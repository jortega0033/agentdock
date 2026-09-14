import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventHistorySearchV2Page } from '@agent-dock/shared';
import { SessionSearchPanel } from '../src/components/SessionSearchPanel.js';
import { clearBridgeOverride, setBridgeOverride } from '../src/bridge.js';
import type { AgentDockBridge } from '../src/window.js';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

function installSearchBridge(
  handler: (query: string) => EventHistorySearchV2Page | Promise<EventHistorySearchV2Page>,
): ReturnType<typeof vi.fn> {
  const searchInteractiveSessionHistory = vi.fn(async ({ query }: { query: string }) =>
    handler(query),
  );
  setBridgeOverride({
    searchInteractiveSessionHistory,
  } as unknown as AgentDockBridge);
  return searchInteractiveSessionHistory;
}

afterEach(() => {
  clearBridgeOverride();
});

describe('SessionSearchPanel', () => {
  it('runs a search on submit and renders bounded excerpt results', async () => {
    const search = installSearchBridge(() => ({
      matches: [
        {
          sessionId: SESSION_ID,
          executionId: '123e4567-e89b-42d3-a456-426614174001',
          sequence: 3,
          type: 'error',
          timestamp: '2026-08-31T00:00:00.000Z',
          excerpt: 'connection reset by peer',
        },
      ],
    }));
    const onOpenResult = vi.fn();
    render(<SessionSearchPanel onOpenResult={onOpenResult} />);

    fireEvent.change(screen.getByLabelText('Search session history'), {
      target: { value: 'connection reset' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(screen.getByText('connection reset by peer')).toBeInTheDocument());
    expect(search).toHaveBeenCalledWith({ query: 'connection reset' });

    fireEvent.click(screen.getByText('connection reset by peer'));
    expect(onOpenResult).toHaveBeenCalledWith(SESSION_ID, 3);
  });

  it('shows an explicit empty state distinct from not-yet-searched', async () => {
    installSearchBridge(() => ({ matches: [] }));
    render(<SessionSearchPanel onOpenResult={vi.fn()} />);

    expect(screen.queryByText(/No matches/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search session history'), {
      target: { value: 'no such literal' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() =>
      expect(screen.getByText('No matches in retained session history.')).toBeInTheDocument(),
    );
  });

  it('surfaces a search failure as an alert without crashing', async () => {
    installSearchBridge(() => {
      throw new Error('daemon unreachable');
    });
    render(<SessionSearchPanel onOpenResult={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Search session history'), {
      target: { value: 'anything' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('daemon unreachable'));
  });

  it('does not search on an empty or whitespace-only query', () => {
    const search = installSearchBridge(() => ({ matches: [] }));
    render(<SessionSearchPanel onOpenResult={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Search session history'), {
      target: { value: '   ' },
    });
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
    expect(search).not.toHaveBeenCalled();
  });
});
