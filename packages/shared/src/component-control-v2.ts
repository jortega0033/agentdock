import { z } from 'zod';
import { providerIdSchema } from './schemas.js';

const componentIdSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9._:/-]+$/);
export const providerComponentKindV2Schema = z.enum(['skill', 'plugin', 'hook', 'command', 'agent']);
export type ProviderComponentKindV2 = z.infer<typeof providerComponentKindV2Schema>;
export const providerComponentDescriptorV2Schema = z.object({
  id: componentIdSchema,
  provider: providerIdSchema,
  kind: providerComponentKindV2Schema,
  name: z.string().min(1).max(256),
  description: z.string().max(4_096).optional(),
  scope: z.enum(['project', 'user', 'managed', 'marketplace', 'built_in', 'unknown']),
  source: z.enum(['filesystem', 'provider_api', 'managed_policy', 'marketplace', 'built_in', 'unknown']),
  displayPath: z.string().max(1_024).optional(),
  packageName: z.string().max(256).optional(),
  enabled: z.boolean(),
  trusted: z.boolean(),
  dependencies: z.array(z.string().max(256)).max(256),
  capabilities: z.array(z.string().max(256)).max(256),
  supportsDirectInvoke: z.boolean(),
  supportsManage: z.boolean(),
  loadError: z.object({ code: componentIdSchema, summary: z.string().max(1_024) }).strict().optional(),
  manifestPreview: z.object({ hooks: z.number().int().min(0).max(10_000), mcpServers: z.number().int().min(0).max(10_000), executables: z.number().int().min(0).max(10_000), environmentVariables: z.number().int().min(0).max(10_000), skills: z.number().int().min(0).max(10_000), agents: z.number().int().min(0).max(10_000) }).strict(),
}).strict();
export type ProviderComponentDescriptorV2 = z.infer<typeof providerComponentDescriptorV2Schema>;

export const providerComponentListRequestV2Schema = z.object({ provider: providerIdSchema, cwd: z.string().min(1).max(32_768), kind: providerComponentKindV2Schema.optional() }).strict();
export type ProviderComponentListRequestV2 = z.infer<typeof providerComponentListRequestV2Schema>;
export const providerComponentListV2Schema = z.object({ items: z.array(providerComponentDescriptorV2Schema).max(20_000), revision: z.string().min(1).max(128) }).strict();
export type ProviderComponentListV2 = z.infer<typeof providerComponentListV2Schema>;

export const providerComponentManageRequestV2Schema = z.object({ provider: providerIdSchema, cwd: z.string().min(1).max(32_768), componentId: componentIdSchema, action: z.enum(['enable', 'disable']) }).strict();
export type ProviderComponentManageRequestV2 = z.infer<typeof providerComponentManageRequestV2Schema>;
export const providerComponentInvokeRequestV2Schema = z.object({ provider: providerIdSchema, cwd: z.string().min(1).max(32_768), componentId: componentIdSchema, prompt: z.string().max(200_000).optional() }).strict();
export type ProviderComponentInvokeRequestV2 = z.infer<typeof providerComponentInvokeRequestV2Schema>;
export const providerComponentOperationResultV2Schema = z.object({ componentId: componentIdSchema, status: z.enum(['completed', 'disabled', 'enabled', 'unsupported', 'blocked']), safeSummary: z.string().max(1_024).optional() }).strict();
export type ProviderComponentOperationResultV2 = z.infer<typeof providerComponentOperationResultV2Schema>;

export const hookActivityV2Schema = z.object({ provider: providerIdSchema, sessionId: z.string().uuid(), hookId: componentIdSchema, lifecycle: z.string().min(1).max(128), status: z.enum(['started', 'completed', 'failed', 'blocked']), timestamp: z.string().datetime(), safeSummary: z.string().max(1_024).optional() }).strict();
export type HookActivityV2 = z.infer<typeof hookActivityV2Schema>;
