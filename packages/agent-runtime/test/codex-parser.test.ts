import { describe, expect, it } from 'vitest';
import { noopLogger } from '../src/logger.js';
import { parseCodexLine } from '../src/providers/codex/parser.js';

describe('parseCodexLine', () => {
  it('captures the thread id from thread.started', () => {
    const result = parseCodexLine({ type: 'thread.started', thread_id: 'thread-1' }, noopLogger);
    expect(result.providerSessionId).toBe('thread-1');
    expect(result.events).toEqual([{ type: 'status', status: 'thread_started' }]);
  });

  it('maps turn.started to a status event', () => {
    const result = parseCodexLine({ type: 'turn.started' }, noopLogger);
    expect(result.events).toEqual([{ type: 'status', status: 'turn_started' }]);
  });

  it('maps a started command_execution item to tool.started', () => {
    const result = parseCodexLine(
      {
        type: 'item.started',
        item: { id: 'item_0', type: 'command_execution', command: 'echo hi', status: 'in_progress' },
      },
      noopLogger,
    );
    expect(result.events).toEqual([
      { type: 'tool.started', toolName: 'shell', toolCallId: 'item_0', input: { command: 'echo hi' } },
    ]);
  });

  it('maps a completed command_execution item to tool.completed', () => {
    const result = parseCodexLine(
      {
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'command_execution',
          command: 'echo hi',
          aggregated_output: 'hi\n',
          exit_code: 0,
          status: 'completed',
        },
      },
      noopLogger,
    );
    expect(result.events).toEqual([
      {
        type: 'tool.completed',
        toolName: 'shell',
        toolCallId: 'item_0',
        result: { command: 'echo hi', output: 'hi\n', exitCode: 0 },
        isError: false,
      },
    ]);
  });

  it('marks a failed command_execution item as isError', () => {
    const result = parseCodexLine(
      {
        type: 'item.completed',
        item: { id: 'item_0', type: 'command_execution', status: 'failed', exit_code: -1 },
      },
      noopLogger,
    );
    expect(result.events[0]).toMatchObject({ type: 'tool.completed', isError: true });
  });

  it('maps a completed agent_message item to assistant.message', () => {
    const result = parseCodexLine(
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'done' } },
      noopLogger,
    );
    expect(result.events).toEqual([{ type: 'assistant.message', text: 'done' }]);
  });

  it('maps turn.completed usage to a usage event', () => {
    const result = parseCodexLine(
      { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 6, cached_input_tokens: 2 } },
      noopLogger,
    );
    expect(result.events).toEqual([
      { type: 'usage', inputTokens: 20, outputTokens: 6, cachedInputTokens: 2 },
    ]);
  });

  it('marks a completed item-level error as recoverable, since the turn can still finish', () => {
    const result = parseCodexLine(
      { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'config warning' } },
      noopLogger,
    );
    expect(result.events).toEqual([{ type: 'error', message: 'config warning', recoverable: true }]);
  });

  it('maps turn.failed to an error event', () => {
    const result = parseCodexLine(
      { type: 'turn.failed', error: { message: 'boom' } },
      noopLogger,
    );
    expect(result.events).toEqual([{ type: 'error', message: 'boom', recoverable: false }]);
  });

  it('ignores unrecognized event types', () => {
    expect(parseCodexLine({ type: 'something.new' }, noopLogger).events).toEqual([]);
  });

  it('ignores malformed input without throwing', () => {
    expect(parseCodexLine(null, noopLogger).events).toEqual([]);
    expect(parseCodexLine([1, 2, 3], noopLogger).events).toEqual([]);
  });
});
