---
"macrodata": patch
---

Generate the changelog at the repo root. The root is now a workspace member (`workspaces: ["."]`) with a name + version, so changesets versions the **root** package and `changeset version` writes `CHANGELOG.md` at the repo root natively (the [#1137](https://github.com/changesets/changesets/issues/1137) workaround); the nested `@macrodata/opencode` plugin package is changeset-`ignore`d. `scripts/version.ts` syncs the bumped root version into the plugin's package.json and both Claude Code plugin manifests. Removes the stale pre-fork upstream `plugins/macrodata/CHANGELOG.md`.
