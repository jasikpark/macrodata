/**
 * Session checkpoints — the hand-off from a session's lifecycle hooks to the daemon.
 *
 * bin/checkpoint-hook.ts writes one `<session_id>.json` per session into
 * getCheckpointDir() on Stop, PreCompact and SessionEnd. A later event for the
 * same session overwrites the earlier one, so a burst of Stops coalesces into a
 * single pending file. The daemon watches the directory and acts on each file
 * once its checkpointDelayMs() has passed without a newer write.
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

/** Set in the environment of any session the daemon forks to process a checkpoint. */
export const CHECKPOINT_FORK_ENV = "MACRODATA_CHECKPOINT_FORK";

export function getCheckpointDir(): string {
  return join(getStateRoot(), ".checkpoints");
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
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
  // Stop's wait stays under the 5-minute default prompt-cache TTL, so work that
  // forks the session at checkpoint time still reads a warm cache.
  return event === "Stop" ? STOP_DELAY_MS : 0;
}

export const STOP_DELAY_MS = 4 * 60_000;
