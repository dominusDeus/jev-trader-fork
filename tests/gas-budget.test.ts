import { expect, test } from "bun:test";
import { GasBudget } from "../src/gas-budget";
import type { Intent } from "../src/journal";
const intent: Intent = { block: 100, nonce: 0, gasLimit: "350000", maxGasWei: "140", quote: { side: "buy", size: 200, price: 0.02, txHash: "0x" + "a".repeat(64), gasMon: 0, cancel: [], status: "sent", orderId: null, capped: false } };

test("quotes preserve cancellation capacity at the exact budget boundary", () => {
  const budget = new GasBudget();
  expect(budget.reason(140n, 280n, 140n)).toBeNull();
  budget.record(intent);
  expect(budget.reason(140n, 280n, 140n)).toBe("gas_budget_exhausted");
  expect(budget.reason(140n, 280n, 140n, true)).toBeNull();
  budget.record({ ...intent, quote: { ...intent.quote, txHash: "0x" + "b".repeat(64) } });
  expect(budget.reason(1n, 280n, 140n, true)).toBe("gas_budget_exhausted");
});

test("replay keeps allocations and duplicate delivery does not charge twice", () => {
  const budget = new GasBudget();
  budget.record(intent); budget.record(intent);
  expect(budget.snapshot().allocatedWei).toBe("140");
  const restored = new GasBudget(); restored.record(intent);
  expect(restored.snapshot()).toEqual(budget.snapshot());
});

test("missing policy, undersized reserve and old history fail closed", () => {
  const budget = new GasBudget();
  expect(budget.reason(140n, 0n, 0n)).toBe("gas_budget_unconfigured");
  expect(budget.reason(140n, 1000n, 0n)).toBe("gas_budget_unconfigured");
  expect(budget.reason(140n, 1000n, 139n)).toBe("cancel_reserve_too_small");
  budget.record({ ...intent, maxGasWei: undefined });
  expect(budget.reason(1n, 1000n, 140n)).toBe("gas_history_incomplete");
  expect(budget.reason(1n, 1000n, 140n, true)).toBe("gas_history_incomplete");
});
