---
"macrodata": patch
---

Remove the unused `@tobilu/qmd` runtime dependency. Macrodata does not import the
QMD SDK; it remains prior art for future index work rather than install-time code.
