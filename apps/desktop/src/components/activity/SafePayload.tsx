import { useEffect, useMemo, useState } from 'react';

const MAX_RENDERED_CHARACTERS = 16_384;
const MAX_RENDERED_ITEMS = 200;
const MAX_RENDERED_DEPTH = 8;

interface RenderBudget {
  remaining: number;
  truncated: boolean;
}

function boundedValue(
  value: unknown,
  budget: RenderBudget,
  seen: WeakSet<object>,
  depth = 0,
): unknown {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return '[additional values omitted]';
  }
  budget.remaining -= 1;

  if (typeof value === 'string') {
    if (value.length <= MAX_RENDERED_CHARACTERS) return value;
    budget.truncated = true;
    return `${value.slice(0, MAX_RENDERED_CHARACTERS)}\n… [truncated]`;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return value.toString();
  if (depth >= MAX_RENDERED_DEPTH) {
    budget.truncated = true;
    return '[maximum depth reached]';
  }
  if (seen.has(value)) return '[circular reference]';
  seen.add(value);

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const child of value) {
      if (budget.remaining <= 0) {
        budget.truncated = true;
        result.push('[additional values omitted]');
        break;
      }
      result.push(boundedValue(child, budget, seen, depth + 1));
    }
    return result;
  }

  const result = Object.create(null) as Record<string, unknown>;
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    if (count >= MAX_RENDERED_ITEMS || budget.remaining <= 0) {
      budget.truncated = true;
      result['…'] = '[additional values omitted]';
      break;
    }
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      budget.truncated = true;
      continue;
    }
    result[key] = boundedValue(child, budget, seen, depth + 1);
    count += 1;
  }
  return result;
}

export function formatBoundedPayload(value: unknown): { text: string; truncated: boolean } {
  const budget: RenderBudget = { remaining: MAX_RENDERED_ITEMS, truncated: false };
  let text: string;
  try {
    const bounded = boundedValue(value, budget, new WeakSet());
    text = typeof bounded === 'string' ? bounded : JSON.stringify(bounded, null, 2);
  } catch {
    text = '[payload could not be displayed]';
  }
  if (text.length > MAX_RENDERED_CHARACTERS) {
    text = `${text.slice(0, MAX_RENDERED_CHARACTERS)}\n… [truncated]`;
    budget.truncated = true;
  }
  return { text, truncated: budget.truncated };
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function exportText(text: string, filename: string): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function SafePayload({
  value,
  label = 'Payload',
  filename = 'activity-payload.txt',
  code = false,
}: {
  value: unknown;
  label?: string;
  filename?: string;
  code?: boolean;
}) {
  const { text, truncated } = useMemo(() => formatBoundedPayload(value), [value]);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => setCopyState('idle'), [text]);

  return (
    <section className="activity-payload" aria-label={label}>
      <div className="activity-payload__toolbar">
        <span>{label}</span>
        <div className="activity-payload__actions">
          {truncated ? <span className="activity-badge">Truncated</span> : null}
          <button
            type="button"
            className="activity-action"
            onClick={() => void copyText(text).then((ok) => setCopyState(ok ? 'copied' : 'failed'))}
          >
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
          </button>
          <button
            type="button"
            className="activity-action"
            onClick={() => exportText(text, filename)}
          >
            Export
          </button>
        </div>
      </div>
      <pre
        className={
          code
            ? 'activity-payload__content activity-payload__content--code'
            : 'activity-payload__content'
        }
      >
        {text}
      </pre>
    </section>
  );
}
