import type { ProviderId } from './provider.js';

/**
 * Provider-neutral streaming event protocol. Every adapter in packages/agent-runtime normalizes
 * its CLI's native output into this union. Nothing above the agent-runtime package (the daemon,
 * the desktop UI) should ever branch on provider id to interpret an event.
 */
export type AgentEvent =
  | { type: 'session.started'; sessionId: string; provider: ProviderId; providerSessionId?: string }
  | { type: 'status'; status: string; detail?: string }
  | { type: 'assistant.delta'; text: string }
  | { type: 'assistant.message'; text: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'tool.started'; toolName: string; toolCallId?: string; input?: unknown }
  | { type: 'tool.completed'; toolName?: string; toolCallId?: string; result?: unknown; isError?: boolean }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      cost?: number;
    }
  | { type: 'error'; code?: string; message: string; recoverable: boolean }
  | { type: 'session.completed'; providerSessionId?: string }
  | { type: 'session.failed'; message: string }
  | { type: 'session.cancelled' };

export type AgentEventType = AgentEvent['type'];
