# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Structure

```
macrodata/
└── plugins/
    └── macrodata/              # Local file-based memory plugin
        ├── .claude-plugin/     # Plugin metadata
        ├── bin/                # Daemon and hook scripts
        ├── skills/             # Plugin skills (e.g., onboarding)
        ├── opencode/           # OpenCode plugin variant
        └── src/                # MCP server source
            ├── index.ts        # MCP server with tool definitions
            ├── indexer.ts      # Vectra indexing logic
            └── embeddings.ts   # Transformers.js embeddings
```

## Build and Development Commands

```bash
# From plugins/macrodata/
bun install
bun run start       # Run MCP server
```

## Architecture

Macrodata provides persistent memory for AI coding agents. File-based, fully offline.

**Source** (`plugins/macrodata/`):
- `src/index.ts` - MCP server with 11 tools (log_journal, search_memory, etc.)
- `src/indexer.ts` - Vectra-based vector index for semantic search
- `src/embeddings.ts` - Transformers.js embedding generation (Xenova/all-MiniLM-L6-v2)
- `bin/macrodata-daemon.ts` - Background daemon for scheduled reminders

**Storage** (default `~/.config/macrodata/`):
- `state/` - Always-in-context files (identity.md, human.md, today.md, workspace.md)
- `entities/` - Markdown files in per-category subdirs (people, projects, topics, …)
- `journal/` - JSONL entries, date-partitioned
- `.index/` - Vectra embeddings cache

## Testing

```bash
# From plugins/macrodata/
bun test                        # full suite
bun test test/indexer.test.ts   # a single file
```

Two daemon tests (`SIGHUP reload`, `detects new schedules at runtime`) are `Bun.sleep`-timed and flake under full-suite CPU load; they pass in isolation. Re-run them isolated before treating either as a real failure.

## Releasing (manual — no CI/changesets)

Releases are made **by hand**; there is no release automation. (The upstream changesets machinery — `.changeset/`, `.github/workflows/release.yml`, `scripts/version.ts` — was removed as unused.) To cut a release:

1. Bump the version in three files, kept in lockstep: `.claude-plugin/marketplace.json`, `plugins/macrodata/.claude-plugin/plugin.json`, `plugins/macrodata/package.json`.
2. Move `CHANGELOG.md`'s `[Unreleased]` items into a new `## [X.Y.Z] — YYYY-MM-DD` section. A merged PR may have skipped its changelog entry — backfill it here.
3. Commit `release X.Y.Z`, tag `vX.Y.Z`, push the commit and the tag.

The installed plugin picks up a release via `/plugin update` + `/reload-plugins`; merged-but-unreleased `main` commits are NOT live in the running plugin until a release is cut.

## Conventions & gotchas

- **VCS:** `jj` (colocated with git). Open PRs ready, not draft — solo repo.
- **Entity types are folder names.** The `entities/<subdir>/` directory names ARE the indexable type set: `rebuildIndex`/`indexEntityFile` (`src/indexer.ts`) and the `search_memory` type filter (`src/index.ts`) all derive the type from the live folder list. Don't reintroduce a hardcoded type union — new categories must index automatically.
- **`manage_index` rebuild is upsert-only.** It re-scans and updates but does NOT purge records for deleted/renamed files: the daemon and MCP server are separate processes sharing one lock-free Vectra index, so a destructive rebuild would race. For a clean rebuild, delete the index dir (`rm -rf <root>/.index`) and rebuild.
- **`plugins/macrodata/opencode/` is a vestigial upstream variant**, not maintained here — don't assume it tracks `src/`.
