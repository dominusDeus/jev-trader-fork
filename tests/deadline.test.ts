import { expect, test } from "bun:test";
import { DecisionExpired, DecisionWindow } from "../src/deadline";

test("checks the monotonic clock even before the timeout callback runs", () => {
  let now = 0;
  const window = new DecisionWindow(250, () => now);
  try {
    window.assertFresh();
    now = 250;
    expect(window.assertFresh).toThrow(DecisionExpired);
  } finally { window.dispose(); }
});

test("expires a hung operation and ignores its late completion", async () => {
  const window = new DecisionWindow(10);
  try {
    await expect(window.wait(() => new Promise(() => {}))).rejects.toBeInstanceOf(DecisionExpired);
    expect(window.signal.aborted).toBe(true);
  } finally { window.dispose(); }
});

test("superseding interrupts even a caller that ignores AbortSignal", async () => {
  const window = new DecisionWindow(1000);
  const operation = window.wait(() => new Promise(() => {}));
  window.expire();
  await expect(operation).rejects.toBeInstanceOf(DecisionExpired);
  window.dispose();
});
