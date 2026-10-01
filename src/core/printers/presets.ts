/** Label size presets per printer family (same catalogue as the original app). */
import type { LabelSize } from '../render/layout';
import { isDSeries, isTape, isTspl, type ResolvedConfig } from './definitions';

type Table = Record<string, LabelSize>;

const rect = (w: number, h: number, extra: Partial<LabelSize> = {}): LabelSize => ({ width: w, height: h, ...extra });
const fromKeys = (keys: string[], extra: Partial<LabelSize> = {}): Table =>
  Object.fromEntries(keys.map((k) => { const [w, h] = k.split('x').map(Number); return [k, rect(w, h, extra)]; }));

export const M_SERIES: Table = fromKeys(['12x40', '15x30', '20x30', '25x50', '30x20', '30x40', '40x30', '40x60', '50x25', '50x30', '50x80', '60x40']);
export const M_ROUND: Table = Object.fromEntries([20, 30, 40, 50].map((d) => [`${d}mm Round`, rect(d, d, { round: true })]));
export const D_SERIES: Table = fromKeys(['40x12', '30x12', '22x12', '12x12', '30x14', '22x14', '40x15', '30x15']);
export const D_CONTINUOUS: Table = Object.fromEntries(
  ['40x12', '30x12', '22x12', '40x15', '30x15'].map((k) => { const [w, h] = k.split('x').map(Number); return [`${k} cont`, rect(w, h, { continuous: true })]; }),
);
export const D_ROUND: Table = { '14mm Round': rect(14, 14, { round: true }) };
export const PM241: Table = fromKeys(['102x152', '102x102', '102x76', '102x51', '100x150', '100x100']);

export const TAPE_WIDTHS = [12, 14, 15] as const;
export const tapeSizes = (tapeWidth: number): Table =>
  Object.fromEntries(
    [40, 30, 22, tapeWidth].map((len) => [`${len}x${tapeWidth}`, rect(len, tapeWidth, { tapeWidth })]),
  );

export interface PresetGroups {
  rect: Table;
  round: Table;
  continuous: Table;
  defaultKey: string;
}

/** Which presets a printer offers, and which one to start on. */
export function presetsFor(cfg: ResolvedConfig, tapeWidth = 12): PresetGroups {
  if (isTape(cfg)) return { rect: tapeSizes(tapeWidth), round: {}, continuous: {}, defaultKey: `40x${tapeWidth}` };
  if (isDSeries(cfg)) return { rect: D_SERIES, round: D_ROUND, continuous: D_CONTINUOUS, defaultKey: '40x12' };
  if (isTspl(cfg)) return { rect: PM241, round: {}, continuous: {}, defaultKey: '102x152' };
  return { rect: M_SERIES, round: M_ROUND, continuous: {}, defaultKey: '40x30' };
}

export const sizeKey = (s: LabelSize) => (s.round ? `${s.width}mm Round` : `${s.width}x${s.height}`);

export const LIMITS = {
  label: { minW: 10, maxW: 100, minH: 10, maxH: 200 },
  multi: { minAcross: 1, maxAcross: 8, minGap: 0, maxGap: 10 },
  copies: { min: 1, max: 99 },
  zoom: { min: 0.25, max: 3, step: 0.25 },
  font: { min: 6, max: 200 },
};

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const ALL_KNOWN: Table = {
  ...M_SERIES, ...M_ROUND, ...D_SERIES, ...D_CONTINUOUS, ...D_ROUND, ...PM241,
  ...tapeSizes(12), ...tapeSizes(14), ...tapeSizes(15),
};
/** True when the size is one of the catalogue presets (of any printer), false for user-defined sizes. */
export const isKnownPreset = (key: string) => key in ALL_KNOWN;

export const presetKey = (s: LabelSize) => (s.continuous ? `${s.width}x${s.height} cont` : sizeKey(s));
