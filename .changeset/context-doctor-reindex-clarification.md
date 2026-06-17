---
"@macrodata/opencode": patch
---

context-doctor: clarify that the daemon auto-reindexes entity add/change incrementally (`indexEntityFile`, ~1s debounce), so a manual `manage_index` rebuild is only needed after **deletes or renames** — and for those the fix is `rm -rf <root>/.index` + rebuild, since rebuild is upsert-only and won't purge orphaned records. (#20)
