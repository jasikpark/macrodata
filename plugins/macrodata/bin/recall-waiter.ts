#!/usr/bin/env bun
/**
 * Recall waiter — delivers a recall result as soon as the worker serves it.
 *
 * Registered on PostToolUse (Read/WebSearch/WebFetch) with `async: true`,
 * beside the ambient-recall hook. That hook drains whatever the worker already
 * served and enqueues the current context; the worker then reranks for ~6s.
 * This waiter polls the session's inbox in the background, claims the result
 * when it lands, and exits with it as additionalContext.
 *
 * Claude Code (2.1.327) holds an async hook's output and attaches it at the
 * next attachment pass: after the next tool step if the turn is still running,
 * otherwise at the start of the next turn. It never wakes an idle session and
 * never blocks the agent, in interactive and `claude -p` sessions alike, so a
 * result that misses the turn falls back to next-turn delivery on its own.
 * (`asyncRewake` would wake an idle session, labels the message "hook blocking
 * error", and runs inline under `claude -p`.)
 *
 * Exits silently when the wait budget (MACRODATA_RECALL_WAITER_WAIT_MS) runs
 * out — the next drain still finds a late result in the inbox — or when another
 * live waiter already covers the session. Off when recall is disabled or
 * MACRODATA_RECALL_MODE=sync (sync mode injects inline). Imports stay light: no
 * models, no index.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import {
  recallDisabled,
  getCalibrationLog,
  getExcludePath,
  getInjectedPath,
  getMailboxDir,
  getWaiterLockPath,
} from "../src/recall/config.ts";
import { envNum } from "../src/recall/env.ts";
import { ambientProfile } from "../src/recall/profiles.ts";
import { memKey, recordAccess } from "../src/recall/access.ts";
import { atomicWrite, claimInbox, recallBlock, srcLabel, type Claim } from "../src/recall/inbox.ts";

/** Above the worker's p90 rerank (~7s, calibration.jsonl 11-18) with slack for a queued request. */
const WAIT_MS = envNum("MACRODATA_RECALL_WAITER_WAIT_MS", 12_000, 0, 60_000);
const POLL_MS = envNum("MACRODATA_RECALL_WAITER_POLL_MS", 250, 10, 5_000);

type Outcome = "served" | "deadline" | "covered";

function readJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * One waiter per session. A burst of parallel Reads spawns one waiter each;
 * the first holds the lock and the rest leave, since any of them would wait
 * for the same inbox. A lock whose pid is gone is taken over.
 */
function takeLock(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") return false;
      const pid = Number(readFileSync(path, "utf-8"));
      try {
        if (pid > 0) {
          process.kill(pid, 0);
          return false;
        }
      } catch {}
      try {
        unlinkSync(path);
      } catch {}
    }
  }
  return false;
}

async function main(): Promise<void> {
  if (recallDisabled() || process.env.MACRODATA_RECALL_MODE === "sync") process.exit(0);
  const t0 = Date.now();
  let env: { session_id?: string; tool_name?: string } = {};
  try {
    env = JSON.parse(await Bun.stdin.text());
  } catch {
    process.exit(0);
  }
  const sid = (env.session_id || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!sid) process.exit(0);
  mkdirSync(getMailboxDir(), { recursive: true });

  const lock = getWaiterLockPath(sid);
  const log = (outcome: Outcome, claim?: Claim): void => {
    try {
      appendFileSync(
        getCalibrationLog(),
        JSON.stringify({
          ts: new Date().toISOString(),
          sid,
          event: "PostToolUse",
          tool: env.tool_name ?? null,
          mode: "waiter",
          outcome,
          waitMs: Date.now() - t0,
          search: (claim?.meta.servedSearch ?? "").slice(0, 300),
          n: claim?.ready.length ?? 0,
          scores: claim?.ready.map((h) => Number(h.score.toFixed(3))) ?? [],
          sources: claim?.ready.map(srcLabel) ?? [],
          drained: claim?.drained ?? 0,
          filteredInContext: claim?.filteredInContext ?? 0,
          floorDropped: claim?.floorDropped ?? 0,
          drainError: claim?.drainError ?? false,
        }) + "\n",
      );
    } catch {}
  };
  if (!takeLock(lock)) {
    log("covered");
    process.exit(0);
  }
  const release = (): void => {
    try {
      if (readFileSync(lock, "utf-8") === String(process.pid)) unlinkSync(lock);
    } catch {}
  };

  const profile = ambientProfile();
  let last: Claim | undefined;
  while (Date.now() - t0 < WAIT_MS) {
    // The exclude the hook last wrote, plus anything injected since: a hit the
    // model has already seen must not come back through this side door.
    const injected = readJson<({ c: string } | string)[]>(getInjectedPath(sid), []).map((e) =>
      typeof e === "string" ? e : e.c,
    );
    const exclude = new Set<string>([...readJson<string[]>(getExcludePath(sid), []), ...injected]);
    const claim = claimInbox(sid, exclude, profile);
    if (claim.claimed) last = claim;
    if (claim.ready.length > 0) {
      const now = new Date().toISOString();
      try {
        const prior = readJson<{ c: string; ts: string }[]>(getInjectedPath(sid), []);
        atomicWrite(
          getInjectedPath(sid),
          JSON.stringify(
            [...prior, ...claim.ready.map((h) => ({ c: h.content, ts: now }))].slice(-1000),
          ),
        );
      } catch {}
      recordAccess(claim.ready.map(memKey), "surfaced", now);
      log("served", claim);
      release();
      // additionalContext only: on the async path Claude Code injects
      // systemMessage into the model's context too, so a debug copy there
      // would double the block.
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: recallBlock(claim.ready),
          },
        }),
      );
      process.exit(0);
    }
    await Bun.sleep(POLL_MS);
  }
  log("deadline", last);
  release();
  process.exit(0);
}

main().catch((e) => {
  console.error(
    `[macrodata-recall] waiter failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
  );
  process.exit(1);
});
