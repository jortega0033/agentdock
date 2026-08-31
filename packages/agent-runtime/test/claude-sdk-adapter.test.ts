import { PassThrough } from 'node:stream';
import { resolve } from 'node:path';
import type { CapabilitySelection, ProviderStatus } from '@agent-dock/shared';
import { describe, expect, it, vi } from 'vitest';
import type { InteractiveProviderTransport, StartInteractiveSessionOptions } from '../src/types.js';
import {
  buildClaudeSdkVersionProbeEnvironment,
  ClaudeProvider,
  type ClaudeProviderDependencies,
} from '../src/providers/claude/adapter.js';
import {
  CLAUDE_AGENT_SDK_TRANSPORT_ID,
  resolveClaudeSdkV2Support,
} from '../src/providers/claude/sdk-support.js';
import type { ClaudeAgentSdkManagedSpawn } from '../src/providers/claude/sdk/index.js';

const executable = 'C:\\agent-dock\\resources\\claude-agent-sdk\\claude.exe';
const providerStateDirectory = resolve('daemon-state');
const env = { ANTHROPIC_API_KEY: 'test-key' };

const sdkStatus: ProviderStatus = {
  id: 'claude',
  name: 'Claude Agent',
  installed: true,
  authenticated: 'authenticated',
  authSource: 'api_key',
  executablePath: executable,
  version: '2.1.251',
  capabilities: {},
};

function cliStatus(): ProviderStatus {
  return {
    ...sdkStatus,
    name: 'Claude',
    authSource: 'claude_subscription',
    executablePath: 'claude',
  };
}

function selection(): CapabilitySelection {
  const support = resolveClaudeSdkV2Support(sdkStatus, 'sdk', env, {
    runtimePlatform: 'win32',
    sdkAssetAvailable: true,
    sdkClaudeCodeVersion: '2.1.251',
  });
  if (!support) throw new Error('SDK support fixture missing');
  return {
    transport: CLAUDE_AGENT_SDK_TRANSPORT_ID,
    enabled: support.capabilities
      .filter(({ id }) => id === 'session.cancel')
      .map(({ id, constraints }) => ({ id, constraints })),
    unavailableOptional: [],
    possibleEffects: [],
    effectsComplete: true,
  };
}

function sdkTransportSpec() {
  const support = resolveClaudeSdkV2Support(sdkStatus, 'sdk', env, {
    runtimePlatform: 'win32',
    sdkAssetAvailable: true,
    sdkClaudeCodeVersion: '2.1.251',
  });
  if (!support?.transports[0]) throw new Error('SDK transport fixture missing');
  return support.transports[0];
}

function options(
  overrides: Partial<StartInteractiveSessionOptions> = {},
): StartInteractiveSessionOptions {
  return {
    sessionId: 'session_1',
    cwd: 'C:\\workspace',
    prompt: 'prompt',
    transport: sdkTransportSpec(),
    selection: selection(),
    executionId: 'execution-1',
    turnId: 'turn-1',
    providerStatus: sdkStatus,
    workspaceTrust: {
      state: 'trusted',
      workspaceId: 'workspace-1',
      incarnation: 'incarnation-1',
      trustEpoch: 1,
    },
    providerStateDirectory,
    ...overrides,
  };
}

async function* empty(): AsyncGenerator<unknown, void, void> {
  /* session need not emit to prove admission */
}

function transport(): InteractiveProviderTransport {
  return {
    events: empty(),
    stderr: empty(),
    started: Promise.resolve(),
    accepted: Promise.resolve('accepted'),
    send: async () => undefined,
    resolveInteraction: async () => undefined,
    interrupt: async () => undefined,
    close: async () => undefined,
    forceClose: async () => undefined,
  };
}

function dependencies(
  overrides: Partial<ClaudeProviderDependencies> = {},
): ClaudeProviderDependencies {
  return {
    env: () => env,
    runtimePlatform: () => 'win32',
    detectCli: vi.fn(async () => cliStatus()),
    resolveSdkExecutable: () => ({ ok: true, path: executable, source: 'packaged-resource' }),
    probeSdkVersion: vi.fn(async () => '2.1.251'),
    createSdkTransport: vi.fn(() => transport()) as never,
    createManagedSpawner: vi.fn(() => () => {
      const stream = new PassThrough();
      return {
        process: {
          stdin: stream,
          stdout: stream,
          killed: false,
          exitCode: 0,
          signalCode: null,
          kill: () => true,
          on: () => undefined,
          once: () => undefined,
          off: () => undefined,
        },
        forceClose: async () => undefined,
        reaped: Promise.resolve(),
      } as unknown as ClaudeAgentSdkManagedSpawn;
    }) as never,
    ...overrides,
  };
}

describe('ClaudeProvider Agent SDK admission', () => {
  it('keeps SDK version probes credential-free and control-free', () => {
    expect(
      buildClaudeSdkVersionProbeEnvironment({
        SystemRoot: 'C:\\Windows',
        ANTHROPIC_API_KEY: 'secret',
        AWS_SECRET_ACCESS_KEY: 'secret',
        CLAUDE_CODE_OAUTH_TOKEN: 'secret',
        NODE_OPTIONS: '--require unsafe',
        AGENT_DOCK_CLAUDE_TRANSPORT: 'cli',
        Path: 'C:\\unsafe',
      }),
    ).toEqual({ SystemRoot: 'C:\\Windows' });
  });

  it('normalizes Windows SystemRoot casing for the isolated version probe', () => {
    expect(buildClaudeSdkVersionProbeEnvironment({ SYSTEMROOT: 'C:\\Windows' })).toEqual({
      SystemRoot: 'C:\\Windows',
    });
  });

  it('selects the exact packaged SDK only with eligible auth and pinned executable version', async () => {
    const deps = dependencies();
    const detected = await new ClaudeProvider(undefined, deps).detect();
    expect(detected).toMatchObject(sdkStatus);
    expect(deps.probeSdkVersion).toHaveBeenCalledWith(executable);
    expect(deps.detectCli).not.toHaveBeenCalled();
  });

  it.each([
    [{}, 'missing auth'],
    [{ CLAUDE_CODE_OAUTH_TOKEN: 'subscription' }, 'subscription OAuth'],
    [{ ANTHROPIC_API_KEY: 'key' }, 'missing asset'],
  ])('falls back to the retained CLI in auto mode for %s', async (candidateEnv, _label) => {
    const noAsset = _label === 'missing asset';
    const deps = dependencies({
      env: () => candidateEnv,
      ...(noAsset
        ? { resolveSdkExecutable: () => ({ ok: false, reason: 'sdk_asset_missing' as const }) }
        : {}),
    });
    await expect(new ClaudeProvider(undefined, deps).detect()).resolves.toEqual(cliStatus());
    expect(deps.detectCli).toHaveBeenCalledOnce();
  });

  it('fails forced SDK support closed when authenticated SDK evidence is absent', () => {
    const provider = new ClaudeProvider(
      undefined,
      dependencies({ env: () => ({ AGENT_DOCK_CLAUDE_TRANSPORT: 'sdk' }) }),
    );
    expect(() => provider.getV2Support(cliStatus())).toThrow(/missing/i);
  });

  it.each([
    [options({ workspaceTrust: { state: 'untrusted' } }), 'claude_sdk_workspace_untrusted'],
    [
      options({ continuation: { kind: 'resume', providerSessionId: 'native-id' } }),
      'claude_sdk_continuation_unavailable',
    ],
    [
      options({ providerStatus: { ...sdkStatus, executablePath: 'C:\\other\\claude.exe' } }),
      'claude_sdk_launch_unverified',
    ],
    [
      options({ providerStatus: { ...sdkStatus, version: '2.1.250' } }),
      'claude_sdk_version_unsupported',
    ],
    [
      options({ providerStatus: { ...sdkStatus, authSource: 'bedrock' } }),
      'claude_sdk_launch_unverified',
    ],
  ] as const)('rejects launch before transport construction: %s', async (input, reasonCode) => {
    const deps = dependencies();
    await expect(
      new ClaudeProvider(undefined, deps).startInteractiveSession(input),
    ).rejects.toMatchObject({ reasonCode, deliveryState: 'not_delivered' });
    expect(deps.createSdkTransport).not.toHaveBeenCalled();
  });

  it('passes locked SDK options and a daemon-managed spawner to the SDK transport', async () => {
    const deps = dependencies();
    const provider = new ClaudeProvider(undefined, deps);
    await provider.startInteractiveSession(options());
    expect(deps.createManagedSpawner).toHaveBeenCalledWith(
      expect.objectContaining({
        executable,
        cwd: 'C:\\workspace',
        authSource: 'api_key',
        runtimePlatform: 'win32',
      }),
    );
    expect(deps.createSdkTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        executable,
        daemonConfigRoot: providerStateDirectory,
        requestedTransportMode: 'auto',
        sdkOptions: expect.objectContaining({
          cwd: 'C:\\workspace',
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          plugins: [],
          skills: [],
          agents: {},
          hooks: {},
          disallowedTools: expect.arrayContaining(['Bash', 'Agent']),
        }),
        managedProcessSpawner: expect.any(Function),
      }),
    );
  });
});
