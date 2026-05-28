# Changelog

All notable changes to this fork of [ascorbic/macrodata](https://github.com/ascorbic/macrodata) are tracked here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries land on `main` as part of the change that introduces them. The next version bump publishes them.

## [Unreleased]

### Added

- Budget-aware SessionStart composer at `plugins/macrodata/bin/compose-context.ts`. Each section (identity, today, human, workspace, journal, schedules, usage, files) gets a fixed UTF-16 `.length` budget under the 10,000-char hook-output cliff (anthropics/claude-code#44086 — exceeding it silently truncates to a 2,000-char preview). Three section shapes:
  - **Forcing-function** (identity/today/human/workspace): head-keep + a final `<macrodata-truncation-warning>` block. The in-band marker carries a visible `…`, the size delta, and a per-section pointer to where the full content lives (`… [shown first 1500 of 78896 chars (head-keep); full content: state/today.md]`), and the cut snaps back to the last line boundary so it never slices mid-word. Both marker and warning are framed as **display-only** truncation (the file on disk is intact) and steer the agent to distill/summarize, offload detail into an entity with a `[[wikilink]]`, or relocate append-only content to the journal — explicitly **never delete** substantive content to fit.
  - **Progressive-disclosure** (journal/schedules): per-entry snippet (180-char cap on journal first-lines) + footer pointer at full-content tools (`get_recent_journal`, `search_memory`, `list_reminders`).
  - **Static** (usage/files): bundled doc + file index; head-keep when oversize.
  - Production impact on a heavily-bloated state: SessionStart output drops from ~128,000 chars to ~8,300 chars, restoring full inline visibility.
- Input-hardening on the composer (from an adversarial review): per-entry `zod` validation in the journal loader so one malformed JSONL record can no longer throw and collapse the whole section to `_Journal unavailable_`; per-loader `try/catch` (plus a guarded `statSync` in `loadFiles`) so an unreadable file or a broken symlink in `entities/` degrades to `_section unavailable_` instead of crashing the composer and injecting an empty context; and entity-escaping of literal `</macrodata*` / `<macrodata*` tag-openers in section bodies so file content (e.g. docs about this very format) can't close a wrapper early or forge a sibling block.
- Snapshot tests at `plugins/macrodata/test/compose-context.test.ts` covering first-run, under-budget, single-section bloat, all-sections bloat, head-keep prefix preservation, UTF-16 `.length` budget semantics (surrogate-pair emoji vs BMP CJK), progressive-disclosure shape for journal and schedules (inline snapshots), and the input-hardening cases above — including a `fast-check` property test asserting arbitrary state-file content stays under the 10K cliff with exactly one intact section closer.

### Changed

- `plugins/macrodata/bin/macrodata-hook.sh` `inject_static_context()` collapses from a 56-line heredoc to a 10-line delegation to `compose-context.ts`.

## [0.2.3] — 2026-05-22

### Added

- New `/remember` skill at `plugins/macrodata/skills/remember/SKILL.md`. Thin trigger that maps "save the conversation" / `/remember` to `save_conversation_summary`. Intentionally minimal — no prescription of what the summary looks like; the tool's schema and session context handle the rest.

### Changed

- Plugin version bumped from `0.2.2` to `0.2.3` in `marketplace.json`, `plugin.json`, and `package.json` so the marketplace picks up the new skill on `/plugin upgrade`.

## [0.2.2] — 2026-05-22

### Added

- New `UserPromptSubmit` hook `bin/suggest-memory-tools.sh`: emits a static `<macrodata-tools-hint>` block nudging the model to call `mcp__plugin_macrodata_macrodata__search_memory`, `mcp__plugin_macrodata_macrodata__get_recent_journal`, or `mcp__plugin_qmd_qmd__query` when recall is actually needed. Cost: one shell exec per prompt, no bun startup, no index reads.
- `systemMessage` on the new hook so you can see `[macrodata] injected reminder about search_memory + qmd recall tools` per turn (the `additionalContext` block alone is only visible to the model).

### Changed

- Plugin version bumped from `0.2.1` to `0.2.2` in `marketplace.json`, `plugin.json`, and `package.json` so the marketplace picks up the new release on `/plugin upgrade`.

### Deprecated

- `bin/ambient-memory.ts` and `bin/ambient-memory-qmd.ts` are no longer registered in `plugin.json`. Both files remain in-tree with `DEPRECATED 2026-05-22 — DELETE ME` headers explaining the burn-in verdict (operationally-useful surfacings on <10% of turns at 2–28s/prompt latency). Slated for deletion if nothing reaches for them within a couple months.

### Notes

- This version exists because two prior `feat(ambient)` commits — one adding the parallel qmd hook for A/B comparison, one retiring both hooks — landed on `main` without a version bump. The marketplace tracks by version, not git SHA, so consumers couldn't see either change until this release rolled them up.

## [0.2.1] — 2026-05-21

### Added

- Cross-encoder reranking layer over the bi-encoder search, with `MACRODATA_AMBIENT_RERANK=1` toggle and `MACRODATA_AMBIENT_DUAL=1` to surface a vector-only eval block alongside the reranked one. `MACRODATA_AMBIENT_CANDIDATE_K=40` widens the slate handed to the cross-encoder so title-less section chunks have a better shot at landing in it.

[Unreleased]: https://github.com/jasikpark/macrodata/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/jasikpark/macrodata/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/jasikpark/macrodata/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/jasikpark/macrodata/releases/tag/v0.2.1

