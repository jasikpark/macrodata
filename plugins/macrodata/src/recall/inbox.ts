/**
 * The hook side of the recall mailbox: claiming a worker result from a
 * session's inbox and rendering hits as a <macrodata-recall> block.
 *
 * Shared by the ambient-recall hook (bin/recall-hook-main.ts) and the recall
 * waiter (bin/recall-waiter.ts). Imports nothing that loads models or the
 * index, so the waiter stays a light process.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import type { SearchResult } from "./indexer.ts";
import { getInboxPath } from "./config.ts";

/** Timing and served-query stamps the worker writes beside the hits. */
export interface InboxMeta {
  requestedAt?: string;
  servedAt?: string;
  pipelineMs?: number;
  servedSearch?: string;
  servedRerankQuery?: string;
}

/**
 * One claim attempt's result plus the accounting that feeds calibration.
 * `drained` = hits the worker had waiting; `filteredInContext` = how many the
 * in-context exclude dropped (drained>0 with filteredInContext===drained and no
 * `ready` is the N2 post-injection blackout signature); `floorDropped` = hits
 * the floor re-check or a malformed score dropped after that; `drainError` =
 * the inbox existed but could not be claimed or parsed, which would otherwise
 * log exactly like "worker hadn't served yet".
 */
export interface Claim {
  claimed: boolean;
  ready: SearchResult[];
  meta: InboxMeta;
  drained: number;
  filteredInContext: number;
  filteredSrc: string[];
  floorDropped: number;
  drainError: boolean;
}

/**
 * Publish a whole file in one rename. The tmp name is pid-unique: parallel tool
 * calls fire concurrent same-sid hooks, and a shared tmp path lets two writers
 * interleave before one renames torn bytes into place.
 */
export function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/**
 * Collapse runs of whitespace to single spaces and escape any case-variant of
 * the `</macrodata-recall` closing tag so untrusted text stays on one line and
 * cannot close `<macrodata-recall>` early.
 */
function sanitizeInline(s: string): string {
  return s.replace(/\s+/g, " ").replace(/<\/(macrodata-recall)/gi, "<\\/$1");
}

/**
 * Log and display label: the file, qualified by the section when present. A
 * bare `section ?? source` collapses two files sharing a section title into one
 * label, and blackout forensics exist to identify WHICH hit was suppressed.
 */
export function srcLabel(h: SearchResult): string {
  const source = sanitizeInline(h.source).trim();
  const section = h.section ? sanitizeInline(h.section).trim() : "";
  return section ? `${source} › ${section}` : source;
}

/**
 * Claim the session's inbox, if any, and filter it down to injectable hits.
 *
 * Claim-by-rename BEFORE reading: concurrent same-sid hooks (parallel tool
 * calls, or the hook racing the recall waiter) must not both drain one result —
 * that double-injects and double-counts recordAccess, which feeds recency
 * ranking. Exactly one rename wins; the loser's ENOENT means "nothing ready".
 */
export function claimInbox(sid: string, exclude: Set<string>, profile: { floor: number; limit: number }): Claim {
  const out: Claim = {
    claimed: false, ready: [], meta: {}, drained: 0, filteredInContext: 0, filteredSrc: [], floorDropped: 0, drainError: false,
  };
  const inbox = sid ? getInboxPath(sid) : "";
  if (!inbox || !existsSync(inbox)) return out;
  const claim = `${inbox}.${process.pid}.claim`;
  // Only ENOENT means a concurrent fire won. Any other rename failure means the
  // inbox exists but can never be claimed, which would strand it forever while
  // the log shows drained:0.
  try { renameSync(inbox, claim); out.claimed = true; }
  catch (e) { if ((e as { code?: string }).code !== "ENOENT") out.drainError = true; }
  if (!out.claimed) return out;
  try {
    const parsed = JSON.parse(readFileSync(claim, "utf-8")) as InboxMeta & { hits?: SearchResult[] };
    const raw = parsed.hits || [];
    out.drained = raw.length;
    const kept = raw.filter((h) => !exclude.has(h.content));
    out.filteredInContext = out.drained - kept.length;
    out.filteredSrc = raw.filter((h) => exclude.has(h.content)).map(srcLabel);
    // The reader's floor is re-applied, not just its limit: hook and worker read
    // separate environments, and a tightened floor here must not be bypassed by
    // hits the worker admitted under a looser one. The typeof guards keep a
    // version-skewed inbox from crashing toFixed()/memKey downstream.
    const floored = kept.filter((h) =>
      typeof h.content === "string" && typeof h.source === "string" &&
      typeof h.score === "number" && h.score >= profile.floor);
    out.floorDropped = kept.length - floored.length;
    out.ready = floored.slice(0, profile.limit);
    const { hits: _hits, ...meta } = parsed;
    out.meta = meta;
  } catch {
    out.drainError = true;
    // A malformed CLAIMED file is post-atomic-rename, so it is an anomaly worth
    // an autopsy (version skew? worker bug?); keep it as .bad.
    try { renameSync(claim, `${claim}.bad`); } catch {}
  }
  try { unlinkSync(claim); } catch {} // ENOENT when renamed to .bad
  return out;
}

/**
 * One hit as a row, with per-stage numbers so no reader judges calibration on
 * the conflated final: rerank = final cross-encoder; rrf = fused recall
 * (pre-rerank); mmr = pick order, pre-MMR weight rank (w#) and redundancy at
 * pick time, omitted when MMR was bypassed; rec = recency factor with the
 * effective last-accessed age it decays from ("seen" — surfacing bumps it).
 * An absent stage value renders "?", never a fabricated 0 that reads as measured.
 */
export function recallRow(h: SearchResult, now = Date.now()): string {
  const fmt = (v: number | undefined, digits: number) => (v != null ? v.toFixed(digits) : "?");
  const ageLabel = (ts?: string): string => {
    if (!ts) return "evergreen";
    const d = (now - Date.parse(ts)) / 86_400_000;
    return Number.isNaN(d) ? "evergreen" : d < 1 ? "<1d ago" : `${Math.round(d)}d ago`;
  };
  const mmrSeg = h.mmrPick != null ? ` · mmr (#${h.mmrPick} · w#${h.wRank ?? "?"} · sim ${fmt(h.mmrSim, 2)})` : "";
  // Raw content can quote the literal closing tag (the corpus holds web pages
  // and transcripts); escape any case-variant so a hit can't end the block
  // early and pass itself off as post-recall context.
  const excerpt = sanitizeInline(h.content).slice(0, 220);
  return `- rerank ${h.score.toFixed(2)} · rrf ${fmt(h.rrf, 3)}${mmrSeg} · rec (${fmt(h.recency, 2)} · seen ${ageLabel(h.timestamp)}) — ${srcLabel(h)}\n  ${excerpt}`;
}

/** The model-facing block. RAW content is injected; scrubbing is query-only. */
export function recallBlock(chunks: SearchResult[]): string {
  return "<macrodata-recall>\n" + chunks.map((h) => recallRow(h)).join("\n") + "\n</macrodata-recall>";
}
