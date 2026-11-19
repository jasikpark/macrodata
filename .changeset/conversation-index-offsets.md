---
"macrodata": patch
---

Conversation indexing reads only what each transcript gained since the last pass. It used to re-read and re-embed a changed transcript from the start, so every reindex of a long session re-embedded all of it. A prompt still waiting for its reply, or a line still being written, is picked up on a later pass. `conversations-state.json` is now replaced atomically, so a crash mid-write no longer leaves it unparsable, which would have forced every transcript to be re-embedded.
