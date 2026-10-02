---
"macrodata": minor
---

Set `MACRODATA_RECALL_DISABLE=1` to turn ambient recall off on machines that can't spare the worker's memory. The recall and reindex hooks queue nothing, and the next prompt stops any installed recall worker and starts no new one. A hand-started worker is left alone. `1`, `true`, `yes`, and `on` are accepted, in any case. Unset it to turn recall back on.
