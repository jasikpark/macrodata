#!/usr/bin/env bun
import { getRecentJournalEntries } from "../src/journal.js";

const count = Number(process.argv[2] ?? 5);
const entries = getRecentJournalEntries(count);

for (const entry of entries) {
  const firstLine = entry.content.split("\n")[0];
  console.log(`- [${entry.topic}] ${firstLine}`);
}
