#!/usr/bin/env bun
/**
 * DEPRECATED 2026-05-22 — DELETE ME.
 *
 * Unregistered in plugin.json on 2026-05-22 after ~3h of burn-in showed
 * qmd reranker reliably confident on entity-named prompts (qmd.md @ 0.93)
 * but confidently wrong on social/short prompts ("nah" → INDEX.md @ 0.88),
 * with 6–28s latency variance. Replaced by `bin/suggest-memory-tools.sh`,
 * which nudges the model to call qmd's `query` MCP tool intentionally.
 *
 * Kept in-tree (rather than git rm'd immediately) so the parallel-A/B
 * scaffolding isn't lost — useful reference if we revisit qmd-as-hook later.
 * If you find this and the deprecation is older than a couple months, delete
 * this file + the bi-encoder sibling.
 *
 * Original docstring follows.
 *
 * Ambient memory hook (qmd sibling).
 *
 * Runs in parallel with ambient-memory.ts. Calls the @tobilu/qmd JS API
 * against the same on-disk index the `qmd` CLI populated, so we can A/B
 * retrieval quality at the prompt level. Distinct envelope tag and
 * calibration topic keep the two streams disambiguated.
 *
 * Off-switch: MACRODATA_AMBIENT_QMD_DISABLE=1
 */

console.log = () => {};
console.info = () => {};

import { createStore, type HybridQueryResult } from "@tobilu/qmd";
import { homedir } from "node:os";
import { join } from "node:path";

const LIMIT = 3;
const MAX_SNIPPET_CHARS = 160;
const DEFAULT_MIN_SCORE = 0.5;
const DEFAULT_DB_PATH = join(homedir(), ".cache", "qmd", "index.sqlite");

async function main() {
  if (process.env.MACRODATA_AMBIENT_QMD_DISABLE === "1") return;

  const t0 = performance.now();
  const raw = await Bun.stdin.text();
  if (!raw.trim()) return;

  let prompt: string | undefined;
  try {
    prompt = (JSON.parse(raw) as { prompt?: string }).prompt?.trim();
  } catch {
    return;
  }
  if (!prompt) return;

  const minScoreRaw = process.env.MACRODATA_AMBIENT_QMD_MIN_SCORE;
  const parsedMin = minScoreRaw ? Number(minScoreRaw) : NaN;
  const minScore = Number.isFinite(parsedMin) ? parsedMin : DEFAULT_MIN_SCORE;
  const dbPath = process.env.MACRODATA_AMBIENT_QMD_DB ?? DEFAULT_DB_PATH;

  const store = await createStore({ dbPath });
  let hits: HybridQueryResult[] = [];
  let searchMs = 0;
  try {
    const tSearchStart = performance.now();
    hits = await store.search({
      query: prompt,
      limit: LIMIT,
      collections: ["macrodata", "macrodata-journal"],
    });
    searchMs = performance.now() - tSearchStart;
  } finally {
    await store.close();
  }

  if (!hits.length) return;

  const aboveCount = hits.filter((h) => h.score >= minScore).length;
  const totalCount = hits.length;
  const floorStr = minScore.toFixed(2);
  const totalMs = performance.now() - t0;
  const timing = `${searchMs.toFixed(0)}ms search / ${totalMs.toFixed(0)}ms total`;

  const lines = hits.map((h) => {
    const body = h.bestChunk || h.body || "";
    const snippet = body.replace(/\s+/g, " ").slice(0, MAX_SNIPPET_CHARS);
    const tail = body.length > MAX_SNIPPET_CHARS ? "…" : "";
    const src = h.displayPath || h.file;
    const above = h.score >= minScore;
    const marker = above ? "" : ", below";
    return ` · (${h.score.toFixed(2)}${marker}) ${snippet}${tail}  [${src}]`;
  });

  const note = `At end of turn, log_journal under topic 'ambient-memory-qmd-calibration' with this entire block verbatim plus a brief note on whether qmd's hits were more or less useful than the bi-encoder block above. Floor was ${floorStr}.`;

  const additionalContext = `<macrodata-ambient-qmd hits="${aboveCount}/${totalCount}" threshold="${floorStr}" timing="${timing}" note="${note}">\n${lines.join("\n")}\n</macrodata-ambient-qmd>`;

  const systemMessage = `[ambient-qmd ${timing}] ${aboveCount}/${totalCount} above floor ${floorStr}:\n${lines.join("\n")}`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
      systemMessage,
    }) + "\n",
  );
}

main().catch((err) => {
  if (process.env.MACRODATA_AMBIENT_QMD_DEBUG === "1") {
    process.stderr.write(`[ambient-memory-qmd] ${String(err)}\n`);
  }
});
