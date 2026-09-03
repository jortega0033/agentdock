#!/usr/bin/env node
// Fails fast, before pnpm resolves or links anything, when the active Node/pnpm toolchain isn't
// one this repo actually tests (issue #64). Wired as package.json's "preinstall" script, so it
// runs automatically as the first step of `pnpm install` — not an opt-in step someone can skip.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(scriptDir, '..', 'package.json');

/** The only Node major versions this repo's CI actually exercises (ci.yml's matrix; a separate
 * windows-test.yml matrixes the same range on Windows, see issue #60). */
export const SUPPORTED_NODE_RANGE = Object.freeze({ minMajor: 20, maxMajorExclusive: 23 });

export function parseSemver(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function isNodeVersionSupported(version, range = SUPPORTED_NODE_RANGE) {
  const parsed = parseSemver(version);
  return (
    parsed !== undefined && parsed.major >= range.minMajor && parsed.major < range.maxMajorExclusive
  );
}

/** Parses `pnpm/<version> ...` out of the npm_config_user_agent pnpm itself sets for every
 * lifecycle script it runs — reading this avoids spawning a child process to ask "which pnpm is
 * this," which would need shell:true (and its own quoting risk) to resolve pnpm.cmd on Windows. */
export function parseActivePnpmVersion(userAgent) {
  const match = /^pnpm\/(\S+)/.exec(String(userAgent ?? ''));
  return match?.[1];
}

export function pnpmVersionMatches(activeVersion, declaredVersion) {
  const active = parseSemver(activeVersion);
  const declared = parseSemver(declaredVersion);
  return (
    active !== undefined &&
    declared !== undefined &&
    active.major === declared.major &&
    active.minor === declared.minor &&
    active.patch === declared.patch
  );
}

export function parseDeclaredPnpmVersion(packageManagerField) {
  const match = /^pnpm@(\S+)$/.exec(String(packageManagerField ?? ''));
  return match?.[1];
}

export function buildReport({ nodeVersion, userAgent, declaredPnpmField, platform, arch }) {
  const nodeOk = isNodeVersionSupported(nodeVersion);
  const activePnpm = parseActivePnpmVersion(userAgent);
  const declaredPnpm = parseDeclaredPnpmVersion(declaredPnpmField);
  const pnpmOk = activePnpm !== undefined && pnpmVersionMatches(activePnpm, declaredPnpm);
  const { minMajor, maxMajorExclusive } = SUPPORTED_NODE_RANGE;

  const lines = [
    `Node:     ${nodeVersion} (${nodeOk ? 'supported' : 'UNSUPPORTED'} — this repo tests ${minMajor}.x through ${maxMajorExclusive - 1}.x)`,
    `pnpm:     ${activePnpm ?? 'not detected (are you running "pnpm install", not npm/yarn?)'} (${pnpmOk ? 'matches packageManager' : `expected ${declaredPnpm ?? 'unknown'}`})`,
    `Platform: ${platform} (${arch})`,
  ];

  const fixes = [];
  if (!nodeOk) {
    fixes.push(
      `Unsupported Node version. Install Node ${minMajor}.x or ${maxMajorExclusive - 1}.x from https://nodejs.org/, or switch with a version manager (nvm/fnm/volta).`,
    );
  }
  if (!pnpmOk) {
    fixes.push(
      [
        `pnpm ${activePnpm ?? '(not detected)'} does not match this repo's pinned pnpm@${declaredPnpm ?? 'unknown'} ("packageManager" in package.json).`,
        '  corepack enable',
        `  corepack prepare pnpm@${declaredPnpm ?? '<version>'} --activate`,
        '  pnpm install',
        '',
        "If Corepack itself isn't available (some newer Node releases no longer bundle it by default):",
        '  npm install -g corepack',
        '  corepack enable',
        '',
        'Or skip Corepack entirely and install pnpm directly:',
        `  npm install -g pnpm@${declaredPnpm ?? '10'}`,
      ].join('\n'),
    );
  }

  return { ok: nodeOk && pnpmOk, lines, fixes };
}

function main() {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const report = buildReport({
    nodeVersion: process.version,
    userAgent: process.env.npm_config_user_agent,
    declaredPnpmField: pkg.packageManager,
    platform: process.platform,
    arch: process.arch,
  });

  console.log(report.lines.join('\n'));
  if (!report.ok) {
    console.error('');
    for (const fix of report.fixes) console.error(fix);
    console.error('');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
