---
"macrodata": patch
---

Rebalance the `schedule` tool's `delivery` description so `session` and `headless` read as two first-class, intent-based choices (session = a human should see/act on it; headless = it should just run on its own), rather than framing `headless` as a "reserve for trusted background jobs" last resort. Keeps the honest caveats — headless runs unsupervised and no-ops while the machine is asleep (e.g. a laptop on battery) — but as constraints to design around, not reasons to avoid it.
