# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Structure

```
macrodata/
├── plugins/                    # Claude Code plugins
│   └── cloud/                  # Plugin for cloud macrodata
│       ├── .claude-plugin/     # Plugin metadata
│       ├── bin/                # Daemon and hook scripts
│       └── hooks/              # Plugin hooks config
├── workers/                    # Cloudflare Workers
│   └── macrodata/              # Main memory MCP worker
│       ├── src/                # Worker source code
│       ├── test/               # Worker tests
│       ├── wrangler.jsonc      # Wrangler config
│       └── macrodata.config.ts # User-editable config
├── package.json                # Root package.json
└── marketplace.json            # Plugin marketplace config
```

## Build and Development Commands

```bash
pnpm dev            # Start local dev server with wrangler
pnpm deploy         # Deploy to Cloudflare Workers
pnpm types          # Regenerate worker-configuration.d.ts
pnpm check          # Type check with tsc
pnpm lint           # Run oxlint
pnpm lint:fix       # Run oxlint with auto-fix
pnpm format         # Format with oxfmt
pnpm test           # Run tests
```

## Architecture

Macrodata is memory infrastructure for AI coding agents.

### Workers

**macrodata** (`workers/macrodata/`) - Cloud memory MCP server on Cloudflare Workers.

- `src/index.ts` - Hono app with OAuth provider
- `src/mcp-agent.ts` - Durable Object implementing MCP tools
- `src/models.ts` - AI SDK provider setup
- `src/config.ts` - Type definitions and `defineConfig` helper
- `macrodata.config.ts` - User-editable config for models, embedding, OAuth

**Key bindings** (in wrangler.jsonc):

- `AI` - Workers AI for embeddings and local models
- `VECTORIZE` - Vector index for semantic search
- `MCP_OBJECT` - Durable Object for per-user state
- `OAUTH_KV` - KV namespace for OAuth tokens

### Plugins

**cloud** (`plugins/cloud/`) - Plugin that connects Claude Code to hosted macrodata service.

- Starts a daemon that maintains WebSocket connection to macrodata
- Injects context via hooks on session start and prompt submit
- Reads OAuth tokens from macOS keychain

## Model Configuration

Models are configured in `workers/macrodata/macrodata.config.ts`:

- `models.fast` - Quick tasks (default: Gemini Flash via AI Gateway)
- `models.thinking` - Deep reasoning (default: Claude Opus via AI Gateway)
- `models.local` - Free Workers AI model (default: Kimi K2)
- `embedding` - Vectorize embedding model (BGE variants)

External models route through AI Gateway's unified provider. Local models use Workers AI directly.
