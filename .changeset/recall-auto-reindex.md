---
"macrodata": minor
---

Ambient recall now keeps its index current on its own. The recall worker reconciles the corpus at startup (which is also the first-run build), and a new hook queues a reindex at SessionStart and after any Write/Edit under `entities/` or `journal/` or any macrodata journal tool call. The hook only drops a request into the worker's mailbox, so it never loads a model, and the one long-lived worker serializes every index write. SessionStart prints a one-line notice while no index exists yet.
