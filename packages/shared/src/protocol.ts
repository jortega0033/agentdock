/**
 * The public contract version for the daemon's HTTP+SSE API and the AgentEvent shape it emits.
 * Bump this only when a *breaking* change is made to either — a downstream client (starting with
 * @agent-dock/client) checks this against `GET /health` and refuses to proceed on a mismatch
 * rather than guessing whether it's still compatible. See docs/protocol-v1.md.
 *
 * Deliberately a plain number with exact-match comparison, not a semver range or a negotiation
 * handshake — this is a boilerplate with two clients (the bundled Electron app and whatever forks
 * it) and one daemon shipped together, not a multi-version ecosystem yet. Add real negotiation if
 * and when that stops being true.
 */
export const AGENT_DOCK_PROTOCOL_VERSION = 1;
