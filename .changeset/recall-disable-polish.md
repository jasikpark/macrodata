---
"macrodata": patch
---

With `MACRODATA_RECALL_DISABLE` set, the recall hook now exits before loading its search pipeline: a fire costs about 15 MB and 10 ms instead of about 120 MB and 300 ms, on every prompt, `Read`, web search or fetch, and `Stop`.

When one session has the switch set and another doesn't, the two would restart and stop the worker on every prompt without saying so. The session with recall on now announces it each time it restarts a worker that a disabled session stopped.

Values with whitespace inside them, such as `t rue`, now leave recall on everywhere; before, the worker supervisor read them as off while the hooks read them as on.
