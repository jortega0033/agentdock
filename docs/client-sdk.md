# Client SDK

`@agent-dock/client` (`packages/client`) is the typed way anything talks to the daemon: Electron's
main process (what this repo's own desktop app does), a future Node CLI, a future VS Code
extension. It owns the HTTP request/response handling, bearer-token auth, incremental SSE parsing,
and the protocol-version compatibility check, so a caller never hand-writes daemon URLs, headers,
or event-stream parsing.

It has no Electron or browser dependency (the workspace requires Node 20+, whose global `fetch` it
uses), and its
`package.json` declares an `"exports"` map with only `"."`:

```json
{ "exports": { ".": "./src/index.ts" } }
```

There is no `@agent-dock/client/src/internal/...` to reach into, by construction, not just
convention. Only what `index.ts` exports is the public surface.

## Public exports

```ts
import { AgentDockClient } from '@agent-dock/client';
import type {
  AgentDockClientOptions,
  HealthResponse,
  SessionEventHistoryV2Options,
  SessionEventsOptions,
  SessionListV2Options,
  SessionRequestOptions,
} from '@agent-dock/client';
import {
  AgentDockClientError, // base class every error below extends
  DaemonError, // any other non-2xx response
  DaemonUnavailableError, // fetch itself failed, or the daemon didn't respond
  ProtocolMismatchError, // GET /health does not support the version required by this namespace
  ProviderUnavailableError, // 404 on a /providers/:id route
  SessionNotFoundError, // 404 on a /sessions/:id route
  UnauthorizedError, // 401, bad or missing token
  ValidationError, // 400, or a daemon response/SSE frame that failed its Zod schema
} from '@agent-dock/client';
```

One abstract base and seven concrete error classes, chosen to match what needs to be distinguishable
by `instanceof` rather than by parsing a message string.

## Usage

```ts
import { AgentDockClient } from '@agent-dock/client';

const client = new AgentDockClient({ baseUrl: 'http://127.0.0.1:PORT', token });

const providers = await client.providers.list(); // ProviderStatus[]
const provider = await client.providers.get('claude'); // ProviderStatus

const cwd = '/path/to/project';
const workspace = await client.v2.workspaces.inspect(cwd);
if (workspace.state !== 'trusted') {
  // Show the resolved identity to the user and obtain explicit consent first.
  await client.v2.workspaces.setTrust(workspace.workspaceId, {
    cwd,
    incarnation: workspace.incarnation,
    state: 'trusted',
  });
}

const session = await client.sessions.create({
  provider: 'claude',
  cwd,
  prompt: 'Inspect this repository',
  // resumeProviderSessionId: session.providerSessionId, // to continue a prior thread
});

for await (const event of client.sessions.events(session.id)) {
  console.log(event); // AgentEventEnvelope: a normalized AgentEvent plus sequence/timestamp
}

const current = await client.sessions.get(session.id); // re-fetch the AgentSession record
await client.sessions.cancel(session.id); // cancel an in-flight session
await client.sessions.delete(session.id); // cancel (if running) and forget it
await client.sessions.cancelAll(); // cancel every in-flight v1 session
```

The existing top-level namespaces stay pinned to protocol v1. Capability-negotiated callers use
the explicit v2 namespace:

```ts
const providersV2 = await client.v2.providers.list();
const sessionV2 = await client.v2.sessions.create({
  provider: 'claude',
  cwd,
  prompt: 'Inspect this repository',
  // capabilities omitted: use the safe one-shot default request
});

for await (const event of client.v2.sessions.events(sessionV2.id, { responder: true })) {
  console.log(event); // validated AgentEventV2Envelope

  if (event.type === 'approval.requested') {
    await client.v2.sessions.send({
      type: 'approval.respond',
      commandId: crypto.randomUUID(),
      sessionId: event.sessionId,
      turnId: event.turnId,
      requestId: event.requestId,
      decision: 'deny',
    });
  }
}
```

Production session creation returns `409 workspace_untrusted` unless the exact current workspace
incarnation has been trusted. Trust is a user decision; do not set it silently in a client.

Passing `{ responder: true }` claims the session's sole interaction-responder stream. The client
keeps the returned lease private and attaches it to approval/question responses; observer streams
should omit this option and cannot answer interactions.

`client.v2.sessions` also exposes `list`, `get`, `history`, `resume`, `fork`, `send`, `cancel`, and
`delete`. `send` validates the
`AgentCommandV2` input, requires a `202` response, validates the strict
`CommandAcknowledgementV2`, and rejects an acknowledgement whose command, session, or turn ID does
not match the request. See [protocol-v2.md](protocol-v2.md) for the complete contract.

Daemon, transport, and validated-response errors are typed, so a caller can branch on `instanceof`
instead of parsing strings:

```ts
try {
  await client.sessions.create({ provider: 'claude', cwd, prompt });
} catch (err) {
  if (err instanceof DaemonUnavailableError) {
    // daemon isn't running / isn't reachable yet
  } else if (err instanceof ProtocolMismatchError) {
    // this client and the running daemon disagree on protocol version
  } else if (err instanceof ValidationError) {
    // daemon response or SSE frame didn't match the expected shape
  }
}
```

Full API: `providers.list()`, `providers.get(id)`, `sessions.create(input)`, `sessions.get(id)`,
`sessions.events(id, options?)`, `sessions.cancel(id)`, `sessions.delete(id)`,
`sessions.cancelAll(options?)`, and `health()`. `SessionEventsOptions` accepts an `AbortSignal` (to
stop consuming early), a `lastEventId` (to resume a stream instead of replaying from the start; see
[protocol-v1.md](protocol-v1.md#ordering-guarantees)), and a v2-only `responder` flag.
`SessionRequestOptions` accepts an
`AbortSignal`; v1 `cancelAll` and v2 `create`/`cancel` accept it so shutdown callers can bound HTTP
work. `sessions.cancelAll()` exists specifically
for a desktop shutdown path (Electron calls it before force-killing the daemon on Windows, where a
process signal alone can't reach the daemon's own graceful-shutdown handler; see
[daemon.md#shutdown](daemon.md#shutdown)); most callers only ever need `sessions.cancel(id)`.

The v2 namespaces are:

- `v2.providers`: `list`, `get`.
- `v2.sessions`: `create`, `list`, `get`, `history`, `resume`, `fork`, `events`, `send`, `cancel`,
  `delete`.
- `v2.workspaces`: `inspect`, `setTrust`; `v2.audit`: `list`; `v2.agents`: `graph`, `control`.
- `v2.worktrees`: `preview`, `create`, `list`, `cleanup`.
- `v2.attachments`: `upload`, `list`, `reference`; `v2.structured`: `validate`.
- `v2.integrations.mcp`: `list`, `configure`, `action`, `catalog`, `oauth`, `invoke`.
- `v2.integrations.components`: `list`, `manage`, `invoke`.

## Design decisions

Worth knowing if you're extending this package:

- **The compatibility check is lazy, not in the constructor.** `new AgentDockClient(...)` is
  synchronous and does no I/O; the first call to `health()` (or any other method) runs the
  `GET /health` + protocol-version check once, caches the result for the client's lifetime, and
  retries on the next call if it failed. A daemon still starting up shouldn't permanently poison a
  client instance created a moment too early. Discovery intersects the daemon's additive
  `supportedProtocolVersions` list with the client's list and selects the highest shared version;
  an older daemon without that list falls back to its legacy scalar.
- **No automatic reconnect.** `sessions.events()` opens exactly one SSE connection. A rejected
  stream read throws, while a clean EOF returns normally even if no terminal event arrived; an
  `AbortSignal` also ends the stream. Callers that require terminal confirmation must track terminal
  events themselves and decide whether to retry after an early EOF. Protocol v1 retains only the
  first 5,000 events. A retry is complete only when every event missed by that subscriber is still
  in that retained prefix; events emitted after the cap are live-only and cannot be recovered after
  a disconnect. See
  [protocol-v1.md#ordering-guarantees](protocol-v1.md#ordering-guarantees).
- **Errors are typed by transport-level category, never by sniffing a message string.** See the
  seven classes above.
- **The token never appears in a URL.** `sessions.events()` sends it as an `Authorization` header
  like every other call, via `fetch` + a manual `ReadableStream` reader (`src/sse.ts`) rather than
  the browser `EventSource` API, which can't set custom headers at all.
- **Structured success payloads and SSE frames are validated where the client applies a shared Zod
  schema** (`@agent-dock/shared`). Health, individual providers/sessions, and event frames are
  covered; the current v1 provider-list wrapper and cancel acknowledgements are not independently
  schema-validated, and error bodies are used only for status/message handling. Most request inputs
  are validated; v1 `sessions.create()` currently exposes the shared schema's `ZodError` for
  runtime-invalid input.
- **A bounded v2 SSE overflow is explicit.** The daemon ends that subscriber with a validated
  `stream.error` control frame. The generator throws `DaemonError` with status `429` and includes
  the last handed-off sequence in its message when available; the caller decides whether to resume.

## Where it's used in this repo

Electron's main process (`apps/desktop/electron/main.ts`) owns exactly one `AgentDockClient`
instance, constructed once the daemon's discovery file is readable. Production daemon traffic goes
through that instance; `electron/interactive-session-lifecycle.ts` also imports client error/types
but does not own a client. The renderer reaches main through narrow, typed preload methods backed by
fixed IPC channels/handlers, with nothing shaped like a generic request passthrough. Those methods
cover the current v2 multi-session UI, history/resume/fork/delete flows, interactive timeline and
responder commands, workspace trust, and integration panels. See
[SECURITY.md](../SECURITY.md#renderer-never-talks-to-the-daemon-directly) for the full boundary,
and [electron.md](electron.md) for how the main process wires this client to IPC.

## Using it from a workspace/fork, not from outside the repo

Nothing about `@agent-dock/client`'s own code depends on Electron: a plain Node script (a future
CLI, an editor extension) can use it exactly like `main.ts` does. But `@agent-dock/client` is not a
published npm package: it's `private: true`, and its `main`/`types` point at raw TypeScript source
(`./src/index.ts`), not a built `dist/`. This works today only because everything that imports it
lives in the same pnpm workspace (or a fork of this repo, which is the same thing). An external
project outside this repo's workspace **cannot** `npm install @agent-dock/client` and get something
resolvable; see [architecture.md#project-identity](architecture.md#project-identity) for the
fork-vs-publish decision this follows from.

If you're building a new consumer (a CLI, an editor extension) as another package inside this same
workspace, or in a fork of this repo, it's exactly as simple as it looks:

```ts
import { AgentDockClient } from '@agent-dock/client';

const client = new AgentDockClient({ baseUrl: 'http://127.0.0.1:5173', token: '...' });
const health = await client.health(); // throws ProtocolMismatchError / DaemonUnavailableError early
```

See [architecture.md#why-a-separate-daemon-instead-of-running-the-cli-logic-in-electrons-main-process](architecture.md#why-a-separate-daemon-instead-of-running-the-cli-logic-in-electrons-main-process)
for why the daemon+client split is what makes a second, non-Electron consumer like this possible at
all without touching the daemon or the provider adapters.
