import { describe, expect, it } from 'vitest';
import { createSessionRequestSchema, providerIdSchema, sessionIdParamSchema } from '../src/schemas.js';

describe('providerIdSchema', () => {
  it('accepts known provider ids', () => {
    expect(providerIdSchema.parse('claude')).toBe('claude');
    expect(providerIdSchema.parse('codex')).toBe('codex');
  });

  it('rejects unknown provider ids', () => {
    expect(providerIdSchema.safeParse('gemini').success).toBe(false);
  });
});

describe('createSessionRequestSchema', () => {
  it('accepts a valid request', () => {
    const result = createSessionRequestSchema.safeParse({ provider: 'claude', cwd: '/tmp', prompt: 'hi' });
    expect(result.success).toBe(true);
  });

  it('rejects a missing prompt', () => {
    const result = createSessionRequestSchema.safeParse({ provider: 'claude', cwd: '/tmp', prompt: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing cwd', () => {
    const result = createSessionRequestSchema.safeParse({ provider: 'claude', prompt: 'hi' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown provider', () => {
    const result = createSessionRequestSchema.safeParse({ provider: 'gpt', cwd: '/tmp', prompt: 'hi' });
    expect(result.success).toBe(false);
  });
});

describe('sessionIdParamSchema', () => {
  it('accepts a valid uuid', () => {
    expect(sessionIdParamSchema.safeParse({ sessionId: '123e4567-e89b-12d3-a456-426614174000' }).success).toBe(true);
  });

  it('rejects a non-uuid string', () => {
    expect(sessionIdParamSchema.safeParse({ sessionId: 'not-a-uuid' }).success).toBe(false);
  });
});
