/**
 * Recall's on/off switch: when it is off and who decides, and that the
 * ambient-recall hook then touches no recall state.
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

/** recallDisabled()'s verdict in-process and through the supervisor's subcommand. */
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
/** A plugin entry as Claude Code writes it: pluginConfigs[<id>].options.<key>. */
const opt = (recall_enabled: unknown) => ({ options: { recall_enabled } });

// The supervisor reaps on this verdict and the hooks queue on it, so the
// subcommand's column catches the shell wiring drifting from the function.
describe("recall switch parsing", () => {
  test.each([
    ["", false],
    ["1", true],
    ["true", true],
    [" TRUE ", true],
    ["Yes", true],
    ["on\n", true],
    ["\n1", true],
    ["\uFEFF1", true],
    ["0", false],
    ["false", false],
    ["off", false],
    ["t rue", false],
    ["tr\nue", false],
    ["2", false],
  ])("MACRODATA_RECALL_DISABLE=%j", (disable, disabled) => {
    expect(verdicts({ disable })).toEqual({ ts: disabled, sh: disabled });
  });

  test.each<[string, SwitchInputs, boolean]>([
    ["nothing set", {}, false],
    ["option off in settings", { settings: plugin({ "macrodata@macrodata": opt(false) }) }, true],
    ["option on in settings", { settings: plugin({ "macrodata@macrodata": opt(true) }) }, false],
    ["option off as a string", { settings: plugin({ "macrodata@macrodata": opt("false") }) }, true],
    ["any marketplace's entry", { settings: plugin({ "macrodata@fork": opt(false) }) }, true],
    ["off in one install wins", { settings: plugin({ "macrodata@a": opt(true), "macrodata@b": opt(false) }) }, true],
    ["another plugin's option", { settings: plugin({ "other@macrodata": opt(false) }) }, false],
    ["unrecognized value", { settings: plugin({ "macrodata@macrodata": opt(0) }) }, false],
    ["a value wrapped in an array", { settings: plugin({ "macrodata@macrodata": opt(["false"]) }) }, false],
    ["the key outside options", { settings: plugin({ "macrodata@macrodata": { recall_enabled: false } }) }, false],
    ["non-object options", { settings: plugin({ "macrodata@macrodata": { options: false } }) }, false],
    ["non-object entry", { settings: plugin({ "macrodata@m": false }) }, false],
    ["non-object pluginConfigs", { settings: JSON.stringify({ pluginConfigs: [false] }) }, false],
    ["a byte-order mark", { settings: "\uFEFF" + plugin({ "macrodata@m": opt(false) }) }, true],
    // Each of these is valid to jq; none is JSON, so the file counts as unreadable.
    ["trailing junk", { option: "true", settings: plugin({ "macrodata@m": opt(false) }) + "}" }, false],
    ["two documents", { option: "true", settings: plugin({ "macrodata@m": opt(false) }) + "{}" }, false],
    ["a NaN literal", { option: "true", settings: '{"n":NaN,"pluginConfigs":{"macrodata@m":{"options":{"recall_enabled":false}}}}' }, false],
    // The file is read live because another session's exported copy can be stale.
    ["settings on beats a stale exported off", { option: "false", settings: plugin({ "macrodata@m": opt(true) }) }, false],
    ["exported off with no file entry", { option: "false" }, true],
    ["exported off with unreadable settings", { option: "false", settings: "{not json" }, true],
    ["exported on", { option: "true" }, false],
    ["override beats settings on", { disable: "1", settings: plugin({ "macrodata@m": opt(true) }) }, true],
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
      plugin({ "macrodata@macrodata": opt(false) }),
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
