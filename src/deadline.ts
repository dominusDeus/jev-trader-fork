export class DecisionExpired extends Error {
  constructor() { super("Decision expired or superseded by a newer block"); }
}

/** One block's read/decision/signing budget. Broadcasts already started must still be tracked. */
export class DecisionWindow {
  private controller = new AbortController();
  private expiresAt: number;
  private timer: ReturnType<typeof setTimeout>;

  constructor(budgetMs: number, private now = () => performance.now()) {
    this.expiresAt = now() + budgetMs;
    this.timer = setTimeout(() => this.expire(), budgetMs);
  }

  get signal() { return this.controller.signal; }
  expire() { this.controller.abort(new DecisionExpired()); }
  dispose() { clearTimeout(this.timer); }

  assertFresh = () => {
    if (this.signal.aborted || this.now() >= this.expiresAt) throw new DecisionExpired();
  };

  /** Also bounds callers that ignore AbortSignal; their late result is never used. */
  async wait<T>(operation: () => Promise<T>): Promise<T> {
    this.assertFresh();
    let abort!: () => void;
    const expired = new Promise<never>((_, reject) => {
      abort = () => reject(new DecisionExpired());
      this.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const value = await Promise.race([expired, operation()]);
      this.assertFresh();
      return value;
    } finally {
      this.signal.removeEventListener("abort", abort);
    }
  }
}
