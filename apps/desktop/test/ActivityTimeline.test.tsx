import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEventV2Envelope } from '@agent-dock/shared';
import { ActivityTimeline } from '../src/components/activity/ActivityTimeline.js';
import type { TimelineEventInput } from '../src/components/activity/types.js';

const meta = {
  sessionId: '123e4567-e89b-42d3-a456-426614174000',
  executionId: '123e4567-e89b-42d3-a456-426614174001',
  turnId: '123e4567-e89b-42d3-a456-426614174002',
  timestamp: '2026-08-31T00:00:00.000Z',
};

function event(
  type: string,
  sequence: number,
  values: Record<string, unknown> = {},
): TimelineEventInput {
  return { ...meta, type, sequence, ...values };
}

describe('ActivityTimeline', () => {
  it('shows an accessible empty state', () => {
    render(<ActivityTimeline events={[]} />);
    expect(screen.getByText('No activity yet.')).toBeInTheDocument();
  });

  it('renders plans, usage, and unknown payloads as inert bounded content', () => {
    const malicious = '<img src=x onerror="window.pwned=true"><script>alert(1)</script>';
    render(
      <ActivityTimeline
        events={[
          event('session.started', 0, {
            provider: 'codex',
            transport: 'app-server',
            selection: { enabled: ['tools'] },
          }),
          event('content.completed', 0, {
            block: {
              type: 'plan',
              id: '123e4567-e89b-42d3-a456-426614174003',
              title: 'Ship safely',
              steps: [
                {
                  id: '123e4567-e89b-42d3-a456-426614174004',
                  text: 'Run tests',
                  status: 'in_progress',
                },
              ],
            },
          }),
          event('usage.tokens', 1, { scope: 'turn', inputTokens: 12, outputTokens: 7 }),
          event('content.completed', 2, {
            block: {
              type: 'future_content',
              id: '123e4567-e89b-42d3-a456-426614174005',
              safe: malicious,
            },
          }),
          {
            type: 'vendor.future_event',
            sequence: 3,
            summary: malicious,
            payload: { href: 'javascript:alert(1)' },
          },
        ]}
      />,
    );

    expect(screen.getByText('Ship safely')).toBeInTheDocument();
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('app-server')).toBeInTheDocument();
    expect(screen.getByText('Run tests')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText(malicious)).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByLabelText('Bounded payload')).toBeInTheDocument();
    expect(screen.getByLabelText('Content details')).toBeInTheDocument();
  });

  it('coalesces streaming content and replaces it with the completed block', () => {
    const contentBlockId = '123e4567-e89b-42d3-a456-426614174003';
    render(
      <ActivityTimeline
        events={[
          event('content.delta', 0, { contentBlockId, delta: 'draft ' }),
          event('content.delta', 1, { contentBlockId, delta: 'answer' }),
          event('content.completed', 2, {
            block: { type: 'text', id: contentBlockId, text: 'final answer' },
          }),
        ]}
      />,
    );

    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByText('final answer')).toBeInTheDocument();
    expect(screen.queryByText('draft answer')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Assistant message\. Completed/)).toBeInTheDocument();
  });

  it('focuses a new blocking interaction once without repeatedly stealing focus', async () => {
    const approval = event('approval.requested', 0, {
      requestId: '123e4567-e89b-42d3-a456-426614174003',
      title: 'Run command?',
      action: 'Execute tests',
      target: 'pnpm test',
      deadlineAt: '2026-08-31T00:01:00.000Z',
    });
    const { rerender } = render(
      <>
        <button type="button">Outside</button>
        <ActivityTimeline events={[approval]} />
      </>,
    );

    const card = screen.getByLabelText(/Run command\?.*Action required/);
    await waitFor(() => expect(card).toHaveFocus());
    screen.getByRole('button', { name: 'Outside' }).focus();
    rerender(
      <>
        <button type="button">Outside</button>
        <ActivityTimeline events={[approval, event('session.status', 1, { status: 'active' })]} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Outside' })).toHaveFocus();
  });

  it('scrolls to and focuses the item matching focusSequence, once, when present (issue #131)', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const events = [
      event('session.started', 0, { provider: 'codex', transport: 'fake', selection: {} }),
      event('session.status', 1, { status: 'active' }),
      event('session.status', 2, { status: 'active' }),
    ];
    const { rerender } = render(<ActivityTimeline events={events} focusSequence={1} />);

    await waitFor(() => {
      const cards = screen.getAllByRole('article');
      expect(cards[1]).toHaveFocus();
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    screen.getAllByRole('article')[0]?.focus();
    rerender(<ActivityTimeline events={events} focusSequence={1} />);
    expect(screen.getAllByRole('article')[0]).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('still focuses the matched event when a later jump reuses the same sequence number in a different session (issue #131 review finding)', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const sessionAEvents = [
      event('session.started', 0, { provider: 'codex', transport: 'fake', selection: {} }),
      event('session.status', 1, { status: 'active' }),
    ];
    const otherMeta = {
      sessionId: '923e4567-e89b-42d3-a456-426614174000',
      executionId: '923e4567-e89b-42d3-a456-426614174001',
      timestamp: '2026-08-31T00:00:00.000Z',
    };
    const sessionBEvents: TimelineEventInput[] = [
      { ...otherMeta, type: 'session.started', sequence: 0, provider: 'claude', transport: 'fake', selection: {} },
      { ...otherMeta, type: 'session.status', sequence: 1, status: 'active' },
    ];

    const { rerender } = render(<ActivityTimeline events={sessionAEvents} focusSequence={1} />);
    await waitFor(() => expect(screen.getAllByRole('article')[1]).toHaveFocus());

    // Switching to a different session whose own event log also has a sequence 1 -- the guard
    // must key on the resolved item's identity, not the bare sequence number, or this second jump
    // silently does nothing (the bug an independent review of this issue's PR caught).
    rerender(<ActivityTimeline events={sessionBEvents} focusSequence={1} />);
    await waitFor(() => expect(screen.getAllByRole('article')[1]).toHaveFocus());
  });

  it('does nothing when focusSequence has no matching retained event', () => {
    render(
      <ActivityTimeline
        events={[event('session.started', 0, { provider: 'codex', transport: 'fake', selection: {} })]}
        focusSequence={999}
      />,
    );
    expect(document.activeElement).toBe(document.body);
  });

  it('supports arrow, Home, and End navigation between cards', () => {
    render(
      <ActivityTimeline
        events={[
          event('session.started', 0, { provider: 'codex', transport: 'fake', selection: {} }),
          event('session.completed', 1),
        ]}
      />,
    );
    const cards = screen.getAllByRole('article');
    cards[0]?.focus();
    fireEvent.keyDown(cards[0]!, { key: 'ArrowDown' });
    expect(cards[1]).toHaveFocus();
    fireEvent.keyDown(cards[1]!, { key: 'Home' });
    expect(cards[0]).toHaveFocus();
    fireEvent.keyDown(cards[0]!, { key: 'End' });
    expect(cards[1]).toHaveFocus();
  });

  it('announces the lifecycle item changed by the newest event', async () => {
    const toolCallId = '123e4567-e89b-42d3-a456-426614174030';
    const contentBlockId = '123e4567-e89b-42d3-a456-426614174031';
    const started = event('tool.started', 0, {
      toolCallId,
      contentBlockId,
      toolName: 'shell',
      possibleEffects: ['command'],
      effectsComplete: true,
    });
    const status = event('session.status', 1, { status: 'active' });
    const { container, rerender } = render(<ActivityTimeline events={[started, status]} />);

    rerender(
      <ActivityTimeline
        events={[
          started,
          status,
          event('tool.completed', 2, {
            toolCallId,
            contentBlockId,
            toolName: 'shell',
            status: 'completed',
            summary: 'done',
          }),
        ]}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector('.activity-visually-hidden')).toHaveTextContent(
        'Tool: shell. Completed',
      ),
    );
  });

  it('bounds oversized values and exposes copy and export actions', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<ActivityTimeline events={[{ type: 'vendor.large', payload: 'x'.repeat(30_000) }]} />);

    expect(screen.getAllByText(/truncated/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0]?.[0].length).toBeLessThanOrEqual(16_400);
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
  });

  it('renders attachment, structured, command, diff, and extension content safely', () => {
    render(
      <ActivityTimeline
        events={[
          event('content.completed', 0, {
            block: {
              type: 'image',
              id: '123e4567-e89b-42d3-a456-426614174010',
              attachmentId: '123e4567-e89b-42d3-a456-426614174011',
              name: 'preview.png',
              mimeType: 'image/png',
              byteLength: 2048,
              alt: 'Generated preview',
            },
          }),
          event('content.completed', 1, {
            block: {
              type: 'file',
              id: '123e4567-e89b-42d3-a456-426614174012',
              attachmentId: '123e4567-e89b-42d3-a456-426614174013',
              name: 'report.txt',
              mimeType: 'text/plain',
              byteLength: 512,
            },
          }),
          event('content.completed', 2, {
            block: {
              type: 'structured_data',
              id: '123e4567-e89b-42d3-a456-426614174014',
              data: { result: 'safe' },
            },
          }),
          event('content.completed', 3, {
            block: {
              type: 'tool_activity',
              id: '123e4567-e89b-42d3-a456-426614174015',
              toolCallId: '123e4567-e89b-42d3-a456-426614174016',
              toolName: 'Bash',
              status: 'completed',
              possibleEffects: ['command'],
              effectsComplete: true,
              resultSummary: 'Tests passed',
            },
          }),
          event('content.completed', 4, {
            block: {
              type: 'tool_activity',
              id: '123e4567-e89b-42d3-a456-426614174017',
              toolCallId: '123e4567-e89b-42d3-a456-426614174018',
              toolName: 'EditFile',
              status: 'completed',
              possibleEffects: ['write'],
              effectsComplete: true,
              resultSummary: 'Updated one file',
              patch: '-old\n+new',
            },
          }),
          event('content.completed', 5, {
            block: {
              type: 'provider_extension',
              id: '123e4567-e89b-42d3-a456-426614174019',
              extensionName: 'vendor.trace',
              representation: 'bounded_data',
              safeSummary: 'Trace summary',
              safeToPersist: true,
              data: { spanCount: 3 },
            },
          }),
        ]}
      />,
    );

    expect(screen.getByText('preview.png')).toBeInTheDocument();
    expect(screen.getByText('Generated preview')).toBeInTheDocument();
    expect(screen.getByText('report.txt')).toBeInTheDocument();
    expect(screen.getByLabelText('Structured data')).toHaveTextContent('safe');
    expect(screen.getByLabelText('Command details')).toHaveTextContent('Bash');
    expect(screen.getByLabelText('File changes')).toHaveTextContent('EditFile');
    expect(screen.getByLabelText('Extension data')).toHaveTextContent('vendor.trace');
  });

  it("renders a tool.completed event's preserved output as a dedicated attachment, not inline generic JSON (issue #132)", () => {
    render(
      <ActivityTimeline
        events={[
          event('tool.completed', 0, {
            toolCallId: '123e4567-e89b-42d3-a456-426614174020',
            contentBlockId: '123e4567-e89b-42d3-a456-426614174021',
            toolName: 'command',
            status: 'completed',
            summary: 'Command completed with exit code 0',
            output: {
              attachmentId: '123e4567-e89b-42d3-a456-426614174022',
              mimeType: 'text/plain',
              byteCount: 9_001,
              sha256: 'deadbeef',
              preview: 'build log preview line one\n',
              previewTruncated: true,
            },
          }),
        ]}
      />,
    );

    expect(screen.getByLabelText('Tool output')).toHaveTextContent('build log preview line one');
    expect(screen.getByText('9,001 bytes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load full output' })).toBeInTheDocument();
    // The generic details dump must not also show the raw output object -- it's superseded by
    // the dedicated view above, not duplicated alongside it.
    expect(screen.queryByText(/attachmentId/)).not.toBeInTheDocument();
  });

  it('labels denied, cancelled, and resolved interactions by their terminal states', () => {
    const approvalRequestId = '123e4567-e89b-42d3-a456-426614174020';
    const cancelledQuestionId = '123e4567-e89b-42d3-a456-426614174021';
    const answeredQuestionId = '123e4567-e89b-42d3-a456-426614174022';
    render(
      <ActivityTimeline
        events={[
          event('approval.requested', 0, {
            requestId: approvalRequestId,
            title: 'Delete generated file?',
            action: 'Delete file',
            target: 'output.tmp',
          }),
          event('approval.resolved', 1, {
            requestId: approvalRequestId,
            decision: 'denied',
            actor: 'user',
          }),
          event('question.requested', 2, { requestId: cancelledQuestionId, questions: [] }),
          event('question.cancelled', 3, { requestId: cancelledQuestionId, reason: 'timeout' }),
          event('question.requested', 4, { requestId: answeredQuestionId, questions: [] }),
          event('question.resolved', 5, { requestId: answeredQuestionId, answers: [] }),
        ]}
      />,
    );

    expect(screen.getByLabelText('Approval denied. Failed')).toBeInTheDocument();
    expect(screen.getByLabelText('Question cancelled. Cancelled')).toBeInTheDocument();
    expect(screen.getByLabelText('Question answered. Completed')).toBeInTheDocument();
  });

  it('never displays native correlation IDs or answer values from valid v2 interactions', () => {
    const approvalRequestId = '123e4567-e89b-42d3-a456-426614174029';
    const requestId = '123e4567-e89b-42d3-a456-426614174030';
    const questionId = '123e4567-e89b-42d3-a456-426614174031';
    const optionId = '123e4567-e89b-42d3-a456-426614174032';
    const events: AgentEventV2Envelope[] = [
      {
        ...meta,
        sequence: 0,
        type: 'approval.requested',
        requestId: approvalRequestId,
        title: 'Run deployment',
        action: 'deploy',
        target: 'staging',
        possibleEffects: ['command'],
        effectsComplete: true,
        allowedDecisions: ['allow_once', 'deny'],
        deadlineAt: '2026-08-31T00:01:00.000Z',
      },
      {
        ...meta,
        sequence: 1,
        type: 'approval.resolved',
        requestId: approvalRequestId,
        decision: 'allowed',
        actor: 'user',
      },
      {
        ...meta,
        sequence: 2,
        type: 'question.requested',
        requestId,
        deadlineAt: '2026-08-31T00:01:00.000Z',
        questions: [
          {
            id: questionId,
            title: 'Deployment',
            prompt: 'Choose a target',
            options: [{ id: optionId, label: 'Staging' }],
            allowsFreeText: false,
          },
        ],
      },
      {
        ...meta,
        sequence: 3,
        type: 'question.resolved',
        requestId,
        answers: [{ questionId, value: optionId }],
      },
    ];

    const { container } = render(<ActivityTimeline events={events} />);

    expect(screen.getByText('Deployment')).toBeInTheDocument();
    expect(screen.getByText('Staging')).toBeInTheDocument();
    expect(container).not.toHaveTextContent(requestId);
    expect(container).not.toHaveTextContent(questionId);
    expect(container).not.toHaveTextContent(optionId);
    expect(container.innerHTML).not.toContain(approvalRequestId);
    expect(container.innerHTML).not.toContain(requestId);
    expect(container.innerHTML).not.toContain(questionId);
    expect(container.innerHTML).not.toContain(optionId);
  });

  it('does not move focus when blocking-card focus is disabled', async () => {
    const approval = event('approval.requested', 0, {
      requestId: '123e4567-e89b-42d3-a456-426614174023',
      title: 'Run command?',
      action: 'Execute tests',
      target: 'pnpm test',
    });
    render(
      <>
        <button type="button" autoFocus>
          Security dialog control
        </button>
        <ActivityTimeline events={[approval]} focusBlockingCards={false} />
      </>,
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Security dialog control' })).toHaveFocus(),
    );
  });

  it('shows a context-pressure signal only when both current and capacity are present (issue #129)', () => {
    const { rerender } = render(
      <ActivityTimeline
        events={[
          event('usage.tokens', 0, {
            scope: 'turn',
            inputTokens: 100,
            contextTokens: 62_000,
            contextWindowTokens: 272_000,
          }),
        ]}
      />,
    );
    expect(screen.getByText('62,000 / 272,000')).toBeInTheDocument();

    rerender(
      <ActivityTimeline
        events={[
          event('usage.tokens', 0, { scope: 'turn', inputTokens: 100, contextTokens: 62_000 }),
        ]}
      />,
    );
    expect(screen.queryByText(/272,000/)).not.toBeInTheDocument();
    expect(screen.queryByText('Context', { exact: false })).not.toBeInTheDocument();
  });

  it('renders a primary-only rate-limit window with utilization, duration, and reset time', () => {
    render(
      <ActivityTimeline
        events={[
          event('usage.rate_limits', 0, {
            scope: 'session',
            limitName: '5h window',
            primary: { usedPercent: 82, windowDurationMins: 300, resetsAt: 1_700_000_000 },
          }),
        ]}
      />,
    );

    expect(screen.getByText('5h window')).toBeInTheDocument();
    expect(screen.getByText('Primary window (300 min window)')).toBeInTheDocument();
    expect(screen.getByText('82% used · 18% remaining')).toBeInTheDocument();
    expect(screen.queryByText('Secondary window', { exact: false })).not.toBeInTheDocument();
    const resetTime = screen.getByText(new Date(1_700_000_000 * 1000).toLocaleString());
    expect(resetTime.tagName).toBe('TIME');
    expect(resetTime).toHaveAttribute('dateTime', new Date(1_700_000_000 * 1000).toISOString());
  });

  it('renders a secondary-only event distinctly without fabricating a primary window', () => {
    render(
      <ActivityTimeline
        events={[event('usage.rate_limits', 0, { scope: 'session', secondary: { usedPercent: 7 } })]}
      />,
    );

    expect(screen.getByText('Secondary window')).toBeInTheDocument();
    expect(screen.getByText('7% used · 93% remaining')).toBeInTheDocument();
    expect(screen.queryByText('Primary window', { exact: false })).not.toBeInTheDocument();
  });

  it('renders dual windows in stable primary-then-secondary order', () => {
    const { container } = render(
      <ActivityTimeline
        events={[
          event('usage.rate_limits', 0, {
            scope: 'session',
            primary: { usedPercent: 10 },
            secondary: { usedPercent: 20 },
          }),
        ]}
      />,
    );

    const labels = Array.from(container.querySelectorAll('.activity-rate-limit-window h4')).map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(['Primary window', 'Secondary window']);
  });

  it.each([
    [0, '0% used', '100% remaining'],
    [82, '82% used', '18% remaining'],
    [100, '100% used', '0% remaining'],
    [120, '120% used', '0% remaining'],
  ])('preserves reported usedPercent %d as text without clamping', (usedPercent, usedText, headroomText) => {
    const { container } = render(
      <ActivityTimeline
        events={[
          event('usage.rate_limits', 0, { scope: 'session', primary: { usedPercent } }),
        ]}
      />,
    );

    expect(screen.getByText(`${usedText} · ${headroomText}`)).toBeInTheDocument();
    const fill = container.querySelector('.activity-rate-limit-meter__fill') as HTMLElement;
    const width = Number.parseFloat(fill.style.width);
    expect(width).toBeGreaterThanOrEqual(0);
    expect(width).toBeLessThanOrEqual(100);
  });

  it('fails safely to an unavailable state for invalid reset/utilization inputs instead of throwing', () => {
    expect(() =>
      render(
        <ActivityTimeline
          events={[
            event('usage.rate_limits', 0, {
              scope: 'session',
              primary: { usedPercent: 50, resetsAt: -5 },
              secondary: { usedPercent: Number.NaN },
            }),
          ]}
        />,
      ),
    ).not.toThrow();

    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(screen.getByText('Utilization unavailable')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('NaN');
    expect(document.body.innerHTML).not.toContain('Infinity');
    expect(document.body.innerHTML).not.toContain('Invalid Date');
  });

  it('keeps provider labels as escaped text and does not claim a current reset after a frozen replay', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    try {
      const malicious = '<img src=x onerror="window.pwned=true">5h window';
      render(
        <ActivityTimeline
          events={[
            event('usage.rate_limits', 0, {
              scope: 'session',
              limitName: malicious,
              primary: { usedPercent: 99, resetsAt: 1_700_000_000 },
            }),
          ]}
        />,
      );

      expect(screen.getByText(malicious)).toBeInTheDocument();
      expect(document.querySelector('img')).toBeNull();
      // A resolved-in-the-past reset stays a historical observation, not a live 0%/reset claim.
      expect(screen.getByText('99% used · 1% remaining')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
