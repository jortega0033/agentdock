import { useEffect, useState } from 'react';
import type { OwnedWorktreeV2, WorktreePreviewV2 } from '@agent-dock/shared';

const WORKTREE_STATUS_PILL: Record<OwnedWorktreeV2['status'], 'ok' | 'warn' | 'muted'> = {
  ready: 'ok',
  dirty: 'warn',
  locked: 'warn',
  orphaned: 'muted',
  missing: 'muted',
};

const WORKTREE_STATUS_HINT: Partial<Record<OwnedWorktreeV2['status'], string>> = {
  dirty: 'Has uncommitted changes.',
  locked: 'Locked — in use by another process.',
  orphaned: 'Orphaned — no longer linked to an active session.',
  missing: 'Missing — the worktree folder was removed outside AgentDock.',
};

export function WorktreePanel({ cwd }: { cwd: string }) {
  const [name, setName] = useState(''); const [preview, setPreview] = useState<WorktreePreviewV2>(); const [confirmed, setConfirmed] = useState(false); const [items, setItems] = useState<OwnedWorktreeV2[]>([]); const [error, setError] = useState<string>();
  const refresh = () => window.agentDock.listWorktrees().then(setItems).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Worktree list failed'));
  useEffect(() => { void refresh(); }, []);
  async function inspect() { try { setPreview(await window.agentDock.previewWorktree({ cwd: cwd.trim(), name: name.trim() })); setConfirmed(false); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Worktree preview failed'); } }
  async function create() { if (!preview || !confirmed) return; try { await window.agentDock.createWorktree({ cwd: cwd.trim(), name: preview.name, confirmIncludeCopy: true }); setPreview(undefined); setName(''); await refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Worktree creation failed'); } }
  function cleanup(item: OwnedWorktreeV2) {
    if (!window.confirm(`Permanently delete the worktree "${item.name}"? This cannot be undone.`)) return;
    void window.agentDock.cleanupWorktree(item.id).then(refresh).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Cleanup blocked'));
  }
  return <div>{error && <div className="banner banner--error">{error}</div>}<div className="row"><label>Worktree name<input type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="feature-name" /></label><button type="button" disabled={!cwd.trim() || !name.trim()} onClick={() => void inspect()}>Preview</button></div>{preview && <div className="worktree-preview"><p>Copy {preview.includeFiles.length} included file(s); {preview.ignoredFiles.length} ignored file(s) detected.</p>{preview.secretRisk && <p className="mcp-server__failure">Possible secret-bearing filenames detected. Review before copying.</p>}<label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed the include and ignored-file preview.</label><button type="button" disabled={!confirmed} onClick={() => void create()}>Create isolated worktree</button></div>}<div className="component-list">{!error && items.length === 0 && <p className="form-hint">No worktrees yet — create one above.</p>}{items.map((item) => <div className="component-item" key={item.id}><div className="row row--spread"><strong>{item.name}</strong><span className={`status-pill status-pill--${WORKTREE_STATUS_PILL[item.status]}`}>{item.status}</span></div>{WORKTREE_STATUS_HINT[item.status] && <p className="form-hint">{WORKTREE_STATUS_HINT[item.status]}</p>}{item.status === 'ready' && <button type="button" className="button button--quiet-danger" onClick={() => cleanup(item)}>Clean up</button>}</div>)}</div></div>;
}
