import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionKey, type PermissionActionV2 } from '@agent-dock/shared';
import { afterEach, describe, expect, it } from 'vitest';
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
