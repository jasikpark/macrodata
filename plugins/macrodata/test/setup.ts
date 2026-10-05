/**
 * Preloaded before every test file (bunfig.toml). Recall's on/off switch reads
 * the developer's own environment and Claude Code settings file, so without this
 * a machine with recall turned off fails every test that expects a worker.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const configDir = mkdtempSync(join(tmpdir(), "macrodata-claude-config-"));
process.env.CLAUDE_CONFIG_DIR = configDir;
afterAll(() => rmSync(configDir, { recursive: true, force: true }));
delete process.env.MACRODATA_RECALL_DISABLE;
delete process.env.CLAUDE_PLUGIN_OPTION_RECALL_ENABLED;
