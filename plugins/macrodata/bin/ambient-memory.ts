#!/usr/bin/env bun
/**
 * Ambient associative memory hook (spike).
 *
 * Wired to UserPromptSubmit in ~/.claude/settings.json. Reads Claude Code's
 * hook envelope from stdin, embeds the user's prompt, runs a top-3 search
 * against macrodata's vector index, and emits the hits as an additional
 * context block. Fails silently on any error — never blocks the prompt.
 *
 * Off-switch: set MACRODATA_AMBIENT_DISABLE=1 in env to skip entirely.
 *
 * Inspired by Tim Kellogg's "Ambient Associative Memory" (2026-05-17). See
 * gest task `yxxsnxkv` and artifact `zqxxwnls` for the design rationale.
 */

// Silence indexer/embedder `console.log` chatter — anything written to stdout
// from this script becomes injected context, and we only want the search hits.
// Restored before we emit our own output (we use process.stdout.write, not
// console.log, so the silencing stays in effect for the rest of the run).
console.log = () => {};
console.info = () => {};

import { searchMemory, type SearchResult } from "../src/indexer.ts";

const MAX_SNIPPET_CHARS = 160;
const LIMIT = 3;
// Candidate slate width handed from the bi-encoder to the cross-encoder. This
// is the hard recall ceiling — answers ranked beyond this position by cosine
// can't be promoted by rerank because the cross-encoder never sees them.
// Bumped from indexer's default of 20 to 40 to give title-less section chunks
// a better shot at landing in the slate before title-prepend ships. Cost is
// one extra forward pass through MiniLM-L-6 per item beyond 20. Override with
// MACRODATA_AMBIENT_CANDIDATE_K (e.g. "20" to revert, "80" to push further).
const DEFAULT_CANDIDATE_K = 40;
// Minimum similarity score to surface. Permissive default — almost nothing
// will be filtered out at 0.05, but the infrastructure is in place to tune
// up once we see what real noise looks like. Override with
// MACRODATA_AMBIENT_MIN_SCORE (e.g. "0.35").
//
// When MACRODATA_AMBIENT_RERANK=1, `score` on each hit is the cross-encoder
// sigmoid'd output, not bi-encoder cosine. Both are nominally in [0, 1] but
// the distributions differ — expect to recalibrate the floor for reranked
// runs (cross-encoder relevant docs commonly score >0.9).
const DEFAULT_MIN_SCORE = 0.05;

async function main() {
  if (process.env.MACRODATA_AMBIENT_DISABLE === "1") return;

  const t0 = performance.now();
  const raw = await Bun.stdin.text();
  if (!raw.trim()) return;

  let prompt: string | undefined;
  try {
    const env = JSON.parse(raw) as { prompt?: string };
    prompt = env.prompt?.trim();
  } catch {
    return;
  }
  if (!prompt) return;

  const minScoreRaw = process.env.MACRODATA_AMBIENT_MIN_SCORE;
  const parsedMin = minScoreRaw ? Number(minScoreRaw) : NaN;
  const minScore = Number.isFinite(parsedMin) ? parsedMin : DEFAULT_MIN_SCORE;

  const doRerank = process.env.MACRODATA_AMBIENT_RERANK === "1";
  const doDual = process.env.MACRODATA_AMBIENT_DUAL === "1";

  const candidateKRaw = process.env.MACRODATA_AMBIENT_CANDIDATE_K;
  const parsedCandidateK = candidateKRaw ? Number(candidateKRaw) : NaN;
  const candidateK =
    Number.isFinite(parsedCandidateK) && parsedCandidateK > 0
      ? Math.floor(parsedCandidateK)
      : DEFAULT_CANDIDATE_K;

  const tSearchStart = performance.now();
  const rawHits = await searchMemory(prompt, { limit: LIMIT, rerank: doRerank, candidateK });
  const searchMs = performance.now() - tSearchStart;
  const hits = rawHits.filter((h) => h.score >= minScore);

  // Optional dual-mode eval: also fetch vector-only ordering so the calibration
  // log captures the diff. Costs one extra embed + Vectra query; skips the
  // cross-encoder pass on this second call.
  let dualVectorHits: SearchResult[] | null = null;
  if (doDual && doRerank) {
    try {
      dualVectorHits = await searchMemory(prompt, { limit: LIMIT, rerank: false });
    } catch {
      // Eval logging is best-effort; never block the prompt.
    }
  }

  const SUMMARY_CHARS = 90;
  const floorStr = minScore.toFixed(2);
  const totalMs = performance.now() - t0;
  const mode = doRerank ? (doDual ? "rerank+dual" : "rerank") : "vector";
  const timing = `${searchMs.toFixed(0)}ms search / ${totalMs.toFixed(0)}ms total / mode=${mode}`;

  // Build the dual-mode eval block once — appended to additionalContext and
  // systemMessage when present. Shape: vector-only top-3 alongside reranked
  // top-3 so the end-of-turn calibration log captures what rerank changed.
  let dualBlock = "";
  if (dualVectorHits && dualVectorHits.length) {
    const lines = dualVectorHits.map((h, i) => {
      const snippet = h.content.replace(/\s+/g, " ").slice(0, MAX_SNIPPET_CHARS);
      const tail = h.content.length > MAX_SNIPPET_CHARS ? "…" : "";
      const src = h.section ? `${h.source}#${h.section}` : h.source;
      return `[v${i + 1}] (${h.score.toFixed(2)}) ${snippet}${tail}  — ${src}`;
    });
    dualBlock = `\n<macrodata-ambient-eval-vector note="Top-${LIMIT} by bi-encoder cosine for the same prompt — compare against the reranked block above. If the reranker promoted something genuinely better, note it; if it shuffled order without improving relevance, note that too.">\n${lines.join("\n")}\n</macrodata-ambient-eval-vector>`;
  }

  // Unified envelope: always show the full top-K slate with snippets, marking
  // each entry's relation to the floor. Earlier versions hid snippets when
  // nothing cleared the floor (to keep calibration "blind"); empirically that
  // made calibration harder, not easier — Caleb needs to see what's up there
  // to judge whether the floor is set right. The dual-mode block carries the
  // structural comparison signal now, not the snippet-hiding asymmetry.
  const aboveCount = hits.length;
  const totalCount = rawHits.length;

  const lines = rawHits.length
    ? rawHits.map((h, i) => {
        const snippet = h.content.replace(/\s+/g, " ").slice(0, MAX_SNIPPET_CHARS);
        const tail = h.content.length > MAX_SNIPPET_CHARS ? "…" : "";
        const src = h.section ? `${h.source}#${h.section}` : h.source;
        const above = h.score >= minScore;
        const scorePart =
          h.rerankScore !== undefined && h.vectorScore !== undefined
            ? `${h.vectorScore.toFixed(2)}→${h.rerankScore.toFixed(2)}`
            : h.score.toFixed(2);
        const marker = above ? "" : ", below";
        return `[${i + 1}] (${scorePart}${marker}) ${snippet}${tail}  — ${src}`;
      })
    : ["(no candidates returned by the index)"];

  const note =
    aboveCount > 0
      ? `At end of turn, log_journal under topic 'ambient-memory-calibration' with this entire block verbatim plus a brief note on which hits (if any) were actually useful and whether the floor (${floorStr}) felt right. Entries marked "below" were under the floor — included for floor-calibration visibility, treat as informational only. Ignore the hits themselves in your response if irrelevant to the prompt.`
      : `At end of turn, log_journal under topic 'ambient-memory-calibration' with this entire block verbatim plus a brief note on whether any of the below-floor entries would have been useful (suggesting the floor is too high) or whether none were relevant (floor is doing its job). The dual-mode block, if present, shows what rerank changed vs. bi-encoder alone.`;

  const additionalContext = `<macrodata-ambient hits="${aboveCount}/${totalCount}" threshold="${floorStr}" timing="${timing}" note="${note}">\n${lines.join("\n")}\n</macrodata-ambient>${dualBlock}`;

  const formatScore = (h: SearchResult) => {
    const part =
      h.rerankScore !== undefined && h.vectorScore !== undefined
        ? `${h.vectorScore.toFixed(2)}→${h.rerankScore.toFixed(2)}`
        : h.score.toFixed(2);
    return h.score >= minScore ? part : `${part}, below`;
  };

  let systemMessage: string;
  if (process.env.MACRODATA_AMBIENT_TERSE === "1") {
    const topHit = rawHits[0];
    const topScore = topHit ? formatScore(topHit) : "n/a";
    const sources = [...new Set(rawHits.map((h) => h.source))];
    systemMessage = `[ambient ${timing}] ${aboveCount}/${totalCount} above floor ${floorStr} (top ${topScore})${sources.length ? ` from ${sources.join(", ")}` : ""}`;
  } else {
    const summary = rawHits.length
      ? rawHits
          .map((h) => {
            const s = h.content.replace(/\s+/g, " ").slice(0, SUMMARY_CHARS);
            const t = h.content.length > SUMMARY_CHARS ? "…" : "";
            return `  · (${formatScore(h)}) ${s}${t}  [${h.source}]`;
          })
          .join("\n")
      : "  · (no candidates returned by the index)";
    systemMessage = `[ambient ${timing}] ${aboveCount}/${totalCount} above floor ${floorStr}:\n${summary}`;
  }

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
  if (process.env.MACRODATA_AMBIENT_DEBUG === "1") {
    process.stderr.write(`[ambient-memory] ${String(err)}\n`);
  }
});
