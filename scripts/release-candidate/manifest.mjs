import { readFile } from 'node:fs/promises';

export const RELEASE_CANDIDATE_MANIFEST_SCHEMA_VERSION = 1;

/**
 * One named quality gate this release-candidate workflow ran (lint, typecheck, test, build,
 * audit, packaging, packaged-app launch, installer lifecycle, ...). `passed` is the only field
 * `aggregateGateResults` reads to decide overall readiness -- everything else here is
 * human-readable detail for the manifest, not part of the readiness decision itself.
 * @typedef {{ name: string, passed: boolean, detail?: string }} GateResult
 */

/**
 * Aggregates every gate into one overall status. This is a strict AND, computed here and nowhere
 * else: nothing upstream can set `ready: true` directly, and a single failed gate -- however
 * minor -- always produces `ready: false`. Issue #66's own acceptance criterion is literally this
 * function's contract: "Failed checks cannot produce a 'ready' manifest."
 * @param {GateResult[]} gates
 */
export function aggregateGateResults(gates) {
  if (gates.length === 0) {
    throw new Error('aggregateGateResults requires at least one gate result');
  }
  const failed = gates.filter((gate) => !gate.passed).map((gate) => gate.name);
  return {
    ready: failed.length === 0,
    failedGates: failed,
    gates,
  };
}

/**
 * One row imported from the (already redacted, per issue #65) live-provider-smoke evidence file.
 * `verified` is true only for a row whose `resultCode` is literally `'success'` -- every other
 * code (a skip or a failure) means that transport was NOT exercised for real, and must never be
 * read as a "verified" claim about that provider/version.
 * @typedef {{ provider: string, transport: string, providerVersion: string | undefined, resultCode: string, verified: boolean, timestamp: string }} ProviderMatrixRow
 */

/**
 * Reads issue #65's live-provider-smoke evidence JSONL (if it exists) and reduces each row to
 * only the fields relevant to a release-readiness manifest -- this already-redacted file never
 * carried provider output/credentials to begin with (see #65's `buildEvidenceRecord`), but this
 * function still doesn't copy fields it doesn't need (`capabilitiesTested`, `durationMs`, `os`),
 * so a manifest reader sees exactly what's relevant to "was this transport verified" and nothing
 * else. Returns `{ available: false }` when no evidence file exists, so the manifest can state
 * plainly that the matrix wasn't run for this candidate rather than silently omitting the field.
 * @param {string | undefined} evidencePath
 */
export async function importProviderMatrixEvidence(evidencePath) {
  if (!evidencePath) return { available: false, rows: [] };
  let text;
  try {
    text = await readFile(evidencePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { available: false, rows: [] };
    }
    throw error;
  }
  const rows = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
    .map((record) => ({
      provider: record.provider,
      transport: record.transport,
      providerVersion: record.providerVersion,
      resultCode: record.resultCode,
      verified: record.resultCode === 'success',
      timestamp: record.timestamp,
    }));
  return { available: true, rows };
}

/**
 * @param {{
 *   commit: string,
 *   dirty: boolean,
 *   osImage: string,
 *   nodeVersion: string,
 *   pnpmVersion: string,
 *   providerPins: Record<string, string>,
 *   gates: GateResult[],
 *   artifacts: Array<{ name: string, path: string, sha256: string, sizeBytes: number }>,
 *   signingStatus: 'unsigned',
 *   documentedExceptions: string[],
 *   providerMatrix: Awaited<ReturnType<typeof importProviderMatrixEvidence>>,
 *   sbom?: { available: boolean, format?: string, path?: string, sha256?: string },
 *   provenance?: { available: boolean, attestationUrl?: string },
 *   generatedAt?: string,
 * }} input
 */
export function buildManifest(input) {
  const aggregate = aggregateGateResults(input.gates);
  return {
    schemaVersion: RELEASE_CANDIDATE_MANIFEST_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    commit: input.commit,
    dirty: input.dirty,
    osImage: input.osImage,
    toolchain: { node: input.nodeVersion, pnpm: input.pnpmVersion },
    providerPins: input.providerPins,
    gates: aggregate.gates,
    ready: aggregate.ready,
    failedGates: aggregate.failedGates,
    artifacts: input.artifacts,
    // Never configured for this boilerplate -- see docs/packaging.md#unsigned-installer-and-smartscreen.
    // Always literally 'unsigned': there is no code path that can set this to anything claiming
    // a real signature, since this repo has no signing certificate to sign with.
    signingStatus: input.signingStatus,
    published: false,
    documentedExceptions: input.documentedExceptions,
    providerMatrix: input.providerMatrix,
    // False (issue #61) means exactly what providerMatrix.available: false already means elsewhere
    // in this manifest -- "not generated for this run", never an implicit claim either way.
    sbom: input.sbom ?? { available: false },
    provenance: input.provenance ?? { available: false },
  };
}
