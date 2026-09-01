import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROVIDER_DISPLAY_NAMES } from '@agent-dock/shared';

/**
 * Guards the release-visible provider identity policy: product UI may say "Claude Agent" (or
 * "Claude"), never "Claude Code" or "Claude Code Agent" — those names stay reserved for accurate
 * technical references to the separately installed, upstream Claude CLI (docs, error messages
 * naming the binary), never for the product-facing provider name. See
 * `packages/shared/src/provider.ts` and `packages/agent-runtime/src/providers/claude/sdk-version.ts`.
 */
const PROHIBITED_DISPLAY_NAMES = ['Claude Code', 'Claude Code Agent'];

/** Every release-visible renderer surface and generator that must render the provider name, not
 * hardcode it. */
const RELEASE_VISIBLE_SOURCE_FILES = [
  '../src/App.tsx',
  '../src/components/ProviderPanel.tsx',
  '../src/asset-capture-bridge.ts',
  '../../../scripts/assets/generate_public_assets.py',
  '../../../packages/agent-runtime/src/providers/claude/parser.ts',
];

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

describe('release-visible provider branding', () => {
  it('centralizes the approved Claude display name as "Claude Agent"', () => {
    expect(PROVIDER_DISPLAY_NAMES.claude).toBe('Claude Agent');
    expect(PROHIBITED_DISPLAY_NAMES).not.toContain(PROVIDER_DISPLAY_NAMES.claude);
  });

  it.each(RELEASE_VISIBLE_SOURCE_FILES)(
    'never reintroduces a prohibited SDK display name in %s',
    (relativePath) => {
      const source = readSource(relativePath);
      for (const prohibited of PROHIBITED_DISPLAY_NAMES) {
        expect(source).not.toContain(prohibited);
      }
    },
  );
});
