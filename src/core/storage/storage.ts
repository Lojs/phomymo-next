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

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

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

const allDesigns = () => read<Record<string, Design>>(KEYS.DESIGNS, {});

export function saveDesign(name: string, design: Design): void {
  const n = name.trim();
  if (!n) throw new Error('Design name is required');
  const all = allDesigns();
  all[n] = { ...design, savedAt: Date.now() };
  if (!write(KEYS.DESIGNS, all)) throw new Error('Failed to save design (storage full?)');
}

export const loadDesign = (name: string): Design | null => allDesigns()[name] ?? null;
export const designExists = (name: string) => name.trim() in allDesigns();

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
  if (!all[oldName]) throw new Error('Design not found');
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

export function parseDesignJSON(json: string): { name: string | null; design: Design } {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON format');
  }
  if (!data || !Array.isArray(data.elements)) throw new Error('Invalid design format: missing elements');
  if (!data.labelSize || typeof data.labelSize.width !== 'number') throw new Error('Invalid design format: missing label size');
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

export const loadSettings = (): Settings => ({ ...DEFAULT_SETTINGS, ...read<Partial<Settings>>(KEYS.SETTINGS, {}) });
export const saveSettings = (s: Settings) => void write(KEYS.SETTINGS, s);

// ---- per-device memory (printer model, tape width) -------------------------------------------
// Older versions stored a bare model string; newer ones an object. Read both.

type DeviceEntry = string | { model?: string; tapeWidth?: number };
const deviceMap = () => read<Record<string, DeviceEntry>>(KEYS.DEVICE_MAPPING, {});
const asObject = (e: DeviceEntry | undefined) => (typeof e === 'string' ? { model: e } : { ...(e ?? {}) });

export const getDeviceModel = (name: string): string | null => asObject(deviceMap()[name]).model ?? null;
export const getDeviceTapeWidth = (name: string): number | null => asObject(deviceMap()[name]).tapeWidth ?? null;

function patchDevice(name: string, patch: { model?: string; tapeWidth?: number }): void {
  if (!name) return;
  const all = deviceMap();
  all[name] = { ...asObject(all[name]), ...patch };
  write(KEYS.DEVICE_MAPPING, all);
}
export const saveDeviceModel = (name: string, model: string) => patchDevice(name, { model });
export const saveDeviceTapeWidth = (name: string, tapeWidth: number) => patchDevice(name, { tapeWidth });

// ---- custom printer definitions ----------------------------------------------------------

export const loadCustomPrinters = (): PrinterDefinition[] => read<PrinterDefinition[]>(KEYS.CUSTOM_PRINTERS, []);
export const saveCustomPrinters = (list: PrinterDefinition[]) => void write(KEYS.CUSTOM_PRINTERS, list);

// ---- multi-label presets -------------------------------------------------------------------

export type MultiPreset = Omit<MultiLabelConfig, 'enabled' | 'cloneMode'>;
export const loadMultiPresets = () => read<Record<string, MultiPreset>>(KEYS.MULTI_LABEL_PRESETS, {});
export function saveMultiPreset(name: string, p: MultiPreset): void {
  write(KEYS.MULTI_LABEL_PRESETS, { ...loadMultiPresets(), [name.trim()]: p });
}
export function deleteMultiPreset(name: string): void {
  const all = loadMultiPresets();
  delete all[name];
  write(KEYS.MULTI_LABEL_PRESETS, all);
}

// ---- autosave (work in progress survives a reload) ---------------------------------------------

export const loadAutosave = (): Design | null => read<Design | null>(KEYS.AUTOSAVE, null);
export const saveAutosave = (d: Design) => void write(KEYS.AUTOSAVE, d);
