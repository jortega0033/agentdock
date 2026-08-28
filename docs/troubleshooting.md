# Troubleshooting

## Claude/Codex not detected (`installed: false`)

`GET /providers` reports `installed: false` when `findExecutable()` couldn't locate the CLI binary
at all — see [providers.md#executable-discovery](providers.md#executable-discovery) for exactly how
it searches (a real `where`/`which` lookup, then a curated list of common install directories).

- Confirm the CLI actually works from a terminal: `claude --version` / `codex --version`.
- If it works in a terminal but the daemon still reports `installed: false`, the daemon's process
  may have started with a different `PATH` than your shell — this is especially common for a GUI
  app launched from a desktop/Start Menu shortcut rather than a terminal. `findExecutable()`'s
  fallback directory list exists specifically for this; if your install location isn't in it
  (`packages/agent-runtime/src/detect-executable.ts#commonInstallDirs`), that's a real gap worth
  reporting or extending.
- Restart the daemon after installing a CLI for the first time — `findExecutable()` runs fresh on
  every `GET /providers` call, but a shell-level `PATH` change made *after* the daemon's own
  process started won't be picked up without restarting the daemon itself (the daemon inherits its
  environment once, at spawn time).

## `authenticated: "unknown"` — what it means

This is a distinct, deliberate state, not a bug — see
[providers.md#providerstatus](providers.md#providerstatus). It means the adapter's own login-status
check (`claude auth status --json` / `codex login status`) failed, timed out, or returned output the
parser couldn't confidently interpret. It is **never** coerced to `true`. Run the CLI's own status
command directly (`claude auth status`, `codex login status`) to see the real state; if that
succeeds but the daemon still reports `unknown`, the adapter's parser may need updating for a
CLI output format that changed — see the relevant `parser.ts` and its test fixtures in
[providers.md](providers.md).

## Daemon fails to start

**"another agent-dock daemon is already running (pid ..., discovery file ...)"** — see
[daemon.md#single-instance-behavior](daemon.md#single-instance-behavior). Either a daemon really is
already running (check the pid with your OS's task manager / `ps`), or a previous run left a
discovery file whose pid happens to be reused by an unrelated process now running (rare, but
possible on a long-lived machine). If you're sure nothing is actually using it, deleting the
discovery file lets the daemon start fresh — its path is `os.tmpdir()/agent-dock/daemon.json` (do
not treat this as a workaround to reach for by default; understand why the lock exists first, in
[daemon.md](daemon.md#single-instance-behavior)).

**Port already in use** — only relevant if you set `AGENT_DOCK_PORT` to a fixed value; the default
(`0`, an OS-assigned ephemeral port) can't collide. Either free the port or unset
`AGENT_DOCK_PORT`.

**No visible error at all** — run with `AGENT_DOCK_LOG_LEVEL=debug pnpm daemon` for more detail; see
[daemon.md#logging](daemon.md#logging).

## Protocol mismatch

`ProtocolMismatchError` from `@agent-dock/client` means the client's `AGENT_DOCK_PROTOCOL_VERSION`
and the running daemon's don't match. In this repo, the client and daemon are built from the same
workspace and versioned together, so this should only happen if you're running a daemon built from
a different checkout than the desktop app (e.g. an old `pnpm daemon` left running from before a
protocol-affecting change, still holding the discovery file). Stop the stale daemon and let the
current one start — see [Daemon fails to start](#daemon-fails-to-start) above if that's the
symptom. See [protocol-v1.md](protocol-v1.md) for what counts as a breaking, version-bumping
change.

## Session starts but no events arrive

1. Confirm the session actually started: `GET /sessions/:id` should show `status: "running"` (or
   `"failed"` with an `error` message, which is your actual answer).
2. Check the daemon's own log output — a non-zero CLI exit logs a bounded stderr snippet at `warn`
   (see [SECURITY.md#what-the-daemon-will-never-do](../SECURITY.md#what-the-daemon-will-never-do)
   for exactly what is and isn't logged). This is usually the fastest way to see what actually went
   wrong inside the CLI itself, since a bare `session.failed` message is deliberately generic.
3. If you're calling the SSE endpoint directly (not through `@agent-dock/client`), confirm you're
   reading the stream incrementally, not buffering the whole response — some HTTP clients (and some
   `curl` flag combinations) don't stream by default.
4. A working directory that doesn't exist fails fast at `POST /sessions` with `400`, before any
   process is spawned — this is not a "no events" case, it's a request rejected up front.

## Cancellation doesn't seem to fully stop things

Cancellation kills the provider CLI's whole process tree, not just the direct child — see
[daemon.md#cancellation-and-process-tree-kill](daemon.md#cancellation-and-process-tree-kill) for the
exact mechanism per platform. This was empirically verified on Windows (a real grandchild process
was confirmed killed within ~1s). The POSIX path uses the standard, well-documented process-group
mechanism but hasn't been independently re-verified on macOS/Linux in this project — if you find a
case where a POSIX grandchild survives cancellation, that's a real gap worth reporting with
reproduction steps.

## Windows SmartScreen warning on the installed app

Expected — the installer and app are unsigned. See
[packaging.md#unsigned-installer-and-smartscreen](packaging.md#unsigned-installer-and-smartscreen).
This is not a packaging bug to "fix" without acquiring a real code-signing certificate, which is out
of scope for this project.

## `pnpm build` succeeded but the packaged app doesn't work

`pnpm build` and `pnpm package:win` catch different failure classes — see
[packaging.md#verifying-a-packaging-sensitive-change](packaging.md#verifying-a-packaging-sensitive-change).
If you changed anything under `apps/desktop/electron/` or `electron-builder.yml`, `pnpm build`
alone was never sufficient to catch a packaging-mode-only bug; you need to actually run
`pnpm package:win` and launch `dist-packages/win-unpacked/AgentDock.exe`.

## Testing without a real Claude/Codex account

You don't need one. The test suite never calls a real provider CLI or spends real API credit — see
[DEVELOPMENT.md](../DEVELOPMENT.md#testing-without-paid-providers) for how the fixture-based
approach works (`describeProviderContract()` running against small `node` scripts standing in for
the real CLI). `pnpm test` from a clean checkout, with no `claude`/`codex` installed at all, passes.
