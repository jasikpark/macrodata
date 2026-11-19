/**
 * Session checkpoints: which hook envelopes become a request, and what the hook
 * writes into the daemon's queue. The daemon side is not exercised here.
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
  parseCheckpointRequest,
} from "../src/checkpoint.ts";

const HOOK = join(import.meta.dir, "..", "bin", "checkpoint-hook.ts");

const envelope = (over: Record<string, unknown> = {}) => ({
  session_id: "77bb4a5d-bca6-44ab-8bc4-a5a2e8f2251b",
  transcript_path: "/home/u/.claude/projects/p/77bb4a5d-bca6-44ab-8bc4-a5a2e8f2251b.jsonl",
  hook_event_name: "Stop",
  ...over,
});

const runHook = (ctx: TestContext, input: unknown) =>
  spawnSync("bun", ["run", HOOK], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: { ...process.env, MACRODATA_ROOT: ctx.root },
    encoding: "utf-8",
  });

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
  test("Stop waits under the 5-minute prompt-cache TTL; PreCompact and SessionEnd act at once", () => {
    expect(checkpointDelayMs("Stop")).toBeGreaterThan(0);
    expect(checkpointDelayMs("Stop")).toBeLessThan(5 * 60_000);
    expect(checkpointDelayMs("PreCompact")).toBe(0);
    expect(checkpointDelayMs("SessionEnd")).toBe(0);
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

  test("writes one file per session and a later fire replaces it", () => {
    expect(runHook(ctx, envelope()).status).toBe(0);
    expect(runHook(ctx, envelope({ hook_event_name: "SessionEnd" })).status).toBe(0);

    const dir = getCheckpointDir();
    expect(readdirSync(dir)).toEqual(["77bb4a5d-bca6-44ab-8bc4-a5a2e8f2251b.json"]);
    const req = parseCheckpointRequest(readFileSync(join(dir, readdirSync(dir)[0]!), "utf-8"));
    expect(req?.event).toBe("SessionEnd");
  });

  test("a session forked to process a checkpoint queues nothing", () => {
    const r = spawnSync("bun", ["run", HOOK], {
      input: JSON.stringify(envelope({ hook_event_name: "SessionEnd" })),
      env: { ...process.env, MACRODATA_ROOT: ctx.root, MACRODATA_CHECKPOINT_FORK: "1" },
      encoding: "utf-8",
    });
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
