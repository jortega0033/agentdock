# Daemon

`apps/daemon` is a standalone Fastify HTTP+SSE server. It has no Electron dependency and no
required parent process — `pnpm daemon` runs and can be `curl`'d directly, with no display server
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

The daemon binds `127.0.0.1` only — never `0.0.0.0`, and never the IPv6 loopback (`::1`) either; it
answers on IPv4 only (`apps/daemon/src/index.ts`). By default it asks the OS for an ephemeral port
(`AGENT_DOCK_PORT` unset or `0`); set `AGENT_DOCK_PORT=<port>` to request a fixed one. Whichever
port it ends up on is written to the discovery file and printed to stdout — there's no way to know
it in advance otherwise.

## Discovery file

The daemon writes `{ port, token, pid, startedAt }` to a JSON file under `os.tmpdir()/agent-dock/`
once it's listening, with restrictive file permissions (`0600` on POSIX). This is a **filesystem
handoff, not a network one** — a client reads the file directly (it has to be running as the same
OS user), rather than the daemon ever broadcasting the token over the network. See
[SECURITY.md](../SECURITY.md#local-auth-token) for why.

## Auth token

Every route except `GET /health` requires `Authorization: Bearer <token>`, checked with a
timing-safe comparison. The full threat model and reasoning live in
[SECURITY.md](../SECURITY.md) — this file only covers operational behavior, not why it's safe.

## Single-instance behavior

The daemon refuses to start if the discovery file's recorded pid is still alive
(`apps/daemon/src/discovery-file.ts#assertNoLiveDaemon`):

```
Error: another agent-dock daemon is already running (pid <pid>, discovery file <path>).
Only one daemon instance is supported at a time in this MVP — stop it first.
```

A discovery file whose recorded pid is no longer running (a stale file left by a crash or
force-kill) is treated as safe to overwrite — nothing is listening at that pid anymore, and a
corrupt/partially-written file is treated the same way. See
[troubleshooting.md](troubleshooting.md#daemon-fails-to-start) if you hit this unexpectedly.

## Routes

| Route | Auth | Behavior |
|---|---|---|
| `GET /health` | none | `{ status: 'ok', uptimeSeconds, protocolVersion }` |
| `GET /providers` | required | `{ providers: ProviderStatus[] }` — runs each adapter's `detect()` |
| `GET /providers/:providerId` | required | One `ProviderStatus`, or `404` for an unregistered id |
| `POST /sessions` | required | Body validated against `createSessionRequestSchema`. `400` for an unknown provider, a `resumeProviderSessionId` on a provider whose `capabilities.resume` is `false`, or a `cwd` that doesn't exist. `201` + `AgentSession` on success |
| `GET /sessions/:sessionId` | required | Current `AgentSession` record, or `404` |
| `GET /sessions/:sessionId/events` | required | SSE stream — see [Event history and replay](#event-history-and-replay) below |
| `POST /sessions/:sessionId/cancel` | required | `202` + `{ status: 'cancelling' }`, or `404` |
| `DELETE /sessions/:sessionId` | required | Cancels if still running, then removes the record. `204`, or `404` |

Every request body/param is Zod-validated before touching any handler logic
(`packages/shared/src/schemas.ts`); invalid input gets a `4xx` with a short JSON error message,
never a stack trace. See the full request-validation and error-handler behavior in
[SECURITY.md](../SECURITY.md#request-validation).

Wire shapes (route bodies, the `AgentEvent`/`AgentEventEnvelope` format) are documented in
[protocol-v1.md](protocol-v1.md), not duplicated here.

## Session lifecycle: SessionManager, SessionStore

`SessionManager` (`apps/daemon/src/session-manager.ts`) orchestrates everything: creates a session
through the provider registry, consumes its normalized `AgentEvent` stream, and keeps the
`AgentSession` record's `status` up to date as terminal events arrive
(`starting` → `running` → one of `completed` / `failed` / `cancelled`).

The `AgentSession` record itself lives behind a `SessionStore` interface
(`apps/daemon/src/session-store.ts`):

```ts
interface SessionStore {
  create(session: AgentSession): void;
  get(id: string): AgentSession | undefined;
  update(id: string, session: AgentSession): void;
  delete(id: string): void;
  list(): AgentSession[];
}
```

`MemorySessionStore` is the only implementation and the daemon's default — fully synchronous (so is
the interface), and **sessions do not survive a daemon restart**. Persistence is explicitly out of
scope for this milestone: swapping in a real store (e.g. a future `SQLiteSessionStore`) should only
require implementing this interface, not touching `SessionManager`'s lifecycle logic — but the
interface would likely need to become `async` at that point, a deliberately larger change left for
when it's actually needed.

The store owns only the `AgentSession` record. A session's live process handle (an
`AsyncGenerator` plus a `cancel()` closure — not serializable at all) and its buffered event
history are kept as separate, non-persistable runtime state inside `SessionManager`, specifically
so `SessionStore` never grows into an accidental event-history database with its own
schema-design questions.

## Event history and replay

`SessionManager` buffers every session's emitted `AgentEventEnvelope`s in memory, capped at 5,000
per session (`MAX_STORED_EVENTS_PER_SESSION`). `GET /sessions/:id/events`:

1. Writes an SSE `:ok` comment immediately, then the standard `text/event-stream` headers.
2. Replays every buffered event from `sequence` 0 (or from `Last-Event-ID + 1`, if that header was
   sent) as `id: <sequence>\nevent: <type>\ndata: <json>\n\n` frames.
3. Keeps the connection open and streams new events live as they arrive.
4. Closes the response itself once a terminal event (`session.completed` / `session.failed` /
   `session.cancelled`) is written — the client never has to guess whether more events might still
   arrive.

Past 5,000 buffered events, further events still reach an already-connected live subscriber but are
no longer available to replay to a new one; the daemon logs a warning rather than growing memory
unbounded. See [protocol-v1.md#ordering-guarantees](protocol-v1.md#ordering-guarantees) for the
full ordering contract this upholds.

## Cancellation and process-tree kill

`POST /sessions/:id/cancel` calls the session's runtime handle's `cancel()`, which kills the
provider CLI's whole process tree — not just the direct child — so a cancelled session can't leave
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

On `SIGINT`/`SIGTERM`, the daemon (`apps/daemon/src/index.ts`): cancels every in-flight session
(`SessionManager.cancelAll()`), closes the Fastify server, removes the discovery file, then exits.
This is idempotent — a second signal while shutdown is already in progress is a no-op.

**Windows limitation**: Node's `child.kill()` maps to `TerminateProcess` on Windows, which does not
deliver a real `SIGTERM` the daemon's own shutdown handler can catch. When Electron kills the
daemon child process directly (e.g. on app quit), the daemon doesn't get to run its own graceful
shutdown — see `killDaemon()` in `apps/desktop/electron/main.ts`, which mitigates this by cancelling
the one active session over HTTP *before* killing the child, and
[architecture.md#known-limitations](architecture.md#known-limitations)
for what this does and doesn't cover. The daemon process itself has always been confirmed to exit
alongside the app in testing; what can be left behind is a stale discovery file, which is harmless
— see [Single-instance behavior](#single-instance-behavior) above.

## Logging

`packages/agent-runtime/src/logger.ts`'s `createConsoleLogger` writes structured JSON lines to
stdout/stderr. Set `AGENT_DOCK_LOG_LEVEL=debug` to see `debug`-level lines (default is `info`). Any
log metadata key matching `/token|secret|password|authorization|api[-_]?key|credential/i` is
redacted to `[redacted]` regardless of level — see [SECURITY.md](../SECURITY.md#what-the-daemon-will-never-do).
