import type { ProviderId } from './provider.js';

export type SessionStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * One agent execution. `id` is a daemon-generated UUID and is the only identifier clients should
 * key off of — it is never a process id. `providerSessionId` is whatever session/thread id the
 * underlying CLI reports (if any); pass it back as `resumeProviderSessionId` in a new
 * `POST /sessions` request to continue that thread, for providers whose `capabilities.resume` is
 * true (see docs/providers.md#provider-capabilities).
 *
 * Sessions live behind the daemon's SessionStore (in-memory by default — see
 * docs/architecture.md#sessionstore) and do not survive a daemon restart.
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
