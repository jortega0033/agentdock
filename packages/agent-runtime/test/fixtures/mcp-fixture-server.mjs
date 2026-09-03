#!/usr/bin/env node
// A small, real MCP stdio server for tests: speaks real newline-delimited JSON-RPC 2.0, not a
// mock of the transport. Exercises exactly the behaviors issue #56's tests need: a read-only
// tool, a destructive tool, a tool that errors, one that returns an oversized result, one that
// never responds (timeout), and a crash mode. Never touches a real credential or network resource.
import { createInterface } from 'node:readline';

const mode = process.env.AGENTDOCK_FIXTURE_MODE ?? 'normal';

const rl = createInterface({ input: process.stdin, terminal: false });

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}

const TOOLS = [
  { name: 'echo', description: 'Echoes its input.', annotations: { readOnlyHint: true } },
  { name: 'delete_file', description: 'Deletes a file.', annotations: { destructiveHint: true } },
  { name: 'no_hints', description: 'Declares no annotations at all.' },
  { name: 'false_destructive_hint', description: 'Declares destructiveHint:false but no readOnlyHint.', annotations: { destructiveHint: false } },
  { name: 'fails', description: 'Always reports isError.' },
  { name: 'huge', description: 'Returns an oversized result.' },
  { name: 'hang', description: 'Never responds.' },
  { name: 'crash', description: 'Exits the process immediately.' },
  { name: 'env_probe', description: 'Reports one of this process\'s own env var values.', annotations: { readOnlyHint: true } },
];

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (frame.method === 'notifications/initialized') return;
  const { id, method, params } = frame;

  if (mode === 'garbage') {
    process.stdout.write('this is not json\n');
    return;
  }
  if (mode === 'oversized_line') {
    process.stdout.write(`${'x'.repeat(6 * 1024 * 1024)}\n`);
    return;
  }

  if (method === 'initialize') {
    if (mode === 'slow_init') return; // never responds -- exercises connect timeout
    respond(id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agentdock-fixture', version: '1' } });
    return;
  }
  if (method === 'tools/list') {
    if (mode === 'no_optional_methods') return respondError(id, 'Method not found');
    respond(id, { tools: TOOLS });
    return;
  }
  if (method === 'resources/list' || method === 'prompts/list') {
    respondError(id, 'Method not found');
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    if (name === 'echo' || name === 'delete_file' || name === 'no_hints' || name === 'false_destructive_hint') {
      respond(id, { content: { received: params?.arguments ?? {} } });
      return;
    }
    if (name === 'fails') {
      respond(id, { isError: true, content: 'simulated failure' });
      return;
    }
    if (name === 'huge') {
      respond(id, { content: { blob: 'y'.repeat(2 * 1024 * 1024) } });
      return;
    }
    if (name === 'hang') {
      return; // deliberately never responds
    }
    if (name === 'crash') {
      process.exit(1);
    }
    if (name === 'env_probe') {
      const varName = params?.arguments?.name;
      respond(id, { content: { value: typeof varName === 'string' ? (process.env[varName] ?? null) : null } });
      return;
    }
    respondError(id, `unknown tool: ${String(name)}`);
    return;
  }
  respondError(id, `unknown method: ${String(method)}`);
});
