import { useCallback, useState } from 'react';
import { App } from './App.js';
import { createDemoBridge } from './demo-bridge.js';
import { clearBridgeOverride, setBridgeOverride } from './bridge.js';

/** Owns the demo-mode lifecycle so it stays isolated from `App`'s own logic: swaps the active
 * bridge (via bridge.ts's override -- `window.agentDock` itself is frozen by Electron's
 * `contextBridge.exposeInMainWorld` and cannot be reassigned) between the real preload-assigned
 * bridge and the demo bridge, and fully remounts `<App>` (via `key`) on every transition so no
 * demo session state can bleed into a real session or vice versa. */
export function AppRoot() {
  const [demoMode, setDemoMode] = useState(false);
  const [instanceKey, setInstanceKey] = useState(0);

  const enterDemoMode = useCallback(() => {
    setBridgeOverride(createDemoBridge());
    setDemoMode(true);
    setInstanceKey((key) => key + 1);
  }, []);

  const exitDemoMode = useCallback(() => {
    clearBridgeOverride();
    setDemoMode(false);
    setInstanceKey((key) => key + 1);
  }, []);

  return (
    <App
      key={instanceKey}
      demoMode={demoMode}
      onEnterDemo={enterDemoMode}
      onExitDemo={exitDemoMode}
    />
  );
}
