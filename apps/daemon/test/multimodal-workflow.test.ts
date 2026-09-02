import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS_V2 } from '@agent-dock/shared';
import { AttachmentStore, AttachmentStoreError } from '../src/attachment-store.js';
import { validateStructuredOutput } from '../src/structured-output.js';
import { FakeProvider, ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';

async function* chunks(...values: Buffer[]) {
  for (const value of values) yield value;
}

describe('private attachment staging', () => {
  it('sniffs MIME, normalizes names, persists safe metadata only, and never changes the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-dock-attachments-'));
    const staged = join(root, 'staged');
    const manifest = join(root, 'manifest.json');
    const source = join(root, 'source.png');
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('fixture'),
    ]);
    await writeFile(source, bytes);
    const store = new AttachmentStore(staged, manifest);
    await store.load();
    const result = await store.stage({
      fileName: '../unsafe\u0000.png',
      declaredSize: bytes.length,
      stream: chunks(bytes.subarray(0, 5), bytes.subarray(5)),
    });
    expect(result).toMatchObject({
      fileName: 'unsafe.png',
      mimeType: 'image/png',
      size: bytes.length,
      referenced: false,
    });
    expect(await readFile(source)).toEqual(bytes);
    const manifestText = await readFile(manifest, 'utf8');
    expect(manifestText).not.toContain('fixture');
    expect(manifestText).not.toContain(source);
  });

  it('rejects over-limit authorization before consuming bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-dock-attachments-limit-'));
    const store = new AttachmentStore(join(root, 'staged'), join(root, 'manifest.json'));
    await store.load();
    let consumed = false;
    async function* stream() {
      consumed = true;
      yield Buffer.from('x');
    }
    await expect(
      store.stage({
        fileName: 'large.txt',
        declaredSize: ATTACHMENT_LIMITS_V2.maxFileBytes + 1,
        stream: stream(),
      }),
    ).rejects.toMatchObject({
      code: 'attachment_too_large',
    } satisfies Partial<AttachmentStoreError>);
    expect(consumed).toBe(false);
  });

  it('reserves quota before concurrent staging so the global file limit cannot race', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-dock-attachments-race-'));
    const store = new AttachmentStore(join(root, 'staged'), join(root, 'manifest.json'), undefined, {
      ...ATTACHMENT_LIMITS_V2,
      maxGlobalFiles: 1,
    });
    await store.load();
    const uploads = Array.from({ length: 2 }, (_, index) =>
      store.stage({ fileName: `${index}.txt`, declaredSize: 1, stream: chunks(Buffer.from('x')) }),
    );
    const results = await Promise.allSettled(uploads);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
  });

  it('enforces cumulative session limits across reference calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-dock-attachments-session-'));
    const store = new AttachmentStore(join(root, 'staged'), join(root, 'manifest.json'));
    await store.load();
    const attachments = [];
    for (let index = 0; index <= ATTACHMENT_LIMITS_V2.maxSessionFiles; index += 1)
      attachments.push(
        await store.stage({
          fileName: `${index}.txt`,
          declaredSize: 1,
          stream: chunks(Buffer.from('x')),
        }),
      );
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    await store.reference(
      attachments.slice(0, ATTACHMENT_LIMITS_V2.maxSessionFiles).map((item) => item.id),
      sessionId,
    );
    await expect(store.reference([attachments.at(-1)!.id], sessionId)).rejects.toMatchObject({
      code: 'attachment_quota_exceeded',
    } satisfies Partial<AttachmentStoreError>);
  });

  it('referenceForDispatch resolves the real staged path -- unlike reference(), which never exposes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-dock-attachments-dispatch-'));
    const staged = join(root, 'staged');
    const store = new AttachmentStore(staged, join(root, 'manifest.json'));
    await store.load();
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('fixture'),
    ]);
    const attachment = await store.stage({
      fileName: 'image.png',
      declaredSize: bytes.length,
      stream: chunks(bytes),
    });
    const sessionId = '123e4567-e89b-42d3-a456-426614174001';
    const [record] = await store.referenceForDispatch([attachment.id], sessionId);
    expect(record!.path.startsWith(staged)).toBe(true);
    expect(record!.mimeType).toBe('image/png');

    const otherSessionId = '123e4567-e89b-42d3-a456-426614174002';
    await expect(store.referenceForDispatch([attachment.id], otherSessionId)).rejects.toMatchObject({
      code: 'attachment_not_found',
    } satisfies Partial<AttachmentStoreError>);

    await expect(
      store.referenceForDispatch(['00000000-0000-4000-8000-000000000000'], sessionId),
    ).rejects.toMatchObject({ code: 'attachment_not_found' } satisfies Partial<AttachmentStoreError>);
  });

  it('deleteAttachments immediately removes referenced files, recovering quota without waiting for the TTL sweep', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-dock-attachments-delete-'));
    const store = new AttachmentStore(join(root, 'staged'), join(root, 'manifest.json'));
    await store.load();
    const bytes = Buffer.from('x');
    const attachment = await store.stage({
      fileName: 'file.txt',
      declaredSize: bytes.length,
      stream: chunks(bytes),
    });
    const sessionId = '123e4567-e89b-42d3-a456-426614174003';
    await store.reference([attachment.id], sessionId);
    expect(store.list()).toHaveLength(1);

    await store.deleteAttachments([attachment.id]);
    expect(store.list()).toHaveLength(0);

    // Deleting an already-gone or unknown id is not an error -- release calls are idempotent.
    await expect(store.deleteAttachments([attachment.id])).resolves.toBeUndefined();
  });
});

describe('structured output validation', () => {
  it('distinguishes schema-valid output and returns inspectable bounded errors', () => {
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string', minLength: 3 } },
      required: ['answer'],
      additionalProperties: false,
    };
    expect(validateStructuredOutput(schema, { answer: 'yes' })).toMatchObject({
      valid: true,
      errors: [],
    });
    const invalid = validateStructuredOutput(schema, { answer: 42, extra: true });
    expect(invalid).toMatchObject({ valid: false });
    expect(invalid.errors).toEqual(
      expect.arrayContaining([
        { path: '$/answer', message: expect.any(String) },
        { path: '$/extra', message: expect.any(String) },
      ]),
    );
    expect(validateStructuredOutput(schema, { answer: 'no' })).toMatchObject({
      valid: false,
      errors: [{ path: '$/answer' }],
    });
    expect(validateStructuredOutput({ type: 'not-a-json-type' }, {})).toMatchObject({
      valid: false,
      errors: [{ path: '$' }],
    });
  });
});

describe('multimodal daemon routes', () => {
  it('accepts authenticated binary uploads without paths and validates structured output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-dock-multimodal-route-'));
    const store = new AttachmentStore(join(root, 'staged'), join(root, 'manifest.json'));
    await store.load();
    const registry = new ProviderRegistry();
    registry.register(new FakeProvider('claude'));
    const app = buildServer({
      registry,
      sessionManager: new SessionManager(registry, noopLogger),
      token: 'token',
      logger: noopLogger,
      attachmentStore: store,
    });
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('fixture'),
    ]);
    const upload = await app.inject({
      method: 'POST',
      url: '/v2/attachments',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        'x-agentdock-filename': encodeURIComponent('../image.png'),
      },
      payload: bytes,
    });
    expect(upload.statusCode, upload.body).toBe(201);
    expect(upload.json()).toMatchObject({ fileName: 'image.png', mimeType: 'image/png' });
    expect(upload.body).not.toContain(root);
    const validation = await app.inject({
      method: 'POST',
      url: '/v2/workflows/structured/validate',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      payload: {
        schema: {
          type: 'object',
          required: ['answer'],
          properties: { answer: { type: 'string' } },
        },
        output: { answer: 1 },
      },
    });
    expect(validation.statusCode, validation.body).toBe(200);
    expect(validation.json()).toMatchObject({ valid: false, errors: [{ path: '$/answer' }] });

    const attachmentId = upload.json().id as string;
    const deletion = await app.inject({
      method: 'DELETE',
      url: `/v2/attachments/${attachmentId}`,
      headers: { authorization: 'Bearer token' },
    });
    expect(deletion.statusCode, deletion.body).toBe(204);
    expect(store.list()).toHaveLength(0);
    // Deleting again (or an id that never existed) is still a clean no-op, not an error.
    const redeletion = await app.inject({
      method: 'DELETE',
      url: `/v2/attachments/${attachmentId}`,
      headers: { authorization: 'Bearer token' },
    });
    expect(redeletion.statusCode, redeletion.body).toBe(204);
    await app.close();
  });
});
