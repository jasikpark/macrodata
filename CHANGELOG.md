# Changelog

All notable changes to this fork of [ascorbic/macrodata](https://github.com/ascorbic/macrodata) are tracked here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries land on `main` as part of the change that introduces them. The next version bump publishes them.

## [Unreleased]

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

<!-- Compare links omitted until version tags exist. Tag a release with e.g. `jj git push --change @ --remote origin` after creating a tag, or `git tag v0.2.2 <sha> && git push origin v0.2.2` if working through git. -->

