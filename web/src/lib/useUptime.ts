"use client";

import { useEffect, useState } from "react";
import { uptime } from "./format";

/**
 * Ticks once a second and returns elapsed time since `startedAt` as "hh:mm:ss".
 * Renders "00:00:00" on the server and on the first client paint (no hydration
 * mismatch), then starts ticking in an effect.
 */
export function useUptime(startedAt: number | null | undefined): string {
  const [text, setText] = useState("00:00:00");

  useEffect(() => {
    if (!startedAt) {
      setText("00:00:00");
      return;
    }
    const tick = () => setText(uptime(startedAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return text;
}

export default useUptime;
