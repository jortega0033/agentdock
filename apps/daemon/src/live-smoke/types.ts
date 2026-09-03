import type { AuthSource, ProviderId } from '@agent-dock/shared';

/** The four production transports issue #65 requires a live, opt-in smoke case for. */
export type LiveSmokeTransportId =
  | 'claude-agent-sdk'
  | 'claude-legacy-one-shot'
  | 'codex-app-server'
  | 'codex-legacy-one-shot';

/**
 * Every way a smoke case can end. Only `success` means a real session actually completed.
 * Every `skipped_*` code means no conclusion was reached (missing opt-in, missing binary/auth, a
 * stale provider version) -- callers must never treat a skip as a pass. `failed_*` codes are a
 * real defect: the harness's own logic broke a contract (duplicate terminal event, malformed
 * stream, a hang past the timeout, or an unexpected error).
 */
export type LiveSmokeResultCode =
  | 'success'
  | 'skipped_not_enabled'
  | 'skipped_missing_binary'
  | 'skipped_missing_auth'
  | 'skipped_version_stale'
  | 'failed_timeout'
  | 'failed_protocol_violation'
  | 'failed_error';

export function isSkippedResult(code: LiveSmokeResultCode): boolean {
  return code.startsWith('skipped_');
}

export function isFailedResult(code: LiveSmokeResultCode): boolean {
  return code.startsWith('failed_');
}

/**
 * One redacted, release-evidence row for a single smoke case. Every field here is safe to
 * publish: no credential, account identifier, raw prompt/output text, or private filesystem path.
 * See `buildEvidenceRecord` for the redaction this type's shape is meant to make easy to audit at
 * a glance -- there is deliberately no field here that could hold a secret.
 */
export interface LiveSmokeEvidenceRecord {
  schemaVersion: 1;
  commit: string;
  os: NodeJS.Platform;
  provider: ProviderId;
  transport: LiveSmokeTransportId;
  providerVersion: string | undefined;
  /** The auth *category* only (e.g. 'api_key', 'chatgpt') -- never an account identifier. */
  authSourceCategory: AuthSource | 'none';
  /**
   * Capability ids the daemon actually negotiated as enabled for this case (`session.cancel`
   * always required; `session.resume`/`session.fork` only present when a follow-up continuation
   * case ran and completed). This is what was *available and selected*, not proof every listed
   * capability's full behavior was individually exercised in the one prompt this harness sends --
   * see docs/release-checklist.md for what a `success` row does and does not prove.
   */
  capabilitiesTested: string[];
  resultCode: LiveSmokeResultCode;
  durationMs: number;
  timestamp: string;
}
