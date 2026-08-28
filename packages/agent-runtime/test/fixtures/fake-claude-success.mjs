// Simulates `claude -p ... --output-format stream-json --verbose` on success.
// Writes output in awkward chunks (split JSON, multiple lines per write) to exercise the
// line-reader's chunk-boundary handling end to end, not just in isolation.
const lines = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-fixture-session-id' }),
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hello from fixture' }] },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'hello from fixture',
    total_cost_usd: 0.01,
    usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0 },
    session_id: 'claude-fixture-session-id',
  }),
];

const combined = lines.join('\n') + '\n';
// Split mid-line to prove partial-JSON-across-chunks is tolerated.
const splitPoint = Math.floor(combined.length / 2);
process.stdout.write(combined.slice(0, splitPoint));
setTimeout(() => {
  process.stdout.write(combined.slice(splitPoint));
}, 20);
