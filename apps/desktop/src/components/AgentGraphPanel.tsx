import { useEffect, useState } from 'react';
import type { SubagentNodeV2 } from '@agent-dock/shared';

export function AgentGraphPanel({ sessionId }: { sessionId?: string }) {
  const [nodes, setNodes] = useState<SubagentNodeV2[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!sessionId) { setNodes([]); return; }
    let cancelled = false;
    void window.agentDock.getSubagentGraph(sessionId).then((graph) => { if (!cancelled) setNodes(graph.nodes); }).catch((failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : 'Agent graph unavailable'); });
    return () => { cancelled = true; };
  }, [sessionId]);
  const depth = (node: SubagentNodeV2): number => { let value = 0; let parent = node.parentId; const seen = new Set<string>(); while (parent && !seen.has(parent)) { seen.add(parent); value += 1; parent = nodes.find((item) => item.id === parent)?.parentId; } return Math.min(value, 16); };
  return <div>{error && <div className="banner banner--error">{error}</div>}{nodes.map((node) => <div className="agent-node" key={node.id} style={{ marginLeft: `${depth(node) * 16}px` }}><div className="row row--spread"><strong>{node.name}</strong><span className="status-pill">{node.status}</span></div><div className="mcp-server__meta">{node.role ?? 'agent'} · {node.model ?? 'provider default'} · {node.workspace.kind}: {node.workspace.displayName}</div><div className="mcp-server__actions">{node.controls.interrupt && <button type="button" onClick={() => void window.agentDock.controlSubagent({ sessionId: node.sessionId, agentId: node.id, action: 'interrupt' })}>Interrupt</button>}{node.controls.cancel && <button type="button" onClick={() => void window.agentDock.controlSubagent({ sessionId: node.sessionId, agentId: node.id, action: 'cancel' })}>Cancel</button>}{!node.controls.interrupt && !node.controls.cancel && <span className="form-hint">Provider does not advertise child control</span>}</div></div>)}{sessionId && nodes.length === 0 && !error && <p className="session-list__empty">No child agents reported.</p>}</div>;
}
