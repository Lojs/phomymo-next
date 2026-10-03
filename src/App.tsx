import { useEffect, useRef } from 'react';
import { useStore } from './state/store';
import { dirOf, useT } from './i18n';
import { TopBar } from './ui/TopBar';
import { Toolbox } from './ui/Toolbox';
import { LabelPanel } from './ui/LabelPanel';
import { ElementPanel } from './ui/ElementPanel';
import { Stage } from './ui/stage/Stage';
import { AboutDialog, DesignsDialog, ModelDialog, MultiDialog, PrintersDialog, PrintOverlay, SettingsDialog, TemplateDialog, Toasts } from './ui/Dialogs';
import { printCurrent, reconnectIfNeeded } from './services/printing';
import { saveCurrentDesign } from './services/actions';

const isEditable = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.tagName === 'SELECT');
};

function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;

      if (isEditable(e.target)) return;

      // Key off `e.code` (the physical key), not `e.key` (the character the layout
      // produces). With an Arabic keyboard the Z key reports e.key='س', so every
      // Ctrl shortcut silently did nothing — which is exactly the audience this app
      // is built for. e.code is layout-independent. Non-letter keys (arrows,
      // Delete, Escape) keep matching on e.key since those never change.
      const k = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
      const letter = (c: string) => k === c;

      if (mod && letter('z')) {
        e.preventDefault();
        e.shiftKey ? st.redo() : st.undo();
        return;
      }
      if (mod && letter('y')) { e.preventDefault(); st.redo(); return; }
      if (mod && letter('c')) { e.preventDefault(); st.copy(); return; }
      if (mod && letter('v')) { e.preventDefault(); st.paste(); return; }
      if (mod && letter('d')) { e.preventDefault(); st.duplicate(); return; }
      if (mod && letter('g')) { e.preventDefault(); e.shiftKey ? st.ungroup() : st.group(); return; }
      if (mod && letter('a')) { e.preventDefault(); st.selectAll(); return; }
      if (mod && letter('s')) {
        e.preventDefault();
        const name = st.designName ?? window.prompt('Design name')?.trim();
        if (name) saveCurrentDesign(name);
        return;
      }
      if (mod && letter('p')) { e.preventDefault(); void printCurrent(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && st.selectedIds.length) { e.preventDefault(); st.removeSelected(); return; }
      if (e.key === 'Escape') { st.select([]); return; }

      const step = e.shiftKey ? 10 : 1;
      const nudge: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (nudge[e.key] && st.selectedIds.length) {
        e.preventDefault();
        const [dx, dy] = nudge[e.key];
        st.checkpoint(`nudge:${st.selectedIds.join(',')}`);
        st.replaceElements(st.elements.map((el) => (st.selectedIds.includes(el.id) ? { ...el, x: el.x + dx, y: el.y + dy } : el)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export default function App() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const dialog = useStore((s) => s.dialog);
  const selectedIds = useStore((s) => s.selectedIds);
  const connected = useStore((s) => s.conn.connected);
  const rootRef = useRef<HTMLDivElement>(null);

  useKeyboardShortcuts();

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dirOf(lang);
    document.title = t('appName');
  }, [lang, t]);

  /**
   * Restore the printer link when the user comes back to the tab.
   *
   * A backgrounded tab can be frozen by the browser, which drops the GATT link through no fault of
   * the app's. Without this the user would have to open the connect menu and pick the printer again
   * just because they looked at another tab. reconnectIfNeeded() is a no-op unless the link
   * actually dropped on its own and a device is still remembered, so this cannot open the picker
   * unprompted or undo a deliberate Disconnect.
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reconnectIfNeeded();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  /**
   * Keep the screen awake while the app is on screen and a printer is connected.
   *
   * Honest about what this can and cannot do: the browser releases a screen wake lock the moment
   * the page becomes hidden, so this does NOT stop a background tab from being frozen — nothing a
   * page can do does. What it does is stop the *device* from sleeping while the app is in front of
   * you, which is the other way a printing session dies. The re-acquire on visibilitychange is
   * required because the lock is dropped, not paused, when the page hides.
   */
  useEffect(() => {
    if (!connected) return;
    if (!('wakeLock' in navigator)) return;
    let lock: { release: () => Promise<void> } | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      try {
        lock = await (navigator as unknown as { wakeLock: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock.request('screen');
      } catch {
        // Denied, or unsupported in this context (an insecure origin, for one). Not worth a toast:
        // the app works fine without it, and the reconnect above is the real safety net.
      }
    };

    void acquire();
    const onVisible = () => { if (document.visibilityState === 'visible') void acquire(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => {});
      lock = null;
    };
  }, [connected]);

  return (
    <div className="app" ref={rootRef}>
      <TopBar />
      <div className="app-body">
        <Toolbox />
        <main className="app-stage"><Stage /></main>
        <aside className="app-panel" aria-label={t('properties')}>
          {selectedIds.length ? <ElementPanel /> : <LabelPanel />}
        </aside>
      </div>

      {dialog === 'designs' && <DesignsDialog />}
      {dialog === 'settings' && <SettingsDialog />}
      {dialog === 'template' && <TemplateDialog />}
      {dialog === 'multi' && <MultiDialog />}
      {dialog === 'printers' && <PrintersDialog />}
      {dialog === 'model' && <ModelDialog />}
      {dialog === 'about' && <AboutDialog />}
      <PrintOverlay />
      <Toasts />
    </div>
  );
}
