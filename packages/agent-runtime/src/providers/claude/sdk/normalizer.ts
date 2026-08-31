import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { AgentEventV2, AuthSource, CapabilitySelection, Effect } from '@agent-dock/shared';
import { boundedDisplay, ClaudeAgentSdkProtocolError, nativeId, object } from './errors.js';
import { CLAUDE_AGENT_SDK_CLAUDE_CODE_VERSION } from '../sdk-version.js';

interface ToolIdentity {
  contentBlockId: string;
  toolCallId: string;
  name: string;
  completed: boolean;
}

interface ContentIdentity {
  contentBlockId: string;
  kind: 'text' | 'thinking' | 'tool';
  completed: boolean;
}

export interface ClaudeSdkInitExpectation {
  cwd: string;
  selection: CapabilitySelection;
  authSource?: AuthSource;
  model?: string;
  allowedTools?: readonly string[];
  requireEmptyMcp?: boolean;
  requireIsolatedExtensions?: boolean;
}

const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_TRACKED_ITEMS = 10_000;

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function toolEffects(name: string): { possibleEffects: Effect[]; effectsComplete: boolean } {
  if (['Read', 'Glob', 'Grep'].includes(name)) {
    return { possibleEffects: ['read'], effectsComplete: true };
  }
  if (['Edit', 'Write', 'NotebookEdit'].includes(name)) {
    return { possibleEffects: ['filesystem_write'], effectsComplete: true };
  }
  if (name === 'Bash') return { possibleEffects: ['command'], effectsComplete: false };
  if (['WebFetch', 'WebSearch'].includes(name)) {
    return { possibleEffects: ['network'], effectsComplete: true };
  }
  return { possibleEffects: ['external_side_effect'], effectsComplete: false };
}

function normalizedToolName(value: unknown): string {
  return boundedDisplay(value, 256, 'unknown_tool');
}

/** Strict stateful projection from native SDK messages to bounded Agent Dock events. */
export class ClaudeAgentSdkNormalizer {
  private providerSessionIdValue: string | undefined;
  private pendingTurnId: string | undefined;
  private activeTurnId: string | undefined;
  private currentMessageId: string | undefined;
  private cumulativeCost = 0;
  private cumulativeInputTokens = 0;
  private cumulativeOutputTokens = 0;
  private cumulativeCachedInputTokens = 0;
  private thinkingSummarized = false;
  private readonly content = new Map<string, ContentIdentity>();
  private readonly tools = new Map<string, ToolIdentity>();

  constructor(
    private readonly expectation: ClaudeSdkInitExpectation,
    private readonly emit: (event: AgentEventV2) => void,
  ) {}

  get providerSessionId(): string | undefined {
    return this.providerSessionIdValue;
  }

  get activeTurn(): string | undefined {
    return this.activeTurnId;
  }

  expectTurn(turnId: string): void {
    if (this.pendingTurnId || this.activeTurnId) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_state_invalid',
        'Cannot start another Claude turn',
      );
    }
    this.pendingTurnId = nativeId(turnId, 'turn id');
    this.thinkingSummarized = false;
  }

  message(raw: unknown): void {
    const message = object(raw, 'Claude SDK message');
    if (message.type === 'system' && message.subtype === 'init') {
      this.initialize(message);
      return;
    }
    if (message.type === 'stream_event') {
      this.partial(message);
      return;
    }
    if (message.type === 'assistant') {
      this.assistant(message);
      return;
    }
    if (message.type === 'user') {
      this.user(message);
      return;
    }
    if (message.type === 'result') {
      this.result(message);
      return;
    }
    if (message.type === 'system' && message.subtype === 'thinking_tokens') {
      this.summarizeThinking();
      return;
    }
    if (message.type === 'tool_progress' || message.type === 'tool_use_summary') return;
    if (this.providerSessionIdValue) {
      this.emit({
        type: 'extension.summary',
        ...(this.activeTurnId ? { turnId: this.activeTurnId } : {}),
        extensionName: 'claude.sdk.message',
        summary: 'Unsupported Claude SDK message omitted',
        reason: 'unsupported',
      });
    }
  }

  private initialize(message: Record<string, unknown>): void {
    const sessionId = nativeId(message.session_id, 'Claude session id');
    if (!samePath(String(message.cwd ?? ''), this.expectation.cwd)) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_scope_changed',
        'Claude SDK effective workspace changed',
      );
    }
    if (this.expectation.model && message.model !== this.expectation.model) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_scope_changed',
        'Claude SDK effective model changed',
      );
    }
    if (message.claude_code_version !== CLAUDE_AGENT_SDK_CLAUDE_CODE_VERSION) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_scope_changed',
        'Claude SDK executable version changed',
      );
    }
    if (message.permissionMode !== 'default') {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_scope_changed',
        'Claude SDK permission mode changed',
      );
    }
    if (
      message.agents !== undefined &&
      (!Array.isArray(message.agents) || message.agents.length !== 0)
    ) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_scope_changed',
        'Claude SDK enabled an unexpected agent',
      );
    }
    const expectedApiKeySource =
      this.expectation.authSource === 'api_key'
        ? 'ANTHROPIC_API_KEY'
        : ['bedrock', 'vertex', 'foundry'].includes(this.expectation.authSource ?? '')
          ? 'none'
          : undefined;
    if (expectedApiKeySource === undefined || message.apiKeySource !== expectedApiKeySource) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_auth_scope_changed',
        'Claude SDK authentication source changed',
      );
    }
    if (this.expectation.allowedTools) {
      if (!Array.isArray(message.tools)) {
        throw new ClaudeAgentSdkProtocolError('claude_sdk_frame_invalid', 'Invalid Claude tools');
      }
      const allowed = new Set(this.expectation.allowedTools);
      if (message.tools.some((tool) => typeof tool !== 'string' || !allowed.has(tool))) {
        throw new ClaudeAgentSdkProtocolError(
          'claude_sdk_scope_changed',
          'Claude SDK enabled an unexpected tool',
        );
      }
    }
    if (
      this.expectation.requireEmptyMcp &&
      (!Array.isArray(message.mcp_servers) || message.mcp_servers.length !== 0)
    ) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_scope_changed',
        'Claude SDK enabled an unexpected MCP server',
      );
    }
    if (
      this.expectation.requireIsolatedExtensions &&
      (!Array.isArray(message.skills) ||
        message.skills.length !== 0 ||
        !Array.isArray(message.plugins) ||
        message.plugins.length !== 0)
    ) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_scope_changed',
        'Claude SDK enabled an unexpected extension',
      );
    }
    if (this.providerSessionIdValue === undefined) {
      this.providerSessionIdValue = sessionId;
      this.emit({
        type: 'session.started',
        provider: 'claude',
        transport: 'claude-agent-sdk',
        selection: this.expectation.selection,
      });
    } else if (this.providerSessionIdValue !== sessionId) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_state_invalid',
        'Claude SDK session identity changed',
      );
    }
    this.activateTurn();
  }

  ensureTool(nativeToolId: string, rawName: unknown): ToolIdentity {
    return this.startTool(nativeId(nativeToolId, 'tool use id'), rawName, this.activateTurn());
  }

  private activateTurn(): string {
    if (this.activeTurnId) return this.activeTurnId;
    if (!this.pendingTurnId) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_state_invalid',
        'Claude SDK emitted work without a pending turn',
      );
    }
    const turnId = this.pendingTurnId;
    this.pendingTurnId = undefined;
    this.activeTurnId = turnId;
    this.emit({ type: 'session.status', status: 'active' });
    this.emit({ type: 'turn.started', turnId });
    return turnId;
  }

  private partial(message: Record<string, unknown>): void {
    if (message.parent_tool_use_id !== null) return;
    const turnId = this.activateTurn();
    const event = object(message.event, 'Claude stream event');
    if (event.type === 'message_start') {
      this.currentMessageId = nativeId(object(event.message, 'message start').id, 'message id');
      return;
    }
    if (event.type === 'content_block_start') {
      const block = object(event.content_block, 'content block start');
      const key = this.contentKey(event.index);
      if (block.type === 'tool_use') {
        const nativeToolId = nativeId(block.id, 'tool use id');
        this.startTool(nativeToolId, block.name, turnId);
        this.content.set(key, {
          contentBlockId: this.tools.get(nativeToolId)!.contentBlockId,
          kind: 'tool',
          completed: false,
        });
      } else {
        this.content.set(key, {
          contentBlockId: randomUUID(),
          kind: block.type === 'text' ? 'text' : 'thinking',
          completed: false,
        });
      }
      return;
    }
    if (event.type !== 'content_block_delta') return;
    const identity = this.content.get(this.contentKey(event.index));
    if (!identity) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_state_invalid',
        'Claude SDK delta referenced an unknown block',
      );
    }
    const delta = object(event.delta, 'content delta');
    if (identity.kind === 'thinking' || delta.type === 'thinking_delta') {
      this.summarizeThinking();
      return;
    }
    if (identity.kind !== 'text' || delta.type !== 'text_delta' || typeof delta.text !== 'string') {
      return;
    }
    if (Buffer.byteLength(delta.text, 'utf8') > MAX_CONTENT_BYTES) {
      this.emit({
        type: 'extension.summary',
        turnId,
        extensionName: 'claude.sdk.text',
        summary: 'Claude text delta exceeded the content limit',
        reason: 'truncated',
      });
      return;
    }
    this.emit({
      type: 'content.delta',
      turnId,
      contentBlockId: identity.contentBlockId,
      delta: delta.text,
    });
  }

  private assistant(message: Record<string, unknown>): void {
    if (message.parent_tool_use_id !== null) return;
    const turnId = this.activateTurn();
    const nativeMessage = object(message.message, 'assistant message');
    const messageId = nativeId(nativeMessage.id, 'assistant message id');
    if (!Array.isArray(nativeMessage.content)) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_frame_invalid',
        'Invalid Claude assistant content',
      );
    }
    nativeMessage.content.forEach((rawBlock, index) => {
      const block = object(rawBlock, 'assistant content block');
      if (block.type === 'text') {
        if (typeof block.text !== 'string') {
          throw new ClaudeAgentSdkProtocolError(
            'claude_sdk_frame_invalid',
            'Invalid Claude text block',
          );
        }
        const identity = this.completedContentIdentity(messageId, 'text', index);
        if (Buffer.byteLength(block.text, 'utf8') > MAX_CONTENT_BYTES) {
          this.emit({
            type: 'content.completed',
            turnId,
            block: {
              type: 'provider_extension',
              id: identity.contentBlockId,
              extensionName: 'claude.sdk.text',
              representation: 'safe_summary',
              safeSummary: 'Claude text exceeded the content limit',
              reason: 'truncated',
            },
          });
        } else {
          this.emit({
            type: 'content.completed',
            turnId,
            block: { type: 'text', id: identity.contentBlockId, text: block.text },
          });
        }
      } else if (block.type === 'tool_use') {
        this.startTool(nativeId(block.id, 'tool use id'), block.name, turnId);
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        this.summarizeThinking();
      }
    });
  }

  private user(message: Record<string, unknown>): void {
    if (message.parent_tool_use_id !== null) return;
    const turnId = this.activateTurn();
    const nativeMessage = object(message.message, 'user message');
    if (!Array.isArray(nativeMessage.content)) return;
    for (const rawBlock of nativeMessage.content) {
      const block = object(rawBlock, 'user content block');
      if (block.type !== 'tool_result') continue;
      const nativeToolId = nativeId(block.tool_use_id, 'tool result id');
      const identity = this.tools.get(nativeToolId);
      if (!identity || identity.completed) {
        throw new ClaudeAgentSdkProtocolError(
          'claude_sdk_state_invalid',
          'Claude SDK tool result did not match one active tool',
        );
      }
      identity.completed = true;
      this.emit({
        type: 'tool.completed',
        turnId,
        toolCallId: identity.toolCallId,
        contentBlockId: identity.contentBlockId,
        toolName: identity.name,
        status: block.is_error === true ? 'failed' : 'completed',
        summary: block.is_error === true ? 'Claude tool failed' : 'Claude tool completed',
      });
    }
  }

  private result(message: Record<string, unknown>): void {
    const turnId = this.activateTurn();
    const cumulativeUsage = this.cumulativeUsage(message.modelUsage);
    const usage = cumulativeUsage ? undefined : object(message.usage, 'Claude result usage');
    const inputTokens = cumulativeUsage?.inputTokens ?? safeCount(usage?.input_tokens);
    const outputTokens = cumulativeUsage?.outputTokens ?? safeCount(usage?.output_tokens);
    const cachedInputTokens =
      cumulativeUsage?.cachedInputTokens ??
      (safeCount(usage?.cache_read_input_tokens) ?? 0) +
        (safeCount(usage?.cache_creation_input_tokens) ?? 0);
    this.emit({
      type: 'usage.tokens',
      turnId,
      scope: 'turn',
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(cachedInputTokens === 0 ? {} : { cachedInputTokens }),
    });
    if (
      typeof message.total_cost_usd === 'number' &&
      Number.isFinite(message.total_cost_usd) &&
      message.total_cost_usd >= 0
    ) {
      const cost =
        message.total_cost_usd >= this.cumulativeCost
          ? message.total_cost_usd - this.cumulativeCost
          : message.total_cost_usd;
      this.cumulativeCost = message.total_cost_usd;
      this.emit({
        type: 'usage.cost',
        turnId,
        scope: 'turn',
        cost,
        currency: 'USD',
        estimated: true,
      });
    }
    if (
      message.terminal_reason === 'aborted_streaming' ||
      message.terminal_reason === 'aborted_tools'
    ) {
      this.emit({ type: 'turn.interrupted', turnId, reason: 'Claude turn interrupted' });
    } else if (message.subtype !== 'success' || message.is_error === true) {
      this.emit({
        type: 'turn.failed',
        turnId,
        code: 'claude_sdk_turn_failed',
        message: 'Claude turn failed',
      });
    } else {
      this.emit({ type: 'turn.completed', turnId });
    }
    this.activeTurnId = undefined;
    this.currentMessageId = undefined;
    this.content.clear();
    this.emit({ type: 'session.status', status: 'idle' });
  }

  private startTool(nativeToolId: string, rawName: unknown, turnId: string): ToolIdentity {
    const existing = this.tools.get(nativeToolId);
    if (existing) return existing;
    if (this.tools.size >= MAX_TRACKED_ITEMS) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_state_invalid',
        'Claude SDK exceeded the tool limit',
      );
    }
    const name = normalizedToolName(rawName);
    const identity = {
      contentBlockId: randomUUID(),
      toolCallId: randomUUID(),
      name,
      completed: false,
    };
    this.tools.set(nativeToolId, identity);
    this.emit({
      type: 'tool.started',
      turnId,
      toolCallId: identity.toolCallId,
      contentBlockId: identity.contentBlockId,
      toolName: name,
      ...toolEffects(name),
    });
    return identity;
  }

  private summarizeThinking(): void {
    if (this.thinkingSummarized) return;
    const turnId = this.activateTurn();
    this.thinkingSummarized = true;
    this.emit({
      type: 'extension.summary',
      turnId,
      extensionName: 'claude.sdk.thinking',
      summary: 'Claude thinking update redacted from persistent events',
      reason: 'redacted',
    });
  }

  private completedContentIdentity(
    messageId: string,
    kind: ContentIdentity['kind'],
    fallbackIndex: number,
  ): ContentIdentity {
    const prefix = `${messageId}:`;
    for (const [key, identity] of this.content) {
      if (key.startsWith(prefix) && identity.kind === kind && !identity.completed) {
        identity.completed = true;
        return identity;
      }
    }
    const identity = { contentBlockId: randomUUID(), kind, completed: true };
    this.content.set(`${messageId}:${fallbackIndex}`, identity);
    return identity;
  }

  private cumulativeUsage(
    value: unknown,
  ): { inputTokens: number; outputTokens: number; cachedInputTokens: number } | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    let inputTotal = 0;
    let outputTotal = 0;
    let cachedTotal = 0;
    for (const rawUsage of Object.values(value)) {
      if (typeof rawUsage !== 'object' || rawUsage === null || Array.isArray(rawUsage)) {
        return undefined;
      }
      const usage = rawUsage as Record<string, unknown>;
      const input = safeCount(usage.inputTokens);
      const output = safeCount(usage.outputTokens);
      const cacheRead = safeCount(usage.cacheReadInputTokens);
      const cacheWrite = safeCount(usage.cacheCreationInputTokens);
      if ([input, output, cacheRead, cacheWrite].some((count) => count === undefined)) {
        return undefined;
      }
      inputTotal += input as number;
      outputTotal += output as number;
      cachedTotal += (cacheRead as number) + (cacheWrite as number);
      if (![inputTotal, outputTotal, cachedTotal].every(Number.isSafeInteger)) return undefined;
    }
    const result = {
      inputTokens:
        inputTotal >= this.cumulativeInputTokens
          ? inputTotal - this.cumulativeInputTokens
          : inputTotal,
      outputTokens:
        outputTotal >= this.cumulativeOutputTokens
          ? outputTotal - this.cumulativeOutputTokens
          : outputTotal,
      cachedInputTokens:
        cachedTotal >= this.cumulativeCachedInputTokens
          ? cachedTotal - this.cumulativeCachedInputTokens
          : cachedTotal,
    };
    this.cumulativeInputTokens = inputTotal;
    this.cumulativeOutputTokens = outputTotal;
    this.cumulativeCachedInputTokens = cachedTotal;
    return result;
  }

  private contentKey(index: unknown): string {
    if (!this.currentMessageId || !Number.isSafeInteger(index) || Number(index) < 0) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_frame_invalid',
        'Invalid Claude content correlation',
      );
    }
    return `${this.currentMessageId}:${String(index)}`;
  }
}
