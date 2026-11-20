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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { LocalIndex } from "vectra";
import { AtomicLocalIndex } from "../src/recall/atomic-index.ts";
import { getIndexDir } from "../src/config.ts";

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

const userLine = (sessionId: string, n: number) =>
  JSON.stringify({
    type: "user",
    sessionId,
    uuid: `${sessionId}-u${n}`,
    timestamp: "2026-09-24T00:00:00.000Z",
    message: { content: `${sessionId} #${n}` },
  }) + "\n";

const replyLine = (n: number) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: `reply ${n} — ünïcødé` }] },
  }) + "\n";

// One user prompt + assistant reply per exchange; prompts are "<session> #<n>".
function sessionText(sessionId: string, from: number, to: number): string {
  let text = "";
  for (let n = from; n < to; n++) text += userLine(sessionId, n) + replyLine(n);
  return text;
}

function writeSession(projectDir: string, sessionId: string, exchanges: number): void {
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), sessionText(sessionId, 0, exchanges));
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

  test("a search sees exchanges another process committed after this one loaded", async () => {
    writeSession(projectDir, "a", 2);
    await conversations.updateConversationIndex();
    expect(await conversations.getConversationIndexStats()).toEqual({ exchangeCount: 2 });

    // Stands in for the daemon's checkpoint pass: a separate instance, as in another process.
    const other = new AtomicLocalIndex(join(getIndexDir(), "conversations"));
    await other.beginUpdate();
    await other.upsertItem({ id: "other-1", vector: [1, 0, 0, 0], metadata: {} });
    await other.endUpdate();

    expect(await conversations.getConversationIndexStats()).toEqual({ exchangeCount: 3 });
  });

  test("a background-task notification is not indexed as a prompt", async () => {
    const notification =
      JSON.stringify({
        type: "user",
        sessionId: "n",
        uuid: "n-task",
        message: { content: "<task-notification>\n<task-id>b1</task-id>\n</task-notification>" },
      }) + "\n";
    writeFileSync(
      join(projectDir, "n.jsonl"),
      userLine("n", 0) + replyLine(0) + notification + replyLine(1),
    );
    await conversations.updateConversationIndex();
    expect(embedded).toEqual(["proj: n #0"]);
  });

  describe("an appended transcript", () => {
    const file = () => join(projectDir, "s.jsonl");
    const prompts = () => embedded.map((t) => t.split(": ")[1]);

    beforeEach(async () => {
      await conversations.updateConversationIndex();
      writeFileSync(file(), sessionText("s", 0, 3));
      await conversations.updateConversationIndex();
      embedded.length = 0;
    });

    test("embeds only the exchanges added since the last pass", async () => {
      appendFileSync(file(), sessionText("s", 3, 5));
      const result = await conversations.updateConversationIndex();
      expect(prompts()).toEqual(["s #3", "s #4"]);
      expect(result).toEqual({ exchangeCount: 5, filesUpdated: 1, skipped: 0 });
      expect(await conversations.getConversationIndexStats()).toEqual({ exchangeCount: 5 });
    });

    test("a prompt whose reply is not written yet is indexed once the reply lands", async () => {
      appendFileSync(file(), userLine("s", 3));
      await conversations.updateConversationIndex();
      expect(embedded).toEqual([]);

      appendFileSync(file(), replyLine(3));
      await conversations.updateConversationIndex();
      expect(prompts()).toEqual(["s #3"]);
    });

    test("a line still being written is read once it is complete", async () => {
      const exchange = sessionText("s", 3, 4);
      // Cut inside the reply line, mid-way through a multi-byte character.
      const cut = Buffer.from(exchange).indexOf(Buffer.from("ü")) + 1;
      appendFileSync(file(), Buffer.from(exchange).subarray(0, cut));
      await conversations.updateConversationIndex();
      expect(embedded).toEqual([]);

      appendFileSync(file(), Buffer.from(exchange).subarray(cut));
      await conversations.updateConversationIndex();
      expect(prompts()).toEqual(["s #3"]);
    });

    test("a file rewritten shorter than its offset is read from the start", async () => {
      writeFileSync(file(), sessionText("s", 0, 1));
      const result = await conversations.updateConversationIndex();
      expect(prompts()).toEqual(["s #0"]);
      expect(result.exchangeCount).toBe(1);
    });

    test("a file rewritten with different content past its offset is read from the start", async () => {
      // Longer than the three exchanges already read, but none of their bytes.
      writeFileSync(file(), sessionText("t", 0, 4));
      await conversations.updateConversationIndex();
      expect(prompts()).toEqual(["t #0", "t #1", "t #2", "t #3"]);
    });

    test("state written before offsets existed reads the changed file whole, once", async () => {
      const statePath = join(getIndexDir(), "conversations-state.json");
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      for (const entry of Object.values(state.files) as Record<string, unknown>[]) {
        delete entry.size;
        delete entry.offset;
      }
      writeFileSync(statePath, JSON.stringify(state));

      appendFileSync(file(), sessionText("s", 3, 4));
      await conversations.updateConversationIndex();
      expect(prompts()).toEqual(["s #0", "s #1", "s #2", "s #3"]);

      embedded.length = 0;
      appendFileSync(file(), sessionText("s", 4, 5));
      await conversations.updateConversationIndex();
      expect(prompts()).toEqual(["s #4"]);
    });

    test("the state file is replaced whole, leaving no temp files", () => {
      const dir = getIndexDir();
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      expect(() =>
        JSON.parse(readFileSync(join(dir, "conversations-state.json"), "utf-8")),
      ).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Stateful property test of offset-based incremental indexing.
//
// Each case replays a history of byte-level appends (cut anywhere, including
// mid-line and mid-character), index passes (some with the embedder failing),
// rebuilds, rewrites, touches and legacy-state downgrades against two
// transcripts. After every successful pass the index must hold exactly the
// exchanges an independent pairing model finds in each file's complete lines,
// and an exchange already committed must not be embedded again.
//
// Knobs: PROP_RUNS=<n> for a longer search, PROP_SEED=<seed> PROP_PATH=<path> to
// replay a reported failure, PROP_STATS=1 to print how often each interesting
// situation (a commit-crossing pass, a failure after a partial commit) was reached.
// ---------------------------------------------------------------------------

type LineKind = "user" | "tool" | "noise" | "assistant" | "malformed" | "blank";
type Op =
  | { kind: "grow"; file: 0 | 1; bytes: number; keepMtime: boolean }
  | { kind: "pass"; failAfter: number | null }
  | { kind: "rebuild" }
  | { kind: "rewrite"; file: 0 | 1; lines: LineKind[]; keep: number; rename: boolean }
  | { kind: "touch"; file: 0 | 1; seconds: number }
  | { kind: "legacy" }
  | { kind: "flush" };

const SESSIONS = ["s0", "s1"] as const;

// Lines carry a unique tag so the oracle can name the exchange each one forms.
function renderLine(kind: LineKind, session: string, tag: string): string {
  switch (kind) {
    case "user":
      return JSON.stringify({
        type: "user",
        sessionId: session,
        uuid: tag,
        timestamp: "2026-09-24T00:00:00.000Z",
        message: { content: `prompt ${tag} — ünï` },
      });
    case "tool":
      return JSON.stringify({
        type: "user",
        sessionId: session,
        uuid: `${tag}-tool`,
        message: { content: [{ type: "tool_result", tool_use_id: "t" }] },
      });
    case "noise":
      return JSON.stringify({
        type: "user",
        sessionId: session,
        uuid: `${tag}-noise`,
        message: { content: "<system-reminder>ignored" },
      });
    case "assistant":
      return JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: `reply ${tag} ✓🙂` }] },
      });
    case "malformed":
      return `{"type":"user","message":`;
    case "blank":
      return "";
  }
}

interface Transcript {
  version: number;
  kinds: LineKind[];
  bytes: Buffer; // the whole stream this version will eventually hold
  written: number; // how many of its bytes are on disk
}

function streamFor(session: string, version: number, kinds: LineKind[]): Buffer {
  return Buffer.from(
    kinds.map((k, i) => renderLine(k, session, `${session}-v${version}-l${i}`) + "\n").join(""),
  );
}

/** Independent oracle: the exchanges the complete lines on disk pair into. */
function expectedExchanges(
  session: string,
  t: Transcript,
): Map<string, { prompt: string; reply: string }> {
  const complete = t.bytes.subarray(0, t.written);
  const lineCount = complete.toString("latin1").split("\n").length - 1;
  const out = new Map<string, { prompt: string; reply: string }>();
  let pending: string | null = null;
  for (let i = 0; i < lineCount; i++) {
    const tag = `${session}-v${t.version}-l${i}`;
    const kind = t.kinds[i];
    if (kind === "user") pending = tag;
    else if (kind === "assistant" && pending !== null) {
      out.set(`conv-${session}-${pending}`, {
        prompt: `prompt ${pending} — ünï`,
        reply: `reply ${tag} ✓🙂`,
      });
      pending = null;
    }
  }
  return out;
}

const lineKind = fc.constantFrom<LineKind>(
  "user",
  "user",
  "assistant",
  "assistant",
  "tool",
  "noise",
  "malformed",
  "blank",
);
const fileIx = fc.constantFrom<0 | 1>(0, 1);
const transcriptKinds = fc.oneof(
  { weight: 3, arbitrary: fc.array(lineKind, { maxLength: 24 }) },
  {
    weight: 1,
    arbitrary: fc
      .array(fc.constantFrom<LineKind[]>(["user", "assistant"], ["user", "tool", "assistant"]), {
        minLength: 130,
        maxLength: 220,
      })
      .map((pairs) => pairs.flat()),
  },
);
const op: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("grow" as const),
      file: fileIx,
      bytes: fc.oneof(fc.integer({ min: 1, max: 400 }), fc.integer({ min: 20_000, max: 60_000 })),
      // As cp -p or rsync -t leave it: new bytes, the old mtime.
      keepMtime: fc.integer({ min: 0, max: 5 }).map((n) => n === 0),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("pass" as const),
      failAfter: fc.option(
        fc.oneof(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 129, max: 400 })),
        { freq: 3 },
      ),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "rebuild" as const }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("rewrite" as const),
      file: fileIx,
      lines: fc.array(lineKind, { maxLength: 12 }),
      keep: fc.oneof(fc.constant(1), fc.double({ min: 0, max: 1, noNaN: true })),
      rename: fc.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("touch" as const),
      file: fileIx,
      seconds: fc.integer({ min: 1, max: 10 }),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "legacy" as const }) },
  // Write out both whole streams, so the next pass sees two large files at once.
  { weight: 1, arbitrary: fc.constant({ kind: "flush" as const }) },
);

describe("conversation index (property)", () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    failAfter = null;
  });

  test("incremental passes index exactly the paired exchanges, embedding each once", async () => {
    const conversations = await import("../src/conversations.ts");
    // PROP_STATS=1 prints how often each interesting situation was reached.
    const stats: Record<string, number> = {};
    const hit = (k: string, n = 1) => (stats[k] = (stats[k] ?? 0) + n);
    await fc.assert(
      fc.asyncProperty(
        // Mostly short streams; some long enough to cross COMMIT_ITEMS (128) in one pass.
        fc.tuple(transcriptKinds, transcriptKinds),
        fc.array(op, { minLength: 1, maxLength: 30 }),
        async (initial, ops) => {
          const run = createTestContext("macrodata-conv-prop-");
          const dir = join(run.root, "claude", "projects", "-tmp-proj");
          mkdirSync(dir, { recursive: true });
          process.env.CLAUDE_CONFIG_DIR = join(run.root, "claude");
          const pathOf = (f: 0 | 1) => join(dir, `${SESSIONS[f]}.jsonl`);
          // Relative to the file's own mtime, so a case replays the same way at any wall-clock time.
          const bumpMtime = (f: 0 | 1, seconds: number) => {
            const t = statSync(pathOf(f)).mtimeMs / 1000 + seconds;
            utimesSync(pathOf(f), t, t);
          };
          const files: Transcript[] = initial.map((kinds, f) => ({
            version: 0,
            kinds,
            bytes: streamFor(SESSIONS[f], 0, kinds),
            written: 0,
          }));
          for (const f of [0, 1] as const) writeFileSync(pathOf(f), "");
          // Exchanges known committed by the last successful pass, per file.
          let committed = new Set<string>();
          // A file whose state entry predates offsets (no size, no offset) is read
          // whole when it next changes, and like the code before offsets detects
          // change by mtime alone, so an mtime-preserving append to it is out of
          // contract. Entries stay legacy until their file next changes, so this is
          // read back from the state file after each pass. That leans on production
          // state, but only to excuse behaviour, never to expect it.
          const legacyFiles = new Set<0 | 1>();
          const readLegacyFiles = () => {
            legacyFiles.clear();
            const statePath = join(getIndexDir(), "conversations-state.json");
            if (!existsSync(statePath)) return;
            const state = JSON.parse(readFileSync(statePath, "utf-8"));
            for (const f of [0, 1] as const) {
              const entry = state.files[pathOf(f)];
              if (entry && entry.offset === undefined) legacyFiles.add(f);
            }
          };
          let mtimeKept = false; // an mtime-preserving append since the last good pass
          try {
            for (const o of ops) {
              switch (o.kind) {
                case "grow": {
                  const t = files[o.file];
                  const next = Math.min(t.bytes.length, t.written + o.bytes);
                  const before = statSync(pathOf(o.file));
                  appendFileSync(pathOf(o.file), t.bytes.subarray(t.written, next));
                  if (o.keepMtime && !legacyFiles.has(o.file)) {
                    utimesSync(pathOf(o.file), before.atimeMs / 1000, before.mtimeMs / 1000);
                    mtimeKept = true;
                  }
                  t.written = next;
                  break;
                }
                case "flush": {
                  for (const f of [0, 1] as const) {
                    const t = files[f];
                    appendFileSync(pathOf(f), t.bytes.subarray(t.written));
                    t.written = t.bytes.length;
                  }
                  break;
                }
                case "rewrite": {
                  const t = files[o.file];
                  t.version++;
                  t.kinds = o.lines;
                  t.bytes = streamFor(SESSIONS[o.file], t.version, o.lines);
                  t.written = Math.floor(o.keep * t.bytes.length);
                  const content = t.bytes.subarray(0, t.written);
                  if (o.rename) {
                    writeFileSync(`${pathOf(o.file)}.new`, content);
                    renameSync(`${pathOf(o.file)}.new`, pathOf(o.file));
                  } else writeFileSync(pathOf(o.file), content);
                  break;
                }
                case "touch": {
                  bumpMtime(o.file, o.seconds);
                  break;
                }
                case "legacy": {
                  const statePath = join(getIndexDir(), "conversations-state.json");
                  if (!existsSync(statePath)) break;
                  const state = JSON.parse(readFileSync(statePath, "utf-8"));
                  for (const e of Object.values(state.files) as Record<string, unknown>[]) {
                    delete e.size;
                    delete e.offset;
                    delete e.anchor;
                  }
                  writeFileSync(statePath, JSON.stringify(state));
                  readLegacyFiles();
                  if (mtimeKept) for (const f of [0, 1] as const) bumpMtime(f, 5);
                  break;
                }
                case "rebuild":
                case "pass": {
                  embedded.length = 0;
                  failAfter = o.kind === "pass" ? o.failAfter : null;
                  let count = -1;
                  const ok = await (
                    o.kind === "rebuild"
                      ? conversations.rebuildConversationIndex()
                      : conversations.updateConversationIndex()
                  ).then(
                    (r) => ((count = r.exchangeCount), true),
                    (e) => {
                      if (!String(e).includes("embedder died")) throw e;
                      return false;
                    },
                  );
                  failAfter = null;
                  hit(ok ? `${o.kind} ok` : `${o.kind} failed`);
                  if (embedded.length > 128) hit("pass embedding > COMMIT_ITEMS");
                  if (!ok && embedded.length > 128) hit("failure after a partial commit");
                  if (!ok) break;

                  const expected = new Map<string, { prompt: string; reply: string }>();
                  for (const f of [0, 1] as const) {
                    for (const [id, v] of expectedExchanges(SESSIONS[f], files[f]))
                      expected.set(id, v);
                  }
                  const reader = new LocalIndex(join(getIndexDir(), "conversations"));
                  const items = (await reader.isIndexCreated()) ? await reader.listItems() : [];
                  const byId = new Map(
                    items.map((i) => [i.id, i.metadata as Record<string, string>]),
                  );
                  expect(count).toBe(expected.size);
                  for (const [id, v] of expected) {
                    const meta = byId.get(id);
                    expect(meta, `missing ${id}`).toBeDefined();
                    expect(meta!.userPrompt).toBe(v.prompt);
                    expect(meta!.assistantSummary).toBe(v.reply);
                  }
                  if (o.kind === "pass") {
                    for (const text of embedded) {
                      const prompt = text.slice("proj: ".length);
                      const id = [...expected].find(([, v]) => v.prompt === prompt)?.[0];
                      const legacyId = [...legacyFiles].some((f) =>
                        id?.startsWith(`conv-${SESSIONS[f]}-`),
                      );
                      if (id && committed.has(id) && !legacyId) {
                        throw new Error(`re-embedded committed exchange ${id}`);
                      }
                    }
                    expect(new Set(embedded).size).toBe(embedded.length);
                  }
                  committed = new Set(expected.keys());
                  readLegacyFiles();
                  mtimeKept = false;
                  break;
                }
              }
            }
          } finally {
            failAfter = null;
            run.cleanup();
          }
        },
      ),
      {
        numRuns: Number(process.env.PROP_RUNS ?? 200),
        // Replay a reported failure: PROP_SEED=<seed> PROP_PATH=<path>.
        ...(process.env.PROP_SEED
          ? { seed: Number(process.env.PROP_SEED), path: process.env.PROP_PATH }
          : {}),
      },
    );
    if (process.env.PROP_STATS) console.log(stats);
  }, 600_000);
});
