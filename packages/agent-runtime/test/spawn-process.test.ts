import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  spawnProcess,
  filterWindowsJobHostStderr,
  terminateProcessTree,
  type ProcessExitResult,
  type SpawnedProcess,
} from '../src/process/spawn-process.js';

const ORPHAN_FIXTURE = fileURLToPath(
  new URL('./fixtures/fake-orphaning-leader.mjs', import.meta.url),
);
const JOB_HOST_BUILD = fileURLToPath(
  new URL('../../../apps/daemon/scripts/build-windows-job-host.mjs', import.meta.url),
);
const JOB_HOST = fileURLToPath(
  new URL('../../../apps/daemon/dist/agent-dock-job-host.exe', import.meta.url),
);

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`job-host build failed (${code ?? 'unknown'}): ${stderr}`));
    });
  });
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let output = '';
  stream.on('data', (chunk: Buffer | string) => {
    output += chunk.toString();
  });
  await new Promise<void>((resolve) => stream.once('end', resolve));
  return output;
}

describe('spawnProcess process-tree lifecycle', () => {
  beforeAll(async () => {
    if (process.platform === 'win32') {
      try {
        await stat(JOB_HOST);
      } catch {
        await run(process.execPath, [JOB_HOST_BUILD]);
      }
    }
  });

  it.skipIf(process.platform === 'win32')(
    'kills descendants after the leader has already exited',
    async () => {
      const childScript = 'setInterval(() => {}, 1000);';
      const leaderScript = [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        'process.stdout.write(String(child.pid));',
        'setImmediate(() => process.exit(0));',
      ].join('');
      const processTree = spawnProcess(process.execPath, ['-e', leaderScript], {
        cwd: process.cwd(),
      });
      let descendantPid: number | undefined;
      processTree.child.stdout.on('data', (chunk) => {
        descendantPid = Number(String(chunk));
      });

      try {
        await waitUntil(() => descendantPid !== undefined);
        await processTree.exit;
        expect(descendantPid).toBeDefined();
        expect(alive(descendantPid!)).toBe(true);

        await processTree.kill();
        await waitUntil(() => !alive(descendantPid!));
      } finally {
        if (descendantPid !== undefined && alive(descendantPid)) {
          process.kill(descendantPid, 'SIGKILL');
        }
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'owns and reaps a leader-to-intermediate-to-grandchild Windows orphan',
    async () => {
      const temp = await mkdtemp(join(tmpdir(), 'agent dock generic job orphan '));
      const marker = join(temp, 'marker.txt');
      const pidFile = join(temp, 'grandchild.pid');
      const processTree = spawnProcess(process.execPath, [ORPHAN_FIXTURE, marker, pidFile], {
        cwd: temp,
        windowsJobHostPath: JOB_HOST,
      });

      try {
        await waitUntil(async () => {
          try {
            await stat(marker);
            await stat(pidFile);
            return true;
          } catch {
            return false;
          }
        });
        const descendantPid = Number(await readFile(pidFile, 'utf8'));
        expect(alive(descendantPid)).toBe(true);

        processTree.child.stdin.write('exit\n');
        const result = await processTree.exit;
        expect(result.code).toBe(0);
        await waitUntil(() => !alive(descendantPid));
        const markerAfterReap = await stat(marker);
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        expect((await stat(marker)).mtimeMs).toBe(markerAfterReap.mtimeMs);
      } finally {
        await processTree.kill().catch(() => undefined);
        await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
    15_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'strips the Job Host control line while preserving provider stdout and stderr',
    async () => {
      const canary = 'provider-stderr-canary';
      const processTree = spawnProcess(
        process.execPath,
        ['-e', `process.stdout.write('provider-stdout'); process.stderr.write('${canary}')`],
        { cwd: process.cwd(), windowsJobHostPath: JOB_HOST },
      );
      const stdout = collect(processTree.child.stdout);
      const stderr = collect(processTree.child.stderr);
      processTree.child.stdin.end();

      expect((await processTree.exit).code).toBe(0);
      expect(await stdout).toBe('provider-stdout');
      expect(await stderr).toBe(canary);
      expect(await stderr).not.toContain('ADJH/1');
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'launches a cmd shim through the Job Host without exposing its handshake',
    async () => {
      const temp = await mkdtemp(join(tmpdir(), 'agent dock generic cmd '));
      const shimDirectory = join(temp, 'npm bin with spaces');
      const shim = join(shimDirectory, 'codex.cmd');
      const injectionMarker = join(temp, 'shell injection marker.txt');
      const literalArgument = `literal&echo injected>${injectionMarker}`;
      await mkdir(shimDirectory, { recursive: true });
      await writeFile(shim, '@echo off\r\necho %*\r\n');
      const processTree = spawnProcess(shim, [literalArgument], {
        cwd: temp,
        windowsJobHostPath: JOB_HOST,
      });
      const stdout = collect(processTree.child.stdout);
      const stderr = collect(processTree.child.stderr);
      processTree.child.stdin.end();

      try {
        expect((await processTree.exit).code).toBe(0);
        expect(await stdout).toContain(literalArgument);
        expect(await stderr).toBe('');
        await expect(stat(injectionMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await processTree.kill().catch(() => undefined);
        await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );

  it('reaps a Windows Job Host directly instead of relying on lineage snapshots', async () => {
    let exited = false;
    let resolveExit!: (result: ProcessExitResult) => void;
    const exit = new Promise<ProcessExitResult>((resolve) => {
      resolveExit = resolve;
    });
    const kill = vi.fn(() => {
      exited = true;
      resolveExit({ code: null, signal: 'SIGKILL' });
      return true;
    });
    const child = { pid: 12345, kill } as unknown as SpawnedProcess;

    await terminateProcessTree(child, exit, () => exited, {
      platform: 'win32',
      timeoutMs: 100,
    });

    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('suppresses a malformed Job Host handshake and every later stderr byte', async () => {
    const source = new PassThrough();
    const invalid = vi.fn();
    const output = collect(filterWindowsJobHostStderr(source, invalid));

    source.write('ADJH/1 BROKEN\ncredential-canary');
    source.write('approval-canary');
    source.end();

    expect(await output).toBe('');
    expect(invalid).toHaveBeenCalledOnce();
  });

  it('suppresses an oversized Job Host handshake and every later stderr byte', async () => {
    const source = new PassThrough();
    const invalid = vi.fn();
    const output = collect(filterWindowsJobHostStderr(source, invalid));

    source.write(Buffer.alloc(513, 0x78));
    source.write('credential-canary\n');
    source.end();

    expect(await output).toBe('');
    expect(invalid).toHaveBeenCalledOnce();
  });

  it('accepts a bounded READY line coalesced with a large provider stderr chunk', async () => {
    const source = new PassThrough();
    const invalid = vi.fn();
    const output = collect(filterWindowsJobHostStderr(source, invalid));
    const providerStderr = 'provider-canary'.repeat(100);

    source.end(`ADJH/1 READY 123\n${providerStderr}`);

    expect(await output).toBe(providerStderr);
    expect(invalid).not.toHaveBeenCalled();
  });

  it('bounds a stalled Windows Job Host reap with one absolute deadline', async () => {
    const child = {
      pid: 12345,
      kill: vi.fn(() => true),
    } as unknown as SpawnedProcess;
    const startedAt = Date.now();

    await expect(
      terminateProcessTree(child, new Promise<ProcessExitResult>(() => undefined), () => false, {
        platform: 'win32',
        timeoutMs: 25,
      }),
    ).rejects.toThrow('Job Host could not be confirmed reaped');

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
