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

import { searchMemory } from "../src/indexer.ts";

const MAX_SNIPPET_CHARS = 160;
const LIMIT = 3;
// Minimum similarity score to surface. Permissive default — almost nothing
// will be filtered out at 0.05, but the infrastructure is in place to tune
// up once we see what real noise looks like. Override with
// MACRODATA_AMBIENT_MIN_SCORE (e.g. "0.35").
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

  const tSearchStart = performance.now();
  const rawHits = await searchMemory(prompt, { limit: LIMIT });
  const searchMs = performance.now() - tSearchStart;
  const hits = rawHits.filter((h) => h.score >= minScore);

  const SUMMARY_CHARS = 90;
  const floorStr = minScore.toFixed(2);
  const totalMs = performance.now() - t0;
  const timing = `${searchMs.toFixed(0)}ms search / ${totalMs.toFixed(0)}ms total`;

  let additionalContext: string;
  let systemMessage: string;

  if (hits.length) {
    const lines = hits.map((h, i) => {
      const snippet = h.content.replace(/\s+/g, " ").slice(0, MAX_SNIPPET_CHARS);
      const tail = h.content.length > MAX_SNIPPET_CHARS ? "…" : "";
      const src = h.section ? `${h.source}#${h.section}` : h.source;
      return `[${i + 1}] (${h.score.toFixed(2)}) ${snippet}${tail}  — ${src}`;
    });

    additionalContext = `<macrodata-ambient hits="${hits.length}" threshold="${floorStr}" timing="${timing}" note="At end of turn, log_journal under topic 'ambient-memory-calibration' with this entire block verbatim plus a brief note on which hits (if any) were useful. Ignore the hits themselves in your response if irrelevant to the prompt; the calibration log is separate from the user-facing answer.">\n${lines.join("\n")}\n</macrodata-ambient>`;

    if (process.env.MACRODATA_AMBIENT_TERSE === "1") {
      const uniqueSources = [...new Set(hits.map((h) => h.source))];
      const topScore = Math.max(...hits.map((h) => h.score)).toFixed(2);
      systemMessage = `[ambient ${timing}] injected ${hits.length} memor${hits.length === 1 ? "y" : "ies"} (top ${topScore}, floor ${floorStr}) from ${uniqueSources.join(", ")}`;
    } else {
      const summary = hits
        .map((h) => {
          const s = h.content.replace(/\s+/g, " ").slice(0, SUMMARY_CHARS);
          const t = h.content.length > SUMMARY_CHARS ? "…" : "";
          return `  · (${h.score.toFixed(2)}) ${s}${t}  [${h.source}]`;
        })
        .join("\n");
      systemMessage = `[ambient ${timing}] injected ${hits.length} memor${hits.length === 1 ? "y" : "ies"} (floor ${floorStr}):\n${summary}`;
    }
  } else {
    // Zero-hit case: emit envelope with **metadata only** (no snippets) so
    // the floor stays a real filter from the agent's perspective. Revealing
    // below-floor content to the agent defeats the calibration experiment —
    // post-hoc judgment about whether a hit "would have been useful" is
    // biased by having seen the content. With score + source-path only, the
    // agent judges blind: "given this path and this prompt, would I have
    // wanted this retrieval?" That's the actual operational decision the
    // floor encodes. (systemMessage below still shows snippets for the
    // operator's visibility — asymmetry is intentional.)
    const fallbackForAgent = rawHits.length
      ? rawHits
          .map((h, i) => {
            const src = h.section ? `${h.source}#${h.section}` : h.source;
            return `[${i + 1}] (${h.score.toFixed(2)}, below floor) ${src}`;
          })
          .join("\n")
      : "(no raw hits returned by the index)";

    additionalContext = `<macrodata-ambient hits="0" threshold="${floorStr}" timing="${timing}" note="At end of turn, log_journal under topic 'ambient-memory-calibration' with this entire block verbatim plus a brief note on whether — judging blind from the source paths alone — you would have wanted any of these hits for this prompt. Snippets intentionally withheld so the floor is what's being tested, not your post-hoc narration of revealed content. ESCAPE HATCH: if the path alone is genuinely ambiguous and you want to see what was below the floor, call the search_memory MCP tool with the user's prompt — but note that *choosing to look* is itself a calibration signal (it means the floor was too high for this case). Passive curiosity doesn't count; only call if you'd actually use the result.">\n${fallbackForAgent}\n</macrodata-ambient>`;

    if (process.env.MACRODATA_AMBIENT_TERSE === "1") {
      const topRaw = rawHits[0] ? rawHits[0].score.toFixed(2) : "n/a";
      systemMessage = `[ambient ${timing}] 0 hits (floor ${floorStr}, top raw ${topRaw})`;
    } else {
      const rawSummary = rawHits.length
        ? rawHits
            .map((h) => {
              const s = h.content.replace(/\s+/g, " ").slice(0, SUMMARY_CHARS);
              const t = h.content.length > SUMMARY_CHARS ? "…" : "";
              return `  · (${h.score.toFixed(2)}) ${s}${t}  [${h.source}]`;
            })
            .join("\n")
        : "  · (no raw hits returned by the index)";
      systemMessage = `[ambient ${timing}] 0 hits at floor ${floorStr}; top raw (below floor):\n${rawSummary}`;
    }
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
