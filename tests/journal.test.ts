import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingJournal, type JournalEvent } from "../src/journal";

const identity = { chainId: 143, wallet: "0x" + "1".repeat(40), market: "0x" + "2".repeat(40), marginAccount: "0x" + "3".repeat(40) };
const dirs: string[] = [], stores: TradingJournal[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function path() { const dir = mkdtempSync(join(tmpdir(), "jev-journal-test-")); dirs.push(dir); return join(dir, "state.sqlite"); }
function open(file: string) { const store = new TradingJournal(file, identity); stores.push(store); return store; }

test("reopens committed data; identical retries do not add records", () => {
  const file = path();
  const store = open(file);
  const event: JournalEvent = { type: "bootstrap", block: 99, nonce: 0 };
  expect(store.append(event)).toBe(true);
  expect(store.append(event)).toBe(false);
  store.close();
  expect(open(file).replay()).toEqual([event]);
});

test("second writer and changed wallet/market are rejected without disturbing owner", () => {
  const file = path();
  const store = open(file);
  expect(() => open(file)).toThrow("active writer");
  expect(store.append({ type: "bootstrap", block: 99, nonce: 0 })).toBe(true);
  store.close();
  expect(() => new TradingJournal(file, { ...identity, wallet: "0x" + "4".repeat(40) })).toThrow("another wallet");
  expect(() => new TradingJournal(file, { ...identity, market: "0x" + "4".repeat(40) })).toThrow("another wallet");
  expect(open(file).replay()).toHaveLength(1);
});

test("conflicting events latch the journal unavailable", () => {
  const store = open(path());
  store.append({ type: "bootstrap", block: 99, nonce: 0 });
  expect(() => store.append({ type: "bootstrap", block: 100, nonce: 0 })).toThrow("Conflicting");
  expect(store.available).toBe(false);
  expect(() => store.append({ type: "decision", inputTokens: 10 })).toThrow("paused");
});

test("cursor gaps and data tampering fail closed", () => {
  const file = path();
  const store = open(file);
  store.append({ type: "bootstrap", block: 99, nonce: 0 });
  expect(() => store.append({ type: "fills", from: 101, through: 102, fills: [] })).toThrow("cursor gap");
  store.close();
  const db = new Database(file);
  db.exec("UPDATE events SET payload='{}'");
  db.close();
  expect(() => open(file)).toThrow("checksum");
});

test("committed data survives SIGKILL and the dead writer is recovered", async () => {
  const file = path();
  const code = `import { TradingJournal } from './src/journal'; const j = new TradingJournal(process.argv[1], JSON.parse(process.argv[2])); j.append({type:'bootstrap',block:99,nonce:0}); console.log('ready'); setInterval(()=>{},1000);`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", code, file, JSON.stringify(identity)], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const output = await reader.read();
    expect(new TextDecoder().decode(output.value)).toContain("ready");
    reader.releaseLock();
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
  expect(open(file).replay()).toEqual([{ type: "bootstrap", block: 99, nonce: 0 }]);
});

test("deleted accounting chunks cannot silently reopen with a cursor gap", () => {
  const file = path();
  const store = open(file);
  store.append({ type: "bootstrap", block: 99, nonce: 0 });
  store.append({ type: "fills", from: 100, through: 100, fills: [] });
  store.append({ type: "fills", from: 101, through: 101, fills: [] });
  store.close();
  const db = new Database(file);
  db.exec("DELETE FROM events WHERE event_key='fills:100'");
  db.close();
  expect(() => open(file)).toThrow("cursor sequence");
});
