# Security

The daemon can invoke powerful local coding agents that read and write files and run shell
commands. This document states exactly what AgentDock defends against, how, and what's explicitly
out of scope — so a fork of this boilerplate can reason about its own trust boundary instead of
inheriting one on faith. It has been through an adversarial audit (reproducing attacks against a
running instance, not just reviewing the code) — see the "Verified" notes throughout for what was
actually demonstrated versus what follows from the design.

## What this protects against

- A malicious or compromised **webpage running in an ordinary browser tab** — anywhere, not just
  inside this app — issuing requests to the daemon's `127.0.0.1` port and getting Claude/Codex to
  read or modify local files.
- The **renderer process** (React UI) reading the daemon's bearer token or base URL, or reaching
  any daemon route beyond the seven narrow IPC capabilities the preload bridge exposes.
- A request choosing **which executable runs** — `POST /sessions` only ever accepts a `provider`
  id from a closed enum; the actual binary path is always resolved internally.
- **Shell interpolation** — every provider CLI is spawned with `shell: false` and an argv array;
  nothing request-supplied is ever concatenated into a shell string.
- **Casual credential leakage** — the daemon never reads a credential file/keychain entry/OAuth
  token itself, never logs one, and never returns its own bearer token in any API response.

## What this does NOT claim to protect against

- **Another process running as the same OS user with equivalent privileges.** If a process can
  already read your files, it can already do everything the CLI itself can do — this is a
  localhost trust boundary, not a sandbox between OS users or processes.
- **A compromised Claude Code or Codex CLI installation.** AgentDock spawns the CLI you already
  installed and authenticated; it does not vet, sandbox, or restrict what that CLI does once
  running.
- **Malicious code already running with equivalent local privileges** — e.g. another app on the
  same machine, running as the same user, that decides to read the discovery file or plant a
  symlink at its path before the daemon writes it. A same-user attacker in that position already
  has your files.
- **Provider-side security issues** — anything in Anthropic's or OpenAI's own infrastructure, auth
  systems, or CLI implementations is out of this project's scope entirely.

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
main process** (`apps/desktop/electron/main.ts`, via `@agent-dock/client`), which uses Node's
networking stack — CORS is a browser/fetch-spec concept enforced by Chromium's renderer process,
not by the `fetch` function itself, so main-process fetch was never subject to it. **Verified**: the
same request that failed from a real browser tab succeeds immediately from plain Node `fetch()`
against the same daemon. The renderer talks to main only through seven narrow, typed IPC
capabilities (`electron/preload.ts`): `getDaemonStatus()`, `onDaemonStatus()`, `listProviders()`,
`createSession()`, `cancelSession()`, `onSessionEvent()`, `selectDirectory()`. **The daemon's
bearer token and base URL never cross into the renderer at all** — they live only in main-process
memory — which closes off "token leaks into the DOM/renderer console/a crash report" by
construction rather than by convention. The two status-reporting functions
(`getDaemonStatus`/`onDaemonStatus`) reconstruct a clean `{ state, error? }` object from whatever
main sends rather than passing the IPC payload through unvalidated, specifically so an accidental
extra field on the main-process side (a token, a base URL) can never cross into the renderer even
by mistake — see `apps/desktop/test/preload.test.ts` for the regression test against the real
module, not a mock of it.

One consequence: the daemon no longer needs *any* browser origin allowlisted, in dev or production.
There is no configuration knob for this at all — the daemon rejects every request that carries an
Origin header, unconditionally (see [Origin validation](#origin-validation) below) — and the
renderer's CSP `connect-src` is just `'self'` (it makes zero network calls to the daemon to
restrict). The daemon's HTTP+SSE API is unchanged and still fully usable by any *non-browser*
client — `curl`, a future CLI client, a VS Code extension — exactly as designed; only the desktop
app's own renderer was ever the problem, and only the desktop app's own transport changed.

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
handoff, not a network one**: the daemon writes `{ port, token, pid, startedAt }` to a discovery
file once it's listening, and main reads that file directly (it runs as the same OS user). The
file itself is written mode `0600`; its containing directory (`os.tmpdir()/agent-dock/`, shared by
every AgentDock-based app on the machine) is created mode `0700` on POSIX, and if it already
exists, the daemon verifies it's still owned by the current user with mode `0700` before writing
into it, refusing to start otherwise — `os.tmpdir()` is a shared, sometimes world-writable root on
Linux (Windows and macOS both return a per-user directory already), so without this check a
different local user could have pre-staged the directory to intercept the handoff. There is no
equivalent POSIX-style check on Windows: NTFS ACLs are inherited from the parent by default, which
for a per-user temp root is already restrictive, and a `chmod`-style check would be a claim this
codebase can't actually verify there — see `apps/daemon/src/discovery-file.ts`.

The discovery *filename* is namespaced per application id (default `agent-dock`, overridable via
`AGENT_DOCK_APP_ID`) rather than one fixed name — see
[Single daemon instance](#single-daemon-instance) below for why.

### Why a bearer token defeats the "malicious webpage" threat specifically

A page running in a real browser tab, at some `http://evil.example` origin, can absolutely send a
request to `http://127.0.0.1:<port>` — that's just how the web works, and no amount of "the server
only listens on localhost" changes that. What stops it:

1. **It doesn't know the token.** The token lives in a discovery file with restrictive permissions
   and never crosses into any renderer; a webpage has no filesystem access at all.
2. **The daemon never sends CORS headers.** No CORS plugin is installed, and no route ever sets
   `Access-Control-Allow-Origin`. `Authorization` is a
   ["non-simple" header](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS#simple_requests),
   so a cross-origin `fetch` that sets it triggers a CORS preflight (`OPTIONS`) first — and because
   the daemon never answers a preflight with permission, the browser refuses to send the real
   request at all. **Verified**: a preflight `OPTIONS /sessions` from a disallowed origin gets
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

## Origin validation

`apps/daemon/src/server.ts` also validates the `Origin` header independently of the token, and
does so before the auth check runs. The policy is deliberately simple: **any request that carries
an `Origin` header at all is treated as browser-authored and rejected with `403`**, unconditionally
— no allowlist, no scheme parsing, no configuration knob. Requests with no `Origin` header at
all — `curl`, another local process, Electron's own main process — pass this check and fall
through to the token check, since a real browser cannot omit `Origin` on a cross-origin request;
only non-browser contexts can.

This replaced an earlier version that only recognized the literal string `"null"` and
`/^https?:\/\//i` as "browser-authored," with an `AGENT_DOCK_ALLOWED_ORIGINS` allowlist meant to
permit a future browser client. Two problems with that version, both fixed by the current policy:
a `chrome-extension://` (or any other non-`http(s)`, non-`"null"` scheme) origin fell straight
through unrecognized, since it matched neither check; and the allowlist itself was inert even when
populated, since nothing ever paired it with a real `Access-Control-Allow-Origin` response header —
an allowlisted browser origin still could not have completed a request, per
[Renderer never talks to the daemon directly](#renderer-never-talks-to-the-daemon-directly) above.
Since there is no legitimate browser-originated caller of this API today, the fix was to delete the
allowlist rather than complete it: treating every `Origin` header as disqualifying is simpler, and
correct for what this daemon actually needs to be reachable by.

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
  [docs/providers.md](docs/providers.md) for why this exists.
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

See [docs/architecture.md](docs/architecture.md#dependency-graph) and
`packages/agent-runtime/src/process/spawn-process.ts` for the full detail; the security-relevant
summary is that every provider CLI is spawned detached from the daemon (its own process group on
POSIX) and killed as a whole tree on cancellation (`taskkill /pid <pid> /T /F` on Windows, a
negative-pid `SIGTERM`→`SIGKILL` escalation on POSIX). **Verified on Windows**: a test fixture that
spawns a real grandchild process (simulating a CLI that itself launches a tool subprocess)
confirmed the grandchild stops running within ~1s of cancellation, not just the direct child
(`packages/agent-runtime/test/run-session.test.ts`). The POSIX path uses the equivalent,
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

Every client discovers a given application's daemon through one fixed, namespaced discovery-file
path (`os.tmpdir()/agent-dock/<app-id>.json`, `<app-id>` defaulting to `agent-dock` — see
`apps/daemon/src/discovery-file.ts`), so two daemons *sharing the same app id* running at once
would silently race over it — whichever started last "wins" the file, leaving the other alive but
unreachable through discovery. Rather than accept that ambiguity, the daemon refuses to start if
the discovery file's recorded pid is still alive, and treats a stale file (dead pid, or corrupt
from an interrupted write) as safe to overwrite. **Verified**: starting a second `pnpm daemon`
while the first is still running fails fast with an explicit "already running (pid ...)" error
instead of silently binding a second instance.

This is a per-app-id guarantee, not a machine-global one: two different products built on this
boilerplate, each launched with its own `AGENT_DOCK_APP_ID`, run their own daemons — and their own
independent single-instance locks — side by side without colliding. The app id itself is validated
before it's ever used to build a path (`sanitizeAppId()`: letters, digits, `-`, `_` only, 1–64
characters, must start with a letter or digit) — rejected outright rather than sanitized-by-best-
effort, so it can't be used for path traversal (`../../etc/passwd`) or to escape the discovery
directory entirely (an absolute path). Electron's desktop app passes its app id to the daemon via
that same environment variable at spawn time, and computes the matching discovery path itself to
read the file back — see `apps/desktop/electron/main.ts`.

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
navigation away from the app's own content (`setWindowOpenHandler` returning `{ action: 'deny' }`;
a `will-navigate` handler that compares real origins in dev mode — not a `startsWith` prefix
check, which a URL like `http://localhost:5173.evil.example` would have passed against an allowed
`http://localhost:5173` — and in packaged mode allows only the exact `file://` URL of the app's own
`dist/index.html`, not any local file path); anything else opens in the OS's default browser
instead via `shell.openExternal`. A `session.setPermissionRequestHandler` denies every permission
request (camera, microphone, geolocation, notifications, etc.) by default, since nothing in this UI
asks for any of them. None of this is load-bearing for the *current* UI (it renders no untrusted
content or links, and requests no permissions), but it's cheap defense in depth for forks of this
boilerplate that later add either.

The preload script (`electron/preload.ts`) exposes exactly seven narrow, single-purpose, typed
operations via `contextBridge` — daemon status (queried once, and pushed on change), list
providers, create a session, cancel a session, subscribe to session events, open a native directory
picker — never a generic "invoke this IPC channel with this payload" tunnel, and never the
daemon's connection info (see "Renderer never talks to the daemon directly" above). The two
daemon-status functions reconstruct a clean status object from the IPC payload rather than passing
it through once its shape looks roughly right, so an accidental extra field on the main-process
side can't ride along. There is no `remote` module, no `eval`, and no path by which the renderer
can execute an arbitrary shell command, read an arbitrary file, or reach any daemon route this
bridge doesn't explicitly expose. The page's `Content-Security-Policy` is
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'` — no
`unsafe-eval`, and `connect-src` is just same-origin now that the renderer makes no network calls
of its own.

## Reporting a vulnerability

This repository does not (yet) have a dedicated security contact address. Once it's public on
GitHub, please report a security issue through
[GitHub's private security advisory feature](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
on this repository ("Security" tab → "Report a vulnerability") rather than filing a public issue or
exploit writeup. If that feature isn't available yet (e.g. the repo is still private), reach the
maintainers through whatever private channel they've made available and avoid disclosing details
publicly until a fix is out.
