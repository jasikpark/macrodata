# @macrodata/opencode

## 0.5.1

### Patch Changes

- [#21](https://github.com/jasikpark/macrodata/pull/21) [`c7864f1`](https://github.com/jasikpark/macrodata/commit/c7864f1b514358366dae47c797c68f9e9efeffde) Thanks [@jasikpark](https://github.com/jasikpark)! - context-doctor: clarify that the daemon auto-reindexes entity add/change incrementally (`indexEntityFile`, ~1s debounce), so a manual `manage_index` rebuild is only needed after **deletes or renames** — and for those the fix is `rm -rf <root>/.index` + rebuild, since rebuild is upsert-only and won't purge orphaned records. ([#20](https://github.com/jasikpark/macrodata/issues/20))

- [#21](https://github.com/jasikpark/macrodata/pull/21) [`c7864f1`](https://github.com/jasikpark/macrodata/commit/c7864f1b514358366dae47c797c68f9e9efeffde) Thanks [@jasikpark](https://github.com/jasikpark)! - Re-add changesets-driven release automation (versioning only, no npm publish). `bun run version` runs `changeset version` and syncs the bumped version into `plugin.json` + `marketplace.json`; `changeset tag` creates the `vX.Y.Z` git tag. The release workflow uses the default `GITHUB_TOKEN` (no GitHub App) and never publishes to npm — the package is now `private`, and the plugin installs via the Claude Code marketplace. Replaces the manual 3-file version bump.

## 0.2.1

### Patch Changes

- [#12](https://github.com/ascorbic/macrodata/pull/12) [`a8906f5`](https://github.com/ascorbic/macrodata/commit/a8906f5c98db2c16fe0d44f29c8d9ed339909d23) Thanks [@ascorbic](https://github.com/ascorbic)! - Update distill skill for SQLite session storage format

## 0.2.0

### Minor Changes

- [#9](https://github.com/ascorbic/macrodata/pull/9) [`9c37516`](https://github.com/ascorbic/macrodata/commit/9c37516367cec8474483373ace3b529ea87410f6) Thanks [@ascorbic](https://github.com/ascorbic)! - Read OpenCode conversations from SQLite instead of file-based storage. Uses `bun:sqlite` with no new dependencies. Fixes project resolution by joining session to project worktree. Requires OpenCode v1.2.0+.

### Patch Changes

- [#10](https://github.com/ascorbic/macrodata/pull/10) [`8c4d770`](https://github.com/ascorbic/macrodata/commit/8c4d7703ee52cb3809d0c4ab132849530f003174) Thanks [@ascorbic](https://github.com/ascorbic)! - Move context injection from chat.message hook to system prompt transform. Fixes session titles all showing as "innie memory system setup" because synthetic message parts were sent to the title generation LLM.

## 0.1.3

### Patch Changes

- [#5](https://github.com/ascorbic/macrodata/pull/5) [`acb2066`](https://github.com/ascorbic/macrodata/commit/acb20667b40435839f81359aba8a0904a394b43a) Thanks [@ascorbic](https://github.com/ascorbic)! - Include USAGE.md in published package

## 0.1.2

### Patch Changes

- [`bdec5e7`](https://github.com/ascorbic/macrodata/commit/bdec5e7ab8f7e1537ff63fdcc64672a836aa63e8) Thanks [@ascorbic](https://github.com/ascorbic)! - Improve context injection and fix schedules display

  - Use XML tags for context sections (better parsing)
  - Fix schedules to read from reminders directory
  - Add shared USAGE.md with explicit guidance
  - Dynamic entity directory scanning
  - Notify pending context on state/entity file changes

## 0.1.1

### Patch Changes

- [`5973e45`](https://github.com/ascorbic/macrodata/commit/5973e45f3e4a3fcf02011e525678f71f63ce2dd0) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix daemon file watcher and conversation indexing

  - Fix reminders watcher not detecting new files (watch directory instead of glob pattern)
  - Index both Claude Code and OpenCode conversations on daemon startup

- [`5dc8366`](https://github.com/ascorbic/macrodata/commit/5dc8366a6a9df8a274b0f8861151895effd30020) Thanks [@ascorbic](https://github.com/ascorbic)! - Add daemon hot-reload support and cleanup

  - Daemon now supports SIGHUP to reload config without restart
  - Daemon logs to file instead of console
  - Hook and OpenCode plugin signal daemon reload on session start
  - Context now lists actual state/entity files instead of just paths
  - Dynamic import of transformers library for faster startup
  - Remove redundant readStateFile and indexFile tools

## 0.1.0

### Minor Changes

- [`c53012e`](https://github.com/ascorbic/macrodata/commit/c53012eaaf031ccd812afc4d472754a8226f2f6c) Thanks [@ascorbic](https://github.com/ascorbic)! - Initial version
