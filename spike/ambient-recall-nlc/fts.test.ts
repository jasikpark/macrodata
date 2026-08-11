/**
 * Contract tests for mmrSelect — the MMR pool-selection stage. Pure function,
 * no index/models needed; synthetic candidates only.
 */
import { describe, expect, test } from "bun:test";
import { mmrSelect, type PoolCandidate } from "./fts.ts";

function cand(content: string, w: number): PoolCandidate {
  return {
    item: { content, source: "test", type: "journal", score: 0 },
    rrf: w,
    rec: 1,
    w,
  };
}

/** Slates arrive sorted by w descending, as pipelineSearch guarantees. */
function slate(...cands: PoolCandidate[]): PoolCandidate[] {
  return [...cands].sort((a, b) => b.w - a.w);
}

describe("mmrSelect", () => {
  test("lambda >= 1 degenerates to plain top-k", () => {
    const s = slate(
      cand("alpha beta gamma", 0.03),
      cand("alpha beta gamma delta", 0.02),
      cand("epsilon zeta eta", 0.01),
    );
    const picked = mmrSelect(s, 2, 1);
    expect(picked.map((c) => c.w)).toEqual([0.03, 0.02]);
  });

  test("slate smaller than k returns everything", () => {
    const s = slate(cand("alpha beta", 0.02), cand("gamma delta", 0.01));
    expect(mmrSelect(s, 20, 0.55)).toHaveLength(2);
  });

  test("near-duplicate loses its slot to a distinct lower-scored candidate", () => {
    // dup restates the top pick almost verbatim (adjacent-journal-days shape);
    // fresh covers different ground at a lower score. MMR must pick fresh.
    // junk exists so fresh is not the slate min — min-max normalization pins
    // the min to relevance 0, where no candidate can win on relevance at all.
    const top = cand("webclient punycode decoder tooltip ariakit hostname", 0.030);
    const dup = cand("webclient punycode decoder tooltip ariakit hostname component", 0.028);
    const fresh = cand("dnclient reconnect poll adaptive backoff rpc deadline", 0.012);
    const junk = cand("webclient punycode tooltip", 0.005);
    const picked = mmrSelect(slate(top, dup, fresh, junk), 2, 0.55);
    expect(picked[0].item.content).toBe(top.item.content);
    expect(picked[1].item.content).toBe(fresh.item.content);
  });

  test("with vectors, similarity is semantic — a paraphrase with zero token overlap is demoted", () => {
    // para shares NO tokens with top (Jaccard would score it 0 = maximally
    // novel) but its vector is identical: the same fact reworded. The cosine
    // path must demote it in favor of fresh, which is genuinely elsewhere.
    const top = { ...cand("webclient host rename fails on save", 0.03), vector: [1, 0, 0] };
    const para = { ...cand("renaming a machine breaks when you submit", 0.028), vector: [1, 0, 0] };
    const fresh = { ...cand("dnclient reconnect poll adaptive backoff", 0.02), vector: [0, 1, 0] };
    const junk = { ...cand("webclient host save", 0.005), vector: [0.9, 0.44, 0] };
    const picked = mmrSelect(slate(top, para, fresh, junk), 2, 0.55);
    expect(picked[0].item.content).toBe(top.item.content);
    expect(picked[1].item.content).toBe(fresh.item.content);
  });

  test("first pick is always the highest-w candidate", () => {
    const s = slate(
      cand("alpha beta gamma", 0.03),
      cand("delta epsilon zeta", 0.02),
      cand("eta theta iota", 0.01),
    );
    expect(mmrSelect(s, 2, 0.55)[0].w).toBe(0.03);
  });

  test("uniform-w slate survives normalization (no NaN) and returns k items", () => {
    const s = slate(
      cand("alpha beta", 0.02),
      cand("gamma delta", 0.02),
      cand("epsilon zeta", 0.02),
    );
    const picked = mmrSelect(s, 2, 0.55);
    expect(picked).toHaveLength(2);
    for (const c of picked) expect(Number.isNaN(c.w)).toBe(false);
  });

  test("selection order is preserved (not re-sorted by w afterwards)", () => {
    // With aggressive diversity, a low-w-but-novel candidate can be picked
    // second; the returned order must reflect pick order so downstream
    // diagnostics see what MMR actually did.
    const top = cand("alpha beta gamma delta", 0.030);
    const dup = cand("alpha beta gamma delta epsilon", 0.029);
    const fresh = cand("zeta eta theta iota", 0.005);
    const noise = cand("alpha beta gamma epsilon", 0.028);
    const picked = mmrSelect(slate(top, dup, fresh, noise), 3, 0.3);
    expect(picked[0].item.content).toBe(top.item.content);
    expect(picked[1].item.content).toBe(fresh.item.content);
    expect(picked.map((c) => c.item.content)).not.toEqual(
      slate(top, dup, fresh, noise).slice(0, 3).map((c) => c.item.content),
    );
  });
});
