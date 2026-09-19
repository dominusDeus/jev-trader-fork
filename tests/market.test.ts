import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import { Market, type Book } from "../src/market";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { mockFetch } from "./helpers";
import { DecisionExpired } from "../src/deadline";

const original = { ...config };
const fetchOriginal = globalThis.fetch;
const markets: Market[] = [];
const dirs: string[] = [];
afterEach(() => { markets.splice(0).forEach(m => m.journal?.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); mock.restore(); Object.assign(config, original); globalThis.fetch = fetchOriginal; });
const bn = ethers.BigNumber.from;
const params: Kuru.MarketParams = {
  pricePrecision: bn(100_000_000), sizePrecision: bn(10_000_000_000), tickSize: bn(100),
  baseAssetAddress: ethers.constants.AddressZero, baseAssetDecimals: bn(18),
  quoteAssetAddress: "0x" + "2".repeat(40), quoteAssetDecimals: bn(6),
  minSize: bn(200).mul(10_000_000_000), maxSize: bn(1_000_000).mul(10_000_000_000),
  makerFeeBps: bn(0), takerFeeBps: bn(0),
};
const book: Book = { block: 100, bid: 0.02, ask: 0.021, mid: 0.0205, spreadBps: 488, imbalance: 0, depthBps: {}, levels: { bids: [], asks: [] } };
function liveMarket(checkBalance = false) {
  config.dryRun = false;
  config.privateKey = "0x" + "1".repeat(64); // synthetic public test key
  config.gasLimit = 350_000;
  config.gasBudgetWei = ethers.utils.parseEther("10").toString();
  config.cancelReserveWei = ethers.utils.parseEther("1").toString();
  const dir = mkdtempSync(join(tmpdir(), "jev-market-test-"));
  dirs.push(dir);
  config.statePath = join(dir, "live.sqlite");
  const market = new Market();
  if (!checkBalance) spyOn(market as any, "assertNativeGas").mockResolvedValue(undefined); // separate lifecycle tests from native balance RPC
  market.journal!.append({ type: "bootstrap", block: 99, nonce: 0 });
  markets.push(market);
  return market;
}
function rpcFixture(chain = "0x8f", verified = true) {
  const methods: string[] = [];
  const paramSpy = spyOn(Kuru.ParamFetcher, "getMarketParams").mockResolvedValue(params);
  mockFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    methods.push(body.method);
    let result: string;
    if (body.method === "eth_chainId") result = chain;
    else if (body.method === "eth_gasPrice") result = "0x17bfac7c00";
    else if (body.method === "eth_getTransactionCount") result = "0x0";
    else if (body.method === "eth_call") {
      const data = body.params[0].data as string;
      if (data.startsWith("0x5f71a07c")) result = verified ? "0x01" : "0x00";
      else if (data === "0x88bb4f60") result = "0x" + "0".repeat(64 * 8);
      else result = "0x00";
    } else throw new Error(`Unexpected RPC in test: ${body.method}`);
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  });
  return { methods, paramSpy };
}

test("live init is read-only: no signing, approval, or deposit", async () => {
  const { methods } = rpcFixture();
  const market = liveMarket();
  const sign = spyOn(market.wallet!, "signTransaction").mockRejectedValue(new Error("Must not sign at startup"));
  const send = spyOn(market.wallet!, "sendTransaction").mockRejectedValue(new Error("Must not send at startup"));
  await market.init();
  expect(sign).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(methods.every(method => ["eth_chainId", "eth_gasPrice", "eth_getTransactionCount", "eth_call"].includes(method))).toBe(true);
});

test("wrong chain aborts before market initialization", async () => {
  const { paramSpy } = rpcFixture("0x1");
  const market = liveMarket();
  await expect(market.init()).rejects.toThrow("chainId");
  expect(paramSpy).not.toHaveBeenCalled();
});

test("both send and read RPC must match the configured chain", async () => {
  rpcFixture();
  config.readRpcUrl = "https://read.example.invalid";
  const calls: string[] = [];
  mockFetch(async url => {
    calls.push(String(url));
    return Response.json({ result: String(url) === config.readRpcUrl ? "0x1" : "0x8f" });
  });
  await expect(liveMarket().init()).rejects.toThrow("chainId");
  expect(calls).toEqual([config.rpcUrl, config.readRpcUrl]);
});

test("unverified margin association prevents live initialization", async () => {
  rpcFixture("0x8f", false);
  await expect(liveMarket().init()).rejects.toThrow("not verified");
});

test("market size constraints are checked before operation", async () => {
  rpcFixture();
  config.tradeSizeMon = 199;
  await expect(new Market().init()).rejects.toThrow("size limits");
});

test("unsupported size precision is rejected instead of rounded", async () => {
  rpcFixture();
  config.tradeSizeMon = 200.00000000001;
  await expect(new Market().init()).rejects.toThrow("size precision");
});

test("a decision expiring during signing is never broadcast", async () => {
  const market = liveMarket();
  market.params = params;
  let valid = true;
  spyOn(market.wallet!, "signTransaction").mockImplementation(async () => { valid = false; return "0x1234"; });
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network allowed"));
  const assertFresh = () => { if (!valid) throw new DecisionExpired(); };
  await expect(market.send(100, "buy", 200, book, [], false, assertFresh)).rejects.toBeInstanceOf(DecisionExpired);
  expect(fetch).not.toHaveBeenCalled();
});

test("an already expired decision is not even signed", async () => {
  const market = liveMarket();
  market.params = params;
  const sign = spyOn(market.wallet!, "signTransaction").mockRejectedValue(new Error("Must not sign"));
  await expect(market.send(100, "buy", 200, book, [], false, () => { throw new DecisionExpired(); })).rejects.toBeInstanceOf(DecisionExpired);
  expect(sign).not.toHaveBeenCalled();
});

test("an ambiguous send retains its hash and nonce and blocks further orders", async () => {
  const market = liveMarket();
  market.params = params;
  const signed = "0x1234";
  const hash = ethers.utils.keccak256(signed);
  const sign = spyOn(market.wallet!, "signTransaction").mockResolvedValue(signed);
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("response lost"));
  const quote = await market.send(100, "buy", 200, book, [], false, () => {});
  expect(quote.txHash).toBe(hash);
  expect(quote.status).toBe("lost");
  expect(market.hasUncertainTransactions).toBe(true);
  expect(market.buildTx("buy", 200, 0.02, []).nonce).toBe(1);
  await expect(market.send(101, "buy", 200, book, [], false, () => {})).rejects.toThrow("paused");
  expect(sign).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  // A later receipt can still resolve the exact transaction; no nonce resync/reuse.
  fetch.mockResolvedValue(Response.json({ result: { transactionHash: hash, status: "0x0", blockNumber: "0x65", logs: [], effectiveGasPrice: "0x2" } }));
  const resolved = await market.pollPending(120);
  expect(resolved[0]?.quote.status).toBe("reverted");
  expect(market.hasUncertainTransactions).toBe(false);
  expect(await market.pollPending(121)).toEqual([]);
});

test("missing receipts keep being polled after the timeout, reported only once", async () => {
  const market = liveMarket();
  market.params = params;
  const hash = ethers.utils.keccak256("0x1234");
  spyOn(market.wallet!, "signTransaction").mockResolvedValue("0x1234");
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ result: hash }));
  await market.send(100, "buy", 200, book, [], false, () => {});
  fetch.mockImplementation(Object.assign(async () => Response.json({ result: null }), { preconnect() {} }));
  expect((await market.pollPending(110))[0]?.quote.status).toBe("lost");
  expect(await market.pollPending(111)).toEqual([]);
  expect(market.hasUncertainTransactions).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(3);
});

test("overlapping receipt polls account for a transaction only once", async () => {
  const market = liveMarket();
  market.params = params;
  const hash = ethers.utils.keccak256("0x1234");
  spyOn(market.wallet!, "signTransaction").mockResolvedValue("0x1234");
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ result: hash }));
  await market.send(100, "buy", 200, book, [], false, () => {});
  fetch.mockImplementation(Object.assign(async () => Response.json({ result: { transactionHash: hash, status: "0x0", blockNumber: "0x65", logs: [], effectiveGasPrice: "0x2" } }), { preconnect() {} }));
  const results = await Promise.all([market.pollPending(101), market.pollPending(102)]);
  expect(results.flat()).toHaveLength(1);
});

test("a malformed successful receipt never releases reserved exposure", async () => {
  const market = liveMarket();
  market.params = params;
  const hash = ethers.utils.keccak256("0x1234");
  spyOn(market.wallet!, "signTransaction").mockResolvedValue("0x1234");
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ result: hash }));
  await market.send(100, "buy", 200, book, [], false, () => {});
  // status=success, but no attributable OrderCreated log.
  fetch.mockImplementation(Object.assign(async () => Response.json({ result: { transactionHash: hash, status: "0x1", blockNumber: "0x65", logs: [] } }), { preconnect() {} }));
  expect((await market.pollPending(110))[0]?.quote.status).toBe("lost");
  expect(market.hasUncertainTransactions).toBe(true);
});

test("restart restores an intent whose broadcast response was lost", async () => {
  const market = liveMarket();
  market.params = params;
  const hash = ethers.utils.keccak256("0x1234");
  spyOn(market.wallet!, "signTransaction").mockResolvedValue("0x1234");
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection dropped"));
  await market.send(100, "buy", 200, book, [], false, () => {});
  market.journal!.close();
  const restored = new Market();
  spyOn(restored as any, "assertNativeGas").mockResolvedValue(undefined);
  markets.push(restored);
  restored.params = params;
  expect(restored.hasUncertainTransactions).toBe(true);
  expect(restored.buildTx("buy", 200, 0.02, []).nonce).toBe(1);
  await expect(restored.send(101, "buy", 200, book, [], false, () => {})).rejects.toThrow("paused");
  fetch.mockImplementation(Object.assign(async () => Response.json({ result: { transactionHash: hash, status: "0x0", blockNumber: "0x65", logs: [], effectiveGasPrice: "0x2" } }), { preconnect() {} }));
  const results = await restored.pollPending(102);
  expect(results[0]?.quote.status).toBe("reverted");
  restored.journal!.close();
  const restoredAgain = new Market();
  markets.push(restoredAgain);
  expect(restoredAgain.hasUncertainTransactions).toBe(false);
  expect(await restoredAgain.pollPending(103)).toEqual([]);
});

test("journal commit failure prevents any broadcast", async () => {
  const market = liveMarket();
  market.params = params;
  spyOn(market.wallet!, "signTransaction").mockResolvedValue("0x1234");
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Must not broadcast"));
  market.journal!["db"].exec("CREATE TRIGGER fail_write BEFORE INSERT ON events BEGIN SELECT RAISE(FAIL, 'disk unavailable'); END;");
  await expect(market.send(100, "buy", 200, book, [], false, () => {})).rejects.toThrow("disk unavailable");
  expect(fetch).not.toHaveBeenCalled();
  expect(market.hasUncertainTransactions).toBe(true);
});

test("intent is on disk before the broadcast RPC is invoked", async () => {
  const market = liveMarket();
  market.params = params;
  spyOn(market.wallet!, "signTransaction").mockResolvedValue("0x1234");
  mockFetch(async () => {
    const saved = market.journal!.replay().filter(e => e.type === "intent");
    expect(saved).toHaveLength(1);
    expect(saved[0]!.intent.nonce).toBe(0);
    return Response.json({ result: ethers.utils.keccak256("0x1234") });
  });
  expect((await market.send(100, "buy", 200, book, [], false, () => {})).status).toBe("sent");
});

test("a nonce used outside the journal prevents startup reconciliation", async () => {
  const market = liveMarket();
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ result: "0x2" }), { preconnect() {} }));
  await expect(market["reconcileNonce"]()).rejects.toThrow("outside the journal");
});

test("fresh journal bootstrap refuses to adopt an already used wallet", async () => {
  // Close the fixture's initialized store and use a separate empty persistent file.
  const existing = liveMarket();
  existing.journal!.close();
  config.statePath = join(dirs.at(-1)!, "uninitialized.sqlite");
  const market = new Market(); markets.push(market);
  mockFetch(async () => Response.json({ result: "0x1" }));
  await expect(market["reconcileNonce"]()).rejects.toThrow("Existing wallet");
  expect(market.journal!.replay()).toEqual([]);
});

test("fresh signer gets an explicit durable recovery boundary", async () => {
  const existing = liveMarket(); existing.journal!.close();
  config.statePath = join(dirs.at(-1)!, "new-signer.sqlite");
  const market = new Market(); markets.push(market);
  mockFetch(async (_url, init) => Response.json({ result: JSON.parse(String(init?.body)).method === "eth_blockNumber" ? "0x64" : "0x0" }));
  await market["reconcileNonce"]();
  expect(market.journal!.replay()).toEqual([{ type: "bootstrap", block: 99, nonce: 0 }]);
});

test("resting verification checks owner, units, price and side at a pinned block", async () => {
  const { default: abi } = await import("@kuru-labs/kuru-sdk/abi/OrderBook.json");
  const iface = new ethers.utils.Interface(abi.abi);
  const market = liveMarket(); market.params = params;
  let isBuy = true;
  mockFetch(async (_url, init) => {
    const { params: [call, tag] } = JSON.parse(String(init?.body));
    expect(tag).toBe("0x64");
    const result = call.to === config.market ? iface.encodeFunctionResult("s_orders", [market.address, bn(200).mul(10_000_000_000), 0, 0, 0, 2_000_000, 0, isBuy]) : "0x0";
    return Response.json({ result });
  });
  const orders = [{ id: 7, size: 200, price: 0.02, side: "buy" as const }];
  await market.verifyRestingOrders(orders, 100);
  isBuy = false;
  await expect(market.verifyRestingOrders(orders, 100)).rejects.toThrow("differ from journal");
});

test("cancel-only uses SDK cancellation calldata and persists before broadcast", async () => {
  const { default: abi } = await import("@kuru-labs/kuru-sdk/abi/OrderBook.json");
  const iface = new ethers.utils.Interface(abi.abi);
  const market = liveMarket(); // no book or market params needed for cancellation
  const hash = ethers.utils.keccak256("0x1234");
  spyOn(market.wallet!, "signTransaction").mockImplementation(async tx => {
    const decoded = iface.parseTransaction({ data: String(tx.data) });
    expect(decoded.name).toBe("batchCancelOrders");
    expect(decoded.args[0].map(Number)).toEqual([7, 8]);
    expect(bn(tx.value).isZero()).toBe(true);
    return "0x1234";
  });
  mockFetch(async () => {
    expect(market.journal!.replay().at(-1)).toMatchObject({ type: "intent", intent: { nonce: 0, quote: { kind: "cancel", size: 0, cancel: [7, 8] } } });
    return Response.json({ result: hash });
  });
  expect((await market.cancelOrders(100, [7, 8])).status).toBe("sent");
  await expect(market.send(101, "buy", 200, book, [], false, () => {})).rejects.toThrow("paused");
  const ev = iface.encodeEventLog(iface.getEvent("OrdersCanceled"), [[7, 8], market.address]);
  mockFetch(async () => Response.json({ result: { transactionHash: hash, status: "0x1", blockNumber: "0x65", effectiveGasPrice: "0x2", logs: [{ ...ev, address: config.market }] } }));
  const result = (await market.pollPending(101))[0]!;
  expect(result.quote).toMatchObject({ kind: "cancel", status: "canceled", orderId: null, size: 0 });
  expect(result.canceled).toEqual([7, 8]);
  expect(result.quote.gasMon).toBeGreaterThan(0);
  expect(await market.pollPending(102)).toEqual([]);
});

test("incomplete cancel receipt remains uncertain and cannot release orders", async () => {
  const market = liveMarket();
  const hash = ethers.utils.keccak256("0x1234");
  spyOn(market.wallet!, "signTransaction").mockResolvedValue("0x1234");
  mockFetch(async () => Response.json({ result: hash }));
  await market.cancelOrders(100, [7]);
  mockFetch(async () => Response.json({ result: { transactionHash: hash, status: "0x1", blockNumber: "0x65", logs: [] } }));
  const results = await market.pollPending(110);
  expect(results[0]?.quote.status).toBe("lost");
  expect(results[0]?.canceled).toEqual([]);
  await expect(market.cancelOrders(111, [7])).rejects.toThrow("pending");
});

test("uncertain cancellation survives restart and a revert retains requested orders", async () => {
  const market = liveMarket();
  const hash = ethers.utils.keccak256("0x1234");
  spyOn(market.wallet!, "signTransaction").mockResolvedValue("0x1234");
  mockFetch(async () => { throw new Error("response lost"); });
  expect((await market.cancelOrders(100, [7])).status).toBe("lost");
  market.journal!.close();
  const restored = new Market(); markets.push(restored);
  expect(restored.hasUncertainTransactions).toBe(true);
  await expect(restored.cancelOrders(101, [7])).rejects.toThrow("pending");
  mockFetch(async () => Response.json({ result: { transactionHash: hash, status: "0x0", blockNumber: "0x65", logs: [], effectiveGasPrice: "0x2" } }));
  const result = (await restored.pollPending(102))[0]!;
  expect(result.quote).toMatchObject({ kind: "cancel", status: "reverted", cancel: [7] });
  expect(result.canceled).toEqual([]);
  expect(result.quote.gasMon).toBeGreaterThan(0);
});

test("cancel storage failure and invalid ids never broadcast", async () => {
  const market = liveMarket();
  const sign = spyOn(market.wallet!, "signTransaction").mockResolvedValue("0x1234");
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Must not broadcast"));
  for (const ids of [[], [0], [-1], [7, 7], [2 ** 40]]) await expect(market.cancelOrders(100, ids)).rejects.toThrow("Invalid");
  expect(sign).not.toHaveBeenCalled();
  market.journal!["db"].exec("CREATE TRIGGER fail_cancel BEFORE INSERT ON events BEGIN SELECT RAISE(FAIL, 'disk unavailable'); END;");
  await expect(market.cancelOrders(100, [7])).rejects.toThrow("disk unavailable");
  expect(fetch).not.toHaveBeenCalled();
});

test("quote and cancellation cannot sign concurrently with the same nonce", async () => {
  const market = liveMarket(); market.params = params;
  let resolve!: (signed: string) => void;
  const sign = spyOn(market.wallet!, "signTransaction").mockImplementation(() => new Promise(r => { resolve = r; }));
  mockFetch(async () => Response.json({ result: ethers.utils.keccak256("0x1234") }));
  const quoting = market.send(100, "buy", 200, book, [], false, () => {});
  await expect(market.cancelOrders(100, [7])).rejects.toThrow("being submitted");
  expect(sign).toHaveBeenCalledTimes(1);
  resolve("0x1234");
  await quoting;
  await expect(market.cancelOrders(101, [7])).rejects.toThrow("pending");
});

test("gas exhaustion survives a cheap reverted receipt and restart, leaving cancellation capacity", async () => {
  const market = liveMarket(); market.params = params;
  config.gasBudgetWei = ethers.utils.parseEther("0.28").toString();
  config.cancelReserveWei = ethers.utils.parseEther("0.14").toString();
  const hash = ethers.utils.keccak256("0x1234");
  spyOn(market.wallet!, "signTransaction").mockResolvedValue("0x1234");
  mockFetch(async () => Response.json({ result: hash }));
  await market.send(100, "buy", 200, book, [], false, () => {});
  expect(market.quoteBudgetReason).toBe("gas_budget_exhausted");
  mockFetch(async () => Response.json({ result: { transactionHash: hash, status: "0x0", blockNumber: "0x65", logs: [], effectiveGasPrice: "0x1" } }));
  await market.pollPending(101);
  market.journal!.close();
  const restored = new Market(); restored.params = params; markets.push(restored);
  spyOn(restored as any, "assertNativeGas").mockResolvedValue(undefined);
  expect(restored.gasBudgetStatus.allocatedWei).toBe(ethers.utils.parseEther("0.14").toString());
  const sign = spyOn(restored.wallet!, "signTransaction").mockResolvedValue("0xabcd");
  await expect(restored.send(102, "buy", 200, book, [], false, () => {})).rejects.toThrow("gas_budget_exhausted");
  expect(sign).not.toHaveBeenCalled();
  mockFetch(async () => Response.json({ result: ethers.utils.keccak256("0xabcd") }));
  expect((await restored.cancelOrders(102, [7])).status).toBe("sent");
  expect(restored.gasBudgetStatus.allocatedWei).toBe(config.gasBudgetWei);
});

test("unconfigured live gas policy never signs or broadcasts", async () => {
  const market = liveMarket(); market.params = params;
  config.gasBudgetWei = "0"; config.cancelReserveWei = "0";
  const sign = spyOn(market.wallet!, "signTransaction").mockRejectedValue(new Error("Must not sign"));
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Must not broadcast"));
  await expect(market.send(100, "buy", 200, book, [], false, () => {})).rejects.toThrow("gas_budget_unconfigured");
  expect(sign).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

test("native balance enforces exact quote plus cancellation reserve before signing", async () => {
  const market = liveMarket(true); market.params = params;
  config.cancelReserveWei = ethers.utils.parseEther("0.14").toString();
  let balance = ethers.utils.parseEther("0.28").sub(1);
  const methods: string[] = [];
  mockFetch(async (_url, init) => {
    const { method, params } = JSON.parse(String(init?.body)); methods.push(method);
    if (method === "eth_getBalance") {
      expect(params).toEqual([market.address, "0x64"]);
      return Response.json({ result: balance.toHexString() });
    }
    return Response.json({ result: ethers.utils.keccak256("0x1234") });
  });
  const sign = spyOn(market.wallet!, "signTransaction").mockResolvedValue("0x1234");
  await expect(market.send(100, "buy", 200, book, [], false, () => {})).rejects.toThrow("native_gas_insufficient");
  expect(sign).not.toHaveBeenCalled();
  expect(methods).toEqual(["eth_getBalance"]);
  expect(market.journal!.replay()).toHaveLength(1);
  balance = balance.add(1);
  await market.send(100, "buy", 200, book, [], false, () => {});
  expect(sign).toHaveBeenCalledTimes(1);
  expect(methods.at(-1)).toBe("eth_sendRawTransaction");
});

test("native balance failures and malformed responses never authorize a signature", async () => {
  const market = liveMarket(true); market.params = params;
  const sign = spyOn(market.wallet!, "signTransaction").mockResolvedValue("0x1234");
  for (const result of [null, "", "1000000000000000000", "0x-1", "0x" + "f".repeat(65), { balance: "0xffff" }]) {
    mockFetch(async () => Response.json({ result }));
    await expect(market.send(100, "buy", 200, book, [], false, () => {})).rejects.toThrow("native_gas_unavailable");
  }
  mockFetch(async () => { throw new Error("network down"); });
  await expect(market.send(100, "buy", 200, book, [], false, () => {})).rejects.toThrow("native_gas_unavailable");
  expect(sign).not.toHaveBeenCalled();
  expect(market.gasBudgetStatus.nativeBalanceWei).toBeNull();
});

test("pending transaction maximum is subtracted from the native balance", async () => {
  const market = liveMarket(true); market.params = params;
  config.cancelReserveWei = ethers.utils.parseEther("0.14").toString();
  const sign = spyOn(market.wallet!, "signTransaction").mockResolvedValue("0x1234");
  mockFetch(async (_url, init) => Response.json({ result: JSON.parse(String(init?.body)).method === "eth_getBalance" ? ethers.utils.parseEther("0.28").toHexString() : ethers.utils.keccak256("0x1234") }));
  await market.send(100, "buy", 200, book, [], false, () => {});
  await expect(market.send(101, "buy", 200, book, [], false, () => {})).rejects.toThrow("native_gas_insufficient");
  expect(sign).toHaveBeenCalledTimes(1);
});

test("cancel-only can use the native gas reserve but cannot exceed actual balance", async () => {
  const market = liveMarket(true);
  let balance = ethers.utils.parseEther("0.14").sub(1);
  const sign = spyOn(market.wallet!, "signTransaction").mockResolvedValue("0x1234");
  mockFetch(async (_url, init) => Response.json({ result: JSON.parse(String(init?.body)).method === "eth_getBalance" ? balance.toHexString() : ethers.utils.keccak256("0x1234") }));
  await expect(market.cancelOrders(100, [7])).rejects.toThrow("native_gas_insufficient");
  expect(sign).not.toHaveBeenCalled();
  balance = balance.add(1);
  expect((await market.cancelOrders(100, [7])).status).toBe("sent");
  expect(sign).toHaveBeenCalledTimes(1);
});

test("decision expiring during balance read does not sign or allocate budget", async () => {
  const market = liveMarket(true); market.params = params;
  let fresh = true;
  mockFetch(async () => { fresh = false; return Response.json({ result: ethers.utils.parseEther("10").toHexString() }); });
  const sign = spyOn(market.wallet!, "signTransaction").mockResolvedValue("0x1234");
  await expect(market.send(100, "buy", 200, book, [], false, () => { if (!fresh) throw new DecisionExpired(); })).rejects.toBeInstanceOf(DecisionExpired);
  expect(sign).not.toHaveBeenCalled();
  expect(market.gasBudgetStatus.allocatedWei).toBe("0");
});
