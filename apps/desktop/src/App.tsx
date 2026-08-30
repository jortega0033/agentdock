import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, ProviderId, ProviderStatus } from '@agent-dock/shared';
import { ProviderPanel } from './components/ProviderPanel.js';
import { EventLog } from './components/EventLog.js';
import { AgentDockMark } from './components/AgentDockMark.js';
import runtimeUnavailableIllustration from '../assets/illustrations/runtime-unavailable.svg';

type DaemonState = 'connecting' | 'ready' | 'unavailable';
type RunStatus = 'idle' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

const DAEMON_CONNECT_TIMEOUT_MS = 20_000;

export function App() {
  const [daemonState, setDaemonState] = useState<DaemonState>('connecting');
  const [daemonError, setDaemonError] = useState<string>();

  const [providers, setProviders] = useState<ProviderStatus[]>();
  const [providersError, setProvidersError] = useState<string>();

  const [provider, setProvider] = useState<ProviderId>('claude');
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [formError, setFormError] = useState<string>();

  const [runStatus, setRunStatus] = useState<RunStatus>('idle');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  // Mirrors `sessionId` so the onSessionEvent subscription (set up once, below) always filters
  // against the current session without needing to resubscribe. A stale closure here would
  // silently drop events for a session started after the initial subscription.
  const sessionIdRef = useRef<string>();

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
    window.agentDock
      .listProviders()
      .then(setProviders)
      .catch((err: Error) => setProvidersError(err.message));
  }, [daemonState]);

  // One subscription for the whole component lifetime; events are filtered to the session this
  // render currently cares about. main.ts only ever streams one session at a time in this demo.
  useEffect(() => {
    return window.agentDock.onSessionEvent((eventSessionId, event) => {
      if (sessionIdRef.current !== eventSessionId) return;
      setEvents((prev) => [...prev, event]);
      if (event.type === 'session.completed') setRunStatus('completed');
      else if (event.type === 'session.failed') setRunStatus('failed');
      else if (event.type === 'session.cancelled') setRunStatus('cancelled');
    });
  }, []);

  const handleRun = useCallback(async () => {
    setFormError(undefined);

    if (!cwd.trim()) {
      setFormError('working directory is required');
      return;
    }
    if (!prompt.trim()) {
      setFormError('prompt is required');
      return;
    }

    setEvents([]);
    setRunStatus('starting');

    try {
      const session = await window.agentDock.createSession({ provider, cwd, prompt });
      sessionIdRef.current = session.id;
      setSessionId(session.id);
      setRunStatus('running');
    } catch (err) {
      setRunStatus('failed');
      setFormError(err instanceof Error ? err.message : 'failed to start session');
    }
  }, [provider, cwd, prompt]);

  const handleCancel = useCallback(async () => {
    if (!sessionId) return;
    try {
      await window.agentDock.cancelSession(sessionId);
    } catch {
      // the session-event stream will still reflect the true terminal state
    }
  }, [sessionId]);

  const isRunning = runStatus === 'starting' || runStatus === 'running';
  const selectedProviderStatus = providers?.find((p) => p.id === provider);
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
                  onChange={(e) => setProvider(e.target.value as ProviderId)}
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
                    onChange={(e) => setCwd(e.target.value)}
                    placeholder="/path/to/project"
                    disabled={isRunning}
                  />
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={isRunning}
                    onClick={async () => {
                      const dir = await window.agentDock.selectDirectory();
                      if (dir) setCwd(dir);
                    }}
                  >
                    Browse
                  </button>
                </div>
              </label>

              <label>
                Prompt
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={5}
                  placeholder="Describe the task for your agent…"
                  disabled={isRunning}
                />
              </label>

              {formError && <div className="banner banner--error">{formError}</div>}

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
              <span className={`status status--${runStatus}`}>{runStatus}</span>
            </div>
            <EventLog events={events} />
          </section>
        </main>
      )}
    </div>
  );
}
