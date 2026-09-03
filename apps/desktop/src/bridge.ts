import type { AgentDockBridge } from './window.js';

// `contextBridge.exposeInMainWorld('agentDock', api)` (electron/preload.ts) makes `window.agentDock`
// non-writable in the renderer -- assigning it throws in strict-mode ESM. Demo mode needs to swap in
// a fixture bridge at runtime, so every call site reads through this lazy indirection instead of the
// frozen global; `activeOverride` is renderer-owned state that can be freely reassigned.
let activeOverride: AgentDockBridge | undefined;

export function getBridge(): AgentDockBridge {
  return activeOverride ?? window.agentDock;
}

export function setBridgeOverride(bridge: AgentDockBridge): void {
  activeOverride = bridge;
}

export function clearBridgeOverride(): void {
  activeOverride = undefined;
}
