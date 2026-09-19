import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const key = "0x" + "1".repeat(64); // public test fixture, never funded

describe("configuration fails closed", () => {
  test("a key alone cannot enable live mode", () => {
    expect(loadConfig({ PRIVATE_KEY: key }).dryRun).toBe(true);
    expect(loadConfig({}).dryRun).toBe(true);
  });
  test("live needs explicit false and a valid key", () => {
    expect(loadConfig({ DRY_RUN: "false", PRIVATE_KEY: key }).dryRun).toBe(false);
    expect(() => loadConfig({ DRY_RUN: "false" })).toThrow("PRIVATE_KEY");
  });
  test.each(["", "TRUE", "False", "1", "yes", "false "])("rejects ambiguous DRY_RUN=%s", value => {
    expect(() => loadConfig({ DRY_RUN: value, PRIVATE_KEY: key })).toThrow("DRY_RUN");
  });
  test.each(["TRADE_SIZE_MON", "MAX_POSITION_MON", "BANKROLL_USD", "PORT", "DECISION_DEADLINE_MS", "RPC_TIMEOUT_MS"])("rejects invalid %s", field => {
    for (const value of ["", "NaN", "Infinity", "-1", "0", "0x100", "1e309"]) {
      expect(() => loadConfig({ [field]: value })).toThrow(field);
    }
  });
  test("validates relationships and discrete units", () => {
    expect(() => loadConfig({ MAX_POSITION_MON: "100" })).toThrow("TRADE_SIZE_MON");
    expect(() => loadConfig({ PRIORITY_FEE_GWEI: "401" })).toThrow("PRIORITY_FEE_GWEI");
    expect(() => loadConfig({ QUOTE_INSIDE_TICKS: "0.5" })).toThrow("QUOTE_INSIDE_TICKS");
    expect(() => loadConfig({ HORIZON_BLOCKS: "401" })).toThrow("HORIZON_BLOCKS");
    expect(() => loadConfig({ GAS_LIMIT: "100" })).toThrow("GAS_LIMIT");
    expect(() => loadConfig({ PORT: "65536" })).toThrow("PORT");
    expect(() => loadConfig({ MAX_FEE_GWEI: "1.0000000001" })).toThrow("MAX_FEE_GWEI");
    expect(loadConfig({ GAS_LIMIT: "" }).gasLimit).toBeUndefined();
    expect(loadConfig({ QUOTE_INSIDE_TICKS: "0", PRIORITY_FEE_GWEI: "0" }).quoteInsideTicks).toBe(0);
  });
  test("validates model selection, addresses and URLs without exposing secrets", () => {
    expect(() => loadConfig({ MODEL: "typo" })).toThrow("MODEL");
    expect(() => loadConfig({ MODEL: "jev" })).toThrow("TYPESAFE_AI_API_KEY");
    expect(() => loadConfig({ MARKET: "0x" + "0".repeat(40) })).toThrow("MARKET");
    expect(() => loadConfig({ RPC_URL: "file:///secret-token" })).toThrow("Invalid RPC_URL: unsupported protocol");
    expect(() => loadConfig({ PRIVATE_KEY: "secret-key" })).toThrow("Invalid PRIVATE_KEY");
    expect(() => loadConfig({ PRIVATE_KEY: "0x" + "0".repeat(64) })).toThrow("Invalid PRIVATE_KEY");
    expect(() => loadConfig({ PRIVATE_KEY: "0x" + "f".repeat(64) })).toThrow("Invalid PRIVATE_KEY");
  });
});

test("gas budgets preserve wei precision and default to no spending", () => {
  expect(loadConfig({}).gasBudgetWei).toBe("0");
  expect(loadConfig({ GAS_BUDGET_MON: "1.000000000000000001", CANCEL_RESERVE_MON: "0.000000000000000001" })).toMatchObject({ gasBudgetWei: "1000000000000000001", cancelReserveWei: "1" });
  for (const key of ["GAS_BUDGET_MON", "CANCEL_RESERVE_MON"]) {
    for (const value of ["", "-1", "Infinity", "1e5", "0.0000000000000000001"]) expect(() => loadConfig({ [key]: value })).toThrow(key);
  }
  expect(() => loadConfig({ GAS_BUDGET_MON: "1", CANCEL_RESERVE_MON: "2" })).toThrow("CANCEL_RESERVE_MON");
});

test("model call limit defaults to zero and accepts only nonnegative integers", () => {
  expect(loadConfig({}).modelCallLimit).toBe(0);
  expect(loadConfig({ MODEL_CALL_LIMIT: "3" }).modelCallLimit).toBe(3);
  for (const value of ["-1", "", "1.5", "NaN", "1e9"]) expect(() => loadConfig({ MODEL_CALL_LIMIT: value })).toThrow("MODEL_CALL_LIMIT");
});
