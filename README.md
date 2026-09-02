![AgentDock desktop runtime](./docs/images/social/readme-hero.webp)

<p align="center"><strong>Open-source Electron and local-daemon boilerplate for desktop apps that use Claude Agent, the Claude CLI, or Codex CLI.</strong></p>

<p align="center">Electron · Fastify · React · TypeScript · Apache-2.0</p>

## What AgentDock is

AgentDock is fork-first runtime boilerplate for building focused desktop products on top of Claude
Agent, the Claude CLI, or Codex CLI. It supplies reusable Electron and local-daemon
infrastructure; your fork supplies the domain workflow and product layer.

Users authenticate through the Claude Agent SDK, the Claude CLI, or
[Codex CLI](https://github.com/openai/codex). Credentials remain under the provider runtime's
control on the user's machine; AgentDock does not collect, store, or proxy provider API keys. The
included desktop is a reference implementation: run it to understand the flow, then replace its
generic workflow, product copy, and visual identity.

### Use AgentDock when

- You are building a desktop workflow where an agent inspects a real workspace, streams progress,
  and produces a reviewable result -- with pause-for-approval on the transports that support it
  (Claude Agent SDK and Codex app-server; see the [capability matrix](docs/capability-matrix.md)).
- You want a normalized Claude and Codex integration contract (one event shape, one negotiated
  capability model across providers) without exposing daemon credentials to a renderer -- the
  contract is shared, but capability support still varies by provider and transport.
- You plan to fork the codebase and own the downstream product.

### Choose another starting point when

- You need a finished chat application, hosted multi-user backend, credential vault, cloud sync, or
  marketplace.
- You need a drop-in UI component or public npm SDK without maintaining a fork.
- You need a verified installer for a platform other than Windows.

## Boilerplate contract

| AgentDock provides                                                 | Your product owns                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| Electron shell and replaceable reference UI                        | Final workflow, domain UX, and product behavior              |
| Authenticated loopback daemon, typed IPC, and trusted client       | Accounts, hosted backend, cloud sync, and product database   |
| Provider adapters, normalized events, sessions, approvals, history | Domain data, policies, integrations, and evaluation criteria |
| Windows packaging base and replaceable assets                      | Brand identity, signing, distribution, and support           |

AgentDock's local session and history stores are runtime infrastructure, not a product database.
Capability surfaces such as MCP controls, provider components, subagents, worktrees, attachments,
and structured output can vary by provider, transport, platform, and checkout. Verify the relevant
fixtures and tests before promising support in a downstream product.

## Start your fork

1. Fork the repository, install dependencies, and run the reference desktop.
2. Define one focused workflow, or review the
   [product ideas for AgentDock forks](docs/use-cases/README.md).
3. Choose the provider transports and capabilities that workflow requires; verify their support.
4. Replace the reference workflow, `appId`, `productName`, copy, and assets.
5. Preserve the trust boundary: renderer code never receives daemon credentials or calls the daemon
   directly.
6. Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and the packaging checks before
   distribution.

### Downstream example

Open Vacancy Radar is a downstream product built from AgentDock. It keeps the Electron shell,
local daemon, and connection to Claude Agent, the Claude CLI, or Codex CLI, then adds a
vacancy-focused workflow and its own product behavior.

## Quick start

You need [Node.js 20+](https://nodejs.org/) and pnpm 10 (declared through Corepack):

```bash
corepack enable
pnpm install
pnpm dev:desktop
```

Configure at least one provider path. The Claude Agent SDK path uses the pinned Windows asset plus
an eligible Anthropic API key, Bedrock, Vertex, or Foundry environment and does not require a
separate `claude` CLI install. For the Claude CLI path or either Codex transport, install and
authenticate the provider CLI separately:

```bash
# Claude CLI
claude auth login
claude auth status

# Codex
codex login
codex login status
```

The desktop starts and owns the local daemon automatically. To run only the daemon:

```bash
pnpm daemon
```

It prints its loopback URL and discovery-file location at startup. See
[the daemon guide](docs/daemon.md) for health checks and lifecycle details.

## Architecture

![AgentDock runtime flow](./docs/images/architecture/runtime-flow.svg)

The renderer never calls the daemon directly. Electron main uses the private workspace package
`@agent-dock/client`, which owns bearer authentication, protocol compatibility, HTTP requests, and
incremental SSE parsing.

```text
React renderer → typed IPC → Electron main → @agent-dock/client → local Fastify daemon
                                                               └→ agent runtime
                                                                  ├→ Claude Agent SDK or Claude CLI
                                                                  └→ Codex adapter  → app-server or `codex exec`
```

Read [the architecture guide](docs/architecture.md) for component ownership and
[SECURITY.md](SECURITY.md) for the threat model and local-auth mechanism.

### Claude transport modes

Set `AGENT_DOCK_CLAUDE_TRANSPORT` to `auto` (the default), `sdk`, or `cli`. SDK eligibility has
multiple gates: the daemon must run on Windows, resolve the pinned SDK asset, and find either a
user-provided `ANTHROPIC_API_KEY` or exactly one supported Bedrock, Vertex, or Foundry mode. It
never treats Claude.ai/subscription OAuth or `CLAUDE_CODE_OAUTH_TOKEN` as SDK credentials. Each SDK
session also requires a trusted workspace. `auto` uses the Claude CLI compatibility transport when
an SDK gate is unmet before transport selection; `sdk` fails closed. After the SDK is selected, an import, startup,
or query failure does not replay the session through the CLI. See
[the provider guide](docs/providers.md#claude-transport-modes) for the full gate and credential
rules.

### Codex transport modes

Set `AGENT_DOCK_CODEX_TRANSPORT` to `auto` (the default), `app-server`, or `exec`. Protocol v1 uses
`codex exec --json`. For protocol v2, `auto` selects app-server only for the exact validated Codex
CLI version, an authenticated detection snapshot, and a trusted workspace. When app-server is not
selected, `auto` may use the Codex exec compatibility transport only if that fallback scope also
passes; otherwise
it fails closed. Forced `app-server` mode fails closed when its gates do not pass, and AgentDock
never replays accepted work through another transport. See
[the provider guide](docs/providers.md#historical-v02-decision-and-current-v2-transport).

## Repository map

```text
apps/
  desktop/        Electron + React reference client
  daemon/         Standalone local Fastify service
packages/
  agent-runtime/  Process management, adapters, normalized events
  client/         Typed daemon client for trusted Node/Electron contexts
  shared/         Protocol v1/v2 types and Zod schemas
scripts/assets/   Icon, documentation, and social-image generation tooling
```

## Everyday commands

```bash
pnpm build             # compile every package and application
pnpm typecheck         # strict TypeScript across the workspace
pnpm test              # unit + integration tests; no real provider calls
pnpm lint              # ESLint
pnpm package:win       # Windows NSIS installer
pnpm assets:generate   # regenerate committed app/docs assets
pnpm assets:validate   # validate dimensions, formats, and SVG safety
```

The asset commands require Python 3.11+ and the pinned packages in
[`scripts/assets/requirements.txt`](scripts/assets/requirements.txt). See
[the asset guide](docs/assets.md) before changing the identity or regenerating images. With those
dependencies installed, the committed checkout passes `pnpm assets:validate`; treat any failure as
a release blocker.

## Production and packaging

`pnpm build` produces compiled libraries, a self-contained daemon bundle, the Vite renderer, and
bundled Electron main/preload scripts. It does not create an installer.

```bash
pnpm package:win
```

The installer appears in `dist-packages/`:

```text
dist-packages/
  win-unpacked/                    AgentDock.exe + resources/
  AgentDock-Setup-<version>.exe    NSIS installer
```

Windows is the only verified packaging target today. Builds are unsigned, so Windows SmartScreen
may warn on first launch. See [the packaging guide](docs/packaging.md) for the packaged runtime
layout and verification checklist.

## Client SDK

`@agent-dock/client` is currently a private monorepo workspace package, ready to reuse inside a
fork or another trusted Node/Electron package in the same workspace. It is not published to npm.

```ts
import { AgentDockClient } from '@agent-dock/client';

const client = new AgentDockClient({
  baseUrl: 'http://127.0.0.1:PORT',
  token,
});

const cwd = '/path/to/project';
const workspace = await client.v2.workspaces.inspect(cwd);

if (workspace.state !== 'trusted') {
  // Show this workspace identity to the user and obtain explicit consent first.
  await client.v2.workspaces.setTrust(workspace.workspaceId, {
    cwd,
    incarnation: workspace.incarnation,
    state: 'trusted',
  });
}

const session = await client.v2.sessions.create({
  provider: 'claude',
  cwd,
  prompt: 'Inspect this repository',
});

for await (const event of client.v2.sessions.events(session.id)) {
  console.log(event);
}
```

The explicit `v2` namespace is intentional: it can negotiate an eligible Claude SDK or Codex
app-server transport. The client's top-level `sessions` namespace is protocol v1 and always uses
the CLI one-shot compatibility transport.

Production v1 and v2 session creation both require the workspace to be trusted before the daemon
accepts the session.

Failures are typed (`DaemonUnavailableError`, `UnauthorizedError`,
`ProtocolMismatchError`, `ProviderUnavailableError`, and others), so consumers can branch without
parsing error strings. See [the client guide](docs/client-sdk.md) and
[protocol v1](docs/protocol-v1.md). The additive capability-negotiated contract is documented in
[protocol v2](docs/protocol-v2.md).

## Adding a provider

Adding another CLI means extending the shared provider ID, implementing detection, capabilities,
parsing, and the adapter, passing the shared contract suite, and registering it with the daemon.
The protocol and client remain provider-neutral; the reference desktop needs one selector option.

Follow [the provider guide](docs/providers.md#adding-a-new-provider) for the complete checklist.

## Documentation

- [Development](DEVELOPMENT.md): setup, code map, and architectural rules
- [Architecture](docs/architecture.md): runtime flow, responsibilities, and trust boundaries
- [Product ideas for AgentDock forks](docs/use-cases/README.md): researched app directory, MVP wedges, and current implementation caveats
- [Security](SECURITY.md): threat model, loopback auth, and process hygiene
- [Protocol v1](docs/protocol-v1.md): normalized events and wire guarantees
- [Protocol v2](docs/protocol-v2.md): capability negotiation, correlated content, and versioned routes
- [Client SDK](docs/client-sdk.md): full client API and errors
- [Providers](docs/providers.md): adapters, detection, parsers, and contract tests
- [Provider capability matrix](docs/capability-matrix.md): what each provider/transport actually
  supports, at the exact pinned version tested
- [Capability and security model for protocol v2](docs/capability-security-v2.md): the full
  negotiation, evidence, and security decision record the matrix above summarizes
- [Daemon](docs/daemon.md): standalone operation, routes, and lifecycle
- [Electron](docs/electron.md): renderer/main/daemon boundary
- [Packaging](docs/packaging.md): electron-builder and NSIS details
- [Assets](docs/assets.md): brand sources, generated files, and replacement guide
- [Troubleshooting](docs/troubleshooting.md): common failures and diagnostics
- [Release checklist](docs/release-checklist.md): what backs a "release candidate" or a public "verified" provider claim
- [Contributing](CONTRIBUTING.md): workflow and pull-request checklist

## License

[Apache-2.0](LICENSE)
