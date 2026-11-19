#!/usr/bin/env bun
/**
 * Session checkpoint trigger — fires on Stop, PreCompact and SessionEnd.
 *
 * Adds this fire's request to the daemon's queue (src/checkpoint.ts) as a file
 * of its own and returns; the daemon does the work and deletes the file once a
 * run has covered it.
 *
 * Exit 1 on an unexpected error (non-blocking, visible); never exit 2, which
 * would block the Stop.
 */

import { mkdirSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { checkpointRequestFor, getCheckpointDir, isCheckpointFork, requestFileName } from "../src/checkpoint.js";

// A session the daemon forked to process a checkpoint must not queue its own,
// or each fork would schedule the next.
if (isCheckpointFork()) process.exit(0);

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
  const path = join(dir, requestFileName(req));
  // The daemon ignores anything not ending in .json, so it never reads a partial write.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(req));
  renameSync(tmp, path);
} catch (err) {
  console.error(`[macrodata] could not queue a session checkpoint: ${String(err)}`);
  process.exit(1);
}
