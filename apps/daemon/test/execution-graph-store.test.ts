import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEventV2Envelope, AgentSessionV2, CapabilitySelection } from '@agent-dock/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ExecutionGraphStoreError,
  FileExecutionGraphStore,
  MemoryExecutionGraphStore,
  type DurableExecutionRecord,
} from '../src/execution-graph-store.js';

const NOW = '2026-09-01T08:00:00.000Z';
const STARTED = '2026-09-01T07:59:00.000Z';
const temporaryDirectories: string[] = [];

const selection: CapabilitySelection = {
  transport: 'fake-v2',
  enabled: [],
  unavailableOptional: [],
  possibleEffects: [],
  effectsComplete: true,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function graphPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-dock-execution-graph-'));
  temporaryDirectories.push(root);
  return join(root, 'graph');
}

function record(
  overrides: Partial<AgentSessionV2> = {},
  recordOverrides: Partial<DurableExecutionRecord> = {},
): DurableExecutionRecord {
  const executionId = overrides.executionId ?? randomUUID();
  return {
    session: {
      id: randomUUID(),
      provider: 'claude',
      transport: 'fake-v2',
      cwd: '/workspace',
      status: 'starting',
      selection,
      executionId,
      rootExecutionId: executionId,
      continuationKind: 'fresh',
      acceptedWork: 'not_accepted',
      startedAt: STARTED,
      earliestSequence: 0,
      ...overrides,
    },
    interactive: true,
    ...recordOverrides,
  };
}

function terminalRecord(overrides: Partial<AgentSessionV2> = {}): DurableExecutionRecord {
  return record({
    status: 'completed',
    completedAt: NOW,
    terminalReason: 'provider_completed',
    acceptedWork: 'accepted',
    ...overrides,
  });
}

function childRecord(
  parent: DurableExecutionRecord,
  overrides: Partial<AgentSessionV2> = {},
): DurableExecutionRecord {
  return record({
    provider: parent.session.provider,
    rootExecutionId: parent.session.rootExecutionId,
    parentSessionId: parent.session.id,
    parentExecutionId: parent.session.executionId,
    continuationKind: 'resume',
    ...overrides,
  });
}

function startedEvent(session: AgentSessionV2, sequence = 0): AgentEventV2Envelope {
  return {
    sessionId: session.id,
    executionId: session.executionId,
    ...(session.parentExecutionId === undefined
      ? {}
      : { parentExecutionId: session.parentExecutionId }),
    sequence,
    timestamp: STARTED,
    type: 'session.started',
    provider: session.provider,
    transport: session.transport,
    selection: session.selection,
  };
}

function completedEvent(session: AgentSessionV2, sequence: number): AgentEventV2Envelope {
  return {
    sessionId: session.id,
    executionId: session.executionId,
    ...(session.parentExecutionId === undefined
      ? {}
      : { parentExecutionId: session.parentExecutionId }),
    sequence,
    timestamp: NOW,
    type: 'session.completed',
  };
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error('operation unexpectedly succeeded');
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionGraphStoreError);
    expect(error).toMatchObject({ code });
  }
}

describe('MemoryExecutionGraphStore', () => {
  it('paginates strict snapshots and contiguous normalized history', () => {
    const store = new MemoryExecutionGraphStore();
    const first = record({ startedAt: '2026-09-01T07:58:00.000Z' });
    const second = record({ startedAt: STARTED });
    store.reserve(first);
    store.reserve(second);
    store.appendEvent(second.session.id, startedEvent(second.session));
    store.appendEvent(second.session.id, completedEvent(second.session, 1));

    const firstPage = store.list({ limit: 1 });
    expect(firstPage.sessions.map(({ id }) => id)).toEqual([second.session.id]);
    expect(firstPage.nextCursor).toBeDefined();
    expect(
      store.list({ cursor: firstPage.nextCursor, limit: 1 }).sessions.map(({ id }) => id),
    ).toEqual([first.session.id]);

    const history = store.history(second.session.id, { limit: 1 });
    expect(history?.events.map(({ sequence }) => sequence)).toEqual([0]);
    expect(
      store
        .history(second.session.id, { cursor: history?.nextCursor, limit: 1 })
        ?.events.map(({ sequence }) => sequence),
    ).toEqual([1]);
    expectCode(
      () => store.appendEvent(second.session.id, startedEvent(second.session, 2)),
      'invalid_event',
    );
    expect(store.history(randomUUID())).toBeUndefined();
    expectCode(() => store.list({ cursor: 'bad' }), 'invalid_cursor');
  });

  it('enforces terminal parent lineage, immutable identity, and rollback-only discard', () => {
    const store = new MemoryExecutionGraphStore();
    const parent = terminalRecord({ providerSessionId: 'native-thread-1' });
    store.reserve(parent);
    const child = childRecord(parent);
    store.reserve(child);
    expect(store.get(child.session.id)?.session.rootExecutionId).toBe(
      parent.session.rootExecutionId,
    );

    expectCode(
      () =>
        store.update({
          ...child,
          session: { ...child.session, parentSessionId: randomUUID() },
        }),
      'immutable_lineage',
    );
    store.discard(child.session.id);
    expect(store.get(child.session.id)).toBeUndefined();

    const activeParent = record({ providerSessionId: 'native-thread-2' });
    store.reserve(activeParent);
    expectCode(() => store.reserve(childRecord(activeParent)), 'continuation_parent_active');

    const eventful = record();
    store.reserve(eventful);
    store.appendEvent(eventful.session.id, startedEvent(eventful.session));
    expectCode(() => store.discard(eventful.session.id), 'discard_forbidden');
  });

  it('locks provider-native continuations per provider and lease', () => {
    const store = new MemoryExecutionGraphStore();
    const retained = terminalRecord({ providerSessionId: 'same-native-id' });
    store.reserve(retained);
    store.acquireContinuation('claude', 'same-native-id', 'lease-a');
    store.acquireContinuation('claude', 'same-native-id', 'lease-a');
    store.acquireContinuation('codex', 'same-native-id', 'lease-b');
    expectCode(
      () => store.acquireContinuation('claude', 'same-native-id', 'lease-b'),
      'continuation_in_use',
    );
    store.releaseContinuation('claude', 'same-native-id', 'wrong-lease');
    expectCode(
      () => store.acquireContinuation('claude', 'same-native-id', 'lease-b'),
      'continuation_in_use',
    );
    store.releaseContinuation('claude', 'same-native-id', 'lease-a');
    store.acquireContinuation('claude', 'same-native-id', 'lease-b');
    expectCode(() => store.deleteLineage(retained.session.id), 'continuation_in_use');
    store.releaseContinuation('claude', 'same-native-id', 'lease-b');
    expect(store.deleteLineage(retained.session.id)).toBe(true);
    expectCode(() => store.reserve(retained), 'immutable_lineage');
  });
});

describe('FileExecutionGraphStore', () => {
  it('atomically persists strict metadata/events with private permissions', async () => {
    const path = await graphPath();
    const stored = terminalRecord();
    const store = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    store.reserve(stored);
    store.appendEvent(stored.session.id, startedEvent(stored.session));
    store.appendEvent(stored.session.id, completedEvent(stored.session, 1));

    const reloaded = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    expect(reloaded.get(stored.session.id)).toEqual(stored);
    expect(reloaded.history(stored.session.id)?.events).toHaveLength(2);

    const metadataPath = join(
      path,
      'lineages',
      stored.session.rootExecutionId as string,
      'records',
      `${stored.session.id}.json`,
    );
    const raw = await readFile(metadataPath, 'utf8');
    expect(raw).not.toContain('prompt');
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
      expect((await stat(metadataPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('marks active executions interrupted exactly once across restarts', async () => {
    const path = await graphPath();
    const active = record({ status: 'active', acceptedWork: 'accepted' });
    const initial = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    initial.reserve(active);
    initial.appendEvent(active.session.id, startedEvent(active.session));

    const recovered = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    expect(recovered.get(active.session.id)?.session).toMatchObject({
      status: 'interrupted',
      completedAt: NOW,
      terminalReason: 'daemon_restart',
    });
    expect(recovered.recoveryReport().interruptedSessionIds).toEqual([active.session.id]);
    expect(recovered.history(active.session.id)?.events.map(({ type }) => type)).toEqual([
      'session.started',
      'session.interrupted',
    ]);

    const recoveredAgain = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    expect(recoveredAgain.recoveryReport().interruptedSessionIds).toEqual([]);
    expect(recoveredAgain.history(active.session.id)?.events).toHaveLength(2);
  });

  it('repairs terminal metadata from a durable terminal event without inventing interruption', async () => {
    const path = await graphPath();
    const active = record({ status: 'active', acceptedWork: 'accepted' });
    const initial = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    initial.reserve(active);
    initial.appendEvent(active.session.id, startedEvent(active.session));
    initial.appendEvent(active.session.id, completedEvent(active.session, 1));

    const recovered = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    expect(recovered.get(active.session.id)?.session).toMatchObject({
      status: 'completed',
      completedAt: NOW,
      terminalReason: 'completed',
    });
    expect(recovered.recoveryReport().interruptedSessionIds).toEqual([]);
    expect(recovered.history(active.session.id)?.events.map(({ type }) => type)).toEqual([
      'session.started',
      'session.completed',
    ]);
  });

  it('reloads full durable history when bounded replay metadata advances', async () => {
    const path = await graphPath();
    const stored = terminalRecord();
    const initial = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    initial.reserve(stored);
    initial.appendEvent(stored.session.id, startedEvent(stored.session));
    initial.appendEvent(stored.session.id, completedEvent(stored.session, 1));
    initial.update({
      ...stored,
      session: { ...stored.session, earliestSequence: 1 },
    });

    const recovered = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    expect(recovered.history(stored.session.id)?.events.map(({ sequence }) => sequence)).toEqual([
      0, 1,
    ]);
    expect(recovered.recoveryReport().quarantinedPaths).toEqual([]);
  });

  it('quarantines corrupt metadata and only the corrupt JSONL tail', async () => {
    const path = await graphPath();
    const good = terminalRecord();
    const corrupt = terminalRecord();
    const store = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    store.reserve(good);
    store.reserve(corrupt);
    store.appendEvent(good.session.id, startedEvent(good.session));

    const goodEventsPath = join(
      path,
      'lineages',
      good.session.rootExecutionId as string,
      'events',
      `${good.session.id}.jsonl`,
    );
    await appendFile(goodEventsPath, '{"torn":', 'utf8');
    const corruptMetadataPath = join(
      path,
      'lineages',
      corrupt.session.rootExecutionId as string,
      'records',
      `${corrupt.session.id}.json`,
    );
    await writeFile(corruptMetadataPath, '{"bad":true}\n', 'utf8');

    const recovered = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    expect(recovered.get(good.session.id)).toBeDefined();
    expect(recovered.history(good.session.id)?.events).toHaveLength(1);
    expect(recovered.get(corrupt.session.id)).toBeUndefined();
    expect(recovered.recoveryReport().quarantinedPaths).toHaveLength(2);
    expect(await readFile(goodEventsPath, 'utf8')).toBe(
      `${JSON.stringify(startedEvent(good.session))}\n`,
    );
  });

  it('quarantines a manifest atomic-write temporary without replacing valid state', async () => {
    const path = await graphPath();
    const stored = terminalRecord();
    const initial = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    initial.reserve(stored);
    const temporaryPath = join(path, `.manifest.json.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, '{"partial":', { mode: 0o600 });

    const recovered = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    expect(recovered.get(stored.session.id)).toEqual(stored);
    expect(recovered.recoveryReport().quarantinedPaths).toHaveLength(1);
    expect(await readFile(join(path, 'manifest.json'), 'utf8')).toBe('{"version":1}\n');
  });

  it('migrates v0 once and rejects future manifests without rewriting them', async () => {
    const path = await graphPath();
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'manifest.json'), '{"version":0}\n', { mode: 0o600 });

    const migrated = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    expect(migrated.recoveryReport().migratedFromVersion).toBe(0);
    expect(JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))).toEqual({ version: 1 });
    expect(
      new FileExecutionGraphStore(path, { now: () => new Date(NOW) }).recoveryReport()
        .migratedFromVersion,
    ).toBeUndefined();

    await writeFile(join(path, 'manifest.json'), '{"version":2}\n', 'utf8');
    expectCode(
      () => new FileExecutionGraphStore(path, { now: () => new Date(NOW) }),
      'unsupported_schema',
    );
    expect(JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))).toEqual({ version: 2 });
  });

  it('quarantines malformed or invalid current manifests and rebuilds v1', async () => {
    for (const contents of ['{"version":1,"unexpected":true}\n', '{"version":']) {
      const path = await graphPath();
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'manifest.json'), contents, { mode: 0o600 });

      const recovered = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });

      expect(JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))).toEqual({
        version: 1,
      });
      expect(recovered.recoveryReport().quarantinedPaths).toHaveLength(1);
    }
  });

  it('preflights future-version manifest and record temporaries without moving them', async () => {
    const path = await graphPath();
    const stored = terminalRecord();
    const initial = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    initial.reserve(stored);

    const manifestTemporary = join(path, `.manifest.json.${randomUUID()}.tmp`);
    const manifestContents = '{"version":2,"future":true}\n';
    await writeFile(manifestTemporary, manifestContents, { mode: 0o600 });
    expectCode(() => new FileExecutionGraphStore(path), 'unsupported_schema');
    expect(await readFile(manifestTemporary, 'utf8')).toBe(manifestContents);
    await rm(manifestTemporary, { force: true });

    const recordsPath = join(path, 'lineages', stored.session.rootExecutionId as string, 'records');
    const recordTemporary = join(recordsPath, `.${stored.session.id}.json.${randomUUID()}.tmp`);
    const recordContents = `${JSON.stringify({ schemaVersion: 2, record: stored })}\n`;
    await writeFile(recordTemporary, recordContents, { mode: 0o600 });
    expectCode(() => new FileExecutionGraphStore(path), 'unsupported_schema');
    expect(await readFile(recordTemporary, 'utf8')).toBe(recordContents);
  });

  it('idempotently migrates v0 execution records and refuses future record versions', async () => {
    const path = await graphPath();
    const legacy = terminalRecord();
    const recordsPath = join(path, 'lineages', legacy.session.rootExecutionId as string, 'records');
    await mkdir(recordsPath, { recursive: true });
    await mkdir(join(path, 'lineages', legacy.session.rootExecutionId as string, 'events'), {
      recursive: true,
    });
    await writeFile(join(path, 'manifest.json'), '{"version":0}\n', { mode: 0o600 });
    const recordPath = join(recordsPath, `${legacy.session.id}.json`);
    await writeFile(recordPath, `${JSON.stringify({ schemaVersion: 0, record: legacy })}\n`, {
      mode: 0o600,
    });

    const migrated = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    expect(migrated.get(legacy.session.id)).toEqual(legacy);
    expect(JSON.parse(await readFile(recordPath, 'utf8'))).toMatchObject({ schemaVersion: 1 });
    expect(new FileExecutionGraphStore(path).get(legacy.session.id)).toEqual(legacy);

    const futureContents = `${JSON.stringify({ schemaVersion: 2, record: legacy })}\n`;
    await writeFile(recordPath, futureContents, 'utf8');
    expectCode(() => new FileExecutionGraphStore(path), 'unsupported_schema');
    expect(await readFile(recordPath, 'utf8')).toBe(futureContents);
  });

  it('preflights all records before mutating a mixed-version store', async () => {
    const path = await graphPath();
    const legacy = terminalRecord();
    const future = terminalRecord();
    const writeRecord = async (candidate: DurableExecutionRecord, schemaVersion: number) => {
      const lineagePath = join(path, 'lineages', candidate.session.rootExecutionId as string);
      await mkdir(join(lineagePath, 'records'), { recursive: true });
      await mkdir(join(lineagePath, 'events'), { recursive: true });
      const recordPath = join(lineagePath, 'records', `${candidate.session.id}.json`);
      const contents = `${JSON.stringify({ schemaVersion, record: candidate })}\n`;
      await writeFile(recordPath, contents, { mode: 0o600 });
      return { recordPath, contents };
    };
    await mkdir(path, { recursive: true });
    const manifestContents = '{"version":0}\n';
    await writeFile(join(path, 'manifest.json'), manifestContents, { mode: 0o600 });
    const legacyFile = await writeRecord(legacy, 0);
    const futureFile = await writeRecord(future, 2);

    expectCode(() => new FileExecutionGraphStore(path), 'unsupported_schema');
    expect(await readFile(join(path, 'manifest.json'), 'utf8')).toBe(manifestContents);
    expect(await readFile(legacyFile.recordPath, 'utf8')).toBe(legacyFile.contents);
    expect(await readFile(futureFile.recordPath, 'utf8')).toBe(futureFile.contents);
  });

  it('quarantines whole recovered lineages with missing or mismatched parent links', async () => {
    const path = await graphPath();
    const initial = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    const missingParent = terminalRecord({ providerSessionId: 'native-missing-parent' });
    const orphan = childRecord(missingParent);
    const mismatchedParent = terminalRecord({ providerSessionId: 'native-mismatched-parent' });
    const mismatchedChild = childRecord(mismatchedParent);
    initial.reserve(missingParent);
    initial.reserve(orphan);
    initial.reserve(mismatchedParent);
    initial.reserve(mismatchedChild);

    const metadataPath = (candidate: DurableExecutionRecord) =>
      join(
        path,
        'lineages',
        candidate.session.rootExecutionId as string,
        'records',
        `${candidate.session.id}.json`,
      );
    await rm(metadataPath(missingParent), { force: true });
    const childPath = metadataPath(mismatchedChild);
    const childContents = JSON.parse(await readFile(childPath, 'utf8')) as {
      record: { session: { parentExecutionId: string } };
    };
    childContents.record.session.parentExecutionId = randomUUID();
    await writeFile(childPath, `${JSON.stringify(childContents)}\n`, 'utf8');

    const recovered = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    for (const candidate of [missingParent, orphan, mismatchedParent, mismatchedChild]) {
      expect(recovered.get(candidate.session.id)).toBeUndefined();
    }
    expect(recovered.recoveryReport().quarantinedPaths).toHaveLength(2);
    expect(await readdir(join(path, 'lineages'))).toEqual([]);
  });

  it('evicts only whole terminal lineages and leaves one bounded tombstone', async () => {
    const path = await graphPath();
    const store = new FileExecutionGraphStore(path, {
      maxRecords: 2,
      now: () => new Date(NOW),
    });
    const parent = terminalRecord({ providerSessionId: 'native-thread' });
    const child = childRecord(parent, {
      status: 'completed',
      completedAt: NOW,
      terminalReason: 'provider_completed',
    });
    store.reserve(parent);
    store.reserve(child);

    const replacement = record();
    store.reserve(replacement);
    expect(store.get(parent.session.id)).toBeUndefined();
    expect(store.get(child.session.id)).toBeUndefined();
    expect(store.get(replacement.session.id)).toBeDefined();
    expect(await readdir(join(path, 'tombstones'))).toHaveLength(1);

    expectCode(() => store.deleteLineage(replacement.session.id), 'active_lineage');
    store.discard(replacement.session.id);
    expect(await readdir(join(path, 'lineages'))).toHaveLength(0);
  });

  it('prunes a tombstone before evicting another live lineage at the record cap', async () => {
    const path = await graphPath();
    const store = new FileExecutionGraphStore(path, {
      maxRecords: 2,
      now: () => new Date(NOW),
    });
    const oldest = terminalRecord({
      startedAt: '2026-09-01T07:55:00.000Z',
      completedAt: '2026-09-01T07:56:00.000Z',
    });
    const newest = terminalRecord({
      startedAt: '2026-09-01T07:57:00.000Z',
      completedAt: '2026-09-01T07:58:00.000Z',
    });
    store.reserve(oldest);
    store.reserve(newest);

    const replacement = record();
    store.reserve(replacement);

    expect(store.get(oldest.session.id)).toBeUndefined();
    expect(store.get(newest.session.id)).toBeDefined();
    expect(store.get(replacement.session.id)).toBeDefined();
    expect(await readdir(join(path, 'tombstones'))).toHaveLength(0);
  });

  it('expires terminal lineages by age without touching a fresh active execution', async () => {
    const path = await graphPath();
    const store = new FileExecutionGraphStore(path, {
      maxAgeMs: 60_000,
      now: () => new Date(NOW),
    });
    const expired = terminalRecord({
      startedAt: '2026-08-01T00:00:00.000Z',
      completedAt: '2026-08-01T00:01:00.000Z',
    });
    store.reserve(expired);
    const active = record();
    store.reserve(active);

    expect(store.get(expired.session.id)).toBeUndefined();
    expect(store.get(active.session.id)).toBeDefined();
  });

  it('does not age-evict the selected parent lineage while reserving its child', async () => {
    const path = await graphPath();
    const store = new FileExecutionGraphStore(path, {
      maxAgeMs: 60_000,
      now: () => new Date(NOW),
    });
    const parent = terminalRecord({
      providerSessionId: 'native-expired-parent',
      startedAt: '2026-08-01T00:00:00.000Z',
      completedAt: '2026-08-01T00:01:00.000Z',
    });
    store.reserve(parent);

    const child = childRecord(parent);
    store.reserve(child);

    expect(store.get(parent.session.id)).toBeDefined();
    expect(store.get(child.session.id)?.session.parentSessionId).toBe(parent.session.id);
  });

  it('returns storage_full before reserve when only active/quarantine bytes remain', async () => {
    const path = await graphPath();
    const store = new FileExecutionGraphStore(path, {
      maxBytes: 1_024,
      now: () => new Date(NOW),
    });
    await writeFile(join(path, 'quarantine', 'retained.bin'), Buffer.alloc(2_048), { mode: 0o600 });
    const candidate = record();

    expectCode(() => store.reserve(candidate), 'storage_full');
    expect(store.get(candidate.session.id)).toBeUndefined();
  });

  it('counts associated state bytes and removes its records with an evicted lineage', async () => {
    const path = await graphPath();
    const associated = `${path}-associated`;
    await mkdir(associated, { recursive: true });
    await writeFile(join(associated, 'retained.bin'), Buffer.alloc(2_048), { mode: 0o600 });
    const removed: string[][] = [];
    const full = new FileExecutionGraphStore(path, {
      maxBytes: 1_024,
      additionalQuotaPaths: [associated],
      onLineageRemoving: (records) => removed.push(records.map(({ session }) => session.id)),
      now: () => new Date(NOW),
    });
    expectCode(() => full.reserve(record()), 'storage_full');

    await rm(associated, { recursive: true, force: true });
    await mkdir(associated, { recursive: true });
    const bounded = new FileExecutionGraphStore(path, {
      maxRecords: 1,
      additionalQuotaPaths: [associated],
      onLineageRemoving: (records) => removed.push(records.map(({ session }) => session.id)),
      now: () => new Date(NOW),
    });
    const terminal = terminalRecord();
    bounded.reserve(terminal);
    bounded.reserve(record());
    expect(removed).toContainEqual([terminal.session.id]);
  });

  it('commits lineage deletion before running compatibility cleanup', async () => {
    const path = await graphPath();
    const terminal = terminalRecord();
    const rootId = terminal.session.rootExecutionId as string;
    let observed:
      { lineageExists: boolean; tombstoneRootExecutionId: string | undefined } | undefined;
    const store = new FileExecutionGraphStore(path, {
      now: () => new Date(NOW),
      onLineageRemoving: () => {
        const tombstone = JSON.parse(
          readFileSync(join(path, 'tombstones', `${rootId}.json`), 'utf8'),
        ) as { rootExecutionId?: string };
        observed = {
          lineageExists: existsSync(join(path, 'lineages', rootId)),
          tombstoneRootExecutionId: tombstone.rootExecutionId,
        };
      },
    });
    store.reserve(terminal);

    expect(store.deleteLineage(terminal.session.id)).toBe(true);
    expect(observed).toEqual({
      lineageExists: false,
      tombstoneRootExecutionId: rootId,
    });
  });

  it('rejects unknown secret-bearing metadata and raw tool fields before persistence', async () => {
    const path = await graphPath();
    const store = new FileExecutionGraphStore(path, { now: () => new Date(NOW) });
    const candidate = record();
    const unsafe = {
      ...candidate,
      session: { ...candidate.session, prompt: 'SECRET_CANARY' },
    } as DurableExecutionRecord;

    expectCode(() => store.reserve(unsafe), 'invalid_record');
    const safe = record();
    store.reserve(safe);
    const unsafeToolEvent = {
      sessionId: safe.session.id,
      executionId: safe.session.executionId,
      sequence: 0,
      timestamp: STARTED,
      type: 'tool.started',
      turnId: randomUUID(),
      toolCallId: randomUUID(),
      contentBlockId: randomUUID(),
      toolName: 'read_file',
      possibleEffects: ['read'],
      effectsComplete: true,
      rawInput: 'RAW_TOOL_SECRET_CANARY',
    } as AgentEventV2Envelope;
    expectCode(() => store.appendEvent(safe.session.id, unsafeToolEvent), 'invalid_event');
    const disk = await Promise.all(
      (await readdir(path, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8').catch(() => '')),
    );
    expect(disk.join('\n')).not.toContain('SECRET_CANARY');
    expect(disk.join('\n')).not.toContain('RAW_TOOL_SECRET_CANARY');
  });

  it('rejects a symlinked store directory instead of following it', async () => {
    if (process.platform === 'win32') return;
    const path = await graphPath();
    const target = `${path}-target`;
    await mkdir(target, { recursive: true });
    temporaryDirectories.push(target);
    const { symlink } = await import('node:fs/promises');
    await symlink(target, path, 'dir');
    await chmod(target, 0o700);

    expect(() => new FileExecutionGraphStore(path)).toThrow(
      expect.objectContaining({ code: 'ELOOP' }),
    );
  });
});
