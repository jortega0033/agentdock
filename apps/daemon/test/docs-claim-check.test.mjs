import { describe, expect, it } from 'vitest';
import {
  BANNED_TERMINOLOGY,
  REQUIRED_MATRIX_CATEGORIES,
  findLinkViolations,
  findMatrixGaps,
  findTerminologyViolations,
  headingAnchors,
  stripCode,
} from '../../../scripts/docs-claim-check.mjs';

describe('stripCode', () => {
  it('blanks fenced code blocks and inline spans while preserving line numbers', () => {
    const markdown = 'before\n```\nlegacy Claude CLI\n```\nafter `legacy-one-shot` end';
    const stripped = stripCode(markdown);
    expect(stripped.split(/\r?\n/)).toHaveLength(markdown.split(/\r?\n/).length);
    expect(stripped).not.toContain('legacy Claude CLI');
    expect(stripped).not.toContain('legacy-one-shot');
    expect(stripped).toContain('before');
    expect(stripped).toContain('after');
    expect(stripped).toContain('end');
  });
});

describe('findTerminologyViolations', () => {
  it('flags public prose that brands the vendor CLI itself as legacy', () => {
    const markdown = 'Use the legacy Claude CLI for this path.';
    const violations = findTerminologyViolations(markdown, 'fixture.md');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: 'fixture.md', line: 1 });
  });

  it('reports the correct original line number even after an earlier stripped code block', () => {
    const markdown = ['# Heading', '', '```js', 'const legacy = 1;', '```', '', 'The legacy Claude CLI is old.'].join(
      '\n',
    );
    const violations = findTerminologyViolations(markdown, 'fixture.md');
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(7);
    expect(violations[0].text).toBe('The legacy Claude CLI is old.');
  });

  it('does not flag an internal identifier inside inline code or a fenced block', () => {
    const markdown = [
      'Uses `LEGACY_ONE_SHOT_TRANSPORT_ID` and the `legacy-one-shot` string.',
      '```ts',
      "const id = 'legacy-one-shot'; // legacy Claude CLI inside code, ignored",
      '```',
    ].join('\n');
    expect(findTerminologyViolations(markdown, 'fixture.md')).toEqual([]);
  });

  it('does not flag Codex CLI branding when only Claude is mentioned, and vice versa', () => {
    expect(findTerminologyViolations('the legacy Claude CLI', 'a.md')).toHaveLength(1);
    expect(findTerminologyViolations('the legacy Codex CLI', 'b.md')).toHaveLength(1);
    expect(findTerminologyViolations('a legacy stack, unrelated to any CLI', 'c.md')).toEqual([]);
  });

  it('every banned pattern is a real RegExp', () => {
    expect(BANNED_TERMINOLOGY.length).toBeGreaterThan(0);
    for (const pattern of BANNED_TERMINOLOGY) expect(pattern).toBeInstanceOf(RegExp);
  });
});

describe('headingAnchors', () => {
  it('slugifies headings the way GitHub does, including duplicates', () => {
    const markdown = '# My Heading\n## My Heading\n### Another One!';
    const anchors = headingAnchors(markdown);
    expect(anchors.has('my-heading')).toBe(true);
    expect(anchors.has('my-heading-1')).toBe(true);
    expect(anchors.has('another-one')).toBe(true);
  });
});

describe('findLinkViolations', () => {
  it('accepts a relative link to a real file and a real heading anchor', () => {
    expect(
      findLinkViolations('See [x](docs/troubleshooting.md#claude-transport-mode-is-unavailable)', 'README.md'),
    ).toEqual([]);
  });

  it('flags a relative link to a file that does not exist', () => {
    const violations = findLinkViolations('See [x](docs/does-not-exist.md)', 'README.md');
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain('does not exist');
  });

  it('flags a relative link to a real file with a heading anchor that does not exist', () => {
    const violations = findLinkViolations('See [x](docs/troubleshooting.md#nonexistent-heading)', 'README.md');
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain('no heading');
  });

  it('ignores external links, mailto links, and same-page anchors', () => {
    expect(findLinkViolations('[x](https://example.com/nope)', 'README.md')).toEqual([]);
    expect(findLinkViolations('[x](mailto:test@example.com)', 'README.md')).toEqual([]);
    expect(findLinkViolations('[x](#some-local-anchor)', 'README.md')).toEqual([]);
  });
});

describe('findMatrixGaps', () => {
  it('returns no gaps when every required category is present', () => {
    const markdown = REQUIRED_MATRIX_CATEGORIES.map((category) => `## ${category}`).join('\n');
    expect(findMatrixGaps(markdown)).toEqual([]);
  });

  it('reports exactly the missing categories', () => {
    const markdown = REQUIRED_MATRIX_CATEGORIES.filter((c) => c !== 'Fork' && c !== 'Attachments').join('\n');
    expect(findMatrixGaps(markdown)).toEqual(['Fork', 'Attachments']);
  });
});

describe('the real docs/capability-matrix.md', () => {
  it('covers every required category with no gaps', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL('../../../docs/capability-matrix.md', import.meta.url));
    const markdown = readFileSync(path, 'utf8');
    expect(findMatrixGaps(markdown)).toEqual([]);
  });
});
