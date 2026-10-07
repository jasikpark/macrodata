/**
 * Memory-store skills linked into Claude Code's skills dir: what gets linked,
 * what is never touched, and that turning the option off unlinks only ours.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestContext, type TestContext } from "./helpers";
import {
  MARKER_NAME,
  adoptSkill,
  reconcileSkills,
  skillStatus,
  skillsEnabled,
} from "../src/skills.ts";

const SYNC = join(import.meta.dir, "..", "bin", "skills-sync.ts");

let ctx: TestContext;
let configDir: string;
let skillsDir: string;
let store: string;
let savedConfigDir: string | undefined;
let savedOption: string | undefined;

beforeEach(() => {
  ctx = createTestContext("macrodata-skills-");
  configDir = realpathSync(mkdtempSync(join(tmpdir(), "macrodata-claude-")));
  skillsDir = join(configDir, "skills");
  store = join(ctx.root, "skills");
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  savedOption = process.env.CLAUDE_PLUGIN_OPTION_SKILLS_ENABLED;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  delete process.env.CLAUDE_PLUGIN_OPTION_SKILLS_ENABLED;
});

afterEach(() => {
  ctx.cleanup();
  rmSync(configDir, { recursive: true, force: true });
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  if (savedOption === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_SKILLS_ENABLED;
  else process.env.CLAUDE_PLUGIN_OPTION_SKILLS_ENABLED = savedOption;
});

function storeSkill(name: string, status?: string): string {
  const dir = join(store, name);
  mkdirSync(dir, { recursive: true });
  const fm = status ? `status: ${status}\n` : "";
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test\n${fm}---\n\nbody\n`);
  return dir;
}

function handSkill(name: string): string {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: hand\n---\n`);
  return dir;
}

const isLink = (p: string) => existsSync(p) && lstatSync(p).isSymbolicLink();
const resolvesTo = (p: string) => realpathSync(p);
const marker = () => JSON.parse(readFileSync(join(skillsDir, MARKER_NAME), "utf-8"));

describe("skillStatus", () => {
  test.each([
    ["---\nstatus: probation\n---\n", "probation"],
    ["---\nname: x\nstatus: 'archived'\n---\nbody", "archived"],
    ["---\r\nstatus: Active\r\n---\r\n", "active"],
    ["---\nname: x\n---\nstatus: archived\n", "active"],
    ["no frontmatter", "active"],
  ])("%j → %s", (md, status) => {
    expect(skillStatus(md)).toBe(status);
  });
});

describe("skillsEnabled", () => {
  test("off by default", () => {
    expect(skillsEnabled()).toBe(false);
  });

  test("the live settings value outranks the exported option", () => {
    process.env.CLAUDE_PLUGIN_OPTION_SKILLS_ENABLED = "true";
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({
        pluginConfigs: { "macrodata@mkt": { options: { skills_enabled: false } } },
      }),
    );
    expect(skillsEnabled()).toBe(false);
  });

  test("the exported option applies when settings say nothing", () => {
    process.env.CLAUDE_PLUGIN_OPTION_SKILLS_ENABLED = "true";
    expect(skillsEnabled()).toBe(true);
  });
});

describe("reconcileSkills", () => {
  test("links active, probation and status-less skills; skips archived", () => {
    const a = storeSkill("alpha");
    const b = storeSkill("beta", "probation");
    storeSkill("gamma", "archived");
    const r = reconcileSkills(true);
    expect(r.linked).toEqual(["alpha", "beta"]);
    expect(resolvesTo(join(skillsDir, "alpha"))).toBe(a);
    expect(resolvesTo(join(skillsDir, "beta"))).toBe(b);
    expect(existsSync(join(skillsDir, "gamma"))).toBe(false);
    expect(marker()).toEqual({ store, links: ["alpha", "beta"] });
  });

  test("links are relative", () => {
    storeSkill("alpha");
    reconcileSkills(true);
    expect(readlinkSync(join(skillsDir, "alpha")).startsWith("/")).toBe(false);
  });

  test("reports creating the skills dir, since Claude Code only watches dirs that existed at startup", () => {
    storeSkill("alpha");
    expect(reconcileSkills(true).createdDir).toBe(true);
    expect(reconcileSkills(true).createdDir).toBe(false);
  });

  test("is idempotent", () => {
    storeSkill("alpha");
    reconcileSkills(true);
    const r = reconcileSkills(true);
    expect(r).toEqual({ linked: [], relinked: [], pruned: [], warnings: [], createdDir: false });
  });

  test("never touches a hand-made skill or another installer's link of the same name", () => {
    storeSkill("alpha");
    storeSkill("beta");
    const hand = handSkill("alpha");
    const elsewhere = mkdtempSync(join(tmpdir(), "macrodata-foreign-"));
    symlinkSync(elsewhere, join(skillsDir, "beta"));
    try {
      const r = reconcileSkills(true);
      expect(r.linked).toEqual([]);
      expect(r.warnings).toHaveLength(2);
      expect(lstatSync(hand).isDirectory()).toBe(true);
      expect(readlinkSync(join(skillsDir, "beta"))).toBe(elsewhere);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("unlinks a skill once it is archived or deleted", () => {
    storeSkill("alpha");
    const b = storeSkill("beta");
    reconcileSkills(true);
    storeSkill("alpha", "archived");
    rmSync(b, { recursive: true });
    const r = reconcileSkills(true);
    expect(r.pruned.sort()).toEqual(["alpha", "beta"]);
    expect(existsSync(join(skillsDir, "alpha"))).toBe(false);
    expect(isLink(join(skillsDir, "beta"))).toBe(false);
    expect(marker().links).toEqual([]);
  });

  test("turning it off unlinks only its own links", () => {
    storeSkill("alpha");
    handSkill("mine");
    reconcileSkills(true);
    const r = reconcileSkills(false);
    expect(r.pruned).toEqual(["alpha"]);
    expect(existsSync(join(skillsDir, "mine", "SKILL.md"))).toBe(true);
  });

  test("leaves a real dir that replaced one of its links", () => {
    storeSkill("alpha");
    reconcileSkills(true);
    rmSync(join(skillsDir, "alpha"));
    handSkill("alpha");
    const r = reconcileSkills(false);
    expect(r.pruned).toEqual([]);
    expect(lstatSync(join(skillsDir, "alpha")).isDirectory()).toBe(true);
  });

  test("repoints an owned link that drifted", () => {
    const a = storeSkill("alpha");
    reconcileSkills(true);
    rmSync(join(skillsDir, "alpha"));
    symlinkSync("/nonexistent", join(skillsDir, "alpha"));
    expect(reconcileSkills(true).relinked).toEqual(["alpha"]);
    expect(resolvesTo(join(skillsDir, "alpha"))).toBe(a);
  });

  test("re-owns its own links after the marker is lost", () => {
    storeSkill("alpha");
    reconcileSkills(true);
    rmSync(join(skillsDir, MARKER_NAME));
    expect(reconcileSkills(true).warnings).toEqual([]);
    expect(marker().links).toEqual(["alpha"]);
  });

  test("a marker for a different store owns nothing", () => {
    storeSkill("alpha");
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync("/nonexistent", join(skillsDir, "alpha"));
    writeFileSync(
      join(skillsDir, MARKER_NAME),
      JSON.stringify({ store: "/other", links: ["alpha"] }),
    );
    const r = reconcileSkills(true);
    expect(r.relinked).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(readlinkSync(join(skillsDir, "alpha"))).toBe("/nonexistent");
  });

  test("skips names Claude Code can't load", () => {
    storeSkill("Bad_Name");
    const r = reconcileSkills(true);
    expect(r.linked).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });

  test("does nothing, and creates nothing, with an empty store", () => {
    expect(reconcileSkills(true).createdDir).toBe(false);
    expect(existsSync(skillsDir)).toBe(false);
  });
});

describe("adoptSkill", () => {
  test("moves a hand-made skill into the store and links it back", () => {
    handSkill("alpha");
    const dest = adoptSkill("alpha");
    expect(dest).toBe(join(store, "alpha"));
    expect(existsSync(join(dest, "SKILL.md"))).toBe(true);
    expect(resolvesTo(join(skillsDir, "alpha"))).toBe(dest);
    expect(marker().links).toEqual(["alpha"]);
    expect(reconcileSkills(true).warnings).toEqual([]);
  });

  test("refuses another installer's link", () => {
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(ctx.root, join(skillsDir, "alpha"));
    expect(() => adoptSkill("alpha")).toThrow("symlink");
  });

  test("refuses a name the store already has", () => {
    handSkill("alpha");
    storeSkill("alpha");
    expect(() => adoptSkill("alpha")).toThrow("already has");
    expect(lstatSync(join(skillsDir, "alpha")).isDirectory()).toBe(true);
  });
});

describe("skills-sync.ts", () => {
  const run = (...args: string[]) =>
    spawnSync("bun", ["run", SYNC, ...args], {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PLUGIN_OPTION_SKILLS_ENABLED: "true" },
    });

  test("prints what changed, then nothing once in sync", () => {
    storeSkill("alpha");
    const first = run();
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("linked: alpha");
    expect(first.stdout).toContain("/reload-skills");
    expect(run().stdout).toBe("");
  });

  test("adopt exits nonzero on refusal", () => {
    expect(run("adopt", "missing").status).toBe(1);
  });
});
