import type { AgentEvent, AgentEventV2Envelope, AgentSession } from '@agent-dock/shared';
import type {
  RendererApprovalInteraction,
  RendererInteraction,
  RendererInteractionResolution,
} from '../electron/interaction-broker.js';
import type { AgentDockBridge } from './window.js';
import { DEMO_TRANSPORT_ID, providers, providersV2, workspaceTrust } from './fixtures/provider-fixtures.js';

/** An obviously-fake path -- unlike the asset-capture fixture's `C:\workspace\agent-dock`, this
 * must never look like it could be a real directory on the viewer's machine, since demo mode ships
 * to every user, not just internal screenshot tooling. */
const DEMO_CWD = 'demo-workspace';

const DEMO_APPROVAL_HANDLE = 'demo-approval-handle-1234567890123456789012';

/** Deterministic, always-"completed" interactive bridge for the shipped "Try a demo" mode. Reuses
 * the same provider/sandbox/trust fixtures as `asset-capture-bridge.ts` (see
 * `fixtures/provider-fixtures.ts`) so the two can't silently drift, but plays a richer script: it
 * is the only fixture bridge that exercises the approval interaction, since asset-capture's single
 * deterministic snapshot has no need to model a paused, user-driven step. */
export function createDemoBridge(): AgentDockBridge {
  let eventCallback: ((sessionId: string, event: AgentEvent) => void) | undefined;
  let interactiveEventCallback:
    ((sessionId: string, event: AgentEventV2Envelope) => void) | undefined;
  let interactionCallback:
    ((sessionId: string, interaction: RendererInteraction) => void) | undefined;
  let interactionResolvedCallback:
    ((sessionId: string, resolution: RendererInteractionResolution) => void) | undefined;
  // Set by createInteractiveSession on each run, and invoked by respondApproval once the viewer
  // actually approves or denies -- the demo script is genuinely paused at the approval step, not
  // just delayed behind a fixed timer, so nothing plays past it until the viewer acts.
  let approvalContinuation: (() => void) | undefined;

  const interactiveSessionId = '123e4567-e89b-42d3-a456-426614174000';
  const interactiveExecutionId = '123e4567-e89b-42d3-a456-426614174001';
  const legacySession: AgentSession = {
    id: 'demo-session-001',
    provider: 'claude',
    cwd: DEMO_CWD,
    prompt: 'Review the runtime boundary and summarize the package architecture.',
    status: 'starting',
    startedAt: '2026-08-30T12:00:00.000Z',
  };

  const bridge: AgentDockBridge = {
    getDaemonStatus: async () => ({ state: 'ready' }),
    onDaemonStatus: () => () => {},
    listProviders: async () => providers,
    listProvidersV2: async () => providersV2,
    openProviderInstallDocs: async () => {},
    listMcpServers: async () => ({ servers: [], revision: 'demo-1' }),
    configureMcpServer: async () => ({ servers: [], revision: 'demo-1' }),
    actionMcpServer: async () => ({ servers: [], revision: 'demo-1' }),
    getMcpCatalog: async (_provider, serverId) => ({ serverId, items: [], revision: 'demo-1' }),
    startMcpOAuth: async (_provider, serverId) => ({ serverId, status: 'unsupported' }),
    invokeMcpTool: async (input) => ({
      serverId: input.serverId,
      toolId: input.toolId,
      status: 'failed',
      safeSummary: 'Unavailable in demo mode',
    }),
    listProviderComponents: async () => ({ items: [], revision: 'demo-1' }),
    manageProviderComponent: async (input) => ({ componentId: input.componentId, status: 'unsupported' }),
    invokeProviderComponent: async (input) => ({ componentId: input.componentId, status: 'unsupported' }),
    getSubagentGraph: async (sessionId) => ({ sessionId, nodes: [] }),
    controlSubagent: async (input) => ({ sessionId: input.sessionId, agentId: input.agentId, status: 'unsupported' }),
    previewWorktree: async (input) => ({
      workspaceId: 'a'.repeat(64),
      name: input.name,
      displayTarget: input.name,
      includeFiles: [],
      ignoredFiles: [],
      secretRisk: false,
      requiresConfirmation: true,
    }),
    createWorktree: async (input) => ({
      id: '123e4567-e89b-42d3-a456-426614174099',
      workspaceId: 'a'.repeat(64),
      name: input.name,
      displayPath: input.name,
      status: 'ready',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    listWorktrees: async () => [],
    cleanupWorktree: async (worktreeId) => ({
      id: worktreeId,
      workspaceId: 'a'.repeat(64),
      name: 'worktree',
      displayPath: 'worktree',
      status: 'missing',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    selectAndUploadAttachments: async () => [],
    validateStructuredOutput: async (input) => ({ valid: true, normalizedOutput: input.output, errors: [] }),
    createSession: async () => {
      window.setTimeout(() => {
        eventCallback?.(legacySession.id, {
          type: 'session.started',
          sessionId: legacySession.id,
          provider: 'claude',
        });
        eventCallback?.(legacySession.id, {
          type: 'status',
          status: 'running',
          detail: 'Inspecting workspace boundaries',
        });
        eventCallback?.(legacySession.id, {
          type: 'tool.started',
          toolName: 'Read',
          toolCallId: 'demo-tool-legacy-1',
        });
        eventCallback?.(legacySession.id, {
          type: 'assistant.message',
          text: 'AgentDock keeps provider authentication inside each installed CLI and normalizes session events through one typed local protocol.',
        });
        eventCallback?.(legacySession.id, {
          type: 'tool.completed',
          toolName: 'Read',
          toolCallId: 'demo-tool-legacy-1',
        });
        eventCallback?.(legacySession.id, { type: 'usage', inputTokens: 1842, outputTokens: 326 });
        eventCallback?.(legacySession.id, { type: 'session.completed' });
      }, 80);
      return legacySession;
    },
    cancelSession: async () => {},
    onSessionEvent: (callback) => {
      eventCallback = callback;
      return () => {
        eventCallback = undefined;
      };
    },
    createInteractiveSession: async (input) => {
      const selection = {
        transport: DEMO_TRANSPORT_ID,
        enabled: [],
        unavailableOptional: [],
        possibleEffects: [],
        effectsComplete: true,
      } as const;
      const turnId = '123e4567-e89b-42d3-a456-426614174002';
      const contentBlockId = '123e4567-e89b-42d3-a456-426614174003';
      const planBlockId = '123e4567-e89b-42d3-a456-426614174004';
      const planStepId = '123e4567-e89b-42d3-a456-426614174005';
      const readToolBlockId = '123e4567-e89b-42d3-a456-426614174006';
      const readToolCallId = '123e4567-e89b-42d3-a456-426614174007';
      const shellToolBlockId = '123e4567-e89b-42d3-a456-426614174008';
      const shellToolCallId = '123e4567-e89b-42d3-a456-426614174009';
      const startedAt = new Date().toISOString();

      window.setTimeout(() => {
        const timestamp = new Date().toISOString();
        interactiveEventCallback?.(interactiveSessionId, {
          type: 'session.started',
          sessionId: interactiveSessionId,
          executionId: interactiveExecutionId,
          sequence: 0,
          timestamp,
          provider: input.provider,
          transport: selection.transport,
          selection,
        });
        interactiveEventCallback?.(interactiveSessionId, {
          type: 'session.status',
          sessionId: interactiveSessionId,
          executionId: interactiveExecutionId,
          sequence: 1,
          timestamp,
          status: 'active',
        });
        interactiveEventCallback?.(interactiveSessionId, {
          type: 'turn.started',
          sessionId: interactiveSessionId,
          executionId: interactiveExecutionId,
          turnId,
          sequence: 2,
          timestamp,
        });
        interactiveEventCallback?.(interactiveSessionId, {
          type: 'content.delta',
          sessionId: interactiveSessionId,
          executionId: interactiveExecutionId,
          turnId,
          contentBlockId,
          sequence: 3,
          timestamp,
          delta:
            'AgentDock keeps provider authentication inside each installed CLI and applies one local approval policy.',
        });
        interactiveEventCallback?.(interactiveSessionId, {
          type: 'content.completed',
          sessionId: interactiveSessionId,
          executionId: interactiveExecutionId,
          turnId,
          sequence: 4,
          timestamp,
          block: {
            type: 'text',
            id: contentBlockId,
            text: 'AgentDock keeps provider authentication inside each installed CLI and applies one local approval policy.',
          },
        });
        interactiveEventCallback?.(interactiveSessionId, {
          type: 'content.completed',
          sessionId: interactiveSessionId,
          executionId: interactiveExecutionId,
          turnId,
          sequence: 5,
          timestamp,
          block: {
            type: 'plan',
            id: planBlockId,
            title: 'Verify the runtime boundary',
            steps: [
              { id: planStepId, text: 'Run focused security and renderer checks', status: 'completed' },
            ],
          },
        });
        interactiveEventCallback?.(interactiveSessionId, {
          type: 'tool.started',
          sessionId: interactiveSessionId,
          executionId: interactiveExecutionId,
          turnId,
          sequence: 6,
          timestamp,
          contentBlockId: readToolBlockId,
          toolCallId: readToolCallId,
          toolName: 'Read',
          possibleEffects: ['read'],
          effectsComplete: true,
        });
        interactiveEventCallback?.(interactiveSessionId, {
          type: 'tool.completed',
          sessionId: interactiveSessionId,
          executionId: interactiveExecutionId,
          turnId,
          sequence: 7,
          timestamp,
          contentBlockId: readToolBlockId,
          toolCallId: readToolCallId,
          toolName: 'Read',
          status: 'completed',
          summary: 'Read 3 files under packages/agent-runtime/src',
        });
        interactiveEventCallback?.(interactiveSessionId, {
          type: 'tool.started',
          sessionId: interactiveSessionId,
          executionId: interactiveExecutionId,
          turnId,
          sequence: 8,
          timestamp,
          contentBlockId: shellToolBlockId,
          toolCallId: shellToolCallId,
          toolName: 'shell',
          possibleEffects: ['command'],
          effectsComplete: true,
        });

        const interaction: RendererApprovalInteraction = {
          kind: 'approval',
          interactionHandle: DEMO_APPROVAL_HANDLE,
          title: 'Run shell command',
          action: 'command',
          target: 'pnpm test',
          possibleEffects: ['command'],
          effectsComplete: true,
          allowedDecisions: ['allow_once', 'deny'],
          deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        };
        interactionCallback?.(interactiveSessionId, interaction);
      }, 80);

      approvalContinuation = () => {
        const timestamp = new Date().toISOString();
        interactiveEventCallback?.(interactiveSessionId, {
          type: 'tool.completed',
          sessionId: interactiveSessionId,
          executionId: interactiveExecutionId,
          turnId,
          sequence: 9,
          timestamp,
          contentBlockId: shellToolBlockId,
          toolCallId: shellToolCallId,
          toolName: 'shell',
          status: 'completed',
          summary: 'Focused checks passed: 71 tests',
        });
        interactiveEventCallback?.(interactiveSessionId, {
          type: 'turn.completed',
          sessionId: interactiveSessionId,
          executionId: interactiveExecutionId,
          turnId,
          sequence: 10,
          timestamp,
        });
        interactiveEventCallback?.(interactiveSessionId, {
          type: 'usage.tokens',
          sessionId: interactiveSessionId,
          executionId: interactiveExecutionId,
          sequence: 11,
          timestamp,
          scope: 'session',
          inputTokens: 1842,
          outputTokens: 326,
        });
        interactiveEventCallback?.(interactiveSessionId, {
          type: 'session.completed',
          sessionId: interactiveSessionId,
          executionId: interactiveExecutionId,
          sequence: 12,
          timestamp,
        });
      };

      return {
        id: interactiveSessionId,
        provider: input.provider,
        transport: selection.transport,
        cwd: input.cwd,
        status: 'starting',
        selection,
        executionId: interactiveExecutionId,
        currentTurnId: turnId,
        acceptedWork: 'not_accepted',
        startedAt,
        earliestSequence: 0,
      };
    },
    listInteractiveSessions: async () => ({ sessions: [] }),
    readInteractiveSessionHistory: async () => ({ events: [] }),
    reconnectInteractiveSession: async () => {
      throw new Error('demo mode has no persisted session');
    },
    resumeInteractiveSession: async (_sessionId, input) =>
      bridge.createInteractiveSession({ provider: 'claude', cwd: DEMO_CWD, ...input }),
    forkInteractiveSession: async (_sessionId, input) =>
      bridge.createInteractiveSession({ provider: 'claude', cwd: DEMO_CWD, ...input }),
    deleteInteractiveSession: async () => {},
    sendSessionCommand: async (command) => ({
      status: 'accepted',
      commandId: '123e4567-e89b-42d3-a456-426614174004',
      sessionId: command.sessionId,
      turnId: command.turnId,
    }),
    respondApproval: async (interactionHandle, decision) => {
      if (interactionHandle === DEMO_APPROVAL_HANDLE) {
        window.setTimeout(() => {
          approvalContinuation?.();
          interactionResolvedCallback?.(interactiveSessionId, {
            interactionHandle,
            kind: 'approval_resolved',
            reason: decision === 'deny' ? 'denied' : 'allowed',
          });
        }, 80);
      }
      return { status: 'accepted' };
    },
    answerQuestions: async () => ({ status: 'accepted' }),
    cancelInteractiveSession: async (sessionId) => ({ status: 'cancelling', sessionId }),
    onInteractiveSessionEvent: (callback) => {
      interactiveEventCallback = callback;
      return () => {
        interactiveEventCallback = undefined;
      };
    },
    onInteractiveSessionStreamNotice: () => () => {},
    onInteractionRequested: (callback) => {
      interactionCallback = callback;
      return () => {
        interactionCallback = undefined;
      };
    },
    onInteractionResolved: (callback) => {
      interactionResolvedCallback = callback;
      return () => {
        interactionResolvedCallback = undefined;
      };
    },
    inspectWorkspace: async () => workspaceTrust,
    setWorkspaceTrust: async (_workspaceId, update) => ({ ...workspaceTrust, state: update.state }),
    readAudit: async () => ({ schemaVersion: 1, entries: [] }),
    selectDirectory: async () => DEMO_CWD,
  };

  Object.defineProperty(bridge, '__agentDockDemo', { value: true, enumerable: false });

  return bridge;
}
