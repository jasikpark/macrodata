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

# The PID recorded in the pidfile (nonzero exit if none / empty).
read_daemon_pid() {
    [ -f "$PIDFILE" ] || return 1
    local pid; pid=$(cat "$PIDFILE")
    [ -n "$pid" ] || return 1
    printf '%s' "$pid"
}

# argv of a SPECIFIC pid (empty + nonzero if it isn't alive). The PID file is
# version-agnostic (keyed to the state root), but $DAEMON is version-specific
# (its cache path contains the version), so the argv tells us which version is
# running. Callers pin the PID once via read_daemon_pid and pass it here, so the
# argv we classify and the PID we later signal/kill are the SAME process — never
# two reads of a mutable pidfile.
daemon_argv() {
    local pid=$1
    { [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; } || return 1
    ps -p "$pid" -o command= 2>/dev/null
}

start_daemon() {
    # Pin the PID once, then classify AND act on that same process — re-reading
    # the pidfile between the argv check and the kill could target a different
    # (recycled / just-respawned) process.
    local pid="" cmd=""
    pid=$(read_daemon_pid) || pid=""
    if [ -n "$pid" ]; then
        cmd=$(daemon_argv "$pid") || cmd=""
    fi
    if [ -n "$cmd" ]; then
        case "$cmd" in
            *"$DAEMON"*)
                # Current version already running — nothing to do.
                return 0
                ;;
            */plugins/cache/*macrodata-daemon.ts*)
                # A plugin-cache daemon from a DIFFERENT version: stale after an
                # upgrade (it keeps running the old cached code). Stop it so we
                # respawn from the new version path. (GH #12.)
                kill "$pid" 2>/dev/null
                local n=0
                while [ $n -lt 20 ] && kill -0 "$pid" 2>/dev/null; do
                    sleep 0.1; n=$((n + 1))
                done
                # Escalate if it ignored SIGTERM. Without this we'd fall through
                # and spawn a fresh daemon that immediately self-exits ("already
                # running", since the stale PID is still live) — silently leaving
                # the OLD code running, i.e. regressing GH #12.
                if kill -0 "$pid" 2>/dev/null; then
                    kill -9 "$pid" 2>/dev/null
                    n=0
                    while [ $n -lt 20 ] && kill -0 "$pid" 2>/dev/null; do
                        sleep 0.1; n=$((n + 1))
                    done
                fi
                # SIGKILL skips the daemon's own pidfile cleanup, so clear it
                # here — the fresh daemon must never read a stale entry.
                rm -f "$PIDFILE"
                ;;
            *)
                # Daemon running from outside the plugin cache (a hand-started
                # dev checkout). Assume it's intentional — leave it, don't spawn
                # a competitor. Restart it yourself if you're iterating on it.
                return 0
                ;;
        esac
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
    # Didn't report a PID in time — a cold `bun` start can exceed 2s. Leave a
    # breadcrumb instead of failing silently.
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start_daemon: daemon did not report a PID within 2s" >> "$LOGFILE"
}

signal_daemon_reload() {
    # Guard against PID reuse: a stale pidfile can name a recycled PID now owned
    # by an unrelated process, and many programs treat SIGHUP as "terminate".
    # Pin the PID once and HUP that exact validated process — only if its argv
    # says it's a macrodata daemon.
    local pid cmd
    pid=$(read_daemon_pid) || return 0
    cmd=$(daemon_argv "$pid") || return 0
    case "$cmd" in
        *macrodata-daemon.ts*) kill -HUP "$pid" 2>/dev/null ;;
    esac
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
