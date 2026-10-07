/**
 * Memory-store skills: `<root>/skills/<name>/SKILL.md`, presented to Claude Code
 * as per-skill symlinks in `<claude config>/skills/`.
 *
 * The store is the truth and the links are derived: reconcileSkills() is
 * idempotent and rebuilds the link set from the store every SessionStart. Claude
 * Code discovers only one level under its skills dir, so the store is flat and
 * each skill gets its own link; a link to the store dir itself would not load.
 *
 * Ownership is recorded in a marker file beside the links, never inferred from a
 * name alone: the same dir holds hand-made skills and other installers' links
 * (`npx skills`), and a name collision with either is skipped with a warning
 * rather than overwritten.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join, relative, resolve } from "path";
import { getClaudeConfigDir, getStateRoot, livePluginOption } from "./config.ts";

export const MARKER_NAME = ".macrodata-skills.json";

/** Claude Code's skill-name shape: lowercase letters, digits, hyphens. */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Statuses whose skills are linked; `archived` (and anything unknown) is not. */
const LIVE_STATUSES = new Set(["active", "probation"]);

export function getSkillsStoreDir(): string {
  return join(getStateRoot(), "skills");
}

export function getClaudeSkillsDir(): string {
  return join(getClaudeConfigDir(), "skills");
}

/**
 * Whether the store's skills are linked into Claude Code: the plugin's
 * skills_enabled option read live, else Claude Code's exported copy. Off by
 * default — it writes into a dir the user also manages by hand.
 */
export function skillsEnabled(): boolean {
  const live = livePluginOption("skills_enabled");
  if (live !== undefined) return live;
  const word = (process.env.CLAUDE_PLUGIN_OPTION_SKILLS_ENABLED ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(word);
}

/** The `status:` field of a SKILL.md frontmatter block; absent means `active`. */
export function skillStatus(skillMd: string): string {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!fm) return "active";
  const m = /^status:\s*["']?([A-Za-z-]+)["']?\s*$/m.exec(fm[1]);
  return m ? m[1].toLowerCase() : "active";
}

export interface Marker {
  /** The store the links point into; a marker for another store owns nothing here. */
  store: string;
  links: string[];
}

function readMarker(skillsDir: string, store: string): Set<string> {
  try {
    const m = JSON.parse(readFileSync(join(skillsDir, MARKER_NAME), "utf-8")) as Partial<Marker>;
    if (m.store === store && Array.isArray(m.links)) {
      return new Set(
        m.links.filter((n): n is string => typeof n === "string" && SKILL_NAME.test(n)),
      );
    }
  } catch {
    // Absent or unreadable: nothing is owned until a link proves otherwise.
  }
  return new Set();
}

function writeMarker(skillsDir: string, marker: Marker): void {
  const path = join(skillsDir, MARKER_NAME);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(marker, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Store skills that should be linked, by name. Invalid names are reported, not linked. */
function desiredSkills(store: string, warnings: string[]): Map<string, string> {
  const desired = new Map<string, string>();
  let entries: string[];
  try {
    entries = readdirSync(store);
  } catch {
    return desired;
  }
  for (const name of entries.sort()) {
    if (name.startsWith(".")) continue;
    const dir = join(store, name);
    let md: string;
    try {
      md = readFileSync(join(dir, "SKILL.md"), "utf-8");
    } catch {
      continue;
    }
    if (!SKILL_NAME.test(name)) {
      warnings.push(
        `skills/${name}: not a valid skill name (lowercase letters, digits, hyphens); not linked`,
      );
      continue;
    }
    if (LIVE_STATUSES.has(skillStatus(md))) desired.set(name, dir);
  }
  return desired;
}

/** Where a symlink at `path` resolves, or undefined if `path` isn't a symlink. */
function linkTarget(path: string): string | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) return undefined;
    return resolve(realpathSync(dirname(path)), readlinkSync(path));
  } catch {
    return undefined;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export interface ReconcileResult {
  linked: string[];
  relinked: string[];
  pruned: string[];
  warnings: string[];
  /** The skills dir didn't exist before this run, so Claude Code isn't watching it yet. */
  createdDir: boolean;
}

/**
 * Bring `<claude config>/skills/` in line with the store: link live skills,
 * repoint owned links that drifted, remove owned links whose skill is archived,
 * gone, or (with `enabled` false) all of them. Never touches a name it doesn't
 * own.
 */
export function reconcileSkills(enabled = skillsEnabled()): ReconcileResult {
  const result: ReconcileResult = {
    linked: [],
    relinked: [],
    pruned: [],
    warnings: [],
    createdDir: false,
  };
  const store = getSkillsStoreDir();
  const skillsDir = getClaudeSkillsDir();
  const desired = enabled ? desiredSkills(store, result.warnings) : new Map<string, string>();

  if (!existsSync(skillsDir)) {
    if (desired.size === 0) return result;
    mkdirSync(skillsDir, { recursive: true });
    result.createdDir = true;
  }
  // Relative links survive a moved home dir; computed from the resolved dir so
  // a symlinked config dir doesn't skew the `..` count.
  const realSkillsDir = realpathSync(skillsDir);
  const owned = readMarker(skillsDir, store);
  const kept = new Set<string>();

  for (const [name, dir] of desired) {
    const path = join(skillsDir, name);
    const want = relative(realSkillsDir, dir);
    const target = linkTarget(path);
    if (target === dir) {
      kept.add(name);
      continue;
    }
    if (!exists(path)) {
      if (placeLink(want, path, dir)) {
        result.linked.push(name);
        kept.add(name);
      }
      continue;
    }
    if (target !== undefined && owned.has(name)) {
      unlinkSync(path);
      if (placeLink(want, path, dir)) {
        result.relinked.push(name);
        kept.add(name);
      }
      continue;
    }
    result.warnings.push(
      `${path} already exists and isn't macrodata's; store skill "${name}" not linked`,
    );
  }

  for (const name of owned) {
    if (kept.has(name)) continue;
    const path = join(skillsDir, name);
    // Only a link is ours to remove: a real dir under an owned name was put
    // there by someone else after we let go of the name.
    if (linkTarget(path) !== undefined) {
      unlinkSync(path);
      result.pruned.push(name);
    }
  }

  if (kept.size > 0 || owned.size > 0) {
    writeMarker(skillsDir, { store, links: [...kept].sort() });
  }
  return result;
}

/**
 * Create `path` → `want`. A concurrent session may win the race; that counts as
 * success only if its link resolves to the same skill.
 */
function placeLink(want: string, path: string, dir: string): boolean {
  try {
    symlinkSync(want, path);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EEXIST" && linkTarget(path) === dir;
  }
}

/**
 * Move a hand-made skill from `<claude config>/skills/<name>` into the store and
 * link it back. Refuses symlinks (another installer's) and names the store
 * already has.
 */
export function adoptSkill(name: string): string {
  if (!SKILL_NAME.test(name)) throw new Error(`"${name}" is not a valid skill name`);
  const skillsDir = getClaudeSkillsDir();
  const src = join(skillsDir, name);
  const store = getSkillsStoreDir();
  const dest = join(store, name);
  let st;
  try {
    st = lstatSync(src);
  } catch {
    throw new Error(`no skill at ${src}`);
  }
  if (st.isSymbolicLink()) throw new Error(`${src} is a symlink; adopt its target instead`);
  if (!st.isDirectory() || !existsSync(join(src, "SKILL.md")))
    throw new Error(`${src} has no SKILL.md`);
  if (exists(dest)) throw new Error(`the store already has ${dest}`);
  mkdirSync(store, { recursive: true });
  try {
    renameSync(src, dest);
  } catch (e) {
    // EXDEV: store and config dir on different volumes.
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
    rmSync(src, { recursive: true });
  }
  const owned = readMarker(skillsDir, store);
  symlinkSync(relative(realpathSync(skillsDir), dest), src);
  owned.add(name);
  writeMarker(skillsDir, { store, links: [...owned].sort() });
  return dest;
}
