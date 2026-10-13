/**
 * Recall verdicts — the agent's structured judgment of injected recall hits.
 *
 * Verdicts are meta-memory, so they live in `.recall/verdicts.jsonl`, never in
 * the journal: a journaled verdict quotes the hits it grades and gets recalled
 * in their place. Rows are append-only like the access log, so the MCP server
 * and the hook never clobber each other. `key` is the hit's `memKey`, which the
 * hook prints on each recall row.
 */

import { appendFileSync, mkdirSync } from "fs";
import { getRecallDir, getVerdictLog } from "./config.ts";
import { recordAccess } from "./access.ts";

export const VERDICTS = ["useful", "reminder", "redundant", "off-topic", "stale"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface VerdictInput {
  key: string;
  verdict: Verdict;
  note?: string;
}

/**
 * Access-event kind a verdict records, or null when it records none. Neither kind
 * is in the default REFRESH_KINDS, so verdicts leave ranking alone until
 * MACRODATA_RECALL_REFRESH_KINDS opts in; until then they are measurement only.
 */
export function clockEvent(verdict: Verdict): string | null {
  switch (verdict) {
    case "useful":
      return "referenced";
    case "off-topic":
    case "stale":
      return "rejected";
    // A reminder was worth one nudge, not more of them; redundant says the
    // context already held it, which is nothing about the memory itself.
    case "reminder":
    case "redundant":
      return null;
  }
}

export function recordVerdicts(verdicts: VerdictInput[], note: string | undefined, ts: string): void {
  if (verdicts.length === 0 && !note) return;
  mkdirSync(getRecallDir(), { recursive: true });
  // A slate-level note is its own row with no key: it describes the turn, not a hit.
  const rows: object[] = verdicts.map((v) => ({ ts, key: v.key, verdict: v.verdict, ...(v.note && { note: v.note }) }));
  if (note) rows.push({ ts, note });
  appendFileSync(getVerdictLog(), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  for (const v of verdicts) {
    const kind = clockEvent(v.verdict);
    if (kind) recordAccess([v.key], kind, ts);
  }
}
