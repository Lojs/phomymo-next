import { useEffect, useRef } from 'react';
import { useStore } from './state/store';
import { dirOf, useT } from './i18n';
import { TopBar } from './ui/TopBar';
import { Toolbox } from './ui/Toolbox';
import { LabelPanel } from './ui/LabelPanel';
import { ElementPanel } from './ui/ElementPanel';
import { Stage } from './ui/stage/Stage';
import { AboutDialog, DesignsDialog, ModelDialog, MultiDialog, PrintersDialog, PrintOverlay, SettingsDialog, TemplateDialog, Toasts } from './ui/Dialogs';
import { printCurrent } from './services/printing';
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
  const rootRef = useRef<HTMLDivElement>(null);

  useKeyboardShortcuts();

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dirOf(lang);
    document.title = t('appName');
  }, [lang, t]);

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
