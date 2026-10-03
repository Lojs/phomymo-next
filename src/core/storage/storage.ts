/**
 * localStorage persistence. Keys and shapes match the original app so designs,
 * settings and custom printers carry over when served from the same origin.
 */
import type { LabelElement } from '../model/elements';
import type { LabelSize, MultiLabelConfig } from '../render/layout';
import type { TemplateRecord } from '../template/template';
import type { PrinterDefinition } from '../printers/definitions';

export const KEYS = {
  DEVICE_MAPPING: 'phomymo_device_models',
  DESIGNS: 'phomymo_designs',
  SETTINGS: 'phomymo_settings',
  MULTI_LABEL_PRESETS: 'phomymo_multi_label_presets',
  CUSTOM_PRINTERS: 'phomymo_custom_printers',
  LANG: 'phomymo_lang',
  AUTOSAVE: 'phomymo_autosave',
} as const;

/**
 * Read + JSON.parse a key. `isValid` is optional shape validation: a structurally-valid but
 * wrong-typed value (a legacy `"null"`, an array where an object belongs) would otherwise flow
 * into callers that assume the type — e.g. `name in allDesigns()` throws a TypeError on null —
 * and take down the designs list with no way to recover from the UI. Returning the fallback
 * instead degrades to "no saved data", which the app already handles.
 */
function read<T>(key: string, fallback: T, isValid?: (v: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (isValid && !isValid(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

/** A non-null, non-array object — the shape every key here except CUSTOM_PRINTERS expects. */
const isRecord = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
const isArray = (v: unknown): boolean => Array.isArray(v);

/**
 * A record read back from storage, safe to use `in` and `[]` on.
 *
 * The values here come from JSON.parse, and JSON.parse('{"__proto__": …}') produces an object whose
 * `__proto__` is an *own* property rather than a prototype mutation — so `name in designs` walks the
 * prototype chain and reports true for names that were never saved ("constructor", "toString"), while
 * `Object.keys` does not list them. Object.create(null) drops that chain, so `in` means what it looks
 * like it means and a lookup cannot return Object.prototype's members.
 */
const ownRecord = <T>(v: T): T => (isRecord(v) ? (Object.assign(Object.create(null) as object, v) as T) : v);

/** True when `key` is a real own property, not an inherited Object.prototype member. */
const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// ---- designs -----------------------------------------------------------------------

export interface Design {
  elements: LabelElement[];
  labelSize: LabelSize;
  multiLabel?: MultiLabelConfig;
  isTemplate?: boolean;
  templateFields?: string[];
  templateData?: TemplateRecord[];
  savedAt?: number;
}

export interface DesignSummary { name: string; savedAt: number; elementCount: number; isTemplate: boolean; recordCount: number }

const allDesigns = () => ownRecord(read<Record<string, Design>>(KEYS.DESIGNS, {}, isRecord));

export function saveDesign(name: string, design: Design): void {
  const n = name.trim();
  if (!n) throw new Error('Design name is required');
  const all = allDesigns();
  all[n] = { ...design, savedAt: Date.now() };
  if (!write(KEYS.DESIGNS, all)) throw new Error('Failed to save design (storage full?)');
}

export const loadDesign = (name: string): Design | null => {
  const all = allDesigns();
  return hasOwn(all, name) ? all[name] ?? null : null;
};
export const designExists = (name: string) => hasOwn(allDesigns(), name.trim());

export function listDesigns(): DesignSummary[] {
  return Object.entries(allDesigns())
    .map(([name, d]) => ({
      name,
      savedAt: d.savedAt ?? 0,
      elementCount: d.elements?.length ?? 0,
      isTemplate: !!d.isTemplate,
      recordCount: d.templateData?.length ?? 0,
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

export function deleteDesign(name: string): void {
  const all = allDesigns();
  delete all[name];
  write(KEYS.DESIGNS, all);
}

export function renameDesign(oldName: string, newName: string): void {
  const all = allDesigns();
  if (!hasOwn(all, oldName) || !all[oldName]) throw new Error('Design not found');
  const n = newName.trim();
  if (!n) throw new Error('Design name is required');
  if (n !== oldName && all[n]) throw new Error('A design with that name already exists');
  all[n] = all[oldName];
  if (n !== oldName) delete all[oldName];
  write(KEYS.DESIGNS, all);
}

export function exportDesignJSON(name: string, design: Design): string {
  return JSON.stringify({ name, version: 3, ...design }, null, 2);
}

/** A finite number — the only thing safe to feed into geometry math (NaN/Infinity produce garbage). */
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Reject an element whose geometry is not numeric. Without this an imported file with a string
 * `x`/`rotation` loads fine and only fails much later — as NaN coordinates inside boundsOf /
 * paintLabel, far from the import try/catch, so the user sees a blank or broken canvas instead of
 * "invalid file". Element type is checked too, since drawElement switches on it.
 */
const isElement = (v: unknown): boolean => {
  if (!isRecord(v)) return false;
  const e = v as Record<string, unknown>;
  const t = e.type;
  if (t !== 'text' && t !== 'image' && t !== 'barcode' && t !== 'qr' && t !== 'shape') return false;
  return num(e.x) && num(e.y) && num(e.width) && num(e.height) && num(e.rotation) && typeof e.id === 'string';
};

const isLabelSize = (v: unknown): boolean => {
  if (!isRecord(v)) return false;
  const s = v as Record<string, unknown>;
  if (!num(s.width) || !num(s.height)) return false;
  if (s.orientation !== undefined && s.orientation !== 'portrait' && s.orientation !== 'landscape') return false;
  return true;
};

export function parseDesignJSON(json: string): { name: string | null; design: Design } {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON format');
  }
  if (!data || !Array.isArray(data.elements)) throw new Error('Invalid design format: missing elements');
  if (!isLabelSize(data.labelSize)) throw new Error('Invalid design format: missing or malformed label size');
  const bad = data.elements.findIndex((e: unknown) => !isElement(e));
  if (bad !== -1) throw new Error(`Invalid design format: element ${bad + 1} is malformed`);
  const design: Design = { elements: data.elements, labelSize: data.labelSize };
  if (data.isTemplate) design.isTemplate = true;
  if (Array.isArray(data.templateFields)) design.templateFields = data.templateFields;
  if (Array.isArray(data.templateData)) design.templateData = data.templateData;
  if (data.multiLabel && typeof data.multiLabel === 'object') {
    const m = data.multiLabel;
    design.multiLabel = {
      enabled: !!m.enabled,
      labelWidth: m.labelWidth || 10,
      labelHeight: m.labelHeight || 20,
      labelsAcross: m.labelsAcross || 4,
      gapMm: m.gapMm || 2,
      cloneMode: m.cloneMode !== false,
    };
  }
  return { name: typeof data.name === 'string' ? data.name : null, design };
}

// ---- settings ----------------------------------------------------------------------

export interface Settings {
  density: number;
  copies: number;
  feed: number;
  printerModel: string;
  tapeWidth: number;
  ditherPreview: boolean;
}

export const DEFAULT_SETTINGS: Settings = { density: 6, copies: 1, feed: 32, printerModel: 'auto', tapeWidth: 12, ditherPreview: false };

export const loadSettings = (): Settings => ({ ...DEFAULT_SETTINGS, ...ownRecord(read<Partial<Settings>>(KEYS.SETTINGS, {}, isRecord)) });
export const saveSettings = (s: Settings) => void write(KEYS.SETTINGS, s);

// ---- per-device memory (printer model, tape width) -------------------------------------------
// Older versions stored a bare model string; newer ones an object. Read both.

type DeviceEntry = string | { model?: string; tapeWidth?: number };
const deviceMap = () => ownRecord(read<Record<string, DeviceEntry>>(KEYS.DEVICE_MAPPING, {}, isRecord));
const asObject = (e: DeviceEntry | undefined) => (typeof e === 'string' ? { model: e } : { ...(e ?? {}) });

export const getDeviceModel = (name: string): string | null => (hasOwn(deviceMap(), name) ? asObject(deviceMap()[name]).model ?? null : null);
export const getDeviceTapeWidth = (name: string): number | null => (hasOwn(deviceMap(), name) ? asObject(deviceMap()[name]).tapeWidth ?? null : null);

function patchDevice(name: string, patch: { model?: string; tapeWidth?: number }): void {
  if (!name) return;
  const all = deviceMap();
  all[name] = { ...asObject(all[name]), ...patch };
  write(KEYS.DEVICE_MAPPING, all);
}
export const saveDeviceModel = (name: string, model: string) => patchDevice(name, { model });
export const saveDeviceTapeWidth = (name: string, tapeWidth: number) => patchDevice(name, { tapeWidth });

// ---- custom printer definitions ----------------------------------------------------------

export const loadCustomPrinters = (): PrinterDefinition[] => read<PrinterDefinition[]>(KEYS.CUSTOM_PRINTERS, [], isArray);
export const saveCustomPrinters = (list: PrinterDefinition[]) => void write(KEYS.CUSTOM_PRINTERS, list);

// ---- multi-label presets -------------------------------------------------------------------

export type MultiPreset = Omit<MultiLabelConfig, 'enabled' | 'cloneMode'>;
export const loadMultiPresets = () => ownRecord(read<Record<string, MultiPreset>>(KEYS.MULTI_LABEL_PRESETS, {}, isRecord));
export function saveMultiPreset(name: string, p: MultiPreset): void {
  write(KEYS.MULTI_LABEL_PRESETS, { ...loadMultiPresets(), [name.trim()]: p });
}
export function deleteMultiPreset(name: string): void {
  const all = loadMultiPresets();
  delete all[name];
  write(KEYS.MULTI_LABEL_PRESETS, all);
}

// ---- autosave (work in progress survives a reload) ---------------------------------------------

/**
 * True when a stored autosave is safe to hand back to the app.
 *
 * isRecord alone was not enough: an object with no `elements` array and no `labelSize` passed it and
 * then broke the first render that read `elements.length`, taking the whole app down at startup with
 * no way to recover from the UI. This checks the two fields the app dereferences immediately, so a
 * corrupt value degrades to "no autosave" — which the app already handles.
 */
const isAutosave = (v: unknown): boolean =>
  isRecord(v) && Array.isArray((v as Design).elements) && isLabelSize((v as Design).labelSize);

export const loadAutosave = (): Design | null => read<Design | null>(KEYS.AUTOSAVE, null, isAutosave);

/**
 * Persist the working design.
 *
 * Returns whether the write actually landed. localStorage throws QuotaExceededError when a base64
 * image pushes the design past ~5MB, and the old version discarded the result — so an autosave that
 * had been failing for weeks looked exactly like one that was working, and the work was only
 * discovered to be gone at reload. Callers that can warn should check this.
 */
export const saveAutosave = (d: Design): boolean => write(KEYS.AUTOSAVE, d);
