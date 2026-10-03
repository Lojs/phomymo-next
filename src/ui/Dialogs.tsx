import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { useT } from '../i18n';
import { APP_VERSION } from '../version';
import { Button, Field, Modal, NumberInput, Segmented, Select, Slider, Toggle } from './kit';
import { Icon } from './icons';
import { deleteDesign, listDesigns, loadDesign, renameDesign, designExists, saveCustomPrinters, loadCustomPrinters, deleteMultiPreset, loadMultiPresets, saveMultiPreset, saveDeviceModel, DEFAULT_SETTINGS } from '../core/storage/storage';
import { exportCsv, exportJson, exportPdf, exportPng, importCsvFile, importDesignFile, saveCurrentDesign } from '../services/actions';
import { cancelBatch, isBatchRunning, printDensityTest, rememberModel, runBatch } from '../services/printing';
import { BUILTIN_PRINTERS, type PrinterDefinition } from '../core/printers/definitions';
import { LIMITS } from '../core/printers/presets';
import { createEmptyRecord, evaluateExpressions, generateSampleData, substituteFields } from '../core/template/template';
import { paintLabel } from '../core/render/label';
import { prepareForRender } from '../core/render/label';
import { multiLayout, PX_PER_MM } from '../core/render/layout';

const close = () => useStore.getState().openDialog(null);

// ---- designs ---------------------------------------------------------------------------------

export function DesignsDialog() {
  const t = useT();
  const s = useStore();
  const [version, setVersion] = useState(0);
  const [name, setName] = useState(s.designName ?? '');
  const file = useRef<HTMLInputElement>(null);
  const items = useMemo(() => listDesigns(), [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = () => {
    const n = name.trim();
    if (!n) return;
    if (n !== s.designName && designExists(n) && !window.confirm(`${n}?`)) return;
    if (saveCurrentDesign(n)) setVersion((v) => v + 1);
  };

  return (
    <Modal title={t('designs')} onClose={close} wide>
      <div className="dlg-row">
        <input className="grow" value={name} placeholder={t('designName')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} aria-label={t('designName')} />
        <Button variant="primary" icon="check" disabled={!name.trim()} onClick={save}>{t('saveDesign')}</Button>
      </div>
      <div className="dlg-row dlg-row-wrap">
        <Button icon="plus" onClick={() => { if (!s.elements.length || window.confirm(t('confirmNew'))) { s.newDesign(); close(); } }}>{t('newDesign')}</Button>
        <Button icon="download" onClick={() => file.current?.click()}>{t('importJson')}</Button>
        <Button icon="upload" onClick={exportJson}>{t('exportJson')}</Button>
        <Button icon="image" onClick={() => void exportPng()}>{t('exportPng')}</Button>
        <Button icon="upload" onClick={() => void exportPdf()}>{t('exportPdf')}</Button>
        <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importDesignFile(f).then(() => { setVersion((v) => v + 1); close(); }); e.target.value = ''; }} />
      </div>

      {items.length === 0 ? <p className="empty-note">{t('noDesigns')}</p> : (
        <ul className="list">
          {items.map((d) => (
            <li key={d.name} className={d.name === s.designName ? 'is-current' : ''}>
              <button type="button" className="list-main" onClick={() => { const dsg = loadDesign(d.name); if (dsg) { s.loadDesign(dsg, d.name); close(); } }}>
                <strong>{d.name}</strong>
                <span>{t('elementsCount', { n: d.elementCount })}{d.recordCount ? ` · ${t('recordsCount', { n: d.recordCount })}` : ''}{d.savedAt ? ` · ${new Date(d.savedAt).toLocaleDateString(s.lang === 'ar' ? 'ar' : undefined)}` : ''}</span>
              </button>
              <Button variant="ghost" icon="text" title={t('rename')} aria-label={t('rename')} onClick={() => { const n = window.prompt(t('rename'), d.name)?.trim(); if (n && n !== d.name) { try { renameDesign(d.name, n); if (s.designName === d.name) useStore.setState({ designName: n }); setVersion((v) => v + 1); } catch (e) { s.toast((e as Error).message, 'error'); } } }} />
              <Button variant="ghost" icon="trash" title={t('delete')} aria-label={t('delete')} onClick={() => { if (window.confirm(`${t('delete')}: ${d.name}?`)) { deleteDesign(d.name); setVersion((v) => v + 1); } }} />
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

// ---- template data -----------------------------------------------------------------------------

function Thumb({ record, index }: { record: Record<string, string>; index: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const elements = useStore((s) => s.elements);
  const multi = useStore((s) => s.multi);
  const labelSize = useStore((s) => s.labelSize);
  const layout = useMemo(() => useStore.getState().layout(), [multi, labelSize]);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    // Expressions first, then data (see printCurrent in services/printing.ts).
    const els = substituteFields(evaluateExpressions(elements), record);
    let dead = false;
    void prepareForRender(els).then(() => {
      if (dead) return;
      c.width = layout.width;
      c.height = layout.height;
      paintLabel(c.getContext('2d')!, els, layout);
    });
    return () => { dead = true; };
  }, [record, elements, layout]);
  return <canvas ref={ref} aria-label={`#${index + 1}`} />;
}

export function TemplateDialog() {
  const t = useT();
  const s = useStore();
  const fields = s.fields();
  const columns = fields.length ? fields : Object.keys(s.templateData[0] ?? {});
  const [grid, setGrid] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const rows = s.templateData;
  const chosen = s.selectedRecords;

  const setCell = (i: number, key: string, v: string) => s.setTemplateData(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  const toggle = (i: number) => s.setSelectedRecords(chosen.includes(i) ? chosen.filter((x) => x !== i) : [...chosen, i].sort((a, b) => a - b));
  const start = async (indexes: number[]) => { close(); await runBatch(indexes); };
  const all = rows.map((_, i) => i);

  return (
    <Modal title={t('templateTitle')} onClose={close} wide footer={
      <>
        <Button onClick={() => start(chosen)} disabled={!chosen.length} icon="print">{t('printSelected')}</Button>
        <Button variant="primary" onClick={() => start(all)} disabled={!rows.length} icon="print">{t('printAll')}</Button>
      </>
    }>
      <p className="field-hint">{t('fieldsHint')}</p>
      {columns.length === 0 && <p className="empty-note">{t('noFields')}</p>}
      <div className="dlg-row dlg-row-wrap">
        <Button icon="plus" disabled={!columns.length} onClick={() => s.setTemplateData([...rows, createEmptyRecord(columns)])}>{t('addRecord')}</Button>
        <Button icon="download" onClick={() => file.current?.click()}>{t('importCsv')}</Button>
        <Button icon="upload" disabled={!rows.length} onClick={exportCsv}>{t('exportCsv')}</Button>
        <Button disabled={!fields.length} onClick={() => s.setTemplateData(generateSampleData(fields, 3))}>{t('sampleData')}</Button>
        <Button variant="ghost" icon="trash" disabled={!rows.length} onClick={() => s.setTemplateData([])}>{t('clearData')}</Button>
        <Button variant="ghost" icon="eye" active={grid} disabled={!rows.length} onClick={() => setGrid((g) => !g)}>{t('preview')}</Button>
        <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importCsvFile(f); e.target.value = ''; }} />
      </div>

      {grid ? (
        <div className="thumbs">
          {rows.slice(0, 60).map((r, i) => (
            <button key={i} type="button" className={`thumb${chosen.includes(i) ? ' is-on' : ''}`} onClick={() => toggle(i)}>
              <Thumb record={r} index={i} /><span>{t('record', { n: i + 1 })}</span>
            </button>
          ))}
        </div>
      ) : rows.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th><input type="checkbox" aria-label={t('selectAll')} checked={chosen.length === rows.length} onChange={(e) => s.setSelectedRecords(e.target.checked ? all : [])} /></th>
                {columns.map((c) => <th key={c}>{c}</th>)}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td><input type="checkbox" checked={chosen.includes(i)} onChange={() => toggle(i)} aria-label={t('record', { n: i + 1 })} /></td>
                  {columns.map((c) => <td key={c}><input value={r[c] ?? ''} dir="auto" onChange={(e) => setCell(i, c, e.target.value)} aria-label={`${c} ${i + 1}`} /></td>)}
                  <td><Button variant="ghost" icon="trash" aria-label={t('delete')} onClick={() => { s.setTemplateData(rows.filter((_, j) => j !== i)); }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ---- multi-label roll ----------------------------------------------------------------------------

export function MultiDialog() {
  const t = useT();
  const s = useStore();
  const [cfg, setCfg] = useState({ labelWidth: s.multi.labelWidth, labelHeight: s.multi.labelHeight, labelsAcross: s.multi.labelsAcross, gapMm: s.multi.gapMm, cloneMode: s.multi.cloneMode });
  const [presets, setPresets] = useState(loadMultiPresets());
  const [preset, setPreset] = useState('');
  const layout = multiLayout(cfg);
  const totalMm = layout.width / PX_PER_MM;
  const upd = (p: Partial<typeof cfg>) => setCfg((c) => ({ ...c, ...p }));

  return (
    <Modal title={t('multiLabelRoll')} onClose={close} footer={
      <>
        {s.multi.enabled && <Button variant="ghost" onClick={() => { s.exitMulti(); close(); }}>{t('exitRoll')}</Button>}
        <Button variant="primary" onClick={() => { s.setMulti({ ...cfg, enabled: true }); close(); }}>{t('apply')}</Button>
      </>
    }>
      <svg className="roll-preview" viewBox={`-4 -4 ${layout.width + 8} ${layout.height + 8}`} role="img" aria-label={`${cfg.labelsAcross} × ${cfg.labelWidth}×${cfg.labelHeight}`}>
        {layout.zones!.map((z, i) => <g key={i}><rect x={z.x} y={z.y} width={z.width} height={z.height} rx={3} /><text x={z.x + z.width / 2} y={z.y + z.height / 2 + 4} textAnchor="middle">{i + 1}</text></g>)}
      </svg>
      <p className="field-hint mono">{totalMm.toFixed(0)} {t('mm')} {totalMm > 100 ? '⚠' : ''}</p>
      <div className="grid-2">
        <Field label={t('width')}><NumberInput value={cfg.labelWidth} min={5} max={100} unit={t('mm')} onChange={(v) => upd({ labelWidth: v })} /></Field>
        <Field label={t('height')}><NumberInput value={cfg.labelHeight} min={5} max={200} unit={t('mm')} onChange={(v) => upd({ labelHeight: v })} /></Field>
        <Field label={t('labelsAcross')}><NumberInput value={cfg.labelsAcross} min={LIMITS.multi.minAcross} max={LIMITS.multi.maxAcross} onChange={(v) => upd({ labelsAcross: Math.round(v) })} /></Field>
        <Field label={t('gap')}><NumberInput value={cfg.gapMm} min={LIMITS.multi.minGap} max={LIMITS.multi.maxGap} step={0.5} unit={t('mm')} onChange={(v) => upd({ gapMm: v })} /></Field>
      </div>
      <Toggle checked={cfg.cloneMode} onChange={(v) => upd({ cloneMode: v })} label={t('cloneMode')} />
      {s.multi.enabled && <Button icon="copy" onClick={() => { s.cloneActiveZoneToAll(); }}>{t('cloneNow')}</Button>}

      <Field label={t('presets')}>
        <span className="row">
          <Select value={preset} onChange={(v) => { setPreset(v); const p = presets[v]; if (p) upd(p); }}>
            <option value="">—</option>
            {Object.keys(presets).map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
          <Button icon="check" title={t('savePreset')} aria-label={t('savePreset')} onClick={() => { const n = window.prompt(t('presetName'))?.trim(); if (n) { saveMultiPreset(n, { labelWidth: cfg.labelWidth, labelHeight: cfg.labelHeight, labelsAcross: cfg.labelsAcross, gapMm: cfg.gapMm }); setPresets(loadMultiPresets()); setPreset(n); } }} />
          <Button icon="trash" variant="ghost" disabled={!preset} aria-label={t('delete')} onClick={() => { deleteMultiPreset(preset); setPresets(loadMultiPresets()); setPreset(''); }} />
        </span>
      </Field>
    </Modal>
  );
}

// ---- printers ---------------------------------------------------------------------------------------

const PROTOCOLS = ['m-series', 'm02', 'm04', 'm110', 'p12', 'd-series', 'tspl'];
const blank = (): PrinterDefinition => ({ id: '', name: '', protocol: 'm-series', widthBytes: 48, dpi: 203, alignment: 'center', rotated: false, tape: false, tapeWidths: null, defaultTapeWidth: null, namePatterns: [] });

export function PrintersDialog() {
  const t = useT();
  const s = useStore();
  const [edit, setEdit] = useState<PrinterDefinition | null>(null);
  const [isNew, setIsNew] = useState(false);
  const customIds = new Set(loadCustomPrinters().map((d) => d.id));

  const persist = (list: PrinterDefinition[]) => { saveCustomPrinters(list); s.setRegistry(list); };
  const commit = () => {
    if (!edit || !edit.id.trim() || !edit.name.trim()) return;
    const def = { ...edit, id: edit.id.trim(), builtin: false };
    persist([...loadCustomPrinters().filter((d) => d.id !== def.id), def]);
    setEdit(null);
  };

  if (edit) {
    const set = (p: Partial<PrinterDefinition>) => setEdit({ ...edit, ...p });
    return (
      <Modal title={isNew ? t('addPrinter') : t('editPrinter')} onClose={() => setEdit(null)} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>{t('cancel')}</Button><Button variant="primary" onClick={commit} disabled={!edit.id.trim() || !edit.name.trim()}>{t('save')}</Button></>}>
        <Field label={t('printerId')}><input value={edit.id} disabled={!isNew} onChange={(e) => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })} /></Field>
        <Field label={t('printerName')}><input value={edit.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <div className="grid-2">
          <Field label={t('protocol')}><Select value={edit.protocol} onChange={(v) => set({ protocol: v })}>{PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}</Select></Field>
          <Field label={t('dpi')}><Select value={String(edit.dpi)} onChange={(v) => set({ dpi: Number(v) })}><option value="203">203</option><option value="300">300</option></Select></Field>
          <Field label={t('widthBytes')}><NumberInput value={edit.widthBytes ?? 0} min={0} max={255} onChange={(v) => set({ widthBytes: Math.round(v) || null })} /></Field>
          <Field label={t('alignment')}><Segmented value={edit.alignment} onChange={(v) => set({ alignment: v })} options={[{ value: 'left', icon: 'alignL' }, { value: 'center', icon: 'alignC' }, { value: 'right', icon: 'alignR' }]} /></Field>
        </div>
        <Toggle checked={edit.rotated} onChange={(v) => set({ rotated: v })} label={t('rotated')} />
        <Toggle checked={edit.tape} onChange={(v) => set({ tape: v, tapeWidths: v ? [12, 14, 15] : null })} label={t('tapePrinter')} />
        <Field label={t('namePatterns')}><input value={edit.namePatterns.join(', ')} onChange={(e) => set({ namePatterns: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></Field>
      </Modal>
    );
  }

  return (
    <Modal title={t('printersTitle')} onClose={close} wide footer={<Button variant="primary" icon="plus" onClick={() => { setIsNew(true); setEdit(blank()); }}>{t('addPrinter')}</Button>}>
      <ul className="list">
        {s.registry.all.map((d) => {
          const custom = customIds.has(d.id);
          const overridesBuiltin = custom && BUILTIN_PRINTERS.some((b) => b.id === d.id);
          return (
            <li key={d.id}>
              <div className="list-main">
                <strong>{d.name}</strong>
                <span className="mono">{d.protocol} · {d.widthBytes ?? '—'} B · {d.dpi} dpi · {custom ? t('customPrinter') : t('builtin')}</span>
              </div>
              <Button variant="ghost" icon="settings" aria-label={t('editPrinter')} onClick={() => { setIsNew(false); setEdit({ ...d }); }} />
              {custom && <Button variant="ghost" icon={overridesBuiltin ? 'undo' : 'trash'} aria-label={overridesBuiltin ? t('resetPrinter') : t('delete')} title={overridesBuiltin ? t('resetPrinter') : t('delete')} onClick={() => persist(loadCustomPrinters().filter((x) => x.id !== d.id))} />}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

// ---- unrecognised printer -------------------------------------------------------------------------------

export function ModelDialog() {
  const t = useT();
  const s = useStore();
  const [model, setModel] = useState(s.registry.all.find((d) => d.id === 'm110')?.id ?? s.registry.all[0].id);
  const [remember, setRemember] = useState(true);
  return (
    <Modal title={t('chooseModelTitle')} onClose={close} footer={<Button variant="primary" onClick={() => { s.updateSettings({ printerModel: model }); if (remember) saveDeviceModel(s.conn.deviceName, model); close(); }}>{t('useModel')}</Button>}>
      <p>{t('chooseModelBody', { name: s.conn.deviceName })}</p>
      <Field label={t('printerModel')}><Select value={model} onChange={setModel}>{s.registry.all.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
      <Toggle checked={remember} onChange={setRemember} label={t('remember')} />
    </Modal>
  );
}

// ---- about ---------------------------------------------------------------------------------------------------

export function AboutDialog() {
  const t = useT();
  const keys: [string, string][] = [['Ctrl/⌘ + Z / Shift+Z', t('undo') + ' / ' + t('redo')], ['Ctrl/⌘ + C / V / D', t('duplicate')], ['Ctrl/⌘ + G', t('group')], ['Ctrl/⌘ + S', t('saveDesign')], ['Ctrl/⌘ + P', t('print')], ['Delete', t('remove')], ['← ↑ ↓ →', t('position')], ['Alt', '—'], ['Ctrl/⌘ + Wheel', t('zoomIn')]];
  return (
    <Modal title={t('aboutTitle')} onClose={close}>
      <p>{t('aboutBody')}</p>
      <h3 className="mini-h">{t('shortcuts')}</h3>
      <dl className="status-list mono">{keys.slice(0, 7).map(([k, v]) => <><dt key={k}>{k}</dt><dd>{v}</dd></>)}</dl>
      {/* The version is shown here rather than in the topbar, keeping the brand lockup clean.
          Both this line and the credit below are pinned to the physical left in every
          language — they are English/LTR strings, and mixing a left-hand version with a
          right-hand credit looked untidy in the RTL layout. dir="ltr" also stops RTL from
          reordering "v1.0.2". */}
      <div className="about-meta" dir="ltr">
        <p className="app-version">v{APP_VERSION}</p>
        <p className="field-hint">Based on <a href="https://github.com/transcriptionstream/phomymo" target="_blank" rel="noreferrer">transcriptionstream/phomymo</a>.</p>
      </div>
    </Modal>
  );
}

// ---- print progress ---------------------------------------------------------------------------------------------

export function PrintOverlay() {
  const t = useT();
  const p = useStore((s) => s.print);
  if (!p?.active) return null;
  const pct = Math.min(100, Math.round(((p.current + 0) / Math.max(1, p.total)) * 100));
  return (
    <div className="scrim scrim-print" role="alertdialog" aria-live="polite" aria-label={p.label}>
      <div className="modal modal-small">
        <div className="printing-mark"><Icon name="print" size={22} /></div>
        <h2>{p.label}</h2>
        <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>
        <p className="field-hint mono">{p.total > 1 ? `${Math.min(p.current + 1, p.total)}/${p.total}` : ''} {p.sub}</p>
        {isBatchRunning() && <Button icon="stop" onClick={cancelBatch}>{t('stop')}</Button>}
      </div>
    </div>
  );
}

// ---- print settings -----------------------------------------------------------------------------
// Everything printer-facing lives here and only here. The printer block used to sit in the side
// panel, so density/copies/feed were permanently in the way of the design controls even though
// they change about once a month. Settings apply immediately, so the footer is Reset + Done
// rather than Save — a Save button would imply the fields above it do nothing until you press it.

export function SettingsDialog() {
  const t = useT();
  const s = useStore();
  const reset = () => s.updateSettings({
    printerModel: DEFAULT_SETTINGS.printerModel,
    density: DEFAULT_SETTINGS.density,
    copies: DEFAULT_SETTINGS.copies,
    feed: DEFAULT_SETTINGS.feed,
  });

  return (
    <Modal
      title={t('printSettings')}
      onClose={close}
      footer={<>
        <Button onClick={reset}>{t('reset')}</Button>
        <Button variant="primary" onClick={close}>{t('done')}</Button>
      </>}
    >
      <Field label={t('printer')}>
        <span className={`pill${s.conn.connected ? ' pill-on' : ''}`}>{s.conn.connected ? s.conn.deviceName : t('notConnected')}</span>
      </Field>
      <Field label={t('printerModel')}>
        <Select
          value={s.settings.printerModel}
          onChange={(v) => { s.updateSettings({ printerModel: v }); if (s.conn.deviceName && v !== 'auto') rememberModel(s.conn.deviceName, v); }}
        >
          <option value="auto">{t('autoDetect')}</option>
          {s.registry.all.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
      </Field>
      <Field label={t('density')}><Slider value={s.settings.density} min={1} max={8} onChange={(v) => s.updateSettings({ density: v })} /></Field>
      {/* Copies and the print preview live in the top bar: they are changed while printing, not
          while configuring the printer, so reaching them shouldn't cost a dialog. */}
      <Field label={t('feed')}><NumberInput value={s.settings.feed} min={0} max={255} step={8} onChange={(v) => s.updateSettings({ feed: Math.round(v) })} /></Field>
      <div className="row row-wrap">
        <Button icon="sliders" onClick={() => void printDensityTest()} disabled={!s.conn.connected}>{t('densityTest')}</Button>
        <Button icon="settings" variant="ghost" onClick={() => s.openDialog('printers')}>{t('managePrinters')}</Button>
      </div>
      {/* The printer's readout (battery, paper, cover, firmware, serial) is not here: it belongs to
          the device, not to a setting, and it now lives in the connect menu under Disconnect. */}
    </Modal>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((x) => <div key={x.id} className={`toast toast-${x.kind}`}>{x.text}</div>)}
    </div>
  );
}
