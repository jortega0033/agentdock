# Security

The daemon can invoke powerful local coding agents that read and write files and run shell
commands. This document states the threat model this boilerplate defends against, exactly how,
and what's explicitly out of scope. It has been through an adversarial audit (reproducing attacks
against a running instance, not just reviewing the code) — see the "verified" notes throughout for
what was actually demonstrated versus what follows from the design.

## Threat model

**Primary threat: a malicious or compromised webpage running in the user's ordinary browser must
not be able to POST to the daemon and make Claude/Codex modify local files.** The daemon binds to
`127.0.0.1`, which any local process — including a browser tab — can reach. Binding to localhost
is necessary for this project to work at all, so everything below exists to make that binding
safe.

Secondary threats: another local process reading the daemon's auth token off disk, a compromised
renderer trying to execute arbitrary code, a cancelled/crashed CLI session leaking an orphaned
process, and two daemon instances racing over the same discovery file.

**Out of scope** (by design, not oversight): protecting against another process running as the
*same* OS user with equivalent privileges — if that process can read your files, it can already do
everything the CLI itself can do. This is a localhost trust boundary, not a sandbox. Concretely,
this also covers the discovery file's write path: it's written with a plain `fs.writeFileSync`, not
hardened against a symlink another same-user process could plant at that path first — a same-user
attacker who can pre-place a symlink already has your files.

## Renderer never talks to the daemon directly

This is the load-bearing design decision, and it exists because of something an earlier version of
this project got wrong and an adversarial audit caught: **a browser fetch from the renderer to the
daemon cannot actually complete**, even with the right token. Any request carrying an
`Authorization` header is non-simple and forces a CORS preflight; the daemon deliberately never
answers a preflight with `Access-Control-Allow-Origin` (see below), so Chromium — which is exactly
what an Electron renderer uses for networking — refuses to send the real request at all. **Verified**:
reproduced with a real browser tab pointed at the Vite dev server, `fetch()`ing the daemon with a
valid token failed with `TypeError: Failed to fetch`, and DevTools showed the actual cause —
*"Response to preflight request doesn't pass access control check: No 'Access-Control-Allow-Origin'
header is present."* This is true in a packaged build too: a `file://`-loaded page is still a
distinct origin from `http://127.0.0.1:<port>` and still triggers the same preflight.

The fix is architectural, not a CORS exception: **all daemon HTTP/SSE traffic happens in Electron's
main process** (`apps/desktop/electron/daemon-client.ts` + `main.ts`), which uses Node's networking
stack (undici) — CORS is a browser/fetch-spec concept enforced by Chromium's renderer process, not
by the `fetch` function itself, so main-process fetch was never subject to it. **Verified**: the
same request that failed from a real browser tab succeeds immediately from plain Node `fetch()`
against the same daemon. The renderer talks to main only through a handful of narrow, typed IPC
capabilities (`electron/preload.ts`): `listProviders()`, `createSession()`, `cancelSession()`,
`onSessionEvent()`, `selectDirectory()`. **The daemon's bearer token and base URL never cross into
the renderer at all** — they live only in main-process memory — which also closes off a class of
"token leaks into the DOM/renderer console/a crash report" concerns by construction rather than by
convention.

One consequence: the daemon no longer needs *any* browser origin allowlisted, in dev or production
— `AGENT_DOCK_ALLOWED_ORIGINS` is left unset when Electron spawns the daemon, and the page's CSP
`connect-src` is just `'self'` (the renderer makes zero network calls to the daemon to restrict).
The daemon's HTTP+SSE API is unchanged and still fully usable by any *non-browser* client — `curl`,
a future CLI client, a VS Code extension — exactly as designed; only the desktop app's own renderer
was ever the problem, and only the desktop app's own transport changed.

## Local-auth token

The daemon generates a random 32-byte token (`crypto.randomBytes(32).toString('hex')`) at
**every** startup — it is never persisted across restarts and never hardcoded. Every route except
`GET /health` requires it:

```
Authorization: Bearer <token>
```

Requests without a valid token get `401`, compared with `crypto.timingSafeEqual` to avoid a timing
side-channel (`apps/daemon/src/auth-token.ts`).

The token reaches Electron's main process — never the renderer, see above — through a **filesystem
handoff, not a network one**: the daemon writes `{ port, token, pid, startedAt }` to
`os.tmpdir()/agent-dock/daemon.json` with file mode `0600` once it's listening, and main reads that
file directly (it runs as the same OS user).

### Why a bearer token defeats the "malicious webpage" threat specifically

A page running in a real browser tab, at some `http://evil.example` origin, can absolutely send a
request to `http://127.0.0.1:<port>` — that's just how the web works, and no amount of "the server
only listens on localhost" changes that. What stops it:

1. **It doesn't know the token.** The token lives in a file the daemon writes with `0600`
   permissions and never crosses into any renderer; a webpage has no filesystem access at all.
2. **The daemon never sends CORS headers.** No `@fastify/cors`-style plugin is installed, and no
   route ever sets `Access-Control-Allow-Origin`. `Authorization` is a
   ["non-simple" header](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS#simple_requests),
   so a cross-origin `fetch` that sets it triggers a CORS preflight (`OPTIONS`) first — and
   because the daemon never answers a preflight with permission, the browser refuses to send the
   real request at all. **Verified**: a preflight `OPTIONS /sessions` from a disallowed origin gets
   `403` from our own Origin check before Fastify would even route it to a handler, and no route
   ever adds `Access-Control-Allow-*` response headers regardless.

Point 2 is the one that actually matters even if a token somehow leaked: without permissive CORS,
a browser will not let cross-origin script read the response of a state-changing request even for
requests that *don't* need a preflight (e.g. a plain `<form>` POST, or a `fetch` with
`Content-Type: text/plain`) — but the request could still fire. That's exactly why every mutating
route additionally requires the token: form-based "blind" CSRF can't set a custom `Authorization`
header, so it can't pass the token check either. **Verified**: a simulated cross-origin form-style
POST (`Content-Type: text/plain`, no auth header, `Origin: http://evil.example`) to `POST /sessions`
was rejected before session creation, by the Origin check specifically.

`server.ts` also validates the `Origin` header independently of the token: any `http(s)://` origin
not in an explicit allowlist (empty by default; only ever used to permit a Vite dev server during
development, and even then only for the daemon's *own* dev-time diagnostics, since the renderer no
longer calls it directly) gets `403` before the auth check runs — as does the literal origin value
`"null"` (what a sandboxed iframe, a `data:` URI, or some `file://` contexts send). Requests with no
`Origin` header at all — `curl`, another local process, Electron's own main process — pass this
check and fall through to the token check, since a real browser cannot omit `Origin` on a
cross-origin request; only non-browser contexts can.

## What the daemon will never do

- Read a Claude/Codex/any-provider credential file, keychain entry, or OAuth token directly.
- Accept an executable path or name from a request body — `POST /sessions` only accepts a
  `provider` id from a closed enum (`packages/shared/src/schemas.ts`); the actual executable is
  always resolved internally via `findExecutable()`. **Verified**: an unknown `provider` value
  fails Zod validation with `400` before reaching any handler; extra/unknown body fields (e.g. an
  `executable` or `env` field slipped into the request) are silently dropped by Zod, never read.
- Interpolate a prompt (or anything else request-supplied) into a shell string. Every process is
  spawned with `shell: false` and an argv array (`packages/agent-runtime/src/process/spawn-process.ts`).
- Listen on any interface other than `127.0.0.1` by default. **Verified**: `http://[::1]:<port>`
  (IPv6 loopback) gets no response — the daemon binds IPv4-only, not dual-stack.
- Log a complete environment, a raw auth-status response, or a full prompt at the default log
  level (`packages/agent-runtime/src/logger.ts` redacts any meta key matching
  `/token|secret|password|authorization|api[-_]?key|credential/i`). A non-zero process exit *does*
  log a bounded (2000-char) stderr snippet at `warn` — that's the CLI's own diagnostic output, not
  daemon secrets, and a failure with zero visible reason is undebuggable; see
  [providers.md](providers.md) for why this exists.
- Leak the token back through any API response, even an error body. **Verified** by regression
  test (`apps/daemon/test/server.test.ts`).

## Request validation

Every request body and path/query parameter that reaches a route handler is validated with Zod
(`packages/shared/src/schemas.ts`) before touching any business logic. Invalid input — an unknown
provider, a non-UUID session id, a prompt over the size cap, a wrong-typed field, malformed JSON,
an oversized body — gets a sanitized `4xx` with a short error message, never a stack trace
(`app.setErrorHandler` in `apps/daemon/src/server.ts` preserves Fastify's own `4xx` status codes
for genuine client errors like "malformed JSON" but flattens anything without one to a generic
`500`, so an unexpected internal error never leaks implementation detail while a bad request still
gets an accurate, actionable status).

## Process hygiene

See [architecture.md#process-management](architecture.md#process-management) for the full detail;
the security-relevant summary is that every provider CLI is spawned detached from the daemon (its
own process group on POSIX) and killed as a whole tree on cancellation (`taskkill /T /F` on
Windows, a negative-pid `SIGTERM`→`SIGKILL` escalation on POSIX). **Verified on Windows**: a test
fixture that spawns a real grandchild process (simulating a CLI that itself launches a tool
subprocess) confirmed the grandchild stops running within ~1s of cancellation, not just the direct
child (`packages/agent-runtime/test/run-session.test.ts`). The POSIX path uses the equivalent,
well-established process-group mechanism but was not independently re-verified on macOS/Linux in
this audit (no such machine was available) — treat it as documented behavior, not empirically
re-confirmed on every platform.

## Environment inheritance (a deliberate tradeoff, not an oversight)

Provider CLIs are spawned with the daemon's **full environment** (`process.env`) unless a caller
overrides `StartSessionOptions.env`, which nothing in this codebase currently does. This is a
conscious choice, not an accident: `claude`/`codex` need `PATH`, `HOME`/`USERPROFILE`, and
platform-specific variables to even locate their own config and credentials, and stripping the
environment down to a hand-picked safe subset risks silently breaking legitimate CLI
authentication — a worse failure mode for a boilerplate whose entire point is "use the CLI's own
auth" than inheriting a somewhat broader environment than strictly necessary. The daemon itself
never returns its environment (or the child's) through any API response or log line. If you fork
this project into a context where the daemon's own process might carry secrets unrelated to the
providers (e.g. it's started from a shell profile that also exports cloud credentials), that's a
reason to start the daemon from a more minimal environment yourself — not something this codebase
currently does for you.

## Single daemon instance

Every client discovers the daemon through one fixed path
(`os.tmpdir()/agent-dock/daemon.json`), so two daemons running at once would silently race over it
— whichever started last "wins" the file, leaving the other alive but unreachable through
discovery. Rather than accept that ambiguity, the daemon refuses to start if the discovery file's
recorded pid is still alive (`apps/daemon/src/discovery-file.ts#assertNoLiveDaemon`), and treats a
stale file (dead pid, or corrupt from an interrupted write) as safe to overwrite. **Verified**:
starting a second `pnpm daemon` while the first is still running fails fast with an explicit
"already running (pid ...)" error instead of silently binding a second instance.

## Electron hardening

`apps/desktop/electron/main.ts` creates its `BrowserWindow` with:

```ts
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  preload: join(__dirname, 'preload.js'),
}
```

`webSecurity` is never disabled (there is no override anywhere in this codebase — leaving it at its
secure default). The window also denies `window.open`/`target=_blank` popups and any in-window
navigation away from the app's own origin (`setWindowOpenHandler` returning `{ action: 'deny' }`,
a `will-navigate` handler that only allows the dev-server origin or `file://`); anything else opens
in the OS's default browser instead via `shell.openExternal`. Neither is load-bearing for the
*current* UI (it renders no untrusted content or links), but it's cheap defense in depth for forks
of this boilerplate that later add either.

The preload script (`electron/preload.ts`) exposes exactly five narrow, single-purpose, typed
operations via `contextBridge` — list providers, create a session, cancel a session, subscribe to
session events, open a native directory picker — never a generic "invoke this IPC channel with
this payload" tunnel, and never the daemon's connection info (see "Renderer never talks to the
daemon directly" above). There is no `remote` module, no `eval`, and no path by which the renderer
can execute an arbitrary shell command, read an arbitrary file, or reach any daemon route this
bridge doesn't explicitly expose. The page's `Content-Security-Policy` is
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'` — no
`unsafe-eval`, and `connect-src` is just same-origin now that the renderer makes no network calls
of its own.

## Reporting a vulnerability

This is boilerplate, not a hosted service — if you find a security issue in it, please open an
issue (or, for something sensitive, contact the maintainers privately first) rather than filing a
public exploit writeup.
