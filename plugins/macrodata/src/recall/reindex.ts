/**
 * The worker's queue of ambient-recall reindex work.
 *
 * bin/recall-reindex-hook.ts drops `reindex-<tag>.json` into the mailbox
 * (src/recall/reindex-request.ts); the worker parses it and hands it to a
 * ReindexQueue. Reindexing lives in the worker because it is the one process
 * that owns the models, and the indexer serializes writers only within a
 * process: a reconcile per hook process would load the embed model per edit
 * and turn every overlap into a ConcurrentWriteError.
 */

import { ConcurrentWriteError, UnusableIndexError } from "./atomic-index.ts";
import type { ReconcileOptions, ReconcileResult } from "./indexer.ts";
import type { ReindexRequest } from "./reindex-request.ts";

export interface ReindexOps {
  reconcileCorpus(opts: Pick<ReconcileOptions, "heal">): Promise<ReconcileResult>;
  reconcileSource(path: string): Promise<ReconcileResult>;
  /** Changes whenever index.json is replaced or removed (e.g. mtime + size). */
  indexStamp(): string;
  /** Publishes why reindexing stopped, for the SessionStart hook; null clears it. */
  reportHalt(message: string | null): void;
}

// Past models.ts's 10-minute circuit-breaker cooldown, so a capped retry after
// repeated model-load failures meets a closed circuit.
const MAX_RETRY_MS = 15 * 60_000;

// Past this many distinct pending paths, one corpus pass is cheaper than a
// reconcile per path, and the set stays bounded under a bulk rewrite.
export const PATH_CAP = 64;

interface Log {
  debug(msg: string, props?: Record<string, unknown>): void;
  info(msg: string, props?: Record<string, unknown>): void;
  warn(msg: string, props?: Record<string, unknown>): void;
  error(msg: string, props?: Record<string, unknown>): void;
}

/**
 * Coalescing queue of reindex work. A pending corpus reconcile subsumes every
 * pending path; a path whose reconcile reports incomplete (one reconcileSource
 * declines to index, such as a symlink or a wrong-case spelling) falls back to
 * the corpus.
 *
 * An unusable index (unparsable, or another embedding model's vectors) gets one
 * corpus pass that sets it aside and rebuilds. If the rebuilt index is unusable
 * too, the queue halts until index.json is replaced, and reports the halt.
 */
export class ReindexQueue {
  private corpus = false;
  private paths = new Set<string>();
  private running: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryAt = 0;
  private failures = 0;
  private lastFailures = "";
  // `heal` asks the next corpus pass to set an unusable index aside, and stays
  // set until one succeeds. `healed` allows that once per index.json: an index
  // unusable again after its rebuild halts the queue instead of looping.
  private heal = false;
  private healed = false;
  private haltedAt: string | null = null;
  /** When the current drain began; null while idle. */
  activeSince: number | null = null;

  constructor(
    private ops: ReindexOps,
    private log: Log,
    private retryMs = 30_000,
  ) {}

  add(req: ReindexRequest): void {
    if (this.haltedAt !== null) {
      if (this.ops.indexStamp() === this.haltedAt) return;
      this.haltedAt = null;
      this.healed = false;
      this.log.info("reindex resumed: index replaced");
    }
    if ("corpus" in req) this.corpus = true;
    else for (const p of req.paths) this.paths.add(p);
    if (this.paths.size > PATH_CAP) {
      this.corpus = true;
      this.paths.clear();
    }
    this.kick();
  }

  private kick(): void {
    if (this.running) return;
    this.activeSince = Date.now();
    // Deferred a microtask so every add() in the same tick (a startup sweep of
    // queued requests) coalesces before the first reconcile starts.
    this.running = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.running = null;
        this.activeSince = null;
        if (this.pending()) this.kick();
      });
  }

  private pending(): boolean {
    return this.haltedAt === null && (this.corpus || this.paths.size > 0);
  }

  /** Resolves once the queue is empty; for tests and orderly shutdown. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    while (this.pending()) {
      if (this.corpus) {
        this.corpus = false;
        this.paths.clear();
        const heal = this.heal;
        await this.attempt("corpus", () => this.ops.reconcileCorpus({ heal }));
        continue;
      }
      const batch = [...this.paths];
      this.paths.clear();
      for (const p of batch) {
        if (this.corpus || this.haltedAt !== null) break;
        const r = await this.attempt(p, () => this.ops.reconcileSource(p));
        // A failed path drops the rest of the batch: the corpus retry it armed
        // (or the heal pass it queued) covers every path in it.
        if (!r) break;
        if (!r.complete) this.corpus = true;
      }
    }
  }

  private async attempt(
    scope: string,
    run: () => Promise<ReconcileResult>,
  ): Promise<ReconcileResult | null> {
    const t0 = Date.now();
    this.log.debug("reindex start", { scope });
    try {
      const { failures, ...r } = await run();
      const changed = r.embedded || r.relabeled || r.pruned || r.setAside;
      this.log[changed ? "info" : "debug"]("reindexed", { scope, ...r, ms: Date.now() - t0 });
      // The same unreadable file fails every pass; report it when the set changes.
      const key = failures.join("\n");
      if (key !== this.lastFailures && (scope === "corpus" || failures.length > 0)) {
        this.lastFailures = key;
        if (failures.length > 0) this.log.warn("reindex incomplete", { scope, failures });
      }
      // A path succeeding says nothing about what failed the corpus pass.
      if (scope === "corpus") {
        this.failures = 0;
        this.heal = false;
        this.ops.reportHalt(null);
      }
      return { failures, ...r };
    } catch (err) {
      if (err instanceof UnusableIndexError && !this.healed) {
        this.healed = true;
        this.heal = true;
        this.corpus = true;
        this.log.warn("reindex found an unusable index; setting it aside to rebuild", {
          scope,
          error: err.message,
        });
      } else if (err instanceof UnusableIndexError) {
        this.haltedAt = err.stamp;
        this.heal = false;
        this.corpus = false;
        this.paths.clear();
        this.log.error("reindex halted: index is unusable after a rebuild", {
          scope,
          error: err.message,
        });
        this.ops.reportHalt(err.message);
      } else if (err instanceof ConcurrentWriteError) {
        // Another process (a hand-run recall-reindex.ts) committed first. The
        // failed update was dropped and the cache reset, so a later corpus pass
        // reloads its commit and redoes whatever this one lost.
        this.log.warn("reindex lost a write race, retrying the corpus", {
          scope,
          retryMs: this.scheduleRetry(this.retryMs),
        });
      } else {
        // A model that failed to load (offline, circuit open) or a transient
        // I/O error; back off rather than wait for the next hook to re-ask.
        // One failure per retry cycle: paths failing while a retry is armed
        // are the same outage, not a deeper one.
        const retryMs = this.retry
          ? this.scheduleRetry(0)
          : this.scheduleRetry(Math.min(this.retryMs * 2 ** this.failures++, MAX_RETRY_MS));
        this.log.error("reindex failed", { scope, error: String(err), retryMs });
      }
      return null;
    }
  }

  /** Arms the one retry timer unless it is already armed; returns ms until it fires. */
  private scheduleRetry(ms: number): number {
    if (this.retry) return Math.max(0, this.retryAt - Date.now());
    this.retryAt = Date.now() + ms;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.add({ corpus: true });
    }, ms);
    this.retry.unref?.();
    return ms;
  }
}
