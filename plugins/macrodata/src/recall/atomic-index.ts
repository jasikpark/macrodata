/**
 * A Vectra LocalIndex whose commits are atomic and refuse to overwrite a
 * concurrent writer's commit.
 *
 * Vectra 0.9.0's endUpdate calls fs.writeFile straight onto index.json, so an
 * interrupt mid-commit (Ctrl-C, crash, ENOSPC) leaves a truncated file that
 * every later load fails to parse, and a reader can parse a half-written one.
 * It also loads index.json once and writes its in-memory copy back on every
 * commit, so a second process's commit in between is silently reverted
 * (last writer wins). There is no cross-process lock; the stamp check narrows
 * that race to the stat-to-rename window rather than closing it.
 */

import { ItemSelector, LocalIndex, type IndexItem, type MetadataTypes } from "vectra";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";

interface FileStamp {
  mtimeMs: number;
  size: number;
}

interface IndexData {
  items: IndexItem[];
}

// Vectra keeps these TS-private; the fields exist at runtime on every instance.
interface VectraInternals {
  _data?: IndexData;
  _update?: IndexData;
}

export class ConcurrentWriteError extends Error {}

/** index.json exists but does not parse; `--full` sets it aside and rebuilds. */
export class UnparsableIndexError extends Error {}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class AtomicLocalIndex extends LocalIndex {
  private loadedStamp: FileStamp | null = null;

  private get indexPath(): string {
    return join(this.folderPath, this.indexName);
  }

  private get internals(): VectraInternals {
    return this as unknown as VectraInternals;
  }

  private stampNow(): FileStamp | null {
    try {
      const st = statSync(this.indexPath);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  }

  /** Remove temp files left by commits whose process died mid-write. */
  private sweepTempFiles(): void {
    const pattern = new RegExp(`^${this.indexName.replace(/\./g, "\\.")}\\.(\\d+)\\.tmp$`);
    let names: string[];
    try {
      names = readdirSync(this.folderPath);
    } catch {
      return;
    }
    for (const name of names) {
      const pid = Number(pattern.exec(name)?.[1]);
      if (pid && pid !== process.pid && !isAlive(pid)) {
        rmSync(join(this.folderPath, name), { force: true });
      }
    }
  }

  override async createIndex(...args: Parameters<LocalIndex["createIndex"]>): Promise<void> {
    await super.createIndex(...args);
    this.loadedStamp = this.stampNow();
  }

  protected override async loadIndexData(): Promise<void> {
    if (this.internals._data) return;
    this.sweepTempFiles();
    // Stamp before reading: a commit landing between the two makes the stamp
    // stale, which can only cause a spurious ConcurrentWriteError, never a
    // silent overwrite.
    const stamp = this.stampNow();
    try {
      await super.loadIndexData();
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new UnparsableIndexError(
          `${this.indexPath} is unparsable (${err.message}); run \`bun run bin/recall-reindex.ts --full\` to set it aside and rebuild`,
        );
      }
      throw err;
    }
    this.loadedStamp = stamp;
  }

  /** Rename an unparsable index.json out of the way; returns where it went. */
  setAside(): string {
    const aside = `${this.indexPath}.corrupt-${Date.now()}`;
    renameSync(this.indexPath, aside);
    this.internals._data = undefined;
    this.loadedStamp = null;
    return aside;
  }

  // Vectra's beginUpdate copies only the top-level object, so the update shares
  // the items array and item objects with the committed data: its deletes and
  // upserts would show through to searches and survive cancelUpdate.
  override async beginUpdate(): Promise<void> {
    await super.beginUpdate();
    const update = this.internals._update;
    if (update) {
      this.internals._update = { ...update, items: update.items.map((i) => ({ ...i })) };
    }
  }

  // Vectra's upsert of an existing id replaces the vector but keeps the old
  // norm, which cosine scoring divides by.
  override async upsertItem<TItemMetadata extends Record<string, MetadataTypes>>(
    item: Partial<IndexItem<TItemMetadata>>,
  ): Promise<IndexItem<TItemMetadata>> {
    if (!this.internals._update) {
      await this.beginUpdate();
      try {
        const stored = await this.upsertItem(item);
        await this.endUpdate();
        return stored;
      } catch (err) {
        this.cancelUpdate();
        throw err;
      }
    }
    const stored = await super.upsertItem(item);
    stored.norm = ItemSelector.normalize(stored.vector);
    return stored;
  }

  override async endUpdate(): Promise<void> {
    const update = this.internals._update;
    if (!update) throw new Error("No update in progress");

    const now = this.stampNow();
    const loaded = this.loadedStamp;
    if (loaded && (!now || now.mtimeMs !== loaded.mtimeMs || now.size !== loaded.size)) {
      throw new ConcurrentWriteError(
        `${this.indexPath} changed on disk since this process loaded it`,
      );
    }

    // Stamp the temp file itself (rename keeps mtime and size): a stat of the
    // path after the rename could record a concurrent writer's file instead.
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    let written: FileStamp;
    try {
      const fd = openSync(tmp, "w");
      try {
        writeFileSync(fd, JSON.stringify(update));
        fsyncSync(fd);
        const st = fstatSync(fd);
        written = { mtimeMs: st.mtimeMs, size: st.size };
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.indexPath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    this.internals._data = update;
    this.internals._update = undefined;
    this.loadedStamp = written;
  }
}
