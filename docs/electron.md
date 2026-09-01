# Electron

`apps/desktop` is a demo Electron + React client for the daemon. It exists to prove the daemon and
`@agent-dock/client` work end to end and to give you a real, working example to fork: it has no
provider-specific logic of its own.

## The three-layer boundary

```
Renderer (React)  ──IPC (contextBridge)──▶  Electron main  ──@agent-dock/client──▶  Daemon
```

The renderer **never** calls the daemon's HTTP+SSE API directly: only the main process does,
through one `AgentDockClient` instance. This isn't a style preference: a renderer `fetch()` to the
daemon cannot actually succeed, because the daemon deliberately never answers a CORS preflight. See
[SECURITY.md](../SECURITY.md#renderer-never-talks-to-the-daemon-directly) for the full explanation
of why, including what was reproduced against a real browser tab. The short version for this doc:
keep new daemon calls in `electron/main.ts`, never add a `fetch()` to the daemon from anywhere
under `src/` (the renderer).

## BrowserWindow security settings

`electron/main.ts` creates its window with:

```ts
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  preload: join(__dirname, 'preload.js'),
}
```

`webSecurity` is never overridden. `setWindowOpenHandler` denies every `window.open`/`target=_blank`
popup and opens the URL in the OS browser instead. `will-navigate` (`isAllowedNavigationTarget()`
in `main.ts`) allows only: in dev mode, the exact dev-server _origin_ (a real `new URL(...).origin`
comparison, not a `startsWith` prefix match (the earlier prefix check would have let
`http://localhost:5173.evil.example` through against an allowed `http://localhost:5173`); in
packaged mode, the exact `file://` URL of the app's own `dist/index.html`, not any local file path.
Anything else redirects to the OS browser instead. A `session.setPermissionRequestHandler` denies
every permission request by default (camera, mic, geolocation, notifications, ...). None of this
matters for the _current_ UI (it renders no untrusted content or links, and requests no
permissions), but it's cheap defense in depth for a fork that later adds either, see
[SECURITY.md](../SECURITY.md#electron-hardening).

## The preload bridge

`electron/preload.ts` exposes exactly twelve functions on `window.agentDock` via `contextBridge`,
never a generic "invoke this channel with this payload" tunnel, and never the daemon's base URL or
bearer token. `getDaemonStatus`/`onDaemonStatus` specifically reconstruct a clean status object
from the IPC payload rather than passing it through once its shape looks roughly right, so an
accidental extra field on the main-process side (a token, a base URL) can never ride along even by
mistake, see `apps/desktop/test/preload.test.ts` for the regression test against this real module:

```ts
interface AgentDockBridge {
  getDaemonStatus(): Promise<DaemonStatus>;
  onDaemonStatus(callback: (status: DaemonStatus) => void): () => void;
  listProviders(): Promise<ProviderStatus[]>;
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  cancelSession(sessionId: string): Promise<void>;
  onSessionEvent(callback: (sessionId: string, event: AgentEvent) => void): () => void;
  createInteractiveSession(input: CreateSessionV2Request): Promise<AgentSessionV2>;
  sendSessionCommand(command: AgentCommandV2): Promise<CommandAcknowledgementV2>;
  cancelInteractiveSession(sessionId: string): Promise<CancelSessionV2Response>;
  onInteractiveSessionEvent(
    callback: (sessionId: string, event: AgentEventV2Envelope) => void,
  ): () => void;
  onInteractiveSessionStreamNotice(
    callback: (sessionId: string, notice: InteractiveSessionStreamNotice) => void,
  ): () => void;
  selectDirectory(): Promise<string | null>;
}
```

Each maps to one fixed request or event channel in `main.ts`. Interactive create, command, and
cancel inputs are schema-validated in both preload and main. Their successful responses are parsed
again in preload; command acknowledgements must correlate to the submitted command. Interactive
events are parsed as `AgentEventV2Envelope` and must match the outer session ID before crossing into
the renderer. The main process reconnects transiently dropped or overflowed v2 SSE streams from
the last forwarded sequence while that session remains active. A replay gap sends a validated
`replay_reset` snapshot before resuming at the daemon's earliest sequence; a permanent stream
failure sends a sanitized error notice and stops retrying. If you're adding a new capability the
renderer needs, add a narrow, single-purpose function here; resist the temptation to add a generic
"send arbitrary IPC channel + payload" escape hatch, since that's exactly the shape that would let
a compromised renderer reach something it shouldn't.

## Daemon lifecycle from Electron's side

On `app.whenReady()`, `main.ts` spawns the daemon as a child process
(`spawn(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, ... })`),
using `resolveDaemonEntry()` (`electron/resolve-daemon-entry.ts`) to pick the right entry point for
dev/packaged/unpacked, see [packaging.md](packaging.md#resolvedaemonentry) for the three cases. It
then polls the discovery file (`waitForDaemonReady`, 200ms interval, 15s timeout) until it can read
a port+token and successfully call `client.health()`, which doubles as both the readiness check and
the protocol-compatibility check in one call. `daemon:status` IPC events (`connecting` / `ready` /
`unavailable`) let the renderer show its own connection state without ever seeing _why_ in terms of
daemon internals.

`app.requestSingleInstanceLock()` means a second launch of the app focuses the existing window
instead of opening a second one, which would otherwise spawn a second daemon and lose the
single-instance race described in [daemon.md#single-instance-behavior](daemon.md#single-instance-behavior).

On quit, `killDaemon()` first stops admitting interactive creates, aborts their HTTP requests, and
waits through the bounded cleanup window; a create that still resolves is cancelled immediately
instead of joining the active set. It then aborts active SSE
subscriptions, best-effort calls
`POST /sessions/cancel-all` over HTTP to cancel every in-flight v1 session, cancels every tracked
interactive v2 session, then kills the daemon child process. This exists specifically because
Windows' `child.kill()` doesn't deliver a real `SIGTERM` the daemon's own shutdown handler could
otherwise catch, see
[daemon.md#shutdown](daemon.md#shutdown) for the full explanation.

## Renderer trust assumptions

The renderer is treated as **semi-trusted, not adversarial**: it's this repo's own React code,
sandboxed by Electron's process isolation, but it's still the layer closest to whatever the CLI's
output ends up rendering. Concretely: the renderer never receives the daemon's token or base URL
(so even a fully compromised renderer can't reach the daemon directly), and every IPC input from
the renderer is re-validated against the Zod schemas at the `ipcMain.handle` boundary in `main.ts`
, not just trusted because it came from "our own" preload bridge. See the comment on
`daemon:create-session` in `electron/main.ts` for why that revalidation is a distinct concern from
`@agent-dock/client`'s own validation of the daemon's response.

## The working-directory picker

`selectDirectory()` opens a native OS directory picker (`dialog.showOpenDialog`) from the main
process and returns the chosen path (or `null` if cancelled) to the renderer: this is the only way
a session's `cwd` gets set; the renderer cannot read the filesystem itself to construct one.

## Provider and session flow (what the demo UI actually does)

1. On load, the renderer calls `listProvidersV2()` and shows each provider's installation,
   authentication, transport, capability, and sandbox evidence.
2. The user picks a provider, a working directory, and a prompt. The main process verifies the
   workspace trust record before a session can start.
3. `createInteractiveSession(input)` negotiates capabilities and starts the selected provider
   transport. `main.ts` forwards its v2 stream through the narrow preload bridge.
4. `ActivityTimeline.tsx` renders bounded provider-neutral activity cards. Approval and question
   requests use the separate interaction broker and focused security dialogs.
5. `cancelInteractiveSession(id)` is available while a session is running. Protocol v1 envelopes
   remain supported by the timeline model during migration, but the demo flow uses v2.

## Where to safely add native functionality

- **A new daemon capability the UI needs**: add the IPC handler in `main.ts`, the typed function in
  `preload.ts`'s `AgentDockBridge`, and call it from the renderer through `window.agentDock`. Don't
  add a daemon call directly in renderer code.
- **A new native OS integration** (file picker, notifications, tray icon, etc.): same pattern, main
  process owns the Electron/Node API, preload exposes a narrow typed function, renderer calls it.
  Never enable `nodeIntegration` or disable `contextIsolation`/`sandbox` to shortcut this.
- **Rendering content that isn't this repo's own UI** (e.g. a tool result containing a link or
  HTML): route external links through `shell.openExternal` (already the default for any navigation
  away from the app, see [BrowserWindow security settings](#browserwindow-security-settings) above)
  rather than loading them in-window.

## Build tooling

`vite-plugin-electron/simple` (`vite.config.ts`) bundles `electron/main.ts` and `electron/preload.ts`
with esbuild and drives the Electron process during `vite dev` (launch + reload on change); `vite
build` produces the same `dist-electron/` output for packaging. `preload.js` is forced to CommonJS
output (`format: 'cjs'`) since Electron's sandboxed preload loader doesn't support ESM, even though
the rest of this project is `"type": "module"`.
