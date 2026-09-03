import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

/**
 * The one reusable sender check every privileged `ipcMain.handle` registration routes through.
 * This app has exactly one legitimate IPC caller: the current main window's own top-level frame.
 * Relying on "there's only one window today" instead of checking this explicitly is a fork-time
 * trust-boundary default that silently stops holding the moment a fork adds a second window, a
 * devtools/child frame, or renders untrusted content in an iframe. Electron's own guidance is to
 * compare `event.senderFrame` against the exact frame you expect
 * (https://www.electronjs.org/docs/latest/tutorial/ipc#security-considerations): a destroyed
 * window, a secondary `webContents` (e.g. a devtools window), or a non-main child frame of the
 * right window must all fail this check.
 */
export function isFromMainWindowFrame(
  mainWindow: BrowserWindow | undefined,
  event: IpcMainInvokeEvent,
): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return event.senderFrame === mainWindow.webContents.mainFrame;
}
