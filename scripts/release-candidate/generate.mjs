import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

export async function loadProviderPins() {
  // Imports the *compiled* output, not TypeScript source: this script runs with plain `node`
  // (no tsx/ts-node), and this workflow always runs `pnpm build` as an earlier gate anyway, so
  // the pins this reports are guaranteed to be the ones that build actually used.
  const compatibilityManifestPath = join(
    REPO_ROOT,
    'packages/agent-runtime/dist/providers/compatibility-manifest.js',
  );
  const sdkVersionPath = join(REPO_ROOT, 'packages/agent-runtime/dist/providers/claude/sdk-version.js');
  const compat = await import(pathToFileURL(compatibilityManifestPath).href);
  const sdk = await import(pathToFileURL(sdkVersionPath).href);
  return {
    'claude-legacy-one-shot': compat.CLAUDE_LEGACY_COMPATIBILITY.providerVersion,
    'claude-agent-sdk': sdk.CLAUDE_AGENT_SDK_CLAUDE_CODE_VERSION,
    'codex-legacy-one-shot': compat.CODEX_LEGACY_COMPATIBILITY.providerVersion,
    'codex-app-server': compat.CODEX_APP_SERVER_COMPATIBILITY.providerVersion,
  };
}

async function main() {
  const { buildManifest, importProviderMatrixEvidence } = await import('./manifest.mjs');
  const { computeArtifactEvidence } = await import('./artifact-evidence.mjs');
  const { values } = parseArgs({
    options: {
      commit: { type: 'string' },
      dirty: { type: 'string', default: 'false' },
      'os-image': { type: 'string' },
      'node-version': { type: 'string' },
      'pnpm-version': { type: 'string' },
      'gates-json': { type: 'string' },
      'artifacts-json': { type: 'string', default: '[]' },
      'documented-exceptions-json': { type: 'string', default: '[]' },
      'provider-matrix-evidence': { type: 'string' },
      out: { type: 'string' },
    },
  });

  for (const required of ['commit', 'os-image', 'node-version', 'pnpm-version', 'gates-json', 'out']) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }

  const gates = JSON.parse(values['gates-json']);
  const artifactInputs = JSON.parse(values['artifacts-json']);
  const artifacts = await Promise.all(
    artifactInputs.map((artifact) => computeArtifactEvidence(artifact.name, artifact.path)),
  );
  const providerMatrix = await importProviderMatrixEvidence(values['provider-matrix-evidence']);
  const providerPins = await loadProviderPins();

  const manifest = buildManifest({
    commit: values.commit,
    dirty: values.dirty === 'true',
    osImage: values['os-image'],
    nodeVersion: values['node-version'],
    pnpmVersion: values['pnpm-version'],
    providerPins,
    gates,
    artifacts,
    signingStatus: 'unsigned',
    documentedExceptions: JSON.parse(values['documented-exceptions-json']),
    providerMatrix,
  });

  await writeFile(values.out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`release-candidate: wrote manifest to ${values.out} (ready: ${manifest.ready})`);
  if (!manifest.ready) {
    console.error(`release-candidate: NOT ready -- failed gates: ${manifest.failedGates.join(', ')}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('release-candidate: failed to generate manifest', error);
    process.exitCode = 1;
  });
}
