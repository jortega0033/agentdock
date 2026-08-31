import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import Ajv2020 from 'ajv/dist/2020';
import type {
  AgentCommandV2,
  AgentEvent,
  AgentEventV2,
  CapabilitySelection,
  ProviderId,
  ProviderTransportV2,
} from '@agent-dock/shared';
import { agentCommandV2Schema, agentEventEnvelopeSchema } from '@agent-dock/shared';
import { AsyncChannel } from '../../src/process/async-channel.js';
import { noopLogger, type Logger } from '../../src/logger.js';
import { PROVIDER_FIXTURE_SCHEMA_SET } from '../../src/providers/compatibility-manifest.js';
import {
  superviseInteractiveSession,
  type SessionSupervisorOptions,
} from '../../src/providers/common/session-supervisor.js';
import type { ParsedLine } from '../../src/providers/common/run-session.js';
import type {
  AcceptedWorkState,
  InteractiveProviderTransport,
  ProviderInteractionResolution,
  StartInteractiveSessionOptions,
} from '../../src/types.js';

export const PROVIDER_FIXTURE_SCHEMA = 'agent-dock/provider-fixture@1';

export const FIXTURE_IDS = {
  session: '10000000-0000-4000-8000-000000000001',
  execution: '10000000-0000-4000-8000-000000000002',
  turn: '10000000-0000-4000-8000-000000000003',
  followUpTurn: '10000000-0000-4000-8000-000000000004',
  command: '10000000-0000-4000-8000-000000000005',
  request: '10000000-0000-4000-8000-000000000006',
  question: '10000000-0000-4000-8000-000000000007',
  block: '10000000-0000-4000-8000-000000000008',
  toolCall: '10000000-0000-4000-8000-000000000009',
} as const;

const FIXTURE_DEADLINE = '2099-01-01T00:00:00.000Z';
const FIXTURE_ROOT = fileURLToPath(new URL('../conformance', import.meta.url));
const FIXTURES_ROOT = join(FIXTURE_ROOT, 'fixtures');
const FIXTURE_SCHEMA_PATH = join(FIXTURE_ROOT, 'provider-fixture.schema.json');
const validateFixtureSchema = new Ajv2020({ allErrors: true, strictTypes: false }).compile(
  JSON.parse(readFileSync(FIXTURE_SCHEMA_PATH, 'utf8')),
);
const TERMINAL_TYPES = new Set<AgentEventV2['type']>([
  'session.completed',
  'session.failed',
  'session.cancelled',
  'session.interrupted',
]);

type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export interface FixtureNativeFrame {
  phase: string;
  channel: 'stdout' | 'stderr' | 'events' | 'lifecycle';
  value: JsonValue;
  repeat?: number;
}

export interface FixtureControl {
  operation: 'send' | 'interrupt' | 'close';
  afterEvent?: AgentEventV2['type'];
  command?: JsonValue;
}

export interface ProviderFixture {
  schema: typeof PROVIDER_FIXTURE_SCHEMA;
  schemaSet: typeof PROVIDER_FIXTURE_SCHEMA_SET;
  fixtureSet: string;
  id: string;
  protocol: 'v1' | 'v2';
  provider: { id: string; implementation: 'claude' | 'codex' | 'fake'; version: string };
  transport: { id: string; version: string };
  scenario: string;
  covers: string[];
  startup: {
    started: 'resolve';
    acceptedWork: AcceptedWorkState | 'reject';
  };
  nativeInput: JsonValue[];
  nativeOutput: FixtureNativeFrame[];
  controls: FixtureControl[];
  expectedNormalizedEvents: JsonValue[];
  terminalState: {
    type: AgentEventV2['type'] | AgentEvent['type'];
    count: 1;
    acceptedWork: AcceptedWorkState;
    workMayHaveStarted: boolean;
    fallbackAllowed: boolean;
    message?: string;
  };
  cleanup: {
    closeCalls: number;
    forceCloseCalls: number;
    interactionResolutions: number;
    reaped: true;
  };
}

export interface LoadedProviderFixture {
  fixture: ProviderFixture;
  absolutePath: string;
  relativePath: string;
}

export interface RecordedLegacyInvocation {
  argv: JsonValue[];
  stdin: JsonValue;
}

export interface LegacyFixtureReplay {
  events: AgentEvent[];
  nativeFrames: FixtureNativeFrame[];
}

export interface InteractiveFixtureReplay {
  events: AgentEventV2[];
  nativeFrames: FixtureNativeFrame[];
  canonicalEvents: string;
  acceptedWork: AcceptedWorkState;
  sentCommands: AgentCommandV2[];
  resolutions: ProviderInteractionResolution[];
  closeCalls: number;
  forceCloseCalls: number;
  reaped: boolean;
}

const TRANSPORT: ProviderTransportV2 = {
  id: 'fake-interactive',
  priority: 1,
  stability: 'stable',
  possibleEffects: [],
  effectsComplete: true,
};

const SELECTION: CapabilitySelection = {
  transport: TRANSPORT.id,
  enabled: [
    {
      id: 'session.input.follow_up',
      constraints: { kind: 'text_input', maxCharacters: 200_000, attachmentKinds: [] },
    },
    {
      id: 'session.input.steer',
      constraints: { kind: 'text_input', maxCharacters: 200_000, attachmentKinds: [] },
    },
    {
      id: 'session.interrupt',
      constraints: { kind: 'acknowledgement', timeoutMs: 30_000 },
    },
    {
      id: 'session.cancel',
      constraints: { kind: 'acknowledgement', timeoutMs: 30_000 },
    },
    {
      id: 'interaction.approval',
      constraints: { kind: 'interaction', timeoutMs: 300_000, maxPayloadBytes: 32 * 1024 },
    },
    {
      id: 'interaction.question',
      constraints: { kind: 'interaction', timeoutMs: 300_000, maxPayloadBytes: 32 * 1024 },
    },
    {
      id: 'content.tools',
      constraints: { kind: 'effects', allowedEffects: [] },
    },
    {
      id: 'content.usage.tokens',
      constraints: { kind: 'usage', scopes: ['turn', 'session'] },
    },
  ],
  unavailableOptional: [],
  possibleEffects: [],
  effectsComplete: true,
};

const START_OPTIONS: StartInteractiveSessionOptions = {
  sessionId: FIXTURE_IDS.session,
  executionId: FIXTURE_IDS.execution,
  turnId: FIXTURE_IDS.turn,
  cwd: '<redacted:cwd>',
  prompt: '<redacted:prompt>',
  transport: TRANSPORT,
  selection: SELECTION,
};

const MATERIALIZED_STRINGS = new Map<string, string>([
  ['<session-id>', FIXTURE_IDS.session],
  ['<execution-id>', FIXTURE_IDS.execution],
  ['<turn-id>', FIXTURE_IDS.turn],
  ['<follow-up-turn-id>', FIXTURE_IDS.followUpTurn],
  ['<command-id>', FIXTURE_IDS.command],
  ['<request-id>', FIXTURE_IDS.request],
  ['<question-id>', FIXTURE_IDS.question],
  ['<content-block-id>', FIXTURE_IDS.block],
  ['<tool-call-id>', FIXTURE_IDS.toolCall],
  ['<deadline>', FIXTURE_DEADLINE],
]);

const CANONICAL_STRINGS = new Map<string, string>(
  [...MATERIALIZED_STRINGS].map(([placeholder, value]) => [value, placeholder]),
);

const ROOT_KEYS = new Set([
  'schema',
  'schemaSet',
  'fixtureSet',
  'id',
  'protocol',
  'provider',
  'transport',
  'scenario',
  'covers',
  'startup',
  'nativeInput',
  'nativeOutput',
  'controls',
  'expectedNormalizedEvents',
  'terminalState',
  'cleanup',
]);

export function loadProviderFixtures(): LoadedProviderFixture[] {
  return walkJsonFiles(FIXTURES_ROOT)
    .map((absolutePath) => ({
      fixture: parseProviderFixture(JSON.parse(readFileSync(absolutePath, 'utf8')) as unknown),
      absolutePath,
      relativePath: relative(FIXTURE_ROOT, absolutePath).replaceAll('\\', '/'),
    }))
    .sort((left, right) => compareCodeUnits(left.relativePath, right.relativePath));
}

export function parseProviderFixture(value: unknown): ProviderFixture {
  if (!validateFixtureSchema(value)) {
    const failures = (validateFixtureSchema.errors ?? [])
      .map((error) => `${error.instancePath || '/'}:${error.keyword}`)
      .join(', ');
    throw new Error(`fixture failed JSON schema validation: ${failures}`);
  }
  assertRecord(value, 'fixture');
  assertExactKeys(value, ROOT_KEYS, 'fixture');
  if (value.schema !== PROVIDER_FIXTURE_SCHEMA) throw new Error('fixture schema is unsupported');
  if (value.schemaSet !== PROVIDER_FIXTURE_SCHEMA_SET)
    throw new Error('fixture schemaSet is unsupported');
  for (const key of ['fixtureSet', 'id', 'scenario'] as const) assertNonempty(value[key], key);
  if (value.protocol !== 'v1' && value.protocol !== 'v2')
    throw new Error('fixture protocol must be v1 or v2');
  assertProvider(value.provider);
  assertVersionedTransport(value.transport);
  assertStringArray(value.covers, 'covers');
  if (value.covers.length === 0 || !value.covers.includes(value.scenario as string))
    throw new Error('fixture covers must include its scenario');
  assertStartup(value.startup);
  if (!Array.isArray(value.nativeInput) || !Array.isArray(value.nativeOutput))
    throw new Error('fixture nativeInput/nativeOutput must be arrays');
  value.nativeOutput.forEach(assertNativeFrame);
  if (!Array.isArray(value.controls)) throw new Error('fixture controls must be an array');
  value.controls.forEach(assertControl);
  if (!Array.isArray(value.expectedNormalizedEvents) || value.expectedNormalizedEvents.length === 0)
    throw new Error('fixture expectedNormalizedEvents must be a nonempty array');
  value.expectedNormalizedEvents.forEach((event, index) =>
    assertRecord(event, `expectedNormalizedEvents[${index}]`),
  );
  assertTerminal(value.terminalState);
  assertCleanup(value.cleanup);
  return value as unknown as ProviderFixture;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function canonicalNativeJson(value: unknown): string {
  return canonicalJson(normalizeNativeRedactions(value));
}

export function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return CANONICAL_STRINGS.get(value) ?? value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') throw new Error('value is not JSON-compatible');
  if (isExactFixtureSelection(value)) return '<fixture-selection>';
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

export function replayLegacyFixture(
  fixture: ProviderFixture,
  parseLine: (raw: unknown, logger: Logger) => ParsedLine,
): AgentEvent[] {
  return replayLegacyFixtureWithTrace(fixture, parseLine).events;
}

export function replayLegacyFixtureWithTrace(
  fixture: ProviderFixture,
  parseLine: (raw: unknown, logger: Logger) => ParsedLine,
): LegacyFixtureReplay {
  if (fixture.protocol !== 'v1') throw new Error('legacy replay requires a v1 fixture');
  assertRecordedNativeInput(fixture);
  const provider = fixture.provider.id as ProviderId;
  const events: AgentEvent[] = [
    { type: 'session.started', sessionId: FIXTURE_IDS.session, provider },
  ];
  const nativeFrames: FixtureNativeFrame[] = [];
  let providerSessionId: string | undefined;
  for (const frame of fixture.nativeOutput) {
    if (frame.channel !== 'stdout') continue;
    nativeFrames.push(frame);
    for (let index = 0; index < (frame.repeat ?? 1); index += 1) {
      const parsed = parseLine(materialize(frame.value), noopLogger);
      events.push(...parsed.events);
      providerSessionId = parsed.providerSessionId ?? providerSessionId;
    }
  }
  if (fixture.terminalState.type === 'session.completed') {
    events.push({
      type: 'session.completed',
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
    });
  } else if (fixture.terminalState.type === 'session.cancelled') {
    events.push({ type: 'session.cancelled' });
  } else {
    events.push({
      type: 'session.failed',
      message: fixture.terminalState.message ?? 'provider fixture failed',
    });
  }
  for (const [sequence, event] of events.entries()) {
    agentEventEnvelopeSchema.parse({
      ...event,
      sequence,
      timestamp: '2000-01-01T00:00:00.000Z',
    });
  }
  return { events, nativeFrames };
}

export async function replayInteractiveFixture(
  fixture: ProviderFixture,
  limits: SessionSupervisorOptions = {},
): Promise<InteractiveFixtureReplay> {
  if (fixture.protocol !== 'v2') throw new Error('interactive replay requires a v2 fixture');
  const transport = new ReplayInteractiveTransport(fixture);
  const options: StartInteractiveSessionOptions = {
    ...START_OPTIONS,
    transport: { ...TRANSPORT, id: fixture.transport.id },
    selection: { ...SELECTION, transport: fixture.transport.id },
    ...(fixture.scenario === 'resume'
      ? { resumeProviderSessionId: '<redacted:provider-session-id>' }
      : {}),
  };
  assertRecordedNativeInput(fixture, options);
  const handle = await superviseInteractiveSession(transport, options, limits);

  const events: AgentEventV2[] = [];
  let collector: Promise<void> | undefined;
  const startCollector = () => {
    collector ??= (async () => {
      for await (const event of handle.events) events.push(event);
    })();
  };

  if (fixture.scenario !== 'queue-overflow') startCollector();
  transport.begin();

  if (fixture.scenario === 'queue-overflow') {
    await waitFor(() => transport.closeCalls + transport.forceCloseCalls > 0);
    startCollector();
  }

  for (const [index, control] of fixture.controls.entries()) {
    if (control.afterEvent) {
      await waitFor(() => events.some((event) => event.type === control.afterEvent));
    }
    transport.prepareControl(index, control);
    if (control.operation === 'send') {
      const command = agentCommandV2Schema.parse(materialize(control.command));
      await handle.send(command);
      transport.completeSendControl(index);
    } else if (control.operation === 'interrupt') {
      await handle.interrupt();
    } else {
      await handle.close();
    }
  }

  await withTimeout(collector ?? Promise.resolve(), 5_000, `fixture ${fixture.id} did not finish`);
  const acceptedWork = await handle.accepted;
  return {
    events,
    nativeFrames: transport.nativeFrames,
    canonicalEvents: canonicalJson(events),
    acceptedWork,
    sentCommands: transport.sentCommands,
    resolutions: transport.resolutions,
    closeCalls: transport.closeCalls,
    forceCloseCalls: transport.forceCloseCalls,
    reaped: transport.reaped,
  };
}

class ReplayInteractiveTransport implements InteractiveProviderTransport {
  private readonly channel = new AsyncChannel<JsonValue | LifecycleFrame>(10_000);
  private readonly acceptance = deferred<AcceptedWorkState>();
  private preparedControl: { index: number; control: FixtureControl } | undefined;
  private closed = false;
  readonly sentCommands: AgentCommandV2[] = [];
  readonly resolutions: ProviderInteractionResolution[] = [];
  readonly nativeFrames: FixtureNativeFrame[] = [];
  readonly started = Promise.resolve();
  readonly accepted = this.acceptance.promise;
  readonly events = this.readEvents();
  readonly stderr = (async function* (): AsyncGenerator<unknown, void, void> {
    // Replay fixtures keep stderr as bounded, sanitized metadata only.
  })();
  closeCalls = 0;
  forceCloseCalls = 0;
  reaped = false;

  constructor(private readonly fixture: ProviderFixture) {}

  begin(): void {
    if (this.fixture.startup.acceptedWork === 'reject') {
      this.acceptance.reject(new Error('fixture acceptance failed'));
    } else {
      this.acceptance.resolve(this.fixture.startup.acceptedWork);
    }
    this.emitPhase('startup');
  }

  prepareControl(index: number, control: FixtureControl): void {
    this.preparedControl = { index, control };
  }

  completeSendControl(index: number): void {
    this.consumePreparedControl(index, 'send');
    this.emitPhase(`control:${index}`);
  }

  async send(command: AgentCommandV2): Promise<void> {
    const prepared = this.preparedControl;
    if (!prepared || prepared.control.operation !== 'send')
      throw new Error('fixture received an unexpected send');
    const expected = agentCommandV2Schema.parse(materialize(prepared.control.command));
    if (canonicalJson(command) !== canonicalJson(expected))
      throw new Error('fixture command did not match the recorded control');
    this.sentCommands.push(command);
  }

  async resolveInteraction(resolution: ProviderInteractionResolution): Promise<void> {
    this.resolutions.push(resolution);
  }

  async interrupt(): Promise<void> {
    const prepared = this.preparedControl;
    if (!prepared || prepared.control.operation !== 'interrupt')
      throw new Error('fixture received an unexpected interrupt');
    this.consumePreparedControl(prepared.index, 'interrupt');
    this.emitPhase(`control:${prepared.index}`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeCalls += 1;
    const prepared = this.preparedControl;
    if (prepared?.control.operation === 'close') {
      this.consumePreparedControl(prepared.index, 'close');
      this.emitPhase(`control:${prepared.index}`);
    }
    this.channel.close();
    this.reaped = true;
  }

  async forceClose(): Promise<void> {
    if (this.reaped) return;
    this.forceCloseCalls += 1;
    this.closed = true;
    this.channel.close();
    this.reaped = true;
  }

  private consumePreparedControl(index: number, operation: FixtureControl['operation']): void {
    const prepared = this.preparedControl;
    if (!prepared || prepared.index !== index || prepared.control.operation !== operation)
      throw new Error(`fixture control ${index} did not match ${operation}`);
    this.preparedControl = undefined;
  }

  private emitPhase(phase: string): void {
    for (const frame of this.fixture.nativeOutput.filter(
      (candidate) => candidate.phase === phase,
    )) {
      this.nativeFrames.push(frame);
      for (let index = 0; index < (frame.repeat ?? 1); index += 1) {
        if (frame.channel === 'stderr') continue;
        if (frame.channel === 'lifecycle') {
          const value = frame.value as { action?: JsonValue; message?: JsonValue };
          this.channel.push({
            lifecycle: value.action === 'crash' ? 'crash' : 'disconnect',
            message: typeof value.message === 'string' ? value.message : undefined,
          });
          this.channel.close();
          continue;
        }
        if (frame.channel !== 'events') continue;
        const value = materialize(frame.value);
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          (value as Record<string, unknown>).selection === '<fixture-selection>'
        ) {
          (value as Record<string, unknown>).selection = {
            ...SELECTION,
            transport: this.fixture.transport.id,
          };
        }
        if (!this.channel.push(value as JsonValue))
          throw new Error('fixture replay input queue overflowed before supervisor consumption');
      }
    }
  }

  private async *readEvents(): AsyncGenerator<unknown, void, void> {
    for await (const value of this.channel) {
      if (isLifecycleFrame(value)) {
        if (value.lifecycle === 'crash') throw new Error(value.message ?? 'fixture provider crash');
        return;
      }
      yield value;
    }
  }
}

interface LifecycleFrame {
  lifecycle: 'crash' | 'disconnect';
  message?: string;
}

function isLifecycleFrame(value: JsonValue | LifecycleFrame): value is LifecycleFrame {
  return !!value && typeof value === 'object' && !Array.isArray(value) && 'lifecycle' in value;
}

function materialize(value: unknown): unknown {
  if (typeof value === 'string') return MATERIALIZED_STRINGS.get(value) ?? value;
  if (Array.isArray(value)) return value.map(materialize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, materialize(item)]),
  );
}

export function recordedNativeInput(fixture: ProviderFixture): Record<string, JsonValue>[] {
  if (fixture.nativeInput.length === 0) throw new Error('fixture nativeInput must not be empty');
  return fixture.nativeInput.map((value, index) => {
    assertRecord(value, `nativeInput[${index}]`);
    return value as Record<string, JsonValue>;
  });
}

export function recordedLegacyInvocation(fixture: ProviderFixture): RecordedLegacyInvocation {
  if (fixture.protocol !== 'v1') throw new Error('legacy invocation requires a v1 fixture');
  return assertLegacyInvocation(recordedNativeInput(fixture)[0]!);
}

function assertRecordedNativeInput(
  fixture: ProviderFixture,
  options?: StartInteractiveSessionOptions,
): void {
  const input = recordedNativeInput(fixture)[0]!;
  if (!isRedaction(input.prompt, 'prompt')) {
    throw new Error('fixture nativeInput must contain a redacted prompt');
  }
  if (options && !sameRedaction(input.prompt, options.prompt, 'prompt')) {
    throw new Error('fixture prompt does not match interactive start options');
  }
  if (input.cwd !== undefined) {
    if (!isRedaction(input.cwd, 'cwd')) throw new Error('fixture cwd must be redacted');
    if (options && !sameRedaction(input.cwd, options.cwd, 'cwd')) {
      throw new Error('fixture cwd does not match interactive start options');
    }
  }
  const recordedResume = input.resumeProviderSessionId ?? input.providerSessionId;
  if (fixture.scenario === 'resume') {
    assertNonempty(recordedResume, 'nativeInput resume provider session id');
    if (options && recordedResume !== options.resumeProviderSessionId) {
      throw new Error('fixture resume id does not match interactive start options');
    }
  } else if (options?.resumeProviderSessionId !== undefined) {
    throw new Error('fresh fixture unexpectedly received a resume id');
  }
  if (fixture.protocol === 'v1') assertLegacyInvocation(input);
}

function assertLegacyInvocation(input: Record<string, JsonValue>): RecordedLegacyInvocation {
  if (!Array.isArray(input.argv) || input.argv.length === 0) {
    throw new Error('legacy fixture nativeInput must record argv');
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'stdin')) {
    throw new Error('legacy fixture nativeInput must record stdin');
  }
  for (const [index, argument] of input.argv.entries()) {
    if (typeof argument !== 'string' && redactionKind(argument) === undefined) {
      throw new Error(`legacy fixture argv[${index}] must be a string or typed placeholder`);
    }
  }
  return { argv: input.argv, stdin: input.stdin! };
}

function isRedaction(value: JsonValue | undefined, kind: 'prompt' | 'cwd'): boolean {
  return redactionKind(value) === (kind === 'cwd' ? 'working_directory' : kind);
}

function sameRedaction(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
  kind: 'prompt' | 'cwd',
): boolean {
  const expected = kind === 'cwd' ? 'working_directory' : kind;
  return redactionKind(left) === expected && redactionKind(right) === expected;
}

function redactionKind(value: JsonValue | undefined): string | undefined {
  if (value === '<redacted:prompt>') return 'prompt';
  if (value === '<redacted:cwd>') return 'working_directory';
  return !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof value.$fixturePlaceholder === 'string'
    ? value.$fixturePlaceholder
    : undefined;
}

function normalizeNativeRedactions(value: unknown): unknown {
  const kind = redactionKind(value as JsonValue | undefined);
  if (kind !== undefined) return { $fixturePlaceholder: kind };
  if (Array.isArray(value)) return value.map(normalizeNativeRedactions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      normalizeNativeRedactions(item),
    ]),
  );
}

function isExactFixtureSelection(value: object): boolean {
  if (Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.transport !== 'string') return false;
  return isDeepStrictEqual(value, { ...SELECTION, transport: record.transport });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function walkJsonFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkJsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path);
  }
  return files;
}

function assertProvider(value: unknown): void {
  assertRecord(value, 'provider');
  assertExactKeys(value, new Set(['id', 'implementation', 'version']), 'provider');
  assertNonempty(value.id, 'provider.id');
  assertNonempty(value.version, 'provider.version');
  if (!['claude', 'codex', 'fake'].includes(String(value.implementation)))
    throw new Error('provider.implementation is invalid');
}

function assertVersionedTransport(value: unknown): void {
  assertRecord(value, 'transport');
  assertExactKeys(value, new Set(['id', 'version']), 'transport');
  assertNonempty(value.id, 'transport.id');
  assertNonempty(value.version, 'transport.version');
}

function assertStartup(value: unknown): void {
  assertRecord(value, 'startup');
  assertExactKeys(value, new Set(['started', 'acceptedWork']), 'startup');
  if (value.started !== 'resolve') throw new Error('startup.started must be resolve');
  if (!['not_accepted', 'accepted', 'unknown', 'reject'].includes(String(value.acceptedWork)))
    throw new Error('startup.acceptedWork is invalid');
}

function assertNativeFrame(value: unknown, index: number): void {
  assertRecord(value, `nativeOutput[${index}]`);
  assertExactKeys(
    value,
    new Set(['phase', 'channel', 'value', 'repeat']),
    `nativeOutput[${index}]`,
  );
  assertNonempty(value.phase, `nativeOutput[${index}].phase`);
  if (!['stdout', 'stderr', 'events', 'lifecycle'].includes(String(value.channel)))
    throw new Error(`nativeOutput[${index}].channel is invalid`);
  if (!('value' in value)) throw new Error(`nativeOutput[${index}].value is required`);
  if (
    value.repeat !== undefined &&
    (!Number.isInteger(value.repeat) ||
      (value.repeat as number) < 1 ||
      (value.repeat as number) > 6_000)
  ) {
    throw new Error(`nativeOutput[${index}].repeat is invalid`);
  }
}

function assertControl(value: unknown, index: number): void {
  assertRecord(value, `controls[${index}]`);
  assertExactKeys(value, new Set(['operation', 'afterEvent', 'command']), `controls[${index}]`);
  if (!['send', 'interrupt', 'close'].includes(String(value.operation)))
    throw new Error(`controls[${index}].operation is invalid`);
  if (value.afterEvent !== undefined)
    assertNonempty(value.afterEvent, `controls[${index}].afterEvent`);
  if (value.operation === 'send' && value.command === undefined)
    throw new Error(`controls[${index}].command is required`);
  if (value.operation !== 'send' && value.command !== undefined)
    throw new Error(`controls[${index}].command is only valid for send`);
}

function assertTerminal(value: unknown): void {
  assertRecord(value, 'terminalState');
  assertExactKeys(
    value,
    new Set(['type', 'count', 'acceptedWork', 'workMayHaveStarted', 'fallbackAllowed', 'message']),
    'terminalState',
  );
  assertNonempty(value.type, 'terminalState.type');
  if (!TERMINAL_TYPES.has(value.type as AgentEventV2['type'])) {
    throw new Error('terminalState.type must be terminal');
  }
  if (value.count !== 1) throw new Error('terminalState.count must be one');
  if (!['not_accepted', 'accepted', 'unknown'].includes(String(value.acceptedWork)))
    throw new Error('terminalState.acceptedWork is invalid');
  if (typeof value.workMayHaveStarted !== 'boolean' || typeof value.fallbackAllowed !== 'boolean')
    throw new Error('terminalState work/fallback flags must be boolean');
}

function assertCleanup(value: unknown): void {
  assertRecord(value, 'cleanup');
  assertExactKeys(
    value,
    new Set(['closeCalls', 'forceCloseCalls', 'interactionResolutions', 'reaped']),
    'cleanup',
  );
  for (const key of ['closeCalls', 'forceCloseCalls', 'interactionResolutions'] as const) {
    if (!Number.isInteger(value[key]) || (value[key] as number) < 0)
      throw new Error(`cleanup.${key} is invalid`);
  }
  if (value.reaped !== true) throw new Error('cleanup.reaped must be true');
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unknown field ${key}`);
  }
}

function assertNonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be nonempty`);
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0))
    throw new Error(`${label} must contain nonempty strings`);
  if (new Set(value).size !== value.length) throw new Error(`${label} must be unique`);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for fixture replay state');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function expectedCanonicalEvents(fixture: ProviderFixture): string {
  return canonicalJson(fixture.expectedNormalizedEvents);
}

export function terminalEvents(events: AgentEventV2[]): AgentEventV2[] {
  return events.filter((event) => TERMINAL_TYPES.has(event.type));
}
