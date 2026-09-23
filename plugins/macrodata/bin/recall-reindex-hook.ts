#!/usr/bin/env bun
/**
 * Ambient-recall reindex trigger — fires on SessionStart and on PostToolUse for
 * the tools that write memory (Write/Edit, and the macrodata MCP journal tools).
 *
 * Drops a reindex request into the mailbox for the worker (src/recall/reindex.ts)
 * and returns; this process never loads a model or touches the index. A request
 * written while no worker runs waits in the mailbox for the next one.
 *
 * On SessionStart with no index yet, prints a one-line notice: the worker's first
 * reconcile embeds the whole corpus, and recall covers only what has committed.
 *
 * Exit 1 on an unexpected error (non-blocking, visible); never exit 2.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { getIndexDir, getMailboxDir, getReindexRequestPath } from "../src/recall/config.ts";
import { reindexRequestFor, type HookEnvelope } from "../src/recall/reindex-request.ts";

let env: HookEnvelope = {};
const raw = process.stdin.isTTY ? "" : await Bun.stdin.text();
try {
  const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
  if (typeof parsed !== "object" || parsed === null) process.exit(0);
  env = parsed as HookEnvelope;
} catch {
  process.exit(0);
}

const req = reindexRequestFor(env);
if (!req) process.exit(0);

try {
  mkdirSync(getMailboxDir(), { recursive: true });
  // Corpus requests are identical, so they share one name and a burst of them
  // (or a worker that never drains them) leaves one file, not one per session.
  const path = getReindexRequestPath("corpus" in req ? "corpus" : `${process.pid}-${Date.now()}`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(req));
  renameSync(tmp, path);
} catch (err) {
  console.error(`[macrodata-recall] could not queue a reindex: ${String(err)}`);
  process.exit(1);
}

if (
  env.hook_event_name === "SessionStart" &&
  !existsSync(join(getIndexDir(), "vectors", "index.json"))
) {
  console.log(
    "<macrodata-recall-status>\nmacrodata-recall: no recall index yet; the worker is building it in the background. The first build embeds the whole memory corpus and can take a while; until it finishes, recall covers only what has been indexed so far.\n</macrodata-recall-status>",
  );
}
