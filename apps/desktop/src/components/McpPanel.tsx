import { useCallback, useEffect, useState } from 'react';
import type { McpCatalogV2, McpServerDescriptorV2, McpTransportV2, ProviderId } from '@agent-dock/shared';

interface McpPanelProps {
  provider: ProviderId;
  cwd: string;
}

function publicField(server: McpServerDescriptorV2, key: 'command' | 'args'): string | string[] | undefined {
  const field = server.configFields.find((item) => item.key === key && item.classification === 'public');
  return field?.value;
}

export function McpPanel({ provider, cwd }: McpPanelProps) {
  const [servers, setServers] = useState<McpServerDescriptorV2[]>([]);
  const [revision, setRevision] = useState<string>();
  const [catalogs, setCatalogs] = useState<Record<string, McpCatalogV2>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<Exclude<McpTransportV2, 'legacy_sse_read_only'>>('stdio');
  const [endpoint, setEndpoint] = useState('');
  const [args, setArgs] = useState('');

  const refresh = useCallback(async () => {
    if (!cwd.trim()) {
      setServers([]);
      setRevision(undefined);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.agentDock.listMcpServers(provider, cwd.trim());
      setServers(result.servers);
      setRevision(result.revision);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Failed to inspect MCP servers');
    } finally {
      setBusy(false);
    }
  }, [cwd, provider]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function mutate(work: () => Promise<{ servers: McpServerDescriptorV2[]; revision: string }>): Promise<void> {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await work();
      setServers(result.servers);
      setRevision(result.revision);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'MCP operation failed');
    } finally {
      setBusy(false);
    }
  }

  function beginEdit(server: McpServerDescriptorV2): void {
    setEditing(server.id);
    setName(server.name);
    setTransport(server.transport === 'stdio' ? 'stdio' : 'streamable_http');
    const command = publicField(server, 'command');
    const currentArgs = publicField(server, 'args');
    setEndpoint(typeof command === 'string' ? command : '');
    setArgs(Array.isArray(currentArgs) ? currentArgs.join(' ') : '');
  }

  async function submitConfiguration(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const config = transport === 'stdio'
      ? { transport: 'stdio' as const, command: endpoint.trim(), args: args.trim() ? args.trim().split(/\s+/).slice(0, 128) : [] }
      : { transport: 'streamable_http' as const, url: endpoint.trim() };
    await mutate(() => window.agentDock.configureMcpServer(editing
      ? { provider, cwd: cwd.trim(), action: 'edit', serverId: editing, name: name.trim(), config }
      : { provider, cwd: cwd.trim(), action: 'add', name: name.trim(), scope: 'project', config }));
    setEditing(undefined);
    setName('');
    setEndpoint('');
    setArgs('');
  }

  async function loadCatalog(serverId: string): Promise<void> {
    try {
      const catalog = await window.agentDock.getMcpCatalog(provider, serverId, cwd.trim());
      setCatalogs((current) => ({ ...current, [serverId]: catalog }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Failed to load MCP catalog');
    }
  }

  async function startOAuth(serverId: string): Promise<void> {
    try {
      const status = await window.agentDock.startMcpOAuth(provider, serverId, cwd.trim());
      setNotice(status.authorizationHost ? `Opened ${status.authorizationHost} in your browser.` : status.safeSummary ?? `OAuth: ${status.status}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Failed to start MCP OAuth');
    }
  }

  return (
    <div className="mcp-panel">
      <div className="row row--spread">
        <p className="mcp-panel__summary">{servers.length} configured · {revision ?? 'not loaded'}</p>
        <button className="button button--secondary" type="button" disabled={busy || !cwd.trim()} onClick={() => void refresh()}>Refresh</button>
      </div>
      {error && <div className="banner banner--error" role="alert">{error}</div>}
      {notice && <div className="banner banner--info" role="status">{notice}</div>}
      <div className="mcp-server-list">
        {servers.map((server) => (
          <article className="mcp-server" key={`${server.provider}:${server.id}`}>
            <div className="row row--spread">
              <div>
                <strong>{server.name}</strong>
                <div className="mcp-server__meta">{server.provider} · {server.scope} · {server.ownership} · {server.transport}</div>
              </div>
              <span className={`status-pill status-pill--${server.connectionStatus === 'ready' ? 'ok' : 'muted'}`}>{server.enabled ? server.connectionStatus : 'disabled'}</span>
            </div>
            {server.startupFailure && <p className="mcp-server__failure">{server.startupFailure.summary}</p>}
            <div className="mcp-server__meta">Tools {server.catalog.tools} · Resources {server.catalog.resources} · Prompts {server.catalog.prompts}{server.required ? ' · required' : ''}</div>
            {server.configFields.length > 0 && <div className="mcp-field-list">{server.configFields.map((field) => <span key={field.key}>{field.key}: {field.classification}</span>)}</div>}
            {server.sessionIds.length > 0 && <div className="mcp-server__meta">Used by {server.sessionIds.length} session{server.sessionIds.length === 1 ? '' : 's'}</div>}
            <div className="mcp-server__actions">
              <button type="button" disabled={busy} aria-label={`Catalog ${server.name}`} onClick={() => void loadCatalog(server.id)}>Catalog</button>
              {server.capabilities.reload && <button type="button" disabled={busy} aria-label={`Reload ${server.name}`} onClick={() => void mutate(() => window.agentDock.actionMcpServer({ provider, cwd: cwd.trim(), serverId: server.id, action: 'reload' }))}>Reload</button>}
              {server.capabilities.configure && <button type="button" disabled={busy} aria-label={`${server.enabled ? 'Disable' : 'Enable'} ${server.name}`} onClick={() => void mutate(() => window.agentDock.configureMcpServer({ provider, cwd: cwd.trim(), serverId: server.id, action: server.enabled ? 'disable' : 'enable' }))}>{server.enabled ? 'Disable' : 'Enable'}</button>}
              {server.capabilities.configure && server.transport !== 'legacy_sse_read_only' && <button type="button" disabled={busy} aria-label={`Edit ${server.name}`} onClick={() => beginEdit(server)}>Edit</button>}
              {server.capabilities.oauth && <button type="button" disabled={busy} aria-label={`Sign in to ${server.name}`} onClick={() => void startOAuth(server.id)}>Sign in</button>}
              {server.capabilities.configure && <button type="button" className="button--danger" disabled={busy} aria-label={`Remove ${server.name}`} onClick={() => void mutate(() => window.agentDock.configureMcpServer({ provider, cwd: cwd.trim(), serverId: server.id, action: 'remove' }))}>Remove</button>}
            </div>
            {catalogs[server.id] && <ul className="mcp-catalog" aria-label={`${server.name} catalog`}>{catalogs[server.id]!.items.map((item) => <li key={`${item.kind}:${item.id}`}><strong>{item.name}</strong> <span>{item.kind}{item.kind === 'tool' && item.destructive ? ' · approval required' : ''}</span></li>)}</ul>}
          </article>
        ))}
        {!busy && cwd.trim() && servers.length === 0 && <p className="session-list__empty">No MCP servers configured for this provider.</p>}
      </div>
      <form className="mcp-config-form" onSubmit={(event) => void submitConfiguration(event)}>
        <h3>{editing ? 'Edit MCP server' : 'Add MCP server'}</h3>
        <label>Name<input type="text" value={name} onChange={(event) => setName(event.target.value)} maxLength={256} required /></label>
        <label>Transport<select value={transport} onChange={(event) => setTransport(event.target.value as typeof transport)}><option value="stdio">stdio</option><option value="streamable_http">streamable HTTP</option></select></label>
        <label>{transport === 'stdio' ? 'Executable' : 'HTTPS URL'}<input type="text" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} required placeholder={transport === 'stdio' ? 'npx' : 'https://mcp.example.com'} /></label>
        {transport === 'stdio' && <label>Arguments<input type="text" value={args} onChange={(event) => setArgs(event.target.value)} placeholder="-y package-name" /></label>}
        <div className="row"><button className="button button--primary" type="submit" disabled={busy || !cwd.trim()}>{editing ? 'Save' : 'Add server'}</button>{editing && <button className="button button--secondary" type="button" onClick={() => setEditing(undefined)}>Cancel</button>}</div>
        <p className="form-hint">Credentials stay with the provider. AgentDock accepts only public command arguments or an HTTPS endpoint.</p>
      </form>
    </div>
  );
}
