import { describe, expect, it } from 'vitest';
import { noopLogger } from '../src/logger.js';
import { parseClaudeLine } from '../src/providers/claude/parser.js';

describe('parseClaudeLine', () => {
  it('captures the provider session id from the init event', () => {
    const result = parseClaudeLine(
      { type: 'system', subtype: 'init', session_id: 'abc-123' },
      noopLogger,
    );
    expect(result.providerSessionId).toBe('abc-123');
    expect(result.events).toEqual([{ type: 'status', status: 'initialized' }]);
  });

  it('ignores non-init system messages', () => {
    const result = parseClaudeLine({ type: 'system', subtype: 'hook_started' }, noopLogger);
    expect(result.events).toEqual([]);
  });

  it('turns assistant text blocks into assistant.message', () => {
    const result = parseClaudeLine(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi there' }] } },
      noopLogger,
    );
    expect(result.events).toEqual([{ type: 'assistant.message', text: 'hi there' }]);
  });

  it('turns thinking blocks into thinking.delta', () => {
    const result = parseClaudeLine(
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'pondering' }] } },
      noopLogger,
    );
    expect(result.events).toEqual([{ type: 'thinking.delta', text: 'pondering' }]);
  });

  it('turns tool_use blocks into tool.started', () => {
    const result = parseClaudeLine(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }] },
      },
      noopLogger,
    );
    expect(result.events).toEqual([
      { type: 'tool.started', toolName: 'Bash', toolCallId: 'call_1', input: { command: 'ls' } },
    ]);
  });

  it('turns tool_result blocks (in user messages) into tool.completed', () => {
    const result = parseClaudeLine(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ls output', is_error: false }],
        },
      },
      noopLogger,
    );
    expect(result.events).toEqual([
      { type: 'tool.completed', toolCallId: 'call_1', result: 'ls output', isError: false },
    ]);
  });

  it('emits usage alongside message content when present', () => {
    const result = parseClaudeLine(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1 },
        },
      },
      noopLogger,
    );
    expect(result.events).toEqual([
      { type: 'assistant.message', text: 'hi' },
      { type: 'usage', inputTokens: 5, outputTokens: 2, cachedInputTokens: 1, cost: undefined },
    ]);
  });

  it('maps a successful result event to a usage event and the final session id', () => {
    const result = parseClaudeLine(
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        total_cost_usd: 0.42,
        usage: { input_tokens: 100, output_tokens: 50 },
        session_id: 'abc-123',
      },
      noopLogger,
    );
    expect(result.providerSessionId).toBe('abc-123');
    expect(result.events).toEqual([
      { type: 'usage', inputTokens: 100, outputTokens: 50, cachedInputTokens: undefined, cost: 0.42 },
    ]);
  });

  it('maps an error result event to an error event', () => {
    const result = parseClaudeLine(
      { type: 'result', subtype: 'error_max_turns', is_error: true, result: 'ran out of turns' },
      noopLogger,
    );
    expect(result.events).toEqual([
      { type: 'error', code: 'error_max_turns', message: 'ran out of turns', recoverable: false },
    ]);
  });

  it('ignores unrecognized top-level event types', () => {
    const result = parseClaudeLine({ type: 'rate_limit_event' }, noopLogger);
    expect(result.events).toEqual([]);
  });

  it('bounds and strips control characters from an unrecognized event type before logging it (issue #67)', () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const spyLogger = {
      debug: (message: string, meta?: Record<string, unknown>) => calls.push([message, meta]),
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    parseClaudeLine(
      { type: `evil\ntype\rwith${String.fromCharCode(0)}control${String.fromCharCode(0x1b)}chars${'x'.repeat(200)}` },
      spyLogger,
    );
    expect(calls).toHaveLength(1);
    const eventType = calls[0]![1]!.eventType as string;
    expect(Array.from(eventType).every((character) => character.codePointAt(0)! > 0x1f)).toBe(true);
    expect(Buffer.byteLength(eventType, 'utf8')).toBeLessThanOrEqual(128);
  });

  it('ignores malformed input without throwing', () => {
    expect(parseClaudeLine(null, noopLogger).events).toEqual([]);
    expect(parseClaudeLine('a string', noopLogger).events).toEqual([]);
    expect(parseClaudeLine(42, noopLogger).events).toEqual([]);
  });
});
