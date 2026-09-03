# Electron

`apps/desktop` is a demo Electron + React client for the daemon. It exists to prove the daemon and
`@agent-dock/client` work end to end and to give you a real, working example to fork: it has no
provider-native parsing, launch, or transport logic of its own. The reference form currently
defaults to Claude and explicitly lists Claude/Codex; provider behavior still comes from runtime
status, capability, and transport records.

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
popup and, like every other external-launch path (blocked `will-navigate` targets, OAuth
authorization URLs), routes the target through `parseAllowedExternalUrl()`
(`electron/allowed-external-url.ts`) before it can reach `shell.openExternal`: only an absolute
`https:` URL with a non-empty host and no embedded username/password is opened, in the OS browser.
`file:`, `javascript:`, `data:`, `blob:`, `mailto:`, `tel:`, a custom/unregistered scheme, a bare
UNC/filesystem path, and anything malformed are all rejected before any OS launch, and only a
bounded scheme/host summary is ever logged, never the full URL. `will-navigate`
(`isAllowedNavigationTarget()` in `main.ts`) allows only: in dev mode, the exact dev-server _origin_
(a real `new URL(...).origin` comparison, not a `startsWith` prefix match (the earlier prefix check
would have let `http://localhost:5173.evil.example` through against an allowed
`http://localhost:5173`); in packaged mode, the exact `file://` URL of the app's own
`dist/index.html`, not any local file path. Anything else is validated and redirected to the OS
browser instead. A `session.setPermissionRequestHandler` denies
every permission request by default (camera, mic, geolocation, notifications, ...). The current UI
renders normalized provider/user content as inert React text, not raw HTML or remote pages, and
requests no browser permissions. These settings remain defense in depth for that content and for a
fork that adds links or native features; see [SECURITY.md](../SECURITY.md#electron-hardening).

## The preload bridge

`electron/preload.ts` exposes the explicit `AgentDockBridge` operations on `window.agentDock` via
`contextBridge`, never a generic "invoke this channel with this payload" tunnel and never the
daemon's bearer token or a base-URL property. The current surface covers status/provider discovery,
legacy and interactive session lifecycle/history/continuation, approval and question interactions,
workspace trust/audit, MCP and provider components, subagents/worktrees,
attachments/structured workflows, and native pickers. The interface in `preload.ts` is the
authoritative list.

`getDaemonStatus`/`onDaemonStatus` specifically reconstruct a clean status object from the IPC
payload rather than passing it through once its shape looks roughly right, so an accidental extra
field on the main-process side (a token, a base URL) can never ride along even by mistake. See
`apps/desktop/test/preload.test.ts` for the regression test against this real module.

That field-level guarantee does not sanitize every rejected IPC promise. `AgentDockClient` includes
its base URL in some network-error messages, and main-process handlers can forward that text to the
renderer. The URL is therefore observable failure metadata today; the bearer token is not.

Each operation maps to one fixed request or event channel in `main.ts`. Inputs are validated at the
preload/main boundaries as applicable, and daemon responses are parsed before they cross into the
renderer. Command acknowledgements must correlate to the submitted command. Interactive events are
parsed as `AgentEventV2Envelope` and must match the outer session ID. The main process reconnects
transiently dropped or overflowed v2 SSE streams from the last forwarded sequence while that session
remains active. A replay gap sends a validated `replay_reset` snapshot before resuming at the
daemon's earliest sequence; a permanent stream failure sends a sanitized error notice and stops
retrying. If you're adding a new capability the renderer needs, add a narrow, single-purpose
function here; do not add a generic arbitrary-channel escape hatch.

Every `ipcMain.handle` registration in `main.ts` routes through a local `handle()` wrapper
(`isFromMainWindowFrame()`, `electron/ipc-sender-guard.ts`) instead of calling `ipcMain.handle`
directly: the message must come from the current main window's own top-level frame. A destroyed
window, a secondary `webContents` (e.g. a devtools window), or a non-main child frame of the right
window are all rejected before the handler body runs, rather than relying on "there's only one
window today" as an implicit assumption that silently stops holding the moment a fork adds a second
window or renders untrusted content in an iframe.

## Daemon lifecycle from Electron's side

On `app.whenReady()`, `main.ts` spawns the daemon as a child process
(`spawn(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENT_DOCK_APP_ID: APP_ID }, ... })`),
using `resolveDaemonEntry()` (`electron/resolve-daemon-entry.ts`) to pick the right entry point for
dev/packaged/unpacked, see [packaging.md](packaging.md#resolvedaemonentry) for the three cases. It
then polls the discovery file (`waitForDaemonReady`, 200ms interval, 15s timeout) until it can read
a port+token and successfully call `client.health()`, which doubles as both the readiness check and
the protocol-compatibility check in one call. `daemon:status` IPC events (`connecting` / `ready` /
`unavailable`) let the renderer show its own connection state without ever seeing _why_ in terms of
daemon internals.

`app.requestSingleInstanceLock()` means a second launch of the app focuses the existing window
instead of opening a second one, which would otherwise spawn a second daemon and lose the
simultaneous-start race described in
[daemon.md#duplicate-start-behavior](daemon.md#duplicate-start-behavior).

On quit, `killDaemon()` first stops admitting interactive creates and aborts every active v1 and v2
SSE subscription, then waits through the bounded cleanup window for pending interactive creates; a
create that still resolves after that is cancelled immediately instead of joining the active set.
It then best-effort calls `POST /sessions/cancel-all` over HTTP to cancel every in-flight v1
session, cancels every tracked interactive v2 session, then kills the daemon child process. This
exists specifically because Windows' `child.kill()` doesn't deliver a real `SIGTERM` the daemon's
own shutdown handler could otherwise catch, see
[daemon.md#shutdown](daemon.md#shutdown) for the full explanation.

## Tray lifecycle

Closing the main window does not quit the app: the window's `close` handler hides it instead
(`event.preventDefault(); mainWindow?.hide();`) and a tray icon (`createTray()`, both in
`main.ts`) keeps running, so the daemon and any in-flight sessions stay alive in the background.
Only a real quit — the tray menu's Quit item, `app.quit()` from the OS, or `before-quit` — sets an
`isQuitting` flag that lets the window actually close and runs `killDaemon()`. The tray's "Open
AgentDock" item and a left-click on the icon both restore the hidden window.

## Renderer trust assumptions

The renderer is treated as **semi-trusted, not adversarial**: it's this repo's own React code,
sandboxed by Electron's process isolation, but it's still the layer closest to whatever the CLI's
output ends up rendering. Concretely: the renderer never receives the bearer token or a callable
daemon client, so knowing a loopback URL from an error is not enough to authenticate. IPC input is
re-validated with shared Zod schemas or narrow explicit validators at the `ipcMain.handle` boundary
in `main.ts`, not just trusted because it came from "our own" preload bridge. See the comment on
`daemon:create-session` in `electron/main.ts` for why that revalidation is a distinct concern from
`@agent-dock/client`'s own validation of the daemon's response.

## The working-directory picker

`selectDirectory()` opens a native OS directory picker (`dialog.showOpenDialog`) from the main
process and returns the chosen path (or `null` if cancelled) to the renderer. It is the reference
UI's path-selection convenience, not the trust boundary: session requests carry a renderer-supplied
`cwd` string. The daemon resolves canonical workspace identity, requires an explicit trust record,
and revalidates identity/trust before provider dispatch.

## Provider and session flow (what the demo UI actually does)

1. On load, the renderer calls `listProvidersV2()` and shows each provider's installation,
   authentication, sandbox-policy, OS-isolation, version, and detection-error status. The response
   also carries transport/capability data for negotiation, but the current `ProviderPanel` does not
   render those fields.
2. The user picks a provider, a working directory, and a prompt. Electron main validates and
   forwards the narrow request; the daemon resolves, inspects, and revalidates the current workspace
   trust record before provider detection and dispatch.
3. `createInteractiveSession(input)` negotiates capabilities and starts the selected provider
   transport. `main.ts` forwards its v2 stream through the narrow preload bridge.
4. `ActivityTimeline.tsx` renders bounded provider-neutral activity cards. Approval and question
   requests use the separate interaction broker and focused security dialogs.
5. `cancelInteractiveSession(id)` is available while a session is running. Protocol v1 envelopes
   remain supported by the timeline model during migration, but the demo flow uses v2.

## Where to safely add native functionality

- **A new daemon capability the UI needs**: add the IPC handler in `main.ts`, the typed function in
  `preload.ts`'s `AgentDockBridge`, and call it from the renderer through `getBridge()`
  (`apps/desktop/src/bridge.ts`), not `window.agentDock` directly. `getBridge()` is the only place
  that reads `window.agentDock`; every other call site goes through it so the reference UI's demo
  mode (`apps/desktop/src/demo-bridge.ts`, swapped in via `setBridgeOverride()` in `AppRoot.tsx`)
  can substitute a fixture bridge without touching call sites. Don't add a daemon call directly in
  renderer code.
- **A new native OS integration** (file picker, notifications, etc. — the tray icon already
  follows this pattern, see [Tray lifecycle](#tray-lifecycle) above): same idea, main process owns
  the Electron/Node API, preload exposes a narrow typed function, renderer calls it through
  `getBridge()`. Never enable `nodeIntegration` or disable `contextIsolation`/`sandbox` to
  shortcut this.
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
