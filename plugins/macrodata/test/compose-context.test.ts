import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { appendFileSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import fc from "fast-check";
import {
  createTestContext,
  setupMinimalState,
  addJournalEntry,
  addReminder,
  type TestContext,
} from "./helpers";

const COMPOSER = join(import.meta.dir, "..", "bin", "compose-context.ts");

function compose(ctx: TestContext): string {
  return execSync(`bun "${COMPOSER}" "${ctx.root}"`, {
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      MACRODATA_ROOT: ctx.root,
      // Point USAGE.md at a non-existent path so the bundled doc doesn't bleed
      // into the test (it's 4.6KB and would always overflow the 300 budget).
      MACRODATA_USAGE_PATH: join(ctx.root, "no-such-usage.md"),
    },
  });
}

describe("compose-context", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  describe("first-run", () => {
    test("emits first-run block when identity.md missing", () => {
      const output = compose(ctx);
      expect(output).toContain("<macrodata-first-run");
      expect(output).not.toContain("<macrodata-identity");
      expect(output).not.toContain("<macrodata-truncation-warning");
    });
  });

  describe("under budget", () => {
    test("minimal state fits with no truncation and no warning", () => {
      setupMinimalState(ctx);
      // Pin one journal entry with a fixed timestamp so snapshots are stable.
      addJournalEntry(ctx, "test", "hello world", new Date("2026-05-28T12:00:00Z"));
      addReminder(ctx, "test-reminder", {
        type: "cron",
        expression: "0 9 * * *",
        description: "test reminder",
        payload: "noop",
      });

      const output = compose(ctx);

      expect(output).not.toContain("truncated=");
      expect(output).not.toContain("<macrodata-truncation-warning");
      expect(output.length).toBeLessThan(9500);
      // Scrub the temp-dir path so the snapshot is stable across runs.
      const scrubbed = output.replaceAll(ctx.root, "<CTX_ROOT>");
      expect(scrubbed).toMatchSnapshot();
    });
  });

  describe("over budget — head-keep truncation", () => {
    test("single oversized section truncates and warning fires", () => {
      setupMinimalState(ctx);
      // identity.md budget is 1300; emit 5000 ASCII chars to force truncation.
      const bloat = "BLOAT_CONTENT_LINE\n".repeat(300); // ~5700 chars
      writeFileSync(join(ctx.stateDir, "identity.md"), bloat);

      const output = compose(ctx);

      expect(output).toMatch(/<macrodata-identity truncated="\d+→1300">/);
      expect(output).toContain("shown first");
      expect(output).toContain('<macrodata-truncation-warning count="1"');
      expect(output.length).toBeLessThan(10000);
    });

    test("all 4 state files bloated stays under the 10K cliff", () => {
      setupMinimalState(ctx);
      const bloat = "X".repeat(20000);
      writeFileSync(join(ctx.stateDir, "identity.md"), bloat);
      writeFileSync(join(ctx.stateDir, "today.md"), bloat);
      writeFileSync(join(ctx.stateDir, "human.md"), bloat);
      writeFileSync(join(ctx.stateDir, "workspace.md"), bloat);

      const output = compose(ctx);

      expect(output.length).toBeLessThan(10000);
      expect(output).toContain('<macrodata-truncation-warning count="4"');
      // Full-output snapshot: shows the truncation warning block and all
      // surrounding wrappers verbatim. The X-bloat inside each section is
      // collapsed to `<N X's>` so the snapshot diffs on structure/warning
      // copy rather than the bloat itself.
      const scrubbed = output
        .replaceAll(ctx.root, "<CTX_ROOT>")
        .replace(/X{20,}/g, (m) => `<${m.length} X's>`);
      expect(scrubbed).toMatchSnapshot();
    });

    test("head-keep preserves prefix, drops suffix", () => {
      setupMinimalState(ctx);
      const head = "# HEAD_MARKER\n\n";
      const tail = "\n\n# TAIL_MARKER_SHOULD_BE_DROPPED";
      const middle = "M".repeat(5000);
      writeFileSync(join(ctx.stateDir, "identity.md"), head + middle + tail);

      const output = compose(ctx);

      expect(output).toContain("HEAD_MARKER");
      expect(output).not.toContain("TAIL_MARKER_SHOULD_BE_DROPPED");
    });
  });

  describe("progressive disclosure", () => {
    function extractSection(output: string, tag: string): string {
      const re = new RegExp(`<macrodata-${tag}[^>]*>([\\s\\S]*?)</macrodata-${tag}>`);
      return output.match(re)?.[1].trim() ?? "";
    }

    test("long journal first-lines truncate per-entry with footer pointer", () => {
      setupMinimalState(ctx);
      addJournalEntry(ctx, "bloat", "x".repeat(500), new Date("2026-05-28T12:00:00Z"));

      const journal = extractSection(compose(ctx), "journal");

      expect(journal).toMatchInlineSnapshot(`
"- [2026-05-28 07:00] [bloat] xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…
_More: \`get_recent_journal\` (chronological), \`search_memory\` (semantic)._"
`);
    });

    test("schedules section appends list_reminders pointer", () => {
      setupMinimalState(ctx);
      addReminder(ctx, "test-reminder", {
        type: "cron",
        expression: "0 9 * * *",
        description: "morning check",
        payload: "noop",
      });

      const schedules = extractSection(compose(ctx), "schedules");

      expect(schedules).toMatchInlineSnapshot(`
"- morning check (cron: 0 9 * * *)
_More: \`list_reminders\` for full payloads._"
`);
    });
  });

  describe("UTF-16 .length budgeting", () => {
    test("surrogate-pair emoji counts as 2 UTF-16 units toward budget", () => {
      setupMinimalState(ctx);
      // 😀 = 2 UTF-16 code units. 700 × 😀 = 1,400 .length > 1,300 budget.
      // But 700 codepoints would NOT exceed if measured as codepoints.
      // This test fails if the budget is mistakenly counting codepoints.
      const emoji = "😀".repeat(700);
      writeFileSync(join(ctx.stateDir, "identity.md"), emoji);

      const output = compose(ctx);

      expect(output).toContain('<macrodata-identity truncated="1400→1300">');
    });

    test("BMP chars count as 1 UTF-16 unit", () => {
      setupMinimalState(ctx);
      // 日 = 1 UTF-16 code unit, 1 codepoint, 3 UTF-8 bytes.
      // 1,200 × 日 = 1,200 .length < 1,300 budget → no truncation.
      // This test fails if the budget is mistakenly counting bytes.
      const cjk = "日".repeat(1200);
      writeFileSync(join(ctx.stateDir, "identity.md"), cjk);

      const output = compose(ctx);

      expect(output).not.toContain("<macrodata-identity truncated=");
    });
  });

  describe("budget sum invariant", () => {
    test("section budgets sum to <= MAX_BUDGET", () => {
      // Pragmatic check: the composer's own guard exits 1 on overrun.
      // If this test is failing, edit SECTIONS[*].budget in compose-context.ts.
      setupMinimalState(ctx);
      expect(() => compose(ctx)).not.toThrow();
    });
  });

  // Regression coverage for the VDD adversarial-review findings.
  describe("hardening", () => {
    function extractSection(output: string, tag: string): string {
      const re = new RegExp(`<macrodata-${tag}[^>]*>([\\s\\S]*?)</macrodata-${tag}>`);
      return output.match(re)?.[1].trim() ?? "";
    }

    test("one malformed journal entry does not collapse the whole section", () => {
      setupMinimalState(ctx);
      // A well-formed entry plus a structurally-valid-JSON entry missing its
      // timestamp. Pre-fix, the bad entry threw inside the map and the single
      // catch swallowed it, erasing ALL entries to "_Journal unavailable_".
      addJournalEntry(ctx, "good", "real entry", new Date("2026-05-28T12:00:00Z"));
      const journalPath = join(ctx.journalDir, "2026-05-28.jsonl");
      appendFileSync(
        journalPath,
        JSON.stringify({ topic: "bad", content: "no timestamp here" }) + "\n",
      );

      const journal = extractSection(compose(ctx), "journal");

      expect(journal).toContain("real entry");
      expect(journal).not.toContain("_Journal unavailable_");
      expect(journal).not.toContain("no timestamp here");
    });

    test("a null/unparseable timestamp is skipped, not rendered as 1969", () => {
      setupMinimalState(ctx);
      addJournalEntry(ctx, "good", "real entry", new Date("2026-05-28T12:00:00Z"));
      appendFileSync(
        join(ctx.journalDir, "2026-05-28.jsonl"),
        JSON.stringify({ timestamp: null, topic: "bad", content: "epoch leak" }) + "\n",
      );

      const journal = extractSection(compose(ctx), "journal");

      expect(journal).toContain("real entry");
      expect(journal).not.toContain("1969");
      expect(journal).not.toContain("epoch leak");
    });

    test("literal closing tag in a state file is neutralized, structure intact", () => {
      setupMinimalState(ctx);
      // Plausible in THIS repo: a state file documenting macrodata's own format.
      writeFileSync(
        join(ctx.stateDir, "identity.md"),
        "Docs: the identity block ends with </macrodata-identity>.",
      );

      const output = compose(ctx);

      // The "<" is entity-escaped so it can't close the wrapper early.
      expect(output).toContain("&lt;/macrodata-identity>");
      // Exactly one REAL closer for the section — no early close, no forgery.
      expect(output.split("</macrodata-identity>").length - 1).toBe(1);
    });

    test("a broken symlink in entities/ does not crash the composer", () => {
      setupMinimalState(ctx);
      // statSync follows symlinks and throws ENOENT on a dangling one. Pre-fix,
      // this exited nonzero and the hook injected an empty context silently.
      symlinkSync(
        join(ctx.entitiesDir, "does-not-exist"),
        join(ctx.entitiesDir, "people", "dangling.md"),
      );

      const output = compose(ctx);

      expect(output).toContain("<macrodata>");
      expect(output).toContain("</macrodata>");
      expect(output).toContain("<macrodata-files");
    });

    // Property: no matter what a state file contains, the composer must stay
    // under the hard 10K cliff AND emit exactly one real </macrodata-identity>
    // closer. Subprocess-per-run keeps numRuns modest.
    test("property: arbitrary identity content stays under the cliff with intact structure", () => {
      setupMinimalState(ctx);
      fc.assert(
        fc.property(fc.string({ maxLength: 30_000 }), (content) => {
          writeFileSync(join(ctx.stateDir, "identity.md"), content);
          const output = compose(ctx);
          if (output.length >= 10_000) return false;
          return output.split("</macrodata-identity>").length - 1 === 1;
        }),
        { numRuns: 20 },
      );
    }, 30_000);
  });
});
