/**
 * Retrieval profiles: one pipeline (vector + FTS -> RRF -> recency/MMR pool ->
 * rerank -> floor), tuned per consumer, after Porrima's retrieval-settings.ts
 * (separate memoryContext / passiveRecall rows over the same index).
 *
 * - ambient: the recall hook. Interruptive, so narrow, recency-biased, and
 *   silent below the floor.
 * - search: a deliberate query (search_memory, search_conversations). The
 *   caller asked, so it always gets results, and an old decision must rank on
 *   relevance alone.
 *
 * Profiles are read at call time so MACRODATA_RECALL_* overrides take effect
 * without a worker restart. The env vars tune the ambient profile only.
 */

import { envNum } from "./fts.ts";

export type ProfileName = "ambient" | "search";

export interface RetrievalProfile {
  name: ProfileName;
  /** Candidates per recall leg (vector and FTS each). */
  legK: number;
  /** Candidates that earn a cross-encoder pass. Keep below legK * 2, or recency and MMR stop gating. */
  rerankPool: number;
  /** MMR relevance/diversity trade-off for pool selection: 1 = pure relevance. */
  mmrLambda: number;
  /** Recency half-life for pool selection. Infinity turns recency off. */
  halfLifeDays: number;
  /** Minimum final rerank score. 0 returns everything that was reranked. */
  floor: number;
  /** Maximum hits returned. */
  limit: number;
}

export function ambientProfile(): RetrievalProfile {
  return {
    name: "ambient",
    // Porrima's passiveRecall searchLimit tiers are 28/40/64 (fast/balanced/thorough).
    legK: envNum("MACRODATA_RECALL_LEG_K", 40, 1),
    rerankPool: envNum("MACRODATA_RECALL_RERANK_POOL", 20, 1),
    mmrLambda: envNum("MACRODATA_RECALL_MMR_LAMBDA", 0.55, 0),
    halfLifeDays: envNum("MACRODATA_RECALL_HALFLIFE_DAYS", 30, 0.1),
    floor: envNum("MACRODATA_RECALL_FLOOR", 0.5, 0),
    limit: envNum("MACRODATA_RECALL_LIMIT", 3, 1),
  };
}

export function searchProfile(): RetrievalProfile {
  // A sharp tool, after Porrima's search_memory (topK 5, recency kept): few
  // results, ranked on relevance with recency as a nudge. Reaching old
  // decisions is a date filter's job, not a reason to switch recency off.
  // Unlike Porrima it keeps the cross-encoder, and leans MMR toward relevance
  // (Porrima's final-selection lambda is 0.7) so duplicate records of one event
  // don't crowd out the rest.
  return {
    name: "search",
    legK: 40,
    rerankPool: 20,
    mmrLambda: 0.7,
    halfLifeDays: 30,
    floor: 0,
    limit: 5,
  };
}

export function getProfile(name: ProfileName): RetrievalProfile {
  return name === "search" ? searchProfile() : ambientProfile();
}

export function isProfileName(v: unknown): v is ProfileName {
  return v === "ambient" || v === "search";
}
