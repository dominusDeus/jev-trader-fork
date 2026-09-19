// Historical diagnostics: exercise the audited Git snapshot with mocked IO. No RPC or keys.
// These assertions document defects, not desired regression-test behavior.
// Run from the repo: NODE_PATH="$(npm root -g)" node docs/audit-2026-09-18/reproduce.cjs
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function load(file, dependencies) {
  const source = execFileSync('git', ['show', `236c99e32a9998d9e88cf70f78d49628eadc212c:${file}`], { cwd: root, encoding: 'utf8' });
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: (id) => {
    if (!(id in dependencies)) throw new Error(`Unexpected dependency: ${id}`);
    return dependencies[id];
  }, performance, console, Date, setTimeout }, { filename: file });
  return exports;
}
const config = { refreshBlocks: 200, tradeSizeMon: 200, maxPositionMon: 1000, horizonBlocks: 100, jevUsdPerMTok: 0.042, bankrollUsd: 100, historySize: 1000 };
const writes = [];
const { Trader } = load('src/trader.ts', { './config': { config }, './trades': {}, './market': {}, 'node:fs': { mkdirSync() {}, appendFileSync: (_, text) => writes.push(text) } });
const book = { block: 100, bid: 0.02, ask: 0.021, mid: 0.0205, spreadBps: 488, imbalance: 0, depthBps: {}, levels: { bids: [], asks: [] } };
const decision = () => ({ action: 'buy', probabilities: { buy: 0.8, sell: 0.2, hold: 0 }, upIn10: 0.8, latencyMs: 1, inputTokens: 100 });
const quote = { side: 'buy', price: 0.02, size: 200, txHash: '0xabc', gasMon: 0, cancel: [], status: 'placed', orderId: 7, capped: false };
const market = { wallet: null, pollPending: async () => [], readBook: async () => book, refresh: async () => {} };
const fresh = () => new Trader(market, { decide: async () => decision() }, () => {});

(async () => {
  let release;
  let entered;
  const started = new Promise(r => { entered = r; });
  const gate = new Promise(r => { release = r; });
  const sent = [];
  const trader = new Trader({ ...market, send: async block => { sent.push(block); return { ...quote, status: 'sim' }; } }, { decide: async () => { entered(); await gate; return decision(); } }, () => {});
  const running = trader.onBlock(100);
  await started;
  await trader.onBlock(101);
  release();
  await running;
  assert.equal(sent[0], 100);
  assert.equal(trader.history.map(e => e.block).join(','), '101,100');
  console.log('CONFIRMED: old block 100 sends after block 101; history is 101,100.');

  const lost = fresh();
  lost.inflight.set(quote.txHash, quote);
  assert.equal(lost.restingMon('buy'), 200);
  lost.applyQuoteResult({ block: 100, quote: { ...quote, status: 'lost' }, canceled: [] });
  assert.equal(lost.restingMon('buy'), 0);
  console.log('CONFIRMED: lost status releases all reserved exposure without chain reconciliation.');

  const race = fresh();
  race.liveFills([{ ...quote, updatedSize: 0, block: 101 }]);
  race.applyQuoteResult({ block: 100, quote, canceled: [] });
  assert.equal(race.orders.get(7).size, 200);
  console.log('CONFIRMED: a late placement receipt resurrects an already fully filled order.');

  const pnl = fresh();
  pnl.totals.jevUsd = 1;
  pnl.emit(100, book, decision(), null, false);
  assert.equal(pnl.history[0].totals.pnlUsd, 0);
  const stored = writes.at(-1);
  pnl.applyQuoteResult({ block: 100, quote, canceled: [] });
  assert.equal(JSON.parse(stored).quote, null);
  assert.equal(pnl.history[0].quote.status, 'placed');
  console.log('CONFIRMED: $1 model cost leaves P&L at $0; persisted block is not updated by receipt.');

  const spans = [];
  const { TradeFeed } = load('src/trades.ts', { './book': {}, './chain': { rpc: async (_, [filter]) => { spans.push(filter); return []; } } });
  const feed = new TradeFeed({ market: 'mock', url: 'mock', sizeDec: 10 });
  feed.lastBlock = 100;
  await feed.poll(1201);
  assert.equal(parseInt(spans[0].fromBlock, 16), 202);
  assert.equal(feed.lastBlock, 1201);
  console.log('CONFIRMED: catch-up silently skips blocks 101–201 and advances cursor to 1201.');
})().catch(error => { console.error(error); process.exitCode = 1; });
