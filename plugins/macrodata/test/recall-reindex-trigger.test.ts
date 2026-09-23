/**
 * Automatic reindexing: which hook events ask for a reindex, what the hook
 * writes into the mailbox, and how the worker's ReindexQueue coalesces and
 * recovers. The queue runs against fake reconcile ops; nothing here embeds.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { createTestContext, type TestContext } from "./helpers";
import { ConcurrentWriteError, UnparsableIndexError } from "../src/recall/atomic-index.ts";
import type { ReconcileResult } from "../src/recall/indexer.ts";
import { ReindexQueue, type ReindexOps } from "../src/recall/reindex.ts";
import { parseReindexRequest, reindexRequestFor } from "../src/recall/reindex-request.ts";

const HOOK = join(import.meta.dir, "..", "bin", "recall-reindex-hook.ts");

const result = (over: Partial<ReconcileResult> = {}): ReconcileResult => ({
  itemCount: 0,
  embedded: 0,
  relabeled: 0,
  unchanged: 0,
  pruned: 0,
  complete: true,
  ...over,
});

const silent = { info() {}, warn() {}, error() {} };

describe("reindexRequestFor", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => ctx.cleanup());

  test("SessionStart asks for the whole corpus", () => {
    expect(reindexRequestFor({ hook_event_name: "SessionStart" })).toEqual({ corpus: true });
  });

  test("the macrodata journal tools ask for the whole corpus", () => {
    for (const tool of [
      "mcp__plugin_macrodata_macrodata__log_journal",
      "mcp__plugin_macrodata_macrodata__save_conversation_summary",
    ]) {
      expect(reindexRequestFor({ hook_event_name: "PostToolUse", tool_name: tool })).toEqual({
        corpus: true,
      });
    }
    expect(
      reindexRequestFor({
        hook_event_name: "PostToolUse",
        tool_name: "mcp__plugin_macrodata_macrodata__search_memory",
      }),
    ).toBeNull();
  });

  test("a write under either corpus root names that path", () => {
    const entity = join(ctx.root, "entities", "people", "x.md");
    const journal = join(ctx.root, "journal", "2026-01-01.jsonl");
    for (const p of [entity, journal]) {
      expect(
        reindexRequestFor({
          hook_event_name: "PostToolUse",
          tool_name: "Edit",
          tool_input: { file_path: p },
        }),
      ).toEqual({ paths: [p] });
    }
  });

  test("a write through a symlinked alias of the store is respelled under the configured root", () => {
    const alias = join(ctx.root, "alias");
    symlinkSync(ctx.root, alias);
    const file = join(ctx.root, "entities", "people", "x.md");
    writeFileSync(file, "# x\n");
    expect(
      reindexRequestFor({
        tool_name: "Write",
        tool_input: { file_path: join(alias, "entities", "people", "x.md") },
      }),
    ).toEqual({ paths: [file] });
  });

  test("paths outside the corpus, relative paths, and the roots themselves ask for nothing", () => {
    for (const file_path of [
      join(ctx.root, "state", "today.md"),
      join(ctx.root, "entities-other", "x.md"),
      "entities/people/x.md",
      join(ctx.root, "entities"),
      join(ctx.root, "journal", "..", "state", "x.md"),
    ]) {
      expect(reindexRequestFor({ tool_name: "Write", tool_input: { file_path } })).toBeNull();
    }
    expect(reindexRequestFor({ tool_name: "Write", tool_input: { file_path: 42 } })).toBeNull();
  });
});

describe("parseReindexRequest", () => {
  test("accepts corpus or a non-empty list of absolute paths, nothing else", () => {
    expect(parseReindexRequest({ corpus: true })).toEqual({ corpus: true });
    expect(parseReindexRequest({ paths: ["/a/b.md"] })).toEqual({ paths: ["/a/b.md"] });
    for (const bad of [
      null,
      "x",
      {},
      { corpus: 1 },
      { paths: [] },
      { paths: ["rel.md"] },
      { paths: [3] },
    ]) {
      expect(parseReindexRequest(bad)).toBeNull();
    }
  });
});

describe("ReindexQueue", () => {
  function fakeOps(sourceResult: (p: string) => ReconcileResult | Error = () => result()) {
    const calls: string[] = [];
    let corpusError: Error | null = null;
    let stamp = "v0";
    const ops: ReindexOps = {
      async reconcileCorpus() {
        calls.push("corpus");
        const e = corpusError;
        corpusError = null;
        if (e) throw e;
        return result();
      },
      async reconcileSource(p) {
        calls.push(p);
        const r = sourceResult(p);
        if (r instanceof Error) throw r;
        return r;
      },
      indexStamp: () => stamp,
    };
    return {
      ops,
      calls,
      failCorpusOnce: (e: Error) => (corpusError = e),
      replaceIndex: () => (stamp = `v${Number(stamp.slice(1)) + 1}`),
    };
  }

  test("a pending corpus reconcile subsumes pending paths", async () => {
    const { ops, calls } = fakeOps();
    const q = new ReindexQueue(ops, silent);
    q.add({ paths: ["/a"] });
    q.add({ corpus: true });
    q.add({ paths: ["/b"] });
    await q.idle();
    // "/a" started before the corpus request arrived; "/b" was still pending.
    expect(calls).toEqual(["/a", "corpus"]);
  });

  test("duplicate paths coalesce, and work added mid-drain still runs", async () => {
    let q!: ReindexQueue;
    const { ops, calls } = fakeOps((p) => {
      if (p === "/a") q.add({ paths: ["/late"] });
      return result();
    });
    q = new ReindexQueue(ops, silent);
    // "/first" is taken as soon as the drain starts; both "/a" requests are
    // still pending behind it.
    q.add({ paths: ["/first"] });
    q.add({ paths: ["/a", "/a"] });
    q.add({ paths: ["/a"] });
    await q.idle();
    expect(calls).toEqual(["/first", "/a", "/late"]);
  });

  test("a path reconcileSource declines falls back to the corpus, skipping the rest of its batch", async () => {
    const { ops, calls } = fakeOps((p) => result({ complete: p !== "/symlinked" }));
    const q = new ReindexQueue(ops, silent);
    q.add({ paths: ["/symlinked", "/b"] });
    await q.idle();
    expect(calls).toEqual(["/symlinked", "corpus"]);
  });

  test("an unparsable index halts the queue until the index file is replaced", async () => {
    const errors: string[] = [];
    const { ops, calls, failCorpusOnce, replaceIndex } = fakeOps();
    failCorpusOnce(new UnparsableIndexError("bad"));
    const q = new ReindexQueue(ops, { ...silent, error: (m) => errors.push(m) });
    q.add({ corpus: true });
    await q.idle();
    q.add({ paths: ["/a"] });
    await q.idle();
    expect(calls).toEqual(["corpus"]);
    expect(errors).toEqual(["reindex halted: index is unparsable"]);

    replaceIndex();
    q.add({ paths: ["/b"] });
    await q.idle();
    expect(calls).toEqual(["corpus", "/b"]);
  });

  test("a lost write race retries the corpus", async () => {
    const { ops, calls, failCorpusOnce } = fakeOps();
    failCorpusOnce(new ConcurrentWriteError("raced"));
    const q = new ReindexQueue(ops, silent, 10);
    q.add({ corpus: true });
    await q.idle();
    await Bun.sleep(50);
    await q.idle();
    expect(calls).toEqual(["corpus", "corpus"]);
  });

  test("any other failure is reported, the queue keeps serving, and the corpus is retried", async () => {
    const errors: string[] = [];
    const { ops, calls } = fakeOps((p) => (p === "/boom" ? new Error("disk") : result()));
    const q = new ReindexQueue(ops, { ...silent, error: (m) => errors.push(m) }, 10);
    q.add({ paths: ["/boom", "/ok"] });
    await q.idle();
    expect(calls).toEqual(["/boom", "/ok"]);
    expect(errors).toEqual(["reindex failed"]);
    await Bun.sleep(50);
    await q.idle();
    expect(calls).toEqual(["/boom", "/ok", "corpus"]);
  });

  test("repeated failures back off", async () => {
    const delays: unknown[] = [];
    const { ops } = fakeOps();
    ops.reconcileCorpus = async () => {
      throw new Error("model offline");
    };
    const q = new ReindexQueue(
      ops,
      { ...silent, error: (_m, props) => delays.push(props?.retryMs) },
      10,
    );
    q.add({ corpus: true });
    const deadline = Date.now() + 2000;
    while (delays.length < 3 && Date.now() < deadline) await Bun.sleep(5);
    expect(delays.slice(0, 3)).toEqual([10, 20, 40]);
  });
});

describe("recall-reindex-hook.ts", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => ctx.cleanup());

  const mailbox = () => join(ctx.root, ".recall", "mailbox");
  const run = (envelope: object) =>
    spawnSync("bun", ["run", HOOK], {
      input: JSON.stringify(envelope),
      env: { ...process.env, MACRODATA_ROOT: ctx.root },
      encoding: "utf-8",
    });
  const requests = () =>
    existsSync(mailbox())
      ? readdirSync(mailbox())
          .filter((f) => /^reindex-.+\.json$/.test(f))
          .map((f) => JSON.parse(readFileSync(join(mailbox(), f), "utf-8")))
      : [];

  test("queues a corpus reindex at SessionStart and says so when no index exists", () => {
    const r = run({ hook_event_name: "SessionStart" });
    expect(r.status).toBe(0);
    expect(requests()).toEqual([{ corpus: true }]);
    expect(r.stdout).toContain("no recall index yet");
  });

  test("is silent at SessionStart once an index exists", () => {
    const vectors = join(ctx.root, ".recall", "index", "vectors");
    mkdirSync(vectors, { recursive: true });
    writeFileSync(join(vectors, "index.json"), "{}");
    const r = run({ hook_event_name: "SessionStart" });
    expect(r.stdout).toBe("");
    expect(requests()).toEqual([{ corpus: true }]);
  });

  test("queues the edited path, and nothing for a path outside the corpus", () => {
    const p = join(ctx.root, "entities", "people", "x.md");
    run({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: p } });
    run({
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: join(ctx.root, "state", "today.md") },
    });
    expect(requests()).toEqual([{ paths: [p] }]);
  });

  test("a burst of corpus requests leaves one file; a burst of edits leaves one each", () => {
    for (let i = 0; i < 3; i++) run({ hook_event_name: "SessionStart" });
    expect(requests()).toEqual([{ corpus: true }]);
    const p = join(ctx.root, "entities", "people", "x.md");
    for (let i = 0; i < 3; i++)
      run({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: p } });
    expect(requests()).toHaveLength(4);
  });

  test("a non-object envelope asks for nothing and exits clean", () => {
    for (const input of ["null", "42", '"x"', "not json"]) {
      const r = spawnSync("bun", ["run", HOOK], {
        input,
        env: { ...process.env, MACRODATA_ROOT: ctx.root },
        encoding: "utf-8",
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
    }
    expect(requests()).toEqual([]);
  });
});

describe("worker reindexing", () => {
  let ctx: TestContext;
  let worker: ReturnType<typeof Bun.spawn> | null = null;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(async () => {
    worker?.kill();
    await worker?.exited;
    worker = null;
    ctx.cleanup();
  });

  async function waitFor(pred: () => boolean, ms = 15000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await Bun.sleep(50);
    }
    return pred();
  }

  // The corpus holds only a symlink, which the scan skips, so no reconcile has
  // anything to embed and no model loads. reconcileSource declines the symlink
  // and reports it incomplete, which is what makes its "reindexed" record
  // observable: a request that was consumed but never queued writes none.
  test("builds the index at startup and applies reindex requests", async () => {
    const mailbox = join(ctx.root, ".recall", "mailbox");
    mkdirSync(mailbox, { recursive: true });
    const target = join(ctx.root, "outside.md");
    writeFileSync(target, "# outside\n");
    const link = join(ctx.root, "entities", "people", "link.md");
    symlinkSync(target, link);
    writeFileSync(join(mailbox, "reindex-1.json"), JSON.stringify({ paths: [link] }));
    writeFileSync(join(mailbox, "reindex-2.json"), "not json");
    let log = "";
    worker = Bun.spawn(
      [
        "bun",
        "run",
        join(import.meta.dir, "..", "src", "recall", "worker.ts"),
        "--macrodata-recall-worker",
        ctx.root,
      ],
      { env: { ...process.env, MACRODATA_ROOT: ctx.root }, stdout: "pipe", stderr: "pipe" },
    );
    // logtape's console sink sends warnings and errors to stderr.
    for (const stream of [worker.stdout, worker.stderr]) {
      void (async () => {
        for await (const chunk of stream as ReadableStream<Uint8Array>)
          log += new TextDecoder().decode(chunk);
      })();
    }
    const indexJson = join(ctx.root, ".recall", "index", "vectors", "index.json");
    expect(await waitFor(() => existsSync(indexJson))).toBe(true);
    expect(await waitFor(() => readdirSync(mailbox).every((f) => !f.startsWith("reindex-")))).toBe(
      true,
    );
    const records = () =>
      log
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as { message?: string; properties?: Record<string, unknown> });
    expect(
      await waitFor(() =>
        records().some((r) => r.message === "reindexed" && r.properties?.scope === link),
      ),
    ).toBe(true);
    expect(
      await waitFor(() =>
        records().some((r) => r.message === "reindex request dropped: malformed"),
      ),
    ).toBe(true);
  });
});
