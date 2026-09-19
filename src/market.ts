import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import MarginAccountAbi from "@kuru-labs/kuru-sdk/abi/MarginAccount.json";
import { config } from "./config";
import { rpc } from "./chain";
import { readBook as fetchBook, readVaultParams, vaultActive, log10 } from "./book";
import { GasBudget } from "./gas-budget";
import { TradingJournal } from "./journal";

export interface Book {
  block: number;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  /** (bidDepth - askDepth) / (bidDepth + askDepth) within 1% of mid. -1..1 */
  imbalance: number;
  /** Top 5 levels each side, best first: [price, size]. */
  levels: { bids: [number, number][]; asks: [number, number][] };
  /** Cumulative MON depth within N bps of mid, per side. */
  depthBps: { [band: string]: { bid: number; ask: number } };
}

export type Side = "buy" | "sell";

/**
 * This block's order: a post-only limit order resting on Kuru's book, replacing last block's.
 * `sent` until the receipt lands, then `placed` (with its orderId) or `reverted` (the book moved
 * through the price, or a cancelled id had already filled). `lost` means uncertain: keep polling
 * and reserve exposure until a receipt resolves it. It does not mean dropped by the chain.
 */
export interface Quote {
  /** Omitted means quote for older journals. Cancel-only uses zero size/price; side is ignored. */
  kind?: "quote" | "cancel";
  side: Side;
  price: number; // USDC per MON, tick aligned
  size: number; // MON
  txHash: string | null;
  gasMon: number; // gasLimit x gas price: Monad charges the limit, not gasUsed
  cancel: number[]; // resting order ids this tx cancels
  status: "sent" | "placed" | "reverted" | "lost" | "sim" | "canceled";
  orderId: number | null;
  /** The position cap or margin funds picked this side; the model's probabilities still show its call. */
  capped: boolean;
}

/** A maker fill: someone hit one of our resting orders. Arrives via the Trade log feed, not our own receipts. */
export interface Fill {
  side: Side;
  size: number; // MON
  price: number; // USDC per MON: our order's price
  txHash: string | null; // the taker's transaction
  orderId: number;
  simulated: boolean;
}

export interface QuoteResult { block: number; quote: Quote; canceled: number[]; confirmedBlock?: number }

const gwei = (n: number) => ethers.utils.parseUnits(String(n), "gwei");
const BN = ethers.BigNumber;
const ZERO_ADDRESS = ethers.constants.AddressZero;

interface Pending { block: number; quote: Quote; gasLimit: ethers.BigNumber; broadcasting: boolean; maxGasWei?: string }

/** Kuru MON-USDC market: read the book, post one limit order per block, confirm asynchronously. */
export class Market {
  readonly provider = new ethers.providers.StaticJsonRpcProvider(config.rpcUrl, config.chainId);
  /** null unless DRY_RUN=false is explicitly configured with a valid key. */
  readonly wallet = config.dryRun ? null : new ethers.Wallet(config.privateKey!, this.provider);
  params!: Kuru.MarketParams; // public so scripts can build txs without init()
  /** Margin account balances, refreshed every `config.refreshBlocks`. Limit orders draw from here. */
  margin = { mon: 0, usdc: 0 };
  private iface = new ethers.utils.Interface(OrderBookAbi.abi);
  private marginIface = new ethers.utils.Interface(MarginAccountAbi.abi);
  private nonce = 0;
  private submitting = false;
  private gasBudget = new GasBudget();
  private nativeGasReason: string | null = null;
  private nativeBalanceWei: string | null = null;
  private feeWei = gwei(102); // base + priority, last known; Monad's floor is 100 + 2
  private gasLimit = BN.from(config.gasLimitFallback);
  private useVault = false;
  private pending = new Map<string, Pending>();
  readonly journal: TradingJournal | null;

  constructor(options: { journal?: TradingJournal; offline?: boolean } = {}) {
    this.journal = this.wallet && !options.offline ? options.journal ?? new TradingJournal(config.statePath, {
      chainId: config.chainId, wallet: this.wallet.address, market: config.market, marginAccount: config.marginAccount,
    }) : null;
    if (this.journal) this.journal.assertIdentity({ chainId: config.chainId, wallet: this.wallet!.address, market: config.market, marginAccount: config.marginAccount });
    for (const event of this.journal?.replay() ?? []) {
      if (event.type === "bootstrap") this.nonce = event.nonce;
      if (event.type === "intent") {
        const i = event.intent;
        this.gasBudget.record(i);
        this.nonce = Math.max(this.nonce, i.nonce + 1);
        this.pending.set(i.quote.txHash!, { block: i.block, quote: { ...i.quote, status: "lost", gasMon: 0 }, gasLimit: BN.from(i.gasLimit), broadcasting: false, maxGasWei: i.maxGasWei });
      }
      if (event.type === "receipt") this.pending.delete(event.result.quote.txHash!);
    }
  }

  get address() { return this.wallet?.address ?? null; }
  get hasUncertainTransactions() { return (this.journal !== null && !this.journal.available) || [...this.pending.values()].some(p => p.quote.status === "lost"); }
  get quoteBudgetReason() {
    return this.wallet ? (this.gasBudget.reason(this.maxGasWei(), BigInt(config.gasBudgetWei), BigInt(config.cancelReserveWei)) ?? this.nativeGasReason) : null;
  }
  get gasBudgetStatus() {
    return { ...this.gasBudget.snapshot(), limitWei: config.gasBudgetWei, cancelReserveWei: config.cancelReserveWei, quoteBlockReason: this.quoteBudgetReason, nativeBalanceWei: this.nativeBalanceWei, nativeGasReason: this.nativeGasReason };
  }
  /** Recheck an observed block; no cached balance authorizes a signature. */
  async refreshNativeGas(block: number) {
    if (!this.wallet) return;
    await this.assertNativeGas(block, this.maxGasWei(), false);
  }

  private async assertNativeGas(block: number, cost: bigint, cancel: boolean) {
    // Capture reservations before awaiting: receipts can resolve while the read is in flight.
    const reservations = [...this.pending.values()].map(p => p.maxGasWei);
    this.nativeBalanceWei = null;
    try {
      if (!Number.isSafeInteger(block) || block < 0 || reservations.some(v => v === undefined)) throw new Error("Invalid gas balance context");
      const raw = await rpc<string>("eth_getBalance", [this.wallet!.address, "0x" + block.toString(16)]);
      if (typeof raw !== "string" || !/^0x[\da-f]+$/i.test(raw) || raw.length > 66) throw new Error("Invalid native balance response");
      const balance = BigInt(raw);
      this.nativeBalanceWei = balance.toString();
      const pendingCost = reservations.reduce<bigint>((sum, value) => sum + BigInt(value!), 0n);
      const reserve = BigInt(config.cancelReserveWei);
      this.nativeGasReason = balance < pendingCost + cost + reserve ? "native_gas_insufficient" : null;
      if (balance < pendingCost + cost + (cancel ? 0n : reserve)) throw new Error("native_gas_insufficient");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "native_gas_insufficient") this.nativeGasReason = "native_gas_unavailable";
      throw new Error(this.nativeGasReason ?? "native_gas_unavailable");
    }
  }
  private maxGasWei() { return BigInt(this.gasLimit.mul(gwei(config.maxFeeGwei)).toString()); }
  private get priceDec() { return log10(this.params.pricePrecision); }
  private get sizeDec() { return log10(this.params.sizePrecision); }
  private get tickUnits() { return Number(this.params.tickSize.toString()); }

  async init() {
    if (this.wallet && !this.journal) throw new Error("Live initialization requires a durable journal");
    // StaticJsonRpcProvider assumes its configured chain; explicitly verify both endpoints.
    for (const url of new Set([config.rpcUrl, config.readRpcUrl])) {
      const chain = await rpc<string>("eth_chainId", [], url);
      if (!/^0x[\da-f]+$/i.test(chain) || BigInt(chain) !== BigInt(config.chainId)) throw new Error("RPC chainId does not match the configured chain");
    }
    this.params = await Kuru.ParamFetcher.getMarketParams(this.provider, config.market);
    if (ethers.utils.getAddress(this.params.baseAssetAddress) !== ZERO_ADDRESS) throw new Error("Only native MON base markets are supported");
    // Reject sizes that would otherwise be silently rounded in encode().
    if (!/^10*$/.test(this.params.sizePrecision.toString()) || this.sizeDec > 18) throw new Error("Unsupported market size precision");
    let size: ethers.BigNumber;
    try { size = ethers.utils.parseUnits(String(config.tradeSizeMon), this.sizeDec); }
    catch { throw new Error("TRADE_SIZE_MON exceeds market size precision"); }
    if (size.lt(this.params.minSize) || size.gt(this.params.maxSize)) throw new Error("TRADE_SIZE_MON is outside market size limits");
    if (this.wallet) {
      const data = this.marginIface.encodeFunctionData("verifiedMarket", [config.market]);
      const verified = await rpc<string>("eth_call", [{ to: config.marginAccount, data }, "latest"]);
      if (BN.from(verified).toString() !== "1") throw new Error("Market is not verified by MARGIN_ACCOUNT");
    }
    await this.refresh();
    if (!this.wallet) return;
    await this.reconcileNonce();
    // Funding/approvals are deliberately outside the trading process.
    await this.initGasLimit();
  }

  /** Every `config.refreshBlocks`: fee estimate, margin balances, and whether the Kuru AMM vault went live. */
  async refresh() {
    const [fee, vault, mon, usdc] = await Promise.allSettled([
      rpc<string>("eth_gasPrice"),
      readVaultParams(config.readRpcUrl, config.market),
      this.wallet ? this.marginBalance(ZERO_ADDRESS) : Promise.resolve(null),
      this.wallet ? this.marginBalance(this.params.quoteAssetAddress) : Promise.resolve(null),
    ]);
    if (fee.status === "fulfilled") this.feeWei = BN.from(fee.value);
    if (vault.status === "fulfilled") this.useVault = vaultActive(vault.value);
    if (mon.status === "fulfilled" && mon.value) this.margin.mon = Number(ethers.utils.formatUnits(mon.value, this.params.baseAssetDecimals.toNumber()));
    if (usdc.status === "fulfilled" && usdc.value) this.margin.usdc = Number(ethers.utils.formatUnits(usdc.value, this.params.quoteAssetDecimals.toNumber()));
  }

  /** One eth_call (two batched into one HTTP request once the vault is live). */
  readBook(signal?: AbortSignal): Promise<Book> {
    return fetchBook(config.readRpcUrl, config.market, this.params, { vault: this.useVault, timeoutMs: config.rpcTimeoutMs, signal });
  }

  /**
   * Where this block's order rests: `quoteInsideTicks` inside the touch on our side, never crossing.
   * If the spread is too tight to step inside, join the touch. Integer tick math, so the price is
   * exactly representable on-chain.
   */
  quotePrice(side: Side, book: Book): number {
    const scale = 10 ** this.priceDec, tick = this.tickUnits;
    const bidU = Math.round(book.bid * scale), askU = Math.round(book.ask * scale);
    const step = config.quoteInsideTicks * tick;
    let p = side === "buy" ? bidU + step : askU - step;
    if (side === "buy" && p >= askU) p = bidU;
    if (side === "sell" && p <= bidU) p = askU;
    return p / scale;
  }

  /**
   * Sign and fire one `batchUpdate`: cancel the given resting orders, post one new post-only limit
   * order. Returns as soon as the RPC has the hash. `pollPending` resolves placed/reverted later.
   */
  async send(block: number, side: Side, sizeMon: number, book: Book, cancel: number[], capped: boolean, assertFresh: () => void): Promise<Quote> {
    assertFresh();
    if (this.hasUncertainTransactions || [...this.pending.values()].some(p => p.quote.kind === "cancel")) throw new Error("Trading paused: unresolved transaction");
    const price = this.quotePrice(side, book);
    if (!this.wallet) return { side, price, size: sizeMon, txHash: null, gasMon: 0, cancel, status: "sim", orderId: null, capped };
    if (!this.journal) throw new Error("Live orders require a durable journal");
    this.journal.assertAvailable();

    return this.submit(block, { side, price, size: sizeMon, txHash: null, gasMon: 0, cancel, status: "sent", orderId: null, capped }, this.buildTx(side, sizeMon, price, cancel), assertFresh);
  }

  /** Remove known orders without reading the book, calling a model or placing new exposure. */
  async cancelOrders(block: number, ids: number[]): Promise<Quote> {
    if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0 || id >= 2 ** 40) || new Set(ids).size !== ids.length) throw new Error("Invalid cancellation order ids");
    // Wait for earlier placements/cancellations to settle before choosing what to cancel.
    if (this.pending.size || this.hasUncertainTransactions) throw new Error("Cancellation waiting for pending transactions");
    const quote: Quote = { kind: "cancel", side: "buy", price: 0, size: 0, txHash: null, gasMon: 0, cancel: [...ids], status: "sim", orderId: null, capped: false };
    if (!this.wallet) return quote;
    const tx = this.transaction(this.iface.encodeFunctionData("batchCancelOrders", [ids]));
    return this.submit(block, quote, tx, () => {});
  }

  private async submit(block: number, draft: Quote, tx: ethers.providers.TransactionRequest, assertFresh: () => void): Promise<Quote> {
    if (this.submitting) throw new Error("Another transaction is being submitted");
    if (!this.journal || !this.wallet) throw new Error("Live orders require a durable journal");
    this.journal.assertAvailable();
    this.submitting = true;
    try {
      const maxGasWei = BigInt(BN.from(tx.gasLimit!).mul(BN.from(tx.maxFeePerGas!)).toString());
      const reason = this.gasBudget.reason(maxGasWei, BigInt(config.gasBudgetWei), BigInt(config.cancelReserveWei), draft.kind === "cancel");
      if (reason) throw new Error(reason);
      await this.assertNativeGas(block, maxGasWei, draft.kind === "cancel");
      assertFresh(); // balance lookup must not authorize a stale decision
      const signed = await this.wallet.signTransaction(tx);
      assertFresh(); // signing is async: the block/deadline may have changed
      const hash = ethers.utils.keccak256(signed);
      const quote: Quote = { ...draft, txHash: hash, gasMon: this.gasMon(this.gasLimit, this.feeWei), status: "sent" };
      const pending: Pending = { block, quote, gasLimit: this.gasLimit, broadcasting: true, maxGasWei: maxGasWei.toString() };
      // FULL SQLite commit precedes any network write. Never persist the key or signed payload.
      const intent = { block, quote, nonce: this.nonce, gasLimit: this.gasLimit.toString(), maxGasWei: maxGasWei.toString() };
      this.journal.append({ type: "intent", intent });
      this.gasBudget.record(intent);
      // Know the hash and reserve the nonce before an ambiguous RPC response can occur.
      this.pending.set(hash, pending);
      this.nonce++;
      try {
        assertFresh(); // the disk commit also consumes the decision budget
        const accepted = await rpc<string>("eth_sendRawTransaction", [signed]);
        if (accepted?.toLowerCase() !== hash) throw new Error("RPC returned an unexpected transaction hash");
      } catch {
        // Even a transport error may follow successful acceptance. Never reuse the nonce.
        pending.quote = { ...quote, status: "lost", gasMon: 0 };
      } finally {
        pending.broadcasting = false;
      }
      return pending.quote;
    } finally { this.submitting = false; }
  }

  /** One eth_getTransactionReceipt per in-flight tx. Returns whatever resolved (or timed out). */
  async pollPending(block: number): Promise<QuoteResult[]> {
    if (!this.pending.size) return [];
    const out: QuoteResult[] = [];
    await Promise.all([...this.pending].map(async ([hash, p]) => {
      if (p.broadcasting) return;
      const receipt = await rpc<any>("eth_getTransactionReceipt", [hash]).catch(() => null);
      if (this.pending.get(hash) !== p) return; // an overlapping poll already resolved it
      let result: QuoteResult | undefined;
      if (receipt?.transactionHash?.toLowerCase() === hash && /^0x[\da-f]+$/i.test(receipt.blockNumber) && parseInt(receipt.blockNumber, 16) <= block && (receipt.status === "0x0" || receipt.status === "0x1")) {
        try {
          result = this.parseReceipt(receipt, p);
          if (result.quote.status === "placed" && result.quote.orderId === null) throw new Error("Missing OrderCreated event");
        } catch { result = undefined; /* preserve exposure for malformed receipts */ }
      }
      if (result) {
        this.journal!.append({ type: "receipt", result });
        this.pending.delete(hash);
        out.push(result);
        return;
      }
      if (block - p.block >= config.pendingBlocks && p.quote.status !== "lost") {
        p.quote = { ...p.quote, status: "lost", gasMon: 0 };
        out.push({ block: p.block, quote: p.quote, canceled: [] });
      }
    }));
    return out;
  }

  /** The exact transaction the hot loop signs: no pre-send RPC, hardcoded gas limit, static type-2 fees. */
  buildTx(side: Side, sizeMon: number, price: number, cancel: number[]): ethers.providers.TransactionRequest {
    return this.transaction(this.encode(side, sizeMon, price, cancel));
  }

  private transaction(data: string): ethers.providers.TransactionRequest {
    return {
      type: 2, chainId: config.chainId, to: config.market, nonce: this.nonce, gasLimit: this.gasLimit,
      maxFeePerGas: gwei(config.maxFeeGwei), maxPriorityFeePerGas: gwei(config.priorityFeeGwei),
      data, value: BN.from(0),
    };
  }

  /** batchUpdate(buyPrices, buySizes, sellPrices, sellSizes, orderIdsToCancel, postOnly). Funds come from the margin account, so value is 0. */
  encode(side: Side, sizeMon: number, price: number, cancel: number[]): string {
    const priceU = BN.from(Math.round(price * 10 ** this.priceDec));
    const sizeU = ethers.utils.parseUnits(sizeMon.toFixed(this.sizeDec), this.sizeDec);
    const [bp, bs, sp, ss] = side === "buy" ? [[priceU], [sizeU], [], []] : [[], [], [priceU], [sizeU]];
    return this.iface.encodeFunctionData("batchUpdate", [bp, bs, sp, ss, cancel.map((id) => BN.from(id)), true]);
  }

  /** OrderCreated for our address gives the new order id; OrdersCanceled lists what the tx removed. status 0x0: nothing changed on the book. */
  private parseReceipt(r: any, p: Pending): QuoteResult {
    if (r.effectiveGasPrice) this.feeWei = BN.from(r.effectiveGasPrice);
    const gasMon = this.gasMon(p.gasLimit, BN.from(r.effectiveGasPrice ?? this.feeWei));
    const me = this.wallet!.address.toLowerCase();
    let orderId: number | null = null;
    const canceled: number[] = [];
    if (r.status !== "0x0") {
      for (const log of r.logs ?? []) {
        if (String(log.address).toLowerCase() !== config.market.toLowerCase()) continue;
        let ev; try { ev = this.iface.parseLog(log); } catch { continue; }
        if (ev.name === "OrderCreated" && String(ev.args.owner).toLowerCase() === me) orderId = Number(ev.args.orderId);
        if (ev.name === "OrdersCanceled" && String(ev.args.owner).toLowerCase() === me) for (const id of ev.args.orderId) canceled.push(Number(id));
      }
    }
    const status: Quote["status"] = r.status === "0x0" ? "reverted" : p.quote.kind === "cancel" ? "canceled" : "placed";
    if (status === "canceled" && (orderId !== null || p.quote.cancel.some(id => !canceled.includes(id)) || canceled.some(id => !p.quote.cancel.includes(id)))) {
      throw new Error("Cancellation receipt does not account for every requested order");
    }
    return { block: p.block, quote: { ...p.quote, status, orderId, gasMon }, canceled, confirmedBlock: parseInt(r.blockNumber, 16) };
  }

  private async marginBalance(token: string, blockTag = "latest"): Promise<ethers.BigNumber> {
    const data = this.marginIface.encodeFunctionData("getBalance", [this.wallet!.address, token]);
    const res = await rpc<string>("eth_call", [{ to: config.marginAccount, data }, blockTag], config.readRpcUrl);
    return BN.from(res);
  }

  /**
   * One eth_estimateGas at startup for a post-only place with no cancels, plus headroom for the one
   * or two cancels a normal block carries, x1.15. Never in the hot loop. Needs margin funds to succeed.
   */
  private async initGasLimit() {
    if (config.gasLimit) { this.gasLimit = BN.from(config.gasLimit); }
    else {
      try {
        const book = await this.readBook();
        const side: Side = this.margin.usdc >= config.tradeSizeMon * book.ask ? "buy" : "sell";
        const data = this.encode(side, config.tradeSizeMon, this.quotePrice(side, book), []);
        const est = await this.provider.estimateGas({ to: config.market, from: this.wallet!.address, data });
        this.gasLimit = est.add(90_000).mul(115).div(100);
      } catch (e) {
        console.warn(`gas estimate failed (${(e as Error).message.slice(0, 120)}); using ${config.gasLimitFallback}`);
      }
    }
    const perBlock = this.gasMon(this.gasLimit, this.feeWei);
    console.log(`gas limit ${this.gasLimit} · maxFee ${config.maxFeeGwei} gwei · priority ${config.priorityFeeGwei} gwei · ~${perBlock.toFixed(4)} MON per block, ~${(perBlock * 12_000).toFixed(0)} MON per hour`);
  }

  private gasMon(limit: ethers.BigNumber, feeWei: ethers.BigNumber) {
    return Number(ethers.utils.formatEther(limit.mul(feeWei)));
  }

  /** An existing wallet without a journal is not silently adopted. Use a dedicated fresh signer. */
  private async reconcileNonce() {
    const counts = await Promise.all(["latest", "pending"].map(tag => rpc<string>("eth_getTransactionCount", [this.wallet!.address, tag])));
    if (counts.some(value => !/^0x[\da-f]+$/i.test(value))) throw new Error("Invalid wallet nonce response");
    const [latest, pending] = counts.map(value => parseInt(value, 16)) as [number, number];
    if (!Number.isSafeInteger(latest) || !Number.isSafeInteger(pending) || pending < latest) throw new Error("Inconsistent wallet nonce response");
    const events = this.journal!.replay();
    if (!events.length) {
      if (latest !== 0 || pending !== 0) throw new Error("Existing wallet requires an imported and reconciled journal; refusing to start from zero");
      const head = await rpc<string>("eth_blockNumber", [], config.readRpcUrl);
      const block = parseInt(head, 16);
      if (!/^0x[\da-f]+$/i.test(head) || !Number.isSafeInteger(block) || block < 1) throw new Error("Invalid recovery block");
      this.journal!.append({ type: "bootstrap", block: block - 1, nonce: 0 });
    } else if (latest > this.nonce || pending > this.nonce) {
      throw new Error("Wallet nonce advanced outside the journal; reconciliation required");
    }
  }

  /** Compare restored resting orders to one pinned chain snapshot before resuming. */
  async verifyRestingOrders(orders: { id: number; size: number; price: number; side: Side }[], block: number) {
    if (!this.wallet) return;
    const tag = "0x" + block.toString(16);
    for (const order of orders) {
      const data = this.iface.encodeFunctionData("s_orders", [order.id]);
      const raw = await rpc<string>("eth_call", [{ to: config.market, data }, tag], config.readRpcUrl);
      const decoded = this.iface.decodeFunctionResult("s_orders", raw);
      const expectedSize = ethers.utils.parseUnits(order.size.toFixed(this.sizeDec), this.sizeDec);
      const expectedPrice = BN.from(Math.round(order.price * 10 ** this.priceDec));
      if (String(decoded.ownerAddress).toLowerCase() !== this.wallet.address.toLowerCase() || !BN.from(decoded.size).eq(expectedSize) || !BN.from(decoded.price).eq(expectedPrice) || decoded.isBuy !== (order.side === "buy")) {
        throw new Error("Resting orders differ from journal; trading remains paused");
      }
    }
    // Unlike periodic best-effort refresh, recovery requires both balances to succeed.
    const [mon, usdc] = await Promise.all([this.marginBalance(ZERO_ADDRESS, tag), this.marginBalance(this.params.quoteAssetAddress, tag)]);
    this.margin.mon = Number(ethers.utils.formatUnits(mon, this.params.baseAssetDecimals.toNumber()));
    this.margin.usdc = Number(ethers.utils.formatUnits(usdc, this.params.quoteAssetDecimals.toNumber()));
  }
}
