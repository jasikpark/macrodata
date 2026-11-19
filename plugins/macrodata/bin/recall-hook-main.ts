/**
 * Ambient-recall hook — fires on UserPromptSubmit, PostToolUse
 * (Read/WebSearch/WebFetch), and Stop.
 *
 * Reads a Claude Code hook envelope on stdin, builds a scrubbed query from the
 * current context, runs the retrieval pipeline (vector + FTS + RRF + recency +
 * in-process rerank + floor), and — only if something clears the floor — emits
 * an additionalContext block. Stays SILENT otherwise (the whole point: no
 * noise). EXPECTED errors (missing files, lost claim races, malformed inbox
 * hits) degrade silently; an UNEXPECTED error fails LOUDLY — visible stderr +
 * exit 1 — but never BLOCKS: exit 1 is Claude Code's non-blocking hook
 * failure (exit 2 would block the tool call; nothing here may exit 2).
 * Squeaky-gate policy (Caleb, 2026-07-23): a surprise bug should announce
 * itself per-fire until fixed, not silently disable recall.
 *
 * Modes (MACRODATA_RECALL_MODE): "async" (default) — mailbox protocol with
 * worker.ts; this process NEVER loads models. "sync" — run the pipeline inline,
 * which loads the GGUFs IN THIS per-fire process; debugging only. --query
 * always runs sync.
 *
 * Entered through bin/recall-hook.ts, which checks MACRODATA_RECALL_DISABLE
 * before this module's imports load.
 *
 * Manual test:  echo '{"tool_name":"Read","tool_input":{"file_path":"x/porrima.md"}}' | MACRODATA_RECALL_MODE=sync bun run bin/recall-hook.ts
 *          or:  bun run bin/recall-hook.ts --query "what is porrima"
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { pipelineSearch } from "../src/recall/fts.ts";
import { ambientProfile } from "../src/recall/profiles.ts";
import type { SearchResult } from "../src/recall/indexer.ts";
import { buildHookQuery, analyzeTranscript, scrubOperationalNoise } from "../src/recall/query.ts";
import { memKey, recordAccess } from "../src/recall/access.ts";
import { atomicWrite, claimInbox, recallBlock, recallRow, srcLabel } from "../src/recall/inbox.ts";
import {
  getCalibrationLog,
  getExcludePath,
  getInjectedPath,
  getMailboxDir,
  getRequestPath,
} from "../src/recall/config.ts";

const AMBIENT = ambientProfile();
const MIN_QUERY_CHARS = 8;

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
  const sid = (env.session_id || "").replace(/[^A-Za-z0-9_-]/g, "");

  // Mode: async (default) keeps models strictly in the worker; sync is the
  // explicit debug override (inline pipeline = per-fire model load). The old
  // MACRODATA_RECALL_ASYNC=1 wiring is subsumed by the async default.
  const MODE = qIdx >= 0 || process.env.MACRODATA_RECALL_MODE === "sync" ? "sync" : "async";

  // ONE transcript read per fire — query build AND compaction window come out
  // of the same parse (this used to be two full read+parse passes, a real tax
  // on the blocking path late in a long session).
  const ta = env.transcript_path ? analyzeTranscript(env.transcript_path) : null;

  // Real query = the surrounding conversation (wide search / tight rerank).
  let search: string, rerankQuery: string;
  if (event === "UserPromptSubmit") {
    // Turn-start: the just-submitted prompt is the rerank focus (user just
    // spoke); blend recent transcript context into the wide search. The window
    // already includes the prior assistant turn, so no separate Stop pass.
    const prompt = scrubOperationalNoise(typeof env.prompt === "string" ? env.prompt : "");
    const tq = ta?.query ?? { search: "", rerank: "" };
    search = `${prompt}\n${tq.search}`.slice(0, 6000);
    // Blend fresh prompt + recent trajectory — bare prompt is too thin a rerank
    // signal (the naive-prompt-as-query trap, this time at the rerank stage).
    rerankQuery = `${prompt} ${tq.rerank}`.slice(0, 900);
  } else if (ta) {
    const q = ta.query;
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

  // Both dirs are created up front: every write below assumes they exist, and on
  // a fresh state root nothing else has made them yet.
  mkdirSync(getMailboxDir(), { recursive: true });
  const injectedFile = sid ? getInjectedPath(sid) : "";
  const excludeFile = sid ? getExcludePath(sid) : "";

  // ---- Unified in-context EXCLUDE (Porrima inContextIds = frozen ∪ delta) ----
  // EXACT, content-keyed, scoped to the live COMPACTION WINDOW, and excluded in the
  // candidate POOL (pre-rerank) so fresh hits backfill → inject MORE, never less.
  //   delta  = chunks this session's hook injected WITHIN the window (injected-<sid>,
  //            stored {c,ts} so it window-scopes; Porrima deltaIds, resets at compaction).
  //   frozen = journal entries I AUTHORED in the window (`[topic] content` log_journal
  //            keys, byte-identical to the indexed form; Porrima frozenIds).
  // EXACT match only — we suppress ONLY what we provably produced/injected; anything
  // uncertain is injected (Caleb's under-cull). Written to exclude-<sid> so the
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
  // Comes from the SAME transcript parse as the query build (analyzeTranscript).
  const { windowStartTs, authoredKeys } = ta ?? { windowStartTs: "", authoredKeys: new Set<string>() };
  const persistInjected = (chunks: SearchResult[]): void => {
    if (!injectedFile) return;
    try {
      const now = new Date().toISOString();
      const loaded = loadInjected();
      // Prune pre-window + ts-less entries (ineligible) — PRIMARY growth bound. Lexical
      // ISO compare: both ts are canonical `…Z`+ms (toISOString), so lexical==chronological;
      // a format mismatch fails toward DROPPING (under-cull), never echo. cap(1000) is a
      // pathological backstop for a never-compacting mega-session — overshoot = harmless
      // echo (under-cull-safe). atomicWrite publishes whole files only; note a
      // concurrent fire's read-modify-write can still lose entries last-writer-
      // wins (under-cull-safe, tracked with the mailbox-robustness work).
      const kept = loaded.filter((e) => e.ts && (!windowStartTs || e.ts >= windowStartTs));
      // Nothing to add and nothing pruned means the file already says this.
      // Called on every fire, so writing unconditionally would rewrite it once
      // per prompt for the life of a session that injects nothing.
      if (chunks.length === 0 && kept.length === loaded.length) return;
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
  const logCalibration = (
    chunks: SearchResult[],
    extra: Record<string, unknown>,
    servedQuery?: { search?: string; rerankQuery?: string },
  ): void => {
    try {
      // Async injection lags ~1 fire, so a drained row's hits were reranked
      // against a PRIOR query, not this fire's. When the worker echoes back the
      // query it actually served, log THAT — otherwise the row pairs this fire's
      // `search` with the prior query's `hits` and any retrieval-quality read of
      // the log is judging the wrong query. This fire's own query isn't lost: it
      // was just enqueued and will surface as the served query of a later drain.
      const logSearch = servedQuery?.search ?? search;
      const logRerank = servedQuery?.rerankQuery ?? rerankQuery;
      appendFileSync(getCalibrationLog(), JSON.stringify({
        // sid segments fires by session — without it the N2 blind-cycle
        // adjacency test can't tell a real post-injection blackout from two
        // unrelated sessions interleaved in this shared flat log.
        ts: new Date().toISOString(), sid: sid || null, event, tool: env.tool_name ?? null,
        search: logSearch.slice(0, 300), rerankQuery: logRerank.slice(0, 200),
        n: chunks.length, ms: Date.now() - t0,
        scores: chunks.map((h) => Number(h.score.toFixed(3))), // back-compat: final score
        sources: chunks.map(srcLabel),
        // Per-STAGE breakdown so calibration sweeps can see WHY a hit ranked, not just
        // the conflated final: rerank (final cross-encoder), rrf (fused recall), recency factor.
        hits: chunks.map((h) => ({
          src: srcLabel(h),
          rerank: Number(h.score.toFixed(3)),
          rrf: h.rrf != null ? Number(h.rrf.toFixed(4)) : null,
          recency: h.recency != null ? Number(h.recency.toFixed(3)) : null,
          wRank: h.wRank ?? null,
          mmrPick: h.mmrPick ?? null,
          mmrSim: h.mmrSim != null ? Number(h.mmrSim.toFixed(3)) : null,
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
    // One row format for both surfaces, so the human sees exactly what the model got.
    const debugBlock = chunks.map((h) => recallRow(h)).join("\n");
    const visible = `[macrodata-recall] ${chunks.length} hit(s) from ${env.tool_name ?? event} · recency ${AMBIENT.halfLifeDays}d half-life · ${tag}\n${debugBlock}`;
    process.stdout.write(JSON.stringify({
      systemMessage: visible,
      hookSpecificOutput: { hookEventName: event, additionalContext: recallBlock(chunks) },
    }));
    process.exit(0);
  };

  // ---- STOP = PRIME-ONLY, in EVERY mode. Enqueue the just-ended turn's
  // context so the worker reranks during the idle gap before the user's next
  // prompt — but DON'T drain or inject. Two reasons: (1) a Stop hook emitting
  // additionalContext can re-trigger the turn → loop (mode-independent: the
  // sync path must not inject on Stop either); (2) draining without injecting
  // would throw away a computed result. The next UserPromptSubmit drains this
  // primed inbox → near-zero felt latency. (Trivial turns were already filtered
  // by the thinking/text gate above, so we only prime substantial turns.)
  if (event === "Stop") {
    if (sid) {
      try {
        atomicWrite(getRequestPath(sid),
          JSON.stringify({ sid, search, rerankQuery, ts: new Date().toISOString(), primedBy: "Stop" }));
      } catch {}
      logCalibration([], { mode: "stop-prime" });
    }
    emitSilent(); // zero output → cannot loop
  }

  // ---- ASYNC mode (default): drain the inbox (a PRIOR fire's results), enqueue
  // THIS query for the worker, exit fast. The slow rerank never blocks the tool;
  // results surface one fire later (3fz competitive injection).
  if (MODE === "async") {
    // Drain accounting (drained, filteredInContext, filteredSrc, floorDropped,
    // drainError) feeds calibration; see Claim in src/recall/inbox.ts.
    const { ready, meta, drained, filteredInContext, filteredSrc, floorDropped, drainError } =
      claimInbox(sid, excludeSet, AMBIENT);
    // Enqueue THIS turn's context for the worker (latest-wins; worker consumes).
    if (sid) {
      try { atomicWrite(getRequestPath(sid),
        JSON.stringify({ sid, search, rerankQuery, ts: new Date().toISOString() })); } catch {}
    }
    // Outside the ready check: the prune above is the growth bound, and a fire
    // that injects nothing is exactly the fire that has entries to drop — a
    // compaction moves the window without producing a hit, and pruning only when
    // something is added means the file keeps every pre-window entry until the
    // next injection, which may be many prompts away or never.
    persistInjected(ready);
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
      logCalibration(
        ready,
        { mode: "async", offPathMs: offPath, queryToServeMs: span, fastMs, drained, filteredInContext, filteredSrc, floorDropped, excludeSize: excludeSet.size, drainError },
        { search: meta.servedSearch, rerankQuery: meta.servedRerankQuery },
      );
      emitHits(ready, tag);
    }
    // Nothing to inject this fire, but we enqueued the current context for the
    // worker. Surface the enqueue (log + UI) so the async lifecycle is visible —
    // but WITHOUT additionalContext, so the model isn't fed empty noise. (When
    // there's no sid we couldn't enqueue, so stay truly silent.)
    if (sid) {
      const fastMs = Date.now() - t0;
      // Pass the served query here too: when the exclude filtered EVERYTHING
      // (drained>0, n:0 — the N2 blackout signature this row exists to catch),
      // the counters must pair with the query that produced the suppressed
      // hits, not this fire's. On a pure-enqueue row meta is {} and the
      // undefined fields fall back to this fire's query, which is then correct.
      logCalibration(
        [],
        { mode: "async-enqueue", fastMs, drained, filteredInContext, filteredSrc, floorDropped, excludeSize: excludeSet.size, drainError },
        { search: meta.servedSearch, rerankQuery: meta.servedRerankQuery },
      );
      const visible = `[macrodata-recall] queued from ${env.tool_name ?? event} · reranking off-path, nothing ready yet (this fire ${fastMs}ms)`;
      process.stdout.write(JSON.stringify({
        systemMessage: visible,
        hookSpecificOutput: { hookEventName: event },
      }));
      process.exit(0);
    }
    emitSilent();
  }

  // ---- SYNC mode (MACRODATA_RECALL_MODE=sync, or --query): run the full
  // pipeline inline — loads the GGUF models IN THIS per-fire process. Debug and
  // manual-CLI use only; wired sessions should always run async.
  let hits: SearchResult[] = [];
  const tPipe = Date.now();
  try {
    hits = await pipelineSearch(search, AMBIENT, { rerankQuery, exclude: excludeSet });
  } catch {
    emitSilent(); // servers down / error — never block the tool
  }
  const pipeMs = Date.now() - tPipe;
  logCalibration(hits, { mode: "sync", pipeMs });
  if (hits.length === 0) emitSilent(); // nothing fresh + relevant
  persistInjected(hits);
  emitHits(hits, `${Date.now() - t0}ms (pipeline ${pipeMs}ms)`);
}

// Intentional squeak, not an accident of a floating promise: an unexpected
// throw prints one attributed line + the stack and exits 1 (non-blocking,
// user-visible) instead of surfacing as a bare unhandled-rejection dump.
main().catch((e) => {
  console.error(`[macrodata-recall] hook failed (unexpected): ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
