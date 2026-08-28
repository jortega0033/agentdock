# Development

This is the practical "how do I actually work in this repo" guide. [docs/architecture.md](docs/architecture.md)
is the map of how the pieces fit together; this file is the walkthrough for making a change.

## Prerequisites

- Node 20+ and pnpm (see the `packageManager` field in the root [package.json](package.json) for
  the exact version this repo was built against).
- Optionally, a real, authenticated `claude` and/or `codex` CLI install if you want to exercise a
  provider adapter against the real thing — see
  [Manual provider smoke tests](#manual-provider-smoke-tests) below. **Not required** for normal
  development: the automated test suite never needs either CLI installed.

## First-time setup

```bash
pnpm install
pnpm typecheck
pnpm test
```

If both pass on a clean checkout, your environment is set up correctly.

## Repository map

```
apps/
  desktop/        Electron + React demo client (secure defaults, no provider-specific logic)
  daemon/         Standalone local Node.js service (Fastify), runnable without Electron
packages/
  agent-runtime/  Provider-neutral runtime: process management, adapters, normalized events
  client/         @agent-dock/client — typed daemon SDK (HTTP+SSE, auth, protocol version check)
  shared/         Types, Zod schemas, and the protocol v1 AgentEvent contract everything else uses
```

Dependencies only flow one direction: `shared ← agent-runtime ← daemon`, and separately
`shared ← client ← desktop`. See [docs/architecture.md#dependency-graph](docs/architecture.md#dependency-graph)
for the full picture and a "what belongs where" table.

## "I want to change X" — where to start

| You want to... | Start here |
|---|---|
| Change what an `AgentEvent` looks like, or add a new event type | `packages/shared/src/events.ts` + `schemas.ts`, then read [docs/protocol-v1.md](docs/protocol-v1.md) — this is a protocol change, treat it as one |
| Add a new HTTP route or change an existing one's behavior | `apps/daemon/src/routes/*.ts`, then update [docs/daemon.md](docs/daemon.md) and [docs/protocol-v1.md](docs/protocol-v1.md) if the wire shape changed |
| Add a new provider (a third CLI besides Claude/Codex) | [docs/providers.md#adding-a-new-provider](docs/providers.md#adding-a-new-provider) — a self-contained checklist, no daemon/client/desktop changes needed |
| Change how a provider's output is parsed | `packages/agent-runtime/src/providers/<name>/parser.ts` + its test fixtures |
| Change process spawning/cancellation behavior for every provider | `packages/agent-runtime/src/providers/common/run-session.ts` and `process/spawn-process.ts` |
| Change the desktop UI | `apps/desktop/src/` — never add a daemon `fetch()` call here, see [docs/electron.md](docs/electron.md) |
| Add a new Electron main-process/IPC capability | `apps/desktop/electron/main.ts` (handler) + `electron/preload.ts` (typed bridge function) — see [docs/electron.md#the-preload-bridge](docs/electron.md#the-preload-bridge) |
| Change `@agent-dock/client`'s public API | `packages/client/src/index.ts` and `client.ts` — anything not exported from `index.ts` isn't public, see [docs/client-sdk.md](docs/client-sdk.md) |
| Change packaging (electron-builder config, `resolveDaemonEntry`) | See [docs/packaging.md](docs/packaging.md) first — three real bugs were already found here, each only by actually running `pnpm package:win` |
| Change the daemon's auth/origin/CORS behavior | `apps/daemon/src/server.ts` and `auth-token.ts` — read [SECURITY.md](SECURITY.md) fully before touching this; it's the load-bearing part of the whole project |

## Normal development workflow

```bash
pnpm dev:daemon    # daemon only, tsx watch, auto-restart on change
pnpm dev:desktop   # full desktop app — spawns the daemon automatically
pnpm daemon        # daemon only, no watch (matches how a packaged app would run it in dev mode)
```

Before opening a PR, see [CONTRIBUTING.md](CONTRIBUTING.md#before-opening-a-pr) for the exact
verification commands expected to pass.

## Testing without paid providers

The automated test suite never calls a real Claude/Codex CLI and never spends real API credit.
Provider adapters are tested two ways, both against fixtures:

1. **Parser unit tests** (`test/claude-parser.test.ts`, `test/codex-parser.test.ts`) — feed each
   adapter's `parseLine()` a realistic fixture of the CLI's native JSONL output and assert the
   normalized `AgentEvent[]` it produces.
2. **Provider contract tests** (`test/claude-contract.test.ts`, `test/codex-contract.test.ts`) —
   `describeProviderContract()` (`packages/agent-runtime/test/support/provider-contract.ts`) runs
   the adapter's *real* `parseLine`/`buildArgs` against a small `node` fixture script standing in
   for the actual CLI binary, asserting the guarantees every adapter must uphold (terminal event
   ordering, capability gating, etc.) — see [docs/providers.md#provider-contract-tests](docs/providers.md#provider-contract-tests).

`pnpm test` from a clean checkout, with no `claude`/`codex` installed at all, passes.

## Manual provider smoke tests

The fixture-based tests above prove the *adapter's parsing and lifecycle logic* is correct; they
don't prove the real CLI's output still matches what the fixtures assume. If you change a parser or
upgrade a CLI version, it's worth manually confirming against the real thing:

```bash
pnpm daemon
# in another terminal, with claude (or codex) installed and authenticated:
curl -X POST http://127.0.0.1:<port>/sessions \
  -H "Authorization: Bearer <token from the discovery file>" \
  -H "Content-Type: application/json" \
  -d '{"provider":"claude","cwd":"/path/to/a/real/project","prompt":"say hello"}'
```

Then `curl` (or open in a browser — SSE is human-readable) `GET /sessions/:id/events` and confirm
the session reaches `session.completed` with sensible normalized events. This is not part of CI and
is not required for a PR that doesn't touch provider parsing — it's a manual check for exactly the
class of drift fixtures can't catch (a real CLI changing its own output format).

## Common architectural rules

These aren't style preferences — breaking them tends to break the security model or the layering
the tests assume:

- **Never build a shell command string.** Every process spawn uses `shell: false` and an argv
  array. See [SECURITY.md](SECURITY.md#what-the-daemon-will-never-do).
- **Never let the renderer call the daemon directly.** All daemon traffic goes through Electron
  main via `@agent-dock/client`. See [docs/electron.md](docs/electron.md).
- **Never accept an executable path from a request.** The daemon always resolves the executable
  itself via `findExecutable()`.
- **Never branch on provider id outside `packages/agent-runtime`.** The daemon, the client, and the
  desktop UI all work only in terms of the normalized `AgentEvent` union and `ProviderCapabilities`
  — see [docs/protocol-v1.md](docs/protocol-v1.md).
- **Never add a generic IPC passthrough** to the preload bridge. Each capability the renderer needs
  is its own narrow, typed function.
- **Don't add persistence, a new provider mode, or a new heavy dependency without opening an issue
  first.** See [CONTRIBUTING.md#scope](CONTRIBUTING.md#scope).
