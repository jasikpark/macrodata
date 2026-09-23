/**
 * Ambient-recall indexer — Qwen3/1024 Vectra index over macrodata markdown.
 *
 * Units come from the canonical corpus projection (src/corpus.ts) shared with
 * the MiniLM indexer, so both indexes hold the same units. The differences are:
 * Qwen3 doc/query embeddings, 1024-dim, and a separate index dir
 * (config.getIndexDir) — MiniLM/384 and Qwen3/1024 cannot share a Vectra store.
 */

import type { LocalIndex } from "vectra";
import { AtomicLocalIndex, UnparsableIndexError } from "./atomic-index.ts";
import { join, relative, resolve, sep } from "path";
import { existsSync, lstatSync, mkdirSync } from "fs";
import { embedDocuments, embedQuery } from "./embeddings.ts";
import { getIndexDir, getJournalDir, getEntitiesDir } from "./config.ts";
import {
  scanCorpus,
  canonicalUnder,
  isDotPath,
  projectJournalFile,
  projectEntityFile,
  type CorpusProjection,
  type MemoryItem,
  type MemoryItemType,
  type SourceSnapshot,
} from "../corpus.ts";

export type { MemoryItem, MemoryItemType } from "../corpus.ts";

export interface SearchResult {
  content: string;
  source: string;
  section?: string;
  timestamp?: string;
  type: MemoryItemType;
  score: number; // FINAL score = pure cross-encoder rerank (0-1)
  // Per-stage diagnostics (carried through for calibration; not used in ranking):
  rrf?: number; // RRF-fused recall score (vector+FTS), pre-recency, pre-rerank
  recency?: number; // recency decay factor (0-1) applied for candidate SELECTION only
  wRank?: number; // 1-based rank in the pre-MMR w-sorted slate; wRank > pool size = MMR created this slot
  mmrPick?: number; // 1-based MMR selection order; absent = MMR bypassed (small slate / lambda>=1)
  mmrSim?: number; // redundancy penalty (max cosine/Jaccard vs earlier picks) at pick time; 0 for the first pick
}

let index: AtomicLocalIndex | null = null;

// Drop the cached LocalIndex (it holds index.json in memory) so the next call
// re-reads from disk. Called by the staleness check in fts.ts when a reindex
// bumps the on-disk index — without it the long-lived worker serves the old
// snapshot forever.
export function resetIndexCache(): void {
  index = null;
}

async function getIndex(): Promise<AtomicLocalIndex> {
  const dir = getIndexDir();
  if (index) return index;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  index = new AtomicLocalIndex(join(dir, "vectors"));
  if (!(await index.isIndexCreated())) {
    await index.createIndex();
  }
  return index;
}

// Embed a length-capped view of each doc — long sections dilute the embedding
// and blew fp32 activation memory. Full content is still stored in metadata for
// display/return; only the embedding input is truncated.
const MAX_EMBED_CHARS = 2000;

// A char-unit slice can split a surrogate pair, leaving a lone high surrogate
// that serializes to U+FFFD and silently degrades the embedding. Drop a
// trailing lone high surrogate (same guard as compose-state-file.ts).
function dropLoneHighSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

const EMBED_BATCH = 8;

// Vectra rewrites the whole index.json on every endUpdate (and on every bare
// upsertItem/deleteItem, which wraps its own update), so a write per item makes
// a full rebuild quadratic in index size. Commit every COMMIT_ITEMS embedded
// items instead: an interrupted pass loses at most that many embeddings, and
// the next reconcile skips everything already committed.
const COMMIT_ITEMS = 128;

type Metadata = Record<string, string | number | boolean>;

function metadataOf(item: MemoryItem): Metadata {
  const metadata: Metadata = { type: item.type, content: item.content, source: item.source };
  if (item.section) metadata.section = item.section;
  if (item.timestamp) metadata.timestamp = item.timestamp;
  return metadata;
}

// The embedding input is derived from content alone, so equal content means
// the stored vector is still valid even when other metadata moved.
const METADATA_KEYS = ["type", "content", "source", "section", "timestamp"] as const;

function sameMetadata(stored: Record<string, unknown>, next: Metadata): boolean {
  return METADATA_KEYS.every((k) => stored[k] === next[k]);
}

export interface ReconcileResult {
  /** Items the projection produced for the reconciled scope. */
  itemCount: number;
  /** Items (re-)embedded: new, content changed, or forced. */
  embedded: number;
  /** Items whose content matched but metadata moved; vector reused. */
  relabeled: number;
  unchanged: number;
  pruned: number;
  /** False when the scope's projection was incomplete, so nothing unseen was pruned. */
  complete: boolean;
}

// Every writer below runs through this chain, so two reconciles in one process
// (a watcher's burst of events) never interleave inside one Vectra update: a
// second beginUpdate on the shared LocalIndex throws, and its cleanup would
// cancel the first caller's update.
let writeChain: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

// Vectors this process pruned recently, by content. A watcher sees a rename as
// two events in either order; when the deletion lands first, the addition
// finds its content here instead of re-embedding it.
const RECENTLY_PRUNED_CAP = 4096;
const recentlyPruned = new Map<unknown, number[]>();

function rememberPruned(items: { metadata: unknown; vector: number[] }[]): void {
  for (const it of items) {
    const content = (it.metadata as Record<string, unknown>).content;
    recentlyPruned.delete(content);
    recentlyPruned.set(content, it.vector);
  }
  for (const key of recentlyPruned.keys()) {
    if (recentlyPruned.size <= RECENTLY_PRUNED_CAP) break;
    recentlyPruned.delete(key);
  }
}

/**
 * Converge the index on `items`, deleting `stale` ids. Embeds only items whose
 * content no stored vector already covers, unless `force`. Callers own the
 * authority of `stale`: it must contain only ids a clean read proved are gone.
 */
async function applyReconcile(
  idx: LocalIndex,
  items: MemoryItem[],
  stale: Iterable<string>,
  opts: { force?: boolean; complete: boolean },
): Promise<ReconcileResult> {
  const stored = await idx.listItems();
  const existing = new Map(stored.map((it) => [it.id, it]));
  // Ids are positional (journal line index, section index), so a line inserted
  // above or a file renamed moves identical content to a new id; reuse its
  // vector rather than re-embedding.
  const byContent = new Map<unknown, number[]>(recentlyPruned);
  for (const it of stored)
    byContent.set((it.metadata as Record<string, unknown>).content, it.vector);

  const toEmbed: MemoryItem[] = [];
  const toRelabel: { item: MemoryItem; vector: number[] }[] = [];
  let unchanged = 0;
  for (const item of items) {
    const meta = existing.get(item.id)?.metadata as Record<string, unknown> | undefined;
    const reusable = opts.force ? undefined : byContent.get(item.content);
    if (!reusable) toEmbed.push(item);
    else if (!meta || !sameMetadata(meta, metadataOf(item)))
      toRelabel.push({ item, vector: reusable });
    else unchanged++;
  }
  const deletions = [...new Set(stale)].filter((id) => existing.has(id));

  const result: ReconcileResult = {
    itemCount: items.length,
    embedded: toEmbed.length,
    relabeled: toRelabel.length,
    unchanged,
    pruned: deletions.length,
    complete: opts.complete,
  };
  // A commit rewrites the whole index.json and bumps its mtime, which makes the
  // worker drop and reparse every cache it keys on that file.
  if (deletions.length === 0 && toRelabel.length === 0 && toEmbed.length === 0) return result;

  const t0 = Date.now();
  let open = false;
  try {
    await idx.beginUpdate();
    open = true;
    for (const id of deletions) await idx.deleteItem(id);
    for (const { item, vector } of toRelabel) {
      await idx.upsertItem({ id: item.id, vector, metadata: metadataOf(item) });
    }
    let sinceCommit = 0;
    for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
      const batch = toEmbed.slice(i, i + EMBED_BATCH);
      const vectors = await embedDocuments(
        batch.map((it) => dropLoneHighSurrogate(it.content.slice(0, MAX_EMBED_CHARS))),
      );
      for (let j = 0; j < batch.length; j++) {
        await idx.upsertItem({
          id: batch[j].id,
          vector: vectors[j],
          metadata: metadataOf(batch[j]),
        });
      }
      sinceCommit += batch.length;
      const done = Math.min(i + EMBED_BATCH, toEmbed.length);
      if (sinceCommit >= COMMIT_ITEMS && done < toEmbed.length) {
        open = false;
        await idx.endUpdate();
        await idx.beginUpdate();
        open = true;
        sinceCommit = 0;
      }
      if (done % (EMBED_BATCH * 10) === 0 || done === toEmbed.length) {
        const rate = done / ((Date.now() - t0) / 1000);
        console.log(
          `[macrodata-recall]${done}/${toEmbed.length} embedded (${rate.toFixed(1)} items/s)`,
        );
      }
    }
    open = false;
    await idx.endUpdate();
    rememberPruned(deletions.flatMap((id) => existing.get(id) ?? []));
  } catch (err) {
    // A failed commit may have left the on-disk index ahead of or behind this
    // copy (ConcurrentWriteError); drop the cache so the next read reloads it.
    if (open) idx.cancelUpdate();
    resetIndexCache();
    throw err;
  }
  return result;
}

/** Journal and entity sources share one relative-path namespace; the extension tells them apart. */
function kindOfSource(source: unknown): "journal" | "entity" | null {
  if (typeof source !== "string") return null;
  return source.endsWith(".jsonl") ? "journal" : source.endsWith(".md") ? "entity" : null;
}

/**
 * Ids in the index that `projection` proves are gone.
 *
 * A missing root is far more likely a misconfigured MACRODATA_ROOT or a sync
 * tool mid-swap than a deliberate wipe, so its kind is never pruned. Otherwise
 * an indexed id the scan no longer produces is gone unless its source lies
 * under something the scan failed on: a directory that failed to list may hide
 * it, and an unreadable, malformed, or symlinked source's missing items may be
 * unparsable rather than gone. Everything else, including an empty corpus
 * under a present root, is authoritative.
 */
async function staleIds(idx: LocalIndex, projection: CorpusProjection): Promise<string[]> {
  const indexed = await idx.listItems();
  const live = new Set(projection.items.map((it) => it.id));
  const rootPresent = {
    journal: existsSync(getJournalDir()),
    entity: existsSync(getEntitiesDir()),
  };
  for (const kind of ["journal", "entity"] as const) {
    if (!rootPresent[kind])
      console.log(`[macrodata-recall]prune skipped for ${kind}: root missing`);
  }
  for (const f of projection.failures) {
    console.log(`[macrodata-recall]projection incomplete: ${f.source}: ${f.error}`);
  }

  // A failure's source is a file or a directory; "." is the root itself.
  const tainted = (kind: "journal" | "entity", source: string) =>
    projection.failures.some(
      (f) =>
        f.kind === kind &&
        (f.source === "." || source === f.source || source.startsWith(f.source + "/")),
    );
  const heldFrom = new Map(
    projection.snapshots.flatMap((s) =>
      s.kind === "journal" && s.heldFrom !== undefined ? [[s.source, s.heldFrom] as const] : [],
    ),
  );

  return indexed
    .filter((it) => {
      if (live.has(it.id)) return false;
      const source = (it.metadata as Record<string, unknown>).source;
      const kind = kindOfSource(source);
      if (!kind) return projection.complete;
      if (kind === "journal" && isHeld(it.id, source as string, heldFrom.get(source as string)))
        return false;
      return rootPresent[kind] && !tainted(kind, source as string);
    })
    .map((it) => it.id);
}

/** Whether a journal id sits at or past its source's held tail line. */
function isHeld(id: string, source: string, heldFrom: number | undefined): boolean {
  if (heldFrom === undefined) return false;
  const line = Number(id.slice(`journal-${source}-`.length));
  return !Number.isInteger(line) || line >= heldFrom;
}

async function freshIndex({ replaceUnparsable = false } = {}): Promise<LocalIndex> {
  // Another process (a manual reindex, a sibling worker) may have rewritten
  // index.json since this one cached it; reconcile against the disk.
  resetIndexCache();
  const idx = await getIndex();
  if (!replaceUnparsable) return idx;
  try {
    await idx.listItems();
    return idx;
  } catch (err) {
    if (!(err instanceof UnparsableIndexError)) throw err;
    console.log(`[macrodata-recall]unparsable index moved to ${idx.setAside()}; rebuilding`);
    resetIndexCache();
    return getIndex();
  }
}

/**
 * Converge the whole index on the current corpus: embed new and changed items,
 * relabel moved metadata, delete what a clean read proves is gone.
 */
export function reconcileCorpus(opts: { force?: boolean } = {}): Promise<ReconcileResult> {
  return serialized(async () => {
    const start = Date.now();
    const idx = await freshIndex({ replaceUnparsable: opts.force });
    const projection = scanCorpus();
    const result = await applyReconcile(idx, projection.items, await staleIds(idx, projection), {
      force: opts.force,
      complete: projection.complete,
    });
    console.log(
      `[macrodata-recall]reconcile: ${result.embedded} embedded, ${result.relabeled} relabeled, ${result.unchanged} unchanged, ${result.pruned} pruned in ${((Date.now() - start) / 1000).toFixed(1)}s`,
    );
    return result;
  });
}

const noopIncomplete = (): ReconcileResult => ({
  itemCount: 0,
  embedded: 0,
  relabeled: 0,
  unchanged: 0,
  pruned: 0,
  complete: false,
});

/**
 * Converge the index on one corpus path (absolute). A path that no longer
 * exists is a confirmed deletion of its source, or of every source under it
 * when it was a directory; a rename or category move is a deletion at the old
 * path plus an addition at the new one, so reconcile both paths. A path the
 * corpus scan would not index (a symlink at any depth, a spelling that differs
 * from the on-disk name, a dot path, a wrong extension, a directory) changes
 * nothing and reports incomplete, so the caller can fall back to
 * reconcileCorpus.
 */
export function reconcileSource(path: string): Promise<ReconcileResult> {
  const absPath = resolve(path);
  const journalDir = getJournalDir();
  const entitiesDir = getEntitiesDir();
  const kind = absPath.startsWith(journalDir + sep)
    ? "journal"
    : absPath.startsWith(entitiesDir + sep)
      ? "entity"
      : null;
  if (!kind) return Promise.reject(new Error(`not a corpus path: ${path}`));
  const root = kind === "journal" ? journalDir : entitiesDir;
  const source = relative(root, absPath).split(sep).join("/");

  return serialized(async () => {
    if (!canonicalUnder(root, absPath)) return noopIncomplete();
    let gone = false;
    try {
      const st = lstatSync(absPath);
      const ext = kind === "journal" ? ".jsonl" : ".md";
      if (!st.isFile() || isDotPath(source) || !source.endsWith(ext)) return noopIncomplete();
    } catch (err) {
      // Only ENOENT under a root that still exists proves deletion; EACCES and
      // friends are an unreadable source, and a vanished root is misconfiguration.
      gone = (err as NodeJS.ErrnoException).code === "ENOENT" && existsSync(root);
      if (!gone) return noopIncomplete();
    }

    const idx = await freshIndex();
    if (gone) {
      const stale = (await idx.listItems())
        .filter((it) => {
          const s = (it.metadata as Record<string, unknown>).source;
          return (
            kindOfSource(s) === kind && (s === source || (s as string).startsWith(source + "/"))
          );
        })
        .map((it) => it.id);
      return applyReconcile(idx, [], stale, { complete: true });
    }

    const snap: SourceSnapshot =
      kind === "journal"
        ? projectJournalFile(absPath, journalDir)
        : projectEntityFile(absPath, entitiesDir);
    if (snap.status !== "ok") {
      console.log(`[macrodata-recall]source incomplete: ${snap.source}: ${snap.error}`);
      return applyReconcile(idx, snap.items, [], { complete: false });
    }
    const live = new Set(snap.items.map((it) => it.id));
    const stale = (await idx.listItems())
      .filter(
        (it) =>
          (it.metadata as Record<string, unknown>).source === source &&
          !live.has(it.id) &&
          !isHeld(it.id, source, snap.heldFrom),
      )
      .map((it) => it.id);
    return applyReconcile(idx, snap.items, stale, { complete: true });
  });
}

/** Delete vectors the current corpus proves are gone, without embedding. */
export function pruneOrphans(): Promise<{ pruned: number; kept: number }> {
  return serialized(async () => {
    const idx = await freshIndex();
    const before = (await idx.listItems()).length;
    const { pruned } = await applyReconcile(idx, [], await staleIds(idx, scanCorpus()), {
      complete: true,
    });
    return { pruned, kept: before - pruned };
  });
}

/** Re-embed every item (e.g. after an embedding-model change) and prune. */
export async function rebuildIndex(): Promise<{ itemCount: number; pruned: number }> {
  const { itemCount, pruned } = await reconcileCorpus({ force: true });
  return { itemCount, pruned };
}

export async function searchMemory(
  query: string,
  options: { limit?: number; type?: MemoryItemType; since?: string; task?: string } = {},
): Promise<SearchResult[]> {
  const { limit = 5, type, since, task } = options;
  const idx = await getIndex();

  const all = await idx.listItems();
  if (all.length === 0) return [];

  const queryVector = await embedQuery(query, task);
  const results = await idx.queryItems(queryVector, limit * 4);

  let filtered = results;
  if (type || since) {
    filtered = results.filter((item) => {
      const meta = item.item.metadata as Record<string, unknown>;
      if (type && meta.type !== type) return false;
      if (since && meta.timestamp && (meta.timestamp as string) < since) return false;
      return true;
    });
  }

  return filtered.slice(0, limit).map((r) => {
    const meta = r.item.metadata as Record<string, unknown>;
    return {
      content: meta.content as string,
      source: meta.source as string,
      section: meta.section as string | undefined,
      timestamp: meta.timestamp as string | undefined,
      type: meta.type as MemoryItemType,
      score: r.score,
    };
  });
}
