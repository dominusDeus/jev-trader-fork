import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Trader, type TraderMarket } from "../src/trader";
import { config } from "../src/config";
import type { Book, Quote } from "../src/market";
import type { Decision, Model } from "../src/model";

const dirs: string[] = [];
const originalDeadline = config.decisionDeadlineMs;
afterEach(() => {
  config.decisionDeadlineMs = originalDeadline;
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
const book: Book = { block: 100, bid: 0.02, ask: 0.021, mid: 0.0205, spreadBps: 488, imbalance: 0, depthBps: {}, levels: { bids: [], asks: [] } };
const decision = (): Decision => ({ action: "buy", probabilities: { buy: 0.8, sell: 0.2, hold: 0 }, upIn10: 0.8, latencyMs: 1, inputTokens: 100 });
const quote: Quote = { side: "buy", price: 0.02, size: 200, txHash: null, gasMon: 0, cancel: [], status: "sim", orderId: null, capped: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function setup(model: Model = { name: "test", decide: async () => decision() }) {
  const dir = mkdtempSync(join(tmpdir(), "jev-trader-test-"));
  dirs.push(dir);
  const send = mock(async (...args: Parameters<TraderMarket["send"]>) => { args[6](); return quote; });
  const market: TraderMarket = { address: null, wallet: null, journal: null, cancelOrders: async () => { throw new Error("Unexpected cancellation"); }, verifyRestingOrders: async () => {}, quoteBudgetReason: null, refreshNativeGas: async () => {}, hasUncertainTransactions: false, margin: { mon: 0, usdc: 0 }, readBook: async () => book, pollPending: async () => [], refresh: async () => {}, send };
  const trader = new Trader(market, model, () => {}, undefined, undefined, dir);
  return { trader, market, send };
}

test("fresh decisions still submit one quote; duplicate blocks do not", async () => {
  const { trader, send } = setup();
  await trader.onBlock(100);
  await trader.onBlock(100);
  await trader.onBlock(99);
  expect(send).toHaveBeenCalledTimes(1);
  expect(trader.history.map(e => e.block)).toEqual([100]);
});

test("new blocks invalidate a pending model response and preserve event order", async () => {
  const entered = deferred<void>();
  const answer = deferred<Decision>();
  const { trader, send } = setup({ name: "slow", decide: async () => { entered.resolve(); return answer.promise; } });
  const active = trader.onBlock(100);
  await entered.promise;
  await trader.onBlock(101);
  await active;
  answer.resolve(decision());
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
  expect(trader.history.map(e => e.block)).toEqual([100, 101]);
  expect(trader.history.every(e => e.decision?.late && e.quote === null)).toBe(true);
});

test("a hung model times out and the next block can proceed", async () => {
  config.decisionDeadlineMs = 15;
  let calls = 0;
  const { trader, market, send } = setup({ name: "hung", decide: async () => ++calls === 1 ? new Promise(() => {}) : decision() });
  await trader.onBlock(100);
  expect(send).not.toHaveBeenCalled();
  expect(trader.history[0]?.decision?.late).toBe(true);
  config.decisionDeadlineMs = 1000;
  market.readBook = async () => ({ ...book, block: 101 });
  await trader.onBlock(101);
  expect(send).toHaveBeenCalledTimes(1);
});

test("a hung read also releases the loop without submitting", async () => {
  config.decisionDeadlineMs = 15;
  const { trader, market, send } = setup();
  market.readBook = async () => new Promise(() => {});
  await trader.onBlock(100);
  config.decisionDeadlineMs = 1000;
  market.readBook = async () => ({ ...book, block: 101 });
  await trader.onBlock(101);
  expect(send).toHaveBeenCalledTimes(1);
});

test("a stale book never reaches the model or send", async () => {
  const decide = mock(async () => decision());
  const { trader, market, send } = setup({ name: "test", decide });
  market.readBook = async () => ({ ...book, block: 99 });
  await trader.onBlock(100);
  expect(decide).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test("a broadcast already started remains tracked when a newer block arrives", async () => {
  const started = deferred<void>();
  const submitted = deferred<Quote>();
  const { trader, market } = setup();
  market.send = async (...args) => { args[6](); started.resolve(); return submitted.promise; };
  const active = trader.onBlock(100);
  await started.promise;
  await trader.onBlock(101);
  submitted.resolve({ ...quote, status: "sent", txHash: "0x123" });
  await active;
  expect(trader.history.map(e => e.block)).toEqual([100, 101]);
  expect(trader.history[0]?.quote?.txHash).toBe("0x123");
  expect(trader.history[1]?.resting.bidMon).toBe(200);
});

test("a lost receipt preserves exposure and prevents another quote", async () => {
  const { trader, market } = setup();
  market.send = async () => ({ ...quote, status: "sent", txHash: "0x123" });
  await trader.onBlock(100);
  Object.defineProperty(market, "hasUncertainTransactions", { value: true });
  market.pollPending = async () => [{ block: 100, quote: { ...quote, status: "lost", txHash: "0x123" }, canceled: [] }];
  market.readBook = async () => ({ ...book, block: 101 });
  const send = mock(async () => quote);
  market.send = send;
  await trader.onBlock(101);
  expect(send).not.toHaveBeenCalled();
  expect(trader.history.at(-1)?.resting.bidMon).toBe(200);
  expect(trader.history[0]?.quote?.status).toBe("lost");
});

test("explicit hold never turns into a buy and removes simulated resting orders", async () => {
  const decide = mock(async () => decision());
  const { trader, market, send } = setup({ name: "test", decide });
  await trader.onBlock(100);
  expect(trader["orders"].size).toBe(1);
  decide.mockResolvedValue({ ...decision(), action: "hold", probabilities: { buy: 0, sell: 0, hold: 1 } });
  market.readBook = async () => ({ ...book, block: 101 });
  await trader.onBlock(101);
  expect(send).toHaveBeenCalledTimes(1);
  expect(trader["orders"].size).toBe(0);
  expect(trader.history.at(-1)?.decision?.action).toBe("hold");
});

test("expired model decision removes simulated orders without placing a replacement", async () => {
  const decide = mock(async () => decision());
  const { trader, market, send } = setup({ name: "test", decide });
  await trader.onBlock(100);
  config.decisionDeadlineMs = 15;
  decide.mockImplementation(() => new Promise(() => {}));
  market.readBook = async () => ({ ...book, block: 101 });
  await trader.onBlock(101);
  expect(trader["orders"].size).toBe(0);
  expect(send).toHaveBeenCalledTimes(1);
});

test("paid provider cannot run in simulation without a persistent journal", async () => {
  const decide = mock(async () => decision());
  const { trader, send } = setup({ name: "paid", paid: true, decide });
  await trader.onBlock(100);
  expect(decide).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(trader.status.reason).toBe("model_journal_required");
});
