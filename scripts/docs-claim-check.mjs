#!/usr/bin/env node
// Guards the truthfulness fixes from issue #63 against silent regression: every public doc still
// resolves its internal links, nobody reintroduces "legacy Claude/Codex CLI" branding (the vendor
// CLI, not the internal `legacy-one-shot` transport identifier, which is fine), and
// docs/capability-matrix.md still covers every capability category the matrix promises. This is
// deliberately mechanical (exact phrases, real files, real headings) rather than a semantic claims
// classifier: a check that produces false positives/negatives erodes trust faster than no check.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

/** Every Markdown file this check treats as "public" -- the surface issue #63 is about. */
export function publicDocFiles(root = repoRoot) {
  const topLevel = ['README.md', 'CONTRIBUTING.md', 'DEVELOPMENT.md', 'SECURITY.md'];
  const docsDir = join(root, 'docs');
  const docs = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) docs.push(relative(root, full).split('\\').join('/'));
    }
  };
  walk(docsDir);
  return [...topLevel.filter((f) => statSync(join(root, f), { throwIfNoEntry: false }))].concat(
    docs.sort(),
  );
}

/** Strips fenced code blocks and inline code spans so a banned phrase inside a real code
 * identifier (e.g. `legacy-one-shot`, a filename) never trips the terminology check. Replaces each
 * stripped span with same-length blanks (blank lines for fenced blocks) rather than deleting it, so
 * every remaining line keeps its original 1-based line number for accurate reporting. */
export function stripCode(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\r\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
}

/** Public-facing phrases that brand the vendor CLI itself as "legacy" rather than describing the
 * one-shot compatibility transport precisely (issue #63). Case-insensitive, matched after code is
 * stripped, so `LEGACY_ONE_SHOT_TRANSPORT_ID` and the `legacy-one-shot` string literal never match. */
export const BANNED_TERMINOLOGY = [
  /\blegacy claude(?:\s+cli)?\b/i,
  /\bthe legacy claude cli\b/i,
  /\bclaude legacy cli\b/i,
  /\blegacy codex(?:\s+cli)?\b/i,
  /\bthe legacy codex cli\b/i,
  /\bcodex legacy(?:\s+cli|\s+exec)?\b/i,
];

export function findTerminologyViolations(markdown, filePath) {
  const strippedLines = stripCode(markdown).split(/\r?\n/);
  const originalLines = markdown.split(/\r?\n/);
  const violations = [];
  strippedLines.forEach((line, index) => {
    const matched = BANNED_TERMINOLOGY.some((pattern) => pattern.test(line));
    if (matched) {
      violations.push({
        file: filePath,
        line: index + 1,
        text: (originalLines[index] ?? line).trim(),
        reason:
          'brands the vendor CLI itself as "legacy" -- use "Claude/Codex CLI (one-shot) compatibility transport" instead',
      });
    }
  });
  return violations;
}

/** Every heading in a Markdown file, as the anchor slug GitHub/most renderers would generate. */
export function headingAnchors(markdown) {
  const anchors = new Set();
  const seen = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const slug = match[1]
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

/** Relative Markdown links only -- external `http(s)://` links are out of scope (no network calls
 * in a fast, offline CI check). */
export function findLinkViolations(markdown, filePath, root = repoRoot) {
  const violations = [];
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(markdown))) {
    const target = match[1].trim();
    if (/^[a-z]+:\/\//i.test(target) || target.startsWith('mailto:') || target.startsWith('#')) {
      continue;
    }
    const [pathPart, anchor] = target.split('#');
    if (!pathPart) continue;
    const resolvedPath = resolve(dirname(join(root, filePath)), pathPart);
    if (!statSync(resolvedPath, { throwIfNoEntry: false })) {
      violations.push({ file: filePath, target, reason: `target file does not exist: ${pathPart}` });
      continue;
    }
    if (anchor && resolvedPath.endsWith('.md')) {
      const anchors = headingAnchors(readFileSync(resolvedPath, 'utf8'));
      if (!anchors.has(anchor)) {
        violations.push({
          file: filePath,
          target,
          reason: `no heading in ${pathPart} produces the anchor #${anchor}`,
        });
      }
    }
  }
  return violations;
}

/** Every capability-matrix category issue #63 requires, so the check fails loudly if a row is
 * ever deleted rather than silently going stale. */
export const REQUIRED_MATRIX_CATEGORIES = [
  'Fresh run',
  'Streaming',
  'Tools',
  'Approvals',
  'Questions',
  'Cancellation',
  'Resume',
  'Fork',
  'MCP operations',
  'Components',
  'Child-agent',
  'Attachments',
  'Structured output',
  'Known limitations',
];

export function findMatrixGaps(markdown) {
  return REQUIRED_MATRIX_CATEGORIES.filter(
    (category) => !markdown.toLowerCase().includes(category.toLowerCase()),
  );
}

function main() {
  const files = publicDocFiles(repoRoot);
  const allViolations = [];

  for (const file of files) {
    const markdown = readFileSync(join(repoRoot, file), 'utf8');
    allViolations.push(...findTerminologyViolations(markdown, file));
    allViolations.push(...findLinkViolations(markdown, file, repoRoot));
  }

  const matrixPath = 'docs/capability-matrix.md';
  const matrixMarkdown = readFileSync(join(repoRoot, matrixPath), 'utf8');
  const gaps = findMatrixGaps(matrixMarkdown);
  if (gaps.length > 0) {
    allViolations.push({
      file: matrixPath,
      reason: `missing required capability categor${gaps.length === 1 ? 'y' : 'ies'}: ${gaps.join(', ')}`,
    });
  }

  if (allViolations.length === 0) {
    console.log(`docs-claim-check: ${files.length} public docs checked, clean.`);
    return;
  }

  console.error(`docs-claim-check: ${allViolations.length} problem(s) found:\n`);
  for (const violation of allViolations) {
    const location = violation.line ? `${violation.file}:${violation.line}` : violation.file;
    console.error(`  ${location} — ${violation.reason}`);
    if (violation.text) console.error(`    "${violation.text}"`);
  }
  console.error('');
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
