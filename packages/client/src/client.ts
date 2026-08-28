import {
  AGENT_DOCK_PROTOCOL_VERSION,
  agentSessionSchema,
  createSessionRequestSchema,
  healthResponseSchema,
  providerStatusSchema,
  type AgentEventEnvelope,
  type AgentSession,
  type CreateSessionRequest,
  type ProviderId,
  type ProviderStatus,
} from '@agent-dock/shared';
import {
  DaemonError,
  DaemonUnavailableError,
  ProtocolMismatchError,
  ProviderUnavailableError,
  SessionNotFoundError,
  UnauthorizedError,
  ValidationError,
  type AgentDockClientError,
} from './errors.js';
import { parseSseStream } from './sse.js';

export interface AgentDockClientOptions {
  /** e.g. `http://127.0.0.1:54321` — no trailing slash required. */
  baseUrl: string;
  token: string;
  /** Injectable for tests; defaults to the ambient global `fetch`. */
  fetch?: typeof fetch;
}

export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
  protocolVersion: number;
}

export interface SessionEventsOptions {
  signal?: AbortSignal;
  /** Resume from the SSE `id:` after this value, instead of a full replay from the start. */
  lastEventId?: string;
}

/**
 * Typed client for the AgentDock daemon's HTTP + SSE API. Owns everything a caller shouldn't
 * have to hand-write: the daemon URL, the bearer token, JSON request/response handling,
 * incremental SSE parsing, and a protocol-version compatibility check performed automatically
 * before the first real request. See docs/protocol-v1.md.
 *
 * No reconnect logic: `sessions.events()` opens exactly one stream and ends when the daemon
 * closes it (at the session's terminal event) or `signal` aborts. If the connection drops for any
 * other reason, the generator throws — call `sessions.events()` again to resume; because the
 * daemon replays its full stored event history to a fresh subscriber (or from `lastEventId`
 * onward), a bare retry is a complete, correct "reconnect" with no separate resume protocol needed.
 */
export class AgentDockClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private compatibilityCheck: Promise<HealthResponse> | undefined;

  readonly providers = {
    list: (): Promise<ProviderStatus[]> => this.listProviders(),
    get: (id: ProviderId): Promise<ProviderStatus> => this.getProvider(id),
  };

  readonly sessions = {
    create: (input: CreateSessionRequest): Promise<AgentSession> => this.createSession(input),
    get: (id: string): Promise<AgentSession> => this.getSession(id),
    events: (id: string, options?: SessionEventsOptions): AsyncGenerator<AgentEventEnvelope, void, void> =>
      this.streamSessionEvents(id, options),
    cancel: (id: string): Promise<void> => this.cancelSession(id),
    delete: (id: string): Promise<void> => this.deleteSession(id),
  };

  constructor(options: AgentDockClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Checks the daemon is reachable and protocol-compatible. Also the check every other method runs before its own request. */
  health(): Promise<HealthResponse> {
    return this.ensureCompatible();
  }

  private ensureCompatible(): Promise<HealthResponse> {
    if (!this.compatibilityCheck) {
      this.compatibilityCheck = this.checkCompatibility().catch((err: unknown) => {
        // Don't let a transient failure (daemon still starting up, briefly unreachable) poison
        // every future call — the next one gets a fresh check.
        this.compatibilityCheck = undefined;
        throw err;
      });
    }
    return this.compatibilityCheck;
  }

  private async checkCompatibility(): Promise<HealthResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/health`);
    } catch (err) {
      throw new DaemonUnavailableError(`could not reach the daemon at ${this.baseUrl}: ${errorMessage(err)}`, {
        cause: err,
      });
    }
    if (!res.ok) {
      throw new DaemonUnavailableError(`daemon health check failed with status ${res.status}`);
    }
    const json = await res.json().catch(() => undefined);
    const parsed = healthResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ValidationError(`daemon /health response did not match the expected shape: ${parsed.error.message}`);
    }
    if (parsed.data.protocolVersion !== AGENT_DOCK_PROTOCOL_VERSION) {
      throw new ProtocolMismatchError(AGENT_DOCK_PROTOCOL_VERSION, parsed.data.protocolVersion);
    }
    return parsed.data;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    opts: { notFound?: () => AgentDockClientError } = {},
  ): Promise<T> {
    await this.ensureCompatible();

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${this.token}` },
      });
    } catch (err) {
      throw new DaemonUnavailableError(`could not reach the daemon at ${this.baseUrl}: ${errorMessage(err)}`, {
        cause: err,
      });
    }

    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 404 && opts.notFound) throw opts.notFound();

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const message = body.error ?? `daemon request failed with status ${res.status}`;
      if (res.status === 400) throw new ValidationError(message);
      throw new DaemonError(message, res.status);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async listProviders(): Promise<ProviderStatus[]> {
    const body = await this.request<{ providers: unknown[] }>('/providers');
    return body.providers.map((raw) => validate(providerStatusSchema, raw, 'provider status'));
  }

  private async getProvider(id: ProviderId): Promise<ProviderStatus> {
    const raw = await this.request<unknown>(`/providers/${encodeURIComponent(id)}`, undefined, {
      notFound: () => new ProviderUnavailableError(`provider not registered: ${id}`),
    });
    return validate(providerStatusSchema, raw, 'provider status');
  }

  private async createSession(input: CreateSessionRequest): Promise<AgentSession> {
    createSessionRequestSchema.parse(input); // fail fast client-side before ever making the request
    const raw = await this.request<unknown>('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return validate(agentSessionSchema, raw, 'session');
  }

  private async getSession(id: string): Promise<AgentSession> {
    const raw = await this.request<unknown>(`/sessions/${encodeURIComponent(id)}`, undefined, {
      notFound: () => new SessionNotFoundError(id),
    });
    return validate(agentSessionSchema, raw, 'session');
  }

  private async *streamSessionEvents(
    id: string,
    options: SessionEventsOptions = {},
  ): AsyncGenerator<AgentEventEnvelope, void, void> {
    await this.ensureCompatible();

    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (options.lastEventId) headers['Last-Event-ID'] = options.lastEventId;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/sessions/${encodeURIComponent(id)}/events`, {
        headers,
        signal: options.signal,
      });
    } catch (err) {
      if (options.signal?.aborted) return; // caller cancelled before/while connecting; not an error
      throw new DaemonUnavailableError(`could not reach the daemon at ${this.baseUrl}: ${errorMessage(err)}`, {
        cause: err,
      });
    }

    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 404) throw new SessionNotFoundError(id);
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new DaemonError(body.error ?? `failed to open event stream (status ${res.status})`, res.status);
    }

    yield* parseSseStream(res.body, options.signal);
  }

  private async cancelSession(id: string): Promise<void> {
    await this.request<unknown>(
      `/sessions/${encodeURIComponent(id)}/cancel`,
      { method: 'POST' },
      { notFound: () => new SessionNotFoundError(id) },
    );
  }

  private async deleteSession(id: string): Promise<void> {
    await this.request<void>(
      `/sessions/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      { notFound: () => new SessionNotFoundError(id) },
    );
  }
}

function validate<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { message: string } } }, raw: unknown, label: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`daemon returned a ${label} that does not match the protocol: ${result.error?.message}`);
  }
  return result.data as T;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
