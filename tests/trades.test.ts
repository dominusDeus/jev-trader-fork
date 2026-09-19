import { afterEach, expect, mock, test } from "bun:test";
import { TradeFeed } from "../src/trades";
import { mockFetch } from "./helpers";

afterEach(() => mock.restore());

test("bounded catch-up never skips the oldest unprocessed blocks", async () => {
  const spans: { from: number; to: number }[] = [];
  mockFetch(async (_url, init) => {
    const { params: [filter] } = JSON.parse(String(init?.body));
    spans.push({ from: parseInt(filter.fromBlock, 16), to: parseInt(filter.toBlock, 16) });
    return Response.json({ result: [] });
  });
  const feed = new TradeFeed({ market: "0x" + "1".repeat(40), url: "https://test.invalid", sizeDec: 10 });
  feed.lastBlock = 100;
  await feed.poll(1201);
  expect(spans[0]?.from).toBe(101);
  expect(feed.lastBlock).toBe(1100);
  await feed.poll(1201);
  expect(spans[10]?.from).toBe(1101);
  expect(feed.lastBlock).toBe(1201);
  for (let i = 1; i < spans.length; i++) expect(spans[i]!.from).toBe(spans[i - 1]!.to + 1);
});

test("a failed chunk resumes from that chunk instead of jumping ahead", async () => {
  let fail = true;
  const ranges: number[] = [];
  mockFetch(async (_url, init) => {
    const { params: [filter] } = JSON.parse(String(init?.body));
    const from = parseInt(filter.fromBlock, 16);
    ranges.push(from);
    if (from === 201 && fail) throw new Error("RPC unavailable");
    return Response.json({ result: [] });
  });
  const feed = new TradeFeed({ market: "0x" + "1".repeat(40), url: "https://test.invalid", sizeDec: 10 });
  feed.lastBlock = 100;
  await feed.poll(300);
  expect(feed.lastBlock).toBe(200);
  fail = false;
  await feed.poll(300);
  expect(ranges).toEqual([101, 201, 201]);
  expect(feed.lastBlock).toBe(300);
});

test("a rejected durable batch never advances the cursor", async () => {
  mockFetch(async () => Response.json({ result: [] }));
  const feed = new TradeFeed({ market: "0x" + "1".repeat(40), url: "https://test.invalid", sizeDec: 10, startBlock: 99, onBatch: () => { throw new Error("disk full"); } });
  await feed.poll(100);
  expect(feed.lastBlock).toBe(99);
});

test("restored zero cursor collects maker fills from the first block", async () => {
  const maker = "0x" + "1".repeat(40);
  const word = (value: bigint) => value.toString(16).padStart(64, "0");
  mockFetch(async () => Response.json({ result: [{ blockNumber: "0x1", logIndex: "0x0", transactionHash: "0x" + "a".repeat(64), data: "0x" + [7n, BigInt(maker), 0n, 20_000_000_000_000_000n, 0n, 0n, 0n, 2_000_000_000_000n].map(word).join("") }] }));
  const feed = new TradeFeed({ market: maker, maker, url: "https://test.invalid", sizeDec: 10, startBlock: 0 });
  await feed.poll(1);
  expect(feed.drainFills()).toHaveLength(1);
  expect(feed.lastBlock).toBe(1);
});
