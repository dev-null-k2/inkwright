import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/newsreader';
import '@fontsource-variable/brygada-1918';
import '@fontsource-variable/caveat';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/app.css';
import './fill/fill.css';
import './smart/smart.css';
import './styles/agent.css';
import './styles/palettes.css';
import './styles/localai.css';
import './styles/knowledge.css';
import { App } from './App.tsx';
import { BUILD_TARGET, isNative } from './platform/env.ts';
import { handleOAuthRedirect } from './lib/agent/oauth-callback.ts';

// Installable, offline-capable web app (Mac/Windows/Linux/ChromeOS/iPad "Add to Dock/Home Screen").
if (BUILD_TARGET === 'web' && !isNative && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}

// A connected app's sign-in popup only hands the result back to the main window.
if (!handleOAuthRedirect()) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
