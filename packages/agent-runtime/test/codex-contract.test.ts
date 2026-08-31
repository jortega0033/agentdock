import { buildCodexArgs } from '../src/providers/codex/build-args.js';
import { CODEX_PROMPT_VIA_STDIN } from '../src/providers/codex/adapter.js';
import { CODEX_CAPABILITIES } from '../src/providers/codex/capabilities.js';
import { parseCodexLine } from '../src/providers/codex/parser.js';
import { describeProviderContract } from './support/provider-contract.js';

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
