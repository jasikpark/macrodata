---
"macrodata": patch
---

Conversation indexing no longer rewrites the whole index once per exchange. Incremental updates commit every 128 exchanges and a full rebuild commits once. This keeps the PreCompact and SessionEnd hooks from holding a session for minutes when a long transcript changes: on an 84 MB index, a pass that took 62.7 s now takes 3.4 s. A pass that dies midway re-indexes only its uncommitted batch next time, instead of every file it had already finished.

The conversation index now uses the same atomic commits as the recall index. An interrupted commit can no longer truncate `index.json`, and a commit refuses to overwrite one that another process committed after this one loaded it, instead of silently reverting that write.

Transcripts are now found under `CLAUDE_CONFIG_DIR/projects` when `CLAUDE_CONFIG_DIR` is set, instead of always under `~/.claude/projects`.
