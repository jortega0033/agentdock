import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_CATALOG,
  CORE_CAPABILITY_IDS,
  boundedJsonSchema,
  capabilityConstraintSchemaById,
  capabilityRequestSchema,
  capabilitySelectionSchema,
  capabilitySupportRecordSchema,
  providerStatusV2Schema,
  type CapabilityConstraints,
  type CoreCapabilityId,
} from '../src/capabilities-v2.js';

const versions = {
  adapterContract: '2',
  transport: '1.0.0',
  runtime: '20.0.0',
  fixtureSet: 'fixture-v1',
};

function constraintsFor(id: CoreCapabilityId): CapabilityConstraints {
  if (
    id === 'session.input.follow_up' ||
    id === 'session.input.steer' ||
    id === 'agents.subagents.steer'
  ) {
    return { kind: 'text_input', maxCharacters: 200_000, attachmentKinds: ['image', 'file'] };
  }
  if (
    id === 'session.interrupt' ||
    id === 'session.cancel' ||
    id === 'agents.subagents.interrupt' ||
    id === 'agents.subagents.cancel'
  ) {
    return { kind: 'acknowledgement', timeoutMs: 30_000 };
  }
  if (id === 'session.resume' || id === 'session.fork')
    return { kind: 'continuation', native: true };
  if (
    id === 'interaction.approval' ||
    id === 'interaction.question' ||
    id === 'integration.mcp.elicitation.form' ||
    id === 'integration.mcp.elicitation.url'
  ) {
    return { kind: 'interaction', timeoutMs: 300_000, maxPayloadBytes: 32 * 1024 };
  }
  if (
    id === 'content.streaming' ||
    id === 'content.plans' ||
    id === 'content.thinking' ||
    id === 'content.artifacts' ||
    id === 'integration.hooks.observe' ||
    id === 'agents.subagents.observe'
  ) {
    return { kind: 'content', maxBlockBytes: 256 * 1024, persistence: 'live_only' };
  }
  if (id === 'content.tools' || id === 'integration.mcp.tool.invoke') {
    return { kind: 'effects', allowedEffects: ['read', 'filesystem_write'] };
  }
  if (id === 'content.usage.tokens') return { kind: 'usage', scopes: ['turn', 'session'] };
  if (id === 'content.usage.cost') {
    return {
      kind: 'cost',
      scopes: ['turn', 'session'],
      currencies: ['EUR', 'USD'],
      acceptsEstimates: true,
    };
  }
  if (id === 'integration.mcp.server.inspect') {
    return { kind: 'mcp_server', transports: ['stdio', 'streamable_http'] };
  }
  if (id === 'integration.mcp.server.connect') {
    return {
      kind: 'mcp_server',
      transports: ['stdio', 'streamable_http'],
      actions: ['connect', 'reconnect'],
    };
  }
  if (id === 'integration.mcp.server.configure') {
    return {
      kind: 'mcp_server',
      transports: ['stdio', 'streamable_http'],
      actions: ['add', 'edit', 'enable', 'disable', 'remove'],
    };
  }
  if (
    id === 'model.catalog' ||
    id.startsWith('integration.mcp.catalog.') ||
    id.endsWith('.inspect')
  )
    return { kind: 'catalog', pageSize: 100 };
  if (
    id === 'integration.mcp.server.disconnect' ||
    id === 'integration.mcp.server.reload' ||
    id === 'integration.mcp.oauth'
  )
    return { kind: 'none' };
  if (id.endsWith('.manage')) return { kind: 'component_manage', actions: ['enable', 'disable'] };
  if (id.endsWith('.invoke')) return { kind: 'invocation', allowedEffects: ['read', 'command'] };
  if (id === 'input.image' || id === 'input.file') {
    return {
      kind: 'attachment',
      mimeTypes: ['image/png', 'text/plain'],
      maxBytes: 25 * 1024 * 1024,
    };
  }
  if (id === 'output.structured') {
    return {
      kind: 'structured_output',
      maxSchemaBytes: 64 * 1024,
      maxSchemaDepth: 16,
      maxSchemaNodes: 1_024,
    };
  }
  if (id === 'workspace.worktrees') return { kind: 'worktree', rootHandles: ['root-1'] };
  if (id.startsWith('isolation.filesystem.'))
    return { kind: 'filesystem_isolation', rootHandles: ['root-1'] };
  if (id === 'isolation.network.restricted') {
    return {
      kind: 'network_isolation',
      destinations: [{ host: 'api.example.com', protocol: 'tcp', port: 443 }],
    };
  }
  throw new Error(`missing test constraints for ${id}`);
}

function supportRecord(id: CoreCapabilityId, overrides: Record<string, unknown> = {}) {
  return {
    id,
    ...CAPABILITY_CATALOG[id],
    support: 'supported',
    stability: 'stable',
    evidence: [{ kind: 'fixture', reference: `fixtures/${id}.json` }],
    scope: {
      provider: 'claude',
      transport: 'cli',
      platform: 'linux',
      model: '*',
      authMode: '*',
      trustState: 'untrusted',
      versions,
    },
    prerequisites: { capabilities: [], trustStates: [], sessionStates: [], services: [] },
    possibleEffects: [],
    effectsComplete: true,
    constraints: constraintsFor(id),
    ...overrides,
  };
}

describe('protocol v2 capability schemas', () => {
  it('contains exactly the 52 documented core ID-to-constraint pairs', () => {
    expect(CORE_CAPABILITY_IDS).toHaveLength(52);
    expect(new Set(CORE_CAPABILITY_IDS).size).toBe(52);
    expect(Object.keys(capabilityConstraintSchemaById).sort()).toEqual(
      [...CORE_CAPABILITY_IDS].sort(),
    );

    for (const id of CORE_CAPABILITY_IDS) {
      const result = capabilitySupportRecordSchema.safeParse(supportRecord(id));
      expect(result.success, `${id}: ${result.success ? '' : result.error.message}`).toBe(true);
    }
  });

  it('rejects opaque constraints and catalog kind/owner redefinitions for every core ID', () => {
    for (const id of CORE_CAPABILITY_IDS) {
      expect(
        capabilitySupportRecordSchema.safeParse(
          supportRecord(id, {
            constraints: { kind: 'opaque', value: null },
          }),
        ).success,
        id,
      ).toBe(false);
      expect(
        capabilitySupportRecordSchema.safeParse(
          supportRecord(id, {
            kind: CAPABILITY_CATALOG[id].kind === 'operation' ? 'observation' : 'operation',
          }),
        ).success,
        id,
      ).toBe(false);
      expect(
        capabilitySupportRecordSchema.safeParse(
          supportRecord(id, {
            owner: CAPABILITY_CATALOG[id].owner === 'provider' ? 'agentdock' : 'provider',
          }),
        ).success,
        id,
      ).toBe(false);
    }
  });

  it('preserves an unknown capability only through bounded opaque constraints', () => {
    const unknown = {
      ...supportRecord('session.cancel'),
      id: 'ext.example.future',
      kind: 'observation',
      owner: 'provider',
      constraints: { kind: 'opaque', value: { feature: ['a', true, 2] } },
    };
    const parsed = capabilitySupportRecordSchema.parse(unknown);
    expect(parsed).toEqual(unknown);
    expect(
      capabilitySupportRecordSchema.safeParse({
        ...unknown,
        constraints: { kind: 'content', maxBlockBytes: 1, persistence: 'live_only' },
      }).success,
    ).toBe(false);
  });

  it('reserves core namespaces and requires ext namespace and feature segments for unknown IDs', () => {
    for (const id of ['future.feature', 'ext.namespace']) {
      expect(
        capabilitySupportRecordSchema.safeParse({
          ...supportRecord('session.cancel'),
          id,
          kind: 'observation',
          owner: 'provider',
          constraints: { kind: 'opaque', value: null },
        }).success,
        id,
      ).toBe(false);
    }
    expect(
      capabilitySupportRecordSchema.safeParse({
        ...supportRecord('session.cancel'),
        id: 'session.future',
        kind: 'observation',
        owner: 'provider',
        constraints: { kind: 'opaque', value: null },
      }).success,
    ).toBe(true);
    expect(
      capabilityRequestSchema.safeParse({
        required: [{ id: 'ext.example.feature' }],
        optional: [],
        allowExperimental: false,
      }).success,
    ).toBe(true);
  });

  it('requires fixture or host-verified evidence before support can be advertised', () => {
    expect(
      capabilitySupportRecordSchema.safeParse(
        supportRecord('session.cancel', {
          evidence: [{ kind: 'vendor_declared', reference: 'vendor-page' }],
        }),
      ).success,
    ).toBe(false);
    expect(
      capabilitySupportRecordSchema.safeParse(
        supportRecord('session.cancel', {
          evidence: [{ kind: 'runtime_report', reference: 'runtime' }],
        }),
      ).success,
    ).toBe(false);
    expect(
      capabilitySupportRecordSchema.safeParse(
        supportRecord('session.cancel', {
          evidence: [{ kind: 'host_verified', reference: 'probe' }],
        }),
      ).success,
    ).toBe(true);
  });

  it('uses strict wire objects instead of silently stripping executable fields', () => {
    expect(
      capabilitySupportRecordSchema.safeParse({
        ...supportRecord('session.cancel'),
        surprise: true,
      }).success,
    ).toBe(false);
    expect(
      capabilityRequestSchema.safeParse({
        required: [],
        optional: [],
        allowExperimental: false,
        surprise: true,
      }).success,
    ).toBe(false);
    expect(
      capabilityRequestSchema.safeParse({
        required: [
          {
            id: 'content.tools',
            constraints: { kind: 'effects', allowedEffects: ['read'], extra: true },
          },
        ],
        optional: [],
        allowExperimental: false,
      }).success,
    ).toBe(false);
  });

  it('rejects non-JSON, cyclic, over-depth, over-item, over-string, and over-byte opaque values', () => {
    expect(boundedJsonSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(boundedJsonSchema.safeParse(new Date()).success).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(boundedJsonSchema.safeParse(cyclic).success).toBe(false);
    const shared = { value: 1 };
    expect(boundedJsonSchema.safeParse({ left: shared, right: shared }).success).toBe(true);

    let deep: unknown = null;
    for (let index = 0; index < 17; index += 1) deep = { child: deep };
    expect(boundedJsonSchema.safeParse(deep).success).toBe(false);
    expect(
      boundedJsonSchema.safeParse(
        Object.fromEntries(Array.from({ length: 1_025 }, (_, index) => [`k${index}`, null])),
      ).success,
    ).toBe(false);
    expect(boundedJsonSchema.safeParse('€'.repeat(86)).success).toBe(false);
    expect(
      boundedJsonSchema.safeParse(Array.from({ length: 300 }, () => 'x'.repeat(250))).success,
    ).toBe(false);
  });

  it('rejects duplicate request IDs and malformed provider/transport scope links', () => {
    expect(
      capabilityRequestSchema.safeParse({
        required: [{ id: 'session.cancel' }],
        optional: [{ id: 'session.cancel' }],
        allowExperimental: false,
      }).success,
    ).toBe(false);

    const status = {
      id: 'claude',
      name: 'Claude',
      installed: true,
      authenticated: 'authenticated',
      transports: [
        { id: 'cli', priority: 0, stability: 'stable', possibleEffects: [], effectsComplete: true },
      ],
      capabilities: [supportRecord('session.cancel')],
      sandbox: {
        providerId: 'claude',
        platform: 'win32',
        provider: { mechanism: 'provider_policy', state: 'unknown', evidence: [] },
        agentDock: { mechanism: 'agentdock_policy', state: 'not_requested', evidence: [] },
        os: { mechanism: 'os_sandbox', state: 'unavailable', evidence: [] },
        badge: 'none',
      },
    };
    expect(providerStatusV2Schema.safeParse(status).success).toBe(true);
    expect(
      providerStatusV2Schema.safeParse({
        ...status,
        capabilities: [supportRecord('session.cancel'), supportRecord('session.cancel')],
      }).success,
    ).toBe(false);
    expect(
      providerStatusV2Schema.safeParse({
        ...status,
        capabilities: [
          supportRecord('session.cancel', {
            scope: { ...supportRecord('session.cancel').scope, transport: 'missing' },
          }),
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate and contradictory capability selection IDs', () => {
    const enabled = {
      id: 'session.cancel',
      constraints: { kind: 'acknowledgement', timeoutMs: 30_000 },
    };
    const selection = {
      transport: 'cli',
      enabled: [enabled],
      unavailableOptional: [{ id: 'content.tools', reason: 'not supported' }],
      possibleEffects: [],
      effectsComplete: true,
    };

    expect(
      capabilitySelectionSchema.safeParse({ ...selection, enabled: [enabled, enabled] }).success,
    ).toBe(false);
    expect(
      capabilitySelectionSchema.safeParse({
        ...selection,
        unavailableOptional: [
          { id: 'content.tools', reason: 'not supported' },
          { id: 'content.tools', reason: 'still not supported' },
        ],
      }).success,
    ).toBe(false);
    expect(
      capabilitySelectionSchema.safeParse({
        ...selection,
        unavailableOptional: [{ id: 'session.cancel', reason: 'contradiction' }],
      }).success,
    ).toBe(false);
    expect(capabilitySelectionSchema.safeParse(selection).success).toBe(true);
  });
});
