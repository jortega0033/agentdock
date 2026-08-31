#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { sanitizeFixture, scanFixtureForSecrets } from './fixture-safety.mjs';

async function readInput(inputPath) {
  return inputPath === '-' ? readFile(0, 'utf8') : readFile(resolve(inputPath), 'utf8');
}

async function writeAtomically(outputPath, contents) {
  const destination = resolve(outputPath);
  const destinationDirectory = dirname(destination);
  await mkdir(destinationDirectory, { recursive: true });
  const temporary = resolve(
    destinationDirectory,
    `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  const [inputPath, outputPath, ...extra] = process.argv.slice(2);
  if (!inputPath || !outputPath || extra.length > 0 || outputPath === '-') {
    throw new Error('usage: node sanitize-fixture.mjs <input.json|-> <output.json>');
  }

  let parsed;
  try {
    parsed = JSON.parse(await readInput(inputPath));
  } catch {
    throw new Error('input is not valid JSON');
  }
  const sanitized = sanitizeFixture(parsed);
  const findings = scanFixtureForSecrets(sanitized);
  if (findings.length > 0) {
    const summary = findings.map(({ code, path }) => `${code} at ${path}`).join(', ');
    throw new Error(`sanitized fixture failed safety scan: ${summary}`);
  }
  await writeAtomically(outputPath, `${JSON.stringify(sanitized, null, 2)}\n`);
}

main().catch((error) => {
  console.error(
    `fixture sanitization failed: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
  process.exitCode = 1;
});
