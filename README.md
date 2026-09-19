# jev-trader

One decision every Monad block. A TypeSafe Jev model watches the Kuru MON-USDC order book and answers buy or sell every ~300 ms. Every block posts a real post-only limit order on that side, one tick inside the touch, replacing the last one. Fills happen when a taker hits it, so the bot earns the spread instead of paying it. A small server streams every block to the dashboard.

## Run

    cp .env.example .env
    bun install
    bun run start

Simulation is the default, even with a `PRIVATE_KEY`: real book, real decisions, simulated fills. Live mode requires explicit `DRY_RUN=false` and a valid key. Unknown boolean/model values and invalid numeric limits fail before initialization. Jev also requires a persistent journal and an explicit positive `MODEL_CALL_LIMIT`; paid-provider simulation is currently blocked because dry mode has no journal. Set `MODEL=jev` and `TYPESAFE_AI_API_KEY` to configure Jev; the default `mock` is a momentum heuristic stand-in.

Startup is read-only: it never deposits funds or approves tokens. Margin must be funded separately; the old `MARGIN_MON` and `MARGIN_USDC` settings are no longer used. Initialization checks RPC chain IDs, native MON base, market size limits and (live) whether the configured margin account verifies the market. These checks do not authenticate contracts or replace full account reconciliation and risk-budget work. Keep simulation enabled while that work is incomplete.

`DECISION_DEADLINE_MS` (default 250) limits book reading, model evaluation and signing. A newer observed block also invalidates an unfinished decision. Book data older than the triggering block is rejected. Freshness is checked again after signing, immediately before broadcast. RPCs have a `RPC_TIMEOUT_MS` deadline (default 5000). A broadcast already started is not canceled by the decision deadline. If its RPC request fails or times out, its locally computed hash and reserved nonce remain tracked as uncertain. Delayed events are emitted in block order.

Uncertain transactions pause new orders, preserve exposure and keep being polled. Live mode commits the intent, nonce and transaction hash to a local SQLite journal **before broadcast**, then records receipts, individual fills, decision usage and the fill cursor. Restart replays this journal, catches up missed fills, checks nonces and verifies known resting orders and margin balances at a pinned block before allowing a fresh decision. Repeated receipts/fills do not duplicate accounting; a fill arriving before placement confirmation cannot resurrect a completed order.

`STATE_PATH` defaults to `data/live.sqlite`. Keep it on a persistent local volume, including in containers. One process owns the journal; a second writer, mismatched wallet/market/chain, invalid history or storage failure blocks trading. The journal stores no private keys or signed transaction bytes. Do not delete it to unblock recovery, and do not copy a running SQLite database without a SQLite-aware backup procedure (the WAL can contain committed data).

An empty journal accepts only a fresh signer with both latest and pending nonce zero. An already used wallet requires an imported, reconciled journal; an import tool is not implemented yet. Use a dedicated signer. A permanently dropped transaction, or a deadline expiring after intent commit but before broadcast, can leave recovery paused; automatic replacement/rebroadcast is not implemented.

If a book/model decision fails or expires, the model returns `hold`, or neither side can be quoted, existing orders trigger a durable protection pause. After earlier transactions settle and fill logs catch up, the bot submits `batchCancelOrders` without a book/model call or a replacement order. Exposure stays reserved until a valid receipt accounts for every canceled id. Once orders and pending transactions are gone, a later fresh block may resume decisions. A reverted cancellation latches `cancellation_failed` across restarts, without unlimited gas-burning retries; diagnosis and a safe recovery workflow remain necessary.

Cancellation uses the same nonce manager and durable transaction lifecycle as placement. Events with `kind: "cancel"` have size/price zero and an ignored legacy side field; successful receipts use `status: "canceled"`. Older quote events omit `kind`. No inventory liquidation is performed. Simulation removes simulated resting orders without signing.

This is not yet ready for unattended live operation: a loss budget, full equity accounting, shutdown handling and chain-reorganization handling remain pending. Protection needs a working process, block/log feed, RPC, signer, storage and gas; it cannot cancel while those are unavailable or earlier transactions remain unresolved. Verification covers known orders, not discovery of all preexisting account activity. The journal currently grows without compaction; decision costs are reconstructed using the configured token price.

## Gas allocation

`GAS_BUDGET_MON` sets a lifetime ceiling for the journal, including cancellations. `CANCEL_RESERVE_MON` reserves part of that ceiling for cancel-only transactions. Both default to zero; live sends stay blocked until configured explicitly. Values support up to 18 decimal places. Simulation remains usable with zero budgets.

Each intent saves `maxGasWei = gasLimit * maxFeePerGas` before broadcast. That maximum remains allocated after receipts, reverts, ambiguous sends and restarts, even if actual gas cost is lower. This conservative allocation is distinct from actual gas expenditure shown in totals. Raising the configured ceiling explicitly increases permitted lifetime allocation; restarting or lowering fees does not erase prior allocations. No daily reset or automatic refill exists.

A quote must leave the cancellation reserve untouched; that reserve must cover at least one cancel transaction at the current gas limit and maximum fee. Cancel-only transactions can use the remaining total budget. Exhaustion pauses model decisions and invokes the existing protection flow for known resting orders. Once they are removed, exhaustion keeps the bot paused. Snapshot health includes allocated/limit/reserve in wei and the blocking reason.

The reserve is not segregated funds. Native MON balance is checked separately with `eth_getBalance` at the observed block before model decisions and again before signing. Quotes require the new maximum gas cost, the configured cancellation reserve, and maximum costs of unresolved transactions; cancels can use the reserve. Invalid or failed reads block signing. Insufficient/unavailable balance pauses model calls and is rechecked during protection; a successful recheck permits a later fresh block to resume. This snapshot cannot prevent external wallet spending or guarantee future inclusion; keep the signer dedicated. Gas adequacy for a large cancellation batch remains to be verified. Existing journals with intents missing `maxGasWei` stay readable for recovery but block new sends, including cancels, with `gas_history_incomplete`; no automatic migration or guessed historical ceiling is applied. Do not delete history to reset the budget. These controls do not cap trading losses or model charges independently.

## Model call quota

`MODEL_CALL_LIMIT` is the lifetime number of paid-provider attempts allowed for this journal, zero by default. The built-in Jev adapter declares `paid: true`; new external adapters must do the same. Local mock calls do not consume the quota. Each attempt is persisted before invoking the provider, and remains allocated after errors, deadlines or restarts. A decision that expires just after persistence can consume a slot without reaching the provider; this is intentionally conservative. Successful decisions reference their reserved call.

Exhaustion pauses further model requests and lets the protection flow cancel existing orders. It stays paused after cancellation. Increasing the configured quota explicitly adds capacity; there is no automatic refill. The initial snapshot exposes allocated calls, configured limit and blocking reason. A journal containing older decisions without call IDs blocks paid calls as `model_history_incomplete`; recovery requires an audited migration, not deletion of history. Paid calls without a journal are blocked as `model_journal_required`, including current dry mode. Use `MODEL=mock` for simulation until a separate simulation journal is implemented.

This counts application-level provider attempts, not dollars or tokens. It does not establish a maximum invoice per request or account for use outside this process. Existing token-based cost displays remain estimates and can omit usage from failed or late responses.

## Checks

    bun run test
    bun run typecheck

Tests use synthetic keys and mocked network/market calls, disable automatic `.env` loading, and write trader logs only to temporary directories. No real trading process is started. The backend currently has no lint script. Implementation progress and outstanding safety work are in `docs/audit-2026-09-18/RETOMAR.md`.

## Endpoints

Deployed (dry run, mock model): https://jev-trader-production.up.railway.app

- `GET /` snapshot: model, wallet, dryRun, latest block event, health (running/reconciling/paused and reason)
- `GET /history` last 1000 block events
- `GET /events` SSE: `snapshot` on connect, then one `block` event per block, plus a `fill` event whenever a live order's receipt lands

Every event (see `src/trader.ts` for types):

    {
      "block": 105488269, "ts": 1789593630676,
      "mid": 0.022636, "bestBid": 0.022628, "bestAsk": 0.022644, "spreadBps": 7.07,
      "decision": { "action": "buy", "probabilities": { "buy": 0.77, "sell": 0.23, "hold": 0 }, "upIn10": 0.77, "latencyMs": 81, "late": false },
      "quote": { "side": "buy", "price": 0.022629, "size": 200, "txHash": "0x…", "gasMon": 0.0357, "cancel": [100295801], "status": "sent", "orderId": null, "capped": false },
      "fill": null,
      "resting": { "bidMon": 200, "askMon": 200 },
      "position": { "side": "short", "size": 200, "entryPrice": 0.022633, "unrealizedUsd": -0.0006, "unrealizedMon": -0.027 },
      "totals": { "blocks": 3, "decisions": 3, "quotes": 3, "fills": 1, "reverted": 0, "lateBlocks": 0, "jevUsd": 0.000004, "gasMon": 0.107, "gasUsd": 0.0024, "realizedUsd": 0, "pnlUsd": -0.003, "pnlMon": -0.13, "pnlPct": -0.003 }
    }

Every block the model is asked about the move over `HORIZON_BLOCKS` (default 100, ~30 s) and answers `buy` or `sell`. `quote` is the order that block put on the book: a post-only limit order of `TRADE_SIZE_MON` on that side, `QUOTE_INSIDE_TICKS` inside the touch (clamped to the touch when the spread is too tight), in one `batchUpdate` that also cancels everything we had resting (`cancel`). `hold` marks a late decision or an explicit no-trade response; it never creates a new order. Existing resting orders enter the protection cancellation flow. When the position cap (or, live, margin funds) blocks a side, the quote goes on the other side with `capped: true` and `probabilities` still show the model's call. `resting` is our size known to be on the book after this block. `upIn10` equals the buy probability.

Live sends are fired and forgotten, so the `block` event carries the **intent**: `status: "sent"`, `gasMon` is `gasLimit x (last known base fee + priority)`. Monad charges the gas limit, so that is the real cost whether the order lands or not. The receipt arrives a block or two later as its own SSE event:

    event: quote
    data: { "block": 105488269, "quote": { …, "status": "placed", "orderId": 100295812, "gasMon": 0.0357 } }

`status` becomes `placed` (with the order id) or `reverted` (the book moved through the price before the tx landed, or a cancelled order had already filled). No receipt after 10 blocks gives `lost`, meaning uncertain, not canceled: exposure is retained, new orders pause, and a later receipt can still resolve it. A failed broadcast response also produces `lost` with the locally computed transaction hash. `gasMon: 0` on that uncertain status means unconfirmed cost, not proof that no gas was spent. Fills are not in our own transactions: someone else's taker order hits our resting one, and the Trade log for it arrives via the same `eth_getLogs` poll that feeds the model. Each block with fills gets its own SSE event, and `position`, `realizedUsd` and `fills` update then:

    event: fill
    data: { "block": 105488271, "fill": { "side": "buy", "size": 200, "price": 0.022629, "txHash": "0x…", "orderId": 100295812, "simulated": false } }

`txHash` is the taker's transaction. In a dry run the quote is `status: "sim"`: the order rests for one block and a real print crossing its price fills it (`simulated: true`).

## Layout

    src/config.ts   env
    src/chain.ts    block feed (WebSocket newHeads + polling backstop, newest block only), raw RPC
    src/book.ts     one-eth_call order book reader (decodes getL2Book, merges the AMM vault)
    src/market.ts   Kuru: read book, hand-encoded batchUpdate (cancel + post-only place), local nonce, async confirmation
    src/journal.ts  durable SQLite intents, receipts, fills and recovery cursor
    src/deadline.ts per-block decision deadline and cancellation
    src/model.ts    Model interface, JevModel (AI SDK experimental_evaluate), MockModel
    src/trader.ts   the loop: one in flight, hold when late, position and P&L accounting
    src/server.ts   Bun.serve: snapshot, history, SSE

## The 300 ms budget

A decision and an order have to fit in one block, so the live loop now adds two native-balance reads to the original RPC path:
one balance read before the model, one before signing, one `eth_call` for the book and one `eth_sendRawTransaction`
(`RPC_URL`), which returns as soon as the tx is accepted. A synchronous durable journal commit also precedes every live broadcast. There is no
`eth_estimateGas` (Monad charges gas on the limit, so the limit is hardcoded or derived once at
startup), no `eth_sendRawTransactionSync` (it blocks until the tx is Proposed), no gas price lookup
(static type-2 fees: `MAX_FEE_GWEI` cap, 2 gwei priority; the effective price is base + priority).
Receipts, the fee estimate and the vault check run off the hot path on later blocks. Historical measurement before native-balance checks, in a
dry run with the mock model: read p50 18 ms, whole loop p50 100 ms (80 ms of it the mock's inference stand-in).

    bun run scripts/bench-read.ts     # book reader vs the SDK: exactness and latency
    bun run scripts/dry-encode.ts     # signs a buy and a sell offline, asserts the calldata matches the SDK
