import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentEventV2Envelope,
  ApprovalDecisionV2,
  CapabilityRequest,
  ProviderId,
  ProviderStatusV2,
  WorkspaceTrustViewV2,
} from '@agent-dock/shared';
import type {
  RendererInteraction,
  RendererInteractionResolution,
  RendererQuestionResponse,
} from '../electron/interaction-broker.js';
import { ProviderPanel } from './components/ProviderPanel.js';
import { EventLog } from './components/EventLog.js';
import { AgentDockMark } from './components/AgentDockMark.js';
import { InteractionDialog, WorkspaceTrustDialog } from './components/SecurityDialogs.js';
import runtimeUnavailableIllustration from '../assets/illustrations/runtime-unavailable.svg';

type DaemonState = 'connecting' | 'ready' | 'unavailable';
type RunStatus =
  'idle' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

const DAEMON_CONNECT_TIMEOUT_MS = 20_000;
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

function terminalStatus(event: AgentEventV2Envelope): RunStatus | undefined {
  if (event.type === 'session.completed') return 'completed';
  if (event.type === 'session.failed') return 'failed';
  if (event.type === 'session.cancelled') return 'cancelled';
  if (event.type === 'session.interrupted') return 'interrupted';
  return undefined;
}

function projectedSessionStatus(
  status: 'starting' | 'active' | 'idle' | 'completed' | 'failed' | 'cancelled' | 'interrupted',
): RunStatus {
  return status === 'starting' || status === 'active' || status === 'idle' ? 'running' : status;
}

export function App() {
  const [daemonState, setDaemonState] = useState<DaemonState>('connecting');
  const [daemonError, setDaemonError] = useState<string>();
  const [providers, setProviders] = useState<ProviderStatusV2[]>();
  const [providersError, setProvidersError] = useState<string>();
  const [provider, setProvider] = useState<ProviderId>('claude');
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [formError, setFormError] = useState<string>();
  const [runStatus, setRunStatus] = useState<RunStatus>('idle');
  const [events, setEvents] = useState<AgentEventV2Envelope[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [workspaceTrust, setWorkspaceTrust] = useState<WorkspaceTrustViewV2>();
  const [trustPrompt, setTrustPrompt] = useState<WorkspaceTrustViewV2>();
  const [trustBusy, setTrustBusy] = useState(false);
  const [trustError, setTrustError] = useState<string>();
  const [interactions, setInteractions] = useState<RendererInteraction[]>([]);
  const [interactionBusy, setInteractionBusy] = useState(false);
  const [interactionError, setInteractionError] = useState<string>();
  const [revokingTrust, setRevokingTrust] = useState(false);
  const sessionIdRef = useRef<string>();
  const startingRef = useRef(false);

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
    if (daemonState !== 'ready') return;
    const listProvidersV2 = window.agentDock.listProvidersV2;
    if (!listProvidersV2) {
      setProvidersError('this desktop bridge does not support secure provider discovery');
      return;
    }
    listProvidersV2()
      .then(setProviders)
      .catch((error: Error) => setProvidersError(error.message));
  }, [daemonState]);

  useEffect(() => {
    const unsubscribeEvents = window.agentDock.onInteractiveSessionEvent(
      (eventSessionId, event) => {
        if (!sessionIdRef.current && startingRef.current) sessionIdRef.current = eventSessionId;
        if (sessionIdRef.current !== eventSessionId) return;
        setEvents((current) => [...current, event]);
        const terminal = terminalStatus(event);
        if (terminal) {
          setRunStatus(terminal);
          startingRef.current = false;
        } else if (event.type === 'session.status' && event.status !== 'starting') {
          setRunStatus('running');
        }
      },
    );
    const unsubscribeNotices = window.agentDock.onInteractiveSessionStreamNotice(
      (eventSessionId, notice) => {
        if (sessionIdRef.current !== eventSessionId) return;
        if (notice.type === 'replay_reset') {
          setRunStatus(projectedSessionStatus(notice.session.status));
          return;
        }
        setFormError(notice.message);
        setRunStatus('failed');
      },
    );
    const unsubscribeInteractions =
      window.agentDock.onInteractionRequested?.((interaction) => {
        setInteractionError(undefined);
        setInteractions((current) => [...current, interaction]);
      }) ?? (() => {});
    const unsubscribeResolutions =
      window.agentDock.onInteractionResolved?.((resolution: RendererInteractionResolution) => {
        setInteractions((current) =>
          current.filter((item) => item.interactionHandle !== resolution.interactionHandle),
        );
        setInteractionBusy(false);
      }) ?? (() => {});
    return () => {
      unsubscribeEvents();
      unsubscribeNotices();
      unsubscribeInteractions();
      unsubscribeResolutions();
    };
  }, []);

  const startInteractiveSession = useCallback(async () => {
    setEvents([]);
    setInteractions([]);
    setSessionId(undefined);
    sessionIdRef.current = undefined;
    startingRef.current = true;
    setRunStatus('starting');
    try {
      const session = await window.agentDock.createInteractiveSession({
        provider,
        cwd: cwd.trim(),
        prompt: prompt.trim(),
        capabilities: INTERACTIVE_CAPABILITIES,
      });
      if (sessionIdRef.current && sessionIdRef.current !== session.id) {
        throw new Error('interactive event stream did not match the created session');
      }
      sessionIdRef.current = session.id;
      setSessionId(session.id);
      setRunStatus(projectedSessionStatus(session.status));
    } catch (error) {
      sessionIdRef.current = undefined;
      setRunStatus('failed');
      setFormError(error instanceof Error ? error.message : 'failed to start session');
    } finally {
      startingRef.current = false;
    }
  }, [provider, cwd, prompt]);

  const handleRun = useCallback(async () => {
    setFormError(undefined);
    setTrustError(undefined);
    if (!cwd.trim()) {
      setFormError('working directory is required');
      return;
    }
    if (!prompt.trim()) {
      setFormError('prompt is required');
      return;
    }
    const inspectWorkspace = window.agentDock.inspectWorkspace;
    if (!inspectWorkspace) {
      setRunStatus('failed');
      setFormError('this desktop bridge does not support workspace trust');
      return;
    }
    setRunStatus('starting');
    try {
      const trust = await inspectWorkspace(cwd.trim());
      setWorkspaceTrust(trust);
      if (trust.state !== 'trusted') {
        setTrustPrompt(trust);
        return;
      }
      await startInteractiveSession();
    } catch (error) {
      setRunStatus('failed');
      setFormError(error instanceof Error ? error.message : 'failed to inspect workspace');
    }
  }, [cwd, prompt, startInteractiveSession]);

  const handleTrustAndRun = useCallback(async () => {
    if (!trustPrompt || !window.agentDock.setWorkspaceTrust) return;
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
    }
  }, [cwd, startInteractiveSession, trustPrompt]);

  const handleCancel = useCallback(async () => {
    if (!sessionId) return;
    try {
      await window.agentDock.cancelInteractiveSession(sessionId);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'failed to cancel session');
    }
  }, [sessionId]);

  const removeInteraction = useCallback((interactionHandle: string) => {
    setInteractions((current) =>
      current.filter((interaction) => interaction.interactionHandle !== interactionHandle),
    );
  }, []);

  const handleApproval = useCallback(
    async (decision: ApprovalDecisionV2) => {
      const interaction = interactions[0];
      if (!interaction || interaction.kind !== 'approval' || !window.agentDock.respondApproval)
        return;
      setInteractionBusy(true);
      setInteractionError(undefined);
      try {
        await window.agentDock.respondApproval(interaction.interactionHandle, decision);
      } catch (error) {
        setFormError(
          `${error instanceof Error ? error.message : 'approval response failed'}; the request will fail closed`,
        );
      } finally {
        removeInteraction(interaction.interactionHandle);
        setInteractionBusy(false);
      }
    },
    [interactions, removeInteraction],
  );

  const handleQuestions = useCallback(
    async (answers: RendererQuestionResponse['answers']) => {
      const interaction = interactions[0];
      if (!interaction || interaction.kind !== 'question' || !window.agentDock.answerQuestions)
        return;
      setInteractionBusy(true);
      setInteractionError(undefined);
      try {
        await window.agentDock.answerQuestions(interaction.interactionHandle, answers);
      } catch (error) {
        setFormError(
          `${error instanceof Error ? error.message : 'question response failed'}; the request will fail closed`,
        );
      } finally {
        removeInteraction(interaction.interactionHandle);
        setInteractionBusy(false);
      }
    },
    [interactions, removeInteraction],
  );

  const handleRevokeTrust = useCallback(async () => {
    if (!workspaceTrust || !window.agentDock.setWorkspaceTrust) return;
    setRevokingTrust(true);
    setFormError(undefined);
    try {
      const trust = await window.agentDock.setWorkspaceTrust(workspaceTrust.workspaceId, {
        cwd: cwd.trim(),
        incarnation: workspaceTrust.incarnation,
        state: 'untrusted',
      });
      setWorkspaceTrust(trust);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'failed to revoke workspace trust');
    } finally {
      setRevokingTrust(false);
    }
  }, [cwd, workspaceTrust]);

  const isRunning = runStatus === 'starting' || runStatus === 'running';
  const selectedProviderStatus = providers?.find((status) => status.id === provider);
  const canRun =
    daemonState === 'ready' &&
    !!selectedProviderStatus?.installed &&
    !isRunning &&
    cwd.trim().length > 0 &&
    prompt.trim().length > 0;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand__mark" aria-hidden="true">
            <AgentDockMark />
          </div>
          <div>
            <h1>AgentDock</h1>
            <p className="subtitle">A secure local runtime for CLI-authenticated AI agents</p>
          </div>
        </div>
        <div className={`runtime-state runtime-state--${daemonState}`}>
          <span className="runtime-state__dot" aria-hidden="true" />
          <span>Local runtime</span>
          <strong>{daemonState}</strong>
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
        <main className="workspace">
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
              {providers && <ProviderPanel providers={providers} />}
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
                  disabled={isRunning}
                >
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex</option>
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
                    disabled={isRunning}
                  />
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={isRunning}
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
                  disabled={isRunning}
                />
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
                >
                  Run
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={handleCancel}
                  disabled={runStatus !== 'running'}
                >
                  Cancel
                </button>
              </div>
            </section>
          </div>

          <section className="card card--session">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Normalized event stream</span>
                <h2>Session</h2>
              </div>
              <span className={`status status--${runStatus}`} aria-live="polite">
                {runStatus}
              </span>
            </div>
            <EventLog events={events} />
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
            setRunStatus('idle');
          }}
          onTrust={() => void handleTrustAndRun()}
        />
      )}
      {interactions[0] && (
        <InteractionDialog
          interaction={interactions[0]}
          busy={interactionBusy}
          error={interactionError}
          onApproval={(decision) => void handleApproval(decision)}
          onQuestions={(answers) => void handleQuestions(answers)}
          onCancelSession={() => void handleCancel()}
        />
      )}
    </div>
  );
}
