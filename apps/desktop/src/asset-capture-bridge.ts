import type { AgentEvent, AgentSession, ProviderStatus } from '@agent-dock/shared';
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

/** Development-only deterministic bridge for capturing documentation screenshots. */
export function installAssetCaptureBridge(): void {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') ?? 'ready';
  if (params.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';

  let eventCallback: ((sessionId: string, event: AgentEvent) => void) | undefined;
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
    selectDirectory: async () => 'C:\\workspace\\agent-dock',
  };

  window.agentDock = bridge;
}
