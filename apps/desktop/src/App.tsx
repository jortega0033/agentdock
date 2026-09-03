import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type {
  AgentEventV2Envelope,
  AgentSessionV2,
  ApprovalDecisionV2,
  CapabilityRequest,
  ProviderId,
  ProviderStatusV2,
  SessionEventHistoryV2Page,
  SessionListV2Page,
  WorkspaceTrustViewV2,
} from '@agent-dock/shared';
import { PROVIDER_DISPLAY_NAMES } from '@agent-dock/shared';
import type {
  RendererInteractionResolution,
  RendererQuestionResponse,
} from '../electron/interaction-broker.js';
import { ProviderPanel } from './components/ProviderPanel.js';
import { DemoModeBanner } from './components/DemoModeBanner.js';
import { McpPanel } from './components/McpPanel.js';
import { ComponentPanel } from './components/ComponentPanel.js';
import { AgentGraphPanel } from './components/AgentGraphPanel.js';
import { WorktreePanel } from './components/WorktreePanel.js';
import { WorkflowPanel } from './components/WorkflowPanel.js';
import { PanelStatusBadge } from './components/PanelStatusBadge.js';
import {
  childAgentPanelStatus,
  componentPanelStatus,
  mcpPanelStatus,
  workflowPanelStatus,
} from './panel-status.js';
import { ActivityTimeline } from './components/activity/ActivityTimeline.js';
import { RendererInteractionTimelineProjector } from './components/activity/interaction-timeline.js';
import { AgentDockMark } from './components/AgentDockMark.js';
import { InteractionDialog, WorkspaceTrustDialog } from './components/SecurityDialogs.js';
import {
  createSessionWorkspaceState,
  projectedSessionStatus,
  sessionWorkspacePreferences,
  sessionWorkspaceReducer,
  type SessionWorkspaceAction,
  type SessionWorkspacePreferences,
} from './session-workspace.js';
import runtimeUnavailableIllustration from '../assets/illustrations/runtime-unavailable.svg';

type DaemonState = 'connecting' | 'ready' | 'unavailable';

const DAEMON_CONNECT_TIMEOUT_MS = 20_000;
const CATALOG_PAGE_LIMIT = 100;
const MAX_CATALOG_PAGES = 100;
const WORKSPACE_PREFERENCES_KEY = 'agent-dock.session-workspace.v1';
const INTERACTIVE_CAPABILITIES: CapabilityRequest = {
  required: [{ id: 'session.cancel' }],
  optional: [
    { id: 'interaction.approval' },
    { id: 'interaction.question' },
    { id: 'content.streaming' },
    { id: 'content.tools' },
    { id: 'content.plans' },
    { id: 'content.usage.tokens' },
    { id: 'content.usage.cost' },
    { id: 'content.thinking' },
  ],
  allowExperimental: false,
};

export interface AppProps {
  demoMode?: boolean;
  onEnterDemo?: () => void;
  onExitDemo?: () => void;
}

// demoMode/onEnterDemo/onExitDemo default to inert values so every existing `render(<App />)`
// call site (this file's own test suite included) keeps working unchanged -- AppRoot.tsx is the
// only real caller, and it always passes all three explicitly.
const NOOP = () => {};

export function App({ demoMode = false, onEnterDemo = NOOP, onExitDemo = NOOP }: AppProps = {}) {
  const [daemonState, setDaemonState] = useState<DaemonState>('connecting');
  const [daemonError, setDaemonError] = useState<string>();
  const [providers, setProviders] = useState<ProviderStatusV2[]>();
  const [providersError, setProvidersError] = useState<string>();
  const [provider, setProvider] = useState<ProviderId>('claude');
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [allowDirtyWorkspaceShare, setAllowDirtyWorkspaceShare] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [workspaceTrust, setWorkspaceTrust] = useState<WorkspaceTrustViewV2>();
  const [trustPrompt, setTrustPrompt] = useState<WorkspaceTrustViewV2>();
  const [trustBusy, setTrustBusy] = useState(false);
  const [trustError, setTrustError] = useState<string>();
  const [interactionBusy, setInteractionBusy] = useState(false);
  const [interactionError, setInteractionError] = useState<string>();
  const [revokingTrust, setRevokingTrust] = useState(false);
  const [creating, setCreating] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [workspace, dispatchWorkspace] = useReducer(
    sessionWorkspaceReducer,
    undefined,
    createSessionWorkspaceState,
  );
  const workspaceRef = useRef(workspace);
  const pendingActionsRef = useRef(new Map<string, SessionWorkspaceAction[]>());
  const interactionProjectorsRef = useRef(new Map<string, RendererInteractionTimelineProjector>());

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    let cancelled = false;
    window.agentDock.getDaemonStatus().then((status) => {
      if (cancelled) return;
      if (status.state === 'ready') setDaemonState('ready');
      else if (status.state === 'unavailable') {
        setDaemonState('unavailable');
        setDaemonError(status.error);
      }
    });
    const unsubscribeStatus = window.agentDock.onDaemonStatus((status) => {
      setDaemonState(status.state);
      setDaemonError(status.state === 'unavailable' ? status.error : undefined);
    });
    const timeout = setTimeout(() => {
      setDaemonState((current) => (current === 'connecting' ? 'unavailable' : current));
      setDaemonError((current) => current ?? 'timed out waiting for the local daemon to start');
    }, DAEMON_CONNECT_TIMEOUT_MS);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      unsubscribeStatus();
    };
  }, []);

  useEffect(() => {
    // A future refactor could set window.agentDock to the demo bridge without going through
    // AppRoot's enterDemoMode (or vice versa) -- that would silently mislabel demo data as real
    // (or vice versa), so surface it loudly instead of trusting the `demoMode` prop alone.
    const bridgeIsDemo = Boolean(
      (window.agentDock as unknown as { __agentDockDemo?: boolean }).__agentDockDemo,
    );
    if (bridgeIsDemo !== demoMode) {
      console.error('AgentDock: demo-mode flag and active bridge disagree — refusing to trust labeling');
    }
  }, [demoMode]);

  useEffect(() => {
    if (daemonState !== 'ready') return;
    let cancelled = false;
    void window.agentDock
      .listProvidersV2()
      .then((statuses) => {
        if (!cancelled) setProviders(statuses);
      })
      .catch((error: Error) => {
        if (!cancelled) setProvidersError(error.message);
      });
    // The demo bridge has no persisted catalog to restore (listInteractiveSessions always
    // returns empty) and restoring would otherwise read the real user's saved workspace
    // preferences from localStorage into a demo session -- skip straight to "loaded".
    if (demoMode) {
      setCatalogLoaded(true);
    } else {
      void restoreSessionCatalog();
    }
    return () => {
      cancelled = true;
    };

    async function restoreSessionCatalog(): Promise<void> {
      try {
        const sessions = await readAllSessions();
        if (cancelled) return;
        const hydrateAction: SessionWorkspaceAction = {
          type: 'hydrate',
          sessions,
          preferences: readWorkspacePreferences(),
        };
        workspaceRef.current = sessionWorkspaceReducer(workspaceRef.current, hydrateAction);
        dispatchWorkspace(hydrateAction);
        for (const session of sessions) flushPendingActions(session.id);
        await Promise.all(
          sessions.map(async (session) => {
            const events = await readAllHistory(session.id);
            if (cancelled) return;
            dispatchWorkspace({ type: 'replace_history', sessionId: session.id, events });
            if (!isTerminal(session))
              await window.agentDock.reconnectInteractiveSession(session.id);
          }),
        );
      } catch (error) {
        if (!cancelled) {
          setFormError(error instanceof Error ? error.message : 'failed to restore sessions');
        }
      } finally {
        if (!cancelled) setCatalogLoaded(true);
      }
    }
  }, [daemonState, demoMode]);

  useEffect(() => {
    // A demo session's fake IDs must never land in the real user's saved workspace preferences.
    if (!catalogLoaded || demoMode) return;
    try {
      window.localStorage.setItem(
        WORKSPACE_PREFERENCES_KEY,
        JSON.stringify(sessionWorkspacePreferences(workspace)),
      );
    } catch {
      // Daemon state remains authoritative when best-effort UI preferences cannot be saved.
    }
  }, [catalogLoaded, workspace, demoMode]);

  useEffect(() => {
    const unsubscribeEvents = window.agentDock.onInteractiveSessionEvent((sessionId, event) => {
      dispatchOrQueue(sessionId, { type: 'append_event', event });
    });
    const unsubscribeNotices = window.agentDock.onInteractiveSessionStreamNotice(
      (sessionId, notice) => {
        if (notice.type === 'replay_reset') {
          dispatchWorkspace({ type: 'replay_reset', session: notice.session });
          return;
        }
        dispatchWorkspace({ type: 'stream_error', sessionId, message: notice.message });
      },
    );
    const unsubscribeInteractions = window.agentDock.onInteractionRequested(
      (sessionId, interaction) => {
        setInteractionError(undefined);
        dispatchOrQueue(sessionId, {
          type: 'interaction_requested',
          sessionId,
          interaction,
          timelineEvent: interactionProjector(sessionId).projectInteraction(interaction),
        });
      },
    );
    const unsubscribeResolutions = window.agentDock.onInteractionResolved(
      (sessionId: string, resolution: RendererInteractionResolution) => {
        dispatchOrQueue(sessionId, {
          type: 'interaction_resolved',
          sessionId,
          resolution,
          timelineEvent: interactionProjector(sessionId).projectResolution(resolution),
        });
        setInteractionBusy(false);
      },
    );
    return () => {
      unsubscribeEvents();
      unsubscribeNotices();
      unsubscribeInteractions();
      unsubscribeResolutions();
    };
  }, []);

  const startInteractiveSession = useCallback(async () => {
    setCreating(true);
    try {
      const session = await window.agentDock.createInteractiveSession({
        provider,
        cwd: cwd.trim(),
        prompt: prompt.trim(),
        capabilities: INTERACTIVE_CAPABILITIES,
        ...(allowDirtyWorkspaceShare ? { allowDirtyWorkspaceShare: true } : {}),
      });
      const upsertAction: SessionWorkspaceAction = { type: 'upsert', session, select: true };
      workspaceRef.current = sessionWorkspaceReducer(workspaceRef.current, upsertAction);
      dispatchWorkspace(upsertAction);
      flushPendingActions(session.id);
      setPrompt('');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'failed to start session');
    } finally {
      setCreating(false);
    }
  }, [allowDirtyWorkspaceShare, provider, cwd, prompt]);

  const handleRun = useCallback(async () => {
    setFormError(undefined);
    setTrustError(undefined);
    if (!cwd.trim()) return setFormError('working directory is required');
    if (!prompt.trim()) return setFormError('prompt is required');
    setCreating(true);
    try {
      const trust = await window.agentDock.inspectWorkspace(cwd.trim());
      setWorkspaceTrust(trust);
      if (trust.state !== 'trusted') return setTrustPrompt(trust);
      await startInteractiveSession();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'failed to inspect workspace');
    } finally {
      setCreating(false);
    }
  }, [cwd, prompt, startInteractiveSession]);

  const handleTrustAndRun = useCallback(async () => {
    if (!trustPrompt) return;
    setTrustBusy(true);
    setTrustError(undefined);
    try {
      const trust = await window.agentDock.setWorkspaceTrust(trustPrompt.workspaceId, {
        cwd: cwd.trim(),
        incarnation: trustPrompt.incarnation,
        state: 'trusted',
      });
      setWorkspaceTrust(trust);
      setTrustPrompt(undefined);
      await startInteractiveSession();
    } catch (error) {
      setTrustError(error instanceof Error ? error.message : 'failed to trust workspace');
    } finally {
      setTrustBusy(false);
      setCreating(false);
    }
  }, [cwd, startInteractiveSession, trustPrompt]);

  const selectedEntry = workspace.selectedSessionId
    ? workspace.entries[workspace.selectedSessionId]
    : undefined;
  const selectedInteraction = selectedEntry?.interactions[0];
  const runStatus = creating
    ? 'starting'
    : selectedEntry
      ? projectedSessionStatus(selectedEntry.session.status)
      : 'idle';

  const handleCancel = useCallback(async (sessionId?: string) => {
    const target = sessionId ?? workspaceRef.current.selectedSessionId;
    if (!target) return;
    try {
      await window.agentDock.cancelInteractiveSession(target);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'failed to cancel session');
    }
  }, []);

  const handleApproval = useCallback(
    async (decision: ApprovalDecisionV2) => {
      if (!selectedEntry || !selectedInteraction || selectedInteraction.kind !== 'approval') return;
      setInteractionBusy(true);
      setInteractionError(undefined);
      try {
        await window.agentDock.respondApproval(selectedInteraction.interactionHandle, decision);
      } catch (error) {
        setInteractionError(
          `${error instanceof Error ? error.message : 'approval response failed'}; the request will fail closed`,
        );
      } finally {
        dispatchWorkspace({
          type: 'remove_interaction',
          sessionId: selectedEntry.session.id,
          interactionHandle: selectedInteraction.interactionHandle,
        });
        setInteractionBusy(false);
      }
    },
    [selectedEntry, selectedInteraction],
  );

  const handleQuestions = useCallback(
    async (answers: RendererQuestionResponse['answers']) => {
      if (!selectedEntry || !selectedInteraction || selectedInteraction.kind !== 'question') return;
      setInteractionBusy(true);
      setInteractionError(undefined);
      try {
        await window.agentDock.answerQuestions(selectedInteraction.interactionHandle, answers);
      } catch (error) {
        setInteractionError(
          `${error instanceof Error ? error.message : 'question response failed'}; the request will fail closed`,
        );
      } finally {
        dispatchWorkspace({
          type: 'remove_interaction',
          sessionId: selectedEntry.session.id,
          interactionHandle: selectedInteraction.interactionHandle,
        });
        setInteractionBusy(false);
      }
    },
    [selectedEntry, selectedInteraction],
  );

  const handleContinuation = useCallback(
    async (kind: 'resume' | 'fork') => {
      if (!selectedEntry || !prompt.trim()) return;
      setCreating(true);
      setFormError(undefined);
      try {
        const operation =
          kind === 'resume'
            ? window.agentDock.resumeInteractiveSession
            : window.agentDock.forkInteractiveSession;
        const session = await operation(selectedEntry.session.id, {
          prompt: prompt.trim(),
          capabilities: INTERACTIVE_CAPABILITIES,
          ...(allowDirtyWorkspaceShare ? { allowDirtyWorkspaceShare: true } : {}),
        });
        const upsertAction: SessionWorkspaceAction = { type: 'upsert', session, select: true };
        workspaceRef.current = sessionWorkspaceReducer(workspaceRef.current, upsertAction);
        dispatchWorkspace(upsertAction);
        flushPendingActions(session.id);
        setPrompt('');
      } catch (error) {
        setFormError(error instanceof Error ? error.message : `failed to ${kind} session`);
      } finally {
        setCreating(false);
      }
    },
    [allowDirtyWorkspaceShare, prompt, selectedEntry],
  );

  const handleDelete = useCallback(async () => {
    if (!selectedEntry || !isTerminal(selectedEntry.session)) return;
    try {
      await window.agentDock.deleteInteractiveSession(selectedEntry.session.id);
      interactionProjectorsRef.current.delete(selectedEntry.session.id);
      dispatchWorkspace({ type: 'delete', sessionId: selectedEntry.session.id });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'failed to delete session');
    }
  }, [selectedEntry]);

  const handleRevokeTrust = useCallback(async () => {
    if (!workspaceTrust) return;
    setRevokingTrust(true);
    setFormError(undefined);
    try {
      setWorkspaceTrust(
        await window.agentDock.setWorkspaceTrust(workspaceTrust.workspaceId, {
          cwd: cwd.trim(),
          incarnation: workspaceTrust.incarnation,
          state: 'untrusted',
        }),
      );
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'failed to revoke workspace trust');
    } finally {
      setRevokingTrust(false);
    }
  }, [cwd, workspaceTrust]);

  const selectedProviderStatus = providers?.find((status) => status.id === provider);
  const selectedSessionProviderStatus = providers?.find(
    (status) => status.id === selectedEntry?.session.provider,
  );
  const canRun =
    daemonState === 'ready' &&
    !!selectedProviderStatus?.installed &&
    !creating &&
    cwd.trim().length > 0 &&
    prompt.trim().length > 0;
  const selectedTerminal = selectedEntry ? isTerminal(selectedEntry.session) : false;
  // A capability the daemon has not negotiated as supported can never actually dispatch (see
  // apps/daemon/src/v2-legacy-provider.ts, issue #54) — hide the corresponding action rather than
  // let the user hit a guaranteed server-side rejection.
  const sessionSupports = (capabilityId: 'session.resume' | 'session.fork'): boolean =>
    selectedSessionProviderStatus?.capabilities.some(
      (record) => record.id === capabilityId && record.support === 'supported',
    ) ?? false;
  const canResumeSelected = selectedTerminal && sessionSupports('session.resume');
  const canForkSelected = selectedTerminal && sessionSupports('session.fork');

  const runDisabledReason = (): string | undefined => {
    if (canRun) return undefined;
    if (creating) return 'Run: a request is already in flight.';
    if (daemonState !== 'ready') return 'Run: waiting for the local runtime to be ready.';
    if (!selectedProviderStatus?.installed) {
      return `Run: ${PROVIDER_DISPLAY_NAMES[provider]} is not installed.`;
    }
    if (cwd.trim().length === 0) return 'Run: enter a working directory.';
    if (prompt.trim().length === 0) return 'Run: enter a prompt.';
    return undefined;
  };

  const continuationDisabledReason = (
    verb: 'Resume' | 'Fork',
    capable: boolean,
  ): string | undefined => {
    if (capable && prompt.trim().length > 0 && !creating) return undefined;
    if (creating) return `${verb}: a request is already in flight.`;
    if (!selectedTerminal) return `${verb}: select a completed session first.`;
    if (!capable) {
      return `${verb}: this provider does not support ${verb === 'Resume' ? 'resuming' : 'forking'} a session yet.`;
    }
    return `${verb}: enter a prompt to continue.`;
  };

  const cancelDisabledReason = (): string | undefined =>
    selectedEntry && projectedSessionStatus(selectedEntry.session.status) !== 'running'
      ? 'Cancel: this session is not running.'
      : undefined;

  return (
    <div className="app-shell">
      {demoMode && <DemoModeBanner onExit={onExitDemo} />}
      <header className="app-header">
        <div className="brand">
          <div className="brand__mark" aria-hidden="true">
            <AgentDockMark />
          </div>
          <div>
            <h1>AgentDock</h1>
            <p className="subtitle">A secure local runtime for your own agent CLI or SDK credentials</p>
          </div>
        </div>
        <div className="app-header__status">
          {!demoMode && (
            <button className="button button--secondary" type="button" onClick={onEnterDemo}>
              Try a demo
            </button>
          )}
          <div className={`runtime-state runtime-state--${daemonState}`}>
            <span className="runtime-state__dot" aria-hidden="true" />
            <span>Local runtime</span>
            <strong>{daemonState}</strong>
          </div>
        </div>
      </header>

      {daemonState === 'connecting' && (
        <div className="banner banner--info">Connecting to local daemon…</div>
      )}
      {daemonState === 'unavailable' && (
        <section className="card unavailable-state">
          <img
            className="unavailable-state__illustration"
            src={runtimeUnavailableIllustration}
            alt=""
          />
          <div>
            <span className="eyebrow">Runtime check failed</span>
            <h2>Daemon unavailable</h2>
            <p>{daemonError ?? 'unknown error'}</p>
            <p className="unavailable-state__hint">
              Restart AgentDock after verifying the local runtime bundle and your installed agent
              CLIs.
            </p>
          </div>
        </section>
      )}

      {daemonState === 'ready' && (
        <main className="workspace workspace--sessions">
          <aside className="workspace__sidebar card" aria-label="Sessions">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Workspace</span>
                <h2>Sessions</h2>
              </div>
              <span className="section-count">{workspace.order.length}</span>
            </div>
            <div className="session-list">
              {workspace.order.map((sessionId) => {
                const entry = workspace.entries[sessionId];
                if (!entry) return null;
                return (
                  <button
                    key={sessionId}
                    type="button"
                    className={`session-list__item${workspace.selectedSessionId === sessionId ? ' session-list__item--selected' : ''}${entry.archived ? ' session-list__item--archived' : ''}`}
                    onClick={() => dispatchWorkspace({ type: 'select', sessionId })}
                  >
                    <span className="session-list__title">
                      {entry.session.provider} · {shortId(sessionId)}
                    </span>
                    <span className="session-list__meta">
                      {projectedSessionStatus(entry.session.status)} · {entry.session.transport}
                    </span>
                    <span className="session-list__signals">
                      {entry.interactions.length > 0 && <strong>Needs attention</strong>}
                      {entry.unread > 0 && (
                        <span className="session-list__unread">{entry.unread}</span>
                      )}
                      {entry.archived && <span>Archived</span>}
                    </span>
                  </button>
                );
              })}
              {catalogLoaded && workspace.order.length === 0 && (
                <p className="session-list__empty">No sessions yet.</p>
              )}
            </div>
          </aside>

          <div className="workspace__controls">
            <section className="card">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">Runtime</span>
                  <h2>Providers</h2>
                </div>
                <span className="section-count">{providers?.length ?? '–'}</span>
              </div>
              {providersError && <div className="banner banner--error">{providersError}</div>}
              {providers && (
                <ProviderPanel
                  providers={providers}
                  onTryDemo={demoMode ? undefined : onEnterDemo}
                />
              )}
            </section>
            <section className="card">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">Integrations</span>
                  <h2>MCP servers</h2>
                </div>
              </div>
              <PanelStatusBadge status={mcpPanelStatus()} id="mcp-panel-status" />
              <McpPanel provider={provider} cwd={cwd} />
            </section>
            <section className="card">
              <div className="section-heading"><div><span className="eyebrow">Trust inventory</span><h2>Skills, plugins & hooks</h2></div></div>
              <PanelStatusBadge status={componentPanelStatus()} id="component-panel-status" />
              <ComponentPanel provider={provider} cwd={cwd} />
            </section>
            <section className="card"><div className="section-heading"><div><span className="eyebrow">Isolation</span><h2>Owned worktrees</h2></div></div><WorktreePanel cwd={cwd} /></section>
            <section className="card">
              <div className="section-heading"><div><span className="eyebrow">Execution tree</span><h2>Child agents</h2></div></div>
              <PanelStatusBadge
                status={childAgentPanelStatus(!!selectedEntry)}
                id="child-agent-panel-status"
              />
              <AgentGraphPanel sessionId={selectedEntry?.session.id} />
            </section>
            <section className="card">
              <div className="section-heading"><div><span className="eyebrow">Staging only, not dispatched</span><h2>File staging & structured output</h2></div></div>
              <PanelStatusBadge status={workflowPanelStatus()} id="workflow-panel-status" />
              <WorkflowPanel sessionId={selectedEntry?.session.id} />
            </section>
            <section className="card">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">New session</span>
                  <h2>Run an agent</h2>
                </div>
              </div>
              <label>
                Provider
                <select
                  value={provider}
                  onChange={(event) => setProvider(event.target.value as ProviderId)}
                  disabled={creating}
                >
                  <option value="claude">{PROVIDER_DISPLAY_NAMES.claude}</option>
                  <option value="codex">{PROVIDER_DISPLAY_NAMES.codex}</option>
                </select>
              </label>
              <label>
                Working directory
                <div className="row">
                  <input
                    type="text"
                    value={cwd}
                    onChange={(event) => {
                      setCwd(event.target.value);
                      setWorkspaceTrust(undefined);
                    }}
                    placeholder="/path/to/project"
                    disabled={creating}
                  />
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={creating}
                    onClick={async () => {
                      const directory = await window.agentDock.selectDirectory();
                      if (directory) {
                        setCwd(directory);
                        setWorkspaceTrust(undefined);
                      }
                    }}
                  >
                    Browse
                  </button>
                </div>
              </label>
              {workspaceTrust?.state === 'trusted' && (
                <div className="trust-state" role="status">
                  <span>Trusted workspace: {workspaceTrust.displayName}</span>
                  <button
                    className="button button--quiet-danger"
                    type="button"
                    disabled={revokingTrust}
                    onClick={handleRevokeTrust}
                  >
                    {revokingTrust ? 'Revoking…' : 'Revoke trust'}
                  </button>
                </div>
              )}
              <label>
                Prompt
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={5}
                  placeholder="Describe the task for your agent…"
                  disabled={creating}
                />
              </label>
              <label className="dirty-share-option">
                <input
                  type="checkbox"
                  checked={allowDirtyWorkspaceShare}
                  onChange={(event) => setAllowDirtyWorkspaceShare(event.target.checked)}
                  disabled={creating}
                />
                Allow another read-only session to share this worktree when it is already dirty
              </label>
              {formError && (
                <div className="banner banner--error" role="alert">
                  {formError}
                </div>
              )}
              <div className="row run-actions">
                <button
                  className="button button--primary"
                  type="button"
                  onClick={handleRun}
                  disabled={!canRun}
                  title={runDisabledReason()}
                >
                  Run
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => void handleContinuation('resume')}
                  disabled={!canResumeSelected || !prompt.trim() || creating}
                  title={continuationDisabledReason('Resume', canResumeSelected)}
                >
                  Resume
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => void handleContinuation('fork')}
                  disabled={!canForkSelected || !prompt.trim() || creating}
                  title={continuationDisabledReason('Fork', canForkSelected)}
                >
                  Fork
                </button>
              </div>
            </section>
          </div>

          <section className="card card--session">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Provider-neutral activity</span>
                <h2>Session timeline</h2>
              </div>
              <span className={`status status--${runStatus}`} aria-live="polite">
                {runStatus}
              </span>
            </div>
            {selectedEntry && (
              <div className="session-facts" aria-label="Session details">
                <span>{selectedEntry.session.cwd}</span>
                <span>Branch: {selectedEntry.session.branch ?? 'not a Git worktree'}</span>
                <span>{selectedEntry.session.provider}</span>
                <span>{selectedEntry.session.transport}</span>
                <span>Trust: verified at dispatch</span>
                {selectedSessionProviderStatus && (
                  <span>Sandbox: {selectedSessionProviderStatus.sandbox.badge}</span>
                )}
                <span>{lineageLabel(selectedEntry.session)}</span>
              </div>
            )}
            {selectedEntry?.streamError && (
              <div className="banner banner--error">{selectedEntry.streamError}</div>
            )}
            <ActivityTimeline
              events={selectedEntry?.activity.events ?? []}
              omittedEventCount={selectedEntry?.activity.omittedEventCount ?? 0}
              focusBlockingCards={!selectedInteraction}
            />
            {selectedEntry && (
              <div className="row session-actions">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => void handleCancel(selectedEntry.session.id)}
                  disabled={projectedSessionStatus(selectedEntry.session.status) !== 'running'}
                  title={cancelDisabledReason()}
                >
                  Cancel
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() =>
                    dispatchWorkspace({
                      type: 'toggle_archive',
                      sessionId: selectedEntry.session.id,
                    })
                  }
                >
                  {selectedEntry.archived ? 'Unarchive' : 'Archive'}
                </button>
                <button
                  className="button button--danger"
                  type="button"
                  onClick={() => void handleDelete()}
                  disabled={!selectedTerminal}
                >
                  Delete
                </button>
              </div>
            )}
          </section>
        </main>
      )}

      {trustPrompt && (
        <WorkspaceTrustDialog
          workspace={trustPrompt}
          busy={trustBusy}
          error={trustError}
          onCancel={() => {
            setTrustPrompt(undefined);
            setCreating(false);
          }}
          onTrust={() => void handleTrustAndRun()}
        />
      )}
      {selectedInteraction && selectedEntry && (
        <InteractionDialog
          interaction={selectedInteraction}
          busy={interactionBusy}
          error={interactionError}
          onApproval={(decision) => void handleApproval(decision)}
          onQuestions={(answers) => void handleQuestions(answers)}
          onCancelSession={() => void handleCancel(selectedEntry.session.id)}
        />
      )}
    </div>
  );

  function dispatchOrQueue(sessionId: string, action: SessionWorkspaceAction): void {
    if (workspaceRef.current.entries[sessionId]) {
      dispatchWorkspace(action);
      return;
    }
    const pending = pendingActionsRef.current.get(sessionId) ?? [];
    pending.push(action);
    pendingActionsRef.current.set(sessionId, pending);
  }

  function flushPendingActions(sessionId: string): void {
    const pending = pendingActionsRef.current.get(sessionId) ?? [];
    pendingActionsRef.current.delete(sessionId);
    for (const action of pending) dispatchWorkspace(action);
  }

  function interactionProjector(sessionId: string): RendererInteractionTimelineProjector {
    let projector = interactionProjectorsRef.current.get(sessionId);
    if (!projector) {
      projector = new RendererInteractionTimelineProjector();
      interactionProjectorsRef.current.set(sessionId, projector);
    }
    return projector;
  }
}

async function readAllSessions(): Promise<AgentSessionV2[]> {
  const sessions: AgentSessionV2[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_CATALOG_PAGES; pageIndex += 1) {
    const page: SessionListV2Page = await window.agentDock.listInteractiveSessions({
      limit: CATALOG_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    sessions.push(...page.sessions);
    if (!page.nextCursor) return sessions;
    if (seenCursors.has(page.nextCursor)) throw new Error('session catalog returned a cursor loop');
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('session catalog exceeded the desktop restore bound');
}

async function readAllHistory(sessionId: string): Promise<AgentEventV2Envelope[]> {
  const events: AgentEventV2Envelope[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_CATALOG_PAGES; pageIndex += 1) {
    const page: SessionEventHistoryV2Page = await window.agentDock.readInteractiveSessionHistory(
      sessionId,
      { limit: CATALOG_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    );
    events.push(...page.events);
    if (!page.nextCursor) return events;
    if (seenCursors.has(page.nextCursor)) throw new Error('session history returned a cursor loop');
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('session history exceeded the desktop restore bound');
}

function readWorkspacePreferences(): SessionWorkspacePreferences | undefined {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(WORKSPACE_PREFERENCES_KEY) ?? 'null',
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const unread = record.unreadBySession;
    const archived = record.archivedSessionIds;
    return {
      ...(typeof record.selectedSessionId === 'string'
        ? { selectedSessionId: record.selectedSessionId }
        : {}),
      unreadBySession:
        unread && typeof unread === 'object' && !Array.isArray(unread)
          ? Object.fromEntries(
              Object.entries(unread).filter(
                ([, count]) => typeof count === 'number' && Number.isInteger(count) && count >= 0,
              ),
            )
          : {},
      archivedSessionIds: Array.isArray(archived)
        ? archived.filter((sessionId): sessionId is string => typeof sessionId === 'string')
        : [],
    };
  } catch {
    return undefined;
  }
}

function isTerminal(session: AgentSessionV2): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(session.status);
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function lineageLabel(session: AgentSessionV2): string {
  return session.parentSessionId
    ? `${session.continuationKind ?? 'continued'} from ${shortId(session.parentSessionId)}`
    : 'Fresh session';
}
