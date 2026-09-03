import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentEventV2Envelope,
  AgentSessionV2,
  CapabilitySupportRecord,
  ProviderCapabilities,
  ProviderStatus,
  ProviderStatusV2,
  WorkspaceTrustViewV2,
} from '@agent-dock/shared';
import type {
  RendererInteraction,
  RendererInteractionResolution,
} from '../electron/interaction-broker.js';
import { App } from '../src/App.js';
import type { AgentDockBridge, DaemonStatus } from '../src/window.js';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const EXECUTION_ID = '123e4567-e89b-42d3-a456-426614174001';
const TURN_ID = '123e4567-e89b-42d3-a456-426614174002';
const WORKSPACE_ID = 'a'.repeat(64);
const INCARNATION = 'b'.repeat(64);

const LEGACY_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  cancellation: true,
  tools: true,
  usage: true,
  thinking: true,
};
const LEGACY_PROVIDER: ProviderStatus = {
  id: 'claude',
  name: 'Claude Code',
  installed: true,
  authenticated: 'authenticated',
  capabilities: LEGACY_CAPABILITIES,
};
const CLAUDE_INSTALLED: ProviderStatusV2 = {
  id: 'claude',
  name: 'Claude Code',
  installed: true,
  authenticated: 'authenticated',
  transports: [],
  capabilities: [],
  sandbox: {
    providerId: 'claude',
    platform: 'win32',
    provider: { mechanism: 'provider_policy', state: 'unknown', evidence: [] },
    agentDock: {
      mechanism: 'agentdock_policy',
      state: 'enforced',
      evidence: [
        {
          kind: 'fixture',
          reference: 'app-test',
          verifiedAt: '2026-08-31T00:00:00.000Z',
        },
      ],
    },
    os: { mechanism: 'os_sandbox', state: 'unavailable', evidence: [] },
    badge: 'restricted_by_policy',
  },
};
const TRUSTED_WORKSPACE: WorkspaceTrustViewV2 = {
  schemaVersion: 1,
  workspaceId: WORKSPACE_ID,
  incarnation: INCARNATION,
  displayName: 'project',
  reusable: true,
  state: 'trusted',
};
const SESSION: AgentSessionV2 = {
  id: SESSION_ID,
  provider: 'claude',
  transport: 'fake-interactive',
  cwd: '/tmp/project',
  branch: 'feature/concurrent-workspace',
  status: 'starting',
  selection: {
    transport: 'fake-interactive',
    enabled: [],
    unavailableOptional: [],
    possibleEffects: [],
    effectsComplete: true,
  },
  executionId: EXECUTION_ID,
  currentTurnId: TURN_ID,
  acceptedWork: 'not_accepted',
  startedAt: '2026-08-31T00:00:00.000Z',
  earliestSequence: 0,
};

interface BridgeCallbacks {
  event?: (sessionId: string, event: AgentEventV2Envelope) => void;
  interaction?: (interaction: RendererInteraction) => void;
  resolution?: (resolution: RendererInteractionResolution) => void;
}

function installBridge(overrides: Partial<AgentDockBridge> = {}): {
  bridge: AgentDockBridge;
  callbacks: BridgeCallbacks;
} {
  const callbacks: BridgeCallbacks = {};
  const bridge: AgentDockBridge = {
    getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' } satisfies DaemonStatus),
    onDaemonStatus: vi.fn().mockReturnValue(() => {}),
    listProviders: vi.fn().mockResolvedValue([LEGACY_PROVIDER]),
    listProvidersV2: vi.fn().mockResolvedValue([CLAUDE_INSTALLED]),
    listMcpServers: vi.fn().mockResolvedValue({ servers: [], revision: 'test-1' }),
    configureMcpServer: vi.fn().mockResolvedValue({ servers: [], revision: 'test-1' }),
    actionMcpServer: vi.fn().mockResolvedValue({ servers: [], revision: 'test-1' }),
    getMcpCatalog: vi
      .fn()
      .mockResolvedValue({ serverId: 'fixture', items: [], revision: 'test-1' }),
    startMcpOAuth: vi.fn().mockResolvedValue({ serverId: 'fixture', status: 'unsupported' }),
    invokeMcpTool: vi
      .fn()
      .mockResolvedValue({ serverId: 'fixture', toolId: 'tool', status: 'failed' }),
    listProviderComponents: vi.fn().mockResolvedValue({ items: [], revision: 'test-1' }),
    manageProviderComponent: vi
      .fn()
      .mockResolvedValue({ componentId: 'project/skill/test', status: 'unsupported' }),
    invokeProviderComponent: vi
      .fn()
      .mockResolvedValue({ componentId: 'project/skill/test', status: 'unsupported' }),
    getSubagentGraph: vi.fn().mockImplementation(async (sessionId) => ({ sessionId, nodes: [] })),
    controlSubagent: vi
      .fn()
      .mockResolvedValue({ sessionId: SESSION_ID, agentId: SESSION_ID, status: 'unsupported' }),
    previewWorktree: vi.fn().mockResolvedValue({
      workspaceId: 'a'.repeat(64),
      name: 'test',
      displayTarget: 'test',
      includeFiles: [],
      ignoredFiles: [],
      secretRisk: false,
      requiresConfirmation: true,
    }),
    createWorktree: vi.fn().mockResolvedValue({
      id: SESSION_ID,
      workspaceId: 'a'.repeat(64),
      name: 'test',
      displayPath: 'test',
      status: 'ready',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    listWorktrees: vi.fn().mockResolvedValue([]),
    cleanupWorktree: vi.fn().mockResolvedValue({
      id: SESSION_ID,
      workspaceId: 'a'.repeat(64),
      name: 'test',
      displayPath: 'test',
      status: 'missing',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    selectAndUploadAttachments: vi.fn().mockResolvedValue([]),
    validateStructuredOutput: vi.fn().mockImplementation(async (input) => ({
      valid: true,
      normalizedOutput: input.output,
      errors: [],
    })),
    createSession: vi.fn(),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    onSessionEvent: vi.fn().mockReturnValue(() => {}),
    createInteractiveSession: vi.fn().mockResolvedValue(SESSION),
    listInteractiveSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    readInteractiveSessionHistory: vi.fn().mockResolvedValue({ events: [] }),
    reconnectInteractiveSession: vi.fn().mockResolvedValue(SESSION),
    resumeInteractiveSession: vi.fn().mockResolvedValue(SESSION),
    forkInteractiveSession: vi.fn().mockResolvedValue(SESSION),
    deleteInteractiveSession: vi.fn().mockResolvedValue(undefined),
    sendSessionCommand: vi.fn(),
    respondApproval: vi.fn().mockResolvedValue({ status: 'accepted' }),
    answerQuestions: vi.fn().mockResolvedValue({ status: 'accepted' }),
    cancelInteractiveSession: vi
      .fn()
      .mockResolvedValue({ status: 'cancelling', sessionId: SESSION_ID }),
    onInteractiveSessionEvent: vi.fn((callback) => {
      callbacks.event = callback;
      return () => {
        callbacks.event = undefined;
      };
    }),
    onInteractiveSessionStreamNotice: vi.fn().mockReturnValue(() => {}),
    onInteractionRequested: vi.fn((callback) => {
      callbacks.interaction = (interaction) => callback(SESSION_ID, interaction);
      return () => {
        callbacks.interaction = undefined;
      };
    }),
    onInteractionResolved: vi.fn((callback) => {
      callbacks.resolution = (resolution) => callback(SESSION_ID, resolution);
      return () => {
        callbacks.resolution = undefined;
      };
    }),
    inspectWorkspace: vi.fn().mockResolvedValue(TRUSTED_WORKSPACE),
    setWorkspaceTrust: vi.fn().mockResolvedValue(TRUSTED_WORKSPACE),
    readAudit: vi.fn().mockResolvedValue({ schemaVersion: 1, entries: [] }),
    selectDirectory: vi.fn().mockResolvedValue('/chosen/dir'),
    ...overrides,
  };
  (window as unknown as { agentDock: AgentDockBridge }).agentDock = bridge;
  return { bridge, callbacks };
}

function fillSessionForm(): void {
  fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
    target: { value: '/tmp/project' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: /prompt/i }), {
    target: { value: 'do something' },
  });
}

function event(
  sequence: number,
  value: { type: 'content.delta'; delta: string } | { type: 'session.completed' },
): AgentEventV2Envelope {
  const meta = {
    sessionId: SESSION_ID,
    executionId: EXECUTION_ID,
    sequence,
    timestamp: '2026-08-31T00:00:00.000Z',
  };
  return value.type === 'content.delta'
    ? {
        ...meta,
        ...value,
        turnId: TURN_ID,
        contentBlockId: '123e4567-e89b-42d3-a456-426614174003',
      }
    : { ...meta, ...value };
}

beforeEach(() => {
  window.localStorage.clear();
  installBridge();
});
afterEach(() => vi.restoreAllMocks());

describe('App security flow', () => {
  it('shows the daemon-unavailable state when startup fails', async () => {
    let statusCallback: ((status: DaemonStatus) => void) | undefined;
    installBridge({
      getDaemonStatus: vi.fn().mockResolvedValue({ state: 'connecting' } satisfies DaemonStatus),
      onDaemonStatus: vi.fn((callback) => {
        statusCallback = callback;
        return () => {};
      }),
    });
    render(<App />);
    statusCallback?.({ state: 'unavailable', error: 'daemon exited unexpectedly' });
    await waitFor(() => expect(screen.getByText(/daemon unavailable/i)).toBeInTheDocument());
    expect(screen.getByText(/exited unexpectedly/)).toBeInTheDocument();
  });

  it('shows policy restrictions separately from unavailable Windows OS isolation', async () => {
    render(<App />);
    expect(await screen.findByText('Restricted by AgentDock policy')).toBeInTheDocument();
    expect(screen.getByText('OS isolation: unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/bash sandboxed/i)).not.toBeInTheDocument();
  });

  it('labels every advanced panel with its real implementation state (issue #62)', async () => {
    render(<App />);
    await screen.findByText('Claude Code');

    // MCP, Components, and Workflow are all scaffold-only regardless of provider; Child agents
    // reads as unsupported only because no session is selected yet in this test.
    expect(screen.getAllByText('Scaffold only').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('Unsupported')).toBeInTheDocument();
    expect(
      screen.getByText(/Configuration and inspection only, for either provider/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Files you stage here are not included in any run/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Select a session to see its child-agent state/)).toBeInTheDocument();
  });

  it('requires explicit incarnation-bound trust before starting and supports Escape cancellation', async () => {
    const untrusted = { ...TRUSTED_WORKSPACE, state: 'untrusted' as const };
    const { bridge } = installBridge({
      inspectWorkspace: vi.fn().mockResolvedValue(untrusted),
    });
    render(<App />);
    await screen.findByText('Claude Code');
    fillSessionForm();
    const runButton = screen.getByRole('button', { name: 'Run' });
    await waitFor(() => expect(runButton).toBeEnabled());
    runButton.focus();
    fireEvent.click(runButton);

    const dialog = await screen.findByRole('dialog', { name: /trust project/i });
    const cancelTrustButton = within(dialog).getByRole('button', { name: 'Cancel' });
    const trustButton = within(dialog).getByRole('button', { name: /trust workspace & run/i });
    expect(cancelTrustButton).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(trustButton).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(cancelTrustButton).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(runButton).toHaveFocus();
    expect(bridge.createInteractiveSession).not.toHaveBeenCalled();

    await waitFor(() => expect(runButton).toBeEnabled());
    fireEvent.click(runButton);
    await screen.findByRole('dialog', { name: /trust project/i });
    fireEvent.click(screen.getByRole('button', { name: /trust workspace & run/i }));
    await waitFor(() => expect(bridge.createInteractiveSession).toHaveBeenCalledOnce());
    expect(bridge.setWorkspaceTrust).toHaveBeenCalledWith(WORKSPACE_ID, {
      cwd: '/tmp/project',
      incarnation: INCARNATION,
      state: 'trusted',
    });
  });

  it('runs the v2 session, streams normalized events, and cancels through the v2 API', async () => {
    const { bridge, callbacks } = installBridge();
    render(<App />);
    await screen.findByText('Claude Code');
    fillSessionForm();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(bridge.createInteractiveSession).toHaveBeenCalledOnce());

    callbacks.event?.(SESSION_ID, event(0, { type: 'content.delta', delta: 'fixture output' }));
    expect(await screen.findByText('fixture output')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(bridge.cancelInteractiveSession).toHaveBeenCalledWith(SESSION_ID));
    callbacks.event?.(SESSION_ID, event(1, { type: 'session.completed' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Session activity')).toHaveTextContent('session completed'),
    );
  });

  it('runs three concurrent sessions without mixing background events or cancellation targets', async () => {
    const secondSessionId = '223e4567-e89b-42d3-a456-426614174000';
    const secondExecutionId = '223e4567-e89b-42d3-a456-426614174001';
    const thirdSessionId = '323e4567-e89b-42d3-a456-426614174000';
    const thirdExecutionId = '323e4567-e89b-42d3-a456-426614174001';
    const secondSession: AgentSessionV2 = {
      ...SESSION,
      id: secondSessionId,
      executionId: secondExecutionId,
      startedAt: '2026-08-31T00:00:01.000Z',
    };
    const thirdSession: AgentSessionV2 = {
      ...SESSION,
      id: thirdSessionId,
      executionId: thirdExecutionId,
      startedAt: '2026-08-31T00:00:02.000Z',
    };
    const { bridge, callbacks } = installBridge({
      createInteractiveSession: vi
        .fn()
        .mockResolvedValueOnce(SESSION)
        .mockResolvedValueOnce(secondSession)
        .mockResolvedValueOnce(thirdSession),
    });
    render(<App />);
    await screen.findByText('Claude Code');

    fillSessionForm();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(bridge.createInteractiveSession).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('textbox', { name: /prompt/i }), {
      target: { value: 'second task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(bridge.createInteractiveSession).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByRole('textbox', { name: /prompt/i }), {
      target: { value: 'third task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(bridge.createInteractiveSession).toHaveBeenCalledTimes(3));

    callbacks.event?.(SESSION_ID, event(0, { type: 'content.delta', delta: 'first background' }));
    callbacks.event?.(secondSessionId, {
      ...event(0, { type: 'content.delta', delta: 'second foreground' }),
      sessionId: secondSessionId,
      executionId: secondExecutionId,
    });
    callbacks.event?.(thirdSessionId, {
      ...event(0, { type: 'content.delta', delta: 'third foreground' }),
      sessionId: thirdSessionId,
      executionId: thirdExecutionId,
    });
    expect(await screen.findByText('third foreground')).toBeInTheDocument();
    expect(screen.queryByText('first background')).not.toBeInTheDocument();
    expect(screen.queryByText('second foreground')).not.toBeInTheDocument();

    const interactionHandle = 'A'.repeat(43);
    callbacks.interaction?.({
      kind: 'approval',
      interactionHandle,
      title: 'Background approval',
      action: 'execute',
      target: 'workspace',
      possibleEffects: ['command'],
      effectsComplete: true,
      allowedDecisions: ['allow_once', 'deny'],
      deadlineAt: '2026-08-31T00:05:00.000Z',
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /claude · 123e4567/i })).toHaveTextContent(
        'Needs attention',
      ),
    );
    callbacks.resolution?.({
      interactionHandle,
      kind: 'approval_resolved',
      reason: 'denied',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(bridge.cancelInteractiveSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(bridge.cancelInteractiveSession).toHaveBeenLastCalledWith(thirdSessionId),
    );
    fireEvent.click(screen.getByRole('button', { name: /claude · 223e4567/i }));
    expect(await screen.findByText('second foreground')).toBeInTheDocument();
    expect(screen.queryByText('third foreground')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /claude · 123e4567/i }));
    expect(await screen.findByText('first background')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(bridge.cancelInteractiveSession).toHaveBeenLastCalledWith(SESSION_ID),
    );
  });

  it('restores catalog selection, unread state, terminal history, and branch after restart', async () => {
    const restoredId = '423e4567-e89b-42d3-a456-426614174000';
    const restoredExecutionId = '423e4567-e89b-42d3-a456-426614174001';
    const restoredSession: AgentSessionV2 = {
      ...SESSION,
      id: restoredId,
      executionId: restoredExecutionId,
      status: 'completed',
      startedAt: '2026-08-31T00:00:03.000Z',
      completedAt: '2026-08-31T00:01:00.000Z',
    };
    window.localStorage.setItem(
      'agent-dock.session-workspace.v1',
      JSON.stringify({
        selectedSessionId: restoredId,
        unreadBySession: { [SESSION_ID]: 3 },
        archivedSessionIds: [SESSION_ID],
      }),
    );
    const historyEvent: AgentEventV2Envelope = {
      ...event(0, { type: 'content.delta', delta: 'restored terminal output' }),
      sessionId: restoredId,
      executionId: restoredExecutionId,
    };
    const { bridge } = installBridge({
      listInteractiveSessions: vi.fn().mockResolvedValue({
        sessions: [{ ...SESSION, status: 'completed' }, restoredSession],
      }),
      readInteractiveSessionHistory: vi.fn().mockImplementation(async (sessionId: string) => ({
        events: sessionId === restoredId ? [historyEvent] : [],
      })),
    });

    render(<App />);

    expect(await screen.findByText('restored terminal output')).toBeInTheDocument();
    expect(screen.getByText('Branch: feature/concurrent-workspace')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /claude · 123e4567/i })).toHaveTextContent(
      /3\s*Archived/,
    );
    expect(bridge.reconnectInteractiveSession).not.toHaveBeenCalled();
  });

  function continuationRecord(
    id: 'session.resume' | 'session.fork',
    support: 'supported' | 'unsupported',
  ): CapabilitySupportRecord {
    return {
      id,
      kind: 'operation',
      owner: 'provider',
      support,
      stability: 'stable',
      evidence: [],
      scope: {
        provider: 'claude',
        transport: 'legacy-one-shot',
        platform: 'win32',
        model: '*',
        authMode: '*',
        trustState: 'untrusted',
        versions: {
          adapterContract: '2',
          transport: 'unknown',
          runtime: process.version,
          fixtureSet: 'test-fixture',
        },
      },
      prerequisites: {
        capabilities: [],
        trustStates: ['untrusted'],
        sessionStates: ['starting'],
        services: [],
      },
      possibleEffects: [],
      effectsComplete: true,
      constraints: { kind: 'continuation', native: true },
      ...(support === 'unsupported' ? { reason: 'test fixture' } : {}),
    } as CapabilitySupportRecord;
  }

  it('disables Resume/Fork for a terminal session whose provider does not advertise them as supported (issue #54)', async () => {
    const completedSession: AgentSessionV2 = {
      ...SESSION,
      status: 'completed',
      completedAt: '2026-08-31T00:01:00.000Z',
    };
    window.localStorage.setItem(
      'agent-dock.session-workspace.v1',
      JSON.stringify({
        selectedSessionId: SESSION_ID,
        unreadBySession: {},
        archivedSessionIds: [],
      }),
    );
    // CLAUDE_INSTALLED's default `capabilities: []` already matches this (truthful, no record at
    // all), but list both capabilities explicitly as unsupported to also prove the button reacts
    // to an explicit 'unsupported' record, not just an absent one.
    installBridge({
      listProvidersV2: vi.fn().mockResolvedValue([
        {
          ...CLAUDE_INSTALLED,
          capabilities: [
            continuationRecord('session.resume', 'unsupported'),
            continuationRecord('session.fork', 'unsupported'),
          ],
        },
      ]),
      listInteractiveSessions: vi.fn().mockResolvedValue({ sessions: [completedSession] }),
    });

    render(<App />);

    const resumeButton = await screen.findByRole('button', { name: 'Resume' });
    const forkButton = screen.getByRole('button', { name: 'Fork' });
    expect(resumeButton).toBeDisabled();
    expect(forkButton).toBeDisabled();
  });

  it('enables Resume/Fork for a terminal session whose provider does advertise them as supported', async () => {
    const completedSession: AgentSessionV2 = {
      ...SESSION,
      status: 'completed',
      completedAt: '2026-08-31T00:01:00.000Z',
    };
    window.localStorage.setItem(
      'agent-dock.session-workspace.v1',
      JSON.stringify({
        selectedSessionId: SESSION_ID,
        unreadBySession: {},
        archivedSessionIds: [],
      }),
    );
    installBridge({
      listProvidersV2: vi.fn().mockResolvedValue([
        {
          ...CLAUDE_INSTALLED,
          capabilities: [
            continuationRecord('session.resume', 'supported'),
            continuationRecord('session.fork', 'supported'),
          ],
        },
      ]),
      listInteractiveSessions: vi.fn().mockResolvedValue({ sessions: [completedSession] }),
    });

    render(<App />);

    const resumeButton = await screen.findByRole('button', { name: 'Resume' });
    const forkButton = screen.getByRole('button', { name: 'Fork' });
    fireEvent.change(screen.getByPlaceholderText(/describe the task/i), {
      target: { value: 'continue please' },
    });
    expect(resumeButton).toBeEnabled();
    expect(forkButton).toBeEnabled();
  });

  it('sends dirty-worktree sharing consent only after explicit opt-in', async () => {
    const { bridge } = installBridge();
    render(<App />);
    await screen.findByText('Claude Code');
    fillSessionForm();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /allow another read-only session to share this worktree/i,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() =>
      expect(bridge.createInteractiveSession).toHaveBeenCalledWith(
        expect.objectContaining({ allowDirtyWorkspaceShare: true }),
      ),
    );
  });

  it('defaults keyboard focus to Deny and answers only with an opaque handle', async () => {
    const { bridge, callbacks } = installBridge();
    render(<App />);
    await screen.findByText('Claude Code');
    fillSessionForm();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(bridge.createInteractiveSession).toHaveBeenCalledOnce());

    const interactionHandle = 'A'.repeat(43);
    callbacks.interaction?.({
      kind: 'approval',
      interactionHandle,
      title: 'Run command',
      action: 'execute',
      target: 'workspace',
      possibleEffects: ['command'],
      effectsComplete: true,
      allowedDecisions: ['allow_once', 'allow_session', 'deny'],
      deadlineAt: '2026-08-31T00:05:00.000Z',
    });

    const dialog = await screen.findByRole('dialog', { name: 'Run command' });
    const denyButton = within(dialog).getByRole('button', { name: 'Deny' });
    const allowSessionButton = within(dialog).getByRole('button', {
      name: 'Allow for this session',
    });
    expect(denyButton).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(allowSessionButton).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(denyButton).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() =>
      expect(bridge.respondApproval).toHaveBeenCalledWith(interactionHandle, 'deny'),
    );
  });

  it('projects opaque approval interactions into one safe lifecycle card', async () => {
    const { bridge, callbacks } = installBridge();
    render(<App />);
    await screen.findByText('Claude Code');
    fillSessionForm();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(bridge.createInteractiveSession).toHaveBeenCalledOnce());

    const interactionHandle = 'A'.repeat(43);
    callbacks.interaction?.({
      kind: 'approval',
      interactionHandle,
      title: 'Run command',
      action: 'execute',
      target: 'workspace',
      possibleEffects: ['command'],
      effectsComplete: true,
      allowedDecisions: ['allow_once', 'deny'],
      deadlineAt: '2026-08-31T00:05:00.000Z',
    });

    const timeline = await screen.findByLabelText('Session activity');
    expect(
      await within(timeline).findByRole('article', {
        name: 'Run command. Needs attention. Action required',
      }),
    ).toBeInTheDocument();
    expect(timeline).not.toHaveTextContent(interactionHandle);

    callbacks.resolution?.({
      interactionHandle,
      kind: 'approval_resolved',
      reason: 'denied',
    });

    expect(
      await within(timeline).findByRole('article', { name: 'Approval denied. Failed' }),
    ).toBeInTheDocument();
    expect(within(timeline).getAllByRole('article')).toHaveLength(1);
    expect(timeline).not.toHaveTextContent(interactionHandle);
  });

  it('fails a pending question closed when Escape cancels its session', async () => {
    const { bridge, callbacks } = installBridge();
    render(<App />);
    await screen.findByText('Claude Code');
    fillSessionForm();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(bridge.createInteractiveSession).toHaveBeenCalledOnce());

    callbacks.interaction?.({
      kind: 'question',
      interactionHandle: 'A'.repeat(43),
      deadlineAt: '2026-08-31T00:05:00.000Z',
      questions: [
        {
          questionHandle: 'B'.repeat(43),
          title: 'Choose a mode',
          prompt: 'Which mode should be used?',
          allowsFreeText: false,
          options: [{ optionHandle: 'C'.repeat(43), label: 'Safe mode' }],
        },
      ],
    });

    const dialog = await screen.findByRole('dialog', { name: /answer to continue/i });
    const checkbox = within(dialog).getByRole('checkbox', { name: /safe mode/i });
    const cancelSessionButton = within(dialog).getByRole('button', { name: 'Cancel session' });
    expect(checkbox).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(cancelSessionButton).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(checkbox).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(bridge.cancelInteractiveSession).toHaveBeenCalledWith(SESSION_ID));
  });

  it('submits bounded question answers using opaque question and option handles', async () => {
    const { bridge, callbacks } = installBridge();
    render(<App />);
    await screen.findByText('Claude Code');
    fillSessionForm();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(bridge.createInteractiveSession).toHaveBeenCalledOnce());

    const interactionHandle = 'A'.repeat(43);
    const questionHandle = 'B'.repeat(43);
    const optionHandle = 'C'.repeat(43);
    callbacks.interaction?.({
      kind: 'question',
      interactionHandle,
      deadlineAt: '2026-08-31T00:05:00.000Z',
      questions: [
        {
          questionHandle,
          title: 'Choose a mode',
          prompt: 'Which mode should be used?',
          allowsFreeText: false,
          options: [{ optionHandle, label: 'Safe mode' }],
        },
      ],
    });

    await screen.findByRole('dialog', { name: /answer to continue/i });
    fireEvent.click(screen.getByRole('checkbox', { name: /safe mode/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    await waitFor(() =>
      expect(bridge.answerQuestions).toHaveBeenCalledWith(interactionHandle, [
        {
          questionHandle,
          answer: { kind: 'options', optionHandles: [optionHandle] },
        },
      ]),
    );
  });
});
