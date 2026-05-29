#!/usr/bin/env bun
// Composer for the macrodata "lists" — journal + schedules — emitted together
// as one SessionStart hook (both are small, ~2K combined). Progressive
// disclosure: a bounded snippet of each (recent journal entries, first-line
// capped; active schedules) plus a footer pointing at the full-content tools.
// Carries forward the bounding behavior from the (closed) budget composer, a
// touch more generous on entry count + per-entry length.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getRecentJournalEntries } from "../src/journal.js";
import { getRemindersDir } from "../src/config.js";

const JOURNAL_ENTRIES = 7; // was 5 in the budget composer
// First-line cap. Set from real data: journal first-lines average ~377 chars
// (median 327, p75 547), so the old 220 truncated ~64% of entries mid-sentence.
// 500 clears the average/median and only clips the verbose tail; 7×500≈3.5K is
// trivial in this hook's own ~10K envelope.
const JOURNAL_ENTRY_CAP = 500;
const JOURNAL_FOOTER =
  "_More journal: `get_recent_journal` for full recent entries, or `search_memory` with type: journal to search the whole journal._";
const SCHEDULES_FOOTER = "_More: `list_reminders` for full payloads._";

// getRecentJournalEntries does JSON.parse with no shape validation, so validate
// per-entry and skip bad ones — one malformed record must not collapse the
// whole section.
const JournalEntrySchema = z.object({
  timestamp: z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), {
    message: "unparseable timestamp",
  }),
  topic: z.string(),
  content: z.string().min(1),
});

function neutralizeTags(s: string): string {
  return s.replaceAll("</macrodata", "&lt;/macrodata").replaceAll("<macrodata", "&lt;macrodata");
}

// Drop a trailing lone high surrogate left by a char-unit slice (would
// serialize to U+FFFD otherwise).
function dropLoneHighSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

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
    const entries = getRecentJournalEntries(JOURNAL_ENTRIES);
    if (!entries.length) return "_No recent journal entries_";
    const bullets = entries.flatMap((e) => {
      const parsed = JournalEntrySchema.safeParse(e);
      if (!parsed.success) return [];
      const { timestamp, topic, content } = parsed.data;
      const firstLine = content.split("\n")[0];
      const snippet =
        firstLine.length > JOURNAL_ENTRY_CAP
          ? dropLoneHighSurrogate(firstLine.slice(0, JOURNAL_ENTRY_CAP)) + "…"
          : firstLine;
      return [`- [${fmt.format(new Date(timestamp))}] [${neutralizeTags(topic)}] ${neutralizeTags(snippet)}`];
    });
    if (!bullets.length) return "_No recent journal entries_";
    return bullets.join("\n") + "\n" + JOURNAL_FOOTER;
  } catch {
    return "_Journal unavailable_";
  }
}

function loadSchedules(): string {
  const dir = getRemindersDir();
  if (!existsSync(dir)) return "_No active schedules_";
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return "_No active schedules_";
  }
  const lines: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, name), "utf8"));
      // Require strings — a truthy non-string would coerce to garbage.
      if (
        typeof j.description === "string" &&
        typeof j.type === "string" &&
        typeof j.expression === "string"
      ) {
        lines.push(
          `- ${neutralizeTags(j.description)} (${neutralizeTags(j.type)}: ${neutralizeTags(j.expression)})`,
        );
      }
    } catch {
      // skip malformed
    }
  }
  if (!lines.length) return "_No active schedules_";
  return lines.join("\n") + "\n" + SCHEDULES_FOOTER;
}

process.stdout.write(
  `<macrodata-journal>\n${loadJournal()}\n</macrodata-journal>\n\n<macrodata-schedules>\n${loadSchedules()}\n</macrodata-schedules>`,
);
