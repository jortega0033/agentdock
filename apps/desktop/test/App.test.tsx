import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentEventV2Envelope,
  AgentSessionV2,
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
    createSession: vi.fn(),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    onSessionEvent: vi.fn().mockReturnValue(() => {}),
    createInteractiveSession: vi.fn().mockResolvedValue(SESSION),
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
      callbacks.interaction = callback;
      return () => {
        callbacks.interaction = undefined;
      };
    }),
    onInteractionResolved: vi.fn((callback) => {
      callbacks.resolution = callback;
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

beforeEach(() => installBridge());
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
