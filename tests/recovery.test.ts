import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingJournal, type JournalEvent } from "../src/journal";
import { Trader, type TraderMarket } from "../src/trader";
import type { Quote, QuoteResult } from "../src/market";
import type { MakerFill } from "../src/trades";
import { config } from "../src/config";
import { mockFetch } from "./helpers";

const originalCallLimit = config.modelCallLimit;
const originalModelDeadline = config.decisionDeadlineMs;
const dirs: string[] = [], journals: TradingJournal[] = [];
afterEach(() => { config.modelCallLimit = originalCallLimit; config.decisionDeadlineMs = originalModelDeadline; mock.restore(); journals.splice(0).forEach(j => j.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const identity = { chainId: 143, wallet: "0x" + "1".repeat(40), market: "0x" + "2".repeat(40), marginAccount: "0x" + "3".repeat(40) };
const hash = "0x" + "a".repeat(64);
const quote: Quote = { side: "buy", price: 0.02, size: 200, txHash: hash, gasMon: 0.01, cancel: [], status: "sent", orderId: null, capped: false };
const placed: QuoteResult = { block: 100, confirmedBlock: 100, quote: { ...quote, status: "placed", orderId: 7 }, canceled: [] };
const fill: MakerFill = { block: 100, logIndex: 0, txHash: "0x" + "b".repeat(64), orderId: 7, price: 0.02, size: 200, updatedSize: 0, side: "buy" };
function fixture(events: JournalEvent[] = [], paid = false) {
  const dir = mkdtempSync(join(tmpdir(), "jev-recovery-test-")); dirs.push(dir);
  const path = join(dir, "live.sqlite");
  const journal = new TradingJournal(path, identity); journals.push(journal);
  journal.append({ type: "bootstrap", block: 99, nonce: 0 });
  for (const event of events) journal.append(event);
  const send = mock(async () => quote);
  const verify = mock(async () => {});
  const market: TraderMarket = {
    address: identity.wallet, wallet: null, journal, margin: { mon: 1000, usdc: 100 }, quoteBudgetReason: null, refreshNativeGas: async () => {}, hasUncertainTransactions: false,
    cancelOrders: async () => { throw new Error("Unexpected cancellation"); }, send, pollPending: async () => [], refresh: async () => {}, verifyRestingOrders: verify,
    readBook: async () => ({ block: 102, bid: 0.02, ask: 0.021, mid: 0.0205, spreadBps: 488, imbalance: 0, depthBps: {}, levels: { bids: [], asks: [] } }),
  };
  const model = { name: "mock", paid, decide: mock(async () => ({ action: "buy" as const, probabilities: { buy: 0.8, sell: 0.2, hold: 0 }, upIn10: 0.8, latencyMs: 1, inputTokens: 100 })) };
  const trader = new Trader(market, model, () => {}, undefined, undefined, dir);
  trader.attachTradeFeed(10);
  return { trader, market, model, send, verify, journal, dir, path };
}
const intent: JournalEvent = { type: "intent", intent: { block: 100, nonce: 0, quote, gasLimit: "350000" } };

test("replay of fill before placement preserves inventory without resurrecting an order", () => {
  const { trader } = fixture([intent, { type: "fills", from: 100, through: 100, fills: [fill] }, { type: "receipt", result: placed }]);
  expect(trader["orders"].size).toBe(0);
  expect(trader["inflight"].size).toBe(0);
  expect(trader["position"]).toEqual({ mon: 200, costUsd: 4 });
  expect(trader["totals"].fills).toBe(1);
  expect(trader["totals"].gasMon).toBe(0.01);
  // Duplicate delivery during the same run must not change accounting.
  trader["applyLiveBatch"]([fill]);
  trader["applyQuoteResult"](placed);
  expect(trader["totals"].fills).toBe(1);
  expect(trader["totals"].gasMon).toBe(0.01);
});

test("partial fills received before placement keep the remaining size", () => {
  const { trader } = fixture([intent, { type: "fills", from: 100, through: 100, fills: [{ ...fill, size: 50, updatedSize: 150 }] }, { type: "receipt", result: placed }]);
  expect(trader["orders"].get(7)?.size).toBe(150);
  expect(trader["position"].mon).toBe(50);
});

test("late placement cannot resurrect an order already canceled by a later receipt", () => {
  const second: Quote = { ...quote, txHash: "0x" + "c".repeat(64), cancel: [7] };
  const { trader } = fixture([
    intent,
    { type: "intent", intent: { block: 101, nonce: 1, quote: second, gasLimit: "350000" } },
    { type: "receipt", result: { block: 101, confirmedBlock: 101, quote: { ...second, status: "placed", orderId: 8 }, canceled: [7] } },
    { type: "receipt", result: placed },
  ]);
  expect([...trader["orders"].keys()]).toEqual([8]);
});

test("two fills in the same transaction use distinct log indexes", () => {
  const { trader } = fixture([intent]);
  trader["applyLiveBatch"]([{ ...fill, size: 50, updatedSize: 150 }, { ...fill, logIndex: 1, size: 150, updatedSize: 0 }]);
  expect(trader["position"].mon).toBe(200);
  expect(trader["totals"].fills).toBe(2);
});

test("recovery never asks the model or sends while an intent is unresolved", async () => {
  const { trader, market, model, send, verify } = fixture([intent]);
  Object.defineProperty(market, "hasUncertainTransactions", { value: true });
  mockFetch(async () => Response.json({ result: [] }));
  await trader.onBlock(101);
  expect(model.decide).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
  expect(trader["inflight"].size).toBe(1);
});

test("resting-order mismatch leaves recovery paused", async () => {
  const { trader, model, send, verify } = fixture([intent, { type: "receipt", result: placed }]);
  verify.mockRejectedValue(new Error("size mismatch"));
  mockFetch(async () => Response.json({ result: [] }));
  await expect(trader.recover(101)).rejects.toThrow("size mismatch");
  expect(trader["recovered"]).toBe(false);
  expect(model.decide).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test("missed fills are committed before the cursor and survive another restart", async () => {
  const { trader, journal, path, market, dir } = fixture([intent, { type: "receipt", result: placed }]);
  const word = (v: bigint) => v.toString(16).padStart(64, "0");
  const log = {
    blockNumber: "0x64", logIndex: "0x0", transactionHash: fill.txHash,
    data: "0x" + [7n, BigInt(identity.wallet), 0n, 20_000_000_000_000_000n, 0n, 0n, 0n, 2_000_000_000_000n].map(word).join(""),
  };
  mockFetch(async () => Response.json({ result: [log] }));
  await trader.recover(100);
  expect(trader["position"].mon).toBe(200);
  expect(trader["recovered"]).toBe(true);
  expect(trader["orders"].size).toBe(0);
  journal.close();
  const reopened = new TradingJournal(path, identity); journals.push(reopened);
  const restored = new Trader({ ...market, journal: reopened }, { name: "mock", decide: async () => { throw new Error("Must not run model during replay"); } }, () => {}, undefined, undefined, dir);
  expect(restored["position"]).toEqual(trader["position"]);
  expect(restored["totals"].gasMon).toBe(trader["totals"].gasMon);
  expect(restored["recoveredThrough"]).toBe(100);
  expect(restored["recovered"]).toBe(false);
});

test("successful recovery resumes decisions only on a subsequent fresh block", async () => {
  const { trader, model, send } = fixture();
  mockFetch(async () => Response.json({ result: [] }));
  expect(trader.status.state).toBe("reconciling");
  await trader.onBlock(101);
  expect(model.decide).not.toHaveBeenCalled();
  expect(trader.status.state).toBe("running");
  await trader.onBlock(102);
  expect(model.decide).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
});

test("storage failure stops decisions as well as orders", async () => {
  const { trader, journal, model, send } = fixture();
  journal.close();
  await trader.onBlock(101);
  expect(trader.status).toMatchObject({ state: "paused", reason: "storage_unavailable" });
  expect(model.decide).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

const cancelQuote: Quote = { ...quote, kind: "cancel", price: 0, size: 0, txHash: "0x" + "c".repeat(64), cancel: [7] };
const cancelIntent: JournalEvent = { type: "intent", intent: { block: 102, nonce: 1, quote: cancelQuote, gasLimit: "350000" } };
const protectedOrders: JournalEvent[] = [intent, { type: "receipt", result: placed }, { type: "protection", reason: "decision_failed" }];

test("restarted protection cancels without book or model, retaining exposure until receipt", async () => {
  const { trader, market, model, send, journal } = fixture(protectedOrders);
  mockFetch(async () => Response.json({ result: [] }));
  const cancel = mock(async () => {
    journal.append(cancelIntent);
    return cancelQuote;
  });
  market.cancelOrders = cancel;
  const read = mock(async () => { throw new Error("Book unavailable"); });
  market.readBook = read;
  await trader.onBlock(101); // recovery
  await trader.onBlock(102); // feed catches up asynchronously
  await trader.onBlock(103);
  await trader.onBlock(104);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(model.decide).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(trader["orders"].has(7)).toBe(true);
  expect(trader["restingMon"]("buy")).toBe(200); // cancel intent creates no new exposure
  const result: QuoteResult = { block: 102, confirmedBlock: 104, quote: { ...cancelQuote, status: "canceled" }, canceled: [7] };
  journal.append({ type: "receipt", result });
  trader["applyQuoteResult"](result);
  expect(trader["orders"].size).toBe(0);
  await trader.onBlock(105);
  expect(model.decide).not.toHaveBeenCalled();
  market.readBook = async () => ({ block: 106, bid: 0.02, ask: 0.021, mid: 0.0205, spreadBps: 488, imbalance: 0, depthBps: {}, levels: { bids: [], asks: [] } });
  await trader.onBlock(106);
  expect(model.decide).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(journal.replay().filter(e => e.type === "protection").at(-1)).toEqual({ type: "protection", reason: null });
});

test("cancel revert durably pauses without a gas-burning retry loop", async () => {
  const { trader, market, model, send } = fixture([
    ...protectedOrders, cancelIntent,
    { type: "receipt", result: { block: 102, confirmedBlock: 103, quote: { ...cancelQuote, status: "reverted" }, canceled: [] } },
  ]);
  const cancel = mock(async () => cancelQuote); market.cancelOrders = cancel;
  mockFetch(async () => Response.json({ result: [] }));
  for (let block = 104; block <= 110; block++) await trader.onBlock(block);
  expect(trader.status).toMatchObject({ state: "paused", reason: "cancellation_failed" });
  expect(trader["orders"].has(7)).toBe(true);
  expect(trader["totals"].gasMon).toBe(quote.gasMon + cancelQuote.gasMon);
  expect(model.decide).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test("uncertain cancel intent survives replay without duplicate cancellation", async () => {
  const { trader, market, model } = fixture([...protectedOrders, cancelIntent]);
  const cancel = mock(async () => cancelQuote); market.cancelOrders = cancel;
  mockFetch(async () => Response.json({ result: [] }));
  await trader.onBlock(103);
  await trader.onBlock(104);
  expect(trader["orders"].has(7)).toBe(true);
  expect(trader["inflight"].size).toBe(1);
  expect(trader["restingMon"]("buy")).toBe(200);
  expect(cancel).not.toHaveBeenCalled();
  expect(model.decide).not.toHaveBeenCalled();
});

test("model failure persists protection and cancels known orders automatically", async () => {
  const { trader, market, model, journal } = fixture([intent, { type: "receipt", result: placed }]);
  mockFetch(async () => Response.json({ result: [] }));
  await trader.onBlock(101);
  model.decide.mockRejectedValue(new Error("model unavailable"));
  const cancel = mock(async () => {
    expect(journal.replay().some(e => e.type === "protection" && e.reason === "decision_failed")).toBe(true);
    journal.append(cancelIntent);
    return cancelQuote;
  });
  market.cancelOrders = cancel;
  await trader.onBlock(102);
  await trader.onBlock(103);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(trader["orders"].has(7)).toBe(true);
  expect(trader.status.state).toBe("paused");
});

test("failed book reads trigger cancellation without asking the model", async () => {
  const { trader, market, model, journal, send } = fixture([intent, { type: "receipt", result: placed }]);
  mockFetch(async () => Response.json({ result: [] }));
  await trader.onBlock(101);
  market.readBook = async () => { throw new Error("read unavailable"); };
  const cancel = mock(async () => { journal.append(cancelIntent); return cancelQuote; });
  market.cancelOrders = cancel;
  await trader.onBlock(102);
  await trader.onBlock(103);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(model.decide).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test("insufficient margin on both sides cancels without placing a replacement", async () => {
  const { trader, market, journal, send } = fixture([intent, { type: "receipt", result: placed }]);
  mockFetch(async () => Response.json({ result: [] }));
  await trader.onBlock(101);
  Object.defineProperty(market, "wallet", { value: {} });
  market.margin = { mon: 0, usdc: 0 };
  const cancel = mock(async () => { journal.append(cancelIntent); return cancelQuote; });
  market.cancelOrders = cancel;
  await trader.onBlock(102);
  await trader.onBlock(103);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  expect(trader.status.reason).toBe("quoting_blocked");
  expect(trader["orders"].has(7)).toBe(true);
});

test("gas limit pauses model spending and still cancels existing orders", async () => {
  const { trader, market, journal, model, send } = fixture([intent, { type: "receipt", result: placed }]);
  Object.defineProperty(market, "quoteBudgetReason", { value: "gas_budget_exhausted" });
  mockFetch(async () => Response.json({ result: [] }));
  const cancel = mock(async () => { journal.append(cancelIntent); return cancelQuote; });
  market.cancelOrders = cancel;
  await trader.onBlock(101);
  await trader.onBlock(102);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(model.decide).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  const result: QuoteResult = { block: 102, confirmedBlock: 103, quote: { ...cancelQuote, status: "canceled" }, canceled: [7] };
  journal.append({ type: "receipt", result }); trader["applyQuoteResult"](result);
  await trader.onBlock(104); await trader.onBlock(105);
  expect(trader.status.reason).toBe("gas_budget_exhausted");
  expect(model.decide).not.toHaveBeenCalled();
});

test("native balance pause skips the model and resumes only after a successful recheck", async () => {
  const { trader, market, model, send } = fixture();
  let reason: string | null = null;
  let enough = false;
  Object.defineProperty(market, "quoteBudgetReason", { get: () => reason });
  market.refreshNativeGas = async () => {
    reason = enough ? null : "native_gas_insufficient";
    if (reason) throw new Error(reason);
  };
  mockFetch(async () => Response.json({ result: [] }));
  await trader.onBlock(100); // reconcile
  await trader.onBlock(101);
  await trader.onBlock(102);
  expect(model.decide).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(trader.status.reason).toBe("native_gas_insufficient");
  enough = true;
  await trader.onBlock(103); // clears protection only
  expect(model.decide).not.toHaveBeenCalled();
  market.readBook = async () => ({ block: 104, bid: 0.02, ask: 0.021, mid: 0.0205, spreadBps: 488, imbalance: 0, depthBps: {}, levels: { bids: [], asks: [] } });
  await trader.onBlock(104);
  expect(model.decide).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
});

test("paid model attempt is durable before the request and exhaustion skips future calls", async () => {
  config.modelCallLimit = 1;
  const { trader, model, journal, market, dir } = fixture([], true);
  mockFetch(async () => Response.json({ result: [] }));
  model.decide.mockImplementation(async () => {
    expect(journal.replay().filter(e => e.type === "model_call")).toHaveLength(1);
    throw new Error("provider failed after acceptance");
  });
  await trader.onBlock(101);
  await trader.onBlock(102);
  await trader.onBlock(103);
  expect(model.decide).toHaveBeenCalledTimes(1);
  expect(trader.modelBudgetStatus.reason).toBe("model_budget_exhausted");
  const restored = new Trader(market, model, () => {}, undefined, undefined, dir);
  expect(restored.modelBudgetStatus.callsAllocated).toBe(1);
  expect(restored.modelBudgetStatus.reason).toBe("model_budget_exhausted");
});

test("zero model budget leaves paid provider untouched", async () => {
  config.modelCallLimit = 0;
  const { trader, model, send } = fixture([], true);
  mockFetch(async () => Response.json({ result: [] }));
  await trader.onBlock(101); await trader.onBlock(102);
  expect(model.decide).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  expect(trader.status.reason).toBe("model_budget_unconfigured");
});

test("failure to persist a paid call prevents provider invocation", async () => {
  config.modelCallLimit = 2;
  const { trader, journal, model } = fixture([], true);
  mockFetch(async () => Response.json({ result: [] }));
  await trader.onBlock(101);
  journal["db"].exec("CREATE TRIGGER fail_model BEFORE INSERT ON events WHEN NEW.event_key LIKE 'model_call:%' BEGIN SELECT RAISE(FAIL, 'disk unavailable'); END;");
  await trader.onBlock(102);
  expect(model.decide).not.toHaveBeenCalled();
  expect(journal.available).toBe(false);
});

test("model exhaustion still cancels known orders and does not resume after cancellation", async () => {
  config.modelCallLimit = 1;
  const { trader, market, model, journal } = fixture([
    ...protectedOrders,
    { type: "model_call", callId: "previous-attempt", block: 100, model: "jev" },
  ], true);
  mockFetch(async () => Response.json({ result: [] }));
  const cancel = mock(async () => { journal.append(cancelIntent); return cancelQuote; }); market.cancelOrders = cancel;
  await trader.onBlock(101); await trader.onBlock(102);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(model.decide).not.toHaveBeenCalled();
  const result: QuoteResult = { block: 102, confirmedBlock: 103, quote: { ...cancelQuote, status: "canceled" }, canceled: [7] };
  journal.append({ type: "receipt", result }); trader["applyQuoteResult"](result);
  await trader.onBlock(104);
  expect(trader.status.reason).toBe("model_budget_exhausted");
});

test("legacy decisions without attempt history cannot silently reset a paid model quota", () => {
  config.modelCallLimit = 100;
  const { trader } = fixture([{ type: "decision", inputTokens: 10 }], true);
  expect(trader.modelBudgetStatus.reason).toBe("model_history_incomplete");
});

test("hung paid request consumes its slot even when the decision deadline expires", async () => {
  config.modelCallLimit = 1; config.decisionDeadlineMs = 15;
  const { trader, model, journal } = fixture([], true);
  mockFetch(async () => Response.json({ result: [] }));
  model.decide.mockImplementation(() => new Promise(() => {}));
  await trader.onBlock(101); await trader.onBlock(102); await trader.onBlock(103);
  expect(model.decide).toHaveBeenCalledTimes(1);
  expect(journal.replay().filter(e => e.type === "model_call")).toHaveLength(1);
  expect(journal.replay().filter(e => e.type === "decision")).toHaveLength(0);
  expect(trader.modelBudgetStatus.reason).toBe("model_budget_exhausted");
});

test("successful paid decisions link to a reserved call and replay without double counting", async () => {
  config.modelCallLimit = 2;
  const { trader, model, journal, market, dir } = fixture([], true);
  mockFetch(async () => Response.json({ result: [] }));
  await trader.onBlock(101); await trader.onBlock(102);
  const result = journal.replay().find(e => e.type === "decision")!;
  expect(result.type === "decision" && result.callId).toBeTruthy();
  expect(journal.append(result)).toBe(false);
  const restored = new Trader(market, model, () => {}, undefined, undefined, dir);
  expect(restored.modelBudgetStatus).toMatchObject({ callsAllocated: 1, reason: null });
});
