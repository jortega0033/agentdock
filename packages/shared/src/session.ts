import type { ProviderId } from './provider.js';

export type SessionStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * One agent execution. `id` is a daemon-generated UUID and is the only identifier clients should
 * key off of — it is never a process id. `providerSessionId` is whatever session/thread id the
 * underlying CLI reports (if any) and exists only for future resume support.
 *
 * Sessions live in the daemon's in-memory registry and do not survive a daemon restart.
 */
export interface AgentSession {
  id: string;
  provider: ProviderId;
  cwd: string;
  prompt: string;
  status: SessionStatus;
  providerSessionId?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}
