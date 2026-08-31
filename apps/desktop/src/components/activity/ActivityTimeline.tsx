import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { projectActivityTimeline } from './model.js';
import { SafePayload } from './SafePayload.js';
import type { ActivityTimelineItem, SafeActivityValue, TimelineEventInput } from './types.js';
import emptyEventsIllustration from '../../../assets/illustrations/empty-events.svg';
import './activity-timeline.css';

type SafeRecord = Readonly<Record<string, SafeActivityValue>>;

function isRecord(value: SafeActivityValue | undefined): value is SafeRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function textValue(record: SafeRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberValue(record: SafeRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' ? value : undefined;
}

function arrayValue(record: SafeRecord | undefined, key: string): readonly SafeActivityValue[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

function humanStatus(state: ActivityTimelineItem['state']): string {
  switch (state) {
    case 'streaming':
      return 'Streaming';
    case 'running':
      return 'Running';
    case 'pending':
      return 'Needs attention';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'interrupted':
      return 'Interrupted';
    default:
      return 'Information';
  }
}

function itemDataWithout(
  item: ActivityTimelineItem,
  omitted: readonly string[],
): SafeActivityValue | undefined {
  if (!isRecord(item.data)) return item.data;
  const result: Record<string, SafeActivityValue> = {};
  for (const [key, value] of Object.entries(item.data))
    if (!omitted.includes(key)) result[key] = value;
  return Object.keys(result).length === 0 ? undefined : result;
}

function DetailList({
  entries,
}: {
  entries: ReadonlyArray<readonly [string, string | number | undefined]>;
}) {
  const visible = entries.filter(
    (entry): entry is readonly [string, string | number] => entry[1] !== undefined,
  );
  if (visible.length === 0) return null;
  return (
    <dl className="activity-details">
      {visible.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PlanContent({ data }: { data: SafeRecord }) {
  const steps = arrayValue(data, 'steps');
  return (
    <ol className="activity-plan" aria-label="Plan steps">
      {steps.map((step, index) => {
        const record = isRecord(step) ? step : undefined;
        const status = textValue(record, 'status') ?? 'pending';
        return (
          <li
            key={`${textValue(record, 'id') ?? 'step'}-${index}`}
            className={`activity-plan__step activity-plan__step--${status}`}
          >
            <span aria-hidden="true" className="activity-plan__marker" />
            <span>{textValue(record, 'text') ?? String(step)}</span>
            <span className="activity-badge">{status.replaceAll('_', ' ')}</span>
          </li>
        );
      })}
    </ol>
  );
}

function QuestionContent({ data }: { data: SafeRecord }) {
  const questions = arrayValue(data, 'questions');
  if (questions.length === 0) return null;
  return (
    <div className="activity-questions">
      {questions.map((question, index) => {
        const record = isRecord(question) ? question : undefined;
        const options = arrayValue(record, 'options');
        return (
          <section
            key={`${textValue(record, 'id') ?? 'question'}-${index}`}
            aria-label={textValue(record, 'title') ?? `Question ${index + 1}`}
          >
            <strong>{textValue(record, 'title') ?? `Question ${index + 1}`}</strong>
            <p>{textValue(record, 'prompt') ?? 'No question text supplied.'}</p>
            {options.length > 0 ? (
              <ul>
                {options.map((option, optionIndex) => {
                  const optionRecord = isRecord(option) ? option : undefined;
                  return (
                    <li key={`${textValue(optionRecord, 'id') ?? 'option'}-${optionIndex}`}>
                      {textValue(optionRecord, 'label') ?? String(option)}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function CoreContent({ item }: { item: ActivityTimelineItem }) {
  const data = isRecord(item.data) ? item.data : undefined;
  const contentType = textValue(data, 'type');

  if (contentType === 'plan') return <PlanContent data={data!} />;

  if (contentType === 'image' || contentType === 'file') {
    return (
      <DetailList
        entries={[
          ['Name', textValue(data, 'name')],
          ['Media type', textValue(data, 'mimeType')],
          ['Size', numberValue(data, 'byteLength')],
          ['Description', textValue(data, 'alt')],
        ]}
      />
    );
  }

  if (contentType === 'structured_data') {
    return (
      <SafePayload value={data?.data} label="Structured data" filename="structured-data.json" />
    );
  }

  if (contentType === 'provider_extension') {
    return <SafePayload value={item.data} label="Extension data" filename="extension-data.json" />;
  }

  if (item.category === 'content' && contentType !== undefined && contentType !== 'text') {
    return (
      <SafePayload value={item.data} label="Content details" filename="content-details.json" />
    );
  }

  if (item.category === 'session' || item.category === 'status') {
    const remaining = itemDataWithout(item, ['provider', 'transport', 'status']);
    return (
      <>
        <DetailList
          entries={[
            ['Provider', textValue(data, 'provider')],
            ['Transport', textValue(data, 'transport')],
            ['Status', textValue(data, 'status')],
          ]}
        />
        {remaining !== undefined ? (
          <SafePayload value={remaining} label="Session details" filename="session-details.json" />
        ) : null}
      </>
    );
  }

  if (item.category === 'turn') {
    const remaining = itemDataWithout(item, ['message', 'reason']);
    return remaining === undefined ? null : (
      <SafePayload value={remaining} label="Turn details" filename="turn-details.json" />
    );
  }

  if (item.category === 'approval') {
    return (
      <>
        <DetailList
          entries={[
            ['Target', textValue(data, 'target')],
            ['Reason', textValue(data, 'reason')],
            ['Decision', textValue(data, 'decision')],
            ['Resolved by', textValue(data, 'actor')],
            ['Deadline', textValue(data, 'deadlineAt')],
          ]}
        />
        {itemDataWithout(item, [
          'title',
          'action',
          'target',
          'reason',
          'decision',
          'actor',
          'deadlineAt',
        ]) !== undefined ? (
          <SafePayload
            value={itemDataWithout(item, [
              'title',
              'action',
              'target',
              'reason',
              'decision',
              'actor',
              'deadlineAt',
            ])}
            label="Approval details"
            filename="approval-details.json"
          />
        ) : null}
      </>
    );
  }

  if (item.category === 'question') {
    return (
      <>
        <QuestionContent data={data ?? {}} />
        {item.state !== 'pending' && item.data !== undefined ? (
          <SafePayload value={item.data} label="Question result" filename="question-result.json" />
        ) : null}
      </>
    );
  }

  if (item.category === 'usage') {
    return (
      <DetailList
        entries={[
          ['Scope', textValue(data, 'scope')],
          ['Input tokens', numberValue(data, 'inputTokens')],
          ['Cached input tokens', numberValue(data, 'cachedInputTokens')],
          ['Output tokens', numberValue(data, 'outputTokens')],
          ['Cost', numberValue(data, 'cost')],
          ['Currency', textValue(data, 'currency')],
        ]}
      />
    );
  }

  if (item.category === 'tool') {
    const toolName = textValue(data, 'toolName') ?? item.title;
    const isCommand = /(?:command|shell|bash|powershell|terminal|exec)/iu.test(toolName);
    const isDiff =
      /(?:diff|patch|file.?change|edit)/iu.test(toolName) ||
      data?.diff !== undefined ||
      data?.patch !== undefined;
    return item.data === undefined ? null : (
      <SafePayload
        value={item.data}
        label={isDiff ? 'File changes' : isCommand ? 'Command details' : 'Tool details'}
        filename={isDiff ? 'activity.diff' : isCommand ? 'command-output.txt' : 'tool-details.json'}
        code={isDiff || isCommand}
      />
    );
  }

  if (item.category === 'unknown' || item.category === 'extension') {
    return item.data === undefined ? null : (
      <SafePayload value={item.data} label="Bounded payload" filename="activity-payload.json" />
    );
  }

  if (item.category === 'error') {
    return (
      <DetailList
        entries={[
          ['Code', textValue(data, 'code')],
          [
            'Recoverable',
            typeof data?.recoverable === 'boolean' ? (data.recoverable ? 'Yes' : 'No') : undefined,
          ],
        ]}
      />
    );
  }

  return null;
}

function ActivityCard({
  item,
  setRef,
}: {
  item: ActivityTimelineItem;
  setRef: (element: HTMLElement | null) => void;
}) {
  const status = humanStatus(item.state);
  const isBlocking = item.blocking;
  return (
    <article
      ref={setRef}
      tabIndex={0}
      data-activity-card
      className={`activity-card activity-card--${item.category} activity-card--${item.state}`}
      aria-label={`${item.title}. ${status}${isBlocking ? '. Action required' : ''}`}
      aria-busy={item.inProgress || undefined}
    >
      <header className="activity-card__header">
        <div>
          <span className="activity-card__category">{item.category}</span>
          <h3>{item.title}</h3>
        </div>
        <span className={`activity-state activity-state--${item.state}`}>{status}</span>
      </header>
      {item.body ? (
        item.truncated ? (
          <SafePayload value={item.body} label="Bounded text" filename="activity-text.txt" />
        ) : (
          <p className="activity-card__body">{item.body}</p>
        )
      ) : null}
      <CoreContent item={item} />
      <footer className="activity-card__footer">
        <span>{item.eventTypes.join(' → ')}</span>
        {item.truncated ? <span className="activity-badge">Display bounded</span> : null}
        {item.timestamp ? <time dateTime={item.timestamp}>{item.timestamp}</time> : null}
      </footer>
    </article>
  );
}

export function ActivityTimeline({
  events,
  focusBlockingCards = true,
  omittedEventCount = 0,
}: {
  events: readonly TimelineEventInput[];
  focusBlockingCards?: boolean;
  omittedEventCount?: number;
}) {
  const projection = useMemo(() => projectActivityTimeline(events), [events]);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const focusedBlockingIds = useRef(new Set<string>());
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    const latestInput = events.at(-1);
    const latestProjection = latestInput ? projectActivityTimeline([latestInput]) : undefined;
    const latestId = latestProjection?.items[0]?.id;
    const latest = projection.items.find((item) => item.id === latestId) ?? projection.items.at(-1);
    if (latest) setAnnouncement(`${latest.title}. ${humanStatus(latest.state)}`);
  }, [events, projection.items]);

  useEffect(() => {
    if (!focusBlockingCards) return;
    const pending = projection.items.find(
      (item) => item.blocking && !focusedBlockingIds.current.has(item.id),
    );
    if (!pending) return;
    focusedBlockingIds.current.add(pending.id);
    cardRefs.current.get(pending.id)?.focus({ preventScroll: true });
  }, [focusBlockingCards, projection.items]);

  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (!(event.target instanceof HTMLElement) || !event.target.matches('[data-activity-card]'))
      return;
    const cards = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[data-activity-card]'),
    );
    if (cards.length === 0) return;
    const current = cards.indexOf(document.activeElement as HTMLElement);
    const target =
      event.key === 'Home'
        ? cards[0]
        : event.key === 'End'
          ? cards.at(-1)
          : event.key === 'ArrowDown'
            ? cards[Math.min(cards.length - 1, Math.max(0, current + 1))]
            : cards[Math.max(0, current < 0 ? cards.length - 1 : current - 1)];
    if (target) {
      event.preventDefault();
      target.focus();
    }
  };

  if (projection.items.length === 0) {
    return (
      <div className="activity-timeline activity-timeline--empty" aria-live="polite">
        <img
          className="activity-timeline__empty-illustration"
          src={emptyEventsIllustration}
          alt=""
        />
        <strong>No activity yet.</strong>
        <span>Start a session to see messages, tools, and status updates.</span>
      </div>
    );
  }

  return (
    <section
      className="activity-timeline"
      role="log"
      aria-label="Session activity"
      aria-live="off"
      aria-relevant="additions text"
      onKeyDown={moveFocus}
    >
      <span className="activity-visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      {projection.truncated || omittedEventCount > 0 ? (
        <p className="activity-limit-notice" role="status">
          {projection.omittedEventCount + omittedEventCount} older{' '}
          {projection.omittedEventCount + omittedEventCount === 1 ? 'event was' : 'events were'}{' '}
          omitted to keep this view responsive.
        </p>
      ) : null}
      <div className="activity-timeline__items">
        {projection.items.map((item) => (
          <ActivityCard
            key={item.id}
            item={item}
            setRef={(element) => {
              if (element) cardRefs.current.set(item.id, element);
              else cardRefs.current.delete(item.id);
            }}
          />
        ))}
      </div>
    </section>
  );
}
