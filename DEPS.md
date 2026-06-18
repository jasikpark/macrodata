# macrodata — dependencies

Breadcrumbs of intention for what macrodata needs to run, by tier. MVP-level — not a
polished first-time-setup wizard. This is the single source of truth the
**onboarding** and **context-doctor** skills point at; keep install facts here, not
duplicated across skills.

## Tier 0 — base macrodata (zero external deps)

The memory store + MCP server. File-based, fully offline. Needs only:

- **bun** (or node) to run the MCP server (`plugins/macrodata/`).
- Bundled embeddings: `@xenova/transformers` MiniLM (`Xenova/all-MiniLM-L6-v2`),
  downloaded once into the package — no external service, no GPU.

Nothing else. Journal/state/entities + semantic search work out of the box.

## Tier 1 — ambient recall (optional, local-LLM enhancement)

The `spike/ambient-recall/` pipeline (vector + FTS + RRF + cross-encoder rerank) that
surfaces memory mid-session. Heavier and platform-specific — **opt-in, never
auto-installed.** Requires:

1. **bun** — runs the hook (`hook.ts`) and the long-lived `worker.ts`.
2. **llama.cpp** — provides `llama-server`. macOS: `brew install llama.cpp`.
   (Other platforms: build from <https://github.com/ggml-org/llama.cpp>. Apple-Silicon
   Metal is the tested path; CPU-only works but the rerank is slow — see capability note.)
3. **Two model GGUFs** (auto-downloaded by `llama-server -hf` on first launch):
   - **embedding:** `Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0` → port **8091**
   - **reranker:** `ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF` → port **8090**
     - ⚠️ **MUST be the `ggml-org` GGUF.** Community Qwen3-Reranker GGUFs are missing
       the reranker tensors and return garbage scores (~`4.5e-23`). Verified 2026-06-16.

### Bring it up

The supervisor converges each of the three (embed, rerank, worker) to exactly one
running instance, then exits. It owns its `llama-server`s by a unique `--alias`, so a
`llama-server` you start by hand is invisible to it (never reaped):

```bash
bash spike/ambient-recall/supervisor.sh
```

Wired to run on **SessionStart** via `.claude/settings.local.json`, which also registers
the recall hook on `PostToolUse` (Read/WebSearch/WebFetch), `UserPromptSubmit`, and
`Stop`, all with `MACRODATA_RECALL_ASYNC=1`. The detached servers + worker persist after
the session exits.

### Verify

```bash
pgrep -fl 'macrodata-ambient-embed|macrodata-ambient-rerank|worker\.ts'   # 3 lines = healthy
curl -s localhost:8090/health && curl -s localhost:8091/health            # both OK
```

If recall goes silent: check the three are up (re-run the supervisor), then
`tail spike/ambient-recall/.worker.log` and `.recall-calibration.jsonl`.

### Updating after changes — what needs a restart

- **`hook.ts`** — spawned fresh per fire; edits take effect on the next fire. **No restart.**
- **`indexer.ts` indexing logic** (e.g. the recall topic-exclusion) — only runs at
  rebuild time (`reindex.ts`), never on the worker's query path. A worker restart does
  NOT activate it; a **rebuild** does.
- **The index itself** — upsert-only, so a topic-exclusion / parsing change only purges
  old entries on a *clean* rebuild: `rm -rf spike/ambient-recall/.index && bun run reindex.ts`
  (re-embeds everything, a few minutes on `:8091`).
- **The worker** holds the index in memory, so after a rebuild it serves a STALE index
  until bounced — and the supervisor won't replace a still-running worker (it only
  ensures ≥1 is up). **Release procedure: rebuild, then `pkill -f 'worker\.ts'`** and let
  the supervisor / next SessionStart respawn it against the fresh index.

### Capability note

Don't assume a GPU. The reranker is the cost center (~127ms/doc); on Metal it's the
async-worker win, on CPU it's slow-but-valid. A capability-tiered embed/rerank (skip
rerank on weak hardware) is tracked as gest `tvtssunv`.

### Ports

`8090` rerank, `8091` embed — chosen to dodge conflicts (`8081` was LanguageTool). If
either is taken, change both the supervisor and the pipeline (they must agree — see the
drift note below).

## Drift guard

This file is the *human* doc. The model repos / ports / launch flags also live in
`spike/ambient-recall/supervisor.sh` (and the ports in the pipeline). When the spike
graduates into `plugins/macrodata/`, have context-doctor's health-check import the
**same constants the code uses** rather than re-listing them here — so this doc can go
stale but the *check* can't lie.

## Someday — simpler shipping

Docker / Nix could make Tier 1 a one-command provision (pin llama.cpp + models + the
servers). Explicitly out of scope for now; noted as the eventual path to "install
simply."
