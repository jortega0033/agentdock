import { describe, expect, it } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent, WebFrameMain } from 'electron';
import { isFromMainWindowFrame } from '../electron/ipc-sender-guard.js';

function fakeFrame(): WebFrameMain {
  return {} as WebFrameMain;
}

function fakeWindow(mainFrame: WebFrameMain, destroyed = false): BrowserWindow {
  return {
    isDestroyed: () => destroyed,
    webContents: { mainFrame },
  } as unknown as BrowserWindow;
}

function fakeEvent(senderFrame: WebFrameMain): IpcMainInvokeEvent {
  return { senderFrame } as unknown as IpcMainInvokeEvent;
}

describe('isFromMainWindowFrame', () => {
  it('accepts a message from the main window main frame', () => {
    const frame = fakeFrame();
    const window = fakeWindow(frame);
    expect(isFromMainWindowFrame(window, fakeEvent(frame))).toBe(true);
  });

  it('rejects a message from a different (non-main) child frame of the same window', () => {
    const mainFrame = fakeFrame();
    const childFrame = fakeFrame();
    const window = fakeWindow(mainFrame);
    expect(isFromMainWindowFrame(window, fakeEvent(childFrame))).toBe(false);
  });

  it('rejects a message from a secondary webContents (e.g. a devtools window)', () => {
    const window = fakeWindow(fakeFrame());
    const secondaryWebContentsFrame = fakeFrame();
    expect(isFromMainWindowFrame(window, fakeEvent(secondaryWebContentsFrame))).toBe(false);
  });

  it('rejects every message once the main window has been destroyed', () => {
    const frame = fakeFrame();
    const window = fakeWindow(frame, true);
    expect(isFromMainWindowFrame(window, fakeEvent(frame))).toBe(false);
  });

  it('rejects every message when there is no main window at all', () => {
    expect(isFromMainWindowFrame(undefined, fakeEvent(fakeFrame()))).toBe(false);
  });
});
