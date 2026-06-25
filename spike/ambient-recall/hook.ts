#!/usr/bin/env bun
/**
 * Ambient-recall PostToolUse hook (spike).
 *
 * Reads a Claude Code PostToolUse envelope on stdin, builds a scrubbed query
 * from the tool's intent, runs the full pipeline (vector :8080 + FTS + RRF +
 * rerank :8090 + floor), and — only if something clears the floor — emits an
 * additionalContext block. Stays SILENT otherwise (the whole point: no noise).
 * Fails silent on any error so it can never block a tool call.
 *
 * Manual test:  echo '{"tool_name":"Read","tool_input":{"file_path":"x/porrima.md"}}' | bun run hook.ts
 *          or:  bun run hook.ts --query "what is porrima"
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { pipelineSearch } from "./fts.ts";
import type { SearchResult } from "./indexer.ts";
import { buildHookQuery, buildTranscriptQuery, scrubOperationalNoise, inContextWindow } from "./query.ts";
import { memKey, recordAccess } from "./access.ts";

const FLOOR = Number(process.env.MACRODATA_RECALL_FLOOR ?? 0.5);
const LIMIT = Number(process.env.MACRODATA_RECALL_LIMIT ?? 3);
const MIN_QUERY_CHARS = 8;
// Sampled calibration: fraction of recall INJECTIONS that also ask the agent to
// journal a usefulness verdict. Rate-limited so it doesn't flood the turn with
// meta-tasks. 0 disables. This is the lossless human-judgment signal (distinct
// from the punted "was-it-referenced" inference) that feeds floor/recency tuning.
const VERDICT_RATE = Number(process.env.MACRODATA_RECALL_VERDICT_RATE ?? 0.25);

function emitSilent(): never {
  // No output = nothing injected.
  process.exit(0);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  let env: {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    transcript_path?: string;
    hook_event_name?: string;
    prompt?: string;
    session_id?: string;
  } = {};
  const qIdx = process.argv.indexOf("--query");
  if (qIdx >= 0) {
    env = { tool_name: "Manual", tool_input: { query: process.argv[qIdx + 1] } };
  } else if (!process.stdin.isTTY) {
    const raw = await Bun.stdin.text();
    if (raw.trim()) {
      try { env = JSON.parse(raw); } catch { emitSilent(); }
    }
  }

  const event = env.hook_event_name ?? "PostToolUse";

  // Real query = the surrounding conversation (wide search / tight rerank).
  let search: string, rerankQuery: string;
  if (event === "UserPromptSubmit") {
    // Turn-start: the just-submitted prompt is the rerank focus (user just
    // spoke); blend recent transcript context into the wide search. The window
    // already includes the prior assistant turn, so no separate Stop pass.
    const prompt = scrubOperationalNoise(typeof env.prompt === "string" ? env.prompt : "");
    const tq = env.transcript_path
      ? buildTranscriptQuery(env.transcript_path)
      : { search: "", rerank: "" };
    search = `${prompt}\n${tq.search}`.slice(0, 6000);
    // Blend fresh prompt + recent trajectory — bare prompt is too thin a rerank
    // signal (the naive-prompt-as-query trap, this time at the rerank stage).
    rerankQuery = `${prompt} ${tq.rerank}`.slice(0, 900);
  } else if (env.transcript_path) {
    const q = buildTranscriptQuery(env.transcript_path);
    search = q.search;
    rerankQuery = q.rerank;
    // Stop is registered as a PRIME-ONLY pass (see the async branch below +
    // settings.local.json): it enqueues the turn's context for the worker but
    // never drains/injects. Gate it on a substantial turn so we don't prime on
    // a trivial "ok"-sized response.
    if (event === "Stop") {
      if (!(q.latest.thinking >= 150 || q.latest.text >= 300)) emitSilent();
    } else {
      // Tool path: fold in the current tool's intent (the just-issued action).
      const intent = buildHookQuery(env);
      if (intent) { search = `${intent}\n${search}`.slice(0, 6000); rerankQuery = `${intent} ${rerankQuery}`.slice(0, 900); }
    }
  } else {
    search = buildHookQuery(env);
    rerankQuery = search;
  }
  if (search.length < MIN_QUERY_CHARS) emitSilent();

  const sid = (env.session_id || "").replace(/[^A-Za-z0-9_-]/g, "");
  const here = (name: string) => join(import.meta.dir, name);
  const injectedFile = sid ? here(`.recall-injected-${sid}.json`) : "";
  const excludeFile = sid ? here(`.recall-exclude-${sid}.json`) : "";
  const atomicWrite = (path: string, data: string): void => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  };

  // ---- Unified in-context EXCLUDE (Porrima inContextIds = frozen ∪ delta) ----
  // EXACT, content-keyed, scoped to the live COMPACTION WINDOW, and excluded in the
  // candidate POOL (pre-rerank) so fresh hits backfill → inject MORE, never less.
  //   delta  = chunks this session's hook injected WITHIN the window (.recall-injected,
  //            stored {c,ts} so it window-scopes; Porrima deltaIds, resets at compaction).
  //   frozen = journal entries I AUTHORED in the window (`[topic] content` log_journal
  //            keys, byte-identical to the indexed form; Porrima frozenIds).
  // EXACT match only — we suppress ONLY what we provably produced/injected; anything
  // uncertain is injected (Caleb's under-cull). Written to .recall-exclude-<sid> so the
  // worker (async path) excludes in its pool too. inContextWindow() handles the window.
  type Inj = { c: string; ts: string };
  const loadInjected = (): Inj[] => {
    if (!injectedFile || !existsSync(injectedFile)) return [];
    try {
      return (JSON.parse(readFileSync(injectedFile, "utf-8")) as unknown[])
        .map((e) => (typeof e === "string" ? { c: e, ts: "" } : (e as Inj))); // legacy string[] → ts-less
    } catch { return []; }
  };
  // Resolve the compaction window BEFORE persistInjected — that closure reads
  // windowStartTs, so it must be in scope first (no temporal-dead-zone trap).
  const { windowStartTs, authoredKeys } = env.transcript_path
    ? inContextWindow(env.transcript_path)
    : { windowStartTs: "", authoredKeys: new Set<string>() };
  const persistInjected = (chunks: SearchResult[]): void => {
    if (!injectedFile) return;
    try {
      const now = new Date().toISOString();
      // Prune pre-window + ts-less entries (ineligible) — PRIMARY growth bound. Lexical
      // ISO compare: both ts are canonical `…Z`+ms (toISOString), so lexical==chronological;
      // a format mismatch fails toward DROPPING (under-cull), never echo. cap(1000) is a
      // pathological backstop for a never-compacting mega-session — overshoot = harmless
      // echo (under-cull-safe). atomicWrite so concurrent fires can't tear the file.
      const kept = loadInjected().filter((e) => e.ts && (!windowStartTs || e.ts >= windowStartTs));
      for (const h of chunks) kept.push({ c: h.content, ts: now });
      atomicWrite(injectedFile, JSON.stringify(kept.slice(-1000)));
    } catch {}
  };
  const excludeSet = new Set<string>([
    // delta in-window: a ts-less (legacy) or pre-window injection is treated as NOT in
    // context (re-eligible) — conservative, under-cull. Lexical ISO compare (canonical
    // `…Z`+ms invariant; mismatch fails toward dropping = under-cull-safe).
    ...loadInjected().filter((e) => e.ts && (!windowStartTs || e.ts >= windowStartTs)).map((e) => e.c),
    ...authoredKeys,
  ]);
  try { if (excludeFile) atomicWrite(excludeFile, JSON.stringify([...excludeSet])); } catch {} // stay silent on ENOSPC/EACCES (matches every other write here)

  // Calibration log. `extra` carries mode + timing (sync: pipeMs; async:
  // offPathMs/queryToServeMs/fastMs) so the jsonl records both paths uniformly.
  const logCalibration = (chunks: SearchResult[], extra: Record<string, unknown>): void => {
    try {
      appendFileSync(here(".recall-calibration.jsonl"), JSON.stringify({
        ts: new Date().toISOString(), tool: env.tool_name ?? null,
        search: search.slice(0, 300), rerankQuery: rerankQuery.slice(0, 200),
        n: chunks.length, ms: Date.now() - t0,
        scores: chunks.map((h) => Number(h.score.toFixed(3))), // back-compat: final score
        sources: chunks.map((h) => h.section ?? h.source),
        // Per-STAGE breakdown so calibration sweeps can see WHY a hit ranked, not just
        // the conflated final: rerank (final cross-encoder), rrf (fused recall), recency factor.
        hits: chunks.map((h) => ({
          src: h.section ?? h.source,
          rerank: Number(h.score.toFixed(3)),
          rrf: h.rrf != null ? Number(h.rrf.toFixed(4)) : null,
          recency: h.recency != null ? Number(h.recency.toFixed(3)) : null,
          ageDays: h.timestamp ? Math.round((Date.now() - Date.parse(h.timestamp)) / 86_400_000) : null,
        })),
        ...extra,
      }) + "\n");
    } catch {}
  };

  // Format + emit a recall block, then exit. additionalContext -> model;
  // systemMessage -> user (so the human sees exactly what the model got, plus
  // the latency `tag`). RAW content is injected (scrubbing is query-only).
  const emitHits = (chunks: SearchResult[], tag: string): never => {
    // Record an access event per injected chunk (step 2: "surfaced" = touched).
    // This is the single injection point for both sync + async-drain paths.
    recordAccess(chunks.map(memKey), "surfaced", new Date().toISOString());
    // Age visibility: show each hit's age. Recency is a PRE-rerank candidate-
    // selection bias (Porrima placement), so the displayed score is the pure
    // cross-encoder relevance — an old hit with a high score survived on merit,
    // which is the gentler behavior we want to see. Entities are evergreen.
    const ageLabel = (ts?: string): string => {
      if (!ts) return "evergreen";
      const d = (Date.now() - Date.parse(ts)) / 86_400_000;
      return Number.isNaN(d) ? "evergreen" : d < 1 ? "<1d" : `${Math.round(d)}d`;
    };
    const halfLife = Number(process.env.MACRODATA_RECALL_HALFLIFE_DAYS ?? 30);
    const fmtWhere = (h: SearchResult) => (h.section ? `${h.source} › ${h.section}` : h.source);
    // CLEAN block → model (additionalContext): final score + age only, no diagnostics.
    const block =
      "<macrodata-recall>\n" +
      chunks.map((h) => `- (${h.score.toFixed(2)} · ${ageLabel(h.timestamp)}) ${fmtWhere(h)}\n  ${h.content.replace(/\s+/g, " ").slice(0, 220)}`).join("\n") +
      "\n</macrodata-recall>";
    // DEBUG block → human (systemMessage): per-STAGE numbers so calibration isn't judged
    // on the conflated final. rerank = final cross-encoder; rrf = fused recall score
    // (pre-rerank); rec = recency factor (0-1, pre-rerank candidate-selection only).
    const debugBlock = chunks.map((h) =>
      `- rerank ${h.score.toFixed(2)} · rrf ${(h.rrf ?? 0).toFixed(3)} · rec ${(h.recency ?? 1).toFixed(2)} · ${ageLabel(h.timestamp)} — ${fmtWhere(h)}\n  ${h.content.replace(/\s+/g, " ").slice(0, 220)}`
    ).join("\n");
    // Sampled calibration prompt: on ~VERDICT_RATE of injections, ask the agent to
    // journal a usefulness verdict. Goes in additionalContext (model-facing) so the
    // agent acts on it; the human sees a marker in systemMessage. Reinstates the
    // first-iteration ambient-memory-calibration loop (cf. feedback_ambient_calibration),
    // now sampled to avoid flooding the turn.
    const askVerdict = VERDICT_RATE > 0 && Math.random() < VERDICT_RATE;
    const verdictGuidance = askVerdict
      ? `\n<recall-calibration sampled="~${Math.round(VERDICT_RATE * 100)}%">\n` +
        `Were any of the above relevant to what you're doing right now? Before the turn ends, ` +
        `log a one-line verdict via log_journal(topic="ambient-memory-calibration"): the scores + ` +
        `useful | off-topic + why. (Sampled, so it won't fire every recall.)\n</recall-calibration>`
      : "";
    const visible = `[macrodata-recall] ${chunks.length} hit(s) from ${env.tool_name ?? event} · recency ${halfLife}d half-life · ${tag}${askVerdict ? " · ⊙ verdict requested" : ""}\n${debugBlock}`;
    process.stdout.write(JSON.stringify({
      systemMessage: visible,
      hookSpecificOutput: { hookEventName: event, additionalContext: block + verdictGuidance },
    }));
    process.exit(0);
  };

  // ---- ASYNC path: drain the inbox (a PRIOR fire's results), enqueue THIS
  // query for the worker, exit fast. The slow rerank never blocks the tool;
  // results surface one fire later (3fz competitive injection).
  if (process.env.MACRODATA_RECALL_ASYNC === "1") {
    // STOP = PRIME-ONLY. Enqueue the just-ended turn's context so the worker
    // reranks during the idle gap before the user's next prompt — but DON'T
    // drain or inject. Two reasons: (1) a Stop hook emitting additionalContext
    // can re-trigger the turn → loop; (2) draining without injecting would
    // throw away a computed result. The next UserPromptSubmit drains this primed
    // inbox → near-zero felt latency. (Trivial turns were already filtered by
    // the thinking/text gate above, so we only prime substantial turns.)
    if (event === "Stop") {
      if (sid) {
        try {
          atomicWrite(here(`.recall-request-${sid}.json`),
            JSON.stringify({ sid, search, rerankQuery, ts: new Date().toISOString(), primedBy: "Stop" }));
        } catch {}
        logCalibration([], { mode: "stop-prime" });
      }
      emitSilent(); // zero output → cannot loop
    }

    const inbox = sid ? here(`.recall-inbox-${sid}.json`) : "";
    let ready: SearchResult[] = [];
    let meta: { requestedAt?: string; servedAt?: string; pipelineMs?: number } = {};
    if (inbox && existsSync(inbox)) {
      try {
        const parsed = JSON.parse(readFileSync(inbox, "utf-8")) as
          { requestedAt?: string; servedAt?: string; pipelineMs?: number; hits: SearchResult[] };
        ready = (parsed.hits || []).filter((h) => !excludeSet.has(h.content)).slice(0, LIMIT);
        meta = parsed;
      } catch {}
      try { unlinkSync(inbox); } catch {}
    }
    // Enqueue THIS turn's context for the worker (latest-wins; worker consumes).
    if (sid) {
      try { atomicWrite(here(`.recall-request-${sid}.json`),
        JSON.stringify({ sid, search, rerankQuery, ts: new Date().toISOString() })); } catch {}
    }
    if (ready.length > 0) {
      // Span: when the served query was enqueued → when the worker served it.
      // offPath = the rerank cost the tool call NEVER paid; fast = what this
      // hook invocation actually cost (the only latency the agent felt).
      const fastMs = Date.now() - t0;
      const offPath = meta.pipelineMs ?? 0;
      const t1 = meta.requestedAt ? Date.parse(meta.requestedAt) : NaN;
      const t2 = meta.servedAt ? Date.parse(meta.servedAt) : NaN;
      const clk = (iso?: string) => (iso ? iso.slice(11, 23) : "?"); // HH:MM:SS.mmm
      const span = Number.isFinite(t1) && Number.isFinite(t2) ? `${t2 - t1}ms` : "?";
      const tag =
        `async · saved ~${offPath}ms off-path (this fire ${fastMs}ms) · ` +
        `query ${clk(meta.requestedAt)} → served ${clk(meta.servedAt)} (${span})`;
      logCalibration(ready, { mode: "async", offPathMs: offPath, queryToServeMs: span, fastMs });
      persistInjected(ready);
      emitHits(ready, tag);
    }
    // Nothing to inject this fire, but we enqueued the current context for the
    // worker. Surface the enqueue (log + UI) so the async lifecycle is visible —
    // but WITHOUT additionalContext, so the model isn't fed empty noise. (When
    // there's no sid we couldn't enqueue, so stay truly silent.)
    if (sid) {
      const fastMs = Date.now() - t0;
      logCalibration([], { mode: "async-enqueue", fastMs });
      const visible = `[macrodata-recall] queued from ${env.tool_name ?? event} · reranking off-path, nothing ready yet (this fire ${fastMs}ms)`;
      process.stdout.write(JSON.stringify({
        systemMessage: visible,
        hookSpecificOutput: { hookEventName: event },
      }));
      process.exit(0);
    }
    emitSilent();
  }

  // ---- SYNC path (default): run the full pipeline inline (blocks ~5s).
  let hits: SearchResult[] = [];
  const tPipe = Date.now();
  try {
    hits = await pipelineSearch(search, { limit: LIMIT, floor: FLOOR, rerankQuery, exclude: excludeSet });
  } catch {
    emitSilent(); // servers down / error — never block the tool
  }
  const pipeMs = Date.now() - tPipe;
  logCalibration(hits, { mode: "sync", pipeMs });
  if (hits.length === 0) emitSilent(); // nothing fresh + relevant
  persistInjected(hits);
  emitHits(hits, `${Date.now() - t0}ms (pipeline ${pipeMs}ms)`);
}

main();
