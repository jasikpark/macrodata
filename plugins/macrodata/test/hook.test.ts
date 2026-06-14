/**
 * Integration tests for the hook script (macrodata-hook.sh)
 *
 * As of the per-file-hook sharding, macrodata-hook.sh no longer composes the
 * memory context. session-start only manages the daemon + emits the first-run
 * nudge; prompt-submit only injects daemon-written pending context. State is
 * delivered by compose-state-file.ts / compose-lists.ts (tested separately).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync, spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import {
  createTestContext,
  setupMinimalState,
  addJournalEntry,
  addReminder,
  type TestContext,
} from "./helpers";

const HOOK_SCRIPT = join(dirname(import.meta.dir), "bin", "macrodata-hook.sh");

// `stdin` feeds the hook's stdin JSON (where prompt-submit reads session_id).
// Always pass something — an empty pipe gives jq an immediate EOF so it never
// blocks waiting for input.
function runHook(
  ctx: TestContext,
  command: "session-start" | "prompt-submit",
  stdin = ""
): string {
  try {
    return execSync(`MACRODATA_ROOT="${ctx.root}" bash "${HOOK_SCRIPT}" ${command}`, {
      encoding: "utf-8",
      timeout: 10000,
      input: stdin,
      env: { ...process.env, MACRODATA_ROOT: ctx.root },
    });
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string };
    return error.stdout || "";
  }
}

// Async variant for true-concurrency tests — runs the hook in a real child
// process so several can race the claim simultaneously (execSync is blocking).
function runHookAsync(
  ctx: TestContext,
  command: "session-start" | "prompt-submit",
  stdin = ""
): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("bash", [HOOK_SCRIPT, command], {
      env: { ...process.env, MACRODATA_ROOT: ctx.root },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(out));
    child.on("error", () => resolve(out));
    child.stdin.write(stdin);
    child.stdin.end();
  });
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

  describe("prompt-submit scheduled-task reminders", () => {
    const SESSION = JSON.stringify({ session_id: "sess-1" });

    function writeReminder(name: string, content: string) {
      const dir = join(ctx.root, ".pending-reminders");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), content);
    }

    function remindersLeft(): string[] {
      const dir = join(ctx.root, ".pending-reminders");
      return existsSync(dir) ? readdirSync(dir) : [];
    }

    test("injects a fired reminder and claims (removes) it", () => {
      writeReminder("dreamtime__1000", "<macrodata-scheduled-task id=\"dreamtime\">run /dreamtime</macrodata-scheduled-task>\n");

      const output = runHook(ctx, "prompt-submit", SESSION);
      expect(output).toContain("run /dreamtime");
      // Claimed: original gone, no leftover .claimed.* files either.
      expect(remindersLeft()).toEqual([]);
    });

    test("claims exactly-once — a second session's drain sees nothing", () => {
      writeReminder("distill__1", "<x>claim-once-marker</x>\n");

      const first = runHook(ctx, "prompt-submit", JSON.stringify({ session_id: "a" }));
      expect(first).toContain("claim-once-marker");

      const second = runHook(ctx, "prompt-submit", JSON.stringify({ session_id: "b" }));
      expect(second).not.toContain("claim-once-marker");
    });

    test("injects every queued reminder in one drain", () => {
      writeReminder("a__1", "<x>FIRST-TASK</x>\n");
      writeReminder("b__2", "<x>SECOND-TASK</x>\n");

      const output = runHook(ctx, "prompt-submit", SESSION);
      expect(output).toContain("FIRST-TASK");
      expect(output).toContain("SECOND-TASK");
      expect(remindersLeft()).toEqual([]);
    });

    test("skips half-written tmp files and leftover .claimed files", () => {
      writeReminder(".dreamtime.tmp", "HALF-WRITTEN\n");
      writeReminder("x.claimed.deadsession.999", "ALREADY-CLAIMED\n");

      const output = runHook(ctx, "prompt-submit", SESSION);
      expect(output).not.toContain("HALF-WRITTEN");
      expect(output).not.toContain("ALREADY-CLAIMED");
    });

    test("a hostile session_id cannot escape the pending dir or break the claim", () => {
      writeReminder("dreamtime", "<x>HOSTILE-SID-MARKER</x>\n");

      // session_id is external (harness stdin) and lands in the claim filename;
      // a path-traversal / shell-metachar value must be neutralized, not honored.
      const output = runHook(
        ctx,
        "prompt-submit",
        JSON.stringify({ session_id: "../../../etc/x; rm -rf / $(touch pwned)" })
      );

      expect(output).toContain("HOSTILE-SID-MARKER"); // still claimed + emitted
      expect(remindersLeft()).toEqual([]); // claimed in-place, no orphan, no escape
    });

    test("concurrent drains claim a reminder exactly once (atomic-rename lock)", async () => {
      writeReminder("dreamtime", "<x>RACE-MARKER</x>\n");

      // Five sessions race the same single reminder file simultaneously.
      const outputs = await Promise.all(
        [1, 2, 3, 4, 5].map((i) =>
          runHookAsync(ctx, "prompt-submit", JSON.stringify({ session_id: `s${i}` }))
        )
      );

      const winners = outputs.filter((o) => o.includes("RACE-MARKER")).length;
      expect(winners).toBe(1); // exactly one session emits it, never two
      expect(remindersLeft()).toEqual([]); // claimed + removed, no orphan
    });
  });
});
