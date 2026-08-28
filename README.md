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
Renderer (React) ──IPC──▶ Electron main ──@agent-dock/client──▶ Local Daemon (Fastify, protocol v1)
                                                                          │
                                                             Unified Agent Runtime
                                                        ├── Claude Code adapter ──▶ claude CLI
                                                        └── Codex adapter ────────▶ codex CLI
```

The renderer never calls the daemon directly — only Electron's main process does, through the
typed `@agent-dock/client` SDK. See
[SECURITY.md](SECURITY.md#renderer-never-talks-to-the-daemon-directly) for why, and
[Client SDK](#client-sdk) below for what that package looks like from the outside.

See [docs/architecture.md](docs/architecture.md) for the full breakdown, and
[SECURITY.md](SECURITY.md) for exactly what protects the daemon and why.

## Where do I start?

- **Just want to run it?** [Getting started](#getting-started) below.
- **Want to contribute to this repo?** [DEVELOPMENT.md](DEVELOPMENT.md) — setup, an "I want to
  change X" map of the codebase, and the common architectural rules that keep the security model
  intact.
- **Want to build your own product on top of AgentDock?** [Building your own product](#building-your-own-product-with-agentdock)
  below.
- **Want to add a provider (a third CLI besides Claude/Codex)?**
  [docs/providers.md#adding-a-new-provider](docs/providers.md#adding-a-new-provider) — self-
  contained, no daemon/client/desktop changes required.
- **Something's not working?** [docs/troubleshooting.md](docs/troubleshooting.md).

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
  client/         @agent-dock/client — typed daemon SDK (HTTP+SSE, auth, protocol version check)
  shared/         Types, Zod schemas, and the protocol v1 AgentEvent contract everything else uses
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
startup — see [SECURITY.md](SECURITY.md#local-auth-token) for what that file is and why the token
exists, and [docs/daemon.md](docs/daemon.md) for everything else about running it standalone.

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

## Production build

`pnpm build` compiles every package in dependency order and produces:

- `packages/shared/dist/`, `packages/agent-runtime/dist/` — compiled library output
- `apps/daemon/dist/index.js` — the daemon bundled by esbuild into **one self-contained file**
  (every dependency inlined, including the two packages above) — required so it can run under
  plain `node`, with no workspace resolution or `tsx`, once packaged. See
  [docs/architecture.md](docs/architecture.md#daemon-discovery-and-lifecycle) for why this needed
  fixing, not just adding.
- `apps/desktop/dist/` — the Vite production build of the React renderer
- `apps/desktop/dist-electron/main.js`, `preload.js` — the Electron main process and preload
  script, each bundled to a single file (`main.js` inlines `@agent-dock/client`,
  `@agent-dock/shared`, and `zod`; `preload.js` is forced to CommonJS since Electron's sandboxed
  preload loader doesn't support ESM)

None of this is an installer yet — it's the "does the code actually compile to something runnable"
step. `electron .` against `apps/desktop` at this point runs the app unpacked, useful for a quick
check without going through a full package step.

## Packaging (Windows)

```bash
pnpm package:win   # pnpm build, then electron-builder --win nsis
```

Produces, under `dist-packages/` at the repo root:

- `dist-packages/win-unpacked/` — the unpacked app (`AgentDock.exe` + `resources/`)
- `dist-packages/AgentDock-Setup-<version>.exe` — the NSIS installer

`pnpm package` (no `:win`) runs `electron-builder` for whatever platform you're on; today that's
only meaningfully tested on Windows. Both commands are non-interactive and safe to run from a clean
checkout after `pnpm install`, with no signing configured. See
[docs/packaging.md](docs/packaging.md) for the runtime layout once packaged, why the daemon ships
outside `app.asar`, and the full Windows-only platform matrix.

## Client SDK

`@agent-dock/client` is the typed way to talk to the daemon — it owns the HTTP request/response
handling, bearer-token auth, incremental SSE parsing, and the protocol-version compatibility check
(see [Protocol v1](docs/protocol-v1.md)), so a caller never hand-writes daemon URLs, headers, or
event-stream parsing. It's a plain TypeScript package with no Electron or browser dependency —
usable from Electron's main process (what this repo's own desktop app does), a Node CLI, or a
future VS Code extension. See [docs/client-sdk.md](docs/client-sdk.md) for the full public API
(including `sessions.get`/`sessions.delete`, not shown below) and design decisions.

```ts
import { AgentDockClient } from '@agent-dock/client';

const client = new AgentDockClient({ baseUrl: 'http://127.0.0.1:PORT', token });

const providers = await client.providers.list();

const session = await client.sessions.create({
  provider: 'claude',
  cwd: '/path/to/project',
  prompt: 'Inspect this repository',
});

for await (const event of client.sessions.events(session.id)) {
  console.log(event); // AgentEventEnvelope — a normalized AgentEvent plus sequence/timestamp
}

await client.sessions.cancel(session.id);
```

Failures are typed — `DaemonUnavailableError`, `UnauthorizedError`, `ProtocolMismatchError`,
`ValidationError`, `SessionNotFoundError`, `ProviderUnavailableError`, `DaemonError` — so a caller
can `catch` and branch on `instanceof` instead of parsing error strings. See
[docs/client-sdk.md](docs/client-sdk.md) and [docs/protocol-v1.md](docs/protocol-v1.md).

## Adding a provider

See [docs/providers.md](docs/providers.md#adding-a-new-provider) — it's meant to be: implement one
adapter, declare its capabilities, write its parser + tests, run it against the shared provider
contract suite, register it. No daemon, client, or desktop changes required.

## Building your own product with AgentDock

This repo's `apps/desktop` is a demo, not a product — it exists to prove the daemon and client
work end to end, with no chat history, accounts, or specific workflow of its own. To build a real
product on top of it:

1. **Fork the repo** and treat `apps/desktop` as a starting point to replace, not extend in place
   — keep `packages/shared`, `packages/agent-runtime`, `packages/client`, and `apps/daemon`
   largely as-is; your own product's UI and any product-specific logic (persistence, accounts,
   a specific end-user workflow) belongs in your own app, not upstream in these packages.
2. **Talk to the daemon the same way this repo does** — through `@agent-dock/client` from a trusted
   process (Electron main, a Node backend, a CLI), never from a browser/renderer context. See
   [SECURITY.md](SECURITY.md#renderer-never-talks-to-the-daemon-directly) for why that boundary is
   load-bearing, not optional, if your product also runs in a browser-based renderer.
3. **Add product-specific persistence in your own layer**, not in `SessionStore` — this project's
   `MemorySessionStore` is deliberately ephemeral (see
   [docs/daemon.md#session-lifecycle-sessionmanager-sessionstore](docs/daemon.md#session-lifecycle-sessionmanager-sessionstore)).
   If you need session history to survive a restart, that's a product concern to build in your own
   app (e.g. by storing `AgentEventEnvelope`s as your product receives them over SSE), not something
   to retrofit into the daemon.
4. **Add a provider if you need one AgentDock doesn't ship** — see
   [docs/providers.md#adding-a-new-provider](docs/providers.md#adding-a-new-provider).
5. **Package it as your own app** — update `appId`, `productName`, and add an icon in
   `apps/desktop/electron-builder.yml` (see [docs/packaging.md](docs/packaging.md)); the daemon and
   client packages need no changes to ship under a different product name.

## Documentation

- [DEVELOPMENT.md](DEVELOPMENT.md) — setup, an "I want to change X" map, common architectural rules
- [docs/architecture.md](docs/architecture.md) — component responsibilities, runtime flow, trust boundaries, dependency graph
- [docs/protocol-v1.md](docs/protocol-v1.md) — the `AgentEvent` union, wire format, ordering guarantees, what's public/stable
- [docs/client-sdk.md](docs/client-sdk.md) — `@agent-dock/client`'s full public API and design decisions
- [docs/providers.md](docs/providers.md) — how the Claude/Codex adapters work, provider capabilities, how to add another, the shared contract test suite
- [docs/daemon.md](docs/daemon.md) — running the daemon standalone, routes, session lifecycle, discovery file
- [docs/electron.md](docs/electron.md) — the renderer/main/daemon boundary, IPC bridge, where to safely add native functionality
- [docs/packaging.md](docs/packaging.md) — electron-builder/NSIS specifics, verified commands, platform support
- [docs/troubleshooting.md](docs/troubleshooting.md) — common problems and how to diagnose them
- [SECURITY.md](SECURITY.md) — the daemon's threat model and local-auth mechanism
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution workflow and checklist

## License

[Apache-2.0](LICENSE)
