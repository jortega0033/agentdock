import type { AgentEvent } from '@agent-dock/shared';
import type { Logger } from '../../logger.js';
import type { ParsedLine } from '../common/run-session.js';
import { safeDisplay } from '../common/safe-display.js';

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

function usageEvent(usage: unknown, cost?: unknown): AgentEvent | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as ClaudeUsage;
  return {
    type: 'usage',
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cachedInputTokens: u.cache_read_input_tokens,
    cost: typeof cost === 'number' ? cost : undefined,
  };
}

function parseContentBlocks(content: unknown): AgentEvent[] {
  if (!Array.isArray(content)) return [];
  const events: AgentEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string' && b.text.length > 0) {
          events.push({ type: 'assistant.message', text: b.text });
        }
        break;
      case 'thinking':
        if (typeof b.thinking === 'string' && b.thinking.length > 0) {
          events.push({ type: 'thinking.delta', text: b.thinking });
        }
        break;
      case 'tool_use':
        events.push({
          type: 'tool.started',
          toolName: typeof b.name === 'string' ? b.name : 'unknown',
          toolCallId: typeof b.id === 'string' ? b.id : undefined,
          input: b.input,
        });
        break;
      case 'tool_result':
        events.push({
          type: 'tool.completed',
          toolCallId: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined,
          result: b.content,
          isError: b.is_error === true,
        });
        break;
      default:
        break;
    }
  }
  return events;
}

/** Parses one line of `claude -p --output-format stream-json` output into normalized events. */
export function parseClaudeLine(raw: unknown, logger: Logger): ParsedLine {
  if (!raw || typeof raw !== 'object') return { events: [] };
  const obj = raw as Record<string, unknown>;

  switch (obj.type) {
    case 'system': {
      if (obj.subtype === 'init') {
        const sessionId = typeof obj.session_id === 'string' ? obj.session_id : undefined;
        return { events: [{ type: 'status', status: 'initialized' }], providerSessionId: sessionId };
      }
      return { events: [] };
    }
    case 'assistant':
    case 'user': {
      const message = obj.message as Record<string, unknown> | undefined;
      if (!message) return { events: [] };
      const events = parseContentBlocks(message.content);
      const usage = usageEvent(message.usage);
      if (usage) events.push(usage);
      return { events };
    }
    case 'result': {
      const events: AgentEvent[] = [];
      if (obj.is_error === true) {
        events.push({
          type: 'error',
          code: typeof obj.subtype === 'string' ? obj.subtype : undefined,
          message: typeof obj.result === 'string' ? obj.result : 'Claude Code reported an error result',
          recoverable: false,
        });
      }
      const usage = usageEvent(obj.usage, obj.total_cost_usd);
      if (usage) events.push(usage);
      const sessionId = typeof obj.session_id === 'string' ? obj.session_id : undefined;
      return { events, providerSessionId: sessionId };
    }
    default:
      // eventType is provider-controlled (an arbitrary field from parsed CLI stdout) -- bounded
      // and control-character-stripped before it ever reaches a log line (issue #67).
      logger.debug('claude: unrecognized event type', {
        eventType: safeDisplay(obj.type, 128, 'unknown'),
      });
      return { events: [] };
  }
}
