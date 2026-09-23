---
"macrodata": minor
---

Ambient recall reconciles its index incrementally instead of re-embedding the whole corpus.

`reconcileCorpus` and `reconcileSource` compare each projected item against the indexed one:
items whose content already has a stored vector reuse it (a moved timestamp or category, a
rename, a journal line shifted by an insert above it), only genuinely new content is embedded,
and unchanged items are skipped. A rename reconciled path-by-path reuses the vectors the first
path's deletion just pruned. A pass with nothing to do leaves `index.json` untouched, and an
interrupted pass resumes where it stopped.

Deletion follows the projection's authority. An id the scan no longer produces is pruned unless
its source lies under something the scan failed on — a root or directory that failed to list, an
entry that could not be stat'd, or an unreadable, malformed, or symlinked source — or under a
missing journal or entities root. A file with a size but no allocated blocks (evicted by iCloud
or another sync provider) or one rewritten during the read counts as unread, not empty. An
unparsable final journal line with no trailing newline (an append in flight, or a truncated
rewrite) is not a malformed record, and the vectors indexed at or past it are kept.
`reconcileSource` treats a path that is gone (ENOENT under a root that still exists) as a
confirmed deletion of its source, or of every source under it when it was a directory. A path
the scan would not index — a symlink at any depth, a spelling that differs from the on-disk
name, a dot path, a wrong extension — changes nothing.

Index writes are batched and atomic: each commit writes a temp file and renames it over
`index.json`, so an interrupt mid-commit can no longer leave a truncated index that every later
run fails to parse. A commit refuses to overwrite an `index.json` that another process committed
after this one loaded it, instead of silently reverting that write. Leftover temp files from a
killed run are swept on load. An update's changes stay invisible to searches until it commits,
and replacing a vector recomputes its norm. Writers in one process are serialized.

`bin/recall-reindex.ts` now reconciles by default; `--full` re-embeds everything (for an
embedding-model change) and `--prune-only` deletes only what the current corpus proves is gone. An unparsable `index.json`
makes every mode fail with a message naming `--full`, which moves it aside and rebuilds.
Unknown or conflicting flags exit with a usage message.
