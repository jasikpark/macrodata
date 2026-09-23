/**
 * Incremental reconciliation of the ambient-recall index: reconcileCorpus and
 * reconcileSource embed only new or content-changed items, reuse vectors when
 * only metadata moved, and delete only what a clean read proves is gone.
 *
 * The embedder is mocked (the real one loads a multi-GB GGUF); every text it
 * receives is captured so tests can assert exactly what was re-embedded.
 */

import { mock, describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, type TestContext } from "./helpers";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  renameSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
} from "fs";
import { join } from "path";

const embedded: string[] = [];
// Set to N to make the embedder throw once N texts have been embedded.
let failAfter: number | null = null;

// Text-derived, so a reused vector is distinguishable from a fresh one.
function vectorOf(text: string): number[] {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return [1, (h & 0xff) / 255, ((h >> 8) & 0xff) / 255, ((h >> 16) & 0xff) / 255];
}

void mock.module("../src/recall/embeddings.ts", () => ({
  EMBEDDING_DIMENSIONS: 4,
  DEFAULT_TASK: "test task",
  embedDocument: async () => [1, 0, 0, 0],
  embedDocuments: async (texts: string[]) => {
    if (failAfter !== null && embedded.length + texts.length > failAfter) {
      throw new Error("embedder died");
    }
    embedded.push(...texts);
    return texts.map(vectorOf);
  },
  embedQuery: async () => [1, 0, 0, 0],
  preloadModel: async () => {},
}));

describe("recall reconciliation", () => {
  let ctx: TestContext;
  let recall: typeof import("../src/recall/indexer.ts");

  beforeEach(async () => {
    ctx = createTestContext("macrodata-recall-reconcile-test-");
    recall = await import("../src/recall/indexer.ts");
    recall.resetIndexCache();
    embedded.length = 0;
    failAfter = null;
  });

  afterEach(() => {
    recall.resetIndexCache();
    ctx.cleanup();
  });

  const entity = (rel: string) => join(ctx.entitiesDir, ...rel.split("/"));
  const journal = (name: string) => join(ctx.journalDir, name);

  function put(abs: string, body: string): void {
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }

  function line(topic: string, content: string, timestamp = "2026-09-23T00:00:00Z"): string {
    return JSON.stringify({ topic, content, timestamp });
  }

  const indexPath = () => join(ctx.root, ".recall", "index", "vectors", "index.json");

  /** Ids and sources currently committed to disk, read without the module cache. */
  function onDisk(): { id: string; source: string; timestamp?: string }[] {
    const raw = JSON.parse(
      readFileSync(join(ctx.root, ".recall", "index", "vectors", "index.json"), "utf-8"),
    );
    return raw.items
      .map((it: { id: string; metadata: { source: string; timestamp?: string } }) => ({
        id: it.id,
        source: it.metadata.source,
        timestamp: it.metadata.timestamp,
      }))
      .sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
  }

  const ids = () => onDisk().map((it) => it.id);

  test("a second pass over an unchanged corpus embeds nothing", async () => {
    put(entity("people/alice.md"), "# Alice\n\n## Role\n\nEngineer.\n");
    put(journal("2026-09-23.jsonl"), line("t", "one") + "\n");

    const first = await recall.reconcileCorpus();
    expect(first.embedded).toBe(3);

    embedded.length = 0;
    const second = await recall.reconcileCorpus();
    expect(second).toMatchObject({ embedded: 0, unchanged: 3, pruned: 0, complete: true });
    expect(embedded).toEqual([]);
  });

  test("add and change embed only the new and changed items", async () => {
    put(entity("people/alice.md"), "# Alice\n\n## Role\n\nEngineer.\n\n## Team\n\nInfra.\n");
    await recall.reconcileCorpus();
    embedded.length = 0;

    put(entity("people/alice.md"), "# Alice\n\n## Role\n\nManager.\n\n## Team\n\nInfra.\n");
    put(entity("people/bob.md"), "# Bob\n");
    const r = await recall.reconcileCorpus();

    expect(r).toMatchObject({ embedded: 2, unchanged: 2, pruned: 0 });
    expect(embedded.sort()).toEqual(["# Bob", "## Role\n\nManager."]);
  });

  test("a metadata-only change reuses the stored vector", async () => {
    put(journal("2026-09-23.jsonl"), line("t", "same", "2026-09-23T01:00:00Z") + "\n");
    await recall.reconcileCorpus();
    embedded.length = 0;

    put(journal("2026-09-23.jsonl"), line("t", "same", "2026-09-23T02:00:00Z") + "\n");
    const r = await recall.reconcileCorpus();

    expect(r).toMatchObject({ embedded: 0, relabeled: 1 });
    expect(embedded).toEqual([]);
    expect(onDisk()[0].timestamp).toBe("2026-09-23T02:00:00Z");
  });

  test("deleting a file prunes all of its vectors", async () => {
    put(entity("people/alice.md"), "# Alice\n\n## Role\n\nEngineer.\n");
    put(entity("people/bob.md"), "# Bob\n");
    await recall.reconcileCorpus();

    rmSync(entity("people/alice.md"));
    const r = await recall.reconcileCorpus();

    expect(r.pruned).toBe(2);
    expect(ids()).toEqual(["people-bob-preamble"]);
  });

  test("removing a section prunes that section only", async () => {
    put(entity("people/alice.md"), "# Alice\n\n## Role\n\nEngineer.\n\n## Team\n\nInfra.\n");
    await recall.reconcileCorpus();

    put(entity("people/alice.md"), "# Alice\n\n## Role\n\nEngineer.\n");
    const r = await recall.reconcileCorpus();

    expect(r).toMatchObject({ pruned: 1, embedded: 0 });
    expect(ids()).toEqual(["people-alice-1", "people-alice-preamble"]);
  });

  test("a rename converges: old ids gone, new ids present", async () => {
    put(entity("people/alice.md"), "# Alice\n");
    await recall.reconcileCorpus();

    renameSync(entity("people/alice.md"), entity("people/alicia.md"));
    const r = await recall.reconcileCorpus();

    expect(r).toMatchObject({ pruned: 1, embedded: 0, relabeled: 1 });
    expect(ids()).toEqual(["people-alicia-preamble"]);
  });

  test("a category move converges on the new type and source", async () => {
    put(entity("people/alice.md"), "# Alice\n");
    await recall.reconcileCorpus();

    mkdirSync(entity("projects"), { recursive: true });
    renameSync(entity("people/alice.md"), entity("projects/alice.md"));
    await recall.reconcileCorpus();

    expect(onDisk()).toEqual([
      { id: "projects-alice-preamble", source: "projects/alice.md", timestamp: undefined },
    ]);
  });

  test("a line inserted at the top of a journal re-embeds only the new line", async () => {
    put(journal("2026-09-23.jsonl"), [line("t", "a"), line("t", "b")].join("\n") + "\n");
    await recall.reconcileCorpus();
    embedded.length = 0;

    put(
      journal("2026-09-23.jsonl"),
      [line("t", "new"), line("t", "a"), line("t", "b")].join("\n") + "\n",
    );
    const r = await recall.reconcileCorpus();

    expect(r).toMatchObject({ embedded: 1, relabeled: 2, pruned: 0 });
    expect(embedded).toEqual(["[t] new"]);
  });

  test("force re-embeds everything even when content is unchanged", async () => {
    put(entity("people/alice.md"), "# Alice\n");
    await recall.reconcileCorpus();
    embedded.length = 0;

    const r = await recall.reconcileCorpus({ force: true });
    expect(r).toMatchObject({ embedded: 1, unchanged: 0 });
    expect(embedded).toEqual(["# Alice"]);
  });

  test("force replaces an unparsable index; plain reconcile refuses it", async () => {
    put(entity("people/alice.md"), "# Alice\n");
    await recall.reconcileCorpus();
    writeFileSync(indexPath(), '{"items": [');
    recall.resetIndexCache();

    expect(String(await recall.reconcileCorpus().catch((e) => e))).toContain("--full");
    expect(await recall.rebuildIndex()).toMatchObject({ itemCount: 1 });
    expect(ids()).toEqual(["people-alice-preamble"]);
  });

  test("a pass with nothing to do leaves index.json untouched", async () => {
    put(entity("people/alice.md"), "# Alice\n");
    await recall.reconcileCorpus();
    const before = statSync(indexPath()).mtimeMs;

    await Bun.sleep(20);
    await recall.reconcileCorpus();
    await recall.pruneOrphans();
    expect(statSync(indexPath()).mtimeMs).toBe(before);
  });

  test("an embedder failure keeps committed batches and the next pass resumes", async () => {
    // 200 items crosses the 128-item commit boundary once.
    const lines = Array.from({ length: 200 }, (_, i) => line("t", `n${i}`));
    put(journal("2026-09-23.jsonl"), lines.join("\n") + "\n");

    failAfter = 150;
    const err = await recall.reconcileCorpus().catch((e) => e);
    expect(String(err)).toContain("embedder died");
    expect(onDisk()).toHaveLength(128);

    failAfter = null;
    embedded.length = 0;
    const r = await recall.reconcileCorpus();
    expect(r).toMatchObject({ embedded: 72, unchanged: 128 });
    expect(onDisk()).toHaveLength(200);
  });

  test("concurrent calls in one process serialize instead of corrupting each other", async () => {
    put(entity("people/alice.md"), "# Alice\n");
    put(journal("2026-09-23.jsonl"), line("t", "a") + "\n");

    const results = await Promise.allSettled([
      recall.reconcileCorpus(),
      recall.reconcileSource(entity("people/alice.md")),
      recall.pruneOrphans(),
      recall.reconcileCorpus(),
    ]);

    expect(results.map((r) => r.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    expect(ids()).toEqual(["journal-2026-09-23.jsonl-0", "people-alice-preamble"]);
  });

  test("a missing journal root never prunes entity or journal vectors wholesale", async () => {
    put(entity("people/alice.md"), "# Alice\n");
    put(journal("2026-09-23.jsonl"), line("t", "a") + "\n");
    await recall.reconcileCorpus();

    rmSync(ctx.journalDir, { recursive: true, force: true });
    rmSync(entity("people/alice.md"));
    const r = await recall.reconcileCorpus();

    // The entity deletion is real; the journal vectors survive the missing root.
    expect(r.pruned).toBe(1);
    expect(ids()).toEqual(["journal-2026-09-23.jsonl-0"]);
  });

  describe("a partial scan", () => {
    test("never deletes an unreadable source's vectors", async () => {
      put(entity("people/alice.md"), "# Alice\n\n## Role\n\nEngineer.\n");
      put(entity("people/bob.md"), "# Bob\n");
      await recall.reconcileCorpus();

      chmodSync(entity("people/alice.md"), 0o000);
      try {
        const r = await recall.reconcileCorpus();
        expect(r).toMatchObject({ complete: false, pruned: 0 });
      } finally {
        chmodSync(entity("people/alice.md"), 0o644);
      }
      expect(ids()).toContain("people-alice-1");
    });

    test("never deletes a file that may sit under a directory that failed to list", async () => {
      put(entity("people/alice.md"), "# Alice\n");
      put(entity("projects/x.md"), "# X\n");
      await recall.reconcileCorpus();

      // projects/ unlistable taints everything under it: x.md is absent from
      // the scan but may still exist. alice's deletion is outside that prefix.
      rmSync(entity("projects/x.md"));
      rmSync(entity("people/alice.md"));
      chmodSync(entity("projects"), 0o000);
      try {
        const r = await recall.reconcileCorpus();
        expect(r).toMatchObject({ complete: false, pruned: 1 });
      } finally {
        chmodSync(entity("projects"), 0o755);
      }
      expect(ids()).toEqual(["projects-x-preamble"]);
    });

    test("a symlink elsewhere in the corpus does not block pruning a real deletion", async () => {
      put(entity("people/alice.md"), "# Alice\n");
      put(entity("people/bob.md"), "# Bob\n");
      await recall.reconcileCorpus();

      symlinkSync(entity("people/bob.md"), entity("people/bob-link.md"));
      rmSync(entity("people/alice.md"));
      const r = await recall.reconcileCorpus();

      expect(r).toMatchObject({ complete: false, pruned: 1 });
      expect(ids()).toEqual(["people-bob-preamble"]);
    });

    test("a journal line caught mid-append is not a malformed record", async () => {
      put(journal("2026-09-23.jsonl"), line("t", "a") + "\n" + '{"topic":"t","cont');
      const r = await recall.reconcileCorpus();
      expect(r).toMatchObject({ complete: true, itemCount: 1 });
    });

    test("an unlistable root keeps every vector of its kind", async () => {
      put(entity("people/alice.md"), "# Alice\n");
      put(journal("2026-09-23.jsonl"), line("t", "a") + "\n");
      await recall.reconcileCorpus();

      for (const root of [ctx.entitiesDir, ctx.journalDir]) {
        chmodSync(root, 0o000);
        try {
          expect(await recall.reconcileCorpus()).toMatchObject({ complete: false, pruned: 0 });
          expect(await recall.pruneOrphans()).toMatchObject({ pruned: 0 });
        } finally {
          chmodSync(root, 0o755);
        }
      }
      expect(ids()).toEqual(["journal-2026-09-23.jsonl-0", "people-alice-preamble"]);
    });

    test("a directory whose entries cannot be stat'd keeps their vectors", async () => {
      put(entity("projects/x.md"), "# X\n");
      await recall.reconcileCorpus();

      // Readable but not searchable: readdir lists x.md, every lstat under it
      // fails with EACCES.
      chmodSync(entity("projects"), 0o644);
      try {
        expect(await recall.reconcileCorpus()).toMatchObject({ complete: false, pruned: 0 });
      } finally {
        chmodSync(entity("projects"), 0o755);
      }
      expect(ids()).toEqual(["projects-x-preamble"]);
    });

    test("a file with a size but no allocated blocks is unread, not empty", async () => {
      put(entity("people/alice.md"), "# Alice\n");
      await recall.reconcileCorpus();

      // A sparse file has the same stat shape as an iCloud-evicted one.
      writeFileSync(entity("people/alice.md"), "");
      truncateSync(entity("people/alice.md"), 4096);
      expect(statSync(entity("people/alice.md")).blocks).toBe(0);
      expect(await recall.reconcileCorpus()).toMatchObject({ complete: false, pruned: 0 });
      expect(await recall.reconcileSource(entity("people/alice.md"))).toMatchObject({
        complete: false,
        pruned: 0,
      });
      expect(ids()).toEqual(["people-alice-preamble"]);
    });

    test("a truncated final journal line keeps its indexed vector", async () => {
      const file = journal("2026-09-23.jsonl");
      put(file, [line("t", "a"), line("t", "b")].join("\n") + "\n");
      await recall.reconcileCorpus();

      put(file, line("t", "a") + "\n" + line("t", "b").slice(0, 10));
      expect(await recall.reconcileCorpus()).toMatchObject({ complete: true, pruned: 0 });
      expect(await recall.reconcileSource(file)).toMatchObject({ pruned: 0 });
      expect(ids()).toEqual(["journal-2026-09-23.jsonl-0", "journal-2026-09-23.jsonl-1"]);

      // Once the line lands whole it is a normal record again.
      put(file, line("t", "a") + "\n");
      expect(await recall.reconcileSource(file)).toMatchObject({ pruned: 1 });
    });

    test("still prunes a removed section in a source that read cleanly", async () => {
      put(entity("people/alice.md"), "# Alice\n\n## Role\n\nEngineer.\n");
      put(entity("people/bob.md"), "# Bob\n");
      await recall.reconcileCorpus();

      put(entity("people/alice.md"), "# Alice\n");
      chmodSync(entity("people/bob.md"), 0o000);
      try {
        const r = await recall.reconcileCorpus();
        expect(r).toMatchObject({ complete: false, pruned: 1 });
      } finally {
        chmodSync(entity("people/bob.md"), 0o644);
      }
      expect(ids()).toEqual(["people-alice-preamble", "people-bob-preamble"]);
    });

    test("keeps a malformed journal's lines rather than reading them as deletions", async () => {
      put(journal("2026-09-23.jsonl"), [line("t", "a"), line("t", "b")].join("\n") + "\n");
      await recall.reconcileCorpus();

      put(journal("2026-09-23.jsonl"), [line("t", "a"), "{not json"].join("\n") + "\n");
      const r = await recall.reconcileCorpus();

      expect(r).toMatchObject({ complete: false, pruned: 0 });
      expect(ids()).toEqual(["journal-2026-09-23.jsonl-0", "journal-2026-09-23.jsonl-1"]);
    });
  });

  describe("reconcileSource", () => {
    test("touches only the named source", async () => {
      put(entity("people/alice.md"), "# Alice\n");
      put(entity("people/bob.md"), "# Bob\n");
      await recall.reconcileCorpus();
      embedded.length = 0;

      put(entity("people/alice.md"), "# Alice v2\n");
      put(entity("people/bob.md"), "# Bob v2\n");
      const r = await recall.reconcileSource(entity("people/alice.md"));

      expect(r).toMatchObject({ itemCount: 1, embedded: 1, pruned: 0 });
      expect(embedded).toEqual(["# Alice v2"]);
    });

    test("a deleted file prunes its source", async () => {
      put(entity("people/alice.md"), "# Alice\n\n## Role\n\nEngineer.\n");
      put(entity("people/bob.md"), "# Bob\n");
      await recall.reconcileCorpus();

      rmSync(entity("people/alice.md"));
      const r = await recall.reconcileSource(entity("people/alice.md"));

      expect(r).toMatchObject({ pruned: 2, complete: true });
      expect(ids()).toEqual(["people-bob-preamble"]);
    });

    test("a rename converges when both paths are reconciled", async () => {
      put(journal("2026-09-22.jsonl"), line("t", "a") + "\n");
      await recall.reconcileCorpus();

      renameSync(journal("2026-09-22.jsonl"), journal("2026-09-23.jsonl"));
      embedded.length = 0;
      await recall.reconcileSource(journal("2026-09-22.jsonl"));
      await recall.reconcileSource(journal("2026-09-23.jsonl"));

      expect(ids()).toEqual(["journal-2026-09-23.jsonl-0"]);
      expect(embedded).toEqual([]);
    });

    test("an unreadable file keeps its vectors", async () => {
      put(entity("people/alice.md"), "# Alice\n");
      await recall.reconcileCorpus();

      chmodSync(entity("people/alice.md"), 0o000);
      try {
        const r = await recall.reconcileSource(entity("people/alice.md"));
        expect(r).toMatchObject({ complete: false, pruned: 0 });
      } finally {
        chmodSync(entity("people/alice.md"), 0o644);
      }
      expect(ids()).toEqual(["people-alice-preamble"]);
    });

    test("a missing root is not read as a deletion", async () => {
      put(entity("people/alice.md"), "# Alice\n");
      await recall.reconcileCorpus();

      rmSync(ctx.entitiesDir, { recursive: true, force: true });
      const r = await recall.reconcileSource(entity("people/alice.md"));

      expect(r).toMatchObject({ complete: false, pruned: 0 });
      expect(ids()).toEqual(["people-alice-preamble"]);
    });

    test("a deleted directory prunes every source under it", async () => {
      put(entity("people/alice.md"), "# Alice\n");
      put(entity("people/bob.md"), "# Bob\n");
      put(entity("projects/x.md"), "# X\n");
      await recall.reconcileCorpus();

      rmSync(entity("people"), { recursive: true, force: true });
      const r = await recall.reconcileSource(entity("people"));

      expect(r).toMatchObject({ pruned: 2, complete: true });
      expect(ids()).toEqual(["projects-x-preamble"]);
    });

    test("ignores paths the corpus scan would not index", async () => {
      put(entity("people/alice.md"), "# Alice\n");
      put(journal("2026-09-23.jsonl"), line("t", "a") + "\n");
      await recall.reconcileCorpus();
      embedded.length = 0;

      put(join(ctx.root, "outside.jsonl"), line("t", "secret") + "\n");
      symlinkSync(join(ctx.root, "outside.jsonl"), journal("link.jsonl"));
      put(journal(".trash/old.jsonl"), line("t", "trash") + "\n");
      put(journal("2026-09-23.jsonl.tmp"), line("t", "tmp") + "\n");

      for (const p of [
        journal("link.jsonl"),
        journal(".trash/old.jsonl"),
        journal("2026-09-23.jsonl.tmp"),
        entity("people"),
      ]) {
        expect(await recall.reconcileSource(p)).toMatchObject({
          complete: false,
          pruned: 0,
          embedded: 0,
        });
      }
      expect(embedded).toEqual([]);
      expect(ids()).toEqual(["journal-2026-09-23.jsonl-0", "people-alice-preamble"]);
    });

    test("a vanished journal-rooted path never deletes entity vectors", async () => {
      put(entity("people/alice.md"), "# Alice\n");
      await recall.reconcileCorpus();

      // Same relative source string as the entity, but under journal/.
      const r = await recall.reconcileSource(journal("people/alice.md"));
      expect(r.pruned).toBe(0);
      expect(ids()).toEqual(["people-alice-preamble"]);
    });

    test("rejects a path through a symlinked directory", async () => {
      const outside = join(ctx.root, "outside");
      put(join(outside, "secret.md"), "# SECRET\n");
      mkdirSync(entity("people"), { recursive: true });
      symlinkSync(outside, entity("people/linked"));

      const r = await recall.reconcileSource(entity("people/linked/secret.md"));
      expect(r).toMatchObject({ complete: false, embedded: 0 });
      expect(embedded).toEqual([]);
    });

    test("rejects a spelling that differs from the on-disk name", async () => {
      put(entity("people/alice.md"), "# Alice\n");
      await recall.reconcileCorpus();
      embedded.length = 0;

      // On a case-insensitive filesystem (macOS) the spelling resolves to the
      // file and is rejected as incomplete; on a case-sensitive one (Linux CI)
      // it is a different, absent path, a deletion of a source with no vectors.
      for (const p of [entity("People/alice.md"), entity("people/Alice.md")]) {
        expect(await recall.reconcileSource(p)).toMatchObject({
          complete: !existsSync(p),
          embedded: 0,
          pruned: 0,
        });
      }
      expect(ids()).toEqual(["people-alice-preamble"]);
    });

    test("rejects a path outside the corpus", async () => {
      for (const p of [join(ctx.stateDir, "today.md"), journal("../state/today.md")]) {
        const err = await recall.reconcileSource(p).catch((e) => e);
        expect(String(err)).toContain("not a corpus path");
      }
    });
  });
});
