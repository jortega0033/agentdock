# Protocol v1

This is the daemon's public wire contract: the HTTP+SSE API shape and the `AgentEvent` /
`AgentEventEnvelope` event format every provider adapter normalizes into. `@agent-dock/client`
depends on exactly this document being accurate — if you change any of it, update the version
constant and this file together.

`AGENT_DOCK_PROTOCOL_VERSION` (`packages/shared/src/protocol.ts`, currently `1`) is reported at
`GET /health`. `@agent-dock/client` checks it automatically before the first real request (see
[client-sdk.md](client-sdk.md)) and throws `ProtocolMismatchError` on a mismatch — deliberately an
exact-match comparison, not a semver range or a negotiation handshake, since this is a boilerplate
shipping one daemon and one bundled client together, not a multi-version ecosystem yet. Bump the
constant only when you make a *breaking* change to either the route shapes below or the
`AgentEvent` union.

## HTTP + SSE routes

All routes are relative to `http://127.0.0.1:<port>`. Every route except `GET /health` requires
`Authorization: Bearer <token>` — see [SECURITY.md](../SECURITY.md#local-auth-token). Full
request/response detail (status codes, error bodies) lives in [daemon.md](daemon.md#routes); this
section is the protocol-level shape.

| Route | Purpose |
|---|---|
| `GET /health` | `{ status: 'ok', uptimeSeconds, protocolVersion }` — no auth required |
| `GET /providers` | `{ providers: ProviderStatus[] }` |
| `GET /providers/:providerId` | One `ProviderStatus` |
| `POST /sessions` | Body: `CreateSessionRequest`. Creates and starts a session, returns `AgentSession` |
| `GET /sessions/:sessionId` | Current `AgentSession` record |
| `GET /sessions/:sessionId/events` | SSE stream of `AgentEventEnvelope`, replayed from the start (or from `Last-Event-ID`) |
| `POST /sessions/:sessionId/cancel` | Cancels an in-flight session |
| `DELETE /sessions/:sessionId` | Cancels (if running) and forgets a session |

## The `AgentEvent` union

Defined once, in `packages/shared/src/events.ts`. Every provider adapter normalizes its CLI's
native output into this union — nothing above `packages/agent-runtime` (the daemon, the desktop UI,
a downstream client) should ever branch on which provider produced an event.

| Event | Fields | When it occurs | Capability gate |
|---|---|---|---|
| `session.started` | `sessionId`, `provider`, `providerSessionId?` | Always first, before anything else | none |
| `status` | `status`, `detail?` | Adapter-defined lifecycle status text (currently unused by both adapters, reserved for a provider that reports one) | none |
| `assistant.delta` | `text` | Token-by-token streamed output, for an adapter that opts into partial-message streaming | none — reserved; neither current adapter emits it (see [providers.md](providers.md#claude-code-adapter)) |
| `assistant.message` | `text` | One complete assistant turn | none |
| `thinking.delta` | `text` | Reasoning/thinking content, only when the CLI itself already puts it in its own public output stream | `capabilities.thinking` |
| `tool.started` | `toolName`, `toolCallId?`, `input?` | A tool/command invocation begins | `capabilities.tools` |
| `tool.completed` | `toolName?`, `toolCallId?`, `result?`, `isError?` | A tool/command invocation finishes | `capabilities.tools` |
| `usage` | `inputTokens?`, `outputTokens?`, `cachedInputTokens?`, `cost?` | Token/cost accounting, once per session (typically near the end) | `capabilities.usage` |
| `error` | `code?`, `message`, `recoverable` | A problem the session hit. `recoverable: true` means the session may still continue or complete normally (e.g. Codex's non-fatal item-level errors); `recoverable: false` always precedes a `session.failed` | none |
| `session.completed` | `providerSessionId?` | Terminal — the session finished successfully | none |
| `session.failed` | `message` | Terminal — the session ended in error | none |
| `session.cancelled` | *(none)* | Terminal — the session was cancelled before/while running | `capabilities.cancellation` |

`thinking.delta` is only ever emitted for reasoning content the CLI itself already puts in its
public, user-visible output stream (Claude Code's `thinking` content blocks; Codex's `reasoning`
items). Neither adapter attempts to reconstruct or expose anything the CLI treats as private.

`assistant.delta` exists in the union for a future adapter (or a future CLI flag) that wants
token-by-token streaming; today both adapters only ever emit complete `assistant.message` events —
see [providers.md](providers.md#claude-code-adapter) for why Claude Code specifically doesn't use
`--include-partial-messages`.

## `AgentEventEnvelope` — what actually crosses the wire

```ts
type AgentEventEnvelope = AgentEvent & {
  sequence: number; // per-session, zero-based, monotonically increasing — the SSE `id:` field too
  timestamp: string; // ISO 8601, when the daemon observed the event (not when the CLI produced it)
};
```

These two fields are stamped on once, by the daemon (`SessionManager`), when it records and
broadcasts an event — never something a provider adapter produces itself.

## Ordering guarantees

Upheld by `SessionManager` and enforced structurally by `runProviderSession()` (see
[architecture.md](architecture.md#runtime-flow-what-happens-when-a-user-presses-run) and
[providers.md](providers.md#executable-discovery)):

- Events within one session are emitted in `sequence` order, and every subscriber — live or
  replayed via `Last-Event-ID` — sees the same `sequence`/`timestamp` for the same event.
- Exactly one of `session.completed` / `session.failed` / `session.cancelled` occurs per session.
- That terminal event is always last — nothing is ever emitted after it.
- A fresh SSE subscriber (no `Last-Event-ID`) gets the full stored history replayed from `sequence`
  `0`, then live events as they arrive. A subscriber that sends `Last-Event-ID: <n>` resumes from
  `n + 1`. History is capped at 5,000 events per session
  (`MAX_STORED_EVENTS_PER_SESSION` in `apps/daemon/src/session-manager.ts`); beyond that, further
  events still reach live subscribers but are no longer replayable to a new one, and the daemon
  logs a warning.
- `@agent-dock/client`'s `sessions.events()` iterator ends when the terminal event arrives; it does
  not auto-reconnect — see [client-sdk.md](client-sdk.md#design-decisions) for why a bare retry is
  a complete substitute.

## Runtime validation

`packages/shared/src/schemas.ts` exports `agentEventEnvelopeSchema` (a Zod discriminated union on
`type`, mirroring the table above field-for-field) and `providerStatusSchema`,
`providerCapabilitiesSchema`, `agentSessionSchema`, `healthResponseSchema`. `@agent-dock/client`
validates every SSE frame and every JSON response against these before handing it to a caller, so a
daemon-side contract violation surfaces as a typed `ValidationError`, never a silent shape
mismatch. If you add an `AgentEvent` variant, add its schema branch here too — nothing enforces
that the two stay in sync except doing it by hand.

## What's public/stable vs. internal

**Public/stable, versioned together under `AGENT_DOCK_PROTOCOL_VERSION`:**

- The `AgentEvent` / `AgentEventEnvelope` union (`packages/shared/src/events.ts`)
- `ProviderStatus`, `ProviderCapabilities`, `AgentSession` (`packages/shared/src/provider.ts`, `session.ts`)
- The Zod schemas in `packages/shared/src/schemas.ts`
- The four route shapes above (`/health`, `/providers`, `/sessions`, `/sessions/:id/events`)

**Internal — not part of the protocol, and not exported from any package's public entry point:**

- `SessionManager`'s `RuntimeState` and its in-memory event buffer
- The exact `SessionStore` interface method signatures (`apps/daemon/src/session-store.ts`)
- Anything under `providers/*/parser.ts` or `providers/*/build-args.ts` — the raw, provider-native
  JSONL shape a CLI emits before normalization. A downstream consumer should never parse this
  directly; it's exactly what the `AgentEvent` union exists to shield you from, and it can change
  whenever Claude Code or Codex changes their own output format.

The desktop UI renders `AgentEvent` with a single `switch (event.type)`
(`apps/desktop/src/components/EventLog.tsx`) — it never branches on which provider produced an
event, and neither should any other consumer of this protocol.
