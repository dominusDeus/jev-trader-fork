import type { Intent } from "./journal";

/** Conservative lifetime allocation, in wei. Receipts never replenish this budget. */
export class GasBudget {
  private allocated = 0n;
  private unknownHistory = false;
  private hashes = new Set<string>();

  record(intent: Intent) {
    const hash = intent.quote.txHash!.toLowerCase();
    if (this.hashes.has(hash)) return;
    this.hashes.add(hash);
    if (intent.maxGasWei === undefined) this.unknownHistory = true;
    else this.allocated += BigInt(intent.maxGasWei);
  }

  reason(cost: bigint, limit: bigint, reserve: bigint, cancel = false): string | null {
    if (this.unknownHistory) return "gas_history_incomplete";
    if (limit <= 0n || (!cancel && reserve <= 0n)) return "gas_budget_unconfigured";
    if (!cancel && reserve < cost) return "cancel_reserve_too_small";
    if (this.allocated + cost + (cancel ? 0n : reserve) > limit) return "gas_budget_exhausted";
    return null;
  }

  snapshot() { return { allocatedWei: this.allocated.toString(), historyComplete: !this.unknownHistory }; }
}
