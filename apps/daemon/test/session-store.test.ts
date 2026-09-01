import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSession } from '@agent-dock/shared';
import {
  FileSessionStore,
  MemorySessionStore,
  SESSION_RESTART_INTERRUPTION_ERROR,
  UnsupportedSessionStoreVersionError,
} from '../src/session-store.js';

const FILE_SESSION_ID = '00000000-0000-4000-8000-000000000001';
const CORRUPT_SESSION_ID = '00000000-0000-4000-8000-000000000002';
const SECOND_SESSION_ID = '00000000-0000-4000-8000-000000000003';
const PROMPT_CANARY = 'AGENT_DOCK_PROMPT_CANARY_7ec662f0';
const ERROR_CANARY = 'AGENT_DOCK_ERROR_CANARY_1ddfbc62';
const temporaryDirectories: string[] = [];

function storeDirectory(): string {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'agent-dock-session-store-'));
  temporaryDirectories.push(temporaryDirectory);
  return join(temporaryDirectory, 'sessions-v1');
}

function readAllStoreFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? readAllStoreFiles(path) : [readFileSync(path, 'utf8')];
  });
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1',
    provider: 'claude',
    cwd: '/tmp',
    prompt: 'hi',
    status: 'starting',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makePersistedSession(
  overrides: Partial<AgentSession> = {},
): Omit<AgentSession, 'prompt' | 'error'> {
  const { prompt, error, ...session } = makeSession(overrides);
  void prompt;
  void error;
  return session;
}

describe('MemorySessionStore', () => {
  it('returns undefined for a session that was never created', () => {
    const store = new MemorySessionStore();
    expect(store.get('missing')).toBeUndefined();
  });

  it('creates and retrieves a session by id', () => {
    const store = new MemorySessionStore();
    const session = makeSession();
    store.create(session, 2);
    expect(store.get('sess-1')).toEqual(session);
    expect(store.protocolVersionOf('sess-1')).toBe(2);
  });

  it('update replaces the stored record', () => {
    const store = new MemorySessionStore();
    store.create(makeSession({ status: 'starting' }));
    store.update(
      'sess-1',
      makeSession({ status: 'completed', completedAt: '2026-01-01T00:00:00.000Z' }),
    );
    expect(store.get('sess-1')?.status).toBe('completed');
  });

  it('update on an id that was never created still stores it (no separate "must exist" check)', () => {
    const store = new MemorySessionStore();
    store.update('sess-2', makeSession({ id: 'sess-2' }));
    expect(store.get('sess-2')?.id).toBe('sess-2');
  });

  it('create with a duplicate id overwrites the previous record (last write wins)', () => {
    const store = new MemorySessionStore();
    store.create(makeSession({ prompt: 'first' }));
    store.create(makeSession({ prompt: 'second' }));
    expect(store.get('sess-1')?.prompt).toBe('second');
    expect(store.list()).toHaveLength(1);
  });

  it('delete removes the record', () => {
    const store = new MemorySessionStore();
    store.create(makeSession());
    store.delete('sess-1');
    expect(store.get('sess-1')).toBeUndefined();
    expect(store.protocolVersionOf('sess-1')).toBeUndefined();
  });

  it('delete on a nonexistent id does not throw', () => {
    const store = new MemorySessionStore();
    expect(() => store.delete('never-existed')).not.toThrow();
  });

  it('list returns every stored session', () => {
    const store = new MemorySessionStore();
    store.create(makeSession({ id: 'a' }));
    store.create(makeSession({ id: 'b' }));
    expect(
      store
        .list()
        .map((s) => s.id)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('list returns an empty array when nothing has been created', () => {
    expect(new MemorySessionStore().list()).toEqual([]);
  });
});

describe('FileSessionStore', () => {
  it('persists session metadata and protocol ownership across restarts', () => {
    const directory = storeDirectory();
    const store = new FileSessionStore(directory);
    const session = makeSession({
      id: FILE_SESSION_ID,
      status: 'completed',
      completedAt: '2026-01-01T00:01:00.000Z',
    });

    store.create(session, 2);
    expect(store.get(FILE_SESSION_ID)).toBe(session);
    store.update(FILE_SESSION_ID, { ...session, prompt: 'updated' });
    expect(store.get(FILE_SESSION_ID)?.prompt).toBe('updated');

    const reopened = new FileSessionStore(directory);
    expect(reopened.get(FILE_SESSION_ID)?.prompt).toBe('');
    expect(reopened.protocolVersionOf(FILE_SESSION_ID)).toBe(2);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.getRecoveryReport()).toMatchObject({
      manifestAction: 'none',
      loadedSessionCount: 1,
      migratedRecordCount: 0,
    });
    expect(readdirSync(join(directory, 'records'))).toEqual([`${FILE_SESSION_ID}.json`]);

    reopened.delete(FILE_SESSION_ID);
    expect(new FileSessionStore(directory).get(FILE_SESSION_ID)).toBeUndefined();
  });

  it('never writes raw prompts or error diagnostics to store files', () => {
    const directory = storeDirectory();
    const store = new FileSessionStore(directory);
    const session = makeSession({
      id: FILE_SESSION_ID,
      prompt: PROMPT_CANARY,
      error: ERROR_CANARY,
      status: 'completed',
      completedAt: '2026-01-01T00:01:00.000Z',
    });

    store.create(session, 2);
    store.update(FILE_SESSION_ID, {
      ...session,
      prompt: `${PROMPT_CANARY}-updated`,
      error: `${ERROR_CANARY}-updated`,
    });

    const record = JSON.parse(
      readFileSync(join(directory, 'records', `${FILE_SESSION_ID}.json`), 'utf8'),
    );
    expect(record.session).not.toHaveProperty('prompt');
    expect(record.session).not.toHaveProperty('error');
    const persisted = readAllStoreFiles(directory).join('\n');
    expect(persisted).not.toContain(PROMPT_CANARY);
    expect(persisted).not.toContain(ERROR_CANARY);
    const reopened = new FileSessionStore(directory).get(FILE_SESSION_ID);
    expect(reopened?.prompt).toBe('');
    expect(reopened).not.toHaveProperty('error');
  });

  it('marks active sessions failed exactly once after restart', () => {
    const directory = storeDirectory();
    new FileSessionStore(directory).create(
      makeSession({ id: FILE_SESSION_ID, status: 'running' }),
      2,
    );

    const recovered = new FileSessionStore(directory, {
      now: () => '2026-02-01T00:00:00.000Z',
    });
    expect(recovered.get(FILE_SESSION_ID)).toMatchObject({
      status: 'failed',
      completedAt: '2026-02-01T00:00:00.000Z',
      error: SESSION_RESTART_INTERRUPTION_ERROR,
    });
    expect(recovered.getRecoveryReport().interruptedSessionIds).toEqual([FILE_SESSION_ID]);

    const reopened = new FileSessionStore(directory, {
      now: () => '2026-03-01T00:00:00.000Z',
    });
    expect(reopened.get(FILE_SESSION_ID)?.completedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(reopened.getRecoveryReport().interruptedSessionIds).toEqual([]);
  });

  it('quarantines a corrupt record without losing valid sessions', () => {
    const directory = storeDirectory();
    const store = new FileSessionStore(directory);
    store.create(
      makeSession({
        id: FILE_SESSION_ID,
        status: 'completed',
        completedAt: '2026-01-01T00:01:00.000Z',
      }),
      2,
    );
    const corruptPath = join(directory, 'records', `${CORRUPT_SESSION_ID}.json`);
    writeFileSync(corruptPath, '{"schemaVersion":1', 'utf8');

    const reopened = new FileSessionStore(directory);
    const report = reopened.getRecoveryReport();
    expect(reopened.get(FILE_SESSION_ID)).toBeDefined();
    expect(report.loadedSessionCount).toBe(1);
    expect(report.quarantinedFiles).toHaveLength(1);
    expect(report.quarantinedFiles[0]?.originalPath).toBe(corruptPath);
    expect(readFileSync(report.quarantinedFiles[0]?.quarantinePath as string, 'utf8')).toBe(
      '{"schemaVersion":1',
    );
    expect(existsSync(corruptPath)).toBe(false);
  });

  it('quarantines a temporary file left by an interrupted atomic write', () => {
    const directory = storeDirectory();
    new FileSessionStore(directory);
    const temporaryPath = join(directory, 'records', '.session.json.interrupted.tmp');
    const manifestTemporaryPath = join(directory, '.manifest.json.interrupted.tmp');
    writeFileSync(temporaryPath, '{"partial":', 'utf8');
    writeFileSync(manifestTemporaryPath, '{"manifestPartial":', 'utf8');

    const report = new FileSessionStore(directory).getRecoveryReport();
    expect(report.quarantinedFiles).toHaveLength(2);
    expect(report.quarantinedFiles.map(({ originalPath }) => originalPath).sort()).toEqual(
      [temporaryPath, manifestTemporaryPath].sort(),
    );
    expect(
      report.quarantinedFiles
        .map(({ quarantinePath }) => readFileSync(quarantinePath, 'utf8'))
        .sort(),
    ).toEqual(['{"partial":', '{"manifestPartial":'].sort());
  });

  it('rebuilds a corrupt manifest while preserving valid record files', () => {
    const directory = storeDirectory();
    const store = new FileSessionStore(directory);
    store.create(
      makeSession({
        id: FILE_SESSION_ID,
        status: 'completed',
        completedAt: '2026-01-01T00:01:00.000Z',
      }),
    );
    writeFileSync(join(directory, 'manifest.json'), '{"schemaVersion":', 'utf8');

    const reopened = new FileSessionStore(directory);
    expect(reopened.get(FILE_SESSION_ID)).toBeDefined();
    expect(reopened.getRecoveryReport()).toMatchObject({
      manifestAction: 'rebuilt',
      loadedSessionCount: 1,
    });
    expect(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
    });
  });

  it('migrates manifest and record v0 to v1 idempotently', () => {
    const directory = storeDirectory();
    const recordsDirectory = join(directory, 'records');
    mkdirSync(recordsDirectory, { recursive: true });
    writeFileSync(join(directory, 'manifest.json'), '{"schemaVersion":0}\n', 'utf8');
    writeFileSync(
      join(recordsDirectory, `${FILE_SESSION_ID}.json`),
      `${JSON.stringify({
        protocolVersion: 2,
        session: makeSession({
          id: FILE_SESSION_ID,
          prompt: PROMPT_CANARY,
          error: ERROR_CANARY,
          status: 'completed',
          completedAt: '2026-01-01T00:01:00.000Z',
        }),
      })}\n`,
      'utf8',
    );

    const migrated = new FileSessionStore(directory);
    expect(migrated.protocolVersionOf(FILE_SESSION_ID)).toBe(2);
    expect(migrated.get(FILE_SESSION_ID)?.prompt).toBe('');
    expect(migrated.getRecoveryReport()).toMatchObject({
      manifestAction: 'migrated',
      migratedRecordCount: 1,
      loadedSessionCount: 1,
    });
    expect(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
    });
    const migratedRecord = JSON.parse(
      readFileSync(join(recordsDirectory, `${FILE_SESSION_ID}.json`), 'utf8'),
    );
    expect(migratedRecord).toMatchObject({ schemaVersion: 1, protocolVersion: 2 });
    expect(migratedRecord.session).not.toHaveProperty('prompt');
    expect(migratedRecord.session).not.toHaveProperty('error');
    const migratedFiles = readAllStoreFiles(directory).join('\n');
    expect(migratedFiles).not.toContain(PROMPT_CANARY);
    expect(migratedFiles).not.toContain(ERROR_CANARY);

    expect(new FileSessionStore(directory).getRecoveryReport()).toMatchObject({
      manifestAction: 'none',
      migratedRecordCount: 0,
      loadedSessionCount: 1,
    });
  });

  it('rejects prompt-bearing session objects in strict v1 records', () => {
    const directory = storeDirectory();
    const recordsDirectory = join(directory, 'records');
    mkdirSync(recordsDirectory, { recursive: true });
    writeFileSync(join(directory, 'manifest.json'), '{"schemaVersion":1}\n', 'utf8');
    const recordPath = join(recordsDirectory, `${FILE_SESSION_ID}.json`);
    writeFileSync(
      recordPath,
      `${JSON.stringify({
        schemaVersion: 1,
        protocolVersion: 2,
        session: makeSession({
          id: FILE_SESSION_ID,
          prompt: PROMPT_CANARY,
          status: 'completed',
          completedAt: '2026-01-01T00:01:00.000Z',
        }),
      })}\n`,
      'utf8',
    );

    const store = new FileSessionStore(directory);
    expect(store.get(FILE_SESSION_ID)).toBeUndefined();
    expect(store.getRecoveryReport().quarantinedFiles).toHaveLength(1);
    expect(existsSync(recordPath)).toBe(false);
  });

  it('resumes an interrupted mixed-version migration idempotently', () => {
    const directory = storeDirectory();
    const recordsDirectory = join(directory, 'records');
    mkdirSync(recordsDirectory, { recursive: true });
    writeFileSync(join(directory, 'manifest.json'), '{"schemaVersion":0}\n', 'utf8');
    const alreadyMigratedPath = join(recordsDirectory, `${FILE_SESSION_ID}.json`);
    const legacyPath = join(recordsDirectory, `${CORRUPT_SESSION_ID}.json`);
    const interruptedTemporaryPath = join(recordsDirectory, '.migration.interrupted.tmp');
    writeFileSync(
      alreadyMigratedPath,
      `${JSON.stringify({
        schemaVersion: 1,
        protocolVersion: 2,
        session: makePersistedSession({
          id: FILE_SESSION_ID,
          status: 'completed',
          completedAt: '2026-01-01T00:01:00.000Z',
        }),
      })}\n`,
      'utf8',
    );
    writeFileSync(
      legacyPath,
      `${JSON.stringify({
        protocolVersion: 1,
        session: makeSession({
          id: CORRUPT_SESSION_ID,
          status: 'completed',
          completedAt: '2026-01-01T00:02:00.000Z',
        }),
      })}\n`,
      'utf8',
    );
    writeFileSync(interruptedTemporaryPath, '{"schemaVersion":1', 'utf8');
    const alreadyMigratedBytes = readFileSync(alreadyMigratedPath, 'utf8');

    const resumed = new FileSessionStore(directory);
    expect(resumed.list()).toHaveLength(2);
    expect(resumed.getRecoveryReport()).toMatchObject({
      manifestAction: 'migrated',
      loadedSessionCount: 2,
      migratedRecordCount: 1,
    });
    expect(resumed.getRecoveryReport().quarantinedFiles).toHaveLength(1);
    expect(readFileSync(alreadyMigratedPath, 'utf8')).toBe(alreadyMigratedBytes);
    expect(JSON.parse(readFileSync(legacyPath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      protocolVersion: 1,
    });
    const migratedLegacyBytes = readFileSync(legacyPath, 'utf8');

    const reopened = new FileSessionStore(directory);
    expect(reopened.getRecoveryReport()).toMatchObject({
      manifestAction: 'none',
      loadedSessionCount: 2,
      migratedRecordCount: 0,
      quarantinedFiles: [],
    });
    expect(readFileSync(alreadyMigratedPath, 'utf8')).toBe(alreadyMigratedBytes);
    expect(readFileSync(legacyPath, 'utf8')).toBe(migratedLegacyBytes);
    expect(readdirSync(join(directory, 'quarantine'))).toHaveLength(1);
  });

  it('does not rewrite data owned by a newer schema version', () => {
    const directory = storeDirectory();
    mkdirSync(directory, { recursive: true });
    const manifestPath = join(directory, 'manifest.json');
    writeFileSync(manifestPath, '{"schemaVersion":2}\n', 'utf8');

    expect(() => new FileSessionStore(directory)).toThrow(UnsupportedSessionStoreVersionError);
    expect(readFileSync(manifestPath, 'utf8')).toBe('{"schemaVersion":2}\n');
  });

  it('leaves future-version atomic-write temporaries untouched', () => {
    for (const kind of ['manifest', 'record'] as const) {
      const directory = storeDirectory();
      new FileSessionStore(directory);
      const temporaryPath =
        kind === 'manifest'
          ? join(directory, '.manifest.json.future.tmp')
          : join(directory, 'records', '.session.json.future.tmp');
      const bytes = '{"schemaVersion":2,"future":true}\n';
      writeFileSync(temporaryPath, bytes, 'utf8');

      expect(() => new FileSessionStore(directory)).toThrow(UnsupportedSessionStoreVersionError);
      expect(readFileSync(temporaryPath, 'utf8')).toBe(bytes);
      expect(readdirSync(join(directory, 'quarantine'))).toHaveLength(0);
    }
  });

  it('preflights every record before migrating or recovering older data', () => {
    const directory = storeDirectory();
    new FileSessionStore(directory).create(
      makeSession({ id: FILE_SESSION_ID, status: 'running' }),
      2,
    );
    const activePath = join(directory, 'records', `${FILE_SESSION_ID}.json`);
    const futurePath = join(directory, 'records', `${CORRUPT_SESSION_ID}.json`);
    const corruptPath = join(directory, 'records', `${SECOND_SESSION_ID}.json`);
    writeFileSync(
      futurePath,
      `${JSON.stringify({
        schemaVersion: 2,
        protocolVersion: 2,
        session: makeSession({
          id: CORRUPT_SESSION_ID,
          status: 'completed',
          completedAt: '2026-01-01T00:01:00.000Z',
        }),
      })}\n`,
      'utf8',
    );
    writeFileSync(corruptPath, '{"schemaVersion":1', 'utf8');
    const paths = [join(directory, 'manifest.json'), activePath, futurePath, corruptPath];
    const originalBytes = paths.map((path) => readFileSync(path, 'utf8'));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => new FileSessionStore(directory)).toThrow(UnsupportedSessionStoreVersionError);
    }
    expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(originalBytes);
    expect(JSON.parse(readFileSync(activePath, 'utf8')).session.status).toBe('running');
    expect(existsSync(futurePath)).toBe(true);
    expect(existsSync(corruptPath)).toBe(true);
    expect(readdirSync(join(directory, 'quarantine'))).toEqual([]);
  });

  it('rejects update for a record that was never created', () => {
    const directory = storeDirectory();
    const store = new FileSessionStore(directory);
    const session = makeSession({
      id: FILE_SESSION_ID,
      status: 'completed',
      completedAt: '2026-01-01T00:01:00.000Z',
    });

    expect(() => store.update(FILE_SESSION_ID, session)).toThrow(
      `cannot update unknown session: ${FILE_SESSION_ID}`,
    );
    expect(store.get(FILE_SESSION_ID)).toBeUndefined();
    expect(readdirSync(join(directory, 'records'))).toEqual([]);
  });

  it('treats deletion of an invalid or missing id as a no-op', () => {
    const store = new FileSessionStore(storeDirectory());
    expect(() => store.delete('never-existed')).not.toThrow();
    expect(() => store.delete(FILE_SESSION_ID)).not.toThrow();
  });

  it('creates private state directories and metadata files', () => {
    if (process.platform === 'win32') return;
    const directory = storeDirectory();
    const store = new FileSessionStore(directory);
    store.create(
      makeSession({
        id: FILE_SESSION_ID,
        status: 'completed',
        completedAt: '2026-01-01T00:01:00.000Z',
      }),
    );

    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'records')).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'quarantine')).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'manifest.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, 'records', `${FILE_SESSION_ID}.json`)).mode & 0o777).toBe(
      0o600,
    );
  });
});
