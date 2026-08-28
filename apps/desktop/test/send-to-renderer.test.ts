import { describe, expect, it, vi } from 'vitest';
import { sendToRenderer, type DestroyableWindow } from '../electron/send-to-renderer.js';

function fakeWindow(opts: { windowDestroyed?: boolean; webContentsDestroyed?: boolean } = {}) {
  const send = vi.fn();
  const window: DestroyableWindow = {
    isDestroyed: () => opts.windowDestroyed ?? false,
    webContents: {
      isDestroyed: () => opts.webContentsDestroyed ?? false,
      send,
    },
  };
  return { window, send };
}

describe('sendToRenderer', () => {
  it('sends on a live window', () => {
    const { window, send } = fakeWindow();
    sendToRenderer(window, 'daemon:status', { state: 'ready' });
    expect(send).toHaveBeenCalledWith('daemon:status', { state: 'ready' });
  });

  it('does not throw and does not send when the window itself is destroyed', () => {
    const { window, send } = fakeWindow({ windowDestroyed: true });
    expect(() => sendToRenderer(window, 'daemon:status', { state: 'ready' })).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not throw and does not send when only webContents is destroyed', () => {
    // The case that actually crashed a real packaged build: the window can report itself alive
    // for a moment while its webContents is already torn down.
    const { window, send } = fakeWindow({ webContentsDestroyed: true });
    expect(() => sendToRenderer(window, 'daemon:status', { state: 'ready' })).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not throw and does not send when there is no window at all (undefined)', () => {
    expect(() => sendToRenderer(undefined, 'daemon:status', { state: 'ready' })).not.toThrow();
  });
});
