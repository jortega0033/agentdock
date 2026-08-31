import type { AgentEventEnvelope, AgentEventV2Envelope } from '@agent-dock/shared';

/** The renderer only receives this bounded, data-only representation. */
export type SafeActivityValue =
  | null
  | boolean
  | number
  | string
  | SafeActivityValue[]
  | { readonly [key: string]: SafeActivityValue };

export type ActivityCategory =
  | 'session'
  | 'turn'
  | 'status'
  | 'content'
  | 'tool'
  | 'approval'
  | 'question'
  | 'usage'
  | 'error'
  | 'extension'
  | 'unknown';

export type ActivityState =
  | 'info'
  | 'streaming'
  | 'running'
  | 'pending'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface ActivityTimelineItem {
  /** Stable protocol-derived identifier. Never use the render array index. */
  id: string;
  /** Preferred UI-facing category name. */
  kind: ActivityCategory;
  /** Preferred UI-facing lifecycle name. */
  status: ActivityState;
  /** Compatibility aliases for callers that prefer the more explicit vocabulary. */
  category: ActivityCategory;
  state: ActivityState;
  /** The most useful human label, deliberately plain text rather than markup. */
  title: string;
  /** Bounded plain-text body. Rendering it as text is always safe. */
  body?: string;
  timestamp?: string;
  sequence?: number;
  /** Event types absorbed into this lifecycle item, in receipt order. */
  eventTypes: string[];
  /** Bounded, JSON-like metadata for generic and future event renderers. */
  data?: SafeActivityValue;
  /** True only while an approval or question still requires a response. */
  blocking: boolean;
  /** True for a text stream or a running tool. */
  inProgress: boolean;
  truncated: boolean;
}

export type ActivityItem = ActivityTimelineItem;

/** Accepted while the desktop migrates from protocol v1 to v2. */
export type TimelineEventInput =
  AgentEventV2Envelope | AgentEventEnvelope | Readonly<Record<string, unknown>>;

export interface ActivityTimelineProjection {
  items: ActivityTimelineItem[];
  /** True when old input was omitted to keep a pathological stream bounded. */
  truncated: boolean;
  omittedEventCount: number;
}
