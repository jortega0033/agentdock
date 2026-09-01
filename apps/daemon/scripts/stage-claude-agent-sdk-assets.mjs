import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

// The SDK is owned by agent-runtime.  Resolve through that workspace package so pnpm's isolated
// linker never relies on an accidental daemon-level hoist.
const agentRuntimeRequire = createRequire(
  new URL('../../../packages/agent-runtime/package.json', import.meta.url),
);
const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
const WINDOWS_X64_PACKAGE = '@anthropic-ai/claude-agent-sdk-win32-x64';
const execFileAsync = promisify(execFile);

function packageDirectory(packageName) {
  return dirname(agentRuntimeRequire.resolve(packageName));
}

function binarySourcePath() {
  return agentRuntimeRequire.resolve(`${WINDOWS_X64_PACKAGE}/claude.exe`);
}

async function readPackageMetadata(packageDirectory) {
  const raw = await readFile(join(packageDirectory, 'package.json'), 'utf8');
  return JSON.parse(raw);
}

async function verifySdkBinary(binaryPath, expectedVersion) {
  let output;
  try {
    const result = await execFileAsync(binaryPath, ['--version'], {
      timeout: 15_000,
      windowsHide: true,
    });
    output = `${result.stdout}\n${result.stderr}`;
  } catch {
    throw new Error('Claude Agent SDK executable version probe failed');
  }
  if (!new RegExp(`(?:^|\\D)${expectedVersion.replaceAll('.', '\\.')}($|\\D)`, 'u').test(output)) {
    throw new Error('Claude Agent SDK executable version does not match its package metadata');
  }
}

/**
 * Stages the SDK binary as a real daemon resource.  It must remain outside Electron's ASAR:
 * SDK hosts pass this exact absolute path as pathToClaudeCodeExecutable rather than asking the
 * SDK to discover an executable from a bundled module graph.
 *
 * The notices travel with the executable because neither the SDK nor its native platform
 * package is OSS-licensed.  Release branding must use "Claude Agent" (not "Claude Code" or
 * "Claude Code Agent"); see the generated NOTICE.txt and Anthropic Commercial Terms.
 */
export async function stageClaudeAgentSdkAssets({
  destinationRoot = resolve(import.meta.dirname, '..', 'dist', 'claude-agent-sdk'),
  runtimePlatform = process.platform,
} = {}) {
  // The current release packages a native Windows x64 asset only.  Linux CI must be able to
  // build the daemon without installing a foreign optional package; runtime selection will
  // instead return sdk_asset_missing and never search PATH.
  if (runtimePlatform !== 'win32') return { skipped: true, destinationRoot };
  const sdkDirectory = packageDirectory(SDK_PACKAGE);
  const binaryPath = binarySourcePath();
  const binaryDirectory = dirname(binaryPath);
  const [sdkMetadata, binaryMetadata] = await Promise.all([
    readPackageMetadata(sdkDirectory),
    readPackageMetadata(binaryDirectory),
  ]);
  if (
    sdkMetadata.version !== binaryMetadata.version ||
    typeof sdkMetadata.claudeCodeVersion !== 'string'
  ) {
    throw new Error('Claude Agent SDK package metadata is inconsistent');
  }
  await verifySdkBinary(binaryPath, sdkMetadata.claudeCodeVersion);
  await mkdir(destinationRoot, { recursive: true });

  await Promise.all([
    copyFile(binaryPath, join(destinationRoot, 'claude.exe')),
    copyFile(join(sdkDirectory, 'LICENSE.md'), join(destinationRoot, 'LICENSE.sdk.md')),
    copyFile(join(sdkDirectory, 'README.md'), join(destinationRoot, 'README.sdk.md')),
    copyFile(join(binaryDirectory, 'LICENSE.md'), join(destinationRoot, 'LICENSE.win32-x64.md')),
    copyFile(join(binaryDirectory, 'README.md'), join(destinationRoot, 'README.win32-x64.md')),
  ]);
  await writeFile(
    join(destinationRoot, 'NOTICE.txt'),
    [
      `Claude Agent SDK ${sdkMetadata.version} / executable ${sdkMetadata.claudeCodeVersion} packaged asset notice`,
      '',
      'The SDK and native executable are subject to Anthropic Commercial Terms and their included notices.',
      'Do not offer claude.ai login or subscription credentials through this integration.',
      'Permitted product label: Claude Agent. Do not use: Claude Code, Claude Code Agent.',
      'Terms: https://www.anthropic.com/legal/commercial-terms',
      'Branding: https://code.claude.com/docs/en/agent-sdk/overview',
      '',
    ].join('\n'),
    'utf8',
  );
  return {
    destinationRoot,
    executablePath: join(destinationRoot, 'claude.exe'),
    sdkVersion: sdkMetadata.version,
    claudeCodeVersion: sdkMetadata.claudeCodeVersion,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await stageClaudeAgentSdkAssets();
}
