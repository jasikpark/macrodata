/**
 * Integration tests for the hook script (macrodata-hook.sh)
 *
 * As of the per-file-hook sharding, macrodata-hook.sh no longer composes the
 * memory context. session-start only manages the daemon + emits the first-run
 * nudge; prompt-submit only injects daemon-written pending context. State is
 * delivered by compose-state-file.ts / compose-lists.ts (tested separately).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import {
  createTestContext,
  setupMinimalState,
  addJournalEntry,
  addReminder,
  type TestContext,
} from "./helpers";

const HOOK_SCRIPT = join(dirname(import.meta.dir), "bin", "macrodata-hook.sh");

function runHook(ctx: TestContext, command: "session-start" | "prompt-submit"): string {
  try {
    return execSync(`MACRODATA_ROOT="${ctx.root}" bash "${HOOK_SCRIPT}" ${command}`, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, MACRODATA_ROOT: ctx.root },
    });
  } catch (err: unknown) {
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
    test("emits no inline context when configured (state comes from per-file hooks)", () => {
      // The monolithic composer was removed: identity/today/human/workspace,
      // journal/schedules, usage, and files each have their own SessionStart
      // hook now. With identity present, this hook only manages the daemon and
      // emits nothing to stdout.
      expect(runHook(ctx, "session-start").trim()).toBe("");
    });

    test("does not emit the old monolithic <macrodata> sections", () => {
      addJournalEntry(ctx, "t", "x");
      addReminder(ctx, "r", { type: "cron", expression: "0 9 * * *", description: "d", payload: "p" });
      const output = runHook(ctx, "session-start");
      for (const tag of [
        "<macrodata-identity>",
        "<macrodata-today>",
        "<macrodata-journal>",
        "<macrodata-schedules>",
        "<macrodata-files",
      ]) {
        expect(output).not.toContain(tag);
      }
    });

    test("does not write the legacy .claude-context.md / lastmod files", () => {
      runHook(ctx, "session-start");
      expect(existsSync(join(ctx.root, ".claude-context.md"))).toBe(false);
      expect(existsSync(join(ctx.root, ".context-lastmod.json"))).toBe(false);
    });
  });

  describe("first-run detection", () => {
    test("shows the first-run nudge when there is no identity file", () => {
      const identityFile = join(ctx.stateDir, "identity.md");
      if (existsSync(identityFile)) unlinkSync(identityFile);

      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-first-run");
      expect(output).toContain("/onboarding");
    });
  });

  describe("prompt-submit", () => {
    test("injects pending daemon context and clears it", () => {
      const pendingFile = join(ctx.root, ".pending-context");
      writeFileSync(pendingFile, "<macrodata-update>Test update</macrodata-update>\n");

      const output = runHook(ctx, "prompt-submit");
      expect(output).toContain("Test update");

      const remaining = existsSync(pendingFile) ? readFileSync(pendingFile, "utf-8") : "";
      expect(remaining).toBe("");
    });

    test("does not re-inject state on file change (state is SessionStart-only now)", () => {
      runHook(ctx, "session-start");
      writeFileSync(join(ctx.stateDir, "today.md"), "# Today\n\nModified content for testing.\n");

      const output = runHook(ctx, "prompt-submit");
      expect(output).not.toContain("Modified content for testing");
    });
  });
});
