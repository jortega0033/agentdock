import { describe, expect, it } from 'vitest';
import { boundedUtf8, boundedUtf8FromBytes } from '../src/providers/common/safe-display.js';

// U+1D518 MATHEMATICAL FRAKTUR CAPITAL U -- 4 UTF-8 bytes (F0 9D 94 98). Placed right after a
// 2-byte ASCII prefix so a byte cap can land squarely inside its continuation bytes.
const FRAKTUR_U = '\u{1D518}';

describe('boundedUtf8', () => {
  it('returns the original string unchanged when it already fits', () => {
    expect(boundedUtf8('hello', 10)).toBe('hello');
  });

  it('truncates at a UTF-8 character boundary instead of splitting a multi-byte character', () => {
    const value = `ab${FRAKTUR_U}`;
    expect(Buffer.byteLength(value, 'utf8')).toBe(6);
    // Byte 3 falls inside the fraktur character's continuation bytes (bytes 2-5) -- the result
    // must back off to the last complete character, not emit a truncated/invalid code point.
    expect(boundedUtf8(value, 3)).toBe('ab');
    expect(boundedUtf8(value, 5)).toBe('ab');
    expect(boundedUtf8(value, 6)).toBe(value);
  });
});

describe('boundedUtf8FromBytes', () => {
  it('decodes the full buffer unchanged when it already fits', () => {
    const bytes = Buffer.from('hello', 'utf8');
    expect(boundedUtf8FromBytes(bytes, 10)).toBe('hello');
  });

  it('truncates at a UTF-8 character boundary instead of splitting a multi-byte character', () => {
    const value = `ab${FRAKTUR_U}`;
    const bytes = Buffer.from(value, 'utf8');
    expect(boundedUtf8FromBytes(bytes, 3)).toBe('ab');
    expect(boundedUtf8FromBytes(bytes, 5)).toBe('ab');
    expect(boundedUtf8FromBytes(bytes, 6)).toBe(value);
  });

  it('agrees with boundedUtf8 on the same string, for every cap around the multi-byte boundary', () => {
    const value = `ab${FRAKTUR_U}cd`;
    const bytes = Buffer.from(value, 'utf8');
    for (let cap = 0; cap <= bytes.byteLength + 1; cap += 1) {
      expect(boundedUtf8FromBytes(bytes, cap)).toBe(boundedUtf8(value, cap));
    }
  });
});
