#!/usr/bin/env bash
# Ensure-up + reap supervisor for the ambient-recall spike (shape B).
#
# Run by the SessionStart hook. Converges each of the three to EXACTLY ONE
# running instance, then exits:
#   - embed  llama-server  :8091  (--alias macrodata-ambient-embed)
#   - rerank llama-server  :8090  (--alias macrodata-ambient-rerank)
#   - worker  bun run worker.ts   (drains .recall-request-*, writes .recall-inbox-*)
#
# Ownership: our llama-servers carry a unique --alias, and we match ONLY on that
# (never the model name) — so a llama-server you start by hand in a shell is
# invisible here and can never be counted or reaped. The worker is matched by its
# own script path (no one else runs it).
#
# Spawned directly via nohup (no shell wrapper) so one logical process = one PID,
# which keeps the reap honest. Reap rule: if >1 of ours, keep the lowest PID (the
# first to start = the one holding the port) and kill the rest. Detached procs
# persist after this script + the session exit. Logs → .{supervisor,embed,rerank,
# worker}.log (gitignored). Silent on stdout.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log() { echo "[$(date '+%F %T')] $*" >> "$DIR/.supervisor.log"; }

ensure() { # name  pgrep-pattern  -- start-cmd...
  local name="$1" pat="$2"; shift 2
  local pids; pids="$(pgrep -f "$pat" 2>/dev/null || true)"
  local n; n="$(printf '%s\n' "$pids" | grep -c '[0-9]')"
  if [ "$n" -eq 0 ]; then
    log "$name: down -> starting"
    ( cd "$DIR" && nohup "$@" >> "$DIR/.$name.log" 2>&1 & )
  elif [ "$n" -gt 1 ]; then
    local keep extras
    keep="$(printf '%s\n' "$pids" | sort -n | head -1)"
    extras="$(printf '%s\n' "$pids" | sort -n | tail -n +2 | tr '\n' ' ')"
    log "$name: $n instances -> reap (keep $keep, kill $extras)"
    # shellcheck disable=SC2086
    kill $extras 2>/dev/null || true
  else
    log "$name: up (pid $pids)"
  fi
}

ensure embed 'macrodata-ambient-embed' \
  llama-server -hf Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0 --alias macrodata-ambient-embed --embedding --pooling last --port 8091 -c 4096 -b 8192 -ub 8192

ensure rerank 'macrodata-ambient-rerank' \
  llama-server -hf ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF --alias macrodata-ambient-rerank --reranking --pooling rank --port 8090 -c 4096 -b 8192 -ub 8192

ensure worker 'bun run .*worker\.ts' \
  bun run worker.ts

log "pass complete"
