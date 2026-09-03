# Protocol v1

This is the daemon's public wire contract: the HTTP+SSE API shape and the `AgentEvent` /
`AgentEventEnvelope` event format every provider adapter normalizes into. `@agent-dock/client`
depends on exactly this document being accurate: if you change any of it, update the version
constant and this file together.

`AGENT_DOCK_PROTOCOL_VERSION` (`packages/shared/src/protocol.ts`, currently `1`) remains the legacy
scalar reported at `GET /health`; health also advertises `supportedProtocolVersions: [1, 2]`.
`@agent-dock/client` discovers the highest shared advertised version before the first real request,
while its top-level v1 namespace separately requires version `1` to remain available. It throws
`ProtocolMismatchError` when no shared version, or the namespace's required version, is available.
An older daemon without the array is treated as supporting only its scalar. Bump the v1 constant
only for a breaking change to the route shapes below or the `AgentEvent` union.

## HTTP + SSE routes

All routes are relative to `http://127.0.0.1:<port>`. Every route except `GET /health` requires
`Authorization: Bearer <token>`, see [SECURITY.md](../SECURITY.md#local-auth-token). Full
request/response detail (status codes, error bodies) lives in [daemon.md](daemon.md#routes); this
section is the protocol-level shape.

| Route                              | Purpose                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                      | `{ status: 'ok', uptimeSeconds, protocolVersion, supportedProtocolVersions }`, no auth required                                                               |
| `GET /providers`                   | `{ providers: ProviderStatus[] }`                                                                                                                             |
| `GET /providers/:providerId`       | One `ProviderStatus`                                                                                                                                          |
| `POST /sessions`                   | Body: `CreateSessionRequest`. Requires trust for the current workspace incarnation; returns `409 workspace_untrusted` otherwise, or `AgentSession` on success |
| `GET /sessions/:sessionId`         | Current `AgentSession` record                                                                                                                                 |
| `GET /sessions/:sessionId/events`  | SSE stream of `AgentEventEnvelope`, replayed from the start (or from `Last-Event-ID`)                                                                         |
| `POST /sessions/:sessionId/cancel` | Cancels an in-flight session (`404` if it's already terminal)                                                                                                 |
| `POST /sessions/cancel-all`        | Cancels every in-flight session, used by the desktop app's shutdown path, not by normal session management                                                    |
| `DELETE /sessions/:sessionId`      | Cancels (if running) and forgets a session                                                                                                                    |

V1 has no trust-management route or trust fields. In the production daemon, clients inspect and
trust the exact workspace incarnation through `/v2/workspaces` before calling `POST /sessions`.

`CreateSessionRequest`'s optional `resumeProviderSessionId` accepts an already-known
provider-native id (e.g. a Claude CLI session id or Codex thread id) and passes it straight through
to the provider's own resume flag (`claude --resume <id>` / `codex exec resume <id>`); the daemon
never verifies that id against anything, and rejects it up front only if the target provider's
`ProviderStatus.capabilities.resume` is `false`. This is a renderer-supplied, daemon-unverified
value with **no durable lineage** — it is not the same mechanism as v2's `session.resume`/
`session.fork`, which requires the daemon to have itself stored a durable, non-secret account/model
binding for a terminal parent session before it will ever negotiate continuation (see
[capability-security-v2.md](capability-security-v2.md#evidence-matrix)). A provider whose v1
`resume` flag works (its CLI genuinely accepts a native id) is not thereby "v2-resume-capable";
those are two independent claims, and issue #54 exists specifically because Claude's v1 flag being
real was previously conflated with its (currently nonexistent) v2 durable binding support.

## The `AgentEvent` union

Defined once, in `packages/shared/src/events.ts`. Every provider adapter normalizes its CLI's
native output into this union: nothing above `packages/agent-runtime` (the daemon, the desktop UI,
a downstream client) should ever branch on which provider produced an event.

| Event               | Fields                                                         | When it occurs                                                                                                                                                                                                                                                                                                                                                        | Capability gate             |
| ------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `session.started`   | `sessionId`, `provider`, `providerSessionId?`                  | Always first, before anything else                                                                                                                                                                                                                                                                                                                                    | none                        |
| `status`            | `status`, `detail?`                                            | Adapter-defined lifecycle status text (an unconstrained, provider-defined string, **not dead surface**): Claude emits `status: 'initialized'` on `system/init`, Codex emits `status: 'thread_started'` and `status: 'turn_started'`. Treat the string value itself as informational/unstable, not something to switch on                                              | none                        |
| `assistant.message` | `text`                                                         | One complete assistant turn                                                                                                                                                                                                                                                                                                                                           | none                        |
| `thinking.delta`    | `text`                                                         | Reasoning/thinking content, only when the CLI itself already puts it in its own public output stream                                                                                                                                                                                                                                                                  | `capabilities.thinking`     |
| `tool.started`      | `toolName`, `toolCallId?`, `input?`                            | A tool/command invocation begins                                                                                                                                                                                                                                                                                                                                      | `capabilities.tools`        |
| `tool.completed`    | `toolName?`, `toolCallId?`, `result?`, `isError?`              | A tool/command invocation finishes                                                                                                                                                                                                                                                                                                                                    | `capabilities.tools`        |
| `usage`             | `inputTokens?`, `outputTokens?`, `cachedInputTokens?`, `cost?` | Token/cost accounting. **Cardinality is provider-dependent, not once-per-session**: Codex emits one per completed turn (in practice once for a single-turn session); Claude emits one on every `assistant`/`user` line _and_ again on the final `result` line. Never treat a single `usage` event as a session total, see [providers.md](providers.md#claude-adapter) | `capabilities.usage`        |
| `error`             | `code?`, `message`, `recoverable`                              | A problem the provider reported. `recoverable: true` means the session may still continue. Treat `recoverable: false` as provider-event metadata, not a terminal guarantee: v1 chooses its terminal event from cancellation, stream failure, and process exit, so an exit-zero stream can still end `session.completed` after such an error                           | none                        |
| `session.completed` | `providerSessionId?`                                           | Terminal: the session finished successfully                                                                                                                                                                                                                                                                                                                           | none                        |
| `session.failed`    | `message`                                                      | Terminal: the session ended in error                                                                                                                                                                                                                                                                                                                                  | none                        |
| `session.cancelled` | _(none)_                                                       | Terminal: the session was cancelled before/while running                                                                                                                                                                                                                                                                                                              | `capabilities.cancellation` |

`thinking.delta` is only ever emitted for reasoning content the CLI itself already puts in its
public, user-visible output stream (Claude Code's `thinking` content blocks; Codex's `reasoning`
items). Neither adapter attempts to reconstruct or expose anything the CLI treats as private.

There is deliberately no token-streaming event variant in v1. An earlier `assistant.delta`
placeholder was removed before this milestone froze the protocol: no adapter ever emitted it, no
test exercised it, and it lacked a message-boundary id a real streaming consumer would need to
correlate a run of deltas with its eventual `assistant.message`: reserved-but-unspecified surface
is worse than adding a properly-specified variant once a real adapter needs one. See
[providers.md](providers.md#claude-adapter) for why Claude Code specifically doesn't pass
`--include-partial-messages` today.

## `AgentEventEnvelope`: what actually crosses the wire

```ts
type AgentEventEnvelope = AgentEvent & {
  sequence: number; // per-session, zero-based, monotonically increasing — the SSE `id:` field too
  timestamp: string; // ISO 8601, when the daemon observed the event (not when the CLI produced it)
};
```

These two fields are stamped on once, by the daemon (`SessionManager`), when it records and
broadcasts an event, never something a provider adapter produces itself.

## Ordering guarantees

Upheld by `SessionManager` and enforced structurally by `runProviderSession()` (see
[architecture.md](architecture.md#runtime-flow-what-happens-when-a-user-presses-run) and
[providers.md](providers.md#executable-discovery)):

- Events within one session are emitted in `sequence` order, and every subscriber (live or
  replayed via `Last-Event-ID`) sees the same `sequence`/`timestamp` for the same event.
- Exactly one of `session.completed` / `session.failed` / `session.cancelled` occurs per session.
- That terminal event is always last: nothing is ever emitted after it.
- A fresh SSE subscriber (no `Last-Event-ID`) gets the stored history replayed from `sequence` `0`,
  then live events as they arrive. A subscriber that sends `Last-Event-ID: <n>` requests replay
  from `n + 1`. The stored history is a prefix capped at 5,000 events *and* 16 MiB of serialized
  bytes per session (`MAX_STORED_EVENTS_PER_SESSION` / `MAX_STORED_EVENT_BYTES_PER_SESSION` in
  `apps/daemon/src/session-manager.ts`), whichever is reached first; large events can hit the byte
  ceiling well before 5,000 events. Beyond either cap, further events are delivered only to
  subscribers connected at the time, while `sequence` continues to increment; the daemon logs the
  "history full" condition once per session, not once per subsequent event. A subscriber that
  disconnects after either cap cannot recover later missed events, including a terminal event
  emitted while it was disconnected. This v1 limitation is regression-tested directly in
  `apps/daemon/test/session-manager.test.ts`.
- One normalized envelope cannot exceed 1 MiB serialized (`MAX_LEGACY_EVENT_ENVELOPE_BYTES`). A
  provider event that would exceed it is never stored or streamed: the daemon reaps the provider
  process, records the session as `failed`, and emits exactly one synthetic `session.failed`
  envelope (its own message describes the size violation, not the oversized content) as that
  session's sole terminal event. `@agent-dock/client` enforces the identical 1 MiB ceiling on the
  wire independently (`MAX_V1_SSE_FRAME_BYTES` in `packages/client/src/client.ts`), so a
  daemon that somehow put an oversized frame on the wire would still be rejected client-side with a
  `ValidationError` rather than accepted.
- Each subscriber's own SSE connection is bounded independently to 256 queued frames and 4 MiB
  (`apps/daemon/src/v1-sse-writer.ts`, sharing its bounded-queue/backpressure implementation with
  protocol v2's writer): the daemon never calls `write()` again on a connection that reported
  backpressure until it drains. If one slow subscriber's queue overflows either limit, only that
  subscriber's connection is closed -- the provider session, its stored replay history, and every
  other subscriber are unaffected. Protocol v1 has no wire-level "you overflowed" signal (unlike
  v2's `stream.error`/`stream_overflow`): the connection simply ends, exactly like a normal stream
  close, so the client sees the same thing it would see from a network hiccup.
- `@agent-dock/client`'s `sessions.events()` iterator ends when the terminal event arrives; it does
  not auto-reconnect. Reopening the stream is a complete reconnect only while every missed event is
  still in the retained history prefix (i.e. under both the count and byte caps above) and, for an
  overflow-closed connection, while the provider session itself is still running -- it is not gap
  recovery after either replay cap, and a session that already failed or completed while a
  subscriber was disconnected cannot be replayed past that point either. See
  [client-sdk.md](client-sdk.md#design-decisions).

## Runtime validation

`packages/shared/src/schemas.ts` exports `agentEventEnvelopeSchema` (a Zod discriminated union on
`type`, mirroring the table above field-for-field) and `providerStatusSchema`,
`providerCapabilitiesSchema`, `agentSessionSchema`, `healthResponseSchema`. `@agent-dock/client`
validates health, individual provider/session success payloads, and every SSE frame before handing
them to a caller. The current v1 provider-list wrapper and cancel acknowledgements are not
independently schema-validated; error bodies are read only for bounded status/message handling. If
you add an `AgentEvent` variant, add its schema branch here too: nothing enforces that the two stay
in sync except doing it by hand.

## What's public/stable vs. internal

**Public/stable, versioned together under `AGENT_DOCK_PROTOCOL_VERSION`:**

- The `AgentEvent` / `AgentEventEnvelope` union (`packages/shared/src/events.ts`)
- `ProviderStatus`, `AuthStatus`, `ProviderCapabilities`, `AgentSession`
  (`packages/shared/src/provider.ts`, `session.ts`); `ProviderCapabilities`' known keys are
  stable, but the shape is deliberately open (optional keys + an index signature) so a future
  capability is additive, not a breaking change; see [providers.md](providers.md#provider-capabilities)
- The Zod schemas in `packages/shared/src/schemas.ts`
- The route shapes above (`/health`, `/providers`, `/sessions`, `/sessions/:id/events`)

**Internal: not part of the protocol, and not exported from any package's public entry point:**

- `SessionManager`'s `RuntimeState` and its in-memory event buffer
- The exact `SessionStore` interface method signatures (`apps/daemon/src/session-store.ts`)
- Anything under `providers/*/parser.ts` or `providers/*/build-args.ts`: the raw, provider-native
  JSONL shape a CLI emits before normalization. A downstream consumer should never parse this
  directly; it's exactly what the `AgentEvent` union exists to shield you from, and it can change
  whenever Claude Code or Codex changes their own output format.

The desktop timeline accepts both v1 and v2 envelopes, projects them into bounded provider-neutral
activity items, and never branches on which provider produced an event
(`apps/desktop/src/components/activity/model.ts`). Other protocol consumers should preserve that
same boundary.
