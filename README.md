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
  script, each bundled to a single file (`main.js` inlines `@agent-dock/shared` and `zod`;
  `preload.js` is forced to CommonJS since Electron's sandboxed preload loader doesn't support ESM)

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
only meaningfully tested on Windows — see [Platform support](#platform-support) below. Both
commands are non-interactive and safe to run from a clean checkout after `pnpm install`, with no
signing configured (there's nothing to sign with in this repo — see
[docs/architecture.md](docs/architecture.md#packaging) for what that means for a real release).

### Runtime layout once packaged

```
AgentDock.exe                    (Electron; renderer + main process live in resources/app.asar)
resources/
  app.asar                       renderer (dist/) + main + preload — no node_modules needed,
                                  everything is bundled at build time (see Production build above)
  daemon/
    index.js                     the daemon's own esbuild bundle, unmodified from apps/daemon/dist/
```

The daemon ships **outside** `app.asar`, as an electron-builder `extraResource`, because it's
spawned as a separate OS process (`child_process.spawn`) rather than imported code — asar is a
virtual filesystem Electron's own `fs` module knows how to read, but handing a path inside it to a
freshly spawned process is exactly the kind of "happens to work" behavior this project avoids. See
`apps/desktop/electron-builder.yml` and `apps/desktop/electron/resolve-daemon-entry.ts` for exactly
how the packaged app locates it (`process.resourcesPath`), separately from how dev mode does
(`tsx` against source) and how an unpacked-but-not-packaged build does (the daemon's own
`dist/index.js` next to its source).

## Platform support

| | source / dev | production build | packaged app | installer | uninstall |
|---|---|---|---|---|---|
| **Windows** | ✅ verified | ✅ verified | ✅ verified (installed, launched, closed, relaunched, second-instance-blocked) | ✅ verified (NSIS, silent install/uninstall) | ✅ verified |
| **macOS** | untested | untested | untested | not implemented | — |
| **Linux** | untested | untested | untested | not implemented | — |

Nothing in the code is deliberately Windows-only (path handling uses `node:path`, process
management already has POSIX branches — see [docs/security.md](docs/security.md#process-hygiene)),
but "should work" and "verified" are different claims; only Windows has actually been installed and
exercised end to end. Adding `mac`/`linux` targets to `electron-builder.yml` (`dmg`/`zip`,
`AppImage`/`deb`) is a reasonable next step but wasn't attempted here — see
[docs/architecture.md](docs/architecture.md#known-limitations--v02-directions).

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
