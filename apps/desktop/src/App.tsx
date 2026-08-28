import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, ProviderId, ProviderStatus } from '@agent-dock/shared';
import { ProviderPanel } from './components/ProviderPanel.js';
import { EventLog } from './components/EventLog.js';

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
  // against the current session without needing to resubscribe — a stale closure here would
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
    <div className="app">
      <h1>Agent Dock</h1>
      <p className="subtitle">Boilerplate desktop client for CLI-authenticated AI agents</p>

      {daemonState === 'connecting' && <div className="banner banner--info">Connecting to local daemon…</div>}
      {daemonState === 'unavailable' && (
        <div className="banner banner--error">Daemon unavailable: {daemonError ?? 'unknown error'}</div>
      )}

      {daemonState === 'ready' && (
        <>
          <section>
            <h2>Providers</h2>
            {providersError && <div className="banner banner--error">{providersError}</div>}
            {providers && <ProviderPanel providers={providers} />}
          </section>

          <section>
            <h2>Run</h2>
            <label>
              Provider
              <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)} disabled={isRunning}>
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
                rows={4}
                disabled={isRunning}
              />
            </label>

            {formError && <div className="banner banner--error">{formError}</div>}

            <div className="row">
              <button type="button" onClick={handleRun} disabled={!canRun}>
                Run
              </button>
              <button type="button" onClick={handleCancel} disabled={runStatus !== 'running'}>
                Cancel
              </button>
            </div>
          </section>

          <section>
            <h2>
              Session status: <span className={`status status--${runStatus}`}>{runStatus}</span>
            </h2>
            <EventLog events={events} />
          </section>
        </>
      )}
    </div>
  );
}
