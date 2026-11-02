import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/newsreader';
import '@fontsource-variable/brygada-1918';
import '@fontsource-variable/caveat';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/app.css';
import './styles/localai.css';
import { App } from './App.tsx';
import { BUILD_TARGET, isNative } from './platform/env.ts';

// Installable, offline-capable web app (Mac/Windows/Linux/ChromeOS/iPad "Add to Dock/Home Screen").
if (BUILD_TARGET === 'web' && !isNative && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
