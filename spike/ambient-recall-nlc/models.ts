/**
 * In-process model singletons via node-llama-cpp (Metal GPU) — the -nlc variant's
 * replacement for the external llama-server HTTP endpoints (:8091 embed, :8090
 * rerank) and supervisor.sh. Models load ONCE per process (lazy): fine for the
 * long-lived worker and the one-shot reindex / `--query` CLI, but NOT the per-fire
 * hook (so the -nlc hook is async-only — it never loads models, the worker does).
 *
 * Same GGUFs as the llama-server setup; embedding pooling is driven by the model's
 * own GGUF metadata (Qwen3-Embedding ships last-token pooling).
 */
import { getLlama, resolveModelFile } from "node-llama-cpp";

const EMBED_URI = process.env.MACRODATA_EMBED_MODEL ?? "hf:Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0";
const RERANK_URI = process.env.MACRODATA_RERANK_MODEL ?? "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";

let _llama: ReturnType<typeof getLlama> | undefined;
const llama = () => (_llama ??= getLlama());

async function loadEmbed() {
  const model = await (await llama()).loadModel({ modelPath: await resolveModelFile(EMBED_URI) });
  return model.createEmbeddingContext({ contextSize: 4096 });
}
let _embed: ReturnType<typeof loadEmbed> | undefined;
export const embedContext = () => (_embed ??= loadEmbed());

async function loadRank() {
  const model = await (await llama()).loadModel({ modelPath: await resolveModelFile(RERANK_URI) });
  return model.createRankingContext({ contextSize: 4096 });
}
let _rank: ReturnType<typeof loadRank> | undefined;
export const rankContext = () => (_rank ??= loadRank());

// Which GPU backend resolved (metal/cuda/false) — for the smoke/CLI to report.
export async function gpuInfo(): Promise<string> {
  const l = await llama();
  return l.gpu ? (await l.getGpuDeviceNames()).join(",") || String(l.gpu) : "cpu";
}
