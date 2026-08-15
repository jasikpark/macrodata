/**
 * A deadline for work that has no cancellation.
 *
 * The recall pipeline runs inside a long-lived worker that serves one state
 * root, so an await that never settles is not a slow request — it is the end of
 * recall for that root, with the process still in `ps` looking healthy. Nothing
 * in the pipeline can be cancelled (a model load in node-llama-cpp least of
 * all), so the only available answer is to notice and let the caller die.
 */

/** Resolved in place of the value when the deadline wins. */
export const WEDGED = Symbol("wedged");

/**
 * Race `p` against `ms`, resolving to WEDGED if the deadline wins.
 *
 * Resolves rather than rejects: a rejection here would be indistinguishable from
 * the awaited work's own failure, which is recoverable and must not be treated
 * as a reason to end the process. The loser keeps running — nothing can stop it
 * — so this is only safe where a deadline miss is terminal.
 */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof WEDGED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof WEDGED>((resolve) => {
    timer = setTimeout(() => resolve(WEDGED), ms);
  });
  // Cleared on both paths: an uncleared timer keeps the event loop alive for the
  // whole budget after the work is done, which in a 20-minute cold budget would
  // hold a worker open long past any request.
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}
