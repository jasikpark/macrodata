#!/usr/bin/env bun
/**
 * Version script for changesets.
 * Runs changeset version, then syncs version to plugin manifests.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

// Run changeset version first
execSync("bunx changeset version", { cwd: root, stdio: "inherit" });

// Read the new version from the package
const pkgPath = join(root, "plugins/macrodata/package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const version = pkg.version;

console.log(`Syncing version ${version} to plugin manifests...`);

// Sync to .claude-plugin/plugin.json
const pluginJsonPath = join(root, "plugins/macrodata/.claude-plugin/plugin.json");
const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
pluginJson.version = version;
writeFileSync(pluginJsonPath, JSON.stringify(pluginJson, null, "\t") + "\n");

// Sync to root marketplace.json
const marketplacePath = join(root, ".claude-plugin/marketplace.json");
const marketplace = JSON.parse(readFileSync(marketplacePath, "utf-8"));
marketplace.plugins[0].version = version;
writeFileSync(marketplacePath, JSON.stringify(marketplace, null, "\t") + "\n");

console.log("Version sync complete.");
