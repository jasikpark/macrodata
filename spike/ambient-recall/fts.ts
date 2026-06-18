/**
 * Hacky FTS (BM25-lite) + RRF fusion over the spike index — to A/B test the
 * hybrid theory before committing to a real SQLite FTS5 leg.
 *
 * FTS leg: in-memory IDF-weighted term scoring over each item's content (rare
 * tokens like "asa"/"porrima" outweigh "memory"/"system"). Vector leg: the
 * existing searchMemory(). Fused via Reciprocal Rank Fusion (K=60), same as
 * Porrima. NOT production — no stemming, no SQLite, corpus rebuilt per process.
 */

import { LocalIndex } from "vectra";
import { join } from "path";
import { getIndexDir } from "./config.ts";
import { searchMemory, type SearchResult } from "./indexer.ts";

const STOP = new Set(
  "the a an is are was were be by of to in on for and or but with that this it as at from how do does did what why which when who whose into over under not no yes can could would should i we you they them their our your my me".split(" "),
);

function terms(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9_-]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOP.has(t),
  );
}

interface Doc {
  content: string;
  source: string;
  section?: string;
  type: string;
  timestamp?: string; // carried through so the FTS leg's hits decay too (else FTS-only journal items read as evergreen)
  tf: Map<string, number>;
}

let corpus: Doc[] | null = null;
let idf: Map<string, number> | null = null;

async function buildCorpus(): Promise<void> {
  const idx = new LocalIndex(join(getIndexDir(), "vectors"));
  const items = await idx.listItems();
  corpus = items.map((it) => {
    const m = it.metadata as Record<string, unknown>;
    const content = (m.content as string) ?? "";
    const tf = new Map<string, number>();
    for (const t of terms(content)) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { content, source: m.source as string, section: m.section as string | undefined, type: m.type as string, timestamp: m.timestamp as string | undefined, tf };
  });
  const df = new Map<string, number>();
  for (const d of corpus) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const N = corpus.length;
  idf = new Map();
  for (const [t, f] of df) idf.set(t, Math.log(1 + (N - f + 0.5) / (f + 0.5)));
}

export async function ftsSearch(query: string, k = 20): Promise<SearchResult[]> {
  if (!corpus || !idf) await buildCorpus();
  const qts = terms(query);
  return corpus!
    .map((d) => {
      let s = 0;
      for (const t of qts) {
        const tf = d.tf.get(t);
        if (tf) s += (idf!.get(t) ?? 0) * (tf / (tf + 1.5)); // tf saturation
      }
      return { d, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => ({ content: x.d.content, source: x.d.source, section: x.d.section, type: x.d.type, timestamp: x.d.timestamp, score: x.s }));
}

// Cross-encoder rerank via a second llama-server (/v1/rerank). Returns a score
// per input doc (0-1 calibrated), reordered back to input order.
const RERANK_URL = process.env.MACRODATA_RERANK_URL || "http://localhost:8090";
export async function rerank(query: string, docs: string[]): Promise<number[]> {
  if (docs.length === 0) return [];
  const res = await fetch(`${RERANK_URL}/v1/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Cap doc length sent to the reranker (full content can be long). 2000 chars
    // = slow-and-strong (Caleb 2026-06-17: 8s is fine, async fixes latency, don't
    // trade quality for it). Profiled ~140ms/doc at this length.
    body: JSON.stringify({ query, documents: docs.map((d) => d.slice(0, 2000)) }),
  });
  if (!res.ok) throw new Error(`rerank ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { results: Array<{ index: number; relevance_score: number }> };
  const scores = new Array(docs.length).fill(0);
  for (const r of j.results) scores[r.index] = r.relevance_score;
  return scores;
}

// Full pipeline (Porrima placement): vector + FTS recall -> RRF fuse ->
// recency-biased candidate SELECTION -> cross-encoder rerank -> floor on the
// PURE rerank score. Recency decides which candidates earn a rerank slot; it
// never touches the final ranking, so a stale-but-strongly-relevant memory that
// survives into the pool still wins on pure relevance.
export async function pipelineSearch(
  query: string,
  opts: { limit?: number; task?: string; floor?: number; rerankQuery?: string; exclude?: Set<string> } = {},
): Promise<SearchResult[]> {
  const { limit = 5, task, floor = 0.5, rerankQuery, exclude } = opts;
  // Recall legs use the WIDE query; the rerank precision pass uses the TIGHT
  // query (the agent's current trajectory) when provided, else the same query.
  const vec = await searchMemory(query, { limit: 20, task });
  const fts = await ftsSearch(query, 20);

  // RRF-fuse the two recall legs into one ranked slate (K=60), keyed by content.
  // Drop already-injected chunks here, BEFORE rerank, so repeats don't occupy
  // the pool and starve fresh chunks.
  const K = 60;
  const fused = new Map<string, { item: SearchResult; rrf: number }>();
  const add = (list: SearchResult[]) =>
    list.forEach((r, i) => {
      if (exclude?.has(r.content)) return;
      const prev = fused.get(r.content);
      fused.set(r.content, { item: prev?.item ?? r, rrf: (prev?.rrf ?? 0) + 1 / (K + i + 1) });
    });
  add(vec);
  add(fts);

  // Recency BEFORE rerank (Porrima placement, verified in source 2026-06-17):
  // Porrima bakes recency into the fused RETRIEVAL score (rrf * recencyDecay *
  // importance * supersession) that picks candidates, then OVERWRITES it with the
  // pure cross-encoder score — recency never gates the final output. We mirror
  // that: recency multiplies the RRF score for selection only. This is gentler
  // than our old after-rerank multiply-then-floor, which imposed a hard age
  // ceiling (a 107d hit at rerank 1.0 still floored out); now that same hit wins
  // if it survives into the pool. halfLife default 60d; entities (no timestamp)
  // are evergreen (weight 1). We decay from CREATION (no access-tracking layer).
  const halfLifeDays = Number(process.env.MACRODATA_RECALL_HALFLIFE_DAYS ?? 60);
  const now = Date.now();
  const recency = (ts?: string): number => {
    if (!ts) return 1; // evergreen entity — no decay
    const t = Date.parse(ts);
    if (Number.isNaN(t)) return 1;
    const ageDays = Math.max(0, (now - t) / 86_400_000);
    return Math.pow(0.5, ageDays / halfLifeDays);
  };

  // Pool cap: rerank is the expensive precision stage, so recency-adjusted RRF
  // chooses which top-N candidates to spend it on. A pool >= the slate size makes
  // recency a no-op (everyone gets reranked); tighten it to give recency bite.
  const pool = Number(process.env.MACRODATA_RECALL_RERANK_POOL ?? 20);
  const candidates = [...fused.values()]
    .sort((a, b) => b.rrf * recency(b.item.timestamp) - a.rrf * recency(a.item.timestamp))
    .slice(0, pool)
    .map((x) => x.item);

  // Rerank the pool; the PURE cross-encoder score is the final score.
  const scores = await rerank(rerankQuery || query, candidates.map((c) => c.content));
  return candidates
    .map((c, i) => ({ ...c, score: scores[i] }))
    .filter((c) => c.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// RRF fuse vector + FTS, keyed by content. Returns fused order with rrf score.
export async function hybridSearch(query: string, opts: { limit?: number; task?: string } = {}): Promise<SearchResult[]> {
  const { limit = 5, task } = opts;
  const K = 60;
  const vec = await searchMemory(query, { limit: 20, task });
  const fts = await ftsSearch(query, 20);

  const fused = new Map<string, { item: SearchResult; rrf: number }>();
  const add = (list: SearchResult[]) =>
    list.forEach((r, i) => {
      const key = r.content;
      const prev = fused.get(key);
      fused.set(key, { item: prev?.item ?? r, rrf: (prev?.rrf ?? 0) + 1 / (K + i + 1) });
    });
  add(vec);
  add(fts);

  return [...fused.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map((x) => ({ ...x.item, score: x.rrf }));
}
