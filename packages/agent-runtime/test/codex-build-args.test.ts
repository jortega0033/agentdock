import { describe, expect, it } from 'vitest';
import { buildCodexArgs } from '../src/providers/codex/build-args.js';

describe('buildCodexArgs — prompt transport (issue #57)', () => {
  it('never includes the prompt anywhere in the returned argv', () => {
    const prompt = 'this exact string must never appear in argv, not even split across elements';
    const args = buildCodexArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt });
    expect(args.join(' ')).not.toContain(prompt);
    expect(args).not.toContain(prompt);
  });

  it('never includes the prompt when resuming either', () => {
    const prompt = 'a resumed-session prompt that must also stay out of argv';
    const args = buildCodexArgs({
      sessionId: 'sess-1',
      cwd: '/tmp',
      prompt,
      resumeProviderSessionId: 'thread-1',
    });
    expect(args.join(' ')).not.toContain(prompt);
  });

  it('uses the "-" stdin placeholder in the prompt position for a fresh session', () => {
    const args = buildCodexArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi' });
    expect(args).toEqual(['exec', '-', '--json', '--skip-git-repo-check']);
  });

  it('uses the "-" stdin placeholder in the prompt position when resuming', () => {
    const args = buildCodexArgs({
      sessionId: 'sess-1',
      cwd: '/tmp',
      prompt: 'hi',
      resumeProviderSessionId: 'thread-1',
    });
    expect(args).toEqual(['exec', 'resume', 'thread-1', '-', '--json', '--skip-git-repo-check']);
  });

  it('does not change shape based on prompt length — a huge prompt still yields the same short argv', () => {
    const hugePrompt = 'x'.repeat(500_000); // well beyond Windows' ~32,767-char argv limit
    const args = buildCodexArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: hugePrompt });
    expect(args).toEqual(['exec', '-', '--json', '--skip-git-repo-check']);
  });

  it('does not change argv shape for an empty-string prompt', () => {
    const args = buildCodexArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: '' });
    expect(args).toEqual(['exec', '-', '--json', '--skip-git-repo-check']);
  });

  it('does not change argv shape for a whitespace-only prompt', () => {
    const args = buildCodexArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: '   \n\t  ' });
    expect(args).toEqual(['exec', '-', '--json', '--skip-git-repo-check']);
  });

  it('still appends sandbox and model flags after the placeholder', () => {
    const args = buildCodexArgs({
      sessionId: 'sess-1',
      cwd: '/tmp',
      prompt: 'hi',
      sandbox: 'workspace-write',
      model: 'gpt-5.4',
    });
    expect(args).toEqual([
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
});
