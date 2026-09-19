/**
 * Ambient-recall indexer — Qwen3/1024 Vectra index over macrodata markdown.
 *
 * Parsing (journal JSONL + per-section entity splitting) is ported verbatim
 * from src/indexer.ts so both indexes hold the same units. The differences are:
 * Qwen3 doc/query embeddings, 1024-dim, and a separate index dir
 * (config.getIndexDir) — MiniLM/384 and Qwen3/1024 cannot share a Vectra store.
 */

import { LocalIndex } from "vectra";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { embedDocuments, embedQuery } from "./embeddings.ts";
import { getIndexDir, getJournalDir, getEntitiesDir } from "./config.ts";
import { scanCorpus, type MemoryItem, type MemoryItemType } from "../corpus.ts";

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

let index: LocalIndex | null = null;

// Drop the cached LocalIndex (it holds index.json in memory) so the next call
// re-reads from disk. Called by the staleness check in fts.ts when a reindex
// bumps the on-disk index — without it the long-lived worker serves the old
// snapshot forever.
export function resetIndexCache(): void {
  index = null;
}

async function getIndex(): Promise<LocalIndex> {
  const dir = getIndexDir();
  if (index) return index;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  index = new LocalIndex(join(dir, "vectors"));
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

const INDEX_BATCH = 8;

async function indexItems(items: MemoryItem[]): Promise<void> {
  if (items.length === 0) return;
  const idx = await getIndex();
  const t0 = Date.now();

  // Embed -> upsert -> log per batch (NOT embed-all-then-write): incremental
  // persistence (resumable / survives a kill), bounded memory, visible progress.
  for (let i = 0; i < items.length; i += INDEX_BATCH) {
    const batch = items.slice(i, i + INDEX_BATCH);
    const vectors = await embedDocuments(
      batch.map((it) => dropLoneHighSurrogate(it.content.slice(0, MAX_EMBED_CHARS))),
    );
    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const metadata: Record<string, string | number | boolean> = {
        type: item.type,
        content: item.content,
        source: item.source,
      };
      if (item.section) metadata.section = item.section;
      if (item.timestamp) metadata.timestamp = item.timestamp;
      await idx.upsertItem({ id: item.id, vector: vectors[j], metadata });
    }
    const done = Math.min(i + INDEX_BATCH, items.length);
    if (done % (INDEX_BATCH * 10) === 0 || done === items.length) {
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`[macrodata-recall]${done}/${items.length} indexed (${rate.toFixed(1)} items/s)`);
    }
  }
}

function collectItems(): { items: MemoryItem[]; complete: boolean } {
  const projection = scanCorpus();
  if (!projection.complete) {
    for (const f of projection.failures) {
      console.log(`[macrodata-recall]projection incomplete: ${f.source}: ${f.error}`);
    }
  }
  return { items: projection.items, complete: projection.complete };
}

// indexItems only ever upserts, so a vector outlives the journal line, section,
// or file it came from and keeps scoring against live material forever. Nothing
// else deletes, so the index only converges on the corpus if the ids the scan
// no longer produces are removed here.
/**
 * True when NEITHER corpus root exists on disk. A complete, empty projection
 * over missing roots plus a non-empty index is far more likely a
 * misconfigured MACRODATA_ROOT than a deliberate wipe, so it stays the one
 * pattern pruneAgainst conservatively refuses.
 */
function bothCorpusRootsMissing(): boolean {
  return !existsSync(getJournalDir()) && !existsSync(getEntitiesDir());
}

async function pruneAgainst(
  items: MemoryItem[],
  complete: boolean,
): Promise<{ pruned: number; kept: number }> {
  const idx = await getIndex();
  const indexed = await idx.listItems();

  // An incomplete projection (any source that failed to read or list) would
  // silently read its missing items as deletions. Refuse rather than
  // reconcile to an untruth.
  if (!complete) {
    if (indexed.length > 0) {
      console.log(`[macrodata-recall]prune skipped: projection incomplete, index holds ${indexed.length}`);
    }
    return { pruned: 0, kept: indexed.length };
  }

  // A complete projection is authoritative even when empty: an empty scan
  // against at least one existing root means the corpus IS empty, and
  // empties-to-zero is correct convergence after a wipe (bothCorpusRootsMissing
  // is the one exception, above).
  if (items.length === 0) {
    if (indexed.length > 0) {
      if (bothCorpusRootsMissing()) {
        console.log(
          `[macrodata-recall]prune skipped: journal and entities roots both missing (misconfigured root?), index holds ${indexed.length}`,
        );
        return { pruned: 0, kept: indexed.length };
      }
      for (const orphan of indexed) await idx.deleteItem(orphan.id);
      return { pruned: indexed.length, kept: 0 };
    }
    return { pruned: 0, kept: 0 };
  }

  const live = new Set(items.map((it) => it.id));
  const orphans = indexed.filter((it) => !live.has(it.id));
  for (const orphan of orphans) await idx.deleteItem(orphan.id);

  return { pruned: orphans.length, kept: indexed.length - orphans.length };
}

/**
 * Prune index vectors the current corpus no longer produces. Called with a
 * pre-scanned item list, the caller OWNS that list's authority (it must be a
 * complete projection); called with no argument, the scan decides.
 */
export async function pruneOrphans(
  scanned?: MemoryItem[],
): Promise<{ pruned: number; kept: number }> {
  if (scanned) return pruneAgainst(scanned, true);
  const { items, complete } = collectItems();
  return pruneAgainst(items, complete);
}

export async function rebuildIndex(): Promise<{ itemCount: number; pruned: number }> {
  const start = Date.now();
  const projection = collectItems();
  const allItems = projection.items;

  console.log(`[macrodata-recall]embedding + indexing ${allItems.length} items (Qwen3/1024)…`);
  await indexItems(allItems);

  // Prune against the SAME projection just indexed: pruneAgainst needs
  // `complete` to refuse deleting on an incomplete scan (see pruneAgainst).
  const { pruned } = await pruneAgainst(allItems, projection.complete);
  if (pruned > 0) console.log(`[macrodata-recall]pruned ${pruned} orphaned vectors`);

  console.log(`[macrodata-recall]rebuild complete in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  return { itemCount: allItems.length, pruned };
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
