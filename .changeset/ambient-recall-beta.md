---
"macrodata": minor
---

Ambient memory recall (beta, spike): on UserPromptSubmit / PostToolUse / Stop, a hook asks a local retrieval pipeline for memories relevant to the current context and injects hits on the next opportunity via a file-mailbox protocol. Dual-leg retrieval (Vectra vector + FTS) with RRF fusion, last-accessed recency bias, and Qwen3 cross-encoder rerank — running fully in-process on Metal via node-llama-cpp 3.19.1 (one background worker, no llama-server processes). Lives under `spike/ambient-recall-nlc/` with per-machine wiring via `.claude/settings.local.json`; not yet part of the installed plugin — soak + backtest harness gate the reification.
