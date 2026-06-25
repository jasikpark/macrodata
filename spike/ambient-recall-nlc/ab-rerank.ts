// Black-box A/B: same query+docs through llama-server /v1/rerank vs node-llama-cpp
// rankAll. Inverse-sigmoid both → recover logits. If logit_llama ≈ k·logit_nlc
// (constant k), it's the SAME logit, different sigmoid scale. Throwaway.
import { rankContext } from "./models.ts";

const query = "porrima synthesis mechanism";
const docs = [
  "Porrima extracts memories via a second LLM and reranks them with a cross-encoder.", // strong
  "Macrodata's ambient recall pipeline uses vector plus FTS plus cross-encoder rerank.", // medium-strong
  "Open-strix optimizes memory for forgetting rather than recall.", // medium (adjacent)
  "The webclient onboarding flow creates a host and enrolls it via the API.", // weak
  "The weather is sunny and warm today.", // irrelevant
  "I had a turkey sandwich for lunch and it was fine.", // irrelevant
];

// llama-server /v1/rerank (warm :8090)
const res = await fetch("http://localhost:8090/v1/rerank", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query, documents: docs }),
});
const j = (await res.json()) as { results: Array<{ index: number; relevance_score: number }> };
const llama = new Array(docs.length).fill(0);
for (const r of j.results) llama[r.index] = r.relevance_score;

// node-llama-cpp rankAll (in-process)
const ctx = await rankContext();
const nlc = await ctx.rankAll(query, docs);

const clamp = (s: number) => Math.min(1 - 1e-6, Math.max(1e-6, s));
const logit = (s: number) => Math.log(clamp(s) / (1 - clamp(s)));

// Theory: llama = softmax([yes,no])[0] → logit(llama) = yes-no ; nlc = sigmoid(yes) → logit(nlc) = yes.
// So: recovered yes-logit = logit(nlc); recovered no-logit = logit(nlc) - logit(llama).
console.log("\nidx | llama   nlc   | yes(=logitNlc)  no(=logitNlc-logitLlama) | doc");
console.log("----+---------------+-----------------------------------------+----");
for (let i = 0; i < docs.length; i++) {
  const Ll = logit(llama[i]), Ln = logit(nlc[i]);
  const yes = Ln, no = Ln - Ll;
  console.log(
    `${i}   | ${llama[i].toFixed(3)} ${nlc[i].toFixed(3)} | ` +
    `${yes.toFixed(2).padStart(8)}      ${no.toFixed(2).padStart(8)}                | ${docs[i].slice(0, 34)}`,
  );
}
console.log("\nConfirms theory if: relevant docs → high yes + very-negative no (softmax→1.0, sigmoid→0.7);");
console.log("irrelevant → yes≈0 + no≈0 (both backends ≈0.50). Then nlc=sigmoid(yes), llama=softmax(yes,no), SAME yes-logit.");
