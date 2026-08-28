# Agent Dock

A reusable **Electron + local-daemon boilerplate** for desktop applications that want to run
prompts through AI agent CLIs the user has already installed and authenticated — starting with
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) and
[Codex](https://github.com/openai/codex) — without the application ever touching the user's
credentials.

## What this is

A **Bring Your Own Subscription** foundation: if a user already has `claude` or `codex` installed
and logged in on their machine, an app built on this boilerplate can run prompts through those
CLIs using the user's existing session. The installed CLI stays the sole authentication and
provider boundary; this project never sees a password, token, or API key.

```
Renderer (React) ──IPC──▶ Electron main ──HTTP+SSE, localhost, bearer token──▶ Local Daemon (Fastify)
                                                                                       │
                                                                          Unified Agent Runtime
                                                                     ├── Claude Code adapter ──▶ claude CLI
                                                                     └── Codex adapter ────────▶ codex CLI
```

The renderer never calls the daemon directly — only Electron's main process does. See
[docs/security.md](docs/security.md#renderer-never-talks-to-the-daemon-directly) for why.

See [docs/architecture.md](docs/architecture.md) for the full breakdown, and
[docs/security.md](docs/security.md) for exactly what protects the daemon and why.

## What this is not

- **Not** an unofficial authentication bypass — every CLI call goes through the real `claude`/`codex`
  binary using its own login state. Nothing here reads, copies, or reverse-engineers credential storage.
- **Not** a token extractor or an API proxy — this project never makes a direct Anthropic/OpenAI API
  call and never asks a user for an API key in CLI mode.
- **Not** a finished AI product — there is no chat history database, no accounts, no cloud backend,
  no specific end-user workflow. It's infrastructure for you to build on.
- **Not** a replacement for Claude Code or Codex — it's a thin, provider-neutral shell around them.

## Repository layout

```
apps/
  desktop/        Electron + React demo client (secure defaults, no provider-specific logic)
  daemon/         Standalone local Node.js service (Fastify), runnable without Electron
packages/
  agent-runtime/  Provider-neutral runtime: process management, adapters, normalized events
  shared/         Types, Zod schemas, and the AgentEvent protocol shared by daemon + desktop
```

## Requirements

Install and authenticate the CLIs you want to use, independently of this project:

```bash
# Claude Code
claude auth login
claude auth status

# Codex
codex login
codex login status
```

This project never automates account signup or handles credentials on your behalf — do that
directly with each CLI first.

## Getting started

```bash
pnpm install

# Run the daemon on its own (no Electron required)
pnpm daemon

# In another terminal, verify it's alive
curl http://127.0.0.1:<port>/health
```

The daemon prints its listening URL and where it wrote its discovery file (port + auth token) on
startup — see [docs/security.md](docs/security.md) for what that file is and why the token exists.

To run the full desktop demo (spawns the daemon automatically):

```bash
pnpm dev:desktop
```

### Everyday commands

```bash
pnpm build       # build every package
pnpm typecheck   # strict TypeScript across the whole workspace
pnpm test        # unit + integration tests (no real CLI calls; see docs/providers.md)
pnpm lint        # ESLint
```

## Adding a provider

See [docs/providers.md](docs/providers.md#adding-a-new-provider) — it's meant to be: implement one
adapter, write its parser + tests, register it. No daemon or desktop changes required.

## Documentation

- [docs/architecture.md](docs/architecture.md) — component responsibilities, session/event model, why these design choices
- [docs/providers.md](docs/providers.md) — how the Claude/Codex adapters work, and how to add another
- [docs/security.md](docs/security.md) — the daemon's threat model and local-auth mechanism
- [CONTRIBUTING.md](CONTRIBUTING.md) — development workflow

## License

[Apache-2.0](LICENSE)
