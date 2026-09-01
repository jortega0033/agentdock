import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ATTACHMENT_LIMITS_V2, attachmentMetadataV2Schema, type AttachmentMetadataV2 } from '@agent-dock/shared';

interface StoredAttachment extends AttachmentMetadataV2 { path: string }
interface Manifest { version: 1; attachments: StoredAttachment[] }

export class AttachmentStoreError extends Error {
  constructor(readonly code: 'attachment_too_large' | 'attachment_quota_exceeded' | 'attachment_count_exceeded' | 'attachment_not_found' | 'attachment_size_mismatch' | 'attachment_mime_unsupported', message: string) { super(message); this.name = 'AttachmentStoreError'; }
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
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
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
  #writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly root: string, private readonly manifestPath: string, private readonly now: () => Date = () => new Date()) {}

  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.manifestPath, 'utf8')) as Partial<Manifest>;
      if (parsed.version !== 1 || !Array.isArray(parsed.attachments)) return;
      for (const raw of parsed.attachments.slice(0, ATTACHMENT_LIMITS_V2.maxGlobalFiles)) {
        const { path, ...metadata } = raw as StoredAttachment;
        const valid = attachmentMetadataV2Schema.safeParse(metadata);
        if (valid.success && typeof path === 'string' && dirname(path) === this.root) this.#records.set(valid.data.id, { ...valid.data, path });
      }
    } catch { /* empty fail-closed store */ }
    await this.cleanupExpired();
  }

  async stage(input: { fileName: string; declaredSize: number; sessionId?: string; stream: AsyncIterable<Uint8Array> }): Promise<AttachmentMetadataV2> {
    if (input.declaredSize > ATTACHMENT_LIMITS_V2.maxFileBytes) throw new AttachmentStoreError('attachment_too_large', 'Attachment exceeds 25 MiB');
    this.assertQuota(input.declaredSize, input.sessionId);
    const id = randomUUID(); const temporary = join(this.root, `.${id}.tmp`); const destination = join(this.root, `${id}.bin`);
    const handle = await open(temporary, 'wx', 0o600); let size = 0; let prefix = Buffer.alloc(0); let committed = false;
    try {
      for await (const value of input.stream) {
        const chunk = Buffer.from(value); size += chunk.length;
        if (size > ATTACHMENT_LIMITS_V2.maxFileBytes || size > input.declaredSize) throw new AttachmentStoreError('attachment_too_large', 'Attachment exceeded its authorized size');
        if (prefix.length < 512) prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)]);
        await handle.write(chunk);
      }
      if (size !== input.declaredSize) throw new AttachmentStoreError('attachment_size_mismatch', 'Attachment size did not match the selected file');
      const mimeType = sniffMime(prefix);
      if (!mimeType) throw new AttachmentStoreError('attachment_mime_unsupported', 'Attachment MIME type is unsupported');
      await handle.sync(); await handle.close(); await rename(temporary, destination); committed = true;
      const metadata: AttachmentMetadataV2 = { id, fileName: safeName(input.fileName), mimeType, size, createdAt: this.now().toISOString(), referenced: !!input.sessionId, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
      this.#records.set(id, { ...metadata, path: destination }); await this.persist(); return structuredClone(metadata);
    } finally { await handle.close().catch(() => undefined); if (!committed) await unlink(temporary).catch(() => undefined); }
  }

  list(): AttachmentMetadataV2[] { return [...this.#records.values()].map(({ path: _path, ...metadata }) => structuredClone(metadata)); }

  async reference(ids: string[], sessionId: string): Promise<AttachmentMetadataV2[]> {
    const records = ids.map((id) => { const record = this.#records.get(id); if (!record) throw new AttachmentStoreError('attachment_not_found', 'Attachment was not found'); if (record.sessionId && record.sessionId !== sessionId) throw new AttachmentStoreError('attachment_not_found', 'Attachment belongs to another session'); return record; });
    const bytes = records.reduce((sum, item) => sum + item.size, 0); if (bytes > ATTACHMENT_LIMITS_V2.maxSessionBytes || records.length > ATTACHMENT_LIMITS_V2.maxSessionFiles) throw new AttachmentStoreError('attachment_quota_exceeded', 'Session attachment quota exceeded');
    for (const record of records) { record.referenced = true; record.sessionId = sessionId; } await this.persist(); return records.map(({ path: _path, ...metadata }) => structuredClone(metadata));
  }

  async cleanupExpired(): Promise<void> {
    const cutoff = this.now().getTime() - ATTACHMENT_LIMITS_V2.unreferencedTtlMs; let changed = false;
    for (const [id, record] of this.#records) if (!record.referenced && Date.parse(record.createdAt) < cutoff) { await unlink(record.path).catch(() => undefined); this.#records.delete(id); changed = true; }
    if (changed) await this.persist();
  }

  private assertQuota(bytes: number, sessionId?: string): void {
    const all = [...this.#records.values()];
    if (all.length >= ATTACHMENT_LIMITS_V2.maxGlobalFiles) throw new AttachmentStoreError('attachment_count_exceeded', 'Global attachment count exceeded');
    if (all.reduce((sum, item) => sum + item.size, 0) + bytes > ATTACHMENT_LIMITS_V2.maxGlobalBytes) throw new AttachmentStoreError('attachment_quota_exceeded', 'Global attachment quota exceeded');
    if (sessionId) { const session = all.filter((item) => item.sessionId === sessionId); if (session.length >= ATTACHMENT_LIMITS_V2.maxSessionFiles || session.reduce((sum, item) => sum + item.size, 0) + bytes > ATTACHMENT_LIMITS_V2.maxSessionBytes) throw new AttachmentStoreError('attachment_quota_exceeded', 'Session attachment quota exceeded'); }
  }

  private persist(): Promise<void> {
    const operation = this.#writeTail.then(async () => { const temporary = `${this.manifestPath}.${randomUUID()}.tmp`; await mkdir(dirname(this.manifestPath), { recursive: true, mode: 0o700 }); await writeFile(temporary, `${JSON.stringify({ version: 1, attachments: [...this.#records.values()] })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); await rename(temporary, this.manifestPath); });
    this.#writeTail = operation.catch(() => undefined); return operation;
  }
}
