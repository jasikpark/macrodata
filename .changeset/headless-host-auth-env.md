---
"macrodata": patch
---

fix(daemon): headless runs no longer die "Not logged in" while the user is logged in

The daemon is usually started by a SessionStart hook inside a Claude desktop-app session and spawned its headless `claude --print` children with its own environment. Those children inherited `CLAUDE_CODE_ENTRYPOINT=claude-desktop` and `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1`, which makes Claude Code defer OAuth token refresh to a host session over the control channel — a host a detached child does not have. The runs worked only while an interactive session kept the keychain token fresh; once the machine was left alone long enough for it to expire, every tick exited 1 with `Not logged in · Please run /login` until a session was opened again. `spawnHeadless` now strips the host-session variables (`headlessSpawnEnv`), so a headless child refreshes its own token exactly like `claude -p` typed in a terminal.
