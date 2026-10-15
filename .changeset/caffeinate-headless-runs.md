---
"macrodata": patch
---

Keep the Mac awake while a headless scheduled run is in progress. On macOS the daemon now holds a `caffeinate -is` assertion until the `claude --print` child exits, capped at 4 hours, so a run that fires with the lid closed on AC no longer crawls through brief maintenance wakes. On battery it blocks idle sleep while the run is alive; with the lid closed on battery macOS sleeps regardless.
