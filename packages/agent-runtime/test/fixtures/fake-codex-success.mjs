// Simulates `codex exec --json ...` on success, including a tool call lifecycle.
const events = [
  { type: 'thread.started', thread_id: 'codex-fixture-thread-id' },
  { type: 'turn.started' },
  {
    type: 'item.started',
    item: { id: 'item_0', type: 'command_execution', command: 'echo hi', status: 'in_progress' },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item_0',
      type: 'command_execution',
      command: 'echo hi',
      aggregated_output: 'hi\n',
      exit_code: 0,
      status: 'completed',
    },
  },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'done' } },
  // Provider adapters must ignore event kinds they don't recognize yet, not crash on them.
  { type: 'totally_unrecognized_future_event', anything: 'goes here' },
  { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 6, cached_input_tokens: 2 } },
];

for (const event of events) {
  process.stdout.write(JSON.stringify(event) + '\n');
}
