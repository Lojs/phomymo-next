import { useRef, useState } from 'react';
import { useT } from '../i18n';
import { Icon, type IconName } from './icons';
import { useOutsideClose } from './kit';
import { SHAPES } from './shapes';
import { addBarcode, addImageFile, addQR, addShape, addText } from '../services/actions';
import { useStore } from '../state/store';

// Defined at module scope, not inside Toolbox(), so it has a stable component identity across
// renders. A component re-created inside its parent's render body gets a *new* function
// reference every render; React's reconciler then treats every <Tool> as a different component
// type from one render to the next and tears down + remounts the whole toolbox row instead of
// just updating it — including, on the very click that opens the shape submenu, the button the
// user just tapped. That's a real, non-cosmetic bug (not just a performance nit): it can make a
// click or tap misbehave depending on exactly when the remount lands relative to the event.
function Tool({ icon, label, onClick, badge }: { icon: IconName; label: string; onClick: () => void; badge?: number }) {
  return (
    <button type="button" className="tool" onClick={onClick} title={label}>
      <Icon name={icon} size={20} />
      <span>{label}</span>
      {!!badge && <em className="tool-badge">{badge}</em>}
    </button>
  );
}

export function Toolbox() {
  const t = useT();
  const file = useRef<HTMLInputElement>(null);
  const [shapes, setShapes] = useState(false);
  const templateCount = useStore((s) => s.templateData.length);
  // Closes on outside click/tap or Escape — not on pointer-leave, which has no touchscreen
  // equivalent and can race a tap on one of the menu's own buttons.
  const shapesRef = useOutsideClose(shapes, () => setShapes(false));

  return (
    <nav className="toolbox" aria-label="Tools">
      <Tool icon="text" label={t('addText')} onClick={addText} />
      <Tool icon="image" label={t('addImage')} onClick={() => file.current?.click()} />
      <Tool icon="barcode" label={t('addBarcode')} onClick={addBarcode} />
      <Tool icon="qr" label={t('addQR')} onClick={addQR} />
      <div className="tool-wrap" ref={shapesRef}>
        <Tool icon="shape" label={t('addShape')} onClick={() => setShapes((v) => !v)} />
        {shapes && (
          <div className="menu menu-shapes" role="menu">
            {SHAPES.map((s) => (
              <button key={s.type} role="menuitem" onClick={() => { addShape(s.type); setShapes(false); }}><Icon name={s.icon} size={16} />{t(s.label)}</button>
            ))}
          </div>
        )}
      </div>
      <Tool icon="data" label={t('templateData')} badge={templateCount} onClick={() => useStore.getState().openDialog('template')} />
      <input ref={file} type="file" accept="image/*,.pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void addImageFile(f); e.target.value = ''; }} />
    </nav>
  );
}
