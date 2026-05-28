import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { getJournalDir } from "./config.js";

export interface JournalEntry {
  timestamp: string;
  topic: string;
  content: string;
  metadata?: {
    source?: string;
    intent?: string;
  };
}

export function getRecentJournalEntries(count: number): JournalEntry[] {
  const entries: JournalEntry[] = [];
  const journalDir = getJournalDir();

  if (!existsSync(journalDir)) return entries;

  const files = readdirSync(journalDir)
    .filter((f: string) => f.endsWith(".jsonl"))
    .sort()
    .reverse();

  for (const file of files) {
    if (entries.length >= count) break;

    const content = readFileSync(join(journalDir, file), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    for (const line of lines.reverse()) {
      if (entries.length >= count) break;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }
  }

  return entries;
}
