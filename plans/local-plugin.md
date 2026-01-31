# Local Macrodata Plugin Design

## Overview

A Claude Code plugin that provides durable memory with zero infrastructure. Files on the user's machine, optional git tracking, fully offline.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Claude Code                                         │
│  ┌───────────────────────────────────────────────┐  │
│  │  MCP Server (spawned on first tool use)       │  │
│  │  - State file read/write                      │  │
│  │  - Journal logging                            │  │
│  │  - Semantic search (Transformers.js)          │  │
│  │  - Context bootstrap                          │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
         │
         ▼ spawns on session start
┌─────────────────────────────────────────────────────┐
│  Daemon (long-running)                               │
│  - Scheduled tasks (cron-style reminders)           │
│  - Watches for changes                              │
│  - Can trigger Claude Code via CLI                  │
│  - Uses CLAUDE_CODE_BUN_PATH for Bun runtime        │
└─────────────────────────────────────────────────────┘
         │
         ▼ reads/writes
┌─────────────────────────────────────────────────────┐
│  ~/.config/macrodata/                               │
│  ├── identity.md          (persona, patterns)      │
│  ├── state/                                         │
│  │   ├── inbox.md         (quick capture)          │
│  │   ├── today.md         (daily focus)            │
│  │   └── commitments.md   (active threads)         │
│  ├── entities/                                      │
│  │   ├── people/          (*.md per person)        │
│  │   └── projects/        (*.md per project)       │
│  ├── journal/             (JSONL, date-partitioned) │
│  └── .index/              (embeddings cache)        │
└─────────────────────────────────────────────────────┘
```

## Two-Tier Memory Model

### Always-Loaded (injected every invocation)

| File | Purpose | Size target |
|------|---------|-------------|
| `identity.md` | Persona, values, learned patterns | ~100 lines |
| `state/inbox.md` | Quick capture, pending items | ~20 lines |
| `state/today.md` | Daily focus, open threads | ~30 lines |
| `state/commitments.md` | Active commitments | ~40 lines |

These files are small by design. They're the "working memory" that provides continuity across sessions.

### Retrieved On-Demand (via semantic search)

| Source | Content | Indexing |
|--------|---------|----------|
| `journal/*.jsonl` | Timestamped observations, notes | Embedded and searchable |
| `entities/people/*.md` | Information about people | Embedded and searchable |
| `entities/projects/*.md` | Project context and status | Embedded and searchable |

These can grow indefinitely. The agent retrieves relevant context via search.

## Tools

### Session Bootstrap

#### `get_context`

Called at session start. Returns everything the agent needs to orient:

```typescript
interface ContextResponse {
  identity: string;           // Full identity.md content
  state: {
    inbox: string;
    today: string;
    commitments: string;
  };
  recentJournal: JournalEntry[];  // Last 5 entries
  schedules: Schedule[];          // Active reminders
  isFirstRun: boolean;            // Trigger setup flow if true
}
```

If `isFirstRun` is true, the agent should guide the user through identity setup.

### State Management

#### `read_state`

Read a state file by name:
- `identity` → identity.md
- `inbox` → state/inbox.md
- `today` → state/today.md
- `commitments` → state/commitments.md

#### `write_state`

Write to a state file. Handles atomic writes and optional git commit.

#### `read_entity`

Read an entity file:
- `read_entity("person", "matt")` → entities/people/matt.md
- `read_entity("project", "acme")` → entities/projects/acme.md

#### `write_entity`

Create or update an entity file.

#### `list_entities`

List all entities of a type.

### Journaling

#### `log_journal`

Append a timestamped entry to the journal:

```typescript
interface JournalEntry {
  timestamp: string;      // ISO 8601
  topic: string;          // Category/tag
  content: string;        // The actual note
  metadata?: {
    source?: string;      // Where this came from (conversation, cron, etc.)
    intent?: string;      // What the agent was doing
  };
}
```

Entries are stored in date-partitioned JSONL files: `journal/2026-01-31.jsonl`

#### `get_recent_journal`

Get the N most recent journal entries (default 10).

### Search

#### `search_memory`

Semantic search across all indexed content:

```typescript
interface SearchParams {
  query: string;          // Natural language query
  type?: 'journal' | 'person' | 'project' | 'all';  // Filter by type
  since?: string;         // Only include items after this date
  limit?: number;         // Max results (default 5)
}
```

Returns ranked results with relevance scores.

### Scheduling

#### `schedule_reminder`

Create a recurring reminder (cron syntax):

```typescript
interface Reminder {
  id: string;
  cronExpression: string;   // e.g., "0 9 * * *" for 9am daily
  description: string;
  payload: string;          // Message to process when triggered
}
```

#### `schedule_once`

Create a one-shot reminder at a specific datetime.

#### `list_reminders`

List all active schedules.

#### `remove_reminder`

Delete a scheduled reminder.

## Indexing Strategy

### What Gets Indexed

1. **Journal entries** – each entry becomes a document
2. **Entity files** – each file becomes a document with metadata (type, name)
3. **Identity file** – NOT indexed (always in context anyway)
4. **State files** – NOT indexed (always in context anyway)

### How Indexing Works

- **Model:** all-MiniLM-L6-v2 via Transformers.js (384-dimensional)
- **Storage:** SQLite with vector similarity (or flat file with brute-force search for simplicity)
- **Update triggers:**
  - On journal write: index the new entry
  - On entity write: re-index the entity
  - Background: periodic re-index of everything

### Index Location

`.index/` directory containing:
- `embeddings.db` – SQLite database with vectors
- `metadata.json` – index version, model info

## Setup Flow

On first run (`isFirstRun: true`), the agent should:

1. **Create directory structure** with sensible defaults
2. **Guide identity creation** through conversation:
   - "What should I call you?"
   - "Any particular way you'd like me to work with you?"
   - "What are you working on right now?"
3. **Optionally initialize git** for version tracking
4. **Create initial state files** with placeholders

This mirrors how Acme and Innie developed their identities collaboratively rather than from a template.

## Git Integration

Optional but encouraged:

- On state file write: `git add && git commit -m "Update {file}"`
- Allows rollback of accidental changes
- Provides history of how patterns evolved
- Configured via `macrodata.json` settings

## Configuration

`~/.config/macrodata/macrodata.json`:

```json
{
  "git": {
    "enabled": true,
    "autoCommit": true,
    "remote": null
  },
  "search": {
    "model": "all-MiniLM-L6-v2",
    "indexOnWrite": true
  },
  "daemon": {
    "enabled": true,
    "checkInterval": 60000
  }
}
```

## What This Doesn't Include

- **Remote sync** – that's the cloud plugin's job
- **Multi-machine coordination** – use the cloud plugin for that
- **Team features** – this is personal memory only

## Migration Path

For users who want to move from local to cloud:

1. Export identity and state files
2. Upload to remote macrodata service
3. Switch plugin configuration

The file formats are compatible between local and cloud.
