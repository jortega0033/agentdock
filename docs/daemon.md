# Daemon

`apps/daemon` is a standalone Fastify HTTP+SSE server. It has no Electron dependency and no
required parent process: `pnpm daemon` runs and can be `curl`'d directly, with no display server
or GUI test harness required.

## Running it standalone

```bash
pnpm daemon
```

This runs `apps/daemon/src/index.ts` directly through `tsx` (`pnpm --filter @agent-dock/daemon run
start`). On startup it prints the URL it's listening on and where it wrote its discovery file. In
another terminal:

```bash
curl http://127.0.0.1:<port>/health
```

`pnpm --filter @agent-dock/daemon run dev` does the same thing with `tsx watch` for auto-restart on
source changes.

## Binding and port

The daemon binds `127.0.0.1` only, never `0.0.0.0`, and never the IPv6 loopback (`::1`) either; it
answers on IPv4 only (`apps/daemon/src/index.ts`). By default it asks the OS for an ephemeral port
(`AGENT_DOCK_PORT` unset or `0`); set `AGENT_DOCK_PORT=<port>` to request a fixed one. Whichever
port it ends up on is written to the discovery file and printed to stdout: there's no way to know
it in advance otherwise.

## Discovery file

The daemon writes `{ port, token, pid, startedAt }` to `os.tmpdir()/agent-dock/<app-id>.json` once
it's listening (the file mode `0600`, and the containing directory created/verified mode `0700`
on POSIX (see [SECURITY.md](../SECURITY.md#local-auth-token) for why, including the Windows
caveat)). This is a **filesystem handoff, not a network one**: a client reads the file directly
(it has to be running as the same OS user), rather than the daemon ever broadcasting the token
over the network.

`<app-id>` defaults to `agent-dock` and is set via `AGENT_DOCK_APP_ID`; see
[Single-instance behavior](#single-instance-behavior) below for why it exists and how it's
validated.

## Auth token

Every route except `GET /health` requires `Authorization: Bearer <token>`, checked with a
timing-safe comparison. The full threat model and reasoning live in
[SECURITY.md](../SECURITY.md); this file only covers operational behavior, not why it's safe.

## Single-instance behavior

The daemon refuses to start if its app id's discovery file's recorded pid is still alive
(`apps/daemon/src/discovery-file.ts#assertNoLiveDaemon`):

```
Error: another agent-dock daemon (app id "agent-dock") is already running (pid <pid>,
discovery file <path>). Only one daemon per app id is supported at a time, stop it first.
```

This is a **per app id** guarantee, not a machine-global one. `AGENT_DOCK_APP_ID` (default
`agent-dock`) namespaces the discovery filename, so two different products built on this
boilerplate, each launched with its own app id, run their own daemons side by side without
colliding; two daemons started with the _same_ app id still race for the same file and the second
one refuses to start, which is the actual invariant this exists to guarantee. The app id is
validated before it's used to build a path: 1–64 characters, letters/digits/`-`/`_` only, must
start with a letter or digit: rejected outright (the daemon fails to start with a clear error)
rather than sanitized, so it can't be used for path traversal or to point outside the discovery
directory entirely.

A discovery file whose recorded pid is no longer running (a stale file left by a crash or
force-kill) is treated as safe to overwrite: nothing is listening at that pid anymore, and a
corrupt/partially-written file is treated the same way. A stale file for one app id never affects
another app id's daemon, since they're different files. See
[troubleshooting.md](troubleshooting.md#daemon-fails-to-start) if you hit this unexpectedly.

## Routes

| Route                              | Auth     | Behavior                                                                                                                                                                                                                               |
| ---------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                      | none     | `{ status: 'ok', uptimeSeconds, protocolVersion: 1, supportedProtocolVersions: [1, 2] }`                                                                                                                                               |
| `GET /providers`                   | required | `{ providers: ProviderStatus[] }`, runs each adapter's `detect()`                                                                                                                                                                      |
| `GET /providers/:providerId`       | required | One `ProviderStatus`, or `404` for an unregistered id                                                                                                                                                                                  |
| `POST /sessions`                   | required | Body validated against `createSessionRequestSchema`. `400` for an unknown provider, a `resumeProviderSessionId` on a provider whose `capabilities.resume` is `false`, or a `cwd` that doesn't exist. `201` + `AgentSession` on success |
| `GET /sessions/:sessionId`         | required | Current `AgentSession` record, or `404`                                                                                                                                                                                                |
| `GET /sessions/:sessionId/events`  | required | SSE stream, see [Event history and replay](#event-history-and-replay) below                                                                                                                                                            |
| `POST /sessions/:sessionId/cancel` | required | `202` + `{ status: 'cancelling' }`. `404` for an unknown id **or** a session that's already terminal: cancelling a finished session is never reported as a success                                                                     |
| `POST /sessions/cancel-all`        | required | Cancels every in-flight v1 session. Narrow and single-purpose (not a generic process-control endpoint): exists specifically for Electron's shutdown path, see [Shutdown](#shutdown) below. `202` + `{ status: 'cancelling' }`          |
| `DELETE /sessions/:sessionId`      | required | Cancels if still running, then removes the record. `204`, or `404`                                                                                                                                                                     |

Every request body/param is Zod-validated before touching any handler logic
(`packages/shared/src/schemas.ts`); invalid input gets a `4xx` with a short JSON error message,
never a stack trace. See the full request-validation and error-handler behavior in
[SECURITY.md](../SECURITY.md#request-validation).

Wire shapes (route bodies, the `AgentEvent`/`AgentEventEnvelope` format) are documented in
[protocol-v1.md](protocol-v1.md), not duplicated here.

Protocol v2 is additive: authenticated `/v2/providers` and `/v2/sessions` routes expose scoped
capability records, negotiate before starting provider work, stream validated v2 envelopes, and
dispatch accepted interactive commands through
`POST /v2/sessions/:sessionId/commands`. The unversioned routes above remain the v1 compatibility
and rollback path. The complete v2 route, status, and wire-shape tables live in
[protocol-v2.md](protocol-v2.md).

## Session lifecycle: SessionManager, SessionStore

`SessionManager` (`apps/daemon/src/session-manager.ts`) orchestrates both legacy and interactive
runtime handles: it creates sessions through the provider registry, consumes normalized event
streams, and keeps the `AgentSession` record's status current as terminal events arrive. The v2
facade owns the frozen capability selection, execution/turn IDs, normalized v2 replay window, and
v2 lifecycle projection.

The `AgentSession` record itself lives behind a `SessionStore` interface
(`apps/daemon/src/session-store.ts`):

```ts
interface SessionStore {
  create(session: AgentSession, protocolVersion?: 1 | 2): void;
  get(id: string): AgentSession | undefined;
  update(id: string, session: AgentSession): void;
  delete(id: string): void;
  list(): AgentSession[];
  protocolVersionOf(id: string): 1 | 2 | undefined;
}
```

`MemorySessionStore` remains available for isolated tests and embedders. Production uses the
versioned `FileSessionStore`, which atomically persists compatibility metadata without prompts or
raw error diagnostics and marks legacy active-at-restart records failed. Protocol v2 additionally
uses
`FileExecutionGraphStore` as the authoritative durable metadata/history store; it recovers active
executions as `interrupted` and owns lineage retention, tombstones, pagination, and continuation
locks. All writes remain synchronous so metadata is durable before provider dispatch.

The compatibility store owns only the `AgentSession` record. A session's live legacy or interactive
provider handle and bounded SSE replay window remain runtime state inside `SessionManager`; durable
normalized v2 events are stored separately by the execution graph.

For an interactive v2 transport, creation resolves only after the provider startup handshake. The
common supervisor enforces 1 MiB provider-frame and normalized-event limits, a 5,000-event / 16 MiB
provider queue, a 200 KiB stderr diagnostic cap, at most 32 pending interactions, 30-second
startup/command acceptance, five-minute interaction deadlines, a five-second graceful-close bound,
mandatory process-tree hard-stop/reap fallback, and exactly one terminal event. The production
Claude and Codex adapters do not expose this transport yet; only `FakeProvider` drives it in
deterministic tests while native adapters remain gated by issue #8.

The manager registers each startup before awaiting that handshake. Client disconnect, direct
cancellation, cancel-all, and daemon shutdown abort and await pending starts; shutdown also closes
the admission gate before taking its cancellation snapshot. A provider must honor the startup
abort signal by reaping its host before rejecting.

Interactive command dispatch is serialized per session. A canonical command ID/payload retry
shares the original result; conflicting reuse returns `409 command_id_conflict`. Admission is
capped at 64 pending commands or 1 MiB of pending command JSON and returns
`429 session_backpressure` when full. The settled deduplication ledger retains at most 1,024
entries. `session.interrupt` invokes the transport's interrupt operation and keeps the session
available when supported; it is not cancellation or close.

## Event history and replay

`SessionManager` buffers every session's emitted `AgentEventEnvelope`s in memory, capped at 5,000
per session (`MAX_STORED_EVENTS_PER_SESSION`). `GET /sessions/:id/events`:

1. Writes an SSE `:ok` comment immediately, then the standard `text/event-stream` headers.
2. Replays every buffered event from `sequence` 0 (or from `Last-Event-ID + 1`, if that header was
   sent) as `id: <sequence>\nevent: <type>\ndata: <json>\n\n` frames.
3. Keeps the connection open and streams new events live as they arrive.
4. Closes the response itself once a terminal event (`session.completed` / `session.failed` /
   `session.cancelled`) is written: the client never has to guess whether more events might still
   arrive.

Past 5,000 buffered events, further events are no longer available to replay to a _new_
subscriber, but they are always still delivered live to every currently-connected subscriber,
including the terminal event: the cap only ever bounds replay history, never live delivery.
`sequence` is stamped from a counter independent of the history buffer's length, so it keeps
incrementing past the cap rather than resetting or gapping. The daemon logs a warning once history
stops growing, rather than growing memory unbounded. This is regression-tested directly in
`apps/daemon/test/session-manager.test.ts` (drives a session past the cap and asserts the terminal
event still arrives live). See [protocol-v1.md#ordering-guarantees](protocol-v1.md#ordering-guarantees)
for the full ordering contract this upholds.

Protocol v2 keeps a separate normalized replay window capped at 5,000 events or 16 MiB, evicting
oldest frames first. A resume cursor outside `[earliestSequence, nextSequence]` returns
`409 replay_gap`. Each connected v2 subscriber also gets an independent 256-event / 4 MiB write
queue. Backpressure on one connection cannot stall the provider or another subscriber. A terminal
event closes only after queued frames drain; subscriber overflow drops that connection's queue and
ends it with `stream.error` / `stream_overflow`, including the last sequence handed to the socket
when available.

## Session retention

Once a session reaches a terminal state, its runtime state (buffered event history, listener set)
isn't deleted immediately: a client that hasn't seen the terminal event yet still needs to
replay/receive it. But retaining every completed session forever would grow memory without bound
for a long-lived daemon whose client never calls `DELETE`, so `SessionManager` keeps only the most
recently completed 50 sessions' runtime state (`MAX_RETAINED_COMPLETED_SESSIONS`), evicting the
oldest (and its `AgentSession` record with it) once a 51st completes. This is a simple bound, not
a cache-replacement policy: the daemon is local and single-user, and a bound that's simple to
reason about was preferred over one that's optimal. `DELETE /sessions/:id` removes a session
immediately regardless of this cap, and removes it from the retention tracking too.

`SessionManager.cancel()` also refuses to report success for a session that's already terminal
(see the routes table above), so a stale UI action against a long-finished session gets `404`, not
a misleading `202`.

## Cancellation and process-tree kill

`POST /sessions/:id/cancel` calls the session's runtime handle's `cancel()`, which kills the
provider CLI's whole process tree, not just the direct child, so a cancelled session can't leave
a grandchild process (e.g. a shell command the CLI itself launched) orphaned:

- **Windows**: `taskkill /pid <pid> /T /F`
- **POSIX**: the child is spawned detached in its own process group; cancellation sends
  `SIGTERM` to the group (`process.kill(-pid, 'SIGTERM')`), then escalates to `SIGKILL` after 5
  seconds if it hasn't exited

See [SECURITY.md](../SECURITY.md#process-hygiene) for what was empirically verified here (Windows
grandchild-process test) versus documented-but-not-independently-reconfirmed (the POSIX path).
`DELETE /sessions/:id` cancels first (if the session is still `starting`/`running`) before removing
the record, so deleting a live session doesn't orphan its process either.

## Shutdown

On `SIGINT`/`SIGTERM`, the daemon (`apps/daemon/src/index.ts`): cancels every in-flight session and
waits (bounded, 16 seconds by default, covering interactive graceful-close and force-reap phases)
for their processes to actually exit
(`SessionManager.cancelAll()`), closes the Fastify server, removes the discovery file, then exits.
This is idempotent: a second signal while shutdown is already in progress is a no-op. The bounded
wait means shutdown won't hang forever if a child ignores termination, but also won't return
instantly while a child is still mid-teardown: `cancel()` on a runtime handle only _initiates_
termination (fires a signal/`taskkill` and returns), so without the wait the daemon could exit
while a process was still alive.

**Windows limitation**: Node's `child.kill()` maps to `TerminateProcess` on Windows, which does not
deliver a real `SIGTERM` the daemon's own shutdown handler can catch, so when Electron kills the
daemon child process directly (e.g. on app quit), the daemon's own `cancelAll()` above never runs
at all on that platform. Electron compensates by calling `POST /sessions/cancel-all` over HTTP
_before_ killing the daemon child process (HTTP is a request Windows can deliver reliably, unlike
a signal to the daemon's own process), and separately cancels each tracked interactive v2 session.
This covers every session the desktop main process started, not just the one the current UI happens
to be displaying. See `killDaemon()` in `apps/desktop/electron/main.ts` and
[architecture.md#known-limitations](architecture.md#known-limitations) for what this does and
doesn't cover on POSIX. The daemon process itself has always been confirmed to exit alongside the
app in testing; what can be left behind is a stale discovery file, which is harmless, see
[Single-instance behavior](#single-instance-behavior) above.

## Logging

`packages/agent-runtime/src/logger.ts`'s `createConsoleLogger` writes structured JSON lines to
stdout/stderr. Set `AGENT_DOCK_LOG_LEVEL=debug` to see `debug`-level lines (default is `info`). Any
log metadata key matching `/token|secret|password|authorization|api[-_]?key|credential/i` is
redacted to `[redacted]` regardless of level, see [SECURITY.md](../SECURITY.md#what-the-daemon-will-never-do).
