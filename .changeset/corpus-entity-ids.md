---
"macrodata": patch
---

Use injective `entity:<source>:preamble` / `entity:<source>:<i>` IDs in `projectEntityFile` so entity items cannot collide across hyphenated category/file names (`people-archive/alice.md` vs `people/archive-alice.md`) or against `journal-` IDs (`entities/journal/…`).
