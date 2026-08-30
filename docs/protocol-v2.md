# Protocol v2

Protocol v2 is AgentDock's versioned HTTP and SSE contract for capability negotiation, correlated
turns and interactions, normalized content, and forward-compatible provider extensions. The
unversioned protocol v1 routes and types remain available unchanged; see
[Protocol v1](protocol-v1.md).

The TypeScript types and Zod schemas in `packages/shared/src` are the executable definition of this
document. Every client request and every daemon response is validated at runtime.

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

| Route                                 | Success | Purpose                                                                                   |
| ------------------------------------- | ------: | ----------------------------------------------------------------------------------------- |
| `GET /v2/providers`                   |   `200` | Strict `{ providers: ProviderStatusV2[] }`                                                |
| `GET /v2/providers/:providerId`       |   `200` | One `ProviderStatusV2`                                                                    |
| `POST /v2/sessions`                   |   `201` | Validate and rate-limit `CreateSessionV2Request`, negotiate, then return `AgentSessionV2` |
| `GET /v2/sessions/:sessionId`         |   `200` | Return the current `AgentSessionV2` snapshot                                              |
| `GET /v2/sessions/:sessionId/events`  |   `200` | SSE stream of `AgentEventV2Envelope`; `Last-Event-ID` resumes after that sequence         |
| `POST /v2/sessions/:sessionId/cancel` |   `202` | Return `{ status: 'cancelling', sessionId }` when `session.cancel` was selected           |
| `DELETE /v2/sessions/:sessionId`      |   `204` | Cancel when necessary, then forget the session                                            |

Protocol v2 has no `cancel-all` route. The unversioned v1 endpoint remains a narrow desktop-shutdown
mechanism. `AgentCommandV2` is part of the shared contract in this version, but the bidirectional
`POST /v2/sessions/:sessionId/commands` endpoint is introduced with the session supervisor rather
than exposing a route that cannot yet dispatch commands safely.

Errors are bounded JSON objects with a user-safe `error` string and stable `code` when the daemon
has a protocol-specific reason. Important statuses are:

| Status | Meaning                                                                                |
| -----: | -------------------------------------------------------------------------------------- |
|  `400` | Malformed body, identifier, provider, working directory, or `Last-Event-ID`            |
|  `401` | Missing or incorrect bearer token                                                      |
|  `404` | Provider or session does not exist; cancellation also uses this for a terminal session |
|  `409` | The requested operation conflicts with frozen selection or current session state       |
|  `413` | Request exceeds the v2 payload bound                                                   |
|  `422` | A required capability is unavailable; no provider work has started                     |
|  `429` | Session creation, command, or stream backpressure limit was reached                    |

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
Workspace trust enforcement is added by issue #9; until then this bridge retains the documented v1
workspace trust boundary and must not be presented as sandboxed execution.

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
`decision: 'allow_once' | 'deny'`. Question responses carry `requestId` and up to three correlated
answers.

Interrupt is never an alias for session cancellation. Approval and question responses are accepted
exactly once and fail closed on timeout, disconnect, cancellation, or correlation mismatch. This
ticket publishes and validates the wire contract; the state-aware command endpoint and correlation
ledger are intentionally activated by issue #7.

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
`earliestSequence`, the daemon returns `409 replay_gap`; the client reloads the current snapshot and
does not infer omitted events.

## Runtime validation and bounds

The shared Zod schemas reject malformed requests before provider dispatch and malformed responses
before client code sees them. `@agent-dock/client` validates the complete provider-list wrapper,
provider records, session snapshots, cancellation acknowledgements, and every SSE frame. Invalid
JSON in a successful v2 response, invalid UTF-8 in a v2 stream, a missing successful response body,
an unexpected success status, or a schema mismatch becomes the client's typed `ValidationError`.

Limits enforced by the shared schemas and current compatibility bridge are:

| Object                              |                                                               Limit |
| ----------------------------------- | ------------------------------------------------------------------: |
| Initial prompt                      |                 200,000 JavaScript characters and the request limit |
| Client request/command JSON         |                         1 MiB, depth 16, 1,024 aggregate keys/items |
| Normalized event / client SSE frame |                                                               1 MiB |
| User-visible content block          |                                                             256 KiB |
| Retained compatibility replay       |                                              5,000 events or 16 MiB |
| Extension view                      | 64 KiB; depth 16; 1,024 aggregate keys/items; 512-character summary |

Executable requests are rejected, never truncated. Display-only content may become an explicit
truncation marker. Issue #7 adds the interactive provider-frame, subscriber-queue, pending-command,
and aggregate replay byte budgets; issue #9 adds pending-interaction overflow resolution. Those
future runtime limits are not claimed by the one-shot compatibility bridge.

## Client example

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

for await (const event of client.v2.sessions.events(session.id)) {
  console.log(event.type, event.sequence);
}
```

The client performs discovery lazily, caches a successful result, retries discovery after transient
failure, sends bearer authentication only in headers, and never silently falls back after work may
have started.
