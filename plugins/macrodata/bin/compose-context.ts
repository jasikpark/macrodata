#!/usr/bin/env bun
// Budget-aware composer for the macrodata SessionStart hook.
//
// Replaces the heredoc-style composition in macrodata-hook.sh. Each section
// gets a fixed UTF-16 .length budget; when a section's content exceeds its
// budget, it is head-keep truncated (older content at the top is preserved,
// the tail is dropped) and an in-band marker is emitted. If any section
// truncates, a final <macrodata-truncation-warning> block is appended so the
// next agent can see the drift and trim the offending source file.
//
// Why head-keep everywhere (not tail-keep on append-shaped files):
// tail-keep would silently mask unbounded growth; head-keep + a visible
// warning is the forcing function for keeping state files sparse. Append-only
// growth belongs in the JSONL journal, NOT in state files.
//
// Why this cap exists: Claude Code hooks cap stdout at 10,000 UTF-16 code
// units (NOT bytes, NOT codepoints). Overflow drops to a 2,000-char preview —
// see https://github.com/anthropics/claude-code/issues/44086. We target
// 9,500 to leave 500 units of safety margin under the cliff.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getRecentJournalEntries } from "../src/journal.js";

const MAX_BUDGET = 9_500;

interface Section {
  tag: string;
  budget: number;
  loader: () => string;
  // Where the FULL content lives, surfaced in the truncation marker so the
  // agent knows how to recover what was dropped (a file path or a tool name).
  source: string;
}

const stateRoot =
  process.argv[2] ||
  process.env.MACRODATA_ROOT ||
  join(process.env.HOME ?? "", ".config/macrodata");

// Propagate to the journal/config modules, which read MACRODATA_ROOT fresh
// each call via src/config.ts. Argv must win over inherited env.
process.env.MACRODATA_ROOT = stateRoot;

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;

function readFileOrEmpty(path: string): string {
  if (!existsSync(path)) return "_Empty_";
  return readFileSync(path, "utf8").trim() || "_Empty_";
}

// Neutralize literal macrodata tag-openers in section bodies so file content
// containing e.g. "</macrodata-identity>" (plausible: this repo documents its
// own format) can't close its wrapper early, forge a sibling block, or break
// out of </macrodata>. Entity-escaping just the "<" keeps the text readable
// AND unmistakably meta — it renders as "&lt;/macrodata-identity>" rather than
// silently vanishing the way a zero-width break would. Must run BEFORE
// headKeep so the budget accounts for the escaped (slightly longer) size.
function neutralizeTags(s: string): string {
  return s.replaceAll("</macrodata", "&lt;/macrodata").replaceAll("<macrodata", "&lt;macrodata");
}

// Per-entry first-line cap for journal bullets. Long entries get a snippet;
// full content is reachable via `get_recent_journal` / `search_memory`.
const JOURNAL_ENTRY_CAP = 180;
const JOURNAL_FOOTER =
  "_More: `get_recent_journal` (chronological), `search_memory` (semantic)._";
const SCHEDULES_FOOTER = "_More: `list_reminders` for full payloads._";

// getRecentJournalEntries does JSON.parse with no shape validation, so a single
// structurally-valid-but-wrong entry (missing/null/non-string timestamp or
// content) would otherwise throw inside the map and collapse the WHOLE section
// to "_Journal unavailable_" — silent loss of all 5 entries. Validate per-entry
// and skip the bad ones so one malformed record can't erase recent memory.
const JournalEntrySchema = z.object({
  timestamp: z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), {
    message: "unparseable timestamp",
  }),
  topic: z.string(),
  content: z.string().min(1),
});

function loadJournal(): string {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  try {
    const entries = getRecentJournalEntries(5);
    if (!entries.length) return "_No recent journal entries_";
    const bullets = entries.flatMap((e) => {
      const parsed = JournalEntrySchema.safeParse(e);
      if (!parsed.success) return [];
      const { timestamp, topic, content } = parsed.data;
      const firstLine = content.split("\n")[0];
      const snippet =
        firstLine.length > JOURNAL_ENTRY_CAP
          ? firstLine.slice(0, JOURNAL_ENTRY_CAP) + "…"
          : firstLine;
      return [`- [${fmt.format(new Date(timestamp))}] [${topic}] ${snippet}`];
    });
    if (!bullets.length) return "_No recent journal entries_";
    return bullets.join("\n") + "\n" + JOURNAL_FOOTER;
  } catch {
    return "_Journal unavailable_";
  }
}

function loadSchedules(): string {
  const remindersDir = join(stateRoot, "reminders");
  if (!existsSync(remindersDir)) return "_No active schedules_";
  const lines: string[] = [];
  for (const name of readdirSync(remindersDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(remindersDir, name), "utf8");
      const j = JSON.parse(raw);
      if (j.description && j.type && j.expression) {
        lines.push(`- ${j.description} (${j.type}: ${j.expression})`);
      }
    } catch {
      // skip malformed
    }
  }
  if (!lines.length) return "_No active schedules_";
  return lines.join("\n") + "\n" + SCHEDULES_FOOTER;
}

function loadUsage(): string {
  const usagePath = process.env.MACRODATA_USAGE_PATH || join(SCRIPT_DIR, "..", "USAGE.md");
  if (!existsSync(usagePath)) return "";
  return readFileSync(usagePath, "utf8").trim();
}

function loadFiles(): string {
  const lines: string[] = [];
  const statePath = join(stateRoot, "state");
  if (existsSync(statePath)) {
    for (const f of readdirSync(statePath).sort()) {
      if (f.endsWith(".md")) lines.push(`- state/${f}`);
    }
  }
  const entitiesPath = join(stateRoot, "entities");
  if (existsSync(entitiesPath)) {
    for (const sub of readdirSync(entitiesPath).sort()) {
      const subPath = join(entitiesPath, sub);
      // statSync follows symlinks and throws ENOENT on a broken one (or on an
      // entry deleted between readdir and stat — a TOCTOU race with the daemon).
      // Skip rather than let it bubble up and crash the whole composer.
      let isDir = false;
      try {
        isDir = statSync(subPath).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      for (const f of readdirSync(subPath).sort()) {
        if (f.endsWith(".md")) lines.push(`- entities/${sub}/${f}`);
      }
    }
  }
  return lines.length ? lines.join("\n") : "_No files yet_";
}

// Section shape splits into three categories:
//   - Forcing-function (identity/today/human/workspace): head-keep + warning
//     surfaces drift so the source file gets trimmed.
//   - Progressive-disclosure (journal/schedules): per-entry snippet + footer
//     pointing at the full-content tool (get_recent_journal, list_reminders).
//   - Static (usage/files): bundled doc / file index; head-keep when oversize.
//
// Worst-case framing overhead: 8 sections × ~60 chars + ~25 outer wrapper +
// ~300 truncation-warning ≈ 800. Content budgets sum to 7,600; total ≤ 8,400
// under the 9,500 working budget (10K cliff minus 500 safety margin).
const SECTIONS: Section[] = [
  { tag: "identity", budget: 1300, source: "state/identity.md",        loader: () => readFileOrEmpty(join(stateRoot, "state/identity.md")) },
  { tag: "today",    budget: 1500, source: "state/today.md",           loader: () => readFileOrEmpty(join(stateRoot, "state/today.md")) },
  { tag: "human",    budget: 600,  source: "state/human.md",           loader: () => readFileOrEmpty(join(stateRoot, "state/human.md")) },
  { tag: "workspace",budget: 1500, source: "state/workspace.md",       loader: () => readFileOrEmpty(join(stateRoot, "state/workspace.md")) },
  { tag: "journal",  budget: 1200, source: "get_recent_journal tool",  loader: loadJournal },
  { tag: "schedules",budget: 500,  source: "list_reminders tool",      loader: loadSchedules },
  { tag: "usage",    budget: 300,  source: "USAGE.md",                 loader: loadUsage },
  { tag: "files",    budget: 700,  source: "ls under root attr",       loader: loadFiles },
];

const sectionBudgetSum = SECTIONS.reduce((a, s) => a + s.budget, 0);
if (sectionBudgetSum > MAX_BUDGET) {
  console.error(
    `compose-context: section budgets sum to ${sectionBudgetSum}, exceeding MAX_BUDGET ${MAX_BUDGET}`,
  );
  process.exit(1);
}

interface SectionResult {
  tag: string;
  budget: number;
  originalLength: number;
  output: string;
  truncated: boolean;
}

function headKeep(tag: string, content: string, budget: number, source: string): SectionResult {
  const originalLength = content.length;
  if (originalLength <= budget) {
    return { tag, budget, originalLength, output: content, truncated: false };
  }
  // The marker carries (a) a visible "…" so truncation is unmistakable and
  // (b) where the FULL content lives, so the unshown tail is recoverable.
  // Framed as display-only ("shown first N of M") — the source is untouched —
  // so it never reads as an instruction to delete the tail.
  const marker = `\n…\n[shown first ${budget} of ${originalLength} chars (head-keep); full content: ${source}]`;
  const room = Math.max(0, budget - marker.length);
  let kept = content.slice(0, room);
  // Cut back to the last line boundary so we don't slice mid-word/mid-line,
  // but only if that boundary isn't so early it throws away most of the room.
  const lastNl = kept.lastIndexOf("\n");
  if (lastNl >= room * 0.8) kept = kept.slice(0, lastNl);
  return {
    tag,
    budget,
    originalLength,
    output: kept + marker,
    truncated: true,
  };
}

function identityIsMissing(): boolean {
  return !existsSync(join(stateRoot, "state/identity.md"));
}

if (identityIsMissing()) {
  // First-run path — mirror the bash script's first-run message.
  const detectUserSh = join(SCRIPT_DIR, "detect-user.sh");
  let userInfo = "{}";
  if (existsSync(detectUserSh)) {
    try {
      const proc = Bun.spawnSync([detectUserSh]);
      userInfo = new TextDecoder().decode(proc.stdout).trim() || "{}";
    } catch {
      // keep default
    }
  }
  const firstRun = `<macrodata>
<macrodata-first-run state-root="${stateRoot}">
Macrodata local memory is not yet configured. Run \`/onboarding\` to set up.
</macrodata-first-run>

<macrodata-detected-user>
${userInfo}
</macrodata-detected-user>
</macrodata>`;
  process.stdout.write(firstRun);
  process.exit(0);
}

const results: SectionResult[] = SECTIONS.map((s) => {
  // Degrade per-section: a loader that throws (e.g. an unreadable file, a
  // broken symlink getting past loadFiles' own guard) must not crash the whole
  // composer — that would inject an empty context with no warning. neutralizeTags
  // runs here, before headKeep, so closing-tag escaping is reflected in the budget.
  let content: string;
  try {
    content = neutralizeTags(s.loader());
  } catch {
    content = "_section unavailable_";
  }
  return headKeep(s.tag, content, s.budget, s.source);
});

const blocks: string[] = [];
for (const r of results) {
  let attr = r.truncated ? ` truncated="${r.originalLength}→${r.budget}"` : "";
  // <macrodata-files> additionally carries root="..." so the agent knows
  // where listed files live without re-deriving the path.
  if (r.tag === "files") attr += ` root="${stateRoot}"`;
  blocks.push(`<macrodata-${r.tag}${attr}>\n${r.output}\n</macrodata-${r.tag}>`);
}

const truncated = results.filter((r) => r.truncated);
if (truncated.length) {
  blocks.push(
    `<macrodata-truncation-warning count="${truncated.length}">
${truncated.length} section(s) were truncated for display only — the underlying files on disk are intact (each marker's "full content:" pointer says where). To shrink a section so more of it fits: DISTILL or SUMMARIZE it; move detailed content into an entity file and leave a [[wikilink]] pointer in its place; or relocate append-only / log-style content into the JSONL journal (built for unbounded growth). Do NOT delete substantive content to fit — condense it, link it out to an entity, or move it.
</macrodata-truncation-warning>`,
  );
}

const output = `<macrodata>\n${blocks.join("\n\n")}\n</macrodata>`;

if (output.length > MAX_BUDGET) {
  // Defensive: shouldn't happen if per-section budgets + framing fit, but warn.
  console.error(
    `compose-context: final output length ${output.length} exceeds MAX_BUDGET ${MAX_BUDGET}`,
  );
}

process.stdout.write(output);
