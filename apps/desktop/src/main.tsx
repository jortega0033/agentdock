import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRoot } from './AppRoot.js';
import './styles.css';

async function renderApp(): Promise<void> {
  const captureMode =
    import.meta.env.DEV && new URLSearchParams(window.location.search).has('asset-capture');
  if (captureMode) {
    const { installAssetCaptureBridge } = await import('./asset-capture-bridge.js');
    installAssetCaptureBridge();
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppRoot />
    </StrictMode>,
  );
}

void renderApp();
