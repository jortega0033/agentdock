import type { AgentEvent, AgentSession, CreateSessionRequest, ProviderStatus } from '@agent-dock/shared';

/**
 * HTTP + SSE client for the daemon, used only from Electron's main process — never from the
 * renderer. Main-process fetch is plain Node networking (undici), not subject to the browser's
 * CORS/same-origin rules the renderer's fetch would be, which is exactly why this lives here
 * instead of in the renderer: see docs/security.md#renderer-never-talks-to-the-daemon-directly.
 */
export interface DaemonConnection {
  baseUrl: string;
  token: string;
}

export class DaemonRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'DaemonRequestError';
  }
}

async function request<T>(conn: DaemonConnection, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${conn.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${conn.token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new DaemonRequestError(body.error ?? `request failed with status ${res.status}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function listProviders(conn: DaemonConnection): Promise<ProviderStatus[]> {
  const { providers } = await request<{ providers: ProviderStatus[] }>(conn, '/providers');
  return providers;
}

export function createSession(conn: DaemonConnection, body: CreateSessionRequest): Promise<AgentSession> {
  return request(conn, '/sessions', { method: 'POST', body: JSON.stringify(body) });
}

export function cancelSession(conn: DaemonConnection, sessionId: string): Promise<{ status: string }> {
  return request(conn, `/sessions/${sessionId}/cancel`, { method: 'POST' });
}

export async function streamSessionEvents(
  conn: DaemonConnection,
  sessionId: string,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${conn.baseUrl}/sessions/${sessionId}/events`, {
    headers: { Authorization: `Bearer ${conn.token}` },
    signal,
  });
  if (!res.ok || !res.body) {
    throw new DaemonRequestError(`failed to open event stream (status ${res.status})`, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex: number;
    while ((separatorIndex = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const dataLine = rawEvent.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) continue;
      try {
        onEvent(JSON.parse(dataLine.slice('data: '.length)) as AgentEvent);
      } catch {
        // malformed SSE frame; skip rather than crash the stream reader
      }
    }
  }
}
