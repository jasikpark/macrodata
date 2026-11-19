#!/usr/bin/env bun
/**
 * Session checkpoint trigger — fires on Stop, PreCompact and SessionEnd.
 *
 * Writes this session's checkpoint request into the daemon's queue
 * (src/checkpoint.ts) and returns; the daemon does the work. One file per
 * session, replaced on each fire, so the queue never grows past one entry per
 * live session.
 *
 * Exit 1 on an unexpected error (non-blocking, visible); never exit 2, which
 * would block the Stop.
 */

import { mkdirSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { CHECKPOINT_FORK_ENV, checkpointRequestFor, getCheckpointDir } from "../src/checkpoint.js";

// A session the daemon forked to process a checkpoint must not queue its own,
// or each fork would schedule the next.
if (process.env[CHECKPOINT_FORK_ENV]) process.exit(0);

const raw = process.stdin.isTTY ? "" : await Bun.stdin.text();
let env: Record<string, unknown>;
try {
  const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
  if (typeof parsed !== "object" || parsed === null) process.exit(0);
  env = parsed as Record<string, unknown>;
} catch {
  process.exit(0);
}

const req = checkpointRequestFor(env);
if (!req) process.exit(0);

try {
  const dir = getCheckpointDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${req.session_id}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(req));
  renameSync(tmp, path);
} catch (err) {
  console.error(`[macrodata] could not queue a session checkpoint: ${String(err)}`);
  process.exit(1);
}
