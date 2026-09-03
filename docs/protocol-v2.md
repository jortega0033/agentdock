# Protocol v2

Protocol v2 is AgentDock's versioned HTTP and SSE contract for capability negotiation, correlated
turns and interactions, normalized content, and forward-compatible provider extensions. The
unversioned protocol v1 routes and types remain available unchanged; see
[Protocol v1](protocol-v1.md).

The TypeScript types and Zod schemas in `packages/shared/src` are the executable definition of this
document. Structured v2 inputs and successful payloads are validated at runtime; raw attachment
streams and bounded error bodies use route-specific validators.

## Version discovery

`GET /health` remains unauthenticated and backward compatible:

```json
{
  "status": "ok",
  "uptimeSeconds": 12,
  "protocolVersion": 1,
  "supportedProtocolVersions": [1, 2]
}
```

`protocolVersion` deliberately remains `1`. Existing v1 clients compare that scalar exactly and
ignore the additive array, so changing it to `2` would break them. A v2-aware client intersects
`supportedProtocolVersions` with its own supported versions and selects the highest numeric member.
Array order does not affect selection. When talking to an older daemon that omits the array, a new
client treats `[protocolVersion]` as the daemon's supported set. No intersection produces
`ProtocolMismatchError` before an authenticated route is called.

The current client supports `[1, 2]`. Its existing top-level `providers` and `sessions` namespaces
remain pinned to the unversioned v1 routes. The explicit `client.v2` namespace requires v2 and uses
only `/v2` routes.

## HTTP and SSE routes

All routes are relative to `http://127.0.0.1:<port>`. Every route except `GET /health` requires
`Authorization: Bearer <token>`.

| Route                                   | Success | Purpose                                                                                   |
| --------------------------------------- | ------: | ----------------------------------------------------------------------------------------- |
| `GET /v2/providers`                     |   `200` | Strict `{ providers: ProviderStatusV2[] }`                                                |
| `GET /v2/providers/:providerId`         |   `200` | One `ProviderStatusV2`                                                                    |
| `POST /v2/sessions`                     |   `201` | Validate and rate-limit a fresh session request; raw native continuation IDs are rejected |
| `GET /v2/sessions`                      |   `200` | Return one cursor-paginated page of durable session snapshots                             |
| `GET /v2/sessions/:sessionId`           |   `200` | Return the current or retained `AgentSessionV2` snapshot                                  |
| `GET /v2/sessions/:sessionId/history`   |   `200` | Return one cursor-paginated page of durable normalized events                             |
| `GET /v2/sessions/:sessionId/events`    |   `200` | SSE stream of `AgentEventV2Envelope`; `Last-Event-ID` resumes after that sequence         |
| `POST /v2/sessions/:sessionId/resume`   |   `201` | Resume from the terminal parent's stored provider-native ID                               |
| `POST /v2/sessions/:sessionId/fork`     |   `201` | Create a genuine native fork from the terminal parent's stored ID                         |
| `POST /v2/sessions/:sessionId/commands` |   `202` | Validate and dispatch `AgentCommandV2`, then return `CommandAcknowledgementV2`            |
| `POST /v2/sessions/:sessionId/cancel`   |   `202` | Return `{ status: 'cancelling', sessionId }` when `session.cancel` was selected           |
| `DELETE /v2/sessions/:sessionId`        |   `204` | Delete an entire terminal lineage                                                         |

The following v2 route families expose the currently implemented trust, audit, integration, and
workflow control surfaces. Their request and response schemas live in the correspondingly named
files under `packages/shared/src`; provider-backed operations may return `unsupported` or a
provider-control error when the selected provider does not implement the operation.

| Route                                                    | Success | Purpose                                                                         |
| -------------------------------------------------------- | ------: | ------------------------------------------------------------------------------- |
| `POST /v2/workspaces/inspect`                            |   `200` | Resolve canonical workspace identity and current trust state                    |
| `PUT /v2/workspaces/:workspaceId/trust`                  |   `200` | Set or revoke trust for the exact workspace incarnation                         |
| `GET /v2/audit`                                          |   `200` | Read one cursor-paginated page of normalized approval audit entries             |
| `GET /v2/integrations/mcp`                               |   `200` | Inspect configured MCP servers; see the command/argument warning below          |
| `POST /v2/integrations/mcp/configure`                    |   `200` | Request one typed MCP configuration action                                      |
| `POST /v2/integrations/mcp/action`                       |   `200` | Request connect, disconnect, or reload when supported                           |
| `GET /v2/integrations/mcp/:providerId/:serverId/catalog` |   `200` | Read a bounded MCP tools/resources/prompts catalog                              |
| `POST /v2/integrations/mcp/oauth`                        |   `200` | Start a token-opaque provider OAuth flow when supported                         |
| `POST /v2/integrations/mcp/invoke`                       |   `200` | Invoke an exact catalogued tool; current production controls report unsupported |
| `GET /v2/integrations/components`                        |   `200` | Inspect installed provider skills, plugins, hooks, commands, or agents          |
| `POST /v2/integrations/components/manage`                |   `200` | Enable or disable an exact installed component when supported                   |
| `POST /v2/integrations/components/invoke`                |   `200` | Invoke an exact component when its manifest and provider permit it              |
| `GET /v2/sessions/:sessionId/agents`                     |   `200` | Read the stored provider-neutral subagent graph                                 |
| `POST /v2/sessions/:sessionId/agents/control`            |   `200` | Request an exact child-agent control action                                     |
| `POST /v2/worktrees/preview`                             |   `200` | Preview a bounded AgentDock-owned worktree operation                            |
| `POST /v2/worktrees`                                     |   `201` | Create an AgentDock-owned worktree after explicit copy confirmation             |
| `GET /v2/worktrees`                                      |   `200` | List AgentDock-owned worktrees                                                  |
| `POST /v2/worktrees/cleanup`                             |   `200` | Clean up an owned worktree only when its current state is safe                  |
| `POST /v2/attachments`                                   |   `201` | Stage one bounded attachment from an authenticated byte stream                  |
| `GET /v2/attachments`                                    |   `200` | List staged attachment metadata                                                 |
| `POST /v2/attachments/reference`                         |   `200` | Bind staged attachments to an existing session                                  |
| `POST /v2/workflows/structured/validate`                 |   `200` | Validate caller-supplied output against a bounded JSON Schema                   |

MCP inspection withholds environment, header, bearer-token, and URL values, exposing only their
presence/classification. The current adapter returns configured stdio `command` and `args` values
verbatim as public fields without scanning embedded secrets. Do not put credentials in those
fields, and treat the inspection response as sensitive configuration data.

`/v2/worktrees/preview`, `/v2/worktrees`, and `/v2/worktrees/cleanup` require the source
repository's exact current workspace incarnation to be trusted, the same `workspace.worktrees`
contract documented in [capability-security-v2.md](capability-security-v2.md#workspace-trust): an
untrusted, revoked, or replaced source returns `409 workspace_untrusted` before any Git command
runs, trust is re-derived from disk immediately before the lease, the mutating Git command, and the
include-copy phase, and a newly created worktree begins untrusted itself.

Protocol v2 has no `cancel-all` route. The unversioned v1 endpoint remains a narrow desktop-shutdown
mechanism. Command dispatch is available only when the frozen selection includes the command's
capability and the selected provider transport exposes an interactive session. A legacy one-shot
session rejects commands with `409 session_not_capable`.

Errors are bounded JSON objects with a user-safe `error` string and stable `code` when the daemon
has a protocol-specific reason. Important statuses are:

| Status | Meaning                                                                                 |
| -----: | --------------------------------------------------------------------------------------- |
|  `400` | Malformed body, identifier, provider, directory, cursor, or route/body session mismatch |
|  `401` | Missing or incorrect bearer token                                                       |
|  `403` | A trust- or responder-bound operation is not authorized                                 |
|  `404` | Provider or session does not exist; cancellation also uses this for a terminal session  |
|  `409` | The operation conflicts with frozen selection, command identity, or session state       |
|  `413` | Request exceeds the v2 payload bound                                                    |
|  `422` | A required capability is unavailable; no provider work has started                      |
|  `429` | Session creation or command limit; client also maps `stream_overflow` here              |
|  `502` | Provider session startup or a provider-owned integration control operation failed       |
|  `507` | Durable storage is full and no eligible terminal lineage can make room                  |

## Durable execution graph

V2 session metadata and normalized event history are stored in the per-user AgentDock state
directory before provider work is dispatched. Metadata replacement is atomic; event files are
append-only JSONL. Startup quarantines corrupt records or partial tails, preserves valid data, and
marks executions that were active at daemon exit `interrupted` exactly once.

Retention is enforced across whole terminal lineages: 30 days, 500 session records plus tombstones,
and 250 MiB including quarantined bytes. Active lineages and continuation-locked lineages are never
evicted. If no eligible lineage can make room, creation fails with `507 storage_full` before provider
dispatch.

Resume and fork requests contain only new user input and optional capability preferences. The daemon
derives provider, workspace, lineage, and native session/thread ID from the stored terminal parent.
One continuation lease keyed by provider plus native ID prevents concurrent mutation; a conflict is
`409 continuation_in_use`. Fork is available only when the selected transport advertises a real
provider-native fork operation.

Session creation is limited to 30 authenticated attempts per minute per local client address. The
limiter runs before filesystem inspection, provider detection, or process startup; rejected
authentication attempts do not consume the authenticated budget.

## Provider support records

`ProviderStatusV2` separates transport metadata from scoped capability evidence:

```ts
type ProviderStatusV2 = {
  id: 'claude' | 'codex';
  name: string;
  installed: boolean;
  authenticated: 'authenticated' | 'unauthenticated' | 'unknown';
  transports: ProviderTransportV2[];
  capabilities: CapabilitySupportRecord[];
  executablePath?: string;
  version?: string;
  error?: string;
};
```

Each support record carries its stable capability ID, semantic kind and owner, support and stability
states, evidence, exact provider/transport/platform/model/auth/trust/version scope, prerequisites,
possible effects, whether the effect list is complete, typed constraints, and an optional reason.
Only fixture or host-verified evidence can establish `support: 'supported'`; runtime reports may
narrow support but cannot promote an untested feature. Duplicate scoped records are invalid.

The complete security meaning of these fields is fixed by
[Capability and security model for protocol v2](capability-security-v2.md). Provider marketing or a
runtime self-report alone never enables a capability.

## Capability request and frozen selection

```ts
type CapabilityRequest = {
  required: CapabilityRequestItem[];
  optional: CapabilityRequestItem[];
  preferredTransport?: string;
  allowExperimental: boolean;
};

type CapabilityRequestItem = {
  id: string;
  constraints?: WireCapabilityConstraints;
  allowExperimental?: boolean;
};

type CapabilitySelection = {
  transport: string;
  enabled: ReadonlyArray<{ id: string; constraints: WireCapabilityConstraints }>;
  unavailableOptional: ReadonlyArray<{ id: string; reason: string }>;
  possibleEffects: ReadonlyArray<Effect>;
  effectsComplete: boolean;
};
```

The following cases are intentionally different:

- An absent `capabilities` field on `CreateSessionV2Request` uses the safe default request. It
  requires `session.cancel` and optionally requests tool, token-usage, cost, and thinking
  observations. Initial text, session lifecycle, errors, and exactly one terminal event are
  baseline behavior rather than optional capabilities.
- A present capability request with empty `required` and `optional` arrays asks for baseline
  behavior only.
- An item with omitted `constraints` receives that constraint kind's canonical safe default,
  clipped to the provider's advertised support.
- An explicitly supplied constraint is mechanically intersected with advertised support. It never
  widens the provider record.

Negotiation filters records to the exact runtime scope, expands prerequisites, rejects cycles,
removes deprecated support, and handles experimental support only when both the request and the
individual item opt in. An unsupported required item returns `422` before dispatch. Unsupported
optional items remain visible with deterministic reasons. An eligible `preferredTransport` wins;
otherwise the lowest manifest priority and then lexical transport ID provide stable ordering.

The returned selection includes the full prerequisite closure and is frozen in `AgentSessionV2`.
A downgrade before accepted work may renegotiate. A downgrade after accepted work fails the
session and never replays it through another transport.

The current `legacy-one-shot` bridge is a migration adapter over the existing v1 process runner.
It truthfully reports an `untrusted` scope and does not advertise filesystem or network isolation.
The Claude Agent SDK transport is selected only with a verified trusted workspace and its reviewed
restricted tool policy. The legacy bridge retains the documented v1 boundary and must not be
presented as sandboxed execution.

## The 52 core capability constraints

Known core IDs accept exactly their mapped constraint discriminant. They reject `kind: 'opaque'`.

| Constraint kind                     | Core capability IDs                                                                                                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text_input`                        | `session.input.follow_up`, `session.input.steer`, `agents.subagents.steer`                                                                                                                                                                                                       |
| `acknowledgement`                   | `session.interrupt`, `session.cancel`, `agents.subagents.interrupt`, `agents.subagents.cancel`                                                                                                                                                                                   |
| `continuation`                      | `session.resume`, `session.fork`                                                                                                                                                                                                                                                 |
| `interaction`                       | `interaction.approval`, `interaction.question`, `integration.mcp.elicitation.form`, `integration.mcp.elicitation.url`                                                                                                                                                            |
| `content`                           | `content.streaming`, `content.plans`, `content.thinking`, `content.artifacts`, `integration.hooks.observe`, `agents.subagents.observe`                                                                                                                                           |
| `effects`                           | `content.tools`, `integration.mcp.tool.invoke`                                                                                                                                                                                                                                   |
| `invocation`                        | `integration.skills.invoke`, `integration.commands.invoke`, `integration.agents.invoke`                                                                                                                                                                                          |
| `usage`                             | `content.usage.tokens`                                                                                                                                                                                                                                                           |
| `cost`                              | `content.usage.cost`                                                                                                                                                                                                                                                             |
| `catalog`                           | `model.catalog`, `integration.mcp.catalog.tools`, `integration.mcp.catalog.resources`, `integration.mcp.catalog.prompts`, `integration.skills.inspect`, `integration.plugins.inspect`, `integration.hooks.inspect`, `integration.commands.inspect`, `integration.agents.inspect` |
| `mcp_server`                        | `integration.mcp.server.inspect`                                                                                                                                                                                                                                                 |
| `mcp_server` plus connect actions   | `integration.mcp.server.connect`                                                                                                                                                                                                                                                 |
| `mcp_server` plus configure actions | `integration.mcp.server.configure`                                                                                                                                                                                                                                               |
| `component_manage`                  | `integration.skills.manage`, `integration.plugins.manage`, `integration.hooks.manage`                                                                                                                                                                                            |
| `attachment`                        | `input.image`, `input.file`                                                                                                                                                                                                                                                      |
| `structured_output`                 | `output.structured`                                                                                                                                                                                                                                                              |
| `worktree`                          | `workspace.worktrees`                                                                                                                                                                                                                                                            |
| `filesystem_isolation`              | `isolation.filesystem.workspace_read`, `isolation.filesystem.read_only`, `isolation.filesystem.workspace_write`                                                                                                                                                                  |
| `network_isolation`                 | `isolation.network.restricted`                                                                                                                                                                                                                                                   |
| `none`                              | `integration.mcp.server.disconnect`, `integration.mcp.server.reload`, `integration.mcp.oauth`                                                                                                                                                                                    |

Numeric maxima take the lower value. Allowlists use canonical set intersection.
`acceptsEstimates` uses logical AND, and `native: true` must match. Persistence selects the least
revealing common mode: `live_only`, then `safe_summary`, then `normalized`.

Empty `attachmentKinds` means text-only. Empty network destinations and filesystem root handles
mean deny all access; those are valid restrictive selections. Empty transports, actions, usage
scopes, currencies, MIME types, effect/invocation sets, or worktree roots make the capability
unavailable. Duplicate entries and invalid intersections are rejected.

Canonical defaults and absolute bounds are defined in `capabilityConstraintSchemaById` and
`defaultConstraintsForCapability`. Notable limits include 200,000 prompt characters, 30-second
acknowledgements, five-minute and 32 KiB interactions, 256 KiB content blocks, catalog pages of
1-100 items, 25 MiB attachments, and structured schemas limited to 64 KiB, depth 16, and 1,024
nodes.

## Unknown capabilities and provider extensions

AgentDock reserves the `session`, `interaction`, `content`, `model`, `integration`, `agents`,
`input`, `output`, `workspace`, and `isolation` prefixes. Third-party capabilities use
`ext.<namespace>.<feature>` and `OpaqueCapabilityConstraints`:

```ts
type OpaqueCapabilityConstraints = {
  kind: 'opaque';
  value: BoundedJson;
};
```

Opaque JSON is limited to 64 KiB, depth 16, 1,024 aggregate keys/items, finite numbers, and
256-byte UTF-8 keys and strings. An unknown ID round-trips for diagnostics but is not selected
without a fixture-backed installed schema and deterministic intersector. Unknown optional IDs are
reported unavailable; unknown required IDs return `422`.

A provider-native event never becomes a new core event discriminator. When native data cannot be
represented as a selected core observation, the adapter emits a bounded `extension.summary` or a
`provider_extension` content block. Raw native frames do not cross the adapter boundary. Display or
persistence restrictions produce a safe summary with a redaction/truncation reason rather than
silently dropping the event or exposing raw data.

## Sessions, turns, lineage, and accepted work

`AgentSessionV2` contains:

- `id`, `executionId`, optional `parentExecutionId`, and optional `currentTurnId`;
- provider, selected transport, working directory, lifecycle status, and frozen selection;
- `acceptedWork`, which is `not_accepted`, `accepted`, or `unknown`;
- start/completion timestamps, optional safe error text, and `earliestSequence` for replay.

Session, execution, turn, command, interaction request, content block, and tool-call IDs are stable
UUIDs. A child execution carries `parentExecutionId`; a turn-bound event carries `turnId`. Provider
request responses bind to exactly one `(sessionId, turnId, requestId)` tuple. Retrying a command ID
with a byte-equivalent canonical payload returns the recorded acknowledgement; conflicting reuse or
a stale/cross-session interaction is rejected with `409` when command dispatch is enabled.

## Content blocks

Every block has a stable `id` and one of these normalized discriminants:

| Block type           | Purpose                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `text`               | User-visible text                                                    |
| `image`              | Opaque image attachment metadata; no inline binary                   |
| `file`               | Opaque file attachment metadata; no original path in renderer events |
| `structured_data`    | Bounded JSON-compatible structured output                            |
| `tool_activity`      | Normalized tool activity linked to a stable tool-call ID             |
| `plan`               | A bounded ordered plan representation                                |
| `provider_extension` | Bounded provider extension view or safe summary                      |

One user-visible block is limited to 256 KiB. Attachments use opaque handles and separate byte
quotas; protocol JSON never carries inline binary.

## Commands

`AgentCommandV2` is a discriminated union with a stable command ID, session ID, and the required
turn/request correlation for its variant:

| Command             | Meaning                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `input.follow_up`   | Start a new turn after an idle/completed turn                         |
| `input.steer`       | Add input to the active turn                                          |
| `session.interrupt` | Interrupt the active turn while preserving the session when supported |
| `approval.respond`  | Resolve one correlated approval request                               |
| `question.respond`  | Resolve one correlated question request                               |

Every command carries `commandId`, `sessionId`, and `turnId`. Input commands carry a nonempty
`content` array; an interrupt has no additional payload. Approval responses carry `requestId` and
`decision: 'allow_once' | 'allow_session' | 'deny'`. `allow_session` is accepted only for a normal,
fully classified action eligible for a session-scoped grant; providers still receive a one-shot
native allow for each request. Question responses carry `requestId` and up to three correlated
answers.

Interrupt is never an alias for session cancellation. Approval and question responses are accepted
exactly once and fail closed on timeout, disconnect, cancellation, or correlation mismatch.

`POST /v2/sessions/:sessionId/commands` serializes commands per session and returns `202` only
after the selected provider transport accepts the command across its accepted-work boundary. The
response is the strict acknowledgement
`{ status: 'accepted', commandId, sessionId, turnId }`. Repeating a command ID with the same
canonical payload shares the original in-flight or settled result without redispatch; an accepted
retry therefore receives the same acknowledgement. Reusing it with a different payload returns
`409 command_id_conflict`. A command outside the frozen selected constraints returns
`409 command_out_of_bounds` before provider dispatch.

Approval and question responses also require the lease held by the sole live responder stream.
Open that stream with `X-AgentDock-Responder: 1`, or with
`client.v2.sessions.events(id, { responder: true })`. The daemon returns the private lease in a
response header; `@agent-dock/client` retains it in memory and attaches it only to correlated
approval/question commands. Observer streams receive no lease. A missing, stale, or competing
lease is rejected before provider dispatch.

The daemon admits at most 64 pending commands or 1 MiB of pending canonical command JSON per
session; exceeding either limit returns `429 session_backpressure`. It retains up to 1,024 settled
command-ledger entries for retry deduplication. Provider acceptance is bounded to 30 seconds.
Interactive requests are capped by their frozen selected payload/timeout constraints, 32 pending
approvals/questions, and five minutes; overflow, timeout, disconnect, interruption, cancellation,
and shutdown resolve them provider-side fail-closed.

For this route, malformed input or a route/body session mismatch returns `400`; an unknown session
returns `404`; capability, lifecycle, interaction-correlation, command-ID, and provider-acceptance
conflicts return `409`; admission backpressure returns `429`.

## Events and envelopes

Every event envelope includes `sessionId`, `executionId`, optional `parentExecutionId`, a zero-based
monotonic `sequence`, and an ISO-8601 `timestamp`. Turn-bound variants also require `turnId`.

| Family              | Event discriminants                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Session lifecycle   | `session.started`, `session.status`, `session.completed`, `session.failed`, `session.cancelled`, `session.interrupted` |
| Turn lifecycle      | `turn.started`, `turn.completed`, `turn.failed`, `turn.interrupted`                                                    |
| Content             | `content.delta`, `content.completed`                                                                                   |
| Tools               | `tool.started`, `tool.completed`                                                                                       |
| Approvals           | `approval.requested`, `approval.resolved`                                                                              |
| Questions           | `question.requested`, `question.resolved`, `question.cancelled`                                                        |
| Accounting          | `usage.tokens`, `usage.cost`                                                                                           |
| Problems/extensions | `error`, `extension.summary`                                                                                           |

Provider-native type names are data, never normalized core discriminants. A client that receives
`thread.started`, `content_block_delta`, or another native name as `type` rejects the frame with
`ValidationError`.

Events are ordered per session. Exactly one terminal session event is emitted and it is always last.
`Last-Event-ID: n` resumes at `n + 1`. When a requested sequence is older than
`earliestSequence`, the daemon returns `409 replay_gap`. `@agent-dock/client` surfaces that response
as `DaemonError` with status `409`; the caller must reload the current snapshot and must not infer
omitted events.

Each v2 SSE connection has an independent 256-event / 4 MiB queue. A slow subscriber therefore
cannot stall provider event production or another subscriber. A terminal event closes the
connection only after already queued frames drain. If a queue exceeds either limit, the daemon
discards that queue and ends the connection with a small, unnumbered
`{ type: 'stream.error', code: 'stream_overflow', lastSequence? }` control frame. `lastSequence` is
the last event handed to that connection. `@agent-dock/client` validates this frame and throws a
`DaemonError` with status `429`. A caller tracking its last successfully yielded sequence may
reconnect from that cursor while it remains in the replay window.

## Runtime validation and bounds

The shared Zod schemas reject malformed requests before provider dispatch and malformed responses
before client code sees them. `@agent-dock/client` validates the complete provider-list wrapper,
provider records, session snapshots, command/cancellation acknowledgements, and every SSE frame.
Invalid JSON in a successful v2 response, invalid UTF-8 in a v2 stream, a missing successful
response body, an unexpected success status, or a schema mismatch becomes the client's typed
`ValidationError`.

Limits enforced by the shared schemas, compatibility bridge, and interactive supervisor are:

| Object                            |                                                               Limit |
| --------------------------------- | ------------------------------------------------------------------: |
| Initial prompt                    |                 200,000 JavaScript characters and the request limit |
| Client request/command JSON       |                         1 MiB, depth 16, 1,024 aggregate keys/items |
| Provider frame / normalized event |                                                               1 MiB |
| Provider event queue              |                                              5,000 events or 16 MiB |
| Per-subscriber SSE queue          |                                                 256 events or 4 MiB |
| Pending commands                  |                                                64 commands or 1 MiB |
| Settled command ledger            |                                                       1,024 entries |
| Pending interactions              |                                   32 requests, at most five minutes |
| Retained v2 replay                |                                              5,000 events or 16 MiB |
| Seen turn-ID ledger               |                                                      10,000 entries |
| Content-block lifecycle ledger    |                                                      10,000 entries |
| User-visible content block        |                                                             256 KiB |
| Extension view                    | 64 KiB; depth 16; 1,024 aggregate keys/items; 512-character summary |
| Startup/command acceptance; close |                                               30 seconds; 5 seconds |

Executable requests are rejected, never truncated. Display-only content over the per-block limit,
including cumulative deltas for one stable block ID, becomes one typed truncation marker carrying
the observed byte count and SHA-256; later content for that truncated block is suppressed. These
interactive limits apply only to transports using the v2 session supervisor; the one-shot
compatibility bridge retains its v1 process-runner limits.

## Current implementation boundary

The current v2 implementation provides shared schemas and negotiation, provider discovery,
durable sessions/history, trust and audit stores, versioned routes and client APIs, a
provider-neutral supervisor, bounded SSE delivery, and narrow Electron/preload methods.
`FakeProvider` exercises deterministic rich-interaction fixtures. CLI one-shot compatibility replay
fixtures remain pinned separately from the native-transport conformance harnesses.

The Claude Agent SDK transport is available only when its pinned Windows asset, approved
authentication source, and trusted-workspace requirements are satisfied; the Claude CLI
compatibility path remains `legacy-one-shot`. Codex app-server is available only for its exact
validated runtime, authentication, and trusted-workspace scope, with `legacy-one-shot` retained as
the compatibility path. The Claude SDK launch profile disables project settings, MCP, hooks,
plugins, skills, agents, and Bash.

The React renderer now uses the v2 flow for provider discovery, durable multi-session history,
resume/fork/delete, the interactive timeline, approvals/questions, workspace trust, and the exposed
integration/worktree/subagent panels. Those control surfaces are intentionally uneven: production
MCP catalog/OAuth/direct invocation and several component or child-agent actions report unsupported;
attachments can be staged and structured output can be validated, but neither is wired into a
provider execution request yet.

## Client example

This example assumes `cwd` was already inspected through `client.v2.workspaces.inspect(cwd)` and
the user explicitly trusted its current incarnation with `setTrust`; otherwise creation returns
`409 workspace_untrusted`.

```ts
import { AgentDockClient } from '@agent-dock/client';

const client = new AgentDockClient({ baseUrl, token });
const providers = await client.v2.providers.list();

const session = await client.v2.sessions.create({
  provider: providers[0].id,
  cwd,
  prompt: 'Inspect this repository',
  // Omitting capabilities selects the safe one-shot-compatible default.
});

for await (const event of client.v2.sessions.events(session.id, { responder: true })) {
  console.log(event.type, event.sequence);
}
```

For a session whose frozen selection includes an interactive command capability,
`client.v2.sessions.send(command)` validates the command and its correlated `202` acknowledgement.

The client performs discovery lazily, caches a successful result, retries discovery after transient
failure, sends bearer authentication only in headers, and never silently falls back after work may
have started.
