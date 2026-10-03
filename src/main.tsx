import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './fonts';
import './styles.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline shell. Registered after the first render so it never competes with startup for bandwidth,
// and failures are swallowed: an app that works online must not break because a service worker could
// not be installed (private browsing, an unsupported context, a hard refresh).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}