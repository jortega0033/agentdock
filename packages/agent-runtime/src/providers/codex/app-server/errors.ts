export class CodexAppServerProtocolError extends Error {
  constructor(
    readonly code:
      | 'closed'
      | 'forbidden_method'
      | 'frame_invalid'
      | 'frame_too_large'
      | 'interaction_invalid'
      | 'process_failed'
      | 'response_invalid'
      | 'state_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'CodexAppServerProtocolError';
  }
}

export function boundedUtf8(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString('utf8');
}

export function safeDisplay(value: unknown, maximumBytes: number, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const printable = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || /\p{Cf}/u.test(character)
      ? ' '
      : character;
  }).join('');
  return boundedUtf8(printable, maximumBytes);
}
