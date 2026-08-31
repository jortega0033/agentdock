import { constants as fsConstants } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  auditEntryV2Schema,
  auditReadResponseV2Schema,
  type AuditEntryV2,
  type AuditReadResponseV2,
} from '@agent-dock/shared';
import { ensureStateDirectory } from './state-directory.js';

const MAX_AUDIT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_AUDIT_PAGE_ENTRIES = 100;
const MAX_OPEN_RACE_RETRIES = 4;

interface AuditFileHandle {
  writeFile(data: string, encoding: 'utf8'): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

type OpenFile = (
  filePath: string,
  flags: string | number,
  mode?: number,
) => Promise<AuditFileHandle>;

export interface AuditStoreDependencies {
  openFile?: OpenFile;
  syncDirectory?: (directory: string) => Promise<void>;
}

const defaultOpenFile: OpenFile = (filePath, flags, mode) => open(filePath, flags, mode);

async function openAuditFile(
  filePath: string,
  openFile: OpenFile,
): Promise<{
  handle: AuditFileHandle;
  created: boolean;
}> {
  for (let attempt = 0; attempt < MAX_OPEN_RACE_RETRIES; attempt += 1) {
    try {
      return { handle: await openFile(filePath, 'ax', 0o600), created: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    try {
      return {
        handle: await openFile(
          filePath,
          fsConstants.O_WRONLY |
            fsConstants.O_APPEND |
            (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0),
        ),
        created: false,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('audit file could not be opened safely');
}

async function syncParentDirectory(directory: string): Promise<void> {
  try {
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Node cannot open/fsync directory handles on Windows. Ignore only its documented
    // unsupported-operation errors there; every POSIX persistence failure remains fatal.
    if (
      process.platform !== 'win32' ||
      (code !== 'EPERM' && code !== 'EACCES' && code !== 'EINVAL')
    ) {
      throw error;
    }
  }
}

export type NewAuditEntryV2 = Omit<AuditEntryV2, 'sequence'>;

export class AuditStoreCorruptError extends Error {
  constructor(message = 'audit store is corrupt') {
    super(message);
    this.name = 'AuditStoreCorruptError';
  }
}

function encodeCursor(sequence: number): string {
  return Buffer.from(String(sequence), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) throw new Error('invalid audit cursor');
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^(0|[1-9]\d*)$/.test(decoded)) throw new Error('invalid audit cursor');
  const sequence = Number(decoded);
  if (!Number.isSafeInteger(sequence)) throw new Error('invalid audit cursor');
  return sequence;
}

/** Serialized, fsync-before-return JSONL audit storage. Strict schemas prevent raw data leakage. */
export class AuditStore {
  private entries: AuditEntryV2[] | undefined;
  private initializePromise: Promise<void> | undefined;
  private writeTail: Promise<void> = Promise.resolve();
  private unhealthy = false;
  private readonly openFile: OpenFile;
  private readonly syncDirectory: (directory: string) => Promise<void>;

  constructor(
    private readonly filePath: string,
    dependencies: AuditStoreDependencies = {},
  ) {
    this.openFile = dependencies.openFile ?? defaultOpenFile;
    this.syncDirectory = dependencies.syncDirectory ?? syncParentDirectory;
  }

  append(input: NewAuditEntryV2): Promise<AuditEntryV2> {
    const operation = this.writeTail.then(async () => {
      await this.initialize();
      if (this.unhealthy) throw new AuditStoreCorruptError('audit store is unhealthy');
      const entry = auditEntryV2Schema.parse({
        ...input,
        sequence: this.entries?.length ?? 0,
      });
      const line = `${JSON.stringify(entry)}\n`;
      const currentSize = await this.fileSize();
      if (currentSize + Buffer.byteLength(line) > MAX_AUDIT_FILE_BYTES) {
        throw new Error('audit store size limit reached');
      }
      await ensureStateDirectory(dirname(this.filePath));
      const { handle, created } = await openAuditFile(this.filePath, this.openFile);
      let operationFailed = false;
      let operationError: unknown;
      try {
        await handle.writeFile(line, 'utf8');
        await handle.sync();
      } catch (error) {
        this.unhealthy = true;
        operationFailed = true;
        operationError = error;
      }
      try {
        await handle.close();
      } catch (error) {
        this.unhealthy = true;
        if (!operationFailed) {
          operationFailed = true;
          operationError = error;
        }
      }
      if (operationFailed) throw operationError;
      if (created) {
        try {
          await this.syncDirectory(dirname(this.filePath));
        } catch (error) {
          this.unhealthy = true;
          throw error;
        }
      }
      this.entries?.push(entry);
      return entry;
    });
    this.writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async read(
    options: {
      cursor?: string;
      limit?: number;
      sessionId?: string;
    } = {},
  ): Promise<AuditReadResponseV2> {
    await this.writeTail;
    await this.initialize();
    if (this.unhealthy) throw new AuditStoreCorruptError('audit store is unhealthy');
    const start = decodeCursor(options.cursor);
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_PAGE_ENTRIES) {
      throw new Error(`audit limit must be between 1 and ${MAX_AUDIT_PAGE_ENTRIES}`);
    }
    const source = this.entries ?? [];
    const page: AuditEntryV2[] = [];
    let scan = start;
    while (scan < source.length && page.length < limit) {
      const entry = source[scan];
      scan += 1;
      if (entry && (options.sessionId === undefined || entry.sessionId === options.sessionId)) {
        page.push(entry);
      }
    }
    return auditReadResponseV2Schema.parse({
      schemaVersion: 1,
      entries: page,
      ...(scan < source.length ? { nextCursor: encodeCursor(scan) } : {}),
    });
  }

  private async initialize(): Promise<void> {
    if (this.entries) return;
    if (!this.initializePromise) {
      this.initializePromise = this.load().catch((error: unknown) => {
        this.unhealthy = true;
        throw error;
      });
    }
    await this.initializePromise;
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      const details = await stat(this.filePath);
      if (details.size > MAX_AUDIT_FILE_BYTES) throw new AuditStoreCorruptError();
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries = [];
        return;
      }
      throw error;
    }
    const lines = raw.length === 0 ? [] : raw.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const entries: AuditEntryV2[] = [];
    try {
      for (const [sequence, line] of lines.entries()) {
        if (!line) throw new Error('blank audit record');
        const entry = auditEntryV2Schema.parse(JSON.parse(line));
        if (entry.sequence !== sequence) throw new Error('non-contiguous audit sequence');
        entries.push(entry);
      }
    } catch {
      throw new AuditStoreCorruptError();
    }
    this.entries = entries;
  }

  private async fileSize(): Promise<number> {
    try {
      return (await stat(this.filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }
}
