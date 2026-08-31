import { describe, expect, it } from 'vitest';
import {
  PROVIDER_COMPATIBILITY_MANIFEST,
  PROVIDER_FIXTURE_SCHEMA_SET,
} from '../src/providers/compatibility-manifest.js';
import {
  FIXTURE_IDS,
  PROVIDER_FIXTURE_SCHEMA,
  canonicalJson,
  expectedCanonicalEvents,
  loadProviderFixtures,
  replayLegacyFixture,
  replayLegacyFixtureWithTrace,
  replayInteractiveFixture,
  terminalEvents,
  type FixtureNativeFrame,
  type ProviderFixture,
} from './support/provider-fixture.js';
import { parseClaudeLine } from '../src/providers/claude/parser.js';
import { parseCodexLine } from '../src/providers/codex/parser.js';

const loadedFixtures = loadProviderFixtures();
const interactiveFixtures = loadedFixtures.filter(
  ({ fixture }) => fixture.protocol === 'v2' && fixture.provider.implementation === 'fake',
);

const REQUIRED_EVIDENCE: Record<string, readonly string[]> = {
  'claude-legacy-2.1.228-v1': [
    'fresh-session',
    'resume',
    'tools',
    'usage',
    'unknown-additive-fields',
  ],
  'codex-legacy-0.147.0-v1': [
    'fresh-session',
    'resume',
    'tools',
    'usage',
    'unknown-additive-fields',
  ],
  'fake-interactive-v1': [
    'fresh-session',
    'resume',
    'tools',
    'usage',
    'approval-allow',
    'approval-deny',
    'question-response',
    'interrupt',
    'cancellation',
    'malformed-input',
    'disconnect',
    'pre-accept-failure',
    'post-accept-failure',
    'queue-overflow',
  ],
};

describe('provider compatibility manifest', () => {
  it('maps every entry to exact schema, fixture set, provider version, and transport', () => {
    for (const entry of PROVIDER_COMPATIBILITY_MANIFEST) {
      const matches = loadedFixtures.filter(
        ({ fixture }) => fixture.fixtureSet === entry.fixtureSet,
      );
      expect(matches.length, `missing fixture set ${entry.fixtureSet}`).toBeGreaterThan(0);

      for (const { fixture } of matches) {
        expect(fixture.schema).toBe(PROVIDER_FIXTURE_SCHEMA);
        expect(fixture.schemaSet).toBe(entry.schemaSet);
        expect(fixture.provider.implementation).toBe(entry.provider);
        expect(fixture.provider.version).toBe(entry.providerVersion);
        expect(fixture.transport.id).toBe(entry.transport);
      }
    }
  });

  it('maps every checked-in fixture set to one manifest entry', () => {
    const manifestSets = new Set(PROVIDER_COMPATIBILITY_MANIFEST.map((entry) => entry.fixtureSet));
    const fixtureSets = new Set(loadedFixtures.map(({ fixture }) => fixture.fixtureSet));

    expect(fixtureSets).toEqual(manifestSets);
    expect(new Set(PROVIDER_COMPATIBILITY_MANIFEST.map((entry) => entry.schemaSet))).toEqual(
      new Set([PROVIDER_FIXTURE_SCHEMA_SET]),
    );
    expect(manifestSets.size).toBe(PROVIDER_COMPATIBILITY_MANIFEST.length);
    expect(new Set(loadedFixtures.map(({ fixture }) => fixture.id)).size).toBe(
      loadedFixtures.length,
    );
    for (const { fixture, relativePath } of loadedFixtures) {
      expect(relativePath.startsWith(`fixtures/${fixture.fixtureSet}/`)).toBe(true);
    }
  });

  it('backs every required scenario with consumed native frames and replayed events', async () => {
    const replayEvidence = new Map<string, ScenarioEvidence>();
    for (const { fixture } of loadedFixtures) {
      replayEvidence.set(fixture.id, await collectScenarioEvidence(fixture));
    }

    for (const [fixtureSet, requirements] of Object.entries(REQUIRED_EVIDENCE)) {
      const fixtures = loadedFixtures
        .filter(({ fixture }) => fixture.fixtureSet === fixtureSet)
        .map(({ fixture }) => fixture);
      for (const requirement of requirements) {
        expect(
          fixtures.some((fixture) =>
            hasScenarioEvidence(fixture, requirement, replayEvidence.get(fixture.id)!),
          ),
          `${fixtureSet} lacks evidence for ${requirement}`,
        ).toBe(true);
      }
    }
  });
});

describe('fixture harness self-tests', () => {
  it('canonicalizes generated IDs and object key order byte-stably', () => {
    expect(canonicalJson({ z: FIXTURE_IDS.session, a: FIXTURE_IDS.command })).toBe(
      '{\n  "a": "<command-id>",\n  "z": "<session-id>"\n}\n',
    );
  });

  it('canonicalizes only the exact selected capability contract', async () => {
    const fixture = interactiveFixtures.find(
      ({ fixture: candidate }) => candidate.scenario === 'fresh-session',
    )?.fixture;
    expect(fixture).toBeDefined();
    const replay = await replayInteractiveFixture(fixture!);
    const started = replay.events.find((event) => event.type === 'session.started');
    expect(started?.type).toBe('session.started');
    if (!started || started.type !== 'session.started') return;

    expect(canonicalJson(started.selection)).toBe('"<fixture-selection>"\n');
    const changed = structuredClone(started.selection);
    changed.enabled = changed.enabled.slice(1);
    expect(canonicalJson(changed)).not.toBe('"<fixture-selection>"\n');
  });

  it('tolerates additive native fields without changing legacy normalization', () => {
    const source = loadedFixtures.find(
      ({ fixture }) =>
        fixture.fixtureSet === 'claude-legacy-2.1.228-v1' && fixture.scenario === 'fresh-session',
    )?.fixture;
    expect(source).toBeDefined();
    const mutated = structuredClone(source!);
    const firstFrame = mutated.nativeOutput[0]?.value;
    expect(firstFrame && typeof firstFrame === 'object' && !Array.isArray(firstFrame)).toBe(true);
    (firstFrame as Record<string, unknown>).future_additive_field = {
      revision: 99,
      timestamp: '2040-01-01T00:00:00.000Z',
    };

    expect(canonicalJson(replayLegacyFixture(mutated, parseClaudeLine))).toBe(
      expectedCanonicalEvents(source!),
    );
  });

  it('fails a mutated missing required field closed with one terminal event', async () => {
    const source = interactiveFixtures.find(
      ({ fixture }) => fixture.scenario === 'fresh-session',
    )?.fixture;
    expect(source).toBeDefined();
    const mutated = structuredClone(source!);
    const turnStarted = mutated.nativeOutput.find(
      (frame) =>
        frame.value &&
        typeof frame.value === 'object' &&
        !Array.isArray(frame.value) &&
        frame.value.type === 'turn.started',
    )?.value;
    expect(turnStarted && typeof turnStarted === 'object' && !Array.isArray(turnStarted)).toBe(
      true,
    );
    delete (turnStarted as Record<string, unknown>).turnId;

    const replay = await replayInteractiveFixture(mutated);
    expect(terminalEvents(replay.events)).toEqual([
      {
        type: 'session.failed',
        code: 'provider_frame_invalid',
        message: 'provider event failed validation',
      },
    ]);
    expect(replay.closeCalls).toBe(1);
    expect(replay.reaped).toBe(true);
  });

  it('rejects native-input drift before starting the transport', async () => {
    const source = interactiveFixtures.find(
      ({ fixture }) => fixture.scenario === 'resume',
    )?.fixture;
    expect(source).toBeDefined();
    const mutated = structuredClone(source!);
    const input = asRecord(mutated.nativeInput[0]);
    expect(input).toBeDefined();
    input!.resumeProviderSessionId = '<redacted:wrong-session-id>';

    await expect(replayInteractiveFixture(mutated)).rejects.toThrow(
      'fixture resume id does not match interactive start options',
    );
  });

  it('replays sanitizer-produced typed prompt and cwd placeholders', async () => {
    const source = interactiveFixtures.find(
      ({ fixture }) => fixture.scenario === 'fresh-session',
    )?.fixture;
    expect(source).toBeDefined();
    const mutated = structuredClone(source!);
    const input = asRecord(mutated.nativeInput[0]);
    expect(input).toBeDefined();
    input!.prompt = { $fixturePlaceholder: 'prompt' };
    input!.cwd = { $fixturePlaceholder: 'working_directory' };

    const replay = await replayInteractiveFixture(mutated);
    expectReplayEvents(mutated, replay.events);
  });
});

describe('interactive provider fixture contract', () => {
  for (const { fixture, relativePath } of interactiveFixtures) {
    it(`${relativePath} replays deterministically`, async () => {
      const first = await replayInteractiveFixture(fixture);
      const second = await replayInteractiveFixture(fixture);

      expect(first.canonicalEvents).toBe(second.canonicalEvents);
      expectReplayEvents(fixture, first.events);

      const terminals = terminalEvents(first.events);
      expect(terminals).toHaveLength(fixture.terminalState.count);
      expect(terminals[0]?.type).toBe(fixture.terminalState.type);
      expect(first.events.at(-1)).toBe(terminals[0]);
      expect(first.acceptedWork).toBe(fixture.terminalState.acceptedWork);

      expect(first.closeCalls).toBe(fixture.cleanup.closeCalls);
      expect(first.forceCloseCalls).toBe(fixture.cleanup.forceCloseCalls);
      expect(first.resolutions).toHaveLength(fixture.cleanup.interactionResolutions);
      expect(first.reaped).toBe(fixture.cleanup.reaped);

      const expectedCommandCount = fixture.controls.filter(
        (control) => control.operation === 'send',
      ).length;
      expect(first.sentCommands).toHaveLength(expectedCommandCount);
      assertCommandCorrelation(first.sentCommands, first.events);
      assertCapabilitySelection(first.events, fixture);

      if (fixture.terminalState.workMayHaveStarted) {
        expect(fixture.terminalState.fallbackAllowed).toBe(false);
      }
    }, 15_000);
  }
});

function assertCapabilitySelection(
  events: Awaited<ReturnType<typeof replayInteractiveFixture>>['events'],
  fixture: ProviderFixture,
): void {
  const started = events.find((event) => event.type === 'session.started');
  if (!started || started.type !== 'session.started') return;

  expect(started.transport).toBe(fixture.transport.id);
  expect(started.selection.transport).toBe(fixture.transport.id);
  expect(started.selection.effectsComplete).toBe(true);
  const enabled = new Set(started.selection.enabled.map((entry) => entry.id));
  for (const capability of [
    'session.input.follow_up',
    'session.input.steer',
    'session.interrupt',
    'session.cancel',
    'interaction.approval',
    'interaction.question',
    'content.tools',
    'content.usage.tokens',
  ] as const) {
    expect(enabled.has(capability), `missing selected capability ${capability}`).toBe(true);
  }
}

function expectReplayEvents(
  fixture: ProviderFixture,
  events: Awaited<ReturnType<typeof replayInteractiveFixture>>['events'],
): void {
  if (fixture.scenario === 'queue-overflow') {
    const diagnosticAndTerminal = events.filter(
      (event) =>
        event.type === 'error' ||
        event.type === 'approval.resolved' ||
        event.type === 'question.resolved' ||
        event.type === 'question.cancelled' ||
        terminalEvents([event]).length === 1,
    );
    expect(events).toHaveLength(5_003);
    expect(events.filter((event) => event.type === 'session.status')).toHaveLength(4_997);
    expect(events.filter((event) => event.type === 'question.requested')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'question.cancelled')).toHaveLength(1);
    expect(canonicalJson(diagnosticAndTerminal)).toBe(expectedCanonicalEvents(fixture));
    return;
  }

  expect(canonicalJson(events)).toBe(expectedCanonicalEvents(fixture));
}

function assertCommandCorrelation(
  commands: Awaited<ReturnType<typeof replayInteractiveFixture>>['sentCommands'],
  events: Awaited<ReturnType<typeof replayInteractiveFixture>>['events'],
): void {
  for (const command of commands) {
    expect(command.commandId).toBe(FIXTURE_IDS.command);
    expect(command.sessionId).toBe(FIXTURE_IDS.session);

    if (command.type === 'approval.respond') {
      expect(
        events.some(
          (event) => event.type === 'approval.requested' && event.requestId === command.requestId,
        ),
      ).toBe(true);
    }

    if (command.type === 'question.respond') {
      expect(
        events.some(
          (event) => event.type === 'question.requested' && event.requestId === command.requestId,
        ),
      ).toBe(true);
    }

    if ('turnId' in command) {
      expect(events.some((event) => 'turnId' in event && event.turnId === command.turnId)).toBe(
        true,
      );
    }
  }
}

interface ScenarioEvidence {
  events: unknown[];
  nativeFrames: FixtureNativeFrame[];
}

async function collectScenarioEvidence(fixture: ProviderFixture): Promise<ScenarioEvidence> {
  if (fixture.protocol === 'v2') {
    const replay = await replayInteractiveFixture(fixture);
    return { events: replay.events, nativeFrames: replay.nativeFrames };
  }
  const parseLine = fixture.provider.implementation === 'claude' ? parseClaudeLine : parseCodexLine;
  return replayLegacyFixtureWithTrace(fixture, parseLine);
}

function hasScenarioEvidence(
  fixture: ProviderFixture,
  requirement: string,
  evidence: ScenarioEvidence,
): boolean {
  const nativeTypes = evidence.nativeFrames.map((frame) => recordType(frame.value));
  const eventTypes = evidence.events.map(recordType);
  switch (requirement) {
    case 'fresh-session': {
      const input = asRecord(fixture.nativeInput[0]);
      return (
        fixture.scenario === requirement &&
        input !== undefined &&
        input.prompt !== undefined &&
        input.resumeProviderSessionId === undefined &&
        input.providerSessionId === undefined &&
        hasNativeSessionStart(evidence.nativeFrames) &&
        eventTypes.includes('session.started') &&
        eventTypes.includes(fixture.terminalState.type)
      );
    }
    case 'resume': {
      const input = asRecord(fixture.nativeInput[0]);
      return (
        fixture.scenario === requirement &&
        input !== undefined &&
        (input.resumeProviderSessionId !== undefined || input.providerSessionId !== undefined) &&
        hasNativeSessionStart(evidence.nativeFrames) &&
        eventTypes.includes('session.started') &&
        eventTypes.includes(fixture.terminalState.type)
      );
    }
    case 'tools':
      return eventTypes.includes('tool.started') && eventTypes.includes('tool.completed');
    case 'usage':
      return eventTypes.some((type) => type === 'usage' || type === 'usage.tokens');
    case 'unknown-additive-fields':
      return (
        evidence.nativeFrames.some((frame) => containsFutureField(frame.value)) &&
        eventTypes.includes(fixture.terminalState.type)
      );
    case 'approval-allow':
      return (
        nativeTypes.includes('approval.requested') &&
        eventTypes.includes('approval.requested') &&
        evidence.events.some((event) => {
          const record = asRecord(event);
          return record?.type === 'approval.resolved' && record.decision === 'allowed';
        }) &&
        eventTypes.includes(fixture.terminalState.type)
      );
    case 'approval-deny':
      return (
        nativeTypes.includes('approval.requested') &&
        eventTypes.includes('approval.requested') &&
        evidence.events.some((event) => {
          const record = asRecord(event);
          return record?.type === 'approval.resolved' && record.decision === 'denied';
        }) &&
        eventTypes.includes(fixture.terminalState.type)
      );
    case 'question-response':
      return (
        nativeTypes.includes('question.requested') &&
        eventTypes.includes('question.requested') &&
        eventTypes.includes('question.resolved') &&
        eventTypes.includes(fixture.terminalState.type)
      );
    case 'interrupt':
      return (
        nativeTypes.includes('turn.interrupted') &&
        nativeTypes.includes('session.interrupted') &&
        eventTypes.includes('turn.interrupted') &&
        eventTypes.includes('session.interrupted') &&
        fixture.terminalState.type === 'session.interrupted' &&
        eventTypes.at(-1) === 'session.interrupted'
      );
    case 'cancellation':
      return eventTypes.includes('session.cancelled') && eventTypes.at(-1) === 'session.cancelled';
    case 'malformed-input':
      return evidence.events.some((event) => {
        const value = asRecord(event);
        return value?.type === 'error' && value.code === 'provider_frame_invalid';
      });
    case 'disconnect':
      return (
        evidence.nativeFrames.some((frame) => {
          const value = asRecord(frame.value);
          return frame.channel === 'lifecycle' && value?.action === 'disconnect';
        }) &&
        evidence.events.some((event) => {
          const value = asRecord(event);
          return value?.type === 'error' && value.code === 'provider_disconnected';
        })
      );
    case 'pre-accept-failure':
      return (
        fixture.startup.acceptedWork === 'reject' &&
        eventTypes.includes('session.failed') &&
        evidence.events.some((event) => asRecord(event)?.code === 'provider_crash')
      );
    case 'post-accept-failure':
      return (
        fixture.startup.acceptedWork === 'accepted' &&
        evidence.nativeFrames.some((frame) => asRecord(frame.value)?.action === 'crash') &&
        eventTypes.includes('session.failed') &&
        evidence.events.some((event) => asRecord(event)?.code === 'provider_crash')
      );
    case 'queue-overflow':
      return (
        evidence.nativeFrames.some((frame) => (frame.repeat ?? 1) > 5_000) &&
        nativeTypes.includes('question.requested') &&
        eventTypes.includes('question.cancelled') &&
        evidence.events.some((event) => asRecord(event)?.code === 'provider_queue_overflow')
      );
    default:
      return false;
  }
}

function hasNativeSessionStart(nativeFrames: FixtureNativeFrame[]): boolean {
  return nativeFrames.some((frame) => {
    const value = asRecord(frame.value);
    return (
      value?.type === 'session.started' ||
      value?.type === 'thread.started' ||
      (value?.type === 'system' && value.subtype === 'init')
    );
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordType(value: unknown): string | undefined {
  const type = asRecord(value)?.type;
  return typeof type === 'string' ? type : undefined;
}

function containsFutureField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsFutureField);
  const record = asRecord(value);
  if (!record) return false;
  return (
    Object.keys(record).some((key) => key.startsWith('future_')) ||
    Object.values(record).some(containsFutureField)
  );
}
