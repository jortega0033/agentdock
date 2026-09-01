import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilitySelection, ProviderStatus } from '@agent-dock/shared';
import { ProviderTransportStartupError } from '../src/types.js';
import { CodexProvider } from '../src/providers/codex/adapter.js';
import {
  CODEX_APP_SERVER_TRANSPORT,
  resolveCodexV2Support,
} from '../src/providers/codex/app-server-support.js';

const originalMode = process.env.AGENT_DOCK_CODEX_TRANSPORT;

const status: ProviderStatus = {
  id: 'codex',
  name: 'Codex',
  installed: true,
  authenticated: 'authenticated',
  authSource: 'chatgpt',
  executablePath: 'C:\\verified\\codex.exe',
  version: '0.147.0',
  capabilities: { resume: true, cancellation: true, tools: true, usage: true, thinking: true },
};

function selection(): CapabilitySelection {
  const support = resolveCodexV2Support(status, 'app-server');
  if (!support) throw new Error('missing test support');
  return {
    transport: CODEX_APP_SERVER_TRANSPORT.id,
    enabled: support.capabilities
      .filter((record) => record.id === 'session.cancel')
      .map((record) => ({ id: record.id, constraints: record.constraints })),
    unavailableOptional: [],
    possibleEffects: [],
    effectsComplete: true,
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    cwd: process.cwd(),
    prompt: 'prompt sentinel',
    transport: CODEX_APP_SERVER_TRANSPORT,
    selection: selection(),
    executionId: '8de97520-c659-4dab-bc75-cf3020e38baa',
    turnId: '1c5e75f4-069d-42bd-9ce1-9684ca00fe47',
    providerStatus: status,
    workspaceTrust: {
      state: 'trusted' as const,
      workspaceId: 'workspace-1',
      incarnation: 'incarnation-1',
      trustEpoch: 0,
    },
    ...overrides,
  };
}

afterEach(() => {
  if (originalMode === undefined) delete process.env.AGENT_DOCK_CODEX_TRANSPORT;
  else process.env.AGENT_DOCK_CODEX_TRANSPORT = originalMode;
});

describe.sequential('CodexProvider app-server admission', () => {
  it('keeps forced exec on the unchanged legacy bridge', () => {
    process.env.AGENT_DOCK_CODEX_TRANSPORT = 'exec';
    expect(new CodexProvider().getV2Support(status)).toBeUndefined();
  });

  it('rejects the retained exec bridge before launch when app-server is forced', () => {
    process.env.AGENT_DOCK_CODEX_TRANSPORT = 'app-server';

    expect(() =>
      new CodexProvider().startSession({
        sessionId: 'session-1',
        cwd: process.cwd(),
        prompt: 'must not launch',
        providerStatus: status,
        sandbox: 'workspace-write',
      }),
    ).toThrow(
      expect.objectContaining({
        reasonCode: 'codex_exec_transport_not_selected',
        deliveryState: 'not_delivered',
      }),
    );
  });

  it('reports an invalid transport override as a safe pre-launch error', () => {
    process.env.AGENT_DOCK_CODEX_TRANSPORT = 'app_server';

    expect(() =>
      new CodexProvider().startSession({
        sessionId: 'session-1',
        cwd: process.cwd(),
        prompt: 'must not launch',
      }),
    ).toThrow(
      expect.objectContaining({
        reasonCode: 'codex_transport_mode_invalid',
        deliveryState: 'not_delivered',
      }),
    );
  });

  it('fails closed before process launch without verified workspace evidence', async () => {
    process.env.AGENT_DOCK_CODEX_TRANSPORT = 'app-server';
    const provider = new CodexProvider();
    const pending = provider.startInteractiveSession(
      options({ workspaceTrust: { state: 'untrusted' } }),
    );
    await expect(pending).rejects.toMatchObject({
      reasonCode: 'codex_app_server_workspace_untrusted',
      deliveryState: 'not_delivered',
    });
    await expect(pending).rejects.toBeInstanceOf(ProviderTransportStartupError);
  });

  it('fails closed before process launch for an unverified auth state', async () => {
    process.env.AGENT_DOCK_CODEX_TRANSPORT = 'auto';
    const pending = new CodexProvider().startInteractiveSession(
      options({ providerStatus: { ...status, authenticated: 'unknown' } }),
    );
    await expect(pending).rejects.toMatchObject({
      reasonCode: 'codex_app_server_auth_unverified',
      deliveryState: 'not_delivered',
    });
  });
});
