---
"macrodata": minor
---

Skills can live in the memory store. With the new **Memory skills** option (`skills_enabled`, off by default) on, each `skills/<name>/SKILL.md` in the store is symlinked into `~/.claude/skills/` at session start; `status: archived` in a skill's frontmatter unlinks it. The plugin records which links it made and changes only those, warning instead of overwriting when a name is already taken. `bin/skills-sync.ts adopt <name>` moves a hand-made skill into the store.
