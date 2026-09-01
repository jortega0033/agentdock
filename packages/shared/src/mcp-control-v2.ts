import { z } from 'zod';
import { providerIdSchema } from './schemas.js';

const boundedIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
const boundedNameSchema = z.string().min(1).max(256);
const safeSummarySchema = z.string().max(1_024);

export const mcpTransportV2Schema = z.enum([
  'stdio',
  'streamable_http',
  'legacy_sse_read_only',
]);
export type McpTransportV2 = z.infer<typeof mcpTransportV2Schema>;

export const mcpOwnershipV2Schema = z.enum(['provider', 'project', 'managed', 'unknown']);
export const mcpConnectionStatusV2Schema = z.enum([
  'disabled',
  'disconnected',
  'connecting',
  'ready',
  'failed',
  'unknown',
]);
export const mcpAuthStatusV2Schema = z.enum([
  'not_required',
  'authenticated',
  'unauthenticated',
  'unsupported',
  'unknown',
]);

export const mcpConfigFieldV2Schema = z
  .object({
    key: boundedNameSchema,
    classification: z.enum(['public', 'secret', 'unknown']),
    present: z.boolean(),
    source: z.enum(['provider', 'project', 'managed', 'unknown']),
    value: z.union([z.string().max(4_096), z.array(z.string().max(1_024)).max(128)]).optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.value !== undefined && field.classification !== 'public') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'only public fields may expose values' });
    }
    if (field.value !== undefined && field.key !== 'command' && field.key !== 'args') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'only fixture-backed command and args fields may expose values',
      });
    }
  });

export const mcpCatalogCountsV2Schema = z
  .object({ tools: z.number().int().min(0).max(100_000), resources: z.number().int().min(0).max(100_000), prompts: z.number().int().min(0).max(100_000) })
  .strict();

export const mcpServerDescriptorV2Schema = z
  .object({
    id: boundedIdSchema,
    provider: providerIdSchema,
    name: boundedNameSchema,
    ownership: mcpOwnershipV2Schema,
    scope: z.enum(['local', 'user', 'project', 'managed', 'unknown']),
    transport: mcpTransportV2Schema,
    enabled: z.boolean(),
    required: z.boolean(),
    connectionStatus: mcpConnectionStatusV2Schema,
    authStatus: mcpAuthStatusV2Schema,
    catalog: mcpCatalogCountsV2Schema,
    capabilities: z
      .object({
        connect: z.boolean(),
        reload: z.boolean(),
        configure: z.boolean(),
        oauth: z.boolean(),
        tools: z.boolean(),
        resources: z.boolean(),
        prompts: z.boolean(),
      })
      .strict(),
    configFields: z.array(mcpConfigFieldV2Schema).max(128),
    startupFailure: z
      .object({ code: boundedIdSchema, summary: safeSummarySchema })
      .strict()
      .optional(),
    sessionIds: z.array(z.string().uuid()).max(1_000),
  })
  .strict();
export type McpServerDescriptorV2 = z.infer<typeof mcpServerDescriptorV2Schema>;

export const mcpServerListV2Schema = z.object({ servers: z.array(mcpServerDescriptorV2Schema).max(2_000), revision: z.string().min(1).max(128) }).strict();
export type McpServerListV2 = z.infer<typeof mcpServerListV2Schema>;

export const mcpListRequestV2Schema = z.object({ provider: providerIdSchema, cwd: z.string().min(1).max(32_768) }).strict();
export type McpListRequestV2 = z.infer<typeof mcpListRequestV2Schema>;

const catalogBase = z.object({
  id: boundedIdSchema,
  name: boundedNameSchema,
  description: z.string().max(4_096).optional(),
});
export const mcpCatalogItemV2Schema = z.discriminatedUnion('kind', [
  catalogBase.extend({ kind: z.literal('tool'), destructive: z.boolean(), sideEffecting: z.boolean(), inputSchema: z.record(z.unknown()).optional() }).strict(),
  catalogBase.extend({ kind: z.literal('resource'), uri: z.string().max(4_096) }).strict(),
  catalogBase.extend({ kind: z.literal('prompt'), argumentNames: z.array(boundedNameSchema).max(128) }).strict(),
]);
export const mcpCatalogV2Schema = z.object({ serverId: boundedIdSchema, items: z.array(mcpCatalogItemV2Schema).max(10_000), revision: z.string().min(1).max(128) }).strict();
export type McpCatalogV2 = z.infer<typeof mcpCatalogV2Schema>;
export const mcpCatalogRequestV2Schema = z.object({ provider: providerIdSchema, cwd: z.string().min(1).max(32_768), serverId: boundedIdSchema }).strict();
export type McpCatalogRequestV2 = z.infer<typeof mcpCatalogRequestV2Schema>;

const publicStdioConfigSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1).max(4_096),
  args: z.array(z.string().max(1_024)).max(128).default([]),
}).strict();
const publicHttpConfigSchema = z.object({
  transport: z.literal('streamable_http'),
  url: z.string().url().max(4_096).refine((value) => new URL(value).protocol === 'https:', 'HTTPS is required'),
}).strict();
export const mcpPublicServerConfigV2Schema = z.discriminatedUnion('transport', [publicStdioConfigSchema, publicHttpConfigSchema]);

const configureBase = { provider: providerIdSchema, cwd: z.string().min(1).max(32_768) } as const;
export const mcpConfigureRequestV2Schema = z.discriminatedUnion('action', [
  z.object({ ...configureBase, action: z.literal('add'), name: boundedNameSchema, scope: z.enum(['local', 'user', 'project']), config: mcpPublicServerConfigV2Schema }).strict(),
  z.object({ ...configureBase, action: z.literal('edit'), serverId: boundedIdSchema, name: boundedNameSchema.optional(), config: mcpPublicServerConfigV2Schema }).strict(),
  z.object({ ...configureBase, action: z.enum(['enable', 'disable', 'remove']), serverId: boundedIdSchema }).strict(),
]);
export type McpConfigureRequestV2 = z.infer<typeof mcpConfigureRequestV2Schema>;

export const mcpServerActionRequestV2Schema = z.object({ provider: providerIdSchema, cwd: z.string().min(1).max(32_768), serverId: boundedIdSchema, action: z.enum(['connect', 'disconnect', 'reload']) }).strict();
export type McpServerActionRequestV2 = z.infer<typeof mcpServerActionRequestV2Schema>;

export const mcpOAuthStartRequestV2Schema = z.object({ provider: providerIdSchema, cwd: z.string().min(1).max(32_768), serverId: boundedIdSchema }).strict();
export const mcpOAuthStatusV2Schema = z.object({ serverId: boundedIdSchema, status: z.enum(['pending', 'authenticated', 'failed', 'unsupported']), authorizationUrl: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'HTTPS is required').optional(), safeSummary: safeSummarySchema.optional() }).strict();
export type McpOAuthStatusV2 = z.infer<typeof mcpOAuthStatusV2Schema>;

export const mcpToolInvocationRequestV2Schema = z.object({
  provider: providerIdSchema,
  cwd: z.string().min(1).max(32_768),
  serverId: boundedIdSchema,
  toolId: boundedIdSchema,
  arguments: z.record(z.unknown()),
  approval: z.object({ decision: z.enum(['approve_once', 'deny']), requestId: z.string().uuid() }).strict().optional(),
}).strict();
export type McpToolInvocationRequestV2 = z.infer<typeof mcpToolInvocationRequestV2Schema>;

export const mcpToolInvocationResultV2Schema = z.object({ serverId: boundedIdSchema, toolId: boundedIdSchema, status: z.enum(['completed', 'denied', 'approval_required', 'failed']), output: z.unknown().optional(), safeSummary: safeSummarySchema.optional(), approvalRequestId: z.string().uuid().optional() }).strict();
export type McpToolInvocationResultV2 = z.infer<typeof mcpToolInvocationResultV2Schema>;
