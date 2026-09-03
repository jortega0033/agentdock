import { buildCodexArgs } from '../src/providers/codex/build-args.js';
import { CODEX_PROMPT_VIA_STDIN } from '../src/providers/codex/adapter.js';
import { CODEX_CAPABILITIES } from '../src/providers/codex/capabilities.js';
import { parseCodexLine } from '../src/providers/codex/parser.js';
import { describeProviderContract } from './support/provider-contract.js';
import { describe, expect, it } from 'vitest';

describeProviderContract({
  providerId: 'codex',
  fixtureSet: 'codex-legacy-0.147.0-v1',
  capabilities: CODEX_CAPABILITIES,
  parseLine: parseCodexLine,
  buildArgs: buildCodexArgs,
  promptViaStdin: CODEX_PROMPT_VIA_STDIN,
  fixtures: {
    // Codex's own parser ignores the one unrecognized system/init-shaped line in this fixture
    // the same way it ignores any other event kind it doesn't know — reusing it here (rather than
    // adding a near-duplicate) is exactly the "unknown events don't crash the adapter" guarantee
    // this suite checks.
    success: 'fake-codex-success.mjs',
    failure: 'fake-claude-failure.mjs',
    hang: 'fake-hang.mjs',
  },
  expectedAssistantText: 'done',
  expectedProviderSessionId: 'codex-fixture-thread-id',
});

describe('Codex pinned fallback scope', () => {
  it('adds an explicit sandbox only when a pinned cross-transport launch requests one', () => {
    expect(
      buildCodexArgs({
        sessionId: 'session-1',
        cwd: '/workspace',
        prompt: 'hello',
        sandbox: 'workspace-write',
        model: 'gpt-5.4',
      }),
    ).toEqual([
      'exec',
      '-',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '--model',
      'gpt-5.4',
    ]);
  });

  it('fails closed instead of dropping a sandbox pin on resumed exec', () => {
    expect(() =>
      buildCodexArgs({
        sessionId: 'session-2',
        cwd: '/workspace',
        prompt: 'continue',
        resumeProviderSessionId: 'native-thread-1',
        sandbox: 'workspace-write',
        model: 'gpt-5.4',
      }),
    ).toThrow('cannot preserve an explicit sandbox scope');
  });
});
