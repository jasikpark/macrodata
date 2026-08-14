---
"macrodata": patch
---

Manage the ambient-recall worker from `macrodata-hook.sh`, on both hook events, so a
plugin update takes effect without waiting for a new session. The worker had its own
SessionStart-only supervisor, and SessionStart does not fire on `/plugin update` +
`/reload-plugins` — so the pass that reaps the previous version's worker only ran once
a session happened to open, and until then a freshly installed release kept serving
recall from the old cached code. The daemon already converged on every prompt; the
worker now does too, through the same verified-kill path. Per-prompt passes stay silent
unless they act, so neither the model's context nor the log gets a line per message.
