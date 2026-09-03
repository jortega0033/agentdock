import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionV2, WorkspaceTrustViewV2 } from '@agent-dock/shared';
import {
  runCancellationCase,
  runContinuationCase,
  runFreshRunCase,
  type LiveSmokeClient,
} from '../../src/live-smoke/run-case.js';

const BASE_CAPABILITIES = {
  required: [{ id: 'session.cancel' }],
  optional: [{ id: 'session.resume' }, { id: 'session.fork' }],
  allowExperimental: false,
};

function fakeSession(id: string, enabledIds: string[]): AgentSessionV2 {
  // Minimal fixture: run-case.ts only ever reads `.id` and `.selection.enabled[].id`.
  return {
    id,
    selection: {
      transport: 'fake',
      enabled: enabledIds.map((capabilityId) => ({ id: capabilityId, constraints: { kind: 'none' } })),
      unavailableOptional: [],
      possibleEffects: [],
      effectsComplete: true,
    },
  } as unknown as AgentSessionV2;
}

function trustedView(): WorkspaceTrustViewV2 {
  return {
    schemaVersion: 1,
    workspaceId: 'a'.repeat(64),
    incarnation: 'b'.repeat(64),
    displayName: 'fixture',
    reusable: true,
    state: 'trusted',
  };
}

async function* iterableFrom(items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item;
}

describe('runFreshRunCase', () => {
  it('trusts an untrusted workspace before creating a session, then reports success', async () => {
    const setTrust = vi.fn().mockResolvedValue(trustedView());
    const client: LiveSmokeClient = {
      workspaces: {
        inspect: vi.fn().mockResolvedValue({ ...trustedView(), state: 'untrusted' }),
        setTrust,
      },
      sessions: {
        create: vi.fn().mockResolvedValue(fakeSession('s1', ['session.cancel'])),
        events: () => iterableFrom([{ type: 'content.delta', delta: 'hi' }, { type: 'session.completed' }]),
        send: vi.fn(),
        cancel: vi.fn(),
        resume: vi.fn(),
        fork: vi.fn(),
      },
    };
    const outcome = await runFreshRunCase(client, {
      provider: 'claude',
      transport: 'claude-legacy-one-shot',
      cwd: '/tmp/fixture',
      prompt: 'hello',
      timeoutMs: 5_000,
      capabilities: BASE_CAPABILITIES,
    });
    expect(setTrust).toHaveBeenCalledOnce();
    expect(outcome.resultCode).toBe('success');
    expect(outcome.capabilitiesTested).toEqual(['session.cancel']);
  });

  it('does not re-trust an already-trusted workspace', async () => {
    const setTrust = vi.fn();
    const client: LiveSmokeClient = {
      workspaces: { inspect: vi.fn().mockResolvedValue(trustedView()), setTrust },
      sessions: {
        create: vi.fn().mockResolvedValue(fakeSession('s1', [])),
        events: () => iterableFrom([{ type: 'session.completed' }]),
        send: vi.fn(),
        cancel: vi.fn(),
        resume: vi.fn(),
        fork: vi.fn(),
      },
    };
    await runFreshRunCase(client, {
      provider: 'claude',
      transport: 'claude-legacy-one-shot',
      cwd: '/tmp/fixture',
      prompt: 'hello',
      timeoutMs: 5_000,
      capabilities: BASE_CAPABILITIES,
    });
    expect(setTrust).not.toHaveBeenCalled();
  });

  it('answers an approval request inline so the turn can keep going', async () => {
    const send = vi.fn().mockResolvedValue({ status: 'accepted' });
    const client: LiveSmokeClient = {
      workspaces: { inspect: vi.fn().mockResolvedValue(trustedView()), setTrust: vi.fn() },
      sessions: {
        create: vi.fn().mockResolvedValue(fakeSession('s1', ['interaction.approval'])),
        events: () =>
          iterableFrom([
            {
              type: 'approval.requested',
              turnId: 't1',
              requestId: 'r1',
              allowedDecisions: ['allow_once', 'deny'],
            },
            { type: 'content.delta', delta: 'ok' },
            { type: 'session.completed' },
          ]),
        send,
        cancel: vi.fn(),
        resume: vi.fn(),
        fork: vi.fn(),
      },
    };
    const outcome = await runFreshRunCase(client, {
      provider: 'claude',
      transport: 'claude-legacy-one-shot',
      cwd: '/tmp/fixture',
      prompt: 'hello',
      timeoutMs: 5_000,
      capabilities: BASE_CAPABILITIES,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({
      type: 'approval.respond',
      requestId: 'r1',
      decision: 'allow_once',
    });
    expect(outcome.resultCode).toBe('success');
  });

  it('reports failure when the terminal event carries no normalized content', async () => {
    const client: LiveSmokeClient = {
      workspaces: { inspect: vi.fn().mockResolvedValue(trustedView()), setTrust: vi.fn() },
      sessions: {
        create: vi.fn().mockResolvedValue(fakeSession('s1', [])),
        events: () => iterableFrom([{ type: 'session.completed' }]),
        send: vi.fn(),
        cancel: vi.fn(),
        resume: vi.fn(),
        fork: vi.fn(),
      },
    };
    const outcome = await runFreshRunCase(client, {
      provider: 'claude',
      transport: 'claude-legacy-one-shot',
      cwd: '/tmp/fixture',
      prompt: 'hello',
      timeoutMs: 5_000,
      capabilities: BASE_CAPABILITIES,
    });
    expect(outcome.resultCode).toBe('failed_protocol_violation');
  });
});

describe('runContinuationCase', () => {
  it('exercises resume only when called, using the client resume operation', async () => {
    const resume = vi.fn().mockResolvedValue(fakeSession('s2', []));
    const client: LiveSmokeClient = {
      workspaces: { inspect: vi.fn(), setTrust: vi.fn() },
      sessions: {
        create: vi.fn(),
        events: () => iterableFrom([{ type: 'content.delta', delta: 'ok' }, { type: 'session.completed' }]),
        send: vi.fn(),
        cancel: vi.fn(),
        resume,
        fork: vi.fn(),
      },
    };
    const outcome = await runContinuationCase(client, 'resume', 's1', {
      provider: 'claude',
      transport: 'claude-legacy-one-shot',
      cwd: '/tmp/fixture',
      prompt: 'continue',
      timeoutMs: 5_000,
      capabilities: BASE_CAPABILITIES,
    });
    expect(resume).toHaveBeenCalledWith('s1', expect.objectContaining({ prompt: 'continue' }));
    expect(outcome.resultCode).toBe('success');
    expect(outcome.capabilitiesTested).toEqual(['session.resume']);
  });

  it('exercises fork using the client fork operation, distinctly from resume', async () => {
    const fork = vi.fn().mockResolvedValue(fakeSession('s3', []));
    const resume = vi.fn();
    const client: LiveSmokeClient = {
      workspaces: { inspect: vi.fn(), setTrust: vi.fn() },
      sessions: {
        create: vi.fn(),
        events: () => iterableFrom([{ type: 'content.delta', delta: 'ok' }, { type: 'session.completed' }]),
        send: vi.fn(),
        cancel: vi.fn(),
        resume,
        fork,
      },
    };
    await runContinuationCase(client, 'fork', 's1', {
      provider: 'codex',
      transport: 'codex-app-server',
      cwd: '/tmp/fixture',
      prompt: 'continue',
      timeoutMs: 5_000,
      capabilities: BASE_CAPABILITIES,
    });
    expect(fork).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
  });
});

describe('runCancellationCase', () => {
  it('reports success only when the terminal type is session.cancelled', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const client: LiveSmokeClient = {
      workspaces: { inspect: vi.fn(), setTrust: vi.fn() },
      sessions: {
        create: vi.fn(),
        events: () => iterableFrom([{ type: 'session.cancelled' }]),
        send: vi.fn(),
        cancel,
        resume: vi.fn(),
        fork: vi.fn(),
      },
    };
    const outcome = await runCancellationCase(client, fakeSession('s1', []), 5_000);
    expect(cancel).toHaveBeenCalledWith('s1');
    expect(outcome.resultCode).toBe('success');
  });

  it('treats completing normally instead of cancelling as a protocol violation for this case', async () => {
    const client: LiveSmokeClient = {
      workspaces: { inspect: vi.fn(), setTrust: vi.fn() },
      sessions: {
        create: vi.fn(),
        events: () => iterableFrom([{ type: 'session.completed' }]),
        send: vi.fn(),
        cancel: vi.fn().mockResolvedValue(undefined),
        resume: vi.fn(),
        fork: vi.fn(),
      },
    };
    const outcome = await runCancellationCase(client, fakeSession('s1', []), 5_000);
    expect(outcome.resultCode).toBe('failed_protocol_violation');
  });
});
