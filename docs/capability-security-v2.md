# Capability and security model for protocol v2

- **Status:** accepted design gate, implementation pending
- **Decision date:** 2026-08-30
- **Applies to:** the planned `/v2` protocol and rich Claude/Codex transports
- **Does not change:** the currently shipped protocol v1 behavior

This document fixes the capability vocabulary and security decisions that every protocol v2,
provider, persistence, and desktop ticket must implement. It is a contract for future work, not a
claim that the v2 features exist today. [Protocol v1](protocol-v1.md) remains the authoritative
description of the current application.

## Decision summary

1. A capability is advertised only from adapter evidence, never from a provider feature page.
2. Capability support is scoped to provider, transport, version, platform, model, authentication
   mode, and workspace trust state. Support in one scope says nothing about another.
3. Unknown capability IDs survive validation, but remain unselected by default. Core code never
   adds a provider-ID branch to interpret them.
4. A workspace is untrusted until the user explicitly trusts its canonical repository identity.
   Project instructions and executable configuration are suppressed while it is untrusted.
5. An untrusted workspace runs only when the selected transport can prove the required restricted
   profile. An unverified permission mode is not a sandbox.
6. AgentDock has no provider, cloud, or MCP credential store and never collects designated
   authentication values through its API or UI. Adapters may pass approved inherited values
   opaquely to provider transports, but never persist or render them.
7. Persisted data is allowlisted, bounded, redacted, and retained for fixed periods. Raw provider
   frames, reasoning, process environments, designated authentication data, and unrestricted tool
   payloads are not persisted. User text and selected files can still contain user-supplied secrets.
8. An approval is forwarded only after its audit record is durable. Failure, timeout,
   disconnection, or ambiguity denies the action.
9. A transport may fall back only before its exact accepted-work boundary. Work that may have
   started is never replayed through another transport.
10. Resume and fork use stored provider-native identifiers. Fork is never simulated by replaying a
    transcript, and dirty worktrees are never removed automatically.

## Compatibility boundary

| Concern            | Protocol v1, current                                                  | Protocol v2, planned                                                                            |
| ------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Provider transport | One short-lived Claude/Codex CLI process per session                  | A negotiated, versioned transport with legacy CLI fallback                                      |
| Input              | One prompt, then stdin closes                                         | Correlated commands, turns, approvals, and questions                                            |
| Capability shape   | Optional booleans; unknown boolean keys pass through                  | Scoped support records with evidence, stability, prerequisites, and constraints                 |
| Workspace trust    | No AgentDock trust state                                              | Default-untrusted, canonical workspace identity, project configuration gates                    |
| Agent isolation    | Provider-owned behavior, not attested by AgentDock                    | Platform-specific state reported from verified enforcement                                      |
| History            | Memory only; up to 5,000 events per session and 50 completed sessions | Bounded per-user persistence with explicit deletion and retention                               |
| Credentials        | Full daemon environment inherited by the CLI; CLI owns login          | No designated auth-secret storage; documented environment/cloud or provider-owned login sources |
| Approval/audit     | Provider-owned, with no AgentDock approval channel or audit           | Fail-closed AgentDock policy and durable decision metadata                                      |

Nothing in this decision retroactively adds workspace trust, approval enforcement, persistence, or
sandboxing to v1. The unversioned v1 routes, schemas, runtime behavior, and tests remain unchanged
until the separate v2 migration lands.

## Capability vocabulary

### Owners

Every catalog entry has exactly one semantic owner:

- `provider`: the adapter must map and prove a provider-native behavior.
- `agentdock`: AgentDock implements the behavior independently of provider feature claims.
- `composite`: a provider-native behavior is usable only through an AgentDock policy, correlation,
  or lifecycle layer. Neither side alone satisfies the capability.

Owner does not grant permission. Every provider-owned capability still passes through AgentDock's
normal validation and policy boundaries.

### Support records

The v2 runtime represents support with this logical shape. The implementation may use equivalent
TypeScript names, but it must preserve these fields and meanings.

```ts
type CapabilityKind = 'operation' | 'observation' | 'guarantee';
type Effect =
  'read' | 'filesystem_write' | 'command' | 'network' | 'external_side_effect' | 'destructive';

type CapabilitySupportRecord = {
  id: string;
  kind: CapabilityKind;
  owner: 'provider' | 'agentdock' | 'composite';
  support: 'supported' | 'unsupported' | 'unknown';
  stability: 'stable' | 'experimental' | 'deprecated';
  evidence: Array<{
    kind: 'fixture' | 'host_verified' | 'runtime_report' | 'vendor_declared';
    reference: string;
    verifiedAt?: string;
  }>;
  scope: {
    provider: string;
    transport: string;
    platform: 'win32' | 'darwin' | 'linux' | 'linux_wsl2';
    model: string | '*';
    authMode: string | '*';
    trustState: 'untrusted' | 'trusted';
    versions: {
      adapterContract: string;
      transport: string;
      runtime: string;
      sdk?: string;
      schema?: string;
      fixtureSet: string;
    };
  };
  prerequisites: {
    capabilities: string[];
    trustStates: Array<'untrusted' | 'trusted'>;
    sessionStates: Array<'starting' | 'active' | 'idle' | 'terminal'>;
    services: Array<
      | 'approval_responder'
      | 'question_responder'
      | 'audit_store'
      | 'attachment_store'
      | 'history_store'
      | 'workspace_lease'
    >;
  };
  possibleEffects: Effect[];
  effectsComplete: boolean;
  constraints: WireCapabilityConstraints;
  reason?: string;
};
```

`CapabilityConstraints` is the following complete ID-keyed union. A runtime validator must pair a
core support record's `id` with exactly the mapped schema; core IDs never use arbitrary JSON.

```ts
type NoConstraints = { kind: 'none' };
type TextInputConstraints = {
  kind: 'text_input';
  maxCharacters: number;
  attachmentKinds: Array<'image' | 'file'>;
};
type AcknowledgementConstraints = { kind: 'acknowledgement'; timeoutMs: number };
type ContinuationConstraints = { kind: 'continuation'; native: true };
type InteractionConstraints = {
  kind: 'interaction';
  timeoutMs: number;
  maxPayloadBytes: number;
};
type ContentConstraints = {
  kind: 'content';
  maxBlockBytes: number;
  persistence: 'live_only' | 'safe_summary' | 'normalized';
};
type EffectConstraints = {
  kind: 'effects';
  allowedEffects: Effect[];
};
type InvocationConstraints = {
  kind: 'invocation';
  allowedEffects: Effect[];
};
type UsageConstraints = {
  kind: 'usage';
  scopes: Array<'turn' | 'session'>;
};
type CostConstraints = {
  kind: 'cost';
  scopes: Array<'turn' | 'session'>;
  currencies: string[];
  acceptsEstimates: boolean;
};
type CatalogConstraints = { kind: 'catalog'; pageSize: number };
type McpServerConstraints = {
  kind: 'mcp_server';
  transports: Array<'stdio' | 'streamable_http' | 'legacy_sse_read_only'>;
};
type McpConnectConstraints = McpServerConstraints & {
  actions: Array<'connect' | 'reconnect'>;
};
type McpConfigureConstraints = McpServerConstraints & {
  actions: Array<'add' | 'edit' | 'enable' | 'disable' | 'remove'>;
};
type ComponentManageConstraints = {
  kind: 'component_manage';
  actions: Array<'enable' | 'disable'>;
};
type AttachmentConstraints = {
  kind: 'attachment';
  mimeTypes: string[];
  maxBytes: number;
};
type StructuredOutputConstraints = {
  kind: 'structured_output';
  maxSchemaBytes: number;
  maxSchemaDepth: number;
  maxSchemaNodes: number;
};
type WorktreeConstraints = {
  kind: 'worktree';
  rootHandles: string[];
};
type FilesystemIsolationConstraints = {
  kind: 'filesystem_isolation';
  rootHandles: string[];
};
type NetworkIsolationConstraints = {
  kind: 'network_isolation';
  destinations: Array<{ host: string; protocol: 'tcp' | 'udp'; port: number }>;
};

type CapabilityConstraintById = {
  'session.input.follow_up': TextInputConstraints;
  'session.input.steer': TextInputConstraints;
  'session.interrupt': AcknowledgementConstraints;
  'session.cancel': AcknowledgementConstraints;
  'session.resume': ContinuationConstraints;
  'session.fork': ContinuationConstraints;
  'interaction.approval': InteractionConstraints;
  'interaction.question': InteractionConstraints;
  'content.streaming': ContentConstraints;
  'content.tools': EffectConstraints;
  'content.plans': ContentConstraints;
  'content.usage.tokens': UsageConstraints;
  'content.usage.cost': CostConstraints;
  'content.thinking': ContentConstraints;
  'content.artifacts': ContentConstraints;
  'model.catalog': CatalogConstraints;
  'integration.mcp.server.inspect': McpServerConstraints;
  'integration.mcp.server.connect': McpConnectConstraints;
  'integration.mcp.server.disconnect': NoConstraints;
  'integration.mcp.server.reload': NoConstraints;
  'integration.mcp.server.configure': McpConfigureConstraints;
  'integration.mcp.catalog.tools': CatalogConstraints;
  'integration.mcp.catalog.resources': CatalogConstraints;
  'integration.mcp.catalog.prompts': CatalogConstraints;
  'integration.mcp.tool.invoke': EffectConstraints;
  'integration.mcp.oauth': NoConstraints;
  'integration.mcp.elicitation.form': InteractionConstraints;
  'integration.mcp.elicitation.url': InteractionConstraints;
  'integration.skills.inspect': CatalogConstraints;
  'integration.skills.invoke': InvocationConstraints;
  'integration.skills.manage': ComponentManageConstraints;
  'integration.plugins.inspect': CatalogConstraints;
  'integration.plugins.manage': ComponentManageConstraints;
  'integration.hooks.inspect': CatalogConstraints;
  'integration.hooks.observe': ContentConstraints;
  'integration.hooks.manage': ComponentManageConstraints;
  'integration.commands.inspect': CatalogConstraints;
  'integration.commands.invoke': InvocationConstraints;
  'integration.agents.inspect': CatalogConstraints;
  'integration.agents.invoke': InvocationConstraints;
  'agents.subagents.observe': ContentConstraints;
  'agents.subagents.steer': TextInputConstraints;
  'agents.subagents.interrupt': AcknowledgementConstraints;
  'agents.subagents.cancel': AcknowledgementConstraints;
  'input.image': AttachmentConstraints;
  'input.file': AttachmentConstraints;
  'output.structured': StructuredOutputConstraints;
  'workspace.worktrees': WorktreeConstraints;
  'isolation.filesystem.workspace_read': FilesystemIsolationConstraints;
  'isolation.filesystem.read_only': FilesystemIsolationConstraints;
  'isolation.filesystem.workspace_write': FilesystemIsolationConstraints;
  'isolation.network.restricted': NetworkIsolationConstraints;
};

type CoreCapabilityId = keyof CapabilityConstraintById;
type CapabilityConstraints<I extends CoreCapabilityId = CoreCapabilityId> =
  CapabilityConstraintById[I];
type BoundedJson =
  null | boolean | number | string | BoundedJson[] | { [key: string]: BoundedJson };
type OpaqueCapabilityConstraints = {
  kind: 'opaque';
  value: BoundedJson;
};
type WireCapabilityConstraints = CapabilityConstraints | OpaqueCapabilityConstraints;
```

Omitting request constraints never means unlimited. It deterministically selects these canonical
defaults clipped to the advertised record: text uses 200,000 characters with no attachments;
acknowledgement uses 30 seconds; interaction uses 5 minutes/32 KiB; content uses 256 KiB and
`live_only`; usage accepts advertised scopes; cost accepts advertised currencies/scopes but not
estimates; catalogs use 50 entries; MCP inspection uses stable advertised transports but excludes
legacy SSE; MCP connection permits `connect` but not `reconnect`; MCP configuration and
skill/plugin/hook management permit `disable` only; invocation/effect operations allow `read` only;
attachments use advertised MIME types and the per-file cap; structured output uses 64 KiB/depth
16/1,024 nodes; worktree/filesystem roots use only the selected daemon-issued workspace root handle;
network destinations are empty; and `NoConstraints` is exactly `{ kind: 'none' }`. A caller must
explicitly request `reconnect`, `add`, `edit`, `enable`, `remove`, or any other wider subset.

Integers are finite and non-negative. Runtime schemas apply these absolute bounds: text 200,000
characters; acknowledgement 30 seconds; interaction 5 minutes and 32 KiB; content 256 KiB; catalog
pages 1-100; attachment bytes no greater than the retention cap; schema 64 KiB/depth 16/1,024 nodes;
at most 32 unique MIME types, currencies, root handles, or destinations; and every identifier/string
at most 256 UTF-8 bytes unless the live-bound table is narrower. Hosts are canonical IDNA names,
ports are 1-65,535, and root handles are daemon-issued, not paths.

Intersection is mechanical: numeric maxima use the lower value; allowlist/set fields use canonical
set intersection; `acceptsEstimates` uses logical AND; fixed discriminants and `native: true` must
match; destinations match canonical host/protocol/port; and persistence chooses the least revealing
common mode (`live_only` before `safe_summary` before `normalized`). An empty `attachmentKinds`
means text-only, an empty network `destinations` means deny all, and empty filesystem `rootHandles`
means no filesystem access; those are valid restrictive results. Empty transports, actions, usage
scopes, currencies, MIME types, invocation/effect sets, or worktree roots make that capability
unavailable. Invalid intersections are always unavailable. Duplicate entries are rejected before
intersection.

Known core IDs require their mapped constraint and reject `kind: 'opaque'`. Unknown well-formed IDs
round-trip only with `OpaqueCapabilityConstraints`, whose value is limited to 64 KiB, depth 16,
1,024 aggregate keys/items, finite numbers, and 256-byte keys/strings. It remains unselected unless
a fixture-backed installed consumer registers both its runtime schema and deterministic intersector;
otherwise optional is unavailable and required returns `422`.

Only `fixture` and `host_verified` evidence may form the static basis for
`support: 'supported'`. Multiple evidence entries are expected: for example, a schema fixture can
prove decoding while a platform fixture proves cancellation or sandbox enforcement. A
`runtime_report` is an observation that may narrow a matching supported record to `unsupported` or
`unknown`; it cannot promote untested support. `vendor_declared` is planning evidence only.

Catalog metadata for reserved IDs, including kind, owner, meaning, and safe default, is
authoritative. A provider manifest cannot redefine it. Records must be unique by ID and full scope;
duplicates fail manifest validation. Scope resolution follows these deterministic rules:

1. Provider, transport, platform, trust state, and every version field must match. Version ranges
   are allowed only in a checked-in compatibility manifest tied to the named fixture set.
2. Exact model/auth matches beat `*`; a narrower compatible version range beats a broader one.
3. A current runtime disable or failed host probe overrides static support.
4. Conflicting records at equal specificity resolve to `unknown`, never to supported.
5. Missing, stale, ambiguous, or version-mismatched evidence resolves to `unknown`.

`stability` describes the scoped provider implementation. The canonical AgentDock IDs and meanings
in the catalog below are stable. An adapter may advertise a catalog ID as experimental, in which
case negotiation requires both an explicit request and an experimental opt-in.

### Deterministic negotiation

```ts
type CapabilityRequest = {
  required: Array<{
    id: string;
    constraints?: WireCapabilityConstraints;
    allowExperimental?: boolean;
  }>;
  optional: Array<{
    id: string;
    constraints?: WireCapabilityConstraints;
    allowExperimental?: boolean;
  }>;
  preferredTransport?: string;
  allowExperimental: boolean; // defaults to false
};

type CapabilitySelection = {
  transport: string;
  enabled: Array<{ id: string; constraints: WireCapabilityConstraints }>;
  unavailableOptional: Array<{ id: string; reason: string }>;
  possibleEffects: Effect[];
  effectsComplete: boolean;
};
```

Each provider manifest orders transports with a fixture-tested integer priority. Negotiation:

1. Filters records to the exact runtime scope and expands the typed capability-prerequisite closure.
   A missing prerequisite removes an optional capability and fails a required one. Cycles invalidate
   the manifest.
2. Excludes deprecated support and excludes experimental support unless both the requested item and
   request opt in. An unsupported or unknown required ID returns `422` before dispatch.
3. Intersects requested and advertised typed constraints. Field-specific empty-set semantics above
   decide whether an empty result is restrictive or unavailable.
4. Uses an eligible `preferredTransport`; otherwise chooses the lowest manifest priority, then the
   lexical transport ID as a stable tie-breaker. No provider-specific daemon branch participates.
5. Returns the complete prerequisite closure and unavailable optional reasons. Selection is frozen
   for a session; a runtime downgrade before dispatch renegotiates, while one after dispatch ends
   the session without replay.

The default request preserves today's one-shot behavior: initial text and terminal lifecycle are
baseline, `session.cancel` is required, and `content.tools`, `content.usage.tokens`,
`content.usage.cost`, and `content.thinking` are optional observations. It requests no follow-up,
steering, approval, question, MCP, extension execution, subagent control, attachment, structured
output, or isolation guarantee, and it does not opt into experimental support.

Selection has different effects by kind:

- An unselected `operation` is rejected before it reaches a provider.
- An unselected `guarantee` is never displayed or used for policy.
- A provider may still emit an unselected observation. The adapter converts it to a bounded generic
  extension summary and records capability drift; it does not crash, disappear, or silently become
  a selected typed event.
- If a provider initiates an unselected approval, question, or MCP elicitation despite negotiation,
  AgentDock immediately denies/cancels it at the adapter, records capability drift, and never exposes
  the unauthorized interaction to the renderer. Inability to send a safe negative response cancels
  the turn/session.

Before dispatch, AgentDock unions `possibleEffects` across the selected transport, capabilities,
and enabled tool catalog. If any source has `effectsComplete: false`, or a possible effect is
unknown, the session is classified mutation-capable and destructive and needs an exclusive
workspace lease. Effects learned from emitted activity are too late to choose a safe lease.

### Unknown IDs and extensions

Core IDs use lowercase dotted segments, with snake case inside a segment. The `session`,
`interaction`, `content`, `model`, `integration`, `agents`, `input`, `output`, `workspace`, and
`isolation` prefixes are reserved by AgentDock. Third-party IDs use `ext.<namespace>.<feature>`.

- Schemas preserve unknown, well-formed IDs and their bounded support metadata.
- Unknown optional IDs remain visible for diagnostics and are not selected.
- Unknown required IDs return `422` before provider dispatch.
- No unknown capability implies a permission, sandbox, trust, or persistence grant.
- Negotiation compares opaque IDs and scoped records. It never switches on provider ID.

The protocol always includes validated session start/status, initial text input, text messages,
errors, and exactly one terminal event. Those baseline semantics are not optional capabilities.

## Canonical capability catalog

| ID                                     | Meaning                                                               | Kind          | Owner       | ID stability | Prerequisites                                                     | Safe default                             |
| -------------------------------------- | --------------------------------------------------------------------- | ------------- | ----------- | ------------ | ----------------------------------------------------------------- | ---------------------------------------- |
| `session.input.follow_up`              | Submit a new turn after an idle/completed turn                        | `operation`   | `provider`  | Stable       | Bidirectional transport; active/idle session; command ID          | Off unless requested                     |
| `session.input.steer`                  | Append input to the currently active turn                             | `operation`   | `provider`  | Stable       | Active turn; native steer; command ID                             | Off unless requested                     |
| `session.interrupt`                    | Stop the active turn while preserving resumable session state         | `operation`   | `provider`  | Stable       | Interactive transport; accepted-work marker; acknowledgement      | Off; never alias to cancel               |
| `session.cancel`                       | Terminate AgentDock execution and reap owned processes                | `operation`   | `agentdock` | Stable       | Owned handle; terminal-event guarantee                            | Enabled                                  |
| `session.resume`                       | Continue a provider-native session                                    | `operation`   | `provider`  | Stable       | Stored native ID; terminal parent; continuation lock              | Explicit user action                     |
| `session.fork`                         | Create a genuine provider-native branch                               | `operation`   | `provider`  | Stable       | Stored native ID; native fork; stable snapshot; continuation lock | Explicit action; never emulate           |
| `interaction.approval`                 | Resolve one correlated provider action request                        | `operation`   | `composite` | Stable       | Effect classification; policy; durable audit; responder           | Ask; deny on failure                     |
| `interaction.question`                 | Answer one bounded provider question request                          | `operation`   | `composite` | Stable       | Bounded schema; correlated responder                              | Off without responder                    |
| `content.streaming`                    | Update content blocks by stable ID                                    | `observation` | `provider`  | Stable       | Delta correlation; bounds; completion replacement                 | Accept validated deltas                  |
| `content.tools`                        | Observe normalized tool lifecycle and effects                         | `observation` | `provider`  | Stable       | Tool-call IDs; safe summary; declared effects                     | Display summary; unknown is destructive  |
| `content.plans`                        | Observe a provider-public plan and step state                         | `observation` | `provider`  | Stable       | Stable content IDs; public data                                   | Display only                             |
| `content.usage.tokens`                 | Report authoritative token usage and scope                            | `observation` | `provider`  | Stable       | Token units; turn/session scope                                   | Display and aggregate                    |
| `content.usage.cost`                   | Report authoritative or labeled estimated cost                        | `observation` | `provider`  | Stable       | Currency; scope; estimate flag                                    | Display; never invent                    |
| `content.thinking`                     | Show provider-public reasoning summaries                              | `observation` | `provider`  | Stable       | Public output; no hidden-reasoning reconstruction                 | Live only by default                     |
| `content.artifacts`                    | Show bounded file, diff, or artifact metadata/output                  | `observation` | `provider`  | Stable       | Safe block; size/path policy; explicit export                     | Summary until opened                     |
| `model.catalog`                        | Query models and model-scoped modalities                              | `operation`   | `provider`  | Stable       | Versioned native discovery                                        | Read-only inspection                     |
| `integration.mcp.server.inspect`       | Query configured server identity/status without connecting            | `operation`   | `provider`  | Stable       | Non-starting provider control surface                             | Inspect only                             |
| `integration.mcp.server.connect`       | Start/connect or reconnect one configured MCP server                  | `operation`   | `composite` | Stable       | Trusted source; manifest preview; policy; audit                   | Off; explicit action                     |
| `integration.mcp.server.disconnect`    | Disconnect one MCP server                                             | `operation`   | `composite` | Stable       | Exact server identity; active connection                          | Explicit action                          |
| `integration.mcp.server.reload`        | Reload one server's provider-owned configuration                      | `operation`   | `composite` | Stable       | Trusted source; validated config; audit                           | Off; explicit action                     |
| `integration.mcp.server.configure`     | Add, edit, enable, disable, or remove server configuration            | `operation`   | `composite` | Stable       | Trusted source; typed operation; preview; audit                   | Off; explicit action                     |
| `integration.mcp.catalog.tools`        | Query connected-server tool descriptors                               | `operation`   | `provider`  | Stable       | Connected server; bounded descriptors                             | Read-only inspection                     |
| `integration.mcp.catalog.resources`    | Query connected-server resource descriptors                           | `operation`   | `provider`  | Stable       | Connected server; bounded descriptors                             | Read-only inspection                     |
| `integration.mcp.catalog.prompts`      | Query connected-server prompt descriptors                             | `operation`   | `provider`  | Stable       | Connected server; bounded descriptors                             | Read-only inspection                     |
| `integration.mcp.tool.invoke`          | Invoke one exact MCP server/tool through a session                    | `operation`   | `composite` | Stable       | Server/tool IDs; declared effects; approval policy                | Ask by effect                            |
| `integration.mcp.oauth`                | Start and observe provider-owned MCP OAuth                            | `operation`   | `provider`  | Stable       | Explicit user action; system browser; provider token store        | Off; URL/status only                     |
| `integration.mcp.elicitation.form`     | Resolve one schema-bounded MCP form                                   | `operation`   | `composite` | Stable       | Connected server; question responder; schema validation           | Ask                                      |
| `integration.mcp.elicitation.url`      | Resolve one validated MCP URL flow                                    | `operation`   | `composite` | Stable       | Connected server; user action; URL validation                     | Ask                                      |
| `integration.skills.inspect`           | Query skill metadata and source                                       | `operation`   | `provider`  | Stable       | Supported discovery; bounded manifest                             | Inspect only                             |
| `integration.skills.invoke`            | Invoke one provider skill                                             | `operation`   | `composite` | Stable       | Trusted source; compatible session; policy                        | Off; explicit action                     |
| `integration.skills.manage`            | Enable or disable one installed skill                                 | `operation`   | `composite` | Stable       | Trusted source; typed action; component preview; audit            | Off; no installation or editing          |
| `integration.plugins.inspect`          | Query plugin metadata and bundled components                          | `operation`   | `provider`  | Stable       | Supported discovery; bounded manifest                             | Inspect only                             |
| `integration.plugins.manage`           | Enable or disable an installed plugin                                 | `operation`   | `composite` | Stable       | Trusted source; component preview; audit                          | Off; no installation                     |
| `integration.hooks.inspect`            | Query hook metadata without execution                                 | `operation`   | `provider`  | Stable       | Supported discovery; redacted command/env                         | Inspect only                             |
| `integration.hooks.observe`            | Attribute hook lifecycle to an execution                              | `observation` | `composite` | Stable       | Trusted execution; safe summary; correlation                      | Display summary only                     |
| `integration.hooks.manage`             | Enable or disable one installed hook                                  | `operation`   | `composite` | Stable       | Trusted source; typed action; command preview; audit              | Off; no arbitrary editing/execution      |
| `integration.commands.inspect`         | Query provider commands without execution                             | `operation`   | `provider`  | Stable       | Supported discovery                                               | Inspect only                             |
| `integration.commands.invoke`          | Invoke one exact provider command                                     | `operation`   | `composite` | Stable       | Trusted source; exact ID; effect classification; policy           | Off; ask by effect                       |
| `integration.agents.inspect`           | Query provider agent definitions without launching                    | `operation`   | `provider`  | Stable       | Supported discovery                                               | Inspect only                             |
| `integration.agents.invoke`            | Launch one exact provider agent definition                            | `operation`   | `composite` | Stable       | Trusted source; exact ID; effects; workspace lease                | Off; ask by effect                       |
| `agents.subagents.observe`             | Observe parent/child agent or background-task execution               | `observation` | `provider`  | Stable       | Stable parent/child IDs; execution graph                          | Display only                             |
| `agents.subagents.steer`               | Send input to one exact child                                         | `operation`   | `provider`  | Stable       | Child ID; native child steering                                   | Off; fail closed                         |
| `agents.subagents.interrupt`           | Interrupt one exact child turn                                        | `operation`   | `provider`  | Stable       | Child/turn IDs; native child interrupt                            | Off; fail closed                         |
| `agents.subagents.cancel`              | Cancel one exact child execution                                      | `operation`   | `provider`  | Stable       | Child ID; native child cancellation                               | Off; fail closed                         |
| `input.image`                          | Send a picker-authorized image                                        | `operation`   | `composite` | Stable       | Attachment ID; MIME/size checks; model support                    | Off until selected                       |
| `input.file`                           | Send a picker-authorized file                                         | `operation`   | `composite` | Stable       | Attachment ID; MIME/size checks; model support                    | Off until selected                       |
| `output.structured`                    | Request and validate native structured output                         | `operation`   | `composite` | Stable       | Bounded JSON Schema; model support; validation                    | Off until schema supplied; never emulate |
| `workspace.worktrees`                  | Create and lease an AgentDock-owned Git worktree                      | `operation`   | `agentdock` | Stable       | Trusted repo; validated ref/path/root; lease                      | Off; never auto-remove dirty state       |
| `isolation.filesystem.workspace_read`  | Prove provider-visible reads stay in approved workspace/runtime roots | `guarantee`   | `composite` | Stable       | Per-surface canonical read policy and enforcement evidence        | Unsupported unless proven                |
| `isolation.filesystem.read_only`       | Prove writes are blocked across every enabled execution surface       | `guarantee`   | `composite` | Stable       | Per-surface policy and enforcement evidence                       | Unsupported unless proven                |
| `isolation.filesystem.workspace_write` | Prove writes are limited to approved workspace roots                  | `guarantee`   | `composite` | Stable       | Per-surface policy and enforcement evidence                       | Unsupported unless proven                |
| `isolation.network.restricted`         | Prove network is denied or limited to declared destinations           | `guarantee`   | `composite` | Stable       | Per-surface policy and enforcement evidence                       | Unsupported unless proven                |

Tool names are data, not capability IDs. Every tool activity descriptor carries zero or more
normalized effects: `read`, `filesystem_write`, `command`, `network`, `external_side_effect`, and
`destructive`. Missing or unknown effects are treated as both mutation-capable and destructive
until a fixture-backed adapter classification proves otherwise.

## Evidence matrix

### Current adapter-tested behavior

The current test suite proves only the v1 boolean contract. It does not create v2 support records.

| V1 key         | Claude CLI adapter | Codex exec adapter | Closest v2 meaning                                         |
| -------------- | -----------------: | -----------------: | ---------------------------------------------------------- |
| `resume`       |             Tested |             Tested | `session.resume`                                           |
| `cancellation` |             Tested |             Tested | `session.cancel`                                           |
| `tools`        |             Tested |             Tested | `content.tools`, observation only                          |
| `usage`        |             Tested |             Tested | `content.usage.tokens`; cost needs separate v2 evidence    |
| `thinking`     |             Tested |             Tested | `content.thinking`, only when the CLI emits public content |

The shared provider contract verifies normalization and lifecycle against fixtures. A generic Codex
`mcp_tool_call` becoming `tool.started` does not prove MCP discovery, management, OAuth,
elicitation, or approval capabilities.

### Vendor-described candidates

These sources justify implementation work but advertise no AgentDock support:

| Candidate transport | Vendor-described surface used for planning                                                                                                                                                                   | AgentDock status                                                 | Primary source                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Codex app-server    | Rich-client authentication/history, threads and turns, approvals, streamed items, sandbox policies, images, structured output, MCP, skills, plugins, and hooks; individual methods can still be experimental | Unsupported until a versioned schema and fixtures pass           | [Codex app-server](https://developers.openai.com/codex/app-server)       |
| Claude Agent SDK    | Sessions, tools, permissions, user input, MCP, hooks, skills/plugins, and subagents                                                                                                                          | Unsupported until auth, trust, packaging, and fixture gates pass | [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) |

This snapshot was reviewed on 2026-08-30. Each adapter compatibility manifest must pin the exact
provider/SDK version and evidence set it supports. A documentation change or runtime self-report
alone never widens that range.

## Execution and data boundaries

| Boundary                | Sensitive or executable assets                                                | Threat                                                                       | Required v2 control                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Renderer                | Prompts, visible history, approval choices, attachment previews               | Compromise, forged correlation, unsafe HTML/URLs, oversized payloads         | Narrow typed preload methods; no daemon token/native IDs/secrets; text-only rendering; bounded content |
| Preload                 | Typed renderer requests and pushed events                                     | Accidental generic IPC tunnel or extra-field leakage                         | Explicit method allowlist; reconstruct/validate objects in both directions; no generic `invoke`        |
| Electron main           | Daemon bearer token/base URL, OS dialogs, external browser launch             | Token exposure, arbitrary path/URL launch                                    | Token stays in main memory; picker-issued handles; validate schemes/hosts; narrow daemon client calls  |
| Local daemon            | Policy, session state, capability selection, audit/history                    | Cross-session confusion, replay, unauthorized dispatch, secret persistence   | Bearer/origin controls; runtime schemas; correlation ownership; fail-closed policy; bounded stores     |
| Provider process or SDK | Workspace access, inherited credentials, network, tool execution              | Provider compromise, protocol drift, orphan process, duplicated side effects | Versioned adapter; least environment; process supervision; sandbox truth; no post-accept fallback      |
| Workspace files         | Source, instructions, settings, hooks, MCP, skills/plugins, agent definitions | Prompt injection and repository-controlled code execution                    | Canonical identity; default-untrusted; suppress project sources; execution leases                      |
| MCP server              | Local process or remote service, tool effects, OAuth                          | Code execution on connect, credential leakage, destructive/external action   | Source preview; explicit trust/connect; provider-owned tokens; effect policy; audit                    |
| OAuth browser flow      | Authorization URL and completion status                                       | Token interception, custom-scheme abuse, navigation inside renderer          | Explicit user action; system browser; validated URL; provider owns callback/token; status only         |
| Persisted history       | Prompts, normalized output, paths, usage, approvals, attachments              | Local disclosure, stale secrets, unbounded retention                         | Per-user permissions; allowlist/redaction; quotas/TTL; explicit delete; no raw native payloads         |

The Electron renderer's `sandbox: true` is a Chromium renderer control. It is unrelated to whether
a Claude/Codex tool command is isolated from the host filesystem or network.

## Workspace trust

### Identity and states

For Git, trust is keyed by the tuple of daemon-resolved canonical Git common-directory and worktree
root plus each directory's persistent filesystem object identity/repository incarnation. Outside
Git it uses the canonical working directory plus its object identity. On Unix the identity includes
device/inode; on Windows it includes volume and file ID. Resolution handles symlinks, junctions,
Windows case, and equivalent paths before lookup. Renderer path text is never the trust key.

Every lookup revalidates the stored incarnation. Deleting/recreating either directory, replacing a
repository at the same path, an identity mismatch, or inability to prove a stable identity
invalidates the stored grant. A filesystem without stable object IDs gets no reusable persistent
grant; the user must explicitly trust the resolved incarnation again.

Trust never propagates automatically between linked worktrees, branches checked out at another
root, or a recreated directory. An AgentDock-created worktree starts untrusted. Its creation flow
may offer a separate explicit trust decision only after showing the source revision and every
ignored/untracked file proposed for copy.

| State       | Entry                                                                | Project-controlled behavior                                                         | Session eligibility                                                     |
| ----------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `untrusted` | Default for every new identity, moved repository, or unresolved path | Inspectable as inert metadata where safe; never loaded or executed                  | Only a transport that proves the restricted untrusted profile may start |
| `trusted`   | Explicit user grant or managed policy for the canonical identity     | May load through the owning provider, still subject to sandbox, approval, and audit | New sessions may request trusted capabilities                           |

A trust grant affects only new sessions; AgentDock never upgrades the permissions, configuration
sources, or sandbox of an already running provider process. Revocation is fail-closed: the daemon
atomically blocks new commands and continuations for that workspace, denies/cancels pending
interactions, and cancels every active trusted session before recording the workspace untrusted.
Selecting a directory is not a trust grant.

### Configuration source gates

| Source scope                        | Untrusted                                                                                                                                                          | Trusted                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Provider built-ins                  | Load only the fixture-backed core and read-only tool subset required by the selected profile                                                                       | Load selected supported built-ins under normal policy                                |
| Managed                             | Apply non-executable restrictions. Managed hooks/MCP/plugins/helpers execute only with an explicit managed `allow_untrusted` attestation understood by the adapter | Apply managed restrictions and explicitly enabled managed components                 |
| User                                | Auth state and non-executable restrictions may load. User hooks, MCP, plugins, skills, commands, agents, and memory stay disabled                                  | Load through documented provider rules, still subject to capability selection/policy |
| Project                             | Suppress instructions/memory, settings/env, MCP, hooks, plugins, skills, commands, and agents                                                                      | Load only after trust through documented provider rules                              |
| Local project overrides             | Suppress completely                                                                                                                                                | Load only after trust; never treat “not committed” as safer                          |
| Provider-owned session/memory state | Auth may be consulted; no prior transcript/memory enters context except an explicit trust-compatible resume                                                        | Explicit resume/memory behavior follows provider and retention policy                |
| Marketplace/imported content        | Inert metadata only; never install, enable, or execute                                                                                                             | Installed content requires component preview and supported explicit enable           |

Inspection must not connect a server, launch a helper, evaluate a manifest, or execute a hook.
Worktree include/copy rules are ignored before trust; after trust, AgentDock previews ignored files
and possible secrets before copying. A transport must report which sources it loaded. If it cannot
suppress the disallowed scopes above, it cannot run an untrusted workspace.

For Claude SDK sessions, the restricted profile requires Claude Code 2.1.246 or later,
`settingSources: []`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `strictMcpConfig: true`, an isolated or
relocated `CLAUDE_CONFIG_DIR`, and no configured plugins, skills, hooks, agents, or MCP servers.
Version 2.1.246 is the minimum version whose source exclusion also ignores the excluded source's
sandbox filesystem and Edit/Read permission entries. Managed settings and provider-owned state
remain separately classified and must still satisfy the source matrix.

`allowedTools` alone is not a tool allowlist and can bypass `canUseTool` for a matching tool. The
restricted profile therefore supplies an explicit bounded `tools` set, denies every other tool with
`disallowedTools`/`dontAsk`, and uses a `PreToolUse` canonical-path gate where a provider file tool
cannot be removed. Escape fixtures must prove that project instructions, environment blocks,
auto-memory, path traversal, symlink traversal, MCP, hooks, plugins, skills, agents, and helpers
cannot load or execute. A CLI flag that merely reduces features is not proof. See
[Claude Code permissions](https://code.claude.com/docs/en/permissions) and
[Agent SDK setting sources](https://code.claude.com/docs/en/agent-sdk/claude-code-features).

Claude Bash is disabled for an untrusted session unless its sandbox filesystem policy is default
deny, allowlists reads only to the canonical workspace and minimal non-content runtime roots, denies
all writes, blocks path/symlink escape, and passes host fixtures. Claude's default Bash sandbox can
read beyond the workspace and can write the working directory, so merely initializing that sandbox
proves neither `isolation.filesystem.workspace_read` nor `isolation.filesystem.read_only`.

For Codex app-server, `trust_level = "untrusted"` suppresses project `.codex/` configuration but
does not prove that repository `AGENTS.md` instructions are suppressed. App-server is therefore
unsupported for untrusted execution until a versioned fixture proves that all project instructions
and sources in the matrix above are excluded. See the
[Codex configuration reference](https://developers.openai.com/codex/config-reference) and
[AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md).

## Permission, isolation, and worktree states are separate

| State                    | Question answered                                               | Never implies                                                   |
| ------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------- |
| AgentDock approval       | Did the user allow this normalized action?                      | That the OS can contain it                                      |
| Provider permission mode | Will the provider ask or allow its native tool?                 | That AgentDock audited it or that every subprocess is contained |
| OS sandbox state         | What filesystem/network access can the process actually obtain? | That a destructive action is intended or approved               |
| Worktree/lease state     | Which checkout may this execution mutate?                       | Filesystem or network containment outside that path             |

Default effect policy:

| Effect                         | Untrusted workspace                           | Trusted workspace                                                                |
| ------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------- |
| Read inside selected workspace | Allow only under verified read-only isolation | Allow under selected isolation policy                                            |
| Filesystem write               | Deny                                          | Ask; exact session grant may be offered for a bounded root                       |
| Shell/command                  | Deny                                          | Ask with command, cwd, and effects visible                                       |
| Network                        | Deny                                          | Ask for exact host, protocol, and port; no generic shell approval substitute     |
| External side effect           | Deny                                          | Ask every time unless a later policy explicitly defines a narrower durable grant |
| Destructive or unknown         | Deny                                          | `allow_once` only; audit must succeed before forwarding                          |

Mutation-capable and unknown-effect sessions require an exclusive lease on the canonical
repository/worktree path before dispatch. Read-only sessions may share only when read-only
enforcement is proven.

## Sandbox truth model

### Reported states

- `enforced`: the exact requested profile was accepted and positively verified for this scoped
  transport/platform. This is the only state that receives a sandboxed badge.
- `provider_managed`: the provider may apply controls, but AgentDock did not configure or attest
  them. No sandboxed badge.
- `not_requested`: a trusted compatibility run intentionally requested no AgentDock isolation. No
  sandboxed badge.
- `unavailable`: the transport/platform cannot provide the requested isolation.
- `failed`: isolation was required but setup or verification failed. The session does not start.
- `unknown`: evidence is missing, stale, or ambiguous. Treat as unsupported for untrusted work.

Isolation evidence is recorded per enabled execution surface, with mechanism
`os_sandbox | provider_policy | agentdock_policy`, rather than as one provider-wide boolean:

| Surface                                                                 | Untrusted read-only requirement                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Shell commands and child processes                                      | Disabled, or OS sandbox proves workspace read-only and network mode `deny`; unsandboxed retry disabled       |
| Provider Read/Glob/Grep-style tools                                     | Provider policy limits reads to canonical workspace and explicit safe runtime paths                          |
| Provider Edit/Write/file-change tools                                   | Disabled                                                                                                     |
| MCP, hooks, plugins, skills, commands, and agent/subagent launch        | Disabled unless the source matrix has an explicit managed untrusted attestation and every effect is enforced |
| Computer use, browser control, external side effects, and unknown tools | Disabled                                                                                                     |

`isolation.filesystem.workspace_read`, `isolation.filesystem.read_only`, or
`isolation.network.restricted` may be selected only when every enabled surface satisfies that exact
guarantee. Provider/AgentDock policy can contribute to a composite restricted profile, but only
OS-enforced surfaces may receive an **OS sandboxed** badge. A policy-only session is labeled
**Restricted by policy**, never **Sandboxed**. A partial surface is shown explicitly, for example
**Bash sandboxed; file tools disabled**.

Codex restricted manifests omit or deny `thread/shellCommand` and experimental `process/spawn`:
both execute outside the thread sandbox. On native Windows, evidence records the exact `elevated`
or weaker `unelevated` sandbox mechanism. Neither state silently substitutes for the other, and an
`unelevated` result cannot satisfy a network-restricted claim without its own passing fixture. See
[Codex app-server](https://developers.openai.com/codex/app-server) and
[Codex Windows sandboxing](https://learn.chatgpt.com/docs/windows/windows-sandbox).

### Provider command-sandbox and platform matrix

| Transport                | macOS/Linux                                                                                 | WSL2                                                       | Native Windows                                                    | Testable AgentDock claim                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current Claude CLI v1    | `provider_managed`                                                                          | `provider_managed`                                         | `unavailable` for Claude's Bash sandbox                           | Current adapter does not select or attest a sandbox on any platform                                                                                                                                                                     |
| Planned Claude Agent SDK | `enforced` only after the requested Bash read/write/network policy and escape fixtures pass | Same, plus WSL2 boundary/socket restrictions verified      | Bash sandbox `unavailable`; SDK remains supported                 | Require `failIfUnavailable: true`, `allowUnsandboxedCommands: false`, network mode `deny`, workspace-only provider-visible reads, denied writes, and the separate non-Bash tool policy above; native Windows never shows Bash sandboxed |
| Current Codex exec v1    | `provider_managed`                                                                          | `provider_managed`                                         | `provider_managed`                                                | Current adapter does not select or attest an exact policy                                                                                                                                                                               |
| Planned Codex app-server | `enforced` only after the requested policy and host probe pass                              | Treat as Linux isolation and verify that exact environment | `enforced` only after Windows sandbox setup and host verification | Any setup rejection, unknown version, or missing proof becomes `failed`/`unknown`, never `enforced`                                                                                                                                     |

Claude's vendor sandbox covers Bash subprocesses, not every Read/Edit/Write or computer-use path,
and is supported on macOS, Linux, and WSL2 rather than native Windows. Its default can fall back to
unsandboxed execution, so AgentDock's v2 untrusted profile must explicitly fail closed. See
[Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing). Codex app-server exposes
explicit turn sandbox policies and Windows sandbox setup, but AgentDock still needs versioned host
fixtures before reporting `enforced`; see
[Codex app-server](https://developers.openai.com/codex/app-server).

## Credentials and OAuth

- AgentDock has no dedicated provider/cloud/MCP credential fields, credential database, keychain
  entries, token callback, or secret-returning API in v2. User text and selected files can still
  contain pasted secrets; AgentDock cannot reliably detect or promise to redact those values.
- Renderer input can never supply a process environment or designated authentication value. UI/API
  output contains only a non-secret source label such as `provider_login`, `environment_api_key`,
  `bedrock`, `vertex`, or `foundry`.
- V2 adapters pass only documented base/runtime and selected provider-auth environment keys. Those
  credential values may transit the inherited process environment unchanged, but AgentDock never
  collects, inspects, persists, logs, or returns them. A broader inherited environment is a
  trusted-profile opt-in and must be reported without values. Environments are never event, audit,
  fixture, or log data.
- A Claude session that inherits authentication values sets
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. Bash, hooks, and stdio MCP remain unsupported unless fixtures
  prove their children receive no auth values and cannot read provider/cloud credential files;
  credential paths are denied or masked where the platform permits.
- Claude Agent SDK eligibility is limited to a user-provided Anthropic API key or supported
  Bedrock, Vertex, or Foundry configuration. AgentDock does not embed Claude.ai login or route
  Free/Pro/Max credentials through the SDK. Subscription login remains available only through the
  unmodified, provider-owned Claude Code CLI flow. See
  [Anthropic's authentication and credential-use policy](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).
- The Claude SDK integration may merge disabled. Enabling it by default in a release, or bundling
  its Claude Code binary, requires a recorded review of then-current Anthropic distribution,
  authentication, and branding terms.
- Codex login remains owned by the installed Codex runtime. AgentDock may use existing
  runtime-owned authentication and expose browser/device login status, but it must not expose
  app-server `account/login/start` with `type: "apiKey"` or experimental
  `type: "chatgptAuthTokens"`; both pass secrets through the client. See
  [Codex app-server authentication](https://developers.openai.com/codex/app-server#authentication).
- `integration.mcp.oauth` is eligible only when a provider-owned CLI/runtime exposes a token-opaque
  URL/status flow. MCP OAuth is initiated only by explicit user action; Electron main opens a
  validated `https` URL; the provider runtime owns callback handling and token storage. The
  renderer sees URL host and pending/completed/failed status only.
- Claude Agent SDK's MCP OAuth requires the host to complete OAuth and pass an access token in
  headers, so that adapter advertises `integration.mcp.oauth` as unsupported under AgentDock's
  no-token posture. A provider-owned Claude CLI flow may advertise it only with separate evidence.
  See [Claude Agent SDK MCP OAuth](https://code.claude.com/docs/en/agent-sdk/mcp#oauth2-authentication).
- Starting a stdio MCP server is code execution, even before a tool is called. Trust and manifest
  preview therefore apply to connection, not merely invocation.
- MCP inspection normalizes each configuration field as `public`, `secret`, or `unknown`. It may
  expose a validated executable and argument value only when a fixture-backed provider schema marks
  that field public; secret/unknown arguments, headers, environment values, client secrets, and
  OAuth secrets expose presence and source only. Editing sends typed fields back through the owning
  provider and never returns a secret value to the renderer.

The current v1 CLI path still inherits the daemon's full environment, as documented in
[SECURITY.md](../SECURITY.md#environment-inheritance-a-deliberate-tradeoff-not-an-oversight).
That compatibility behavior is not a v2 credential guarantee.

## Persistence, retention, and redaction

V1 keeps `AgentSession` records and normalized event envelopes in memory. Those envelopes can
contain arbitrary `tool.started.input` and `tool.completed.result` values; logger key redaction does
not sanitize the in-memory/SSE event store. Restarting the daemon removes all v1 state. This fact
must remain visible until v2 replaces it.

V2 uses a per-user state directory with restrictive OS permissions. It does not add
application-layer encryption in this phase, so the UI and documentation must describe the local
plaintext-at-rest property.

| Data class                                                                           | Persisted fields                                                                                                                  | Bounds and retention                                                                                                                                                               | Deletion                                                                                           |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Session metadata and normalized user-visible history                                 | IDs/lineage, provider/transport labels, trust/sandbox state, timestamps, user text, assistant text, safe content summaries, usage | 30 days after the whole lineage becomes terminal; global caps include all records and tombstones: 500 sessions and 250 MiB; evict the oldest eligible whole terminal lineage first | Explicit deletion is whole-lineage and removes content promptly; active lineages cannot be deleted |
| Tool, command, diff, and artifact content                                            | Normalized summary and fields explicitly classified `safe_to_persist`; workspace paths stored relative where possible             | Unstructured/raw inputs, results, stdout/stderr, and external absolute paths are live-only by default                                                                              | Deleted with lineage; explicit exports are user files outside AgentDock retention                  |
| Approval audit                                                                       | Version, session/turn/request IDs, normalized effect/permission key, risk, decision, actor, timestamps, safe target summary       | Append-only closed segments; 90 days and 50 MiB globally                                                                                                                           | Rotate oldest closed segments; content deletion does not rewrite audit metadata                    |
| Provider extension data                                                              | Persist only provider, transport, extension name/version, safe summary, and truncation/redaction reason                           | Raw native frame never leaves adapter process memory; encoded view max 64 KiB, depth 16, 1,024 total keys/items, summary 512 characters, and 1 MiB live budget per session         | Discard raw data after normalization and all live extension data at terminal state                 |
| Provider-public thinking/reasoning                                                   | None by default                                                                                                                   | Live bounded display only                                                                                                                                                          | Discard at terminal state; explicit user export is separate                                        |
| Attachments staged by AgentDock                                                      | Opaque ID, normalized name/MIME/size/hash, staged copy; never original path in renderer events                                    | 25 MiB each; 100 MiB and 20 files per session; 500 MiB and 200 files globally; unreferenced TTL 24 hours; referenced copy follows its lineage's 30-day retention                   | Delete staged copy only; never alter the user's source file                                        |
| Designated auth fields/tokens, process environments, native credential/approval data | Never                                                                                                                             | Forbidden in state, events, audit, fixtures, and logs                                                                                                                              | Reject or redact before crossing the adapter boundary                                              |

User-controlled prompts, assistant-visible text, tool-selected files, and attachments may contain
pasted or embedded secrets. They are not treated as designated authentication fields and cannot be
reliably secret-scanned; the UI warns users and these values follow the content-retention policy
above.

A lineage is its root session, every resume/fork descendant, and the tombstones required to preserve
those references. It is the eviction unit. Cleanup is transactional and may evict a lineage only
when every member is terminal and no execution or deletion lease is active. Before creating,
resuming, or forking, the daemon projects both global caps; it evicts eligible lineages first and,
if none can make room, returns a typed `storage_full` error before provider dispatch. It never
exceeds either cap. A single 500-session lineage cannot add a 501st member until the user exports
what they need and deletes that terminal lineage. Tombstones count toward both limits, so lineage
preservation cannot grow an unbounded side store.

If a value cannot be confidently classified, persist a bounded redaction summary rather than a
partial object. Retention cleanup is atomic and crash-safe. Corrupt records are quarantined rather
than interpreted or silently discarded, and their bytes continue to count toward the quota until
explicit deletion or successful repair.

## Live protocol and memory bounds

Limits apply after UTF-8 encoding unless a row explicitly says JavaScript string length. They are
validated at every renderer/preload, IPC, daemon, adapter, and persistence boundary; a narrower
provider limit wins.

| Object                              |                                                                                                                                                                V2 limit | Overflow behavior                                                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial or follow-up prompt text    |                                                                                                               200,000 JavaScript characters and the request limit below | Reject with `413 payload_too_large` before negotiation or dispatch                                                                                                                       |
| Client command/request JSON         |                                                                                                        1 MiB, nesting depth 16, 1,024 aggregate object keys/array items | Reject the whole command; never truncate an executable request                                                                                                                           |
| One provider-native frame           |                                                                                                                                                                   1 MiB | Resolve pending interactions, stop the process, and emit exactly one bounded `session.failed` terminal with code `provider_frame_too_large`                                              |
| One normalized event                |                                                                                                                                                                   1 MiB | Resolve pending interactions, stop the process, and emit exactly one bounded `session.failed` terminal with code `event_too_large`; executable/action data is never partially normalized |
| One user-visible text/content block |                                                                                                                                                                 256 KiB | Replace the excess with a typed truncation marker and preserve its byte count/hash                                                                                                       |
| Per-session retained replay window  |                                                                                                                           5,000 events or 16 MiB, whichever comes first | Evict oldest replayable events and advance `earliestSequence`                                                                                                                            |
| Per-subscriber outbound queue       |                                                                                                                              256 events or 4 MiB, whichever comes first | Close with `stream_overflow`; client reconnects from its last sequence                                                                                                                   |
| Pending client commands             |                                                                                                                                        64 commands or 1 MiB per session | Reject new commands with `429 session_backpressure`                                                                                                                                      |
| Pending approvals plus questions    |                                                                                                                                                          32 per session | Deny a new approval or cancel a new question, then apply the interaction rules below                                                                                                     |
| One approval interaction            |                                                                                            32 KiB total; 512-character title; 4 KiB each for action, target, and reason | Deny before showing or forwarding an oversized value                                                                                                                                     |
| One question interaction            | 32 KiB total; 3 questions; 10 options each; 512-character titles/labels; 4 KiB prompts/descriptions; 2 KiB option descriptions; 8 KiB previews; 16 KiB free-text answer | Cancel before showing or forwarding an oversized value                                                                                                                                   |
| One extension view                  |                                                                                                     64 KiB, depth 16, 1,024 aggregate keys/items, 512-character summary | Emit only a typed redaction/truncation summary                                                                                                                                           |
| All live extension views            |                                                                                                                                                       1 MiB per session | Drop later views with a counted truncation event                                                                                                                                         |

JSON carries no inline binary; attachments use opaque handles and the separate byte quotas above.
Truncation never creates partial JSON, changes a command/approval target, or converts malformed data
into trusted content. If a reconnect sequence precedes `earliestSequence`, the daemon returns
`409 replay_gap`; the client must reload the current snapshot and cannot infer omitted events.
Approval and question deadlines are five minutes from successful publication to the responder; a
shorter provider deadline wins. Disconnect or publication failure resolves immediately, deadlines
use a monotonic clock, and neither user activity nor reconnect extends them.

## Approval and question resolution

Every provider request is bound to one `(sessionId, turnId, requestId)` tuple and moves exactly once
from `pending` to `allowed`, `denied`, `answered`, or `cancelled`. Exactly one normalized
resolution event is emitted. Each response command also has a client command ID: retrying the same
ID with a byte-equivalent canonical payload returns the recorded acknowledgement without forwarding
again. Reusing an ID with different content returns `409 command_id_conflict`; a new response to a
stale, cross-session, or post-terminal request returns `409 stale_interaction`.

The sole responder stream receives a per-connection 256-bit lease outside the event payload. Only
that live lease may authorize approval or question response commands; observer streams receive no
lease, and the Electron renderer receives neither the lease nor native correlation IDs.

- Approval allow/deny decisions are forwarded only after the normalized audit record is durable. A
  timeout, responder disconnect, session interrupt, cancellation, daemon shutdown, or audit-store
  failure resolves an approval to `denied`. If the audit store is unavailable, AgentDock denies
  locally, forwards no approval response that could permit execution, and cancels the turn/process.
- A question timeout, responder disconnect, overflow, session interrupt, cancellation, or shutdown
  sends the provider-native cancel/no-answer response when supported, emits `cancelled`, and
  interrupts the current turn. The session becomes resumable only after the provider confirms it is
  idle; otherwise AgentDock cancels the session and emits its terminal event.
- Interrupt resolves every pending interaction for that turn before it is forwarded. Session cancel
  and daemon shutdown resolve all pending interactions before process cleanup. A restart marks any
  recovered active session `interrupted`; callbacks from the former process can never be resumed.
- A race is settled by the daemon's atomic compare-and-set of the pending record. The losing user,
  timeout, disconnect, or cancellation path observes the recorded resolution and performs no
  provider action.

## Transport fallback and accepted-work boundary

Fallback is a side-effect safety rule, not a timeout policy. Each adapter compatibility manifest
defines one tested boundary:

| Transport        | Replay becomes forbidden when                                               | Fallback rule                                                                               |
| ---------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Codex app-server | The complete `turn/start` request is handed to app-server                   | No fallback after delivery; app-server exposes no documented idempotency/no-work proof      |
| Claude Agent SDK | `WarmQuery.query(prompt)` is invoked after an inert, successful `startup()` | Import/startup failure may fall back before prompt submission; never after query invocation |
| Codex exec       | Process spawn is attempted because the prompt is already present in argv    | No fallback after the spawn attempt; success/failure ambiguity cannot replay                |
| Claude CLI       | The first prompt byte is handed to child stdin                              | No fallback after any prompt delivery; partial-write failure is ambiguous                   |

- Probe, import, schema, handshake, or startup failure may fall back at most once when it occurs
  before the boundary and proves that no work was accepted. A Claude pre-prompt `startup()` is
  fallback-eligible only while project sources, hooks, plugins, and MCP are disabled. Starting a
  stdio MCP server or executing any startup hook crosses the no-replay boundary even before a model
  turn.
- A fallback candidate must re-satisfy the exact provider account/auth source, model, required
  capabilities, workspace trust/source gates, sandbox profile, and retention scope. Claude SDK
  API/cloud authentication never falls back to a subscription-authenticated CLI. A
  rich/restricted transport never falls back to weaker v1 isolation.
- Timeout, disconnect, malformed response, or process loss after dispatch is ambiguous and never
  authorizes replay. The session ends failed/interrupted with one terminal event.
- Provider-native retries stay inside the selected transport and surface their status. They do not
  trigger a second transport or a fixed AgentDock fallback timer.
- The selected transport, compatibility evidence, accepted/not-accepted state, and fallback reason
  are non-secret session metadata.
- Cancellation, denial, and shutdown resolve pending requests before process cleanup. Every path
  preserves the v1 invariant of exactly one terminal event, always last.

## Threat walkthrough

| Scenario               | Required state                                                                                                                                                          | Default decision and enforcement                                                                                                               | Persisted evidence                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Read-only code review  | Untrusted allowed only with project sources suppressed, `isolation.filesystem.workspace_read: enforced`, `isolation.filesystem.read_only: enforced`, and network denied | Provider-visible reads stay inside canonical workspace/approved runtime roots; any unknown tool or attempted escalation denies and ends safely | Safe summaries and normalized user/assistant content                                |
| File edit              | Trusted workspace, `isolation.filesystem.workspace_write: enforced`, exclusive mutation lease                                                                           | Show paths/diff; ask before write unless an exact bounded session grant exists                                                                 | Approval decision plus safe diff summary, not raw native payload                    |
| Shell command          | Trusted workspace, command effect, exclusive mutation lease                                                                                                             | Ask with normalized command/cwd/effects; timeout/disconnect denies                                                                             | Command summary, decision, exit status; raw output live-only unless classified safe |
| Network access         | Trusted workspace, `isolation.network.restricted: enforced`                                                                                                             | Ask for exact host/protocol/port; a generic command approval cannot grant network                                                              | Destination summary and decision; no headers/tokens                                 |
| Destructive MCP action | Trusted server/source, destructive effect, exclusive mutation lease                                                                                                     | `allow_once` only; audit append must succeed before provider response                                                                          | Server/tool identity, safe target summary, decision; no raw arguments/result        |

These scenarios are the minimum fake-provider policy fixtures for the approval/trust ticket. Any
failure to classify the action uses the destructive row.

## Downstream implementation gates

| Tickets                                                                                                              | Must consume this decision without redefining it                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [#6](https://github.com/jortega0033/agentdock/issues/6), [#7](https://github.com/jortega0033/agentdock/issues/7)     | Support-record schema, opaque negotiation, command correlation, accepted-work state, and one terminal event      |
| [#8](https://github.com/jortega0033/agentdock/issues/8)                                                              | Evidence kinds, exact scopes, malformed/unknown frames, fallback fixtures, and designated-secret boundary tests  |
| [#9](https://github.com/jortega0033/agentdock/issues/9)                                                              | Trust identity/states, effect taxonomy, approval defaults, isolation truth, and audit-before-allow               |
| [#10](https://github.com/jortega0033/agentdock/issues/10), [#11](https://github.com/jortega0033/agentdock/issues/11) | Versioned transport manifests, source-specific auth, platform sandbox evidence, and exact fallback boundaries    |
| [#12](https://github.com/jortega0033/agentdock/issues/12)                                                            | Provider-neutral safe renderers, bounded unknown extensions, and no raw HTML/provider branching                  |
| [#13](https://github.com/jortega0033/agentdock/issues/13), [#14](https://github.com/jortega0033/agentdock/issues/14) | Retention limits, lineage/continuation locks, accepted state, canonical paths, and execution leases              |
| [#15](https://github.com/jortega0033/agentdock/issues/15)                                                            | MCP inspect/manage/OAuth/elicitation split, provider token ownership, connect-time trust, and destructive policy |
| [#16](https://github.com/jortega0033/agentdock/issues/16)                                                            | Inert inspection before trust, component preview, explicit enable/invoke, and safe hook summaries                |
| [#17](https://github.com/jortega0033/agentdock/issues/17)                                                            | Child observe/control split, canonical leases, AgentDock-owned worktree root, and no dirty auto-cleanup          |
| [#18](https://github.com/jortega0033/agentdock/issues/18)                                                            | Model-scoped modality records, picker-issued attachments, quotas/TTL, and native structured output only          |

No downstream implementation may weaken a safe default because a provider exposes a more
permissive native option. A change to a decision-summary rule or catalog safe default requires an
explicit amendment to this document and a review of all dependent tickets.

## Non-goals

- Implementing protocol v2, provider transports, persistence, or UI in this ticket
- Storing credentials or building an AgentDock credential vault
- Marketplace browsing/installation or arbitrary hook editing/execution
- Treating permissions, worktrees, or Electron's renderer sandbox as OS process isolation
- Claiming parity between Claude and Codex, or between models/versions of one provider
- Emulating unsupported fork, structured output, sandbox, or provider features
- Cloud sync, remote workspaces, or multi-user isolation
