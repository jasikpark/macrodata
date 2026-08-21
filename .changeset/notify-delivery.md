---
"macrodata": minor
---

Replace session/subagent reminder delivery with a deterministic `notify` mode.

- `schedule` now offers two delivery modes: `notify` (default) and `headless`. The `session` mode — claim files drained into active sessions as background subagents — is removed; stored schedules with `delivery: "session"` fire as `notify` automatically.
- `notify` runs no model: at fire time the daemon posts a macOS notification and upserts a `- [id] fired <time> — <payload>` line into `state/reminders.md` (a re-fire replaces the schedule's own line). Reminders surface in sessions via the SessionStart compose hook and a prompt-submit relay nudge; removing the line with the Edit tool clears the reminder.
- `headless` is unchanged: a detached `claude --print` on the tick.
