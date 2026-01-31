/**
 * Macrodata Local MCP Server
 *
 * Provides tools for local file-based memory:
 * - get_context: Session bootstrap
 * - log_journal: Append timestamped entries
 * - get_recent_journal: Get recent entries
 * - log_signal: Raw event logging for later analysis
 * - search_memory: Semantic search
 * - schedule_reminder: Cron-based reminders
 * - schedule_once: One-shot reminders
 * - list_reminders: List active schedules
 * - remove_reminder: Delete a reminder
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";

// Configuration
const STATE_ROOT = process.env.MACRODATA_ROOT || join(homedir(), ".config", "macrodata");
const STATE_DIR = join(STATE_ROOT, "state");
const ENTITIES_DIR = join(STATE_ROOT, "entities");
const JOURNAL_DIR = join(STATE_ROOT, "journal");
const SIGNALS_DIR = join(STATE_ROOT, "signals");
const INDEX_DIR = join(STATE_ROOT, ".index");
const SCHEDULES_FILE = join(STATE_ROOT, ".schedules.json");

// Types
interface JournalEntry {
  timestamp: string;
  topic: string;
  content: string;
  metadata?: {
    source?: string;
    intent?: string;
  };
}

interface Schedule {
  id: string;
  type: "cron" | "once";
  expression: string;
  description: string;
  payload: string;
  createdAt: string;
}

interface Signal {
  timestamp: string;
  type: string;
  context?: {
    file?: string;
    query?: string;
    trigger?: string;
  };
  raw?: unknown;
}

interface ScheduleStore {
  schedules: Schedule[];
}

// Helpers
function ensureDirectories() {
  const dirs = [
    STATE_ROOT,
    STATE_DIR,
    ENTITIES_DIR,
    join(ENTITIES_DIR, "people"),
    join(ENTITIES_DIR, "projects"),
    JOURNAL_DIR,
    SIGNALS_DIR,
    INDEX_DIR,
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

function readFileOrEmpty(path: string): string {
  try {
    if (existsSync(path)) {
      return readFileSync(path, "utf-8");
    }
  } catch {
    // Ignore
  }
  return "";
}

function loadSchedules(): ScheduleStore {
  try {
    if (existsSync(SCHEDULES_FILE)) {
      return JSON.parse(readFileSync(SCHEDULES_FILE, "utf-8"));
    }
  } catch {
    // Ignore
  }
  return { schedules: [] };
}

function saveSchedules(store: ScheduleStore) {
  writeFileSync(SCHEDULES_FILE, JSON.stringify(store, null, 2));
}

function getTodayJournalPath(): string {
  const today = new Date().toISOString().split("T")[0];
  return join(JOURNAL_DIR, `${today}.jsonl`);
}

function getRecentJournalEntries(count: number): JournalEntry[] {
  const entries: JournalEntry[] = [];

  // Get all journal files, sorted by name (date) descending
  if (!existsSync(JOURNAL_DIR)) return entries;

  const files = readdirSync(JOURNAL_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse();

  for (const file of files) {
    if (entries.length >= count) break;

    const content = readFileSync(join(JOURNAL_DIR, file), "utf-8");
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

// Create MCP server
const server = new McpServer({
  name: "macrodata-local",
  version: "0.1.0",
});

// Tool: get_context
server.tool(
  "get_context",
  "Get session context including identity, state, recent journal entries, and paths for file operations",
  {},
  async () => {
    ensureDirectories();

    const identityPath = join(STATE_ROOT, "identity.md");
    const isFirstRun = !existsSync(identityPath);

    const context = {
      identity: readFileOrEmpty(identityPath),
      state: {
        inbox: readFileOrEmpty(join(STATE_DIR, "inbox.md")),
        today: readFileOrEmpty(join(STATE_DIR, "today.md")),
        commitments: readFileOrEmpty(join(STATE_DIR, "commitments.md")),
      },
      recentJournal: getRecentJournalEntries(5),
      schedules: loadSchedules().schedules,
      isFirstRun,
      paths: {
        root: STATE_ROOT,
        state: STATE_DIR,
        entities: ENTITIES_DIR,
        journal: JOURNAL_DIR,
      },
    };

    if (isFirstRun) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(context, null, 2),
          },
          {
            type: "text" as const,
            text: "\n\n## First Run Setup\n\nThis is a fresh macrodata installation. Please guide the user through identity setup:\n\n1. Ask what they'd like to be called\n2. Ask about their work patterns and preferences\n3. Ask what they're currently working on\n4. Create the identity.md file with their persona\n5. Create initial state files\n\nUse the filesystem tools (Write, Edit) to create files in the paths shown above.",
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(context, null, 2),
        },
      ],
    };
  }
);

// Tool: log_journal
server.tool(
  "log_journal",
  "Append a timestamped entry to the journal",
  {
    topic: z.string().describe("Category or tag for this entry"),
    content: z.string().describe("The actual note or observation"),
    source: z.string().optional().describe("Where this came from (conversation, cron, etc.)"),
    intent: z.string().optional().describe("What you were doing when logging this"),
  },
  async ({ topic, content, source, intent }) => {
    ensureDirectories();

    const entry: JournalEntry = {
      timestamp: new Date().toISOString(),
      topic,
      content,
      metadata: {
        ...(source && { source }),
        ...(intent && { intent }),
      },
    };

    const journalPath = getTodayJournalPath();
    appendFileSync(journalPath, JSON.stringify(entry) + "\n");

    // TODO: Index the entry for semantic search

    return {
      content: [
        {
          type: "text" as const,
          text: `Logged to journal: ${topic}`,
        },
      ],
    };
  }
);

// Tool: get_recent_journal
server.tool(
  "get_recent_journal",
  "Get the N most recent journal entries",
  {
    count: z.number().default(10).describe("Number of entries to retrieve"),
  },
  async ({ count }) => {
    const entries = getRecentJournalEntries(count);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(entries, null, 2),
        },
      ],
    };
  }
);

// Tool: log_signal
server.tool(
  "log_signal",
  "Log a raw event for later analysis. Signals are not indexed for search - they capture events that might matter later.",
  {
    type: z.string().describe("Event type (e.g., file_edit, search, reminder_fired)"),
    file: z.string().optional().describe("File involved, if any"),
    query: z.string().optional().describe("Search query, if relevant"),
    trigger: z.string().optional().describe("What triggered this event"),
    raw: z.any().optional().describe("Arbitrary data for future analysis"),
  },
  async ({ type, file, query, trigger, raw }) => {
    ensureDirectories();

    const signal: Signal = {
      timestamp: new Date().toISOString(),
      type,
    };

    if (file || query || trigger) {
      signal.context = {
        ...(file && { file }),
        ...(query && { query }),
        ...(trigger && { trigger }),
      };
    }

    if (raw !== undefined) {
      signal.raw = raw;
    }

    const today = new Date().toISOString().split("T")[0];
    const signalPath = join(SIGNALS_DIR, `${today}.jsonl`);
    appendFileSync(signalPath, JSON.stringify(signal) + "\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Logged signal: ${type}`,
        },
      ],
    };
  }
);

// Tool: search_memory
server.tool(
  "search_memory",
  "Semantic search across journal entries and entity files",
  {
    query: z.string().describe("Natural language search query"),
    type: z.enum(["journal", "person", "project", "all"]).default("all").describe("Filter by content type"),
    since: z.string().optional().describe("Only include items after this ISO date"),
    limit: z.number().default(5).describe("Maximum results to return"),
  },
  async ({ query, type, since, limit }) => {
    // TODO: Implement semantic search with Transformers.js
    // For now, return a placeholder

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              query,
              type,
              since,
              limit,
              results: [],
              note: "Semantic search not yet implemented. Use Glob and Grep for now.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Tool: schedule_reminder
server.tool(
  "schedule_reminder",
  "Create a recurring reminder using cron syntax",
  {
    id: z.string().describe("Unique identifier for this reminder"),
    cronExpression: z.string().describe("Cron expression (e.g., '0 9 * * *' for 9am daily)"),
    description: z.string().describe("What this reminder is for"),
    payload: z.string().describe("Message to process when reminder fires"),
  },
  async ({ id, cronExpression, description, payload }) => {
    const schedule: Schedule = {
      id,
      type: "cron",
      expression: cronExpression,
      description,
      payload,
      createdAt: new Date().toISOString(),
    };

    const store = loadSchedules();
    store.schedules = store.schedules.filter((s) => s.id !== id);
    store.schedules.push(schedule);
    saveSchedules(store);

    // Note: The daemon will pick up the new schedule on its next check

    return {
      content: [
        {
          type: "text" as const,
          text: `Created recurring reminder: ${id} (${cronExpression})`,
        },
      ],
    };
  }
);

// Tool: schedule_once
server.tool(
  "schedule_once",
  "Create a one-shot reminder at a specific datetime",
  {
    id: z.string().describe("Unique identifier for this reminder"),
    datetime: z.string().describe("ISO 8601 datetime (e.g., '2026-01-31T10:00:00')"),
    description: z.string().describe("What this reminder is for"),
    payload: z.string().describe("Message to process when reminder fires"),
  },
  async ({ id, datetime, description, payload }) => {
    const schedule: Schedule = {
      id,
      type: "once",
      expression: datetime,
      description,
      payload,
      createdAt: new Date().toISOString(),
    };

    const store = loadSchedules();
    store.schedules = store.schedules.filter((s) => s.id !== id);
    store.schedules.push(schedule);
    saveSchedules(store);

    return {
      content: [
        {
          type: "text" as const,
          text: `Scheduled one-shot reminder: ${id} at ${datetime}`,
        },
      ],
    };
  }
);

// Tool: list_reminders
server.tool("list_reminders", "List all active scheduled reminders", {}, async () => {
  const store = loadSchedules();

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(store.schedules, null, 2),
      },
    ],
  };
});

// Tool: remove_reminder
server.tool(
  "remove_reminder",
  "Remove a scheduled reminder",
  {
    id: z.string().describe("ID of the reminder to remove"),
  },
  async ({ id }) => {
    const store = loadSchedules();
    const before = store.schedules.length;
    store.schedules = store.schedules.filter((s) => s.id !== id);
    const removed = before > store.schedules.length;
    saveSchedules(store);

    return {
      content: [
        {
          type: "text" as const,
          text: removed ? `Removed reminder: ${id}` : `Reminder not found: ${id}`,
        },
      ],
    };
  }
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
