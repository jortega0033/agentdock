# Development

This is the practical "how do I actually work in this repo" guide. [docs/architecture.md](docs/architecture.md)
is the map of how the pieces fit together; this file is the walkthrough for making a change.

## Prerequisites

- Node 20.x or 22.x (the only versions CI tests -- see the `engines` field in the root
  [package.json](package.json)) and the exact pnpm version pinned in `packageManager` there. `pnpm
install` runs `scripts/preflight.mjs` first and fails fast with a fix if either doesn't match; see
  [README.md#quick-start](README.md#quick-start) for the Corepack-present and Corepack-absent
  bootstrap paths.
- Optionally, a real, authenticated `claude` and/or `codex` CLI install if you want to exercise a
  provider adapter against the real thing. See
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
  desktop/        Electron + React demo client (secure defaults, no provider-native execution logic)
  daemon/         Standalone local Node.js service (Fastify), runnable without Electron
packages/
  agent-runtime/  Runtime: process management, provider adapters, normalized events
  client/         @agent-dock/client — typed daemon SDK (HTTP+SSE, auth, protocol version check)
  shared/         Types and Zod schemas for the protocol v1 and v2 contracts everything else uses
```

Dependencies only flow one direction: `shared ← agent-runtime ← daemon`, and separately
`shared ← client ← desktop`. See [docs/architecture.md#dependency-graph](docs/architecture.md#dependency-graph)
for the full picture and a "what belongs where" table.

## "I want to change X": where to start

| You want to...                                                   | Start here                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change what an `AgentEvent` looks like, or add a new event type  | `packages/shared/src/events.ts` + `schemas.ts`, then read [docs/protocol-v1.md](docs/protocol-v1.md): this is a protocol change, treat it as one                                                                                                                  |
| Add a new HTTP route or change an existing one's behavior        | `apps/daemon/src/routes/*.ts`, then update [docs/daemon.md](docs/daemon.md) and the affected [v1](docs/protocol-v1.md) or [v2](docs/protocol-v2.md) protocol document if the wire shape changed                                                                   |
| Add a new provider (a third provider besides Claude/Codex)       | [docs/providers.md#adding-a-new-provider](docs/providers.md#adding-a-new-provider): update the shared provider id/schema, runtime adapter and tests, daemon registry, and v2 transport policy; update the reference UI while its provider choices remain explicit |
| Change how a provider's output is parsed                         | `packages/agent-runtime/src/providers/<name>/parser.ts` + its test fixtures                                                                                                                                                                                       |
| Change process spawning/cancellation behavior                    | Legacy one-shot: `packages/agent-runtime/src/providers/common/run-session.ts`; interactive v2: `packages/agent-runtime/src/providers/common/session-supervisor.ts`; shared OS process ownership: `packages/agent-runtime/src/process/spawn-process.ts`            |
| Change the desktop UI                                            | `apps/desktop/src/`, never add a daemon `fetch()` call here, see [docs/electron.md](docs/electron.md)                                                                                                                                                             |
| Add a new Electron main-process/IPC capability                   | `apps/desktop/electron/main.ts` (handler) + `electron/preload.ts` (typed bridge function), see [docs/electron.md#the-preload-bridge](docs/electron.md#the-preload-bridge)                                                                                         |
| Change `@agent-dock/client`'s public API                         | `packages/client/src/index.ts` and `client.ts`, anything not exported from `index.ts` isn't public, see [docs/client-sdk.md](docs/client-sdk.md)                                                                                                                  |
| Change packaging (electron-builder config, `resolveDaemonEntry`) | See [docs/packaging.md](docs/packaging.md) first: three real bugs were already found here, each only by actually running `pnpm package:win`                                                                                                                       |
| Change the daemon's auth/origin/CORS behavior                    | `apps/daemon/src/server.ts` and `auth-token.ts`, read [SECURITY.md](SECURITY.md) fully before touching this; it's the load-bearing part of the whole project                                                                                                      |

## Normal development workflow

```bash
pnpm dev:daemon    # daemon only, tsx watch, auto-restart on change
pnpm dev:desktop   # full desktop app — spawns the daemon automatically
pnpm daemon        # daemon only, source via tsx, no watch
```

Before opening a PR, see [CONTRIBUTING.md](CONTRIBUTING.md#before-opening-a-pr) for the exact
verification commands expected to pass.

## Testing without paid providers

The automated test suite never calls a real Claude/Codex CLI and never spends real API credit.
The legacy one-shot adapters are tested two ways, both against fixtures:

1. **Parser unit tests** (`test/claude-parser.test.ts`, `test/codex-parser.test.ts`): feed each
   adapter's `parseLine()` a realistic fixture of the CLI's native JSONL output and assert the
   normalized `AgentEvent[]` it produces.
2. **Provider contract tests** (`test/claude-contract.test.ts`, `test/codex-contract.test.ts`):
   `describeProviderContract()` (`packages/agent-runtime/test/support/provider-contract.ts`) runs
   the adapter's _real_ `parseLine`/`buildArgs` against a small `node` fixture script standing in
   for the actual CLI binary, asserting the guarantees every adapter must uphold (terminal event
   ordering, capability gating, etc.). See [docs/providers.md#provider-contract-tests](docs/providers.md#provider-contract-tests).

The Claude SDK and Codex app-server paths additionally have focused support, options, process,
normalizer, and transport suites, plus versioned native-frame conformance fixtures. These still use
local fakes and checked-in evidence rather than paid provider calls.

`pnpm test` from a clean checkout, with no `claude`/`codex` installed at all, passes.

## Manual provider smoke tests

The fixture-based tests above prove the _adapter's parsing and lifecycle logic_ is correct; they
don't prove the real CLI's output still matches what the fixtures assume. If you change a parser or
upgrade a CLI version, it's worth manually confirming against the real thing:

```bash
pnpm daemon
# in another terminal, with claude (or codex) installed and authenticated:
# inspect the exact project identity first:
curl -sS -X POST http://127.0.0.1:<port>/v2/workspaces/inspect \
  -H "Authorization: Bearer <token from the discovery file>" \
  -H "Content-Type: application/json" \
  -d '{"cwd":"/path/to/a/real/project"}'
# after reviewing that response, explicitly trust its workspaceId/incarnation:
curl -sS -X PUT http://127.0.0.1:<port>/v2/workspaces/<workspaceId>/trust \
  -H "Authorization: Bearer <token from the discovery file>" \
  -H "Content-Type: application/json" \
  -d '{"cwd":"/path/to/a/real/project","incarnation":"<incarnation>","state":"trusted"}'
curl -X POST http://127.0.0.1:<port>/sessions \
  -H "Authorization: Bearer <token from the discovery file>" \
  -H "Content-Type: application/json" \
  -d '{"provider":"claude","cwd":"/path/to/a/real/project","prompt":"say hello"}'
```

Trust only a project you have inspected and intend to execute. Then use authenticated
`curl -N -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/sessions/<sessionId>/events`
and confirm the session reaches `session.completed` with sensible normalized events. A normal
browser address-bar request cannot add the required bearer header. This is not part of CI and is not
required for a PR that doesn't touch provider parsing: it's a manual check for exactly the class of
drift fixtures can't catch (a real CLI changing its own output format).

## Common architectural rules

These aren't style preferences: breaking them tends to break the security model or the layering
the tests assume:

- **Never build a shell command string.** Every process spawn uses `shell: false` and an argv
  array. See [SECURITY.md](SECURITY.md#what-the-daemon-will-never-do).
- **Never let the renderer call the daemon directly.** All daemon traffic goes through Electron
  main via `@agent-dock/client`. See [docs/electron.md](docs/electron.md).
- **Never accept an executable path from a request.** CLI transports resolve their executables
  internally via `findExecutable()`. The Claude SDK transport uses the pinned
  `resolveClaudeSdkExecutable()` resolver and does not fall back to `PATH`.
- **Keep provider-native behavior in `packages/agent-runtime`.** Raw parsing, launch arguments, and
  native transport behavior belong there. The daemon currently has explicit Claude/Codex transport
  selection policy, and the reference UI has explicit provider choices; prefer negotiated
  capabilities over adding more provider-id branches downstream. See
  [docs/protocol-v1.md](docs/protocol-v1.md) and [docs/protocol-v2.md](docs/protocol-v2.md).
- **Never add a generic IPC passthrough** to the preload bridge. Each capability the renderer needs
  is its own narrow, typed function.
- **Don't change durable persistence, add a provider mode, or add a new heavy dependency without
  opening an issue first.** See [CONTRIBUTING.md#scope](CONTRIBUTING.md#scope).
