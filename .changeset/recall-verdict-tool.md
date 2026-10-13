---
"macrodata": minor
---

Add `record_recall_verdict`, which grades ambient-recall hits as structured rows in `.recall/verdicts.jsonl` instead of journal entries, so verdicts no longer get recalled in place of the memories they grade. Each recall row now shows a `key` to grade by, and the sampled grading prompt points at the new tool. Verdicts also write `referenced` / `rejected` access events, which leave ranking unchanged unless `MACRODATA_RECALL_REFRESH_KINDS` opts in.
