/**
 * MACRODATA_RECALL_DISABLE: the ambient-recall hook touches no recall state when
 * it is set, and the bash and TypeScript parsers agree on what "set" means.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { createTestContext, type TestContext } from "./helpers";
import { recallDisabled } from "../src/recall/config.ts";

const HOOK = join(import.meta.dir, "..", "bin", "recall-hook.ts");
const SUPERVISOR = join(import.meta.dir, "..", "bin", "macrodata-hook.sh");

describe("MACRODATA_RECALL_DISABLE parsing", () => {
  const saved = process.env.MACRODATA_RECALL_DISABLE;
  afterEach(() => {
    if (saved === undefined) delete process.env.MACRODATA_RECALL_DISABLE;
    else process.env.MACRODATA_RECALL_DISABLE = saved;
  });

  // The supervisor reaps on its reading and the hooks queue on theirs, so a value
  // they split on leaves requests piling up in a mailbox no worker drains.
  test.each([
    ["", false],
    ["1", true],
    ["true", true],
    [" TRUE ", true],
    ["Yes", true],
    ["on\n", true],
    ["0", false],
    ["false", false],
    ["off", false],
    ["t rue", false],
    ["tr\nue", false],
    ["2", false],
  ])("%j", (value, disabled) => {
    process.env.MACRODATA_RECALL_DISABLE = value;
    expect(recallDisabled()).toBe(disabled);
    const sh = spawnSync("bash", [SUPERVISOR, "print-recall-disabled"], {
      encoding: "utf-8",
      env: { ...process.env, MACRODATA_RECALL_DISABLE: value },
    });
    expect(sh.stdout.trim()).toBe(disabled ? "disabled" : "enabled");
  });
});

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
