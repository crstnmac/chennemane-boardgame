import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { registerSW } from 'virtual:pwa-register';

const updateSW = registerSW({
  onNeedRefresh() {
    if (confirm('A new version of Chennamane is available. Reload?')) {
      updateSW(true);
    }
  },
});

// Warm 3D assets ASAP so home hero doesn't flash empty / placeholder
void import('./ui/three/sharedAssets').then((m) => m.preloadBoardAssets());
void import('./ui/three/HomeBoardHero');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
