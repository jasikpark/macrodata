---
"macrodata": patch
---

Conversation search now sees exchanges indexed after its MCP server started. Each server cached `index.json` on first use and never reloaded it, so a session's `search_conversations` missed every exchange indexed later, whether by a PreCompact reindex, `manage_index`, or another session's server. The cache now reloads whenever the file on disk has changed.
