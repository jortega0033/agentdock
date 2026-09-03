import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/**
 * Streams a file through SHA-256 rather than reading it whole into memory -- a packaged
 * installer/unpacked exe can be tens of megabytes, and this runs in CI where memory is bounded.
 */
export async function computeArtifactEvidence(name, path) {
  const [sha256, stats] = await Promise.all([hashFile(path), stat(path)]);
  return { name, path, sha256, sizeBytes: stats.size };
}

function hashFile(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}
