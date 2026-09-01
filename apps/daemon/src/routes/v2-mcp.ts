import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  mcpCatalogV2Schema,
  mcpConfigureRequestV2Schema,
  mcpOAuthStartRequestV2Schema,
  mcpOAuthStatusV2Schema,
  mcpServerActionRequestV2Schema,
  mcpServerListV2Schema,
  mcpToolInvocationRequestV2Schema,
  mcpToolInvocationResultV2Schema,
  providerIdSchema,
  type McpToolInvocationRequestV2,
  type ProviderId,
} from '@agent-dock/shared';
import {
  ProviderControlError,
  type McpControlContext,
  type ProviderMcpControlPlane,
  type ProviderRegistry,
} from '@agent-dock/agent-runtime';
import type { WorkspaceTrustStore } from '../workspace-trust-store.js';
import { resolveWorkspaceIdentity } from '../workspace-identity.js';

const querySchema = z.object({ provider: providerIdSchema, cwd: z.string().min(1).max(32_768) }).strict();
const catalogQuerySchema = z.object({ cwd: z.string().min(1).max(32_768) }).strict();
const serverParamsSchema = z.object({ providerId: providerIdSchema, serverId: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/) }).strict();
const APPROVAL_TTL_MS = 5 * 60_000;

interface PendingApproval {
  provider: ProviderId;
  serverId: string;
  toolId: string;
  invocationHash: string;
  expiresAt: number;
}

function invocationHash(input: McpToolInvocationRequestV2, canonicalCwd: string): string {
  return createHash('sha256')
    .update(JSON.stringify([input.provider, input.serverId, input.toolId, canonicalCwd, input.arguments]))
    .digest('hex');
}

function fail(reply: FastifyReply, status: number, code: string, message: string): void {
  reply.code(status).send({ error: message, code });
}

function providerFailure(reply: FastifyReply, error: unknown): void {
  if (error instanceof ProviderControlError) {
    const status = error.code === 'mcp_server_not_found' ? 404 : error.code === 'workspace_untrusted' ? 403 : error.code === 'operation_unsupported' ? 409 : 502;
    fail(reply, status, error.code, error.message);
    return;
  }
  fail(reply, 502, 'provider_control_failed', 'Provider MCP control operation failed');
}

async function controlContext(cwd: string, trustStore: WorkspaceTrustStore): Promise<McpControlContext> {
  const identity = await resolveWorkspaceIdentity(cwd);
  const trust = await trustStore.inspect(identity);
  return {
    cwd: identity.canonicalPath,
    workspaceTrust: trust.state === 'trusted'
      ? { state: 'trusted', workspaceId: identity.workspaceId, incarnation: identity.incarnation, trustEpoch: 0 }
      : { state: 'untrusted' },
  };
}

async function resolveControl(
  registry: ProviderRegistry,
  providerId: ProviderId,
  context: McpControlContext,
): Promise<{ control: ProviderMcpControlPlane; context: McpControlContext } | undefined> {
  const provider = registry.get(providerId);
  if (!provider?.mcp) return undefined;
  const status = await provider.detect({ cwd: context.cwd, workspaceTrust: context.workspaceTrust });
  return { control: provider.mcp, context: { ...context, executablePath: status.executablePath } };
}

async function requireKnownServer(control: ProviderMcpControlPlane, serverId: string, context: McpControlContext): Promise<void> {
  const list = await control.list(context);
  if (!list.servers.some((server) => server.id === serverId)) {
    throw new ProviderControlError('mcp_server_not_found', 'MCP server was not found');
  }
}

export function registerV2McpRoutes(
  app: FastifyInstance,
  registry: ProviderRegistry,
  trustStore: WorkspaceTrustStore,
): void {
  const approvals = new Map<string, PendingApproval>();

  app.get('/v2/integrations/mcp', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return fail(reply, 400, 'invalid_mcp_request', 'Invalid MCP list request');
    try {
      const initial = await controlContext(parsed.data.cwd, trustStore);
      const resolved = await resolveControl(registry, parsed.data.provider, initial);
      if (!resolved) return fail(reply, 409, 'operation_unsupported', 'Provider does not expose MCP controls');
      reply.send(mcpServerListV2Schema.parse(await resolved.control.list(resolved.context)));
    } catch (error) {
      providerFailure(reply, error);
    }
  });

  app.post('/v2/integrations/mcp/configure', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = mcpConfigureRequestV2Schema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_mcp_request', 'Invalid MCP configuration request');
    try {
      const initial = await controlContext(parsed.data.cwd, trustStore);
      if (initial.workspaceTrust.state !== 'trusted') return fail(reply, 403, 'workspace_untrusted', 'MCP configuration changes require a trusted workspace');
      const resolved = await resolveControl(registry, parsed.data.provider, initial);
      if (!resolved) return fail(reply, 409, 'operation_unsupported', 'Provider does not expose MCP controls');
      if (parsed.data.action !== 'add') await requireKnownServer(resolved.control, parsed.data.serverId, resolved.context);
      reply.send(mcpServerListV2Schema.parse(await resolved.control.configure(parsed.data, resolved.context)));
    } catch (error) {
      providerFailure(reply, error);
    }
  });

  app.post('/v2/integrations/mcp/action', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = mcpServerActionRequestV2Schema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_mcp_request', 'Invalid MCP server action');
    try {
      const initial = await controlContext(parsed.data.cwd, trustStore);
      if (initial.workspaceTrust.state !== 'trusted') return fail(reply, 403, 'workspace_untrusted', 'MCP server actions require a trusted workspace');
      const resolved = await resolveControl(registry, parsed.data.provider, initial);
      if (!resolved) return fail(reply, 409, 'operation_unsupported', 'Provider does not expose MCP controls');
      await requireKnownServer(resolved.control, parsed.data.serverId, resolved.context);
      reply.send(mcpServerListV2Schema.parse(await resolved.control.act(parsed.data, resolved.context)));
    } catch (error) {
      providerFailure(reply, error);
    }
  });

  app.get('/v2/integrations/mcp/:providerId/:serverId/catalog', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const params = serverParamsSchema.safeParse(req.params);
    const query = catalogQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return fail(reply, 400, 'invalid_mcp_request', 'Invalid MCP catalog request');
    try {
      const initial = await controlContext(query.data.cwd, trustStore);
      const resolved = await resolveControl(registry, params.data.providerId, initial);
      if (!resolved) return fail(reply, 409, 'operation_unsupported', 'Provider does not expose MCP controls');
      await requireKnownServer(resolved.control, params.data.serverId, resolved.context);
      reply.send(mcpCatalogV2Schema.parse(await resolved.control.catalog(params.data.serverId, resolved.context)));
    } catch (error) {
      providerFailure(reply, error);
    }
  });

  app.post('/v2/integrations/mcp/oauth', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = mcpOAuthStartRequestV2Schema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_mcp_request', 'Invalid MCP OAuth request');
    try {
      const initial = await controlContext(parsed.data.cwd, trustStore);
      if (initial.workspaceTrust.state !== 'trusted') return fail(reply, 403, 'workspace_untrusted', 'MCP OAuth requires a trusted workspace');
      const resolved = await resolveControl(registry, parsed.data.provider, initial);
      if (!resolved) return fail(reply, 409, 'operation_unsupported', 'Provider does not expose MCP controls');
      await requireKnownServer(resolved.control, parsed.data.serverId, resolved.context);
      reply.send(mcpOAuthStatusV2Schema.parse(await resolved.control.startOAuth(parsed.data.serverId, resolved.context)));
    } catch (error) {
      providerFailure(reply, error);
    }
  });

  app.post('/v2/integrations/mcp/invoke', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = mcpToolInvocationRequestV2Schema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_mcp_request', 'Invalid MCP tool request');
    try {
      const input: McpToolInvocationRequestV2 = parsed.data;
      const initial = await controlContext(input.cwd, trustStore);
      if (initial.workspaceTrust.state !== 'trusted') return fail(reply, 403, 'workspace_untrusted', 'MCP tool invocation requires a trusted workspace');
      const resolved = await resolveControl(registry, input.provider, initial);
      if (!resolved) return fail(reply, 409, 'operation_unsupported', 'Provider does not expose MCP controls');
      await requireKnownServer(resolved.control, input.serverId, resolved.context);
      const catalog = await resolved.control.catalog(input.serverId, resolved.context);
      const tool = catalog.items.find((item) => item.kind === 'tool' && item.id === input.toolId);
      if (!tool || tool.kind !== 'tool') return fail(reply, 404, 'mcp_tool_not_found', 'MCP tool was not found in the current catalog');

      if (tool.sideEffecting || tool.destructive) {
        const now = Date.now();
        for (const [requestId, approval] of approvals)
          if (approval.expiresAt < now) approvals.delete(requestId);
        const hash = invocationHash(input, resolved.context.cwd);
        if (!input.approval) {
          if (approvals.size >= 1_000)
            return fail(reply, 429, 'approval_capacity_exceeded', 'Too many MCP approvals are pending');
          const approvalRequestId = randomUUID();
          approvals.set(approvalRequestId, { provider: input.provider, serverId: input.serverId, toolId: input.toolId, invocationHash: hash, expiresAt: now + APPROVAL_TTL_MS });
          return reply.send(mcpToolInvocationResultV2Schema.parse({ serverId: input.serverId, toolId: input.toolId, status: 'approval_required', approvalRequestId }));
        }
        const pending = approvals.get(input.approval.requestId);
        approvals.delete(input.approval.requestId);
        if (!pending || pending.expiresAt < now || pending.provider !== input.provider || pending.serverId !== input.serverId || pending.toolId !== input.toolId || pending.invocationHash !== hash) {
          return fail(reply, 409, 'approval_invalid', 'MCP tool approval is invalid or expired');
        }
        if (input.approval.decision === 'deny') {
          return reply.send(mcpToolInvocationResultV2Schema.parse({ serverId: input.serverId, toolId: input.toolId, status: 'denied' }));
        }
      }
      reply.send(mcpToolInvocationResultV2Schema.parse(await resolved.control.invoke(input, resolved.context)));
    } catch (error) {
      providerFailure(reply, error);
    }
  });
}
