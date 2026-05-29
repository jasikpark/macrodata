# Changelog

All notable changes to this fork of [ascorbic/macrodata](https://github.com/ascorbic/macrodata) are tracked here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries land on `main` as part of the change that introduces them. The next version bump publishes them.

## [Unreleased]

## [0.2.6] — 2026-05-29

### Changed

- **SessionStart state is now sharded into per-file hooks.** Each state file is injected by its own hook so it gets its own ~10,000-char hook-output envelope (anthropics/claude-code#44086 caps each hook output string independently and runs SessionStart hooks in parallel), instead of all sections fighting inside one envelope and cliff-truncating to a 2K preview.
  - New `plugins/macrodata/bin/compose-state-file.ts` (reusable): `bun compose-state-file.ts today.md` → reads `state/<file>`, head-keeps to that file's cap (**chars _and_ lines, whichever first**), neutralizes `</macrodata*` tag-openers, wraps in `<macrodata-<tag>>`, and emits a display-only truncation marker (pointing at the intact file + nudging distill / `[[wikilink]]`-out / journal-relocate, never delete) when clipped. Per-file caps live in a `BUDGETS` table; default **9,000 chars / 150 lines** (start-high, tune-down — the char cap binds at launch, the line cap starts dormant as a concision lever). Registered 4× in `plugin.json` (identity/today/human/workspace).
  - New `plugins/macrodata/bin/compose-lists.ts`: journal + schedules in one hook, carrying the progressive-disclosure bounding (per-entry `zod` validation, first-line cap, footer pointers), a touch more generous (7 entries / 500-char first-lines — set from real data: journal first-lines average ~377 chars, so the prior 220 truncated ~64% of entries mid-sentence).
  - `plugins/macrodata/bin/macrodata-hook.sh` `session-start` no longer composes context — it now only manages the daemon (`start_daemon`/`signal_daemon_reload`) and emits the first-run `/onboarding` nudge when unconfigured. `inject_static_context`, the bash journal/schedules helpers, and the `prompt-submit` `check_files_changed` re-injection are removed (mid-session state changes are the daemon `.pending-context` channel's job).
- Tests: `compose-state-file.test.ts` and `compose-lists.test.ts` (inline snapshots + `fast-check` property tests — caps/whichever-first, neutralization, missing-file, malformed-entry skip, bounding); `hook.test.ts` rewritten to the new contract (session-start emits nothing when configured; first-run nudge; no prompt-submit re-injection); and `sessionstart-integration.test.ts` — a full-output snapshot that builds a complete mock store and runs every SessionStart hook in `plugin.json` registration order (also fails if a hook is removed/reordered/renamed or starts emitting unexpected content).
- Injection hardening (from an adversarial review): all schedule fields (`type`/`expression`, not just `description`) are tag-neutralized so a hostile reminder `expression` can't forge a sibling block; the first-run `<macrodata-detected-user>` JSON is tag-neutralized so a hostile git/GECOS name can't break the wrapper; surrogate-pair-split slices drop a trailing lone high surrogate (no `U+FFFD` mojibake) in both composers; and `compose-state-file.ts` hard-bounds its final output so a degenerate sub-marker-length cap can't exceed the budget.

### Notes

- Supersedes the closed PR #2 (single budget-aware composer): a per-file head-keep hook is simpler than a multi-section allocator and gives each state file independent tuning. The dynamic-state cliff (was ~48K → 2K preview) is resolved by sharding; caps are pragmatic soft-ish defaults to tune empirically, not derived constants.
- Plugin version bumped from `0.2.5` to `0.2.6` in `marketplace.json`, `plugin.json`, and `package.json` so the marketplace picks up the sharded SessionStart hooks on `/plugin upgrade`.

## [0.2.5] — 2026-05-28

### Added

- Dedicated `SessionStart` hook for the **files manifest**: `plugins/macrodata/bin/compose-files.ts` (TypeScript) + thin wrapper `plugins/macrodata/bin/inject-files.sh`, registered as a third no-matcher `SessionStart` entry in `plugin.json`. Renders a Letta-MemFS-style "filetree-as-index": one line per state/entity file, `- <path> — <description>` when an **entity** carries an authored frontmatter `description:`, else a bare `- <path>`, plus a single aggregate footer counting the entities still lacking one (a nudge to add it). Descriptions are read **only** from authored frontmatter — never scraped from the body/heading (a scraped heading just echoes the filename). **State files (`state/*.md`) are exempt** — they're always injected in full by the dynamic-state composer, so the manifest lists them as plain pointers and never nudges for a description; descriptions earn their keep only on entities, whose bodies are not injected. Runs in its own ~10K hook-output envelope so the index never competes with the composer's budget. Tag-openers in descriptions are entity-escaped (injection hardening); a defensive head-keep guards against a pathological store exceeding the cap.
- `USAGE.md` documents the `description:` frontmatter convention in the Entities section (what it's for, that it feeds the manifest, that missing ones are nudged, and that state files are exempt) — written as "describe what the file *is*, not its status" so descriptions don't drift.
- The memory skills now teach the `description:` convention so newly-created/updated entities carry one: `onboarding` (+ OpenCode variant) shows an entity-file template with `description:` frontmatter; `distill`, `memory-maintenance`, and `dreamtime` (+ OpenCode variants) instruct adding/preserving it, and `memory-maintenance` backfills missing ones. Examples use synthetic stand-ins, not real personal data.
- The `onboarding` state-file templates (identity/today/human/workspace, + OpenCode variant) now ship with a `description:` frontmatter cribbed from `USAGE.md`'s explanation of each file. State files stay **manifest-exempt** (the listing still shows them as bare pointers), but because they're injected in full, the description rides along inline as a per-file purpose reminder — mirroring Letta's `block.description`.
- Tests at `plugins/macrodata/test/compose-files.test.ts`: inline snapshots for the rendering cases (state-file exemption, inline descriptions, no-scrape, footer presence/absence, description cap) and `fast-check` property tests (arbitrary descriptions stay under the 10K cliff with exactly one intact closer; footer count always equals the number of undescribed entities).

### Changed

- `plugins/macrodata/bin/macrodata-hook.sh` no longer emits `<macrodata-files>` from its monolithic `inject_static_context` heredoc (the `list_state_files` helper is removed); the files manifest now comes solely from the dedicated hook above, so it is never double-injected and is no longer truncated inside the big state blob.
- Plugin version bumped from `0.2.4` to `0.2.5` in `marketplace.json`, `plugin.json`, and `package.json` so the marketplace picks up the files manifest + the skills convention on `/plugin upgrade`.

## [0.2.4] — 2026-05-28

### Added

- Dedicated `SessionStart` hook `plugins/macrodata/bin/inject-usage.sh` that injects `USAGE.md` in full. Registered as a second (no-matcher) `SessionStart` entry in `plugin.json`, so the ~4.7K guide lands in its own ~10,000-char hook-output envelope (anthropics/claude-code#44086 caps each hook output string independently; multiple SessionStart hooks run in parallel) instead of competing for budget inside the main state blob. No-matcher means it fires on `startup`/`resume`/`clear`/`compact` — and re-firing on `compact` is what keeps the guide present after compaction.

### Changed

- `plugins/macrodata/bin/macrodata-hook.sh` no longer emits `<macrodata-usage>` from its monolithic `inject_static_context` heredoc (the `get_usage` helper is removed); USAGE.md now comes solely from the dedicated hook above, so it is never double-injected.
- Plugin version bumped from `0.2.3` to `0.2.4` in `marketplace.json`, `plugin.json`, and `package.json` so the marketplace picks up the new hook on `/plugin upgrade`.

### Misc

- `.gitignore`: ignore the local `.gest/` task store.

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

[Unreleased]: https://github.com/jasikpark/macrodata/compare/v0.2.6...HEAD
[0.2.6]: https://github.com/jasikpark/macrodata/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/jasikpark/macrodata/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/jasikpark/macrodata/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/jasikpark/macrodata/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/jasikpark/macrodata/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/jasikpark/macrodata/releases/tag/v0.2.1

