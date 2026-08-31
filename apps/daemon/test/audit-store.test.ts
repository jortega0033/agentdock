import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { permissionKey, type PermissionActionV2 } from '@agent-dock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditStore, AuditStoreCorruptError, type NewAuditEntryV2 } from '../src/audit-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function auditPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-dock-audit-'));
  temporaryDirectories.push(root);
  return join(root, 'audit-v1.jsonl');
}

const action: PermissionActionV2 = {
  actionClass: 'command',
  operation: 'command.execute',
  targetFingerprint: 'a'.repeat(64),
  safeTargetSummary: 'git status',
  risk: 'normal',
  effectsComplete: true,
  mcpDestructive: false,
};

function entry(overrides: Partial<NewAuditEntryV2> = {}): NewAuditEntryV2 {
  return {
    schemaVersion: 1,
    entryId: randomUUID(),
    recordedAt: new Date().toISOString(),
    sessionId: randomUUID(),
    turnId: randomUUID(),
    requestId: randomUUID(),
    providerId: 'claude',
    transport: 'fake-v2',
    workspaceFingerprint: 'b'.repeat(64),
    action,
    permissionKey: permissionKey(action),
    decision: 'allow_once',
    actor: 'user',
    ...overrides,
  };
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe('AuditStore', () => {
  it('serializes concurrent durable appends and reloads contiguous records', async () => {
    const path = await auditPath();
    const store = new AuditStore(path);
    const sessionId = randomUUID();
    const written = await Promise.all([
      store.append(entry({ sessionId })),
      store.append(entry({ sessionId })),
      store.append(entry()),
    ]);

    expect(written.map((item) => item.sequence)).toEqual([0, 1, 2]);
    const reloaded = new AuditStore(path);
    const firstPage = await reloaded.read({ limit: 1, sessionId });
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.nextCursor).toBeDefined();
    const secondPage = await reloaded.read({
      cursor: firstPage.nextCursor,
      limit: 10,
      sessionId,
    });
    expect(secondPage.entries).toHaveLength(1);
  });

  it('syncs the parent directory once after the audit file is first durably created', async () => {
    const path = await auditPath();
    const directorySyncs: Array<{ directory: string; durableContents: string }> = [];
    const store = new AuditStore(path, {
      syncDirectory: async (directory) => {
        directorySyncs.push({ directory, durableContents: await readFile(path, 'utf8') });
      },
    });

    await store.append(entry());
    await store.append(entry());

    expect(directorySyncs).toEqual([
      {
        directory: dirname(path),
        durableContents: expect.stringMatching(/^\{.*\}\n$/),
      },
    ]);
  });

  it('fails closed when the first-create directory durability barrier fails', async () => {
    const failure = new Error('directory fsync failed');
    const store = new AuditStore(await auditPath(), {
      syncDirectory: async () => Promise.reject(failure),
    });

    await expect(store.append(entry())).rejects.toBe(failure);
    await expect(store.append(entry())).rejects.toBeInstanceOf(AuditStoreCorruptError);
  });

  it('does not recreate a file through the existing-file append fallback', async () => {
    const path = await auditPath();
    const flags: Array<string | number> = [];
    const handle = {
      writeFile: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const openFile = vi.fn(async (_path: string, flag: string | number) => {
      flags.push(flag);
      if (flags.length === 1) throw errno('EEXIST');
      if (flags.length === 2) throw errno('ENOENT');
      return handle;
    });
    const syncDirectory = vi.fn(async () => undefined);
    const store = new AuditStore(path, { openFile, syncDirectory });

    await store.append(entry());

    expect(flags).toEqual([
      'ax',
      fsConstants.O_WRONLY |
        fsConstants.O_APPEND |
        (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0),
      'ax',
    ]);
    expect(syncDirectory).toHaveBeenCalledOnce();
  });

  it('rejects a persistent create/open race instead of retrying forever', async () => {
    let attempts = 0;
    const openFile = vi.fn(async () => {
      attempts += 1;
      throw errno(attempts % 2 === 1 ? 'EEXIST' : 'ENOENT');
    });
    const store = new AuditStore(await auditPath(), { openFile });

    await expect(store.append(entry())).rejects.toThrow('could not be opened safely');
    expect(openFile).toHaveBeenCalledTimes(8);
  });

  it('rejects an existing symlink instead of following it during append', async () => {
    const openFile = vi
      .fn()
      .mockRejectedValueOnce(errno('EEXIST'))
      .mockRejectedValueOnce(errno('ELOOP'));
    const store = new AuditStore(await auditPath(), { openFile });

    await expect(store.append(entry())).rejects.toMatchObject({ code: 'ELOOP' });
    expect(openFile).toHaveBeenCalledTimes(2);
  });

  it('marks close failures unhealthy without hiding an earlier write failure', async () => {
    const closeFailure = new Error('close failed');
    const syncDirectory = vi.fn(async () => undefined);
    const closeFailingStore = new AuditStore(await auditPath(), {
      openFile: async () => ({
        writeFile: async () => undefined,
        sync: async () => undefined,
        close: async () => Promise.reject(closeFailure),
      }),
      syncDirectory,
    });
    await expect(closeFailingStore.append(entry())).rejects.toBe(closeFailure);
    await expect(closeFailingStore.append(entry())).rejects.toBeInstanceOf(AuditStoreCorruptError);
    expect(syncDirectory).not.toHaveBeenCalled();

    const writeFailure = new Error('write failed');
    const writeAndCloseFailingStore = new AuditStore(await auditPath(), {
      openFile: async () => ({
        writeFile: async () => Promise.reject(writeFailure),
        sync: async () => undefined,
        close: async () => Promise.reject(closeFailure),
      }),
    });
    await expect(writeAndCloseFailingStore.append(entry())).rejects.toBe(writeFailure);
  });

  it('writes only schema-allowlisted metadata and never arbitrary secret fields', async () => {
    const path = await auditPath();
    const store = new AuditStore(path);
    await expect(
      store.append({ ...entry(), prompt: 'SECRET_CANARY' } as NewAuditEntryV2),
    ).rejects.toThrow();
    expect(await readFile(path, 'utf8').catch(() => '')).not.toContain('SECRET_CANARY');
  });

  it('fails closed on a torn or corrupt audit line', async () => {
    const path = await auditPath();
    await writeFile(path, '{"schemaVersion":1', 'utf8');
    const store = new AuditStore(path);

    await expect(store.read()).rejects.toBeInstanceOf(AuditStoreCorruptError);
    await expect(store.append(entry())).rejects.toBeInstanceOf(AuditStoreCorruptError);
  });

  it('rejects invalid cursors and page bounds', async () => {
    const store = new AuditStore(await auditPath());
    await expect(store.read({ cursor: '$bad' })).rejects.toThrow('invalid audit cursor');
    await expect(store.read({ limit: 101 })).rejects.toThrow('audit limit');
  });
});
