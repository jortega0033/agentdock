// Simulates `codex exec -` reading its prompt from stdin (issue #57) rather than argv — reads
// stdin to completion, then emits it back inside a normal Codex-shaped
// thread.started/turn.started/item.completed(agent_message)/turn.completed sequence so
// parseCodexLine normalizes it exactly like a real response. Used to prove the prompt survives
// spawnProcess -> child.stdin.write()/.end() byte-for-byte for the real Codex argv/parser pair,
// including spaces, quotes, newlines, multi-byte Unicode, and the empty-string boundary.
//
// The echoed text is JSON-encoded (never the raw received bytes) because parseCodexLine
// legitimately drops an agent_message whose text is the empty string (real Codex behavior, not a
// bug this fixture should route around) — JSON.stringify('') is the two-character string `""`,
// always non-empty, so the empty-prompt case still produces an observable, decodable event.
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const received = Buffer.concat(chunks).toString('utf8');
  const events = [
    { type: 'thread.started', thread_id: 'codex-stdin-echo-thread-id' },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: JSON.stringify(received) },
    },
    {
      type: 'turn.completed',
      usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 },
    },
  ];
  for (const event of events) {
    process.stdout.write(JSON.stringify(event) + '\n');
  }
});
