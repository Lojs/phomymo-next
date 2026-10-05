/**
 * localStorage persistence. Keys and shapes match the original app so designs,
 * settings and custom printers carry over when served from the same origin.
 */
import type { LabelElement } from '../model/elements';
import type { LabelSize, MultiLabelConfig } from '../render/layout';
import type { TemplateRecord } from '../template/template';
import type { PrinterDefinition } from '../printers/definitions';
import { LIMITS, clamp } from '../printers/presets';

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

/**
 * Saved designs, as a prototype-free record.
 *
 * Entries that are not objects are dropped rather than kept: listDesigns() reads
 * `d.elements?.length` and `d.savedAt` off each one, so a single corrupt entry (a hand-edited
 * localStorage value, a half-written record) would throw and take the whole library with it — with no
 * way to recover from the UI, because the dialog that would let you delete it is the one that failed.
 */
const allDesigns = () => {
  const raw = read<Record<string, unknown>>(KEYS.DESIGNS, {}, isRecord);
  const out = ownRecord<Record<string, Design>>({} as Record<string, Design>);
  for (const k of Object.keys(raw)) if (isRecord(raw[k])) out[k] = raw[k] as Design;
  return out;
};

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
  if (!num(e.x) || !num(e.y) || !num(e.width) || !num(e.height) || !num(e.rotation) || typeof e.id !== 'string') return false;
  // An image element carries its pixels in `imageData`, and the only form this app ever writes is
  // a data: URL — imported files are read with readAsDataURL, and shrinkImage returns one. Accepting
  // any string here let a hostile design file set imageData to 'https://attacker/pixel.png?id=victim',
  // which the canvas then loads. The shipped container's CSP (img-src 'self' data: blob:) stops the
  // request, but `npm run dev`, `npm run preview` and any other host serving the built files have no
  // such policy, and merely opening the design would contact the attacker's server with the victim's
  // IP and a query string of their choosing. Require the data: form so the pixels are always inline.
  if (t === 'image') {
    const src = e.imageData;
    if (typeof src !== 'string' || !src.startsWith('data:image/')) return false;
  }
  return true;
};

const isLabelSize = (v: unknown): boolean => {
  if (!isRecord(v)) return false;
  const s = v as Record<string, unknown>;
  if (!num(s.width) || !num(s.height)) return false;
  if (s.orientation !== undefined && s.orientation !== 'portrait' && s.orientation !== 'landscape') return false;
  return true;
};

/** Clamp a label size to the app's limits so a corrupt file can't allocate an enormous canvas. */
const clampLabelSize = (s: LabelSize): LabelSize => ({
  ...s,
  width: clamp(s.width, LIMITS.label.minW, LIMITS.label.maxW),
  height: clamp(s.height, LIMITS.label.minH, LIMITS.label.maxH),
});

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
  const design: Design = { elements: data.elements, labelSize: clampLabelSize(data.labelSize) };
  if (data.isTemplate) design.isTemplate = true;

  // Everything below used to be accepted on a bare Array.isArray / typeof-object check, so a file
  // with `templateData: [1,2,3]` or `multiLabel: { labelsAcross: "four" }` imported "successfully"
  // and then failed at print time, or printed "NaN" onto a label. Shape is checked here, at the
  // boundary, so a bad file is rejected with a message instead.
  if (data.templateFields !== undefined) {
    if (!Array.isArray(data.templateFields) || data.templateFields.some((f: unknown) => typeof f !== 'string')) {
      throw new Error('Invalid design format: templateFields must be an array of strings');
    }
    design.templateFields = data.templateFields;
  }
  if (data.templateData !== undefined) {
    if (!Array.isArray(data.templateData)) throw new Error('Invalid design format: templateData must be an array');
    data.templateData.forEach((r: unknown, i: number) => {
      if (!isRecord(r)) throw new Error(`Invalid design format: templateData row ${i + 1} is not an object`);
      for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
        // Values are substituted into text, so anything that is not a primitive would stringify to
        // "[object Object]" on the label.
        if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean' && v !== null) {
          throw new Error(`Invalid design format: templateData row ${i + 1} field "${k}" is not a value`);
        }
      }
    });
    design.templateData = data.templateData;
  }
  if (data.multiLabel !== undefined && data.multiLabel !== null) {
    if (!isRecord(data.multiLabel)) throw new Error('Invalid design format: multiLabel must be an object');
    const m = data.multiLabel as Record<string, unknown>;
    // A finite number, with the defaults applied only when the field is genuinely absent — `|| 10`
    // also swallowed a legitimate 0 and turned NaN into 10 without complaint.
    const num = (v: unknown, d: number, field: string) => {
      if (v === undefined) return d;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`Invalid design format: multiLabel.${field} must be a finite number`);
      }
      return v;
    };
    design.multiLabel = {
      enabled: !!m.enabled,
      labelWidth: clamp(num(m.labelWidth, 10, 'labelWidth'), LIMITS.multi.minLabelW, LIMITS.multi.maxLabelW),
      labelHeight: clamp(num(m.labelHeight, 20, 'labelHeight'), LIMITS.multi.minLabelH, LIMITS.multi.maxLabelH),
      labelsAcross: clamp(num(m.labelsAcross, 4, 'labelsAcross'), LIMITS.multi.minAcross, LIMITS.multi.maxAcross),
      gapMm: clamp(num(m.gapMm, 2, 'gapMm'), LIMITS.multi.minGap, LIMITS.multi.maxGap),
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

export const loadSettings = (): Settings => {
  const raw = ownRecord(read<Partial<Settings>>(KEYS.SETTINGS, {}, isRecord));
  return {
    density: clamp(typeof raw.density === 'number' && Number.isFinite(raw.density) ? raw.density : DEFAULT_SETTINGS.density, 1, 8),
    copies: clamp(typeof raw.copies === 'number' && Number.isFinite(raw.copies) ? raw.copies : DEFAULT_SETTINGS.copies, 1, 99),
    feed: clamp(typeof raw.feed === 'number' && Number.isFinite(raw.feed) ? raw.feed : DEFAULT_SETTINGS.feed, 0, 255),
    printerModel: typeof raw.printerModel === 'string' ? raw.printerModel : DEFAULT_SETTINGS.printerModel,
    tapeWidth: clamp(typeof raw.tapeWidth === 'number' && Number.isFinite(raw.tapeWidth) ? raw.tapeWidth : DEFAULT_SETTINGS.tapeWidth, 0, 100),
    ditherPreview: typeof raw.ditherPreview === 'boolean' ? raw.ditherPreview : DEFAULT_SETTINGS.ditherPreview,
  };
};
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

/** The size an autosave falls back to when its own is unusable. */
const DEFAULT_LABEL_SIZE: LabelSize = { width: 40, height: 30 };

/**
 * Rebuild a usable design from a stored autosave, keeping whatever is intact.
 *
 * Two failure modes were being conflated. A value that is not an object at all is discarded — there is
 * nothing to salvage. But a value that IS a design with one broken field must not cost the user the
 * rest of their work: previously the whole autosave was rejected, and since the check only ran
 * `isRecord`, a partial one got through and then broke the first render that read `elements.length`,
 * taking the app down at startup on every reload with no way to recover from the UI.
 *
 * So bad elements are dropped individually, and a missing label size takes the default. A design can
 * come back with fewer elements than it had, but never none of them.
 */
export function loadAutosave(): Design | null {
  const raw = read<unknown>(KEYS.AUTOSAVE, null, isRecord);
  if (!isRecord(raw)) return null;
  const d = raw as Record<string, unknown>;

  const elements = Array.isArray(d.elements) ? (d.elements.filter(isElement) as LabelElement[]) : [];
  const labelSize = isLabelSize(d.labelSize) ? clampLabelSize(d.labelSize as LabelSize) : { ...DEFAULT_LABEL_SIZE };

  // Nothing recognisable survived: treat it as no autosave rather than opening an empty design, which
  // would look to the user like their work vanished.
  if (!elements.length && !isLabelSize(d.labelSize)) return null;

  const design: Design = { elements, labelSize };
  if (d.isTemplate) design.isTemplate = true;
  if (Array.isArray(d.templateFields)) design.templateFields = d.templateFields.filter((f): f is string => typeof f === 'string');
  if (Array.isArray(d.templateData)) design.templateData = d.templateData.filter(isRecord) as TemplateRecord[];
  if (isRecord(d.multiLabel)) {
    const m = d.multiLabel as Record<string, unknown>;
    design.multiLabel = {
      enabled: !!m.enabled,
      labelWidth: clamp(finiteOr(m.labelWidth, 10), LIMITS.multi.minLabelW, LIMITS.multi.maxLabelW),
      labelHeight: clamp(finiteOr(m.labelHeight, 20), LIMITS.multi.minLabelH, LIMITS.multi.maxLabelH),
      labelsAcross: clamp(finiteOr(m.labelsAcross, 4), LIMITS.multi.minAcross, LIMITS.multi.maxAcross),
      gapMm: clamp(finiteOr(m.gapMm, 2), LIMITS.multi.minGap, LIMITS.multi.maxGap),
      cloneMode: m.cloneMode !== false,
    };
  }
  return design;
}

/**
 * A finite number, or the default.
 *
 * `value || fallback` would also replace a legitimate 0 — and 0 is a real labelWidth for a roll — so
 * the check is on the value itself rather than on its truthiness.
 */
const finiteOr = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Persist the working design.
 *
 * Returns whether the write actually landed. localStorage throws QuotaExceededError when a base64
 * image pushes the design past ~5MB, and the old version discarded the result — so an autosave that
 * had been failing for weeks looked exactly like one that was working, and the work was only
 * discovered to be gone at reload. Callers that can warn should check this.
 */
export const saveAutosave = (d: Design): boolean => write(KEYS.AUTOSAVE, d);
