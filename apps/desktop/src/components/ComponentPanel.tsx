import { useEffect, useState } from 'react';
import type { ProviderComponentDescriptorV2, ProviderComponentKindV2, ProviderId } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';

export function ComponentPanel({ provider, cwd }: { provider: ProviderId; cwd: string }) {
  const [kind, setKind] = useState<ProviderComponentKindV2 | 'all'>('all');
  const [items, setItems] = useState<ProviderComponentDescriptorV2[]>([]);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState<string>();

  useEffect(() => {
    if (!cwd.trim()) { setItems([]); return; }
    let cancelled = false;
    void getBridge().listProviderComponents({ provider, cwd: cwd.trim(), ...(kind === 'all' ? {} : { kind }) })
      .then((result) => { if (!cancelled) { setItems(result.items); setRevision(result.revision); setError(undefined); } })
      .catch((failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : 'Component inspection failed'); });
    return () => { cancelled = true; };
  }, [cwd, kind, provider]);

  return (
    <div className="component-panel">
      <div className="row row--spread">
        <label>Kind<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="all">All</option><option value="skill">Skills</option><option value="plugin">Plugins</option><option value="hook">Hooks</option><option value="command">Commands</option><option value="agent">Agents</option></select></label>
        <span className="mcp-panel__summary">{items.length} items · {revision ?? 'not loaded'}</span>
      </div>
      {error && <div className="banner banner--error" role="alert">{error}</div>}
      <div className="component-list">
        {!error && items.length === 0 && <p className="form-hint">No {kind === 'all' ? 'components' : `${kind}s`} found for this workspace.</p>}
        {items.map((item) => <article className="component-item" key={`${item.provider}:${item.id}`}>
          <div className="row row--spread"><strong>{item.name}</strong><span className={`status-pill status-pill--${item.enabled ? 'ok' : 'muted'}`}>{item.enabled ? 'enabled' : 'disabled'}</span></div>
          <div className="mcp-server__meta">{item.provider} · {item.kind} · {item.scope} · {item.source} · {item.trusted ? 'trusted' : 'untrusted'}</div>
          {item.description && <p>{item.description}</p>}
          {item.displayPath && <code>{item.displayPath}</code>}
          <div className="mcp-field-list"><span>hooks {item.manifestPreview.hooks}</span><span>MCP {item.manifestPreview.mcpServers}</span><span>executables {item.manifestPreview.executables}</span><span>env {item.manifestPreview.environmentVariables}</span></div>
          {item.loadError && <p className="mcp-server__failure">{item.loadError.summary}</p>}
          {!item.trusted && (
            item.supportsManage || item.supportsDirectInvoke
              ? <p className="form-hint">This component advertises a management or invocation operation, but it stays blocked until workspace trust is granted.</p>
              : <p className="form-hint">Inspectable only. Execution stays blocked until workspace trust is granted, and no provider currently advertises a management or invocation operation for it either way.</p>
          )}
          <div className="mcp-server__actions">
            {item.supportsManage && <button type="button" disabled={!item.trusted} onClick={() => void getBridge().manageProviderComponent({ provider, cwd: cwd.trim(), componentId: item.id, action: item.enabled ? 'disable' : 'enable' })}>{item.enabled ? 'Disable' : 'Enable'}</button>}
            {item.supportsDirectInvoke && <button type="button" disabled={!item.trusted} onClick={() => void getBridge().invokeProviderComponent({ provider, cwd: cwd.trim(), componentId: item.id })}>Invoke</button>}
            {!item.supportsManage && !item.supportsDirectInvoke && <span className="form-hint">No provider-advertised control operation</span>}
          </div>
        </article>)}
      </div>
    </div>
  );
}
