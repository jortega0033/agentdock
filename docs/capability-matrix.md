# Provider capability matrix

This is the one canonical, publicly-linked reference for what AgentDock's shipped provider
adapters actually do, per provider, per transport, at the exact pinned version each adapter is
tested against. If a public sentence in this repo (README, use-case guide, in-app copy) claims a
capability, it should trace back to a row here -- either as **Supported**, **Partial**, or an
explicit **design target** (a decision this repo has made about the shape a capability should
eventually have, not something a current adapter delivers). "Provider-neutral" describes the
*normalized wire contract* (`AgentEvent`/`AgentEventV2`, the v2 capability-negotiation schema) that
every adapter maps into -- it does not mean every provider or transport delivers the same set of
capabilities through that contract. See [capability-security-v2.md](capability-security-v2.md) for
the full security/negotiation model this matrix summarizes; this page is the flattened, at-a-glance
view of it.

## Transports and exact pinned versions

| Transport                                    | Provider | Exact pinned/tested version                                                   | Auth modes                                        | Platform    |
| --------------------------------------------- | -------- | ------------------------------------------------------------------------------- | --------------------------------------------------- | ----------- |
| Claude CLI one-shot compatibility transport   | Claude   | Claude Code 2.1.228                                                              | Any `claude auth login` state the CLI itself accepts | Any         |
| Claude Agent SDK                              | Claude   | SDK `0.3.251`, embedded Claude executable `2.1.251`                             | `ANTHROPIC_API_KEY`, Bedrock, Vertex, or Foundry only (never subscription OAuth) | Windows only |
| Codex CLI one-shot compatibility transport    | Codex    | codex-cli `0.147.0`                                                              | Any `codex login` state the CLI itself accepts       | Any         |
| Codex app-server                              | Codex    | codex-cli `0.147.0` (exact validated build)                                     | Authenticated, trusted-workspace only                | Any         |

"One-shot compatibility transport" is this repo's public name for what the code calls the
`legacy-one-shot` bridge: one short-lived CLI process per session, normalized into the shared v1
event shape and (via the same bridge) a conservative v2 capability record. It is a real, currently
supported transport, not a deprecated one -- "one-shot" describes its process-per-turn shape, not
its maintenance status. A version outside the pinned one above still runs, but its capability
support downgrades to `unknown` rather than `supported` until a fixture proves it (see
[providers.md#provider-capabilities](providers.md#provider-capabilities)).

## Capability matrix

Legend: **✅ Supported** (tested, evidence-backed) · **⚠️ Partial** (works with a real, named
limitation) · **❌ Unsupported** (not implemented for this transport) · **🎯 Design target** (a
decision this repo has made, not a shipped capability -- see the linked decision).

| Capability                | Claude CLI compat. transport | Claude Agent SDK | Codex CLI compat. transport | Codex app-server |
| -------------------------- | :----------------------------: | :-----------------: | :----------------------------: | :------------------: |
| Fresh run                 | ✅                              | ✅                   | ✅                              | ✅                    |
| Streaming output           | ✅ full message per turn (no token-level delta) | ✅ token-level content deltas | ✅ full message per turn | ✅ token-level content deltas |
| Tool observation           | ✅ `tool_use`/`tool_result` → `tool.started`/`tool.completed` | ✅ same, plus `content.tools` capability record | ✅ `command_execution`/`file_change`/`mcp_tool_call` → `tool.started`/`tool.completed` | ✅ same, native effects |
| Approvals                  | ❌ no approval channel | ✅ `interaction.approval`, durably audited before allow ([capability-security-v2.md decision 8](capability-security-v2.md#decision-summary)) | ❌ no approval channel | ✅ same as Claude SDK |
| Questions                  | ❌ | ✅ `interaction.question` | ❌ | ✅ |
| Cancellation                | ✅ process-tree kill | ✅ | ✅ process-tree kill | ✅ |
| Resume                     | ⚠️ v1 only: accepts an already-known provider-native id with **no daemon-side verification** (`resumeProviderSessionId`, never durably bound). v2's `session.resume` is **unsupported** for Claude on every transport: no current Claude detection path supplies the non-secret account/model binding evidence v2 durable continuation requires (see [issue #54](https://github.com/jortega0033/agentdock/issues/54)) | ❌ explicitly unsupported for the same reason | ⚠️ same v1-only caveat as Claude CLI | ⚠️ real provider-native resume, durably bound -- except **unsupported when `authSource` is `api_key`**, same continuation-identity restriction as Claude SDK |
| Fork                       | ❌ (v2's legacy bridge never advertises fork; no synthetic/transcript-replay fork exists anywhere) | ❌ | ❌ | ⚠️ real provider-native fork -- except **unsupported when `authSource` is `api_key`**, same restriction as Resume above |
| MCP operations              | ⚠️ config add/edit/enable/disable via CLI argv (no credential exposure), plus live stdio catalog (tools/resources/prompts) and tool invocation for enabled servers -- provider-owned OAuth still unavailable | ❌ (MCP disabled for the SDK profile: session options hardcode an empty server list regardless of what's configured) | ⚠️ same scope as Claude CLI compat. | ⚠️ same scope as the two CLI compat. transports |
| Components (skills/plugins/hooks) | ⚠️ read-only discovery for skills, plugins, commands, agents; hooks additionally support real enable/disable (moves the hook's config between `settings.json` and a sibling ledger file -- filesystem-based, so identical for both Claude transports, requires a trusted workspace, no process execution); no invocation for any component | ❌ (component loading is not wired into SDK session dispatch) | ⚠️ read-only discovery only (skills, plugins); no management/invocation | ⚠️ same read-only scope |
| Child-agent (subagent) events | ⚠️ storage/routes exist (provider-agnostic), but this transport does not populate the graph | ⚠️ same -- no `Task`-tool-use signal is treated as a child spawn, since inferring one from a tool name is exactly what issue #58 rules out without a stable, non-inferred identity | ⚠️ same as Claude CLI | ⚠️ real events from a fixture-backed `subAgentActivity` item (`agentThreadId` is the stable native identity); the schema has no explicit "completed" kind, so a normally-finishing child's terminal status is inferred from its parent turn ending with no further activity for it, not a provider-confirmed signal. Steer/interrupt/cancel are never advertised: Codex has no per-subagent-thread control method today |
| Attachments                 | ❌ same as the Codex CLI compat. transport | ❌ (`input.image` is not advertised for the SDK profile) | ❌ session creation has no attachment field; nothing is dispatched to provider execution | ⚠️ PNG/JPEG only, bound at session creation (`initialAttachmentIds`), sent as real `localImage` turn input; no generic files, no mid-session attachments |
| Structured output           | ❌ same as the Codex CLI compat. transport | ❌ (`output.structured` is not advertised for the SDK profile) | ❌ session creation has no output-schema field; validation exists client-side only, never dispatched to a provider | ⚠️ a session-creation-time JSON Schema (`outputSchema`) is sent on the initial turn; Codex has no dedicated structured-output item type, so the final `agentMessage` text is parsed and AJV-validated -- valid output additionally emits `structured_data`, invalid output stays as the plain text block only |

## Known limitations (repo-wide, not provider-specific)

- **Audit is scoped to approval decisions, not a general activity log.** The durable audit store
  (`apps/daemon/src/audit-store.ts`) persists one record per correlated approval/permission
  decision (session, turn, request, provider, transport, workspace, actor, decision) -- it is not a
  transcript of everything a session did. The standalone MCP invocation route does not currently
  make the audited-approval guarantee interactive sessions get (capability-security-v2.md decision
  8).
- **"Evidence" in this repo's own copy means a specific, checked-in thing**: a compatibility
  fixture, a vendor-declared capability, or a host-verified probe result (see
  [capability-security-v2.md's evidence matrix](capability-security-v2.md#evidence-matrix)) -- not
  a general claim that AgentDock captures provenance for everything an agent does. Progress/activity
  shown in the UI is normalized event output, not a provenance record, unless a specific capability
  row above says otherwise.
- **API-key authentication never advertises resume or fork**, on either the Claude Agent SDK or the
  Codex app-server, regardless of what the table above says for other auth sources on the same
  transport -- the runtime cannot bind continuation identity for that auth source (see
  [providers.md](providers.md)).
- **Broad OS-level sandbox isolation is a design target, not a shipped guarantee.** Workspace trust
  gates whether a session starts at all; it is not the same claim as attested filesystem/network
  isolation during execution. See [capability-security-v2.md](capability-security-v2.md)'s isolation
  capability rows, all currently `unsupported unless proven`.

## Keeping this matrix honest

`scripts/docs-claim-check.mjs` (run in CI) is a mechanical check, not a semantic one: it bans public
Markdown from branding the vendor Claude/Codex CLI itself as "legacy" (internal code identifiers are
exempt), validates that every relative Markdown link and heading anchor in a public doc actually
resolves, and confirms this file still names every required capability category. It cannot tell
whether a *new* sentence's claim is true, or whether an existing row's claim has gone stale -- that
judgment call is still on whoever edits a public doc. If you ship a new capability or change what an
existing one covers, update the row above in the same change, and check any new public-facing
sentence against this table by hand (see [CONTRIBUTING.md](../CONTRIBUTING.md#before-opening-a-pr)).
