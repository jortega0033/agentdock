import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendEvidenceRecord,
  buildEvidenceRecord,
  LiveSmokeRedactionError,
} from '../../src/live-smoke/evidence.js';

const VALID_INPUT = {
  commit: 'a'.repeat(40),
  os: 'win32' as const,
  provider: 'claude' as const,
  transport: 'claude-legacy-one-shot' as const,
  providerVersion: '2.1.228',
  authSourceCategory: 'claude_subscription' as const,
  capabilitiesTested: ['session.cancel', 'interaction.approval'],
  resultCode: 'success' as const,
  durationMs: 1234,
};

describe('buildEvidenceRecord redaction', () => {
  it('accepts a fully safe input and serializes it losslessly', () => {
    const record = buildEvidenceRecord(VALID_INPUT);
    expect(record).toMatchObject({
      schemaVersion: 1,
      commit: VALID_INPUT.commit,
      provider: 'claude',
      transport: 'claude-legacy-one-shot',
      authSourceCategory: 'claude_subscription',
      resultCode: 'success',
      durationMs: 1234,
    });
    expect(typeof record.timestamp).toBe('string');
    expect(() => JSON.parse(JSON.stringify(record))).not.toThrow();
  });

  it('rejects a commit that is not a git SHA', () => {
    expect(() => buildEvidenceRecord({ ...VALID_INPUT, commit: 'not a commit sha' })).toThrow(
      LiveSmokeRedactionError,
    );
  });

  it('rejects a providerVersion that looks like raw CLI output rather than a version string', () => {
    expect(() =>
      buildEvidenceRecord({
        ...VALID_INPUT,
        providerVersion: 'error: could not authenticate, token abc123secret expired',
      }),
    ).toThrow(LiveSmokeRedactionError);
  });

  it('rejects an unrecognized auth source category', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately invalid to test the redaction guard
      buildEvidenceRecord({ ...VALID_INPUT, authSourceCategory: 'someone@example.com' as any }),
    ).toThrow(LiveSmokeRedactionError);
  });

  it('rejects a capability id that is not a real dotted identifier', () => {
    expect(() =>
      buildEvidenceRecord({ ...VALID_INPUT, capabilitiesTested: ['the user asked me to run rm -rf'] }),
    ).toThrow(LiveSmokeRedactionError);
  });

  it('rejects a negative or non-finite duration', () => {
    expect(() => buildEvidenceRecord({ ...VALID_INPUT, durationMs: -1 })).toThrow(
      LiveSmokeRedactionError,
    );
    expect(() => buildEvidenceRecord({ ...VALID_INPUT, durationMs: Number.NaN })).toThrow(
      LiveSmokeRedactionError,
    );
  });
});

describe('appendEvidenceRecord', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('durably appends one JSON line per record, creating parent directories as needed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-dock-evidence-test-'));
    const filePath = join(dir, 'nested', 'evidence.jsonl');
    const first = buildEvidenceRecord(VALID_INPUT);
    const second = buildEvidenceRecord({ ...VALID_INPUT, resultCode: 'skipped_missing_binary' });
    await appendEvidenceRecord(filePath, first);
    await appendEvidenceRecord(filePath, second);
    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ resultCode: 'success' });
    expect(JSON.parse(lines[1]!)).toMatchObject({ resultCode: 'skipped_missing_binary' });
  });
});
