import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';

// Service worker only in browser — not in Electron (file/vite + Pear worker)
const isElectron =
  typeof window !== 'undefined' &&
  Boolean((window as Window & { bridge?: unknown }).bridge);

if (!isElectron) {
  void import('virtual:pwa-register').then(({ registerSW }) => {
    const updateSW = registerSW({
      onNeedRefresh() {
        if (confirm('A new version of Chennamane is available. Reload?')) {
          updateSW(true);
        }
      },
    });
  });
  // Warm 3D assets in the browser only. Electron already hosts a Bare worker +
  // Chromium — eager GLB/HDR preload spikes RSS before first paint.
  void import('./ui/three/sharedAssets').then((m) => m.preloadBoardAssets());
  void import('./ui/three/HomeBoardHero');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
