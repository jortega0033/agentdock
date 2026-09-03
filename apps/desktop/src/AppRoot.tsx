import { useCallback, useRef, useState } from 'react';
import { App } from './App.js';
import { createDemoBridge } from './demo-bridge.js';
import type { AgentDockBridge } from './window.js';

/** Owns the demo-mode lifecycle so it stays isolated from `App`'s own logic: swaps the single
 * global `window.agentDock` between the real preload-assigned bridge and the demo bridge, and
 * fully remounts `<App>` (via `key`) on every transition so no demo session state can bleed into
 * a real session or vice versa. See the design doc for why a global swap + remount was chosen
 * over threading a second bridge instance through every `window.agentDock` call site in App.tsx. */
export function AppRoot() {
  const [demoMode, setDemoMode] = useState(false);
  const [instanceKey, setInstanceKey] = useState(0);
  const realBridgeRef = useRef<AgentDockBridge>();

  const enterDemoMode = useCallback(() => {
    realBridgeRef.current ??= window.agentDock;
    window.agentDock = createDemoBridge();
    setDemoMode(true);
    setInstanceKey((key) => key + 1);
  }, []);

  const exitDemoMode = useCallback(() => {
    if (realBridgeRef.current) window.agentDock = realBridgeRef.current;
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
