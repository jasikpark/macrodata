---
"macrodata": minor
---

Ambient recall can land in the turn that asked for it. An async waiter on Read/WebSearch/WebFetch polls for the worker's result and hands it to Claude Code as soon as it is served, so it reaches the model after the next tool step instead of on the next prompt; a result that misses the turn arrives at the start of the next one, as before. `MACRODATA_RECALL_WAITER_WAIT_MS` (default 12000) bounds the wait.
