/**
 * Incremental conversation indexing: exchanges are committed in batches rather
 * than one index.json rewrite per exchange, and a pass that dies midway keeps
 * the files it already committed.
 *
 * The embedder is mocked (the real one downloads a model); every text it
 * receives is captured so tests can assert exactly what was re-embedded.
 * Transcripts are read from CLAUDE_CONFIG_DIR, pointed at the test root.
 */

import fc from "fast-check";
import { mock, describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createTestContext, type TestContext } from "./helpers";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { LocalIndex } from "vectra";
import { AtomicLocalIndex } from "../src/recall/atomic-index.ts";

const embedded: string[] = [];
// Set to N to make the embedder throw once N texts have been embedded.
let failAfter: number | null = null;
// When set, every embed call is a point where fast-check picks which pass runs next.
let scheduler: fc.Scheduler | null = null;

void mock.module("../src/embeddings.ts", () => ({
  EMBEDDING_DIMENSIONS: 4,
  embed: async () => [1, 0, 0, 0],
  embedBatch: async (texts: string[]) => {
    if (scheduler) await scheduler.schedule(Promise.resolve(), "embed");
    if (failAfter !== null && embedded.length + texts.length > failAfter) {
      throw new Error("embedder died");
    }
    embedded.push(...texts);
    return texts.map(() => [1, 0, 0, 0]);
  },
  preloadModel: async () => {},
}));

// One user prompt + assistant reply per exchange; prompts are "<session> #<n>".
function writeSession(projectDir: string, sessionId: string, exchanges: number): void {
  const lines: string[] = [];
  for (let n = 0; n < exchanges; n++) {
    lines.push(
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: `${sessionId}-u${n}`,
        timestamp: "2026-09-24T00:00:00.000Z",
        message: { content: `${sessionId} #${n}` },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: `reply ${n}` }] },
      }),
    );
  }
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

describe("conversation index", () => {
  let ctx: TestContext;
  let conversations: typeof import("../src/conversations.ts");
  let projectDir: string;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(async () => {
    ctx = createTestContext("macrodata-conversations-test-");
    const configDir = join(ctx.root, "claude");
    projectDir = join(configDir, "projects", "-tmp-proj");
    mkdirSync(projectDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = configDir;
    conversations = await import("../src/conversations.ts");
    embedded.length = 0;
    failAfter = null;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    ctx.cleanup();
  });

  test("an update commits in batches, not once per exchange", async () => {
    // The first call builds the index; later ones are incremental.
    await conversations.updateConversationIndex();
    for (const id of ["a", "b", "c"]) writeSession(projectDir, id, 100);

    // Every commit rewrites index.json. AtomicLocalIndex.endUpdate replaces
    // Vectra's rather than calling it, so the two spies never double-count.
    const spies = [
      spyOn(LocalIndex.prototype, "endUpdate"),
      spyOn(AtomicLocalIndex.prototype, "endUpdate"),
    ];
    try {
      const result = await conversations.updateConversationIndex();
      expect(result).toEqual({ exchangeCount: 300, filesUpdated: 3, skipped: 0 });
      const commits = spies.reduce((n, s) => n + s.mock.calls.length, 0);
      expect(commits).toBeGreaterThan(0);
      expect(commits).toBeLessThan(5);
    } finally {
      for (const s of spies) s.mockRestore();
    }

    embedded.length = 0;
    const again = await conversations.updateConversationIndex();
    expect(again).toEqual({ exchangeCount: 300, filesUpdated: 0, skipped: 3 });
    expect(embedded).toEqual([]);
  });

  test("a pass that dies midway keeps the files it already committed", async () => {
    await conversations.updateConversationIndex();
    for (const id of ["a", "b", "c"]) writeSession(projectDir, id, 100);

    // Two 100-exchange files cross the commit threshold; the third one fails.
    failAfter = 200;
    const err = await conversations.updateConversationIndex().catch((e) => e);
    expect(String(err)).toContain("embedder died");

    failAfter = null;
    embedded.length = 0;
    const result = await conversations.updateConversationIndex();
    expect(result).toEqual({ exchangeCount: 300, filesUpdated: 1, skipped: 2 });
    expect(embedded).toHaveLength(100);
    expect(new Set(embedded.map((t) => t.split(" #")[0])).size).toBe(1);
  });

  test("overlapping passes in one process both complete", async () => {
    // manage_index starts updates and rebuilds without awaiting them.
    await fc.assert(
      fc.asyncProperty(
        // Each release waits out real fs I/O first, so every pass has reached its
        // next embed before fast-check picks which one resumes.
        fc.scheduler({ act: async (f) => (await new Promise((r) => setTimeout(r, 5)), f()) }),
        fc.constantFrom("update", "rebuild"),
        async (s, second) => {
          const run = createTestContext("macrodata-conversations-race-");
          const dir = join(run.root, "claude", "projects", "-tmp-proj");
          mkdirSync(dir, { recursive: true });
          process.env.CLAUDE_CONFIG_DIR = join(run.root, "claude");
          try {
            await conversations.updateConversationIndex();
            for (const id of ["a", "b", "c"]) writeSession(dir, id, 3);

            scheduler = s;
            const passes = Promise.all([
              conversations.updateConversationIndex(),
              second === "update"
                ? conversations.updateConversationIndex()
                : conversations.rebuildConversationIndex(),
            ]);
            await s.waitFor(passes);
            expect(await conversations.getConversationIndexStats()).toEqual({ exchangeCount: 9 });
          } finally {
            scheduler = null;
            run.cleanup();
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
