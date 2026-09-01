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
    await app.close();
  });
});
