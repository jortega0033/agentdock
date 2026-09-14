import { useState } from 'react';
import type { EventHistorySearchV2Match } from '@agent-dock/shared';
import { getBridge } from '../bridge.js';

/**
 * A bounded, read-only literal search over already-retained normalized session history (issue
 * #131). Selecting a result asks the caller to open that session and jump to the matched event;
 * this component owns only the query/results state, not session navigation itself.
 */
export function SessionSearchPanel({
  onOpenResult,
}: {
  onOpenResult: (sessionId: string, sequence: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<EventHistorySearchV2Match[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const runSearch = async (): Promise<void> => {
    const trimmed = query.trim();
    if (!trimmed) {
      setMatches(undefined);
      setError(undefined);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const page = await getBridge().searchInteractiveSessionHistory({ query: trimmed });
      setMatches(page.matches);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'search failed');
      setMatches(undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="session-search-panel">
      <form
        className="row row--spread"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
      >
        <label className="session-search-panel__field">
          Search history
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a prior run by error, symbol, or output"
            aria-label="Search session history"
          />
        </label>
        <button type="submit" disabled={busy || query.trim().length === 0}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>
      {error ? (
        <div className="banner banner--error" role="alert">
          {error}
        </div>
      ) : null}
      {matches ? (
        matches.length === 0 ? (
          <p className="form-hint">No matches in retained session history.</p>
        ) : (
          <ul className="session-search-results" aria-label="Search results">
            {matches.map((match) => (
              <li key={`${match.sessionId}:${match.sequence}`}>
                <button
                  type="button"
                  className="session-search-result"
                  onClick={() => onOpenResult(match.sessionId, match.sequence)}
                >
                  <span className="session-search-result__excerpt">{match.excerpt}</span>
                  <span className="session-search-result__meta">
                    {match.type}
                    {match.timestamp ? ` · ${new Date(match.timestamp).toLocaleString()}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
