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

import { ConcurrentWriteError, UnparsableIndexError } from "./atomic-index.ts";
import type { ReconcileResult } from "./indexer.ts";
import type { ReindexRequest } from "./reindex-request.ts";

export interface ReindexOps {
  reconcileCorpus(): Promise<ReconcileResult>;
  reconcileSource(path: string): Promise<ReconcileResult>;
}

interface Log {
  info(msg: string, props?: Record<string, unknown>): void;
  warn(msg: string, props?: Record<string, unknown>): void;
  error(msg: string, props?: Record<string, unknown>): void;
}

/**
 * Coalescing queue of reindex work. A pending corpus reconcile subsumes every
 * pending path; a path whose reconcile reports incomplete (one reconcileSource
 * declines to index, such as a symlink or a wrong-case spelling) falls back to
 * the corpus.
 */
export class ReindexQueue {
  private corpus = false;
  private paths = new Set<string>();
  private running: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  // An unparsable index fails every reconcile the same way until `--full`
  // replaces it, so after the first report the queue stops trying.
  private halted = false;

  constructor(
    private ops: ReindexOps,
    private log: Log,
    private retryMs = 30_000,
  ) {}

  add(req: ReindexRequest): void {
    if (this.halted) return;
    if ("corpus" in req) this.corpus = true;
    else for (const p of req.paths) this.paths.add(p);
    this.kick();
  }

  private kick(): void {
    this.running ??= this.drain().finally(() => {
      this.running = null;
      if (this.pending()) this.kick();
    });
  }

  private pending(): boolean {
    return !this.halted && (this.corpus || this.paths.size > 0);
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
        await this.attempt("corpus", () => this.ops.reconcileCorpus());
        continue;
      }
      const batch = [...this.paths];
      this.paths.clear();
      for (const p of batch) {
        const r = await this.attempt(p, () => this.ops.reconcileSource(p));
        if (r && !r.complete) this.corpus = true;
      }
    }
  }

  private async attempt(
    scope: string,
    run: () => Promise<ReconcileResult>,
  ): Promise<ReconcileResult | null> {
    const t0 = Date.now();
    try {
      const r = await run();
      if (r.embedded || r.relabeled || r.pruned || !r.complete) {
        this.log.info("reindexed", { scope, ...r, ms: Date.now() - t0 });
      }
      return r;
    } catch (err) {
      if (err instanceof UnparsableIndexError) {
        this.halted = true;
        this.corpus = false;
        this.paths.clear();
        this.log.error("reindex halted: index is unparsable", { scope, error: err.message });
      } else if (err instanceof ConcurrentWriteError) {
        // Another process (a hand-run recall-reindex.ts) committed first. The
        // failed update was dropped and the cache reset, so a later corpus pass
        // reloads its commit and redoes whatever this one lost.
        this.log.warn("reindex lost a write race, retrying the corpus", {
          scope,
          retryMs: this.retryMs,
        });
        this.scheduleRetry();
      } else {
        this.log.error("reindex failed", { scope, error: String(err) });
      }
      return null;
    }
  }

  private scheduleRetry(): void {
    if (this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.add({ corpus: true });
    }, this.retryMs);
    this.retry.unref?.();
  }
}
