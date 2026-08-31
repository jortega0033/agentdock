import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, realpath as realpathAsync, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  query as nativeQuery,
  startup as nativeStartup,
  type Options as ClaudeSdkOptions,
  type PermissionResult,
  type SDKUserMessage,
  type SpawnOptions,
  type SpawnedProcess,
  type UserDialogResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentCommandV2, AgentEventV2, Effect } from '@agent-dock/shared';
import {
  ProviderCommandRejectedError,
  ProviderTransportStartupError,
  type AcceptedWorkState,
  type InteractiveProviderTransport,
  type ProviderDeliveryState,
  type ProviderInteractionResolution,
  type ProviderRuntimeMetadata,
  type StartInteractiveSessionOptions,
} from '../../../types.js';
import { ClaudeSdkEventChannel, ClaudeSdkInputChannel } from './channel.js';
import { boundedDisplay, ClaudeAgentSdkProtocolError, object } from './errors.js';
import { ClaudeAgentSdkNormalizer } from './normalizer.js';
import { resolveClaudeSdkConfigDir } from '../sdk-options.js';

const INTERACTION_TIMEOUT_MS = 300_000;
const CLOSE_TIMEOUT_MS = 2_500;

type ControlledOption =
  | 'abortController'
  | 'canUseTool'
  | 'continue'
  | 'forkSession'
  | 'includePartialMessages'
  | 'onUserDialog'
  | 'pathToClaudeCodeExecutable'
  | 'resume'
  | 'sessionId'
  | 'spawnClaudeCodeProcess'
  | 'stderr'
  | 'supportedDialogKinds';

export type ClaudeAgentSdkSafeOptions = Omit<ClaudeSdkOptions, ControlledOption>;

export interface ClaudeAgentSdkQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  streamInput?(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  close(): void;
}

export interface ClaudeAgentSdkWarmQuery {
  query(prompt: string | AsyncIterable<SDKUserMessage>): ClaudeAgentSdkQuery;
  close(): void;
}

export interface ClaudeAgentSdkFactory {
  query(parameters: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: ClaudeSdkOptions;
  }): ClaudeAgentSdkQuery;
  startup?(parameters?: {
    options?: ClaudeSdkOptions;
    initializeTimeoutMs?: number;
  }): Promise<ClaudeAgentSdkWarmQuery>;
}

export interface ClaudeAgentSdkContinuation {
  kind: 'resume' | 'fork';
  providerSessionId: string;
}

/** Job/tree owner returned by the daemon's SDK spawn seam. */
export interface ClaudeAgentSdkManagedSpawn {
  process: SpawnedProcess;
  /** Force-kills the whole native process tree and resolves only after reaping. */
  forceClose(): Promise<void>;
  /** Resolves only after the whole native process tree has exited and been reaped. */
  reaped: Promise<void>;
}

export interface ClaudeAgentSdkTransportOptions extends Omit<
  StartInteractiveSessionOptions,
  'continuation' | 'transport'
> {
  executable: string;
  /** Absolute daemon-owned root; this transport owns one isolated session child beneath it. */
  daemonConfigRoot: string;
  sdkOptions: ClaudeAgentSdkSafeOptions;
  continuation?: ClaudeAgentSdkContinuation;
  requestedTransportMode?: 'auto' | 'sdk';
  managedProcessSpawner: (options: SpawnOptions) => ClaudeAgentSdkManagedSpawn;
  factory?: ClaudeAgentSdkFactory;
  interactionTimeoutMs?: number;
}

interface PendingBase {
  requestId: string;
  turnId: string;
  nativeRequestId: string;
  settled: boolean;
  detachAbort(): void;
}

interface PendingApproval extends PendingBase {
  kind: 'approval';
  resolve(result: PermissionResult): void;
}

interface PendingQuestion extends PendingBase {
  kind: 'question';
  questions: Map<string, { prompt: string; optionLabels: Map<string, string> }>;
  input: Record<string, unknown>;
  resolve(result: PermissionResult): void;
}

type PendingInteraction = PendingApproval | PendingQuestion;

interface ManagedProcessRecord {
  managed: ClaudeAgentSdkManagedSpawn;
  reapProof: Promise<boolean>;
}

const defaultFactory: ClaudeAgentSdkFactory = {
  query: (parameters) => nativeQuery(parameters),
  startup: async (parameters) => nativeStartup(parameters),
};

const EXACT_TOOL_ALLOWLIST = new Set([
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'NotebookEdit',
  'AskUserQuestion',
]);

function textInput(
  command: Extract<AgentCommandV2, { type: 'input.follow_up' | 'input.steer' }>,
): string {
  const texts: string[] = [];
  for (const block of command.content) {
    if (block.type !== 'text') {
      throw new ProviderCommandRejectedError('Claude SDK transport negotiated text-only input');
    }
    texts.push(block.text);
  }
  return texts.join('\n');
}

function inputMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    origin: { kind: 'human' },
  };
}

function escapesWorkspace(workspace: string, target: string): boolean {
  const pathFromWorkspace = relative(workspace, target);
  return (
    pathFromWorkspace === '..' ||
    pathFromWorkspace.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(pathFromWorkspace)
  );
}

function canonicalExistingOrParent(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return resolve(realpathSync.native(dirname(target)), target.slice(dirname(target).length + 1));
  }
}

function validatedToolTarget(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): string | undefined {
  const field = ['Read', 'Edit', 'Write', 'NotebookEdit'].includes(toolName)
    ? 'file_path'
    : ['Glob', 'Grep'].includes(toolName)
      ? 'path'
      : undefined;
  if (!field) return undefined;
  const raw = input[field];
  if (raw === undefined && ['Glob', 'Grep'].includes(toolName)) {
    try {
      return realpathSync.native(cwd);
    } catch {
      return undefined;
    }
  }
  if (typeof raw !== 'string' || raw.length === 0 || raw.replaceAll('/', '\\').startsWith('\\\\')) {
    return undefined;
  }
  try {
    const canonicalWorkspace = realpathSync.native(cwd);
    const target = resolve(canonicalWorkspace, raw);
    const canonicalTarget = canonicalExistingOrParent(target);
    return !escapesWorkspace(canonicalWorkspace, target) &&
      !escapesWorkspace(canonicalWorkspace, canonicalTarget)
      ? canonicalTarget
      : undefined;
  } catch {
    return undefined;
  }
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

function boundedBoolean(proof: Promise<boolean>, milliseconds: number): Promise<boolean> {
  return new Promise((resolveProof) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProof(value);
    };
    const timer = setTimeout(() => finish(false), milliseconds);
    void proof.then(finish, () => finish(false));
  });
}

function emptyStream(): AsyncGenerator<unknown, void, void> {
  return (async function* empty(): AsyncGenerator<unknown, void, void> {
    for (const value of [] as unknown[]) yield value;
  })();
}

export class ClaudeAgentSdkTransport implements InteractiveProviderTransport {
  private readonly factory: ClaudeAgentSdkFactory;
  private readonly eventsChannel = new ClaudeSdkEventChannel<unknown>();
  private readonly inputChannel = new ClaudeSdkInputChannel<SDKUserMessage>();
  private readonly abortController = new AbortController();
  private readonly interactions = new Map<string, PendingInteraction>();
  private readonly normalizer: ClaudeAgentSdkNormalizer;
  private readonly startedPromise: Promise<void>;
  private resolveStarted!: () => void;
  private rejectStarted!: (error: unknown) => void;
  private readonly acceptedPromise: Promise<AcceptedWorkState>;
  private resolveAccepted!: (state: AcceptedWorkState) => void;
  private queryValue: ClaudeAgentSdkQuery | undefined;
  private warmQuery: ClaudeAgentSdkWarmQuery | undefined;
  private consumePromise: Promise<void> | undefined;
  private readonly managedProcesses: ManagedProcessRecord[] = [];
  private readonly allowedToolNames: ReadonlySet<string>;
  private readonly configDirectory: string;
  private ownsConfigDirectory = false;
  private closing = false;
  private hostLaunchAttempted = false;
  private deliveryState: 'not_delivered' | 'delivered' = 'not_delivered';
  private reapedValue = false;

  readonly events = this.eventsChannel.stream();
  readonly stderr = emptyStream();
  readonly started: Promise<void>;
  readonly accepted: Promise<AcceptedWorkState>;
  readonly runtimeMetadata: Readonly<ProviderRuntimeMetadata>;

  constructor(private readonly options: ClaudeAgentSdkTransportOptions) {
    this.factory = options.factory ?? defaultFactory;
    this.allowedToolNames = new Set(
      Array.isArray(options.sdkOptions.tools) ? options.sdkOptions.tools : [],
    );
    this.configDirectory = resolveClaudeSdkConfigDir(options.daemonConfigRoot, options.sessionId);
    this.normalizer = new ClaudeAgentSdkNormalizer(
      {
        cwd: options.cwd,
        selection: options.selection,
        ...(options.providerStatus?.authSource
          ? { authSource: options.providerStatus.authSource }
          : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(Array.isArray(options.sdkOptions.tools)
          ? { allowedTools: options.sdkOptions.tools }
          : {}),
        requireEmptyMcp: options.sdkOptions.strictMcpConfig === true,
        requireIsolatedExtensions:
          Array.isArray(options.sdkOptions.settingSources) &&
          options.sdkOptions.settingSources.length === 0 &&
          Array.isArray(options.sdkOptions.skills) &&
          options.sdkOptions.skills.length === 0 &&
          Array.isArray(options.sdkOptions.plugins) &&
          options.sdkOptions.plugins.length === 0,
      },
      (event) => this.eventsChannel.push(event),
    );
    this.startedPromise = new Promise<void>((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
    });
    this.started = this.startedPromise;
    this.acceptedPromise = new Promise<AcceptedWorkState>((resolve) => {
      this.resolveAccepted = resolve;
    });
    this.accepted = this.acceptedPromise;
    this.runtimeMetadata = Object.freeze({
      ...(options.providerStatus?.version ? { cliVersion: options.providerStatus.version } : {}),
      schemaVersion: '0.3.251',
      fixtureSet: 'claude-agent-sdk-0.3.251-v1',
      requestedTransportMode: options.requestedTransportMode ?? 'sdk',
    });
    void this.start();
  }

  get providerSessionId(): string | undefined {
    return this.normalizer.providerSessionId;
  }

  get workDeliveryState(): ProviderDeliveryState {
    return this.deliveryState;
  }

  get reaped(): boolean {
    return this.reapedValue;
  }

  async send(command: AgentCommandV2): Promise<void> {
    this.assertOpen();
    if (command.type === 'input.follow_up') {
      this.normalizer.expectTurn(command.turnId);
      await this.options.beforeWorkDelivery?.();
      await this.inputChannel.enqueue(inputMessage(textInput(command)));
      return;
    }
    if (command.type === 'input.steer') {
      throw new ProviderCommandRejectedError('Claude SDK does not provide a native steer command');
    }
    if (command.type === 'session.interrupt') {
      await this.interrupt();
      return;
    }
    if (command.type === 'approval.respond') {
      const pending = this.takeInteraction(command.requestId, command.turnId, 'approval');
      if (pending.settled) return;
      this.settle(
        pending,
        command.decision === 'deny'
          ? { behavior: 'deny', message: 'Denied by user', interrupt: false }
          : { behavior: 'allow' },
      );
      return;
    }
    const pending = this.requireInteraction(command.requestId, command.turnId, 'question');
    if (pending.settled) {
      this.interactions.delete(pending.requestId);
      return;
    }
    if (
      command.answers.length !== pending.questions.size ||
      new Set(command.answers.map((answer) => answer.questionId)).size !== command.answers.length
    ) {
      throw new ProviderCommandRejectedError('Question response must answer every question once');
    }
    const answers: Record<string, string> = {};
    for (const answer of command.answers) {
      const question = pending.questions.get(answer.questionId);
      if (!question) {
        throw new ProviderCommandRejectedError('Question answer did not match the native request');
      }
      if (Array.isArray(answer.value)) {
        const labels = answer.value.map((optionId) => question.optionLabels.get(optionId));
        if (labels.length === 0 || labels.some((label) => label === undefined)) {
          throw new ProviderCommandRejectedError(
            'Question option did not match the native request',
          );
        }
        answers[question.prompt] = labels.join(', ');
      } else {
        answers[question.prompt] = question.optionLabels.get(answer.value) ?? answer.value;
      }
    }
    this.interactions.delete(pending.requestId);
    this.settle(pending, {
      behavior: 'allow',
      updatedInput: { ...pending.input, answers },
    });
  }

  async resolveInteraction(resolution: ProviderInteractionResolution): Promise<void> {
    this.assertOpen();
    const pending = this.takeInteraction(resolution.requestId, resolution.turnId, resolution.kind);
    if (pending.settled) return;
    this.settle(pending, {
      behavior: 'deny',
      message: 'Interaction cancelled by host',
      interrupt: false,
    });
  }

  async interrupt(): Promise<void> {
    this.assertOpen();
    if (!this.queryValue || !this.normalizer.activeTurn) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_state_invalid',
        'No active Claude turn to interrupt',
      );
    }
    await this.queryValue.interrupt();
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.cancelInteractions();
    this.inputChannel.close();
    this.abortController.abort();
    this.warmQuery?.close();
    this.queryValue?.close();
    if (!(await this.awaitReap())) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_close_timeout',
        'Claude SDK process tree did not exit after graceful close',
      );
    }
    await this.removeConfigDirectory();
    this.eventsChannel.close();
  }

  async forceClose(): Promise<void> {
    this.closing = true;
    this.cancelInteractions();
    this.inputChannel.close();
    this.abortController.abort();
    this.warmQuery?.close();
    this.queryValue?.close();
    await Promise.allSettled(this.managedProcesses.map(({ managed }) => managed.forceClose()));
    if (!(await this.awaitReap())) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_force_close_failed',
        'Claude SDK process tree was not reaped',
      );
    }
    await this.removeConfigDirectory();
    this.eventsChannel.close();
  }

  private async start(): Promise<void> {
    try {
      await this.prepareConfigDirectory();
      const queryOptions = this.queryOptions();
      await this.options.beforeProviderThreadStart?.(undefined);
      if (this.factory.startup) {
        this.hostLaunchAttempted = true;
        this.warmQuery = await this.factory.startup({
          options: queryOptions,
          initializeTimeoutMs: 30_000,
        });
      }
      await this.options.beforeWorkDelivery?.();
      this.normalizer.expectTurn(this.options.turnId);
      const initialAccepted = this.inputChannel.enqueue(inputMessage(this.options.prompt));
      const prompt = this.inputChannel.stream();
      this.hostLaunchAttempted = true;
      this.queryValue = this.warmQuery
        ? this.warmQuery.query(prompt)
        : this.factory.query({ prompt, options: queryOptions });
      this.consumePromise = this.consume();
      await initialAccepted;
      this.deliveryState = 'delivered';
      this.resolveAccepted('accepted');
      await this.startedPromise;
    } catch (error) {
      if (this.deliveryState === 'not_delivered') this.resolveAccepted('not_accepted');
      const startupError = new ProviderTransportStartupError(
        error instanceof ClaudeAgentSdkProtocolError ? error.code : 'claude_sdk_startup_failed',
        this.deliveryState === 'not_delivered' ? 'not_delivered' : 'ambiguous',
        this.deliveryState === 'not_delivered'
          ? 'Claude Agent SDK failed before accepting work'
          : 'Claude Agent SDK failed after accepting work',
      );
      this.rejectStarted(startupError);
      this.eventsChannel.fail(startupError);
      this.abortController.abort();
      this.warmQuery?.close();
      this.queryValue?.close();
      if (!this.hostLaunchAttempted || (await this.awaitReap())) {
        await this.removeConfigDirectory();
      }
    }
  }

  private queryOptions(): ClaudeSdkOptions {
    const forbidden = [
      'abortController',
      'canUseTool',
      'continue',
      'forkSession',
      'includePartialMessages',
      'onUserDialog',
      'pathToClaudeCodeExecutable',
      'resume',
      'sessionId',
      'spawnClaudeCodeProcess',
      'stderr',
      'supportedDialogKinds',
    ];
    for (const key of forbidden) {
      if (Object.hasOwn(this.options.sdkOptions, key)) {
        throw new ClaudeAgentSdkProtocolError(
          'claude_sdk_options_invalid',
          'Claude SDK controlled option was supplied twice',
        );
      }
    }
    if (
      !Array.isArray(this.options.sdkOptions.tools) ||
      this.options.sdkOptions.tools.length !== this.allowedToolNames.size ||
      [...this.allowedToolNames].some((tool) => !EXACT_TOOL_ALLOWLIST.has(tool))
    ) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_options_invalid',
        'Claude SDK tools must be an exact supported allowlist',
      );
    }
    if (!this.options.managedProcessSpawner) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_options_invalid',
        'Claude SDK requires the daemon managed process spawner',
      );
    }
    return {
      ...this.options.sdkOptions,
      abortController: this.abortController,
      pathToClaudeCodeExecutable: this.options.executable,
      includePartialMessages: true,
      canUseTool: (toolName, input, callbackOptions) =>
        this.permission(toolName, input, callbackOptions),
      onUserDialog: async (): Promise<UserDialogResult> => ({ behavior: 'cancelled' }),
      supportedDialogKinds: [],
      stderr: () => undefined,
      spawnClaudeCodeProcess: (options) => this.spawnProcess(options),
      ...(this.options.continuation
        ? {
            resume: this.options.continuation.providerSessionId,
            ...(this.options.continuation.kind === 'fork' ? { forkSession: true } : {}),
          }
        : {}),
    };
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.queryValue as ClaudeAgentSdkQuery) {
        this.normalizer.message(message);
        if (this.normalizer.providerSessionId) {
          this.assertContinuationIdentity(this.normalizer.providerSessionId);
          this.resolveStarted();
        }
      }
      if (!this.closing) {
        throw new ClaudeAgentSdkProtocolError(
          'claude_sdk_disconnected',
          'Claude Agent SDK disconnected',
        );
      }
    } catch (error) {
      if (!this.closing) {
        const safeError =
          error instanceof ProviderTransportStartupError ||
          error instanceof ClaudeAgentSdkProtocolError
            ? error
            : new ClaudeAgentSdkProtocolError('claude_sdk_failed', 'Claude Agent SDK failed');
        if (!this.normalizer.providerSessionId) {
          this.rejectStarted(
            new ProviderTransportStartupError(
              safeError instanceof ClaudeAgentSdkProtocolError
                ? safeError.code
                : 'claude_sdk_startup_failed',
              this.deliveryState === 'delivered' ? 'ambiguous' : 'not_delivered',
              this.deliveryState === 'delivered'
                ? 'Claude Agent SDK failed after accepting work'
                : 'Claude Agent SDK failed before accepting work',
            ),
          );
        }
        this.eventsChannel.fail(safeError);
      }
    } finally {
      if (!this.closing) this.inputChannel.close(new Error('Claude SDK input disconnected'));
    }
  }

  private permission(
    toolName: string,
    input: Record<string, unknown>,
    callbackOptions: {
      signal: AbortSignal;
      title?: string;
      displayName?: string;
      description?: string;
      blockedPath?: string;
      decisionReason?: string;
      toolUseID: string;
      requestId: string;
    },
  ): Promise<PermissionResult> {
    if (this.closing || !this.normalizer.activeTurn) {
      return Promise.resolve({ behavior: 'deny', message: 'Claude session is not active' });
    }
    if (this.interactions.size >= 32) {
      return Promise.resolve({ behavior: 'deny', message: 'Too many pending interactions' });
    }
    if (!EXACT_TOOL_ALLOWLIST.has(toolName) || !this.allowedToolNames.has(toolName)) {
      return Promise.resolve({ behavior: 'deny', message: 'Tool is not allowed' });
    }
    if (toolName === 'AskUserQuestion') return this.question(input, callbackOptions);
    const target = validatedToolTarget(toolName, input, this.options.cwd);
    if (!target) {
      return Promise.resolve({ behavior: 'deny', message: 'Tool path is outside the workspace' });
    }
    return this.approval(toolName, target, callbackOptions);
  }

  private approval(
    toolName: string,
    target: string,
    callbackOptions: {
      signal: AbortSignal;
      title?: string;
      displayName?: string;
      description?: string;
      blockedPath?: string;
      decisionReason?: string;
      toolUseID: string;
      requestId: string;
    },
  ): Promise<PermissionResult> {
    const requestId = randomUUID();
    const turnId = this.normalizer.activeTurn as string;
    const tool = this.normalizer.ensureTool(callbackOptions.toolUseID, toolName);
    return new Promise<PermissionResult>((resolve) => {
      const pending: PendingApproval = {
        kind: 'approval',
        requestId,
        turnId,
        nativeRequestId: callbackOptions.requestId,
        settled: false,
        resolve,
        detachAbort: () => undefined,
      };
      this.interactions.set(requestId, pending);
      this.armAbort(pending, callbackOptions.signal);
      if (pending.settled) return;
      this.eventsChannel.push({
        type: 'approval.requested',
        turnId,
        requestId,
        toolCallId: tool.toolCallId,
        title: boundedDisplay(callbackOptions.title, 512, 'Claude requests permission'),
        action: boundedDisplay(callbackOptions.displayName, 4_096, toolName),
        target: boundedDisplay(target, 4_096, 'current workspace'),
        ...(callbackOptions.decisionReason
          ? { reason: boundedDisplay(callbackOptions.decisionReason, 4_096, 'Permission required') }
          : {}),
        ...toolEffects(toolName),
        allowedDecisions: ['allow_once', 'allow_session', 'deny'],
        deadlineAt: this.deadline(),
      } satisfies AgentEventV2);
    });
  }

  private question(
    input: Record<string, unknown>,
    callbackOptions: { signal: AbortSignal; requestId: string },
  ): Promise<PermissionResult> {
    const nativeQuestions = input.questions;
    if (
      !Array.isArray(nativeQuestions) ||
      nativeQuestions.length === 0 ||
      nativeQuestions.length > 3
    ) {
      return Promise.resolve({ behavior: 'deny', message: 'Unsupported question shape' });
    }
    const mapped = new Map<string, { prompt: string; optionLabels: Map<string, string> }>();
    const questions = nativeQuestions.map((rawQuestion) => {
      const question = object(rawQuestion, 'AskUserQuestion question');
      const prompt = boundedDisplay(question.question, 4_096, 'Claude needs input');
      const questionId = randomUUID();
      const optionLabels = new Map<string, string>();
      const nativeOptions = Array.isArray(question.options) ? question.options.slice(0, 10) : [];
      const options = nativeOptions.map((rawOption) => {
        const option = object(rawOption, 'AskUserQuestion option');
        const id = randomUUID();
        const label = boundedDisplay(option.label, 512, 'Option');
        optionLabels.set(id, label);
        return {
          id,
          label,
          ...(typeof option.description === 'string'
            ? { description: boundedDisplay(option.description, 2_048, 'Option') }
            : {}),
        };
      });
      mapped.set(questionId, { prompt, optionLabels });
      return {
        id: questionId,
        title: boundedDisplay(question.header, 512, 'Question'),
        prompt,
        ...(options.length > 0 ? { options } : {}),
        allowsFreeText: true,
      };
    });
    const requestId = randomUUID();
    const turnId = this.normalizer.activeTurn as string;
    return new Promise<PermissionResult>((resolve) => {
      const pending: PendingQuestion = {
        kind: 'question',
        requestId,
        turnId,
        nativeRequestId: callbackOptions.requestId,
        questions: mapped,
        input,
        settled: false,
        resolve,
        detachAbort: () => undefined,
      };
      this.interactions.set(requestId, pending);
      this.armAbort(pending, callbackOptions.signal);
      if (pending.settled) return;
      this.eventsChannel.push({
        type: 'question.requested',
        turnId,
        requestId,
        questions,
        deadlineAt: this.deadline(),
      } satisfies AgentEventV2);
    });
  }

  private armAbort(pending: PendingInteraction, signal: AbortSignal): void {
    const cancel = (): void => {
      if (this.interactions.get(pending.requestId) !== pending) return;
      this.interactions.delete(pending.requestId);
      this.settle(pending, {
        behavior: 'deny',
        message: 'Interaction cancelled by Claude',
        interrupt: false,
      });
      // The daemon owns the published interaction. A native-side cancellation invalidates that
      // correlation, so fail the provider stream and let the supervisor publish its safe
      // disconnect resolution without sending a second native response.
      if (this.options.interactionOwner === 'daemon') {
        this.eventsChannel.fail(
          new ClaudeAgentSdkProtocolError(
            'claude_sdk_interaction_cancelled',
            'Claude cancelled a published interaction',
          ),
        );
        return;
      }
      this.eventsChannel.push(
        pending.kind === 'approval'
          ? {
              type: 'approval.resolved',
              turnId: pending.turnId,
              requestId: pending.requestId,
              decision: 'denied',
              actor: 'policy',
            }
          : {
              type: 'question.cancelled',
              turnId: pending.turnId,
              requestId: pending.requestId,
              reason: 'provider_cancelled',
            },
      );
    };
    signal.addEventListener('abort', cancel, { once: true });
    pending.detachAbort = () => signal.removeEventListener('abort', cancel);
    if (signal.aborted) cancel();
  }

  private settle(pending: PendingInteraction, result: PermissionResult): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.detachAbort();
    pending.resolve(result);
  }

  private takeInteraction<K extends PendingInteraction['kind']>(
    requestId: string,
    turnId: string,
    kind: K,
  ): Extract<PendingInteraction, { kind: K }> {
    const pending = this.requireInteraction(requestId, turnId, kind);
    this.interactions.delete(requestId);
    return pending;
  }

  private requireInteraction<K extends PendingInteraction['kind']>(
    requestId: string,
    turnId: string,
    kind: K,
  ): Extract<PendingInteraction, { kind: K }> {
    const pending = this.interactions.get(requestId);
    if (!pending || pending.kind !== kind || pending.turnId !== turnId) {
      throw new ProviderCommandRejectedError('Interaction is stale or belongs to another turn');
    }
    return pending as Extract<PendingInteraction, { kind: K }>;
  }

  private cancelInteractions(): void {
    for (const pending of this.interactions.values()) {
      this.settle(pending, {
        behavior: 'deny',
        message: 'Interaction cancelled by host',
        interrupt: false,
      });
    }
    this.interactions.clear();
  }

  private deadline(): string {
    return new Date(
      Date.now() + (this.options.interactionTimeoutMs ?? INTERACTION_TIMEOUT_MS),
    ).toISOString();
  }

  private async prepareConfigDirectory(): Promise<void> {
    if (this.options.sdkOptions.env?.CLAUDE_CONFIG_DIR !== this.configDirectory) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_options_invalid',
        'Claude SDK config directory is not bound to the daemon session',
      );
    }
    let rootStat;
    try {
      rootStat = await lstat(this.options.daemonConfigRoot);
    } catch {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_state_invalid',
        'Claude SDK daemon config root is unavailable',
      );
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_state_invalid',
        'Claude SDK daemon config root is not a safe directory',
      );
    }
    const canonicalRoot = await realpathAsync(this.options.daemonConfigRoot);
    const sdkRoot = resolve(this.options.daemonConfigRoot, 'claude-agent-sdk');
    await mkdir(sdkRoot, {
      recursive: true,
      mode: 0o700,
    });
    const sdkRootStat = await lstat(sdkRoot);
    const canonicalSdkRoot = await realpathAsync(sdkRoot);
    if (
      !sdkRootStat.isDirectory() ||
      sdkRootStat.isSymbolicLink() ||
      escapesWorkspace(canonicalRoot, canonicalSdkRoot)
    ) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_state_invalid',
        'Claude SDK config parent escaped the daemon root',
      );
    }
    try {
      await mkdir(this.configDirectory, { mode: 0o700 });
      this.ownsConfigDirectory = true;
    } catch {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_state_invalid',
        'Claude SDK session config directory already exists',
      );
    }
  }

  private spawnProcess(options: SpawnOptions): SpawnedProcess {
    const spawn = this.options.managedProcessSpawner;
    if (!spawn) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_options_invalid',
        'Claude SDK managed process spawner is unavailable',
      );
    }
    const managed = spawn(options);
    this.managedProcesses.push({
      managed,
      // Observe rejection immediately; a rejected proof is permanently false and never reaped.
      reapProof: managed.reaped.then(
        () => true,
        () => false,
      ),
    });
    return managed.process;
  }

  private async awaitReap(): Promise<boolean> {
    if (!this.hostLaunchAttempted) {
      this.reapedValue = true;
      return true;
    }
    if (this.managedProcesses.length === 0) {
      // The required spawn hook is the only production process creation path. If it was never
      // called, there is no native process tree to reap.
      this.reapedValue = true;
      return true;
    }
    const proof = Promise.all(this.managedProcesses.map(({ reapProof }) => reapProof)).then(
      (results) => results.every(Boolean),
    );
    const reaped = await boundedBoolean(proof, CLOSE_TIMEOUT_MS);
    if (reaped) this.reapedValue = true;
    return reaped;
  }

  private async removeConfigDirectory(): Promise<void> {
    if (!this.ownsConfigDirectory) return;
    let stat;
    try {
      stat = await lstat(this.configDirectory);
    } catch {
      this.ownsConfigDirectory = false;
      return;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_config_cleanup_failed',
        'Claude SDK config directory changed before cleanup',
      );
    }
    try {
      await rm(this.configDirectory, { recursive: true, force: false });
    } catch {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_config_cleanup_failed',
        'Claude SDK config directory cleanup failed',
      );
    }
    this.ownsConfigDirectory = false;
  }

  private assertContinuationIdentity(providerSessionId: string): void {
    const continuation = this.options.continuation;
    if (!continuation) return;
    const valid =
      continuation.kind === 'resume'
        ? providerSessionId === continuation.providerSessionId
        : providerSessionId !== continuation.providerSessionId;
    if (!valid) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_continuation_invalid',
        'Claude SDK continuation identity did not match the native operation',
      );
    }
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new ClaudeAgentSdkProtocolError('claude_sdk_closed', 'Claude SDK transport is closed');
    }
  }
}

export function createClaudeAgentSdkTransport(
  options: ClaudeAgentSdkTransportOptions,
): ClaudeAgentSdkTransport {
  return new ClaudeAgentSdkTransport(options);
}
