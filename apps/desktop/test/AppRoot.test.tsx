import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoot } from '../src/AppRoot.js';
import type { AgentDockBridge, DaemonStatus } from '../src/window.js';

function realBridge(): AgentDockBridge {
  return {
    getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' } satisfies DaemonStatus),
    onDaemonStatus: vi.fn().mockReturnValue(() => {}),
    listProviders: vi.fn().mockResolvedValue([]),
    listProvidersV2: vi.fn().mockResolvedValue([]),
    openProviderInstallDocs: vi.fn().mockResolvedValue(undefined),
    listMcpServers: vi.fn().mockResolvedValue({ servers: [], revision: 'real-1' }),
    configureMcpServer: vi.fn().mockResolvedValue({ servers: [], revision: 'real-1' }),
    actionMcpServer: vi.fn().mockResolvedValue({ servers: [], revision: 'real-1' }),
    getMcpCatalog: vi.fn().mockResolvedValue({ serverId: 'x', items: [], revision: 'real-1' }),
    startMcpOAuth: vi.fn().mockResolvedValue({ serverId: 'x', status: 'unsupported' }),
    invokeMcpTool: vi.fn().mockResolvedValue({ serverId: 'x', toolId: 'x', status: 'failed' }),
    listProviderComponents: vi.fn().mockResolvedValue({ items: [], revision: 'real-1' }),
    manageProviderComponent: vi.fn().mockResolvedValue({ componentId: 'x', status: 'unsupported' }),
    invokeProviderComponent: vi.fn().mockResolvedValue({ componentId: 'x', status: 'unsupported' }),
    getSubagentGraph: vi.fn().mockResolvedValue({ sessionId: 'x', nodes: [] }),
    controlSubagent: vi.fn().mockResolvedValue({ sessionId: 'x', agentId: 'x', status: 'unsupported' }),
    previewWorktree: vi.fn(),
    createWorktree: vi.fn(),
    listWorktrees: vi.fn().mockResolvedValue([]),
    cleanupWorktree: vi.fn(),
    selectAndUploadAttachments: vi.fn().mockResolvedValue([]),
    validateStructuredOutput: vi.fn(),
    createSession: vi.fn(),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    onSessionEvent: vi.fn().mockReturnValue(() => {}),
    createInteractiveSession: vi.fn(),
    listInteractiveSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    readInteractiveSessionHistory: vi.fn().mockResolvedValue({ events: [] }),
    reconnectInteractiveSession: vi.fn(),
    resumeInteractiveSession: vi.fn(),
    forkInteractiveSession: vi.fn(),
    deleteInteractiveSession: vi.fn().mockResolvedValue(undefined),
    sendSessionCommand: vi.fn(),
    respondApproval: vi.fn().mockResolvedValue({ status: 'accepted' }),
    answerQuestions: vi.fn().mockResolvedValue({ status: 'accepted' }),
    cancelInteractiveSession: vi.fn(),
    onInteractiveSessionEvent: vi.fn().mockReturnValue(() => {}),
    onInteractiveSessionStreamNotice: vi.fn().mockReturnValue(() => {}),
    onInteractionRequested: vi.fn().mockReturnValue(() => {}),
    onInteractionResolved: vi.fn().mockReturnValue(() => {}),
    inspectWorkspace: vi.fn(),
    setWorkspaceTrust: vi.fn(),
    readAudit: vi.fn().mockResolvedValue({ schemaVersion: 1, entries: [] }),
    selectDirectory: vi.fn().mockResolvedValue('/real/path'),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  (window as unknown as { agentDock: AgentDockBridge }).agentDock = realBridge();
});

describe('AppRoot demo-mode lifecycle', () => {
  it('swaps in the demo bridge and shows the banner on entry, then restores the exact real bridge instance and hides the banner on exit', async () => {
    const original = window.agentDock;
    render(<AppRoot />);

    expect(screen.queryByText(/demo mode/i)).not.toBeInTheDocument();
    expect(
      (window.agentDock as unknown as { __agentDockDemo?: boolean }).__agentDockDemo,
    ).toBeUndefined();

    fireEvent.click(await screen.findByRole('button', { name: 'Try a demo' }));

    expect(await screen.findByText(/demo mode/i)).toBeInTheDocument();
    expect((window.agentDock as unknown as { __agentDockDemo?: boolean }).__agentDockDemo).toBe(
      true,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Exit demo' }));

    expect(window.agentDock).toBe(original);
    expect(screen.queryByText(/demo mode/i)).not.toBeInTheDocument();
  });
});
