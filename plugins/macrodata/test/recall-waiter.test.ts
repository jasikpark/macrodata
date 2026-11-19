/**
 * The recall waiter (bin/recall-waiter.ts): an async PostToolUse hook that
 * claims the worker's result as soon as it is served and emits it as
 * additionalContext, so Claude Code attaches it at the next tool step or turn
 * start. Otherwise it exits silently and leaves the inbox for the next drain.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawn, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createTestContext, type TestContext } from "./helpers";

const WAITER = join(import.meta.dir, "..", "bin", "recall-waiter.ts");
const SID = "s1";
const ENVELOPE = JSON.stringify({
  hook_event_name: "PostToolUse",
  tool_name: "Read",
  session_id: SID,
});

const hit = (content: string, score = 0.9) => ({
  content,
  source: "journal/2026-11-18.jsonl",
  type: "journal",
  score,
});

describe("recall waiter", () => {
  let ctx: TestContext;
  let mailbox: string;
  beforeEach(() => {
    ctx = createTestContext();
    mailbox = join(ctx.root, ".recall", "mailbox");
    mkdirSync(mailbox, { recursive: true });
  });
  afterEach(() => ctx.cleanup());

  const inbox = () => join(mailbox, `inbox-${SID}.json`);
  const serve = (hits: unknown[]) =>
    writeFileSync(
      inbox(),
      JSON.stringify({ requestedAt: "2026-11-18T23:00:00.000Z", servedSearch: "q", hits }),
    );
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    MACRODATA_ROOT: ctx.root,
    MACRODATA_RECALL_DISABLE: "",
    MACRODATA_RECALL_MODE: "",
    MACRODATA_RECALL_WAITER_WAIT_MS: "600",
    MACRODATA_RECALL_WAITER_POLL_MS: "20",
    ...extra,
  });
  const wait = (extra?: Record<string, string>) =>
    spawnSync("bun", ["run", WAITER], { input: ENVELOPE, env: env(extra), encoding: "utf-8" });
  const context = (stdout: string): string =>
    JSON.parse(stdout).hookSpecificOutput.additionalContext;
  const rows = () =>
    readFileSync(join(ctx.root, ".recall", "calibration.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

  test("a served result is emitted as additionalContext and consumed", () => {
    serve([hit("Orbit staging deploys freeze on Fridays")]);
    const r = wait();
    expect(r.status).toBe(0);
    expect(context(r.stdout)).toContain("<macrodata-recall>");
    expect(context(r.stdout)).toContain("Orbit staging deploys freeze on Fridays");
    // A systemMessage would reach the model too on the async path, doubling the block.
    expect(JSON.parse(r.stdout).systemMessage).toBeUndefined();
    expect(existsSync(inbox())).toBe(false);
    const injected = JSON.parse(readFileSync(join(mailbox, `injected-${SID}.json`), "utf-8"));
    expect(injected.map((e: { c: string }) => e.c)).toEqual([
      "Orbit staging deploys freeze on Fridays",
    ]);
    expect(rows().at(-1)).toMatchObject({ mode: "waiter", outcome: "served", n: 1 });
  });

  test("a result that lands mid-wait is picked up", async () => {
    const child = spawn("bun", ["run", WAITER], {
      env: env({ MACRODATA_RECALL_WAITER_WAIT_MS: "5000" }),
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stdin.end(ENVELOPE);
    await Bun.sleep(400);
    serve([hit("served while the waiter polled")]);
    const code = await new Promise<number | null>((res) => child.on("exit", res));
    expect(code).toBe(0);
    expect(context(stdout)).toContain("served while the waiter polled");
  });

  test("nothing served before the budget runs out exits silently", () => {
    const r = wait();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(rows().at(-1)).toMatchObject({ outcome: "deadline", n: 0 });
  });

  test("hits already in context are not re-injected", () => {
    writeFileSync(join(mailbox, `exclude-${SID}.json`), JSON.stringify(["already seen"]));
    serve([hit("already seen")]);
    const r = wait();
    expect(r.stdout).toBe("");
    expect(rows().at(-1)).toMatchObject({ outcome: "deadline", drained: 1, filteredInContext: 1 });
  });

  test("hits this session injected since the last exclude write are not re-injected", () => {
    writeFileSync(
      join(mailbox, `injected-${SID}.json`),
      JSON.stringify([{ c: "just injected", ts: "2026-11-18T23:00:00.000Z" }]),
    );
    serve([hit("just injected")]);
    expect(wait().stdout).toBe("");
  });

  test("hits under the ambient floor are not injected", () => {
    serve([hit("weak match", 0.1)]);
    expect(wait().stdout).toBe("");
  });

  test("a live waiter already covering the session makes a second one leave", () => {
    writeFileSync(join(mailbox, `waiter-${SID}.lock`), String(process.pid));
    serve([hit("left for the first waiter")]);
    const r = wait();
    expect(r.stdout).toBe("");
    expect(existsSync(inbox())).toBe(true);
    expect(rows().at(-1)).toMatchObject({ outcome: "covered" });
  });

  test("a lock left by a dead waiter is taken over and released", () => {
    writeFileSync(join(mailbox, `waiter-${SID}.lock`), "999999");
    serve([hit("dead lock")]);
    expect(context(wait().stdout)).toContain("dead lock");
    expect(existsSync(join(mailbox, `waiter-${SID}.lock`))).toBe(false);
  });

  test("sync mode leaves delivery to the inline hook", () => {
    serve([hit("sync mode")]);
    const r = wait({ MACRODATA_RECALL_MODE: "sync" });
    expect(r.stdout).toBe("");
    expect(existsSync(inbox())).toBe(true);
  });
});
