import { expect, test } from "bun:test";
import { paperSettings, parseSnapshot } from "../src/ibkr/inspect";
const snapshot = { version: 1, broker: "ibkr", mode: "paper", readOnly: true, account: "DU123", capturedAt: "2026-09-19T12:00:00Z", accountReady: null, values: [{ key: "CashBalance", currency: "USD", value: "100" }], positions: [] };
test("IBKR reader requires explicit paper account and rejects live ports", () => {
  expect(() => paperSettings({})).toThrow("IBKR_PAPER_ACCOUNT");
  expect(() => paperSettings({ IBKR_PAPER_ACCOUNT: "U123" })).toThrow();
  for (const port of ["4001", "7496", "-1", "4002oops"]) expect(() => paperSettings({ IBKR_PAPER_ACCOUNT: "DU123", IBKR_PAPER_PORT: port })).toThrow();
  expect(paperSettings({ IBKR_PAPER_ACCOUNT: "DU123" })).toEqual({ account: "DU123", port: 4002, clientId: 71, timeout: 15 });
});
test("IBKR reader rejects wrong account, incomplete download and non-paper payloads", () => {
  expect(parseSnapshot(JSON.stringify(snapshot), "DU123").values[0]?.value).toBe("100");
  for (const patch of [{ account: "DU456" }, { mode: "live" }, { readOnly: false }, { accountReady: false }, { values: [] }, { positions: null }, { capturedAt: "bad" }]) expect(() => parseSnapshot(JSON.stringify({ ...snapshot, ...patch }), "DU123")).toThrow();
});
test("IBKR positions retain contract identifiers and reject duplicates", () => {
  const p = { contractId: 1, symbol: "TEST", securityType: "BOND", currency: "EUR", quantity: "1000" };
  expect(parseSnapshot(JSON.stringify({ ...snapshot, positions: [p] }), "DU123").positions[0]).toEqual(p);
  expect(() => parseSnapshot(JSON.stringify({ ...snapshot, positions: [p, p] }), "DU123")).toThrow("Duplicate");
  expect(() => parseSnapshot(JSON.stringify({ ...snapshot, positions: [{ ...p, quantity: "NaN" }] }), "DU123")).toThrow();
});
