/**
 * Printer definitions and model resolution.
 *
 * Built-in definitions ship in printers.json (same data as the original
 * project). Custom definitions are supplied by the caller (persisted in
 * localStorage by the app layer) and win over built-ins on id collision.
 */
import builtinData from './printers.json';

export type Protocol = 'm-series' | 'm02' | 'm04' | 'm110' | 'p12' | 'd-series' | 'tspl' | (string & {});
export type Alignment = 'left' | 'center' | 'right';

export interface PrinterDefinition {
  id: string;
  name: string;
  group?: string;
  description?: string;
  protocol: Protocol;
  widthBytes: number | null;
  dpi: number;
  alignment: Alignment;
  rotated: boolean;
  tape: boolean;
  tapeWidths: number[] | null;
  defaultTapeWidth: number | null;
  namePatterns: string[];
  labelPresets?: string;
  builtin?: boolean;
}

export interface ResolvedConfig {
  width: number | null;
  protocol: Protocol;
  dpi: number;
  recognized: boolean;
  matchedPattern: string | null;
  definition: PrinterDefinition | null;
}

export const BUILTIN_PRINTERS = (builtinData as { printers: PrinterDefinition[] }).printers.map((p) => ({
  ...p,
  builtin: true,
}));

const DEFAULT_WIDTH_BYTES = 72;

export class PrinterRegistry {
  readonly all: PrinterDefinition[];
  private readonly patterns: { pattern: string; def: PrinterDefinition }[];

  constructor(customs: PrinterDefinition[] = []) {
    const customIds = new Set(customs.map((c) => c.id));
    const builtins = BUILTIN_PRINTERS.filter((d) => !customIds.has(d.id)).map((d) => ({ ...d }));
    this.all = [...builtins, ...customs.map((c) => ({ ...c, builtin: false }))];

    // Custom patterns first, then built-ins; longer patterns win for specificity.
    const ordered = [...this.all.filter((d) => !d.builtin), ...this.all.filter((d) => d.builtin)];
    const list: { pattern: string; def: PrinterDefinition }[] = [];
    for (const def of ordered) {
      for (const pat of def.namePatterns ?? []) list.push({ pattern: pat.toUpperCase(), def });
    }
    list.sort((a, b) => b.pattern.length - a.pattern.length);
    this.patterns = list;
  }

  get(id: string): PrinterDefinition | undefined {
    return this.all.find((d) => d.id === id);
  }

  detect(deviceName: string | null | undefined): ResolvedConfig {
    if (!deviceName) return unrecognized();
    const name = deviceName.toUpperCase();
    for (const { pattern, def } of this.patterns) {
      if (name.startsWith(pattern)) {
        return {
          width: def.widthBytes,
          protocol: def.protocol,
          dpi: def.dpi || 203,
          recognized: true,
          matchedPattern: pattern,
          definition: def,
        };
      }
    }
    return unrecognized();
  }

  private override(model: string): ResolvedConfig | null {
    if (!model || model === 'auto') return null;
    const def = this.get(model);
    if (!def) return null;
    return {
      width: def.widthBytes,
      protocol: def.protocol,
      dpi: def.dpi || 203,
      recognized: true,
      matchedPattern: null,
      definition: def,
    };
  }

  /** Manual model selection wins; otherwise auto-detect from the BLE name. */
  resolve(deviceName: string | null | undefined, model = 'auto'): ResolvedConfig {
    return this.override(model) ?? this.detect(deviceName);
  }

  /** Print width in bytes (8 px each). Mirrors the original fallbacks exactly. */
  widthBytes(deviceName: string | null | undefined, model = 'auto'): number {
    const o = this.override(model);
    if (o && o.width !== null) return o.width;
    return this.detect(deviceName).width ?? DEFAULT_WIDTH_BYTES;
  }
}

function unrecognized(): ResolvedConfig {
  return {
    width: DEFAULT_WIDTH_BYTES,
    protocol: 'm-series',
    dpi: 203,
    recognized: false,
    matchedPattern: null,
    definition: null,
  };
}

// --- Capability helpers (operate on a resolved config) ----------------------

export const isProtocol = (cfg: ResolvedConfig, p: Protocol) => cfg.protocol === p;
export const isDSeries = (cfg: ResolvedConfig) => cfg.protocol === 'd-series';
export const isTspl = (cfg: ResolvedConfig) => cfg.protocol === 'tspl';

export function isTape(cfg: ResolvedConfig): boolean {
  return cfg.definition ? !!cfg.definition.tape : cfg.protocol === 'p12';
}

/** Rotated printers print the label sideways; the raster is sent unpadded. */
export function isRotated(cfg: ResolvedConfig): boolean {
  return cfg.definition ? !!cfg.definition.rotated : cfg.protocol === 'd-series' || cfg.protocol === 'p12';
}

export function alignmentOf(cfg: ResolvedConfig): Alignment {
  return cfg.definition?.alignment || 'center';
}

/**
 * The printable width in millimetres.
 *
 * widthBytes is a count of 8-dot bytes, so its length depends on the head's DPI: 48 bytes is 48 mm
 * on a 203 DPI printer but only 32 mm on a 300 DPI one. Printing the byte count with an "mm"
 * suffix was therefore right for every 203 DPI entry by coincidence and wrong for all of them
 * otherwise — the M02 Pro read "78mm" when the paper is 53 mm.
 */
/**
 * The millimetre length of a print head, unrounded.
 *
 * One conversion for the whole app: paperWidthMm() rounds it for display, and the too-wide warning
 * compares and shows it from here, so the number compared and the number quoted can no longer drift.
 */
export function widthBytesToMm(widthBytes: number, dpi: number): number {
  return (widthBytes * 8 * 25.4) / (dpi || 203);
}

export function paperWidthMm(cfg: ResolvedConfig): number | null {
  const bytes = cfg.width;
  if (bytes === null) return null;
  return Math.round(widthBytesToMm(bytes, cfg.dpi || 203));
}

export function describe(reg: PrinterRegistry, deviceName: string, model = 'auto'): string {
  const cfg = reg.resolve(deviceName, model);
  const def = cfg.definition;
  const mm = paperWidthMm(cfg);
  if (def) return def.name + (mm !== null ? ` (${mm}mm)` : '');
  return `M-series (${mm !== null ? `${mm}mm` : '—'})`;
}
