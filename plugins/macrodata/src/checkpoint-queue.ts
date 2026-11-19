/**
 * The daemon's side of the session checkpoint queue (src/checkpoint.ts): one
 * timer per session, at most one run per session at a time, and a request file
 * deleted only once a run that read it has succeeded.
 *
 * A run covers the files present when it starts: a hook fires only after the
 * transcript bytes it announces are on disk. Files that land mid-run have names
 * the run never read, so they survive it and arm the next one.
 *
 * File access, time and the work itself are injected so the queue can be
 * driven deterministically; bin/macrodata-daemon.ts supplies the real ones.
 */

import { basename } from "path";
import {
  checkpointDelayMs,
  mergeCheckpointRequests,
  parseCheckpointRequest,
  sessionOfRequestFile,
  type CheckpointRequest,
} from "./checkpoint.js";

export interface CheckpointQueueDeps {
  /** Paths of every file in the queue directory. */
  list(): string[];
  /** The file's text; null when it is not a regular file the queue should read. Throws when it is gone. */
  read(path: string): string | null;
  remove(path: string): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  run(req: CheckpointRequest): Promise<void>;
  log(msg: string): void;
  logError(msg: string): void;
}

export class CheckpointQueue {
  private timers = new Map<string, unknown>();
  private running = new Set<string>();

  constructor(private deps: CheckpointQueueDeps) {}

  /** Call for every add or change of a file in the queue directory. */
  arm(path: string): void {
    const session = sessionOfRequestFile(basename(path));
    if (session) this.armSession(session);
  }

  /** Drops pending timers. A run in flight finishes on its own. */
  stop(): void {
    for (const timer of this.timers.values()) this.deps.clearTimer(timer);
    this.timers.clear();
  }

  private armSession(session: string): void {
    // runOne() re-arms when a run ends, picking up any file that landed meanwhile.
    if (this.running.has(session)) return;
    const pending = this.pending(session);
    const prev = this.timers.get(session);
    if (prev !== undefined) this.deps.clearTimer(prev);
    this.timers.delete(session);
    if (!pending) return;
    const wait = Math.max(0, this.dueAt(pending.req) - this.deps.now());
    this.timers.set(
      session,
      this.deps.setTimer(() => void this.runOne(session), wait),
    );
  }

  private dueAt(req: CheckpointRequest): number {
    return req.ts + checkpointDelayMs(req.event);
  }

  /** The session's files folded into one request, dropping any that can't be read as one. */
  private pending(session: string): { req: CheckpointRequest; paths: string[] } | null {
    const reqs: { path: string; req: CheckpointRequest }[] = [];
    for (const path of this.deps.list()) {
      if (sessionOfRequestFile(basename(path)) !== session) continue;
      let req: CheckpointRequest | null = null;
      try {
        const raw = this.deps.read(path);
        if (raw !== null) req = parseCheckpointRequest(raw);
      } catch {
        continue; // consumed between the listing and the read
      }
      if (!req || req.session_id !== session) {
        this.deps.logError(`Dropping unusable checkpoint request: ${basename(path)}`);
        try {
          this.deps.remove(path);
        } catch {}
        continue;
      }
      reqs.push({ path, req });
    }
    if (reqs.length === 0) return null;
    reqs.sort((a, b) => a.req.ts - b.req.ts);
    let merged: CheckpointRequest | null = null;
    for (const { req } of reqs) merged = mergeCheckpointRequests(merged, req);
    return { req: merged!, paths: reqs.map((r) => r.path) };
  }

  private async runOne(session: string): Promise<void> {
    this.timers.delete(session);
    const pending = this.pending(session);
    if (!pending) return;
    // A file the watcher hasn't reported yet can move the due time later.
    if (this.dueAt(pending.req) > this.deps.now()) return this.armSession(session);
    this.running.add(session);
    const { req, paths } = pending;
    this.deps.log(`Checkpoint ${req.event} for session ${session}`);
    try {
      await this.deps.run(req);
      for (const path of paths) {
        try {
          this.deps.remove(path);
        } catch {}
      }
    } catch (err) {
      // The files stay queued; the session's next checkpoint or the next daemon
      // start retries them.
      this.deps.logError(`Checkpoint for session ${session} failed: ${String(err)}`);
      this.running.delete(session);
      if (this.deps.list().some((p) => sessionOfRequestFile(basename(p)) === session && !paths.includes(p))) {
        this.armSession(session);
      }
      return;
    }
    this.running.delete(session);
    this.armSession(session);
  }
}
