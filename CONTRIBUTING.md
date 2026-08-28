# Contributing

Thanks for considering a contribution to Agent Dock. This is boilerplate meant to be forked and
extended, so contributions here should stay in that spirit: keep the core small, provider-neutral,
and easy for someone else to reason about after forking it.

## Development setup

```bash
pnpm install
pnpm typecheck
pnpm test
```

Requires Node 20+ and pnpm (see the `packageManager` field in the root `package.json` for the
exact version this repo was built against).

## Project structure

See [docs/architecture.md](docs/architecture.md) for the full picture. In short:
`packages/shared` (types/contracts) → `packages/agent-runtime` (provider adapters, process
management) → `apps/daemon` (HTTP+SSE server) → `apps/desktop` (Electron+React demo client).
Dependencies only flow in that direction.

## Before opening a PR

```bash
pnpm typecheck   # strict TypeScript, no `any` without a comment justifying it
pnpm lint
pnpm test        # must pass without a real Claude/Codex install or any paid API call
pnpm build
pnpm audit       # electron-builder's own build-time deps are a known, documented exception —
                 # see docs/architecture.md#packaging; nothing shipped in the app should show up here
```

If you touched anything under `apps/desktop/electron/` (main process, preload, or packaging
config), also run `pnpm package:win` (Windows) and confirm the app still launches from
`dist-packages/win-unpacked/AgentDock.exe` — packaging has its own failure modes that `pnpm build`
alone won't catch (see [docs/architecture.md#packaging](docs/architecture.md#packaging) for two
real ones this project already hit).

If you're touching a provider adapter (`packages/agent-runtime/src/providers/*`), add or update:

- a **parser unit test** against a realistic fixture of the CLI's native JSONL output (see
  `packages/agent-runtime/test/codex-parser.test.ts` for the pattern)
- if the change affects process lifecycle (spawning, cancellation, exit handling), an
  **integration test** using a small `node` fixture script standing in for the real CLI (see
  `packages/agent-runtime/test/run-session.test.ts` and `test/fixtures/*.mjs`)

Never make a test depend on a real, authenticated Claude/Codex CLI being present, and never make
one that spends real API credit — CI has neither.

## Code style

- TypeScript strict mode, no `any` unless there's a comment explaining why it's unavoidable.
- No comments explaining *what* code does — name things so that's obvious. A comment is for a
  non-obvious *why*: a constraint, an invariant, a workaround for a specific CLI quirk.
- Small, focused modules over one big file. If you're adding a provider, follow the existing
  `detect.ts` / `parser.ts` / `adapter.ts` split (see [docs/providers.md](docs/providers.md#adding-a-new-provider)).
- No new abstraction or config surface for a hypothetical future need — this is boilerplate that
  should stay easy to fork and delete parts of, not a framework.

## Scope

Please open an issue before working on anything that would add: persistence (SQLite/a database),
authentication of the app's own users, telemetry/analytics, a new heavy dependency, or a new
provider mode (API-key based, cloud-hosted). These are explicitly out of scope for the current
version — see the README's "What this is not" section — and may or may not be a direction the
project wants to take.

## License

By contributing, you agree your contribution is licensed under this project's
[Apache-2.0 license](LICENSE).
