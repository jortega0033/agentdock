# Client SDK

`@agent-dock/client` (`packages/client`) is the typed way anything talks to the daemon — Electron's
main process (what this repo's own desktop app does), a future Node CLI, a future VS Code
extension. It owns the HTTP request/response handling, bearer-token auth, incremental SSE parsing,
and the protocol-version compatibility check, so a caller never hand-writes daemon URLs, headers,
or event-stream parsing.

It has no Electron or browser dependency — Node 18+'s global `fetch` is all it needs — and its
`package.json` declares an `"exports"` map with only `"."`:

```json
{ "exports": { ".": "./src/index.ts" } }
```

There is no `@agent-dock/client/src/internal/...` to reach into, by construction, not just
convention. Only what `index.ts` exports is the public surface.

## Public exports

```ts
import { AgentDockClient } from '@agent-dock/client';
import type { AgentDockClientOptions, HealthResponse, SessionEventsOptions } from '@agent-dock/client';
import {
  AgentDockClientError, // base class every error below extends
  DaemonError,          // any other non-2xx response
  DaemonUnavailableError, // fetch itself failed, or the daemon didn't respond
  ProtocolMismatchError,  // GET /health reported a different AGENT_DOCK_PROTOCOL_VERSION
  ProviderUnavailableError, // 404 on a /providers/:id route
  SessionNotFoundError,     // 404 on a /sessions/:id route
  UnauthorizedError,        // 401 — bad or missing token
  ValidationError,          // 400, or a response/SSE frame that failed its Zod schema
} from '@agent-dock/client';
```

Seven error classes, chosen to match what needs to be distinguishable by `instanceof` rather than
by parsing a message string — not expanded further without a concrete need.

## Usage

```ts
import { AgentDockClient } from '@agent-dock/client';

const client = new AgentDockClient({ baseUrl: 'http://127.0.0.1:PORT', token });

const providers = await client.providers.list();       // ProviderStatus[]
const provider = await client.providers.get('claude');  // ProviderStatus

const session = await client.sessions.create({
  provider: 'claude',
  cwd: '/path/to/project',
  prompt: 'Inspect this repository',
  // resumeProviderSessionId: session.providerSessionId, // to continue a prior thread
});

for await (const event of client.sessions.events(session.id)) {
  console.log(event); // AgentEventEnvelope — a normalized AgentEvent plus sequence/timestamp
}

const current = await client.sessions.get(session.id); // re-fetch the AgentSession record
await client.sessions.cancel(session.id);               // cancel an in-flight session
await client.sessions.delete(session.id);                // cancel (if running) and forget it
await client.sessions.cancelAll();                       // cancel every in-flight session
```

Errors are typed, so a caller can branch on `instanceof` instead of parsing strings:

```ts
try {
  await client.sessions.create({ provider: 'claude', cwd, prompt });
} catch (err) {
  if (err instanceof DaemonUnavailableError) {
    // daemon isn't running / isn't reachable yet
  } else if (err instanceof ProtocolMismatchError) {
    // this client and the running daemon disagree on protocol version
  } else if (err instanceof ValidationError) {
    // request or response didn't match the expected shape
  }
}
```

Full API: `providers.list()`, `providers.get(id)`, `sessions.create(input)`, `sessions.get(id)`,
`sessions.events(id, options?)`, `sessions.cancel(id)`, `sessions.delete(id)`,
`sessions.cancelAll()`, and `health()`. `SessionEventsOptions` accepts an `AbortSignal` (to stop
consuming early) and a `lastEventId` (to resume a stream instead of replaying from the start — see
[protocol-v1.md](protocol-v1.md#ordering-guarantees)). `sessions.cancelAll()` exists specifically
for a desktop shutdown path (Electron calls it before force-killing the daemon on Windows, where a
process signal alone can't reach the daemon's own graceful-shutdown handler — see
[daemon.md#shutdown](daemon.md#shutdown)); most callers only ever need `sessions.cancel(id)`.

## Design decisions

Worth knowing if you're extending this package:

- **The compatibility check is lazy, not in the constructor.** `new AgentDockClient(...)` is
  synchronous and does no I/O; the first call to `health()` — or any other method — runs the
  `GET /health` + protocol-version check once, caches the result for the client's lifetime, and
  retries on the next call if it failed. A daemon still starting up shouldn't permanently poison a
  client instance created a moment too early.
- **No automatic reconnect.** `sessions.events()` opens exactly one SSE connection and ends when
  the daemon closes it (the session's terminal event) or the caller's `AbortSignal` fires. If the
  connection drops for any other reason, the generator throws and the caller decides whether to
  retry. A bare retry is already a correct, complete "reconnect" — see
  [protocol-v1.md#ordering-guarantees](protocol-v1.md#ordering-guarantees) — because the daemon
  replays its full stored event history to a fresh subscriber, or resumes from `lastEventId`.
- **Errors are typed by transport-level category, never by sniffing a message string.** See the
  seven classes above.
- **The token never appears in a URL.** `sessions.events()` sends it as an `Authorization` header
  like every other call, via `fetch` + a manual `ReadableStream` reader (`src/sse.ts`) rather than
  the browser `EventSource` API, which can't set custom headers at all.
- **Every response is validated against the shared Zod schemas** (`@agent-dock/shared`) before it
  reaches the caller — a daemon-side bug that produces a malformed response surfaces as
  `ValidationError`, not a runtime crash somewhere downstream in application code.

## Where it's used in this repo

Electron's main process (`apps/desktop/electron/main.ts`) owns exactly one `AgentDockClient`
instance, constructed once the daemon's discovery file is readable. It's the only thing in the
desktop app that imports `@agent-dock/client` — the renderer only ever reaches it through seven IPC
handlers in `main.ts`, and the preload bridge (`electron/preload.ts`) exposes those seven functions
and nothing shaped like a generic request passthrough. See
[SECURITY.md](../SECURITY.md#renderer-never-talks-to-the-daemon-directly) for the full boundary,
and [electron.md](electron.md) for how the main process wires this client to IPC.

## Using it from a workspace/fork, not from outside the repo

Nothing about `@agent-dock/client`'s own code depends on Electron — a plain Node script (a future
CLI, an editor extension) can use it exactly like `main.ts` does. But `@agent-dock/client` is not a
published npm package: it's `private: true`, and its `main`/`types` point at raw TypeScript source
(`./src/index.ts`), not a built `dist/`. This works today only because everything that imports it
lives in the same pnpm workspace (or a fork of this repo, which is the same thing). An external
project outside this repo's workspace **cannot** `npm install @agent-dock/client` and get something
resolvable — see [architecture.md#project-identity](architecture.md#project-identity) for the
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
