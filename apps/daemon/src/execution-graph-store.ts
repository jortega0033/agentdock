import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import {
  AUTH_SOURCES,
  PROVIDER_IDS,
  agentEventV2EnvelopeSchema,
  agentSessionV2Schema,
  providerSessionIdV2Schema,
  sessionEventHistoryV2PageSchema,
  sessionEventHistoryV2QuerySchema,
  sessionListV2PageSchema,
  sessionListV2QuerySchema,
  type AgentEventV2Envelope,
  type AgentSessionV2,
  type ProviderId,
  type SessionEventHistoryV2Page,
  type SessionEventHistoryV2Query,
  type SessionListV2Page,
  type SessionListV2Query,
} from '@agent-dock/shared';
import type { ProviderContinuationScope } from './provider-v2.js';

const CURRENT_SCHEMA_VERSION = 1;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_RECORDS = 500;
const DEFAULT_MAX_BYTES = 250 * 1024 * 1024;
const TERMINAL_STATUSES = new Set<AgentSessionV2['status']>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

const continuationScopeSchema = z
  .object({
    provider: z.enum(PROVIDER_IDS),
    cwd: z.string().min(1).max(32_768),
    executablePath: z.string().min(1).max(32_768),
    providerVersion: z.string().min(1).max(1_024),
    authenticated: z.literal('authenticated'),
    authSource: z.enum(AUTH_SOURCES).refine((value) => value !== 'unknown'),
    accountFingerprint: z.string().min(1).max(1_024),
    selectedModel: z.string().min(1).max(1_024),
    workspaceTrust: z
      .object({
        state: z.literal('trusted'),
        workspaceId: z.string().min(1).max(1_024),
        incarnation: z.string().min(1).max(1_024),
        trustEpoch: z.number().int().finite().nonnegative(),
      })
      .strict(),
  })
  .strict();

const durableExecutionRecordSchema = z
  .object({
    session: agentSessionV2Schema,
    interactive: z.boolean(),
    continuationScope: continuationScopeSchema.optional(),
  })
  .strict();

const storedRecordSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    record: durableExecutionRecordSchema,
  })
  .strict();
const storedRecordV0Schema = z
  .object({
    schemaVersion: z.literal(0),
    record: durableExecutionRecordSchema,
  })
  .strict();
const unversionedStoredRecordSchema = z
  .object({
    record: durableExecutionRecordSchema,
  })
  .strict();

const manifestSchema = z.object({ version: z.literal(CURRENT_SCHEMA_VERSION) }).strict();
const manifestV0Schema = z.object({ version: z.literal(0) }).strict();
const tombstoneSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    rootExecutionId: z.string().uuid(),
    deletedAt: z.string().datetime({ offset: true }),
    reason: z.enum(['explicit', 'retention']),
  })
  .strict();

interface Tombstone {
  schemaVersion: 1;
  rootExecutionId: string;
  deletedAt: string;
  reason: 'explicit' | 'retention';
}

export interface DurableExecutionRecord {
  session: AgentSessionV2;
  interactive: boolean;
  continuationScope?: ProviderContinuationScope;
}

export type ExecutionGraphStoreErrorCode =
  | 'active_lineage'
  | 'continuation_binding_not_found'
  | 'continuation_in_use'
  | 'continuation_not_found'
  | 'continuation_parent_active'
  | 'continuation_scope_mismatch'
  | 'corrupt_store'
  | 'discard_forbidden'
  | 'duplicate_session'
  | 'immutable_lineage'
  | 'invalid_cursor'
  | 'invalid_event'
  | 'invalid_record'
  | 'session_not_found'
  | 'storage_full'
  | 'unsupported_schema';

export class ExecutionGraphStoreError extends Error {
  constructor(
    readonly code: ExecutionGraphStoreErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'ExecutionGraphStoreError';
  }
}

export interface ExecutionGraphRecoveryReport {
  interruptedSessionIds: string[];
  quarantinedPaths: string[];
  migratedFromVersion?: number;
}

export interface ExecutionGraphStore {
  reserve(record: DurableExecutionRecord): void;
  discard(sessionId: string): void;
  update(record: DurableExecutionRecord): void;
  get(id: string): DurableExecutionRecord | undefined;
  list(query?: SessionListV2Query): SessionListV2Page;
  history(id: string, query?: SessionEventHistoryV2Query): SessionEventHistoryV2Page | undefined;
  appendEvent(id: string, event: AgentEventV2Envelope): void;
  deleteLineage(id: string): boolean;
  acquireContinuation(provider: ProviderId, nativeId: string, leaseId: string): void;
  releaseContinuation(provider: ProviderId, nativeId: string, leaseId: string): void;
  recoveryReport(): ExecutionGraphRecoveryReport;
}

export interface ExecutionGraphStoreOptions {
  maxAgeMs?: number;
  maxRecords?: number;
  maxBytes?: number;
  now?: () => Date;
  /** Other daemon-owned state whose bytes must count toward the same global storage ceiling. */
  additionalQuotaPaths?: string[];
  /** Best-effort cleanup of compatibility metadata after the graph deletion commits. */
  onLineageRemoving?: (records: readonly DurableExecutionRecord[]) => void;
}

interface CursorPayload {
  version: 1;
  kind: 'history' | 'list';
  after?: string;
  sessionId?: string;
  nextSequence?: number;
}

function storeError(code: ExecutionGraphStoreErrorCode, message: string): never {
  throw new ExecutionGraphStoreError(code, message);
}

function parseRecord(value: unknown): DurableExecutionRecord {
  try {
    const parsed = durableExecutionRecordSchema.parse(value);
    const session = { ...parsed.session };
    if (session.parentSessionId === undefined) {
      if (session.parentExecutionId !== undefined) {
        storeError('invalid_record', 'a root execution cannot have a parent execution id');
      }
      session.rootExecutionId ??= session.executionId;
      session.continuationKind ??= 'fresh';
      if (session.rootExecutionId !== session.executionId || session.continuationKind !== 'fresh') {
        storeError('invalid_record', 'fresh execution lineage is inconsistent');
      }
    } else if (
      session.rootExecutionId === undefined ||
      session.parentExecutionId === undefined ||
      (session.continuationKind !== 'resume' && session.continuationKind !== 'fork')
    ) {
      storeError('invalid_record', 'continued execution requires complete lineage metadata');
    }
    return durableExecutionRecordSchema.parse({ ...parsed, session }) as DurableExecutionRecord;
  } catch (error) {
    if (error instanceof ExecutionGraphStoreError) throw error;
    throw new ExecutionGraphStoreError('invalid_record', 'invalid durable execution record');
  }
}

function parseStoredRecord(value: unknown): {
  record: DurableExecutionRecord;
  needsMigration: boolean;
} {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const version = (value as { schemaVersion?: unknown }).schemaVersion;
    if (typeof version === 'number' && version > CURRENT_SCHEMA_VERSION) {
      storeError('unsupported_schema', 'unsupported execution record schema version');
    }
  }
  const current = storedRecordSchema.safeParse(value);
  if (current.success) return { record: parseRecord(current.data.record), needsMigration: false };
  const versionZero = storedRecordV0Schema.safeParse(value);
  if (versionZero.success) {
    return { record: parseRecord(versionZero.data.record), needsMigration: true };
  }
  const unversioned = unversionedStoredRecordSchema.safeParse(value);
  if (unversioned.success) {
    return { record: parseRecord(unversioned.data.record), needsMigration: true };
  }
  try {
    return { record: parseRecord(value), needsMigration: true };
  } catch {
    storeError('invalid_record', 'invalid stored execution record');
  }
}

function parseEvent(value: unknown): AgentEventV2Envelope {
  try {
    return agentEventV2EnvelopeSchema.parse(value) as AgentEventV2Envelope;
  } catch {
    throw new ExecutionGraphStoreError('invalid_event', 'invalid normalized execution event');
  }
}

function cloneRecord(record: DurableExecutionRecord): DurableExecutionRecord {
  return parseRecord(record);
}

function rootExecutionId(record: DurableExecutionRecord): string {
  return record.session.rootExecutionId ?? record.session.executionId;
}

function isTerminal(record: DurableExecutionRecord): boolean {
  return TERMINAL_STATUSES.has(record.session.status);
}

function recoveredLineageIsValid(
  rootId: string,
  records: readonly DurableExecutionRecord[],
): boolean {
  if (records.length === 0) return false;
  const recordsBySessionId = new Map<string, DurableExecutionRecord>();
  const executionIds = new Set<string>();
  for (const record of records) {
    if (
      rootExecutionId(record) !== rootId ||
      recordsBySessionId.has(record.session.id) ||
      executionIds.has(record.session.executionId)
    ) {
      return false;
    }
    recordsBySessionId.set(record.session.id, record);
    executionIds.add(record.session.executionId);
  }

  const roots = records.filter((record) => record.session.parentSessionId === undefined);
  if (roots.length !== 1 || roots[0]?.session.executionId !== rootId) return false;
  const rootSessionId = roots[0].session.id;

  for (const record of records) {
    const parentSessionId = record.session.parentSessionId;
    if (parentSessionId === undefined) continue;
    const parent = recordsBySessionId.get(parentSessionId);
    if (
      !parent ||
      !isTerminal(parent) ||
      !parent.session.providerSessionId ||
      record.session.provider !== parent.session.provider ||
      record.session.parentExecutionId !== parent.session.executionId ||
      rootExecutionId(parent) !== rootId
    ) {
      return false;
    }
  }

  for (const record of records) {
    const visited = new Set<string>();
    let current: DurableExecutionRecord | undefined = record;
    while (current.session.parentSessionId !== undefined) {
      if (visited.has(current.session.id)) return false;
      visited.add(current.session.id);
      current = recordsBySessionId.get(current.session.parentSessionId);
      if (!current) return false;
    }
    if (current.session.id !== rootSessionId) return false;
  }
  return true;
}

function terminalStateFromEvent(
  event: AgentEventV2Envelope,
): Pick<AgentSessionV2, 'status' | 'completedAt' | 'terminalReason'> | undefined {
  switch (event.type) {
    case 'session.completed':
      return { status: 'completed', completedAt: event.timestamp, terminalReason: 'completed' };
    case 'session.failed':
      return {
        status: 'failed',
        completedAt: event.timestamp,
        terminalReason: event.code ?? 'failed',
      };
    case 'session.cancelled':
      return {
        status: 'cancelled',
        completedAt: event.timestamp,
        terminalReason: event.reason ?? 'cancelled',
      };
    case 'session.interrupted':
      return {
        status: 'interrupted',
        completedAt: event.timestamp,
        terminalReason: event.reason ?? 'interrupted',
      };
    default:
      return undefined;
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, kind: CursorPayload['kind']): CursorPayload {
  if (cursor === undefined) return { version: 1, kind };
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) {
    storeError('invalid_cursor', 'invalid execution graph cursor');
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
    if (
      parsed.version !== 1 ||
      parsed.kind !== kind ||
      (parsed.after !== undefined && typeof parsed.after !== 'string') ||
      (parsed.sessionId !== undefined && typeof parsed.sessionId !== 'string') ||
      (parsed.nextSequence !== undefined &&
        (!Number.isSafeInteger(parsed.nextSequence) || parsed.nextSequence < 0))
    ) {
      storeError('invalid_cursor', 'invalid execution graph cursor');
    }
    return parsed;
  } catch (error) {
    if (error instanceof ExecutionGraphStoreError) throw error;
    throw new ExecutionGraphStoreError('invalid_cursor', 'invalid execution graph cursor');
  }
}

function validateLease(provider: ProviderId, nativeId: string, leaseId: string): void {
  if (!PROVIDER_IDS.includes(provider)) {
    storeError('invalid_record', 'invalid continuation provider');
  }
  if (!providerSessionIdV2Schema.safeParse(nativeId).success) {
    storeError('invalid_record', 'invalid provider continuation id');
  }
  const containsControlCharacter = [...leaseId].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (!leaseId || Buffer.byteLength(leaseId) > 256 || containsControlCharacter) {
    storeError('invalid_record', 'invalid continuation lease id');
  }
}

/** In-process execution graph with the same validation, pagination, lineage, and lock semantics. */
export class MemoryExecutionGraphStore implements ExecutionGraphStore {
  protected readonly recordsById = new Map<string, DurableExecutionRecord>();
  protected readonly eventsById = new Map<string, AgentEventV2Envelope[]>();
  protected readonly continuationLocks = new Map<string, string>();
  protected readonly deletedRootIds = new Set<string>();
  protected readonly report: ExecutionGraphRecoveryReport = {
    interruptedSessionIds: [],
    quarantinedPaths: [],
  };

  reserve(input: DurableExecutionRecord): void {
    const record = parseRecord(input);
    this.assertReservable(record);
    this.persistReserve(record);
    this.recordsById.set(record.session.id, record);
    this.eventsById.set(record.session.id, []);
  }

  discard(sessionId: string): void {
    const record = this.recordsById.get(sessionId);
    if (!record) return;
    const hasEvents = (this.eventsById.get(sessionId)?.length ?? 0) > 0;
    const hasDescendants = [...this.recordsById.values()].some(
      (candidate) => candidate.session.parentSessionId === sessionId,
    );
    if (record.session.status !== 'starting' || hasEvents || hasDescendants) {
      storeError('discard_forbidden', 'only an eventless leaf reservation can be discarded');
    }
    const lineageIds = this.lineageIds(rootExecutionId(record));
    this.persistDiscard(record, lineageIds.length === 1);
    this.recordsById.delete(sessionId);
    this.eventsById.delete(sessionId);
  }

  update(input: DurableExecutionRecord): void {
    const record = parseRecord(input);
    const previous = this.recordsById.get(record.session.id);
    if (!previous) storeError('session_not_found', 'session not found');
    this.assertImmutable(previous, record);
    this.persistUpdate(previous, record);
    this.recordsById.set(record.session.id, record);
  }

  get(id: string): DurableExecutionRecord | undefined {
    const record = this.recordsById.get(id);
    return record ? cloneRecord(record) : undefined;
  }

  list(query: SessionListV2Query = {}): SessionListV2Page {
    let parsed: SessionListV2Query;
    try {
      parsed = sessionListV2QuerySchema.parse(query);
    } catch {
      storeError('invalid_cursor', 'invalid session pagination query');
    }
    const cursor = decodeCursor(parsed.cursor, 'list');
    const sessions = [...this.recordsById.values()]
      .map((record) => record.session)
      .sort((left, right) => {
        const timeOrder = right.startedAt.localeCompare(left.startedAt);
        return timeOrder === 0 ? left.id.localeCompare(right.id) : timeOrder;
      });
    let start = 0;
    if (cursor.after !== undefined) {
      const index = sessions.findIndex((session) => session.id === cursor.after);
      if (index < 0) storeError('invalid_cursor', 'session cursor no longer exists');
      start = index + 1;
    }
    const limit = parsed.limit ?? DEFAULT_PAGE_SIZE;
    const page = sessions.slice(start, start + limit);
    return sessionListV2PageSchema.parse({
      sessions: page,
      ...(start + page.length < sessions.length && page.length > 0
        ? {
            nextCursor: encodeCursor({
              version: 1,
              kind: 'list',
              after: page.at(-1)?.id,
            }),
          }
        : {}),
    }) as SessionListV2Page;
  }

  history(
    id: string,
    query: SessionEventHistoryV2Query = {},
  ): SessionEventHistoryV2Page | undefined {
    if (!this.recordsById.has(id)) return undefined;
    let parsed: SessionEventHistoryV2Query;
    try {
      parsed = sessionEventHistoryV2QuerySchema.parse(query);
    } catch {
      storeError('invalid_cursor', 'invalid event pagination query');
    }
    const cursor = decodeCursor(parsed.cursor, 'history');
    if (cursor.sessionId !== undefined && cursor.sessionId !== id) {
      storeError('invalid_cursor', 'event cursor belongs to another session');
    }
    const source = this.eventsById.get(id) ?? [];
    const nextSequence = cursor.nextSequence ?? source[0]?.sequence ?? 0;
    const start = source.findIndex((event) => event.sequence >= nextSequence);
    const offset = start < 0 ? source.length : start;
    const limit = parsed.limit ?? DEFAULT_PAGE_SIZE;
    const events = source.slice(offset, offset + limit);
    return sessionEventHistoryV2PageSchema.parse({
      events,
      ...(offset + events.length < source.length && events.length > 0
        ? {
            nextCursor: encodeCursor({
              version: 1,
              kind: 'history',
              sessionId: id,
              nextSequence: (events.at(-1)?.sequence ?? 0) + 1,
            }),
          }
        : {}),
    }) as SessionEventHistoryV2Page;
  }

  appendEvent(id: string, input: AgentEventV2Envelope): void {
    const record = this.recordsById.get(id);
    if (!record) storeError('session_not_found', 'session not found');
    const event = parseEvent(input);
    if (
      event.sessionId !== id ||
      event.executionId !== record.session.executionId ||
      event.parentExecutionId !== record.session.parentExecutionId
    ) {
      storeError('invalid_event', 'event lineage does not match its session');
    }
    const events = this.eventsById.get(id) ?? [];
    const last = events.at(-1);
    if (last && event.sequence === last.sequence && canonical(last) === canonical(event)) return;
    if (last && terminalStateFromEvent(last)) {
      storeError('invalid_event', 'a terminal event must be the final normalized event');
    }
    const expected = last ? last.sequence + 1 : record.session.earliestSequence;
    if (event.sequence !== expected) {
      storeError('invalid_event', `expected event sequence ${expected}`);
    }
    this.persistAppendEvent(record, event);
    events.push(event);
    this.eventsById.set(id, events);
  }

  deleteLineage(id: string): boolean {
    const record = this.recordsById.get(id);
    if (!record) return false;
    this.removeLineage(rootExecutionId(record), 'explicit');
    return true;
  }

  acquireContinuation(provider: ProviderId, nativeId: string, leaseId: string): void {
    validateLease(provider, nativeId, leaseId);
    const key = canonical([provider, nativeId]);
    const existing = this.continuationLocks.get(key);
    if (existing !== undefined && existing !== leaseId) {
      storeError('continuation_in_use', 'provider continuation is already in use');
    }
    this.continuationLocks.set(key, leaseId);
  }

  releaseContinuation(provider: ProviderId, nativeId: string, leaseId: string): void {
    validateLease(provider, nativeId, leaseId);
    const key = canonical([provider, nativeId]);
    if (this.continuationLocks.get(key) === leaseId) this.continuationLocks.delete(key);
  }

  recoveryReport(): ExecutionGraphRecoveryReport {
    return {
      interruptedSessionIds: [...this.report.interruptedSessionIds],
      quarantinedPaths: [...this.report.quarantinedPaths],
      ...(this.report.migratedFromVersion === undefined
        ? {}
        : { migratedFromVersion: this.report.migratedFromVersion }),
    };
  }

  protected assertReservable(record: DurableExecutionRecord): void {
    if (this.deletedRootIds.has(rootExecutionId(record))) {
      storeError('immutable_lineage', 'a tombstoned execution lineage cannot be recreated');
    }
    if (this.recordsById.has(record.session.id)) {
      storeError('duplicate_session', 'session already exists');
    }
    const parentId = record.session.parentSessionId;
    if (!parentId) return;
    const parent = this.recordsById.get(parentId);
    if (!parent) storeError('continuation_not_found', 'continuation parent was not found');
    if (!isTerminal(parent)) {
      storeError('continuation_parent_active', 'continuation parent must be terminal');
    }
    if (!parent.session.providerSessionId) {
      storeError('continuation_binding_not_found', 'parent has no provider continuation id');
    }
    if (
      record.session.provider !== parent.session.provider ||
      record.session.parentExecutionId !== parent.session.executionId ||
      rootExecutionId(record) !== rootExecutionId(parent)
    ) {
      storeError('continuation_scope_mismatch', 'continuation lineage does not match its parent');
    }
  }

  protected assertImmutable(previous: DurableExecutionRecord, next: DurableExecutionRecord): void {
    const previousLineage = {
      id: previous.session.id,
      provider: previous.session.provider,
      cwd: previous.session.cwd,
      transport: previous.session.transport,
      selection: previous.session.selection,
      startedAt: previous.session.startedAt,
      executionId: previous.session.executionId,
      rootExecutionId: previous.session.rootExecutionId,
      parentSessionId: previous.session.parentSessionId,
      parentExecutionId: previous.session.parentExecutionId,
      continuationKind: previous.session.continuationKind,
      interactive: previous.interactive,
    };
    const nextLineage = {
      id: next.session.id,
      provider: next.session.provider,
      cwd: next.session.cwd,
      transport: next.session.transport,
      selection: next.session.selection,
      startedAt: next.session.startedAt,
      executionId: next.session.executionId,
      rootExecutionId: next.session.rootExecutionId,
      parentSessionId: next.session.parentSessionId,
      parentExecutionId: next.session.parentExecutionId,
      continuationKind: next.session.continuationKind,
      interactive: next.interactive,
    };
    if (canonical(previousLineage) !== canonical(nextLineage)) {
      storeError('immutable_lineage', 'execution lineage fields are immutable');
    }
    if (
      previous.session.providerSessionId !== undefined &&
      previous.session.providerSessionId !== next.session.providerSessionId
    ) {
      storeError('immutable_lineage', 'provider continuation id is immutable once recorded');
    }
    if (
      previous.continuationScope !== undefined &&
      canonical(previous.continuationScope) !== canonical(next.continuationScope)
    ) {
      storeError('immutable_lineage', 'continuation scope is immutable once recorded');
    }
    if (
      isTerminal(previous) &&
      (previous.session.status !== next.session.status ||
        previous.session.completedAt !== next.session.completedAt ||
        previous.session.terminalReason !== next.session.terminalReason)
    ) {
      storeError('immutable_lineage', 'terminal execution state is immutable');
    }
  }

  protected lineageIds(rootId: string): string[] {
    return [...this.recordsById.values()]
      .filter((record) => rootExecutionId(record) === rootId)
      .map((record) => record.session.id);
  }

  protected removeLineage(rootId: string, reason: 'explicit' | 'retention'): void {
    const ids = this.lineageIds(rootId);
    if (ids.length === 0) return;
    const records = ids.map((id) => this.recordsById.get(id) as DurableExecutionRecord);
    if (!records.every(isTerminal)) {
      storeError('active_lineage', 'an active execution prevents whole-lineage deletion');
    }
    if (records.some((record) => this.hasContinuationLock(record))) {
      storeError('continuation_in_use', 'a continuation lease prevents lineage deletion');
    }
    this.persistLineageRemoval(rootId, records, reason);
    for (const id of ids) {
      this.recordsById.delete(id);
      this.eventsById.delete(id);
    }
    this.deletedRootIds.add(rootId);
  }

  protected persistReserve(_record: DurableExecutionRecord): void {}

  protected hasContinuationLock(record: DurableExecutionRecord): boolean {
    const nativeId = record.session.providerSessionId;
    return nativeId
      ? this.continuationLocks.has(canonical([record.session.provider, nativeId]))
      : false;
  }

  protected persistDiscard(_record: DurableExecutionRecord, _onlyLineageRecord: boolean): void {}

  protected persistUpdate(
    _previous: DurableExecutionRecord,
    _record: DurableExecutionRecord,
  ): void {}

  protected persistAppendEvent(
    _record: DurableExecutionRecord,
    _event: AgentEventV2Envelope,
  ): void {}

  protected persistLineageRemoval(
    _rootId: string,
    _records: DurableExecutionRecord[],
    _reason: 'explicit' | 'retention',
  ): void {}
}

interface ResolvedOptions {
  maxAgeMs: number;
  maxRecords: number;
  maxBytes: number;
  now: () => Date;
  additionalQuotaPaths: string[];
  onLineageRemoving?: (records: readonly DurableExecutionRecord[]) => void;
}

function resolveOptions(options: ExecutionGraphStoreOptions): ResolvedOptions {
  const resolved = {
    maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    maxRecords: options.maxRecords ?? DEFAULT_MAX_RECORDS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    now: options.now ?? (() => new Date()),
    additionalQuotaPaths: [...new Set(options.additionalQuotaPaths ?? [])],
    ...(options.onLineageRemoving ? { onLineageRemoving: options.onLineageRemoving } : {}),
  };
  if (
    !Number.isSafeInteger(resolved.maxAgeMs) ||
    resolved.maxAgeMs < 0 ||
    !Number.isSafeInteger(resolved.maxRecords) ||
    resolved.maxRecords < 1 ||
    !Number.isSafeInteger(resolved.maxBytes) ||
    resolved.maxBytes < 1 ||
    resolved.additionalQuotaPaths.some((path) => !path)
  ) {
    throw new Error('invalid execution graph retention options');
  }
  return resolved;
}

function ensureDirectory(path: string): void {
  if (existsSync(path)) {
    const details = lstatSync(path);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      const error = new Error(`unsafe execution graph directory: ${path}`) as NodeJS.ErrnoException;
      error.code = 'ELOOP';
      throw error;
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== 'win32' ||
      (code !== 'EPERM' && code !== 'EACCES' && code !== 'EINVAL')
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeFully(descriptor: number, contents: string): void {
  const buffer = Buffer.from(contents, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(descriptor, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error('execution graph write made no progress');
    offset += written;
  }
}

function ensureDurableDirectory(path: string): void {
  const existed = existsSync(path);
  ensureDirectory(path);
  if (!existed) syncDirectory(dirname(path));
}

function atomicWrite(path: string, contents: string): void {
  const directory = dirname(path);
  ensureDirectory(directory);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let renamed = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFully(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    renamed = true;
    chmodSync(path, 0o600);
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!renamed && existsSync(temporary)) unlinkSync(temporary);
  }
}

function appendDurably(path: string, contents: string): void {
  ensureDirectory(dirname(path));
  const existed = existsSync(path);
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_APPEND |
    fsConstants.O_CREAT |
    (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0);
  const descriptor = openSync(path, flags, 0o600);
  try {
    writeFully(descriptor, contents);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
  if (!existed) syncDirectory(dirname(path));
}

function byteSize(path: string): number {
  if (!existsSync(path)) return 0;
  const details = lstatSync(path);
  if (!details.isDirectory()) return details.size;
  return readdirSync(path).reduce((total, entry) => total + byteSize(join(path, entry)), 0);
}

/** Versioned, synchronous, fsync-before-return execution graph storage. */
export class FileExecutionGraphStore extends MemoryExecutionGraphStore {
  private readonly options: ResolvedOptions;
  private readonly manifestPath: string;
  private readonly lineagesPath: string;
  private readonly tombstonesPath: string;
  private readonly quarantinePath: string;
  private readonly trashPath: string;
  private readonly tombstones = new Map<string, Tombstone>();
  private recovering = false;

  constructor(
    private readonly directory: string,
    options: ExecutionGraphStoreOptions = {},
  ) {
    super();
    this.options = resolveOptions(options);
    this.manifestPath = join(directory, 'manifest.json');
    this.lineagesPath = join(directory, 'lineages');
    this.tombstonesPath = join(directory, 'tombstones');
    this.quarantinePath = join(directory, 'quarantine');
    this.trashPath = join(directory, '.trash');
    this.initialize();
  }

  protected override persistReserve(record: DurableExecutionRecord): void {
    const contents = this.recordContents(record);
    this.ensureCapacity(Buffer.byteLength(contents), 1, rootExecutionId(record));
    const rootPath = this.ensureLineageDirectories(rootExecutionId(record));
    atomicWrite(join(rootPath, 'records', `${record.session.id}.json`), contents);
  }

  protected override persistDiscard(
    record: DurableExecutionRecord,
    onlyLineageRecord: boolean,
  ): void {
    const rootId = rootExecutionId(record);
    const lineagePath = join(this.lineagesPath, rootId);
    if (onlyLineageRecord && existsSync(lineagePath)) {
      const trash = join(this.trashPath, `discard--${rootId}--${randomUUID()}`);
      renameSync(lineagePath, trash);
      syncDirectory(this.lineagesPath);
      rmSync(trash, { recursive: true, force: true });
      syncDirectory(this.trashPath);
      return;
    }
    const metadataPath = this.metadataPath(record);
    const eventsPath = this.eventsPath(record);
    if (existsSync(metadataPath)) unlinkSync(metadataPath);
    if (existsSync(eventsPath) && statSync(eventsPath).size === 0) unlinkSync(eventsPath);
    syncDirectory(dirname(metadataPath));
  }

  protected override persistUpdate(
    previous: DurableExecutionRecord,
    record: DurableExecutionRecord,
  ): void {
    this.ensureLineageDirectories(rootExecutionId(record));
    const contents = this.recordContents(record);
    const previousBytes = byteSize(this.metadataPath(previous));
    if (!this.recovering) {
      this.ensureCapacity(
        Math.max(0, Buffer.byteLength(contents) - previousBytes),
        0,
        rootExecutionId(record),
      );
    }
    atomicWrite(this.metadataPath(record), contents);
  }

  protected override persistAppendEvent(
    record: DurableExecutionRecord,
    event: AgentEventV2Envelope,
  ): void {
    this.ensureLineageDirectories(rootExecutionId(record));
    const line = `${JSON.stringify(event)}\n`;
    if (!this.recovering) {
      this.ensureCapacity(Buffer.byteLength(line), 0, rootExecutionId(record));
    }
    appendDurably(this.eventsPath(record), line);
  }

  protected override persistLineageRemoval(
    rootId: string,
    records: DurableExecutionRecord[],
    reason: 'explicit' | 'retention',
  ): void {
    const source = join(this.lineagesPath, rootId);
    if (!existsSync(source)) return;
    const trash = join(this.trashPath, `evict--${rootId}--${randomUUID()}`);
    renameSync(source, trash);
    syncDirectory(this.lineagesPath);
    syncDirectory(this.trashPath);
    const tombstone = tombstoneSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      rootExecutionId: rootId,
      deletedAt: this.options.now().toISOString(),
      reason,
    }) as Tombstone;
    try {
      atomicWrite(this.tombstoneFile(rootId), `${JSON.stringify(tombstone)}\n`);
    } catch (error) {
      if (!existsSync(source) && existsSync(trash)) renameSync(trash, source);
      syncDirectory(this.lineagesPath);
      throw error;
    }
    this.tombstones.set(rootId, tombstone);
    rmSync(trash, { recursive: true, force: true });
    syncDirectory(this.trashPath);
    try {
      this.options.onLineageRemoving?.(records);
    } catch {
      // The tombstone is the authoritative commit. Startup reconciliation removes stale
      // compatibility records left by an interrupted or failed post-commit cleanup.
    }
  }

  private initialize(): void {
    for (const path of [
      this.directory,
      this.lineagesPath,
      this.tombstonesPath,
      this.quarantinePath,
      this.trashPath,
    ]) {
      ensureDurableDirectory(path);
    }
    this.assertNoFutureSchemas();
    this.recoverRootTemporaryFiles();
    this.loadOrMigrateManifest();
    this.recoverTransactions();
    this.loadTombstones();
    this.loadLineages();
    this.recoverInterruptedExecutions();
    this.enforceAgeRetention();
    try {
      this.ensureCapacity(0, 0);
    } catch (error) {
      if (!(error instanceof ExecutionGraphStoreError) || error.code !== 'storage_full')
        throw error;
    }
  }

  private recoverRootTemporaryFiles(): void {
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^\.manifest\.json\..+\.tmp$/.test(entry.name)) continue;
      const quarantined = this.quarantineFile(join(this.directory, entry.name), 'atomic-write');
      this.report.quarantinedPaths.push(quarantined);
    }
  }

  private assertNoFutureSchemas(): void {
    const inspect = (path: string, field: 'schemaVersion' | 'version'): void => {
      try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
        const version = (value as Record<string, unknown>)[field];
        if (typeof version === 'number' && version > CURRENT_SCHEMA_VERSION) {
          storeError('unsupported_schema', 'unsupported execution graph schema version');
        }
      } catch (error) {
        if (error instanceof ExecutionGraphStoreError) throw error;
        // Invalid JSON is corruption, not a future schema. Normal startup quarantines it later.
      }
    };
    if (existsSync(this.manifestPath)) inspect(this.manifestPath, 'version');
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (entry.isFile() && /^\.manifest\.json\..+\.tmp$/.test(entry.name)) {
        inspect(join(this.directory, entry.name), 'version');
      }
    }
    for (const lineage of readdirSync(this.lineagesPath, { withFileTypes: true })) {
      if (!lineage.isDirectory()) continue;
      const recordsPath = join(this.lineagesPath, lineage.name, 'records');
      if (!existsSync(recordsPath) || !lstatSync(recordsPath).isDirectory()) continue;
      for (const entry of readdirSync(recordsPath, { withFileTypes: true })) {
        if (entry.isFile()) inspect(join(recordsPath, entry.name), 'schemaVersion');
      }
    }
    for (const entry of readdirSync(this.tombstonesPath, { withFileTypes: true })) {
      if (entry.isFile()) inspect(join(this.tombstonesPath, entry.name), 'schemaVersion');
    }
  }

  private loadOrMigrateManifest(): void {
    if (!existsSync(this.manifestPath)) {
      atomicWrite(this.manifestPath, `${JSON.stringify({ version: CURRENT_SCHEMA_VERSION })}\n`);
      return;
    }
    chmodSync(this.manifestPath, 0o600);
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(this.manifestPath, 'utf8'));
    } catch {
      const quarantined = this.quarantineFile(this.manifestPath, 'manifest');
      this.report.quarantinedPaths.push(quarantined);
      atomicWrite(this.manifestPath, `${JSON.stringify({ version: CURRENT_SCHEMA_VERSION })}\n`);
      return;
    }
    if (manifestV0Schema.safeParse(manifest).success) {
      atomicWrite(this.manifestPath, `${JSON.stringify({ version: CURRENT_SCHEMA_VERSION })}\n`);
      this.report.migratedFromVersion = 0;
      return;
    }
    if (manifestSchema.safeParse(manifest).success) return;
    const version =
      manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
        ? (manifest as { version?: unknown }).version
        : undefined;
    if (typeof version === 'number' && version > CURRENT_SCHEMA_VERSION) {
      storeError('unsupported_schema', 'unsupported execution graph schema version');
    }
    const quarantined = this.quarantineFile(this.manifestPath, 'manifest');
    this.report.quarantinedPaths.push(quarantined);
    atomicWrite(this.manifestPath, `${JSON.stringify({ version: CURRENT_SCHEMA_VERSION })}\n`);
  }

  private recoverTransactions(): void {
    for (const entry of readdirSync(this.trashPath, { withFileTypes: true })) {
      const path = join(this.trashPath, entry.name);
      if (entry.name.startsWith('discard--')) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      const match = /^evict--([0-9a-f-]{36})--/.exec(entry.name);
      if (!match?.[1]) {
        const quarantined = this.quarantineFile(path, 'transaction');
        this.report.quarantinedPaths.push(quarantined);
        continue;
      }
      const rootId = match[1];
      const tombstonePath = this.tombstoneFile(rootId);
      let committed = false;
      if (existsSync(tombstonePath)) {
        try {
          const tombstone = tombstoneSchema.parse(JSON.parse(readFileSync(tombstonePath, 'utf8')));
          committed = tombstone.rootExecutionId === rootId;
        } catch {
          const quarantined = this.quarantineFile(tombstonePath, 'tombstone-transaction');
          this.report.quarantinedPaths.push(quarantined);
        }
      }
      if (committed) {
        rmSync(path, { recursive: true, force: true });
      } else {
        const target = join(this.lineagesPath, rootId);
        if (existsSync(target)) {
          const quarantined = this.quarantineFile(path, 'transaction-collision');
          this.report.quarantinedPaths.push(quarantined);
        } else {
          renameSync(path, target);
        }
      }
    }
  }

  private loadTombstones(): void {
    for (const entry of readdirSync(this.tombstonesPath, { withFileTypes: true })) {
      const path = join(this.tombstonesPath, entry.name);
      if (!entry.isFile()) {
        const quarantined = this.quarantineFile(path, 'tombstone');
        this.report.quarantinedPaths.push(quarantined);
        continue;
      }
      try {
        const tombstone = tombstoneSchema.parse(
          JSON.parse(readFileSync(path, 'utf8')),
        ) as Tombstone;
        if (entry.name !== `${tombstone.rootExecutionId}.json`) throw new Error('name mismatch');
        chmodSync(path, 0o600);
        this.tombstones.set(tombstone.rootExecutionId, tombstone);
        this.deletedRootIds.add(tombstone.rootExecutionId);
      } catch {
        const quarantined = this.quarantineFile(path, 'tombstone');
        this.report.quarantinedPaths.push(quarantined);
      }
    }
  }

  private loadLineages(): void {
    const pendingEvents: Array<{ record: DurableExecutionRecord; path: string }> = [];
    for (const lineageEntry of readdirSync(this.lineagesPath, { withFileTypes: true })) {
      const lineagePath = join(this.lineagesPath, lineageEntry.name);
      if (!lineageEntry.isDirectory() || !/^[0-9a-f-]{36}$/.test(lineageEntry.name)) {
        const quarantined = this.quarantineFile(lineagePath, 'lineage');
        this.report.quarantinedPaths.push(quarantined);
        continue;
      }
      ensureDirectory(lineagePath);
      const recordsPath = join(lineagePath, 'records');
      const eventsPath = join(lineagePath, 'events');
      ensureDirectory(recordsPath);
      ensureDirectory(eventsPath);
      const recoveredRecords: Array<{
        record: DurableExecutionRecord;
        path: string;
        needsMigration: boolean;
      }> = [];
      let invalidLineage = this.deletedRootIds.has(lineageEntry.name);
      for (const entry of readdirSync(recordsPath, { withFileTypes: true })) {
        const path = join(recordsPath, entry.name);
        const canonicalMetadataName = /^[0-9a-f-]{36}\.json$/.test(entry.name);
        if (!entry.isFile() || !canonicalMetadataName) {
          const quarantined = this.quarantineFile(path, 'metadata');
          this.report.quarantinedPaths.push(quarantined);
          continue;
        }
        try {
          const stored = parseStoredRecord(JSON.parse(readFileSync(path, 'utf8')));
          const record = stored.record;
          if (
            entry.name !== `${record.session.id}.json` ||
            rootExecutionId(record) !== lineageEntry.name ||
            this.recordsById.has(record.session.id) ||
            recoveredRecords.some(
              ({ record: candidate }) => candidate.session.id === record.session.id,
            )
          ) {
            throw new Error('record path mismatch');
          }
          recoveredRecords.push({ record, path, needsMigration: stored.needsMigration });
        } catch (error) {
          if (error instanceof ExecutionGraphStoreError && error.code === 'unsupported_schema') {
            throw error;
          }
          invalidLineage = true;
        }
      }
      if (
        invalidLineage ||
        !recoveredLineageIsValid(
          lineageEntry.name,
          recoveredRecords.map(({ record }) => record),
        )
      ) {
        const quarantined = this.quarantineFile(lineagePath, 'lineage-metadata');
        this.report.quarantinedPaths.push(quarantined);
        continue;
      }

      for (const recovered of recoveredRecords) {
        if (recovered.needsMigration) {
          atomicWrite(recovered.path, this.recordContents(recovered.record));
        }
        chmodSync(recovered.path, 0o600);
        this.recordsById.set(recovered.record.session.id, recovered.record);
        this.eventsById.set(recovered.record.session.id, []);
        pendingEvents.push({
          record: recovered.record,
          path: join(eventsPath, `${recovered.record.session.id}.jsonl`),
        });
      }
      const retainedSessionIds = new Set(recoveredRecords.map(({ record }) => record.session.id));
      for (const entry of readdirSync(eventsPath, { withFileTypes: true })) {
        const path = join(eventsPath, entry.name);
        const sessionId = entry.name.endsWith('.jsonl') ? entry.name.slice(0, -6) : undefined;
        if (!entry.isFile() || !sessionId || !retainedSessionIds.has(sessionId)) {
          const quarantined = this.quarantineFile(path, 'orphan-events');
          this.report.quarantinedPaths.push(quarantined);
        }
      }
    }
    for (const pending of pendingEvents) this.loadEventFile(pending.record, pending.path);
  }

  private loadEventFile(record: DurableExecutionRecord, path: string): void {
    if (!existsSync(path)) return;
    chmodSync(path, 0o600);
    const raw = readFileSync(path, 'utf8');
    const events: AgentEventV2Envelope[] = [];
    let offset = 0;
    let corruptOffset: number | undefined;
    while (offset < raw.length) {
      const newline = raw.indexOf('\n', offset);
      if (newline < 0) {
        corruptOffset = offset;
        break;
      }
      const line = raw.slice(offset, newline);
      try {
        if (!line) throw new Error('blank event');
        const event = parseEvent(JSON.parse(line));
        const previous = events.at(-1);
        if (previous && terminalStateFromEvent(previous)) {
          throw new Error('event follows terminal event');
        }
        const expected = previous ? previous.sequence + 1 : event.sequence;
        if (
          event.sessionId !== record.session.id ||
          event.executionId !== record.session.executionId ||
          event.parentExecutionId !== record.session.parentExecutionId ||
          event.sequence !== expected
        ) {
          throw new Error('event lineage mismatch');
        }
        events.push(event);
      } catch {
        corruptOffset = offset;
        break;
      }
      offset = newline + 1;
    }
    if (corruptOffset !== undefined) {
      const tail = raw.slice(corruptOffset);
      const quarantined = this.writeQuarantine(`${record.session.id}.events-tail.jsonl`, tail);
      this.report.quarantinedPaths.push(quarantined);
      atomicWrite(path, events.map((event) => `${JSON.stringify(event)}\n`).join(''));
    }
    this.eventsById.set(record.session.id, events);
  }

  private recoverInterruptedExecutions(): void {
    this.recovering = true;
    try {
      for (const current of [...this.recordsById.values()]) {
        if (isTerminal(current)) continue;
        const events = this.eventsById.get(current.session.id) ?? [];
        let persistedTerminal:
          Pick<AgentSessionV2, 'status' | 'completedAt' | 'terminalReason'> | undefined;
        for (let index = events.length - 1; index >= 0; index -= 1) {
          persistedTerminal = terminalStateFromEvent(events[index] as AgentEventV2Envelope);
          if (persistedTerminal) break;
        }
        if (persistedTerminal) {
          this.update({
            ...current,
            session: { ...current.session, ...persistedTerminal },
          });
          continue;
        }

        const interruptedAt = this.options.now().toISOString();
        const last = events.at(-1);
        this.appendEvent(current.session.id, {
          sessionId: current.session.id,
          executionId: current.session.executionId,
          ...(current.session.parentExecutionId === undefined
            ? {}
            : { parentExecutionId: current.session.parentExecutionId }),
          sequence: last ? last.sequence + 1 : current.session.earliestSequence,
          timestamp: interruptedAt,
          type: 'session.interrupted',
          reason: 'daemon_restart',
        });
        this.update({
          ...current,
          session: {
            ...current.session,
            status: 'interrupted',
            completedAt: interruptedAt,
            terminalReason: 'daemon_restart',
          },
        });
        this.report.interruptedSessionIds.push(current.session.id);
      }
    } finally {
      this.recovering = false;
    }
  }

  private enforceAgeRetention(excludedRootId?: string): void {
    const cutoff = this.options.now().getTime() - this.options.maxAgeMs;
    for (const lineage of this.terminalLineages()) {
      if (lineage.rootId !== excludedRootId && lineage.completedAt < cutoff) {
        this.removeLineage(lineage.rootId, 'retention');
      }
    }
    for (const tombstone of [...this.tombstones.values()]) {
      if (Date.parse(tombstone.deletedAt) < cutoff) this.removeTombstone(tombstone.rootExecutionId);
    }
  }

  private ensureCapacity(addedBytes: number, addedRecords: number, excludedRootId?: string): void {
    if (!this.recovering) this.enforceAgeRetention(excludedRootId);
    while (true) {
      const recordLimitExceeded =
        this.recordsById.size + this.tombstones.size + addedRecords > this.options.maxRecords;
      const storedBytes =
        byteSize(this.directory) +
        this.options.additionalQuotaPaths.reduce((total, path) => total + byteSize(path), 0);
      const byteLimitExceeded = storedBytes + addedBytes > this.options.maxBytes;
      if (!recordLimitExceeded && !byteLimitExceeded) return;

      const tombstone = [...this.tombstones.values()].sort((left, right) =>
        left.deletedAt.localeCompare(right.deletedAt),
      )[0];
      if (tombstone) {
        this.removeTombstone(tombstone.rootExecutionId);
        continue;
      }
      const candidate = this.terminalLineages().find(
        (lineage) => lineage.rootId !== excludedRootId,
      );
      if (candidate) {
        this.removeLineage(candidate.rootId, 'retention');
        continue;
      }
      storeError('storage_full', 'execution graph retention capacity is exhausted');
    }
  }

  private terminalLineages(): Array<{ rootId: string; completedAt: number }> {
    const grouped = new Map<string, DurableExecutionRecord[]>();
    for (const record of this.recordsById.values()) {
      const rootId = rootExecutionId(record);
      const records = grouped.get(rootId) ?? [];
      records.push(record);
      grouped.set(rootId, records);
    }
    return [...grouped]
      .filter(
        ([, records]) =>
          records.every(isTerminal) && !records.some((record) => this.hasContinuationLock(record)),
      )
      .map(([rootId, records]) => ({
        rootId,
        completedAt: Math.max(
          ...records.map((record) =>
            Date.parse(record.session.completedAt ?? record.session.startedAt),
          ),
        ),
      }))
      .sort((left, right) => left.completedAt - right.completedAt);
  }

  private recordContents(record: DurableExecutionRecord): string {
    return `${JSON.stringify(
      storedRecordSchema.parse({ schemaVersion: CURRENT_SCHEMA_VERSION, record }),
    )}\n`;
  }

  private ensureLineageDirectories(rootId: string): string {
    ensureDirectory(this.lineagesPath);
    const rootPath = join(this.lineagesPath, rootId);
    ensureDurableDirectory(rootPath);
    ensureDurableDirectory(join(rootPath, 'records'));
    ensureDurableDirectory(join(rootPath, 'events'));
    return rootPath;
  }

  private metadataPath(record: DurableExecutionRecord): string {
    return join(this.lineagesPath, rootExecutionId(record), 'records', `${record.session.id}.json`);
  }

  private eventsPath(record: DurableExecutionRecord): string {
    return join(this.lineagesPath, rootExecutionId(record), 'events', `${record.session.id}.jsonl`);
  }

  private tombstoneFile(rootId: string): string {
    return join(this.tombstonesPath, `${rootId}.json`);
  }

  private removeTombstone(rootId: string): void {
    const path = this.tombstoneFile(rootId);
    if (existsSync(path)) unlinkSync(path);
    this.tombstones.delete(rootId);
    this.deletedRootIds.delete(rootId);
    syncDirectory(this.tombstonesPath);
  }

  private quarantineFile(source: string, label: string): string {
    const destination = join(this.quarantinePath, `${label}-${basename(source)}-${randomUUID()}`);
    renameSync(source, destination);
    const details = lstatSync(destination);
    if (!details.isSymbolicLink()) chmodSync(destination, details.isDirectory() ? 0o700 : 0o600);
    syncDirectory(dirname(source));
    syncDirectory(this.quarantinePath);
    return destination;
  }

  private writeQuarantine(name: string, contents: string): string {
    const destination = join(this.quarantinePath, `${name}-${randomUUID()}`);
    atomicWrite(destination, contents);
    return destination;
  }
}
