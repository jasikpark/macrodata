/**
 * AtomicLocalIndex commits by temp-file rename and refuses to overwrite an
 * index.json that another process committed after this one loaded it.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  AtomicLocalIndex,
  ConcurrentWriteError,
  UnparsableIndexError,
  stampOf,
} from "../src/recall/atomic-index.ts";

describe("AtomicLocalIndex", () => {
  let dir: string;
  const file = () => join(dir, "index.json");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "macrodata-atomic-index-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function seeded(): Promise<AtomicLocalIndex> {
    const idx = new AtomicLocalIndex(dir);
    await idx.createIndex();
    await idx.upsertItem({ id: "a", vector: [1, 0], metadata: { content: "a" } });
    return idx;
  }

  test("a commit leaves no temp file behind", async () => {
    await seeded();
    expect(readdirSync(dir)).toEqual(["index.json"]);
    expect(JSON.parse(readFileSync(file(), "utf-8")).items).toHaveLength(1);
  });

  test("a commit over another process's write throws and keeps that write", async () => {
    const idx = await seeded();
    await idx.beginUpdate();
    await idx.upsertItem({ id: "b", vector: [0, 1], metadata: { content: "b" } });

    // A second process commits in between; bump size so the stamp moves even
    // within one mtime tick.
    const other = JSON.parse(readFileSync(file(), "utf-8"));
    other.items.push({ id: "c", vector: [1, 1], norm: 1.41, metadata: { content: "c" } });
    writeFileSync(file(), JSON.stringify(other));

    const err = await idx.endUpdate().catch((e) => e);
    expect(err).toBeInstanceOf(ConcurrentWriteError);
    const ids = JSON.parse(readFileSync(file(), "utf-8")).items.map((it: { id: string }) => it.id);
    expect(ids).toEqual(["a", "c"]);
  });

  test("a fresh instance loads the other process's commit and can write again", async () => {
    await seeded();
    const next = new AtomicLocalIndex(dir);
    await next.upsertItem({ id: "b", vector: [0, 1], metadata: { content: "b" } });
    expect((await next.listItems()).map((it) => it.id)).toEqual(["a", "b"]);
  });

  test("an update is invisible to reads until it commits, and cancel discards it", async () => {
    const idx = await seeded();
    await idx.beginUpdate();
    await idx.deleteItem("a");
    await idx.upsertItem({ id: "b", vector: [0, 1], metadata: { content: "b" } });
    expect((await idx.listItems()).map((it) => it.id)).toEqual(["a"]);
    idx.cancelUpdate();
    expect((await idx.listItems()).map((it) => it.id)).toEqual(["a"]);
  });

  test("replacing an item's vector recomputes its norm", async () => {
    const idx = await seeded();
    await idx.upsertItem({ id: "a", vector: [3, 4], metadata: { content: "a" } });
    const stored = JSON.parse(readFileSync(file(), "utf-8")).items[0];
    expect(stored.norm).toBe(5);
  });

  test("loading sweeps temp files of dead processes, not live ones", async () => {
    await seeded();
    // Far above any real pid, so kill(pid, 0) reports ESRCH.
    writeFileSync(join(dir, "index.json.999999999.tmp"), "{");
    writeFileSync(join(dir, `index.json.${process.ppid}.tmp`), "{");
    await new AtomicLocalIndex(dir).listItems();
    expect(readdirSync(dir).sort()).toEqual(["index.json", `index.json.${process.ppid}.tmp`]);
  });

  test("an unparsable index.json fails with a typed error that names the fix", async () => {
    await seeded();
    writeFileSync(file(), '{"items": [');
    const err = await new AtomicLocalIndex(dir).listItems().catch((e) => e);
    expect(err).toBeInstanceOf(UnparsableIndexError);
    expect(String(err)).toContain("--full");
    // The stamp is of the file that failed, so a replacement is distinguishable.
    expect(err.stamp).toBe(stampOf(file()));
  });

  test("records its embedding model on commit and reports it after a reload", async () => {
    const idx = new AtomicLocalIndex(dir, "model-a");
    await idx.createIndex();
    expect(await idx.storedEmbedModel()).toBeUndefined();
    await idx.upsertItem({ id: "a", vector: [1, 0], metadata: { content: "a" } });
    expect(await new AtomicLocalIndex(dir).storedEmbedModel()).toBe("model-a");
  });

  test("isCurrent tracks whether the disk still holds what this instance loaded", async () => {
    const idx = await seeded();
    expect(idx.isCurrent()).toBe(true);
    expect(idx.stamp).toBe(stampOf(file()));
    const other = new AtomicLocalIndex(dir);
    await other.upsertItem({ id: "b", vector: [0, 1], metadata: { content: "b" } });
    expect(idx.isCurrent()).toBe(false);
    expect(new AtomicLocalIndex(dir).isCurrent()).toBe(false);
  });
});
