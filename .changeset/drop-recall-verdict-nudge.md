---
"macrodata": minor
---

Ambient recall no longer asks the agent to grade its hits. About a quarter of recall injections used to carry a request to journal a usefulness verdict under `ambient-memory-calibration`; those verdicts piled up in the journal and resurfaced through recall. The request and its `MACRODATA_RECALL_VERDICT_RATE` setting are gone. Recall injection and the per-fire `calibration.jsonl` log are unchanged.
