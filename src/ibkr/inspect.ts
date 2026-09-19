import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

export interface PaperSettings { account: string; port: number; clientId: number; timeout: number }
export function paperSettings(env: Record<string, string | undefined>): PaperSettings {
  const account = env.IBKR_PAPER_ACCOUNT ?? "";
  if (!/^DUT?\d+$/.test(account)) throw new Error("IBKR_PAPER_ACCOUNT must be the exact DU/DUT paper account");
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key] ?? String(fallback), value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  const port = integer("IBKR_PAPER_PORT", 4002, 1, 65535);
  if (![4002, 7497].includes(port)) throw new Error("Only standard IBKR paper ports 4002/7497 are supported");
  return { account, port, clientId: integer("IBKR_CLIENT_ID", 71, 1, 2147483647), timeout: integer("IBKR_TIMEOUT_SECONDS", 15, 1, 60) };
}

export interface PaperSnapshot {
  version: 1; broker: "ibkr"; mode: "paper"; readOnly: true; account: string; capturedAt: string;
  accountReady: boolean | null;
  values: { key: string; currency: string; value: string }[];
  positions: { contractId: number; symbol: string; securityType: string; currency: string; quantity: string; [key: string]: unknown }[];
}
export function parseSnapshot(raw: string, account: string): PaperSnapshot {
  const s = JSON.parse(raw);
  if (s?.version !== 1 || s.broker !== "ibkr" || s.mode !== "paper" || s.readOnly !== true || s.account !== account ||
      typeof s.capturedAt !== "string" || !Number.isFinite(Date.parse(s.capturedAt)) ||
      ![true, null].includes(s.accountReady) || !Array.isArray(s.values) || !s.values.length || !Array.isArray(s.positions)) throw new Error("Invalid or incomplete IBKR snapshot");
  if (s.values.some((v: any) => !v || [v.key, v.currency, v.value].some(x => typeof x !== "string")) ||
      s.positions.some((p: any) => !p || !Number.isSafeInteger(p.contractId) || p.contractId <= 0 ||
        [p.symbol, p.securityType, p.currency, p.quantity].some(x => typeof x !== "string") || !Number.isFinite(Number(p.quantity)))) throw new Error("Invalid IBKR account data");
  if (new Set(s.positions.map((p: any) => p.contractId)).size !== s.positions.length) throw new Error("Duplicate IBKR positions");
  return s;
}
export async function inspectPaper(env = process.env): Promise<PaperSnapshot> {
  const s = paperSettings(env);
  const python = env.IBKR_PYTHON ?? "python3";
  const script = fileURLToPath(new URL("./reader.py", import.meta.url));
  try {
    const { stdout } = await promisify(execFile)(python, [script, "--account", s.account, "--port", String(s.port), "--client-id", String(s.clientId), "--timeout", String(s.timeout)], {
      timeout: (s.timeout + 3) * 1000, maxBuffer: 2 * 1024 * 1024,
      // No trading/model credentials are passed to the reader. SDK must be installed in Python's environment.
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" },
    });
    return parseSnapshot(stdout, s.account);
  } catch { throw new Error("IBKR paper read failed: check SDK installation, Paper login, Read-Only API, port and account. No orders were sent."); }
}
if (import.meta.main) {
  try { console.log(JSON.stringify(await inspectPaper(), null, 2)); }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
