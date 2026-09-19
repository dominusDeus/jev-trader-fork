import { spyOn } from "bun:test";

export function mockFetch(handler: (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(handler, { preconnect() {} }));
}
