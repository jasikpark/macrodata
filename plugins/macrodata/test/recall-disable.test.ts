/**
 * Recall's on/off switch: the ambient-recall hook touches no recall state when
 * recall is off, and the bash and TypeScript readers agree on when that is.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestContext, type TestContext } from "./helpers";
import { recallDisabled } from "../src/recall/config.ts";

const HOOK = join(import.meta.dir, "..", "bin", "recall-hook.ts");
const SUPERVISOR = join(import.meta.dir, "..", "bin", "macrodata-hook.sh");

interface SwitchInputs {
  disable?: string;
  option?: string;
  /** Written verbatim as settings.json; absent means no file. */
  settings?: string;
}

const SAVED = ["MACRODATA_RECALL_DISABLE", "CLAUDE_PLUGIN_OPTION_RECALL_ENABLED", "CLAUDE_CONFIG_DIR"] as const;

/** Both readers' verdicts on the same inputs. */
function verdicts(inputs: SwitchInputs): { ts: boolean; sh: boolean } {
  const saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  const configDir = mkdtempSync(join(tmpdir(), "macrodata-switch-"));
  try {
    if (inputs.settings !== undefined) writeFileSync(join(configDir, "settings.json"), inputs.settings);
    const env: Record<string, string> = {
      MACRODATA_RECALL_DISABLE: inputs.disable ?? "",
      CLAUDE_PLUGIN_OPTION_RECALL_ENABLED: inputs.option ?? "",
      CLAUDE_CONFIG_DIR: configDir,
    };
    Object.assign(process.env, env);
    const ts = recallDisabled();
    const sh = spawnSync("bash", [SUPERVISOR, "print-recall-disabled"], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
    }).stdout.trim();
    return { ts, sh: sh === "disabled" };
  } finally {
    for (const k of SAVED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(configDir, { recursive: true, force: true });
  }
}

const plugin = (configs: Record<string, unknown>) => JSON.stringify({ pluginConfigs: configs });

// The supervisor reaps on its reading and the hooks queue on theirs, so inputs
// they split on leave requests piling up in a mailbox no worker drains.
describe("recall switch parsing", () => {
  test.each([
    ["", false],
    ["1", true],
    ["true", true],
    [" TRUE ", true],
    ["Yes", true],
    ["on\n", true],
    ["\n1", true],
    ["\t\r\v\fyes", true],
    ["0", false],
    ["false", false],
    ["off", false],
    ["t rue", false],
    ["tr\nue", false],
    ["2", false],
    // Outside the ASCII whitespace set, so neither side trims them.
    ["\uFEFF1", false],
    ["\u00A01", false],
  ])("MACRODATA_RECALL_DISABLE=%j", (disable, disabled) => {
    expect(verdicts({ disable })).toEqual({ ts: disabled, sh: disabled });
  });

  test.each<[string, SwitchInputs, boolean]>([
    ["nothing set", {}, false],
    ["option off in settings", { settings: plugin({ "macrodata@macrodata": { recall_enabled: false } }) }, true],
    ["option on in settings", { settings: plugin({ "macrodata@macrodata": { recall_enabled: true } }) }, false],
    ["option off as a string", { settings: plugin({ "macrodata@macrodata": { recall_enabled: "false" } }) }, true],
    ["any marketplace's entry", { settings: plugin({ "macrodata@fork": { recall_enabled: false } }) }, true],
    [
      "off in one install wins",
      { settings: plugin({ "macrodata@a": { recall_enabled: true }, "macrodata@b": { recall_enabled: false } }) },
      true,
    ],
    ["another plugin's option", { settings: plugin({ "other@macrodata": { recall_enabled: false } }) }, false],
    ["unrecognized value", { settings: plugin({ "macrodata@macrodata": { recall_enabled: 0 } }) }, false],
    // The file is read live because the exported copy is from session start.
    ["settings on beats a stale exported off", { option: "false", settings: plugin({ "macrodata@m": { recall_enabled: true } }) }, false],
    ["exported off with no file entry", { option: "false" }, true],
    ["exported off with unreadable settings", { option: "false", settings: "{not json" }, true],
    ["exported on", { option: "true" }, false],
    ["override beats settings on", { disable: "1", settings: plugin({ "macrodata@m": { recall_enabled: true } }) }, true],
    ["non-object pluginConfigs", { settings: JSON.stringify({ pluginConfigs: [false] }) }, false],
    ["non-object entry", { settings: plugin({ "macrodata@m": false }) }, false],
  ])("%s", (_name, inputs, disabled) => {
    expect(verdicts(inputs)).toEqual({ ts: disabled, sh: disabled });
  });
});

describe("recall hook kill switch", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => ctx.cleanup());

  const fire = (env: Record<string, string> = {}, preload?: string) =>
    spawnSync("bun", ["run", ...(preload ? [`--preload=${preload}`] : []), HOOK], {
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "what did we decide about the recall worker",
        session_id: "s1",
      }),
      env: { ...process.env, MACRODATA_ROOT: ctx.root, ...env },
      encoding: "utf-8",
    });

  test("a disabled fire exits silently and writes nothing", () => {
    const r = fire({ MACRODATA_RECALL_DISABLE: "yes" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(join(ctx.root, ".recall"))).toBe(false);
  });

  // The pipeline's imports cost ~120 MB per fire, and this hook fires on every
  // prompt, Read, web fetch and Stop. Silence alone can't show they were skipped:
  // a disabled exit beats the async pipeline to any write either way.
  test("a disabled fire never loads the pipeline", () => {
    const trap = join(import.meta.dir, "fixtures", "trap-recall-pipeline.ts");
    expect(fire({ MACRODATA_RECALL_DISABLE: "1" }, trap).status).toBe(0);
    // The trap's control: an enabled fire does load it.
    expect(fire({}, trap).status).toBe(3);
  });

  test("the recall_enabled option turns the hook off", () => {
    const configDir = mkdtempSync(join(tmpdir(), "macrodata-switch-"));
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({ pluginConfigs: { "macrodata@macrodata": { recall_enabled: false } } }),
    );
    try {
      expect(fire({ CLAUDE_CONFIG_DIR: configDir }).status).toBe(0);
      expect(existsSync(join(ctx.root, ".recall"))).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  // The control: without it, the assertion above would also pass for a hook that
  // never writes on this envelope at all.
  test("an enabled fire queues a request", () => {
    fire();
    expect(existsSync(join(ctx.root, ".recall", "mailbox", "request-s1.json"))).toBe(true);
  });
});
