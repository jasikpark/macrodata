---
"@macrodata/opencode": patch
---

Keep the Mac awake while a headless scheduled run is in progress. On macOS the daemon now holds a `caffeinate -is` assertion for the lifetime of each `claude --print` child, so a run that fires with the lid closed on AC no longer crawls through brief maintenance wakes. It has no effect on battery with the lid closed, where macOS forces sleep regardless.
