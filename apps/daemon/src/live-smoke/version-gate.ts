export type VersionGateResult =
  | { supported: true }
  | { supported: false; reason: string };

/**
 * A real installed CLI can be any version; this repo only has fixture/compatibility evidence for
 * one exact pinned version per transport (see `compatibility-manifest.ts`). Issue #65 requires a
 * version mismatch to read as `skipped_version_stale`, never a false `success` -- an untested
 * version completing a session proves nothing about the version this repo actually validated.
 */
export function checkVersionSupported(
  detectedVersion: string | undefined,
  pinnedVersion: string,
): VersionGateResult {
  if (!detectedVersion) {
    return { supported: false, reason: 'provider detection reported no version' };
  }
  if (detectedVersion !== pinnedVersion) {
    return {
      supported: false,
      reason: `detected version ${detectedVersion} does not match the pinned/tested version ${pinnedVersion}`,
    };
  }
  return { supported: true };
}
