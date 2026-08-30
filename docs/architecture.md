# Architecture

This is the map of the repository: what each layer does, why it's shaped this way, and where to
find the deeper detail. Protocol wire-format detail lives in [protocol-v1.md](protocol-v1.md), the
client's own design decisions in [client-sdk.md](client-sdk.md), and packaging specifics in
[packaging.md](packaging.md); this file stays at the "how do the pieces fit together" level and
links out rather than duplicating any of those.

## Component diagram

```
┌─────────────────────────┐
│   Renderer (React)        │   window.agentDock.* — seven narrow IPC capabilities only.
│                            │   Never sees the daemon's token or base URL.
└─────────────┬────────────┘
              │ Electron IPC (contextBridge, same machine, no network)
              ▼
┌─────────────────────────┐
│   Electron Main            │   Spawns/discovers the daemon. Owns one AgentDockClient
│   (electron/main.ts)       │   instance and makes every daemon call through it.
└─────────────┬────────────┘
              │ @agent-dock/client
              ▼
┌─────────────────────────┐
│   AgentDockClient           │   Typed daemon SDK: HTTP+SSE, bearer auth, protocol-
│   (packages/client)        │   version compatibility check. No Electron dependency —
│                             │   usable from any Node process. See docs/client-sdk.md.
└─────────────┬────────────┘
              │ HTTP + SSE, http://127.0.0.1:<port>, Bearer token, protocol v1
              ▼
┌─────────────────────────┐
│   Local Daemon             │   Fastify HTTP server. Provider discovery, session
│   (apps/daemon)            │   lifecycle, SSE streaming, cancellation. Runs standalone.
└─────────────┬────────────┘
              │ depends on
              ▼
┌─────────────────────────┐
│   Agent Runtime             │   Provider-neutral: AgentProvider interface, process
│   (packages/agent-runtime) │   spawning, JSONL parsing, normalization into AgentEvent.
│  ├── ClaudeProvider ───────┼──▶ `claude` CLI ──▶ user's own Claude Code auth
│  └── CodexProvider ────────┼──▶ `codex` CLI ──▶ user's own Codex auth
└─────────────────────────┘
```

## Dependency graph

```
packages/shared  ←  packages/agent-runtime  ←  apps/daemon
       ↑
       └──────────  packages/client  ←  apps/desktop
```

`packages/shared` sits underneath everything: it's the one place `ProviderId`, `ProviderStatus`,
`ProviderCapabilities`, `AgentSession`, `AgentEvent`/`AgentEventEnvelope`, the protocol version, and
the Zod request/response schemas are defined, so the daemon, `@agent-dock/client`, and the desktop
app can never drift from what `agent-runtime` actually produces. `packages/client` depends on
`packages/shared` only, **never** on `agent-runtime` or `apps/daemon`, so the graph stays acyclic.
Nothing depends "sideways" or "up": `apps/daemon` never imports from `apps/desktop`, and
`packages/agent-runtime` never imports from `apps/daemon`.

## What belongs where

| If you're changing... | It belongs in | Not in |
|---|---|---|
| A type, Zod schema, or the protocol version | `packages/shared` | anywhere downstream: every other package imports these, none redefines them |
| Provider process spawning, CLI-native parsing, an `AgentEvent` normalization rule | `packages/agent-runtime` | `apps/daemon`: the daemon never parses a provider's raw output itself |
| A route, session lifecycle, auth/origin checks, SSE framing | `apps/daemon` | `packages/agent-runtime`: the runtime knows nothing about HTTP |
| Anything the daemon exposes to a caller (HTTP/SSE handling, error typing) | `packages/client` | `apps/desktop/electron/main.ts`: main should only ever call `AgentDockClient` methods, never hand-roll a daemon request |
| Electron main-process logic, IPC handlers, the daemon sidecar lifecycle | `apps/desktop/electron/main.ts` | the renderer, see [electron.md](electron.md) |
| UI rendering, provider/session forms | `apps/desktop/src/` (renderer) | never a place that imports `@agent-dock/client` or touches the daemon's token |

## Trust boundaries

Three boundaries matter, in decreasing order of "who might be hostile":

1. **The public internet / an arbitrary webpage → the daemon.** This is the one the whole
   architecture is built around, see [SECURITY.md](../SECURITY.md). The daemon binds
   `127.0.0.1` only, requires a bearer token unknown to any webpage, and never answers a CORS
   preflight, so a malicious page cannot complete a request against it even knowing the token.
2. **The renderer → Electron main.** The renderer is this repo's own code, not adversarial, but
   it's still validated as if it might send something malformed: every IPC input is re-checked
   against the Zod schemas at the `ipcMain.handle` boundary (see [electron.md](electron.md)), and
   it structurally cannot reach the daemon's token or make an arbitrary daemon call, only the seven
   functions the preload bridge exposes.
3. **The daemon → the provider CLI.** The daemon trusts the CLI it spawns (it's the user's own,
   already-authenticated installation) but never trusts *what a request asked it to spawn*: the
   executable is always resolved internally via `findExecutable()`, never from request input, and
   arguments are always an argv array, never a shell string.

Explicitly **not** a trust boundary this project defends: another process running as the same OS
user. See [SECURITY.md](../SECURITY.md#what-this-does-not-claim-to-protect-against).

## Why a separate daemon instead of running the CLI logic in Electron's main process

Three reasons, in order of importance:

1. **A malicious webpage should never be able to run a coding agent on your machine.** Keeping
   agent execution behind an HTTP+token boundary (see [SECURITY.md](../SECURITY.md)) is a much
   smaller, more auditable surface than "whatever the renderer/main process can reach."
2. **The daemon has to outlive one specific UI.** A VS Code extension, a CLI client, or a second
   desktop shell should all be able to talk to the same daemon over the same HTTP+SSE API without
   re-implementing process management.
3. **Testability.** `pnpm daemon` runs and can be curled directly, with no Electron, no display
   server, and no GUI test harness required.

## Runtime flow: what happens when a user presses "Run"

1. Renderer calls `window.agentDock.createSession({ provider, cwd, prompt })`.
2. Preload forwards it over IPC to `ipcMain.handle('daemon:create-session', ...)` in `main.ts`.
3. Main re-validates the input against `createSessionRequestSchema` (a second, independent check;
   see [electron.md#renderer-trust-assumptions](electron.md#renderer-trust-assumptions)) and calls
   `client.sessions.create(...)`.
4. `AgentDockClient` runs its lazy protocol-compatibility check (if not already cached), then
   `POST /sessions` with the bearer token.
5. The daemon validates the body again (Zod, server-side; the client's own validation is a
   different concern, see [client-sdk.md](client-sdk.md)), checks the provider exists and the `cwd`
   is real, and calls `SessionManager.create()`.
6. `SessionManager` asks the provider registry for the right `AgentProvider`, generates a session
   `id`, and calls `providerImpl.startSession(...)`, which resolves the CLI executable and spawns
   it with an argv array (see [Process management](#process-management) below).
7. The daemon responds `201` with the initial `AgentSession` record; `main.ts` immediately starts
   forwarding that session's SSE stream via `forwardSessionEvents()`.
8. The provider CLI's stdout is parsed line-by-line and normalized into `AgentEvent`s (see
   [protocol-v1.md](protocol-v1.md)) by the adapter's `parser.ts`.
9. `SessionManager` stamps each event with `sequence`/`timestamp`, updates the `AgentSession`'s
   `status`, and broadcasts it to every subscriber of that session's SSE stream.
10. Main receives each event over its own SSE connection and pushes it to the renderer via
    `sendToRenderer(mainWindow, 'daemon:session-event', ...)`.
11. The renderer's `onSessionEvent` callback updates `EventLog.tsx`, which renders on a single
    `switch (event.type)`, never branching on provider id.
12. Exactly one of `session.completed` / `session.failed` / `session.cancelled` ends the stream;
    both the daemon's SSE response and `@agent-dock/client`'s async generator close at that point,
    with nothing emitted after it.

## Sessions

```ts
type AgentSession = {
  id: string; // daemon-generated UUID — never a process id
  provider: ProviderId;
  cwd: string;
  prompt: string;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  providerSessionId?: string; // the CLI's own session/thread id, once known
  startedAt: string;
  completedAt?: string;
};
```

A session's `AgentSession` record lives behind a `SessionStore` interface, while its live process
handle and buffered event history are kept as separate, non-persistable runtime state inside
`SessionManager`. **Persistence is deliberately out of scope**, see
[daemon.md#session-lifecycle-sessionmanager-sessionstore](daemon.md#session-lifecycle-sessionmanager-sessionstore)
for the full interface and rationale. Restarting the daemon loses every session and its event
history: `resumeProviderSessionId` lets you continue a provider-native thread, but only within the
same daemon process's lifetime.

## Provider capabilities

`ProviderStatus.capabilities` is what lets a downstream client ask "does this provider support X"
instead of writing `if (provider.id === 'claude')`. See
[providers.md#provider-capabilities](providers.md#provider-capabilities) for the full
`ProviderCapabilities` shape and exactly which fields are true for Claude and Codex and why. The
daemon enforces `capabilities.resume` server-side too: `POST /sessions` rejects a
`resumeProviderSessionId` for a provider whose capability is `false` with `400`, rather than
silently ignoring it.

## Process management

`packages/agent-runtime/src/providers/common/run-session.ts` is the one place every provider's
spawn/parse/normalize lifecycle happens. It:

- validates the working directory exists before spawning anything
- resolves the executable via `findExecutable` (PATH lookup + a curated fallback directory list,
  see [providers.md#executable-discovery](providers.md#executable-discovery)), never from a
  request-supplied path
- spawns with `child_process.spawn`, `shell: false`, and an argv array: prompts are **never**
  interpolated into a shell string
- reads stdout through `readLines` (`process/line-reader.ts`), which tolerates a JSON line split
  across chunk boundaries and multiple JSON lines arriving in one chunk, and caps a single line at
  10MB to bound memory
- captures stderr separately, capped at 200KB, and only surfaces it on a non-zero exit
- kills the whole process tree on cancellation, never just the direct child, see
  [daemon.md#cancellation-and-process-tree-kill](daemon.md#cancellation-and-process-tree-kill)
- always terminates the event stream with exactly one of `session.completed` / `session.failed` /
  `session.cancelled`, so callers never have to guess whether more events might still arrive

## Daemon discovery and lifecycle

Electron spawns the daemon as a sidecar child process and reads its port + token from a discovery
file the daemon writes once it's listening; see [SECURITY.md](../SECURITY.md#local-auth-token) for
why a file handoff instead of a network one, and [daemon.md](daemon.md) for the full operational
detail (routes, single-instance enforcement, shutdown behavior).

This is explicitly **not** the only way to run it: `pnpm daemon` starts the exact same server
standalone, and nothing in the daemon's code depends on Electron being present. A future
"persistent daemon" mode (survives Electron closing, perhaps installed as a background
service/launch agent) is a pure lifecycle change: the HTTP API and desktop client would not need
to change at all.

## Deliberate omissions (v0.2)

These aren't gaps the project failed to notice: each was considered and left out on purpose, and
each is also listed as out of scope in [CONTRIBUTING.md](../CONTRIBUTING.md#scope):

- **No persistence.** Sessions and their event history are lost on daemon restart (see
  [Sessions](#sessions) above), adding it means designing a schema, migrations, and "what happens
  to a resumed session after a crash," none of which this milestone needed to answer.
- **One daemon per app id, enforced** (see [Project identity](#project-identity) and
  [daemon.md#single-instance-behavior](daemon.md#single-instance-behavior)): two different
  products built on this boilerplate coexist by using different app ids, but two instances of the
  *same* product still can't run side by side. A richer scheme (e.g. a random per-launch id) isn't
  needed for what this boilerplate currently supports.
- **No API-key/cloud provider mode.** Everything here assumes a locally authenticated CLI; adding a
  second auth model is a different product shape, not an extension of this one.
- **No auto-update, telemetry, or crash reporting.** Each adds its own trust and privacy surface
  that doesn't belong in boilerplate meant to be forked as-is.
- **Packaging targets Windows only**, see [packaging.md#platform-matrix](packaging.md#platform-matrix).
- **No installer signing**, see [packaging.md#unsigned-installer-and-smartscreen](packaging.md#unsigned-installer-and-smartscreen).

## Project identity

**AgentDock is an open-source boilerplate containing a reusable local runtime and internal typed
workspace SDK boundaries. It is intended to be forked/customized today**, not consumed as a set of
independently-installable npm packages. This is a decision, written down here so it doesn't have to
be inferred (AD-03): every workspace package (`shared`, `agent-runtime`, `client`, plus the two
apps) is `private: true` with `main`/`types` pointing at raw TypeScript source, not a built `dist/`
with a `files` allowlist: nothing here is set up to be `npm install`-ed from outside this
workspace.

That doesn't make the internal boundaries decorative. `packages/shared`'s types and Zod schemas,
`AGENT_DOCK_PROTOCOL_VERSION`, and `@agent-dock/client`'s typed surface exist to keep the daemon,
the client, and the desktop app honest with each other *inside* this repo (and inside a fork of
it), a change to the wire format has to go through one shared definition, not get silently
duplicated three ways. Protocol v1 currently governs the daemon/client pair as shipped together in
this repository; it is not (yet) a promise to arbitrary external consumers.

External npm publication is a real option later, but a deliberately deferred one: see
[client-sdk.md](client-sdk.md#using-it-from-a-workspacefork-not-from-outside-the-repo) for exactly
what would need to change first (a `dist`-based `exports` map, a `files` allowlist, `zod` moved to
a peer dependency in `shared`, dropping `private`), and don't treat "it looks like a normal typed
package" as an invitation to publish it without that work.

## Known limitations

- **Electron's own graceful-shutdown path is best-effort on Windows**, see
  [daemon.md#shutdown](daemon.md#shutdown).
- **Process-tree cancellation was empirically verified on Windows only**, see
  [SECURITY.md](../SECURITY.md#process-hygiene).

If you're extending this project, [DEVELOPMENT.md](../DEVELOPMENT.md) is the practical
"I want to change X, start here" guide; this file is the map, not the walkthrough.
