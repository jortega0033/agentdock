# Troubleshooting

## `corepack enable` fails with "command not found"

Some newer Node releases no longer bundle Corepack by default. Install it first, then retry:

```bash
npm install -g corepack
corepack enable
```

Or skip Corepack entirely and install the exact pinned pnpm version directly:

```bash
npm install -g pnpm@10.29.2
```

Both commands install globally; depending on how Node was installed, that may need administrator
rights (Windows) or `sudo` (Linux/macOS), or may work without either if you installed Node through a
per-user version manager (nvm, fnm, volta) rather than a system-wide installer.

Either way, run `pnpm install` afterward. Its first step runs `node scripts/preflight.mjs`
automatically, which reports your active Node version, active pnpm version, and platform, and fails
with a specific fix (rather than a generic error later in install) if either doesn't match what
this repo actually tests. This repo's CI only exercises Node 20.x and 22.x (`package.json`'s
`engines` field); an unsupported Node major is the most common cause of `preflight.mjs` failing --
see [README.md#quick-start](../README.md#quick-start).

## Claude transport mode is unavailable

`AGENT_DOCK_CLAUDE_TRANSPORT` must be exactly `auto`, `sdk`, or `cli`; it defaults to `auto`.
`cli` uses the unchanged legacy Claude CLI path. SDK mode requires Windows' packaged pinned SDK
asset (SDK `0.3.251`, embedded Claude executable `2.1.251`), a trusted workspace, and exactly one
eligible auth source: `ANTHROPIC_API_KEY`, Bedrock, Vertex, or Foundry. Claude.ai/subscription OAuth
and `CLAUDE_CODE_OAUTH_TOKEN` are never eligible. In `auto`, an SDK eligibility miss selects the
legacy CLI before any SDK work is accepted; there is no cross-auth fallback after acceptance.

SDK settings, MCP, hooks, plugins, skills, agents, and Bash are intentionally disabled. If SDK mode
fails closed, use `auto` or `cli` after checking the auth source, trust state, and packaged asset.

## Codex transport mode is unavailable

`AGENT_DOCK_CODEX_TRANSPORT` must be exactly `auto`, `app-server`, or `exec`; it defaults to `auto`.
The app-server path requires the exact validated Codex CLI version, authenticated status, and a
trusted workspace. Forced `app-server` mode fails closed if a gate does not pass. In `auto`, a safe
startup failure may fall back to the legacy exec bridge only before work is delivered; accepted or
ambiguous work is never replayed. See
[providers.md#historical-v02-decision-and-current-v2-transport](providers.md#historical-v02-decision-and-current-v2-transport).

## Claude/Codex not detected (`installed: false`)

For a CLI-backed path, `GET /providers` reports `installed: false` when `findExecutable()` cannot
locate the binary. See [providers.md#executable-discovery](providers.md#executable-discovery):
Windows scans absolute PATH entries directly, POSIX uses `which` without a shell, and both then
check a curated list of common install directories. An eligible Claude SDK asset is detected
separately and does not require a PATH-installed `claude` binary.

- Confirm the CLI actually works from a terminal: `claude --version` / `codex --version`.
- If it works in a terminal but the daemon still reports `installed: false`, the daemon's process
  may have started with a different `PATH` than your shell, this is especially common for a GUI
  app launched from a desktop/Start Menu shortcut rather than a terminal. `findExecutable()`'s
  fallback directory list exists specifically for this; if your install location isn't in it
  (`packages/agent-runtime/src/detect-executable.ts#commonInstallDirs`), that's a real gap worth
  reporting or extending.
- Restart the daemon after installing a CLI for the first time: `findExecutable()` runs fresh on
  every `GET /providers` call, but a shell-level `PATH` change made _after_ the daemon's own
  process started won't be picked up without restarting the daemon itself (the daemon inherits its
  environment once, at spawn time).

## `authenticated: "unknown"`: what it means

This is a distinct, deliberate state, not a bug, see
[providers.md#providerstatus](providers.md#providerstatus). It means the adapter's own login-status
check (`claude auth status --json` / `codex login status`) failed, timed out, or returned output the
parser couldn't confidently interpret. It is **never** coerced to `true`. Run the CLI's own status
command directly (`claude auth status`, `codex login status`) to see the real state; if that
succeeds but the daemon still reports `unknown`, the adapter's parser may need updating for a
CLI output format that changed, see the relevant `parser.ts` and its test fixtures in
[providers.md](providers.md).

## Daemon fails to start

**`another agent-dock daemon (app id "...") is already running (pid ..., discovery file ...)`**: see
[daemon.md#duplicate-start-behavior](daemon.md#duplicate-start-behavior). Either a daemon really is
already running (check the pid with your OS's task manager / `ps`), or a previous run left a
discovery file whose pid happens to be reused by an unrelated process now running (rare, but
possible on a long-lived machine). If you're sure nothing is actually using it, deleting the
discovery file lets the daemon start fresh. Its default path is
`os.tmpdir()/agent-dock/agent-dock.json`; with `AGENT_DOCK_APP_ID=<app-id>`, it is
`os.tmpdir()/agent-dock/<app-id>.json`. Do not treat deletion as a workaround to reach for by
default; understand the live-pid check and simultaneous-start race first in
[daemon.md](daemon.md#duplicate-start-behavior).

**Port already in use**: only relevant if you set `AGENT_DOCK_PORT` to a fixed value; the default
(`0`, an OS-assigned ephemeral port) can't collide. Either free the port or unset
`AGENT_DOCK_PORT`.

**No visible error at all**: enable debug logging for the current shell, then start the daemon.

PowerShell:

```powershell
$env:AGENT_DOCK_LOG_LEVEL = 'debug'
pnpm daemon
```

POSIX shells:

```bash
AGENT_DOCK_LOG_LEVEL=debug pnpm daemon
```

See [daemon.md#logging](daemon.md#logging).

## Protocol mismatch

`ProtocolMismatchError` from `@agent-dock/client` means the client's `AGENT_DOCK_PROTOCOL_VERSION`
and the running daemon's don't match. In this repo, the client and daemon are built from the same
workspace and versioned together, so this should only happen if you're running a daemon built from
a different checkout than the desktop app (e.g. an old `pnpm daemon` left running from before a
protocol-affecting change, still holding the discovery file). Stop the stale daemon and let the
current one start, see [Daemon fails to start](#daemon-fails-to-start) above if that's the
symptom. See [protocol-v1.md](protocol-v1.md) for what counts as a breaking, version-bumping
change.

## Session starts but no events arrive

1. Confirm the session actually started: `GET /sessions/:id` should show `status: "running"` (or
   `"failed"` with an `error` message, which is your actual answer).
2. Check the daemon log for session start and exit state. A non-zero legacy CLI exit records the
   exit code, signal, and stderr byte count only; raw stderr is intentionally not decoded, logged,
   persisted, or surfaced. Run the provider CLI directly in the same working directory for its own
   diagnostic output. See
   [SECURITY.md#what-the-daemon-will-never-do](../SECURITY.md#what-the-daemon-will-never-do).
3. If you're calling the SSE endpoint directly (not through `@agent-dock/client`), confirm you're
   reading the stream incrementally, not buffering the whole response, some HTTP clients (and some
   `curl` flag combinations) don't stream by default.
4. A working directory that doesn't exist fails fast at `POST /sessions` with `400`, before any
   process is spawned: this is not a "no events" case, it's a request rejected up front.

## Cancellation doesn't seem to fully stop things

Cancellation kills the provider CLI's whole process tree, not just the direct child, see
[daemon.md#cancellation-and-process-tree-kill](daemon.md#cancellation-and-process-tree-kill) for the
exact mechanism per platform. This was empirically verified on Windows (a real grandchild process
was confirmed killed within ~1s). Linux CI exercises the POSIX process-group descendant-kill path;
macOS remains unverified. If you find a POSIX grandchild that survives cancellation, report it with
reproduction steps.

## Windows SmartScreen warning on the installed app

Expected: the installer and app are unsigned. See
[packaging.md#unsigned-installer-and-smartscreen](packaging.md#unsigned-installer-and-smartscreen).
This is not a packaging bug to "fix" without acquiring a real code-signing certificate, which is out
of scope for this project.

## `pnpm build` succeeded but the packaged app doesn't work

`pnpm build` and `pnpm package:win` catch different failure classes, see
[packaging.md#verifying-a-packaging-sensitive-change](packaging.md#verifying-a-packaging-sensitive-change).
If you changed anything under `apps/desktop/electron/` or `electron-builder.yml`, `pnpm build`
alone was never sufficient to catch a packaging-mode-only bug; you need to actually run
`pnpm package:win` and launch `dist-packages/win-unpacked/AgentDock.exe`.

## Testing without a real Claude/Codex account

You don't need one. The test suite never calls a real provider CLI or spends real API credit, see
[DEVELOPMENT.md](../DEVELOPMENT.md#testing-without-paid-providers) for how the fixture-based
approach works (`describeProviderContract()` running against small `node` scripts standing in for
the real CLI). `pnpm test` from a clean checkout, with no `claude`/`codex` installed at all, passes.
