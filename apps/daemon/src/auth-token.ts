import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Generates the daemon's local authorization token. See docs/security.md for the threat model. */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function tokensMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function extractBearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith('Bearer ')) return undefined;
  return value.slice('Bearer '.length);
}
