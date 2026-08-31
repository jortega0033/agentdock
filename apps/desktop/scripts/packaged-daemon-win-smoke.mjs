import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const PACKAGED_APP = join(ROOT, 'dist-packages', 'win-unpacked', 'AgentDock.exe');
const PACKAGED_DAEMON = join(
  ROOT,
  'dist-packages',
  'win-unpacked',
  'resources',
  'daemon',
  'index.js',
);
const PACKAGED_JOB_HOST = join(
  ROOT,
  'dist-packages',
  'win-unpacked',
  'resources',
  'daemon',
  'agent-dock-job-host.exe',
);
const BUILDER_CONFIG = join(ROOT, 'apps', 'desktop', 'electron-builder.yml');
const TIMEOUT_MS = 15_000;

if (process.platform !== 'win32') {
  console.log('Skipping packaged daemon Windows smoke test (requires win32).');
  process.exit(0);
}

const tempRoot = await mkdtemp(join(tmpdir(), 'agent-dock-packaged-daemon-smoke-'));
const appId = `packaged-daemon-smoke-${randomUUID().replaceAll('-', '')}`;
const resourcesDaemonDir = dirname(PACKAGED_DAEMON);
const bundledDaemonPath = PACKAGED_DAEMON;
const shimDir = join(tempRoot, 'npm codex bin with spaces');
const shimPath = join(shimDir, 'codex.cmd');
const shimExecutablePath = join(shimDir, 'codex-shim.exe');
const shimSourcePath = join(shimDir, 'codex-shim.cs');
const invocationLog = join(tempRoot, 'codex-invocations.txt');
const stateDir = join(tempRoot, 'state');
const discoveryPath = join(tmpdir(), 'agent-dock', `${appId}.json`);

let child;
let daemonOutput = '';
try {
  const builderConfig = await readFile(BUILDER_CONFIG, 'utf8');
  assert(
    /extraResources:[\s\S]*?- from: \.\.\/daemon\/dist\s+to: daemon/.test(builderConfig),
    'electron-builder must package apps/daemon/dist as resources/daemon',
  );
  await realpath(PACKAGED_APP);
  await realpath(PACKAGED_DAEMON);
  await realpath(PACKAGED_JOB_HOST);
  await mkdir(shimDir, { recursive: true });
  await writeFile(shimSourcePath, codexShimSource());
  await compileCodexShim(shimSourcePath, shimExecutablePath);
  await writeFile(shimPath, '@echo off\r\n"%~dp0codex-shim.exe" %*\r\n');

  const daemonEnv = withWindowsPath(process.env, shimDir);
  child = spawn(process.execPath, [bundledDaemonPath], {
    cwd: resourcesDaemonDir,
    env: {
      ...daemonEnv,
      AGENT_DOCK_APP_ID: appId,
      AGENT_DOCK_STATE_DIR: stateDir,
      AGENT_DOCK_SMOKE_CODEX_LOG: invocationLog,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const discovery = await waitForDiscovery(discoveryPath, child);
  const response = await fetch(`http://127.0.0.1:${discovery.port}/providers/codex`, {
    headers: { authorization: `Bearer ${discovery.token}` },
  });
  const codex = await response.json();
  if (!response.ok) {
    throw new Error(
      `Codex detection endpoint returned ${response.status}: ${JSON.stringify(codex)}\n${daemonOutput}`,
    );
  }

  assert(codex.installed === true, 'bundled daemon did not report Codex as installed');
  assert(codex.version === '0.147.0', `unexpected Codex version: ${String(codex.version)}`);
  assert(
    (await realpath(codex.executablePath)).toLowerCase() ===
      (await realpath(shimPath)).toLowerCase(),
    `daemon did not execute the PATH-selected Codex shim: ${String(codex.executablePath)}`,
  );
  assert(codex.authenticated === 'authenticated', 'shim login-status handshake was not accepted');
  assert(codex.authSource === 'chatgpt', 'shim auth source was not preserved');

  await verifyPackagedDaemonJobHost(discovery, tempRoot, invocationLog);
  await verifyPackagedJobHost(PACKAGED_JOB_HOST, shimPath, tempRoot, invocationLog);

  const invocations = await readFile(invocationLog, 'utf8');
  assert(invocations.includes('--version'), 'Codex version handshake did not reach the shim');
  assert(
    invocations.includes('login status'),
    'Codex login-status handshake did not reach the shim',
  );
  assert(
    invocations.includes('app-server --stdio'),
    'packaged Job Object host did not launch the Codex app-server shim',
  );
  console.log(
    `Packaged daemon smoke passed from ${bundledDaemonPath} with PATH-selected ${basename(shimPath)}.`,
  );
} finally {
  if (child && child.exitCode === null && !child.killed) {
    child.kill('SIGTERM');
    try {
      await waitForExit(child, 5_000);
    } catch {
      child.kill('SIGKILL');
      await waitForExit(child, 5_000);
    }
  }
  await rm(discoveryPath, { force: true });
  await rm(tempRoot, { recursive: true, force: true });
}

async function waitForDiscovery(path, daemon) {
  const deadline = Date.now() + TIMEOUT_MS;
  let stdout = '';
  let stderr = '';
  daemon.stdout?.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
    daemonOutput += chunk.toString('utf8');
  });
  daemon.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    daemonOutput += chunk.toString('utf8');
  });

  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      throw new Error(`bundled daemon exited (${daemon.exitCode}): ${stderr || stdout}`);
    }
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for bundled daemon discovery file: ${stderr || stdout}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon shutdown timed out')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function withWindowsPath(source, firstDirectory) {
  const env = { ...source };
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const pathExt = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1] ?? '';
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH' || key.toUpperCase() === 'PATHEXT') delete env[key];
  }
  return {
    ...env,
    PATH: `${firstDirectory};${path}`,
    PATHEXT: `.CMD;.EXE;.BAT;${pathExt}`,
  };
}

async function compileCodexShim(sourcePath, outputPath) {
  const literal = (path) => `'${path.replaceAll("'", "''")}'`;
  const command = [
    '$ErrorActionPreference = "Stop"',
    `Add-Type -LiteralPath ${literal(sourcePath)} -OutputAssembly ${literal(outputPath)} -OutputType ConsoleApplication`,
  ].join('; ');
  const result = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ]);
  if (result.code !== 0) {
    throw new Error(
      `failed to compile deterministic codex.exe shim: ${result.stderr || result.stdout}`,
    );
  }
}

async function verifyPackagedDaemonJobHost(discovery, cwd, invocationLogPath) {
  const baseUrl = `http://127.0.0.1:${discovery.port}`;
  const headers = {
    authorization: `Bearer ${discovery.token}`,
    'content-type': 'application/json',
  };
  const inspectResponse = await fetch(`${baseUrl}/v2/workspaces/inspect`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ cwd }),
  });
  const workspace = await inspectResponse.json();
  assert(
    inspectResponse.ok,
    `packaged daemon workspace inspection failed (${inspectResponse.status}): ${JSON.stringify(workspace)}`,
  );
  const trustResponse = await fetch(`${baseUrl}/v2/workspaces/${workspace.workspaceId}/trust`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      cwd,
      incarnation: workspace.incarnation,
      state: 'trusted',
    }),
  });
  const trust = await trustResponse.json();
  assert(
    trustResponse.ok && trust.state === 'trusted',
    `packaged daemon workspace trust failed (${trustResponse.status}): ${JSON.stringify(trust)}`,
  );

  const priorCount = countInvocation(
    await readFile(invocationLogPath, 'utf8'),
    'app-server --stdio',
  );
  const controller = new AbortController();
  const sessionRequest = fetch(`${baseUrl}/v2/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      provider: 'codex',
      cwd,
      prompt: 'packaged Job Object host smoke',
      capabilities: {
        required: [{ id: 'session.cancel' }],
        optional: [],
        allowExperimental: false,
      },
    }),
    signal: controller.signal,
  }).catch((error) => {
    if (controller.signal.aborted) return undefined;
    throw error;
  });
  try {
    await waitForInvocation(invocationLogPath, 'app-server --stdio', priorCount + 1);
  } finally {
    controller.abort();
    await sessionRequest;
  }
}

async function waitForInvocation(path, invocation, minimumCount) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if (countInvocation(await readFile(path, 'utf8'), invocation) >= minimumCount) return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`timed out waiting for packaged daemon invocation: ${invocation}`);
}

function countInvocation(log, invocation) {
  return log.split(/\r?\n/u).filter((line) => line === invocation).length;
}

async function verifyPackagedJobHost(jobHostPath, executablePath, cwd, invocationLogPath) {
  const args = [String(process.pid), executablePath, cwd, 'app-server', '--stdio'].map((value) =>
    Buffer.from(value, 'utf8').toString('base64'),
  );
  const child = spawn(jobHostPath, args, {
    cwd,
    env: { ...process.env, AGENT_DOCK_SMOKE_CODEX_LOG: invocationLogPath },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  child.stdin.end();
  const code = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('packaged Job Object host shutdown timed out'));
    }, TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolvePromise(exitCode);
    });
  });
  assert(code === 0, `packaged Job Object host failed (${String(code)}): ${stderr}`);
  assert(
    /^ADJH\/1 READY [1-9]\d*\r?$/mu.test(stderr),
    'packaged Job Object host did not prove readiness',
  );
  assert(stdout.includes('packaged-app-server-ready'), 'Codex shim stdout was not preserved');
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const process = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    process.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    process.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    process.once('error', reject);
    process.once('exit', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function codexShimSource() {
  return `
using System;
using System.IO;

public static class Program
{
    public static int Main(string[] args)
    {
        var logPath = Environment.GetEnvironmentVariable("AGENT_DOCK_SMOKE_CODEX_LOG");
        if (!String.IsNullOrEmpty(logPath))
            File.AppendAllText(logPath, String.Join(" ", args) + Environment.NewLine);

        if (args.Length == 1 && args[0] == "--version")
        {
            Console.WriteLine("codex-cli 0.147.0");
            return 0;
        }
        if (args.Length == 2 && args[0] == "login" && args[1] == "status")
        {
            Console.WriteLine("Logged in using ChatGPT");
            return 0;
        }
        if (args.Length == 2 && args[0] == "app-server" && args[1] == "--stdio")
        {
            Console.WriteLine("packaged-app-server-ready");
            Console.In.ReadToEnd();
            return 0;
        }

        Console.Error.WriteLine("unexpected Codex invocation: " + String.Join(" ", args));
        return 42;
    }
}
`;
}
