import {
  AGENT_DOCK_PROTOCOL_VERSION,
  AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS,
  agentCommandV2Schema,
  agentEventEnvelopeSchema,
  agentEventOrStreamErrorV2Schema,
  agentSessionSchema,
  agentSessionV2Schema,
  cancelSessionV2ResponseSchema,
  commandAcknowledgementV2Schema,
  createSessionRequestSchema,
  createSessionV2RequestSchema,
  healthResponseSchema,
  providerIdSchema,
  providerStatusSchema,
  providerStatusV2Schema,
  providersV2ResponseSchema,
  sessionContinuationInputV2Schema,
  sessionEventHistoryV2PageSchema,
  sessionEventHistoryV2QuerySchema,
  sessionIdParamSchema,
  sessionListV2PageSchema,
  sessionListV2QuerySchema,
  auditReadResponseV2Schema,
  workspaceInspectRequestV2Schema,
  workspaceTrustUpdateRequestV2Schema,
  workspaceTrustViewV2Schema,
  mcpCatalogV2Schema,
  mcpConfigureRequestV2Schema,
  mcpOAuthStartRequestV2Schema,
  mcpOAuthStatusV2Schema,
  mcpServerActionRequestV2Schema,
  mcpServerListV2Schema,
  mcpToolInvocationRequestV2Schema,
  mcpToolInvocationResultV2Schema,
  type AgentEventEnvelope,
  type AgentEventV2Envelope,
  type AgentCommandV2,
  type AgentSession,
  type AgentSessionV2,
  type AuditReadResponseV2,
  type CancelSessionV2Response,
  type CommandAcknowledgementV2,
  type CreateSessionRequest,
  type CreateSessionV2Request,
  type ProviderId,
  type ProviderStatus,
  type ProviderStatusV2,
  type ProvidersV2Response,
  type SessionContinuationInputV2,
  type SessionEventHistoryV2Page,
  type SessionEventHistoryV2Query,
  type SessionListV2Page,
  type SessionListV2Query,
  type WorkspaceTrustUpdateRequestV2,
  type WorkspaceTrustViewV2,
  type McpCatalogV2,
  type McpConfigureRequestV2,
  type McpOAuthStatusV2,
  type McpServerActionRequestV2,
  type McpServerListV2,
  type McpToolInvocationRequestV2,
  type McpToolInvocationResultV2,
  providerComponentInvokeRequestV2Schema,
  providerComponentListRequestV2Schema,
  providerComponentListV2Schema,
  providerComponentManageRequestV2Schema,
  providerComponentOperationResultV2Schema,
  type ProviderComponentInvokeRequestV2,
  type ProviderComponentListRequestV2,
  type ProviderComponentListV2,
  type ProviderComponentManageRequestV2,
  type ProviderComponentOperationResultV2,
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
import { parseSseStream, type RuntimeSchema } from './sse.js';

export interface AgentDockClientOptions {
  /** e.g. `http://127.0.0.1:54321`, no trailing slash required. */
  baseUrl: string;
  token: string;
  /** Injectable for tests; defaults to the ambient global `fetch`. */
  fetch?: typeof fetch;
}

export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
  protocolVersion: number;
  supportedProtocolVersions?: readonly number[];
}

export interface SessionEventsOptions {
  signal?: AbortSignal;
  /** Resume from the SSE `id:` after this value, instead of a full replay from the start. */
  lastEventId?: string;
  /** Claims the sole interaction-responder stream for this session. Observers should omit it. */
  responder?: boolean;
}

export interface SessionRequestOptions {
  signal?: AbortSignal;
}

export interface AuditReadOptions {
  cursor?: string;
  limit?: number;
  sessionId?: string;
}

export type SessionListV2Options = SessionListV2Query;
export type SessionEventHistoryV2Options = SessionEventHistoryV2Query;

interface CompatibilityResult {
  health: HealthResponse;
  daemonVersions: readonly number[];
  selectedProtocolVersion: number;
}

const PROTOCOL_V2 = 2;
const MAX_V2_SSE_FRAME_BYTES = 1024 * 1024;
const RESPONDER_LEASE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_SUPPORTED_PROTOCOL_VERSIONS: readonly number[] =
  AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS;

/**
 * Typed client for the AgentDock daemon's HTTP + SSE APIs. Owns everything a caller shouldn't
 * have to hand-write: the daemon URL, the bearer token, JSON request/response handling,
 * incremental SSE parsing, and protocol-version negotiation performed automatically before the
 * first real request. The top-level namespaces are the frozen v1 API; `v2` uses `/v2` routes.
 * See docs/protocol-v1.md and docs/protocol-v2.md.
 *
 * No reconnect logic: `sessions.events()` opens exactly one stream and ends when the daemon
 * closes it (at the session's terminal event) or `signal` aborts. If the connection drops for any
 * other reason, the generator throws: call `sessions.events()` again to resume; because the
 * daemon replays its full stored event history to a fresh subscriber (or from `lastEventId`
 * onward), a bare retry is a complete, correct "reconnect" with no separate resume protocol needed.
 */
export class AgentDockClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private compatibilityCheck: Promise<CompatibilityResult> | undefined;
  private readonly responderLeases = new Map<string, string>();

  readonly providers = {
    list: (): Promise<ProviderStatus[]> => this.listProviders(),
    get: (id: ProviderId): Promise<ProviderStatus> => this.getProvider(id),
  };

  readonly sessions = {
    create: (input: CreateSessionRequest): Promise<AgentSession> => this.createSession(input),
    get: (id: string): Promise<AgentSession> => this.getSession(id),
    events: (
      id: string,
      options?: SessionEventsOptions,
    ): AsyncGenerator<AgentEventEnvelope, void, void> => this.streamSessionEvents(id, options),
    cancel: (id: string): Promise<void> => this.cancelSession(id),
    delete: (id: string): Promise<void> => this.deleteSession(id),
    /** Cancels every in-flight protocol-v1 session on the daemon. Used by the desktop shutdown path so
     * quitting the app doesn't orphan any session besides the one it happens to be tracking,
     * see electron/main.ts#killDaemon. */
    cancelAll: (options?: SessionRequestOptions): Promise<void> => this.cancelAllSessions(options),
  };

  /** Protocol-v2 routes. The existing top-level namespaces remain protocol v1. */
  readonly v2 = {
    providers: {
      list: (): Promise<ProviderStatusV2[]> => this.listProvidersV2(),
      get: (id: ProviderId): Promise<ProviderStatusV2> => this.getProviderV2(id),
    },
    sessions: {
      create: (
        input: CreateSessionV2Request,
        options?: SessionRequestOptions,
      ): Promise<AgentSessionV2> => this.createSessionV2(input, options),
      list: (options?: SessionListV2Options): Promise<SessionListV2Page> =>
        this.listSessionsV2(options),
      get: (id: string): Promise<AgentSessionV2> => this.getSessionV2(id),
      history: (
        id: string,
        options?: SessionEventHistoryV2Options,
      ): Promise<SessionEventHistoryV2Page> => this.getSessionEventHistoryV2(id, options),
      resume: (
        parentSessionId: string,
        input: SessionContinuationInputV2,
        options?: SessionRequestOptions,
      ): Promise<AgentSessionV2> =>
        this.continueSessionV2(parentSessionId, 'resume', input, options),
      fork: (
        parentSessionId: string,
        input: SessionContinuationInputV2,
        options?: SessionRequestOptions,
      ): Promise<AgentSessionV2> => this.continueSessionV2(parentSessionId, 'fork', input, options),
      events: (
        id: string,
        options?: SessionEventsOptions,
      ): AsyncGenerator<AgentEventV2Envelope, void, void> =>
        this.streamSessionEventsV2(id, options),
      send: (command: AgentCommandV2): Promise<CommandAcknowledgementV2> =>
        this.sendSessionCommandV2(command),
      cancel: (id: string, options?: SessionRequestOptions): Promise<CancelSessionV2Response> =>
        this.cancelSessionV2(id, options),
      delete: (id: string): Promise<void> => this.deleteSessionV2(id),
    },
    workspaces: {
      inspect: (cwd: string): Promise<WorkspaceTrustViewV2> => this.inspectWorkspaceV2(cwd),
      setTrust: (
        workspaceId: string,
        input: WorkspaceTrustUpdateRequestV2,
      ): Promise<WorkspaceTrustViewV2> => this.setWorkspaceTrustV2(workspaceId, input),
    },
    audit: {
      list: (options?: AuditReadOptions): Promise<AuditReadResponseV2> => this.readAuditV2(options),
    },
    integrations: {
      mcp: {
        list: (provider: ProviderId, cwd: string): Promise<McpServerListV2> =>
          this.listMcpServersV2(provider, cwd),
        configure: (input: McpConfigureRequestV2): Promise<McpServerListV2> =>
          this.configureMcpV2(input),
        action: (input: McpServerActionRequestV2): Promise<McpServerListV2> =>
          this.actionMcpV2(input),
        catalog: (provider: ProviderId, serverId: string, cwd: string): Promise<McpCatalogV2> =>
          this.getMcpCatalogV2(provider, serverId, cwd),
        oauth: (provider: ProviderId, serverId: string, cwd: string): Promise<McpOAuthStatusV2> =>
          this.startMcpOAuthV2(provider, serverId, cwd),
        invoke: (input: McpToolInvocationRequestV2): Promise<McpToolInvocationResultV2> =>
          this.invokeMcpToolV2(input),
      },
      components: {
        list: (input: ProviderComponentListRequestV2): Promise<ProviderComponentListV2> =>
          this.listProviderComponentsV2(input),
        manage: (input: ProviderComponentManageRequestV2): Promise<ProviderComponentOperationResultV2> =>
          this.manageProviderComponentV2(input),
        invoke: (input: ProviderComponentInvokeRequestV2): Promise<ProviderComponentOperationResultV2> =>
          this.invokeProviderComponentV2(input),
      },
    },
  };

  constructor(options: AgentDockClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Checks the daemon is reachable and protocol-compatible. Also the check every other method runs before its own request. */
  async health(): Promise<HealthResponse> {
    return (await this.ensureCompatible()).health;
  }

  private ensureCompatible(): Promise<CompatibilityResult> {
    if (!this.compatibilityCheck) {
      this.compatibilityCheck = this.checkCompatibility().catch((err: unknown) => {
        // Don't let a transient failure (daemon still starting up, briefly unreachable) poison
        // every future call: the next one gets a fresh check.
        this.compatibilityCheck = undefined;
        throw err;
      });
    }
    return this.compatibilityCheck;
  }

  private async checkCompatibility(): Promise<CompatibilityResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/health`);
    } catch (err) {
      throw new DaemonUnavailableError(
        `could not reach the daemon at ${this.baseUrl}: ${errorMessage(err)}`,
        {
          cause: err,
        },
      );
    }
    if (!res.ok) {
      throw new DaemonUnavailableError(`daemon health check failed with status ${res.status}`);
    }
    const json = await res.json().catch(() => undefined);
    const parsed = healthResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ValidationError(
        `daemon /health response did not match the expected shape: ${parsed.error.message}`,
      );
    }
    const daemonVersions = parsed.data.supportedProtocolVersions ?? [parsed.data.protocolVersion];
    const sharedVersions = CLIENT_SUPPORTED_PROTOCOL_VERSIONS.filter((version) =>
      daemonVersions.includes(version),
    );
    if (sharedVersions.length === 0) {
      throw new ProtocolMismatchError(
        highestVersion(CLIENT_SUPPORTED_PROTOCOL_VERSIONS),
        highestVersion(daemonVersions),
      );
    }
    return {
      health: parsed.data,
      daemonVersions,
      selectedProtocolVersion: highestVersion(sharedVersions),
    };
  }

  private async ensureProtocolVersion(version: number): Promise<CompatibilityResult> {
    const compatibility = await this.ensureCompatible();
    const available =
      version === AGENT_DOCK_PROTOCOL_VERSION
        ? compatibility.daemonVersions.includes(version)
        : compatibility.selectedProtocolVersion === version;
    if (!available) {
      throw new ProtocolMismatchError(version, highestVersion(compatibility.daemonVersions));
    }
    return compatibility;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    opts: { notFound?: () => AgentDockClientError } = {},
  ): Promise<T> {
    const res = await this.fetchAuthenticated(AGENT_DOCK_PROTOCOL_VERSION, path, init, opts);

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async fetchAuthenticated(
    protocolVersion: number,
    path: string,
    init: RequestInit = {},
    opts: { notFound?: () => AgentDockClientError; notFoundCode?: string } = {},
  ): Promise<Response> {
    await this.ensureProtocolVersion(protocolVersion);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${this.token}` },
      });
    } catch (err) {
      throw new DaemonUnavailableError(
        `could not reach the daemon at ${this.baseUrl}: ${errorMessage(err)}`,
        {
          cause: err,
        },
      );
    }

    if (res.status === 401) throw new UnauthorizedError();

    let body: unknown;
    let bodyRead = false;
    if (res.status === 404 && opts.notFound) {
      if (opts.notFoundCode === undefined) throw opts.notFound();
      body = await res.json().catch(() => undefined);
      bodyRead = true;
      if (daemonErrorCode(body) === opts.notFoundCode) throw opts.notFound();
    }

    if (!res.ok) {
      if (!bodyRead) body = await res.json().catch(() => undefined);
      const message = daemonErrorMessage(body) ?? `daemon request failed with status ${res.status}`;
      if (res.status === 400) throw new ValidationError(message);
      throw new DaemonError(message, res.status, daemonErrorCode(body));
    }
    return res;
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
    await this.ensureProtocolVersion(AGENT_DOCK_PROTOCOL_VERSION);

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
      throw new DaemonUnavailableError(
        `could not reach the daemon at ${this.baseUrl}: ${errorMessage(err)}`,
        {
          cause: err,
        },
      );
    }

    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 404) throw new SessionNotFoundError(id);
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new DaemonError(
        body.error ?? `failed to open event stream (status ${res.status})`,
        res.status,
      );
    }

    yield* parseSseStream(res.body, {
      schema: agentEventEnvelopeSchema,
      label: 'AgentEvent v1',
      signal: options.signal,
    });
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

  private async cancelAllSessions(options: SessionRequestOptions = {}): Promise<void> {
    await this.request<unknown>('/sessions/cancel-all', {
      method: 'POST',
      signal: options.signal,
    });
  }

  private async requestV2<T>(
    path: string,
    schema: RuntimeSchema<T>,
    label: string,
    init: RequestInit = {},
    opts: {
      expectedStatus: number;
      notFound?: () => AgentDockClientError;
      notFoundCode?: string;
    },
  ): Promise<T> {
    const res = await this.fetchAuthenticated(PROTOCOL_V2, path, init, opts);
    if (res.status !== opts.expectedStatus) {
      throw new ValidationError(
        `daemon returned status ${res.status} for ${label}; protocol v2 requires ${opts.expectedStatus}`,
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new ValidationError(
        `daemon returned malformed JSON for ${label}: ${errorMessage(err)}`,
      );
    }
    return validate(schema, json, label);
  }

  private async requestV2NoContent(
    path: string,
    init: RequestInit,
    opts: { notFound?: () => AgentDockClientError } = {},
  ): Promise<void> {
    const res = await this.fetchAuthenticated(PROTOCOL_V2, path, init, opts);
    if (res.status !== 204) {
      throw new ValidationError(
        `daemon returned status ${res.status}; protocol v2 requires 204 with no content`,
      );
    }
  }

  private async listProvidersV2(): Promise<ProviderStatusV2[]> {
    const body: ProvidersV2Response = await this.requestV2(
      '/v2/providers',
      providersV2ResponseSchema,
      'protocol-v2 provider list',
      {},
      { expectedStatus: 200 },
    );
    return body.providers;
  }

  private async getProviderV2(id: ProviderId): Promise<ProviderStatusV2> {
    const providerId = validateInput(providerIdSchema, id, 'protocol-v2 provider id');
    return this.requestV2(
      `/v2/providers/${encodeURIComponent(providerId)}`,
      providerStatusV2Schema,
      'protocol-v2 provider status',
      {},
      {
        expectedStatus: 200,
        notFound: () => new ProviderUnavailableError(`provider not registered: ${providerId}`),
      },
    );
  }

  private async listMcpServersV2(provider: ProviderId, cwd: string): Promise<McpServerListV2> {
    const providerId = validateInput(providerIdSchema, provider, 'MCP provider id');
    if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 32_768) {
      throw new ValidationError('MCP workspace path is invalid');
    }
    const query = new URLSearchParams({ provider: providerId, cwd });
    return this.requestV2(
      `/v2/integrations/mcp?${query.toString()}`,
      mcpServerListV2Schema,
      'protocol-v2 MCP server list',
      {},
      { expectedStatus: 200 },
    );
  }

  private async configureMcpV2(input: McpConfigureRequestV2): Promise<McpServerListV2> {
    const parsed = validateInput(mcpConfigureRequestV2Schema, input, 'MCP configuration request');
    return this.requestV2('/v2/integrations/mcp/configure', mcpServerListV2Schema, 'protocol-v2 MCP server list', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed),
    }, { expectedStatus: 200 });
  }

  private async actionMcpV2(input: McpServerActionRequestV2): Promise<McpServerListV2> {
    const parsed = validateInput(mcpServerActionRequestV2Schema, input, 'MCP server action');
    return this.requestV2('/v2/integrations/mcp/action', mcpServerListV2Schema, 'protocol-v2 MCP server list', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed),
    }, { expectedStatus: 200 });
  }

  private async getMcpCatalogV2(provider: ProviderId, serverId: string, cwd: string): Promise<McpCatalogV2> {
    const providerId = validateInput(providerIdSchema, provider, 'MCP provider id');
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(serverId) || !cwd || cwd.length > 32_768) {
      throw new ValidationError('MCP catalog request is invalid');
    }
    return this.requestV2(`/v2/integrations/mcp/${encodeURIComponent(providerId)}/${encodeURIComponent(serverId)}/catalog?${new URLSearchParams({ cwd }).toString()}`, mcpCatalogV2Schema, 'protocol-v2 MCP catalog', {}, { expectedStatus: 200 });
  }

  private async startMcpOAuthV2(provider: ProviderId, serverId: string, cwd: string): Promise<McpOAuthStatusV2> {
    const parsed = validateInput(mcpOAuthStartRequestV2Schema, { provider, serverId, cwd }, 'MCP OAuth request');
    return this.requestV2('/v2/integrations/mcp/oauth', mcpOAuthStatusV2Schema, 'protocol-v2 MCP OAuth status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed),
    }, { expectedStatus: 200 });
  }

  private async invokeMcpToolV2(input: McpToolInvocationRequestV2): Promise<McpToolInvocationResultV2> {
    const parsed = validateInput(mcpToolInvocationRequestV2Schema, input, 'MCP tool invocation');
    return this.requestV2('/v2/integrations/mcp/invoke', mcpToolInvocationResultV2Schema, 'protocol-v2 MCP tool result', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed),
    }, { expectedStatus: 200 });
  }

  private async listProviderComponentsV2(input: ProviderComponentListRequestV2): Promise<ProviderComponentListV2> {
    const parsed = validateInput(providerComponentListRequestV2Schema, input, 'provider component inspection');
    const query = new URLSearchParams({ provider: parsed.provider, cwd: parsed.cwd });
    if (parsed.kind) query.set('kind', parsed.kind);
    return this.requestV2(`/v2/integrations/components?${query.toString()}`, providerComponentListV2Schema, 'protocol-v2 provider component list', {}, { expectedStatus: 200 });
  }

  private async manageProviderComponentV2(input: ProviderComponentManageRequestV2): Promise<ProviderComponentOperationResultV2> {
    const parsed = validateInput(providerComponentManageRequestV2Schema, input, 'provider component management');
    return this.requestV2('/v2/integrations/components/manage', providerComponentOperationResultV2Schema, 'protocol-v2 provider component result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) }, { expectedStatus: 200 });
  }

  private async invokeProviderComponentV2(input: ProviderComponentInvokeRequestV2): Promise<ProviderComponentOperationResultV2> {
    const parsed = validateInput(providerComponentInvokeRequestV2Schema, input, 'provider component invocation');
    return this.requestV2('/v2/integrations/components/invoke', providerComponentOperationResultV2Schema, 'protocol-v2 provider component result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) }, { expectedStatus: 200 });
  }

  private async createSessionV2(
    input: CreateSessionV2Request,
    options: SessionRequestOptions = {},
  ): Promise<AgentSessionV2> {
    const parsedInput = validateInput(
      createSessionV2RequestSchema,
      input,
      'protocol-v2 session request',
    );
    return this.requestV2(
      '/v2/sessions',
      agentSessionV2Schema,
      'protocol-v2 session',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsedInput),
        signal: options.signal,
      },
      { expectedStatus: 201 },
    );
  }

  private async getSessionV2(id: string): Promise<AgentSessionV2> {
    const sessionId = validateSessionIdV2(id);
    return this.requestV2(
      `/v2/sessions/${encodeURIComponent(sessionId)}`,
      agentSessionV2Schema,
      'protocol-v2 session',
      {},
      { expectedStatus: 200, notFound: () => new SessionNotFoundError(sessionId) },
    );
  }

  private async listSessionsV2(options: SessionListV2Options = {}): Promise<SessionListV2Page> {
    const parsed = validateInput(
      sessionListV2QuerySchema,
      options,
      'protocol-v2 session list query',
    );
    const query = new URLSearchParams();
    if (parsed.cursor !== undefined) query.set('cursor', parsed.cursor);
    if (parsed.limit !== undefined) query.set('limit', String(parsed.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.requestV2(
      `/v2/sessions${suffix}`,
      sessionListV2PageSchema,
      'protocol-v2 session page',
      {},
      { expectedStatus: 200 },
    );
  }

  private async getSessionEventHistoryV2(
    id: string,
    options: SessionEventHistoryV2Options = {},
  ): Promise<SessionEventHistoryV2Page> {
    const sessionId = validateSessionIdV2(id);
    const parsed = validateInput(
      sessionEventHistoryV2QuerySchema,
      options,
      'protocol-v2 session event history query',
    );
    const query = new URLSearchParams();
    if (parsed.cursor !== undefined) query.set('cursor', parsed.cursor);
    if (parsed.limit !== undefined) query.set('limit', String(parsed.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.requestV2(
      `/v2/sessions/${encodeURIComponent(sessionId)}/history${suffix}`,
      sessionEventHistoryV2PageSchema,
      'protocol-v2 session event history page',
      {},
      { expectedStatus: 200, notFound: () => new SessionNotFoundError(sessionId) },
    );
  }

  private async continueSessionV2(
    parentSessionId: string,
    kind: 'resume' | 'fork',
    input: SessionContinuationInputV2,
    options: SessionRequestOptions = {},
  ): Promise<AgentSessionV2> {
    const sessionId = validateSessionIdV2(parentSessionId);
    const parsed = validateInput(
      sessionContinuationInputV2Schema,
      input,
      `protocol-v2 session ${kind} request`,
    );
    return this.requestV2(
      `/v2/sessions/${encodeURIComponent(sessionId)}/${kind}`,
      agentSessionV2Schema,
      'protocol-v2 session',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
        signal: options.signal,
      },
      {
        expectedStatus: 201,
        notFound: () => new SessionNotFoundError(sessionId),
        notFoundCode: 'session_not_found',
      },
    );
  }

  private async *streamSessionEventsV2(
    id: string,
    options: SessionEventsOptions = {},
  ): AsyncGenerator<AgentEventV2Envelope, void, void> {
    const sessionId = validateSessionIdV2(id);
    validateLastEventIdV2(options.lastEventId);
    let previousSequence =
      options.lastEventId === undefined ? undefined : Number(options.lastEventId);
    await this.ensureProtocolVersion(PROTOCOL_V2);

    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (options.lastEventId) headers['Last-Event-ID'] = options.lastEventId;
    if (options.responder) headers['X-AgentDock-Responder'] = '1';

    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.baseUrl}/v2/sessions/${encodeURIComponent(sessionId)}/events`,
        {
          headers,
          signal: options.signal,
        },
      );
    } catch (err) {
      if (options.signal?.aborted) return;
      throw new DaemonUnavailableError(
        `could not reach the daemon at ${this.baseUrl}: ${errorMessage(err)}`,
        {
          cause: err,
        },
      );
    }

    if (res.status === 401) throw new UnauthorizedError();
    if (res.status === 404) throw new SessionNotFoundError(sessionId);
    if (!res.ok) {
      const body = await res.json().catch(() => undefined);
      const message =
        daemonErrorMessage(body) ?? `failed to open event stream (status ${res.status})`;
      if (res.status === 400) throw new ValidationError(message);
      throw new DaemonError(message, res.status);
    }
    if (res.status !== 200) {
      throw new ValidationError(
        `daemon returned status ${res.status} for a protocol-v2 event stream; expected 200`,
      );
    }
    if (!res.body) {
      throw new ValidationError(
        'daemon returned a protocol-v2 event stream without a response body',
      );
    }

    const responderLease = options.responder
      ? res.headers.get('X-AgentDock-Responder-Lease')
      : null;
    if (options.responder && (!responderLease || !RESPONDER_LEASE_PATTERN.test(responderLease))) {
      await res.body.cancel().catch(() => undefined);
      throw new ValidationError('daemon returned an invalid protocol-v2 responder lease');
    }
    if (responderLease) this.responderLeases.set(sessionId, responderLease);

    try {
      for await (const event of parseSseStream(res.body, {
        schema: agentEventOrStreamErrorV2Schema,
        label: 'AgentEvent v2',
        signal: options.signal,
        maxFrameBytes: MAX_V2_SSE_FRAME_BYTES,
        fatalUtf8: true,
        rejectUnterminatedFrame: true,
        validateEvent: (event, frame) => {
          if (event.type === 'stream.error') return;
          if (event.sessionId !== sessionId) {
            throw new ValidationError(
              `received an AgentEvent v2 for session ${event.sessionId} on the ${sessionId} stream`,
            );
          }
          if (frame.id === undefined) {
            throw new ValidationError('received an AgentEvent v2 SSE frame without an id');
          }
          if (frame.id !== String(event.sequence)) {
            throw new ValidationError(
              `received AgentEvent v2 SSE id ${frame.id} for sequence ${event.sequence}`,
            );
          }
          if (previousSequence !== undefined && event.sequence <= previousSequence) {
            throw new ValidationError(
              `received non-monotonic AgentEvent v2 sequence ${event.sequence} after ${previousSequence}`,
            );
          }
          previousSequence = event.sequence;
        },
      })) {
        if (event.type === 'stream.error') {
          const cursor =
            event.lastSequence === undefined ? '' : ` after sequence ${event.lastSequence}`;
          throw new DaemonError(`protocol-v2 event stream overflowed${cursor}`, 429);
        }
        yield event;
      }
    } finally {
      if (responderLease && this.responderLeases.get(sessionId) === responderLease) {
        this.responderLeases.delete(sessionId);
      }
    }
  }

  private async sendSessionCommandV2(command: AgentCommandV2): Promise<CommandAcknowledgementV2> {
    const parsedCommand = validateInput(agentCommandV2Schema, command, 'protocol-v2 agent command');
    const acknowledgement = await this.requestV2(
      `/v2/sessions/${encodeURIComponent(parsedCommand.sessionId)}/commands`,
      commandAcknowledgementV2Schema,
      'protocol-v2 command acknowledgement',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...((parsedCommand.type === 'approval.respond' ||
            parsedCommand.type === 'question.respond') &&
          this.responderLeases.has(parsedCommand.sessionId)
            ? {
                'X-AgentDock-Responder-Lease': this.responderLeases.get(parsedCommand.sessionId)!,
              }
            : {}),
        },
        body: JSON.stringify(parsedCommand),
      },
      {
        expectedStatus: 202,
        notFound: () => new SessionNotFoundError(parsedCommand.sessionId),
      },
    );

    if (
      acknowledgement.commandId !== parsedCommand.commandId ||
      acknowledgement.sessionId !== parsedCommand.sessionId ||
      acknowledgement.turnId !== parsedCommand.turnId
    ) {
      throw new ValidationError(
        'daemon returned a protocol-v2 command acknowledgement that does not match the command',
      );
    }
    return acknowledgement;
  }

  private async cancelSessionV2(
    id: string,
    options: SessionRequestOptions = {},
  ): Promise<CancelSessionV2Response> {
    const sessionId = validateSessionIdV2(id);
    return this.requestV2(
      `/v2/sessions/${encodeURIComponent(sessionId)}/cancel`,
      cancelSessionV2ResponseSchema,
      'protocol-v2 cancellation acknowledgement',
      { method: 'POST', signal: options.signal },
      { expectedStatus: 202, notFound: () => new SessionNotFoundError(sessionId) },
    );
  }

  private async deleteSessionV2(id: string): Promise<void> {
    const sessionId = validateSessionIdV2(id);
    await this.requestV2NoContent(
      `/v2/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
      { notFound: () => new SessionNotFoundError(sessionId) },
    );
  }

  private async inspectWorkspaceV2(cwd: string): Promise<WorkspaceTrustViewV2> {
    const input = validateInput(
      workspaceInspectRequestV2Schema,
      { cwd },
      'protocol-v2 workspace inspection',
    );
    return this.requestV2(
      '/v2/workspaces/inspect',
      workspaceTrustViewV2Schema,
      'protocol-v2 workspace trust view',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
      { expectedStatus: 200 },
    );
  }

  private async setWorkspaceTrustV2(
    workspaceId: string,
    input: WorkspaceTrustUpdateRequestV2,
  ): Promise<WorkspaceTrustViewV2> {
    if (!/^[a-f0-9]{64}$/.test(workspaceId)) {
      throw new ValidationError('invalid protocol-v2 workspace id');
    }
    const parsed = validateInput(
      workspaceTrustUpdateRequestV2Schema,
      input,
      'protocol-v2 workspace trust update',
    );
    return this.requestV2(
      `/v2/workspaces/${workspaceId}/trust`,
      workspaceTrustViewV2Schema,
      'protocol-v2 workspace trust view',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      },
      { expectedStatus: 200 },
    );
  }

  private async readAuditV2(options: AuditReadOptions = {}): Promise<AuditReadResponseV2> {
    if (
      options.limit !== undefined &&
      (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
    ) {
      throw new ValidationError('protocol-v2 audit limit must be between 1 and 100');
    }
    if (options.cursor !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(options.cursor)) {
      throw new ValidationError('invalid protocol-v2 audit cursor');
    }
    if (options.sessionId !== undefined) validateSessionIdV2(options.sessionId);
    const query = new URLSearchParams();
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.sessionId !== undefined) query.set('sessionId', options.sessionId);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.requestV2(
      `/v2/audit${suffix}`,
      auditReadResponseV2Schema,
      'protocol-v2 audit page',
      {},
      { expectedStatus: 200 },
    );
  }
}

function validate<T>(schema: RuntimeSchema<T>, raw: unknown, label: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(
      `daemon returned a ${label} that does not match the protocol: ${result.error.message}`,
    );
  }
  return result.data;
}

function validateInput<T>(schema: RuntimeSchema<T>, raw: unknown, label: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`invalid ${label}: ${result.error.message}`);
  }
  return result.data;
}

function validateSessionIdV2(id: string): string {
  return validateInput(sessionIdParamSchema, { sessionId: id }, 'protocol-v2 session id').sessionId;
}

function validateLastEventIdV2(lastEventId: string | undefined): void {
  if (lastEventId === undefined) return;
  if (
    typeof lastEventId !== 'string' ||
    !/^\d+$/.test(lastEventId) ||
    !Number.isSafeInteger(Number(lastEventId))
  ) {
    throw new ValidationError(
      'invalid protocol-v2 Last-Event-ID: expected a non-negative safe integer',
    );
  }
}

function highestVersion(versions: readonly number[]): number {
  return Math.max(...versions);
}

function daemonErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return undefined;
}

function daemonErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const code = (body as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const nestedCode = (error as { code?: unknown }).code;
  return typeof nestedCode === 'string' ? nestedCode : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
