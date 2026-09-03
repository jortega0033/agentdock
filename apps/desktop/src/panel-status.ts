/**
 * Shared vocabulary for how truthfully an "advanced" reference-UI panel reflects real runtime
 * behavior today (issue #62). Every advanced panel derives its badge from this single table
 * rather than deciding its own label with an inline `provider === 'x'` conditional, so a state
 * only ever changes in one place when an adapter's real behavior changes.
 */
export type PanelDisplayState =
  | 'implemented'
  | 'provider_dependent'
  | 'experimental'
  | 'scaffold_only'
  | 'unsupported';

export interface PanelStatusDescriptor {
  state: PanelDisplayState;
  label: string;
  explanation: string;
}

const PANEL_STATUS_LABELS: Record<PanelDisplayState, string> = {
  implemented: 'Implemented',
  provider_dependent: 'Provider-dependent',
  experimental: 'Experimental',
  scaffold_only: 'Scaffold only',
  unsupported: 'Unsupported',
};

function descriptor(state: PanelDisplayState, explanation: string): PanelStatusDescriptor {
  return { state, label: PANEL_STATUS_LABELS[state], explanation };
}

/**
 * `ProviderCliMcpControlPlane` (packages/agent-runtime/src/mcp-control.ts) is one shared
 * implementation for both providers: server configuration/inspection (`configure: true`,
 * `reload: true`) works identically for Claude and Codex. Neither provider gets a live
 * connection, tool/resource/prompt catalog, or direct tool invocation (`connect`/`tools`/
 * `resources`/`prompts` are hardcoded `false` for every server); OAuth is the one real
 * per-provider difference, available only for Codex's `streamable_http` servers
 * (`oauth: provider === 'codex' && transport === 'streamable_http'`).
 */
const MCP_STATUS: PanelStatusDescriptor = descriptor(
  'scaffold_only',
  'Configuration and inspection only, for either provider. Live tool/resource/prompt catalogs and direct tool invocation are not available for any provider yet; browser OAuth only exists for a Codex streamable-HTTP server.',
);

/**
 * Both providers get real, filesystem-based component discovery (skills/plugins for both;
 * commands/agents/hooks for Claude too -- see FilesystemProviderComponentControlPlane in
 * packages/agent-runtime/src/component-control.ts). It is read-only for either provider today:
 * `manage()`/`invoke()` unconditionally return `unsupported` once workspace trust is granted
 * ("This provider does not advertise an explicit component management API") -- there is no
 * provider or item for which those operations currently succeed, so this state does not vary by
 * provider.
 */
const COMPONENT_STATUS: PanelStatusDescriptor = descriptor(
  'scaffold_only',
  'Read-only discovery only, for either provider. Execution stays blocked until workspace trust is granted, and no provider currently advertises a management or invocation operation for any component.',
);

/**
 * Storage and routes for the child-agent graph (apps/daemon/src/subagent-graph-store.ts,
 * routes/v2-agents-worktrees.ts) are provider-agnostic, but only the Codex app-server adapter
 * (packages/agent-runtime/src/providers/codex/app-server/normalizer.ts) currently populates it,
 * from real `subAgentActivity` items in the pinned app-server schema (issue #58). Codex's own
 * schema has no explicit "completed" kind for that item, so a normally-finishing child is closed
 * out when its parent turn ends with no further activity for it -- an inferred, not
 * provider-confirmed, terminal signal. Neither Claude transport populates this graph at all: the
 * only signal available (a `Task` tool-use) would require inferring a child from a tool name,
 * which this repo's own evidence rules for this capability explicitly rule out.
 */
const CHILD_AGENT_STATUS: PanelStatusDescriptor = descriptor(
  'provider_dependent',
  'Codex app-server populates this graph from real lifecycle events (a child agent\'s normal completion is inferred from its parent turn ending, not a confirmed provider signal). No other provider or transport populates it yet.',
);
const NO_SESSION_SELECTED_STATUS: PanelStatusDescriptor = descriptor(
  'unsupported',
  'Select a session to see its child-agent state.',
);

/**
 * Attachment staging and structured-output validation both run entirely locally: neither is
 * dispatched to any provider session by any current adapter (see
 * apps/daemon/src/routes/v2-multimodal.ts). This does not vary by provider.
 */
const WORKFLOW_STATUS: PanelStatusDescriptor = descriptor(
  'scaffold_only',
  'Files you stage here are not included in any run. Structured-output validation checks a JSON payload you paste in -- it does not constrain what a provider actually generates.',
);

export function mcpPanelStatus(): PanelStatusDescriptor {
  return MCP_STATUS;
}

export function componentPanelStatus(): PanelStatusDescriptor {
  return COMPONENT_STATUS;
}

export function childAgentPanelStatus(sessionSelected: boolean): PanelStatusDescriptor {
  return sessionSelected ? CHILD_AGENT_STATUS : NO_SESSION_SELECTED_STATUS;
}

export function workflowPanelStatus(): PanelStatusDescriptor {
  return WORKFLOW_STATUS;
}
