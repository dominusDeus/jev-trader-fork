import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { rpc } from "../src/chain";
import { config } from "../src/config";
import { mockFetch } from "./helpers";

const timeout = config.rpcTimeoutMs;
afterEach(() => { mock.restore(); config.rpcTimeoutMs = timeout; });

test("HTTP errors and missing results are explicit RPC failures", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }));
  await expect(rpc("eth_blockNumber")).rejects.toThrow("HTTP 503");
  fetch.mockResolvedValue(Response.json({ jsonrpc: "2.0", id: 1 }));
  await expect(rpc("eth_blockNumber")).rejects.toThrow("missing result");
});

test("null receipt is a valid response, not a transport failure", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ result: null }));
  expect(await rpc("eth_getTransactionReceipt", ["0x123"])).toBeNull();
});

test("RPC requests have a finite timeout", async () => {
  config.rpcTimeoutMs = 10;
  mockFetch(async (_url, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) throw new Error("Missing timeout signal");
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  await expect(rpc("eth_blockNumber")).rejects.toThrow();
});

test("a raw broadcast has a timeout signal for tracked recovery", async () => {
  mockFetch(async (_url, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ result: "0x123" });
  });
  expect(await rpc<string>("eth_sendRawTransaction", ["0x00"])).toBe("0x123");
});
