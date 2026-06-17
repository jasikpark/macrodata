#!/usr/bin/env bun
/**
 * Ambient-recall async worker (spike).
 *
 * Long-lived process that runs the SLOW pipeline off the hook's blocking path.
 * The hook drops a request file; this worker reranks and writes an inbox file;
 * the hook drains the inbox on its NEXT fire. That's 3fz's competitive
 * injection: a slow hit defers to the next opportunity instead of stalling the
 * current tool call.
 *
 * Why this shape (profiled 2026-06-17): rerank dominates at ~127ms/doc × ~40
 * candidates ≈ 5s; vector+fts+corpus ≈ 320ms. Moving the rerank off the tool
 * round-trip is the whole win. A long-lived worker also amortizes the
 * per-process FTS corpus build (~160ms) and keeps the llama-servers warm.
 *
 * Protocol (all files live in this dir, keyed by session_id):
 *   hook  writes  .recall-request-<sid>.json  {sid, search, rerankQuery, ts}
 *   worker reads+deletes the request, reranks, writes
 *          .recall-inbox-<sid>.json  {ts, hits: SearchResult[]}
 *   hook  reads+deletes the inbox on its next fire and injects.
 * Seen-dedup: the worker excludes already-injected chunks by reading
 * .recall-injected-<sid>.json (the hook owns writing it, on actual injection).
 *
 * Run:  bun run worker.ts   (foreground; the supervisor will daemonize it later)
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, watch } from "fs";
import { join } from "path";
import { pipelineSearch } from "./fts.ts";

const DIR = import.meta.dir;
const FLOOR = Number(process.env.MACRODATA_RECALL_FLOOR ?? 0.5);
const LIMIT = Number(process.env.MACRODATA_RECALL_LIMIT ?? 3);
const REQ_RE = /^\.recall-request-(.+)\.json$/;

interface Request { sid: string; search: string; rerankQuery: string; ts?: string }

const reqPath = (sid: string) => join(DIR, `.recall-request-${sid}.json`);
const inboxPath = (sid: string) => join(DIR, `.recall-inbox-${sid}.json`);
const injectedPath = (sid: string) => join(DIR, `.recall-injected-${sid}.json`);

function loadSeen(sid: string): Set<string> {
  const p = injectedPath(sid);
  if (!existsSync(p)) return new Set();
  try { return new Set(JSON.parse(readFileSync(p, "utf-8")) as string[]); } catch { return new Set(); }
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// latest-request-wins per session; coalesce bursts so we never rerank a query
// the agent has already moved past.
const pending = new Map<string, Request>();
let running = false;

async function runPipeline(req: Request): Promise<void> {
  const seen = loadSeen(req.sid);
  const t0 = Date.now();
  let hits: Awaited<ReturnType<typeof pipelineSearch>>;
  try {
    hits = await pipelineSearch(req.search, {
      limit: LIMIT, floor: FLOOR, rerankQuery: req.rerankQuery, exclude: seen,
    });
  } catch (e) {
    console.error(`[worker] ${req.sid}: pipeline error: ${String(e)}`);
    return;
  }
  const ms = Date.now() - t0;
  if (hits.length > 0) {
    // Stamp timing so the hook can render the span: requestedAt (when the hook
    // enqueued) → servedAt (now); pipelineMs is the off-path cost the tool call
    // never paid.
    atomicWrite(inboxPath(req.sid), JSON.stringify({
      requestedAt: req.ts ?? null,
      servedAt: new Date().toISOString(),
      pipelineMs: ms,
      hits,
    }));
    console.log(`[worker] ${req.sid}: ${hits.length} hit(s) -> inbox (${ms}ms)`);
  } else {
    console.log(`[worker] ${req.sid}: 0 hits (${ms}ms)`);
  }
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (pending.size > 0) {
      const batch = [...pending.values()];
      pending.clear();
      for (const req of batch) await runPipeline(req);
    }
  } finally {
    running = false;
  }
}

function ingest(sid: string): void {
  const p = reqPath(sid);
  if (!existsSync(p)) return;
  let req: Request;
  try { req = { ...JSON.parse(readFileSync(p, "utf-8")), sid }; } catch { return; }
  try { unlinkSync(p); } catch {} // consume; latest-wins handled by the map
  if (!req.search || req.search.length < 8) return;
  pending.set(sid, req);
  void drain();
}

// Initial sweep (pick up requests written before the worker started), then watch.
for (const f of readdirSync(DIR)) {
  const m = f.match(REQ_RE);
  if (m) ingest(m[1]);
}
watch(DIR, (_event, filename) => {
  if (!filename) return;
  const m = String(filename).match(REQ_RE);
  if (m) ingest(m[1]);
});
console.log(`[worker] watching ${DIR} for .recall-request-*.json (embed :8091, rerank :8090, floor ${FLOOR}, limit ${LIMIT})`);
