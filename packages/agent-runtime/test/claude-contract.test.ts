import { buildClaudeArgs } from '../src/providers/claude/build-args.js';
import { CLAUDE_PROMPT_VIA_STDIN } from '../src/providers/claude/adapter.js';
import { CLAUDE_CAPABILITIES } from '../src/providers/claude/capabilities.js';
import { parseClaudeLine } from '../src/providers/claude/parser.js';
import { describeProviderContract } from './support/provider-contract.js';

describeProviderContract({
  providerId: 'claude',
  fixtureSet: 'claude-legacy-2.1.228-v1',
  capabilities: CLAUDE_CAPABILITIES,
  parseLine: parseClaudeLine,
  buildArgs: buildClaudeArgs,
  promptViaStdin: CLAUDE_PROMPT_VIA_STDIN,
  fixtures: {
    success: 'fake-claude-success.mjs',
    failure: 'fake-claude-failure.mjs',
    hang: 'fake-hang.mjs',
  },
  expectedAssistantText: 'hello from fixture',
  expectedProviderSessionId: 'claude-fixture-session-id',
});
