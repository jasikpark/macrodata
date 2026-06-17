# Changesets

This repo uses [changesets](https://github.com/changesets/changesets) for
release automation — **versioning only, no npm publish** (the plugin installs
via the Claude Code marketplace, not npm).

## Workflow

1. With a change, add a changeset: `bunx changeset` (pick a bump, write a summary).
2. Merge the PR (the changeset `.md` rides along on `main`).
3. A **"ci: release"** PR is opened automatically. Merging it:
   - runs `bun run version` → `changeset version` bumps `@macrodata/opencode`
     and `scripts/version.ts` syncs that version into `plugin.json` +
     `marketplace.json`, and updates `CHANGELOG.md`;
   - runs `bunx changeset tag` → creates the `vX.Y.Z` git tag (no npm publish).
4. `/plugin update` + `/reload-plugins` picks up the released version.
