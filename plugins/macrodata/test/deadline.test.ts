/**
 * withDeadline — the recall worker's only defense against an await that never
 * settles.
 *
 * The worker holds the single-worker claim for its state root, so a pipeline
 * that hangs takes recall down in the one way nothing outside the process can
 * see or fix: it stays in `ps`, the hook reads it as healthy, and any
 * replacement stands down against its claim. These pin the three properties the
 * worker depends on — the value wins when it arrives in time, the deadline
 * resolves (never rejects) when it doesn't, and the timer stops either way.
 */

import { describe, test, expect } from "bun:test";
import { WEDGED, withDeadline } from "../src/recall/deadline.ts";

const after = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

describe("withDeadline", () => {
  test("resolves with the value when the work finishes in time", async () => {
    expect(await withDeadline(after(5, "hits"), 1000)).toBe("hits");
  });

  test("resolves to WEDGED when the deadline wins", async () => {
    expect(await withDeadline(after(1000, "hits"), 5)).toBe(WEDGED);
  });

  test("a never-settling promise still yields WEDGED", async () => {
    expect(await withDeadline(new Promise<string>(() => {}), 5)).toBe(WEDGED);
  });

  // A rejection here would be indistinguishable from the pipeline's own failure,
  // which the worker recovers from — so rejections must pass through untouched
  // rather than be folded into the wedge signal.
  test("passes a rejection through instead of swallowing it", async () => {
    // Settled through one channel so a resolve and a reject are compared as the
    // same kind of value: a rejection swallowed into WEDGED would otherwise read
    // as a pass in a test that only asserts "did not resolve with the value".
    const settled = await withDeadline(Promise.reject(new Error("pipeline blew up")), 1000).then(
      (v) => (v === WEDGED ? "wedged" : "resolved"),
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(settled).toBe("pipeline blew up");
  });
});
