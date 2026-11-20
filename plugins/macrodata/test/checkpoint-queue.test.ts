/**
 * The session checkpoint queue: hooks writing request files
 * (bin/checkpoint-hook.ts) against the daemon's CheckpointQueue, on a fake
 * filesystem and clock.
 *
 * World replays a history of hook fires (whole, or started and later committed,
 * so a hook that began before a run can land during it), watcher deliveries
 * (coalesced, as chokidar may), clock advances, runs that succeed or fail
 * (optionally with a hook write landing in the middle of the daemon's file
 * work), reloads and unusable files. drain() then does what the daemon
 * eventually would: deliver every pending watcher event, let runs succeed, let
 * time pass, and re-arm every file as a restart does.
 *
 * Invariants:
 * - at most one run per session at a time;
 * - no run starts before its request's delay has passed;
 * - a run's request is the session's files folded: the newest write and the
 *   strongest event among them;
 * - the run that consumes a request file acts with at least that file's event;
 * - after the drain, every request was followed by a successful run that
 *   started after its hook did, and no request file is left.
 *
 * Knobs: PROP_RUNS=<n> for a longer search, PROP_SEED=<seed> PROP_PATH=<path> to
 * replay a reported failure, PROP_STATS=1 to print how often each interesting
 * situation was reached.
 */

import fc from "fast-check";
import { describe, test, expect } from "bun:test";
import {
  checkpointDelayMs,
  parseCheckpointRequest,
  requestFileName,
  sessionOfRequestFile,
  STOP_DELAY_MS,
  type CheckpointEvent,
  type CheckpointRequest,
} from "../src/checkpoint.ts";
import { CheckpointQueue } from "../src/checkpoint-queue.ts";

const SESSIONS = ["s0", "s1"] as const;
type Session = (typeof SESSIONS)[number];
const EVENTS: CheckpointEvent[] = ["Stop", "PreCompact", "SessionEnd"];
const RANK: Record<CheckpointEvent, number> = { Stop: 0, PreCompact: 1, SessionEnd: 2 };
const DIR = "/q";
const sessionOf = (path: string) => sessionOfRequestFile(path.slice(DIR.length + 1)) as Session | null;

type Op =
  | { kind: "fire"; s: Session; event: CheckpointEvent }
  | { kind: "hookStart"; s: Session; event: CheckpointEvent }
  | { kind: "hookCommit"; i: number }
  | { kind: "deliver"; s: Session }
  | { kind: "advance"; ms: number }
  | { kind: "complete"; i: number; ok: boolean; race: CheckpointEvent | null }
  | { kind: "reload" }
  | { kind: "junk"; s: Session };

const session = fc.constantFrom(...SESSIONS);
const event = fc.constantFrom(...EVENTS);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("fire" as const), s: session, event }), weight: 5 },
  { arbitrary: fc.record({ kind: fc.constant("hookStart" as const), s: session, event }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("hookCommit" as const), i: fc.nat(3) }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant("deliver" as const), s: session }), weight: 5 },
  {
    arbitrary: fc.record({
      kind: fc.constant("advance" as const),
      ms: fc.constantFrom(0, 1, 1000, STOP_DELAY_MS - 1, STOP_DELAY_MS, 2 * STOP_DELAY_MS),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("complete" as const),
      i: fc.nat(1),
      ok: fc.boolean(),
      race: fc.option(event, { freq: 3 }),
    }),
    weight: 6,
  },
  { arbitrary: fc.record({ kind: fc.constant("reload" as const) }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("junk" as const), s: session }), weight: 1 },
);

const flush = () => new Promise<void>((r) => setImmediate(r));

interface Commit {
  s: Session;
  path: string;
  /** Sequence numbers of the hook's start and of its write. */
  startSeq: number;
  seq: number;
  req: CheckpointRequest;
}

interface Run {
  s: Session;
  startSeq: number;
  at: number;
  req: CheckpointRequest;
  /** Valid request files present when the run started. */
  files: string[];
  ok?: boolean;
}

class World {
  now = 1_000_000;
  seq = 0;
  files = new Map<string, string>();
  timers = new Map<number, { at: number; fn: () => void }>();
  nextTimer = 1;
  nextTag = 0;
  /** Paths written but not yet reported by the watcher, per session. */
  undelivered = new Map<Session, string[]>();
  /** A hook write to land during the daemon's next file access for a session. */
  interleave = new Map<Session, () => void>();
  pendingRuns = new Map<Session, { resolve: () => void; reject: (e: Error) => void }>();
  inflightHooks: { s: Session; req: CheckpointRequest; startSeq: number }[] = [];
  commits: Commit[] = [];
  runs: Run[] = [];
  stats: Record<string, number> = {};
  queue: CheckpointQueue;

  constructor() {
    this.queue = this.newQueue();
  }

  hit(k: string) {
    this.stats[k] = (this.stats[k] ?? 0) + 1;
  }

  private touch(path: string) {
    const s = sessionOf(path);
    const hook = s && this.interleave.get(s);
    if (hook) {
      this.interleave.delete(s);
      hook();
    }
  }

  newQueue() {
    return new CheckpointQueue({
      list: () => [...this.files.keys()],
      read: (path) => {
        const raw = this.files.get(path);
        if (raw === undefined) throw new Error("ENOENT");
        this.touch(path);
        return raw;
      },
      remove: (path) => {
        if (!this.files.delete(path)) throw new Error("ENOENT");
        this.touch(path);
      },
      now: () => this.now,
      setTimer: (fn, ms) => {
        const id = this.nextTimer++;
        this.timers.set(id, { at: this.now + ms, fn });
        return id;
      },
      clearTimer: (id) => void this.timers.delete(id as number),
      run: (req) => this.startRun(req),
      log: () => {},
      logError: () => {},
    });
  }

  private valid(s: Session) {
    return this.commits.filter((c) => c.s === s && this.files.has(c.path));
  }

  // Recorded, not thrown: the queue treats anything run() throws as an indexer
  // failure, which would hide the violation.
  violations: string[] = [];
  /** Files a failed run read; only these may wait for a restart. */
  failedFiles = new Set<string>();
  /** Sessions whose last run failed with no new file, watcher event or reload since. */
  failedIdle = new Set<Session>();

  private startRun(req: CheckpointRequest): Promise<void> {
    const s = req.session_id as Session;
    if (this.pendingRuns.has(s)) this.violations.push(`concurrent runs for ${s}`);
    if (this.failedIdle.has(s)) this.violations.push(`run for ${s} retried a failure with nothing new queued`);
    const due = req.ts + checkpointDelayMs(req.event);
    if (this.now < due) this.violations.push(`run for ${s} started ${due - this.now}ms early`);
    // Independent fold of the files on disk. A hook write interleaved into this
    // run's own listing may or may not be in it, so then only bound it.
    const present = this.valid(s);
    const maxTs = Math.max(...present.map((c) => c.req.ts));
    const maxRank = Math.max(...present.map((c) => RANK[c.req.event]));
    if (req.ts > maxTs || RANK[req.event] > maxRank) {
      this.violations.push(`run for ${s} acted on ${req.event}@${req.ts}, beyond what is queued`);
    }
    if (!this.interleaved && (req.ts !== maxTs || RANK[req.event] !== maxRank)) {
      this.violations.push(`run for ${s} acted on ${req.event}@${req.ts}, not the queued files folded`);
    }
    const run: Run = { s, startSeq: ++this.seq, at: this.now, req, files: present.map((c) => c.path) };
    this.runs.push(run);
    this.hit(`run ${req.event}`);
    if (present.length > 1) this.hit("run folding several files");
    return new Promise<void>((resolve, reject) => {
      this.pendingRuns.set(s, {
        resolve: () => {
          run.ok = true;
          resolve();
        },
        reject: (e) => {
          run.ok = false;
          for (const p of run.files) this.failedFiles.add(p);
          if (![...this.files.keys()].some((p) => sessionOf(p) === s && !run.files.includes(p))) this.failedIdle.add(s);
          reject(e);
        },
      });
    });
  }
  interleaved = false;

  /** A hook starting now; the transcript bytes it announces are already written. */
  start(s: Session, event: CheckpointEvent) {
    return {
      s,
      req: { session_id: s, transcript_path: `/t/${s}.jsonl`, event, ts: this.now },
      startSeq: ++this.seq,
    };
  }

  commit(h: { s: Session; req: CheckpointRequest; startSeq: number }) {
    const path = `${DIR}/${requestFileName(h.req, 4242, String(this.nextTag++))}`;
    this.files.set(path, JSON.stringify(h.req));
    this.undelivered.set(h.s, [...(this.undelivered.get(h.s) ?? []), path]);
    this.commits.push({ ...h, path, seq: ++this.seq });
    this.failedIdle.delete(h.s);
  }

  async advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (due.length === 0) break;
      const [id, t] = due[0]!;
      this.timers.delete(id);
      this.now = Math.max(this.now, t.at);
      t.fn();
      await flush();
    }
    this.now = until;
  }

  deliver(s: Session) {
    const paths = this.undelivered.get(s) ?? [];
    if (paths.length === 0) return;
    // chokidar may coalesce several writes into one event.
    this.undelivered.set(s, []);
    if (paths.length > 1) this.hit("coalesced delivery");
    this.failedIdle.delete(s);
    this.queue.arm(paths.at(-1)!);
  }

  async apply(op: Op) {
    switch (op.kind) {
      case "fire":
        this.commit(this.start(op.s, op.event));
        break;
      case "hookStart":
        this.inflightHooks.push(this.start(op.s, op.event));
        break;
      case "hookCommit": {
        if (this.inflightHooks.length === 0) return;
        const [h] = this.inflightHooks.splice(op.i % this.inflightHooks.length, 1);
        if (this.inflightHooks.length > 0) this.hit("overlapping hooks");
        if (this.pendingRuns.has(h!.s)) this.hit("hook started before a run, landed during it");
        this.commit(h!);
        break;
      }
      case "deliver":
        this.deliver(op.s);
        break;
      case "advance":
        await this.advance(op.ms);
        break;
      case "complete": {
        const live = [...this.pendingRuns.keys()];
        if (live.length === 0) return;
        const s = live[op.i % live.length]!;
        this.hit("complete with a run in flight");
        const run = this.pendingRuns.get(s)!;
        this.pendingRuns.delete(s);
        if (op.race) {
          const race = op.race;
          this.hit("write during the daemon's post-run file work");
          this.interleave.set(s, () => {
            this.interleaved = true;
            this.commit(this.start(s, race));
          });
        }
        if (op.ok) run.resolve();
        else run.reject(new Error("indexer failed"));
        await flush();
        this.interleave.delete(s);
        this.interleaved = false;
        break;
      }
      case "reload":
        // reload(): stop the watcher's timers, then re-add every file on disk.
        this.queue.stop();
        this.failedIdle.clear();
        for (const p of this.files.keys()) this.queue.arm(p);
        break;
      case "junk": {
        const path = `${DIR}/${op.s}.${this.now}-4242-junk${this.nextTag++}.json`;
        this.files.set(path, "{}");
        this.undelivered.set(op.s, [...(this.undelivered.get(op.s) ?? []), path]);
        break;
      }
    }
  }

  /** Everything the daemon would eventually do with no more hook fires. */
  async drain() {
    for (const h of this.inflightHooks.splice(0)) this.commit(h);
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 20; i++) {
        for (const s of SESSIONS) this.deliver(s);
        for (const [s, run] of this.pendingRuns) {
          this.pendingRuns.delete(s);
          run.resolve();
          await flush();
        }
        if (this.pendingRuns.size === 0 && this.timers.size === 0) break;
        await this.advance(STOP_DELAY_MS);
      }
      // Without a restart, the only requests allowed to wait are ones queued
      // before their session's last failed run.
      if (round === 0) {
        for (const c of this.commits) {
          if (this.failedFiles.has(c.path)) continue;
          if (!this.runs.some((r) => r.s === c.s && r.ok && r.startSeq > c.startSeq)) {
            this.violations.push(`${c.s}'s ${c.req.event} (hook start seq ${c.startSeq}) needed a restart to run`);
          }
        }
      }
      // A failed run leaves its files for the next daemon start, which re-adds
      // every file (ignoreInitial: false).
      if (this.files.size === 0) break;
      this.queue.stop();
        this.failedIdle.clear();
      for (const p of this.files.keys()) this.queue.arm(p);
    }
  }

  check() {
    expect(this.violations).toEqual([]);
    expect([...this.files.keys()]).toEqual([]);
    for (const c of this.commits) {
      const covered = this.runs.some((r) => r.s === c.s && r.ok && r.startSeq > c.startSeq);
      if (!covered) {
        throw new Error(`${c.s}'s ${c.req.event} (hook start seq ${c.startSeq}) was never followed by a successful run`);
      }
      const consumer = this.runs.find((r) => r.ok && r.files.includes(c.path));
      if (consumer && RANK[consumer.req.event] < RANK[c.req.event]) {
        throw new Error(`${c.s}'s ${c.req.event} was consumed by a ${consumer.req.event} run`);
      }
    }
  }
}

async function replay(ops: Op[]): Promise<World> {
  const w = new World();
  for (const op of ops) await w.apply(op);
  await w.drain();
  w.check();
  return w;
}

describe("checkpoint queue", () => {
  test("overlapping hooks: a Stop landing after SessionEnd still runs SessionEnd at once", async () => {
    const w = new World();
    await w.apply({ kind: "hookStart", s: "s0", event: "SessionEnd" });
    await w.apply({ kind: "hookStart", s: "s0", event: "Stop" });
    await w.apply({ kind: "hookCommit", i: 0 });
    await w.apply({ kind: "hookCommit", i: 0 });
    await w.apply({ kind: "deliver", s: "s0" });
    await w.apply({ kind: "advance", ms: 0 });
    expect(w.runs.map((r) => r.req.event)).toEqual(["SessionEnd"]);
    await w.drain();
    w.check();
  });

  test("a write landing while the daemon deletes a finished run's files survives it", async () => {
    const w = await replay([
      { kind: "fire", s: "s0", event: "Stop" },
      { kind: "deliver", s: "s0" },
      { kind: "advance", ms: STOP_DELAY_MS },
      { kind: "complete", i: 0, ok: true, race: "Stop" },
    ]);
    expect(w.runs.filter((r) => r.ok)).toHaveLength(2);
  });

  test("a Stop in the same millisecond a PreCompact run started gets its own run", async () => {
    const w = await replay([
      { kind: "fire", s: "s1", event: "PreCompact" },
      { kind: "reload" },
      { kind: "advance", ms: 0 },
      { kind: "fire", s: "s1", event: "Stop" },
    ]);
    expect(w.runs.map((r) => r.req.event)).toEqual(["PreCompact", "Stop"]);
  });

  test("a burst of Stops runs once, after the last one's delay", async () => {
    const w = new World();
    for (let i = 0; i < 3; i++) {
      await w.apply({ kind: "fire", s: "s0", event: "Stop" });
      await w.apply({ kind: "deliver", s: "s0" });
      await w.apply({ kind: "advance", ms: 1000 });
    }
    await w.apply({ kind: "advance", ms: STOP_DELAY_MS - 1001 });
    expect(w.runs).toHaveLength(0);
    await w.apply({ kind: "advance", ms: 1 });
    expect(w.runs).toHaveLength(1);
    expect(w.runs[0]!.files).toHaveLength(3);
  });

  test("request file names round-trip their session and nothing else parses", () => {
    const req = { session_id: "abc-1_2", transcript_path: "/t.jsonl", event: "Stop" as const, ts: 5 };
    expect(sessionOfRequestFile(requestFileName(req, 7, "x9"))).toBe("abc-1_2");
    for (const name of ["abc.json", "abc.5-7-x9.json.tmp", "../x.5-7-a.json", "a.b.5-7-a.json"]) {
      expect(sessionOfRequestFile(name)).toBeNull();
    }
    expect(parseCheckpointRequest(JSON.stringify(req))).toEqual(req);
  });
});

describe("checkpoint queue (property)", () => {
  test("every request is acted on, by one run at a time, after its delay, with its event", async () => {
    const stats: Record<string, number> = {};
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 60, size: "large" }), async (ops) => {
        const w = await replay(ops);
        for (const [k, n] of Object.entries(w.stats)) stats[k] = (stats[k] ?? 0) + n;
      }),
      {
        numRuns: Number(process.env.PROP_RUNS ?? 300),
        ...(process.env.PROP_SEED
          ? { seed: Number(process.env.PROP_SEED), path: process.env.PROP_PATH }
          : {}),
      },
    );
    if (process.env.PROP_STATS) console.log(stats);
  });
});
