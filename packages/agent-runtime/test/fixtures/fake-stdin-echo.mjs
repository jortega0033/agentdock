// Simulates a headless CLI reading its prompt from stdin (AD-05) rather than argv — reads stdin
// to completion, then emits it back verbatim inside a normal Claude-shaped `assistant`/`result`
// JSONL pair so parseClaudeLine normalizes it exactly like a real response. Used to prove the
// prompt survives spawnProcess -> child.stdin.write()/.end() byte-for-byte, including spaces,
// quotes, newlines, and multi-byte Unicode.
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const received = Buffer.concat(chunks).toString('utf8');
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'stdin-echo-session-id' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: received }] } }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: received,
      session_id: 'stdin-echo-session-id',
    }),
  ];
  process.stdout.write(lines.join('\n') + '\n');
});
