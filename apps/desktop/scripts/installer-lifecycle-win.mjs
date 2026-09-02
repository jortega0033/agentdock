import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const DIST_PACKAGES = join(ROOT, 'dist-packages');
const INSTALL_TIMEOUT_MS = 120_000;

/**
 * Silently installs and uninstalls the real NSIS installer into a runner-local, isolated
 * directory -- issue #66's "Silent installer install/uninstall in an isolated runner". Never
 * touches the real per-user install location a developer's own machine would use: `/D=` pins the
 * install directory to a fresh temp path for this run only.
 */

if (process.platform !== 'win32') {
  console.log('Skipping installer lifecycle test (requires win32).');
  process.exit(0);
}

const installer = await findInstaller();
const installDir = await mkdtemp(join(tmpdir(), 'agent-dock-install-lifecycle-'));
// electron-builder's NSIS build always deletes an empty target directory before installing, so
// mkdtemp's own (empty) directory is removed here to hand NSIS an isolated path with nothing in
// it yet, without racing another process for a brand-new temp name.
await rm(installDir, { recursive: true, force: true });

try {
  // NSIS silent install: /S must be the first flag; /D= (no quotes, no trailing slash, must be
  // the last argument) sets the install directory and requires an absolute path.
  await execFileAsync(installer, ['/S', `/D=${installDir}`], { timeout: INSTALL_TIMEOUT_MS });

  const installedExe = join(installDir, 'AgentDock.exe');
  await assertExists(installedExe, 'silent install did not produce AgentDock.exe');

  const uninstaller = await findUninstaller(installDir);
  await assertExists(uninstaller, 'silent install did not produce an uninstaller');

  console.log(`Installer lifecycle: silent install to ${installDir} produced a real, runnable AgentDock.exe.`);

  // electron-builder's generated NSIS uninstaller also accepts /S for a silent run, and (for a
  // non-perMachine install, this project's default) needs no elevation. NSIS's own uninstaller
  // copies itself to a temp location and re-execs there so it can delete the original uninstaller
  // file out from under the still-running original process; that means this `execFileAsync` call
  // can resolve slightly before that background copy has finished removing every last file (and,
  // sometimes, the now-empty install directory itself) -- waitForRemoval below polls rather than
  // trusting the process exit alone.
  await execFileAsync(uninstaller, ['/S'], { timeout: INSTALL_TIMEOUT_MS });
  await waitForRemoval(installedExe, INSTALL_TIMEOUT_MS);

  console.log('Installer lifecycle: silent uninstall removed the installed executable.');
} finally {
  // Same self-delete race as above can still leave an empty installDir behind for a moment even
  // after the exe itself is gone -- retry instead of a single best-effort attempt, so this script
  // doesn't litter the runner's temp directory across repeated runs.
  await removeWithRetry(installDir, INSTALL_TIMEOUT_MS);
}

async function findInstaller() {
  const entries = await readdir(DIST_PACKAGES).catch(() => []);
  const match = entries.find((name) => /^AgentDock-Setup-.*\.exe$/.test(name));
  if (!match) {
    throw new Error(`no NSIS installer found under ${DIST_PACKAGES} matching AgentDock-Setup-*.exe`);
  }
  return join(DIST_PACKAGES, match);
}

async function findUninstaller(installDir) {
  const entries = await readdir(installDir).catch(() => []);
  const match = entries.find((name) => /^Uninstall.*\.exe$/i.test(name));
  return match ? join(installDir, match) : undefined;
}

async function assertExists(path, message) {
  try {
    await access(path);
  } catch {
    throw new Error(message);
  }
}

async function waitForRemoval(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
    } catch {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`${path} still exists after silent uninstall`);
}

/**
 * `rm(recursive:true, force:true)` normally fails silently (via `.catch`) on a genuine race
 * against another process still writing into the directory; a fixed, short retry window absorbs
 * NSIS's background self-delete without masking a real, persistent leftover (still logged if it
 * never clears, rather than swallowed the way a bare best-effort attempt would).
 */
async function removeWithRetry(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  console.warn(`installer-lifecycle: could not fully remove ${path}: ${String(lastError)}`);
}
