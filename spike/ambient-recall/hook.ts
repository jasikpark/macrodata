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
import { buildHookQuery, buildTranscriptQuery, scrubOperationalNoise } from "./query.ts";

const FLOOR = Number(process.env.MACRODATA_RECALL_FLOOR ?? 0.5);
const LIMIT = Number(process.env.MACRODATA_RECALL_LIMIT ?? 3);
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

  // Cross-turn dedup: chunks already injected THIS session, keyed on CONTENT
  // (journal SearchResults lack a section, so source§section would collapse a
  // day's journal to one key). Used as a rerank EXCLUDE set (dropped before
  // rerank so repeats don't occupy top-N and starve fresh chunks). Session-keyed
  // file spans PostToolUse + UserPromptSubmit; new session = fresh set.
  const sid = (env.session_id || "").replace(/[^A-Za-z0-9_-]/g, "");
  const here = (name: string) => join(import.meta.dir, name);
  const injectedFile = sid ? here(`.recall-injected-${sid}.json`) : "";
  const loadSeen = (): Set<string> => {
    if (!injectedFile || !existsSync(injectedFile)) return new Set();
    try { return new Set(JSON.parse(readFileSync(injectedFile, "utf-8")) as string[]); } catch { return new Set(); }
  };
  const persistSeen = (chunks: SearchResult[]): void => {
    if (!injectedFile) return;
    try {
      const seen = loadSeen();
      for (const h of chunks) seen.add(h.content);
      writeFileSync(injectedFile, JSON.stringify([...seen]));
    } catch {}
  };
  const atomicWrite = (path: string, data: string): void => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  };

  // Calibration log. `extra` carries mode + timing (sync: pipeMs; async:
  // offPathMs/queryToServeMs/fastMs) so the jsonl records both paths uniformly.
  const logCalibration = (chunks: SearchResult[], extra: Record<string, unknown>): void => {
    try {
      appendFileSync(here(".recall-calibration.jsonl"), JSON.stringify({
        ts: new Date().toISOString(), tool: env.tool_name ?? null,
        search: search.slice(0, 300), rerankQuery: rerankQuery.slice(0, 200),
        n: chunks.length, ms: Date.now() - t0,
        scores: chunks.map((h) => Number(h.score.toFixed(3))),
        sources: chunks.map((h) => h.section ?? h.source),
        ...extra,
      }) + "\n");
    } catch {}
  };

  // Format + emit a recall block, then exit. additionalContext -> model;
  // systemMessage -> user (so the human sees exactly what the model got, plus
  // the latency `tag`). RAW content is injected (scrubbing is query-only).
  const emitHits = (chunks: SearchResult[], tag: string): never => {
    const block =
      "<macrodata-recall>\n" +
      chunks.map((h) => {
        const where = h.section ? `${h.source} › ${h.section}` : h.source;
        const snippet = h.content.replace(/\s+/g, " ").slice(0, 220);
        return `- (${h.score.toFixed(2)}) ${where}\n  ${snippet}`;
      }).join("\n") +
      "\n</macrodata-recall>";
    const visible = `[macrodata-recall] ${chunks.length} new hit(s) from ${env.tool_name ?? event} · ${tag}\n${block}`;
    process.stdout.write(JSON.stringify({
      systemMessage: visible,
      hookSpecificOutput: { hookEventName: event, additionalContext: block },
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
        const seen = loadSeen();
        const parsed = JSON.parse(readFileSync(inbox, "utf-8")) as
          { requestedAt?: string; servedAt?: string; pipelineMs?: number; hits: SearchResult[] };
        ready = (parsed.hits || []).filter((h) => !seen.has(h.content)).slice(0, LIMIT);
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
      persistSeen(ready);
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
    hits = await pipelineSearch(search, { limit: LIMIT, floor: FLOOR, rerankQuery, exclude: loadSeen() });
  } catch {
    emitSilent(); // servers down / error — never block the tool
  }
  const pipeMs = Date.now() - tPipe;
  logCalibration(hits, { mode: "sync", pipeMs });
  if (hits.length === 0) emitSilent(); // nothing fresh + relevant
  persistSeen(hits);
  emitHits(hits, `${Date.now() - t0}ms (pipeline ${pipeMs}ms)`);
}

main();
