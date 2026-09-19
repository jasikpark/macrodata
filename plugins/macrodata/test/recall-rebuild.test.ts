/**
 * Regression test for rebuild pruning: an INCOMPLETE projection must never be
 * treated as authoritative by rebuildIndex. If the projection's complete flag
 * is dropped before pruning, the items of any unreadable source read as
 * deletions and rebuild prunes live vectors - this test fails on that bug.
 *
 * The real Qwen3 embedder is far too heavy (it loads a multi-GB GGUF), so the
 * embeddings module is mocked: the contract under test is projection
 * authority, not vector quality.
 */

import { mock, describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, type TestContext } from "./helpers";
import { chmodSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

// Every batch of texts handed to embedDocuments is captured here so tests can
// assert on the EXACT embedding inputs the indexer produced.
const capturedEmbedInputs: string[][] = [];

void mock.module("../src/recall/embeddings.ts", () => ({
  EMBEDDING_DIMENSIONS: 4,
  DEFAULT_TASK: "test task",
  embedDocument: async () => [1, 0, 0, 0],
  embedDocuments: async (texts: string[]) => {
    capturedEmbedInputs.push(texts);
    return texts.map(() => [1, 0, 0, 0]);
  },
  embedQuery: async () => [1, 0, 0, 0],
  preloadModel: async () => {},
}));

describe("rebuildIndex does not prune on an incomplete projection", () => {
  let ctx: TestContext;
  let recall: typeof import("../src/recall/indexer.ts");

  beforeEach(async () => {
    ctx = createTestContext("macrodata-recall-rebuild-test-");
    recall = await import("../src/recall/indexer.ts");
    recall.resetIndexCache();
    mkdirSync(ctx.entitiesDir, { recursive: true });
  });

  afterEach(() => {
    recall.resetIndexCache();
    ctx.cleanup();
  });

  function put(rel: string, body: string): void {
    const p = join(ctx.entitiesDir, ...rel.split("/"));
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }

  test("rebuild over an incomplete projection preserves existing vectors", async () => {
    put("people/alice.md", "# Alice\n\nKeep.\n");
    put("people/bob.md", "# Bob\n\nAlso keep.\n");

    // Pass one: complete projection - both files indexed, nothing pruned.
    const first = await recall.rebuildIndex();
    expect(first.pruned).toBe(0);
    expect(first.itemCount).toBe(2);

    // Pass two: alice becomes unreadable, so the scan is incomplete. bob is
    // fully readable and re-indexed alone, so the buggy path (pruning on the
    // re-embedded items with the complete flag dropped) would read alice's
    // stale vectors as orphans and delete them.
    chmodSync(join(ctx.entitiesDir, "people", "alice.md"), 0o000);
    try {
      const second = await recall.rebuildIndex();
      expect(second.itemCount).toBe(1); // only bob embeddings
      expect(second.pruned).toBe(0); // incomplete projection must never delete
    } finally {
      chmodSync(join(ctx.entitiesDir, "people", "alice.md"), 0o644);
    }

    // Once readable again, a rebuild reconciles normally (still nothing lost).
    const third = await recall.rebuildIndex();
    expect(third.pruned).toBe(0);
    expect(third.itemCount).toBe(2);
  });
});

describe("rebuildIndex trusts a complete-and-empty projection (corpus wipe)", () => {
  let ctx: TestContext;
  let recall: typeof import("../src/recall/indexer.ts");

  beforeEach(async () => {
    ctx = createTestContext("macrodata-recall-wipe-test-");
    recall = await import("../src/recall/indexer.ts");
    recall.resetIndexCache();
    mkdirSync(ctx.entitiesDir, { recursive: true });
  });

  afterEach(() => {
    recall.resetIndexCache();
    ctx.cleanup();
  });

  function put(rel: string, body: string): void {
    const p = join(ctx.entitiesDir, ...rel.split("/"));
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }

  test("a wiped corpus (files gone, roots still present) prunes all stale vectors", async () => {
    put("people/alice.md", "# Alice\n\nKeep.\n");
    put("people/bob.md", "# Bob\n\nAlso keep.\n");
    const first = await recall.rebuildIndex();
    expect(first.pruned).toBe(0);
    expect(first.itemCount).toBe(2);

    // Wipe the corpus: every file gone, but journal/ and entities/ remain.
    rmSync(join(ctx.entitiesDir, "people"), { recursive: true, force: true });

    const second = await recall.rebuildIndex();
    expect(second.itemCount).toBe(0); // nothing left to index
    expect(second.pruned).toBe(2); // complete empty projection IS authoritative
  });

  test("both roots ABSENT with a non-empty index does not prune (misconfiguration guard)", async () => {
    put("people/alice.md", "# Alice\n\nKeep.\n");
    const first = await recall.rebuildIndex();
    expect(first.itemCount).toBe(1);

    // Misconfiguration pattern: the whole data root subtree disappears
    // (journal AND entities both missing on disk) while the index dir under
    // .recall/ still holds vectors — far more likely a wrong MACRODATA_ROOT
    // than a deliberate wipe.
    recall.resetIndexCache();
    rmSync(ctx.journalDir, { recursive: true, force: true });
    rmSync(ctx.entitiesDir, { recursive: true, force: true });

    const second = await recall.rebuildIndex();
    expect(second.itemCount).toBe(0);
    expect(second.pruned).toBe(0); // conservative skip: possibly misconfigured root
  });
});

describe("rebuildIndex embedding inputs never end in a lone high surrogate", () => {
  let ctx: TestContext;
  let recall: typeof import("../src/recall/indexer.ts");

  beforeEach(async () => {
    ctx = createTestContext("macrodata-recall-surrogate-test-");
    recall = await import("../src/recall/indexer.ts");
    recall.resetIndexCache();
    capturedEmbedInputs.length = 0;
    mkdirSync(ctx.entitiesDir, { recursive: true });
  });

  afterEach(() => {
    recall.resetIndexCache();
    ctx.cleanup();
  });

  function put(rel: string, body: string): void {
    const p = join(ctx.entitiesDir, ...rel.split("/"));
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }

  test("an astral char exactly at the truncation boundary is not split into U+FFFD", async () => {
    // The emoji starts at code unit 1999 (the "# Alice\n\n" preamble
    // heading before it is 9 code units), so a naive content.slice(0, 2000)
    // keeps only its high surrogate: the embedding input would end in a lone
    // high surrogate, which a UTF-8 encoder serializes to U+FFFD.
    const prefix = "x".repeat(1990);
    const body = `# Alice\n\n${prefix}${String.fromCodePoint(0x1f600)}tail\n`;

    put("people/alice.md", body);
    const { itemCount } = await recall.rebuildIndex();
    expect(itemCount).toBe(1);

    // Assert on the captured embedDocuments INPUTS, not the vectors.
    expect(capturedEmbedInputs.length).toBeGreaterThan(0);
    for (const batch of capturedEmbedInputs) {
      for (const text of batch) {
        expect(text.length).toBeLessThanOrEqual(2000);
        const last = text.charCodeAt(text.length - 1);
        expect(last < 0xd800 || last > 0xdbff).toBe(true);
      }
    }
  });
});
