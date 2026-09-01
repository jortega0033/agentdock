import type {
  AgentEvent,
  AgentEventV2Envelope,
  AgentSession,
  ProviderStatus,
  ProviderStatusV2,
  WorkspaceTrustViewV2,
} from '@agent-dock/shared';
import { PROVIDER_DISPLAY_NAMES } from '@agent-dock/shared';
import type { AgentDockBridge } from './window.js';

/** Documentation screenshots must never present fictitious data as real: every version here is
 * the actual pinned/verified provider version from `compatibility-manifest.ts` and
 * `sdk-version.ts`, and is suffixed "(demo)" so a reader can never mistake this fixture-driven
 * capture for a live provider read. */
const DEMO_TRANSPORT_ID = 'demo-interactive';

const providers: ProviderStatus[] = [
  {
    id: 'claude',
    name: PROVIDER_DISPLAY_NAMES.claude,
    installed: true,
    authenticated: 'authenticated',
    version: '2.1.251 (demo)',
    capabilities: { resume: true, cancellation: true, tools: true, usage: true, thinking: true },
  },
  {
    id: 'codex',
    name: PROVIDER_DISPLAY_NAMES.codex,
    installed: true,
    authenticated: 'authenticated',
    version: '0.147.0 (demo)',
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
      id: DEMO_TRANSPORT_ID,
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
    listMcpServers: async () => ({ servers: [], revision: 'asset-capture-1' }),
    configureMcpServer: async () => ({ servers: [], revision: 'asset-capture-1' }),
    actionMcpServer: async () => ({ servers: [], revision: 'asset-capture-1' }),
    getMcpCatalog: async (_provider, serverId) => ({ serverId, items: [], revision: 'asset-capture-1' }),
    startMcpOAuth: async (_provider, serverId) => ({ serverId, status: 'unsupported' }),
    invokeMcpTool: async (input) => ({ serverId: input.serverId, toolId: input.toolId, status: 'failed', safeSummary: 'Unavailable in asset capture' }),
    listProviderComponents: async () => ({ items: [], revision: 'asset-capture-1' }),
    manageProviderComponent: async (input) => ({ componentId: input.componentId, status: 'unsupported' }),
    invokeProviderComponent: async (input) => ({ componentId: input.componentId, status: 'unsupported' }),
    getSubagentGraph: async (sessionId) => ({ sessionId, nodes: [] }),
    controlSubagent: async (input) => ({ sessionId: input.sessionId, agentId: input.agentId, status: 'unsupported' }),
    previewWorktree: async (input) => ({ workspaceId: 'a'.repeat(64), name: input.name, displayTarget: input.name, includeFiles: [], ignoredFiles: [], secretRisk: false, requiresConfirmation: true }),
    createWorktree: async (input) => ({ id: '123e4567-e89b-42d3-a456-426614174099', workspaceId: 'a'.repeat(64), name: input.name, displayPath: input.name, status: 'ready', createdAt: '2026-01-01T00:00:00.000Z' }),
    listWorktrees: async () => [],
    cleanupWorktree: async (worktreeId) => ({ id: worktreeId, workspaceId: 'a'.repeat(64), name: 'worktree', displayPath: 'worktree', status: 'missing', createdAt: '2026-01-01T00:00:00.000Z' }),
    selectAndUploadAttachments: async () => [],
    validateStructuredOutput: async (input) => ({ valid: true, normalizedOutput: input.output, errors: [] }),
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
      const toolContentBlockId = '123e4567-e89b-42d3-a456-426614174006';
      const toolCallId = '123e4567-e89b-42d3-a456-426614174007';
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
                {
                  id: planStepId,
                  text: 'Run focused security and renderer checks',
                  status: 'completed',
                },
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
            contentBlockId: toolContentBlockId,
            toolCallId,
            toolName: 'shell',
            possibleEffects: ['command'],
            effectsComplete: true,
          });
          interactiveEventCallback?.(interactiveSessionId, {
            type: 'tool.completed',
            sessionId: interactiveSessionId,
            executionId: interactiveExecutionId,
            turnId,
            sequence: 7,
            timestamp,
            contentBlockId: toolContentBlockId,
            toolCallId,
            toolName: 'shell',
            status: 'completed',
            summary: 'Focused checks passed: 71 tests',
          });
          interactiveEventCallback?.(interactiveSessionId, {
            type: 'turn.completed',
            sessionId: interactiveSessionId,
            executionId: interactiveExecutionId,
            turnId,
            sequence: 8,
            timestamp,
          });
          interactiveEventCallback?.(interactiveSessionId, {
            type: 'usage.tokens',
            sessionId: interactiveSessionId,
            executionId: interactiveExecutionId,
            sequence: 9,
            timestamp,
            scope: 'session',
            inputTokens: 1842,
            outputTokens: 326,
          });
          interactiveEventCallback?.(interactiveSessionId, {
            type: 'session.completed',
            sessionId: interactiveSessionId,
            executionId: interactiveExecutionId,
            sequence: 10,
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
    listInteractiveSessions: async () => ({ sessions: [] }),
    readInteractiveSessionHistory: async () => ({ events: [] }),
    reconnectInteractiveSession: async () => {
      throw new Error('asset capture has no persisted session');
    },
    resumeInteractiveSession: async (_sessionId, input) =>
      bridge.createInteractiveSession({
        provider: 'claude',
        cwd: 'C:\\workspace\\agent-dock',
        ...input,
      }),
    forkInteractiveSession: async (_sessionId, input) =>
      bridge.createInteractiveSession({
        provider: 'claude',
        cwd: 'C:\\workspace\\agent-dock',
        ...input,
      }),
    deleteInteractiveSession: async () => {},
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
