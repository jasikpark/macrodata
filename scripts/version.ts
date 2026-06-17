#!/usr/bin/env bun
/**
 * Version script for changesets.
 *
 * The repo ROOT package (`macrodata`) is a workspace member (`workspaces` lists
 * `"."`) and is the versioned package, so `changeset version` writes the
 * changelog to the root `CHANGELOG.md` natively. The nested plugin package
 * (`@macrodata/opencode`) is changeset-ignored (see .changeset/config.json).
 * This step then syncs the new root version into the plugin's package.json and
 * the two Claude Code plugin manifests, so all four stay in lockstep off a
 * single source (the root version).
 *
 * (History: re-added from upstream ascorbic/macrodata 3a739907 on 2026-06-17 —
 * the fork had removed it with the changesets machinery, but its version sync
 * was exactly what the manual release process was redoing by hand.)
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

// Bump the root package + write root CHANGELOG.md, consuming the changesets.
execSync("bunx changeset version", { cwd: root, stdio: "inherit" });

// Root package = single source of truth for the version.
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version;
console.log(`Syncing version ${version} to plugin package + manifests...`);

// Sync into each target, preserving its existing indent.
const sync = (relPath: string, indent: string | number, mutate: (j: any) => void) => {
  const p = join(root, relPath);
  const j = JSON.parse(readFileSync(p, "utf-8"));
  mutate(j);
  writeFileSync(p, JSON.stringify(j, null, indent) + "\n");
};

sync("plugins/macrodata/package.json", 2, (j) => (j.version = version));
sync("plugins/macrodata/.claude-plugin/plugin.json", "\t", (j) => (j.version = version));
sync(".claude-plugin/marketplace.json", "\t", (j) => (j.plugins[0].version = version));

console.log("Version sync complete.");
