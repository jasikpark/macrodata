---
"@macrodata/opencode": patch
---

Fix daemon file watcher and conversation indexing

- Fix reminders watcher not detecting new files (watch directory instead of glob pattern)
- Index both Claude Code and OpenCode conversations on daemon startup
