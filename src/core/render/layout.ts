/** Label geometry. 1 mm = 8 px (203 DPI); all element coordinates are in these label pixels. */
export const PX_PER_MM = 8;

export interface Zone { x: number; y: number; width: number; height: number }

export interface LabelLayout {
  /** Whole printable canvas (all zones together). */
  width: number;
  height: number;
  round: boolean;
  /** Present on multi-label rolls only. */
  zones: Zone[] | null;
  /** Size of a single label (== width/height unless multi-label). */
  labelWidth: number;
  labelHeight: number;
}

export type Orientation = 'portrait' | 'landscape';

export interface LabelSize {
  /** Physical label dimensions, mm — always as originally chosen (a preset or a custom size).
   *  Orientation never rewrites these; it only changes how the design is laid out on them. */
  width: number; // mm
  height: number; // mm
  round?: boolean;
  continuous?: boolean;
  tapeWidth?: number;
  /** How the design is oriented on the physical label. Missing = 'portrait' (old saved designs). */
  orientation?: Orientation;
}

/** Orientation only means something for a rectangular, non-square label. */
export const orientationApplies = (size: Pick<LabelSize, 'width' | 'height' | 'round'>) =>
  !size.round && size.width !== size.height;

/**
 * The orientation actually in effect — geometric, not field-order-based:
 *  - If `orientation` is explicitly set (any design created or touched under this feature),
 *    that value is authoritative.
 *  - If it's missing (a design saved before this feature existed), it's *derived* from the
 *    physical dimensions themselves: whichever of Portrait/Landscape reproduces the label's
 *    existing width/height unchanged. This is what keeps old designs printing exactly as they
 *    always did, rather than defaulting to a literal "portrait" that might silently rotate them.
 * Portrait always means the design canvas is tall (width ≤ height); Landscape always means wide
 * (width ≥ height) — true regardless of which physical dimension the label calls "width".
 */
export function resolveOrientation(size: Pick<LabelSize, 'width' | 'height' | 'round' | 'orientation'>): Orientation {
  if (size.orientation) return size.orientation;
  // Non-finite dimensions carry no geometry. Without this, a NaN width compared as `<=` any
  // height and resolved to 'landscape', silently blessing a corrupt size into a wide canvas.
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return 'portrait';
  return size.width <= size.height ? 'portrait' : 'landscape';
}

/** True when the rendered/printed pixels need rotating relative to the label's literal width/height
 *  to reach the orientation resolved above — i.e. whenever the physical dims aren't already
 *  arranged the way that orientation requires. */
export function needsPrintRotation(size: LabelSize): boolean {
  if (!orientationApplies(size)) return false;
  const wide = size.width > size.height;
  return resolveOrientation(size) === 'landscape' ? !wide : wide;
}

export interface MultiLabelConfig {
  enabled: boolean;
  labelWidth: number; // mm
  labelHeight: number; // mm
  labelsAcross: number;
  gapMm: number;
  cloneMode: boolean;
}

/**
 * The label's PHYSICAL layout — width/height exactly as the physical label is, never swapped.
 * This is what the printer/protocol pipeline has always assumed and continues to assume;
 * orientation is handled entirely upstream of it (see buildRaster's `rotateForPrint`).
 */
/**
 * Sanitize a millimetre dimension before it becomes pixels.
 *
 * Layout feeds canvas allocation downstream. A custom label size, or a corrupt one that reached the
 * store in an older session, can carry NaN or Infinity here, and Math.round(NaN) produces a canvas
 * the browser cannot allocate. Bounded at 500 mm, which is far beyond any label this app supports.
 */
const saneMm = (v: number, fallback: number): number =>
  Number.isFinite(v) ? Math.min(500, Math.max(1, v)) : fallback;

export function singleLayout(size: LabelSize): LabelLayout {
  const w = Math.round(saneMm(size.width, 40) * PX_PER_MM);
  const h = Math.round(saneMm(size.height, 30) * PX_PER_MM);
  return { width: w, height: h, round: !!size.round, zones: null, labelWidth: w, labelHeight: h };
}

/**
 * The label's DISPLAY layout — what the editor draws and what element coordinates are relative
 * to. Portrait is always tall (width ≤ height), Landscape is always wide (width ≥ height),
 * built from the label's actual short/long physical sides — not from which literal field
 * ("width" vs "height") happens to hold the smaller number. Identical to the physical layout
 * whenever the physical dimensions already happen to be arranged that way (which is exactly the
 * case for every pre-orientation design, by construction of resolveOrientation above).
 */
export function displayLayout(size: LabelSize): LabelLayout {
  const phys = singleLayout(size);
  if (!orientationApplies(size)) return phys;
  const short = Math.min(phys.width, phys.height);
  const long = Math.max(phys.width, phys.height);
  const [w, h] = resolveOrientation(size) === 'landscape' ? [long, short] : [short, long];
  return { ...phys, width: w, height: h, labelWidth: w, labelHeight: h };
}

export function multiLayout(cfg: Pick<MultiLabelConfig, 'labelWidth' | 'labelHeight' | 'labelsAcross' | 'gapMm'>): LabelLayout {
  const lw = Math.round(cfg.labelWidth * PX_PER_MM);
  const lh = Math.round(cfg.labelHeight * PX_PER_MM);
  const gap = Math.round(cfg.gapMm * PX_PER_MM);
  // Clamp the zone count to something the browser can lay out before allocating. A custom or
  // damaged value reached this function directly (the multi-label dialog clamps, but the store
  // and the tests do not), and Array.from({ length: 1e9 }) would try to build a billion zone
  // objects — the tab dies before any error could be shown.
  const across = Math.max(1, Math.min(MAX_ZONES, Math.floor(cfg.labelsAcross) || 1));
  const zones = Array.from({ length: across }, (_, i) => ({ x: i * (lw + gap), y: 0, width: lw, height: lh }));
  return { width: lw * across + gap * (across - 1), height: lh, round: false, zones, labelWidth: lw, labelHeight: lh };
}

/** The most zones a roll may be cut into. Matches LIMITS.multi.maxAcross. */
const MAX_ZONES = 8;

export function zoneAt(layout: LabelLayout, x: number, y: number): number | null {
  if (!layout.zones) return 0;
  const i = layout.zones.findIndex((z) => x >= z.x && x < z.x + z.width && y >= z.y && y < z.y + z.height);
  return i < 0 ? null : i;
}
