---
name: context-doctor
description: Diagnose and repair degradation in your always-in-context memory — state-file bloat, stale or overlapping entity descriptions, broken discovery paths, redundancy. Use when context feels noisy, a state file is over its display cap, or the user asks you to clean up / tune your memory. On-demand repair, distinct from scheduled memory-maintenance.
---

# Context Doctor

Your memory is what makes you *you* across sessions. It has three layers:

- **State files** (`state/*.md`) — injected into context every session. This is
  your "system prompt": the highest-value token space.
- **Entities** (`entities/**/*.md`) — listed in the session manifest by path +
  `description:`, loaded on demand. Your progressive memory.
- **Journal** — append-only, retrieved only by search.

Over time this degrades: state files bloat, descriptions go stale, entities
overlap, and detail that was doing real work gets compressed away. This skill
diagnoses the damage and repairs it collaboratively. Unlike the scheduled
`/memory-maintenance` (end-of-day distill + update), run this **on demand** when
something feels off.

**Edits are conservative.** State files define who you are and what you know
about the user. Make the *smallest* change that resolves the issue. A file that
feels "a bit long" is almost always better than one trimmed too hard.

## Why detail is load-bearing (read before cutting anything)

In-context detail does four things; byte-counting only sees the first:

1. **Information** — the literal facts
2. **Attention anchoring** — makes topics feel important while you reason
3. **Semantic priming** — raises your prior on project-specific patterns
4. **Reasoning templates** — past examples become heuristics; "why" prose
   becomes scaffolding for new problems

Compression preserves (1) and destroys (2), (3), (4). A trimmed state file can
make you measurably worse at project-specific reasoning even though every fact
"still exists" in an entity.

**`[[wikilinks]]` are NOT equivalent to in-context presence.** A link is latent
until you actively fetch it — and you only fetch when you already know you don't
know. The cue that tells you *when* to go look lives in the state file itself.
So: move detail out only when the state file keeps the priming cue that points
to it.

## Resolve the store root first

```bash
ROOT="${MACRODATA_ROOT:-$HOME/.config/macrodata}"
CFG="$HOME/.config/macrodata/config.json"
[ -z "$MACRODATA_ROOT" ] && [ -f "$CFG" ] && ROOT="$(jq -r '.root // empty' "$CFG" 2>/dev/null || true)"
ROOT="${ROOT:-$HOME/.config/macrodata}"
echo "$ROOT"
```

## Diagnosis

### 1. State-file bloat

State files are injected in full and display-capped (head-kept on overflow — the
SessionStart truncation warning is the forcing function). Measure each:

```bash
for f in "$ROOT"/state/*.md; do printf '%6s chars %4s lines  %s\n' \
  "$(wc -m < "$f")" "$(wc -l < "$f")" "$(basename "$f")"; done
# Per-file caps hide the aggregate. Total injected chars / ~4 ≈ the tokens of
# always-on state you pay every turn — the only view of total context share.
cat "$ROOT"/state/*.md | wc -m | awk '{printf "  ≈%d tokens always-on state\n", $1/4}'
```

Intervene **only** if a file is meaningfully over its cap. If it is:

- Cut **redundancy and stale sections** first — completed work, resolved
  threads, duplicated facts.
- Cut **evenly** across topics. If a file was 50% about one project, the
  trimmed version still should be — don't gut one section to save another.
- Prefer **moving a whole sub-topic out to an entity** (leaving a one-line cue +
  `[[link]]`) over summarizing detailed rationale into a lossy blurb.
- **Stop at the cap.** Never trim below it "for headroom."

### 2. Entity description quality

Every entity needs `description:` frontmatter stating its **purpose/category**
("REST service — auth, billing, webhooks"), NOT its current status ("billing
work in progress" goes stale). The manifest footer nudges for missing ones.

```bash
# Entities missing a description
grep -rL '^description:' "$ROOT"/entities --include='*.md'
```

Check that descriptions are **unique and non-overlapping**, and that each file's
contents actually match its description. Delegate spot-checks to subagents for
large stores.

### 3. Redundancy and overlap

Look for two entities covering the same subject, or the same fact restated in
three files. Consolidate into one canonical file; reference it from the others
with `[[link]]` rather than duplicating.

### 4. Discovery paths

Every entity is listed in the SessionStart manifest with its `description:`, so
an unlinked entity is **not** invisible — the manifest is a flat discovery path,
and semantic search is another. So don't chase "orphans" (entities with no
`[[wikilink]]`); that's low-signal here. What actually breaks discovery:

- **A weak `description:`** — the only thing the manifest shows. Covered in §2.
- **Not in the semantic index** — `search_memory` only finds indexed entities.
  Confirm coverage rather than assuming it:
  ```bash
  manage_index(target="memory", action="stats")   # entity count vs. files on disk
  ```
  If the indexed count is well below `find "$ROOT"/entities -name '*.md' | wc -l`,
  some entity types aren't being indexed — a store/indexer bug, not something
  the doctor edits away.

`[[wikilinks]]` still matter for the in-context layer — they're the priming cue
that tells you to go fetch related detail (see the load-bearing argument above).
Add them between *related* state/entity files; don't manufacture links just to
clear an orphan list.

### 5. Stale content

Resolved threads listed as open, completed work listed as active, temp notes
that outlived their purpose, time-bound items now in the past.

## Repair

1. Write down the issues you found and the smallest fix for each.
2. Apply fixes with `Edit` (state/entities) — favor the smallest change.
3. **Preserve persona and user identity.** When editing `identity.md` or
   `human.md`, change *structure*, never the meaning of who you are or stated
   user preferences.
4. Verify, against your own diagnosis: did you lose any specific gotcha, command
   pattern, or rationale during cleanup? If so, put it back (in an entity if it
   doesn't belong in state).
5. Re-index after edits: `manage_index(target="memory", action="rebuild")`.
   Note this is upsert-only — it re-scans and updates, but does NOT purge
   records for files you *deleted* or *renamed* (incl. moving an entity between
   category folders). To clear those orphans you must delete the index dir
   (`rm -rf <root>/.index`) and rebuild.

## Finish

```
log_journal(topic="context-doctor", content="[files measured, what was trimmed/consolidated/relinked, what you deliberately kept and why]")
```

If run interactively, tell the user what you changed. Ask about how they want
*you* to behave or what you should know — not about your internal file
structure; that's yours to tend.
