/**
 * Query construction for the ambient hook (skttzwrk port, hacky).
 *
 * Two jobs, both following Porrima's principle "use the agent's current intent,
 * not the original prompt":
 *  - scrubOperationalNoise(): strip code/paths/flags so structural tokens don't
 *    dominate the embedding (cross-encoders/bi-encoders over-weight shape).
 *  - buildHookQuery(): from a Claude Code PostToolUse envelope, pull the tool's
 *    SEMANTIC args (the intent) — not its raw output — and scrub them.
 */

// A path → its topic words (last segment, de-cased, stopword-stripped).
function pathToTopicWords(p: string): string {
  const seg = p.split(/[\\/]+/).filter(Boolean).pop() ?? p;
  return (
    " " +
    seg
      .replace(/\.\w+$/, "") // drop extension
      .replace(/[-_.:]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase
      .replace(/\b(?:src|dist|api|v\d|bin|lib|node_modules)\b/gi, " ")
      .trim() +
    " "
  );
}

export function scrubOperationalNoise(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/<\/?[a-z_][^>]*>/gi, " ") // xml-ish tags
    .replace(/\b[\w./-]+\.(ts|tsx|js|jsx|md|json|jsonl|sh|py|go|rs|gguf|toml|yaml|yml)\b/gi, pathToTopicWords)
    .replace(/\/(?:api|v\d)\/[\w./:-]+/gi, " ")
    .replace(/(?:^|\s)(?:\.{0,2}\/|~\/|\/)[\w./-]+/g, pathToTopicWords) // bare paths
    .replace(/\b(?:--?[a-z][\w-]*)/gi, " ") // CLI flags
    .replace(/\b(?:path|command|cmd|file|filename|url)=\S+/gi, " ")
    .replace(/[{}[\]"`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Semantic fields across common tools — the intent, ordered most→least topical.
const SIGNAL_FIELDS = [
  "query", "q", "search", "prompt", "description",
  "pattern", "command", "url", "file_path", "path", "content",
];

interface HookEnvelope {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

function toolIntent(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const parts: string[] = [];
  for (const f of SIGNAL_FIELDS) {
    const v = input[f];
    if (typeof v === "string" && v.trim()) parts.push(v);
  }
  return parts.join(" ");
}

export function buildHookQuery(env: HookEnvelope, maxChars = 1000): string {
  return scrubOperationalNoise(toolIntent(env.tool_input)).slice(0, maxChars);
}

// --- Transcript-context query (the real one) ----------------------------------
// Reads the session JSONL and builds TWO queries, Porrima-style:
//  - search (WIDE): last N user/assistant messages — thinking + text + tool
//    INTENT + user prompts. Casts the net.
//  - rerank (TIGHT): the latest assistant trajectory (what the agent is doing
//    right now) + the user prompt with decay. Focuses the precision pass.
// tool_result blocks (raw output) are skipped — noisy, per Porrima.

import { readFileSync } from "fs";

interface Msg { role: string; thinking: string; text: string; tool: string }

function clamp(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

function parseRecent(transcriptPath: string, maxMessages: number): Msg[] {
  let raw: string;
  try { raw = readFileSync(transcriptPath, "utf-8"); } catch { return []; }
  const msgs: Msg[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "user" && e.type !== "assistant") continue;
    const content = e.message?.content;
    if (content == null) continue;
    let thinking = "", text = "", tool = "";
    if (typeof content === "string") {
      text = content; // a real user prompt
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "thinking" && b.thinking) thinking += " " + b.thinking;
        else if (b.type === "text" && b.text) text += " " + b.text;
        else if (b.type === "tool_use") tool += " " + toolIntent(b.input);
        // tool_result intentionally skipped (raw output is noise)
      }
    }
    if (thinking || text || tool) msgs.push({ role: e.message.role ?? e.type, thinking, text, tool });
  }
  // Claude Code emits a turn as separate thinking/text/tool_use events; coalesce
  // consecutive same-role events into one logical message so "latest assistant
  // message" is the whole final response, not just its last block.
  const merged: Msg[] = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.thinking += " " + m.thinking;
      last.text += " " + m.text;
      last.tool += " " + m.tool;
    } else {
      merged.push({ ...m });
    }
  }
  return merged.slice(-maxMessages);
}

// In-context exclusion derived from the live COMPACTION WINDOW (Porrima frozenIds∪deltaIds,
// adapted). Claude Code compacts IN-PLACE: the same session file grows, and each boundary is
// a `type:user` entry flagged `isCompactSummary:true` (preceded by a `compactMetadata` system
// entry). Everything BEFORE the last boundary was summarized away — NOT in context — so we
// must not suppress it (conservative: re-injecting summarized-away detail is useful, not echo).
//
// Returns the window start ts + the EXACT keys of journal memories I AUTHORED in the window:
// `[topic] content`, byte-identical to how indexer.ts stores a journal entry, so it
// exact-matches a recall candidate's content. EXACT only (no substring/cosine) — we suppress
// ONLY what we provably produced; anything uncertain is injected (under-cull, never over-cull).
export function inContextWindow(transcriptPath: string): { windowStartTs: string; authoredKeys: Set<string> } {
  let raw: string;
  try { raw = readFileSync(transcriptPath, "utf-8"); } catch { return { windowStartTs: "", authoredKeys: new Set() }; }
  const entries: Array<{ idx: number; o: any }> = [];
  let firstTs = "", boundaryIdx = -1, boundaryTs = "";
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let o: any; try { o = JSON.parse(lines[i]); } catch { continue; }
    entries.push({ idx: i, o });
    if (!firstTs && o.timestamp) firstTs = o.timestamp;
    // STRUCTURED-FIELD check (NOT a substring scan): the boundary is a system entry
    // carrying subtype:"compact_boundary" (+compactMetadata) immediately followed by a
    // user entry with isCompactSummary:true. Keying on these object fields avoids the
    // over-cull trap where prose merely CONTAINING the string "isCompactSummary"
    // false-matches (confirmed 2026-06-24: a naive grep hit such a prose line).
    // Guard each marker by its expected entry TYPE so a stray top-level field on the
    // wrong entry kind can't advance the boundary (→ silent over-cull of everything after).
    const isSummary = o.isCompactSummary === true && o.type === "user";
    const isBoundarySys = (o.subtype === "compact_boundary" || o.compactMetadata) && o.type === "system";
    if (isSummary || isBoundarySys) {
      boundaryIdx = i;
      // Authoritative boundary ts = the isCompactSummary USER entry (defines what's in
      // context); fall back to the compact_boundary system entry's ts only if the summary
      // lacks one. Last-wins across multiple compactions.
      if (isSummary) boundaryTs = o.timestamp || boundaryTs;
      else if (o.timestamp) boundaryTs = o.timestamp;
    }
  }
  const windowStartTs = boundaryTs || firstTs; // no compaction → whole session is the window
  const authoredKeys = new Set<string>();
  for (const { idx, o } of entries) {
    if (idx <= boundaryIdx) continue; // pre-compaction: summarized away, not in context
    if (o.type !== "assistant" || !Array.isArray(o.message?.content)) continue;
    for (const b of o.message.content) {
      if (b?.type === "tool_use" && /log_journal$/.test(String(b.name || "")) && b.input
          && typeof b.input.topic === "string" && typeof b.input.content === "string") {
        authoredKeys.add(`[${b.input.topic}] ${b.input.content}`);
      }
    }
  }
  return { windowStartTs, authoredKeys };
}

export function buildTranscriptQuery(
  transcriptPath: string,
  opts: { maxMessages?: number; searchChars?: number; rerankChars?: number } = {},
): { search: string; rerank: string; latest: { thinking: number; text: number } } {
  const { maxMessages = 12, searchChars = 6000, rerankChars = 900 } = opts;
  const recent = parseRecent(transcriptPath, maxMessages);
  if (recent.length === 0) return { search: "", rerank: "", latest: { thinking: 0, text: 0 } };

  // WIDE search query — everything recent, scrubbed, tail-clamped.
  const searchParts: string[] = [];
  for (const m of recent) {
    if (m.role === "user") searchParts.push(clamp(m.text, 1200));
    else searchParts.push([clamp(m.thinking, 800), clamp(m.text, 1000), m.tool].filter(Boolean).join(" "));
  }
  const searchRaw = scrubOperationalNoise(searchParts.join("\n"));
  const search = searchRaw.length > searchChars ? searchRaw.slice(searchRaw.length - searchChars) : searchRaw;

  // TIGHT rerank query — latest assistant trajectory + user prompt with decay.
  const latestAsst = [...recent].reverse().find((m) => m.role === "assistant");
  const latestUser = [...recent].reverse().find((m) => m.role === "user");
  const traj = latestAsst
    ? scrubOperationalNoise([clamp(latestAsst.thinking, 400), clamp(latestAsst.text, 300), latestAsst.tool].filter(Boolean).join(" "))
    : "";
  const userQ = scrubOperationalNoise(latestUser?.text ?? "");
  // Decay the user prompt once the agent has a substantial trajectory.
  const userBudget = traj.length >= 200 ? 135 : 405;
  const rerank = clamp([clamp(userQ, userBudget), clamp(traj, 525)].filter(Boolean).join(" "), rerankChars);

  // Depth of the latest assistant message — for the Stop path's triviality gate.
  const latest = latestAsst
    ? { thinking: latestAsst.thinking.trim().length, text: latestAsst.text.trim().length }
    : { thinking: 0, text: 0 };

  return { search, rerank, latest };
}
