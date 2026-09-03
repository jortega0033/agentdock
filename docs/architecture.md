# Architecture

AgentDock is an open-source Electron and local-daemon boilerplate for desktop products that use the
Claude Agent SDK or a user's existing signed-in Claude or Codex CLI. It is designed to be forked. A
product fork can replace the reference UI and workflow, set its own application identity, and keep
or adapt the local runtime layers it needs.

The runtime, protocol, security boundaries, provider adapters, tests, and packaging support that
boilerplate purpose. They provide a working base and clear extension points rather than defining a
finished chat product.

This is the map of the repository: what each layer does, why it's shaped this way, and where to
find the deeper detail. Wire-format detail lives in [protocol-v1.md](protocol-v1.md) and
[protocol-v2.md](protocol-v2.md), while the v2 trust and capability decisions live in
[capability-security-v2.md](capability-security-v2.md). The client's own design decisions are in
[client-sdk.md](client-sdk.md), and packaging specifics in [packaging.md](packaging.md); this file
stays at the "how do the pieces fit together" level and links out rather than duplicating any of
those.

## Component diagram

```
┌─────────────────────────┐
│   Renderer (React)        │   window.agentDock.*: explicit narrow IPC capabilities.
│                            │   Never sees the token; errors may name the base URL.
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
│   (packages/client)        │   version compatibility check. No Electron dependency;
│                             │   usable from any Node process. See docs/client-sdk.md.
└─────────────┬────────────┘
              │ HTTP + SSE, http://127.0.0.1:<port>, Bearer token, protocols v1 + v2
              ▼
┌─────────────────────────┐
│   Local Daemon             │   Fastify HTTP server. Provider discovery, session
│   (apps/daemon)            │   lifecycle, SSE streaming, cancellation. Runs standalone.
└─────────────┬────────────┘
              │ depends on
              ▼
┌─────────────────────────┐
│   Agent Runtime             │   Provider-neutral: AgentProvider interface, process
│   (packages/agent-runtime) │   spawning, native transport normalization into AgentEvent.
│  ├── ClaudeProvider ───────┼──▶ pinned Agent SDK (API/cloud) or local Claude CLI
│  └── CodexProvider ────────┼──▶ app-server or local `codex` CLI
└─────────────────────────┘
```

## Dependency graph

```
packages/shared  ←  packages/agent-runtime  ←  apps/daemon
       ↑                                            ↑
       └──────────  packages/client  ←  apps/desktop
                          ↑
                          └── apps/daemon (live-smoke CLI only, see below)
```

`packages/shared` sits underneath everything: it's the one place `ProviderId`, `ProviderStatus`,
`ProviderCapabilities`, `AgentSession`, `AgentEvent`/`AgentEventEnvelope`, the protocol version, and
the Zod request/response schemas are defined, so the daemon, `@agent-dock/client`, and the desktop
app can never drift from what `agent-runtime` actually produces. `packages/client` depends on
`packages/shared` only, **never** on `agent-runtime`, so the graph stays acyclic even though
`apps/daemon` itself also depends on `packages/client` — its `live-smoke` CLI
(`apps/daemon/src/live-smoke/cli.ts`) uses `AgentDockClient` the same way any other trusted caller
would, to drive a real running daemon in bounded live-provider smoke checks, rather than the daemon
reaching into its own runtime internals for that. Nothing depends "sideways" or "up" in the sense
that matters: `apps/daemon` never imports from `apps/desktop`, and `packages/agent-runtime` never
imports from `apps/daemon` or `packages/client`.

## What belongs where

| If you're changing...                                                             | It belongs in                   | Not in                                                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| A type, Zod schema, or the protocol version                                       | `packages/shared`               | anywhere downstream: every other package imports these, none redefines them                                             |
| Provider process spawning, CLI-native parsing, an `AgentEvent` normalization rule | `packages/agent-runtime`        | `apps/daemon`: the daemon never parses a provider's raw output itself                                                   |
| A route, session lifecycle, auth/origin checks, SSE framing                       | `apps/daemon`                   | `packages/agent-runtime`: the runtime knows nothing about HTTP                                                          |
| Anything the daemon exposes to a caller (HTTP/SSE handling, error typing)         | `packages/client`               | `apps/desktop/electron/main.ts`: main should only ever call `AgentDockClient` methods, never hand-roll a daemon request |
| Electron main-process logic, IPC handlers, the daemon sidecar lifecycle           | `apps/desktop/electron/main.ts` | the renderer, see [electron.md](electron.md)                                                                            |
| UI rendering, provider/session forms                                              | `apps/desktop/src/` (renderer)  | never a place that imports `@agent-dock/client` or touches the daemon's token                                           |

## Trust boundaries

Three boundaries matter, in decreasing order of "who might be hostile":

1. **The public internet / an arbitrary webpage → the daemon.** This is the one the whole
   architecture is built around, see [SECURITY.md](../SECURITY.md). The daemon binds
   `127.0.0.1` only, requires a bearer token unknown to any webpage, and never answers a CORS
   preflight, so a malicious page cannot complete a request against it even knowing the token.
2. **The renderer → Electron main.** The renderer is this repo's own code, not adversarial, but
   it's still validated as if it might send something malformed: IPC inputs are re-checked with
   shared Zod schemas or narrow explicit validators at the `ipcMain.handle` boundary (see
   [electron.md](electron.md)), and it structurally cannot reach the daemon's token or make an
   arbitrary daemon call, only the explicit functions the preload bridge exposes.
3. **The daemon → the provider host.** Local CLI executables are resolved internally, never from
   request input. The Claude Agent SDK path instead uses the exact packaged, version-checked SDK
   executable outside ASAR. Both paths use argv arrays and the daemon-owned process-tree host,
   never a shell-built command.

Explicitly **not** a trust boundary this project defends: another process running as the same OS
user. See [SECURITY.md](../SECURITY.md#what-this-does-not-claim-to-protect-against).

Protocol v2 makes workspace files, provider SDK/app-server transports, MCP servers, OAuth browser
flows, and persisted history explicit boundaries. It also keeps provider permissions, OS
sandboxing, approvals, and worktree isolation as separate states. See the complete
[v2 boundary inventory](capability-security-v2.md#execution-and-data-boundaries). These controls
apply according to the negotiated v2 transport and evidence; they are not guarantees of legacy v1.

## Why a separate daemon instead of running the CLI logic in Electron's main process

Three reasons, in order of importance:

1. **A malicious webpage should never be able to run a coding agent on your machine.** Keeping
   agent execution behind an HTTP+token boundary (see [SECURITY.md](../SECURITY.md)) is a much
   smaller, more auditable surface than "whatever the renderer/main process can reach."
2. **The daemon can run independently of Electron.** The reference desktop owns and stops its
   sidecar — though "stops" now means "on a real quit," not "whenever the window closes": closing
   the window hides it to a tray icon and keeps the daemon running, see
   [Tray lifecycle](electron.md#tray-lifecycle) — while a CLI client, VS Code extension, or another
   shell can run the standalone daemon and use the same HTTP+SSE API without re-implementing
   process management.
3. **Testability.** `pnpm daemon` runs and can be curled directly, with no Electron, no display
   server, and no GUI test harness required.

## Runtime flow: what happens when a user presses "Run"

The reference desktop uses protocol v2:

1. The renderer calls `createInteractiveSession(...)` through `getBridge()`
   (`apps/desktop/src/bridge.ts`, see [electron.md](electron.md)) with the provider, working
   directory, prompt, and requested capabilities.
2. Preload validates the request, main validates it again at the privileged IPC boundary, and
   `AgentDockClient` sends authenticated `POST /v2/sessions`.
3. The daemon resolves the canonical workspace identity, requires current trust, detects the exact
   provider/auth/runtime scope, negotiates capabilities, and revalidates trust before dispatch.
4. `SessionManager` records compatibility metadata and the v2 execution graph before provider work.
   Claude SDK and Codex app-server use the interactive supervisor when their transport gates pass;
   the v2 compatibility path can wrap a legacy one-shot CLI transport conservatively.
5. After the provider startup handshake, the daemon returns `AgentSessionV2`. Electron main tracks
   the session and relays its validated SSE envelopes through the narrow preload bridge.
6. Approval and question requests go through the interaction broker; command IDs, session IDs, and
   response correlations are validated before provider dispatch.
7. The renderer projects provider-neutral envelopes into bounded activity items. Terminal events
   close the live stream, while normalized v2 history and lineage remain available through the
   durable execution graph.

The unversioned `POST /sessions` and v1 SSE flow remain as the legacy compatibility API; see
[protocol-v1.md](protocol-v1.md).

## Sessions

```ts
type AgentSession = {
  id: string; // daemon-generated UUID; never a process id
  provider: ProviderId;
  cwd: string;
  prompt: string;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  providerSessionId?: string; // the CLI's own session/thread id, once known
  startedAt: string;
  completedAt?: string;
};
```

A session's compatibility `AgentSession` record lives behind a `SessionStore` interface. Production
uses `FileSessionStore`; active records recovered after a restart are marked failed. Live provider
handles and bounded SSE replay windows remain non-persistable runtime state inside `SessionManager`.
Protocol v2 stores normalized history, lineage, tombstones, and continuation locks separately in
`FileExecutionGraphStore`, recovering active executions as interrupted. Legacy v1 replay history is
not durable. A v1 caller may still supply a provider-native `resumeProviderSessionId` after a
restart; whether it resumes is determined by the provider, not by an in-process AgentDock record.
See [daemon.md#session-lifecycle-sessionmanager-sessionstore](daemon.md#session-lifecycle-sessionmanager-sessionstore).

## Provider capabilities

In protocol v1, `ProviderStatus.capabilities` lets a downstream client ask "does this provider
support X" instead of writing `if (provider.id === 'claude')`. See
[providers.md#provider-capabilities](providers.md#provider-capabilities) for the full
`ProviderCapabilities` shape and exactly which fields are true for Claude and Codex and why. The
daemon enforces `capabilities.resume` server-side too: `POST /sessions` rejects a
`resumeProviderSessionId` for a provider whose capability is `false` with `400`, rather than
silently ignoring it.

Protocol v2 replaces booleans with scoped, evidence-backed support records while preserving opaque
unknown IDs and provider-neutral negotiation. The canonical IDs, evidence rules, and safe defaults
are fixed in [capability-security-v2.md](capability-security-v2.md#canonical-capability-catalog).
The v1 `ProviderStatus` schema intentionally remains unchanged. `/v2/providers` returns the
separate `ProviderStatusV2`: it uses a provider's optional rich v2 manifest when present and derives
a conservative `legacy-one-shot` manifest from v1 capabilities otherwise.

## Process management

For the current one-shot CLI adapters,
`packages/agent-runtime/src/providers/common/run-session.ts` is the one place every provider's
spawn/parse/normalize lifecycle happens. It:

- validates the working directory exists before spawning anything
- resolves the executable via `findExecutable` (PATH lookup + a curated fallback directory list,
  see [providers.md#executable-discovery](providers.md#executable-discovery)), never from a
  request-supplied path
- spawns with `child_process.spawn`, `shell: false`, and an argv array: prompts are **never**
  interpolated into a shell string
- spawns with a sanitized, default-deny environment built by
  `packages/agent-runtime/src/process/provider-environment.ts`, never the daemon's raw
  `process.env` — see [SECURITY.md](../SECURITY.md#provider-subprocess-environment-isolation) for
  the exact allowed-key matrix and its one known gap (the MCP stdio server subprocess itself is a
  separate spawn path not yet covered, tracked in #103)
- reads stdout through `readLines` (`process/line-reader.ts`), which tolerates a JSON line split
  across chunk boundaries and multiple JSON lines arriving in one chunk, and caps a single line at
  10MB to bound memory
- counts stderr bytes without decoding, persisting, logging, or surfacing their contents; a
  non-zero exit logs only bounded numeric exit metadata
- kills the whole process tree on cancellation, never just the direct child, see
  [daemon.md#cancellation-and-process-tree-kill](daemon.md#cancellation-and-process-tree-kill)
- always terminates the event stream with exactly one of `session.completed` / `session.failed` /
  `session.cancelled`, so callers never have to guess whether more events might still arrive

Rich SDK/app-server transports use a separate provider-neutral bidirectional supervisor. It
owns startup and command-acceptance timeouts, frame/event/stderr/queue bounds, interaction
correlation and provider-native fail-closed resolution, interrupt versus close semantics,
accepted-work state, mandatory process-tree reap fallback, and the terminal-event invariant.
`FakeProvider` and native transport fixtures verify this runtime path. Production Claude uses the
pinned Agent SDK for reviewed API-key/Bedrock/Vertex/Foundry authentication, while Codex uses its
validated app-server transport. Both retain their local one-shot CLI compatibility paths.

## Daemon discovery and lifecycle

Electron spawns the daemon as a sidecar child process and reads its port + token from a discovery
file the daemon writes once it's listening; see [SECURITY.md](../SECURITY.md#local-auth-token) for
why a file handoff instead of a network one, and [daemon.md](daemon.md) for the full operational
detail (routes, duplicate-start check and race caveat, shutdown behavior).

This is explicitly **not** the only way to run it: `pnpm daemon` starts the exact same server
standalone, and nothing in the daemon's code depends on Electron being present. A future
"persistent daemon" mode (survives Electron closing, perhaps installed as a background
service/launch agent) is a pure lifecycle change: the HTTP API and desktop client would not need
to change at all.

## Deliberate scope boundaries

These boundaries are intentional and are also reflected in
[CONTRIBUTING.md](../CONTRIBUTING.md#scope):

- **Local, bounded persistence only.** AgentDock persists redacted compatibility metadata,
  normalized v2 execution history/lineage, audit and trust state, and selected workflow metadata.
  It does not provide a hosted database, account sync, or a product backend.
- **Best-effort duplicate-daemon rejection per app id** (see [Project identity](#project-identity)
  and [daemon.md#duplicate-start-behavior](daemon.md#duplicate-start-behavior)): a later sequential
  start sees the live pid and fails, but simultaneous daemon starts are not excluded by an atomic
  lock. The packaged Electron app has its own single-instance lock; standalone hosts that require a
  hard guarantee must add equivalent coordination.
- **No hosted credential UI.** Claude API/cloud credentials come only from the daemon environment;
  AgentDock never collects, stores, or displays them. Claude subscription OAuth remains on the
  separately installed local CLI path and is never admitted to the SDK transport.
- **No auto-update, telemetry, or crash reporting.** Each adds its own trust and privacy surface
  that doesn't belong in boilerplate meant to be forked as-is.
- **Packaging targets Windows only**, see [packaging.md#platform-matrix](packaging.md#platform-matrix).
- **No installer signing**, see [packaging.md#unsigned-installer-and-smartscreen](packaging.md#unsigned-installer-and-smartscreen).

## Project identity

**AgentDock is an open-source boilerplate containing a reusable local runtime and internal typed
workspace SDK boundaries. It is intended to be forked/customized today**, not consumed as a set of
independently-installable npm packages. This is a decision, written down here so it doesn't have to
be inferred (AD-03): every workspace package is `private: true`. The three library packages point
`main`/`types` at raw TypeScript for workspace use; the desktop app instead points `main` at its
built `dist-electron/main.js` and has no `types` field. None has a publish-oriented `files` contract,
so nothing here is set up to be `npm install`-ed from outside this workspace.

That doesn't make the internal boundaries decorative. `packages/shared`'s types and Zod schemas,
`AGENT_DOCK_PROTOCOL_VERSION`, and `@agent-dock/client`'s typed surface exist to keep the daemon,
the client, and the desktop app honest with each other _inside_ this repo (and inside a fork of
it), a change to the wire format has to go through one shared definition, not get silently
duplicated three ways. Protocols v1 and v2 govern the daemon/client pair as shipped together in this
repository; they are not yet a package-versioned promise to arbitrary external consumers.

External npm publication is a real option later, but a deliberately deferred one: see
[client-sdk.md](client-sdk.md#using-it-from-a-workspacefork-not-from-outside-the-repo) for exactly
what would need to change first (a `dist`-based `exports` map, a `files` allowlist, `zod` moved to
a peer dependency in `shared`, dropping `private`), and don't treat "it looks like a normal typed
package" as an invitation to publish it without that work.

## Known limitations

- **Electron's own graceful-shutdown path is best-effort on Windows**, see
  [daemon.md#shutdown](daemon.md#shutdown).
- **Windows Job Object behavior is exercised in the Windows workflow; POSIX process-group behavior
  is exercised in Linux CI, while macOS remains unverified**, see
  [SECURITY.md](../SECURITY.md#process-hygiene).

If you're extending this project, [DEVELOPMENT.md](../DEVELOPMENT.md) is the practical
"I want to change X, start here" guide; this file is the map, not the walkthrough.
