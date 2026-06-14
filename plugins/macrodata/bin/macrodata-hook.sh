#!/bin/bash
#
# Macrodata Local Hook Script
#
# Usage:
#   macrodata-hook.sh session-start  - Launch daemon, signal reload, emit the
#                                       first-run onboarding nudge if unconfigured
#   macrodata-hook.sh prompt-submit  - Ensure daemon is up, inject any pending
#                                       daemon-written context
#
# NOTE: session-start no longer composes the memory context here. Each state
# file is injected by its own compose-state-file.ts hook, journal+schedules by
# compose-lists.ts, USAGE by inject-usage.sh, and the files manifest by
# inject-files.sh — each in its own ~10K hook-output envelope (anthropics/
# claude-code#44086). This script only manages the daemon lifecycle and the
# first-run nudge.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON="$SCRIPT_DIR/macrodata-daemon.ts"

# State root (MACRODATA_ROOT > config.json > default)
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

PIDFILE="$STATE_ROOT/.daemon.pid"
PENDING_CONTEXT="$STATE_ROOT/.pending-context"
PENDING_REMINDERS_DIR="$STATE_ROOT/.pending-reminders"
LOGFILE="$STATE_ROOT/.daemon.log"
IDENTITY="$STATE_ROOT/state/identity.md"

is_daemon_running() {
    if [ -f "$PIDFILE" ]; then
        local pid=$(cat "$PIDFILE")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

start_daemon() {
    if is_daemon_running; then
        return 0
    fi

    local BUN="bun"
    mkdir -p "$STATE_ROOT"
    # Daemon writes its own PID file; we don't write it here.
    MACRODATA_ROOT="$STATE_ROOT" nohup "$BUN" run "$DAEMON" >> "$LOGFILE" 2>&1 &

    # Wait briefly for the daemon to write its PID file (up to 2 seconds).
    local attempts=0
    while [ $attempts -lt 20 ]; do
        sleep 0.1
        if is_daemon_running; then
            return 0
        fi
        attempts=$((attempts + 1))
    done
}

signal_daemon_reload() {
    if [ -f "$PIDFILE" ]; then
        local pid=$(cat "$PIDFILE")
        if kill -0 "$pid" 2>/dev/null; then
            kill -HUP "$pid" 2>/dev/null
        fi
    fi
}

inject_pending_context() {
    if [ -s "$PENDING_CONTEXT" ]; then
        cat "$PENDING_CONTEXT"
        : > "$PENDING_CONTEXT"  # Clear the file
    fi
}

# Drain fired scheduled tasks. The daemon writes one file per firing into
# .pending-reminders/. We claim each by renaming it before reading: rename(2)
# can move a given source only once, so when several sessions drain at the
# same moment exactly one wins each file and the losers' mv fails silently —
# no scheduled run gets grabbed twice. The claimed name carries the session
# id so the daemon log / a curious human can see who took it.
inject_reminders() {
    [ -d "$PENDING_REMINDERS_DIR" ] || return
    # session_id is external input (harness stdin JSON) and lands in a filename
    # below, so strip it to a safe charset before use.
    local session_id
    session_id=$(printf '%s' "${1:-}" | tr -cd 'A-Za-z0-9_-')
    [ -n "$session_id" ] || session_id="unknown"
    local f base claimed
    for f in "$PENDING_REMINDERS_DIR"/*; do
        [ -e "$f" ] || continue            # no matches: glob stays literal
        base=$(basename "$f")
        case "$base" in
            .*|*.claimed.*) continue ;;    # tmp writes and already-claimed leftovers
        esac
        claimed="$f.claimed.$session_id.$$"
        if mv "$f" "$claimed" 2>/dev/null; then
            cat "$claimed"
            rm -f "$claimed"
        fi
    done
}

inject_first_run() {
    # Once identity.md exists, normal state is delivered by the per-file
    # compose-state-file.ts hooks — nothing to emit here.
    [ -f "$IDENTITY" ] && return

    # Detect user info up front to avoid repeated permission prompts during onboarding.
    local USER_INFO
    USER_INFO=$("$SCRIPT_DIR/detect-user.sh" 2>/dev/null || echo '{}')

    # Neutralize macrodata tag-openers in the detected-user JSON: a hostile
    # git/GECOS name (e.g. user.name containing "</macrodata-detected-user>")
    # would otherwise close the wrapper early or forge a sibling block. The
    # deeper fix (proper JSON escaping at the detect-user.sh source) is tracked
    # as a follow-up.
    USER_INFO="${USER_INFO//<\/macrodata/&lt;/macrodata}"
    USER_INFO="${USER_INFO//<macrodata/&lt;macrodata}"

    echo "<macrodata>
<macrodata-first-run state-root=\"$STATE_ROOT\">
Macrodata local memory is not yet configured. Run \`/onboarding\` to set up.
</macrodata-first-run>

<macrodata-detected-user>
$USER_INFO
</macrodata-detected-user>
</macrodata>"
}

case "$1" in
    session-start)
        start_daemon
        signal_daemon_reload
        inject_first_run
        ;;
    prompt-submit)
        start_daemon
        # session_id rides in on the hook's stdin JSON (absent when run by
        # hand). Read stdin once — it can only be consumed once.
        SESSION_ID=""
        if [ ! -t 0 ]; then
            SESSION_ID=$(jq -r '.session_id // empty' 2>/dev/null)
        fi
        inject_pending_context
        inject_reminders "$SESSION_ID"
        ;;
    *)
        echo "Usage: $0 {session-start|prompt-submit}" >&2
        exit 1
        ;;
esac
