import { z } from 'zod';
import { PROVIDER_IDS } from './provider.js';

export const providerIdSchema = z.enum(PROVIDER_IDS);

/** Body for POST /sessions. Rejects anything not an absolute-looking, non-empty path/prompt. */
export const createSessionRequestSchema = z.object({
  provider: providerIdSchema,
  cwd: z.string().min(1, 'cwd is required'),
  prompt: z.string().min(1, 'prompt is required').max(200_000, 'prompt is too long'),
});

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const sessionIdParamSchema = z.object({
  sessionId: z.string().uuid(),
});
