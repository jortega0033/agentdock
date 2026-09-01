import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  providerComponentInvokeRequestV2Schema,
  providerComponentListRequestV2Schema,
  providerComponentListV2Schema,
  providerComponentManageRequestV2Schema,
  providerComponentOperationResultV2Schema,
} from '@agent-dock/shared';
import { ProviderControlError, type McpControlContext, type ProviderRegistry } from '@agent-dock/agent-runtime';
import type { WorkspaceTrustStore } from '../workspace-trust-store.js';
import { resolveWorkspaceIdentity } from '../workspace-identity.js';

function fail(reply: FastifyReply, status: number, code: string, error: string): void {
  reply.code(status).send({ code, error });
}

async function contextFor(cwd: string, trustStore: WorkspaceTrustStore): Promise<McpControlContext> {
  const identity = await resolveWorkspaceIdentity(cwd);
  const trust = await trustStore.inspect(identity);
  return { cwd: identity.canonicalPath, workspaceTrust: trust.state === 'trusted' ? { state: 'trusted', workspaceId: identity.workspaceId, incarnation: identity.incarnation, trustEpoch: 0 } : { state: 'untrusted' } };
}

export function registerV2ComponentRoutes(app: FastifyInstance, registry: ProviderRegistry, trustStore: WorkspaceTrustStore): void {
  app.get('/v2/integrations/components', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = providerComponentListRequestV2Schema.safeParse(req.query);
    if (!parsed.success) return fail(reply, 400, 'invalid_component_request', 'Invalid component inspection request');
    try {
      const provider = registry.get(parsed.data.provider);
      if (!provider?.components) return fail(reply, 409, 'operation_unsupported', 'Provider component inspection is unsupported');
      const context = await contextFor(parsed.data.cwd, trustStore);
      reply.send(providerComponentListV2Schema.parse(await provider.components.list(parsed.data, context)));
    } catch {
      fail(reply, 502, 'provider_control_failed', 'Provider component inspection failed');
    }
  });

  app.post('/v2/integrations/components/manage', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = providerComponentManageRequestV2Schema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_component_request', 'Invalid component management request');
    try {
      const provider = registry.get(parsed.data.provider);
      if (!provider?.components) return fail(reply, 409, 'operation_unsupported', 'Provider component management is unsupported');
      const context = await contextFor(parsed.data.cwd, trustStore);
      const current = await provider.components.list({ provider: parsed.data.provider, cwd: context.cwd }, context);
      const item = current.items.find((candidate) => candidate.id === parsed.data.componentId);
      if (!item) return fail(reply, 404, 'component_not_found', 'Provider component was not found');
      if (!item.supportsManage) return reply.send(providerComponentOperationResultV2Schema.parse({ componentId: item.id, status: 'unsupported', safeSummary: 'Provider does not advertise explicit management for this component' }));
      reply.send(providerComponentOperationResultV2Schema.parse(await provider.components.manage(parsed.data, context)));
    } catch {
      fail(reply, 502, 'provider_control_failed', 'Provider component management failed');
    }
  });

  app.post('/v2/integrations/components/invoke', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = providerComponentInvokeRequestV2Schema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_component_request', 'Invalid component invocation request');
    try {
      const provider = registry.get(parsed.data.provider);
      if (!provider?.components) return fail(reply, 409, 'operation_unsupported', 'Provider component invocation is unsupported');
      const context = await contextFor(parsed.data.cwd, trustStore);
      if (context.workspaceTrust.state !== 'trusted') return fail(reply, 403, 'workspace_untrusted', 'Workspace trust is required before component execution');
      const current = await provider.components.list({ provider: parsed.data.provider, cwd: context.cwd }, context);
      const item = current.items.find((candidate) => candidate.id === parsed.data.componentId);
      if (!item) return fail(reply, 404, 'component_not_found', 'Provider component was not found');
      if (!item.supportsDirectInvoke) return reply.send(providerComponentOperationResultV2Schema.parse({ componentId: item.id, status: 'unsupported', safeSummary: 'Manifest does not advertise direct invocation' }));
      reply.send(providerComponentOperationResultV2Schema.parse(await provider.components.invoke(parsed.data, context)));
    } catch (error) {
      if (error instanceof ProviderControlError) return fail(reply, 409, error.code, error.message);
      fail(reply, 502, 'provider_control_failed', 'Provider component invocation failed');
    }
  });
}
