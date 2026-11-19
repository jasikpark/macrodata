/**
 * Session checkpoints — the hand-off from a session's lifecycle hooks to the daemon.
 *
 * bin/checkpoint-hook.ts writes one file per fire into getCheckpointDir() on
 * Stop, PreCompact and SessionEnd, named by requestFileName(), and never reads or
 * rewrites another: an async Stop and a SessionEnd can fire at once, and each
 * file has a single writer. The daemon (src/checkpoint-queue.ts) folds a
 * session's files into one request, acts on it once its checkpointDelayMs() has
 * passed without a newer write, and deletes exactly the files that run covered.
 *
 * The daemon owns this queue, not the recall worker: the daemon runs on every
 * host, including ones with recall disabled.
 */

import { join } from "path";
import { getStateRoot } from "./config.js";

export type CheckpointEvent = "Stop" | "PreCompact" | "SessionEnd";

export interface CheckpointRequest {
  session_id: string;
  transcript_path: string;
  event: CheckpointEvent;
  /** Epoch ms the hook wrote this request. */
  ts: number;
}

/** Set to "1" in the environment of any session the daemon forks to process a checkpoint. */
export const CHECKPOINT_FORK_ENV = "MACRODATA_CHECKPOINT_FORK";

export function isCheckpointFork(env: Record<string, string | undefined> = process.env): boolean {
  return env[CHECKPOINT_FORK_ENV] === "1";
}

/** Largest request file the daemon reads; a real one is a few hundred bytes. */
export const MAX_REQUEST_BYTES = 64 * 1024;

export function getCheckpointDir(): string {
  return join(getStateRoot(), ".checkpoints");
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
// SESSION_ID has no ".", so the first one ends the session id.
const REQUEST_FILE = /^([A-Za-z0-9_-]{1,128})\.\d+-\d+-[a-z0-9]+\.json$/;

/** A name no other fire can produce: the session, then this write's time, pid and a random tag. */
export function requestFileName(req: CheckpointRequest, pid = process.pid, tag = Math.random().toString(36).slice(2, 10)): string {
  return `${req.session_id}.${req.ts}-${pid}-${tag}.json`;
}

/** The session a queue file belongs to, or null when the name isn't a request file's. */
export function sessionOfRequestFile(name: string): string | null {
  return REQUEST_FILE.exec(name)?.[1] ?? null;
}
const EVENTS: ReadonlySet<string> = new Set<CheckpointEvent>(["Stop", "PreCompact", "SessionEnd"]);

/**
 * The request a hook envelope asks for, or null when it lacks what the daemon
 * needs. session_id becomes a filename, so anything outside SESSION_ID is
 * refused rather than escaped.
 */
export function checkpointRequestFor(
  env: Record<string, unknown>,
  now = Date.now(),
): CheckpointRequest | null {
  const { session_id, transcript_path, hook_event_name } = env;
  if (typeof session_id !== "string" || !SESSION_ID.test(session_id)) return null;
  if (typeof transcript_path !== "string" || !transcript_path.endsWith(".jsonl")) return null;
  if (typeof hook_event_name !== "string" || !EVENTS.has(hook_event_name)) return null;
  return { session_id, transcript_path, event: hook_event_name as CheckpointEvent, ts: now };
}

// SessionEnd is the session's last chance and PreCompact the last sight of a
// span before it is summarized; a Stop is routine.
const RANK: Record<CheckpointEvent, number> = { Stop: 0, PreCompact: 1, SessionEnd: 2 };

/**
 * One request standing for `prev` and the later `next` of the same session: the
 * newer write's time, and the stronger event, so a Stop landing after SessionEnd
 * does not turn an immediate checkpoint back into a delayed one.
 */
export function mergeCheckpointRequests(
  prev: CheckpointRequest | null,
  next: CheckpointRequest,
): CheckpointRequest {
  if (!prev || prev.session_id !== next.session_id) return next;
  return RANK[prev.event] > RANK[next.event] ? { ...next, event: prev.event } : next;
}

export function parseCheckpointRequest(raw: string): CheckpointRequest | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { event, ts, ...rest } = parsed as Record<string, unknown>;
    if (typeof ts !== "number" || ts <= 0) return null;
    return checkpointRequestFor({ ...rest, hook_event_name: event }, ts);
  } catch {
    return null;
  }
}

/**
 * How long the daemon waits, after the newest write for a session, before
 * acting on it. Every later write for that session restarts the wait.
 *
 * Stop fires after every assistant turn, so a short wait means near-live
 * conversation search but a reindex (and, later, a capture fork of the session) per
 * turn; a long one batches a working burst into one pass but leaves the
 * newest turns unsearchable meanwhile. PreCompact and SessionEnd are the last
 * chance to see a span of the transcript before it is summarized away or the
 * session is gone.
 */
export function checkpointDelayMs(event: CheckpointEvent): number {
  // The prompt cache doesn't bound this wait: a new process resuming the session
  // reads only the global system prefix from cache, however soon it runs
  // (https://github.com/anthropics/claude-code/issues/111435).
  return event === "Stop" ? STOP_DELAY_MS : 0;
}

export const STOP_DELAY_MS = 4 * 60_000;
