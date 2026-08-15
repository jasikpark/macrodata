---
"macrodata": patch
---

Manage the ambient-recall worker from `macrodata-hook.sh`, on both hook events, so a
plugin update takes effect without waiting for a new session. The worker had its own
SessionStart-only supervisor, and SessionStart does not fire on `/plugin update` +
`/reload-plugins` — so the pass that reaps the previous version's worker only ran once
a session happened to open, and until then a freshly installed release kept serving
recall from the old cached code. The daemon already converged on every prompt; the
worker now does too, through the same verified-kill path. Per-prompt passes stay silent
unless they act, so neither the model's context nor the log gets a line per message.

Converging on every prompt also means concurrent sessions can observe the same
worker-less window and spawn into it together, so the worker now claims
`.recall/worker.pid` before it can load a model and stands down if another process
already serves that state root. A claim whose process is gone is taken over rather
than obeyed — the hook stops a stale-version worker with SIGKILL, which never gets to
clean up after itself. A reboot restarts the PID space from the bottom, where a
surviving claim can name an unrelated live process and mute recall for good, so the
hook reads the holder's own command line and clears the claim unless that process is
itself a worker for this root — one predicate, shared with the `ps` classifier, since
a guard that accepts more than the classifier counts hands this root's claim to a
neighbouring root's worker and no later pass can take it back.

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
and a `root` in `config.json` that isn't a string falls
back to the default in both the shell and TypeScript resolvers rather than resolving to
a bogus path in one and throwing in the other.

Behavior change worth knowing: when a hand-started worker is running on a state root,
the hook now reaps the *installed* workers on that root. Every worker drains the same
mailbox, so leaving both up made each request a race between two copies of the code.
The hand-started worker is still never killed.
