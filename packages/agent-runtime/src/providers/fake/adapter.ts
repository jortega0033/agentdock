import { randomUUID } from 'node:crypto';
import {
  CAPABILITY_CATALOG,
  type AgentCommandV2,
  type AgentEvent,
  type CapabilitySupportRecord,
  type CoreCapabilityId,
  type ProviderCapabilities,
  type ProviderId,
  type ProviderStatus,
  type ProviderTransportV2,
} from '@agent-dock/shared';
import { AsyncChannel } from '../../process/async-channel.js';
import type {
  AgentProvider,
  InteractiveProviderSessionHandle,
  InteractiveProviderTransport,
  ProviderInteractionResolution,
  ProviderSessionHandle,
  ProviderV2Support,
  StartInteractiveSessionOptions,
  StartSessionOptions,
} from '../../types.js';
import {
  InteractiveSessionError,
  superviseInteractiveSession,
} from '../common/session-supervisor.js';
import {
  FAKE_INTERACTIVE_COMPATIBILITY,
  FAKE_INTERACTIVE_TRANSPORT_ID,
} from '../compatibility-manifest.js';

export type FakeScenario = 'success' | 'failure' | 'hang-until-cancelled';
export type FakeInteractiveScenario =
  | 'multi-input'
  | 'approval'
  | 'question'
  | 'disconnect'
  | 'queue-overflow'
  | 'malformed-frame'
  | 'oversized-frame'
  | 'crash';

export const FAKE_INTERACTIVE_TRANSPORT: ProviderTransportV2 = {
  id: FAKE_INTERACTIVE_TRANSPORT_ID,
  priority: 1,
  stability: 'stable',
  possibleEffects: [],
  effectsComplete: true,
};

/**
 * Deliberately not a copy of the real adapters' capabilities: `resume`, `tools`, and `thinking`
 * are `false` because FakeProvider genuinely doesn't implement them (no resume branching, no
 * tool/thinking events emitted below); that contrast is useful for tests asserting
 * capability-gated behavior actually gates on the flag rather than always running.
 */
export const FAKE_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  resume: false,
  cancellation: true,
  tools: false,
  usage: true,
  thinking: false,
};

/**
 * In-process fake provider (spawns no subprocess) used by daemon and desktop tests so they never
 * depend on a real Claude/Codex installation or paid API calls. Records every startSession call
 * so tests can assert on what the daemon asked for.
 */
export class FakeProvider implements AgentProvider {
  readonly id: ProviderId;
  readonly name: string;
  readonly startedOptions: StartSessionOptions[] = [];
  readonly interactiveStartedOptions: StartInteractiveSessionOptions[] = [];
  readonly interactiveCommands: AgentCommandV2[] = [];
  readonly interactiveResolutions: ProviderInteractionResolution[] = [];
  interactiveInterrupts = 0;
  interactiveCloses = 0;
  lastInteractionRequestId: string | undefined;

  constructor(
    id: ProviderId = 'claude',
    private readonly status: ProviderStatus = {
      id,
      name: 'Fake Provider',
      installed: true,
      authenticated: 'authenticated',
      capabilities: FAKE_PROVIDER_CAPABILITIES,
    },
    private readonly scenario: FakeScenario = 'success',
    private readonly interactiveScenario?: FakeInteractiveScenario,
  ) {
    this.id = id;
    this.name = status.name;
  }

  async detect(): Promise<ProviderStatus> {
    return this.status;
  }

  getV2Support(status: ProviderStatus): ProviderV2Support | undefined {
    return this.interactiveScenario ? fakeInteractiveSupport(status) : undefined;
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    this.startedOptions.push(options);
    const channel = new AsyncChannel<AgentEvent>();
    let cancelled = false;

    void (async () => {
      channel.push({ type: 'session.started', sessionId: options.sessionId, provider: this.id });
      channel.push({ type: 'status', status: 'running' });

      if (this.scenario === 'hang-until-cancelled') {
        while (!cancelled) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        channel.push({ type: 'session.cancelled' });
        channel.close();
        return;
      }

      channel.push({ type: 'assistant.message', text: `fake response to: ${options.prompt}` });
      channel.push({ type: 'usage', inputTokens: 10, outputTokens: 5 });

      if (this.scenario === 'failure') {
        channel.push({ type: 'error', message: 'fake failure', recoverable: false });
        channel.push({ type: 'session.failed', message: 'fake failure' });
      } else {
        channel.push({ type: 'session.completed', providerSessionId: `fake-${options.sessionId}` });
      }
      channel.close();
    })();

    return {
      events: channel[Symbol.asyncIterator](),
      cancel: async () => {
        cancelled = true;
      },
    };
  }

  async startInteractiveSession(
    options: StartInteractiveSessionOptions,
  ): Promise<InteractiveProviderSessionHandle> {
    if (!this.interactiveScenario) throw new Error('interactive fake scenario is not configured');
    this.interactiveStartedOptions.push(options);
    const transport = new FakeInteractiveTransport(this, options, this.interactiveScenario);
    return superviseInteractiveSession(transport, options);
  }
}

function runtimePlatform(): 'win32' | 'darwin' | 'linux' | 'linux_wsl2' {
  if (process.platform === 'win32' || process.platform === 'darwin') return process.platform;
  return process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP ? 'linux_wsl2' : 'linux';
}

function fakeInteractiveSupport(status: ProviderStatus): ProviderV2Support {
  const scope = {
    provider: status.id,
    transport: FAKE_INTERACTIVE_TRANSPORT.id,
    platform: runtimePlatform(),
    model: '*' as const,
    authMode: '*' as const,
    trustState: 'untrusted' as const,
    versions: {
      adapterContract: '2',
      transport: FAKE_INTERACTIVE_COMPATIBILITY.providerVersion,
      runtime: process.version,
      schema: FAKE_INTERACTIVE_COMPATIBILITY.schemaSet,
      fixtureSet: FAKE_INTERACTIVE_COMPATIBILITY.fixtureSet,
    },
  };
  const record = (
    id: CoreCapabilityId,
    constraints: CapabilitySupportRecord['constraints'],
    sessionStates: Array<'starting' | 'active' | 'idle' | 'terminal'>,
  ): CapabilitySupportRecord =>
    ({
      id,
      kind: CAPABILITY_CATALOG[id].kind,
      owner: CAPABILITY_CATALOG[id].owner,
      support: 'supported',
      stability: 'stable',
      evidence: [{ kind: 'fixture', reference: FAKE_INTERACTIVE_COMPATIBILITY.fixtureSet }],
      scope,
      prerequisites: {
        capabilities: [],
        trustStates: ['untrusted'],
        sessionStates,
        services: [],
      },
      possibleEffects: [],
      effectsComplete: true,
      constraints,
    }) as CapabilitySupportRecord;

  return {
    transports: [{ ...FAKE_INTERACTIVE_TRANSPORT, possibleEffects: [] }],
    capabilities: [
      record(
        'session.input.follow_up',
        { kind: 'text_input', maxCharacters: 200_000, attachmentKinds: [] },
        ['starting', 'idle'],
      ),
      record(
        'session.input.steer',
        { kind: 'text_input', maxCharacters: 200_000, attachmentKinds: [] },
        ['starting', 'active'],
      ),
      record('session.interrupt', { kind: 'acknowledgement', timeoutMs: 30_000 }, [
        'starting',
        'active',
      ]),
      record('session.cancel', { kind: 'acknowledgement', timeoutMs: 30_000 }, [
        'starting',
        'active',
        'idle',
      ]),
      record(
        'interaction.approval',
        { kind: 'interaction', timeoutMs: 300_000, maxPayloadBytes: 32 * 1024 },
        ['starting', 'active'],
      ),
      record(
        'interaction.question',
        { kind: 'interaction', timeoutMs: 300_000, maxPayloadBytes: 32 * 1024 },
        ['starting', 'active'],
      ),
    ],
  };
}

class FakeInteractiveTransport implements InteractiveProviderTransport {
  private readonly channel = new AsyncChannel<unknown>();
  private currentTurnId: string;
  private closed = false;
  readonly started = Promise.resolve();
  readonly accepted = Promise.resolve('accepted' as const);
  readonly events: AsyncGenerator<unknown, void, void>;
  readonly stderr = (async function* (): AsyncGenerator<unknown, void, void> {
    // FakeProvider has no process stderr.
  })();

  constructor(
    private readonly provider: FakeProvider,
    private readonly options: StartInteractiveSessionOptions,
    private readonly scenario: FakeInteractiveScenario,
  ) {
    this.currentTurnId = options.turnId;
    this.events =
      scenario === 'crash'
        ? this.crashingEvents()
        : scenario === 'queue-overflow'
          ? this.queueOverflowEvents()
          : this.channel[Symbol.asyncIterator]();
    queueMicrotask(() => this.start());
  }

  async send(command: AgentCommandV2): Promise<void> {
    if (this.closed) throw new Error('fake interactive transport is closed');
    this.provider.interactiveCommands.push(command);
    this.currentTurnId = command.turnId;
    if (command.type === 'input.follow_up') {
      this.push({ type: 'session.status', status: 'active' });
      this.push({ type: 'turn.started', turnId: command.turnId });
      this.push({
        type: 'content.completed',
        turnId: command.turnId,
        block: {
          type: 'text',
          id: randomUUID(),
          text: `fake response to command ${command.commandId}`,
        },
      });
      this.push({ type: 'turn.completed', turnId: command.turnId });
      this.push({ type: 'session.status', status: 'idle' });
      return;
    }
    if (command.type === 'input.steer') {
      this.push({
        type: 'content.completed',
        turnId: command.turnId,
        block: {
          type: 'text',
          id: randomUUID(),
          text: `fake steered response to command ${command.commandId}`,
        },
      });
      return;
    }
    if (command.type === 'approval.respond') {
      this.push({
        type: 'approval.resolved',
        turnId: command.turnId,
        requestId: command.requestId,
        decision: command.decision === 'allow_once' ? 'allowed' : 'denied',
        actor: 'user',
      });
      this.push({ type: 'turn.completed', turnId: command.turnId });
      this.push({ type: 'session.status', status: 'idle' });
      return;
    }
    if (command.type === 'question.respond') {
      this.push({
        type: 'question.resolved',
        turnId: command.turnId,
        requestId: command.requestId,
        answers: command.answers,
      });
      this.push({ type: 'turn.completed', turnId: command.turnId });
      this.push({ type: 'session.status', status: 'idle' });
    }
  }

  async resolveInteraction(resolution: ProviderInteractionResolution): Promise<void> {
    if (this.closed) throw new Error('fake interactive transport is closed');
    this.provider.interactiveResolutions.push(resolution);
  }

  async interrupt(): Promise<void> {
    if (this.closed) throw new Error('fake interactive transport is closed');
    this.provider.interactiveInterrupts += 1;
    this.push({ type: 'turn.interrupted', turnId: this.currentTurnId, reason: 'user interrupt' });
    this.push({ type: 'session.status', status: 'idle' });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.provider.interactiveCloses += 1;
    this.channel.closeWith([{ type: 'session.cancelled', reason: 'fake transport closed' }]);
  }

  async forceClose(): Promise<void> {
    await this.close();
  }

  private start(): void {
    if (this.scenario === 'crash' || this.scenario === 'queue-overflow') return;
    this.push({
      type: 'session.started',
      provider: this.provider.id,
      transport: this.options.transport.id,
      selection: this.options.selection,
    });
    this.push({ type: 'session.status', status: 'active' });
    this.push({ type: 'turn.started', turnId: this.options.turnId });
    this.push({
      type: 'content.completed',
      turnId: this.options.turnId,
      block: {
        type: 'text',
        id: randomUUID(),
        text: `fake response to: ${this.options.prompt}`,
      },
    });

    if (this.scenario === 'malformed-frame') {
      this.channel.push('{not-json');
      return;
    }
    if (this.scenario === 'oversized-frame') {
      this.channel.push('x'.repeat(1024 * 1024 + 1));
      return;
    }
    if (this.scenario === 'approval') {
      const requestId = randomUUID();
      this.provider.lastInteractionRequestId = requestId;
      this.push({
        type: 'approval.requested',
        turnId: this.options.turnId,
        requestId,
        title: 'Allow fake action?',
        action: 'fake action',
        target: 'fake target',
        possibleEffects: [],
        effectsComplete: true,
        deadlineAt: new Date(Date.now() + 300_000).toISOString(),
      });
      return;
    }
    if (this.scenario === 'question' || this.scenario === 'disconnect') {
      const requestId = randomUUID();
      this.provider.lastInteractionRequestId = requestId;
      this.push({
        type: 'question.requested',
        turnId: this.options.turnId,
        requestId,
        questions: [
          {
            id: randomUUID(),
            title: 'Fake question',
            prompt: 'Choose an answer',
            allowsFreeText: true,
          },
        ],
        deadlineAt: new Date(Date.now() + 300_000).toISOString(),
      });
      if (this.scenario === 'disconnect') this.channel.close();
      return;
    }
    this.push({ type: 'turn.completed', turnId: this.options.turnId });
    this.push({ type: 'session.status', status: 'idle' });
  }

  private push(event: unknown): void {
    this.channel.push(event);
  }

  private async *crashingEvents(): AsyncGenerator<unknown, void, void> {
    yield {
      type: 'session.started',
      provider: this.provider.id,
      transport: this.options.transport.id,
      selection: this.options.selection,
    };
    throw new Error('fake provider crash');
  }

  private async *queueOverflowEvents(): AsyncGenerator<unknown, void, void> {
    yield {
      type: 'session.started',
      provider: this.provider.id,
      transport: this.options.transport.id,
      selection: this.options.selection,
    };
    yield { type: 'session.status', status: 'active' };
    yield { type: 'turn.started', turnId: this.options.turnId };
    for (let index = 0; index < 6_000; index += 1) {
      yield {
        type: 'content.delta',
        turnId: this.options.turnId,
        contentBlockId: randomUUID(),
        delta: String(index),
      };
    }
    throw new InteractiveSessionError('provider_queue_overflow', 'fake provider queue overflowed');
  }
}
