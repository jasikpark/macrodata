---
"macrodata": patch
---

Fix `mmrSelect` and `finalizeHits` edge cases: degrade empty `[]` vectors to Jaccard similarity, preserve `w`-descending order on small slates (`slate.length <= k`), and return `[]` for non-positive or `NaN` `k` / `limit`.
