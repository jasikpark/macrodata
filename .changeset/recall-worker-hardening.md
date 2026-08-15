---
"macrodata": patch
---

Recall worker hardening, following the hook-managed worker that shipped in 0.9.0.

The pidfile-claim guard now asks the same question as the `ps` classifier: is this
process a worker *for this state root*? It used to accept any process carrying the
worker sentinel, so a claim held by a neighbouring root's worker — reachable through
pid recycling after a reboot — survived every pass: the guard saw a worker and left
the claim, the classifier saw none for this root and spawned one, and the fresh
worker found the claim held by something alive and stood down. Recall stayed dead in
a state no later pass could undo. One shared predicate now, so there is no second
copy to drift.

A pipeline that never settles is now survivable. It used to be worse than a crash: the
worker stayed in `ps` holding the claim, read as healthy, and made every replacement
stand down while dropping every request. The pipeline now runs under a deadline and the
worker exits when it misses one, so the next pass can start a worker that serves —
20 minutes for a first run that may download models, 2 minutes once one has completed
(`MACRODATA_RECALL_WEDGE_COLD_MS`, `MACRODATA_RECALL_WEDGE_WARM_MS`). A spawn that dies
during startup is no longer silent either: two consecutive spawns that leave no worker
now say startup is failing instead of logging another clean first start. That count is
deliberately not a time window — a window between attempts measures how fast you type,
and at any real prompt cadence every gap exceeds it.

Also: mailbox files left by sessions that have ended are swept hourly past a 7-day TTL
(only `request-` files were ever consumed, so the directory grew for the life of the
state root and the worker's 5s sweep read all of it), a request file the worker cannot
parse is quarantined instead of left to be found again by every one of those sweeps for
the life of the process, the recall logs are trimmed to their last 2000 lines past 1MB,
and a `root` in `config.json` that isn't a string falls back to the default in both the
shell and TypeScript resolvers rather than resolving to a bogus path in one and throwing
in the other.

Behavior change worth knowing: when a hand-started worker is running on a state root,
the hook now reaps the *installed* workers on that root. Every worker drains the same
mailbox, so leaving both up made each request a race between two copies of the code.
The hand-started worker is still never killed.
