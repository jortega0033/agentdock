import { appendFile, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AUTH_SOURCES, type AuthSource } from '@agent-dock/shared';
import type { LiveSmokeEvidenceRecord, LiveSmokeResultCode, LiveSmokeTransportId } from './types.js';

const KNOWN_AUTH_CATEGORIES = new Set<string>([...AUTH_SOURCES, 'none']);
/** Matches a capability id like `session.resume` or `interaction.approval` -- nothing else. */
const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
/**
 * Requires at least a `major.minor` numeric shape before any suffix -- every real pinned version
 * in `compatibility-manifest.ts`/`sdk-version.ts` looks like this (`2.1.228`, `0.147.0`,
 * `0.3.251`). Deliberately tighter than "any CLI-output-shaped token": a detector bug that
 * captures an error string or an account-ish identifier (`claude_user_123`, `api-key-abcd`)
 * starts with a letter, not a digit, so it's rejected here rather than recorded as if it were a
 * real version.
 */
const VERSION_PATTERN = /^\d+(\.\d+){1,3}(-[A-Za-z0-9.-]{1,32})?$/;

export class LiveSmokeRedactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveSmokeRedactionError';
  }
}

export interface BuildEvidenceRecordInput {
  commit: string;
  os: NodeJS.Platform;
  provider: LiveSmokeEvidenceRecord['provider'];
  transport: LiveSmokeTransportId;
  providerVersion: string | undefined;
  authSourceCategory: AuthSource | 'none';
  capabilitiesTested: string[];
  resultCode: LiveSmokeResultCode;
  durationMs: number;
  now?: () => Date;
}

/**
 * The one place a smoke case's result becomes a publishable evidence row. Every field is
 * validated against a narrow, safe shape before it's accepted -- this is the redaction boundary
 * issue #65 requires ("no credential, account identifier, raw prompt/output, or private path"),
 * enforced structurally rather than by convention: a caller cannot smuggle free text through any
 * field here, even by bypassing TypeScript with `as`.
 */
export function buildEvidenceRecord(input: BuildEvidenceRecordInput): LiveSmokeEvidenceRecord {
  if (!/^[0-9a-f]{7,40}$/i.test(input.commit)) {
    throw new LiveSmokeRedactionError(`commit does not look like a git SHA: ${input.commit}`);
  }
  if (input.providerVersion !== undefined && !VERSION_PATTERN.test(input.providerVersion)) {
    throw new LiveSmokeRedactionError(
      `providerVersion does not look like a version string, refusing to record it verbatim`,
    );
  }
  if (!KNOWN_AUTH_CATEGORIES.has(input.authSourceCategory)) {
    throw new LiveSmokeRedactionError(`unknown auth source category: ${input.authSourceCategory}`);
  }
  for (const capability of input.capabilitiesTested) {
    if (!CAPABILITY_ID_PATTERN.test(capability)) {
      throw new LiveSmokeRedactionError(`capability id does not look like an id: ${capability}`);
    }
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
    throw new LiveSmokeRedactionError(`durationMs must be a non-negative finite number`);
  }
  const timestamp = (input.now?.() ?? new Date()).toISOString();
  return {
    schemaVersion: 1,
    commit: input.commit,
    os: input.os,
    provider: input.provider,
    transport: input.transport,
    providerVersion: input.providerVersion,
    authSourceCategory: input.authSourceCategory,
    capabilitiesTested: [...input.capabilitiesTested],
    resultCode: input.resultCode,
    durationMs: input.durationMs,
    timestamp,
  };
}

/**
 * Durable, append-only JSONL evidence log. Mirrors `AuditStore`'s fsync-before-return discipline
 * (apps/daemon/src/audit-store.ts) so a crash right after a smoke run can't silently lose the one
 * row proving what happened.
 */
export async function appendEvidenceRecord(
  filePath: string,
  record: LiveSmokeEvidenceRecord,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  await appendFile(filePath, line, 'utf8');
  const handle = await open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
