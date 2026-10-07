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
 * name alone, and holds only while the link still points into the recording
 * store: the same dir holds hand-made skills and other installers' links
 * (`npx skills`), and a name collision with either is skipped with a warning
 * rather than overwritten.
 */

import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
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
 * The `status:` field of a SKILL.md frontmatter block; absent or empty means
 * `active`. Frontmatter that isn't a YAML mapping, a fence that never closes
 * within what was read, or a status that isn't a single word is `invalid`,
 * which isn't linked.
 */
export function skillStatus(skillMd: string): string {
  if (!/^\uFEFF?---\r?\n/.test(skillMd)) return "active";
  const fm = /^\uFEFF?---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(skillMd);
  if (!fm) return "invalid";
  let data: unknown;
  try {
    data = Bun.YAML.parse(fm[1] ?? "");
  } catch {
    return "invalid";
  }
  if (data == null) return "active";
  if (!isRecord(data)) return "invalid";
  const status = data.status;
  if (status == null) return "active";
  return typeof status === "string" && /^[A-Za-z-]+$/.test(status.trim())
    ? status.trim().toLowerCase()
    : "invalid";
}

/**
 * `.macrodata-skills.json`: the link names each store made. Keyed by store
 * because two roots can share one config dir (a test shell with its own
 * MACRODATA_ROOT, a root that briefly resolves elsewhere), and neither may
 * prune the other's links.
 */
export interface Marker {
  stores: Record<string, string[]>;
}

function readMarker(skillsDir: string): Map<string, Set<string>> {
  const stores = new Map<string, Set<string>>();
  try {
    const m = JSON.parse(readFileSync(join(skillsDir, MARKER_NAME), "utf-8")) as Partial<Marker>;
    if (isRecord(m.stores)) {
      for (const [store, links] of Object.entries(m.stores)) {
        if (!Array.isArray(links)) continue;
        const names = links.filter((n): n is string => typeof n === "string" && SKILL_NAME.test(n));
        stores.set(store, new Set(names));
      }
    }
  } catch {
    // Absent or unreadable: nothing is owned until a link proves otherwise.
  }
  return stores;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Recorded stores that no longer exist: their links are this store's to adopt.
 * Only ENOENT counts; an unmounted or unreadable store is still someone's.
 */
function goneStores(marker: Map<string, Set<string>>, store: string): string[] {
  return [...marker.keys()].filter((s) => {
    if (s === store) return false;
    try {
      lstatSync(s);
      return false;
    } catch (e) {
      return errCode(e) === "ENOENT";
    }
  });
}

/**
 * The store whose link `path` is, if that store recorded `name` and the link
 * still points into it; this store, or a recorded store that has gone away.
 */
function owningStore(
  marker: Map<string, Set<string>>,
  candidates: string[],
  name: string,
  path: string,
): string | undefined {
  const target = linkTarget(path);
  if (target === undefined) return undefined;
  return candidates.find((s) => marker.get(s)?.has(name) && target === join(s, name));
}

/**
 * Record `kept` as this store's links and drop gone stores' names whose links
 * no longer point into them. Re-reads the marker first: a concurrent session
 * (or another root) may have recorded links this one never saw.
 */
function writeMarker(skillsDir: string, store: string, kept: Set<string>): void {
  const current = readMarker(skillsDir);
  const mine = new Set(kept);
  for (const name of current.get(store) ?? []) {
    if (linkTarget(join(skillsDir, name)) === join(store, name)) mine.add(name);
  }
  current.set(store, mine);
  for (const gone of goneStores(current, store)) {
    const left = [...(current.get(gone) ?? [])].filter(
      (n) => linkTarget(join(skillsDir, n)) === join(gone, n),
    );
    if (left.length) current.set(gone, new Set(left));
    else current.delete(gone);
  }
  const out: Marker = { stores: {} };
  for (const [s, names] of current) if (names.size) out.stores[s] = [...names].sort();
  const path = join(skillsDir, MARKER_NAME);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Frontmatter lives at the top; a bigger read only buys a slower session start. */
const SKILL_HEAD_BYTES = 64 * 1024;

/**
 * The head of a SKILL.md that is a regular file, or undefined. Opened
 * non-blocking and checked on the descriptor, so a FIFO swapped in after a
 * path check can't hang session start.
 */
function readSkillHead(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return undefined;
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

/**
 * Store skills that should be linked, by name; undefined when the store can't
 * be listed, which must not read as "empty" and unlink everything.
 */
function desiredSkills(store: string, warnings: string[]): Map<string, string> | undefined {
  const desired = new Map<string, string>();
  let entries: string[];
  try {
    entries = readdirSync(store);
  } catch (e) {
    if (errCode(e) === "ENOENT") return desired;
    warnings.push(`couldn't list ${store} (${errCode(e)}); links left as they are`);
    return undefined;
  }
  for (const name of entries.sort()) {
    if (name.startsWith(".")) continue;
    const dir = join(store, name);
    // A store entry that is itself a link would let whoever controls its
    // target supply a skill.
    try {
      if (!lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const md = readSkillHead(join(dir, "SKILL.md"));
    if (md === undefined) continue;
    if (!SKILL_NAME.test(name)) {
      warnings.push(
        `skills/${printable(name)}: not a valid skill name (lowercase letters, digits, hyphens); not linked`,
      );
      continue;
    }
    const status = skillStatus(md);
    if (status === "invalid") warnings.push(`skills/${name}: unreadable status; not linked`);
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
 * repoint links into a store that has gone away (a moved root), and remove this
 * store's links whose skill is archived, gone, or (with `enabled` false) all of
 * them. Never touches a link another store or installer owns.
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
  if (desired === undefined) return result;

  if (!existsSync(skillsDir)) {
    if (desired.size === 0) return result;
    mkdirSync(skillsDir, { recursive: true });
    result.createdDir = true;
  }
  // Relative links survive a moved home dir; computed from the resolved dir so
  // a symlinked config dir doesn't skew the `..` count.
  const realSkillsDir = realpathSync(skillsDir);
  const marker = readMarker(skillsDir);
  const candidates = [store, ...goneStores(marker, store)];
  const kept = new Set<string>();
  const handled = new Set<string>();
  const ours = (name: string, path: string) =>
    owningStore(marker, candidates, name, path) !== undefined ||
    linkTarget(path) === join(store, name);

  for (const [name, dir] of desired) {
    handled.add(name);
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
    if (ours(name, path)) {
      if (removeLink(path, result.warnings) && placeLink(want, path, dir, result.warnings)) {
        result.relinked.push(name);
        kept.add(name);
      }
      continue;
    }
    // A concurrent session may have linked it since the check above.
    if (linkTarget(path) === dir) {
      kept.add(name);
      continue;
    }
    result.warnings.push(
      `${path} already exists and isn't macrodata's; store skill "${name}" not linked`,
    );
  }

  // Prune by marker and by target: a link into this store is ours even if a
  // racing session's marker write lost its name.
  const prunable = new Set(candidates.flatMap((s) => [...(marker.get(s) ?? [])]));
  for (const name of readdirSync(skillsDir)) if (SKILL_NAME.test(name)) prunable.add(name);
  for (const name of [...prunable].sort()) {
    if (handled.has(name)) continue;
    const path = join(skillsDir, name);
    if (ours(name, path) && removeLink(path, result.warnings)) result.pruned.push(name);
  }

  if (kept.size > 0 || marker.size > 0) {
    try {
      writeMarker(skillsDir, store, kept);
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
  const status = skillStatus(md);
  if (!LIVE_STATUSES.has(status)) {
    throw new Error(`${src}/SKILL.md has status "${status}", which isn't linked`);
  }
  if (exists(dest)) throw new Error(`the store already has ${dest}`);
  mkdirSync(store, { recursive: true });
  try {
    renameSync(src, dest);
  } catch (e) {
    // EXDEV: store and config dir on different volumes.
    if (errCode(e) !== "EXDEV") throw e;
    try {
      cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
    } catch (err) {
      rmSync(dest, { recursive: true, force: true });
      throw new Error(`couldn't copy ${src} into the store (${errCode(err)}); nothing changed`);
    }
    // rmSync deletes child by child, so a failure leaves src partly gone and
    // dest the only whole copy; it must survive.
    try {
      rmSync(src, { recursive: true });
    } catch (err) {
      throw new Error(
        `copied to ${dest}, but couldn't fully remove ${src} (${errCode(err)}); remove it by hand and the next session start links the store copy`,
      );
    }
  }
  try {
    symlinkSync(relative(realpathSync(skillsDir), dest), src);
  } catch (e) {
    // A session starting mid-adopt links the store copy itself.
    if (errCode(e) === "EEXIST" && linkTarget(src) === dest) return dest;
    throw new Error(
      `moved to ${dest} but couldn't link it back (${errCode(e)}); the next session start links it`,
    );
  }
  try {
    writeMarker(skillsDir, store, new Set([name]));
  } catch {
    // The link points into the store, so the next sync re-owns it.
  }
  return dest;
}
