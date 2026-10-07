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
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
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

/**
 * The `status:` field of a SKILL.md frontmatter block; absent means `active`.
 * A status line that doesn't parse reads as `invalid`, which isn't linked.
 */
export function skillStatus(skillMd: string): string {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!fm) return "active";
  const line = /^status:(.*)$/m.exec(fm[1]);
  if (!line) return "active";
  const v = /^\s*(["']?)([A-Za-z-]+)\1\s*(#.*)?\r?$/.exec(line[1]);
  return v ? v[2].toLowerCase() : "invalid";
}

export interface Marker {
  /** The store the links point into when they were written. */
  store: string;
  links: string[];
}

interface OwnedLinks {
  /** Stores an owned link may point into: the current one and the marker's. */
  stores: string[];
  names: Set<string>;
}

function readMarker(skillsDir: string, store: string): OwnedLinks {
  const owned: OwnedLinks = { stores: [store], names: new Set() };
  try {
    const m = JSON.parse(readFileSync(join(skillsDir, MARKER_NAME), "utf-8")) as Partial<Marker>;
    if (typeof m.store === "string" && m.store !== store) owned.stores.push(m.store);
    if (Array.isArray(m.links)) {
      for (const n of m.links) if (typeof n === "string" && SKILL_NAME.test(n)) owned.names.add(n);
    }
  } catch {
    // Absent or unreadable: nothing is owned until a link proves otherwise.
  }
  return owned;
}

/**
 * Whether the link at `path` is ours: a recorded name whose link points into a
 * store the marker knows. A recorded name alone isn't enough, since the user can
 * replace our link with another installer's under the same name.
 */
function isOwnedLink(owned: OwnedLinks, name: string, path: string): boolean {
  const target = linkTarget(path);
  return (
    target !== undefined &&
    owned.names.has(name) &&
    owned.stores.some((s) => target === join(s, name))
  );
}

/**
 * Persist `links` as the owned set. Re-reads the marker first: a concurrent
 * session may have linked a skill this one never saw, and dropping it from the
 * record would leak its link once the skill is archived.
 */
function writeMarker(
  skillsDir: string,
  store: string,
  links: Set<string>,
  dropped: Set<string>,
): void {
  const merged = new Set(links);
  for (const name of readMarker(skillsDir, store).names) {
    if (!dropped.has(name) && linkTarget(join(skillsDir, name)) === join(store, name))
      merged.add(name);
  }
  const path = join(skillsDir, MARKER_NAME);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ store, links: [...merged].sort() } satisfies Marker, null, 2) + "\n",
  );
  renameSync(tmp, path);
}

/** Frontmatter lives at the top; a bigger read only buys a slower session start. */
const SKILL_HEAD_BYTES = 64 * 1024;

/** The head of a SKILL.md that is a regular file, or undefined. A FIFO or device would block or never end. */
function readSkillHead(path: string): string | undefined {
  let fd: number | undefined;
  try {
    if (!statSync(path).isFile()) return undefined;
    fd = openSync(path, "r");
    const buf = Buffer.alloc(SKILL_HEAD_BYTES);
    return buf.toString("utf-8", 0, readSync(fd, buf, 0, SKILL_HEAD_BYTES, 0));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A store-supplied name, safe to print into model context. */
function printable(name: string): string {
  return JSON.stringify(name.length > 80 ? `${name.slice(0, 80)}…` : name);
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
    const md = readSkillHead(join(dir, "SKILL.md"));
    if (md === undefined) continue;
    if (!SKILL_NAME.test(name)) {
      warnings.push(
        `skills/${printable(name)}: not a valid skill name (lowercase letters, digits, hyphens); not linked`,
      );
      continue;
    }
    const status = skillStatus(md);
    if (status === "invalid") warnings.push(`skills/${name}: unreadable status line; not linked`);
    if (LIVE_STATUSES.has(status)) desired.set(name, dir);
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

function errCode(e: unknown): string {
  return (e as NodeJS.ErrnoException).code ?? String(e);
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
 * repoint owned links that drifted (a moved store), remove owned links whose
 * skill is archived, gone, or (with `enabled` false) all of them. Never touches
 * a link it doesn't own.
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
  const dropped = new Set<string>();

  for (const [name, dir] of desired) {
    const path = join(skillsDir, name);
    const want = relative(realSkillsDir, dir);
    if (linkTarget(path) === dir) {
      kept.add(name);
      continue;
    }
    if (!exists(path)) {
      if (placeLink(want, path, dir, result.warnings)) {
        result.linked.push(name);
        kept.add(name);
      }
      continue;
    }
    if (isOwnedLink(owned, name, path)) {
      if (removeLink(path, result.warnings) && placeLink(want, path, dir, result.warnings)) {
        result.relinked.push(name);
        kept.add(name);
      }
      continue;
    }
    dropped.add(name);
    result.warnings.push(
      `${path} already exists and isn't macrodata's; store skill "${name}" not linked`,
    );
  }

  for (const name of owned.names) {
    if (kept.has(name)) continue;
    dropped.add(name);
    const path = join(skillsDir, name);
    if (isOwnedLink(owned, name, path) && removeLink(path, result.warnings))
      result.pruned.push(name);
  }

  if (kept.size > 0 || owned.names.size > 0) {
    try {
      writeMarker(skillsDir, store, kept, dropped);
    } catch (e) {
      result.warnings.push(
        `couldn't record owned links in ${join(skillsDir, MARKER_NAME)} (${errCode(e)})`,
      );
    }
  }
  return result;
}

/**
 * Create `path` → `want`. A concurrent session may win the race; that counts as
 * success only if its link resolves to the same skill.
 */
function placeLink(want: string, path: string, dir: string, warnings: string[]): boolean {
  try {
    symlinkSync(want, path);
    return true;
  } catch (e) {
    if (errCode(e) === "EEXIST" && linkTarget(path) === dir) return true;
    warnings.push(`couldn't link ${path} (${errCode(e)})`);
    return false;
  }
}

/** Unlink `path`; a concurrent session removing it first counts as success. */
function removeLink(path: string, warnings: string[]): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (e) {
    if (errCode(e) === "ENOENT") return true;
    warnings.push(`couldn't unlink ${path} (${errCode(e)})`);
    return false;
  }
}

/**
 * Move a hand-made skill from `<claude config>/skills/<name>` into the store and
 * link it back. Refuses while skills are disabled (the next sync would unlink
 * it), symlinks (another installer's), and names the store already has.
 */
export function adoptSkill(name: string, enabled = skillsEnabled()): string {
  if (!SKILL_NAME.test(name)) throw new Error(`${printable(name)} is not a valid skill name`);
  if (!enabled) {
    throw new Error(
      "turn on the Memory skills option (skills_enabled) first, or the next session start unlinks it",
    );
  }
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
  const md = st.isDirectory() ? readSkillHead(join(src, "SKILL.md")) : undefined;
  if (md === undefined) throw new Error(`${src} has no SKILL.md`);
  if (!LIVE_STATUSES.has(skillStatus(md))) {
    throw new Error(`${src}/SKILL.md has status "${skillStatus(md)}", which isn't linked`);
  }
  if (exists(dest)) throw new Error(`the store already has ${dest}`);
  mkdirSync(store, { recursive: true });
  let moved = false;
  try {
    renameSync(src, dest);
    moved = true;
  } catch (e) {
    // EXDEV: store and config dir on different volumes.
    if (errCode(e) !== "EXDEV") throw e;
  }
  if (!moved) {
    cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
    try {
      rmSync(src, { recursive: true });
    } catch (e) {
      rmSync(dest, { recursive: true, force: true });
      throw new Error(
        `couldn't remove ${src} after copying (${errCode(e)}); store copy removed, nothing changed`,
      );
    }
  }
  try {
    symlinkSync(relative(realpathSync(skillsDir), dest), src);
  } catch (e) {
    throw new Error(
      `moved to ${dest} but couldn't link it back (${errCode(e)}); the next session start links it`,
    );
  }
  const owned = readMarker(skillsDir, store);
  owned.names.add(name);
  writeMarker(skillsDir, store, owned.names, new Set());
  return dest;
}
