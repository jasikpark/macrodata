/**
 * Qwen3 embeddings (-nlc variant) — IN-PROCESS via node-llama-cpp on Metal,
 * replacing the llama-server HTTP (:8091) leg. The model loads once (models.ts).
 *
 * Qwen3-Embedding is asymmetric: DOCUMENTS embed raw; QUERIES get an
 * "Instruct: <task>\nQuery:<q>" prefix. Pooling (last-token) comes from the GGUF
 * metadata. Vectors are L2-normalized here so they match the existing .index
 * (built L2-normalized via llama-server); 1024-dim. Same exported signatures as
 * the HTTP version, so indexer.ts is unchanged.
 */
import { CONTEXT_TOKENS, embedContext } from "./models.ts";

export const EMBEDDING_DIMENSIONS = 1024;

export const DEFAULT_TASK =
  "Given a description of what the user is currently working on, retrieve memory entries (facts, notes, decisions, journal entries, project context) that are relevant to it";

function queryPrompt(query: string, task: string = DEFAULT_TASK): string {
  return `Instruct: ${task}\nQuery:${query}`;
}

function l2normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  return norm > 0 ? v.map((x) => x / norm) : v;
}

// Headroom for the BOS/EOS tokens getEmbeddingFor adds around the input.
const MAX_INPUT_TOKENS = CONTEXT_TOKENS - 8;

// In-process embedding via node-llama-cpp. Sequential getEmbeddingFor (the context
// is one sequence); fine for the one-shot reindex and per-query use. Inputs are
// cut to the token window: a character cap alone lets token-dense text (rare
// scripts, byte-fallback runs) overflow it, and getEmbeddingFor throws on that.
async function embedRaw(inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const ctx = await embedContext();
  const out: number[][] = [];
  for (const text of inputs) {
    const tokens = ctx.model.tokenize(text);
    const e = await ctx.getEmbeddingFor(
      tokens.length > MAX_INPUT_TOKENS ? tokens.slice(0, MAX_INPUT_TOKENS) : text,
    );
    out.push(l2normalize([...e.vector]));
  }
  return out;
}

export async function embedDocument(text: string): Promise<number[]> {
  return (await embedRaw([text]))[0];
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  return embedRaw(texts);
}

export async function embedQuery(query: string, task?: string): Promise<number[]> {
  return (await embedRaw([queryPrompt(query, task)]))[0];
}

// Warm the in-process model so callers fail fast (and pay the load cost) up front.
export async function preloadModel(): Promise<void> {
  await embedContext();
}
