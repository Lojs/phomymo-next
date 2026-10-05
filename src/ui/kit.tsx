import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { useT } from '../i18n';

/**
 * Closes a menu/popover when the user taps or clicks anywhere outside it, or presses Escape.
 * Robust on touch as well as mouse — unlike a hover-based `onPointerLeave` close, which doesn't
 * correspond to anything meaningful on a touchscreen (there is no "hover" to leave), and which
 * can also race the closing element's own click if a leave event fires as part of the same tap.
 */
export function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open, close]);
  return ref;
}

export function Button({ icon, children, variant = 'default', active, ...p }: {
  icon?: IconName; variant?: 'default' | 'primary' | 'ghost' | 'danger'; active?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...p} className={`btn btn-${variant}${active ? ' is-active' : ''}${children ? '' : ' btn-icon'} ${p.className ?? ''}`}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

/**
 * A labelled action menu — the label lives on the trigger only.
 * This job cannot be done by a native <select>: the only way to show a label while nothing is
 * chosen is a placeholder <option>, and Chrome then lists that same option as the first row of the
 * popup, so the label appeared twice (once on the closed control, once in the list). Here the
 * popup holds only the real choices.
 */
export function MenuButton({ label, items, onPick, layout = 'list', icon }: {
  label: string;
  /** `hint` is a second, dimmer line under the label — the algorithm's real name beside the plain one. */
  items: { value: string; label: string; icon?: IconName; hint?: string }[];
  onPick: (value: string) => void;
  /** `grid` lays the items out two-per-row, for palettes too long to read as one column. */
  layout?: 'list' | 'grid';
  icon?: IconName;
}) {
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  const menuRef = useRef<HTMLDivElement>(null);

  /**
   * Open upward when the menu would fall off the bottom of the window.
   *
   * A native `<select>` is repositioned by the browser; a popup built from a div is not, so a menu
   * opened by a control low in a short window rendered its last rows below the viewport with no way
   * to scroll to them — the option was simply unreachable. Measuring after mount and before paint
   * means the flip is not visible as a jump.
   */
  /**
   * The vertical band the menu has to fit inside: the window, narrowed by every ancestor that clips.
   *
   * The window was the only boundary considered, and it is not the only one that can cut a menu off.
   * The controls sit in a panel that scrolls (`.panel { overflow-y: auto }`), so a menu opened by a
   * control near the bottom of a short panel was inside the window and still half outside the panel:
   * the window test said "fits", the flip was not taken, and the options that fell past the panel's
   * edge were only reachable by scrolling a panel the user had no reason to think was hiding them.
   *
   * Only the window counts as a floor, so the loop starts at 0 and only ever narrows.
   */
  useLayoutEffect(() => {
    if (!open) { setFlip(false); return; }
    // `.menu-wrap` tightly wraps the trigger, and Button does not forward a ref, so the wrapper
    // is the trigger's box.
    const button = ref.current?.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();
    if (!button || !menu || menu.height === 0) return;
    let top = 0;
    let bottom = window.innerHeight;
    for (let p = menuRef.current?.parentElement ?? null; p; p = p.parentElement) {
      if (getComputedStyle(p).overflowY === 'visible') continue;
      const box = p.getBoundingClientRect();
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    }
    setFlip(menu.bottom > bottom && button.top > menu.height && button.top - menu.height >= top);
  }, [open]);

  return (
    <div className="menu-wrap" ref={ref}>
      <Button variant="default" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        {icon && <Icon name={icon} size={16} />}{label}<Icon name="chevron" size={14} />
      </Button>
      {open && (
        <div
          ref={menuRef}
          className={`menu ${layout === 'grid' ? 'menu-shapes' : 'menu-field'}${flip ? ' menu-up' : ''}`}
          role="menu"
        >
          {items.map((it) => (
            <button key={it.value} role="menuitem" onClick={() => { setOpen(false); onPick(it.value); }}>
              {it.icon && <Icon name={it.icon} size={16} />}
              <span className="menu-text">
                {it.label}
                {it.hint && <span className="menu-hint">{it.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A labelled form field.
 *
 * The `id` goes on the *control*, not on the wrapper. A `<label htmlFor>` may only point at a
 * labelable element; pointing it at the wrapper <div> associated the label with nothing, so
 * assistive tech could not announce any field's name and clicking a label did not focus its
 * input. When the child already carries an id it is left alone, and a child that is not a single
 * element (a fragment, or plain text) falls back to the wrapper — where an explicit aria-label on
 * the control is the caller's responsibility.
 */
export function Field({ label, children, hint, inline }: { label: string; children: ReactNode; hint?: string; inline?: boolean }) {
  const id = useId();
  const child = isValidElement(children) ? children : null;
  const controlId = child && !(child.props as { id?: string }).id ? id : undefined;
  return (
    <div className={`field${inline ? ' field-inline' : ''}`}>
      <label htmlFor={controlId ?? id} className="field-label">{label}</label>
      <div className="field-control" id={controlId ? undefined : id}>
        {child && controlId ? cloneElement(child as ReactElement<{ id?: string }>, { id: controlId }) : children}
      </div>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

/**
 * A numeric field that behaves like a normal text input while you're editing it: you can clear
 * it, type multiple digits, select-and-replace, etc., without every keystroke being clamped and
 * committed. The value is only parsed, clamped, and pushed to `onChange` on blur or Enter —
 * exactly like a native form field. While focused, what you see is exactly what you typed.
 */
const formatNum = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '');

export function NumberInput({ value, onChange, min, max, step = 1, unit, width, disabled, title, id }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; unit?: string; width?: number; disabled?: boolean; title?: string; id?: string;
}) {
  const [draft, setDraft] = useState(() => formatNum(value));
  const focused = useRef(false);

  // Sync from outside (e.g. selecting a different element, or an external clamp) — but never
  // while the user is actively typing, or every keystroke's round-trip through the store would
  // stomp on what they just typed.
  useEffect(() => {
    if (!focused.current) setDraft(formatNum(value));
  }, [value]);

  const commit = (raw: string) => {
    const v = parseFloat(raw);
    if (Number.isFinite(v)) {
      const clamped = min !== undefined && max !== undefined ? Math.min(max, Math.max(min, v)) : v;
      onChange(clamped);
      setDraft(formatNum(clamped));
    } else {
      // Empty or not-yet-a-number (e.g. "-" or "3."): quietly revert to the last valid value
      // rather than forcing a default while the field still has focus.
      setDraft(formatNum(value));
    }
  };

  return (
    <span className="num" style={width ? { width } : undefined}>
      <input
        id={id}
        type="text" inputMode="decimal" value={draft} step={step} disabled={disabled} title={title} aria-label={title}
        onFocus={(e) => { focused.current = true; e.currentTarget.select(); }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => { focused.current = false; commit(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(e.currentTarget.value); e.currentTarget.blur(); }
          else if (e.key === 'Escape') { setDraft(formatNum(value)); e.currentTarget.blur(); }
        }}
      />
      {unit && <span className="num-unit">{unit}</span>}
    </span>
  );
}

export function Slider({ value, onChange, min, max, step = 1, disabled, id }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number; disabled?: boolean; id?: string }) {
  return (
    <span className={`slider${disabled ? ' is-disabled' : ''}`}>
      <input id={id} type="range" value={value} min={min} max={max} step={step} disabled={disabled} onChange={(e) => onChange(parseFloat(e.target.value))} />
      <NumberInput value={value} onChange={onChange} min={min} max={max} step={step} width={64} disabled={disabled} />
    </span>
  );
}

export function Segmented<T extends string | number | boolean>({ value, options, onChange, label }: {
  value: T; options: { value: T; label?: string; icon?: IconName; title?: string }[]; onChange: (v: T) => void; label?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" title={o.title ?? o.label} aria-pressed={o.value === value} className={o.value === value ? 'is-on' : ''} onClick={() => onChange(o.value)}>
          {o.icon ? <Icon name={o.icon} size={16} /> : o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-box" aria-hidden="true"><Icon name="check" size={12} /></span>
      <span>{label}</span>
    </label>
  );
}

export function Select({ value, onChange, children, ...rest }: { value: string; onChange: (v: string) => void; children: ReactNode } & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'>) {
  return <select value={value} onChange={(e) => onChange(e.target.value)} {...rest}>{children}</select>;
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head"><h3>{title}</h3>{aside}</header>
      <div className="section-body">{children}</div>
    </section>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <Button variant="ghost" icon="close" aria-label={t('close')} onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}
