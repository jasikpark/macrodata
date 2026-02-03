# Macrodata

Stateful agent capabilities for Claude Code and OpenCode, packaged as a regular plugin.

- **Layered memory** - others have done this
- **Scheduling and autonomy** - less common
- **Dream time** - reflects on memory and identity, rewrites its own code

Local-first. Everything stored as markdown you can read and edit.

## What It Does

Remembers who you are, what you're working on, what happened yesterday. Schedules tasks to run while you sleep. Reflects on its own patterns and improves itself.

Works inside your normal coding workflow. No separate agent system to run, no new interface to learn. Open Claude Code, do your work, close it. The memory persists.

Most memory plugins store and retrieve context. This one has agency - it runs tasks on a schedule, maintains itself, and evolves over time.

## Quick Start

### Claude Code

```bash
/plugin marketplace add ascorbic/macrodata
/plugin install macrodata@macrodata
```

First run guides you through setup.

### OpenCode

```bash
bun add opencode-macrodata
```

**opencode.json:**
```json
{
  "plugin": ["opencode-macrodata"]
}
```

## Features

**Memory:**
- Identity and preferences persist across sessions
- Journal for observations, decisions, learnings
- Semantic search across everything
- Session summaries for context recovery

**Scheduling:**
- Cron-based recurring reminders
- One-shot scheduled tasks
- Background daemon

**Autonomy:**
- Morning prep to set daily focus
- Memory maintenance to clean up and consolidate
- Dream time for reflection and self-improvement

## State Directory

Human-readable markdown and JSONL:

```
~/.config/macrodata/
├── identity.md           # Agent persona
├── state/
│   ├── human.md          # Your profile
│   ├── today.md          # Daily focus
│   └── workspace.md      # Current context
├── entities/
│   ├── people/           # One file per person
│   └── projects/         # One file per project
├── journal/              # JSONL, date-partitioned
└── .schedules.json       # Active reminders
```

## Configuration

State directory: `~/.claude/macrodata.json` (Claude Code) or `~/.config/opencode/macrodata.json` (OpenCode):

```json
{
  "root": "/path/to/your/state"
}
```

Or `MACRODATA_ROOT` env var. Default: `~/.config/macrodata`

## Development

```bash
git clone https://github.com/ascorbic/macrodata
cd macrodata/plugins/macrodata
bun install
bun run start
```

## License

MIT
