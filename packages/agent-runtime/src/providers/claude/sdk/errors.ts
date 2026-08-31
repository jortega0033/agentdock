export class ClaudeAgentSdkProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClaudeAgentSdkProtocolError';
  }
}

export function boundedDisplay(value: unknown, maximumBytes: number, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const clean = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join('');
  if (clean.length === 0) return fallback;
  const encoded = Buffer.from(clean, 'utf8');
  if (encoded.byteLength <= maximumBytes) return clean;
  return encoded
    .subarray(0, maximumBytes)
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ClaudeAgentSdkProtocolError('claude_sdk_frame_invalid', `Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

export function nativeId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 1_024 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new ClaudeAgentSdkProtocolError('claude_sdk_frame_invalid', `Invalid ${label}`);
  }
  return value;
}
