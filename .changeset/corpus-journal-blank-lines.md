---
"macrodata": patch
---

Ignore whitespace-only and CRLF (`\r\n`) blank lines in `projectJournalFile` so valid journals are not marked `incomplete`, and keep trailing whitespace after a newline from disguising a malformed line as an append in flight.
