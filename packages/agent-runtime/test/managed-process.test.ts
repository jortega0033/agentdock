import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

const terminateProcessTree = vi.hoisted(() => vi.fn());

vi.mock('../src/process/spawn-process.js', async () => {
  const actual = await vi.importActual<typeof import('../src/process/spawn-process.js')>(
    '../src/process/spawn-process.js',
  );
  return { ...actual, terminateProcessTree };
});

import { ManagedAppServerProcess } from '../src/providers/codex/app-server/managed-process.js';
import {
  encodeWindowsJobHostArguments,
  resolveWindowsJobHostPath,
  WINDOWS_JOB_HOST_NAME,
} from '../src/process/windows-job-host.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

async function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs = 5_000,
): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child exit timed out')), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  await waitUntil(() => /^ADJH\/1 READY [1-9]\d*\r?$/mu.test(stderr));
}

describe('ManagedAppServerProcess lifecycle failures', () => {
  beforeAll(async () => {
    if (process.platform === 'win32') {
      try {
        await stat(JOB_HOST);
      } catch {
        await run(process.execPath, [JOB_HOST_BUILD]);
      }
    }
  });

  beforeEach(() => terminateProcessTree.mockReset());

  it('resolves the development helper relative to the daemon entry point, not the CWD', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agent dock helper resolution '));
    const sourceDirectory = join(temp, 'src');
    const distDirectory = join(temp, 'dist');
    const entrypoint = join(sourceDirectory, 'index.ts');
    const helper = join(distDirectory, WINDOWS_JOB_HOST_NAME);
    try {
      await Promise.all([
        mkdir(sourceDirectory, { recursive: true }),
        mkdir(distDirectory, { recursive: true }),
      ]);
      await Promise.all([writeFile(entrypoint, ''), writeFile(helper, '')]);

      expect(resolveWindowsJobHostPath(undefined, entrypoint)).toBe(await realpath(helper));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('never falls back to PATH or the CWD for a missing or relative entry point', async () => {
    const resolved = resolveWindowsJobHostPath(undefined, 'relative-entry.ts');
    expect(isAbsolute(resolved)).toBe(true);
    expect(basename(resolved)).toBe(WINDOWS_JOB_HOST_NAME);
    expect(resolved).not.toBe(resolve(WINDOWS_JOB_HOST_NAME));
    expect(() => resolveWindowsJobHostPath('relative-helper.exe')).toThrow(
      'override must be an absolute path',
    );
  });

  it('verifies the process tree after a graceful leader exit', async () => {
    terminateProcessTree.mockImplementationOnce(
      async (
        _child: ChildProcessByStdio<Writable, Readable, Readable>,
        exit: Promise<unknown>,
        isExited: () => boolean,
      ) => {
        await exit;
        expect(isExited()).toBe(true);
      },
    );
    let leaderExited!: () => void;
    const leaderExit = new Promise<void>((resolve) => {
      leaderExited = resolve;
    });
    const processHandle = new ManagedAppServerProcess({
      executable: process.execPath,
      executableArgs: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      platform: 'linux',
      onStdout: () => undefined,
      onStdoutEnd: () => undefined,
      onFailure: () => leaderExited(),
    });

    await leaderExit;
    await processHandle.close();

    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
    expect(processHandle.reaped).toBe(true);
  });

  it('shares one verified reap across concurrent graceful and forced close', async () => {
    let releaseReap!: () => void;
    const reapGate = new Promise<void>((resolve) => {
      releaseReap = resolve;
    });
    terminateProcessTree.mockImplementationOnce(
      async (child: ChildProcessByStdio<Writable, Readable, Readable>, exit: Promise<unknown>) => {
        child.kill('SIGKILL');
        await exit;
        await reapGate;
      },
    );
    const processHandle = new ManagedAppServerProcess({
      executable: process.execPath,
      executableArgs: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      platform: 'linux',
      onStdout: () => undefined,
      onStdoutEnd: () => undefined,
      onFailure: () => undefined,
    });

    const graceful = processHandle.close();
    const forced = processHandle.forceClose();
    releaseReap();
    await Promise.all([graceful, forced]);

    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
    expect(processHandle.reaped).toBe(true);
  });

  it('does not let a later close hide a failed force close', async () => {
    terminateProcessTree.mockImplementationOnce(
      async (child: ChildProcessByStdio<Writable, Readable, Readable>) => {
        child.kill('SIGKILL');
        throw new Error('tree could not be confirmed');
      },
    );
    const processHandle = new ManagedAppServerProcess({
      executable: process.execPath,
      executableArgs: [FIXTURE],
      cwd: process.cwd(),
      platform: 'linux',
      onStdout: () => undefined,
      onStdoutEnd: () => undefined,
      onFailure: () => undefined,
    });

    await expect(processHandle.forceClose()).rejects.toThrow('process tree could not be confirmed');
    await expect(processHandle.close()).rejects.toThrow('process tree could not be confirmed');
    expect(processHandle.reaped).toBe(false);
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform !== 'win32')(
    'fails before provider launch when its owner process is already gone',
    async () => {
      const temp = await mkdtemp(join(tmpdir(), 'agent dock dead owner '));
      const invocationMarker = join(temp, 'provider-started.txt');
      const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      if (!owner.pid) throw new Error('owner sentinel did not start');
      const ownerPid = owner.pid;
      owner.kill('SIGKILL');
      await waitForExit(owner);
      const jobHost = spawn(
        JOB_HOST,
        encodeWindowsJobHostArguments({
          ownerPid,
          executable: process.execPath,
          cwd: temp,
          args: [
            '-e',
            `require('fs').writeFileSync(${JSON.stringify(invocationMarker)}, 'started')`,
          ],
        }),
        { cwd: temp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );

      try {
        expect(await waitForExit(jobHost)).toBe(125);
        await expect(stat(invocationMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        if (jobHost.exitCode === null) jobHost.kill('SIGKILL');
        await waitForExit(jobHost).catch(() => undefined);
        await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'kills its owned provider when the daemon owner process dies',
    async () => {
      const temp = await mkdtemp(join(tmpdir(), 'agent dock job host owner '));
      const marker = join(temp, 'owner marker.txt');
      const pidFile = join(temp, 'owner provider pid.txt');
      const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      if (!owner.pid) throw new Error('owner sentinel did not start');
      const providerScript = `
        const fs = require('fs');
        fs.writeFileSync(process.argv[2], String(process.pid));
        setInterval(() => fs.writeFileSync(process.argv[1], String(Date.now())), 50);
      `;
      const jobHost = spawn(
        JOB_HOST,
        encodeWindowsJobHostArguments({
          ownerPid: owner.pid,
          executable: process.execPath,
          cwd: temp,
          args: ['-e', providerScript, marker, pidFile],
        }),
        { cwd: temp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );

      try {
        await waitForReady(jobHost);
        await waitUntil(async () => {
          try {
            await stat(marker);
            await stat(pidFile);
            return true;
          } catch {
            return false;
          }
        });
        const providerPid = Number(await readFile(pidFile, 'utf8'));
        expect(processAlive(providerPid)).toBe(true);

        owner.kill('SIGKILL');
        await waitForExit(owner);
        expect(await waitForExit(jobHost)).toBe(125);
        await waitUntil(() => !processAlive(providerPid));
        const markerAfterReap = await stat(marker);
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        expect((await stat(marker)).mtimeMs).toBe(markerAfterReap.mtimeMs);
      } finally {
        if (owner.exitCode === null) owner.kill('SIGKILL');
        if (jobHost.exitCode === null) jobHost.kill('SIGKILL');
        await Promise.allSettled([waitForExit(owner), waitForExit(jobHost)]);
        await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
    15_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'launches an npm-style codex.cmd from a path with spaces without a shell-built command',
    async () => {
      const temp = await mkdtemp(join(tmpdir(), 'agent dock codex cmd '));
      const shimDirectory = join(temp, 'npm bin with spaces');
      const shim = join(shimDirectory, 'codex.cmd');
      const invocationLog = join(temp, 'cmd invocation.txt');
      await mkdir(shimDirectory, { recursive: true });
      await writeFile(
        shim,
        '@echo off\r\n>>"%AGENT_DOCK_CMD_LOG%" echo %*\r\necho cmd-app-server-ready\r\nmore >nul\r\n',
      );
      let stdout = '';
      const processHandle = new ManagedAppServerProcess({
        executable: shim,
        windowsJobHostPath: JOB_HOST,
        cwd: temp,
        env: { ...process.env, AGENT_DOCK_CMD_LOG: invocationLog },
        onStdout: (chunk) => {
          stdout += chunk.toString('utf8');
        },
        onStdoutEnd: () => undefined,
        onFailure: () => undefined,
      });

      try {
        await processHandle.ready;
        await waitUntil(async () => {
          try {
            return (await readFile(invocationLog, 'utf8')).includes('app-server --stdio');
          } catch {
            return false;
          }
        });
        await waitUntil(() => stdout.includes('cmd-app-server-ready'));
        await processHandle.close();
        expect(processHandle.reaped).toBe(true);
      } finally {
        await processHandle.forceClose().catch(() => undefined);
        await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'preserves percent-bearing cmd arguments without environment expansion',
    async () => {
      const temp = await mkdtemp(join(tmpdir(), 'agent dock unsafe cmd '));
      const shimDirectory = join(temp, 'npm bin');
      const shim = join(shimDirectory, 'codex.cmd');
      await mkdir(shimDirectory, { recursive: true });
      await writeFile(shim, '@echo off\r\necho %1\r\nmore >nul\r\n');
      let stdout = '';
      const processHandle = new ManagedAppServerProcess({
        executable: shim,
        executableArgs: ['%PATH%'],
        windowsJobHostPath: JOB_HOST,
        cwd: temp,
        onStdout: (chunk) => {
          stdout += chunk.toString('utf8');
        },
        onStdoutEnd: () => undefined,
        onFailure: () => undefined,
      });

      try {
        await processHandle.ready;
        await waitUntil(() => stdout.includes('%PATH%'));
        expect(stdout).not.toContain(process.env.PATH ?? 'unmatchable-path-value');
        await processHandle.close();
        expect(processHandle.reaped).toBe(true);
      } finally {
        await processHandle.forceClose().catch(() => undefined);
        await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'rejects cmd command separators before the provider script starts',
    async () => {
      const temp = await mkdtemp(join(tmpdir(), 'agent dock cmd separator '));
      const shim = join(temp, 'codex.cmd');
      const invocationMarker = join(temp, 'cmd provider started.txt');
      await writeFile(shim, `@echo off\r\ntype nul > "${invocationMarker}"\r\n`);
      const processHandle = new ManagedAppServerProcess({
        executable: shim,
        executableArgs: ['first line\r\nsecond line'],
        windowsJobHostPath: JOB_HOST,
        cwd: temp,
        onStdout: () => undefined,
        onStdoutEnd: () => undefined,
        onFailure: () => undefined,
      });

      try {
        await expect(processHandle.ready).rejects.toThrow('invalid readiness handshake');
        await processHandle.forceClose();
        await expect(stat(invocationMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await processHandle.forceClose().catch(() => undefined);
        await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'reaps a grandchild after both leader and intermediate parent have exited',
    async () => {
      const temp = await mkdtemp(join(tmpdir(), 'agent dock job host orphan '));
      const marker = join(temp, 'marker with spaces.txt');
      const pidFile = join(temp, 'grandchild pid.txt');
      let failed!: (error: Error) => void;
      const providerFailed = new Promise<Error>((resolve) => {
        failed = resolve;
      });
      const processHandle = new ManagedAppServerProcess({
        executable: process.execPath,
        executableArgs: [ORPHAN_FIXTURE, marker, pidFile],
        windowsJobHostPath: JOB_HOST,
        cwd: temp,
        onStdout: () => undefined,
        onStdoutEnd: () => undefined,
        onFailure: failed,
      });

      try {
        await processHandle.ready;
        await waitUntil(async () => {
          try {
            await stat(marker);
            await stat(pidFile);
            return true;
          } catch {
            return false;
          }
        });
        const grandchildPid = Number(await readFile(pidFile, 'utf8'));
        expect(processAlive(grandchildPid)).toBe(true);
        await processHandle.write(Buffer.from('exit\n'));
        await providerFailed;
        await processHandle.close();
        expect(processHandle.reaped).toBe(true);
        await waitUntil(() => !processAlive(grandchildPid));
        const markerAfterReap = await stat(marker);
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        expect((await stat(marker)).mtimeMs).toBe(markerAfterReap.mtimeMs);
      } finally {
        await processHandle.forceClose().catch(() => undefined);
        await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
    15_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'force-closes a live provider Job Object and redacts provider stderr',
    async () => {
      const temp = await mkdtemp(join(tmpdir(), 'agent dock job host force '));
      const marker = join(temp, 'live marker.txt');
      const canary = 'prompt-canary credential-canary approval-canary';
      const markerWriter = `
        const fs = require('fs');
        const marker = process.argv[1];
        setInterval(() => fs.writeFileSync(marker, String(Date.now())), 50);
      `;
      const providerScript = `
        const { spawn } = require('child_process');
        process.stderr.write(${JSON.stringify(canary)});
        spawn(process.execPath, ['-e', ${JSON.stringify(markerWriter)}, process.argv[1]], { stdio: 'ignore' });
        setInterval(() => {}, 1000);
      `;
      const processHandle = new ManagedAppServerProcess({
        executable: process.execPath,
        executableArgs: ['-e', providerScript, marker],
        windowsJobHostPath: JOB_HOST,
        cwd: temp,
        onStdout: () => undefined,
        onStdoutEnd: () => undefined,
        onFailure: () => undefined,
      });

      try {
        await processHandle.ready;
        const stderr = await processHandle.stderr.next();
        expect(stderr.value).toMatch(/^Codex app-server stderr redacted \(\d+ bytes\)$/u);
        expect(String(stderr.value)).not.toContain(canary);
        await waitUntil(async () => {
          try {
            await stat(marker);
            return true;
          } catch {
            return false;
          }
        });
        await processHandle.forceClose();
        expect(processHandle.reaped).toBe(true);
        const markerAfterReap = await stat(marker);
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        expect((await stat(marker)).mtimeMs).toBe(markerAfterReap.mtimeMs);
      } finally {
        await processHandle.forceClose().catch(() => undefined);
        await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'fails before provider launch when the Job Object host is missing',
    async () => {
      const temp = await mkdtemp(join(tmpdir(), 'agent dock missing job host '));
      const invocationMarker = join(temp, 'provider-started.txt');
      const processHandle = new ManagedAppServerProcess({
        executable: process.execPath,
        executableArgs: [
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(invocationMarker)}, 'started')`,
        ],
        windowsJobHostPath: join(temp, 'missing-job-host.exe'),
        cwd: temp,
        onStdout: () => undefined,
        onStdoutEnd: () => undefined,
        onFailure: () => undefined,
      });

      try {
        await expect(processHandle.ready).rejects.toThrow('could not start');
        await processHandle.forceClose();
        expect(processHandle.reaped).toBe(true);
        await expect(stat(invocationMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await processHandle.forceClose().catch(() => undefined);
        await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'rejects a malformed Job Object host handshake before provider launch',
    async () => {
      const temp = await mkdtemp(join(tmpdir(), 'agent dock malformed job host '));
      const invocationMarker = join(temp, 'provider-started.txt');
      const processHandle = new ManagedAppServerProcess({
        executable: process.execPath,
        executableArgs: [
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(invocationMarker)}, 'started')`,
        ],
        // node.exe starts successfully but treats the encoded helper configuration as a script
        // path, producing non-protocol stderr instead of READY.
        windowsJobHostPath: process.execPath,
        cwd: temp,
        onStdout: () => undefined,
        onStdoutEnd: () => undefined,
        onFailure: () => undefined,
      });

      try {
        await expect(processHandle.ready).rejects.toThrow('invalid readiness handshake');
        await processHandle.forceClose();
        expect(processHandle.reaped).toBe(true);
        await expect(stat(invocationMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await processHandle.forceClose().catch(() => undefined);
        await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );
});

describe('ManagedAppServerProcess default environment (issue #53)', () => {
  beforeEach(() => terminateProcessTree.mockReset());

  it('never inherits the daemon\'s full process.env when options.env is omitted', async () => {
    process.env.AGENT_DOCK_ENV_ISOLATION_TEST_CANARY = 'CANARY-do-not-leak';
    let stdout = '';
    // platform: 'linux' takes the plain-spawn path (no Windows Job Host wrapping), matching the
    // simpler pattern the file's other constructor-level tests already use; the sanitized-env
    // fallback itself lives in the one spawn() call shared by both paths (managed-process.ts).
    const processHandle = new ManagedAppServerProcess({
      executable: process.execPath,
      executableArgs: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      cwd: process.cwd(),
      platform: 'linux',
      onStdout: (chunk) => {
        stdout += chunk.toString('utf8');
      },
      onStdoutEnd: () => undefined,
      onFailure: () => undefined,
    });

    try {
      await waitUntil(() => stdout.length > 0);
      const childEnv = JSON.parse(stdout) as Record<string, string>;
      expect(childEnv).not.toHaveProperty('AGENT_DOCK_ENV_ISOLATION_TEST_CANARY');
      expect(childEnv.PATH ?? childEnv.Path).toBeDefined();
    } finally {
      delete process.env.AGENT_DOCK_ENV_ISOLATION_TEST_CANARY;
      await processHandle.forceClose().catch(() => undefined);
    }
  });
});
