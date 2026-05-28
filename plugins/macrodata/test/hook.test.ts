/**
 * Integration tests for hook script
 *
 * Tests the shell script that integrates with Claude Code
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import {
  createTestContext,
  setupMinimalState,
  addJournalEntry,
  addReminder,
  type TestContext,
} from "./helpers";

// Get the hook script path
const HOOK_SCRIPT = join(dirname(import.meta.dir), "bin", "macrodata-hook.sh");

function runHook(ctx: TestContext, command: "session-start" | "prompt-submit"): string {
  try {
    return execSync(`MACRODATA_ROOT="${ctx.root}" bash "${HOOK_SCRIPT}" ${command}`, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, MACRODATA_ROOT: ctx.root },
    });
  } catch (err: unknown) {
    // Hook might fail if daemon can't start, but we still get output
    const error = err as { stdout?: string; stderr?: string };
    return error.stdout || "";
  }
}

describe("hook script", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
    setupMinimalState(ctx);
  });

  afterEach(() => {
    // Kill any daemon that might have started
    const pidFile = join(ctx.root, ".daemon.pid");
    if (existsSync(pidFile)) {
      try {
        const pid = readFileSync(pidFile, "utf-8").trim();
        execSync(`kill ${pid} 2>/dev/null || true`);
      } catch {
        // Ignore
      }
    }
    ctx.cleanup();
  });

  describe("session-start", () => {
    test("outputs macrodata context wrapper", () => {
      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata>");
      expect(output).toContain("</macrodata>");
    });

    test("includes identity section", () => {
      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-identity>");
      expect(output).toContain("Test Identity");
      expect(output).toContain("</macrodata-identity>");
    });

    test("includes today section", () => {
      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-today>");
      expect(output).toContain("Running integration tests");
      expect(output).toContain("</macrodata-today>");
    });

    test("includes human section", () => {
      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-human>");
      expect(output).toContain("Test user");
      expect(output).toContain("</macrodata-human>");
    });

    test("includes workspace section", () => {
      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-workspace>");
      expect(output).toContain("Integration testing");
      expect(output).toContain("</macrodata-workspace>");
    });

    test("includes journal entries", () => {
      addJournalEntry(ctx, "test-topic", "A journal entry for testing");

      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-journal>");
      expect(output).toContain("test-topic");
    });

    describe("journal slot contract", () => {
      function extractJournalSection(output: string): string {
        const match = output.match(/<macrodata-journal>([\s\S]*?)<\/macrodata-journal>/);
        return match ? match[1] : "";
      }

      function bulletLines(section: string): string[] {
        return section.split("\n").filter((l) => l.startsWith("- "));
      }

      test("renders exactly 5 bullet lines when journal has more than 5 entries", () => {
        const today = new Date("2026-05-27T10:00:00Z");
        for (let i = 1; i <= 7; i++) {
          addJournalEntry(ctx, "today", `entry ${i}`, today);
        }

        const section = extractJournalSection(runHook(ctx, "session-start"));
        expect(bulletLines(section)).toHaveLength(5);
      });

      test("does not produce blank lines between bullet entries", () => {
        const today = new Date("2026-05-27T10:00:00Z");
        for (let i = 1; i <= 5; i++) {
          addJournalEntry(ctx, "test", `entry ${i}`, today);
        }

        const section = extractJournalSection(runHook(ctx, "session-start")).trim();
        expect(section).not.toMatch(/\n\s*\n/);
      });

      test("does not mash entries from different files onto the same line", () => {
        const today = new Date("2026-05-27T10:00:00Z");
        const yesterday = new Date("2026-05-26T10:00:00Z");
        for (let i = 1; i <= 3; i++) {
          addJournalEntry(ctx, "today", `today-${i}`, today);
        }
        for (let i = 1; i <= 3; i++) {
          addJournalEntry(ctx, "yesterday", `yesterday-${i}`, yesterday);
        }

        const section = extractJournalSection(runHook(ctx, "session-start"));
        for (const line of bulletLines(section)) {
          const bulletCount = (line.match(/- \[/g) || []).length;
          expect(bulletCount).toBe(1);
        }
      });

      test("shows entries newest-first across files", () => {
        addJournalEntry(ctx, "oldest", "I came first", new Date("2026-05-25T10:00:00Z"));
        addJournalEntry(ctx, "middle", "I came second", new Date("2026-05-26T10:00:00Z"));
        addJournalEntry(ctx, "newest", "I came last", new Date("2026-05-27T10:00:00Z"));

        const lines = bulletLines(extractJournalSection(runHook(ctx, "session-start")));
        expect(lines[0]).toContain("newest");
        expect(lines[lines.length - 1]).toContain("oldest");
      });

      test("each entry starts with a YYYY-MM-DD HH:MM timestamp", () => {
        const today = new Date("2026-05-27T10:00:00Z");
        for (let i = 1; i <= 3; i++) {
          addJournalEntry(ctx, "test", `entry ${i}`, today);
        }

        const lines = bulletLines(extractJournalSection(runHook(ctx, "session-start")));
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          expect(line).toMatch(/^- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] \[[^\]]+\] /);
        }
      });
    });

    test("includes schedules section", () => {
      addReminder(ctx, "test-schedule", {
        type: "cron",
        expression: "0 9 * * *",
        description: "Morning check",
        payload: "Check stuff",
      });

      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-schedules>");
      expect(output).toContain("Morning check");
    });

    test("includes files listing", () => {
      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-files");
      expect(output).toContain(`root="${ctx.root}"`);
      expect(output).toContain("state/identity.md");
    });

    test("writes context file", () => {
      runHook(ctx, "session-start");
      const contextFile = join(ctx.root, ".claude-context.md");
      expect(existsSync(contextFile)).toBe(true);

      const content = readFileSync(contextFile, "utf-8");
      expect(content).toContain("<macrodata>");
    });

    test("stores lastmod file", () => {
      runHook(ctx, "session-start");
      const lastmodFile = join(ctx.root, ".context-lastmod.json");
      expect(existsSync(lastmodFile)).toBe(true);

      const content = JSON.parse(readFileSync(lastmodFile, "utf-8"));
      expect(content).toHaveProperty("identity");
      expect(content).toHaveProperty("today");
    });
  });

  describe("first-run detection", () => {
    test("shows first-run message when no identity file", () => {
      // Remove identity file
      const identityFile = join(ctx.stateDir, "identity.md");
      if (existsSync(identityFile)) {
        require("fs").unlinkSync(identityFile);
      }

      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-first-run");
      expect(output).toContain("/onboarding");
    });
  });

  describe("prompt-submit", () => {
    test("injects pending context", () => {
      // Write some pending context
      const pendingFile = join(ctx.root, ".pending-context");
      writeFileSync(pendingFile, "<macrodata-update>Test update</macrodata-update>\n");

      const output = runHook(ctx, "prompt-submit");
      expect(output).toContain("Test update");

      // Pending file should be cleared
      const remaining = existsSync(pendingFile)
        ? readFileSync(pendingFile, "utf-8")
        : "";
      expect(remaining).toBe("");
    });

    test("re-injects context when files change", () => {
      // First session-start to establish baseline
      runHook(ctx, "session-start");

      // Modify a state file
      const todayFile = join(ctx.stateDir, "today.md");
      writeFileSync(todayFile, "# Today\n\n## Now\n\nModified content for testing.\n");

      // Give filesystem a moment
      execSync("sleep 0.1");

      // prompt-submit should detect change and re-inject
      const output = runHook(ctx, "prompt-submit");
      expect(output).toContain("Modified content for testing");
    });
  });
});
