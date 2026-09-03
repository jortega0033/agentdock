# Security

The daemon can invoke local coding agents that read and write files and run shell
commands. This document states exactly what AgentDock defends against, how, and what's explicitly
out of scope, so a fork of this boilerplate can reason about its own trust boundary instead of
inheriting one on faith. It has been through an adversarial audit (reproducing attacks against a
running instance, not just reviewing the code). See the "Verified" notes throughout for what was
actually demonstrated versus what follows from the design.

## What this protects against

- A malicious or compromised **webpage running in an ordinary browser tab** (anywhere, not just
  inside this app) issuing requests to the daemon's `127.0.0.1` port and getting Claude/Codex to
  read or modify local files.
- The **renderer process** (React UI) reading the daemon's bearer token or reaching daemon
  functionality outside the explicit, typed IPC capabilities the preload bridge exposes. The
  bridge has no base-URL property, but forwarded client network-error text can include that URL; it
  is connection metadata, not an authentication secret.
- A request choosing **which executable runs**: `POST /sessions` only ever accepts a `provider`
  id from a closed enum; the actual binary path is always resolved internally.
- **Shell interpolation**: every provider CLI is spawned with `shell: false` and an argv array;
  nothing request-supplied is ever concatenated into a shell string.
- **Casual credential leakage**: the daemon never reads a credential file/keychain entry/OAuth
  token itself, never logs one, and never returns its own bearer token in any API response.

## What this does NOT claim to protect against

- **Another process running as the same OS user with equivalent privileges.** If a process can
  already read your files, it can already do everything the CLI itself can do. This is a
  localhost trust boundary, not a sandbox between OS users or processes.
- **A compromised Claude or Codex CLI installation.** AgentDock spawns the CLI you already
  installed and authenticated; it does not vet, sandbox, or restrict what that CLI does once
  running.
- **Malicious code already running with equivalent local privileges** (e.g. another app on the
  same machine, running as the same user, that decides to read the discovery file or plant a
  symlink at its path before the daemon writes it). A same-user attacker in that position already
  has your files.
- **Provider-side security issues**: anything in Anthropic's or OpenAI's own infrastructure, auth
  systems, or CLI implementations is out of this project's scope entirely.

## V2 capability and workspace trust model

The v2 provider path assigns explicit workspace trust and requires a trusted workspace for Claude
Agent SDK sessions. The SDK policy disables settings, MCP, hooks, plugins, skills, agents, and Bash;
only the reviewed SDK auth sources (Anthropic API key, Bedrock, Vertex, or Foundry) are eligible.
Claude.ai/subscription OAuth and `CLAUDE_CODE_OAUTH_TOKEN` are excluded. AgentDock never stores or
logs credentials, and does not fall back from accepted SDK work to the CLI compatibility transport
under a different
auth source. The `BrowserWindow` renderer sandbox described later in this file is unrelated to
isolation of an agent's shell, filesystem, or network access.

The implemented v2 path adds evidence-backed capability negotiation, default-untrusted workspaces,
platform-specific sandbox states, approval/audit rules, credential boundaries, durable normalized
history, and guarded transport fallback. The exact guarantees are bound to the negotiated transport
and its evidence; the Claude SDK policy above must not be attributed to the CLI compatibility
transport. See
[Capability and security model for protocol v2](docs/capability-security-v2.md).

## Renderer never talks to the daemon directly

This is the load-bearing design decision, and it exists because of something an earlier version of
this project got wrong and an adversarial audit caught: **a browser fetch from the renderer to the
daemon cannot actually complete**, even with the right token. Any request carrying an
`Authorization` header is non-simple and forces a CORS preflight; the daemon deliberately never
answers a preflight with `Access-Control-Allow-Origin` (see below), so Chromium (which is exactly
what an Electron renderer uses for networking) refuses to send the real request at all. **Verified**:
reproduced with a real browser tab pointed at the Vite dev server, `fetch()`ing the daemon with a
valid token failed with `TypeError: Failed to fetch`, and DevTools showed the actual cause:
_"Response to preflight request doesn't pass access control check: No 'Access-Control-Allow-Origin'
header is present."_ This is true in a packaged build too: a `file://`-loaded page is still a
distinct origin from `http://127.0.0.1:<port>` and still triggers the same preflight.

The fix is architectural, not a CORS exception: **all daemon HTTP/SSE traffic happens in Electron's
main process** (`apps/desktop/electron/main.ts`, via `@agent-dock/client`), which uses Node's
networking stack. CORS is a browser/fetch-spec concept enforced by Chromium's renderer process,
not by the `fetch` function itself, so main-process fetch was never subject to it. **Verified**: the
same request that failed from a real browser tab succeeds immediately from plain Node `fetch()`
against the same daemon. The renderer talks to main through the explicit, typed operations declared
by `AgentDockBridge` in `electron/preload.ts`; these cover daemon status, provider and integration
controls, legacy and interactive sessions, interactions, workspace trust/audit, worktrees,
attachments/structured workflows, and native pickers. There is no generic IPC invoke tunnel.
**The daemon's bearer token never crosses into the renderer.** The token and base URL exist in the
per-user discovery file for local clients and in daemon/main-process memory while running, but the
preload bridge exposes neither as a property. The two status-reporting functions
(`getDaemonStatus`/`onDaemonStatus`) reconstruct a clean `{ state, error? }` object from whatever
main sends, so extra token/base-URL fields cannot ride along. One narrower limitation remains:
`AgentDockClient` includes its base URL in some network-error messages, and IPC handlers that forward
those errors can expose that non-secret URL text to the renderer. See
`apps/desktop/test/preload.test.ts` for the status-object regression tests.

One consequence: the daemon no longer needs _any_ browser origin allowlisted, in dev or production.
There is no configuration knob for this at all: the daemon rejects every request that carries an
Origin header, unconditionally (see [Origin validation](#origin-validation) below), and the
renderer's CSP `connect-src` is just `'self'` (it makes zero network calls to the daemon to
restrict). The daemon's HTTP+SSE API is unchanged and still fully usable by any _non-browser_
client (`curl`, a future CLI client, a VS Code extension) exactly as designed; only the desktop
app's own renderer was ever the problem, and only the desktop app's own transport changed.

## Local-auth token

The daemon generates a random 32-byte token (`crypto.randomBytes(32).toString('hex')`) at
**every** startup. It is never persisted across restarts and never hardcoded. Every route except
`GET /health` requires it:

```
Authorization: Bearer <token>
```

Requests without a valid token get `401`, compared with `crypto.timingSafeEqual` to avoid a timing
side-channel (`apps/daemon/src/auth-token.ts`).

The token reaches Electron's main process (never the renderer, see above) through a **filesystem
handoff, not a network one**: the daemon writes `{ port, token, pid, startedAt }` to a discovery
file once it's listening, and main reads that file directly (it runs as the same OS user). The
file itself is written mode `0600`; its containing directory (`os.tmpdir()/agent-dock/`, shared by
every AgentDock-based app on the machine) is created mode `0700` on POSIX, and if it already
exists, the daemon verifies it's still owned by the current user with mode `0700` before writing
into it, refusing to start otherwise. `os.tmpdir()` is a shared, sometimes world-writable root on
Linux (Windows and macOS both return a per-user directory already), so without this check a
different local user could have pre-staged the directory to intercept the handoff. There is no
equivalent POSIX-style check on Windows: NTFS ACLs are inherited from the parent by default, which
for a per-user temp root is already restrictive, and a `chmod`-style check would be a claim this
codebase can't actually verify there. See `apps/daemon/src/discovery-file.ts`.

The discovery _filename_ is namespaced per application id (default `agent-dock`, overridable via
`AGENT_DOCK_APP_ID`) rather than one fixed name. See
[Single daemon instance](#single-daemon-instance) below for why.

### Why a bearer token defeats the "malicious webpage" threat specifically

A page running in a real browser tab, at some `http://evil.example` origin, can absolutely send a
request to `http://127.0.0.1:<port>`: that's just how the web works, and no amount of "the server
only listens on localhost" changes that. What stops it:

1. **It doesn't know the token.** The token lives in a discovery file with restrictive permissions
   and never crosses into any renderer; a webpage has no filesystem access at all.
2. **The daemon never sends CORS headers.** No CORS plugin is installed, and no route ever sets
   `Access-Control-Allow-Origin`. `Authorization` is a
   ["non-simple" header](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS#simple_requests),
   so a cross-origin `fetch` that sets it triggers a CORS preflight (`OPTIONS`) first, and because
   the daemon never answers a preflight with permission, the browser refuses to send the real
   request at all. **Verified**: a preflight `OPTIONS /sessions` from a disallowed origin gets
   `403` from our own Origin check before Fastify would even route it to a handler, and no route
   ever adds `Access-Control-Allow-*` response headers regardless.

Point 2 is the one that actually matters even if a token somehow leaked: without permissive CORS,
a browser will not let cross-origin script read the response of a state-changing request even for
requests that _don't_ need a preflight (e.g. a plain `<form>` POST, or a `fetch` with
`Content-Type: text/plain`), but the request could still fire. That's exactly why every mutating
route additionally requires the token: form-based "blind" CSRF can't set a custom `Authorization`
header, so it can't pass the token check either. **Verified**: a simulated cross-origin form-style
POST (`Content-Type: text/plain`, no auth header, `Origin: http://evil.example`) to `POST /sessions`
was rejected before session creation, by the Origin check specifically.

## Origin validation

`apps/daemon/src/server.ts` also validates the `Origin` header independently of the token, and
does so before the auth check runs. The policy is deliberately simple: **any request that carries
an `Origin` header at all is treated as browser-authored and rejected with `403`**, unconditionally:
no allowlist, no scheme parsing, no configuration knob. Requests with no `Origin` header at
all (`curl`, another local process, Electron's own main process) pass this check and fall
through to the token check, since a real browser cannot omit `Origin` on a cross-origin request;
only non-browser contexts can.

This replaced an earlier version that only recognized the literal string `"null"` and
`/^https?:\/\//i` as "browser-authored," with an `AGENT_DOCK_ALLOWED_ORIGINS` allowlist meant to
permit a future browser client. Two problems with that version, both fixed by the current policy:
a `chrome-extension://` (or any other non-`http(s)`, non-`"null"` scheme) origin fell straight
through unrecognized, since it matched neither check; and the allowlist itself was inert even when
populated, since nothing ever paired it with a real `Access-Control-Allow-Origin` response header.
An allowlisted browser origin still could not have completed a request, per
[Renderer never talks to the daemon directly](#renderer-never-talks-to-the-daemon-directly) above.
Since there is no legitimate browser-originated caller of this API today, the fix was to delete the
allowlist rather than complete it: treating every `Origin` header as disqualifying is simpler, and
correct for what this daemon actually needs to be reachable by.

## What the daemon will never do

- Read a Claude/Codex/any-provider credential file, keychain entry, or OAuth token directly.
- Accept an executable path or name from a request body: `POST /sessions` only accepts a
  `provider` id from a closed enum (`packages/shared/src/schemas.ts`); the actual executable is
  always resolved internally via `findExecutable()`. **Verified**: an unknown `provider` value
  fails Zod validation with `400` before reaching any handler; extra/unknown body fields (e.g. an
  `executable` or `env` field slipped into the request) are silently dropped by Zod, never read.
- Interpolate a prompt (or anything else request-supplied) into a shell string. Every process is
  spawned with `shell: false` and an argv array (`packages/agent-runtime/src/process/spawn-process.ts`).
- Listen on any interface other than `127.0.0.1` by default. **Verified**: `http://[::1]:<port>`
  (IPv6 loopback) gets no response: the daemon binds IPv4-only, not dual-stack.
- Log a complete environment, a raw auth-status response, a full prompt, or provider stderr
  contents. `packages/agent-runtime/src/logger.ts` redacts any meta key matching
  `/token|secret|password|authorization|api[-_]?key|credential/i`; legacy provider stderr is counted
  without being decoded, persisted, logged, or surfaced. A non-zero exit logs only bounded numeric
  metadata such as exit code, signal, and `stderrBytes`.
- Leak the token back through any API response, even an error body. **Verified** by regression
  test (`apps/daemon/test/server.test.ts`).

The v2 decision preserves these credential invariants and defines which normalized history,
approval metadata, provider extensions, and attachments may be persisted. Designated provider,
cloud, and MCP authentication values, process environments, auth headers/tokens, and
provider-native credential or approval payloads remain non-persistent. Prompts and selected files
can still contain user-supplied secrets and follow the documented content-retention rules. See
[Persistence, retention, and redaction](docs/capability-security-v2.md#persistence-retention-and-redaction).

## Request validation

Structured request bodies and identifiers are checked with shared Zod schemas or narrow explicit
validators before dispatch. Raw attachment streams use route-specific byte, MIME, and quota checks.
Invalid input (an unknown provider, a non-UUID session id, a prompt over the size cap, a wrong-typed
field, malformed JSON, or an oversized body) gets a sanitized `4xx` with a short error message,
never a stack trace. `app.setErrorHandler` in `apps/daemon/src/server.ts` preserves Fastify's own
`4xx` status codes for genuine client errors but flattens anything without one to a generic `500`,
so an unexpected internal error never leaks implementation detail while a bad request still gets an
accurate, actionable status.

## Process hygiene

See [docs/architecture.md](docs/architecture.md#dependency-graph) and
`packages/agent-runtime/src/process/spawn-process.ts` for the full detail. On Windows, the shipped
Job Object host starts the provider inside a `KILL_ON_JOB_CLOSE` job; closing its sole job handle
terminates the owned descendants, and cancellation resolves only after the host is reaped. On
POSIX, the provider is detached into its own process group; cancellation sends group `SIGTERM`,
then `SIGKILL` after a short grace period, and verifies the group disappeared within the bounded
termination window. The Windows Job Object ownership/command-launch path is exercised in the
Windows packaging workflow; focused unit tests cover both platform branches.

## Provider subprocess environment isolation

Every provider subprocess -- one-shot Claude/Codex, Codex app-server, version/auth probes, and
provider CLI control operations (MCP list/configure/act/catalog) -- is spawned with a sanitized,
default-deny environment, never the daemon's full `process.env`. A downstream fork that adds
database or connector secrets to the daemon process cannot have those secrets silently reach a
spawned provider CLI just because a call site forgot to pass an explicit environment: the *default*
itself, at every low-level spawn point (`spawnProcess`/`execCapture` callers, the Codex app-server's
own child spawn), is the sanitized environment, not raw inheritance.

`packages/agent-runtime/src/process/provider-environment.ts` builds it:
`buildLegacyProviderEnvironment(env, { provider })` starts from nothing and copies in only two
groups of names, case-insensitively (rejecting an ambiguous duplicate -- e.g. both `PATH` and
`Path` present -- outright rather than guessing which one is authoritative):

| Group | Keys | Why |
| --- | --- | --- |
| Reviewed OS/runtime | `APPDATA`, `COMSPEC`, `HOME`, `HOMEDRIVE`, `HOMEPATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `LOCALAPPDATA`, `PATH`, `PATHEXT`, `SYSTEMROOT`, `TEMP`, `TMP`, `TMPDIR`, `TZ`, `USERPROFILE`, `WINDIR` | Identical to the Claude Agent SDK's own reviewed set (`sdk-auth.ts`) -- what any spawned native binary needs to start and locate its own config/credential store on disk |
| Provider auth mode | `claude`: `ANTHROPIC_API_KEY`; `codex`: `OPENAI_API_KEY` | Each CLI's own documented environment-variable API-key auth mode. Empirically verified against the real installed `claude`/`codex` CLIs on Windows: `--version`, `auth status --json`, and `login status` all resolve correctly with only the reviewed OS/runtime keys present -- neither CLI needs the daemon to hand it a credential through the environment for its normal interactive-login auth mode |

AgentDock discovery tokens, state paths, app secrets, and every arbitrary `AGENT_DOCK_*` variable
are excluded by construction: they are not in either group, so they are never copied. A fork that
needs one more trusted-host variable (a corporate proxy's CA bundle path, say) extends the matrix
explicitly through `additionalAllowedKeys` at the call site -- never by widening the shared default.

Environment handling remains transport-specific in one respect: the Claude Agent SDK child still
uses its own richer `buildClaudeSdkEnvironment` (per-cloud-auth-source key sets for `bedrock`,
`vertex`, `foundry` in addition to `api_key`, since the SDK negotiates those cloud auth paths
directly), sharing only the case-insensitive lookup/copy primitives and the reviewed OS/runtime key
list with the simpler legacy-CLI builder above -- one set of primitives, not two conflicting
policies. Public status still reports only a non-secret auth-source label, never a credential value.
The exact credential and OAuth boundary is fixed in
[Credentials and OAuth](docs/capability-security-v2.md#credentials-and-oauth).

## Single daemon instance

Every client discovers a given application's daemon through one fixed, namespaced discovery-file
path (`os.tmpdir()/agent-dock/<app-id>.json`, `<app-id>` defaulting to `agent-dock`, see
`apps/daemon/src/discovery-file.ts`). Before listening, the daemon refuses to start if that file's
recorded pid is still alive and treats a stale/corrupt file as safe to overwrite. **Verified**:
starting a second `pnpm daemon` after the first is ready fails fast with an explicit "already
running (pid ...)" error.

This is a best-effort duplicate-start check, not an atomic single-instance lock. Two simultaneous
starts can both check before either writes the discovery file, then coexist while the later writer
wins discovery. The packaged Electron app separately uses its atomic
`app.requestSingleInstanceLock()` to prevent that normal desktop path. Different products with
different `AGENT_DOCK_APP_ID` values intentionally run side by side. Discovery and state-directory
validation both run, so the effective accepted app-id set is 1–64 characters: a lowercase ASCII
letter or digit first, followed only by lowercase ASCII letters, digits, `-`, or `_`. Invalid values
are rejected outright rather than sanitized-by-best-effort, so they cannot be used for path traversal
(`../../etc/passwd`) or to escape the discovery directory entirely (an absolute path). Electron's
desktop app passes its app id to the daemon via that same environment variable at spawn time, and
computes the matching discovery path itself to read the file back. See
`apps/desktop/electron/main.ts`.

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

`webSecurity` is never disabled (there is no override anywhere in this codebase, leaving it at its
secure default). The window also denies `window.open`/`target=_blank` popups and any in-window
navigation away from the app's own content (`setWindowOpenHandler` returning `{ action: 'deny' }`;
a `will-navigate` handler that compares real origins in dev mode (not a `startsWith` prefix
check, which a URL like `http://localhost:5173.evil.example` would have passed against an allowed
`http://localhost:5173`) and in packaged mode allows only the exact `file://` URL of the app's own
`dist/index.html`, not any local file path); anything else opens in the OS's default browser
instead via `shell.openExternal`. A `session.setPermissionRequestHandler` denies every permission
request (camera, microphone, geolocation, notifications, etc.) by default, since nothing in this UI
asks for any of them. The current UI renders normalized provider/user content as inert React text,
not raw HTML or remote pages, and requests no browser permissions. These controls remain defense in
depth for that content and for forks that add links or native features.

The preload script (`electron/preload.ts`) exposes narrow, single-purpose, typed operations via
`contextBridge`, never a generic "invoke this IPC channel with this payload" tunnel and never the
daemon's bearer token or a callable connection object. The bridge is still a powerful surface: it
can start agents and invoke explicit integration, worktree, trust, and approval operations, all of
which remain subject to main/daemon validation and policy. The two daemon-status functions
reconstruct a clean status object from the IPC payload, so accidental extra fields cannot ride
along. Client network-error messages can still contain the daemon base URL as noted above. There is
no `remote` module or `eval`, and no generic direct shell, filesystem, or daemon-route passthrough.
The page's `Content-Security-Policy` is
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'`: no
`unsafe-eval`, and `connect-src` is just same-origin now that the renderer makes no network calls
of its own.

## Reporting a vulnerability

This repository does not have a dedicated security contact address. Report vulnerabilities through
[this repository's private security advisory form](https://github.com/jortega0033/agentdock/security/advisories/new)
rather than filing a public issue, pull request, or exploit writeup. Include reproduction steps,
affected versions, impact, and any suggested mitigation. Avoid disclosing details publicly until a
fix or coordinated disclosure is ready.
