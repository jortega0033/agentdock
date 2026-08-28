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

/**
 * Ordering/correlation metadata the daemon stamps onto an AgentEvent when it records and
 * broadcasts one — never something a provider adapter produces itself. `sequence` is a
 * per-session, zero-based, monotonically increasing index (it *is* the SSE `id:` field on the
 * wire, and what `Last-Event-ID`-based reconnection resumes from); `timestamp` is when the daemon
 * observed the event, not when the provider CLI produced it.
 */
export interface AgentEventMeta {
  sequence: number;
  timestamp: string;
}

/**
 * What actually crosses the daemon → client boundary: a normalized AgentEvent plus the ordering
 * metadata above, flattened into one object. This is the protocol v1 wire/public shape — see
 * docs/protocol-v1.md#ordering-guarantees for the ordering guarantees every session's event stream
 * upholds (exactly one terminal event, always last; nothing emitted after it).
 */
export type AgentEventEnvelope = AgentEvent & AgentEventMeta;
