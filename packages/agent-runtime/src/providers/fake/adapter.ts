import type { AgentEvent, ProviderCapabilities, ProviderId, ProviderStatus } from '@agent-dock/shared';
import { AsyncChannel } from '../../process/async-channel.js';
import type { AgentProvider, ProviderSessionHandle, StartSessionOptions } from '../../types.js';

export type FakeScenario = 'success' | 'failure' | 'hang-until-cancelled';

/**
 * Deliberately not a copy of the real adapters' capabilities: `resume`, `tools`, and `thinking`
 * are `false` because FakeProvider genuinely doesn't implement them (no resume branching, no
 * tool/thinking events emitted below) — that contrast is useful for tests asserting
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

  constructor(
    id: ProviderId = 'claude',
    private readonly status: ProviderStatus = {
      id,
      name: 'Fake Provider',
      installed: true,
      authenticated: true,
      capabilities: FAKE_PROVIDER_CAPABILITIES,
    },
    private readonly scenario: FakeScenario = 'success',
  ) {
    this.id = id;
    this.name = status.name;
  }

  async detect(): Promise<ProviderStatus> {
    return this.status;
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
}
