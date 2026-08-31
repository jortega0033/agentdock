import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  workspaceInspectRequestV2Schema,
  workspaceTrustUpdateRequestV2Schema,
  workspaceTrustViewV2Schema,
} from '@agent-dock/shared';
import type { SessionManager } from '../session-manager.js';
import type { WorkspaceTrustStore } from '../workspace-trust-store.js';
import { resolveWorkspaceIdentity, type WorkspaceIdentity } from '../workspace-identity.js';

const workspaceIdParamPattern = /^[a-f0-9]{64}$/;

function invalidWorkspace(reply: FastifyReply, message = 'invalid workspace'): void {
  reply.code(400).send({ error: message, code: 'invalid_workspace' });
}

export function registerV2WorkspaceRoutes(
  app: FastifyInstance,
  trustStore: WorkspaceTrustStore,
  sessionManager: SessionManager,
): void {
  app.post(
    '/v2/workspaces/inspect',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = workspaceInspectRequestV2Schema.safeParse(req.body);
      if (!parsed.success) {
        invalidWorkspace(reply);
        return;
      }
      try {
        const identity = await resolveWorkspaceIdentity(parsed.data.cwd);
        reply.send(workspaceTrustViewV2Schema.parse(await trustStore.inspect(identity)));
      } catch {
        invalidWorkspace(reply, 'workspace could not be resolved');
      }
    },
  );

  app.put(
    '/v2/workspaces/:workspaceId/trust',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const workspaceId = (req.params as { workspaceId?: unknown }).workspaceId;
      if (typeof workspaceId !== 'string' || !workspaceIdParamPattern.test(workspaceId)) {
        invalidWorkspace(reply, 'invalid workspace id');
        return;
      }
      const parsed = workspaceTrustUpdateRequestV2Schema.safeParse(req.body);
      if (!parsed.success) {
        invalidWorkspace(reply);
        return;
      }

      let identity: WorkspaceIdentity;
      try {
        identity = await resolveWorkspaceIdentity(parsed.data.cwd);
      } catch {
        invalidWorkspace(reply, 'workspace could not be resolved');
        return;
      }
      if (
        identity.workspaceId !== workspaceId ||
        identity.incarnation !== parsed.data.incarnation
      ) {
        reply.code(409).send({
          error: 'workspace identity changed',
          code: 'workspace_identity_changed',
        });
        return;
      }

      if (parsed.data.state === 'trusted') {
        if (!identity.reusable) {
          reply.code(409).send({
            error: 'workspace identity cannot be persistently trusted',
            code: 'workspace_identity_unstable',
          });
          return;
        }
        await trustStore.setTrusted(identity);
        sessionManager.allowWorkspace(identity.workspaceId);
      } else {
        // The in-memory gate closes synchronously before persistence or any other awaited work.
        sessionManager.blockWorkspace(identity.workspaceId);
        // A transient failure writing the intermediate marker must never skip active-session
        // cancellation. Always attempt the final durable untrusted state after cancellation.
        await trustStore.beginRevocation(identity).catch(() => undefined);
        try {
          await sessionManager.revokeWorkspace(identity.workspaceId);
        } finally {
          await trustStore.finishRevocation(identity);
        }
      }
      reply.send(workspaceTrustViewV2Schema.parse(await trustStore.inspect(identity)));
    },
  );
}
