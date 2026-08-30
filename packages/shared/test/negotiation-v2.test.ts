import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_CATALOG,
  DEFAULT_CAPABILITY_REQUEST,
  defaultConstraintsForCapability,
  negotiateCapabilities,
  type CapabilityRequest,
  type CapabilityRuntimeScope,
  type CapabilitySupportRecord,
  type CoreCapabilityId,
  type ProviderTransportV2,
  type WireCapabilityConstraints,
} from '../src/capabilities-v2.js';

const versions = {
  adapterContract: '2',
  transport: '1.0.0',
  runtime: '20.0.0',
  fixtureSet: 'fixture-v1',
};
const runtimeScope: CapabilityRuntimeScope = {
  provider: 'claude',
  platform: 'linux',
  model: 'model-a',
  authMode: 'subscription',
  trustState: 'untrusted',
  versions,
};
const stableTransport: ProviderTransportV2 = {
  id: 'cli',
  priority: 0,
  stability: 'stable',
  possibleEffects: [],
  effectsComplete: true,
};

function record(
  id: CoreCapabilityId,
  constraints: WireCapabilityConstraints,
  options: {
    transport?: string;
    stability?: 'stable' | 'experimental' | 'deprecated';
    prerequisites?: string[];
    possibleEffects?: Array<
      'read' | 'filesystem_write' | 'command' | 'network' | 'external_side_effect' | 'destructive'
    >;
    effectsComplete?: boolean;
  } = {},
) {
  return {
    id,
    ...CAPABILITY_CATALOG[id],
    support: 'supported' as const,
    stability: options.stability ?? 'stable',
    evidence: [{ kind: 'fixture' as const, reference: `fixtures/${id}.json` }],
    scope: {
      provider: 'claude',
      transport: options.transport ?? 'cli',
      platform: 'linux' as const,
      model: '*',
      authMode: '*',
      trustState: 'untrusted' as const,
      versions,
    },
    prerequisites: {
      capabilities: options.prerequisites ?? [],
      trustStates: [],
      sessionStates: [],
      services: [],
    },
    possibleEffects: options.possibleEffects ?? [],
    effectsComplete: options.effectsComplete ?? true,
    constraints,
  };
}

function request(
  required: CapabilityRequest['required'],
  optional: CapabilityRequest['optional'] = [],
): CapabilityRequest {
  return { required, optional, allowExperimental: false };
}

describe('protocol v2 capability negotiation', () => {
  it('distinguishes an absent default request from an explicitly empty request', () => {
    const cancellation = record('session.cancel', { kind: 'acknowledgement', timeoutMs: 30_000 });
    const defaultResult = negotiateCapabilities({
      runtimeScope,
      supportRecords: [cancellation],
      transports: [stableTransport],
    });
    expect(DEFAULT_CAPABILITY_REQUEST.required).toEqual([{ id: 'session.cancel' }]);
    expect(defaultResult.success).toBe(true);
    if (defaultResult.success) {
      expect(defaultResult.selection.enabled.map((item) => item.id)).toEqual(['session.cancel']);
      expect(defaultResult.selection.unavailableOptional.map((item) => item.id)).toEqual([
        'content.thinking',
        'content.tools',
        'content.usage.cost',
        'content.usage.tokens',
      ]);
    }

    const emptyResult = negotiateCapabilities({
      request: request([]),
      runtimeScope,
      supportRecords: [cancellation],
      transports: [stableTransport],
    });
    expect(emptyResult.success).toBe(true);
    if (emptyResult.success) expect(emptyResult.selection.enabled).toEqual([]);
  });

  it('applies canonical defaults and typed intersections without mutating inputs', () => {
    const advertised = { kind: 'effects' as const, allowedEffects: ['read', 'command'] as const };
    expect(
      defaultConstraintsForCapability('content.tools', {
        kind: 'effects',
        allowedEffects: [...advertised.allowedEffects],
      }),
    ).toEqual({ kind: 'effects', allowedEffects: ['read'] });

    const support = record('content.tools', {
      kind: 'effects',
      allowedEffects: [...advertised.allowedEffects],
    });
    const requested: CapabilityRequest = request([
      {
        id: 'content.tools',
        constraints: { kind: 'effects', allowedEffects: ['network', 'command'] },
      },
    ]);
    const before = JSON.stringify({ support, requested });
    const result = negotiateCapabilities({
      request: requested,
      runtimeScope,
      supportRecords: [support],
      transports: [stableTransport],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.selection.enabled[0]?.constraints).toEqual({
        kind: 'effects',
        allowedEffects: ['command'],
      });
    }
    expect(JSON.stringify({ support, requested })).toBe(before);
  });

  it('implements the documented restrictive-empty versus unavailable-empty table', () => {
    const cases = [
      {
        id: 'content.tools' as const,
        advertised: { kind: 'effects' as const, allowedEffects: ['read' as const] },
        requested: { kind: 'effects' as const, allowedEffects: ['network' as const] },
        success: false,
      },
      {
        id: 'isolation.filesystem.read_only' as const,
        advertised: { kind: 'filesystem_isolation' as const, rootHandles: ['root-a'] },
        requested: { kind: 'filesystem_isolation' as const, rootHandles: ['root-b'] },
        success: true,
      },
      {
        id: 'isolation.network.restricted' as const,
        advertised: { kind: 'network_isolation' as const, destinations: [] },
        requested: { kind: 'network_isolation' as const, destinations: [] },
        success: true,
      },
      {
        id: 'workspace.worktrees' as const,
        advertised: { kind: 'worktree' as const, rootHandles: ['root-a'] },
        requested: { kind: 'worktree' as const, rootHandles: ['root-b'] },
        success: false,
      },
    ];
    for (const item of cases) {
      const result = negotiateCapabilities({
        request: request([{ id: item.id, constraints: item.requested }]),
        runtimeScope,
        supportRecords: [record(item.id, item.advertised)],
        transports: [stableTransport],
      });
      expect(result.success, item.id).toBe(item.success);
    }
  });

  it('expands prerequisites and rejects manifest cycles', () => {
    const cancellation = record('session.cancel', { kind: 'acknowledgement', timeoutMs: 30_000 });
    const tools = record(
      'content.tools',
      { kind: 'effects', allowedEffects: ['read'] },
      {
        prerequisites: ['session.cancel'],
      },
    );
    const result = negotiateCapabilities({
      request: request([{ id: 'content.tools' }]),
      runtimeScope,
      supportRecords: [tools, cancellation],
      transports: [stableTransport],
    });
    expect(result.success).toBe(true);
    if (result.success)
      expect(result.selection.enabled.map((item) => item.id)).toEqual([
        'content.tools',
        'session.cancel',
      ]);

    const cycle = negotiateCapabilities({
      request: request([{ id: 'content.tools' }]),
      runtimeScope,
      supportRecords: [
        record(
          'content.tools',
          { kind: 'effects', allowedEffects: ['read'] },
          { prerequisites: ['session.cancel'] },
        ),
        record(
          'session.cancel',
          { kind: 'acknowledgement', timeoutMs: 30_000 },
          { prerequisites: ['content.tools'] },
        ),
      ],
      transports: [stableTransport],
    });
    expect(cycle).toMatchObject({ success: false, code: 'invalid_manifest' });
  });

  it('does not manufacture prerequisite cycles across transports', () => {
    const rpcTransport = { ...stableTransport, id: 'rpc', priority: 1 };
    const result = negotiateCapabilities({
      request: request([{ id: 'content.tools' }]),
      runtimeScope,
      supportRecords: [
        record(
          'content.tools',
          { kind: 'effects', allowedEffects: ['read'] },
          { transport: 'cli', prerequisites: ['session.cancel'] },
        ),
        record(
          'session.cancel',
          { kind: 'acknowledgement', timeoutMs: 30_000 },
          { transport: 'cli' },
        ),
        record(
          'content.tools',
          { kind: 'effects', allowedEffects: ['read'] },
          { transport: 'rpc' },
        ),
        record(
          'session.cancel',
          { kind: 'acknowledgement', timeoutMs: 30_000 },
          { transport: 'rpc', prerequisites: ['content.tools'] },
        ),
      ],
      transports: [stableTransport, rpcTransport],
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.selection.transport).toBe('cli');
  });

  it('does not manufacture prerequisite cycles across runtime scopes', () => {
    const withModel = (support: CapabilitySupportRecord, model: string) => ({
      ...support,
      scope: { ...support.scope, model },
    });
    const result = negotiateCapabilities({
      request: request([{ id: 'content.tools' }]),
      runtimeScope,
      supportRecords: [
        withModel(
          record(
            'content.tools',
            { kind: 'effects', allowedEffects: ['read'] },
            { prerequisites: ['session.cancel'] },
          ),
          'model-a',
        ),
        withModel(
          record('session.cancel', { kind: 'acknowledgement', timeoutMs: 30_000 }),
          'model-a',
        ),
        withModel(
          record('content.tools', { kind: 'effects', allowedEffects: ['read'] }),
          'model-b',
        ),
        withModel(
          record(
            'session.cancel',
            { kind: 'acknowledgement', timeoutMs: 30_000 },
            { prerequisites: ['content.tools'] },
          ),
          'model-b',
        ),
      ],
      transports: [stableTransport],
    });

    expect(result.success).toBe(true);
  });

  it('requires both request-level and per-item experimental opt-in', () => {
    const experimental = record(
      'content.tools',
      { kind: 'effects', allowedEffects: ['read'] },
      { stability: 'experimental' },
    );
    for (const [global, item, success] of [
      [false, false, false],
      [true, false, false],
      [false, true, false],
      [true, true, true],
    ] as const) {
      const result = negotiateCapabilities({
        request: {
          required: [{ id: 'content.tools', allowExperimental: item }],
          optional: [],
          allowExperimental: global,
        },
        runtimeScope,
        supportRecords: [experimental],
        transports: [stableTransport],
      });
      expect(result.success, `${global}/${item}`).toBe(success);
    }
  });

  it('selects preferred transport, otherwise priority then lexical ID, and never implies experimental transport', () => {
    const transports: ProviderTransportV2[] = [
      { ...stableTransport, id: 'zeta', priority: 1 },
      { ...stableTransport, id: 'alpha', priority: 1 },
      { ...stableTransport, id: 'experimental', priority: 0, stability: 'experimental' },
    ];
    const records = transports.map((transport) =>
      record(
        'session.cancel',
        { kind: 'acknowledgement', timeoutMs: 30_000 },
        { transport: transport.id },
      ),
    );
    const base = { required: [{ id: 'session.cancel' }], optional: [], allowExperimental: false };
    const lexical = negotiateCapabilities({
      request: base,
      runtimeScope,
      supportRecords: records,
      transports,
    });
    expect(lexical.success && lexical.selection.transport).toBe('alpha');
    const preferred = negotiateCapabilities({
      request: { ...base, preferredTransport: 'zeta' },
      runtimeScope,
      supportRecords: records,
      transports,
    });
    expect(preferred.success && preferred.selection.transport).toBe('zeta');
    const optedTransport = negotiateCapabilities({
      request: { ...base, preferredTransport: 'experimental', allowExperimental: true },
      runtimeScope,
      supportRecords: records,
      transports,
    });
    expect(optedTransport.success && optedTransport.selection.transport).toBe('experimental');
  });

  it('rejects duplicate id/scope records regardless of raw property insertion order', () => {
    const first = record('session.cancel', { kind: 'acknowledgement', timeoutMs: 30_000 });
    const duplicate = {
      ...first,
      scope: {
        versions: first.scope.versions,
        trustState: first.scope.trustState,
        authMode: first.scope.authMode,
        model: first.scope.model,
        platform: first.scope.platform,
        transport: first.scope.transport,
        provider: first.scope.provider,
      },
    };
    expect(
      negotiateCapabilities({
        request: request([]),
        runtimeScope,
        supportRecords: [first, duplicate],
        transports: [stableTransport],
      }),
    ).toMatchObject({ success: false, code: 'invalid_manifest' });
  });

  it('returns deterministic, deeply frozen selections and conservative effects', () => {
    const support = record(
      'content.tools',
      { kind: 'effects', allowedEffects: ['read'] },
      {
        possibleEffects: ['command', 'read'],
        effectsComplete: false,
      },
    );
    const result = negotiateCapabilities({
      request: request([{ id: 'content.tools' }]),
      runtimeScope,
      supportRecords: [support],
      transports: [{ ...stableTransport, possibleEffects: ['network'] }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.selection.possibleEffects).toEqual(['read', 'command', 'network']);
      expect(result.selection.effectsComplete).toBe(false);
      expect(Object.isFrozen(result.selection)).toBe(true);
      expect(Object.isFrozen(result.selection.enabled)).toBe(true);
      expect(Object.isFrozen(result.selection.enabled[0])).toBe(true);
      expect(Object.isFrozen(result.selection.enabled[0]?.constraints)).toBe(true);
    }
  });

  it('selects opaque extensions only through an intersector backed by matching fixture evidence', () => {
    const extensionRecord = {
      ...record('session.cancel', { kind: 'acknowledgement', timeoutMs: 30_000 }),
      id: 'ext.example.feature',
      kind: 'observation',
      owner: 'provider',
      evidence: [{ kind: 'fixture', reference: 'fixtures/ext-example.json' }],
      constraints: { kind: 'opaque', value: { mode: 'safe' } },
    } as unknown as CapabilitySupportRecord;
    const extensionRequest = request([{ id: 'ext.example.feature' }]);
    const matching = negotiateCapabilities({
      request: extensionRequest,
      runtimeScope,
      supportRecords: [extensionRecord],
      transports: [stableTransport],
      extensionHandlers: {
        'ext.example.feature': {
          fixtureReference: 'fixtures/ext-example.json',
          validate: () => true,
          intersect: (advertised) => advertised,
        },
      },
    });
    expect(matching.success).toBe(true);

    const mismatched = negotiateCapabilities({
      request: extensionRequest,
      runtimeScope,
      supportRecords: [extensionRecord],
      transports: [stableTransport],
      extensionHandlers: {
        'ext.example.feature': {
          fixtureReference: 'fixtures/other.json',
          validate: () => true,
          intersect: (advertised) => advertised,
        },
      },
    });
    expect(mismatched).toMatchObject({ success: false, code: 'invalid_manifest' });
  });

  it('validates requested opaque constraints before intersection', () => {
    const extensionRecord = {
      ...record('session.cancel', { kind: 'acknowledgement', timeoutMs: 30_000 }),
      id: 'ext.example.feature',
      kind: 'observation',
      owner: 'provider',
      evidence: [{ kind: 'fixture', reference: 'fixtures/ext-example.json' }],
      constraints: { kind: 'opaque', value: { mode: 'safe' } },
    } as unknown as CapabilitySupportRecord;
    let intersectCalled = false;
    const result = negotiateCapabilities({
      request: request([
        { id: 'ext.example.feature', constraints: { kind: 'opaque', value: { mode: 'unsafe' } } },
      ]),
      runtimeScope,
      supportRecords: [extensionRecord],
      transports: [stableTransport],
      extensionHandlers: {
        'ext.example.feature': {
          fixtureReference: 'fixtures/ext-example.json',
          validate: (constraints) => (constraints.value as { mode?: string }).mode === 'safe',
          intersect: (advertised) => {
            intersectCalled = true;
            return advertised;
          },
        },
      },
    });

    expect(result).toMatchObject({ success: false, code: 'required_capability_unavailable' });
    expect(intersectCalled).toBe(false);
  });

  it('contains extension handler exceptions and classifies manifest versus availability failures', () => {
    const extensionRecord = {
      ...record('session.cancel', { kind: 'acknowledgement', timeoutMs: 30_000 }),
      id: 'ext.example.feature',
      kind: 'observation',
      owner: 'provider',
      evidence: [{ kind: 'fixture', reference: 'fixtures/ext-example.json' }],
      constraints: { kind: 'opaque', value: { mode: 'safe' } },
    } as unknown as CapabilitySupportRecord;
    const extensionRequest = request([
      { id: 'ext.example.feature', constraints: { kind: 'opaque', value: { mode: 'safe' } } },
    ]);
    const negotiate = (
      validate: (constraints: { kind: 'opaque'; value: unknown }) => boolean,
      intersect: () => { kind: 'opaque'; value: null } | never,
    ) =>
      negotiateCapabilities({
        request: extensionRequest,
        runtimeScope,
        supportRecords: [extensionRecord],
        transports: [stableTransport],
        extensionHandlers: {
          'ext.example.feature': {
            fixtureReference: 'fixtures/ext-example.json',
            validate,
            intersect,
          },
        },
      });

    expect(
      negotiate(
        () => {
          throw new Error('advertised validation failed');
        },
        () => ({ kind: 'opaque', value: null }),
      ),
    ).toMatchObject({ success: false, code: 'invalid_manifest' });

    expect(
      negotiate(
        () => true,
        () => {
          throw new Error('intersection failed');
        },
      ),
    ).toMatchObject({ success: false, code: 'required_capability_unavailable' });

    let requestedValidationCalls = 0;
    expect(
      negotiate(
        () => {
          requestedValidationCalls += 1;
          if (requestedValidationCalls === 2) throw new Error('requested validation failed');
          return true;
        },
        () => ({ kind: 'opaque', value: null }),
      ),
    ).toMatchObject({ success: false, code: 'required_capability_unavailable' });

    let validationCalls = 0;
    expect(
      negotiate(
        () => {
          validationCalls += 1;
          if (validationCalls === 3) throw new Error('result validation failed');
          return true;
        },
        () => ({ kind: 'opaque', value: null }),
      ),
    ).toMatchObject({ success: false, code: 'invalid_manifest' });
  });
});
