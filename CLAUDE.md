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

## Releasing (changesets — versioning only, no npm publish)

Releases are automated with [changesets](https://github.com/changesets/changesets), **version-only**: it never publishes to npm (the plugin installs via the Claude Code marketplace, and the package is `private`). The flow:

1. **Per change:** add a changeset — `bunx changeset` (pick a bump level, write a summary). Commit the `.changeset/*.md` with the PR. This is what keeps `CHANGELOG.md` honest (a skipped changeset = a missing changelog entry, the failure mode hit pre-0.4.0).
2. **On merge to `main`:** `.github/workflows/release.yml` opens/refreshes a **"ci: release"** PR via `changesets/action`. That PR runs `bun run version` → `changeset version` bumps `plugins/macrodata/package.json` + writes `CHANGELOG.md`, and `scripts/version.ts` syncs the new version into `plugin.json` + `marketplace.json` (the 3-file lockstep, automated).
3. **Merge the "ci: release" PR** → `changesets/action` runs `bunx changeset tag` to create the `vX.Y.Z` git tag. No npm publish.

Auth: default `GITHUB_TOKEN` (no GitHub App — the fork has no branch protection). Caveat: a Version PR opened by `GITHUB_TOKEN` does NOT trigger `test.yml` on itself (GitHub's anti-recursion rule); merge it anyway. Whether the action also creates a GitHub *Release* object (vs. just the tag) in `changeset tag` mode is unverified — confirm on the first real release.

The installed plugin picks up a release via `/plugin update` + `/reload-plugins`; merged-but-unreleased `main` commits are NOT live in the running plugin until a release is cut.

## Conventions & gotchas

- **VCS:** `jj` (colocated with git). Open PRs ready, not draft — solo repo.
- **Entity types are folder names.** The `entities/<subdir>/` directory names ARE the indexable type set: `rebuildIndex`/`indexEntityFile` (`src/indexer.ts`) and the `search_memory` type filter (`src/index.ts`) all derive the type from the live folder list. Don't reintroduce a hardcoded type union — new categories must index automatically.
- **`manage_index` rebuild is upsert-only.** It re-scans and updates but does NOT purge records for deleted/renamed files: the daemon and MCP server are separate processes sharing one lock-free Vectra index, so a destructive rebuild would race. For a clean rebuild, delete the index dir (`rm -rf <root>/.index`) and rebuild.
- **`plugins/macrodata/opencode/` is a vestigial upstream variant**, not maintained here — don't assume it tracks `src/`.
