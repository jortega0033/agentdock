import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  AgentSession,
  ProviderCapabilities,
  ProviderStatus,
} from '@agent-dock/shared';
import { App } from '../src/App.js';
import type { AgentDockBridge, DaemonStatus } from '../src/window.js';

const TEST_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  cancellation: true,
  tools: true,
  usage: true,
  thinking: true,
};

const CLAUDE_INSTALLED: ProviderStatus = {
  id: 'claude',
  name: 'Claude Code',
  installed: true,
  authenticated: 'authenticated',
  capabilities: TEST_CAPABILITIES,
};
const CODEX_NOT_INSTALLED: ProviderStatus = {
  id: 'codex',
  name: 'Codex',
  installed: false,
  authenticated: 'unknown',
  capabilities: TEST_CAPABILITIES,
};

function installBridge(overrides: Partial<AgentDockBridge> = {}): AgentDockBridge {
  const bridge: AgentDockBridge = {
    getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' } satisfies DaemonStatus),
    onDaemonStatus: vi.fn().mockReturnValue(() => {}),
    listProviders: vi.fn().mockResolvedValue([CLAUDE_INSTALLED]),
    createSession: vi.fn(),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    onSessionEvent: vi.fn().mockReturnValue(() => {}),
    createInteractiveSession: vi.fn(),
    sendSessionCommand: vi.fn(),
    cancelInteractiveSession: vi.fn(),
    onInteractiveSessionEvent: vi.fn().mockReturnValue(() => {}),
    onInteractiveSessionStreamNotice: vi.fn().mockReturnValue(() => {}),
    selectDirectory: vi.fn().mockResolvedValue('/chosen/dir'),
    ...overrides,
  };
  (window as unknown as { agentDock: AgentDockBridge }).agentDock = bridge;
  return bridge;
}

beforeEach(() => {
  installBridge();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('App', () => {
  it('shows the daemon-unavailable banner when the daemon reports an error', async () => {
    let statusCallback: ((status: DaemonStatus) => void) | undefined;
    installBridge({
      getDaemonStatus: vi.fn().mockResolvedValue({ state: 'connecting' } satisfies DaemonStatus),
      onDaemonStatus: vi.fn((cb) => {
        statusCallback = cb;
        return () => {};
      }),
    });

    render(<App />);
    expect(screen.getByText(/connecting to local daemon/i)).toBeInTheDocument();

    statusCallback?.({
      state: 'unavailable',
      error: 'daemon process exited unexpectedly (code 1, signal null)',
    });

    await waitFor(() => expect(screen.getByText(/daemon unavailable/i)).toBeInTheDocument());
    expect(screen.getByText(/exited unexpectedly/)).toBeInTheDocument();
  });

  it('lists providers and disables Run until a working directory and prompt are filled in', async () => {
    installBridge({
      listProviders: vi.fn().mockResolvedValue([CLAUDE_INSTALLED, CODEX_NOT_INSTALLED]),
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText('Installed: No')).toBeInTheDocument()); // codex

    const runButton = screen.getByRole('button', { name: 'Run' });
    expect(runButton).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
      target: { value: '/tmp/project' },
    });
    expect(runButton).toBeDisabled(); // prompt still empty

    fireEvent.change(screen.getByRole('textbox', { name: /prompt/i }), {
      target: { value: 'do something' },
    });
    expect(runButton).toBeEnabled();
  });

  // The real "does the bridge leak a token" regression now lives in test/preload.test.ts (AD-07),
  // exercising the actual electron/preload.ts module against a stubbed ipcRenderer rather than a
  // mock this test file constructed itself — a mock built by the test can't fail for the reason
  // its name claims, since the test controls both sides of the assertion.

  it('runs a session end to end and reflects completion + streamed events', async () => {
    let sessionEventCallback: ((sessionId: string, event: AgentEvent) => void) | undefined;
    const session: AgentSession = {
      id: 'sess-1',
      provider: 'claude',
      cwd: '/tmp/project',
      prompt: 'do something',
      status: 'starting',
      startedAt: new Date().toISOString(),
    };

    installBridge({
      createSession: vi.fn().mockResolvedValue(session),
      onSessionEvent: vi.fn((cb) => {
        sessionEventCallback = cb;
        return () => {};
      }),
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
      target: { value: '/tmp/project' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /prompt/i }), {
      target: { value: 'do something' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled());

    sessionEventCallback?.('sess-1', {
      type: 'session.started',
      sessionId: 'sess-1',
      provider: 'claude',
    });
    sessionEventCallback?.('sess-1', { type: 'assistant.message', text: 'hi from the fixture' });
    sessionEventCallback?.('sess-1', { type: 'session.completed' });

    await waitFor(() => expect(screen.getByText('hi from the fixture')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('completed')).toBeInTheDocument());
  });

  it('ignores session events for a session id other than the one currently tracked', async () => {
    let sessionEventCallback: ((sessionId: string, event: AgentEvent) => void) | undefined;
    const session: AgentSession = {
      id: 'sess-current',
      provider: 'claude',
      cwd: '/tmp/project',
      prompt: 'do something',
      status: 'starting',
      startedAt: new Date().toISOString(),
    };

    installBridge({
      createSession: vi.fn().mockResolvedValue(session),
      onSessionEvent: vi.fn((cb) => {
        sessionEventCallback = cb;
        return () => {};
      }),
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
      target: { value: '/tmp/project' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /prompt/i }), {
      target: { value: 'do something' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled());

    sessionEventCallback?.('sess-stale-from-a-previous-run', {
      type: 'assistant.message',
      text: 'should not appear',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('should not appear')).not.toBeInTheDocument();
  });

  it('enables Cancel while running and calls cancelSession with the running session id', async () => {
    const session: AgentSession = {
      id: 'sess-2',
      provider: 'claude',
      cwd: '/tmp/project',
      prompt: 'do something',
      status: 'starting',
      startedAt: new Date().toISOString(),
    };
    const bridge = installBridge({ createSession: vi.fn().mockResolvedValue(session) });

    render(<App />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
      target: { value: '/tmp/project' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /prompt/i }), {
      target: { value: 'do something' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    const cancelButton = await screen.findByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancelButton).toBeEnabled());

    fireEvent.click(cancelButton);
    await waitFor(() => expect(bridge.cancelSession).toHaveBeenCalledWith('sess-2'));
  });

  it('surfaces a rejected createSession call as a form error instead of crashing', async () => {
    installBridge({
      createSession: vi.fn().mockRejectedValue(new Error('daemon is not ready yet')),
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
      target: { value: '/tmp/project' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /prompt/i }), {
      target: { value: 'do something' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByText('daemon is not ready yet')).toBeInTheDocument());
    expect(screen.getByText('failed')).toBeInTheDocument();
  });
});
