// Reports its own process.env back as an assistant.message, so a test can assert exactly what
// environment actually reached a spawned provider process (issue #53) end to end, not just what
// the builder function claims it would produce.
const lines = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'env-echo-fixture-session-id' }),
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: JSON.stringify(process.env) }] },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    session_id: 'env-echo-fixture-session-id',
  }),
];

process.stdout.write(lines.join('\n') + '\n');
