import type {
  ActivityCategory,
  ActivityState,
  ActivityTimelineItem,
  ActivityTimelineProjection,
  SafeActivityValue,
  TimelineEventInput,
} from './types.js';

export const MAX_ACTIVITY_TEXT_LENGTH = 4_096;
export const MAX_ACTIVITY_VALUE_DEPTH = 5;
export const MAX_ACTIVITY_VALUE_ITEMS = 32;
export const MAX_ACTIVITY_VALUE_NODES = 256;
export const MAX_ACTIVITY_TIMELINE_EVENTS = 1_000;

type MutableActivityTimelineItem = ActivityTimelineItem & {
  eventTypes: string[];
};

type SanitizedValue = { value: SafeActivityValue; truncated: boolean };
type SanitizeBudget = { remaining: number };

type EventRecord = Readonly<Record<string, unknown>>;

const META_KEYS = new Set([
  'sessionId',
  'executionId',
  'parentExecutionId',
  'turnId',
  'sequence',
  'timestamp',
  'type',
  'requestId',
]);

function isRecord(value: unknown): value is EventRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncateText(
  value: string,
  maximum = MAX_ACTIVITY_TEXT_LENGTH,
): { value: string; truncated: boolean } {
  if (value.length <= maximum) return { value, truncated: false };

  const suffix = '… (truncated)';
  let end = Math.max(0, maximum - suffix.length);
  // Avoid displaying a dangling high surrogate without scanning the whole string.
  const last = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return {
    value: `${value.slice(0, end)}${suffix}`,
    truncated: true,
  };
}

function sanitizeValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  budget: SanitizeBudget = { remaining: MAX_ACTIVITY_VALUE_NODES },
): SanitizedValue {
  if (budget.remaining <= 0) return { value: '[additional values omitted]', truncated: true };
  budget.remaining -= 1;
  if (value === null || typeof value === 'boolean') return { value, truncated: false };
  if (typeof value === 'string') {
    const text = truncateText(value);
    return { value: text.value, truncated: text.truncated };
  }
  if (typeof value === 'number')
    return {
      value: Number.isFinite(value) ? value : String(value),
      truncated: !Number.isFinite(value),
    };
  if (typeof value === 'bigint') return { value: `${value}n`, truncated: false };
  if (typeof value === 'undefined') return { value: '[undefined]', truncated: false };
  if (typeof value === 'symbol' || typeof value === 'function')
    return { value: `[${typeof value}]`, truncated: false };
  if (depth >= MAX_ACTIVITY_VALUE_DEPTH) return { value: '[max depth]', truncated: true };

  if (typeof value !== 'object') return { value: '[unsupported value]', truncated: true };
  if (seen.has(value)) return { value: '[circular]', truncated: true };
  seen.add(value);

  if (Array.isArray(value)) {
    const result: SafeActivityValue[] = [];
    let truncated = value.length > MAX_ACTIVITY_VALUE_ITEMS;
    for (const item of value.slice(0, MAX_ACTIVITY_VALUE_ITEMS)) {
      if (budget.remaining <= 0) {
        result.push('[additional values omitted]');
        truncated = true;
        break;
      }
      const sanitized = sanitizeValue(item, depth + 1, seen, budget);
      result.push(sanitized.value);
      truncated ||= sanitized.truncated;
    }
    return { value: result, truncated };
  }

  const result: Record<string, SafeActivityValue> = {};
  const record = value as Record<string, unknown>;
  let truncated = false;
  let itemCount = 0;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    if (itemCount >= MAX_ACTIVITY_VALUE_ITEMS || budget.remaining <= 0) {
      result['…'] = '[additional values omitted]';
      truncated = true;
      break;
    }
    // This is display-only data, but still skip prototype-shaped keys so future consumers cannot
    // accidentally inherit unexpected values from a spread or assignment.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      truncated = true;
      continue;
    }
    const safeKey = truncateText(key, 160);
    const sanitized = sanitizeValue(record[key], depth + 1, seen, budget);
    result[safeKey.value] = sanitized.value;
    truncated ||= safeKey.truncated || sanitized.truncated;
    itemCount += 1;
  }
  return { value: result, truncated };
}

/** Exported so generic renderers can sanitize future provider payloads at their boundary too. */
export function toSafeActivityValue(value: unknown): SafeActivityValue {
  return sanitizeValue(value).value;
}

function eventType(event: EventRecord): string {
  return asText(event.type, 'unknown.event') || 'unknown.event';
}

function eventSequence(event: EventRecord): number | undefined {
  return asFiniteNumber(event.sequence);
}

function eventTimestamp(event: EventRecord): string | undefined {
  const timestamp = asText(event.timestamp);
  return timestamp ? truncateText(timestamp, 128).value : undefined;
}

function eventScope(event: EventRecord): string {
  return [asText(event.sessionId, 'legacy'), asText(event.executionId, 'v1')]
    .map((part) => encodeURIComponent(part))
    .join(':');
}

function eventFallbackId(event: EventRecord, occurrence: number): string {
  const sequence = eventSequence(event);
  return `event:${eventScope(event)}:${encodeURIComponent(eventType(event))}:${sequence ?? `unsequenced-${occurrence}`}`;
}

function lifecycleId(kind: string, event: EventRecord, value: unknown, occurrence: number): string {
  const identifier = asText(value);
  return identifier
    ? `${kind}:${eventScope(event)}:${encodeURIComponent(identifier)}`
    : eventFallbackId(event, occurrence);
}

function stableFingerprint(value: unknown): string {
  const serialized = JSON.stringify(toSafeActivityValue(value));
  let hash = 2_166_136_261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${serialized.length}-${(hash >>> 0).toString(36)}`;
}

function textField(value: unknown): { value?: string; truncated: boolean } {
  if (typeof value !== 'string') return { truncated: false };
  return truncateText(value);
}

function nonMetaData(event: EventRecord): SanitizedValue {
  const data: Record<string, unknown> = {};
  let copied = 0;
  let truncated = false;
  for (const key in event) {
    if (!Object.prototype.hasOwnProperty.call(event, key) || META_KEYS.has(key)) continue;
    if (copied >= MAX_ACTIVITY_VALUE_ITEMS) {
      truncated = true;
      break;
    }
    data[key] = event[key];
    copied += 1;
  }
  const sanitized = sanitizeValue(data);
  return { value: sanitized.value, truncated: truncated || sanitized.truncated };
}

/**
 * Keep question text useful while dropping native correlation IDs and submitted answer values.
 * Production interactions arrive through an opaque broker, but the generic component also accepts
 * protocol envelopes directly, so this boundary must remain safe on its own.
 */
function questionDisplayData(event: EventRecord): SanitizedValue {
  const data: Record<string, unknown> = {};
  let truncated = false;
  const deadlineAt = asText(event.deadlineAt);
  const reason = asText(event.reason);
  if (deadlineAt) data.deadlineAt = deadlineAt;
  if (reason) data.reason = reason;

  if (eventType(event) === 'question.requested' && Array.isArray(event.questions)) {
    truncated ||= event.questions.length > MAX_ACTIVITY_VALUE_ITEMS;
    data.questions = event.questions.slice(0, MAX_ACTIVITY_VALUE_ITEMS).map((question) => {
      if (!isRecord(question)) {
        truncated = true;
        return { title: 'Invalid question' };
      }

      const display: Record<string, unknown> = {};
      const title = asText(question.title);
      const prompt = asText(question.prompt);
      const preview = asText(question.preview);
      if (title) display.title = title;
      if (prompt) display.prompt = prompt;
      if (typeof question.allowsFreeText === 'boolean')
        display.allowsFreeText = question.allowsFreeText;
      if (preview) display.preview = preview;

      if (Array.isArray(question.options)) {
        truncated ||= question.options.length > MAX_ACTIVITY_VALUE_ITEMS;
        display.options = question.options.slice(0, MAX_ACTIVITY_VALUE_ITEMS).map((option) => {
          if (!isRecord(option)) {
            truncated = true;
            return { label: 'Invalid option' };
          }
          const safeOption: Record<string, unknown> = {};
          const label = asText(option.label);
          const description = asText(option.description);
          if (label) safeOption.label = label;
          if (description) safeOption.description = description;
          return safeOption;
        });
      }
      return display;
    });
  }

  const sanitized = sanitizeValue(data);
  return { value: sanitized.value, truncated: truncated || sanitized.truncated };
}

function newItem(
  id: string,
  category: ActivityCategory,
  state: ActivityState,
  title: string,
  event: EventRecord,
  options: { body?: string; data?: SafeActivityValue; truncated?: boolean } = {},
): MutableActivityTimelineItem {
  const safeTitle = truncateText(title, 512);
  const safeBody = options.body === undefined ? undefined : truncateText(options.body);
  return {
    id,
    kind: category,
    status: state,
    category,
    state,
    title: safeTitle.value,
    ...(safeBody ? { body: safeBody.value } : {}),
    ...(eventTimestamp(event) ? { timestamp: eventTimestamp(event) } : {}),
    ...(eventSequence(event) !== undefined ? { sequence: eventSequence(event) } : {}),
    eventTypes: [eventType(event)],
    ...(options.data === undefined ? {} : { data: options.data }),
    blocking: state === 'pending' && (category === 'approval' || category === 'question'),
    inProgress: state === 'streaming' || state === 'running',
    truncated: Boolean(options.truncated) || safeTitle.truncated || Boolean(safeBody?.truncated),
  };
}

function mergeSafeData(
  previous: SafeActivityValue | undefined,
  next: SafeActivityValue,
): SafeActivityValue {
  if (!isRecord(previous) || !isRecord(next)) return next;
  return { ...previous, ...next };
}

function updateItem(
  item: MutableActivityTimelineItem,
  event: EventRecord,
  update: Partial<Pick<ActivityTimelineItem, 'state' | 'title' | 'body' | 'data' | 'truncated'>>,
): void {
  if (!item.eventTypes.includes(eventType(event))) item.eventTypes.push(eventType(event));
  if (update.state) {
    item.state = update.state;
    item.status = update.state;
  }
  if (update.title !== undefined) {
    const title = truncateText(update.title, 512);
    item.title = title.value;
    item.truncated ||= title.truncated;
  }
  if (update.body !== undefined) {
    const body = truncateText(update.body);
    item.body = body.value;
    item.truncated ||= body.truncated;
  }
  if (update.data !== undefined) item.data = mergeSafeData(item.data, update.data);
  item.timestamp = eventTimestamp(event) ?? item.timestamp;
  item.sequence = eventSequence(event) ?? item.sequence;
  item.blocking =
    item.state === 'pending' && (item.category === 'approval' || item.category === 'question');
  item.inProgress = item.state === 'streaming' || item.state === 'running';
  item.truncated ||= Boolean(update.truncated);
}

function replaceItem(
  item: MutableActivityTimelineItem,
  event: EventRecord,
  update: Pick<ActivityTimelineItem, 'state' | 'title'> & {
    body?: string;
    data?: SafeActivityValue;
    truncated?: boolean;
  },
): void {
  const eventTypes = item.eventTypes.includes(eventType(event))
    ? item.eventTypes
    : [...item.eventTypes, eventType(event)];
  const replacement = newItem(item.id, item.category, update.state, update.title, event, update);
  delete item.body;
  delete item.data;
  delete item.timestamp;
  delete item.sequence;
  Object.assign(item, replacement, { eventTypes });
}

function blockTitle(block: EventRecord): string {
  switch (asText(block.type)) {
    case 'text':
      return 'Assistant message';
    case 'image':
      return `Image: ${asText(block.name, 'attachment')}`;
    case 'file':
      return `File: ${asText(block.name, 'attachment')}`;
    case 'structured_data':
      return 'Structured data';
    case 'tool_activity':
      return `Tool: ${asText(block.toolName, 'unknown tool')}`;
    case 'plan':
      return asText(block.title, 'Plan');
    case 'provider_extension':
      return `Extension: ${asText(block.extensionName, 'unknown')}`;
    default:
      return 'Content';
  }
}

function blockBody(block: EventRecord): { value?: string; truncated: boolean } {
  switch (asText(block.type)) {
    case 'text':
      return textField(block.text);
    case 'tool_activity':
      return textField(block.resultSummary ?? block.inputSummary);
    case 'provider_extension':
      return textField(block.safeSummary);
    default:
      return { truncated: false };
  }
}

function v2Category(type: string): ActivityCategory {
  if (type === 'session.status') return 'status';
  if (type.startsWith('session.')) return 'session';
  if (type.startsWith('turn.')) return 'turn';
  if (type.startsWith('content.')) return 'content';
  if (type.startsWith('tool.')) return 'tool';
  if (type.startsWith('approval.')) return 'approval';
  if (type.startsWith('question.')) return 'question';
  if (type.startsWith('usage.')) return 'usage';
  if (type === 'error') return 'error';
  if (type === 'extension.summary') return 'extension';
  return 'unknown';
}

function legacyCategory(type: string): ActivityCategory {
  if (type === 'assistant.message' || type === 'thinking.delta') return 'content';
  if (type.startsWith('tool.')) return 'tool';
  if (type === 'usage') return 'usage';
  if (type === 'status') return 'status';
  if (type === 'error') return 'error';
  if (type.startsWith('session.')) return 'session';
  return 'unknown';
}

function statusForTerminal(type: string): ActivityState {
  if (type === 'session.started' || type === 'turn.started') return 'running';
  if (type.endsWith('.failed') || type === 'error') return 'failed';
  if (type.endsWith('.cancelled')) return 'cancelled';
  if (type.endsWith('.interrupted')) return 'interrupted';
  if (type.endsWith('.completed') || type.endsWith('.resolved')) return 'completed';
  return 'info';
}

function stateForEvent(event: EventRecord, type: string): ActivityState {
  if (type !== 'status' && type !== 'session.status') return statusForTerminal(type);
  switch (asText(event.status).toLowerCase()) {
    case 'starting':
    case 'active':
    case 'running':
      return 'running';
    case 'completed':
    case 'succeeded':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'info';
  }
}

function toolTitle(event: EventRecord, fallback = 'unknown tool'): string {
  const name = asText(event.toolName);
  if (name) return `Tool: ${name}`;
  return fallback.startsWith('Tool: ') ? fallback : `Tool: ${fallback}`;
}

function isV2(event: EventRecord): boolean {
  return (
    typeof event.executionId === 'string' ||
    eventType(event).startsWith('approval.') ||
    eventType(event).startsWith('question.')
  );
}

/**
 * Converts both public event protocols into UI-safe timeline records. It intentionally does not
 * parse or trust provider-specific markup: every value is bounded plain data before React sees it.
 */
export function projectActivityTimeline(
  events: readonly TimelineEventInput[],
): ActivityTimelineProjection {
  const omittedEventCount = Math.max(0, events.length - MAX_ACTIVITY_TIMELINE_EVENTS);
  const source = omittedEventCount > 0 ? events.slice(-MAX_ACTIVITY_TIMELINE_EVENTS) : events;
  const items: MutableActivityTimelineItem[] = [];
  const byId = new Map<string, MutableActivityTimelineItem>();
  const occurrences = new Map<string, number>();
  const primitiveOccurrences = new Map<string, number>();

  const nextOccurrence = (event: EventRecord): number => {
    const base = `${eventScope(event)}:${eventType(event)}:${eventSequence(event) ?? 'unsequenced'}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return occurrence;
  };
  const append = (item: MutableActivityTimelineItem): MutableActivityTimelineItem => {
    items.push(item);
    byId.set(item.id, item);
    return item;
  };

  for (const input of source) {
    if (!isRecord(input)) {
      const unknown: EventRecord = { type: 'unknown.event', value: input };
      const fingerprint = stableFingerprint(input);
      const occurrence = primitiveOccurrences.get(fingerprint) ?? 0;
      primitiveOccurrences.set(fingerprint, occurrence + 1);
      append(
        newItem(
          `unknown:primitive:${fingerprint}:${occurrence}`,
          'unknown',
          'info',
          'Unknown event',
          unknown,
          { data: toSafeActivityValue(input), truncated: true },
        ),
      );
      continue;
    }

    // The accepted input union deliberately includes future arbitrary records. From this point
    // onward, access through the record boundary rather than through a protocol union branch.
    const event: EventRecord = input as EventRecord;
    const type = eventType(event);
    const occurrence = nextOccurrence(event);

    if (isV2(event)) {
      if (type === 'content.delta') {
        const id = lifecycleId('content', event, event.contentBlockId, occurrence);
        const delta = textField(event.delta);
        const existing = byId.get(id);
        if (existing) {
          const combined = truncateText(`${existing.body ?? ''}${delta.value ?? ''}`);
          updateItem(existing, event, {
            state: 'streaming',
            body: combined.value,
            truncated: combined.truncated || delta.truncated,
          });
        } else {
          append(
            newItem(id, 'content', 'streaming', 'Assistant message', event, {
              body: delta.value,
              truncated: delta.truncated,
            }),
          );
        }
        continue;
      }

      if (type === 'content.completed' && isRecord(event.block)) {
        const block: EventRecord = event.block;
        const toolCallId = asText(block.toolCallId);
        const id = toolCallId
          ? lifecycleId('tool', event, toolCallId, occurrence)
          : lifecycleId('content', event, block.id, occurrence);
        const blockStatus = asText(block.status);
        const state: ActivityState =
          asText(block.type) === 'tool_activity'
            ? blockStatus === 'started'
              ? 'running'
              : blockStatus === 'failed'
                ? 'failed'
                : 'completed'
            : 'completed';
        const body = blockBody(block);
        const data = sanitizeValue(block);
        const existing = byId.get(id);
        if (existing) {
          const update = {
            state,
            title: blockTitle(block),
            body: body.value,
            data: data.value,
            truncated: body.truncated || data.truncated,
          };
          if (toolCallId) updateItem(existing, event, update);
          else replaceItem(existing, event, update);
        } else {
          append(
            newItem(id, toolCallId ? 'tool' : 'content', state, blockTitle(block), event, {
              body: body.value,
              data: data.value,
              truncated: body.truncated || data.truncated,
            }),
          );
        }
        continue;
      }

      if (type === 'tool.started' || type === 'tool.completed') {
        const id = lifecycleId('tool', event, event.toolCallId, occurrence);
        const started = type === 'tool.started';
        const summary = textField(event.summary);
        const data = nonMetaData(event);
        const existing = byId.get(id);
        const state: ActivityState = started
          ? 'running'
          : event.status === 'failed'
            ? 'failed'
            : 'completed';
        if (existing) {
          updateItem(existing, event, {
            state,
            title: toolTitle(event, existing.title),
            body: summary.value,
            data: data.value,
            truncated: summary.truncated || data.truncated,
          });
        } else {
          append(
            newItem(id, 'tool', state, toolTitle(event), event, {
              body: summary.value,
              data: data.value,
              truncated: summary.truncated || data.truncated,
            }),
          );
        }
        continue;
      }

      if (type.startsWith('approval.')) {
        const id = lifecycleId('approval', event, event.requestId, occurrence);
        const pending = type === 'approval.requested';
        const cancelled = type === 'approval.cancelled';
        const data = nonMetaData(event);
        const existing = byId.get(id);
        const title = pending
          ? asText(event.title, 'Approval requested')
          : cancelled
            ? 'Approval cancelled'
            : `Approval ${asText(event.decision, 'resolved')}`;
        const body = pending ? textField(event.action) : undefined;
        const state: ActivityState = pending
          ? 'pending'
          : cancelled
            ? 'cancelled'
            : event.decision === 'denied'
              ? 'failed'
              : 'completed';
        if (existing)
          updateItem(existing, event, {
            state,
            title,
            body: body?.value,
            data: data.value,
            truncated: Boolean(body?.truncated) || data.truncated,
          });
        else
          append(
            newItem(id, 'approval', state, title, event, {
              body: body?.value,
              data: data.value,
              truncated: Boolean(body?.truncated) || data.truncated,
            }),
          );
        continue;
      }

      if (type.startsWith('question.')) {
        const id = lifecycleId('question', event, event.requestId, occurrence);
        const pending = type === 'question.requested';
        const data = questionDisplayData(event);
        const existing = byId.get(id);
        const title = pending
          ? 'Question requested'
          : type === 'question.cancelled'
            ? 'Question cancelled'
            : 'Question answered';
        const state: ActivityState = pending
          ? 'pending'
          : type === 'question.cancelled'
            ? 'cancelled'
            : 'completed';
        if (existing)
          updateItem(existing, event, {
            state,
            title,
            data: data.value,
            truncated: data.truncated,
          });
        else
          append(
            newItem(id, 'question', state, title, event, {
              data: data.value,
              truncated: data.truncated,
            }),
          );
        continue;
      }
    } else if (type === 'tool.started' || type === 'tool.completed') {
      const id = lifecycleId('legacy-tool', event, event.toolCallId, occurrence);
      const started = type === 'tool.started';
      const data = nonMetaData(event);
      const existing = byId.get(id);
      const state: ActivityState = started
        ? 'running'
        : event.isError === true
          ? 'failed'
          : 'completed';
      if (existing)
        updateItem(existing, event, {
          state,
          title: toolTitle(event, existing.title),
          data: data.value,
          truncated: data.truncated,
        });
      else
        append(
          newItem(id, 'tool', state, toolTitle(event), event, {
            data: data.value,
            truncated: data.truncated,
          }),
        );
      continue;
    }

    const data = nonMetaData(event);
    const category = isV2(event) ? v2Category(type) : legacyCategory(type);
    const body = textField(
      event.text ?? event.message ?? event.summary ?? event.detail ?? event.reason,
    );
    const title =
      type === 'assistant.message'
        ? 'Assistant message'
        : type === 'thinking.delta'
          ? 'Thinking'
          : type === 'status'
            ? `Status: ${asText(event.status, 'unknown')}`
            : type.replaceAll('.', ' ');
    append(
      newItem(
        eventFallbackId(event, occurrence),
        category,
        stateForEvent(event, type),
        title,
        event,
        {
          body: body.value,
          data: data.value,
          truncated: body.truncated || data.truncated,
        },
      ),
    );
  }

  return { items, truncated: omittedEventCount > 0, omittedEventCount };
}

/** UI convenience wrapper. Use `projectActivityTimeline` when the truncation metadata is needed. */
export function buildActivityTimeline(
  events: readonly TimelineEventInput[],
): ActivityTimelineItem[] {
  return projectActivityTimeline(events).items;
}
