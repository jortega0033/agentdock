import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface DaemonDiscoveryInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

/** Used when no app id is supplied; the reference desktop app never needs to override this. */
export const DEFAULT_APP_ID = 'agent-dock';

const APP_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * Validates an application id before it's used to build a filesystem path (AD-02's per-app
 * namespacing needs a value that's safe to use as a filename). Deliberately strict: alphanumeric
 * plus `-`/`_`, must start with a letter or digit, capped length, rather than merely escaping,
 * because this value becomes a filename directly: anything permissive here (`.`, `/`, `\`, a
 * leading `-` that a shell could mistake for a flag) is a path-traversal or injection surface.
 * Throws rather than silently coercing, so a bad app id fails the daemon at startup instead of
 * silently writing (or reading) the wrong file.
 */
export function sanitizeAppId(appId: string): string {
  if (!APP_ID_PATTERN.test(appId)) {
    throw new Error(
      `invalid app id "${appId}": must be 1-64 characters, starting with a letter or digit, ` +
        'containing only letters, digits, "-", and "_"',
    );
  }
  return appId;
}

/**
 * The one directory every AgentDock-based app's discovery file lives under, regardless of app id;
 * namespacing happens at the filename level (see `discoveryFilePath`), so only one directory
 * needs its permissions hardened (see `ensureSecureRuntimeDir`).
 */
function runtimeBaseDir(): string {
  return join(tmpdir(), 'agent-dock');
}

/**
 * Creates the discovery directory with restrictive permissions, or verifies an existing one is
 * still appropriate rather than assuming it (AD-19). `os.tmpdir()` is a shared, often
 * world-writable root on Linux (unlike Windows/macOS, which both return a per-user directory).
 * Without this check, a different local user could pre-stage the directory before the daemon
 * ever runs and intercept or corrupt the token handoff. This is a POSIX-only check: Windows has
 * no equivalent of a POSIX file mode, and NTFS ACLs are inherited from the parent by default,
 * which for a per-user temp root is already restrictive; pretending a `chmod`-style check means
 * something there would be dishonest, not extra-safe, so we skip it and say so.
 */
function ensureSecureRuntimeDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return;
  }
  if (process.platform === 'win32') return;

  const stats = statSync(dir);
  const ownedByUs = typeof process.getuid === 'function' ? stats.uid === process.getuid() : true;
  const mode = stats.mode & 0o777;
  if (!ownedByUs || mode !== 0o700) {
    throw new Error(
      `refusing to use ${dir}: expected it to be owned by the current user with mode 0700, but ` +
        `found owner uid ${stats.uid} mode ${mode.toString(8)}. Remove the directory and let the ` +
        'daemon recreate it. A directory another local user can access or has pre-staged is not ' +
        'a safe place for the daemon to hand off its auth token.',
    );
  }
}

/**
 * Where the daemon publishes its port + token for local clients to pick up, for the given
 * application id (default `agent-dock`). This is a filesystem handoff, not a network one: the
 * desktop app reads this file directly (it runs as the same OS user) instead of the daemon ever
 * broadcasting the token over the network. Namespaced per app id (AD-02) so two different
 * products built on this boilerplate (each launched with a different `AGENT_DOCK_APP_ID`) can
 * run their own daemon at the same time without colliding on one machine-global path; two
 * instances sharing the *same* app id still collide by design, which is exactly the single-
 * instance guarantee `assertNoLiveDaemon` provides.
 */
export function discoveryFilePath(appId: string = DEFAULT_APP_ID): string {
  return join(runtimeBaseDir(), `${sanitizeAppId(appId)}.json`);
}

export function writeDiscoveryFile(info: DaemonDiscoveryInfo, appId: string = DEFAULT_APP_ID): string {
  const dir = runtimeBaseDir();
  ensureSecureRuntimeDir(dir);
  const filePath = join(dir, `${sanitizeAppId(appId)}.json`);
  writeFileSync(filePath, JSON.stringify(info, null, 2), { mode: 0o600 });
  return filePath;
}

export function removeDiscoveryFile(appId: string = DEFAULT_APP_ID): void {
  try {
    unlinkSync(discoveryFilePath(appId));
  } catch {
    // already gone; nothing to clean up
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing; it only tests whether the process exists and is signalable.
    // Works cross-platform, including Windows (Node maps it to a process-existence check there).
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every client discovers a given app id's daemon through one fixed, namespaced path (see
 * `discoveryFilePath`), so two daemons *sharing the same app id* running at once would silently
 * race to own it: whichever started last "wins" the file, and the other becomes unreachable
 * through discovery even though it's still alive and still holding sessions. Rather than accept
 * that ambiguity, the MVP policy is one daemon per app id at a time: refuse to start if the
 * existing file's pid is still alive. A stale file left behind by a daemon that didn't get to
 * clean up after itself (crash, force-kill) is fine to overwrite; nothing is listening at that
 * pid anymore. A different app id's discovery file is an entirely separate path and never
 * consulted here.
 */
export function assertNoLiveDaemon(appId: string = DEFAULT_APP_ID): void {
  const filePath = discoveryFilePath(appId);
  if (!existsSync(filePath)) return;

  let existing: DaemonDiscoveryInfo;
  try {
    existing = JSON.parse(readFileSync(filePath, 'utf8')) as DaemonDiscoveryInfo;
  } catch {
    return; // corrupt/partial file from an interrupted write; safe to overwrite
  }

  if (typeof existing.pid === 'number' && isProcessAlive(existing.pid)) {
    throw new Error(
      `another agent-dock daemon (app id "${appId}") is already running (pid ${existing.pid}, ` +
        `discovery file ${filePath}). Only one daemon per app id is supported at a time. Stop it first.`,
    );
  }
}
