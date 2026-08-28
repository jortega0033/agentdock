import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface DaemonDiscoveryInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

/**
 * Where the daemon publishes its port + token for local clients to pick up. This is a
 * filesystem handoff, not a network one: the desktop app reads this file directly (it runs as
 * the same OS user) instead of the daemon ever broadcasting the token over the network.
 */
export function discoveryFilePath(): string {
  return join(tmpdir(), 'agent-dock', 'daemon.json');
}

export function writeDiscoveryFile(info: DaemonDiscoveryInfo): string {
  const filePath = discoveryFilePath();
  mkdirSync(join(tmpdir(), 'agent-dock'), { recursive: true });
  writeFileSync(filePath, JSON.stringify(info, null, 2), { mode: 0o600 });
  return filePath;
}

export function removeDiscoveryFile(): void {
  try {
    unlinkSync(discoveryFilePath());
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
 * Every client discovers the daemon through one fixed path (see discoveryFilePath), so two
 * daemons running at once would silently race to own it — whichever started last "wins" the
 * file, and the other becomes unreachable through discovery even though it's still alive and
 * still holding sessions. Rather than accept that ambiguity, the MVP policy is one daemon per
 * machine at a time: refuse to start if the existing file's pid is still alive. A stale file left
 * behind by a daemon that didn't get to clean up after itself (crash, force-kill) is fine to
 * overwrite — nothing is listening at that pid anymore.
 */
export function assertNoLiveDaemon(): void {
  const filePath = discoveryFilePath();
  if (!existsSync(filePath)) return;

  let existing: DaemonDiscoveryInfo;
  try {
    existing = JSON.parse(readFileSync(filePath, 'utf8')) as DaemonDiscoveryInfo;
  } catch {
    return; // corrupt/partial file from an interrupted write; safe to overwrite
  }

  if (typeof existing.pid === 'number' && isProcessAlive(existing.pid)) {
    throw new Error(
      `another agent-dock daemon is already running (pid ${existing.pid}, discovery file ${filePath}). ` +
        'Only one daemon instance is supported at a time in this MVP — stop it first.',
    );
  }
}
