---
"macrodata": patch
---

The distill skill's per-transcript sub-agents now run on `sonnet` explicitly. An
unpinned `Task` spawn inherits the parent run's model, so a memory-maintenance schedule
on `opus` put every extraction worker on `opus` too. Extraction over an already-filtered
transcript does not need it; the parent's state-file rewrite pass is where the heavier
model earns its keep.
