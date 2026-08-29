import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../src/providers/claude/build-args.js';

describe('buildClaudeArgs — prompt transport (AD-05)', () => {
  it('never includes the prompt anywhere in the returned argv', () => {
    const prompt = 'this exact string must never appear in argv, not even split across elements';
    const args = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt });
    expect(args.join(' ')).not.toContain(prompt);
    expect(args).not.toContain(prompt);
  });

  it('never includes the prompt when resuming either', () => {
    const prompt = 'a resumed-session prompt that must also stay out of argv';
    const args = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt, resumeProviderSessionId: 'thread-1' });
    expect(args.join(' ')).not.toContain(prompt);
  });

  it('still passes -p, explicit --input-format text, and the session-id/resume flags', () => {
    const fresh = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi' });
    expect(fresh).toEqual(['-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--session-id', 'sess-1']);

    const resumed = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi', resumeProviderSessionId: 'thread-1' });
    expect(resumed).toEqual(['-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--resume', 'thread-1']);
  });

  it('does not change shape based on prompt length — a huge prompt is still absent from argv', () => {
    const hugePrompt = 'x'.repeat(500_000); // well beyond Windows' ~32,767-char argv limit
    const args = buildClaudeArgs({ sessionId: 'sess-1', cwd: '/tmp', prompt: hugePrompt });
    expect(args.join('').length).toBeLessThan(200); // just the flags, nowhere near the prompt size
  });
});
