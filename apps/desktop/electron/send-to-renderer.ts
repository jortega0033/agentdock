/**
 * Structural subset of Electron's BrowserWindow that matters here — kept minimal and separate
 * from an `import type { BrowserWindow } from 'electron'` so this file (and its guard logic) is
 * testable with a plain fake object, no Electron runtime required.
 */
export interface DestroyableWindow {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
}

/**
 * The daemon child's 'exit' event (and the SSE stream's error path) can fire *after* the window
 * has already closed — e.g. during shutdown, killing the daemon races with window teardown.
 * `webContents.send()` on an already-destroyed window throws, and an uncaught throw from inside a
 * child_process event handler crashes the whole main process. Reproduced against a real packaged
 * build: closing the window while a daemon-exit event was in flight left a native crash dialog
 * and stray helper processes behind instead of a clean quit. Every push to the renderer goes
 * through this guard so it only has to exist once.
 */
export function sendToRenderer(target: DestroyableWindow | undefined, channel: string, payload: unknown): void {
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
  target.webContents.send(channel, payload);
}
