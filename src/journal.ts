import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Quote, QuoteResult } from "./market";
import type { MakerFill } from "./trades";

export interface JournalIdentity { chainId: number; wallet: string; market: string; marginAccount: string }
export interface Intent { block: number; nonce: number; quote: Quote; gasLimit: string; maxGasWei?: string }
export type JournalEvent =
  | { type: "bootstrap"; block: number; nonce: number }
  | { type: "intent"; intent: Intent }
  | { type: "receipt"; result: QuoteResult }
  | { type: "fills"; from: number; through: number; fills: MakerFill[] }
  | { type: "decision"; inputTokens: number; callId?: string }
  | { type: "model_call"; callId: string; block: number; model: string }
  | { type: "protection"; reason: string | null };

const digest = (payload: string) => createHash("sha256").update(payload).digest("hex");
const integer = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const hash = (v: unknown) => typeof v === "string" && /^0x[\da-f]{64}$/i.test(v);
const side = (v: unknown) => v === "buy" || v === "sell";
const identityKey = (identity: JournalIdentity) => JSON.stringify({ version: 1, chainId: identity.chainId, wallet: identity.wallet.toLowerCase(), market: identity.market.toLowerCase(), marginAccount: identity.marginAccount.toLowerCase() });
function validQuote(q: any) {
  const cancellation = q?.kind === "cancel";
  return q && (q.kind === undefined || q.kind === "quote" || cancellation) && side(q.side) &&
    (cancellation ? q.price === 0 && q.size === 0 && q.orderId === null && q.cancel?.length > 0 : finite(q.price) && q.price > 0 && finite(q.size) && q.size > 0) &&
    hash(q.txHash) && finite(q.gasMon) && Array.isArray(q.cancel) && q.cancel.every(integer) &&
    (cancellation ? ["sent", "canceled", "reverted", "lost"] : ["sent", "placed", "reverted", "lost"]).includes(q.status) &&
    (q.orderId === null || integer(q.orderId)) && typeof q.capped === "boolean";
}
function validate(value: any): asserts value is JournalEvent {
  let valid = false;
  if (value?.type === "bootstrap") valid = integer(value.block) && integer(value.nonce);
  if (value?.type === "protection") valid = value.reason === null || (typeof value.reason === "string" && value.reason.length > 0 && value.reason.length <= 100);
  if (value?.type === "decision") valid = integer(value.inputTokens) && (value.callId === undefined || (typeof value.callId === "string" && value.callId.length > 0));
  if (value?.type === "model_call") valid = integer(value.block) && typeof value.callId === "string" && value.callId.length > 0 && value.callId.length <= 100 && typeof value.model === "string" && value.model.length > 0;
  if (value?.type === "intent") {
    const i = value.intent;
    valid = i && integer(i.block) && integer(i.nonce) && validQuote(i.quote) && i.quote.status === "sent" && typeof i.gasLimit === "string" && /^\d+$/.test(i.gasLimit) && BigInt(i.gasLimit) > 0n && (i.maxGasWei === undefined || (typeof i.maxGasWei === "string" && /^\d+$/.test(i.maxGasWei) && BigInt(i.maxGasWei) > 0n));
  }
  if (value?.type === "receipt") {
    const r = value.result;
    valid = r && integer(r.block) && integer(r.confirmedBlock) && validQuote(r.quote) &&
      ["placed", "canceled", "reverted"].includes(r.quote.status) && Array.isArray(r.canceled) && r.canceled.every(integer) &&
      (r.quote.status !== "placed" || integer(r.quote.orderId)) &&
      (r.quote.status !== "reverted" || (r.canceled.length === 0 && r.quote.orderId === null)) &&
      (r.quote.status !== "canceled" || (r.quote.cancel.every((id: number) => r.canceled.includes(id)) && r.canceled.every((id: number) => r.quote.cancel.includes(id))));
  }
  if (value?.type === "fills") {
    valid = integer(value.from) && integer(value.through) && value.from <= value.through && Array.isArray(value.fills) &&
      value.fills.every((f: any) => f && integer(f.block) && f.block >= value.from && f.block <= value.through &&
        integer(f.logIndex) && hash(f.txHash) && integer(f.orderId) && side(f.side) && finite(f.price) && f.price > 0 &&
        finite(f.size) && f.size > 0 && finite(f.updatedSize));
  }
  if (!valid) throw new Error("Invalid trading journal event");
}

function validateSequence(events: JournalEvent[]) {
  if (!events.length) return;
  const first = events[0]!;
  if (first.type !== "bootstrap") throw new Error("Missing journal bootstrap");
  let nonce = first.nonce, cursor = first.block;
  const intents = new Map<string, Intent>(), receipts = new Set<string>();
  const calls = new Set<string>(), decisions = new Set<string>();
  for (const event of events.slice(1)) {
    if (event.type === "bootstrap") throw new Error("Duplicate journal bootstrap");
    if (event.type === "model_call") {
      if (calls.has(event.callId)) throw new Error("Duplicate model call");
      calls.add(event.callId);
    }
    if (event.type === "decision" && event.callId) {
      if (!calls.has(event.callId) || decisions.has(event.callId)) throw new Error("Invalid model decision sequence");
      decisions.add(event.callId);
    }
    if (event.type === "intent") {
      const intent = event.intent;
      if (intent.nonce !== nonce++ || intents.has(intent.quote.txHash!)) throw new Error("Journal nonce sequence is inconsistent");
      intents.set(intent.quote.txHash!, intent);
    }
    if (event.type === "receipt") {
      const quote = event.result.quote;
      const intent = intents.get(quote.txHash!);
      if (!intent || receipts.has(quote.txHash!) || intent.quote.side !== quote.side || intent.quote.size !== quote.size || intent.quote.price !== quote.price || (intent.quote.kind ?? "quote") !== (quote.kind ?? "quote") || JSON.stringify(intent.quote.cancel) !== JSON.stringify(quote.cancel)) throw new Error("Journal receipt sequence is inconsistent");
      receipts.add(quote.txHash!);
    }
    if (event.type === "fills") {
      if (event.from !== cursor + 1) throw new Error("Journal fill cursor sequence is inconsistent");
      cursor = event.through;
    }
  }
}

/** One writer on one host. Commits are durable before a caller may broadcast or advance a cursor. */
export class TradingJournal {
  private db: Database;
  private healthy = true;
  private closed = false;
  private identity: string;

  constructor(path: string, identity: JournalIdentity) {
    this.identity = identityKey(identity);
    if (path === ":memory:") throw new Error("Live journal requires a persistent file");
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec("PRAGMA busy_timeout=100; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      const check = this.db.query("PRAGMA quick_check").get() as Record<string, unknown>;
      if (Object.values(check)[0] !== "ok") throw new Error("Trading journal integrity check failed");
      this.db.exec("CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, checksum TEXT NOT NULL);");
      const expected = this.identity;
      this.db.transaction(() => {
        const prior = this.db.query("SELECT * FROM metadata WHERE id=1").get() as { identity: string } | null;
        if (prior) {
          if (prior.identity !== expected) throw new Error("Trading journal belongs to another wallet, market, margin account or chain");
        } else {
          if ((this.db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n) throw new Error("Trading journal metadata is missing");
          this.db.query("INSERT INTO metadata VALUES (1, ?)").run(expected);
        }
      }).immediate();
      this.replay(); // malformed persisted records block startup, never reset silently
    } catch (error) {
      this.close();
      if ((error as { code?: string }).code === "SQLITE_BUSY") throw new Error("Trading journal already has an active writer");
      throw error;
    }
  }

  get available() { return this.healthy && !this.closed; }
  assertIdentity(identity: JournalIdentity) {
    if (this.identity !== identityKey(identity)) throw new Error("Trading journal identity mismatch");
  }
  assertAvailable() {
    if (!this.available) throw new Error("Trading journal unavailable; trading paused");
  }

  replay(): JournalEvent[] {
    this.assertAvailable();
    try {
      const rows = this.db.query("SELECT payload, checksum FROM events ORDER BY seq").all() as { payload: string; checksum: string }[];
      const events = rows.map(row => {
        if (digest(row.payload) !== row.checksum) throw new Error("Trading journal checksum mismatch");
        const event: unknown = JSON.parse(row.payload);
        validate(event);
        return event;
      });
      validateSequence(events);
      return events;
    } catch (error) { this.healthy = false; throw error; }
  }

  /** Identical retries are no-ops; conflicting retries fail closed. */
  append(event: JournalEvent): boolean {
    this.assertAvailable();
    try {
      validate(event);
      const key = event.type === "bootstrap" ? "bootstrap" : event.type === "intent" ? `intent:${event.intent.quote.txHash}` :
        event.type === "model_call" ? `model_call:${event.callId}` : event.type === "receipt" ? `receipt:${event.result.quote.txHash}` : event.type === "fills" ? `fills:${event.through}` : event.type === "decision" && event.callId ? `decision:${event.callId}` : `${event.type}:${randomUUID()}`;
      const payload = JSON.stringify(event);
      return this.db.transaction(() => {
        const existing = this.db.query("SELECT payload FROM events WHERE event_key=?").get(key) as { payload: string } | null;
        if (existing) {
          if (existing.payload !== payload) throw new Error("Conflicting trading journal event");
          return false;
        }
        const bootstrapRow = this.db.query("SELECT payload FROM events WHERE event_key='bootstrap'").get() as { payload: string } | null;
        if (event.type !== "bootstrap" && !bootstrapRow) throw new Error("Trading journal must be bootstrapped before use");
        if (event.type === "decision" && event.callId && !this.db.query("SELECT 1 FROM events WHERE event_key=?").get(`model_call:${event.callId}`)) throw new Error("Model decision has no reserved call");
        if (event.type === "intent") {
          const last = this.db.query("SELECT payload FROM events WHERE event_key LIKE 'intent:%' ORDER BY seq DESC LIMIT 1").get() as { payload: string } | null;
          const expectedNonce = last ? (JSON.parse(last.payload) as Extract<JournalEvent, { type: "intent" }>).intent.nonce + 1 : JSON.parse(bootstrapRow!.payload).nonce;
          if (event.intent.nonce !== expectedNonce) throw new Error("Trading journal nonce gap or reuse");
        }
        if (event.type === "receipt") {
          const intent = this.db.query("SELECT payload FROM events WHERE event_key=?").get(`intent:${event.result.quote.txHash}`) as { payload: string } | null;
          if (!intent) throw new Error("Receipt has no persisted intent");
          const saved = (JSON.parse(intent.payload) as Extract<JournalEvent, { type: "intent" }>).intent;
          if (event.result.quote.side !== saved.quote.side || event.result.quote.size !== saved.quote.size || event.result.quote.price !== saved.quote.price || (event.result.quote.kind ?? "quote") !== (saved.quote.kind ?? "quote") || JSON.stringify(event.result.quote.cancel) !== JSON.stringify(saved.quote.cancel)) throw new Error("Receipt conflicts with persisted intent");
        }
        if (event.type === "fills") {
          const last = this.db.query("SELECT payload FROM events WHERE event_key LIKE 'fills:%' ORDER BY seq DESC LIMIT 1").get() as { payload: string } | null;
          const cursor = last ? JSON.parse(last.payload).through : JSON.parse(bootstrapRow!.payload).block;
          if (event.from !== cursor + 1) throw new Error("Trading journal fill cursor gap or overlap");
        }
        this.db.query("INSERT INTO events (event_key, payload, checksum) VALUES (?, ?, ?)").run(key, payload, digest(payload));
        return true;
      }).immediate();
    } catch (error) { this.healthy = false; throw error; }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close(); // OS/SQLite locks also release automatically if the process crashes.
  }
}
