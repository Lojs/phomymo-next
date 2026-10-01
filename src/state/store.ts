import { create } from 'zustand';
import {
  boundsOfMany, cloneToAllZones, collapseToSingleZone, expandToGroups, groupElements, newId, reorder, removeAboveZone,
  rotateComposition, ungroupElements, type LabelElement,
} from '../core/model/elements';
import type { LabelSize, MultiLabelConfig, Orientation } from '../core/render/layout';
import { displayLayout, multiLayout, orientationApplies, resolveOrientation, type LabelLayout } from '../core/render/layout';
import { PrinterRegistry } from '../core/printers/definitions';
import { presetsFor, presetKey, isKnownPreset, clamp, LIMITS } from '../core/printers/presets';
import * as storage from '../core/storage/storage';
import type { Design, Settings } from '../core/storage/storage';
import { extractFields, type TemplateRecord } from '../core/template/template';
import type { Lang } from '../i18n';

export interface Snapshot { elements: LabelElement[]; labelSize: LabelSize; multi: MultiLabelConfig }

export type DialogName = 'designs' | 'template' | 'print' | 'settings' | 'multi' | 'printers' | 'about' | 'model' | null;

export interface Toast { id: number; kind: 'info' | 'success' | 'error'; text: string }

export interface PrinterInfo {
  battery: number | null; paper: string | null; firmware: string | null; serial: string | null;
  cover: string | null; [k: string]: unknown;
}

export type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'failed';

export interface Connection {
  type: 'ble' | 'usb' | null;
  connected: boolean;
  busy: boolean;
  deviceName: string;
  /** Explicit, persistent connection status — distinct from the transient toast, so a failure
   *  is still visible next to the Connect button even after the toast disappears. */
  status: ConnStatus;
  /** Human-readable reason for the last failure, if status is 'failed'. */
  error: string | null;
}

const DEFAULT_MULTI: MultiLabelConfig = { enabled: false, labelWidth: 10, labelHeight: 20, labelsAcross: 4, gapMm: 2, cloneMode: true };
const HISTORY_MAX = 50;

const initialLang = (): Lang => {
  const saved = localStorage.getItem(storage.KEYS.LANG);
  if (saved === 'ar' || saved === 'en') return saved;
  return navigator.language?.toLowerCase().startsWith('ar') ? 'ar' : 'en';
};

interface State extends Snapshot {
  selectedIds: string[];
  activeZone: number;
  past: Snapshot[];
  future: Snapshot[];
  clipboard: LabelElement[];
  designName: string | null;
  dirty: boolean;

  templateData: TemplateRecord[];
  selectedRecords: number[];

  registry: PrinterRegistry;
  settings: Settings;
  conn: Connection;
  printerInfo: PrinterInfo | null;

  zoom: number;
  fit: boolean;
  localFonts: string[];
  lang: Lang;
  dialog: DialogName;
  toasts: Toast[];
  previewOnPaper: boolean;
  print: { active: boolean; label: string; current: number; total: number; sub: string } | null;

  // derived helpers
  layout: () => LabelLayout;
  selected: () => LabelElement[];
  fields: () => string[];
  snapshot: () => Snapshot;

  // history
  checkpoint: (coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;

  // elements
  add: (el: LabelElement) => void;
  patch: (ids: string[], changes: Partial<LabelElement> | ((el: LabelElement) => Partial<LabelElement>)) => void;
  patchSelected: (changes: Partial<LabelElement>, coalesceKey?: string) => void;
  replaceElements: (els: LabelElement[]) => void;
  select: (ids: string[], additive?: boolean) => void;
  removeSelected: () => void;
  copy: () => void;
  paste: () => void;
  duplicate: () => void;
  order: (how: 'front' | 'back' | 'up' | 'down') => void;
  group: () => void;
  ungroup: () => void;
  selectAll: () => void;

  // label / roll
  setLabelSize: (size: LabelSize) => void;
  setOrientation: (o: Orientation) => void;
  setMulti: (cfg: MultiLabelConfig) => void;
  exitMulti: () => void;
  setActiveZone: (z: number) => void;
  cloneActiveZoneToAll: () => void;

  // template
  setTemplateData: (rows: TemplateRecord[]) => void;
  setSelectedRecords: (i: number[]) => void;

  // settings / ui
  updateSettings: (s: Partial<Settings>) => void;
  setRegistry: (customs?: ReturnType<typeof storage.loadCustomPrinters>) => void;
  setConn: (c: Partial<Connection>) => void;
  setPrinterInfo: (i: PrinterInfo | null) => void;
  applyPrinterFamily: () => void;
  setZoom: (z: number, fit?: boolean) => void;
  setLocalFonts: (f: string[]) => void;
  setLang: (l: Lang) => void;
  openDialog: (d: DialogName) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  setPrint: (p: State['print']) => void;
  setPreviewOnPaper: (v: boolean) => void;

  // documents
  newDesign: () => void;
  loadDesign: (d: Design, name: string | null) => void;
  currentDesign: () => Design;
}

let lastCheckpointKey = '';
let lastCheckpointAt = 0;
let toastSeq = 1;

export const useStore = create<State>((set, get) => {
  const settings = storage.loadSettings();
  const registry = new PrinterRegistry(storage.loadCustomPrinters());
  const autosave = storage.loadAutosave();
  const fallbackSize: LabelSize = { width: 40, height: 30 };

  return {
    elements: autosave?.elements ?? [],
    labelSize: autosave?.labelSize ?? fallbackSize,
    multi: autosave?.multiLabel ?? DEFAULT_MULTI,
    selectedIds: [],
    activeZone: 0,
    past: [],
    future: [],
    clipboard: [],
    designName: null,
    dirty: false,

    templateData: autosave?.templateData ?? [],
    selectedRecords: [],

    registry,
    settings,
    conn: { type: null, connected: false, busy: false, deviceName: '', status: 'disconnected', error: null },
    printerInfo: null,

    zoom: 1,
    fit: true,
    localFonts: [],
    lang: initialLang(),
    dialog: null,
    toasts: [],
    previewOnPaper: false,
    print: null,

    // Multi-label rolls don't support orientation (each zone is small and fixed by the roll
    // config), so they always use the physical layout unchanged.
    layout: () => {
      const { multi, labelSize } = get();
      return multi.enabled ? multiLayout(multi) : displayLayout(labelSize);
    },
    selected: () => {
      const { elements, selectedIds } = get();
      return elements.filter((e) => selectedIds.includes(e.id));
    },
    fields: () => extractFields(get().elements),
    snapshot: () => {
      const { elements, labelSize, multi } = get();
      return { elements, labelSize, multi };
    },

    // ---- history --------------------------------------------------------------
    checkpoint: (key = '') => {
      const now = Date.now();
      if (key && key === lastCheckpointKey && now - lastCheckpointAt < 1000) {
        lastCheckpointAt = now;
        return;
      }
      lastCheckpointKey = key;
      lastCheckpointAt = now;
      const snap = get().snapshot();
      set((s) => ({ past: [...s.past, snap].slice(-HISTORY_MAX), future: [], dirty: true }));
    },
    undo: () => {
      const { past } = get();
      if (!past.length) return;
      const cur = get().snapshot();
      const prev = past[past.length - 1];
      lastCheckpointKey = '';
      set((s) => ({ ...prev, past: s.past.slice(0, -1), future: [cur, ...s.future].slice(0, HISTORY_MAX), selectedIds: [], dirty: true }));
    },
    redo: () => {
      const { future } = get();
      if (!future.length) return;
      const cur = get().snapshot();
      const next = future[0];
      lastCheckpointKey = '';
      set((s) => ({ ...next, future: s.future.slice(1), past: [...s.past, cur].slice(-HISTORY_MAX), selectedIds: [], dirty: true }));
    },

    // ---- elements ---------------------------------------------------------------
    add: (el) => {
      get().checkpoint();
      const withZone = { ...el, zone: get().multi.enabled ? get().activeZone : 0 };
      set((s) => ({ elements: [...s.elements, withZone], selectedIds: [el.id] }));
    },
    patch: (ids, changes) =>
      set((s) => ({
        elements: s.elements.map((e) => (ids.includes(e.id) ? ({ ...e, ...(typeof changes === 'function' ? changes(e) : changes) } as LabelElement) : e)),
        dirty: true,
      })),
    patchSelected: (changes, key) => {
      const ids = get().selectedIds;
      if (!ids.length) return;
      get().checkpoint(key ? `${key}:${ids.join(',')}` : '');
      get().patch(ids, changes);
    },
    replaceElements: (els) => set({ elements: els, dirty: true }),
    select: (ids, additive = false) =>
      set((s) => {
        const expanded = expandToGroups(s.elements, ids);
        if (!additive) return { selectedIds: expanded };
        const cur = new Set(s.selectedIds);
        const allIn = expanded.every((i) => cur.has(i));
        for (const i of expanded) allIn ? cur.delete(i) : cur.add(i);
        return { selectedIds: [...cur] };
      }),
    removeSelected: () => {
      const ids = get().selectedIds;
      if (!ids.length) return;
      get().checkpoint();
      set((s) => ({ elements: s.elements.filter((e) => !ids.includes(e.id)), selectedIds: [] }));
    },
    copy: () => set((s) => ({ clipboard: s.elements.filter((e) => s.selectedIds.includes(e.id)) })),
    paste: () => {
      const { clipboard, multi, activeZone } = get();
      if (!clipboard.length) return;
      get().checkpoint();
      const gmap = new Map<string, string>();
      const copies = clipboard.map((e) => {
        let groupId = e.groupId ?? null;
        if (groupId) {
          if (!gmap.has(groupId)) gmap.set(groupId, 'grp_' + newId().slice(3));
          groupId = gmap.get(groupId)!;
        }
        return { ...e, id: newId(), x: e.x + 16, y: e.y + 16, groupId, zone: multi.enabled ? activeZone : 0 } as LabelElement;
      });
      set((s) => ({ elements: [...s.elements, ...copies], selectedIds: copies.map((c) => c.id), clipboard: copies }));
    },
    duplicate: () => {
      get().copy();
      get().paste();
    },
    order: (how) => {
      const ids = get().selectedIds;
      if (!ids.length) return;
      get().checkpoint();
      set((s) => {
        let els = s.elements;
        const list = how === 'front' || how === 'down' ? ids : [...ids].reverse();
        for (const id of list) els = reorder(els, id, how);
        return { elements: els };
      });
    },
    group: () => {
      const ids = get().selectedIds;
      if (ids.length < 2) return;
      get().checkpoint();
      set((s) => ({ elements: groupElements(s.elements, ids).elements }));
    },
    ungroup: () => {
      const groups = new Set(get().selected().map((e) => e.groupId).filter(Boolean) as string[]);
      if (!groups.size) return;
      get().checkpoint();
      set((s) => ({ elements: [...groups].reduce((els, g) => ungroupElements(els, g), s.elements) }));
    },
    selectAll: () => {
      const { elements, multi, activeZone } = get();
      set({ selectedIds: elements.filter((e) => !multi.enabled || (e.zone ?? 0) === activeZone).map((e) => e.id) });
    },

    // ---- label size / roll ------------------------------------------------------------
    setLabelSize: (size) => {
      get().checkpoint();
      const s = get();
      set({
        labelSize: size,
        multi: { ...s.multi, enabled: false },
        elements: s.multi.enabled ? collapseToSingleZone(removeAboveZone(s.elements, 0)) : s.elements,
        activeZone: 0,
        fit: true,
      });
    },
    /**
     * Switch Portrait ↔ Landscape. The physical label size is never touched — only the design's
     * layout on it. If the label already has elements, the whole composition rotates 90° with
     * the canvas so what's on screen keeps its shape (see core/model/elements.rotateComposition).
     * No-op for round labels, square labels, and multi-label rolls, where orientation is not
     * a meaningful choice.
     */
    setOrientation: (o) => {
      const s = get();
      if (s.multi.enabled) return;
      const cur = s.labelSize;
      if (resolveOrientation(cur) === o) return;
      if (!orientationApplies(cur)) {
        set({ labelSize: { ...cur, orientation: o } });
        return;
      }
      get().checkpoint();
      const before = displayLayout(cur);
      const rotated = rotateComposition(s.elements, before.width, before.height, o === 'landscape' ? 'cw' : 'ccw');
      set({ labelSize: { ...cur, orientation: o }, elements: rotated, selectedIds: [], fit: true });
    },
    setMulti: (cfg) => {
      get().checkpoint();
      const across = clamp(cfg.labelsAcross, LIMITS.multi.minAcross, LIMITS.multi.maxAcross);
      const next = { ...cfg, labelsAcross: across, enabled: true };
      set((s) => ({
        multi: next,
        elements: next.cloneMode ? cloneToAllZones(removeAboveZone(s.elements, across - 1), 0, across) : removeAboveZone(s.elements, across - 1),
        activeZone: 0,
        fit: true,
      }));
    },
    exitMulti: () => {
      get().checkpoint();
      set((s) => ({
        multi: { ...s.multi, enabled: false },
        elements: collapseToSingleZone(removeAboveZone(s.elements, 0)),
        activeZone: 0,
        fit: true,
      }));
    },
    setActiveZone: (z) => set({ activeZone: z, selectedIds: [] }),
    cloneActiveZoneToAll: () => {
      const { multi, activeZone } = get();
      if (!multi.enabled) return;
      get().checkpoint();
      set((s) => ({ elements: cloneToAllZones(s.elements, activeZone, multi.labelsAcross) }));
    },

    // ---- template -------------------------------------------------------------------------
    setTemplateData: (rows) => set({ templateData: rows, selectedRecords: [], dirty: true }),
    setSelectedRecords: (i) => set({ selectedRecords: i }),

    // ---- settings / ui ----------------------------------------------------------------------
    updateSettings: (patch) => {
      const next = { ...get().settings, ...patch };
      storage.saveSettings(next);
      set({ settings: next });
      if ('printerModel' in patch || 'tapeWidth' in patch) get().applyPrinterFamily();
    },
    setRegistry: (customs = storage.loadCustomPrinters()) => {
      set({ registry: new PrinterRegistry(customs) });
      get().applyPrinterFamily();
    },
    setConn: (c) => set((s) => ({ conn: { ...s.conn, ...c } })),
    setPrinterInfo: (i) => set({ printerInfo: i }),
    /** When the printer family changes, keep the current size if the family offers it, else pick its default. */
    applyPrinterFamily: () => {
      const { registry, conn, settings, labelSize, multi } = get();
      if (multi.enabled) return;
      const groups = presetsFor(registry.resolve(conn.deviceName, settings.printerModel), settings.tapeWidth);
      const offered = { ...groups.rect, ...groups.round, ...groups.continuous };
      const key = presetKey(labelSize);
      if (key in offered || !isKnownPreset(key)) return; // still valid, or a user-defined custom size
      const fallback = offered[groups.defaultKey];
      if (fallback) set({ labelSize: { ...fallback }, fit: true });
    },
    setZoom: (z, fit = false) => set({ zoom: clamp(z, LIMITS.zoom.min, LIMITS.zoom.max), fit }),
    setLocalFonts: (f) => set({ localFonts: f }),
    setLang: (l) => {
      localStorage.setItem(storage.KEYS.LANG, l);
      set({ lang: l });
    },
    openDialog: (d) => set({ dialog: d }),
    toast: (text, kind = 'info') => {
      const id = toastSeq++;
      set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 5000 : 2600);
    },
    setPrint: (p) => set({ print: p }),
    setPreviewOnPaper: (v) => set({ previewOnPaper: v }),

    // ---- documents -----------------------------------------------------------------------------
    newDesign: () => {
      get().checkpoint();
      set({ elements: [], selectedIds: [], templateData: [], selectedRecords: [], designName: null, dirty: false });
    },
    loadDesign: (d, name) => {
      set({
        elements: d.elements,
        labelSize: d.labelSize,
        multi: d.multiLabel ?? DEFAULT_MULTI,
        templateData: d.templateData ?? [],
        selectedRecords: [],
        selectedIds: [],
        activeZone: 0,
        past: [],
        future: [],
        designName: name,
        dirty: false,
        fit: true,
      });
    },
    currentDesign: () => {
      const { elements, labelSize, multi, templateData } = get();
      const fields = extractFields(elements);
      return {
        elements,
        labelSize,
        ...(multi.enabled ? { multiLabel: multi } : {}),
        ...(fields.length || templateData.length ? { isTemplate: true, templateFields: fields, templateData } : {}),
      };
    },
  };
});

// Autosave the working design (debounced) so a reload never loses work.
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((s, prev) => {
  if (s.elements === prev.elements && s.labelSize === prev.labelSize && s.multi === prev.multi && s.templateData === prev.templateData) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => storage.saveAutosave(useStore.getState().currentDesign()), 600);
});

export const selectedBounds = () => boundsOfMany(useStore.getState().selected());
