---
"macrodata": minor
---

Keep the conversation index current during a session. Stop, PreCompact and SessionEnd now queue a checkpoint for the session, and the daemon indexes that session's transcript: right away for PreCompact and SessionEnd, and 4 minutes after the last Stop for a Stop. Before, only PreCompact reindexed, and it held compaction for the whole pass while it ran. The SessionEnd and PreCompact prompt hooks are gone as well; Claude Code refuses prompt hooks outside the REPL ("Prompt stop hooks are not yet supported outside REPL"), so they never saved a summary.
