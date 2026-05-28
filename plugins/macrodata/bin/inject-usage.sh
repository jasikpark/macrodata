#!/bin/bash
#
# SessionStart hook: inject the macrodata usage guide (USAGE.md) in full.
#
# USAGE.md is the fundamental "how to use macrodata" guide. In the monolithic
# SessionStart blob it sits near the end and gets lost whenever that blob
# overflows Claude Code's 10,000-char hook-output cap (anthropics/claude-code
# #44086 — overflow is silently replaced with a 2,000-char preview).
#
# Registering it as its OWN SessionStart hook (with no matcher, so it fires on
# startup / resume / clear / compact) puts it in a separate ~10K hook-output
# envelope, so it is reliably seen regardless of how large the state composer's
# output is. USAGE.md is ~4.7K — well within a single envelope.
#
# Re-firing on the `compact` source is also what keeps the guide present after
# compaction: hook output is not auto-re-injected post-compact the way a
# project-root CLAUDE.md is — it only persists because the hook runs again.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
USAGE_FILE="$SCRIPT_DIR/../USAGE.md"

[ -f "$USAGE_FILE" ] || exit 0

printf '<macrodata-usage>\n'
cat "$USAGE_FILE"
printf '\n</macrodata-usage>\n'
