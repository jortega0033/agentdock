import { randomUUID } from 'node:crypto';
import type {
  AgentCommandV2,
  AgentSessionV2,
  CapabilityRequest,
  CommandAcknowledgementV2,
  CreateSessionV2Request,
  ProviderId,
  SessionContinuationInputV2,
  WorkspaceTrustUpdateRequestV2,
  WorkspaceTrustViewV2,
} from '@agent-dock/shared';
import { consumeSmokeStream } from './stream.js';
import type { LiveSmokeResultCode, LiveSmokeTransportId } from './types.js';

/** The narrow slice of `AgentDockClient.v2` this harness actually uses -- real callers pass
 * `client.v2` (from `@agent-dock/client`) directly; tests inject a fake satisfying this shape. */
export interface LiveSmokeClient {
  workspaces: {
    inspect(cwd: string): Promise<WorkspaceTrustViewV2>;
    setTrust(
      workspaceId: string,
      input: WorkspaceTrustUpdateRequestV2,
    ): Promise<WorkspaceTrustViewV2>;
  };
  sessions: {
    create(input: CreateSessionV2Request): Promise<AgentSessionV2>;
    events(id: string, options?: { responder?: boolean }): AsyncIterable<unknown>;
    send(command: AgentCommandV2): Promise<CommandAcknowledgementV2>;
    cancel(id: string): Promise<unknown>;
    resume(parentSessionId: string, input: SessionContinuationInputV2): Promise<AgentSessionV2>;
    fork(parentSessionId: string, input: SessionContinuationInputV2): Promise<AgentSessionV2>;
  };
}

export interface LiveSmokeCaseInput {
  provider: ProviderId;
  transport: LiveSmokeTransportId;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  capabilities: CapabilityRequest;
}

export interface LiveSmokeCaseOutcome {
  resultCode: LiveSmokeResultCode;
  capabilitiesTested: string[];
  reason?: string;
}

async function trustWorkspace(
  client: LiveSmokeClient,
  cwd: string,
): Promise<WorkspaceTrustViewV2> {
  const current = await client.workspaces.inspect(cwd);
  if (current.state === 'trusted') return current;
  return client.workspaces.setTrust(current.workspaceId, {
    cwd,
    incarnation: current.incarnation,
    state: 'trusted',
  });
}

/** Best-effort: answers an in-flight approval/question so a real agentic turn that needs one
 * mid-run can still reach a terminal event, instead of hanging until the smoke timeout. Never
 * throws -- a failed response just means the session may end up denied/timed out on its own,
 * which is still a real, valid completion for this harness to observe and report. */
async function respondToInteractionIfAny(
  client: LiveSmokeClient,
  sessionId: string,
  event: unknown,
): Promise<void> {
  if (!event || typeof event !== 'object') return;
  const envelope = event as Record<string, unknown>;
  const type = envelope.type;
  const turnId = envelope.turnId;
  if (typeof turnId !== 'string') return;
  try {
    if (type === 'approval.requested' && typeof envelope.requestId === 'string') {
      const allowed = Array.isArray(envelope.allowedDecisions)
        ? (envelope.allowedDecisions as string[])
        : ['allow_once'];
      const decision = allowed.includes('allow_once') ? 'allow_once' : allowed[0];
      await client.sessions.send({
        commandId: randomUUID(),
        sessionId,
        type: 'approval.respond',
        turnId,
        requestId: envelope.requestId,
        decision,
      } as AgentCommandV2);
    } else if (type === 'question.requested' && typeof envelope.requestId === 'string') {
      const questions = Array.isArray(envelope.questions) ? envelope.questions : [];
      const answers = questions.slice(0, 3).map((question: unknown) => {
        const q = question as Record<string, unknown>;
        const options = Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : [];
        const value =
          options.length > 0 && typeof options[0]?.id === 'string'
            ? (options[0].id as string)
            : 'acknowledged';
        return { questionId: q.id, value };
      });
      await client.sessions.send({
        commandId: randomUUID(),
        sessionId,
        type: 'question.respond',
        turnId,
        requestId: envelope.requestId,
        answers,
      } as AgentCommandV2);
    }
  } catch (error) {
    // Best-effort only, see doc comment above -- but a silently swallowed error here could just
    // as easily be a real bug in this function's own command-building as a legitimate provider
    // rejection, so it's still worth surfacing rather than hiding entirely.
    console.warn(`live-provider-smoke: failed to answer an in-flight interaction request: ${String(error)}`);
  }
}

/**
 * Drives exactly one real Protocol v2 session for one transport to a terminal completion, per
 * issue #65: real workspace trust, real dispatch, normalized content, exactly one terminal event.
 * Approval/question requests encountered along the way are answered best-effort so the turn can
 * finish; resume/fork/cancellation are separate, explicit follow-up cases (see run-case tests) run
 * only when the fresh session actually negotiated that capability, never assumed.
 */
export async function runFreshRunCase(
  client: LiveSmokeClient,
  input: LiveSmokeCaseInput,
): Promise<LiveSmokeCaseOutcome & { session?: AgentSessionV2 }> {
  await trustWorkspace(client, input.cwd);
  const session = await client.sessions.create({
    provider: input.provider,
    cwd: input.cwd,
    prompt: input.prompt,
    capabilities: input.capabilities,
  });
  const capabilitiesTested = session.selection.enabled.map((entry) => entry.id);
  const outcome = await consumeSmokeStream(client.sessions.events(session.id), {
    timeoutMs: input.timeoutMs,
    onEvent: (event) => respondToInteractionIfAny(client, session.id, event),
  });
  if (outcome.outcome === 'timeout') {
    return { resultCode: 'failed_timeout', capabilitiesTested, session };
  }
  if (outcome.outcome === 'protocol_violation') {
    return {
      resultCode: 'failed_protocol_violation',
      capabilitiesTested,
      reason: outcome.reason,
      session,
    };
  }
  if (!outcome.hasContent) {
    return {
      resultCode: 'failed_protocol_violation',
      capabilitiesTested,
      reason: 'session reached a terminal event with no normalized content',
      session,
    };
  }
  return { resultCode: 'success', capabilitiesTested, session };
}

/** Only runs if `session.cancel` was negotiated for the fresh session -- it always should be, but
 * this harness never assumes a capability it didn't see the daemon actually select. */
export async function runCancellationCase(
  client: LiveSmokeClient,
  freshSession: AgentSessionV2,
  timeoutMs: number,
): Promise<LiveSmokeCaseOutcome> {
  const events = client.sessions.events(freshSession.id);
  const cancelSoon = client.sessions.cancel(freshSession.id).catch(() => {});
  const outcome = await consumeSmokeStream(events, { timeoutMs });
  await cancelSoon;
  if (outcome.outcome !== 'success') {
    return {
      resultCode: outcome.outcome === 'timeout' ? 'failed_timeout' : 'failed_protocol_violation',
      capabilitiesTested: ['session.cancel'],
      reason: outcome.outcome === 'protocol_violation' ? outcome.reason : undefined,
    };
  }
  if (outcome.terminalType !== 'session.cancelled') {
    return {
      resultCode: 'failed_protocol_violation',
      capabilitiesTested: ['session.cancel'],
      reason: `expected session.cancelled after cancel, got ${outcome.terminalType}`,
    };
  }
  return { resultCode: 'success', capabilitiesTested: ['session.cancel'] };
}

/** Only runs when `session.resume`/`session.fork` was negotiated (present in the fresh session's
 * `selection.enabled`) -- issue #65: "resume/fork only where negotiated". */
export async function runContinuationCase(
  client: LiveSmokeClient,
  kind: 'resume' | 'fork',
  parentSessionId: string,
  input: LiveSmokeCaseInput,
): Promise<LiveSmokeCaseOutcome> {
  const operation = kind === 'resume' ? client.sessions.resume : client.sessions.fork;
  const session = await operation(parentSessionId, {
    prompt: input.prompt,
    capabilities: input.capabilities,
  });
  const outcome = await consumeSmokeStream(client.sessions.events(session.id), {
    timeoutMs: input.timeoutMs,
    onEvent: (event) => respondToInteractionIfAny(client, session.id, event),
  });
  const capabilitiesTested = [`session.${kind}`];
  if (outcome.outcome !== 'success') {
    return {
      resultCode: outcome.outcome === 'timeout' ? 'failed_timeout' : 'failed_protocol_violation',
      capabilitiesTested,
      reason: outcome.outcome === 'protocol_violation' ? outcome.reason : undefined,
    };
  }
  return { resultCode: 'success', capabilitiesTested };
}
