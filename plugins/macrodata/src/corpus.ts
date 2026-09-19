/**
 * Canonical corpus projection.
 *
 * One deterministic projection of the indexed memory corpus — journal JSONL
 * files and entity Markdown files — shared by every recall consumer
 * (MiniLM indexer, Qwen ambient-recall indexer) so both indexes hold the same
 * units with the same ids, sources, and omission behavior.
 *
 * Source identity: a source is its path relative to the journal dir or the
 * entities dir, POSIX spelling, i.e. exactly the `source` field the indexers
 * have always stored for immediate files. A nested entity file at
 * `entities/people/team/bob.md` is source `people/team/bob.md` and type
 * `people`; its ids carry the full category-relative stem so they cannot
 * collide with an immediate sibling of the same name.
 *
 * Nested / dot-directory policy: scanning walks entity categories recursively.
 * Any path segment starting with "." — a directory (.obsidian, .trash, .git)
 * or a file (.hidden.md) — is skipped, at any depth. Journal scanning follows
 * the same rule. State files and index state are deliberately not part of the
 * indexed corpus.
 *
 * Symlink policy: a personal memory tool does not follow links. Any symlink
 * dirent encountered while walking — whether it resolves to a file or a
 * directory — is never opened, never recursed into, and never indexed. It is
 * recorded as an explicit `incomplete` failure snapshot ("symlink excluded
 * from corpus") so a symlinked docs folder cannot silently vanish, and a
 * symlink cannot be used to read arbitrary files (e.g. `~/.ssh/id_rsa`)
 * outside the store into a searchable index.
 *
 * Failure semantics: a source that cannot be read (or read STABLY — a listing
 * that vanished before read, a transient EACCES) is reported as `incomplete`
 * with an error on its snapshot, and the scan as a whole reports
 * `complete: false`. Valid material is never discarded: partial journal files
 * keep their well-formed lines while still reporting incomplete. Callers must
 * treat an incomplete scan as non-authoritative — in particular they must not
 * reconcile (prune) an index against one, because unchanged sources do not
 * change: a missing item list would read as deletions.
 */

import { readFileSync, readdirSync, existsSync, lstatSync } from "fs";
import { join, relative, sep } from "path";
import { getJournalDir, getEntitiesDir } from "./config.js";

export type MemoryItemType = string;

export interface MemoryItem {
  id: string;
  type: MemoryItemType;
  content: string;
  source: string;
  section?: string;
  timestamp?: string;
}

/** Where a snapshot came from, and what parse rules produced it. */
export type SourceKind = "journal" | "entity";

/**
 * `ok`   — read succeeded; items are the authoritative projection.
 * `incomplete` — the source could not be fully read/parsed; items (if any)
 * are partial. Never tape over an incomplete source with an empty snapshot
 * that reads as "this source is authoritatively empty".
 */
export type SourceStatus = "ok" | "incomplete";

export interface SourceSnapshot {
  /** Normalized source identity: path relative to journal/docs root, POSIX. */
  source: string;
  kind: SourceKind;
  /** Item type: "journal", or the entity category (first path segment). */
  type: MemoryItemType;
  status: SourceStatus;
  items: MemoryItem[];
  /** Present when status is "incomplete": why (read error, malformed count). */
  error?: string;
}

export interface CorpusProjection {
  /** All items from readable sources, scan order. */
  items: MemoryItem[];
  /** Every source seen during the scan, readable and not. */
  snapshots: SourceSnapshot[];
  /** True when every source read cleanly — only then is `items` authoritative. */
  complete: boolean;
  /** The subsets of `snapshots` with status "incomplete". */
  failures: SourceSnapshot[];
}

/** POSIX-normalize and root the given identity against its directory. */
function relativeSource(root: string, absPath: string): string {
  const rel = relative(root, absPath);
  return sep === "\\" ? rel.split("\\").join("/") : rel;
}

/** True if any segment of the path starts with "." (dot-dir OR dot-file). */
export function isDotPath(relPath: string): boolean {
  return relPath.split("/").some((seg) => seg.startsWith("."));
}

// ---------------------------------------------------------------------------
// Journal projection
// ---------------------------------------------------------------------------

/**
 * Parse one journal JSONL file into a SourceSnapshot.
 *
 * Line order and ids (`journal-<source>-<lineIndex>`) are the existing index
 * contract. A malformed line is counted and reported, not dropped silently and
 * not allowed to discard its valid neighbors.
 */
export function projectJournalFile(absPath: string, journalDir = getJournalDir()): SourceSnapshot {
  const kind: SourceKind = "journal";
  const snapshot: SourceSnapshot = {
    source: relativeSource(journalDir, absPath),
    kind,
    type: "journal",
    status: "ok",
    items: [],
  };

  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch (err) {
    return { ...snapshot, status: "incomplete", error: `read failed: ${String(err)}` };
  }

  const lines = raw.trim().split("\n").filter(Boolean);
  let malformedLines = 0;
  for (let i = 0; i < lines.length; i++) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      malformedLines++;
      continue;
    }
    // A parse success is not a valid entry: `"5"`, `null`, `[1,2,3]` all
    // parse cleanly but are not journal shape. Require a non-null object
    // with string topic and content, exactly like a parse failure otherwise.
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof (entry as Record<string, unknown>).topic !== "string" ||
      typeof (entry as Record<string, unknown>).content !== "string"
    ) {
      malformedLines++;
      continue;
    }
    const record = entry as { topic: string; content: string; timestamp?: unknown };
    snapshot.items.push({
      id: `journal-${snapshot.source}-${i}`,
      type: "journal",
      content: `[${record.topic}] ${record.content}`,
      source: snapshot.source,
      timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
    });
  }

  if (malformedLines > 0) {
    return {
      ...snapshot,
      status: "incomplete",
      error: `malformed: ${malformedLines} of ${lines.length} lines unparsable`,
    };
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Entity projection
// ---------------------------------------------------------------------------

/**
 * Parse one entity Markdown file into a SourceSnapshot.
 *
 * Preamble + `##`-section splitting, content formatting, and the
 * `<type>-<name>-preamble` id shape are the existing index contract. The
 * category (type) is the first segment under the entities dir; nested files
 * keep their full category-relative stem in both `source` and their ids.
 * Files outside `entities/` or under a dot path are errors, not silences.
 */
export function projectEntityFile(absPath: string, entitiesDir = getEntitiesDir()): SourceSnapshot {
  const kind: SourceKind = "entity";
  const error = (message: string): SourceSnapshot => ({
    source: relativeSource(entitiesDir, absPath),
    kind,
    type: entityTypeOf(entitiesDir, absPath),
    status: "incomplete",
    items: [],
    error: message,
  });

  // This is the seam the daemon's live-watch reindex (indexEntityFile) calls
  // directly on one path, not through listSources' walk. lstat, not stat,
  // so the check inspects the link itself rather than following it.
  try {
    if (lstatSync(absPath).isSymbolicLink()) {
      return error("symlink excluded from corpus");
    }
  } catch (err) {
    return error(`read failed: ${String(err)}`);
  }

  if (!absPath.startsWith(entitiesDir + sep) && absPath !== entitiesDir) {
    return error(`not an entity path under ${entitiesDir}`);
  }

  const source = relativeSource(entitiesDir, absPath);
  if (isDotPath(source)) {
    return error("dot path excluded from the corpus");
  }

  const segments = source.split("/");
  if (segments.length < 2) {
    return error("entity file must live under a category folder");
  }
  const type = segments[0] as MemoryItemType;
  const filename = segments[segments.length - 1];
  if (!filename.endsWith(".md")) {
    return error(`not markdown: ${filename}`);
  }

  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch (err) {
    return error(`read failed: ${String(err)}`);
  }

  const items: MemoryItem[] = [];
  // Category-relative stem: "alice" for people/alice.md, "team/bob" for
  // people/team/bob.md, so a nested file's id cannot collide with an
  // immediate sibling of the same name.
  const stem = segments.slice(1).join("/").slice(0, -".md".length);
  const stemId = `${type}-${stem}`;
  const sections = content.split(/^## /m);

  if (sections[0].trim()) {
    items.push({
      id: `${stemId}-preamble`,
      type,
      content: sections[0].trim(),
      source,
      section: "preamble",
    });
  }

  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    const firstLine = section.split("\n")[0];
    const sectionTitle = firstLine.trim();
    const sectionContent = section.slice(firstLine.length).trim();
    if (sectionContent) {
      items.push({
        id: `${stemId}-${i}`,
        type,
        content: `## ${sectionTitle}\n\n${sectionContent}`,
        source,
        section: sectionTitle,
      });
    }
  }

  return { source, kind, type, status: "ok", items };
}

function entityTypeOf(entitiesDir: string, absPath: string): MemoryItemType {
  const rel = relativeSource(entitiesDir, absPath);
  const segments = rel.split("/");
  // A category-less path (a file directly under entitiesDir, or the
  // entitiesDir itself) has no first segment that is a real category — the
  // sole segment IS the filename. Reporting the filename as `type` would
  // produce a bogus category (e.g. "note.md") that matches no category
  // filter; "entities" is the same convention failureType uses for the
  // entities-root case.
  return segments.length < 2 ? ("entities" as MemoryItemType) : (segments[0] as MemoryItemType);
}

// ---------------------------------------------------------------------------
// Corpus scan
// ---------------------------------------------------------------------------

/**
 * One directory-listing result: the matching files found, plus an explicit
 * failure snapshot for every directory whose listing could not be taken.
 */
export interface Listing {
  files: string[];
  failures: SourceSnapshot[];
}

/**
 * The `type` a listing-level failure (a directory that could not be listed,
 * or a symlink dirent) is filed under. Journal failures are always "journal".
 * Entity failures take their category from the source's first path segment;
 * a failure at the entities root itself has source "." and no category
 * segment, so it is filed under "entities".
 */
function failureType(kind: SourceKind, source: string): MemoryItemType {
  if (kind === "journal") return "journal";
  if (source === ".") return "entities";
  return source.split("/")[0] as MemoryItemType;
}

/**
 * Build the failure snapshot scanCorpus records for a directory that could
 * not be listed.
 */
function dirFailure(root: string, absDir: string, kind: SourceKind, err: string): SourceSnapshot {
  const rel = relativeSource(root, absDir);
  const source = rel || ".";
  return {
    source,
    kind,
    type: failureType(kind, source),
    status: "incomplete",
    items: [],
    error: `listing failed: ${err}`,
  };
}

/**
 * Build the failure snapshot scanCorpus records for a symlink dirent — file
 * or directory, it makes no difference: a personal memory tool never follows
 * links. Recording it (rather than silently skipping) means a symlinked docs
 * folder does not just vanish from view, and closes the arbitrary-file-read
 * path a followed symlink would otherwise open into a searchable index.
 */
function symlinkFailure(root: string, absPath: string, kind: SourceKind): SourceSnapshot {
  const rel = relativeSource(root, absPath);
  const source = rel || ".";
  return {
    source,
    kind,
    type: failureType(kind, source),
    status: "incomplete",
    items: [],
    error: "symlink excluded from corpus",
  };
}

/**
 * Recursively list files under `root` matching `ext`.
 *
 * A directory whose readdir fails (existing root, or any nested subtree) is an
 * incomplete listing, not a silent omission: it produces a failure snapshot
 * via `failureOf` so the scan caller can force `complete: false`. A missing
 * root is valid and empty — there is nothing to index yet. Dot segments are
 * the exclusion policy at every level, regardless of kind — dirs AND files.
 *
 * A symlink — file or directory — is never followed, even when it resolves
 * inside the corpus root: it is excluded and reported via `symlinkFailureOf`,
 * the same way a listing failure is reported, so it neither silently
 * disappears nor is read. The decision is made from an explicit `lstatSync`
 * per dirent, not from `dirent.isSymbolicLink()` — Node's own docs note the
 * dirent type bits from `readdirSync(..., { withFileTypes: true })` can be
 * unreliable on some filesystems (DT_UNKNOWN), and an lstat is the documented
 * fix when the symlink-vs-directory distinction has to be correct, not just
 * fast.
 */
export function listSources(
  root: string,
  ext: string,
  failureOf: (absDir: string, err: string) => SourceSnapshot,
  symlinkFailureOf: (absPath: string) => SourceSnapshot,
): Listing {
  const files: string[] = [];
  const failures: SourceSnapshot[] = [];
  if (!existsSync(root)) return { files, failures };
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      failures.push(failureOf(dir, String(err)));
      return;
    }
    for (const dirent of entries) {
      const name = dirent.name;
      if (name.startsWith(".")) {
        continue;
      }
      const abs = join(dir, name);
      // The symlink and recursion decisions both key off this lstat, not
      // dirent's advisory type (unreliable on some filesystems, per Node's
      // own docs — see the doc comment above).
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        // Vanished between readdir and lstat (TOCTOU on a live tree, e.g. a
        // concurrent daemon write) — nothing left to read or report; the
        // next scan simply will not see it.
        continue;
      }
      if (stat.isSymbolicLink()) {
        // Never followed, whether it resolves to a file or a directory:
        // a personal memory tool does not read outside its own store via
        // a link, and does not silently drop a symlinked source either.
        failures.push(symlinkFailureOf(abs));
        continue;
      }
      if (stat.isDirectory()) {
        walk(abs);
      } else if (name.endsWith(ext)) {
        files.push(abs);
      }
    }
  };
  walk(root);
  files.sort(); // deterministic scan order
  failures.sort((a, b) => a.source.localeCompare(b.source)); // deterministic failure order
  return { files, failures };
}

/**
 * Scan the whole corpus (journal + entities) into per-source snapshots.
 *
 * Missing roots are complete-and-empty (there is nothing to index yet), not
 * failures. A source that lists but cannot be read, OR a directory (root or
 * nested) that cannot be listed at all, is an incomplete snapshot and flips
 * `complete` to false.
 */
export function scanCorpus(opts?: { journalDir?: string; entitiesDir?: string }): CorpusProjection {
  const journalDir = opts?.journalDir ?? getJournalDir();
  const entitiesDir = opts?.entitiesDir ?? getEntitiesDir();

  const items: MemoryItem[] = [];
  const snapshots: SourceSnapshot[] = [];
  let failures: SourceSnapshot[] = [];

  const journalListing = listSources(
    journalDir,
    ".jsonl",
    (absDir, err) => dirFailure(journalDir, absDir, "journal", err),
    (absPath) => symlinkFailure(journalDir, absPath, "journal"),
  );
  // Directory-listing and symlink failures are sources seen during the scan,
  // same as file-level read/parse failures.
  snapshots.push(...journalListing.failures);
  for (const file of journalListing.files) {
    const snap = projectJournalFile(file, journalDir);
    snapshots.push(snap);
    items.push(...snap.items);
    if (snap.status === "incomplete") failures.push(snap);
  }

  const entityListing = listSources(
    entitiesDir,
    ".md",
    (absDir, err) => dirFailure(entitiesDir, absDir, "entity", err),
    (absPath) => symlinkFailure(entitiesDir, absPath, "entity"),
  );
  snapshots.push(...entityListing.failures);
  for (const file of entityListing.files) {
    const snap = projectEntityFile(file, entitiesDir);
    snapshots.push(snap);
    items.push(...snap.items);
    if (snap.status === "incomplete") failures.push(snap);
  }

  failures = [...journalListing.failures, ...entityListing.failures, ...failures];
  failures.sort((a, b) => a.source.localeCompare(b.source));

  return { items, snapshots, complete: failures.length === 0, failures };
}
