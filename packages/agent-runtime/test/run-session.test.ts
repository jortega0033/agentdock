import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@agent-dock/shared';
import { noopLogger } from '../src/logger.js';
import { runProviderSession } from '../src/providers/common/run-session.js';
import { parseClaudeLine } from '../src/providers/claude/parser.js';
import { parseCodexLine } from '../src/providers/codex/parser.js';

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));

async function collectEvents(
  events: AsyncGenerator<AgentEvent, void, void>,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-dock-run-session-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('runProviderSession (spawns real node child processes via fixtures)', () => {
  it('runs a successful session end to end, tolerating split JSONL chunks', async () => {
    const handle = runProviderSession(
      {
        providerId: 'claude',
        executableNames: [process.execPath],
        buildArgs: () => [join(fixturesDir, 'fake-claude-success.mjs')],
        parseLine: parseClaudeLine,
      },
      { sessionId: 'test-session-1', cwd, prompt: 'hello' },
      noopLogger,
    );

    const events = await collectEvents(handle.events);
    expect(events[0]).toEqual({
      type: 'session.started',
      sessionId: 'test-session-1',
      provider: 'claude',
    });
    expect(events).toContainEqual({ type: 'assistant.message', text: 'hello from fixture' });
    const completed = events.at(-1);
    expect(completed).toMatchObject({
      type: 'session.completed',
      providerSessionId: 'claude-fixture-session-id',
    });
  });

  it('surfaces a non-zero exit without exposing provider stderr', async () => {
    const handle = runProviderSession(
      {
        providerId: 'claude',
        executableNames: [process.execPath],
        buildArgs: () => [join(fixturesDir, 'fake-claude-failure.mjs')],
        parseLine: parseClaudeLine,
      },
      { sessionId: 'test-session-2', cwd, prompt: 'hello' },
      noopLogger,
    );

    const events = await collectEvents(handle.events);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    const failed = events.at(-1);
    expect(failed).toMatchObject({ type: 'session.failed' });
    expect((failed as { message: string }).message).toContain('exited with code');
    expect((failed as { message: string }).message).not.toContain('fatal: something went wrong');
  });

  it('never copies provider stderr into the default failure message', async () => {
    const handle = runProviderSession(
      {
        providerId: 'claude',
        executableNames: [process.execPath],
        buildArgs: () => [join(fixturesDir, 'fake-claude-failure.mjs')],
        parseLine: parseClaudeLine,
      },
      { sessionId: 'test-session-2b', cwd, prompt: 'hello' },
      noopLogger,
    );

    const events = await collectEvents(handle.events);
    const failed = events.at(-1);
    expect(failed).toMatchObject({ type: 'session.failed' });
    expect((failed as { message: string }).message).not.toContain('fatal: something went wrong');
    expect((failed as { message: string }).message).toContain('exited with code');
  });

  it('logs only the stderr byte count on a non-zero exit', async () => {
    const logger = { debug: () => {}, info: () => {}, warn: vi.fn(), error: () => {} };
    const handle = runProviderSession(
      {
        providerId: 'claude',
        executableNames: [process.execPath],
        buildArgs: () => [join(fixturesDir, 'fake-claude-failure.mjs')],
        parseLine: parseClaudeLine,
      },
      { sessionId: 'test-session-2c', cwd, prompt: 'hello' },
      logger,
    );
    await collectEvents(handle.events);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('process exited non-zero'),
      expect.objectContaining({ stderrBytes: expect.any(Number) }),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('fatal: something went wrong');
  });

  it('keeps joined prompt, credential, and raw-approval canaries out of logs and failures', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const promptCanary = 'PROMPT_CANARY_do_not_log';
    const credentialCanary = 'sk-proj-CREDENTIAL_CANARY_do_not_log';
    const approvalCanary = 'RAW_APPROVAL_CANARY_do_not_log';
    const handle = runProviderSession(
      {
        providerId: 'claude',
        executableNames: [process.execPath],
        buildArgs: () => [
          '-e',
          "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write(process.env.AGENT_DOCK_TEST_STDERR??'');process.exitCode=1})",
        ],
        parseLine: parseClaudeLine,
        promptViaStdin: true,
      },
      {
        sessionId: 'sensitive-canary-session',
        cwd,
        prompt: promptCanary,
        env: {
          ...process.env,
          AGENT_DOCK_TEST_STDERR: `${credentialCanary} ${approvalCanary}`,
        },
      },
      logger,
    );
    const events = await collectEvents(handle.events);
    const observable = JSON.stringify({
      logs: Object.values(logger).flatMap((method) => method.mock.calls),
      events,
    });

    expect(observable).not.toContain(promptCanary);
    expect(observable).not.toContain(credentialCanary);
    expect(observable).not.toContain(approvalCanary);
    expect(events.at(-1)).toMatchObject({ type: 'session.failed' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('process exited non-zero'),
      expect.objectContaining({ stderrBytes: expect.any(Number) }),
    );
  });

  it('redacts provider-controlled parser failures from the logger sink', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const promptCanary = 'PROMPT_CANARY_parser_failure';
    const credentialCanary = 'sk-proj-CREDENTIAL_CANARY_parser_failure';
    const approvalCanary = 'RAW_APPROVAL_CANARY_parser_failure';
    const handle = runProviderSession(
      {
        providerId: 'claude',
        executableNames: [process.execPath],
        buildArgs: () => [
          '-e',
          `process.stdout.write('${JSON.stringify({ type: 'fixture' })}\\n')`,
        ],
        parseLine: () => {
          throw new Error(`${credentialCanary} ${approvalCanary}`);
        },
      },
      { sessionId: 'parser-canary-session', cwd, prompt: promptCanary },
      logger,
    );
    const events = await collectEvents(handle.events);
    const observable = JSON.stringify({
      logs: Object.values(logger).flatMap((method) => method.mock.calls),
      events,
    });

    expect(observable).not.toContain(promptCanary);
    expect(observable).not.toContain(credentialCanary);
    expect(observable).not.toContain(approvalCanary);
    expect(events.at(-1)).toMatchObject({
      type: 'session.failed',
      message: 'provider output could not be read',
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('normalizes codex fixture output through the same skeleton', async () => {
    const handle = runProviderSession(
      {
        providerId: 'codex',
        executableNames: [process.execPath],
        buildArgs: () => [join(fixturesDir, 'fake-codex-success.mjs')],
        parseLine: parseCodexLine,
      },
      { sessionId: 'test-session-3', cwd, prompt: 'hello' },
      noopLogger,
    );

    const events = await collectEvents(handle.events);
    expect(events).toContainEqual({
      type: 'tool.completed',
      toolName: 'shell',
      toolCallId: 'item_0',
      result: { command: 'echo hi', output: 'hi\n', exitCode: 0 },
      isError: false,
    });
    expect(events.at(-1)).toMatchObject({
      type: 'session.completed',
      providerSessionId: 'codex-fixture-thread-id',
    });
  });

  it('rejects a nonexistent working directory without spawning anything', async () => {
    const handle = runProviderSession(
      {
        providerId: 'claude',
        executableNames: [process.execPath],
        buildArgs: () => [join(fixturesDir, 'fake-claude-success.mjs')],
        parseLine: parseClaudeLine,
      },
      { sessionId: 'test-session-4', cwd: join(cwd, 'does-not-exist'), prompt: 'hello' },
      noopLogger,
    );

    const events = await collectEvents(handle.events);
    expect(events.some((e) => e.type === 'error' && e.code === 'INVALID_CWD')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'session.failed', message: 'invalid working directory' });
  });

  it('reports PROVIDER_NOT_INSTALLED when the executable cannot be found', async () => {
    const handle = runProviderSession(
      {
        providerId: 'claude',
        executableNames: ['definitely-not-a-real-cli-xyz-123'],
        buildArgs: () => [],
        parseLine: parseClaudeLine,
      },
      { sessionId: 'test-session-5', cwd, prompt: 'hello' },
      noopLogger,
    );

    const events = await collectEvents(handle.events);
    expect(events.some((e) => e.type === 'error' && e.code === 'PROVIDER_NOT_INSTALLED')).toBe(
      true,
    );
  });

  it('cancels a long-running session and terminates the child process', async () => {
    const handle = runProviderSession(
      {
        providerId: 'codex',
        executableNames: [process.execPath],
        buildArgs: () => [join(fixturesDir, 'fake-hang.mjs')],
        parseLine: parseCodexLine,
      },
      { sessionId: 'test-session-6', cwd, prompt: 'hello' },
      noopLogger,
    );

    const collected: AgentEvent[] = [];
    const iterator = handle.events;
    // Wait for the first event so we know the process has actually started.
    const first = await iterator.next();
    if (!first.done) collected.push(first.value);

    await handle.cancel();

    for await (const event of iterator) collected.push(event);

    expect(collected.at(-1)).toEqual({ type: 'session.cancelled' });
  }, 10_000);

  describe('prompt via stdin (AD-05)', () => {
    async function runStdinEcho(prompt: string) {
      const handle = runProviderSession(
        {
          providerId: 'claude',
          executableNames: [process.execPath],
          buildArgs: () => [join(fixturesDir, 'fake-stdin-echo.mjs')],
          parseLine: parseClaudeLine,
          promptViaStdin: true,
        },
        { sessionId: 'stdin-echo-session', cwd, prompt },
        noopLogger,
      );
      const events = await collectEvents(handle.events);
      const message = events.find((e) => e.type === 'assistant.message') as
        { text: string } | undefined;
      return { events, receivedText: message?.text };
    }

    it('delivers the prompt to the child over stdin, not argv, and it round-trips exactly', async () => {
      const { receivedText } = await runStdinEcho('a perfectly ordinary prompt');
      expect(receivedText).toBe('a perfectly ordinary prompt');
    });

    it('preserves spaces, quotes, and embedded newlines exactly', async () => {
      const prompt = 'line one\nline "two" with quotes\n  leading spaces and trailing   ';
      const { receivedText } = await runStdinEcho(prompt);
      expect(receivedText).toBe(prompt);
    });

    it('preserves multi-byte Unicode exactly', async () => {
      const prompt = 'emoji 🎉🚀, CJK 日本語テスト, accents café résumé';
      const { receivedText } = await runStdinEcho(prompt);
      expect(receivedText).toBe(prompt);
    });

    it('handles a prompt far larger than any argv limit (well past Windows argv ~32,767 chars)', async () => {
      const prompt = 'y'.repeat(200_000); // the shared schema's own max
      const { receivedText } = await runStdinEcho(prompt);
      expect(receivedText).toBe(prompt);
      expect(receivedText?.length).toBe(200_000);
    }, 10_000);

    it('still reaches session.completed normally with stdin transport', async () => {
      const { events } = await runStdinEcho('hi');
      expect(events.at(-1)).toMatchObject({ type: 'session.completed' });
    });

    it('cancellation still works when the prompt is delivered via stdin', async () => {
      const handle = runProviderSession(
        {
          providerId: 'claude',
          executableNames: [process.execPath],
          buildArgs: () => [join(fixturesDir, 'fake-hang.mjs')],
          parseLine: parseClaudeLine,
          promptViaStdin: true,
        },
        { sessionId: 'stdin-cancel-session', cwd, prompt: 'hi' },
        noopLogger,
      );
      const iterator = handle.events;
      const first = await iterator.next();
      const collected: AgentEvent[] = first.done ? [] : [first.value];

      await handle.cancel();
      for await (const event of iterator) collected.push(event);

      expect(collected.at(-1)).toEqual({ type: 'session.cancelled' });
    }, 10_000);
  });

  it('kills a grandchild process on cancellation, not just the direct child (no orphaned tool subprocess)', async () => {
    const markerPath = join(cwd, 'grandchild-marker.txt');

    const handle = runProviderSession(
      {
        providerId: 'codex',
        executableNames: [process.execPath],
        buildArgs: () => [join(fixturesDir, 'fake-spawns-grandchild.mjs'), markerPath],
        parseLine: parseCodexLine,
      },
      { sessionId: 'test-session-7', cwd, prompt: 'hello' },
      noopLogger,
    );

    const iterator = handle.events;

    // Wait until the grandchild has actually started writing its marker file (real spawn +
    // process startup latency, not just our own process.started event).
    const deadline = Date.now() + 5000;
    while (!existsSync(markerPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(existsSync(markerPath)).toBe(true);

    await handle.cancel();
    // Drain remaining events so the session fully reaches its terminal state.
    for await (const _event of iterator) {
      // no-op; just drain
    }

    // The grandchild writes a fresh timestamp to the marker file every 100ms. If cancellation
    // only killed the direct child (e.g. `child.kill()` without process-tree/group semantics),
    // the grandchild would keep running and keep updating this file indefinitely.
    const valueRightAfterCancel = readFileSync(markerPath, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const valueOneSecondLater = readFileSync(markerPath, 'utf8');

    expect(valueOneSecondLater).toBe(valueRightAfterCancel);
  }, 15_000);
});
