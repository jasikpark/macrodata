---
"macrodata": minor
---

Keep the conversation index current during a session. Stop, PreCompact and SessionEnd now queue a session checkpoint that the daemon acts on, refreshing the conversation index incrementally. This replaces the SessionEnd and PreCompact prompt hooks, which Claude Code refuses outside the REPL ("Prompt stop hooks are not yet supported outside REPL"), so they never saved a summary.
