import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { createTestContext, type TestContext } from "./helpers.ts";
import { VERDICTS, clockEvent, recordVerdicts } from "../src/recall/verdicts.ts";

let ctx: TestContext;

const rows = (file: string) =>
  existsSync(join(ctx.root, ".recall", file))
    ? readFileSync(join(ctx.root, ".recall", file), "utf-8").trim().split("\n").map((l) => JSON.parse(l))
    : [];

beforeEach(() => {
  ctx = createTestContext("macrodata-verdicts-");
});

afterEach(() => {
  ctx.cleanup();
});

describe("recordVerdicts", () => {
  test("writes one row per graded hit plus a keyless row for the slate note", () => {
    const ts = "2026-10-13T23:00:00.000Z";
    recordVerdicts(
      [
        { key: "j:aaaa", verdict: "useful" },
        { key: "j:bbbb", verdict: "off-topic", note: "turn was about CI" },
      ],
      "slate came from the tool output, not the prompt",
      ts,
    );
    expect(rows("verdicts.jsonl")).toEqual([
      { ts, key: "j:aaaa", verdict: "useful" },
      { ts, key: "j:bbbb", verdict: "off-topic", note: "turn was about CI" },
      { ts, note: "slate came from the tool output, not the prompt" },
    ]);
  });

  test("writes nothing for an empty call", () => {
    recordVerdicts([], undefined, "2026-10-13T23:00:00.000Z");
    expect(existsSync(join(ctx.root, ".recall", "verdicts.jsonl"))).toBe(false);
  });

  test("records an access event exactly for the verdicts that move the clock", () => {
    const ts = "2026-10-13T23:00:00.000Z";
    recordVerdicts(VERDICTS.map((verdict, i) => ({ key: `j:${i}`, verdict })), undefined, ts);
    const expected = VERDICTS.flatMap((verdict, i) => {
      const kind = clockEvent(verdict);
      return kind ? [{ ts, key: `j:${i}`, kind }] : [];
    });
    expect(rows("access-events.jsonl")).toEqual(expected);
  });
});
