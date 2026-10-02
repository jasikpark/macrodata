---
"macrodata": minor
---

Ambient recall can be turned off with the plugin's new **Ambient recall** option (`recall_enabled`), in `/config` or `/plugin configure`. It is stored once in your user settings, so every session agrees, and the hooks read it live: open sessions stop the worker on their next prompt without restarting. `MACRODATA_RECALL_DISABLE` remains as a per-session override.

With recall off, the recall hook exits before loading its search pipeline: a fire costs about 15 MB and 10 ms instead of about 120 MB and 300 ms, on every prompt, `Read`, web search or fetch, and `Stop`.

`MACRODATA_RECALL_DISABLE` values that only one side read as set now read the same everywhere. Before, the worker supervisor and the hooks could disagree on values with whitespace inside them (`t rue`) or a leading newline.
