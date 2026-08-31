import { z } from 'zod';
import { PROVIDER_IDS, type AuthStatus, type ProviderId } from './provider.js';
import { sandboxStatusV2Schema, type SandboxStatusV2 } from './policy-v2.js';

export const EFFECTS = [
  'read',
  'filesystem_write',
  'command',
  'network',
  'external_side_effect',
  'destructive',
] as const;

export type Effect = (typeof EFFECTS)[number];
export type CapabilityKind = 'operation' | 'observation' | 'guarantee';
export type CapabilityOwner = 'provider' | 'agentdock' | 'composite';
export type CapabilitySupport = 'supported' | 'unsupported' | 'unknown';
export type CapabilityStability = 'stable' | 'experimental' | 'deprecated';
export type CapabilityEvidenceKind =
  'fixture' | 'host_verified' | 'runtime_report' | 'vendor_declared';
export type CapabilityPlatform = 'win32' | 'darwin' | 'linux' | 'linux_wsl2';
export type WorkspaceTrustState = 'untrusted' | 'trusted';
export type CapabilitySessionState = 'starting' | 'active' | 'idle' | 'terminal';
export type CapabilityService =
  | 'approval_responder'
  | 'question_responder'
  | 'audit_store'
  | 'attachment_store'
  | 'history_store'
  | 'workspace_lease';

export interface CapabilityEvidence {
  kind: CapabilityEvidenceKind;
  reference: string;
  verifiedAt?: string;
}

export interface CapabilityVersions {
  adapterContract: string;
  transport: string;
  runtime: string;
  sdk?: string;
  schema?: string;
  fixtureSet: string;
}

export interface CapabilityScope {
  provider: string;
  transport: string;
  platform: CapabilityPlatform;
  model: string | '*';
  authMode: string | '*';
  trustState: WorkspaceTrustState;
  versions: CapabilityVersions;
}

export interface CapabilityPrerequisites {
  capabilities: string[];
  trustStates: WorkspaceTrustState[];
  sessionStates: CapabilitySessionState[];
  services: CapabilityService[];
}

export type NoConstraints = { kind: 'none' };
export type TextInputConstraints = {
  kind: 'text_input';
  maxCharacters: number;
  attachmentKinds: Array<'image' | 'file'>;
};
export type AcknowledgementConstraints = { kind: 'acknowledgement'; timeoutMs: number };
export type ContinuationConstraints = { kind: 'continuation'; native: true };
export type InteractionConstraints = {
  kind: 'interaction';
  timeoutMs: number;
  maxPayloadBytes: number;
};
export type ContentConstraints = {
  kind: 'content';
  maxBlockBytes: number;
  persistence: 'live_only' | 'safe_summary' | 'normalized';
};
export type EffectConstraints = { kind: 'effects'; allowedEffects: Effect[] };
export type InvocationConstraints = { kind: 'invocation'; allowedEffects: Effect[] };
export type UsageConstraints = { kind: 'usage'; scopes: Array<'turn' | 'session'> };
export type CostConstraints = {
  kind: 'cost';
  scopes: Array<'turn' | 'session'>;
  currencies: string[];
  acceptsEstimates: boolean;
};
export type CatalogConstraints = { kind: 'catalog'; pageSize: number };
export type McpServerConstraints = {
  kind: 'mcp_server';
  transports: Array<'stdio' | 'streamable_http' | 'legacy_sse_read_only'>;
};
export type McpConnectConstraints = McpServerConstraints & {
  actions: Array<'connect' | 'reconnect'>;
};
export type McpConfigureConstraints = McpServerConstraints & {
  actions: Array<'add' | 'edit' | 'enable' | 'disable' | 'remove'>;
};
export type ComponentManageConstraints = {
  kind: 'component_manage';
  actions: Array<'enable' | 'disable'>;
};
export type AttachmentConstraints = { kind: 'attachment'; mimeTypes: string[]; maxBytes: number };
export type StructuredOutputConstraints = {
  kind: 'structured_output';
  maxSchemaBytes: number;
  maxSchemaDepth: number;
  maxSchemaNodes: number;
};
export type WorktreeConstraints = { kind: 'worktree'; rootHandles: string[] };
export type FilesystemIsolationConstraints = {
  kind: 'filesystem_isolation';
  rootHandles: string[];
};
export type NetworkDestination = { host: string; protocol: 'tcp' | 'udp'; port: number };
export type NetworkIsolationConstraints = {
  kind: 'network_isolation';
  destinations: NetworkDestination[];
};

export const CORE_CAPABILITY_IDS = [
  'session.input.follow_up',
  'session.input.steer',
  'session.interrupt',
  'session.cancel',
  'session.resume',
  'session.fork',
  'interaction.approval',
  'interaction.question',
  'content.streaming',
  'content.tools',
  'content.plans',
  'content.usage.tokens',
  'content.usage.cost',
  'content.thinking',
  'content.artifacts',
  'model.catalog',
  'integration.mcp.server.inspect',
  'integration.mcp.server.connect',
  'integration.mcp.server.disconnect',
  'integration.mcp.server.reload',
  'integration.mcp.server.configure',
  'integration.mcp.catalog.tools',
  'integration.mcp.catalog.resources',
  'integration.mcp.catalog.prompts',
  'integration.mcp.tool.invoke',
  'integration.mcp.oauth',
  'integration.mcp.elicitation.form',
  'integration.mcp.elicitation.url',
  'integration.skills.inspect',
  'integration.skills.invoke',
  'integration.skills.manage',
  'integration.plugins.inspect',
  'integration.plugins.manage',
  'integration.hooks.inspect',
  'integration.hooks.observe',
  'integration.hooks.manage',
  'integration.commands.inspect',
  'integration.commands.invoke',
  'integration.agents.inspect',
  'integration.agents.invoke',
  'agents.subagents.observe',
  'agents.subagents.steer',
  'agents.subagents.interrupt',
  'agents.subagents.cancel',
  'input.image',
  'input.file',
  'output.structured',
  'workspace.worktrees',
  'isolation.filesystem.workspace_read',
  'isolation.filesystem.read_only',
  'isolation.filesystem.workspace_write',
  'isolation.network.restricted',
] as const;

export type CoreCapabilityId = (typeof CORE_CAPABILITY_IDS)[number];

export interface CapabilityConstraintById {
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
}

export type CapabilityConstraints<I extends CoreCapabilityId = CoreCapabilityId> =
  CapabilityConstraintById[I];
export type BoundedJson =
  null | boolean | number | string | BoundedJson[] | { [key: string]: BoundedJson };
export type OpaqueCapabilityConstraints = { kind: 'opaque'; value: BoundedJson };
export type WireCapabilityConstraints = CapabilityConstraints | OpaqueCapabilityConstraints;

type CatalogEntry = { kind: CapabilityKind; owner: CapabilityOwner };

export const CAPABILITY_CATALOG = {
  'session.input.follow_up': { kind: 'operation', owner: 'provider' },
  'session.input.steer': { kind: 'operation', owner: 'provider' },
  'session.interrupt': { kind: 'operation', owner: 'provider' },
  'session.cancel': { kind: 'operation', owner: 'agentdock' },
  'session.resume': { kind: 'operation', owner: 'provider' },
  'session.fork': { kind: 'operation', owner: 'provider' },
  'interaction.approval': { kind: 'operation', owner: 'composite' },
  'interaction.question': { kind: 'operation', owner: 'composite' },
  'content.streaming': { kind: 'observation', owner: 'provider' },
  'content.tools': { kind: 'observation', owner: 'provider' },
  'content.plans': { kind: 'observation', owner: 'provider' },
  'content.usage.tokens': { kind: 'observation', owner: 'provider' },
  'content.usage.cost': { kind: 'observation', owner: 'provider' },
  'content.thinking': { kind: 'observation', owner: 'provider' },
  'content.artifacts': { kind: 'observation', owner: 'provider' },
  'model.catalog': { kind: 'operation', owner: 'provider' },
  'integration.mcp.server.inspect': { kind: 'operation', owner: 'provider' },
  'integration.mcp.server.connect': { kind: 'operation', owner: 'composite' },
  'integration.mcp.server.disconnect': { kind: 'operation', owner: 'composite' },
  'integration.mcp.server.reload': { kind: 'operation', owner: 'composite' },
  'integration.mcp.server.configure': { kind: 'operation', owner: 'composite' },
  'integration.mcp.catalog.tools': { kind: 'operation', owner: 'provider' },
  'integration.mcp.catalog.resources': { kind: 'operation', owner: 'provider' },
  'integration.mcp.catalog.prompts': { kind: 'operation', owner: 'provider' },
  'integration.mcp.tool.invoke': { kind: 'operation', owner: 'composite' },
  'integration.mcp.oauth': { kind: 'operation', owner: 'provider' },
  'integration.mcp.elicitation.form': { kind: 'operation', owner: 'composite' },
  'integration.mcp.elicitation.url': { kind: 'operation', owner: 'composite' },
  'integration.skills.inspect': { kind: 'operation', owner: 'provider' },
  'integration.skills.invoke': { kind: 'operation', owner: 'composite' },
  'integration.skills.manage': { kind: 'operation', owner: 'composite' },
  'integration.plugins.inspect': { kind: 'operation', owner: 'provider' },
  'integration.plugins.manage': { kind: 'operation', owner: 'composite' },
  'integration.hooks.inspect': { kind: 'operation', owner: 'provider' },
  'integration.hooks.observe': { kind: 'observation', owner: 'composite' },
  'integration.hooks.manage': { kind: 'operation', owner: 'composite' },
  'integration.commands.inspect': { kind: 'operation', owner: 'provider' },
  'integration.commands.invoke': { kind: 'operation', owner: 'composite' },
  'integration.agents.inspect': { kind: 'operation', owner: 'provider' },
  'integration.agents.invoke': { kind: 'operation', owner: 'composite' },
  'agents.subagents.observe': { kind: 'observation', owner: 'provider' },
  'agents.subagents.steer': { kind: 'operation', owner: 'provider' },
  'agents.subagents.interrupt': { kind: 'operation', owner: 'provider' },
  'agents.subagents.cancel': { kind: 'operation', owner: 'provider' },
  'input.image': { kind: 'operation', owner: 'composite' },
  'input.file': { kind: 'operation', owner: 'composite' },
  'output.structured': { kind: 'operation', owner: 'composite' },
  'workspace.worktrees': { kind: 'operation', owner: 'agentdock' },
  'isolation.filesystem.workspace_read': { kind: 'guarantee', owner: 'composite' },
  'isolation.filesystem.read_only': { kind: 'guarantee', owner: 'composite' },
  'isolation.filesystem.workspace_write': { kind: 'guarantee', owner: 'composite' },
  'isolation.network.restricted': { kind: 'guarantee', owner: 'composite' },
} as const satisfies Record<CoreCapabilityId, CatalogEntry>;

type CapabilitySupportBase = {
  kind: CapabilityKind;
  owner: CapabilityOwner;
  support: CapabilitySupport;
  stability: CapabilityStability;
  evidence: CapabilityEvidence[];
  scope: CapabilityScope;
  prerequisites: CapabilityPrerequisites;
  possibleEffects: Effect[];
  effectsComplete: boolean;
  reason?: string;
};

export type CoreCapabilitySupportRecord = {
  [I in CoreCapabilityId]: CapabilitySupportBase & {
    id: I;
    kind: (typeof CAPABILITY_CATALOG)[I]['kind'];
    owner: (typeof CAPABILITY_CATALOG)[I]['owner'];
    constraints: CapabilityConstraintById[I];
  };
}[CoreCapabilityId];

export type OpaqueCapabilitySupportRecord = CapabilitySupportBase & {
  id: string;
  constraints: OpaqueCapabilityConstraints;
};

export type CapabilitySupportRecord = CoreCapabilitySupportRecord | OpaqueCapabilitySupportRecord;

export interface CapabilityRequestItem {
  id: string;
  constraints?: WireCapabilityConstraints;
  allowExperimental?: boolean;
}

export interface CapabilityRequest {
  required: CapabilityRequestItem[];
  optional: CapabilityRequestItem[];
  preferredTransport?: string;
  allowExperimental: boolean;
}

export interface SelectedCapability {
  id: string;
  constraints: WireCapabilityConstraints;
}

export interface CapabilityUnavailable {
  id: string;
  reason: string;
}

export interface CapabilitySelection {
  transport: string;
  enabled: ReadonlyArray<Readonly<SelectedCapability>>;
  unavailableOptional: ReadonlyArray<Readonly<CapabilityUnavailable>>;
  possibleEffects: ReadonlyArray<Effect>;
  effectsComplete: boolean;
}

export interface ProviderTransportV2 {
  id: string;
  priority: number;
  stability: CapabilityStability;
  possibleEffects: Effect[];
  effectsComplete: boolean;
}

export interface ProviderStatusV2 {
  id: ProviderId;
  name: string;
  installed: boolean;
  authenticated: AuthStatus;
  transports: ProviderTransportV2[];
  capabilities: CapabilitySupportRecord[];
  /** Truthful, layered status; policy restrictions never imply OS isolation. */
  sandbox: SandboxStatusV2;
  executablePath?: string;
  version?: string;
  error?: string;
}

export interface ProvidersV2Response {
  providers: ProviderStatusV2[];
}

const MAX_OPAQUE_BYTES = 64 * 1024;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_ITEMS = 1_024;
const MAX_WIRE_STRING_BYTES = 256;
const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export interface JsonBounds {
  maxBytes: number;
  maxDepth: number;
  maxItems: number;
  maxStringBytes: number;
}

export function validateJsonBounds(value: unknown, bounds: JsonBounds): string | undefined {
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  const activePath = new WeakSet<object>();
  let aggregateItems = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.exit) {
      if (current.value !== null && typeof current.value === 'object')
        activePath.delete(current.value);
      continue;
    }
    if (current.depth > bounds.maxDepth) return `JSON nesting exceeds depth ${bounds.maxDepth}`;
    if (current.value === null || typeof current.value === 'boolean') continue;
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) return 'JSON numbers must be finite';
      continue;
    }
    if (typeof current.value === 'string') {
      if (utf8ByteLength(current.value) > bounds.maxStringBytes) {
        return `JSON strings must be at most ${bounds.maxStringBytes} UTF-8 bytes`;
      }
      continue;
    }
    if (typeof current.value !== 'object') return 'value is not JSON-compatible';
    if (activePath.has(current.value)) return 'cyclic values are not JSON-compatible';
    activePath.add(current.value);
    stack.push({ value: current.value, depth: current.depth, exit: true });

    if (Array.isArray(current.value)) {
      aggregateItems += current.value.length;
      if (aggregateItems > bounds.maxItems) return `JSON aggregate items exceed ${bounds.maxItems}`;
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        if (!Object.prototype.hasOwnProperty.call(current.value, index))
          return 'sparse arrays are not JSON-compatible';
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null)
      return 'JSON objects must be plain objects';
    const keys = Object.keys(current.value);
    if (Reflect.ownKeys(current.value).length !== keys.length)
      return 'JSON objects may only have enumerable string keys';
    aggregateItems += keys.length;
    if (aggregateItems > bounds.maxItems) return `JSON aggregate items exceed ${bounds.maxItems}`;
    for (const key of keys) {
      if (utf8ByteLength(key) > bounds.maxStringBytes) {
        return `JSON keys must be at most ${bounds.maxStringBytes} UTF-8 bytes`;
      }
      stack.push({
        value: (current.value as Record<string, unknown>)[key],
        depth: current.depth + 1,
      });
    }
  }

  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return 'value is not JSON-compatible';
  }
  if (utf8ByteLength(encoded) > bounds.maxBytes)
    return `encoded JSON exceeds ${bounds.maxBytes} bytes`;
  return undefined;
}

function jsonSchema(bounds: JsonBounds): z.ZodType<BoundedJson, z.ZodTypeDef, unknown> {
  return z
    .unknown()
    .superRefine((value, ctx) => {
      const issue = validateJsonBounds(value, bounds);
      if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
    })
    .transform((value) => value as BoundedJson);
}

export const boundedJsonSchema = jsonSchema({
  maxBytes: MAX_OPAQUE_BYTES,
  maxDepth: MAX_JSON_DEPTH,
  maxItems: MAX_JSON_ITEMS,
  maxStringBytes: MAX_WIRE_STRING_BYTES,
});

export const contentJsonSchema = jsonSchema({
  maxBytes: MAX_CONTENT_BYTES,
  maxDepth: MAX_JSON_DEPTH,
  maxItems: MAX_JSON_ITEMS,
  maxStringBytes: MAX_WIRE_STRING_BYTES,
});

const byteBoundedStringSchema = z
  .string()
  .refine((value) => utf8ByteLength(value) <= MAX_WIRE_STRING_BYTES, {
    message: `must be at most ${MAX_WIRE_STRING_BYTES} UTF-8 bytes`,
  });
const nonemptyByteBoundedStringSchema = byteBoundedStringSchema.refine(
  (value) => value.length > 0,
  'must not be empty',
);
const capabilitySegment = '[a-z][a-z0-9]*(?:_[a-z0-9]+)*';
const capabilityIdPattern = new RegExp(`^${capabilitySegment}(?:\\.${capabilitySegment})+$`);
const extensionCapabilityIdPattern = new RegExp(
  `^ext\\.${capabilitySegment}\\.${capabilitySegment}(?:\\.${capabilitySegment})*$`,
);
const reservedCapabilityPrefixes = new Set([
  'session',
  'interaction',
  'content',
  'model',
  'integration',
  'agents',
  'input',
  'output',
  'workspace',
  'isolation',
]);
const coreCapabilityIdSet = new Set<string>(CORE_CAPABILITY_IDS);

export const capabilityIdSchema = z
  .string()
  .min(1)
  .regex(capabilityIdPattern, 'invalid capability id')
  .refine((value) => utf8ByteLength(value) <= MAX_WIRE_STRING_BYTES, {
    message: `must be at most ${MAX_WIRE_STRING_BYTES} UTF-8 bytes`,
  })
  .refine(
    (value) =>
      reservedCapabilityPrefixes.has(value.slice(0, value.indexOf('.'))) ||
      extensionCapabilityIdPattern.test(value),
    'capability IDs must use a reserved AgentDock prefix or ext.<namespace>.<feature>',
  );
export const coreCapabilityIdSchema = z.enum(CORE_CAPABILITY_IDS);
export const effectSchema = z.enum(EFFECTS);

function uniqueArray<T extends z.ZodTypeAny>(item: T, maximum = 32) {
  return z
    .array(item)
    .max(maximum)
    .superRefine((values, ctx) => {
      const keys = values.map((value) =>
        typeof value === 'object' ? JSON.stringify(value) : String(value),
      );
      if (new Set(keys).size !== keys.length)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate entries are not allowed' });
    });
}

const nonnegativeInteger = (maximum: number) => z.number().int().finite().min(0).max(maximum);
const persistenceSchema = z.enum(['live_only', 'safe_summary', 'normalized']);
const attachmentKindSchema = z.enum(['image', 'file']);
const usageScopeSchema = z.enum(['turn', 'session']);
const mcpTransportSchema = z.enum(['stdio', 'streamable_http', 'legacy_sse_read_only']);

export const noConstraintsSchema = z.object({ kind: z.literal('none') }).strict();
export const textInputConstraintsSchema = z
  .object({
    kind: z.literal('text_input'),
    maxCharacters: nonnegativeInteger(200_000),
    attachmentKinds: uniqueArray(attachmentKindSchema, 2),
  })
  .strict();
export const acknowledgementConstraintsSchema = z
  .object({
    kind: z.literal('acknowledgement'),
    timeoutMs: nonnegativeInteger(30_000),
  })
  .strict();
export const continuationConstraintsSchema = z
  .object({ kind: z.literal('continuation'), native: z.literal(true) })
  .strict();
export const interactionConstraintsSchema = z
  .object({
    kind: z.literal('interaction'),
    timeoutMs: nonnegativeInteger(300_000),
    maxPayloadBytes: nonnegativeInteger(32 * 1024),
  })
  .strict();
export const contentConstraintsSchema = z
  .object({
    kind: z.literal('content'),
    maxBlockBytes: nonnegativeInteger(MAX_CONTENT_BYTES),
    persistence: persistenceSchema,
  })
  .strict();
export const effectConstraintsSchema = z
  .object({ kind: z.literal('effects'), allowedEffects: uniqueArray(effectSchema, EFFECTS.length) })
  .strict();
export const invocationConstraintsSchema = z
  .object({
    kind: z.literal('invocation'),
    allowedEffects: uniqueArray(effectSchema, EFFECTS.length),
  })
  .strict();
export const usageConstraintsSchema = z
  .object({ kind: z.literal('usage'), scopes: uniqueArray(usageScopeSchema, 2) })
  .strict();
export const costConstraintsSchema = z
  .object({
    kind: z.literal('cost'),
    scopes: uniqueArray(usageScopeSchema, 2),
    currencies: uniqueArray(nonemptyByteBoundedStringSchema),
    acceptsEstimates: z.boolean(),
  })
  .strict();
export const catalogConstraintsSchema = z
  .object({ kind: z.literal('catalog'), pageSize: z.number().int().finite().min(1).max(100) })
  .strict();
export const mcpServerConstraintsSchema = z
  .object({ kind: z.literal('mcp_server'), transports: uniqueArray(mcpTransportSchema, 3) })
  .strict();
export const mcpConnectConstraintsSchema = mcpServerConstraintsSchema
  .extend({ actions: uniqueArray(z.enum(['connect', 'reconnect']), 2) })
  .strict();
export const mcpConfigureConstraintsSchema = mcpServerConstraintsSchema
  .extend({
    actions: uniqueArray(z.enum(['add', 'edit', 'enable', 'disable', 'remove']), 5),
  })
  .strict();
export const componentManageConstraintsSchema = z
  .object({
    kind: z.literal('component_manage'),
    actions: uniqueArray(z.enum(['enable', 'disable']), 2),
  })
  .strict();
export const attachmentConstraintsSchema = z
  .object({
    kind: z.literal('attachment'),
    mimeTypes: uniqueArray(nonemptyByteBoundedStringSchema),
    maxBytes: nonnegativeInteger(MAX_ATTACHMENT_BYTES),
  })
  .strict();
export const structuredOutputConstraintsSchema = z
  .object({
    kind: z.literal('structured_output'),
    maxSchemaBytes: nonnegativeInteger(64 * 1024),
    maxSchemaDepth: nonnegativeInteger(16),
    maxSchemaNodes: nonnegativeInteger(1_024),
  })
  .strict();
export const worktreeConstraintsSchema = z
  .object({
    kind: z.literal('worktree'),
    rootHandles: uniqueArray(nonemptyByteBoundedStringSchema),
  })
  .strict();
export const filesystemIsolationConstraintsSchema = z
  .object({
    kind: z.literal('filesystem_isolation'),
    rootHandles: uniqueArray(nonemptyByteBoundedStringSchema),
  })
  .strict();

const canonicalHostPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const networkDestinationSchema = z
  .object({
    host: z
      .string()
      .min(1)
      .max(253)
      .regex(canonicalHostPattern, 'host must be a canonical lowercase IDNA name'),
    protocol: z.enum(['tcp', 'udp']),
    port: z.number().int().finite().min(1).max(65_535),
  })
  .strict();
export const networkIsolationConstraintsSchema = z
  .object({
    kind: z.literal('network_isolation'),
    destinations: uniqueArray(networkDestinationSchema),
  })
  .strict();
export const opaqueCapabilityConstraintsSchema = z
  .object({ kind: z.literal('opaque'), value: boundedJsonSchema })
  .strict();

export const capabilityConstraintSchemaById = {
  'session.input.follow_up': textInputConstraintsSchema,
  'session.input.steer': textInputConstraintsSchema,
  'session.interrupt': acknowledgementConstraintsSchema,
  'session.cancel': acknowledgementConstraintsSchema,
  'session.resume': continuationConstraintsSchema,
  'session.fork': continuationConstraintsSchema,
  'interaction.approval': interactionConstraintsSchema,
  'interaction.question': interactionConstraintsSchema,
  'content.streaming': contentConstraintsSchema,
  'content.tools': effectConstraintsSchema,
  'content.plans': contentConstraintsSchema,
  'content.usage.tokens': usageConstraintsSchema,
  'content.usage.cost': costConstraintsSchema,
  'content.thinking': contentConstraintsSchema,
  'content.artifacts': contentConstraintsSchema,
  'model.catalog': catalogConstraintsSchema,
  'integration.mcp.server.inspect': mcpServerConstraintsSchema,
  'integration.mcp.server.connect': mcpConnectConstraintsSchema,
  'integration.mcp.server.disconnect': noConstraintsSchema,
  'integration.mcp.server.reload': noConstraintsSchema,
  'integration.mcp.server.configure': mcpConfigureConstraintsSchema,
  'integration.mcp.catalog.tools': catalogConstraintsSchema,
  'integration.mcp.catalog.resources': catalogConstraintsSchema,
  'integration.mcp.catalog.prompts': catalogConstraintsSchema,
  'integration.mcp.tool.invoke': effectConstraintsSchema,
  'integration.mcp.oauth': noConstraintsSchema,
  'integration.mcp.elicitation.form': interactionConstraintsSchema,
  'integration.mcp.elicitation.url': interactionConstraintsSchema,
  'integration.skills.inspect': catalogConstraintsSchema,
  'integration.skills.invoke': invocationConstraintsSchema,
  'integration.skills.manage': componentManageConstraintsSchema,
  'integration.plugins.inspect': catalogConstraintsSchema,
  'integration.plugins.manage': componentManageConstraintsSchema,
  'integration.hooks.inspect': catalogConstraintsSchema,
  'integration.hooks.observe': contentConstraintsSchema,
  'integration.hooks.manage': componentManageConstraintsSchema,
  'integration.commands.inspect': catalogConstraintsSchema,
  'integration.commands.invoke': invocationConstraintsSchema,
  'integration.agents.inspect': catalogConstraintsSchema,
  'integration.agents.invoke': invocationConstraintsSchema,
  'agents.subagents.observe': contentConstraintsSchema,
  'agents.subagents.steer': textInputConstraintsSchema,
  'agents.subagents.interrupt': acknowledgementConstraintsSchema,
  'agents.subagents.cancel': acknowledgementConstraintsSchema,
  'input.image': attachmentConstraintsSchema,
  'input.file': attachmentConstraintsSchema,
  'output.structured': structuredOutputConstraintsSchema,
  'workspace.worktrees': worktreeConstraintsSchema,
  'isolation.filesystem.workspace_read': filesystemIsolationConstraintsSchema,
  'isolation.filesystem.read_only': filesystemIsolationConstraintsSchema,
  'isolation.filesystem.workspace_write': filesystemIsolationConstraintsSchema,
  'isolation.network.restricted': networkIsolationConstraintsSchema,
} as const satisfies Record<CoreCapabilityId, z.ZodTypeAny>;

const capabilityKindSchema = z.enum(['operation', 'observation', 'guarantee']);
const capabilityOwnerSchema = z.enum(['provider', 'agentdock', 'composite']);
const capabilitySupportSchema = z.enum(['supported', 'unsupported', 'unknown']);
const capabilityStabilitySchema = z.enum(['stable', 'experimental', 'deprecated']);
const capabilityEvidenceSchema = z
  .object({
    kind: z.enum(['fixture', 'host_verified', 'runtime_report', 'vendor_declared']),
    reference: nonemptyByteBoundedStringSchema,
    verifiedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
const capabilityVersionsSchema = z
  .object({
    adapterContract: nonemptyByteBoundedStringSchema,
    transport: nonemptyByteBoundedStringSchema,
    runtime: nonemptyByteBoundedStringSchema,
    sdk: nonemptyByteBoundedStringSchema.optional(),
    schema: nonemptyByteBoundedStringSchema.optional(),
    fixtureSet: nonemptyByteBoundedStringSchema,
  })
  .strict();
const capabilityScopeSchema = z
  .object({
    provider: nonemptyByteBoundedStringSchema,
    transport: nonemptyByteBoundedStringSchema,
    platform: z.enum(['win32', 'darwin', 'linux', 'linux_wsl2']),
    model: nonemptyByteBoundedStringSchema,
    authMode: nonemptyByteBoundedStringSchema,
    trustState: z.enum(['untrusted', 'trusted']),
    versions: capabilityVersionsSchema,
  })
  .strict();
const capabilityPrerequisitesSchema = z
  .object({
    capabilities: uniqueArray(capabilityIdSchema, CORE_CAPABILITY_IDS.length),
    trustStates: uniqueArray(z.enum(['untrusted', 'trusted']), 2),
    sessionStates: uniqueArray(z.enum(['starting', 'active', 'idle', 'terminal']), 4),
    services: uniqueArray(
      z.enum([
        'approval_responder',
        'question_responder',
        'audit_store',
        'attachment_store',
        'history_store',
        'workspace_lease',
      ]),
      6,
    ),
  })
  .strict();

const capabilitySupportRecordBaseSchema = z
  .object({
    id: capabilityIdSchema,
    kind: capabilityKindSchema,
    owner: capabilityOwnerSchema,
    support: capabilitySupportSchema,
    stability: capabilityStabilitySchema,
    evidence: z.array(capabilityEvidenceSchema),
    scope: capabilityScopeSchema,
    prerequisites: capabilityPrerequisitesSchema,
    possibleEffects: uniqueArray(effectSchema, EFFECTS.length),
    effectsComplete: z.boolean(),
    constraints: z.unknown(),
    reason: byteBoundedStringSchema.optional(),
  })
  .strict();

function addNestedIssues(
  ctx: z.RefinementCtx,
  result: z.SafeParseReturnType<unknown, unknown>,
  path: Array<string | number>,
): void {
  if (result.success) return;
  for (const issue of result.error.issues)
    ctx.addIssue({ ...issue, path: [...path, ...issue.path] });
}

export const capabilitySupportRecordSchema = capabilitySupportRecordBaseSchema
  .superRefine((record, ctx) => {
    if (
      record.support === 'supported' &&
      !record.evidence.some((item) => item.kind === 'fixture' || item.kind === 'host_verified')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence'],
        message: 'supported records require fixture or host_verified evidence',
      });
    }
    if (coreCapabilityIdSet.has(record.id)) {
      const id = record.id as CoreCapabilityId;
      const catalog = CAPABILITY_CATALOG[id];
      if (record.kind !== catalog.kind)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['kind'],
          message: `must be ${catalog.kind} for ${id}`,
        });
      if (record.owner !== catalog.owner)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['owner'],
          message: `must be ${catalog.owner} for ${id}`,
        });
      addNestedIssues(ctx, capabilityConstraintSchemaById[id].safeParse(record.constraints), [
        'constraints',
      ]);
    } else {
      addNestedIssues(ctx, opaqueCapabilityConstraintsSchema.safeParse(record.constraints), [
        'constraints',
      ]);
    }
  })
  .transform((record) => record as CapabilitySupportRecord);

const capabilityRequestItemBaseSchema = z
  .object({
    id: capabilityIdSchema,
    constraints: z.unknown().optional(),
    allowExperimental: z.boolean().optional(),
  })
  .strict();

export const capabilityRequestItemSchema = capabilityRequestItemBaseSchema
  .superRefine((item, ctx) => {
    if (item.constraints === undefined) return;
    if (coreCapabilityIdSet.has(item.id)) {
      addNestedIssues(
        ctx,
        capabilityConstraintSchemaById[item.id as CoreCapabilityId].safeParse(item.constraints),
        ['constraints'],
      );
    } else {
      addNestedIssues(ctx, opaqueCapabilityConstraintsSchema.safeParse(item.constraints), [
        'constraints',
      ]);
    }
  })
  .transform((item) => item as CapabilityRequestItem);

export const capabilityRequestSchema = z
  .object({
    required: z.array(capabilityRequestItemSchema).default([]),
    optional: z.array(capabilityRequestItemSchema).default([]),
    preferredTransport: nonemptyByteBoundedStringSchema.optional(),
    allowExperimental: z.boolean().default(false),
  })
  .strict()
  .superRefine((request, ctx) => {
    const ids = [...request.required, ...request.optional].map((item) => item.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'capability request IDs must be unique across required and optional',
      });
    const boundsIssue = validateJsonBounds(request, {
      maxBytes: 1024 * 1024,
      maxDepth: 16,
      maxItems: 1_024,
      maxStringBytes: 64 * 1024,
    });
    if (boundsIssue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: boundsIssue });
  });

export const DEFAULT_CAPABILITY_REQUEST: Readonly<CapabilityRequest> = Object.freeze({
  required: Object.freeze([{ id: 'session.cancel' }]),
  optional: Object.freeze([
    { id: 'content.tools' },
    { id: 'content.usage.tokens' },
    { id: 'content.usage.cost' },
    { id: 'content.thinking' },
  ]),
  allowExperimental: false,
}) as Readonly<CapabilityRequest>;

const selectedCapabilitySchema = z
  .object({ id: capabilityIdSchema, constraints: z.unknown() })
  .strict()
  .superRefine((item, ctx) => {
    if (coreCapabilityIdSet.has(item.id))
      addNestedIssues(
        ctx,
        capabilityConstraintSchemaById[item.id as CoreCapabilityId].safeParse(item.constraints),
        ['constraints'],
      );
    else
      addNestedIssues(ctx, opaqueCapabilityConstraintsSchema.safeParse(item.constraints), [
        'constraints',
      ]);
  })
  .transform((item) => item as SelectedCapability);

export const capabilitySelectionSchema = z
  .object({
    transport: nonemptyByteBoundedStringSchema,
    enabled: z.array(selectedCapabilitySchema),
    unavailableOptional: z.array(
      z.object({ id: capabilityIdSchema, reason: nonemptyByteBoundedStringSchema }).strict(),
    ),
    possibleEffects: uniqueArray(effectSchema, EFFECTS.length),
    effectsComplete: z.boolean(),
  })
  .strict()
  .superRefine((selection, ctx) => {
    const enabledIds = new Set<string>();
    for (const [index, item] of selection.enabled.entries()) {
      if (enabledIds.has(item.id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['enabled', index, 'id'],
          message: 'enabled capability IDs must be unique',
        });
      enabledIds.add(item.id);
    }

    const unavailableIds = new Set<string>();
    for (const [index, item] of selection.unavailableOptional.entries()) {
      if (unavailableIds.has(item.id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['unavailableOptional', index, 'id'],
          message: 'unavailable optional capability IDs must be unique',
        });
      if (enabledIds.has(item.id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['unavailableOptional', index, 'id'],
          message: 'a capability cannot be both enabled and unavailable',
        });
      unavailableIds.add(item.id);
    }
  })
  .transform((selection) => selection as CapabilitySelection);

export const providerTransportV2Schema = z
  .object({
    id: nonemptyByteBoundedStringSchema,
    priority: z.number().int().finite().nonnegative(),
    stability: capabilityStabilitySchema,
    possibleEffects: uniqueArray(effectSchema, EFFECTS.length),
    effectsComplete: z.boolean(),
  })
  .strict();

export const providerStatusV2Schema = z
  .object({
    id: z.enum(PROVIDER_IDS),
    name: z.string(),
    installed: z.boolean(),
    authenticated: z.enum(['authenticated', 'unauthenticated', 'unknown']),
    transports: z.array(providerTransportV2Schema),
    capabilities: z.array(capabilitySupportRecordSchema),
    sandbox: sandboxStatusV2Schema,
    executablePath: z.string().optional(),
    version: z.string().optional(),
    error: z.string().optional(),
  })
  .strict()
  .superRefine((status, ctx) => {
    const transportIds = status.transports.map((transport) => transport.id);
    if (new Set(transportIds).size !== transportIds.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transports'],
        message: 'transport IDs must be unique',
      });
    const knownTransports = new Set(transportIds);
    const recordKeys = status.capabilities.map((record) =>
      JSON.stringify({ id: record.id, scope: record.scope }),
    );
    if (new Set(recordKeys).size !== recordKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities'],
        message: 'support records must be unique by ID and full scope',
      });
    }
    for (const [index, record] of status.capabilities.entries()) {
      if (record.scope.provider !== status.id)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['capabilities', index, 'scope', 'provider'],
          message: 'scope provider must match provider status id',
        });
      if (!knownTransports.has(record.scope.transport))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['capabilities', index, 'scope', 'transport'],
          message: 'scope transport must be declared by provider status',
        });
    }
  });

export const providersV2ResponseSchema = z
  .object({ providers: z.array(providerStatusV2Schema) })
  .strict();

export type CapabilityRuntimeScope = Omit<CapabilityScope, 'transport'>;

export interface CapabilityExtensionHandler {
  fixtureReference: string;
  validate(constraints: OpaqueCapabilityConstraints): boolean;
  intersect(
    advertised: OpaqueCapabilityConstraints,
    requested: OpaqueCapabilityConstraints | undefined,
  ): OpaqueCapabilityConstraints | null;
}

export interface CapabilityNegotiationInput {
  request?: CapabilityRequest;
  runtimeScope: CapabilityRuntimeScope;
  supportRecords: readonly CapabilitySupportRecord[];
  transports: readonly ProviderTransportV2[];
  selectedWorkspaceRootHandle?: string;
  sessionState?: CapabilitySessionState;
  services?: readonly CapabilityService[];
  extensionHandlers?: Readonly<Record<string, CapabilityExtensionHandler>>;
}

export type CapabilityNegotiationFailureCode =
  'invalid_manifest' | 'required_capability_unavailable';

export type CapabilityNegotiationResult =
  | { success: true; selection: Readonly<CapabilitySelection> }
  | {
      success: false;
      code: CapabilityNegotiationFailureCode;
      unavailableRequired: ReadonlyArray<Readonly<CapabilityUnavailable>>;
    };

const effectOrder = new Map<Effect, number>(EFFECTS.map((effect, index) => [effect, index]));
const persistenceOrder = ['live_only', 'safe_summary', 'normalized'] as const;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortedStrings<T extends string>(values: Iterable<T>): T[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sortedEffects(values: Iterable<Effect>): Effect[] {
  return [...values].sort(
    (left, right) => (effectOrder.get(left) ?? 0) - (effectOrder.get(right) ?? 0),
  );
}

function stringIntersection<T extends string>(
  advertised: readonly T[],
  requested: readonly T[],
): T[] {
  const allowed = new Set(advertised);
  return sortedStrings(new Set(requested.filter((value) => allowed.has(value))));
}

function effectIntersection(advertised: readonly Effect[], requested: readonly Effect[]): Effect[] {
  const allowed = new Set(advertised);
  return sortedEffects(new Set(requested.filter((value) => allowed.has(value))));
}

function destinationKey(destination: NetworkDestination): string {
  return `${destination.host}\u0000${destination.protocol}\u0000${destination.port.toString().padStart(5, '0')}`;
}

function destinationIntersection(
  advertised: readonly NetworkDestination[],
  requested: readonly NetworkDestination[],
): NetworkDestination[] {
  const allowed = new Set(advertised.map(destinationKey));
  return requested
    .filter((destination) => allowed.has(destinationKey(destination)))
    .map((destination) => ({ ...destination }))
    .sort((left, right) => destinationKey(left).localeCompare(destinationKey(right)));
}

function lessRevealingPersistence(
  left: ContentConstraints['persistence'],
  right: ContentConstraints['persistence'],
): ContentConstraints['persistence'] {
  return persistenceOrder[
    Math.min(persistenceOrder.indexOf(left), persistenceOrder.indexOf(right))
  ]!;
}

/** Canonical #5 defaults, already clipped to one advertised core record. */
export function defaultConstraintsForCapability<I extends CoreCapabilityId>(
  id: I,
  advertised: CapabilityConstraintById[I],
  selectedWorkspaceRootHandle?: string,
): CapabilityConstraintById[I] {
  let result: CapabilityConstraints;
  switch (advertised.kind) {
    case 'text_input':
      result = {
        kind: 'text_input',
        maxCharacters: Math.min(advertised.maxCharacters, 200_000),
        attachmentKinds: [],
      };
      break;
    case 'acknowledgement':
      result = { kind: 'acknowledgement', timeoutMs: Math.min(advertised.timeoutMs, 30_000) };
      break;
    case 'continuation':
      result = { kind: 'continuation', native: true };
      break;
    case 'interaction':
      result = {
        kind: 'interaction',
        timeoutMs: Math.min(advertised.timeoutMs, 300_000),
        maxPayloadBytes: Math.min(advertised.maxPayloadBytes, 32 * 1024),
      };
      break;
    case 'content':
      result = {
        kind: 'content',
        maxBlockBytes: Math.min(advertised.maxBlockBytes, MAX_CONTENT_BYTES),
        persistence: 'live_only',
      };
      break;
    case 'effects':
      result = {
        kind: 'effects',
        allowedEffects: effectIntersection(advertised.allowedEffects, ['read']),
      };
      break;
    case 'invocation':
      result = {
        kind: 'invocation',
        allowedEffects: effectIntersection(advertised.allowedEffects, ['read']),
      };
      break;
    case 'usage':
      result = { kind: 'usage', scopes: stringIntersection(advertised.scopes, advertised.scopes) };
      break;
    case 'cost':
      result = {
        kind: 'cost',
        scopes: stringIntersection(advertised.scopes, advertised.scopes),
        currencies: stringIntersection(advertised.currencies, advertised.currencies),
        acceptsEstimates: false,
      };
      break;
    case 'catalog':
      result = { kind: 'catalog', pageSize: Math.min(advertised.pageSize, 50) };
      break;
    case 'mcp_server': {
      const transports = stringIntersection(advertised.transports, ['stdio', 'streamable_http']);
      if (id === 'integration.mcp.server.connect') {
        const connect = advertised as McpConnectConstraints;
        result = {
          kind: 'mcp_server',
          transports,
          actions: stringIntersection(connect.actions, ['connect']),
        };
      } else if (id === 'integration.mcp.server.configure') {
        const configure = advertised as McpConfigureConstraints;
        result = {
          kind: 'mcp_server',
          transports,
          actions: stringIntersection(configure.actions, ['disable']),
        };
      } else {
        result = { kind: 'mcp_server', transports };
      }
      break;
    }
    case 'component_manage':
      result = {
        kind: 'component_manage',
        actions: stringIntersection(advertised.actions, ['disable']),
      };
      break;
    case 'attachment':
      result = {
        kind: 'attachment',
        mimeTypes: stringIntersection(advertised.mimeTypes, advertised.mimeTypes),
        maxBytes: Math.min(advertised.maxBytes, MAX_ATTACHMENT_BYTES),
      };
      break;
    case 'structured_output':
      result = {
        kind: 'structured_output',
        maxSchemaBytes: Math.min(advertised.maxSchemaBytes, 64 * 1024),
        maxSchemaDepth: Math.min(advertised.maxSchemaDepth, 16),
        maxSchemaNodes: Math.min(advertised.maxSchemaNodes, 1_024),
      };
      break;
    case 'worktree':
      result = {
        kind: 'worktree',
        rootHandles:
          selectedWorkspaceRootHandle &&
          advertised.rootHandles.includes(selectedWorkspaceRootHandle)
            ? [selectedWorkspaceRootHandle]
            : [],
      };
      break;
    case 'filesystem_isolation':
      result = {
        kind: 'filesystem_isolation',
        rootHandles:
          selectedWorkspaceRootHandle &&
          advertised.rootHandles.includes(selectedWorkspaceRootHandle)
            ? [selectedWorkspaceRootHandle]
            : [],
      };
      break;
    case 'network_isolation':
      result = { kind: 'network_isolation', destinations: [] };
      break;
    case 'none':
      result = { kind: 'none' };
      break;
    default: {
      const exhaustive: never = advertised;
      throw new Error(`unsupported constraint kind: ${String(exhaustive)}`);
    }
  }
  return cloneJson(result) as CapabilityConstraintById[I];
}

function intersectCoreConstraints(
  id: CoreCapabilityId,
  advertised: CapabilityConstraints,
  requested: CapabilityConstraints,
): CapabilityConstraints | null {
  if (advertised.kind !== requested.kind) return null;
  switch (advertised.kind) {
    case 'text_input': {
      const right = requested as TextInputConstraints;
      return {
        kind: 'text_input',
        maxCharacters: Math.min(advertised.maxCharacters, right.maxCharacters),
        attachmentKinds: stringIntersection(advertised.attachmentKinds, right.attachmentKinds),
      };
    }
    case 'acknowledgement':
      return {
        kind: 'acknowledgement',
        timeoutMs: Math.min(
          advertised.timeoutMs,
          (requested as AcknowledgementConstraints).timeoutMs,
        ),
      };
    case 'continuation':
      return (requested as ContinuationConstraints).native
        ? { kind: 'continuation', native: true }
        : null;
    case 'interaction': {
      const right = requested as InteractionConstraints;
      return {
        kind: 'interaction',
        timeoutMs: Math.min(advertised.timeoutMs, right.timeoutMs),
        maxPayloadBytes: Math.min(advertised.maxPayloadBytes, right.maxPayloadBytes),
      };
    }
    case 'content': {
      const right = requested as ContentConstraints;
      return {
        kind: 'content',
        maxBlockBytes: Math.min(advertised.maxBlockBytes, right.maxBlockBytes),
        persistence: lessRevealingPersistence(advertised.persistence, right.persistence),
      };
    }
    case 'effects':
      return {
        kind: 'effects',
        allowedEffects: effectIntersection(
          advertised.allowedEffects,
          (requested as EffectConstraints).allowedEffects,
        ),
      };
    case 'invocation':
      return {
        kind: 'invocation',
        allowedEffects: effectIntersection(
          advertised.allowedEffects,
          (requested as InvocationConstraints).allowedEffects,
        ),
      };
    case 'usage':
      return {
        kind: 'usage',
        scopes: stringIntersection(advertised.scopes, (requested as UsageConstraints).scopes),
      };
    case 'cost': {
      const right = requested as CostConstraints;
      return {
        kind: 'cost',
        scopes: stringIntersection(advertised.scopes, right.scopes),
        currencies: stringIntersection(advertised.currencies, right.currencies),
        acceptsEstimates: advertised.acceptsEstimates && right.acceptsEstimates,
      };
    }
    case 'catalog':
      return {
        kind: 'catalog',
        pageSize: Math.min(advertised.pageSize, (requested as CatalogConstraints).pageSize),
      };
    case 'mcp_server': {
      const right = requested as McpServerConstraints;
      const transports = stringIntersection(advertised.transports, right.transports);
      if (id === 'integration.mcp.server.connect') {
        return {
          kind: 'mcp_server',
          transports,
          actions: stringIntersection(
            (advertised as McpConnectConstraints).actions,
            (requested as McpConnectConstraints).actions,
          ),
        };
      }
      if (id === 'integration.mcp.server.configure') {
        return {
          kind: 'mcp_server',
          transports,
          actions: stringIntersection(
            (advertised as McpConfigureConstraints).actions,
            (requested as McpConfigureConstraints).actions,
          ),
        };
      }
      return { kind: 'mcp_server', transports };
    }
    case 'component_manage':
      return {
        kind: 'component_manage',
        actions: stringIntersection(
          advertised.actions,
          (requested as ComponentManageConstraints).actions,
        ),
      };
    case 'attachment': {
      const right = requested as AttachmentConstraints;
      return {
        kind: 'attachment',
        mimeTypes: stringIntersection(advertised.mimeTypes, right.mimeTypes),
        maxBytes: Math.min(advertised.maxBytes, right.maxBytes),
      };
    }
    case 'structured_output': {
      const right = requested as StructuredOutputConstraints;
      return {
        kind: 'structured_output',
        maxSchemaBytes: Math.min(advertised.maxSchemaBytes, right.maxSchemaBytes),
        maxSchemaDepth: Math.min(advertised.maxSchemaDepth, right.maxSchemaDepth),
        maxSchemaNodes: Math.min(advertised.maxSchemaNodes, right.maxSchemaNodes),
      };
    }
    case 'worktree':
      return {
        kind: 'worktree',
        rootHandles: stringIntersection(
          advertised.rootHandles,
          (requested as WorktreeConstraints).rootHandles,
        ),
      };
    case 'filesystem_isolation':
      return {
        kind: 'filesystem_isolation',
        rootHandles: stringIntersection(
          advertised.rootHandles,
          (requested as FilesystemIsolationConstraints).rootHandles,
        ),
      };
    case 'network_isolation':
      return {
        kind: 'network_isolation',
        destinations: destinationIntersection(
          advertised.destinations,
          (requested as NetworkIsolationConstraints).destinations,
        ),
      };
    case 'none':
      return { kind: 'none' };
  }
}

function constraintsRemainAvailable(id: string, constraints: WireCapabilityConstraints): boolean {
  switch (constraints.kind) {
    case 'effects':
    case 'invocation':
      return constraints.allowedEffects.length > 0;
    case 'usage':
      return constraints.scopes.length > 0;
    case 'cost':
      return constraints.scopes.length > 0 && constraints.currencies.length > 0;
    case 'mcp_server':
      return (
        constraints.transports.length > 0 &&
        (!('actions' in constraints) || constraints.actions.length > 0)
      );
    case 'component_manage':
      return constraints.actions.length > 0;
    case 'attachment':
      return constraints.mimeTypes.length > 0;
    case 'worktree':
      return constraints.rootHandles.length > 0;
    case 'opaque':
      return true;
    case 'text_input':
    case 'filesystem_isolation':
    case 'network_isolation':
    case 'none':
    case 'acknowledgement':
    case 'continuation':
    case 'interaction':
    case 'content':
    case 'catalog':
    case 'structured_output':
      return true;
    default:
      return coreCapabilityIdSet.has(id);
  }
}

function versionsMatch(left: CapabilityVersions, right: CapabilityVersions): boolean {
  return (
    left.adapterContract === right.adapterContract &&
    left.transport === right.transport &&
    left.runtime === right.runtime &&
    left.sdk === right.sdk &&
    left.schema === right.schema &&
    left.fixtureSet === right.fixtureSet
  );
}

function recordMatchesRuntime(
  record: CapabilitySupportRecord,
  runtimeScope: CapabilityRuntimeScope,
  transport: string,
): boolean {
  return (
    record.scope.provider === runtimeScope.provider &&
    record.scope.transport === transport &&
    record.scope.platform === runtimeScope.platform &&
    record.scope.trustState === runtimeScope.trustState &&
    (record.scope.model === '*' || record.scope.model === runtimeScope.model) &&
    (record.scope.authMode === '*' || record.scope.authMode === runtimeScope.authMode) &&
    versionsMatch(record.scope.versions, runtimeScope.versions)
  );
}

function pickScopedRecord(
  records: readonly CapabilitySupportRecord[],
  id: string,
  runtimeScope: CapabilityRuntimeScope,
  transport: string,
): { record?: CapabilitySupportRecord; reason?: string } {
  const matches = records.filter(
    (record) => record.id === id && recordMatchesRuntime(record, runtimeScope, transport),
  );
  if (matches.length === 0) return { reason: 'no matching support record' };
  const scored = matches.map((record) => ({
    record,
    score: Number(record.scope.model !== '*') + Number(record.scope.authMode !== '*'),
  }));
  const maximum = Math.max(...scored.map((item) => item.score));
  const mostSpecific = scored.filter((item) => item.score === maximum);
  if (mostSpecific.length !== 1)
    return { reason: 'ambiguous support records at equal specificity' };
  return { record: mostSpecific[0]!.record };
}

function manifestCycle(
  records: readonly CapabilitySupportRecord[],
  runtimeScope: CapabilityRuntimeScope,
  transports: readonly ProviderTransportV2[],
): boolean {
  for (const transport of transports) {
    const ids = new Set(
      records
        .filter((record) => recordMatchesRuntime(record, runtimeScope, transport.id))
        .map((record) => record.id),
    );
    const graph = new Map<string, Set<string>>();
    for (const id of ids) {
      const scoped = pickScopedRecord(records, id, runtimeScope, transport.id);
      if (!scoped.record) continue;
      graph.set(
        id,
        new Set(
          scoped.record.prerequisites.capabilities.filter((prerequisite) => ids.has(prerequisite)),
        ),
      );
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const next of graph.get(id) ?? []) if (visit(next)) return true;
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    if ([...graph.keys()].some(visit)) return true;
  }
  return false;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): Readonly<T> {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value as Readonly<T>;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

type ResolvedCapability = { selected: SelectedCapability; record: CapabilitySupportRecord };
type Resolution = { success: true } | { success: false; reason: string; invalidManifest?: boolean };

function resolveForTransport(
  input: CapabilityNegotiationInput,
  request: CapabilityRequest,
  transport: ProviderTransportV2,
):
  | { success: true; selection: Readonly<CapabilitySelection> }
  | { success: false; required: CapabilityUnavailable[]; invalidManifest?: boolean } {
  const explicitItems = new Map(
    [...request.required, ...request.optional].map((item) => [item.id, item]),
  );
  let enabled = new Map<string, ResolvedCapability>();
  const unavailableOptional: CapabilityUnavailable[] = [];

  const resolve = (
    requestedItem: CapabilityRequestItem,
    target: Map<string, ResolvedCapability>,
    stack: Set<string>,
  ): Resolution => {
    const item = explicitItems.get(requestedItem.id) ?? requestedItem;
    if (target.has(item.id)) return { success: true };
    if (stack.has(item.id))
      return { success: false, reason: 'capability prerequisite cycle', invalidManifest: true };
    const scoped = pickScopedRecord(
      input.supportRecords,
      item.id,
      input.runtimeScope,
      transport.id,
    );
    if (!scoped.record)
      return { success: false, reason: scoped.reason ?? 'capability unavailable' };
    const record = scoped.record;
    if (record.support !== 'supported')
      return { success: false, reason: `support is ${record.support}` };
    if (record.stability === 'deprecated')
      return { success: false, reason: 'deprecated support is not selectable' };
    if (
      record.stability === 'experimental' &&
      !(request.allowExperimental && item.allowExperimental === true)
    ) {
      return { success: false, reason: 'experimental support requires request and item opt-in' };
    }
    if (
      record.prerequisites.trustStates.length > 0 &&
      !record.prerequisites.trustStates.includes(input.runtimeScope.trustState)
    ) {
      return { success: false, reason: 'workspace trust prerequisite is not met' };
    }
    const sessionState = input.sessionState ?? 'starting';
    if (
      record.prerequisites.sessionStates.length > 0 &&
      !record.prerequisites.sessionStates.includes(sessionState)
    ) {
      return { success: false, reason: 'session state prerequisite is not met' };
    }
    const availableServices = new Set(input.services ?? []);
    if (record.prerequisites.services.some((service) => !availableServices.has(service))) {
      return { success: false, reason: 'required AgentDock service is unavailable' };
    }

    const nextStack = new Set(stack).add(item.id);
    for (const prerequisite of sortedStrings(record.prerequisites.capabilities)) {
      const prerequisiteResult = resolve(
        { id: prerequisite, allowExperimental: item.allowExperimental },
        target,
        nextStack,
      );
      if (!prerequisiteResult.success) return prerequisiteResult;
    }

    let constraints: WireCapabilityConstraints | null;
    if (coreCapabilityIdSet.has(item.id)) {
      const id = item.id as CoreCapabilityId;
      const advertised = record.constraints as CapabilityConstraints;
      constraints =
        item.constraints === undefined
          ? defaultConstraintsForCapability(
              id,
              advertised as CapabilityConstraintById[typeof id],
              input.selectedWorkspaceRootHandle,
            )
          : intersectCoreConstraints(id, advertised, item.constraints as CapabilityConstraints);
    } else {
      const handler = input.extensionHandlers?.[item.id];
      if (!handler)
        return {
          success: false,
          reason: 'no fixture-backed extension schema and intersector is installed',
        };
      const advertised = record.constraints as OpaqueCapabilityConstraints;
      const fixtureMatchesRecord = record.evidence.some(
        (evidence) =>
          evidence.kind === 'fixture' && evidence.reference === handler.fixtureReference,
      );
      if (!fixtureMatchesRecord)
        return {
          success: false,
          reason: 'extension handler lacks matching fixture evidence',
          invalidManifest: true,
        };
      let advertisedValid = false;
      try {
        advertisedValid = handler.validate(advertised);
      } catch {
        return {
          success: false,
          reason: 'extension handler failed to validate advertised constraints',
          invalidManifest: true,
        };
      }
      if (!advertisedValid) {
        return {
          success: false,
          reason: 'extension handler rejected advertised constraints',
          invalidManifest: true,
        };
      }
      const requested = item.constraints as OpaqueCapabilityConstraints | undefined;
      if (requested !== undefined) {
        let requestedValid = false;
        try {
          requestedValid = handler.validate(requested);
        } catch {
          return {
            success: false,
            reason: 'extension handler failed to validate requested constraints',
          };
        }
        if (!requestedValid)
          return {
            success: false,
            reason: 'extension handler rejected requested constraints',
          };
      }
      try {
        constraints = handler.intersect(advertised, requested);
      } catch {
        return { success: false, reason: 'extension intersector failed' };
      }
      if (constraints && !opaqueCapabilityConstraintsSchema.safeParse(constraints).success) {
        return {
          success: false,
          reason: 'extension intersector returned invalid constraints',
          invalidManifest: true,
        };
      }
      if (constraints) {
        let resultValid = false;
        try {
          resultValid = handler.validate(constraints);
        } catch {
          return {
            success: false,
            reason: 'extension handler failed to validate intersected constraints',
            invalidManifest: true,
          };
        }
        if (!resultValid)
          return {
            success: false,
            reason: 'extension intersector returned invalid constraints',
            invalidManifest: true,
          };
      }
    }
    if (!constraints || !constraintsRemainAvailable(item.id, constraints)) {
      return { success: false, reason: 'constraint intersection is unavailable' };
    }
    target.set(item.id, { selected: { id: item.id, constraints: cloneJson(constraints) }, record });
    return { success: true };
  };

  const requiredFailures: CapabilityUnavailable[] = [];
  for (const item of [...request.required].sort((left, right) => left.id.localeCompare(right.id))) {
    const result = resolve(item, enabled, new Set());
    if (!result.success) {
      requiredFailures.push({ id: item.id, reason: result.reason });
      if (result.invalidManifest)
        return { success: false, required: requiredFailures, invalidManifest: true };
    }
  }
  if (requiredFailures.length > 0) return { success: false, required: requiredFailures };

  for (const item of [...request.optional].sort((left, right) => left.id.localeCompare(right.id))) {
    const trial = new Map(enabled);
    const result = resolve(item, trial, new Set());
    if (result.success) enabled = trial;
    else {
      if (result.invalidManifest) return { success: false, required: [], invalidManifest: true };
      unavailableOptional.push({ id: item.id, reason: result.reason });
    }
  }

  const effects = new Set<Effect>(transport.possibleEffects);
  let effectsComplete = transport.effectsComplete;
  for (const resolved of enabled.values()) {
    for (const effect of resolved.record.possibleEffects) effects.add(effect);
    effectsComplete = effectsComplete && resolved.record.effectsComplete;
  }
  const selection: CapabilitySelection = {
    transport: transport.id,
    enabled: [...enabled.values()]
      .map((item) => item.selected)
      .sort((left, right) => left.id.localeCompare(right.id)),
    unavailableOptional: unavailableOptional.sort((left, right) => left.id.localeCompare(right.id)),
    possibleEffects: sortedEffects(effects),
    effectsComplete,
  };
  return { success: true, selection: deepFreeze(selection) };
}

/** Deterministic provider-neutral capability negotiation. HTTP maps required failures to status 422. */
export function negotiateCapabilities(
  input: CapabilityNegotiationInput,
): CapabilityNegotiationResult {
  const parsedRequest = capabilityRequestSchema.safeParse(
    input.request ?? DEFAULT_CAPABILITY_REQUEST,
  );
  const parsedRecords = input.supportRecords.map((record) =>
    capabilitySupportRecordSchema.safeParse(record),
  );
  const recordsValid = parsedRecords.every((record) => record.success);
  const normalizedRecords = parsedRecords.flatMap((record) =>
    record.success ? [record.data] : [],
  );
  const transportsValid = input.transports.every(
    (transport) => providerTransportV2Schema.safeParse(transport).success,
  );
  const transportIds = input.transports.map((transport) => transport.id);
  const recordKeys = normalizedRecords.map((record) =>
    JSON.stringify({ id: record.id, scope: record.scope }),
  );
  if (
    !parsedRequest.success ||
    !recordsValid ||
    !transportsValid ||
    new Set(transportIds).size !== transportIds.length ||
    new Set(recordKeys).size !== recordKeys.length ||
    manifestCycle(normalizedRecords, input.runtimeScope, input.transports)
  ) {
    return { success: false, code: 'invalid_manifest', unavailableRequired: [] };
  }
  const request = parsedRequest.data;
  const normalizedInput: CapabilityNegotiationInput = {
    ...input,
    supportRecords: normalizedRecords,
  };
  const eligible = input.transports.filter((transport) => {
    if (transport.stability === 'deprecated') return false;
    if (transport.stability === 'experimental') {
      return request.allowExperimental && request.preferredTransport === transport.id;
    }
    return true;
  });
  const candidates = eligible.map((transport) => ({
    transport,
    result: resolveForTransport(normalizedInput, request, transport),
  }));
  if (
    candidates.some((candidate) => !candidate.result.success && candidate.result.invalidManifest)
  ) {
    return { success: false, code: 'invalid_manifest', unavailableRequired: [] };
  }
  const successful = candidates.filter(
    (
      candidate,
    ): candidate is {
      transport: ProviderTransportV2;
      result: { success: true; selection: Readonly<CapabilitySelection> };
    } => candidate.result.success,
  );
  const preferred = request.preferredTransport
    ? successful.find((candidate) => candidate.transport.id === request.preferredTransport)
    : undefined;
  const chosen =
    preferred ??
    successful.sort(
      (left, right) =>
        left.transport.priority - right.transport.priority ||
        left.transport.id.localeCompare(right.transport.id),
    )[0];
  if (chosen) return { success: true, selection: chosen.result.selection };

  const requiredIds = request.required
    .map((item) => item.id)
    .sort((left, right) => left.localeCompare(right));
  return {
    success: false,
    code: 'required_capability_unavailable',
    unavailableRequired: requiredIds.map((id) => ({
      id,
      reason: 'not supported by any eligible transport',
    })),
  };
}
