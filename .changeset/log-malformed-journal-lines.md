---
"macrodata": patch
---

Log malformed lines in journal and conversation parsing instead of silently skipping them. The journal indexer (`parseJournalForIndexing`) and the conversation parser (`parseConversationFile`, `expandConversation`) now count unparseable lines and `console.warn`, so corrupted or multi-line entries that drop out of search are diagnosable instead of vanishing silently. Unreadable journal files warn too.
