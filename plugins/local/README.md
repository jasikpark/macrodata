# Macrodata Local Plugin

Local file-based memory for Claude Code. Zero infrastructure, fully offline, optional git tracking.

## Installation

Add to your Claude Code plugins directory:

```bash
cd ~/.claude/plugins
git clone https://github.com/ascorbic/macrodata
ln -s macrodata/plugins/local macrodata-local
```

Or add to your Claude settings:

```json
{
  "plugins": [
    {
      "path": "/path/to/macrodata/plugins/local"
    }
  ]
}
```

## What It Does

1. **Session context injection** - On session start, injects your identity, current state (inbox, today, commitments), and recent journal entries
2. **File-based memory** - All state stored as markdown files in `~/.config/macrodata/`
3. **Semantic search** - Search across your journal and entity files (people, projects)
4. **Scheduling** - Cron-based and one-shot reminders

## File Structure

```
~/.config/macrodata/
├── identity.md          # Your persona and patterns
├── state/
│   ├── inbox.md         # Quick capture
│   ├── today.md         # Daily focus
│   └── commitments.md   # Active threads
├── entities/
│   ├── people/          # One file per person
│   └── projects/        # One file per project
├── journal/             # JSONL, date-partitioned
├── signals/             # Raw events for future analysis
└── .index/              # Embeddings cache
```

## MCP Tools

The plugin provides 9 tools. State and entity files are read/written using Claude Code's built-in filesystem tools.

| Tool | Purpose |
|------|---------|
| `get_context` | Session bootstrap - returns identity, state, journal, schedules, paths |
| `log_journal` | Append timestamped entry to journal |
| `get_recent_journal` | Get N most recent journal entries |
| `log_signal` | Log raw events for later analysis |
| `search_memory` | Semantic search across journal and entities |
| `schedule_reminder` | Create recurring reminder (cron) |
| `schedule_once` | Create one-shot reminder |
| `list_reminders` | List active schedules |
| `remove_reminder` | Delete a reminder |

## First Run

On first run (no identity.md exists), the plugin will prompt you to set up your identity through conversation:

1. What should the agent call you?
2. Any particular way you'd like it to work with you?
3. What are you working on right now?

The agent will create your identity.md and initial state files.

## Configuration

Set `MACRODATA_ROOT` environment variable to change the state directory (default: `~/.config/macrodata`).

## Daemon

A background daemon handles:
- Scheduled reminders (cron and one-shot)
- File watching for index updates

The daemon is automatically started by the hook script on session start.
