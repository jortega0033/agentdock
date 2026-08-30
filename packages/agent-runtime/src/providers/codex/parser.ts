import type { AgentEvent } from '@agent-dock/shared';
import type { Logger } from '../../logger.js';
import type { ParsedLine } from '../common/run-session.js';

interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
}

function usageEvent(usage: unknown): AgentEvent | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as CodexUsage;
  return {
    type: 'usage',
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cachedInputTokens: u.cached_input_tokens,
  };
}

function itemEvent(kind: 'started' | 'completed', item: Record<string, unknown>): AgentEvent | undefined {
  const id = typeof item.id === 'string' ? item.id : undefined;
  const status = typeof item.status === 'string' ? item.status : undefined;
  const isError = status === 'failed';

  switch (item.type) {
    case 'agent_message':
      if (kind === 'completed' && typeof item.text === 'string' && item.text.length > 0) {
        return { type: 'assistant.message', text: item.text };
      }
      return undefined;
    case 'reasoning':
      if (typeof item.text === 'string' && item.text.length > 0) {
        return { type: 'thinking.delta', text: item.text };
      }
      return undefined;
    case 'error':
      // Codex surfaces item-level "error" entries for non-fatal warnings too (e.g. a config
      // quirk); the turn keeps going and can still complete successfully after one. A genuinely
      // fatal error comes through as turn.failed instead, so this is marked recoverable.
      if (kind === 'completed') {
        return {
          type: 'error',
          message: typeof item.message === 'string' ? item.message : 'Codex reported an error',
          recoverable: true,
        };
      }
      return undefined;
    case 'command_execution':
      return kind === 'started'
        ? { type: 'tool.started', toolName: 'shell', toolCallId: id, input: { command: item.command } }
        : {
            type: 'tool.completed',
            toolName: 'shell',
            toolCallId: id,
            result: { command: item.command, output: item.aggregated_output, exitCode: item.exit_code },
            isError,
          };
    case 'file_change':
      return kind === 'started'
        ? { type: 'tool.started', toolName: 'file_change', toolCallId: id, input: { changes: item.changes } }
        : { type: 'tool.completed', toolName: 'file_change', toolCallId: id, result: { changes: item.changes }, isError };
    case 'mcp_tool_call':
      return kind === 'started'
        ? { type: 'tool.started', toolName: typeof item.tool === 'string' ? item.tool : 'mcp_tool', toolCallId: id, input: item.arguments }
        : {
            type: 'tool.completed',
            toolName: typeof item.tool === 'string' ? item.tool : 'mcp_tool',
            toolCallId: id,
            result: item.result,
            isError,
          };
    default:
      return undefined;
  }
}

/** Parses one line of `codex exec --json` output into normalized events. */
export function parseCodexLine(raw: unknown, logger: Logger): ParsedLine {
  if (!raw || typeof raw !== 'object') return { events: [] };
  const obj = raw as Record<string, unknown>;

  switch (obj.type) {
    case 'thread.started': {
      const threadId = typeof obj.thread_id === 'string' ? obj.thread_id : undefined;
      return { events: [{ type: 'status', status: 'thread_started' }], providerSessionId: threadId };
    }
    case 'turn.started':
      return { events: [{ type: 'status', status: 'turn_started' }] };
    case 'item.started': {
      const item = obj.item as Record<string, unknown> | undefined;
      if (!item) return { events: [] };
      const event = itemEvent('started', item);
      return { events: event ? [event] : [] };
    }
    case 'item.completed': {
      const item = obj.item as Record<string, unknown> | undefined;
      if (!item) return { events: [] };
      const event = itemEvent('completed', item);
      return { events: event ? [event] : [] };
    }
    case 'turn.completed': {
      const usage = usageEvent(obj.usage);
      return { events: usage ? [usage] : [] };
    }
    case 'turn.failed': {
      const error = obj.error as Record<string, unknown> | undefined;
      const message = typeof error?.message === 'string' ? error.message : 'Codex turn failed';
      return { events: [{ type: 'error', message, recoverable: false }] };
    }
    default:
      logger.debug('codex: unrecognized event type', { eventType: String(obj.type) });
      return { events: [] };
  }
}
