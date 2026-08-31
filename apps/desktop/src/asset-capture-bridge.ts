import type {
  AgentEvent,
  AgentEventV2Envelope,
  AgentSession,
  ProviderStatus,
  ProviderStatusV2,
  WorkspaceTrustViewV2,
} from '@agent-dock/shared';
import type { AgentDockBridge } from './window.js';

const providers: ProviderStatus[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    installed: true,
    authenticated: 'authenticated',
    version: '2.4.1',
    capabilities: { resume: true, cancellation: true, tools: true, usage: true, thinking: true },
  },
  {
    id: 'codex',
    name: 'Codex',
    installed: true,
    authenticated: 'authenticated',
    version: '1.9.0',
    capabilities: { resume: true, cancellation: true, tools: true, usage: true },
  },
];

const providersV2: ProviderStatusV2[] = providers.map((provider) => ({
  id: provider.id,
  name: provider.name,
  installed: provider.installed,
  authenticated: provider.authenticated,
  transports: [
    {
      id: 'asset-capture-interactive',
      priority: 0,
      stability: 'stable',
      possibleEffects: ['read', 'filesystem_write', 'command'],
      effectsComplete: true,
    },
  ],
  capabilities: [],
  sandbox: {
    providerId: provider.id,
    platform: 'win32',
    provider: { mechanism: 'provider_policy', state: 'unknown', evidence: [] },
    agentDock: {
      mechanism: 'agentdock_policy',
      state: 'enforced',
      evidence: [
        {
          kind: 'fixture',
          reference: 'asset-capture',
          verifiedAt: '2026-08-30T12:00:00.000Z',
        },
      ],
    },
    os: { mechanism: 'os_sandbox', state: 'unavailable', evidence: [] },
    badge: 'restricted_by_policy',
  },
  ...(provider.version === undefined ? {} : { version: provider.version }),
}));

const workspaceTrust: WorkspaceTrustViewV2 = {
  schemaVersion: 1,
  workspaceId: 'a'.repeat(64),
  incarnation: 'b'.repeat(64),
  displayName: 'agent-dock',
  reusable: true,
  state: 'trusted',
};

/** Development-only deterministic bridge for capturing documentation screenshots. */
export function installAssetCaptureBridge(): void {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') ?? 'ready';
  if (params.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';

  let eventCallback: ((sessionId: string, event: AgentEvent) => void) | undefined;
  let interactiveEventCallback:
    ((sessionId: string, event: AgentEventV2Envelope) => void) | undefined;
  const interactiveSessionId = '123e4567-e89b-42d3-a456-426614174000';
  const interactiveExecutionId = '123e4567-e89b-42d3-a456-426614174001';
  const session: AgentSession = {
    id: 'session-docs-001',
    provider: 'claude',
    cwd: 'C:\\workspace\\agent-dock',
    prompt: 'Review the runtime boundary and summarize the package architecture.',
    status: 'starting',
    startedAt: '2026-08-30T12:00:00.000Z',
  };

  const bridge: AgentDockBridge = {
    getDaemonStatus: async () =>
      mode === 'unavailable'
        ? {
            state: 'unavailable',
            error: 'local daemon could not start; verify the packaged runtime',
          }
        : { state: 'ready' },
    onDaemonStatus: () => () => {},
    listProviders: async () => providers,
    listProvidersV2: async () => providersV2,
    createSession: async () => {
      window.setTimeout(() => {
        eventCallback?.(session.id, {
          type: 'session.started',
          sessionId: session.id,
          provider: 'claude',
        });
        eventCallback?.(session.id, {
          type: 'status',
          status: 'running',
          detail: 'Inspecting workspace boundaries',
        });
        eventCallback?.(session.id, {
          type: 'tool.started',
          toolName: 'Read',
          toolCallId: 'tool-docs-1',
        });
        eventCallback?.(session.id, {
          type: 'assistant.message',
          text: 'AgentDock keeps provider authentication inside each installed CLI and normalizes session events through one typed local protocol.',
        });
        if (mode === 'completed') {
          eventCallback?.(session.id, {
            type: 'tool.completed',
            toolName: 'Read',
            toolCallId: 'tool-docs-1',
          });
          eventCallback?.(session.id, { type: 'usage', inputTokens: 1842, outputTokens: 326 });
          eventCallback?.(session.id, { type: 'session.completed' });
        }
      }, 80);
      return session;
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
        transport: 'asset-capture-interactive',
        enabled: [],
        unavailableOptional: [],
        possibleEffects: [],
        effectsComplete: true,
      } as const;
      const turnId = '123e4567-e89b-42d3-a456-426614174002';
      const contentBlockId = '123e4567-e89b-42d3-a456-426614174003';
      const timestamp = '2026-08-30T12:00:00.000Z';
      window.setTimeout(() => {
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
        if (mode === 'completed') {
          interactiveEventCallback?.(interactiveSessionId, {
            type: 'turn.completed',
            sessionId: interactiveSessionId,
            executionId: interactiveExecutionId,
            turnId,
            sequence: 4,
            timestamp,
          });
          interactiveEventCallback?.(interactiveSessionId, {
            type: 'usage.tokens',
            sessionId: interactiveSessionId,
            executionId: interactiveExecutionId,
            sequence: 5,
            timestamp,
            scope: 'session',
            inputTokens: 1842,
            outputTokens: 326,
          });
          interactiveEventCallback?.(interactiveSessionId, {
            type: 'session.completed',
            sessionId: interactiveSessionId,
            executionId: interactiveExecutionId,
            sequence: 6,
            timestamp,
          });
        }
      }, 80);
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
        startedAt: timestamp,
        earliestSequence: 0,
      };
    },
    sendSessionCommand: async (command) => ({
      status: 'accepted',
      commandId: '123e4567-e89b-42d3-a456-426614174004',
      sessionId: command.sessionId,
      turnId: command.turnId,
    }),
    respondApproval: async () => ({ status: 'accepted' }),
    answerQuestions: async () => ({ status: 'accepted' }),
    cancelInteractiveSession: async (sessionId) => ({ status: 'cancelling', sessionId }),
    onInteractiveSessionEvent: (callback) => {
      interactiveEventCallback = callback;
      return () => {
        interactiveEventCallback = undefined;
      };
    },
    onInteractiveSessionStreamNotice: () => () => {},
    onInteractionRequested: () => () => {},
    onInteractionResolved: () => () => {},
    inspectWorkspace: async () => workspaceTrust,
    setWorkspaceTrust: async (_workspaceId, update) => ({
      ...workspaceTrust,
      state: update.state,
    }),
    readAudit: async () => ({ schemaVersion: 1, entries: [] }),
    selectDirectory: async () => 'C:\\workspace\\agent-dock',
  };

  window.agentDock = bridge;
}
