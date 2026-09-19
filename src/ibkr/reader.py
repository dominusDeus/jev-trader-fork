"""One-shot, local, paper-only portfolio reader using the official IBKR Python API."""
import argparse
import json
import re
import sys
import threading
from datetime import datetime, timezone
from decimal import Decimal


def settings(account, port, client_id, timeout):
    if not re.fullmatch(r"DU[0-9]+", account):
        raise ValueError("Specify the exact DU paper account; live accounts are unsupported")
    if port not in (4002, 7497) or not 1 <= client_id <= 2147483647 or not 1 <= timeout <= 60:
        raise ValueError("Use paper port 4002/7497, positive client ID and timeout 1..60")
    return account, port, client_id, timeout


def numeric(value):
    number = Decimal(str(value))
    if not number.is_finite() or abs(number) >= Decimal("1e100"):
        return None  # IB unset sentinels are not balances or prices
    return str(value)


def reader_class(client_class, wrapper_class):
    class Reader(wrapper_class, client_class):
        def __init__(self, account):
            wrapper_class.__init__(self)
            client_class.__init__(self, self)
            self.account = account
            self.finished = threading.Event()
            self.failure = None
            self.accounts = None
            self.handshake = False
            self.subscribed = False
            self.values = {}
            self.positions = {}
            self.ready = None
            self.complete = False

        def fail(self, message):
            self.failure = message
            self.finished.set()

        def start_if_ready(self):
            if self.failure or self.subscribed or not self.handshake or self.accounts is None:
                return
            if self.account not in self.accounts:
                self.fail("Configured paper account is not in the authenticated session")
                return
            self.subscribed = True
            self.reqAccountUpdates(True, self.account)

        def nextValidId(self, orderId):
            self.handshake = True
            self.start_if_ready()

        def managedAccounts(self, accountsList):
            self.accounts = set(accountsList.split(","))
            self.start_if_ready()

        def updateAccountValue(self, key, val, currency, accountName):
            if accountName != self.account or self.finished.is_set():
                return
            if key.lower() == "accountready":
                self.ready = val.lower() == "true"
                if not self.ready:
                    self.fail("IBKR account is not ready; snapshot rejected")
            if key in {"AccountType", "NetLiquidation", "TotalCashBalance", "CashBalance", "SettledCash", "AvailableFunds", "BuyingPower", "Currency"}:
                self.values[(key, currency)] = {"key": key, "currency": currency, "value": val}

        def updatePortfolio(self, contract, position, marketPrice, marketValue, averageCost, unrealizedPNL, realizedPNL, accountName):
            if accountName != self.account or self.finished.is_set():
                return
            conid = contract.conId
            if not isinstance(conid, int) or conid <= 0 or numeric(position) is None:
                self.fail("Invalid position data; snapshot rejected")
                return
            if Decimal(str(position)) == 0:
                self.positions.pop(conid, None)
                return
            self.positions[conid] = {
                "contractId": conid, "symbol": contract.symbol, "securityType": contract.secType,
                "currency": contract.currency, "exchange": contract.exchange,
                "primaryExchange": contract.primaryExchange,
                "expiry": contract.lastTradeDateOrContractMonth, "multiplier": contract.multiplier,
                "strike": numeric(contract.strike), "right": contract.right,
                "quantity": numeric(position), "marketPrice": numeric(marketPrice),
                "marketValue": numeric(marketValue), "averageCost": numeric(averageCost),
                "unrealizedPnl": numeric(unrealizedPNL), "realizedPnl": numeric(realizedPNL),
            }

        def accountDownloadEnd(self, accountName):
            if accountName == self.account and not self.failure:
                if not self.values:
                    self.fail("Empty account download; snapshot rejected")
                    return
                self.complete = True
                self.finished.set()

        def connectionClosed(self):
            if not self.complete:
                self.fail("IBKR disconnected before account download completed")

        def error(self, reqId, errorTime, errorCode, errorString, advancedOrderRejectJson=""):
            # Connectivity status notices; other errors invalidate the one-shot snapshot.
            if errorCode not in {2104, 2106, 2107, 2108, 2158}:
                self.fail(f"IBKR error {errorCode}; snapshot rejected")

        def snapshot(self):
            if self.failure or not self.complete:
                raise RuntimeError(self.failure or "Incomplete account download")
            return {"version": 1, "broker": "ibkr", "mode": "paper", "readOnly": True,
                    "account": self.account, "capturedAt": datetime.now(timezone.utc).isoformat(),
                    "accountReady": self.ready, "values": list(self.values.values()),
                    "positions": list(self.positions.values())}
    return Reader


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account", required=True)
    parser.add_argument("--port", type=int, default=4002)
    parser.add_argument("--client-id", type=int, default=71)
    parser.add_argument("--timeout", type=int, default=15)
    args = parser.parse_args()
    try:
        settings(args.account, args.port, args.client_id, args.timeout)
        from ibapi.client import EClient
        from ibapi.wrapper import EWrapper
        from ibapi import get_version_string
        if not get_version_string().startswith("10.50."):
            raise RuntimeError("Use the tested official IBKR Python SDK 10.50.x")
    except ImportError:
        print("Official IBKR Python SDK missing; see docs/IBKR-PAPER.md", file=sys.stderr)
        return 1
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    app = reader_class(EClient, EWrapper)(args.account)
    timer = threading.Timer(args.timeout, lambda: (app.fail("IBKR snapshot timed out"), app.disconnect()))
    timer.daemon = True
    timer.start()
    try:
        app.connect("127.0.0.1", args.port, args.client_id)
        thread = threading.Thread(target=app.run, daemon=True)
        thread.start()
        app.finished.wait(args.timeout)
        result = app.snapshot()
        print(json.dumps(result, allow_nan=False))
        return 0
    except Exception:
        print(app.failure or "IBKR connection or snapshot failed", file=sys.stderr)
        return 1
    finally:
        timer.cancel()
        if app.subscribed and app.isConnected():
            app.reqAccountUpdates(False, app.account)
        app.disconnect()


if __name__ == "__main__":
    sys.exit(main())
