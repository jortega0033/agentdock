import { z } from 'zod';
import { boundedJsonSchema } from './capabilities-v2.js';

export const ATTACHMENT_LIMITS_V2 = Object.freeze({ maxFileBytes: 25 * 1024 * 1024, maxSessionBytes: 100 * 1024 * 1024, maxSessionFiles: 20, maxGlobalBytes: 500 * 1024 * 1024, maxGlobalFiles: 200, unreferencedTtlMs: 24 * 60 * 60 * 1_000 });
export const attachmentIdV2Schema = z.string().uuid();
export const attachmentMetadataV2Schema = z.object({ id: attachmentIdV2Schema, fileName: z.string().min(1).max(255), mimeType: z.string().min(1).max(255), size: z.number().int().min(0).max(ATTACHMENT_LIMITS_V2.maxFileBytes), createdAt: z.string().datetime(), referenced: z.boolean(), sessionId: z.string().uuid().optional() }).strict();
export type AttachmentMetadataV2 = z.infer<typeof attachmentMetadataV2Schema>;
export const attachmentListV2Schema = z.object({ attachments: z.array(attachmentMetadataV2Schema).max(ATTACHMENT_LIMITS_V2.maxGlobalFiles) }).strict();
export const attachmentReferenceRequestV2Schema = z.object({ attachmentIds: z.array(attachmentIdV2Schema).min(1).max(ATTACHMENT_LIMITS_V2.maxSessionFiles), sessionId: z.string().uuid() }).strict();
export const attachmentUploadHeadersV2Schema = z.object({ fileName: z.string().min(1).max(255), declaredSize: z.number().int().min(0).max(ATTACHMENT_LIMITS_V2.maxFileBytes), sessionId: z.string().uuid().optional() }).strict();

export const structuredWorkflowRequestV2Schema = z.object({ schema: boundedJsonSchema, output: z.unknown() }).strict();
export type StructuredWorkflowRequestV2 = z.infer<typeof structuredWorkflowRequestV2Schema>;
export const structuredWorkflowResultV2Schema = z.object({ valid: z.boolean(), normalizedOutput: z.unknown(), errors: z.array(z.object({ path: z.string().max(1_024), message: z.string().max(1_024) }).strict()).max(1_024) }).strict();
export type StructuredWorkflowResultV2 = z.infer<typeof structuredWorkflowResultV2Schema>;
