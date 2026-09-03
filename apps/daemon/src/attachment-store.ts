import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  ATTACHMENT_LIMITS_V2,
  attachmentMetadataV2Schema,
  type AttachmentMetadataV2,
} from '@agent-dock/shared';
import { noopLogger, type Logger } from '@agent-dock/agent-runtime';

export interface StoredAttachment extends AttachmentMetadataV2 {
  path: string;
}
interface Manifest {
  version: 1;
  attachments: StoredAttachment[];
}
type AttachmentLimits = { [Key in keyof typeof ATTACHMENT_LIMITS_V2]: number };

export class AttachmentStoreError extends Error {
  constructor(
    readonly code:
      | 'attachment_too_large'
      | 'attachment_quota_exceeded'
      | 'attachment_count_exceeded'
      | 'attachment_not_found'
      | 'attachment_size_mismatch'
      | 'attachment_mime_unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentStoreError';
  }
}

function safeName(value: string): string {
  const normalized = [...basename(value.normalize('NFKC'))]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .trim()
    .slice(0, 255);
  return normalized || 'attachment';
}

function sniffMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
    bytes.subarray(0, 6).toString('ascii') === 'GIF89a'
  )
    return 'image/gif';
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (!bytes.includes(0) && bytes.toString('utf8').includes('\ufffd') === false) {
    const trimmed = bytes.toString('utf8').trimStart();
    return trimmed.startsWith('{') || trimmed.startsWith('[') ? 'application/json' : 'text/plain';
  }
  return undefined;
}

/** Private, quota-bound, atomic staging. It never removes the user-selected source file. */
export class AttachmentStore {
  readonly #records = new Map<string, StoredAttachment>();
  readonly #pendingSessions = new Map<string, { bytes: number; files: number }>();
  #pendingBytes = 0;
  #pendingFiles = 0;
  #mutationTail: Promise<void> = Promise.resolve();
  #writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly manifestPath: string,
    private readonly now: () => Date = () => new Date(),
    private readonly limits: AttachmentLimits = ATTACHMENT_LIMITS_V2,
    private readonly logger: Logger = noopLogger,
  ) {}

  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.manifestPath, 'utf8')) as Partial<Manifest>;
      if (parsed.version === 1 && Array.isArray(parsed.attachments)) {
        for (const raw of parsed.attachments.slice(0, this.limits.maxGlobalFiles)) {
          const { path, ...metadata } = raw as StoredAttachment;
          const valid = attachmentMetadataV2Schema.safeParse(metadata);
          if (valid.success && typeof path === 'string' && dirname(path) === this.root)
            this.#records.set(valid.data.id, { ...valid.data, path });
        }
      }
    } catch {
      /* empty fail-closed store */
    }
    await this.reconcileOrphanedFiles();
    await this.cleanupExpired();
  }

  /**
   * A crash between `stage()`'s durable file write (`rename(temporary, destination)`) and its
   * manifest `persist()` -- or between opening a `.tmp` file and ever completing it -- leaves a
   * real file on disk with nothing in the manifest referencing it: a pure quota leak with no
   * other cleanup path, since every other method here only ever iterates `#records` (issue #67).
   * Reconciles the two by listing what's actually in `root` and removing anything the manifest
   * doesn't know about. Never touches a file the manifest does reference, however old.
   */
  private async reconcileOrphanedFiles(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return;
    }
    const known = new Set([...this.#records.values()].map((record) => basename(record.path)));
    let orphaned = 0;
    for (const entry of entries) {
      const isTemp = entry.startsWith('.') && entry.endsWith('.tmp');
      const isOrphanedBlob = entry.endsWith('.bin') && !known.has(entry);
      if (!isTemp && !isOrphanedBlob) continue;
      await unlink(join(this.root, entry)).catch(() => undefined);
      orphaned += 1;
    }
    if (orphaned > 0) {
      this.logger.warn('removed orphaned attachment files with no surviving manifest entry', {
        count: orphaned,
      });
    }
  }

  async stage(input: {
    fileName: string;
    declaredSize: number;
    sessionId?: string;
    stream: AsyncIterable<Uint8Array>;
  }): Promise<AttachmentMetadataV2> {
    if (input.declaredSize > this.limits.maxFileBytes)
      throw new AttachmentStoreError('attachment_too_large', 'Attachment exceeds 25 MiB');
    this.reserve(input.declaredSize, input.sessionId);
    const id = randomUUID();
    const temporary = join(this.root, `.${id}.tmp`);
    const destination = join(this.root, `${id}.bin`);
    const handle = await open(temporary, 'wx', 0o600).catch((error) => {
      this.release(input.declaredSize, input.sessionId);
      throw error;
    });
    let size = 0;
    let prefix = Buffer.alloc(0);
    let committed = false;
    try {
      for await (const value of input.stream) {
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > this.limits.maxFileBytes || size > input.declaredSize)
          throw new AttachmentStoreError(
            'attachment_too_large',
            'Attachment exceeded its authorized size',
          );
        if (prefix.length < 512)
          prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)]);
        await handle.write(chunk);
      }
      if (size !== input.declaredSize)
        throw new AttachmentStoreError(
          'attachment_size_mismatch',
          'Attachment size did not match the selected file',
        );
      const mimeType = sniffMime(prefix);
      if (!mimeType)
        throw new AttachmentStoreError(
          'attachment_mime_unsupported',
          'Attachment MIME type is unsupported',
        );
      await handle.sync();
      await handle.close();
      await rename(temporary, destination);
      committed = true;
      const metadata: AttachmentMetadataV2 = {
        id,
        fileName: safeName(input.fileName),
        mimeType,
        size,
        createdAt: this.now().toISOString(),
        referenced: !!input.sessionId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      };
      this.#records.set(id, { ...metadata, path: destination });
      await this.persist();
      return structuredClone(metadata);
    } finally {
      await handle.close().catch(() => undefined);
      if (!committed) await unlink(temporary).catch(() => undefined);
      this.release(input.declaredSize, input.sessionId);
    }
  }

  list(): AttachmentMetadataV2[] {
    return [...this.#records.values()].map(({ path: _path, ...metadata }) =>
      structuredClone(metadata),
    );
  }

  async reference(ids: string[], sessionId: string): Promise<AttachmentMetadataV2[]> {
    const records = await this.serializeMutation(() => this.referenceUnlocked(ids, sessionId));
    return records.map(({ path: _path, ...metadata }) => structuredClone(metadata));
  }

  /**
   * Daemon-internal only -- unlike `reference()`, the result carries each attachment's real,
   * canonical on-disk path, so a provider transport can read the file directly. Never expose this
   * to a route response or log; only a trusted in-process caller (SessionManager) should call it.
   */
  async referenceForDispatch(ids: string[], sessionId: string): Promise<StoredAttachment[]> {
    const records = await this.serializeMutation(() => this.referenceUnlocked(ids, sessionId));
    return records.map((record) => structuredClone(record));
  }

  private async referenceUnlocked(ids: string[], sessionId: string): Promise<StoredAttachment[]> {
    const uniqueIds = [...new Set(ids)];
    const records = uniqueIds.map((id) => {
      const record = this.#records.get(id);
      if (!record)
        throw new AttachmentStoreError('attachment_not_found', 'Attachment was not found');
      if (record.sessionId && record.sessionId !== sessionId)
        throw new AttachmentStoreError(
          'attachment_not_found',
          'Attachment belongs to another session',
        );
      return record;
    });
    const session = new Map(
      [...this.#records.values()]
        .filter((record) => record.sessionId === sessionId)
        .map((record) => [record.id, record]),
    );
    for (const record of records) session.set(record.id, record);
    const bytes = [...session.values()].reduce((sum, item) => sum + item.size, 0);
    if (
      bytes > this.limits.maxSessionBytes ||
      session.size > this.limits.maxSessionFiles
    )
      throw new AttachmentStoreError(
        'attachment_quota_exceeded',
        'Session attachment quota exceeded',
      );
    for (const record of records) {
      record.referenced = true;
      record.sessionId = sessionId;
    }
    await this.persist();
    return records;
  }

  /**
   * Explicit, immediate deletion -- unlike `cleanupExpired()`'s unreferenced-only TTL sweep, this
   * deletes whatever ids are given regardless of reference state, so a session-terminal hook or a
   * user-triggered `DELETE /v2/attachments/:id` can actually recover quota instead of waiting up
   * to 24h. Unknown ids are silently ignored (already gone is not an error for a delete call).
   */
  async deleteAttachments(ids: readonly string[]): Promise<void> {
    return this.serializeMutation(() => this.deleteAttachmentsUnlocked(ids));
  }

  private async deleteAttachmentsUnlocked(ids: readonly string[]): Promise<void> {
    let changed = false;
    for (const id of ids) {
      const record = this.#records.get(id);
      if (!record) continue;
      await unlink(record.path).catch(() => undefined);
      this.#records.delete(id);
      changed = true;
    }
    if (changed) await this.persist();
  }

  async cleanupExpired(): Promise<void> {
    return this.serializeMutation(() => this.cleanupExpiredUnlocked());
  }

  private async cleanupExpiredUnlocked(): Promise<void> {
    const now = this.now().getTime();
    const unreferencedCutoff = now - this.limits.unreferencedTtlMs;
    const referencedCutoff = now - this.limits.maxReferencedAgeMs;
    let changed = false;
    for (const [id, record] of this.#records) {
      const createdAt = Date.parse(record.createdAt);
      const expired = record.referenced
        ? createdAt < referencedCutoff
        : createdAt < unreferencedCutoff;
      if (!expired) continue;
      await unlink(record.path).catch(() => undefined);
      this.#records.delete(id);
      changed = true;
    }
    if (changed) await this.persist();
  }

  /**
   * Whole-lineage cleanup (issue #67): releases every attachment referenced by any of the given
   * session ids, regardless of age. Meant to be called from the durable execution graph's
   * lineage-removal hook (`onLineageRemoving` in apps/daemon/src/index.ts) so an attachment does
   * not outlive the session it was bound to just because it hasn't hit its age cap yet. Never
   * touches an attachment whose sessionId isn't in the given set, and never touches a user's
   * original source file (this store only ever unlinks its own staged copy).
   */
  async releaseSessions(sessionIds: readonly string[]): Promise<void> {
    return this.serializeMutation(() => this.releaseSessionsUnlocked(sessionIds));
  }

  private async releaseSessionsUnlocked(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const ids = new Set(sessionIds);
    let changed = false;
    for (const [id, record] of this.#records) {
      if (!record.sessionId || !ids.has(record.sessionId)) continue;
      await unlink(record.path).catch(() => undefined);
      this.#records.delete(id);
      changed = true;
    }
    if (changed) await this.persist();
  }

  private assertQuota(bytes: number, sessionId?: string): void {
    const all = [...this.#records.values()];
    if (all.length + this.#pendingFiles >= this.limits.maxGlobalFiles)
      throw new AttachmentStoreError(
        'attachment_count_exceeded',
        'Global attachment count exceeded',
      );
    if (
      all.reduce((sum, item) => sum + item.size, 0) + this.#pendingBytes + bytes >
      this.limits.maxGlobalBytes
    )
      throw new AttachmentStoreError(
        'attachment_quota_exceeded',
        'Global attachment quota exceeded',
      );
    if (sessionId) {
      const session = all.filter((item) => item.sessionId === sessionId);
      const pending = this.#pendingSessions.get(sessionId) ?? { bytes: 0, files: 0 };
      if (
        session.length + pending.files >= this.limits.maxSessionFiles ||
        session.reduce((sum, item) => sum + item.size, 0) + pending.bytes + bytes >
          this.limits.maxSessionBytes
      )
        throw new AttachmentStoreError(
          'attachment_quota_exceeded',
          'Session attachment quota exceeded',
        );
    }
  }

  private reserve(bytes: number, sessionId?: string): void {
    this.assertQuota(bytes, sessionId);
    this.#pendingBytes += bytes;
    this.#pendingFiles += 1;
    if (sessionId) {
      const pending = this.#pendingSessions.get(sessionId) ?? { bytes: 0, files: 0 };
      this.#pendingSessions.set(sessionId, {
        bytes: pending.bytes + bytes,
        files: pending.files + 1,
      });
    }
  }

  private release(bytes: number, sessionId?: string): void {
    this.#pendingBytes -= bytes;
    this.#pendingFiles -= 1;
    if (!sessionId) return;
    const pending = this.#pendingSessions.get(sessionId);
    if (!pending || pending.files <= 1) this.#pendingSessions.delete(sessionId);
    else
      this.#pendingSessions.set(sessionId, {
        bytes: pending.bytes - bytes,
        files: pending.files - 1,
      });
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private persist(): Promise<void> {
    const operation = this.#writeTail.then(async () => {
      const temporary = `${this.manifestPath}.${randomUUID()}.tmp`;
      await mkdir(dirname(this.manifestPath), { recursive: true, mode: 0o700 });
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, attachments: [...this.#records.values()] })}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      );
      await rename(temporary, this.manifestPath);
    });
    this.#writeTail = operation.catch(() => undefined);
    return operation;
  }
}
