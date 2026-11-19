/**
 * Session checkpoints: which hook envelopes become a request, and what the hook
 * writes into the daemon's queue. The daemon side is in checkpoint-queue.test.ts.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { createTestContext, type TestContext } from "./helpers";
import {
  checkpointDelayMs,
  checkpointRequestFor,
  getCheckpointDir,
  isCheckpointFork,
  mergeCheckpointRequests,
  parseCheckpointRequest,
  sessionOfRequestFile,
} from "../src/checkpoint.ts";

const HOOK = join(import.meta.dir, "..", "bin", "checkpoint-hook.ts");

const envelope = (over: Record<string, unknown> = {}) => ({
  session_id: "77bb4a5d-bca6-44ab-8bc4-a5a2e8f2251b",
  transcript_path: "/home/u/.claude/projects/p/77bb4a5d-bca6-44ab-8bc4-a5a2e8f2251b.jsonl",
  hook_event_name: "Stop",
  ...over,
});

const runHook = (ctx: TestContext, input: unknown, env: Record<string, string> = {}) => {
  // A test run inside a checkpoint fork must not inherit its guard.
  const { MACRODATA_CHECKPOINT_FORK: _, ...inherited } = process.env;
  return spawnSync("bun", ["run", HOOK], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: { ...inherited, MACRODATA_ROOT: ctx.root, ...env },
    encoding: "utf-8",
  });
};

describe("checkpointRequestFor", () => {
  test("Stop, PreCompact and SessionEnd each make a request", () => {
    for (const event of ["Stop", "PreCompact", "SessionEnd"]) {
      expect(checkpointRequestFor(envelope({ hook_event_name: event }), 42)).toEqual({
        session_id: "77bb4a5d-bca6-44ab-8bc4-a5a2e8f2251b",
        transcript_path: "/home/u/.claude/projects/p/77bb4a5d-bca6-44ab-8bc4-a5a2e8f2251b.jsonl",
        event: event as "Stop",
        ts: 42,
      });
    }
  });

  test("other events make none", () => {
    expect(checkpointRequestFor(envelope({ hook_event_name: "UserPromptSubmit" }))).toBeNull();
  });

  test("a session_id that is not a safe filename is refused", () => {
    for (const session_id of ["../escape", "a/b", "", "x".repeat(129), 7]) {
      expect(checkpointRequestFor(envelope({ session_id }))).toBeNull();
    }
  });

  test("a transcript_path that is not a .jsonl file is refused", () => {
    expect(checkpointRequestFor(envelope({ transcript_path: "/etc/passwd" }))).toBeNull();
    expect(checkpointRequestFor(envelope({ transcript_path: undefined }))).toBeNull();
  });
});

describe("checkpointDelayMs", () => {
  test("Stop waits; PreCompact and SessionEnd act at once", () => {
    expect(checkpointDelayMs("Stop")).toBeGreaterThan(0);
    expect(checkpointDelayMs("PreCompact")).toBe(0);
    expect(checkpointDelayMs("SessionEnd")).toBe(0);
  });
});

describe("mergeCheckpointRequests", () => {
  const req = (event: string, ts: number) => checkpointRequestFor(envelope({ hook_event_name: event }), ts)!;

  test("a later Stop does not demote a pending SessionEnd or PreCompact", () => {
    expect(mergeCheckpointRequests(req("SessionEnd", 1), req("Stop", 2))).toEqual({ ...req("Stop", 2), event: "SessionEnd" });
    expect(mergeCheckpointRequests(req("PreCompact", 1), req("Stop", 2)).event).toBe("PreCompact");
  });

  test("a stronger or equal event replaces the pending one", () => {
    expect(mergeCheckpointRequests(req("Stop", 1), req("SessionEnd", 2))).toEqual(req("SessionEnd", 2));
    expect(mergeCheckpointRequests(req("Stop", 1), req("Stop", 2))).toEqual(req("Stop", 2));
    expect(mergeCheckpointRequests(null, req("Stop", 2))).toEqual(req("Stop", 2));
  });
});

describe("isCheckpointFork", () => {
  test("only the exact value 1 marks a fork", () => {
    expect(isCheckpointFork({ MACRODATA_CHECKPOINT_FORK: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "1 "]) {
      expect(isCheckpointFork({ MACRODATA_CHECKPOINT_FORK: v })).toBe(false);
    }
  });
});

describe("parseCheckpointRequest", () => {
  test("round-trips a request", () => {
    const req = checkpointRequestFor(envelope(), 1000);
    expect(parseCheckpointRequest(JSON.stringify(req))).toEqual(req);
  });

  test("rejects a request without a timestamp, and junk", () => {
    expect(parseCheckpointRequest(JSON.stringify(envelope()))).toBeNull();
    expect(parseCheckpointRequest("{not json")).toBeNull();
    expect(parseCheckpointRequest("null")).toBeNull();
  });
});

describe("checkpoint-hook", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => ctx.cleanup());

  test("each fire adds a request file of its own, named for its session", () => {
    expect(runHook(ctx, envelope()).status).toBe(0);
    expect(runHook(ctx, envelope({ hook_event_name: "SessionEnd" })).status).toBe(0);

    const dir = getCheckpointDir();
    const names = readdirSync(dir);
    expect(names).toHaveLength(2);
    for (const name of names) expect(sessionOfRequestFile(name)).toBe("77bb4a5d-bca6-44ab-8bc4-a5a2e8f2251b");
    const events = names.map((n) => parseCheckpointRequest(readFileSync(join(dir, n), "utf-8"))?.event ?? "").sort((a, b) => a.localeCompare(b));
    expect(events).toEqual(["SessionEnd", "Stop"]);
  });

  test("a session forked to process a checkpoint queues nothing", () => {
    const r = runHook(ctx, envelope({ hook_event_name: "SessionEnd" }), { MACRODATA_CHECKPOINT_FORK: "1" });
    expect(r.status).toBe(0);
    expect(existsSync(getCheckpointDir())).toBe(false);
  });

  test("an envelope it cannot use writes nothing and exits 0", () => {
    for (const input of ["", "not json", "[]", envelope({ session_id: "../x" })]) {
      expect(runHook(ctx, input).status).toBe(0);
    }
    expect(existsSync(getCheckpointDir())).toBe(false);
  });
});
