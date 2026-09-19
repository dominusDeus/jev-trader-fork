import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from decimal import Decimal

spec = importlib.util.spec_from_file_location("reader", Path(__file__).resolve().parents[2] / "src/ibkr/reader.py")
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)

class Client:
    def __init__(self, wrapper):
        self.calls = []
    def reqAccountUpdates(self, subscribe, account):
        self.calls.append((subscribe, account))

class Wrapper:
    pass

class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.app = reader.reader_class(Client, Wrapper)("DU123")

    def test_dut_paper_account_is_validated_and_matched_exactly(self):
        self.assertEqual(reader.settings("DUT123456", 4002, 71, 15)[0], "DUT123456")
        app = reader.reader_class(Client, Wrapper)("DUT123456")
        app.managedAccounts("DU123456,DUT123456")
        app.nextValidId(1)
        self.assertEqual(app.calls, [(True, "DUT123456")])
        for account in ["DUT", "DUX123", "UT123", "DUT123junk"]:
            with self.assertRaises(ValueError): reader.settings(account, 4002, 71, 15)

    def ready(self):
        self.app.managedAccounts("U999,DU123,DU456")
        self.app.nextValidId(22)

    def test_settings_reject_live_ports_accounts_and_bad_ids(self):
        for account, port, client, timeout in [("U123", 4002, 1, 15), ("DU123", 4001, 1, 15), ("DU123", 7496, 1, 15), ("DU123", 4002, 0, 15), ("DU123", 4002, 1, 0)]:
            with self.assertRaises(ValueError): reader.settings(account, port, client, timeout)

    def test_waits_for_both_handshake_callbacks_and_subscribes_once(self):
        self.app.nextValidId(22)
        self.assertEqual(self.app.calls, [])
        self.app.managedAccounts("DU123,DU456")
        self.app.nextValidId(23)
        self.assertEqual(self.app.calls, [(True, "DU123")])

    def test_rejects_wrong_account_before_subscription(self):
        self.app.managedAccounts("U123,DU456")
        self.app.nextValidId(22)
        self.assertEqual(self.app.calls, [])
        with self.assertRaises(RuntimeError): self.app.snapshot()

    def test_no_partial_snapshot_and_foreign_accounts_are_filtered(self):
        self.ready()
        self.app.updateAccountValue("CashBalance", "9999", "USD", "U999")
        self.app.updateAccountValue("CashBalance", "100", "USD", "DU123")
        self.app.updateAccountValue("CashBalance", "20", "EUR", "DU123")
        with self.assertRaises(RuntimeError): self.app.snapshot()
        self.app.accountDownloadEnd("DU456")
        self.assertFalse(self.app.complete)
        self.app.accountDownloadEnd("DU123")
        self.assertEqual([v["value"] for v in self.app.snapshot()["values"]], ["100", "20"])

    def test_not_ready_and_disconnect_are_failures(self):
        self.ready()
        self.app.updateAccountValue("AccountReady", "false", "", "DU123")
        self.app.accountDownloadEnd("DU123")
        with self.assertRaises(RuntimeError): self.app.snapshot()
        app = reader.reader_class(Client, Wrapper)("DU123")
        app.connectionClosed()
        with self.assertRaises(RuntimeError): app.snapshot()

    def test_empty_download_is_not_zero_balance(self):
        self.ready()
        self.app.accountDownloadEnd("DU123")
        with self.assertRaises(RuntimeError): self.app.snapshot()

    def test_contract_types_and_decimal_quantities_survive(self):
        self.ready()
        self.app.updateAccountValue("AccountType", "INDIVIDUAL", "", "DU123")
        for i, kind in enumerate(["STK", "BOND", "OPT", "FUT", "FOP", "CASH"], 1):
            c = SimpleNamespace(conId=i, symbol="TEST", secType=kind, currency="USD", exchange="SMART", primaryExchange="", lastTradeDateOrContractMonth="202612", multiplier="100", strike=10, right="C")
            self.app.updatePortfolio(c, Decimal("0.125"), 1.7976931348623157e308, 5, 6, 7, 8, "DU123")
        self.app.accountDownloadEnd("DU123")
        positions = self.app.snapshot()["positions"]
        self.assertEqual(len(positions), 6)
        self.assertEqual(positions[0]["quantity"], "0.125")
        self.assertIsNone(positions[0]["marketPrice"])
        self.assertEqual(positions[-1]["securityType"], "CASH")

    def test_error_details_not_exposed(self):
        self.app.error(-1, 0, 2104, "farm connected")
        self.assertIsNone(self.app.failure)
        self.app.error(-1, 0, 1100, "sensitive broker details")
        self.assertNotIn("sensitive", self.app.failure)
        self.assertTrue(self.app.finished.is_set())

if __name__ == "__main__":
    unittest.main()
