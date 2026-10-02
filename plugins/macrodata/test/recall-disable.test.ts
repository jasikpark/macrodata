/**
 * MACRODATA_RECALL_DISABLE at the ambient-recall hook: a fire touches no recall
 * state, so nothing waits in the mailbox for a worker that will never run.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { createTestContext, type TestContext } from "./helpers";

const HOOK = join(import.meta.dir, "..", "bin", "recall-hook.ts");

describe("recall hook kill switch", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => ctx.cleanup());

  const fire = (disable: string) =>
    spawnSync("bun", ["run", HOOK], {
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "what did we decide about the recall worker",
        session_id: "s1",
      }),
      env: { ...process.env, MACRODATA_ROOT: ctx.root, MACRODATA_RECALL_DISABLE: disable },
      encoding: "utf-8",
    });

  test("a disabled fire exits silently and writes nothing", () => {
    const r = fire("yes");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(join(ctx.root, ".recall"))).toBe(false);
  });

  // The control: without it, the assertion above would also pass for a hook that
  // never writes on this envelope at all.
  test("an enabled fire queues a request", () => {
    fire("");
    expect(existsSync(join(ctx.root, ".recall", "mailbox", "request-s1.json"))).toBe(true);
  });
});
