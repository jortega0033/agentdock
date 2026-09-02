# Contributing

Thanks for considering a contribution to AgentDock. This is boilerplate meant to be forked and
extended, so contributions here should stay in that spirit: keep the core small, provider-neutral,
and easy for someone else to reason about after forking it.

## Contribution workflow

1. Search existing issues before starting work. Use the issue forms for bugs, features, or questions.
2. Discuss large, security-sensitive, or architecture-changing work in an issue before implementation.
3. Work from a focused branch in your fork; direct pushes to the default branch are blocked.
4. Open a pull request using the repository template and link the relevant issue.
5. Resolve review conversations and keep all required checks green before merge.

Report vulnerabilities privately through the repository's **Security** tab, never through a public
issue or pull request.

## Development setup

```bash
pnpm install
pnpm typecheck
pnpm test
```

Requires Node 20+ and pnpm (see the `packageManager` field in the root `package.json` for the
exact version this repo was built against).

## Project structure

See [docs/architecture.md](docs/architecture.md) for the full picture, and
[DEVELOPMENT.md](DEVELOPMENT.md) for an "I want to change X, start here" map. In short:
`packages/shared` sits under two branches: `packages/agent-runtime` → `apps/daemon`, and
`packages/client` → `apps/desktop`. The desktop main process uses the client to reach the daemon;
the desktop does not import the daemon as a package.

## Architecture rules

These aren't style preferences: breaking them tends to break the security model or the layering
the tests assume. The full list, with the reasoning behind each, is
[DEVELOPMENT.md#common-architectural-rules](DEVELOPMENT.md#common-architectural-rules); briefly:
never build a shell command string, never let the renderer call the daemon directly, never accept
an executable path from a request, keep provider-native behavior in `packages/agent-runtime`, and
never add a generic IPC passthrough to the preload bridge.

## Testing requirements

- Never make a test depend on a real, authenticated Claude/Codex CLI being present, and never make
  one that spends real API credit. CI has neither. See
  [DEVELOPMENT.md#testing-without-paid-providers](DEVELOPMENT.md#testing-without-paid-providers)
  for the fixture-based pattern this project uses instead.
- Never commit a fixture, test, or example that contains a real credential, token, or account
  identifier, even a revoked or expired one. Provider CLI fixtures are small `node` scripts
  standing in for the real CLI's I/O shape, never real recorded CLI output.
- If your change affects a wire contract, `@agent-dock/client`'s exports, or a daemon route's shape,
  update the relevant protocol document ([v1](docs/protocol-v1.md) or
  [v2](docs/protocol-v2.md)), [client SDK guide](docs/client-sdk.md), and
  [daemon guide](docs/daemon.md) in the same PR. A behavior change with no doc update for it isn't
  done.

## Before opening a PR

```bash
pnpm typecheck        # strict TypeScript, no `any` without a comment justifying it
pnpm lint
pnpm test             # must pass without a real Claude/Codex install or any paid API call
pnpm build
pnpm docs:claim-check # every public doc's relative links resolve; no "legacy Claude/Codex CLI"
                       # branding; docs/capability-matrix.md still covers every required category
pnpm audit --prod     # currently passes; treat any production/runtime finding as a blocker
pnpm audit            # currently exits nonzero for two documented electron-builder dev-tool
                       # advisories; compare any new finding with docs/packaging.md
```

If you touched a public Markdown file (README, `docs/*.md`, `CONTRIBUTING.md`, `DEVELOPMENT.md`,
`SECURITY.md`) and it makes a capability claim, check it against
[docs/capability-matrix.md](docs/capability-matrix.md) first: every public capability claim should
map to a row there (or an explicit design-target label), not restate what a provider's marketing
page says. See [docs/capability-matrix.md#keeping-this-matrix-honest](docs/capability-matrix.md#keeping-this-matrix-honest).

If you touched anything under `apps/desktop/electron/` (main process, preload, or packaging
config), also run `pnpm package:win` (Windows) and confirm the app still launches from
`dist-packages/win-unpacked/AgentDock.exe`, since packaging has its own failure modes that `pnpm build`
alone won't catch (see [docs/packaging.md#verifying-a-packaging-sensitive-change](docs/packaging.md#verifying-a-packaging-sensitive-change)
for real ones this project already hit).

Linux CI runs `pnpm install --frozen-lockfile`, provider conformance, `lint`, `typecheck`, `test`,
and `build`, in that order, on every push to `main` and every pull request
(`.github/workflows/ci.yml`). `pnpm audit` is currently a local contribution check, not a CI step.
A separate Windows workflow (`.github/workflows/package-windows.yml`) runs provider conformance,
`pnpm package:win`, focused process-ownership tests, and the packaged-daemon smoke test; it also
fails if the NSIS installer was not produced. Neither workflow installs or authenticates a real
Claude/Codex CLI. See [Testing requirements](#testing-requirements) above for why that's unnecessary.

### Provider contribution checklist

If you're touching a provider adapter (`packages/agent-runtime/src/providers/*`), add or update:

- a **parser unit test** against a realistic fixture of the CLI's native JSONL output (see
  `packages/agent-runtime/test/codex-parser.test.ts` for the pattern)
- if the change affects process lifecycle (spawning, cancellation, exit handling), an
  **integration test** using a small `node` fixture script standing in for the real CLI (see
  `packages/agent-runtime/test/run-session.test.ts` and `test/fixtures/*.mjs`)
- if you're adding a new provider entirely, the full checklist in
  [docs/providers.md#adding-a-new-provider](docs/providers.md#adding-a-new-provider), including a
  run of the shared `describeProviderContract()` suite against your adapter

## Code style

- TypeScript strict mode, no `any` unless there's a comment explaining why it's unavoidable.
- No comments explaining _what_ code does: name things so that's obvious. A comment is for a
  non-obvious _why_: a constraint, an invariant, a workaround for a specific CLI quirk.
- Small, focused modules over one big file. If you're adding a provider, follow the existing
  `detect.ts` / `parser.ts` / `adapter.ts` split (see [docs/providers.md](docs/providers.md#adding-a-new-provider)).
- No new abstraction or config surface for a hypothetical future need: this is boilerplate that
  should stay easy to fork and delete parts of, not a framework.

## Scope

Please open an issue before changing the durable session/execution schema, adding authentication of
the app's own users, telemetry/analytics, a new heavy dependency, or a new provider transport or
authentication mode. AgentDock already includes local file-backed session/execution metadata,
Claude Agent SDK transports for reviewed commercial auth sources, and Codex app-server support;
changes to those surfaces need migration and security review. Hosted user accounts, product
telemetry, and a product backend remain downstream concerns; see
[What AgentDock is](README.md#what-agentdock-is).

## License

By contributing, you agree your contribution is licensed under this project's
[Apache-2.0 license](LICENSE).
