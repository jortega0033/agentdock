import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, ProviderCapabilities, ProviderId } from '@agent-dock/shared';
import { noopLogger, type Logger } from '../../src/logger.js';
import { runProviderSession, type ParsedLine } from '../../src/providers/common/run-session.js';
import type { StartSessionOptions } from '../../src/types.js';

const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));

const KNOWN_EVENT_TYPES = new Set<AgentEvent['type']>([
  'session.started',
  'status',
  'assistant.delta',
  'assistant.message',
  'thinking.delta',
  'tool.started',
  'tool.completed',
  'usage',
  'error',
  'session.completed',
  'session.failed',
  'session.cancelled',
]);

const TERMINAL_TYPES = new Set<AgentEvent['type']>(['session.completed', 'session.failed', 'session.cancelled']);

export interface ProviderContractSpec {
  providerId: ProviderId;
  /** The real, currently-declared capabilities for this provider — drives which sections run. */
  capabilities: ProviderCapabilities;
  /** The adapter's real parser — this suite exercises actual normalization logic, not a stand-in. */
  parseLine: (raw: unknown, logger: Logger) => ParsedLine;
  /** The adapter's real argv builder, used only for the (process-free) resume assertion below. */
  buildArgs: (opts: StartSessionOptions) => string[];
  /** Fixture script filenames under test/fixtures, run via `node <fixture>` in place of the real CLI. */
  fixtures: { success: string; failure: string; hang: string };
  /** What the `success` fixture's assistant.message text is expected to be. */
  expectedAssistantText: string;
  /** The provider-native session/thread id the `success` fixture declares. */
  expectedProviderSessionId: string;
}

async function collect(events: AsyncGenerator<AgentEvent, void, void>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/**
 * Baseline behavioral guarantees every provider adapter must uphold, run against the adapter's
 * *real* parser and argv construction (spawning a small `node` fixture script in place of the
 * real CLI binary — see providers.md#adding-a-new-provider). A future provider adapter can reuse
 * this by fixturing its own success/failure/hang scripts and calling `describeProviderContract`
 * with its real `parseLine`/`buildArgs`/`capabilities`.
 *
 * Lives under test/support rather than src/ deliberately: it's a vitest-coupled test helper, not
 * part of the package's public runtime API, so it isn't exported from index.ts or shipped to
 * consumers — a provider package outside this repo would copy the pattern, not import this file.
 */
export function describeProviderContract(spec: ProviderContractSpec): void {
  describe(`provider contract: ${spec.providerId}`, () => {
    let cwd: string;

    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), `agent-dock-contract-${spec.providerId}-`));
    });

    afterEach(() => {
      rmSync(cwd, { recursive: true, force: true });
    });

    function runFixture(fixtureName: string, overrides: Partial<StartSessionOptions> = {}) {
      return runProviderSession(
        {
          providerId: spec.providerId,
          executableNames: [process.execPath],
          buildArgs: () => [join(fixturesDir, fixtureName)],
          parseLine: spec.parseLine,
        },
        { sessionId: 'contract-session', cwd, prompt: 'hello', ...overrides },
        noopLogger,
      );
    }

    it('declares a complete ProviderCapabilities shape', () => {
      for (const key of ['resume', 'cancellation', 'tools', 'usage', 'thinking'] as const) {
        expect(typeof spec.capabilities[key]).toBe('boolean');
      }
    });

    describe('session start', () => {
      it('emits session.started first, tagged with this provider', async () => {
        const events = await collect(runFixture(spec.fixtures.success).events);
        expect(events[0]).toMatchObject({ type: 'session.started', provider: spec.providerId });
      });

      it('rejects a nonexistent working directory before touching the provider CLI', async () => {
        const events = await collect(runFixture(spec.fixtures.success, { cwd: join(cwd, 'does-not-exist') }).events);
        expect(events.some((e) => e.type === 'error' && e.code === 'INVALID_CWD')).toBe(true);
        expect(events.at(-1)).toEqual({ type: 'session.failed', message: 'invalid working directory' });
      });
    });

    describe('events', () => {
      it('never leaks a raw or unrecognized provider event type', async () => {
        const events = await collect(runFixture(spec.fixtures.success).events);
        expect(events.length).toBeGreaterThan(0);
        for (const event of events) {
          expect(KNOWN_EVENT_TYPES.has(event.type), `unexpected event type leaked: ${event.type}`).toBe(true);
        }
      });

      it('tolerates an event kind the parser does not recognize without crashing the session', async () => {
        // The success fixture includes one intentionally-unrecognized event; reaching a normal
        // terminal state at all proves it didn't abort the session.
        const events = await collect(runFixture(spec.fixtures.success).events);
        expect(events.at(-1)?.type).toBe('session.completed');
      });

      it('normalizes assistant output', async () => {
        const events = await collect(runFixture(spec.fixtures.success).events);
        expect(events).toContainEqual({ type: 'assistant.message', text: spec.expectedAssistantText });
      });

      if (spec.capabilities.tools) {
        it('normalizes tool events (capabilities.tools is true)', async () => {
          const events = await collect(runFixture(spec.fixtures.success).events);
          expect(events.some((e) => e.type === 'tool.started')).toBe(true);
          expect(events.some((e) => e.type === 'tool.completed')).toBe(true);
        });
      }

      if (spec.capabilities.usage) {
        it('normalizes usage accounting (capabilities.usage is true)', async () => {
          const events = await collect(runFixture(spec.fixtures.success).events);
          expect(events.some((e) => e.type === 'usage')).toBe(true);
        });
      }
    });

    describe('terminal states', () => {
      it('a successful run ends with exactly one terminal event, last in the stream, carrying the provider session id', async () => {
        const events = await collect(runFixture(spec.fixtures.success).events);
        const terminalIndices = events.map((e, i) => (TERMINAL_TYPES.has(e.type) ? i : -1)).filter((i) => i >= 0);
        expect(terminalIndices).toEqual([events.length - 1]);
        expect(events.at(-1)).toEqual({ type: 'session.completed', providerSessionId: spec.expectedProviderSessionId });
      });

      it('a failing run ends with exactly one terminal event, last in the stream, and it is session.failed', async () => {
        const events = await collect(runFixture(spec.fixtures.failure).events);
        const terminalIndices = events.map((e, i) => (TERMINAL_TYPES.has(e.type) ? i : -1)).filter((i) => i >= 0);
        expect(terminalIndices).toEqual([events.length - 1]);
        expect(events.at(-1)?.type).toBe('session.failed');
      });
    });

    if (spec.capabilities.cancellation) {
      describe('cancellation', () => {
        it('terminates the process and ends with session.cancelled, never session.completed', async () => {
          const handle = runFixture(spec.fixtures.hang);
          const iterator = handle.events;
          const collected: AgentEvent[] = [];
          const first = await iterator.next();
          if (!first.done) collected.push(first.value);

          await handle.cancel();
          for await (const event of iterator) collected.push(event);

          expect(collected.at(-1)).toEqual({ type: 'session.cancelled' });
          expect(collected.some((e) => e.type === 'session.completed')).toBe(false);
        }, 15_000);
      });
    }

    if (spec.capabilities.resume) {
      describe('resume', () => {
        it('constructs a distinct invocation that references the prior provider session id', () => {
          const fresh = spec.buildArgs({ sessionId: 'new-session', cwd, prompt: 'hi' });
          const resumed = spec.buildArgs({
            sessionId: 'new-session',
            cwd,
            prompt: 'hi',
            resumeProviderSessionId: 'prior-provider-thread-id',
          });
          expect(resumed).not.toEqual(fresh);
          expect(resumed).toContain('prior-provider-thread-id');
        });
      });
    }
  });
}
