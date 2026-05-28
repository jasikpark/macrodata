#!/usr/bin/env bun
import { getRecentJournalEntries } from "../src/journal.js";

const count = Number(process.argv[2] ?? 5);
const entries = getRecentJournalEntries(count);

const fmt = new Intl.DateTimeFormat("sv-SE", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

for (const entry of entries) {
  const firstLine = entry.content.split("\n")[0];
  const when = fmt.format(new Date(entry.timestamp));
  console.log(`- [${when}] [${entry.topic}] ${firstLine}`);
}
