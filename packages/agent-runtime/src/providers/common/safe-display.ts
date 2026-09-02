/**
 * Bounding/sanitizing helpers for untrusted, provider-controlled strings -- originally scoped to
 * Codex app-server's wire-event content (see codex/app-server/errors.ts, which re-exports these
 * for its existing call sites), promoted here so every provider adapter's diagnostics can use the
 * same, already-reviewed bounding logic rather than logging an attacker/provider-controlled string
 * verbatim (issue #67: a provider-supplied event type/category string reaching a log call
 * unbounded and unsanitized is a log-injection surface, not just a size risk).
 */
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
