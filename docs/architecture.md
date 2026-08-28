# Architecture

## Component diagram

```
┌─────────────────────────┐
│   Renderer (React)        │   window.agentDock.* — five narrow IPC capabilities only.
│                            │   Never sees the daemon's token or base URL.
└─────────────┬────────────┘
              │ Electron IPC (contextBridge, same machine, no network)
              ▼
┌─────────────────────────┐
│   Electron Main            │   Spawns/discovers the daemon. Owns the daemon connection
│   (electron/main.ts)       │   and makes every HTTP/SSE call on the renderer's behalf.
└─────────────┬────────────┘
              │ HTTP + SSE, http://127.0.0.1:<port>, Bearer token
              ▼
┌─────────────────────────┐
│   Local Daemon             │   Fastify HTTP server. Provider discovery, session
│   (apps/daemon)            │   lifecycle, SSE streaming, cancellation. Runs standalone.
└─────────────┬────────────┘
              │ depends on
              ▼
┌─────────────────────────┐
│   Agent Runtime             │   Provider-neutral: AgentProvider interface, process
│   (packages/agent-runtime) │   spawning, JSONL parsing, normalization into AgentEvent.
│  ├── ClaudeProvider ───────┼──▶ `claude` CLI ──▶ user's own Claude Code auth
│  └── CodexProvider ────────┼──▶ `codex` CLI ──▶ user's own Codex auth
└─────────────────────────┘
```

`packages/shared` sits underneath all of this: it's the one place `ProviderId`, `ProviderStatus`,
`AgentSession`, `AgentEvent`, and the Zod request schemas are defined, so the daemon and desktop
app can never drift from what agent-runtime actually produces.

**The renderer never calls the daemon's HTTP+SSE API directly** — only Electron's main process
does. This isn't a style preference; a renderer `fetch()` to the daemon cannot actually succeed
(see [security.md](security.md#renderer-never-talks-to-the-daemon-directly) for why — it comes down
to the daemon correctly never answering a CORS preflight, which is also exactly what keeps a
malicious webpage out). The daemon's HTTP+SSE API itself is unchanged and still the integration
point for any *other* client — `curl`, a future CLI, a VS Code extension — none of which are
subject to browser CORS in the first place.

## Why a separate daemon instead of running the CLI logic in Electron's main process

Three reasons, in order of importance:

1. **A malicious webpage should never be able to run a coding agent on your machine.** Keeping
   agent execution behind an HTTP+token boundary (see [security.md](security.md)) is a much
   smaller, more auditable surface than "whatever the renderer/main process can reach."
2. **The daemon has to outlive one specific UI.** A VS Code extension, a CLI client, or a second
   desktop shell should all be able to talk to the same daemon over the same four-endpoint API
   without re-implementing process management.
3. **Testability.** `pnpm daemon` runs and can be curled directly, with no Electron, no display
   server, and no GUI test harness required.

## Sessions

```ts
type AgentSession = {
  id: string; // daemon-generated UUID — never a process id
  provider: ProviderId;
  cwd: string;
  prompt: string;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  providerSessionId?: string; // the CLI's own session/thread id, once known
  startedAt: string;
  completedAt?: string;
};
```

Sessions live in an in-memory `Map` inside `SessionManager`
([apps/daemon/src/session-manager.ts](../apps/daemon/src/session-manager.ts)). **This is
deliberate for the MVP**: persistence adds a real design surface (schema, migrations, what
happens to a resumed session after a crash) that the spec explicitly defers. Restarting the
daemon loses every session and its event history. A v0.2 that wants durability should add a
pluggable `SessionStore` interface behind `SessionManager` rather than reaching for SQLite
directly — see [Known limitations](#known-limitations--v02-directions).

## Event protocol

Every provider adapter normalizes its CLI's native JSONL into the same `AgentEvent` union (defined
once, in `packages/shared/src/events.ts`):

```ts
type AgentEvent =
  | { type: 'session.started'; sessionId: string; provider: ProviderId; providerSessionId?: string }
  | { type: 'status'; status: string; detail?: string }
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.message'; text: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'tool.started'; toolName: string; toolCallId?: string; input?: unknown }
  | { type: 'tool.completed'; toolName?: string; toolCallId?: string; result?: unknown; isError?: boolean }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cost?: number }
  | { type: 'error'; code?: string; message: string; recoverable: boolean }
  | { type: 'session.completed'; providerSessionId?: string }
  | { type: 'session.failed'; message: string }
  | { type: 'session.cancelled' };
```

The desktop UI renders this union with a single `switch (event.type)`
([apps/desktop/src/components/EventLog.tsx](../apps/desktop/src/components/EventLog.tsx)) — it
never branches on which provider produced an event. Provider-specific parsing lives entirely in
`packages/agent-runtime/src/providers/*/parser.ts` and never leaks past that package.

`thinking.delta` is only ever emitted for reasoning content the CLI itself already puts in its
public, user-visible output stream (Claude Code's `thinking` content blocks). Neither adapter
attempts to reconstruct or expose anything the CLI treats as private.

## Process management

`packages/agent-runtime/src/providers/common/run-session.ts` is the one place every provider's
spawn/parse/normalize lifecycle happens. It:

- validates the working directory exists before spawning anything
- resolves the executable via `findExecutable` (PATH lookup + a curated fallback directory list —
  see [providers.md](providers.md#executable-discovery)), never from a request-supplied path
- spawns with `child_process.spawn`, `shell: false`, and an argv array — prompts are **never**
  interpolated into a shell string
- reads stdout through `readLines` (`process/line-reader.ts`), which tolerates a JSON line split
  across chunk boundaries and multiple JSON lines arriving in one chunk, and caps a single line at
  10MB to bound memory
- captures stderr separately, capped at 200KB, and only surfaces it on a non-zero exit
- on POSIX, spawns the child detached (its own process group) and kills the whole group on
  cancellation; on Windows, uses `taskkill /T /F` to kill the whole tree — either way, cancelling a
  session can't leave a grandchild process (e.g. a shell command the CLI itself launched) orphaned
- always terminates the event stream with exactly one of `session.completed` / `session.failed` /
  `session.cancelled`, so callers never have to guess whether more events might still arrive

## Daemon discovery and lifecycle

For the MVP, Electron spawns the daemon as a sidecar child process
(`apps/desktop/electron/main.ts`) and reads its port + token from a discovery file the daemon
writes to `os.tmpdir()/agent-dock/daemon.json` (mode `0600`) once it's listening — see
[security.md](security.md#local-auth-token) for why a file handoff instead of a network one.

This is explicitly **not** the only way to run it: `pnpm daemon` starts the exact same server
standalone, and nothing in the daemon's code depends on Electron being present. A future
"persistent daemon" mode (survives Electron closing, perhaps installed as a background
service/launch agent) is a pure lifecycle change — the HTTP API and desktop client would not need
to change at all.

`pnpm daemon` and `pnpm --filter @agent-dock/daemon dev` both run the daemon's TypeScript source
directly through `tsx` — fine for development, since `packages/shared` and `packages/agent-runtime`
intentionally publish their source (not a pre-built `dist/`) as their package.json `main`, so tsx
and Vite pick up changes with no separate build step. That means `apps/daemon`'s own `pnpm build`
can't just run `tsc`: the compiled output would still `import` those two packages by name, and a
plain `node dist/index.js` — no tsx, no loader — can't resolve a `.ts` file through a bare package
specifier. **This was an actual bug, not just a theoretical risk**: it was caught by literally
running the packaged-mode code path (`node dist/index.js` after `pnpm build`), which failed with
`ERR_MODULE_NOT_FOUND`. The fix (`apps/daemon/scripts/build.mjs`) bundles the daemon and every
workspace/npm dependency it imports into one self-contained `dist/index.js` via esbuild —
verified afterward by running that exact file with plain `node` and by relaunching the packaged
(non-dev) Electron app end to end.

## Known limitations / v0.2 directions

- **No persistence.** Sessions and their event history are lost on daemon restart, by design (see
  [Sessions](#sessions) above).
- **One daemon per machine, enforced.** The discovery file is a fixed path, so the daemon refuses
  to start if a live daemon already owns it (see [security.md](security.md#single-daemon-instance))
  rather than silently racing another instance for it. A genuine multi-instance story (e.g. running
  two independent copies of an app built on this boilerplate side by side) would need a
  per-instance discovery path — not implemented, since nothing currently needs it.
- **No API-key/cloud provider mode yet.** Everything here assumes a locally authenticated CLI.
- **Electron's own graceful-shutdown path is best-effort on Windows.** Node's `child.kill()` maps
  to `TerminateProcess` on Windows, which does not deliver a real `SIGTERM` the daemon's own
  shutdown handler can catch — see the `killDaemon()` comment in `electron/main.ts` for the
  mitigation (cancelling the one active session over HTTP before killing the child) and its limits.
- **Process-tree cancellation was empirically verified on Windows only** (a real grandchild
  process, simulating a CLI-launched tool subprocess, was confirmed killed within ~1s of
  cancellation). The POSIX path uses the standard, well-documented process-group mechanism but
  wasn't re-verified on macOS/Linux in this audit for lack of a machine to test on.
