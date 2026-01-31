#!/bin/bash
#
# Macrodata Local Hook Script
#
# Usage:
#   macrodata-hook.sh session-start  - Launch daemon if not running, inject context
#   macrodata-hook.sh prompt-submit  - Check daemon, inject pending context
#

# Get the directory where this script lives
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON="$SCRIPT_DIR/macrodata-daemon.ts"

# State directory (configurable via MACRODATA_ROOT, defaults to ~/.config/macrodata)
STATE_ROOT="${MACRODATA_ROOT:-$HOME/.config/macrodata}"

# Output locations
PIDFILE="$STATE_ROOT/.daemon.pid"
PENDING_CONTEXT="$STATE_ROOT/.pending-context"
LOGFILE="$STATE_ROOT/.daemon.log"

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
    if ! is_daemon_running; then
        # Use Claude Code's bundled Bun if available, otherwise fall back to global
        local BUN="${CLAUDE_CODE_BUN_PATH:-bun}"
        # Ensure state directory exists
        mkdir -p "$STATE_ROOT"
        # Start daemon in background, redirect output to log
        MACRODATA_ROOT="$STATE_ROOT" nohup "$BUN" run "$DAEMON" >> "$LOGFILE" 2>&1 &
        echo $! > "$PIDFILE"
    fi
}

inject_pending_context() {
    if [ -s "$PENDING_CONTEXT" ]; then
        cat "$PENDING_CONTEXT"
        : > "$PENDING_CONTEXT"  # Clear the file
    fi
}

inject_static_context() {
    # For local plugin, we inject identity + state files directly
    local IDENTITY="$STATE_ROOT/identity.md"
    local INBOX="$STATE_ROOT/state/inbox.md"
    local TODAY="$STATE_ROOT/state/today.md"
    local COMMITMENTS="$STATE_ROOT/state/commitments.md"

    # Check if this is first run (no identity file)
    if [ ! -f "$IDENTITY" ]; then
        echo "<macrodata-local>"
        echo "## First Run"
        echo ""
        echo "Macrodata local memory is not yet configured. Run \`get_context\` to set up your memory."
        echo ""
        echo "State directory: $STATE_ROOT"
        echo "</macrodata-local>"
        return
    fi

    echo "<macrodata-local>"
    echo "## Identity"
    echo ""
    cat "$IDENTITY" 2>/dev/null || echo "_No identity configured_"
    echo ""
    echo "## State"
    echo ""
    echo "### Inbox"
    cat "$INBOX" 2>/dev/null || echo "_Empty_"
    echo ""
    echo "### Today"
    cat "$TODAY" 2>/dev/null || echo "_Empty_"
    echo ""
    echo "### Commitments"
    cat "$COMMITMENTS" 2>/dev/null || echo "_Empty_"
    echo ""
    echo "## Paths"
    echo ""
    echo "- Root: \`$STATE_ROOT\`"
    echo "- State: \`$STATE_ROOT/state\`"
    echo "- Entities: \`$STATE_ROOT/entities\`"
    echo "- Journal: \`$STATE_ROOT/journal\`"
    echo "</macrodata-local>"
}

case "$1" in
    session-start)
        start_daemon
        inject_static_context
        ;;
    prompt-submit)
        # Restart daemon if dead
        start_daemon
        # Inject any pending context
        inject_pending_context
        ;;
    *)
        echo "Usage: $0 {session-start|prompt-submit}" >&2
        exit 1
        ;;
esac
