# Providers

## The `AgentProvider` interface

Every provider adapter (`packages/agent-runtime/src/providers/*/adapter.ts`) implements one
interface (`packages/agent-runtime/src/types.ts`):

```ts
interface AgentProvider {
  readonly id: ProviderId;
  readonly name: string;
  detect(options?: ProviderDetectionOptions): Promise<ProviderStatus>;
  startSession(options: StartSessionOptions): ProviderSessionHandle;
  getV2Support?(status: ProviderStatus): ProviderV2Support | undefined;
  startInteractiveSession?(
    options: StartInteractiveSessionOptions,
  ): Promise<InteractiveProviderSessionHandle>;
  readonly mcp?: ProviderMcpControlPlane;
  readonly components?: ProviderComponentControlPlane;
}
```

An implementation owns everything provider-specific: executable discovery, command construction,
process spawning, output parsing, and normalization into `AgentEvent`. Nothing outside
`packages/agent-runtime` should ever need to know a provider's native event shape; that's the whole
point of normalizing into the shared `AgentEvent` union documented in
[protocol-v1.md](protocol-v1.md). The v1 one-shot path normally delegates spawning and parsing to
the shared `runProviderSession()` helper (see
[architecture.md#process-management](architecture.md#process-management)) and supplies only
`buildArgs()` and `parseLine()`. A rich v2 adapter instead advertises an exact support manifest and
implements the optional interactive-session factory; MCP and provider-component control planes are
also optional.

That paragraph describes the current protocol v1 one-shot adapters. The bidirectional provider
contract and its security gates are defined in
[Capability and security model for protocol v2](capability-security-v2.md).

## Executable discovery

`findExecutable()` (`packages/agent-runtime/src/detect-executable.ts`) does not assume the CLI is
on whatever `PATH` the daemon inherited: a GUI app's `PATH` frequently differs from an
interactive login shell's, especially on macOS. It:

1. Tries a PATH lookup. Windows scans absolute PATH entries directly for supported `.exe`/`.cmd`
   names; POSIX invokes `which` without a shell. Relative and empty Windows PATH entries are
   ignored instead of implicitly searching the working directory.
2. Falls back to a short, curated list of directories CLI installers commonly use, per
   `commonInstallDirs()`: `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`,
   `~/.npm-global/bin` on macOS; `~/.local/bin`, `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`,
   `%APPDATA%\npm` on Windows; `~/.local/bin`, `/usr/local/bin`, `/usr/bin` on Linux.

This was verified against real local installs during development: on this project's dev machine,
`claude` resolved to `~/.local/bin/claude.exe` and `codex` to
`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`, neither of which is a path you'd want to
hardcode, which is exactly why discovery works this way instead.

Re-verified after packaging: launched from the Start Menu shortcut of a real NSIS-installed build
(not a dev terminal, so not inheriting whatever `PATH` a shell session happens to have), the daemon
still found and correctly reported both CLIs. Discovery logic itself is unchanged by
packaging: it's the same `findExecutable()` call either way, but the _inherited environment_ a
packaged app launches with genuinely can differ from a terminal's, which is exactly the scenario
this was built to handle, so it was worth confirming rather than assuming.

## `ProviderStatus`

```ts
type AuthStatus = 'authenticated' | 'unauthenticated' | 'unknown';
type AuthSource =
  'chatgpt' | 'api_key' | 'claude_subscription' | 'bedrock' | 'vertex' | 'foundry' | 'unknown';

type ProviderStatus = {
  id: 'claude' | 'codex';
  name: string;
  installed: boolean;
  authenticated: AuthStatus;
  authSource?: AuthSource;
  accountFingerprint?: string; // internal only; never serialized
  selectedModel?: string; // internal only; never serialized
  capabilities: ProviderCapabilities;
  executablePath?: string;
  version?: string;
  error?: string;
};
```

`accountFingerprint` and `selectedModel` are detector/runtime binding inputs, not public provider
status. The daemon removes both before validating and returning either v1 or v2 provider responses.

`AuthStatus` is deliberately a pure three-value string union with no boolean member. It used to be
`boolean | 'unknown'`, which let a lazy `if (status.authenticated)` silently treat "couldn't
determine" as authenticated, exactly backwards for a security-relevant signal, and bad enough
that the type's own docstring had to warn against the obvious usage. There is no shortcut with the
current shape: every consumer writes `status.authenticated === 'authenticated'` explicitly.
`'unknown'` is a distinct, first-class state: a check that failed, timed out, or returned output
the adapter couldn't parse is reported as unknown, **never** coerced to `'authenticated'`. The
desktop UI is expected to route a user through the CLI's own login flow whenever `installed` is
true but `authenticated` isn't `'authenticated'`.

## Provider capabilities

```ts
interface ProviderCapabilities {
  resume?: boolean;
  cancellation?: boolean;
  tools?: boolean;
  usage?: boolean;
  thinking?: boolean;
  [futureCapability: string]: boolean | undefined;
}
```

`capabilities` describes what **this adapter implements**, not a marketing claim about the
underlying model: a field is `true` only if the codebase reliably implements and normalizes that
behavior today. This is what lets a downstream client ask "does this provider support resume"
instead of writing `if (provider.id === 'claude')`.

Every known key is optional (**absent means unsupported, exactly like `false`**), so adding a 6th
capability later doesn't break a client built against today's five-key shape. The wire schema
(`providerCapabilitiesSchema` in `packages/shared/src/schemas.ts`) matches: every known key is
`.optional()`, and unknown keys pass through validation via `.catchall(z.boolean())` rather than
being rejected or silently stripped, so a client one version behind a daemon that's grown a new
capability still gets to see it. For protocol v1, plain optional booleans are the complete design;
there is no richer provider-specific extension path. Adding one would require coordinated shared
type, schema, protocol, and client changes. Protocol v2 supplies that extension model through
scoped support records without mutating the v1 wire shape.

Both current adapters (`providers/claude/capabilities.ts`, `providers/codex/capabilities.ts`)
declare every field `true`, and each is true for a specific, checkable reason, not because the two
CLIs happen to be similar:

| Capability     | Claude | Codex | Why                                                                                                                                                                                                                                                                                              |
| -------------- | ------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resume`       | ✅     | ✅    | `--resume <id>` / `exec resume <id>`, argv construction unit-tested (`build-args.ts`); wired end to end through `POST /sessions`'s `resumeProviderSessionId`, which the daemon rejects with `400` for a provider whose `capabilities.resume` is `false`                                          |
| `cancellation` | ✅     | ✅    | Both go through the shared `runProviderSession()` process-tree kill, see [Process management](architecture.md#process-management)                                                                                                                                                                |
| `tools`        | ✅     | ✅    | Claude's `tool_use`/`tool_result` blocks and Codex's `command_execution`/`file_change`/`mcp_tool_call` items both normalize to `tool.started`/`tool.completed`                                                                                                                                   |
| `usage`        | ✅     | ✅    | Claude's `message.usage`/`result.usage` and Codex's `turn.completed.usage` both normalize to `usage` events                                                                                                                                                                                      |
| `thinking`     | ✅     | ✅    | Claude's `thinking` content blocks and Codex's `reasoning` items both normalize to `thinking.delta` (**only surfaced when the CLI's own extended-thinking/reasoning-effort configuration produces one**); a `true` here means "the adapter passes it through when present," not "always present" |

`FakeProvider` (used across the test suite) deliberately declares `resume: false`, `tools: false`,
`thinking: false` even though it _could_ trivially fake any of them: the contrast is what lets
tests assert that capability-gated behavior actually gates on the flag instead of always running
(see [Provider contract tests](#provider-contract-tests) below).

Add a capability field only when it corresponds to behavior a real adapter already implements.
`modelSelection`, `fileEdits`-as-distinct-from-`tools`, and similar were considered and left out for
v0.2: neither adapter lets a caller pick a model via the API, and file-edit/command-execution
distinctions are already covered by the generic `tools` flag plus each tool event's own `toolName`.

### Capability and security v2 design

Protocol v2 keeps the rule that adapter-tested behavior is truth, but replaces the five booleans
with canonical IDs and support records scoped to provider, transport, version, platform, model,
auth mode, and trust state. Vendor documentation is planning evidence only. Unknown IDs round-trip
without provider-specific branches and remain unselected by default.

The complete catalog, legacy mapping, sandbox matrix, workspace trust rules, credential posture,
retention limits, and fallback boundary live in
[capability-security-v2.md](capability-security-v2.md). Claude Agent SDK support records are
advertised only for their exact pinned Windows/auth/trust scope. Codex app-server support is likewise
restricted to its exact validated CLI version and requires authenticated, trusted launch state.

## Claude adapter

`packages/agent-runtime/src/providers/claude/`

- **Detection**: `claude --version` for the version string, `claude auth status --json` for login
  state (`{ loggedIn: boolean, ... }`), see [`ProviderStatus`](#providerstatus) for how that maps
  to `AuthStatus`.
- **Execution**: `claude -p --input-format text --output-format stream-json --verbose`, plus either
  `--session-id <daemon-uuid>` on a fresh session or `--resume <providerSessionId>` when resuming
  (argv construction is in `build-args.ts`, unit- and contract-tested independently of spawning a
  process). Passing our own UUID as `--session-id` means the daemon's session id and Claude's own
  session id are the same value from the start, instead of needing to reconcile two ids after the
  fact. Resuming is reachable end to end via `POST /sessions`'s `resumeProviderSessionId` field.
  **The prompt itself is not an argv element**: it's written to the child's stdin and the stdin
  stream is then closed (`run-session.ts`'s `promptViaStdin` config; Codex exec sets it too, see
  below). Two reasons: an argv element has to fit inside Windows' `CreateProcess` command-line limit (~32,767
  characters), well under what the shared request schema permits (200,000), and an argv-passed
  prompt is visible to any same-user process for the whole life of the process (`ps`/Task
  Manager's command-line column), not just at spawn time.
- **Parsing** (`parser.ts`): maps `system`/`init` → captures the session id; `assistant`/`user`
  message content blocks (`text`, `thinking`, `tool_use`, `tool_result`) → `assistant.message` /
  `thinking.delta` / `tool.started` / `tool.completed`; `result` → a `usage` event (with
  `total_cost_usd` as `cost`) and, if `is_error` is set, an `error` event. Claude emits a `usage`
  event on every `assistant`/`user` line _and_ again on the final `result` line: one session
  produces several `usage` events, not one; see [Protocol v1](protocol-v1.md) for why a consumer
  should never treat a single `usage` event as a session total.
- This project intentionally does **not** pass `--include-partial-messages`: without it, Claude
  CLI emits one complete `assistant` message per turn instead of a token-by-token delta stream,
  which is simpler and more robust to parse for an MVP. Protocol v1 has no token-streaming event
  variant today (an earlier `assistant.delta` placeholder was removed before anything emitted it,
  see [Protocol v1](protocol-v1.md)); a future adapter or CLI flag that wants real token streaming
  needs a properly-specified event added at that point, not a speculative one reserved now.

Verified manually against a real, already-authenticated `claude` CLI during development (see the
project's technical report / commit history for the transcript): the daemon started a session,
Claude's response and token usage came back as normalized events, and the session reached
`session.completed` with no API key ever requested.

### Claude transport modes

`AGENT_DOCK_CLAUDE_TRANSPORT` accepts `auto` (default), `sdk`, or `cli`. The `cli` mode is the legacy
path documented above and remains unchanged. The SDK path requires Windows, the exact pinned SDK
executable, an authenticated detection snapshot whose source still matches, a trusted workspace at
launch, and either a user-provided `ANTHROPIC_API_KEY` or exactly one supported Bedrock, Vertex, or
Foundry configuration. Claude.ai/subscription OAuth and `CLAUDE_CODE_OAUTH_TOKEN` are never SDK
credentials. `auto` selects the legacy CLI when an SDK eligibility gate fails before transport
selection; `sdk` fails closed. Once the SDK transport is selected, import, startup, or query failure
does not fall back to the CLI.

The SDK and its Windows executable are pinned to `@anthropic-ai/claude-agent-sdk` **0.3.251** and
the embedded Claude executable **2.1.251**. Windows packaging stages the executable and notices
outside Electron's ASAR archive and passes its absolute path to the SDK; it never substitutes a
PATH-discovered CLI binary.

SDK sessions require a trusted workspace. Settings, MCP, hooks, plugins, skills, and agents are
disabled, and `Bash` is disabled. AgentDock does not store or log credentials, and only passes
reviewed local auth configuration to the SDK. Product-facing release branding must use **Claude
Agent**; distribution and commercial-terms review gates any release packaging change.

## Codex adapter

`packages/agent-runtime/src/providers/codex/`

- **Detection**: `codex --version`; `codex login status`, whose output is a short human-readable
  line (`"Logged in using ChatGPT"`, `"Logged in using API key"`, or a not-logged-in variant)
  rather than JSON. The parser matches conservatively and falls back to `'unknown'` rather than
  guessing when the text doesn't clearly say one way or the other.
- **Execution**: `codex exec - --json --skip-git-repo-check`, or
  `codex exec resume <providerSessionId> - --json --skip-git-repo-check` to continue a prior
  thread (argv construction is in `build-args.ts`). `--skip-git-repo-check` is required because a
  session's working directory is whatever the user picked, not necessarily a git repository.
  Resuming is reachable end to end via `POST /sessions`'s `resumeProviderSessionId` field. **The
  prompt itself is not an argv element**: the `-` is Codex's own documented placeholder for "read
  the prompt from stdin instead," and `run-session.ts` writes it there and closes the stream, the
  same as Claude CLI's stdin transport above and for the same two reasons (Windows argv limit,
  and an argv-passed prompt staying visible in `ps`/Task Manager for the process's whole
  lifetime).
- **Parsing** (`parser.ts`): `thread.started` → captures the thread id as `providerSessionId`;
  `item.started` / `item.completed` → `tool.started` / `tool.completed` for `command_execution`,
  `file_change`, and `mcp_tool_call` items, `assistant.message` for a completed `agent_message`
  item, `thinking.delta` for `reasoning` items; `turn.completed.usage` → a `usage` event;
  `turn.failed` → a fatal `error` event. A completed item of type `error` (Codex uses this for
  non-fatal warnings, e.g. a local config quirk, that don't stop the turn) is normalized as
  `recoverable: true`, unlike `turn.failed` which is not.

Verified manually the same way as Claude: a real, already-authenticated `codex` CLI produced a
correct response through the full daemon → adapter → SSE pipeline, including capturing Codex's own
thread id as `providerSessionId`.

### Historical v0.2 decision and current v2 transport

The v0.2 decision to keep the unversioned protocol-v1 path on `codex exec --json` was recorded
against **codex-cli 0.147.0**. That compatibility path remains: it preserves the simple one-process,
one-turn JSONL adapter and its v1 contract.

Protocol v2 now has a native `codex-app-server` transport for the exact validated
**codex-cli 0.147.0** scope. `AGENT_DOCK_CODEX_TRANSPORT` accepts `auto` (default), `app-server`, or
`exec`: `auto` advertises app-server only when the detected version matches that compatibility
record, while `exec` keeps v2 on the conservative legacy bridge. Starting app-server additionally
requires an exact detected executable, authenticated provider status, and a trusted workspace; it
uses the provider's `workspace-write` sandbox request and `on-request` approval policy.

The app-server manifest covers follow-up and steer input, interrupt/cancel, resume/fork, approvals
and bounded questions, streamed messages, tools, plans, and usage. API-key authentication does not
advertise resume or fork because the runtime cannot bind continuation identity for that auth source.
The exact method allowlist, schema hash, and fake JSON-RPC harness are compatibility evidence; they
do not imply support for every method exposed by app-server.

The provider-neutral interactive contract and supervisor re-establish lifecycle, accepted-work,
teardown, and terminal-event guarantees at the RPC layer. Both real providers and `FakeProvider`
exercise that path within their advertised scopes; the renderer consumes the same normalized v2
events and commands without provider-native branching.

## Provider contract tests

This suite verifies the current protocol v1 adapter contract.

Any checked-in native-frame fixture must follow the
[provider fixture safety and recording guidance](provider-fixtures.md).

`packages/agent-runtime/test/support/provider-contract.ts` exports `describeProviderContract()`,
a reusable vitest suite asserting the guarantees _every_ adapter must uphold, run against each
adapter's real `parseLine`/`buildArgs` (not a re-implementation of them), with a small `node`
fixture script standing in for the real CLI binary. `test/claude-contract.test.ts` and
`test/codex-contract.test.ts` are ~15-line call sites that just supply each provider's fixtures and
declared capabilities, see either for the pattern to copy for a new provider.

What it checks: `session.started` is emitted first and tagged with the right provider; a
nonexistent working directory is rejected before the CLI is ever touched; no raw/unrecognized
provider-native event type ever reaches the normalized stream; an unrecognized event kind doesn't
crash the session; assistant output normalizes; tool events normalize _only when
`capabilities.tools` says they should_, same for `usage`; exactly one terminal event occurs, always
last, carrying the provider session id on success; cancellation (gated on `capabilities.cancellation`)
terminates the process and never lets `session.completed` follow `session.cancelled`; resume (gated
on `capabilities.resume`) produces an argv that references the prior provider session id and
differs from a fresh session's argv.

It lives under `test/support/`, not `src/`: it's a vitest-coupled test helper, not part of this
package's public runtime API, so it isn't exported from `index.ts`. A provider adapter maintained
outside this repo would copy the pattern rather than import the file directly.

Both `ClaudeProvider` and `CodexProvider` pass the shared contract files today (32 tests total: 15
Claude and 17 Codex). Run those files or the agent-runtime test suite to verify the current count.
Provider-specific
parsing detail (the exact Claude/Codex JSONL shapes) stays in `test/claude-parser.test.ts` /
`test/codex-parser.test.ts`, which the contract suite doesn't replace. Both providers' `detect()`
auth parsing also has dedicated pure-function tests independent of the contract suite, see
`test/claude-detect.test.ts` / `test/codex-detect.test.ts`.

## Adding a new provider

This checklist targets the current protocol v1 adapter shape.

Say you want to add `GeminiProvider`. The daemon's generic provider routes and client methods do not
need provider-specific branches, but the shared provider ID, daemon registry, and current desktop
provider picker do need updates:

1. **Register the id.** Add `'gemini'` to `PROVIDER_IDS` in `packages/shared/src/provider.ts`.
2. **Write `detect.ts`.** Resolve the executable (via `findExecutable`, see
   [Executable discovery](#executable-discovery)), get its version, and determine auth state,
   never coercing "couldn't tell" into `true` (see [`ProviderStatus`](#providerstatus)).
3. **Write `capabilities.ts`.** Declare a `ProviderCapabilities` object reflecting what you
   actually implemented in the steps below, not an aspiration (see
   [Provider capabilities](#provider-capabilities)).
4. **Write `parser.ts`.** A pure function `(raw: unknown, logger: Logger) => ParsedLine` mapping
   the CLI's native JSONL shape into `AgentEvent[]`, matching the `ParsedLine` contract in
   `providers/common/run-session.ts`.
5. **Write `build-args.ts`.** A pure function `(opts: StartSessionOptions) => string[]`
   constructing the CLI's argv, branching on `opts.resumeProviderSessionId` if `capabilities.resume`
   is true.
6. **Write `adapter.ts`.** A class implementing `AgentProvider`
   (see [The `AgentProvider` interface](#the-agentprovider-interface)), delegating execution to the
   shared `runProviderSession()` helper: validation, spawning, cancellation, and the
   completed/failed/cancelled terminal-event guarantee are all handled there; you only supply
   `buildArgs` and `parseLine`.
7. **Write provider-specific parser tests**, and **run the shared provider contract suite.** Unit-
   test the parser against fixture JSON (see `test/codex-parser.test.ts` for the shape), then add
   `test/gemini-contract.test.ts` calling `describeProviderContract()` with your fixtures and
   capabilities (see [Provider contract tests](#provider-contract-tests)), a `node` fixture script
   standing in for the real CLI, so CI never needs a real Gemini account.
8. **Register it.** Add `new GeminiProvider(logger)` to `buildProviderRegistry()` in
   `apps/daemon/src/providers.ts`.

That's the v1 surface. `GET /providers` picks up the registered adapter automatically,
`@agent-dock/client` needs no provider-specific method (it validates against the shared
`ProviderStatus` schema), and the desktop UI's provider `<select>` needs a new `<option>`; event
rendering remains provider-neutral because it switches on normalized `AgentEvent.type`. A rich v2
transport additionally needs scoped support evidence and the optional interactive factory described
above.
