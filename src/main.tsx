import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './fonts';
import './styles.css';
import App from './App';
import { useStore } from './state/store';
import { translate } from './i18n';
import { KEYS, onOtherTabWrite, startCrossTabWatch } from './core/storage/storage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Another tab on this origin — a second browser tab, or the installed PWA window beside it — writes
// to the same localStorage, and both the autosave and the saved-designs map are last-writer-wins.
// Nothing here can merge the two, but the user can be told, which is the difference between losing
// work silently and losing it knowingly.
startCrossTabWatch();
onOtherTabWrite((key) => {
  const store = useStore.getState();
  store.toast(
    key === KEYS.AUTOSAVE
      ? translate(store.lang, 'changedElsewhere')
      : translate(store.lang, 'storageChangedElsewhere'),
    'error',
  );
});

// Offline shell. Registered after the first render so it never competes with startup for bandwidth,
// and failures are swallowed: an app that works online must not break because a service worker could
// not be installed (private browsing, an unsupported context, a hard refresh).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}