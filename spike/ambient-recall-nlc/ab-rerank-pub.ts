// Neutral, publicly-reproducible A/B for the upstream issue: same query+docs
// through llama-server /v1/rerank vs node-llama-cpp rankAll. Recovers logits via
// inverse-sigmoid / inverse-softmax to show both consume the SAME yes-logit.
// Throwaway — delete after the issue is posted.
import { rankContext } from "./models.ts";

const query = "what is the capital of France";
const docs = [
  "Paris is the capital of France.",                       // relevant
  "The Eiffel Tower is a landmark located in Paris.",      // related
  "Photosynthesis converts sunlight into chemical energy.", // irrelevant
  "I had a turkey sandwich for lunch and it was fine.",    // irrelevant
];

const res = await fetch("http://localhost:8090/v1/rerank", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query, documents: docs }),
});
const j = (await res.json()) as { results: Array<{ index: number; relevance_score: number }> };
const server = new Array(docs.length).fill(0);
for (const r of j.results) server[r.index] = r.relevance_score;

const ctx = await rankContext();
const nlc = await ctx.rankAll(query, docs);

const clamp = (s: number) => Math.min(1 - 1e-6, Math.max(1e-6, s));
const logit = (s: number) => Math.log(clamp(s) / (1 - clamp(s)));

console.log("\n| doc | llama-server /v1/rerank | rankAll | sigmoid(server) |");
console.log("|---|---|---|---|");
for (let i = 0; i < docs.length; i++) {
  const sigServer = 1 / (1 + Math.exp(-server[i]));
  console.log(`| ${docs[i].slice(0, 40)} | ${server[i].toFixed(4)} | ${nlc[i].toFixed(4)} | ${sigServer.toFixed(4)} |`);
}
console.log("\n(rankAll column should equal the sigmoid(server) column — that's the double-transform)");