import { randomUUID } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureStateDirectory } from './state-directory.js';
import type { WorkspaceIdentity } from './workspace-identity.js';

export type StoredWorkspaceTrustState = 'trusted' | 'untrusted' | 'revoking';

interface StoredTrustRecord {
  workspaceId: string;
  incarnation: string;
  state: StoredWorkspaceTrustState;
  updatedAt: string;
}

interface TrustFileV1 {
  version: 1;
  records: StoredTrustRecord[];
}

export interface WorkspaceTrustView {
  workspaceId: string;
  incarnation: string;
  displayName: string;
  state: 'trusted' | 'untrusted';
}

function isRecord(value: unknown): value is StoredTrustRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<StoredTrustRecord>;
  return (
    typeof record.workspaceId === 'string' &&
    /^[a-f0-9]{64}$/.test(record.workspaceId) &&
    typeof record.incarnation === 'string' &&
    /^[a-f0-9]{64}$/.test(record.incarnation) &&
    (record.state === 'trusted' || record.state === 'untrusted' || record.state === 'revoking') &&
    typeof record.updatedAt === 'string' &&
    !Number.isNaN(Date.parse(record.updatedAt))
  );
}

/** Small versioned trust store. A malformed or interrupted state never becomes trusted. */
export class WorkspaceTrustStore {
  private records: Map<string, StoredTrustRecord> | undefined;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async inspect(identity: WorkspaceIdentity): Promise<WorkspaceTrustView> {
    await this.load();
    const record = this.records?.get(identity.workspaceId);
    const trusted = record?.state === 'trusted' && record.incarnation === identity.incarnation;
    return {
      workspaceId: identity.workspaceId,
      incarnation: identity.incarnation,
      displayName: identity.displayName,
      state: trusted ? 'trusted' : 'untrusted',
    };
  }

  setTrusted(identity: WorkspaceIdentity): Promise<void> {
    return this.update(identity, 'trusted');
  }

  beginRevocation(identity: WorkspaceIdentity): Promise<void> {
    return this.update(identity, 'revoking');
  }

  finishRevocation(identity: WorkspaceIdentity): Promise<void> {
    return this.update(identity, 'untrusted');
  }

  private update(identity: WorkspaceIdentity, state: StoredWorkspaceTrustState): Promise<void> {
    const operation = this.writeTail.then(async () => {
      await this.load();
      this.records?.set(identity.workspaceId, {
        workspaceId: identity.workspaceId,
        incarnation: identity.incarnation,
        state,
        updatedAt: new Date().toISOString(),
      });
      await this.persist();
    });
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private async load(): Promise<void> {
    if (this.records) return;
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.records = new Map();
        return;
      }
      throw error;
    }

    const parsed = JSON.parse(raw) as Partial<TrustFileV1>;
    if (parsed.version !== 1 || !Array.isArray(parsed.records) || !parsed.records.every(isRecord)) {
      throw new Error('workspace trust store is invalid');
    }
    this.records = new Map(parsed.records.map((record) => [record.workspaceId, record]));
  }

  private async persist(): Promise<void> {
    if (!this.records) throw new Error('workspace trust store was not loaded');
    const directory = dirname(this.filePath);
    await ensureStateDirectory(directory);
    const temporaryPath = join(directory, `.workspace-trust-${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      const payload: TrustFileV1 = { version: 1, records: [...this.records.values()] };
      await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.filePath);
  }
}
