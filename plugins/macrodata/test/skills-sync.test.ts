/**
 * Memory-store skills linked into Claude Code's skills dir: what gets linked,
 * what is never touched, and that turning the option off unlinks only ours.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
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
const owned = (s = store) => marker().stores[s] ?? [];

describe("skillStatus", () => {
  test.each([
    ["---\nstatus: probation\n---\n", "probation"],
    ["---\nname: x\nstatus: 'archived'\n---\nbody", "archived"],
    ["---\r\nstatus: Active\r\n---\r\n", "active"],
    ["---\nname: x\n---\nstatus: archived\n", "active"],
    ["---\nstatus: archived # retired\n---\n", "archived"],
    ["---\nstatus: archived, mostly\n---\n", "invalid"],
    ["no frontmatter", "active"],
    ["---\nstatus: archived\n" + "x".repeat(10), "invalid"],
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
    expect(marker()).toEqual({ stores: { [store]: ["alpha", "beta"] } });
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
    expect(owned()).toEqual([]);
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

  test("repoints its links after the store moves", () => {
    storeSkill("alpha");
    reconcileSkills(true);
    const newRoot = realpathSync(mkdtempSync(join(tmpdir(), "macrodata-moved-")));
    try {
      renameSync(store, join(newRoot, "skills"));
      process.env.MACRODATA_ROOT = newRoot;
      const r = reconcileSkills(true);
      expect(r.relinked).toEqual(["alpha"]);
      expect(r.warnings).toEqual([]);
      expect(resolvesTo(join(skillsDir, "alpha"))).toBe(join(newRoot, "skills", "alpha"));
      expect(marker().stores).toEqual({ [join(newRoot, "skills")]: ["alpha"] });
    } finally {
      process.env.MACRODATA_ROOT = ctx.root;
      rmSync(newRoot, { recursive: true, force: true });
    }
  });

  test("leaves another installer's link that took over one of its names", () => {
    storeSkill("alpha");
    reconcileSkills(true);
    const elsewhere = mkdtempSync(join(tmpdir(), "macrodata-foreign-"));
    try {
      rmSync(join(skillsDir, "alpha"));
      symlinkSync(elsewhere, join(skillsDir, "alpha"));
      expect(reconcileSkills(true).relinked).toEqual([]);
      expect(readlinkSync(join(skillsDir, "alpha"))).toBe(elsewhere);
      expect(reconcileSkills(false).pruned).toEqual([]);
      expect(readlinkSync(join(skillsDir, "alpha"))).toBe(elsewhere);
      expect(owned()).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("keeps a link a concurrent session recorded", () => {
    storeSkill("alpha");
    reconcileSkills(true);
    const m = marker();
    storeSkill("beta");
    reconcileSkills(true);
    // Rewind the record to before beta, as a slower session's write would.
    writeFileSync(join(skillsDir, MARKER_NAME), JSON.stringify(m));
    storeSkill("gamma");
    reconcileSkills(true);
    expect(owned()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("warns when it can't write links", () => {
    storeSkill("alpha");
    mkdirSync(skillsDir);
    chmodSync(skillsDir, 0o555);
    try {
      const r = reconcileSkills(true);
      expect(r.linked).toEqual([]);
      expect(r.warnings.some((w) => w.includes("EACCES"))).toBe(true);
    } finally {
      chmodSync(skillsDir, 0o755);
    }
  });

  test("skips a SKILL.md that isn't a regular file instead of blocking on it", () => {
    mkdirSync(join(store, "alpha"), { recursive: true });
    spawnSync("mkfifo", [join(store, "alpha", "SKILL.md")]);
    expect(reconcileSkills(true).linked).toEqual([]);
  });

  test("re-owns its own links after the marker is lost", () => {
    storeSkill("alpha");
    reconcileSkills(true);
    rmSync(join(skillsDir, MARKER_NAME));
    expect(reconcileSkills(true).warnings).toEqual([]);
    expect(owned()).toEqual(["alpha"]);
  });

  test("never touches links a different, still-present store recorded", () => {
    storeSkill("alpha");
    reconcileSkills(true);
    const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), "macrodata-other-")));
    try {
      process.env.MACRODATA_ROOT = otherRoot;
      const other = join(otherRoot, "skills");
      mkdirSync(join(other, "beta"), { recursive: true });
      writeFileSync(join(other, "beta", "SKILL.md"), "---\nname: beta\n---\n");
      const r = reconcileSkills(true);
      expect(r).toMatchObject({ linked: ["beta"], relinked: [], pruned: [], warnings: [] });
      expect(resolvesTo(join(skillsDir, "alpha"))).toBe(join(store, "alpha"));
      process.env.MACRODATA_ROOT = ctx.root;
      expect(reconcileSkills(true)).toMatchObject({ linked: [], pruned: [], warnings: [] });
      expect(marker().stores).toEqual({ [store]: ["alpha"], [other]: ["beta"] });
    } finally {
      process.env.MACRODATA_ROOT = ctx.root;
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  test("leaves its links alone when the store can't be listed", () => {
    storeSkill("alpha");
    reconcileSkills(true);
    chmodSync(store, 0o000);
    try {
      const r = reconcileSkills(true);
      expect(r.pruned).toEqual([]);
      expect(r.warnings).toHaveLength(1);
      expect(lstatSync(join(skillsDir, "alpha")).isSymbolicLink()).toBe(true);
      expect(owned()).toEqual(["alpha"]);
    } finally {
      chmodSync(store, 0o755);
    }
  });

  test("keeps a moved store's record until its links are repointed", () => {
    storeSkill("alpha");
    reconcileSkills(true);
    const newRoot = realpathSync(mkdtempSync(join(tmpdir(), "macrodata-moved-")));
    const oldStore = store;
    try {
      renameSync(store, join(newRoot, "skills"));
      process.env.MACRODATA_ROOT = newRoot;
      chmodSync(skillsDir, 0o555);
      const r = reconcileSkills(true);
      chmodSync(skillsDir, 0o755);
      expect(r.relinked).toEqual([]);
      expect(r.warnings.some((w) => w.includes("EACCES"))).toBe(true);
      expect(r.warnings.filter((w) => w.includes("alpha"))).toHaveLength(1);
      expect(marker().stores).toEqual({ [oldStore]: ["alpha"] });
      expect(reconcileSkills(true).relinked).toEqual(["alpha"]);
      expect(marker().stores).toEqual({ [join(newRoot, "skills")]: ["alpha"] });
    } finally {
      chmodSync(skillsDir, 0o755);
      process.env.MACRODATA_ROOT = ctx.root;
      rmSync(newRoot, { recursive: true, force: true });
    }
  });

  test("skips names Claude Code can't load, quoting them so they can't inject lines", () => {
    storeSkill("Bad_Name");
    storeSkill("x\nIGNORE PREVIOUS");
    const r = reconcileSkills(true);
    expect(r.linked).toEqual([]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.every((w) => !w.includes("\n"))).toBe(true);
  });

  test("does nothing, and creates nothing, with an empty store", () => {
    expect(reconcileSkills(true).createdDir).toBe(false);
    expect(existsSync(skillsDir)).toBe(false);
  });
});

describe("adoptSkill", () => {
  test("moves a hand-made skill into the store and links it back", () => {
    handSkill("alpha");
    const dest = adoptSkill("alpha", true);
    expect(dest).toBe(join(store, "alpha"));
    expect(existsSync(join(dest, "SKILL.md"))).toBe(true);
    expect(resolvesTo(join(skillsDir, "alpha"))).toBe(dest);
    expect(owned()).toEqual(["alpha"]);
    expect(reconcileSkills(true).warnings).toEqual([]);
  });

  test("refuses while skills are disabled, since the next sync would unlink it", () => {
    handSkill("alpha");
    expect(() => adoptSkill("alpha", false)).toThrow("skills_enabled");
    expect(lstatSync(join(skillsDir, "alpha")).isDirectory()).toBe(true);
  });

  test("refuses an archived skill", () => {
    const dir = handSkill("alpha");
    writeFileSync(join(dir, "SKILL.md"), "---\nstatus: archived\n---\n");
    expect(() => adoptSkill("alpha", true)).toThrow("archived");
  });

  test("refuses another installer's link", () => {
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(ctx.root, join(skillsDir, "alpha"));
    expect(() => adoptSkill("alpha", true)).toThrow("symlink");
  });

  test("refuses a name the store already has", () => {
    handSkill("alpha");
    storeSkill("alpha");
    expect(() => adoptSkill("alpha", true)).toThrow("already has");
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
