---
"macrodata": patch
---

Ambient recall no longer indexes `ambient-memory-calibration` journal lines. Those verdicts quote the hits they grade, so they were surfacing as recall hits themselves and outranking the entries they describe. The next reindex prunes any already in the index. `search_memory` still finds them.
