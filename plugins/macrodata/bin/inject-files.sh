#!/bin/bash
#
# SessionStart hook: inject the macrodata files manifest in its own
# ~10K hook-output envelope, separate from the dynamic-state composer.
#
# The manifest is a "filetree-as-index" of state + entity files, each with its
# authored frontmatter description (or a bare path + a footer nudge when one is
# missing). Delegates to compose-files.ts — see that file for the format and
# rationale. No matcher, so it fires on startup/resume/clear/compact; re-firing
# on compact keeps the manifest present after compaction.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Resolve the state root the same way macrodata-hook.sh does.
DEFAULT_ROOT="$HOME/.config/macrodata"
CONFIG_FILE="$DEFAULT_ROOT/config.json"
if [ -n "$MACRODATA_ROOT" ]; then
    STATE_ROOT="$MACRODATA_ROOT"
elif [ -f "$CONFIG_FILE" ]; then
    STATE_ROOT=$(jq -r '.root // empty' "$CONFIG_FILE" 2>/dev/null)
    STATE_ROOT="${STATE_ROOT:-$DEFAULT_ROOT}"
else
    STATE_ROOT="$DEFAULT_ROOT"
fi

MACRODATA_ROOT="$STATE_ROOT" bun run "$SCRIPT_DIR/compose-files.ts" "$STATE_ROOT"
