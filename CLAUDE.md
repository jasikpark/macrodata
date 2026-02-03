# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Structure

```
macrodata/
└── plugins/
    └── local/                  # Local file-based memory plugin
        ├── .claude-plugin/     # Plugin metadata
        ├── bin/                # Daemon and hook scripts
        ├── skills/             # Plugin skills (e.g., onboarding)
        ├── opencode/           # OpenCode plugin variant
        └── src/                # MCP server source
            ├── index.ts        # MCP server with tool definitions
            ├── indexer.ts      # Vectra indexing logic
            └── embeddings.ts   # Transformers.js embeddings
```

## Build and Development Commands

```bash
# From plugins/macrodata/
bun install
bun run start       # Run MCP server
```

## Publishing Setup

### GitHub Secrets

Set up required secrets using 1Password CLI and GitHub CLI:

```bash
# Set GitHub App secrets from "Mixiebot GitHub" 1Password entry
op item get "Mixiebot GitHub" --account my.1password.com --fields "app id" --format json | jq -r '.value' | gh secret set APP_ID
op item get "Mixiebot GitHub" --account my.1password.com --fields "private key" --format json | jq -r '.value' | gh secret set APP_PRIVATE_KEY
```

### npm Trusted Publishing

Configure trusted publishing on npmjs.com for `@macrodata/opencode`:

1. Publish a 0.0.0 version locally (one-time): `cd plugins/macrodata && npm publish --access public`
2. Navigate to the package page on npmjs.com
3. Click "Settings" → follow GitHub authentication flow
4. Enter repository name and `release.yml` as the workflow name

### Repository Settings

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# Configure repository settings
gh api repos/$REPO --method PATCH \
  -f allow_squash_merge=true \
  -f allow_merge_commit=false \
  -f allow_rebase_merge=false \
  -f delete_branch_on_merge=true \
  -f allow_auto_merge=true \
  -f allow_update_branch=true \
  -f squash_merge_commit_message=COMMIT_MESSAGES \
  -f squash_merge_commit_title=COMMIT_OR_PR_TITLE \
  -f has_wiki=false

# Create branch protection ruleset
gh api repos/$REPO/rulesets --method POST --input - <<'EOF'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["~DEFAULT_BRANCH"],
      "exclude": []
    }
  },
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"},
    {"type": "required_linear_history"},
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["merge", "squash", "rebase"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": true,
        "required_status_checks": [
          {"context": "test"},
          {"context": "Validate PR title"}
        ]
      }
    }
  ],
  "bypass_actors": [
    {"actor_type": "RepositoryRole", "actor_id": 5, "bypass_mode": "always"}
  ]
}
EOF
```

## Architecture

Macrodata provides persistent memory for AI coding agents. File-based, fully offline.

**Source** (`plugins/macrodata/`):
- `src/index.ts` - MCP server with 11 tools (log_journal, search_memory, etc.)
- `src/indexer.ts` - Vectra-based vector index for semantic search
- `src/embeddings.ts` - Transformers.js embedding generation (BGE model)
- `bin/macrodata-daemon.ts` - Background daemon for scheduled reminders

**Storage** (default `~/.config/macrodata/`):
- `identity.md` - Agent persona
- `state/` - Current state (human.md, today.md, workspace.md)
- `entities/` - People, projects as markdown files
- `journal/` - JSONL entries, date-partitioned
- `.index/` - Vectra embeddings cache
