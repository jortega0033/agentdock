import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ownedWorktreeListV2Schema,
  ownedWorktreeV2Schema,
  sessionIdParamSchema,
  subagentControlRequestV2Schema,
  subagentControlResultV2Schema,
  subagentGraphV2Schema,
  worktreeCleanupRequestV2Schema,
  worktreeCreateRequestV2Schema,
  worktreePreviewRequestV2Schema,
  worktreePreviewV2Schema,
} from '@agent-dock/shared';
import type { SubagentGraphStore } from '../subagent-graph-store.js';
import { OwnedWorktreeManager, WorktreeManagerError } from '../worktree-manager.js';

function fail(reply: FastifyReply, status: number, code: string, error: string): void { reply.code(status).send({ code, error }); }

export function registerV2AgentWorktreeRoutes(app: FastifyInstance, subagents?: SubagentGraphStore, worktrees?: OwnedWorktreeManager): void {
  if (subagents) {
    app.get('/v2/sessions/:sessionId/agents', async (req, reply) => {
      const parsed = sessionIdParamSchema.safeParse(req.params);
      if (!parsed.success) return fail(reply, 400, 'invalid_session_id', 'Invalid session id');
      reply.send(subagentGraphV2Schema.parse(subagents.graph(parsed.data.sessionId)));
    });
    app.post('/v2/sessions/:sessionId/agents/control', async (req, reply) => {
      const params = sessionIdParamSchema.safeParse(req.params);
      const parsed = subagentControlRequestV2Schema.safeParse(req.body);
      if (!params.success || !parsed.success || params.data.sessionId !== parsed.data.sessionId) return fail(reply, 400, 'invalid_subagent_request', 'Invalid subagent control request');
      const status = await subagents.control(parsed.data);
      reply.send(subagentControlResultV2Schema.parse({ sessionId: parsed.data.sessionId, agentId: parsed.data.agentId, status, ...(status === 'unsupported' ? { safeSummary: 'Provider does not advertise this child-agent control' } : {}) }));
    });
  }
  if (worktrees) {
    app.post('/v2/worktrees/preview', async (req, reply) => {
      const parsed = worktreePreviewRequestV2Schema.safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_worktree_request', 'Invalid worktree preview request');
      try { reply.send(worktreePreviewV2Schema.parse(await worktrees.preview(parsed.data))); } catch (error) { worktreeFailure(reply, error); }
    });
    app.post('/v2/worktrees', async (req, reply) => {
      const parsed = worktreeCreateRequestV2Schema.safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_worktree_request', 'Explicit include-copy confirmation is required');
      try { reply.code(201).send(ownedWorktreeV2Schema.parse(await worktrees.create(parsed.data))); } catch (error) { worktreeFailure(reply, error); }
    });
    app.get('/v2/worktrees', async (_req, reply) => reply.send(ownedWorktreeListV2Schema.parse({ worktrees: await worktrees.list() })));
    app.post('/v2/worktrees/cleanup', async (req, reply) => {
      const parsed = worktreeCleanupRequestV2Schema.safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_worktree_request', 'Invalid worktree cleanup request');
      try { reply.send(ownedWorktreeV2Schema.parse(await worktrees.cleanup(parsed.data.worktreeId))); } catch (error) { worktreeFailure(reply, error); }
    });
  }
}

function worktreeFailure(reply: FastifyReply, error: unknown): void {
  if (error instanceof WorktreeManagerError) return fail(reply, error.code === 'worktree_not_found' ? 404 : 409, error.code, error.message);
  fail(reply, 500, 'worktree_operation_failed', 'Worktree operation failed');
}
