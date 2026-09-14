import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { AgentEventV2, CapabilitySelection } from '@agent-dock/shared';
import { describe, expect, it } from 'vitest';
import {
  ClaudeAgentSdkNormalizer,
  type ClaudeSdkInitExpectation,
} from '../src/providers/claude/sdk/normalizer.js';
import { CLAUDE_AGENT_SDK_CLAUDE_CODE_VERSION } from '../src/providers/claude/sdk-version.js';
import type { RawToolOutputV2 } from '../src/types.js';

const SELECTION: CapabilitySelection = {
  transport: 'claude-agent-sdk',
  enabled: [],
  unavailableOptional: [],
  possibleEffects: ['read', 'filesystem_write'],
  effectsComplete: true,
};

const EXPECTATION: ClaudeSdkInitExpectation = {
  cwd: resolve('.'),
  selection: SELECTION,
  authSource: 'api_key',
};

function initMessage() {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 'session-1',
    cwd: resolve('.'),
    claude_code_version: CLAUDE_AGENT_SDK_CLAUDE_CODE_VERSION,
    permissionMode: 'default',
    apiKeySource: 'ANTHROPIC_API_KEY',
    tools: [],
    mcp_servers: [],
    skills: [],
    plugins: [],
  };
}

/** Starts a session, opens a turn, and registers one `Bash` tool_use so a matching `tool_result`
 * can be delivered by the tests below (issue #132). */
function startedNormalizerWithTool(rawOutputs: RawToolOutputV2[]): {
  events: AgentEventV2[];
  normalizer: ClaudeAgentSdkNormalizer;
} {
  const events: AgentEventV2[] = [];
  const normalizer = new ClaudeAgentSdkNormalizer(
    EXPECTATION,
    (event) => events.push(event),
    (payload) => rawOutputs.push(payload),
  );
  normalizer.expectTurn('turn-1');
  normalizer.message(initMessage());
  normalizer.message({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      id: 'assistant-1',
      content: [{ type: 'tool_use', id: 'native-tool-1', name: 'Bash', input: {} }],
    },
  });
  return { events, normalizer };
}

function toolResultMessage(content: unknown, isError = false) {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'native-tool-1', is_error: isError, content }],
    },
  };
}

describe('ClaudeAgentSdkNormalizer raw tool output capture (issue #132)', () => {
  it('captures a plain string tool_result content as raw output alongside the existing synthetic summary', () => {
    const rawOutputs: RawToolOutputV2[] = [];
    const { events, normalizer } = startedNormalizerWithTool(rawOutputs);
    normalizer.message(toolResultMessage('hi\n'));
    const completed = events.find((event) => event.type === 'tool.completed');
    expect(completed).toMatchObject({ summary: 'Claude tool completed', status: 'completed' });
    expect(rawOutputs).toHaveLength(1);
    expect(rawOutputs[0]).toMatchObject({
      toolCallId: (completed as { toolCallId: string }).toolCallId,
      contentBlockId: (completed as { contentBlockId: string }).contentBlockId,
      mimeType: 'text/plain',
      preview: 'hi\n',
      previewTruncated: false,
      byteCount: 3,
      sha256: createHash('sha256').update('hi\n').digest('hex'),
    });
    expect(rawOutputs[0]!.bytes.toString('utf8')).toBe('hi\n');
  });

  it('captures an array of text content blocks joined as raw output', () => {
    const rawOutputs: RawToolOutputV2[] = [];
    const { events, normalizer } = startedNormalizerWithTool(rawOutputs);
    normalizer.message(
      toolResultMessage([
        { type: 'text', text: 'first part' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ignored' } },
        { type: 'text', text: 'second part' },
      ]),
    );
    expect(events.some((event) => event.type === 'tool.completed')).toBe(true);
    expect(rawOutputs).toHaveLength(1);
    expect(rawOutputs[0]!.mimeType).toBe('text/plain');
    expect(rawOutputs[0]!.bytes.toString('utf8')).toBe('first part\n\nsecond part');
  });

  it('marks the preview truncated only once real content exceeds the 4,096-byte preview bound (exact threshold vs threshold+1)', () => {
    for (const [length, expectTruncated] of [
      [4_096, false],
      [4_097, true],
    ] as const) {
      const rawOutputs: RawToolOutputV2[] = [];
      const { normalizer } = startedNormalizerWithTool(rawOutputs);
      normalizer.message(toolResultMessage('x'.repeat(length)));
      expect(rawOutputs).toHaveLength(1);
      expect(rawOutputs[0]!.previewTruncated).toBe(expectTruncated);
      expect(Buffer.byteLength(rawOutputs[0]!.preview, 'utf8')).toBeLessThanOrEqual(4_096);
      expect(rawOutputs[0]!.byteCount).toBe(length);
    }
  });

  it('drops raw output gracefully once content exceeds the attachment store byte cap, leaving the tool.completed event unaffected', () => {
    const rawOutputs: RawToolOutputV2[] = [];
    const { events, normalizer } = startedNormalizerWithTool(rawOutputs);
    normalizer.message(toolResultMessage('x'.repeat(25 * 1024 * 1024 + 1)));
    expect(rawOutputs).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool.completed', status: 'completed' }),
    );
  });

  it('captures nothing when the tool_result carries no content', () => {
    const rawOutputs: RawToolOutputV2[] = [];
    const { events, normalizer } = startedNormalizerWithTool(rawOutputs);
    normalizer.message(toolResultMessage(undefined));
    expect(rawOutputs).toHaveLength(0);
    expect(events.some((event) => event.type === 'tool.completed')).toBe(true);
  });

  it('never captures raw output when the caller supplies no emitRawToolOutput callback', () => {
    const events: AgentEventV2[] = [];
    const normalizer = new ClaudeAgentSdkNormalizer(EXPECTATION, (event) => events.push(event));
    normalizer.expectTurn('turn-1');
    normalizer.message(initMessage());
    normalizer.message({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'assistant-1',
        content: [{ type: 'tool_use', id: 'native-tool-1', name: 'Bash', input: {} }],
      },
    });
    expect(() => normalizer.message(toolResultMessage('hi\n'))).not.toThrow();
    expect(events.some((event) => event.type === 'tool.completed')).toBe(true);
  });

  it('captures the failed-tool synthetic summary alongside real content when is_error is true', () => {
    const rawOutputs: RawToolOutputV2[] = [];
    const { events, normalizer } = startedNormalizerWithTool(rawOutputs);
    normalizer.message(toolResultMessage('boom', true));
    const completed = events.find((event) => event.type === 'tool.completed');
    expect(completed).toMatchObject({ summary: 'Claude tool failed', status: 'failed' });
    expect(rawOutputs).toHaveLength(1);
    expect(rawOutputs[0]!.bytes.toString('utf8')).toBe('boom');
  });
});
