import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  sanitizeFixture,
  scanFixtureForSecrets,
} from '../../../scripts/provider-fixtures/fixture-safety.mjs';

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(
  new URL('../../../scripts/provider-fixtures/sanitize-fixture.mjs', import.meta.url),
);
const CONFORMANCE_FIXTURES = fileURLToPath(new URL('./conformance/fixtures', import.meta.url));
const temporaryDirectories = [];

async function fixtureJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await fixtureJsonFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path);
  }
  return files;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('provider fixture safety', () => {
  it('removes prompts, paths, environments, credentials, reasoning, tool data, and free text', () => {
    const rawMarkers = [
      'DO_NOT_KEEP_PROMPT',
      'DO_NOT_KEEP_PATH',
      'DO_NOT_KEEP_ENV',
      'DO_NOT_KEEP_CREDENTIAL',
      'DO_NOT_KEEP_REASONING',
      'DO_NOT_KEEP_TOOL_INPUT',
      'DO_NOT_KEEP_TOOL_RESULT',
      'DO_NOT_KEEP_TEXT',
      'DO_NOT_KEEP_ARRAY_TEXT',
      'DO_NOT_KEEP_NOTE',
    ];
    const sanitized = sanitizeFixture({
      schemaVersion: 1,
      provider: 'claude',
      version: '2.1.228',
      transport: 'legacy-one-shot',
      scenario: 'tool-result',
      nativeInput: {
        prompt: rawMarkers[0],
        cwd: `C:\\Users\\person\\${rawMarkers[1]}`,
        env: { SAFE_NAME: rawMarkers[2] },
        authorization: `Bearer ${rawMarkers[3]}`,
      },
      nativeOutput: [
        {
          type: 'assistant',
          message: {
            content: [
              rawMarkers[8],
              { type: 'thinking', thinking: rawMarkers[4] },
              { type: 'text', text: rawMarkers[7] },
              { type: 'tool_use', id: 'call-1', input: { command: rawMarkers[5] } },
              { type: 'tool_result', tool_use_id: 'call-1', content: rawMarkers[6] },
            ],
          },
        },
      ],
      note: rawMarkers[9],
    });

    expect(sanitized).toMatchObject({
      schemaVersion: 1,
      provider: 'claude',
      version: '2.1.228',
      transport: 'legacy-one-shot',
      scenario: 'tool-result',
      nativeInput: {
        prompt: { $fixturePlaceholder: 'prompt' },
        cwd: { $fixturePlaceholder: 'working_directory' },
        env: { $fixturePlaceholder: 'environment' },
        authorization: { $fixturePlaceholder: 'credential' },
      },
      nativeOutput: [
        {
          type: 'assistant',
          message: {
            content: [
              { $fixturePlaceholder: 'free_text' },
              { type: 'thinking', thinking: { $fixturePlaceholder: 'reasoning' } },
              { type: 'text', text: { $fixturePlaceholder: 'free_text' } },
              {
                type: 'tool_use',
                id: 'call-1',
                input: { $fixturePlaceholder: 'tool_input' },
              },
              {
                type: 'tool_result',
                tool_use_id: 'call-1',
                content: { $fixturePlaceholder: 'tool_result' },
              },
            ],
          },
        },
      ],
      note: { $fixturePlaceholder: 'free_text' },
    });
    const encoded = JSON.stringify(sanitized);
    for (const marker of rawMarkers) expect(encoded).not.toContain(marker);
    expect(scanFixtureForSecrets(sanitized)).toEqual([]);
  });

  it('reports common credential, private-key, authorization, and home-path leaks without echoing them', () => {
    const syntheticApiKey = ['sk-ant-', 'abcdefghijklmnopqrstuv'].join('');
    const syntheticAuthorization = ['Authorization: Bearer ', 'abcdefghijklmnop'].join('');
    const syntheticPrivateKey = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    const findings = scanFixtureForSecrets({
      provider: 'codex',
      unsafe: [
        syntheticApiKey,
        syntheticAuthorization,
        syntheticPrivateKey,
        'C:\\Users\\private-user\\repo',
        '/home/private-user/repo',
      ],
      apiKey: 'not-a-pattern-but-still-sensitive',
    });

    expect(findings.map(({ code }) => code)).toEqual([
      'api_key_prefix',
      'authorization_value',
      'private_key',
      'windows_home_path',
      'unix_home_path',
      'sensitive_value',
    ]);
    expect(JSON.stringify(findings)).not.toContain('private-user');
    expect(JSON.stringify(findings)).not.toContain('abcdefghijklmnop');
  });

  it('keeps numeric usage counters structural while sensitive boundary fields fail closed', () => {
    const findings = scanFixtureForSecrets({
      input_tokens: 20,
      outputTokens: 6,
      cachedInputTokens: 2,
      prompt: 'private prompt without a token pattern',
      cwd: 'relative/private-workspace',
      env: { SAFE_LOOKING_NAME: 'private value' },
      authorization: 'opaque-value',
      toolResult: 'private tool output without a token pattern',
    });

    expect(findings).toEqual([
      { code: 'sensitive_value', path: '$.prompt' },
      { code: 'sensitive_value', path: '$.cwd' },
      { code: 'sensitive_value', path: '$.env' },
      { code: 'sensitive_value', path: '$.authorization' },
      { code: 'sensitive_value', path: '$.toolResult' },
    ]);
  });

  it('accepts only fixed, correctly typed redaction tags', () => {
    expect(scanFixtureForSecrets({ prompt: '<redacted:prompt>' })).toEqual([]);
    expect(
      scanFixtureForSecrets({
        prompt: '<redacted:not-approved>',
        authorization: '<redacted:prompt>',
        message: '<redacted:prompt>',
      }),
    ).toEqual([
      { code: 'invalid_redaction_tag', path: '$.prompt' },
      { code: 'placeholder_kind_mismatch', path: '$.authorization' },
      { code: 'placeholder_kind_mismatch', path: '$.message' },
    ]);
  });

  it('rejects unknown redaction syntax globally while accepting ordinary safe free text', () => {
    expect(
      scanFixtureForSecrets({
        status: '<redacted:mistyped>',
        message: 'ordinary safe free text',
        nested: ['safe <status> marker', '<REDACTED:prompt>'],
      }),
    ).toEqual([
      { code: 'invalid_redaction_tag', path: '$.status' },
      { code: 'invalid_redaction_tag', path: '$.nested[1]' },
    ]);
  });

  it('redacts and rejects raw native invocation prompt, stdin, session, and opaque operands', () => {
    // Codex exec's prompt travels over stdin, not argv (issue #57): its argv position holds a
    // fixed '-' literal, so a raw prompt for it is now only reachable via `stdin`.
    const rawArgvPrompt = 'DO_NOT_KEEP_ARGV_PROMPT';
    const rawStdinPrompt = 'DO_NOT_KEEP_STDIN_PROMPT';
    const rawSessionId = 'DO_NOT_KEEP_PROVIDER_SESSION_ID';
    const rawOpaqueOperand = 'DO_NOT_KEEP_OPAQUE_OPERAND';
    const raw = {
      nativeInput: [
        {
          argv: ['exec', 'resume', rawSessionId, '-', '--json', '--skip-git-repo-check'],
          stdin: rawArgvPrompt,
        },
        {
          argv: [
            '-p',
            '--input-format',
            'text',
            '--output-format',
            'stream-json',
            '--verbose',
            '--session-id',
            rawOpaqueOperand,
          ],
          stdin: rawStdinPrompt,
        },
      ],
    };

    const rawFindings = scanFixtureForSecrets(raw);
    expect(rawFindings).toEqual([
      { code: 'sensitive_value', path: '$.nativeInput[0].argv[2]' },
      { code: 'sensitive_value', path: '$.nativeInput[0].stdin' },
      { code: 'sensitive_value', path: '$.nativeInput[1].argv[7]' },
      { code: 'sensitive_value', path: '$.nativeInput[1].stdin' },
    ]);
    expect(JSON.stringify(rawFindings)).not.toContain('DO_NOT_KEEP');

    const sanitized = sanitizeFixture(raw);
    expect(sanitized).toEqual({
      nativeInput: [
        {
          argv: [
            'exec',
            'resume',
            { $fixturePlaceholder: 'free_text' },
            '-',
            '--json',
            '--skip-git-repo-check',
          ],
          stdin: { $fixturePlaceholder: 'prompt' },
        },
        {
          argv: [
            '-p',
            '--input-format',
            'text',
            '--output-format',
            'stream-json',
            '--verbose',
            '--session-id',
            { $fixturePlaceholder: 'free_text' },
          ],
          stdin: { $fixturePlaceholder: 'prompt' },
        },
      ],
    });
    const encoded = JSON.stringify(sanitized);
    for (const marker of [rawArgvPrompt, rawStdinPrompt, rawSessionId, rawOpaqueOperand]) {
      expect(encoded).not.toContain(marker);
    }
    expect(scanFixtureForSecrets(sanitized)).toEqual([]);
  });

  it('treats structural-looking text as sensitive in native argv operand slots', () => {
    // Codex exec's fresh-session grammar has no operand slot left (prompt travels over stdin, not
    // argv — issue #57); its resume grammar still has one (provider_session_id), exercised below
    // alongside Claude's own `--session-id` operand.
    const raw = {
      nativeInput: [
        {
          argv: ['exec', 'resume', 'text', '-', '--json', '--skip-git-repo-check'],
          stdin: null,
        },
        {
          argv: [
            '-p',
            '--input-format',
            'text',
            '--output-format',
            'stream-json',
            '--verbose',
            '--session-id',
            'resume',
          ],
          stdin: null,
        },
      ],
    };

    expect(scanFixtureForSecrets(raw)).toEqual([
      { code: 'sensitive_value', path: '$.nativeInput[0].argv[2]' },
      { code: 'sensitive_value', path: '$.nativeInput[1].argv[7]' },
    ]);
    const sanitized = sanitizeFixture(raw);
    expect(sanitized.nativeInput[0].argv[2]).toEqual({ $fixturePlaceholder: 'free_text' });
    expect(sanitized.nativeInput[1].argv[7]).toEqual({ $fixturePlaceholder: 'free_text' });
    expect(scanFixtureForSecrets(sanitized)).toEqual([]);
  });

  it('redacts unknown descendants inside sensitive provider payloads', () => {
    const raw = {
      type: 'tool_result',
      tool_use_id: 'fixture-call',
      future_payload: { nested: 'DO_NOT_KEEP_UNKNOWN_TOOL_RESULT' },
    };
    const sanitized = sanitizeFixture(raw);

    expect(sanitized).toEqual({
      type: 'tool_result',
      tool_use_id: 'fixture-call',
      future_payload: { $fixturePlaceholder: 'tool_result' },
    });
    expect(JSON.stringify(sanitized)).not.toContain('DO_NOT_KEEP_UNKNOWN_TOOL_RESULT');
    expect(scanFixtureForSecrets(raw)).toEqual([
      { code: 'sensitive_value', path: '$.future_payload' },
    ]);
    expect(scanFixtureForSecrets(sanitized)).toEqual([]);
  });

  it('scans secret-bearing property names without echoing them', () => {
    const syntheticSecretKey = ['sk-ant-', 'propertynamesecret'].join('');
    const findings = scanFixtureForSecrets({ [syntheticSecretKey]: 'structural value' });

    expect(findings).toEqual([{ code: 'api_key_prefix', path: '$["<redacted-key>"]' }]);
    expect(JSON.stringify(findings)).not.toContain('propertynamesecret');
  });

  it('preserves benign structural fields and accepts correctly typed placeholders', () => {
    const safe = {
      schemaVersion: 1,
      provider: 'codex',
      version: '0.147.0',
      transport: { id: 'legacy-one-shot', version: 'codex-jsonl-v1' },
      scenario: 'fresh-session',
      status: 'completed',
      requestId: '00000000-0000-4000-8000-000000000001',
      prompt: { $fixturePlaceholder: 'prompt' },
      message: { content: [{ type: 'text', text: { $fixturePlaceholder: 'free_text' } }] },
    };

    expect(sanitizeFixture(safe)).toEqual(safe);
    expect(scanFixtureForSecrets(safe)).toEqual([]);
  });

  it('CLI writes only scanned output and leaves an existing destination intact on invalid JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-dock-fixture-safety-'));
    temporaryDirectories.push(directory);
    const inputPath = join(directory, 'input.json');
    const outputPath = join(directory, 'output.json');
    await writeFile(
      inputPath,
      JSON.stringify({ provider: 'claude', prompt: 'RAW_PROMPT', token: 'RAW_TOKEN' }),
    );

    await execFileAsync(process.execPath, [CLI_PATH, inputPath, outputPath]);
    const output = await readFile(outputPath, 'utf8');
    expect(output).not.toContain('RAW_PROMPT');
    expect(output).not.toContain('RAW_TOKEN');
    expect(scanFixtureForSecrets(JSON.parse(output))).toEqual([]);

    await writeFile(inputPath, '{not-json');
    await expect(
      execFileAsync(process.execPath, [CLI_PATH, inputPath, outputPath]),
    ).rejects.toThrow();
    expect(await readFile(outputPath, 'utf8')).toBe(output);
  });

  it('accepts every checked-in conformance fixture', async () => {
    const files = await fixtureJsonFiles(CONFORMANCE_FIXTURES);
    expect(files.length).toBeGreaterThan(0);
    const violations = [];
    for (const file of files) {
      const fixture = JSON.parse(await readFile(file, 'utf8'));
      for (const finding of scanFixtureForSecrets(fixture)) {
        violations.push({ file: relative(CONFORMANCE_FIXTURES, file), ...finding });
      }
    }
    expect(violations).toEqual([]);
  });
});
