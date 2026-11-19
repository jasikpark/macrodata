/**
 * Retrieval profiles: the ambient profile keeps the hook's long-standing
 * defaults and env overrides; the search profile always answers.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ambientProfile, getProfile, searchProfile } from "../src/recall/profiles.ts";
import { finalizeHits } from "../src/recall/fts.ts";

const ENV_KEYS = [
  "MACRODATA_RECALL_LEG_K",
  "MACRODATA_RECALL_RERANK_POOL",
  "MACRODATA_RECALL_MMR_LAMBDA",
  "MACRODATA_RECALL_HALFLIFE_DAYS",
  "MACRODATA_RECALL_FLOOR",
  "MACRODATA_RECALL_LIMIT",
];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("ambientProfile", () => {
  test("defaults match the hook's pre-profile constants", () => {
    clearEnv();
    expect(ambientProfile()).toEqual({
      name: "ambient",
      legK: 40,
      rerankPool: 20,
      mmrLambda: 0.55,
      halfLifeDays: 30,
      floor: 0.5,
      limit: 3,
    });
  });

  test("MACRODATA_RECALL_* overrides are read at call time", () => {
    clearEnv();
    process.env.MACRODATA_RECALL_FLOOR = "0.7";
    process.env.MACRODATA_RECALL_LEG_K = "64";
    const p = ambientProfile();
    expect(p.floor).toBe(0.7);
    expect(p.legK).toBe(64);
  });

  test("env overrides leave the search profile alone", () => {
    clearEnv();
    const before = searchProfile();
    process.env.MACRODATA_RECALL_FLOOR = "0.9";
    process.env.MACRODATA_RECALL_LIMIT = "1";
    expect(searchProfile()).toEqual(before);
  });
});

describe("searchProfile", () => {
  test("has no floor, so a deliberate search always answers", () => {
    expect(searchProfile().floor).toBe(0);
  });

  test("returns at least as many hits as ambient recall injects", () => {
    clearEnv();
    expect(searchProfile().limit).toBeGreaterThanOrEqual(ambientProfile().limit);
  });

  test("keeps the rerank pool inside the fused slate so MMR still gates", () => {
    const p = searchProfile();
    expect(p.rerankPool).toBeLessThan(p.legK * 2);
  });
});

describe("getProfile", () => {
  test("resolves by name", () => {
    expect(getProfile("search").name).toBe("search");
    expect(getProfile("ambient").name).toBe("ambient");
  });
});

describe("finalizeHits", () => {
  const hits = [{ score: 0.2 }, { score: 0.9 }, { score: 0.45 }, { score: 0.6 }];

  test("ambient drops hits under its floor and caps at its limit", () => {
    clearEnv();
    expect(finalizeHits(hits, ambientProfile()).map((h) => h.score)).toEqual([0.9, 0.6]);
  });

  test("search keeps below-floor hits, ranked by score", () => {
    expect(finalizeHits(hits, searchProfile()).map((h) => h.score)).toEqual([0.9, 0.6, 0.45, 0.2]);
  });
});
