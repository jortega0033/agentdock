# Architecture

## Component diagram

```
┌─────────────────────────┐
│   Renderer (React)        │   window.agentDock.* — five narrow IPC capabilities only.
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
│                             │   usable from any Node process. See docs below.
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

`packages/shared` sits underneath all of this: it's the one place `ProviderId`, `ProviderStatus`,
`ProviderCapabilities`, `AgentSession`, `AgentEvent`/`AgentEventEnvelope`, the protocol version,
and the Zod request/response schemas are defined, so the daemon, `@agent-dock/client`, and the
desktop app can never drift from what agent-runtime actually produces. `packages/client` depends
on `packages/shared` only — never on `agent-runtime` or `apps/daemon` — so the dependency graph
stays acyclic: `shared ← agent-runtime ← daemon`, and separately `shared ← client ← desktop`.

**The renderer never calls the daemon's HTTP+SSE API directly** — only Electron's main process
does. This isn't a style preference; a renderer `fetch()` to the daemon cannot actually succeed
(see [security.md](security.md#renderer-never-talks-to-the-daemon-directly) for why — it comes down
to the daemon correctly never answering a CORS preflight, which is also exactly what keeps a
malicious webpage out). The daemon's HTTP+SSE API itself is unchanged and still the integration
point for any *other* client — `curl`, a future CLI, a VS Code extension — none of which are
subject to browser CORS in the first place.

## Why a separate daemon instead of running the CLI logic in Electron's main process

Three reasons, in order of importance:

1. **A malicious webpage should never be able to run a coding agent on your machine.** Keeping
   agent execution behind an HTTP+token boundary (see [security.md](security.md)) is a much
   smaller, more auditable surface than "whatever the renderer/main process can reach."
2. **The daemon has to outlive one specific UI.** A VS Code extension, a CLI client, or a second
   desktop shell should all be able to talk to the same daemon over the same four-endpoint API
   without re-implementing process management.
3. **Testability.** `pnpm daemon` runs and can be curled directly, with no Electron, no display
   server, and no GUI test harness required.

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

A session's `AgentSession` record lives behind a `SessionStore` interface — see
[SessionStore](#sessionstore) below — while its live process handle and buffered event history are
kept as separate, non-persistable runtime state inside `SessionManager`
([apps/daemon/src/session-manager.ts](../apps/daemon/src/session-manager.ts)). **Persistence is
deliberately out of scope**: it adds a real design surface (schema, migrations, what happens to a
resumed session after a crash) that both the original MVP spec and the v0.2 backbone milestone
explicitly deferred. Restarting the daemon loses every session and its event history —
`resumeProviderSessionId` lets you continue a provider-native thread, but only within the same
daemon process's lifetime.

## Protocol v1

`AGENT_DOCK_PROTOCOL_VERSION` (`packages/shared/src/protocol.ts`, currently `1`) is the daemon's
public contract version, reported at `GET /health`. It covers two things together: the HTTP+SSE
API shape and the `AgentEvent`/`AgentEventEnvelope` wire format. `@agent-dock/client` checks it
automatically before the first real request (see [Client SDK](#client-sdk)) and throws
`ProtocolMismatchError` on a mismatch — deliberately exact-match comparison, not a semver range or
a negotiation handshake, since this is a boilerplate shipping one daemon and one bundled client
together, not a multi-version ecosystem yet.

Every provider adapter normalizes its CLI's native JSONL into the same `AgentEvent` union (defined
once, in `packages/shared/src/events.ts`) — this is the frozen v1 contract:

```ts
type AgentEvent =
  | { type: 'session.started'; sessionId: string; provider: ProviderId; providerSessionId?: string }
  | { type: 'status'; status: string; detail?: string }
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.message'; text: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'tool.started'; toolName: string; toolCallId?: string; input?: unknown }
  | { type: 'tool.completed'; toolName?: string; toolCallId?: string; result?: unknown; isError?: boolean }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cost?: number }
  | { type: 'error'; code?: string; message: string; recoverable: boolean }
  | { type: 'session.completed'; providerSessionId?: string }
  | { type: 'session.failed'; message: string }
  | { type: 'session.cancelled' };
```

What actually crosses the daemon → client boundary is `AgentEventEnvelope` — an `AgentEvent` with
two fields the daemon stamps on once, when it records and broadcasts the event (never something a
provider adapter produces):

```ts
type AgentEventEnvelope = AgentEvent & {
  sequence: number; // per-session, zero-based, monotonically increasing — the SSE `id:` field too
  timestamp: string; // ISO 8601, when the daemon observed the event (not when the CLI produced it)
};
```

**Ordering guarantees**, upheld by `SessionManager` and enforced structurally by
`runProviderSession()` (see [Process management](#process-management)):

- events within one session are emitted in `sequence` order, and every subscriber — live or
  replayed via `Last-Event-ID` — sees the same `sequence`/`timestamp` for the same event
- exactly one of `session.completed` / `session.failed` / `session.cancelled` occurs per session
- that terminal event is always last — nothing is ever emitted after it
- `@agent-dock/client`'s `sessions.events()` iterator ends when the terminal event arrives; it does
  not auto-reconnect (see [Client SDK](#client-sdk) for why a bare retry is sufficient instead)

Runtime validation: `packages/shared/src/schemas.ts` exports `agentEventEnvelopeSchema` (and
`providerStatusSchema`, `providerCapabilitiesSchema`, `agentSessionSchema`, `healthResponseSchema`)
— Zod schemas mirroring every public type field-for-field. `@agent-dock/client` validates every SSE
frame and every JSON response against these before handing it to a caller, so a daemon-side
contract violation surfaces as a typed `ValidationError`, never a silent shape mismatch.

**What's public/stable**: the `AgentEvent`/`AgentEventEnvelope` union, `ProviderStatus`,
`ProviderCapabilities`, `AgentSession`, the Zod schemas above, and the four route shapes
(`/health`, `/providers`, `/sessions`, `/sessions/:id/events`) — all versioned together under
`AGENT_DOCK_PROTOCOL_VERSION`. **What's internal**: `SessionManager`'s `RuntimeState`, the
`SessionStore` interface's exact method signatures, and anything under `providers/*/parser.ts` —
none of it is exported from a package's public entry point, and none of it is what
`AGENT_DOCK_PROTOCOL_VERSION` promises stability for.

The desktop UI renders `AgentEvent` with a single `switch (event.type)`
([apps/desktop/src/components/EventLog.tsx](../apps/desktop/src/components/EventLog.tsx)) — it
never branches on which provider produced an event. Provider-specific parsing lives entirely in
`packages/agent-runtime/src/providers/*/parser.ts` and never leaks past that package (the provider
contract suite — see [providers.md](providers.md#provider-contract-tests) — asserts this directly:
every event a real fixture run produces must have a `type` from the `AgentEvent` union, nothing else).

`thinking.delta` is only ever emitted for reasoning content the CLI itself already puts in its
public, user-visible output stream (Claude Code's `thinking` content blocks; Codex's `reasoning`
items). Neither adapter attempts to reconstruct or expose anything the CLI treats as private.

## Client SDK

`@agent-dock/client` (`packages/client`) is the typed way anything talks to the daemon —
Electron's main process, a future Node CLI, a future VS Code extension. It has no Electron or
browser dependency (Node 18+'s global `fetch` is all it needs), and its `package.json` declares an
`"exports"` map with only `"."` — there is no `@agent-dock/client/src/internal/...` to reach into,
by construction, not just convention.

Design decisions worth knowing if you're extending it:

- **The compatibility check is lazy, not in the constructor.** `new AgentDockClient(...)` is
  synchronous and does no I/O; the first call to `health()` *or any other method* runs the
  `GET /health` + protocol-version check once, caches the result for the client's lifetime, and
  re-tries on the next call if it failed (a daemon still starting up shouldn't permanently poison a
  client instance created a moment too early).
- **No automatic reconnect.** `sessions.events()` opens exactly one SSE connection and ends when
  the daemon closes it (the session's terminal event) or the caller's `AbortSignal` fires. If the
  connection drops for any other reason, the generator throws and the caller decides whether to
  retry — see [Protocol v1](#protocol-v1) for why a bare retry is already a correct, complete
  "reconnect": the daemon replays its full stored event history to a fresh subscriber.
- **Errors are typed by transport-level category, never by sniffing a message string.**
  `DaemonUnavailableError` (fetch itself failed), `UnauthorizedError` (401), `SessionNotFoundError`
  / `ProviderUnavailableError` (404 on the corresponding route), `ValidationError` (400, or a
  response/SSE frame that fails its Zod schema), `ProtocolMismatchError`, and `DaemonError` (any
  other non-2xx) — seven classes, chosen to match what the v0.2 spec asked to be able to
  distinguish, not expanded further without a concrete need.
- **The token never appears in a URL.** `sessions.events()` sends it as an `Authorization` header
  like every other call, via `fetch` + a manual `ReadableStream` reader (`src/sse.ts`) rather than
  the browser `EventSource` API, which can't set custom headers at all.

Electron's main process (`apps/desktop/electron/main.ts`) owns exactly one `AgentDockClient`
instance, constructed once the daemon's discovery file is readable. It's the only thing in the
desktop app that imports `@agent-dock/client` — the renderer only ever reaches it through the five
IPC handlers in `main.ts`, and the preload bridge (`electron/preload.ts`) exposes those five
functions and nothing shaped like a generic request passthrough. See
[security.md](security.md#renderer-never-talks-to-the-daemon-directly) for the full boundary.

## Provider capabilities

`ProviderStatus.capabilities` (`packages/shared/src/provider.ts`) is what lets a downstream client
ask "does this provider support X" instead of writing `if (provider.id === 'claude')`:

```ts
interface ProviderCapabilities {
  resume: boolean;
  cancellation: boolean;
  tools: boolean;
  usage: boolean;
  thinking: boolean;
}
```

Each adapter declares its own (`providers/claude/capabilities.ts`, `providers/codex/capabilities.ts`)
based on what that adapter actually implements — never a claim about the underlying model. See
[providers.md#provider-capabilities](providers.md#provider-capabilities) for exactly which fields
are true for Claude and Codex and why. The daemon enforces `capabilities.resume` server-side too:
`POST /sessions` rejects a `resumeProviderSessionId` for a provider whose capability is `false`
with `400`, rather than silently ignoring it.

## SessionStore

`SessionManager` depends on a `SessionStore` interface (`apps/daemon/src/session-store.ts`), not
directly on a `Map`:

```ts
interface SessionStore {
  create(session: AgentSession): void;
  get(id: string): AgentSession | undefined;
  update(id: string, session: AgentSession): void;
  delete(id: string): void;
  list(): AgentSession[];
}
```

`SessionManager → SessionStore → MemorySessionStore` — `MemorySessionStore` is the only
implementation and the daemon's default, and it's fully synchronous (so is the interface — see the
comment in session-store.ts for why an untested `Promise<void>` union isn't added speculatively).
**Persistence remains explicitly out of scope for this milestone**: swapping in a real store (e.g.
a future `SQLiteSessionStore`) should only require implementing this interface, not touching
`SessionManager`'s lifecycle logic — but that interface would likely need to become async at that
point, which is a deliberate, larger change left for when it's actually needed.

The store owns only `AgentSession` records. A session's live process handle (an `AsyncGenerator`
plus a `cancel()` closure — not serializable at all) and its buffered event history stay as
separate runtime-only state inside `SessionManager`, specifically so `SessionStore` never grows
into an accidental event-history database with its own schema-design questions.

## Process management

`packages/agent-runtime/src/providers/common/run-session.ts` is the one place every provider's
spawn/parse/normalize lifecycle happens. It:

- validates the working directory exists before spawning anything
- resolves the executable via `findExecutable` (PATH lookup + a curated fallback directory list —
  see [providers.md](providers.md#executable-discovery)), never from a request-supplied path
- spawns with `child_process.spawn`, `shell: false`, and an argv array — prompts are **never**
  interpolated into a shell string
- reads stdout through `readLines` (`process/line-reader.ts`), which tolerates a JSON line split
  across chunk boundaries and multiple JSON lines arriving in one chunk, and caps a single line at
  10MB to bound memory
- captures stderr separately, capped at 200KB, and only surfaces it on a non-zero exit
- on POSIX, spawns the child detached (its own process group) and kills the whole group on
  cancellation; on Windows, uses `taskkill /T /F` to kill the whole tree — either way, cancelling a
  session can't leave a grandchild process (e.g. a shell command the CLI itself launched) orphaned
- always terminates the event stream with exactly one of `session.completed` / `session.failed` /
  `session.cancelled`, so callers never have to guess whether more events might still arrive

## Daemon discovery and lifecycle

For the MVP, Electron spawns the daemon as a sidecar child process
(`apps/desktop/electron/main.ts`) and reads its port + token from a discovery file the daemon
writes to `os.tmpdir()/agent-dock/daemon.json` (mode `0600`) once it's listening — see
[security.md](security.md#local-auth-token) for why a file handoff instead of a network one.

This is explicitly **not** the only way to run it: `pnpm daemon` starts the exact same server
standalone, and nothing in the daemon's code depends on Electron being present. A future
"persistent daemon" mode (survives Electron closing, perhaps installed as a background
service/launch agent) is a pure lifecycle change — the HTTP API and desktop client would not need
to change at all.

`pnpm daemon` and `pnpm --filter @agent-dock/daemon dev` both run the daemon's TypeScript source
directly through `tsx` — fine for development, since `packages/shared` and `packages/agent-runtime`
intentionally publish their source (not a pre-built `dist/`) as their package.json `main`, so tsx
and Vite pick up changes with no separate build step. That means `apps/daemon`'s own `pnpm build`
can't just run `tsc`: the compiled output would still `import` those two packages by name, and a
plain `node dist/index.js` — no tsx, no loader — can't resolve a `.ts` file through a bare package
specifier. **This was an actual bug, not just a theoretical risk**: it was caught by literally
running the packaged-mode code path (`node dist/index.js` after `pnpm build`), which failed with
`ERR_MODULE_NOT_FOUND`. The fix (`apps/daemon/scripts/build.mjs`) bundles the daemon and every
workspace/npm dependency it imports into one self-contained `dist/index.js` via esbuild —
verified afterward by running that exact file with plain `node` and by relaunching the packaged
(non-dev) Electron app end to end.

## Packaging

`apps/desktop/electron-builder.yml` configures [electron-builder](https://www.electron.build/) to
produce a Windows NSIS installer (`pnpm package:win`) into `dist-packages/` at the repo root —
deliberately not under `apps/desktop/dist/` or `dist-electron/`, so installer output never mixes
with the Vite/esbuild build artifacts those two directories hold. See the README's
[Packaging](../README.md#packaging-windows) section for the exact commands and output layout, and
[security.md](security.md#electron-hardening) for what packaging does and doesn't change about the
threat model (short version: nothing — the daemon's auth/Origin model is identical whether the app
is running from source or installed).

Three things had to be figured out, not assumed, to get from "electron-builder exits 0" to "the
installed app actually works":

1. **Where the daemon bundle lives once packaged.** `resolveDaemonEntry()`
   (`apps/desktop/electron/resolve-daemon-entry.ts`) is a pure function (no Electron import, fully
   unit-testable) with three cases: dev server → run source through `tsx`; packaged
   (`app.isPackaged`) → `process.resourcesPath/daemon/index.js`, shipped as an electron-builder
   `extraResource` outside `app.asar` (see [Runtime layout](../README.md#runtime-layout-once-packaged)
   in the README for why outside asar specifically); unpacked-but-not-packaged production build →
   the daemon's own `dist/index.js` next to its source, falling back to `tsx` if that hasn't been
   built yet. Tests assert packaged mode never falls through to the tsx/source path, since neither
   exists in a packaged build.
2. **What electron-builder should treat as a runtime dependency.** `react`, `react-dom`, `zod`, and
   `@agent-dock/shared` are all fully inlined into `dist/` and `dist-electron/main.js` at build time
   (Vite for the renderer, esbuild via vite-plugin-electron for main) — none of them are read from
   `node_modules` once built. They live in `package.json`'s `devDependencies`, not `dependencies`,
   specifically so electron-builder's automatic production-dependency resolution (which inspects
   `dependencies` and copies the matching `node_modules` trees into the package independently of the
   `files` config) doesn't embed a second, unused, unbundled copy of each — this was caught by
   unpacking a real built `app.asar` and finding `node_modules/@agent-dock/shared` inside it despite
   an explicit `files` exclude.
3. **A shutdown-path crash only a real packaged run surfaced.** Closing the window while the daemon's
   `exit` event was still in flight called `webContents.send()` on an already-destroyed window,
   which throws — uncaught, from inside a `child_process` event handler, it took down the whole main
   process (observed as a native "Error"-titled window and stray helper processes instead of a clean
   quit). Every push to the renderer now goes through `sendToRenderer()`
   (`apps/desktop/electron/send-to-renderer.ts`, also Electron-import-free and unit-tested), which
   checks `isDestroyed()` on both the window and its `webContents` first. Re-verified by repeating
   the exact close sequence against a rebuilt package: clean exit, zero leftover processes.

The desktop app also takes Electron's `app.requestSingleInstanceLock()` — a second launch attempt
focuses the existing window instead of opening a second one, which would otherwise spawn a second
daemon and lose the race against the first over the shared discovery file (see
[security.md](security.md#single-daemon-instance)). Verified live: launching the packaged exe a
second time while the first was running left the process count and the daemon's port unchanged.

## Known limitations / v0.2 directions

- **No persistence.** Sessions and their event history are lost on daemon restart, by design (see
  [Sessions](#sessions) above).
- **One daemon per machine, enforced.** The discovery file is a fixed path, so the daemon refuses
  to start if a live daemon already owns it (see [security.md](security.md#single-daemon-instance))
  rather than silently racing another instance for it. A genuine multi-instance story (e.g. running
  two independent copies of an app built on this boilerplate side by side) would need a
  per-instance discovery path — not implemented, since nothing currently needs it.
- **No API-key/cloud provider mode yet.** Everything here assumes a locally authenticated CLI.
- **Electron's own graceful-shutdown path is best-effort on Windows.** Node's `child.kill()` maps
  to `TerminateProcess` on Windows, which does not deliver a real `SIGTERM` the daemon's own
  shutdown handler can catch — see the `killDaemon()` comment in `electron/main.ts` for the
  mitigation (cancelling the one active session over HTTP before killing the child) and its limits.
  **Reconfirmed against the packaged app**: the daemon process itself always dies with the app (no
  orphaned process, verified across several close/relaunch cycles), but its discovery file can be
  left stale rather than cleaned up — harmless, since the next daemon start only trusts a discovery
  file whose recorded pid is still alive (see [security.md](security.md#single-daemon-instance)) and
  overwrites it otherwise.
- **Process-tree cancellation was empirically verified on Windows only** (a real grandchild
  process, simulating a CLI-launched tool subprocess, was confirmed killed within ~1s of
  cancellation). The POSIX path uses the standard, well-documented process-group mechanism but
  wasn't re-verified on macOS/Linux in this audit for lack of a machine to test on.
- **Packaging targets Windows only.** `electron-builder.yml` configures an NSIS installer and
  nothing else; macOS (`dmg`) and Linux (`AppImage`/`deb`) targets are straightforward additions to
  the same config but haven't been added or tested — see the README's
  [Platform support](../README.md#platform-support) matrix. No code assumes Windows specifically
  (the process-management layer already branches on `process.platform` where it matters), but that's
  not the same claim as "verified".
- **No installer signing.** The NSIS installer and the packaged `AgentDock.exe` are unsigned —
  `electron-builder`'s log shows signing steps being skipped for lack of a certificate. Expect
  Windows SmartScreen to warn on first run of an unsigned installer; that's expected for an
  unsigned OSS boilerplate build, not a packaging bug, and code signing was explicitly out of scope
  for this milestone.
