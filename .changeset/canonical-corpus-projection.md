---
"macrodata": patch
---

One canonical projection of the memory corpus, shared by the MiniLM and Qwen indexers.

Both indexers carried their own copy of the journal and entity parsers, so the two
indexes could disagree about what a source is and which units it produces. There is now
a single projection — `projectJournalFile`, `projectEntityFile`, `scanCorpus` — and both
consume it. A source is its path relative to the journal or entities dir, so an entity
nested under a category (`entities/people/team/bob.md`) carries its full
category-relative stem in both `source` and its ids; the old basename-derived ids
collided with an immediate sibling of the same name. Nested entity files are indexed on
a full rebuild now, where only the incremental daemon path saw them before, so the first
shared rebuild re-embeds them once.

A scan now knows whether it is authoritative, and reconciliation depends on it. A file
that cannot be read, a directory that cannot be listed, and a journal line that is not
an object with string `topic` and `content` all mark their source incomplete while
keeping whatever was readable — `"5"`, `null` and `[1,2,3]` parse cleanly and used to
index as `[undefined] undefined`. An incomplete scan never prunes: its missing items
would otherwise read as deletions and delete live vectors for sources that were merely
unreadable. A complete scan is trusted even when it is empty, so a wiped corpus
converges to an empty index instead of retaining every stale vector forever; the one
exception is both roots missing while the index holds vectors, which is a misconfigured
`MACRODATA_ROOT` far more often than a deliberate wipe.

Symlinks are never followed into the corpus. A link named like a corpus file — say
`entities/people/notes.md` pointing at `~/.ssh/id_rsa` — would otherwise have its target
read, embedded, and left retrievable through `search_memory` and ambient recall. The
refusal is enforced where the bytes are read (`projectEntityFile`, reached by the
daemon's live-watch reindex as well as the batch walk) and the walk decides on `lstat`
rather than the dirent type bits, which some filesystems report as unknown. Schedule
files get the same treatment: `followSymlinks: false` on a chokidar watcher governs
chokidar's own traversal and has no effect on `readFileSync`, so the reminders handlers
refuse a symlinked schedule before reading it rather than injecting whatever it resolves
to into the next session's context.

Also: an entity file directly at the entities root has no category to take its type from
and is refused rather than indexed under a type named after the file, and the embedding
input is cut on whole characters, so a note with an astral character at the 2000-char
boundary no longer embeds a lone surrogate.
