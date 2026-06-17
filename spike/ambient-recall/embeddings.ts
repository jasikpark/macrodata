/**
 * Qwen3 embeddings (spike) via a warm llama-server over HTTP.
 *
 * PIVOTED 2026-06-16 from onnxruntime-node (CPU-only on mac, ~143ms/query,
 * ~17min bulk) to llama.cpp's llama-server on Metal (~8ms/query). The server is
 * a persistent warm process, so this also solves the "model load per hook
 * process" problem — the hook just fetches. Same exported signatures as the
 * ONNX version, so indexer.ts is unchanged.
 *
 * Run the server (separate process):
 *   llama-server -hf Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0 \
 *     --embedding --pooling last --port 8091 -c 4096 -b 8192 -ub 8192
 *
 * Qwen3-Embedding is asymmetric: DOCUMENTS embed raw; QUERIES get an
 * "Instruct: <task>\nQuery:<q>" prefix. Pooling (last_token) is configured on
 * the server. Vectors come back L2-normalized; 1024-dim.
 */

export const EMBEDDING_DIMENSIONS = 1024;

// Port 8091, not 8080 — webclient's dev server owns 8080 (Caleb 2026-06-17).
const SERVER = process.env.MACRODATA_EMBED_URL || "http://localhost:8091";

export const DEFAULT_TASK =
  "Given a description of what the user is currently working on, retrieve memory entries (facts, notes, decisions, journal entries, project context) that are relevant to it";

function queryPrompt(query: string, task: string = DEFAULT_TASK): string {
  return `Instruct: ${task}\nQuery:${query}`;
}

// POST to the OpenAI-compatible /v1/embeddings endpoint. Accepts an array input;
// response order isn't guaranteed, so we sort by `index`.
async function embedRaw(inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const res = await fetch(`${SERVER}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: inputs, model: "qwen3-embedding" }),
  });
  if (!res.ok) {
    throw new Error(`embed server ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function embedDocument(text: string): Promise<number[]> {
  return (await embedRaw([text]))[0];
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  // The server batches on the GPU; keep request size bounded so a single POST
  // body doesn't get huge. 64 is comfortable for Metal at this model size.
  const batchSize = 64;
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    results.push(...(await embedRaw(texts.slice(i, i + batchSize))));
  }
  return results;
}

export async function embedQuery(query: string, task?: string): Promise<number[]> {
  return (await embedRaw([queryPrompt(query, task)]))[0];
}

// Server is already warm; just confirm it's reachable so callers fail fast with
// a clear message instead of a connection error mid-batch.
export async function preloadModel(): Promise<void> {
  const res = await fetch(`${SERVER}/health`).catch(() => null);
  if (!res || !res.ok) {
    throw new Error(`llama-server not reachable at ${SERVER} (start it: llama-server -hf Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0 --embedding --pooling last --port 8080)`);
  }
}
