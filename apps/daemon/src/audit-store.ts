import { constants as fsConstants } from 'node:fs';
import { open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  auditEntryV2Schema,
  auditReadResponseV2Schema,
  type AuditEntryV2,
  type AuditReadResponseV2,
} from '@agent-dock/shared';
import { ensureStateDirectory } from './state-directory.js';

const MAX_AUDIT_FILE_BYTES = 64 * 1024 * 1024;
// How long a rotated (no longer active) segment survives before deletion (issue #67). Deliberately
// long: this is a safety-net age cap on top of the size cap below, not a short-lived cache.
const MAX_AUDIT_SEGMENT_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
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
  /** Overrides for tests; production always uses the real constants and clock. */
  maxFileBytes?: number;
  maxSegmentAgeMs?: number;
  now?: () => Date;
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
  private readonly maxFileBytes: number;
  private readonly maxSegmentAgeMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly filePath: string,
    dependencies: AuditStoreDependencies = {},
  ) {
    this.openFile = dependencies.openFile ?? defaultOpenFile;
    this.syncDirectory = dependencies.syncDirectory ?? syncParentDirectory;
    this.maxFileBytes = dependencies.maxFileBytes ?? MAX_AUDIT_FILE_BYTES;
    this.maxSegmentAgeMs = dependencies.maxSegmentAgeMs ?? MAX_AUDIT_SEGMENT_AGE_MS;
    this.now = dependencies.now ?? (() => new Date());
  }

  append(input: NewAuditEntryV2): Promise<AuditEntryV2> {
    const operation = this.writeTail.then(async () => {
      await this.initialize();
      if (this.unhealthy) throw new AuditStoreCorruptError('audit store is unhealthy');
      // Measured against a provisional sequence purely to size the line -- a sequence number's
      // own byte width is immaterial to the cap check, but the *real* entry/line actually written
      // below is always recomputed after any rotation, so its sequence is correct for whichever
      // file it lands in.
      const provisionalLine = `${JSON.stringify(
        auditEntryV2Schema.parse({ ...input, sequence: this.entries?.length ?? 0 }),
      )}\n`;
      const currentSize = await this.fileSize();
      if (currentSize > 0 && currentSize + Buffer.byteLength(provisionalLine) > this.maxFileBytes) {
        // Rotate instead of failing closed forever once the cap is hit (issue #67): the current
        // file becomes an immutable, timestamped archive segment -- never rewritten, only ever
        // deleted whole once it ages out (pruneExpiredSegments()) -- and a fresh file starts at
        // sequence 0. This is the one deliberate exception to "audit deletion never rewrites
        // metadata": deletion here always removes a whole segment file, never edits a surviving
        // entry's own fields, so no entry's own sequence/content is ever silently changed.
        await this.rotateUnlocked();
      }
      const entry = auditEntryV2Schema.parse({
        ...input,
        sequence: this.entries?.length ?? 0,
      });
      const line = `${JSON.stringify(entry)}\n`;
      if (Buffer.byteLength(line) > this.maxFileBytes) {
        throw new Error('a single audit entry exceeds the audit file size cap');
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
    await this.pruneExpiredSegments();
    let raw: string;
    try {
      const details = await stat(this.filePath);
      if (details.size > this.maxFileBytes) throw new AuditStoreCorruptError();
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

  private segmentPrefix(): string {
    const name = basename(this.filePath);
    return name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name;
  }

  private archivedSegmentPath(rotatedAt: Date): string {
    return join(dirname(this.filePath), `${this.segmentPrefix()}.${rotatedAt.getTime()}.jsonl`);
  }

  /**
   * Moves the current audit file aside, whole and unmodified, to an immutable archive segment
   * name, then resets in-memory state so the next append starts a fresh file at sequence 0. Only
   * called from within `append()`'s already-serialized `writeTail` chain.
   */
  private async rotateUnlocked(): Promise<void> {
    const rotatedAt = this.now();
    await rename(this.filePath, this.archivedSegmentPath(rotatedAt));
    this.entries = [];
  }

  /**
   * Deletes whole rotated segments older than `maxSegmentAgeMs` (issue #67). Never touches the
   * active file (it isn't named like a segment) and never partially rewrites a segment -- each one
   * is either kept exactly as rotation left it, or deleted entirely. Runs once per store lifetime,
   * from `load()`.
   */
  private async pruneExpiredSegments(): Promise<void> {
    const dir = dirname(this.filePath);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    const prefix = `${this.segmentPrefix()}.`;
    const cutoff = this.now().getTime() - this.maxSegmentAgeMs;
    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith('.jsonl')) continue;
      const middle = name.slice(prefix.length, -'.jsonl'.length);
      if (!/^\d+$/.test(middle)) continue;
      if (Number(middle) < cutoff) await unlink(join(dir, name)).catch(() => undefined);
    }
  }
}
