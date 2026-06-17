---
"macrodata": patch
---

Re-add changesets-driven release automation (versioning only, no npm publish). `bun run version` runs `changeset version` and syncs the bumped version into `plugin.json` + `marketplace.json`; `changeset tag` creates the `vX.Y.Z` git tag. The release workflow uses the default `GITHUB_TOKEN` (no GitHub App) and never publishes to npm — the package is now `private`, and the plugin installs via the Claude Code marketplace. Replaces the manual 3-file version bump.
