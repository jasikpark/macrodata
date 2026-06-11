---
name: remember
description: Save a conversation summary and spawn a background reflection worker to distill the session into journal observations. Use when the user invokes /remember, asks to save/remember the conversation, or when a PreCompact/SessionEnd hook directs you here.
---

# Part 1 — conversation summary

Call `mcp__plugin_macrodata_macrodata__save_conversation_summary` with whatever fields are relevant. You were here — use your judgment.

# Part 2 — reflection worker (background)

After the summary is saved, spawn ONE background subagent to distill the session transcript into journal observations. This runs on subscription billing and must not block your turn — spawn it and move on.

Setup (you, not the worker): determine this session's transcript path — the `*.jsonl` for the current session under `~/.claude/projects/<encoded-cwd>/`. If you cannot identify it confidently (e.g. headless context), skip Part 2 and say so.

Spawn via the Agent tool with `run_in_background: true` and `model: "sonnet"` (always pin the model — never let the worker inherit the session default). Task, with PATH and SESSION_ID filled in:

```
You are a one-shot memory reflection worker for Claude Code session SESSION_ID.
Transcript: PATH
Ledger: ~/Documents/macrodata/.reflection-ledger.json

1. Read the ledger (create the file as {} if missing). Your start offset =
   ledger["SESSION_ID"].reflected_through_byte, or 0 if absent. End offset =
   the transcript's current byte size. If start >= end, update nothing, report
   "no new content", and exit.
2. Read ONLY bytes start..end in one pass (e.g. `tail -c +START_PLUS_1 PATH | head -c N`).
   If the delta exceeds ~400KB, process only the final 400KB and record the
   skipped byte range in your report. One pass — no polling, no waiting, no loops.
3. Distill durable observations: decisions and why, root causes, gotchas,
   corrections or preferences the user states, concrete outcomes (PRs, commits,
   releases, test results). Ignore tool noise, code dumps, and pleasantries.
   0–8 observations; zero is a valid answer.
4. Log each observation with the macrodata MCP tool `log_journal` (load it via
   ToolSearch if needed): topic = a fitting existing journal topic if you know
   one, else a sensible kebab-case topic; content = one or two self-contained
   sentences with concrete identifiers (PR numbers, file names, task ids);
   source = "reflection". If the MCP tool is unavailable, append lines to
   ~/Documents/macrodata/.reflection-fallback.jsonl as
   {"timestamp": ISO, "topic": ..., "content": ...} and flag this in your report.
5. Update the ledger entry for SESSION_ID: reflected_through_byte = end offset,
   last_run = now (ISO), runs += 1. Preserve other sessions' entries.
6. Hard limits: do NOT write under state/ or entities/, do NOT touch
   .pending-context, do NOT edit any other file. Your only writes are journal
   entries (or the fallback file) and the ledger.
7. Final message: observation count, byte range processed, topics used, and
   anything skipped.
```

Skip Part 2 entirely if the ledger shows a run for this session within the last 10 minutes (debounce — compaction and /remember can fire close together).
