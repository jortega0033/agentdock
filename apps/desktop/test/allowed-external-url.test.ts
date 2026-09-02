import { describe, expect, it, vi } from 'vitest';
import {
  externalUrlLogSummary,
  handleWillNavigate,
  handleWindowOpen,
  openAllowedExternalUrl,
  parseAllowedExternalUrl,
  resolveOAuthLaunch,
} from '../electron/allowed-external-url.js';

describe('parseAllowedExternalUrl', () => {
  const cases: Array<[label: string, input: string, allowed: boolean]> = [
    ['plain https URL', 'https://example.com/path', true],
    ['https with a query and fragment', 'https://example.com/path?a=1#frag', true],
    ['https with a non-default port', 'https://example.com:8443/', true],
    ['http (not https)', 'http://example.com/', false],
    ['file scheme', 'file:///etc/passwd', false],
    ['javascript scheme', 'javascript:alert(1)', false],
    ['data scheme', 'data:text/html,<script>alert(1)</script>', false],
    ['blob scheme', 'blob:https://example.com/uuid', false],
    ['mailto scheme', 'mailto:a@example.com', false],
    ['tel scheme', 'tel:+15551234567', false],
    ['custom/unregistered scheme', 'myapp://open?x=1', false],
    ['bare UNC path', '\\\\server\\share\\file', false],
    ['bare Windows path', 'C:\\Users\\person\\file.txt', false],
    ['bare POSIX path', '/etc/passwd', false],
    ['empty string', '', false],
    ['whitespace only', '   ', false],
    ['https with embedded username', 'https://user@example.com/', false],
    ['https with embedded username and password', 'https://user:pass@example.com/', false],
    // The WHATWG URL parser cannot represent an https URL with a truly empty host: an empty
    // authority throws (covered by 'garbage' below via the catch path), and any non-slash text
    // after "//" is consumed as the host instead. There is no reachable empty-hostname case for
    // this scheme; the check exists as defense in depth regardless.
    ['garbage', 'not a url at all', false],
  ];

  it.each(cases)('%s -> %s', (_label, input, allowed) => {
    const result = parseAllowedExternalUrl(input);
    if (allowed) {
      expect(result).toBeInstanceOf(URL);
      expect(result?.protocol).toBe('https:');
    } else {
      expect(result).toBeUndefined();
    }
  });
});

describe('externalUrlLogSummary', () => {
  it('exposes only scheme and host, never the query or fragment', () => {
    const url = new URL('https://example.com/path?token=SECRET#fragment-SECRET');
    const summary = externalUrlLogSummary(url);
    expect(summary).toEqual({ scheme: 'https:', host: 'example.com' });
    expect(JSON.stringify(summary)).not.toContain('SECRET');
  });
});

describe('openAllowedExternalUrl', () => {
  it('opens a valid https URL exactly once and logs a bounded summary', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    openAllowedExternalUrl('https://example.com/path?token=SECRET', openExternal, log);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/path?token=SECRET');
    expect(log).toHaveBeenCalledWith('opening external URL', {
      scheme: 'https:',
      host: 'example.com',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
  });

  it('never opens an unsafe URL and never logs the raw candidate', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    openAllowedExternalUrl('javascript:alert(document.cookie)', openExternal, log);
    expect(openExternal).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('document.cookie');
  });
});

describe('handleWindowOpen', () => {
  it('always denies the child window and opens externally only for a safe URL', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    expect(handleWindowOpen('https://example.com', openExternal, vi.fn())).toEqual({
      action: 'deny',
    });
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('denies the child window and never opens externally for an unsafe URL', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    expect(handleWindowOpen('file:///etc/passwd', openExternal, vi.fn())).toEqual({
      action: 'deny',
    });
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('handleWillNavigate', () => {
  const isAllowedTarget = (url: string) => url === 'https://app.internal/';

  it('lets navigation to the allowed target through without opening externally', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const prevented = handleWillNavigate(
      'https://app.internal/',
      isAllowedTarget,
      openExternal,
      vi.fn(),
    );
    expect(prevented).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('prevents navigation elsewhere and opens a safe target externally instead', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const prevented = handleWillNavigate(
      'https://example.com/',
      isAllowedTarget,
      openExternal,
      vi.fn(),
    );
    expect(prevented).toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('prevents navigation to an unsafe target and never opens it externally', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const prevented = handleWillNavigate(
      'javascript:alert(1)',
      isAllowedTarget,
      openExternal,
      vi.fn(),
    );
    expect(prevented).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('resolveOAuthLaunch', () => {
  it('returns undefined when the provider gave no authorization URL', () => {
    expect(resolveOAuthLaunch(undefined)).toBeUndefined();
  });

  it('returns the validated URL and bare host for a safe https authorization URL', () => {
    const launch = resolveOAuthLaunch('https://accounts.example.com/authorize?state=xyz');
    expect(launch?.host).toBe('accounts.example.com');
    expect(launch?.url.protocol).toBe('https:');
  });

  it('throws rather than silently dropping an unsafe provider-supplied URL', () => {
    expect(() => resolveOAuthLaunch('http://accounts.example.com/authorize')).toThrow(
      /unsafe OAuth URL/,
    );
    expect(() => resolveOAuthLaunch('javascript:alert(1)')).toThrow(/unsafe OAuth URL/);
  });
});
