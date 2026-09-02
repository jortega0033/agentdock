import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const PACKAGED_APP = join(ROOT, 'dist-packages', 'win-unpacked', 'AgentDock.exe');
const DISCOVERY_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;

/**
 * Proves what issue #66 asks for: "Packaged-app launch proves the real executable starts its
 * bundled daemon" -- launches the actual `AgentDock.exe` electron-builder produced (not the
 * daemon bundle directly, unlike `packaged-daemon-win-smoke.mjs`), waits for it to write a real
 * daemon discovery file and answer a real health check, then closes it the way a user closing the
 * window would (a non-forceful `taskkill`, which delivers WM_CLOSE to the app's real top-level
 * window rather than hard-terminating it), and confirms both the Electron process and the daemon
 * process it owns exit within a bounded time -- no orphaned daemon left running.
 *
 * This deliberately does NOT assert the discovery file gets removed: `electron/main.ts`'s
 * `killDaemon()` calls `daemonChild?.kill()`, which its own comment documents as mapping to a
 * hard `TerminateProcess` on Windows -- the daemon's own SIGTERM-triggered
 * `removeDiscoveryFile()` (apps/daemon/src/index.ts) never runs on Windows shutdown by design.
 * Real graceful behavior on this platform is HTTP-level session cancellation *before* that kill
 * (see `killDaemon()`'s own comment), not discovery-file cleanup; asserting file removal here
 * would test something this codebase never claims to do. This script still removes the discovery
 * file itself afterward so it never leaks into a later run.
 */

if (process.platform !== 'win32') {
  console.log('Skipping packaged app Windows smoke test (requires win32).');
  process.exit(0);
}

const tempRoot = await mkdtemp(join(tmpdir(), 'agent-dock-packaged-app-smoke-'));
const appId = `packaged-app-smoke-${randomUUID().replaceAll('-', '')}`;
const discoveryPath = join(tmpdir(), 'agent-dock', `${appId}.json`);
const stateDir = join(tempRoot, 'state');

let child;
try {
  await realpath(PACKAGED_APP);

  child = spawn(PACKAGED_APP, [], {
    env: {
      ...process.env,
      AGENT_DOCK_APP_ID: appId,
      AGENT_DOCK_STATE_DIR: stateDir,
    },
    stdio: 'ignore',
    windowsHide: false, // a real packaged app launch should actually create a window, not hide it
    detached: false,
  });
  const spawnError = await new Promise((resolvePromise) => {
    child.once('error', resolvePromise);
    child.once('spawn', () => resolvePromise(undefined));
  });
  if (spawnError) throw spawnError;

  const discovery = await waitForDiscovery(discoveryPath, child);
  const health = await fetch(`http://127.0.0.1:${discovery.port}/health`, {
    headers: { authorization: `Bearer ${discovery.token}` },
  });
  const healthBody = await health.json();
  assert(health.ok, `packaged app's bundled daemon health check failed: ${JSON.stringify(healthBody)}`);
  assert(healthBody.status === 'ok', `unexpected health status: ${JSON.stringify(healthBody)}`);

  const daemonPid = await findChildDaemonPid(child.pid);
  assert(daemonPid !== undefined, 'could not find the bundled daemon process spawned by the packaged app');

  // A non-forceful taskkill delivers WM_CLOSE / a normal close request rather than hard-killing
  // the process tree, exercising the app's own shutdown handling (electron/main.ts's before-quit
  // path, which is responsible for stopping the daemon it owns) instead of bypassing it.
  await execFileAsync('taskkill', ['/PID', String(child.pid)]);
  await waitForProcessExit(child.pid, SHUTDOWN_TIMEOUT_MS);
  await waitForProcessExit(daemonPid, SHUTDOWN_TIMEOUT_MS);

  console.log(`Packaged app smoke passed: ${PACKAGED_APP} started its bundled daemon and shut down cleanly.`);
} finally {
  if (child && child.exitCode === null && !child.killed) {
    try {
      await execFileAsync('taskkill', ['/F', '/T', '/PID', String(child.pid)]);
    } catch {
      // Best-effort: the process may have already exited on its own by the time cleanup runs.
    }
  }
  await rm(discoveryPath, { force: true });
  await rm(tempRoot, { recursive: true, force: true });
}

async function waitForDiscovery(path, app) {
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) {
      throw new Error(`packaged app exited (${app.exitCode}) before writing a discovery file`);
    }
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('timed out waiting for the packaged app to write its daemon discovery file');
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isProcessAlive(pid))) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`process ${pid} did not exit within ${timeoutMs}ms of a graceful close request`);
}

async function isProcessAlive(pid) {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    return stdout.includes(String(pid));
  } catch {
    return false;
  }
}

async function findChildDaemonPid(parentPid) {
  // `wmic` is deprecated/absent on newer Windows images; Get-CimInstance is the supported
  // replacement and is present on every current windows-latest GitHub-hosted runner image. The
  // "does this child look like the daemon" check happens in Node, not inside the PowerShell
  // command string, to avoid the notoriously fragile interaction between Node's Windows argv
  // quoting and PowerShell's own -Command re-parsing when a filter string itself contains quotes.
  const command = `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ]).catch(() => ({ stdout: '' }));
    const parsed = parseChildProcessList(stdout);
    const daemonProcess = parsed.find((process) => process.CommandLine?.includes('daemon'));
    if (daemonProcess) return daemonProcess.ProcessId;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  return undefined;
}

function parseChildProcessList(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
