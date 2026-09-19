/**
 * Canonical corpus projection tests.
 *
 * Tests call the public corpus-projection interface only — projectJournalFile,
 * projectEntityFile, scanCorpus — never parsing internals. Everything runs in an
 * isolated temp state root via MACRODATA_ROOT.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, type TestContext } from "./helpers";
import { writeFileSync, mkdirSync, chmodSync, symlinkSync, rmSync, unlinkSync } from "fs";
import { join } from "path";

const corpus = await import("../src/corpus.ts");

describe("corpus projection", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext("macrodata-corpus-test-");
  });

  afterEach(() => {
    ctx.cleanup();
  });

  describe("journal projection", () => {
    test("projects a journal file deterministically", () => {
      mkdirSync(ctx.journalDir, { recursive: true });
      const file = join(ctx.journalDir, "2026-09-18.jsonl");
      writeFileSync(
        file,
        [
          JSON.stringify({
            timestamp: "2026-09-18T10:00:00.000Z",
            topic: "alpha",
            content: "first entry",
          }),
          JSON.stringify({
            timestamp: "2026-09-18T11:00:00.000Z",
            topic: "beta",
            content: "second entry",
          }),
          "",
        ].join("\n") + "\n",
      );

      const snap = corpus.projectJournalFile(file);
      expect(snap.status).toBe("ok");
      expect(snap.kind).toBe("journal");
      expect(snap.source).toBe("2026-09-18.jsonl");
      expect(snap.error).toBeUndefined();
      expect(snap.items).toEqual([
        {
          id: "journal-2026-09-18.jsonl-0",
          type: "journal",
          content: "[alpha] first entry",
          source: "2026-09-18.jsonl",
          timestamp: "2026-09-18T10:00:00.000Z",
        },
        {
          id: "journal-2026-09-18.jsonl-1",
          type: "journal",
          content: "[beta] second entry",
          source: "2026-09-18.jsonl",
          timestamp: "2026-09-18T11:00:00.000Z",
        },
      ]);

      // Deterministic: two projections of the same file are identical.
      const again = corpus.projectJournalFile(file);
      expect(again).toEqual(snap);
    });

    test("a malformed line marks the source incomplete but keeps valid lines", () => {
      mkdirSync(ctx.journalDir, { recursive: true });
      const file = join(ctx.journalDir, "mixed.jsonl");
      writeFileSync(
        file,
        [
          JSON.stringify({ timestamp: "2026-09-18T10:00:00.000Z", topic: "ok", content: "good" }),
          "{not json",
          JSON.stringify({
            timestamp: "2026-09-18T12:00:00.000Z",
            topic: "also",
            content: "still good",
          }),
        ].join("\n"),
      );

      const snap = corpus.projectJournalFile(file);
      expect(snap.status).toBe("incomplete");
      expect(snap.items).toHaveLength(2); // valid lines are never discarded
      expect(snap.items[0]?.content).toBe("[ok] good");
      expect(snap.items[1]?.content).toBe("[also] still good");
      expect(snap.error).toBeDefined();
      expect(String(snap.error)).toContain("malformed");
    });

    test("non-object JSON values (null, string, array) count as malformed, not items", () => {
      mkdirSync(ctx.journalDir, { recursive: true });
      const file = join(ctx.journalDir, "shapes.jsonl");
      writeFileSync(
        file,
        [
          JSON.stringify({ timestamp: "2026-09-18T10:00:00.000Z", topic: "ok", content: "good" }),
          "null",
          '"5"',
          "[1,2,3]",
          JSON.stringify({ topic: 5, content: "bad topic type" }),
          JSON.stringify({ topic: "bad content type", content: null }),
        ].join("\n"),
      );

      const snap = corpus.projectJournalFile(file);
      expect(snap.status).toBe("incomplete");
      // Only the one well-formed object with string topic/content survives.
      expect(snap.items).toHaveLength(1);
      expect(snap.items[0]?.content).toBe("[ok] good");
      expect(String(snap.error)).toContain("malformed: 5 of 6 lines unparsable");
      // None of the malformed values leak through as "[undefined] undefined"
      // or similar coerced garbage.
      expect(snap.items.some((i) => i.content.includes("undefined"))).toBe(false);
    });

    test("an unreadable journal file is incomplete, never valid-but-empty", () => {
      mkdirSync(ctx.journalDir, { recursive: true });
      const file = join(ctx.journalDir, "locked.jsonl");
      writeFileSync(file, JSON.stringify({ timestamp: "t", topic: "x", content: "y" }));
      chmodSync(file, 0o000);
      try {
        const snap = corpus.projectJournalFile(file);
        expect(snap.status).toBe("incomplete");
        expect(snap.error).toBeDefined();
        expect(snap.source).toBe("locked.jsonl");
      } finally {
        chmodSync(file, 0o644);
      }
    });
  });

  describe("entity projection", () => {
    test("projects preamble and sections deterministically", () => {
      const dir = join(ctx.entitiesDir, "people");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "alice.md");
      writeFileSync(
        file,
        "# Alice\n\nIntro line.\n\n## About\n\nEngineer.\n\n## Notes\n\nFrontend.\n",
      );

      const snap = corpus.projectEntityFile(file);
      expect(snap.status).toBe("ok");
      expect(snap.kind).toBe("entity");
      expect(snap.source).toBe("people/alice.md");
      expect(snap.type).toBe("people");
      expect(snap.items).toEqual([
        {
          id: "people-alice-preamble",
          type: "people",
          content: "# Alice\n\nIntro line.",
          source: "people/alice.md",
          section: "preamble",
        },
        {
          id: "people-alice-1",
          type: "people",
          content: "## About\n\nEngineer.",
          source: "people/alice.md",
          section: "About",
        },
        {
          id: "people-alice-2",
          type: "people",
          content: "## Notes\n\nFrontend.",
          source: "people/alice.md",
          section: "Notes",
        },
      ]);
      expect(corpus.projectEntityFile(file)).toEqual(snap);
    });

    test("nested files keep their full category-relative path in source and id", () => {
      const dir = join(ctx.entitiesDir, "people", "team");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "bob.md");
      writeFileSync(file, "# Bob\n\nNested entity.\n");

      const snap = corpus.projectEntityFile(file);
      expect(snap.status).toBe("ok");
      expect(snap.source).toBe("people/team/bob.md");
      expect(snap.type).toBe("people");
      expect(snap.items).toHaveLength(1);
      expect(snap.items[0]?.id).toBe("people-team/bob-preamble");
      expect(snap.items[0]?.source).toBe("people/team/bob.md");
    });

    test("empty body sections and empty preamble produce no items but ok status", () => {
      const dir = join(ctx.entitiesDir, "projects");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "empty.md");
      writeFileSync(file, "");

      const snap = corpus.projectEntityFile(file);
      expect(snap.status).toBe("ok");
      expect(snap.items).toEqual([]);
    });

    test("an unreadable entity file is incomplete, never valid-but-empty", () => {
      const dir = join(ctx.entitiesDir, "people");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "locked.md");
      writeFileSync(file, "# X");
      chmodSync(file, 0o000);
      try {
        const snap = corpus.projectEntityFile(file);
        expect(snap.status).toBe("incomplete");
        expect(snap.error).toBeDefined();
        expect(snap.items).toEqual([]);
      } finally {
        chmodSync(file, 0o644);
      }
    });

    // Regression: indexEntityFile (src/indexer.ts) calls projectEntityFile
    // directly on a single path — it does not go through listSources' walk
    // at all. That is exactly the seam the daemon's live chokidar watcher
    // uses on every add/change event, so a symlink named like an entity file
    // dropped into entities/ must be refused here too, not only when
    // discovered by a batch scanCorpus() walk. Without this, a symlink
    // could reach the searchable MiniLM index by a path scanCorpus's own
    // symlink test never exercises.
    test("a symlink is excluded via the public projectEntityFile seam directly, not only via scanCorpus", () => {
      const dir = join(ctx.entitiesDir, "people");
      mkdirSync(dir, { recursive: true });
      const outside = join(ctx.root, "..", `outside-projectentityfile-${Date.now()}.md`);
      writeFileSync(outside, "# Secret\n\nnot for the corpus\n");
      try {
        const link = join(dir, "linked.md");
        symlinkSync(outside, link);

        const snap = corpus.projectEntityFile(link);
        expect(snap.status).toBe("incomplete");
        expect(snap.kind).toBe("entity");
        expect(snap.source).toBe("people/linked.md");
        expect(snap.error).toBe("symlink excluded from corpus");
        expect(snap.items).toEqual([]);
      } finally {
        try {
          unlinkSync(outside);
        } catch {
          /* best effort */
        }
      }
    });

    test("a root-level entity file with no category folder is rejected as incomplete", () => {
      const file = join(ctx.entitiesDir, "note.md");
      mkdirSync(ctx.entitiesDir, { recursive: true });
      writeFileSync(file, "# Note\n\nStray root file.\n");

      const snap = corpus.projectEntityFile(file);
      expect(snap.status).toBe("incomplete");
      expect(snap.error).toBe("entity file must live under a category folder");
      expect(snap.items).toEqual([]);
      // The bogus category-less type must never be the literal filename.
      expect(snap.type).toBe("entities");
      expect(snap.type).not.toBe("note.md");
    });

    test("a stray root-level entity file produces no items and no double-dash / filename-typed ids via scanCorpus", () => {
      mkdirSync(join(ctx.entitiesDir, "people"), { recursive: true });
      writeFileSync(join(ctx.entitiesDir, "people", "alice.md"), "# Alice\n\nNormal.\n");
      writeFileSync(join(ctx.entitiesDir, "note.md"), "# Note\n\nStray root file.\n");

      const proj = corpus.scanCorpus();
      // The stray root file is a failure...
      expect(proj.failures.some((f) => f.source === "note.md")).toBe(true);
      // ...and produces no items.
      expect(proj.items.some((i) => i.source === "note.md")).toBe(false);
      // No item id anywhere carries the double-dash signature of a
      // category-less stem (type + "-" + "" + "-preamble" == "note.md--preamble").
      for (const item of proj.items) {
        expect(item.id).not.toContain("--");
        expect(item.type).not.toBe("note.md");
      }
      // The unaffected category file is still projected normally.
      expect(proj.items.map((i) => i.id)).toContain("people-alice-preamble");
    });
  });

  describe("scanCorpus", () => {
    test("scans every immediate category plus nested paths, skipping dot dirs", () => {
      // Immediate and nested entity files.
      writeFileSync(join(ctx.entitiesDir, "people", "alice.md"), "# Alice\n\nImmediate.\n");
      mkdirSync(join(ctx.entitiesDir, "people", "team"), { recursive: true });
      writeFileSync(join(ctx.entitiesDir, "people", "team", "bob.md"), "# Bob\n\nNested.\n");
      writeFileSync(join(ctx.entitiesDir, "projects", "widget.md"), "# W\n\n## Status\n\nLive.\n");
      // Dot-dir artifacts must not appear at any depth.
      mkdirSync(join(ctx.entitiesDir, ".trash"), { recursive: true });
      writeFileSync(join(ctx.entitiesDir, ".trash", "gone.md"), "# G");
      mkdirSync(join(ctx.entitiesDir, "people", ".obsidian"), { recursive: true });
      writeFileSync(join(ctx.entitiesDir, "people", ".obsidian", "cfg.md"), "# C");
      // Dot-file inside a real dir: excluded, same policy as dot dirs.
      writeFileSync(join(ctx.entitiesDir, "people", ".hidden.md"), "# H");

      writeFileSync(
        join(ctx.journalDir, "2026-09-18.jsonl"),
        JSON.stringify({ timestamp: "t1", topic: "a", content: "one" }) + "\n",
      );
      writeFileSync(
        join(ctx.journalDir, "2026-09-19.jsonl"),
        JSON.stringify({ timestamp: "t2", topic: "b", content: "two" }) + "\n",
      );

      const proj = corpus.scanCorpus();
      expect(proj.complete).toBe(true);
      expect(proj.failures).toEqual([]);

      const ids = proj.items.map((i) => i.id).sort();
      expect(ids).toEqual(
        [
          "journal-2026-09-18.jsonl-0",
          "journal-2026-09-19.jsonl-0",
          "people-alice-preamble",
          "people-team/bob-preamble",
          "projects-widget-1",
          "projects-widget-preamble",
        ].sort(),
      );
      // Dot files and dot dirs never leak into the corpus.
      expect(ids.join(",")).not.toContain("hidden");
      expect(ids.join(",")).not.toContain("gone");
      expect(ids.join(",")).not.toContain("cfg");
    });

    test("missing journal and entities directories project as complete and empty", () => {
      const proj = corpus.scanCorpus();
      expect(proj.complete).toBe(true);
      expect(proj.items).toEqual([]);
      expect(proj.snapshots).toEqual([]);
    });

    test("a failed source marks the whole scan incomplete and lists it as a failure", () => {
      writeFileSync(join(ctx.entitiesDir, "people", "alice.md"), "# Alice\n\nHi.\n");
      const locked = join(ctx.journalDir, "locked.jsonl");
      writeFileSync(locked, JSON.stringify({ timestamp: "t", topic: "x", content: "y" }));
      chmodSync(locked, 0o000);
      try {
        const proj = corpus.scanCorpus();
        expect(proj.complete).toBe(false);
        expect(proj.failures).toHaveLength(1);
        expect(proj.failures[0]?.status).toBe("incomplete");
        expect(proj.failures[0]?.source).toBe("locked.jsonl");
        // Valid, readable material is still projected.
        expect(proj.items.map((i) => i.id)).toContain("people-alice-preamble");
      } finally {
        chmodSync(locked, 0o644);
      }
    });

    test("scan is deterministic across repeated calls", () => {
      writeFileSync(join(ctx.entitiesDir, "people", "alice.md"), "# A\n\nP.\n");
      const a = corpus.scanCorpus();
      const b = corpus.scanCorpus();
      expect(b).toEqual(a);
    });

    test("an existing root whose listing fails forces the scan incomplete", () => {
      // Reliable fixture, not timing: chmod the journal ROOT unreadable after
      // writing files into it. readdirSync fails deterministically.
      writeFileSync(
        join(ctx.journalDir, "2026-09-18.jsonl"),
        JSON.stringify({ timestamp: "t", topic: "a", content: "one" }) + "\n",
      );
      chmodSync(ctx.journalDir, 0o000);
      try {
        const proj = corpus.scanCorpus();
        expect(proj.complete).toBe(false);
        expect(proj.failures).toHaveLength(1);
        const f = proj.failures[0]!;
        expect(f.status).toBe("incomplete");
        expect(f.kind).toBe("journal");
        expect(f.error).toContain("listing failed");
        // The hidden file must not leak out as authoritative items either.
        expect(proj.items).toEqual([]);
        // A directory-listing failure is a source seen during the scan too:
        // it must appear in snapshots, not only in the failures subset.
        expect(proj.snapshots).toContainEqual(f);
      } finally {
        chmodSync(ctx.journalDir, 0o755);
      }
    });

    // Regression: dirFailure/symlinkFailure derived `type` from
    // `source.split("/")[0] || "entities"`. For an entities-ROOT failure the
    // source identity is "." (relativeSource of the root against itself),
    // and "." is truthy, so the type landed as the literal string "." instead
    // of falling through to the "entities" default — the fallback was
    // unreachable for exactly the case it was meant to cover.
    test("a failure at the entities root itself is typed \"entities\", not \".\"", () => {
      chmodSync(ctx.entitiesDir, 0o000);
      try {
        const proj = corpus.scanCorpus();
        expect(proj.complete).toBe(false);
        expect(proj.failures).toHaveLength(1);
        const f = proj.failures[0]!;
        expect(f.source).toBe(".");
        expect(f.kind).toBe("entity");
        expect(f.type).toBe("entities");
      } finally {
        chmodSync(ctx.entitiesDir, 0o755);
      }
    });

    test("a nested subtree whose listing fails forces the scan incomplete", () => {
      writeFileSync(join(ctx.entitiesDir, "people", "alice.md"), "# Alice\n\nReadable.\n");
      const nested = join(ctx.entitiesDir, "people", "team");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "bob.md"), "# Bob");
      chmodSync(nested, 0o000);
      try {
        const proj = corpus.scanCorpus();
        expect(proj.complete).toBe(false);
        expect(proj.failures).toHaveLength(1);
        const f = proj.failures[0]!;
        expect(f.status).toBe("incomplete");
        expect(f.kind).toBe("entity");
        expect(f.error).toContain("listing failed");
        // Readable material outside the broken subtree is still projected.
        expect(proj.items.map((i) => i.id)).toContain("people-alice-preamble");
        // The directory failure is a seen source; it belongs in snapshots too.
        expect(proj.snapshots).toContainEqual(f);
      } finally {
        chmodSync(nested, 0o755);
      }
    });

    test("a symlinked file is never read into the corpus, even when it targets a real file outside the store", () => {
      // The adversarial case: a symlink named like a corpus file pointing at
      // a sensitive file entirely outside MACRODATA_ROOT. If followed, its
      // content would land in a searchable index.
      const outside = join(ctx.root, "..", `outside-secret-${Date.now()}.md`);
      writeFileSync(outside, "# Secret\n\nnot for the corpus\n");
      try {
        const link = join(ctx.entitiesDir, "people", "linked.md");
        symlinkSync(outside, link);

        const proj = corpus.scanCorpus();
        expect(proj.complete).toBe(false);
        expect(proj.failures).toHaveLength(1);
        const f = proj.failures[0]!;
        expect(f.status).toBe("incomplete");
        expect(f.kind).toBe("entity");
        expect(f.source).toBe("people/linked.md");
        expect(f.error).toBe("symlink excluded from corpus");
        // The linked-to content must never appear as an item anywhere.
        expect(proj.items.some((i) => i.content.includes("not for the corpus"))).toBe(false);
        expect(proj.items).toEqual([]);
        // Seen during the scan, so it belongs in snapshots too.
        expect(proj.snapshots).toContainEqual(f);
      } finally {
        try {
          unlinkSync(outside);
        } catch {
          /* best effort */
        }
      }
    });

    test("a symlinked directory is excluded, not silently dropped", () => {
      const outsideDir = join(ctx.root, "..", `outside-dir-${Date.now()}`);
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, "hidden.md"), "# Hidden\n\nshould never be indexed\n");
      try {
        const link = join(ctx.entitiesDir, "linked-dir");
        symlinkSync(outsideDir, link);

        const proj = corpus.scanCorpus();
        expect(proj.complete).toBe(false);
        expect(proj.failures).toHaveLength(1);
        const f = proj.failures[0]!;
        expect(f.status).toBe("incomplete");
        expect(f.kind).toBe("entity");
        expect(f.source).toBe("linked-dir");
        expect(f.error).toBe("symlink excluded from corpus");
        // Nothing under the linked directory was walked or indexed.
        expect(proj.items.some((i) => i.content.includes("should never be indexed"))).toBe(false);
        expect(proj.items).toEqual([]);
        expect(proj.snapshots).toContainEqual(f);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });
});
