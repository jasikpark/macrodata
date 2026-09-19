/**
 * Memory Indexer
 *
 * Manages the vector index for semantic search over:
 * - Journal entries
 * - People files
 * - Project files
 *
 * Uses Vectra for storage and embeddings.ts for vector generation.
 */

import { LocalIndex } from "vectra";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { getLogger } from "@logtape/logtape";
import { embed, embedBatch, preloadModel as preloadEmbeddings } from "./embeddings.js";
import { getIndexDir } from "./config.js";
import { scanCorpus, projectEntityFile, type MemoryItem, type MemoryItemType } from "./corpus.js";

export type { SourceSnapshot, SourceStatus, SourceKind, CorpusProjection } from "./corpus.js";

// Library-side logging: records go to whatever sink the running entrypoint
// configured (MCP server -> stderr, daemon -> .daemon.log) and are dropped
// silently in unconfigured processes (hooks, tests) — stdout is never touched,
// so an MCP stdio process can safely call any function here.
const logger = getLogger(["macrodata", "indexer"]);

// Item types for filtering
// "journal", or an entity folder name (people, projects, topics, agents, …).
// The entities/ subdirectory names ARE the type set — see rebuildIndex and
// indexEntityFile, which both derive the type from the folder. No closed union,
// so new categories index automatically.
export type { MemoryItemType, MemoryItem } from "./corpus.js";

export interface SearchResult {
  content: string;
  source: string;
  section?: string;
  timestamp?: string;
  type: MemoryItemType;
  score: number;
  // Cross-encoder score (sigmoid'd to [0, 1]). Present only when rerank was on.
  // When set, `score` is replaced with this value so downstream sorting/floors
  // operate on the reranker's verdict; `vectorScore` preserves the original
  // bi-encoder cosine for inspection.
  rerankScore?: number;
  vectorScore?: number;
}

// Cached index instance with path tracking
let index: LocalIndex | null = null;
let indexPath: string | null = null;

/**
 * Get or create the vector index
 * Re-creates if the configured path has changed
 */
async function getIndex(): Promise<LocalIndex> {
  const currentIndexDir = getIndexDir();
  const currentIndexPath = join(currentIndexDir, "vectors");

  // Invalidate cache if path changed
  if (index && indexPath !== currentIndexPath) {
    index = null;
    indexPath = null;
  }

  if (index) return index;

  // Ensure index directory exists
  if (!existsSync(currentIndexDir)) {
    mkdirSync(currentIndexDir, { recursive: true });
  }

  index = new LocalIndex(currentIndexPath);
  indexPath = currentIndexPath;

  // Create if doesn't exist
  if (!(await index.isIndexCreated())) {
    logger.info("creating new index");
    await index.createIndex();
  }

  return index;
}

/**
 * Add or update a single item in the index
 */
export async function indexItem(item: MemoryItem): Promise<void> {
  const idx = await getIndex();
  const vector = await embed(item.content);

  const metadata: Record<string, string | number | boolean> = {
    type: item.type,
    content: item.content,
    source: item.source,
  };
  if (item.section) metadata.section = item.section;
  if (item.timestamp) metadata.timestamp = item.timestamp;

  await idx.upsertItem({
    id: item.id,
    vector,
    metadata,
  });
}

/**
 * Add or update multiple items (batched for efficiency)
 */
export async function indexItems(items: MemoryItem[]): Promise<void> {
  if (items.length === 0) return;

  const idx = await getIndex();
  const vectors = await embedBatch(items.map((i) => i.content));

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const metadata: Record<string, string | number | boolean> = {
      type: item.type,
      content: item.content,
      source: item.source,
    };
    if (item.section) metadata.section = item.section;
    if (item.timestamp) metadata.timestamp = item.timestamp;

    await idx.upsertItem({
      id: item.id,
      vector: vectors[i],
      metadata,
    });
  }
}

/**
 * Search the index
 */
export async function searchMemory(
  query: string,
  options: {
    limit?: number;
    type?: MemoryItemType;
    since?: string;
    rerank?: boolean;
    candidateK?: number;
  } = {},
): Promise<SearchResult[]> {
  const { limit = 5, type, since, rerank: doRerank = false, candidateK } = options;
  const idx = await getIndex();

  // Check if index has items
  const stats = await idx.listItems();
  if (stats.length === 0) {
    logger.info("index is empty");
    return [];
  }

  // With rerank on, fetch a wider slate so the cross-encoder has room to
  // promote items the bi-encoder ranked modestly. Without rerank, keep the
  // existing 2x oversampling that lets type/since filters still satisfy limit.
  const fetchK = doRerank ? (candidateK ?? Math.max(20, limit * 4)) : limit * 2;

  const queryVector = await embed(query);
  const results = await idx.queryItems(queryVector, fetchK);

  // Filter results if type or since specified
  let filtered = results;
  if (type || since) {
    filtered = results.filter((item) => {
      const meta = item.item.metadata as Record<string, unknown>;
      if (type && meta.type !== type) return false;
      if (since && meta.timestamp && (meta.timestamp as string) < since) return false;
      return true;
    });
  }

  const mapped: SearchResult[] = filtered.map((r) => {
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

  if (doRerank && mapped.length > 1) {
    const { rerank } = await import("./rerank.js");
    const ceScores = await rerank(
      query,
      mapped.map((m) => m.content),
    );
    return mapped
      .map((m, i) => ({
        ...m,
        vectorScore: m.score,
        rerankScore: ceScores[i],
        score: ceScores[i],
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  return mapped.slice(0, limit);
}

/**
 * Rebuild the entire index from scratch
 */
export async function rebuildIndex(): Promise<{ itemCount: number }> {
  logger.info("starting full index rebuild");
  const startTime = Date.now();

  // Rebuild is upsert-only: it deliberately does NOT delete+recreate the index.
  // The daemon and MCP server are separate processes sharing one lock-free
  // Vectra index; an rm-then-repopulate window would let a concurrent daemon
  // reindex read a half-deleted index (ENOENT) or clobber the rebuilt one.
  // Trade-off: records for deleted files/sections, or renamed types, are not
  // purged here — the one-time person->people rename needs a manual
  // `rm -rf <root>/.index` before rebuild. A safe cross-process clean rebuild
  // (temp-dir atomic swap + daemon coordination) is a tracked follow-up.
  // Canonical corpus projection — one scan, shared with recall. Every entity
  // category (immediate subdirectory of entities/) is indexed recursively with
  // no code change; dot segments are excluded at any depth.
  const projection = scanCorpus();
  const allItems = projection.items;
  for (const failure of projection.failures) {
    logger.warn("corpus source incomplete; indexed what was readable", {
      source: failure.source,
      error: failure.error,
    });
  }

  // Index all items
  logger.info("indexing items", { items: allItems.length });
  await indexItems(allItems);

  const duration = Date.now() - startTime;
  logger.info("index rebuild complete", { ms: duration });

  return { itemCount: allItems.length };
}

/**
 * Index a single journal entry (for incremental updates)
 */
export async function indexJournalEntry(entry: {
  timestamp: string;
  topic: string;
  content: string;
}): Promise<void> {
  const item: MemoryItem = {
    id: `journal-${entry.timestamp}`,
    type: "journal",
    content: `[${entry.topic}] ${entry.content}`,
    source: "journal",
    timestamp: entry.timestamp,
  };
  await indexItem(item);
}

/**
 * Get index stats
 */
export async function getIndexStats(): Promise<{ itemCount: number }> {
  const idx = await getIndex();
  const items = await idx.listItems();
  return { itemCount: items.length };
}

/**
 * Index a single entity file (person or project)
 * Called by daemon when files change. The canonical projection derives the
 * type, source identity, and ids — including nested category paths.
 */
export async function indexEntityFile(filePath: string): Promise<void> {
  const snap = projectEntityFile(filePath);
  if (snap.status === "incomplete") {
    logger.error("failed to index entity file", { filePath, error: snap.error });
    return;
  }
  await indexItems(snap.items);
  logger.info("indexed entity file", { file: snap.source, sections: snap.items.length });
}

/**
 * Preload the embedding model (call during startup)
 */
export async function preloadModel(): Promise<void> {
  await preloadEmbeddings();
}
