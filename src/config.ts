type Env = Record<string, string | undefined>;

/** Parse before any network or wallet initialization. Errors name fields, never their values. */
export function loadConfig(env: Env) {
  const text = (key: string, fallback?: string) => env[key]?.trim() || fallback;
  const number = (key: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER, integer = false) => {
    const raw = env[key] === undefined ? String(fallback) : env[key]!.trim();
    const value = Number(raw);
    if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
      throw new Error(`Invalid ${key}: expected ${integer ? "an integer" : "a number"} between ${min} and ${max}`);
    }
    return value;
  };
  const url = (key: string, fallback: string | undefined, protocols: string[]) => {
    const value = text(key, fallback);
    if (value === undefined) return undefined;
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error(`Invalid ${key}: expected a URL`); }
    if (!protocols.includes(parsed.protocol)) throw new Error(`Invalid ${key}: unsupported protocol`);
    return value;
  };
  const address = (key: string, fallback: string) => {
    const value = text(key, fallback)!;
    if (!/^0x[\da-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) throw new Error(`Invalid ${key}: expected a nonzero address`);
    return value;
  };
  // Presence of a key never opts into live mode. Empty/unknown boolean values fail closed.
  if (env.DRY_RUN !== undefined && env.DRY_RUN !== "true" && env.DRY_RUN !== "false") {
    throw new Error("Invalid DRY_RUN: expected true or false");
  }
  const dryRun = env.DRY_RUN !== "false";
  const privateKey = text("PRIVATE_KEY");
  if (privateKey) {
    if (!/^0x[\da-fA-F]{64}$/.test(privateKey) || BigInt(privateKey) === 0n || BigInt(privateKey) >= 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n) {
      throw new Error("Invalid PRIVATE_KEY");
    }
  }
  if (!dryRun && !privateKey) throw new Error("PRIVATE_KEY is required when DRY_RUN=false");
  const model = text("MODEL", "mock");
  if (model !== "mock" && model !== "jev") throw new Error("Invalid MODEL: expected mock or jev");
  if (model === "jev" && !text("TYPESAFE_AI_API_KEY")) throw new Error("TYPESAFE_AI_API_KEY is required when MODEL=jev");

  const tradeSizeMon = number("TRADE_SIZE_MON", 200, Number.MIN_VALUE);
  const maxPositionMon = number("MAX_POSITION_MON", 1000, Number.MIN_VALUE);
  if (tradeSizeMon > maxPositionMon) throw new Error("TRADE_SIZE_MON must not exceed MAX_POSITION_MON");
  const maxFeeGwei = number("MAX_FEE_GWEI", 400, Number.MIN_VALUE);
  const priorityFeeGwei = number("PRIORITY_FEE_GWEI", 2, 0);
  if (priorityFeeGwei > maxFeeGwei) throw new Error("PRIORITY_FEE_GWEI must not exceed MAX_FEE_GWEI");
  for (const key of ["MAX_FEE_GWEI", "PRIORITY_FEE_GWEI"]) {
    if ((env[key]?.split(".")[1]?.length ?? 0) > 9) throw new Error(`Invalid ${key}: at most 9 decimal places`);
  }

  // Decimal strings preserve every wei; zero deliberately disables new live spending.
  const monBudget = (key: string) => {
    const value = env[key]?.trim() ?? "0";
    if (!/^\d+(\.\d{1,18})?$/.test(value)) throw new Error(`Invalid ${key}: expected nonnegative MON with at most 18 decimals`);
    const [whole, fraction = ""] = value.split(".");
    const wei = BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
    if (wei > 2n ** 256n - 1n) throw new Error(`Invalid ${key}: amount too large`);
    return wei.toString();
  };
  const gasBudgetWei = monBudget("GAS_BUDGET_MON"), cancelReserveWei = monBudget("CANCEL_RESERVE_MON");
  if (BigInt(cancelReserveWei) > BigInt(gasBudgetWei)) throw new Error("CANCEL_RESERVE_MON must not exceed GAS_BUDGET_MON");

  return {
    rpcUrl: url("RPC_URL", "https://rpc.monad.xyz", ["https:", "http:"])!,
    readRpcUrl: url("READ_RPC_URL", "https://rpc.monad.xyz", ["https:", "http:"])!,
    wsUrl: url("WS_URL", undefined, ["wss:", "ws:"]),
    chainId: 143,
    market: address("MARKET", "0x065C9d28E428A0db40191a54d33d5b7c71a9C394"),
    marginAccount: address("MARGIN_ACCOUNT", "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5"),
    privateKey, dryRun, tradeSizeMon, maxPositionMon,
    statePath: text("STATE_PATH", "data/live.sqlite")!,
    bankrollUsd: number("BANKROLL_USD", 100, Number.MIN_VALUE),
    quoteInsideTicks: number("QUOTE_INSIDE_TICKS", 1, 0, Number.MAX_SAFE_INTEGER, true),
    gasLimit: text("GAS_LIMIT") === undefined ? undefined : number("GAS_LIMIT", 350_000, 21_000, 30_000_000, true),
    gasLimitFallback: 350_000,
    maxFeeGwei, priorityFeeGwei, gasBudgetWei, cancelReserveWei,
    pendingBlocks: 10,
    refreshBlocks: 200,
    horizonBlocks: number("HORIZON_BLOCKS", 100, 1, 400, true),
    // Budget from observed block to broadcast, including book read and signing.
    decisionDeadlineMs: number("DECISION_DEADLINE_MS", 250, 1, 10_000, true),
    rpcTimeoutMs: number("RPC_TIMEOUT_MS", 5000, 1, 60_000, true),
    model,
    modelCallLimit: number("MODEL_CALL_LIMIT", 0, 0, Number.MAX_SAFE_INTEGER, true),
    jevModelId: text("JEV_MODEL_ID", "jev-latest")!,
    jevUsdPerMTok: 0.042,
    port: number("PORT", 3000, 1, 65535, true),
    historySize: 1000,
  };
}

export const config = loadConfig(process.env);
