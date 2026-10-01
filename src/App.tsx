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

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? st.redo() : st.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); st.redo(); return; }
      if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); st.copy(); return; }
      if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); st.paste(); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); st.duplicate(); return; }
      if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); e.shiftKey ? st.ungroup() : st.group(); return; }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); st.selectAll(); return; }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        const name = st.designName ?? window.prompt('Design name')?.trim();
        if (name) saveCurrentDesign(name);
        return;
      }
      if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); void printCurrent(); return; }
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
