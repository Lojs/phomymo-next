/**
 * Label element model. Field names match the original Phomymo design format,
 * so designs saved by the old app import unchanged.
 */
export type ElementType = 'text' | 'image' | 'barcode' | 'qr' | 'shape';
/**
 * How an image is turned into dots.
 *
 * 'auto' is a real, selectable value, not just the absence of one: it means "decide from this
 * image", and the decision is made per image at render time — error diffusion for a photograph,
 * a plain threshold for flat art. Keeping it in the type is what lets the picker say so instead of
 * naming a mode that may not be the one used.
 */
export type DitherChoice = 'auto' | 'none' | 'ordered' | 'atkinson' | 'floyd-steinberg';
export type BarcodeFormat = 'CODE128' | 'EAN13' | 'CODE39' | 'UPC';
export type ShapeType =
  | 'rectangle' | 'ellipse' | 'triangle' | 'line'
  | 'diamond' | 'star' | 'heart' | 'pentagon' | 'hexagon'
  | 'arrowRight' | 'arrowLeft' | 'plus' | 'check';

interface Base {
  id: string;
  type: ElementType;
  /** Zone index on multi-label rolls (0 for single labels). */
  zone: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  groupId?: string | null;
}

export interface TextElement extends Base {
  type: 'text';
  text: string;
  fontSize: number;
  color: string;
  align: 'left' | 'center' | 'right';
  verticalAlign: 'top' | 'middle' | 'bottom';
  fontFamily: string;
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  textDecoration: 'none' | 'underline';
  background: string;
  noWrap: boolean;
  clipOverflow: boolean;
  autoScale: boolean;
}

export interface ImageElement extends Base {
  type: 'image';
  imageData: string;
  naturalWidth: number;
  naturalHeight: number;
  lockAspectRatio: boolean;
  dither?: DitherChoice;
  brightness?: number;
  contrast?: number;
}

export interface BarcodeElement extends Base {
  type: 'barcode';
  barcodeData: string;
  barcodeFormat: BarcodeFormat;
  showText?: boolean;
  textFontSize?: number;
  textBold?: boolean;
}

export interface QRElement extends Base {
  type: 'qr';
  qrData: string;
}

export interface ShapeElement extends Base {
  type: 'shape';
  shapeType: ShapeType;
  fill: string;
  stroke: string;
  strokeWidth: number;
  cornerRadius: number;
}

export type LabelElement = TextElement | ImageElement | BarcodeElement | QRElement | ShapeElement;

export const newId = () => 'el_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 11);
const newGroupId = () => 'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 11);

type Opts<T> = Partial<Omit<T, 'id' | 'type'>>;

const geo = (o: Partial<Base>, w: number, h: number) => ({
  zone: o.zone ?? 0,
  x: o.x ?? 50,
  y: o.y ?? 50,
  width: o.width ?? w,
  height: o.height ?? h,
  rotation: o.rotation ?? 0,
});

export function createText(text = 'Text', o: Opts<TextElement> = {}): TextElement {
  return {
    id: newId(),
    type: 'text',
    ...geo(o, 150, 40),
    text,
    fontSize: o.fontSize ?? 24,
    color: o.color ?? 'black',
    align: o.align ?? 'left',
    verticalAlign: o.verticalAlign ?? 'middle',
    fontFamily: o.fontFamily ?? 'Inter, sans-serif',
    fontWeight: o.fontWeight ?? 'normal',
    fontStyle: o.fontStyle ?? 'normal',
    textDecoration: o.textDecoration ?? 'none',
    background: o.background ?? 'transparent',
    noWrap: o.noWrap ?? false,
    clipOverflow: o.clipOverflow ?? false,
    autoScale: o.autoScale ?? false,
  };
}

export function createImage(imageData: string, o: Opts<ImageElement> = {}): ImageElement {
  return {
    id: newId(),
    type: 'image',
    ...geo(o, 100, 100),
    imageData,
    naturalWidth: o.naturalWidth ?? 100,
    naturalHeight: o.naturalHeight ?? 100,
    lockAspectRatio: o.lockAspectRatio ?? true,
    ...(o.dither ? { dither: o.dither } : {}),
  };
}

export function createBarcode(data = '123456789012', o: Opts<BarcodeElement> = {}): BarcodeElement {
  return { id: newId(), type: 'barcode', ...geo(o, 180, 80), barcodeData: data, barcodeFormat: o.barcodeFormat ?? 'CODE128' };
}

export function createQR(data = 'https://example.com', o: Opts<QRElement> = {}): QRElement {
  return { id: newId(), type: 'qr', ...geo(o, 100, 100), qrData: data };
}

export function createShape(shapeType: ShapeType = 'rectangle', o: Opts<ShapeElement> = {}): ShapeElement {
  return {
    id: newId(),
    type: 'shape',
    ...geo(o, 80, 60),
    shapeType,
    fill: o.fill ?? 'black',
    stroke: o.stroke ?? 'none',
    strokeWidth: o.strokeWidth ?? 2,
    cornerRadius: o.cornerRadius ?? 0,
  };
}

// ---- geometry -----------------------------------------------------------------

export interface Bounds { x: number; y: number; width: number; height: number; cx: number; cy: number }
export interface Point { x: number; y: number }

export const MIN_SIZES: Record<ElementType, { width: number; height: number }> = {
  text: { width: 50, height: 20 },
  image: { width: 30, height: 30 },
  barcode: { width: 80, height: 40 },
  qr: { width: 50, height: 50 },
  shape: { width: 10, height: 10 },
};

export function rotatePoint(p: Point, c: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

export function corners(el: Pick<LabelElement, 'x' | 'y' | 'width' | 'height' | 'rotation'>): Point[] {
  const c = { x: el.x + el.width / 2, y: el.y + el.height / 2 };
  return [
    { x: el.x, y: el.y },
    { x: el.x + el.width, y: el.y },
    { x: el.x + el.width, y: el.y + el.height },
    { x: el.x, y: el.y + el.height },
  ].map((p) => rotatePoint(p, c, el.rotation || 0));
}

/** Axis-aligned bounds of a (possibly rotated) element. */
export function boundsOf(el: LabelElement): Bounds {
  const pts = corners(el);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
    cx: el.x + el.width / 2,
    cy: el.y + el.height / 2,
  };
}

export function boundsOfMany(els: LabelElement[]): Bounds | null {
  if (!els.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const el of els) {
    const b = boundsOf(el);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);
    y1 = Math.max(y1, b.y + b.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

export function hitTest(px: number, py: number, el: LabelElement): boolean {
  // Take the absolute size. A negative width (which a corrupt import could carry, and which the
  // hit box then reported as empty — the element became unclickable, so it could be neither
  // selected nor deleted, with no way out but reloading) or a NaN coordinate makes every
  // comparison false and the element unselectable for the same reason. Using the magnitude keeps
  // such an element selectable so the user can still act on it.
  const w = Math.abs(el.width) || 1;
  const h = Math.abs(el.height) || 1;
  const x0 = Math.min(el.x, el.x + el.width);
  const y0 = Math.min(el.y, el.y + el.height);
  const c = { x: x0 + w / 2, y: y0 + h / 2 };
  const l = rotatePoint({ x: px, y: py }, c, -(el.rotation || 0));
  if (!Number.isFinite(l.x) || !Number.isFinite(l.y)) return false;
  return l.x >= x0 && l.x <= x0 + w && l.y >= y0 && l.y <= y0 + h;
}

export function topElementAt(px: number, py: number, els: LabelElement[]): LabelElement | null {
  for (let i = els.length - 1; i >= 0; i--) if (hitTest(px, py, els[i])) return els[i];
  return null;
}

// ---- group transforms (used when several elements are selected) ---------------

export function moveElements(els: LabelElement[], ids: string[], dx: number, dy: number): LabelElement[] {
  return els.map((el) => (ids.includes(el.id) ? { ...el, x: el.x + dx, y: el.y + dy } : el));
}

export function scaleElements(els: LabelElement[], ids: string[], sx: number, sy: number, center: Point): LabelElement[] {
  return els.map((el) => {
    if (!ids.includes(el.id)) return el;
    const cx = center.x + (el.x + el.width / 2 - center.x) * sx;
    const cy = center.y + (el.y + el.height / 2 - center.y) * sy;
    const w = Math.max(el.width * sx, 10);
    const h = Math.max(el.height * sy, 10);
    return { ...el, x: cx - w / 2, y: cy - h / 2, width: w, height: h };
  });
}

export function rotateElements(els: LabelElement[], ids: string[], delta: number, center: Point): LabelElement[] {
  return els.map((el) => {
    if (!ids.includes(el.id)) return el;
    const c = rotatePoint({ x: el.x + el.width / 2, y: el.y + el.height / 2 }, center, delta);
    return { ...el, x: c.x - el.width / 2, y: c.y - el.height / 2, rotation: (((el.rotation || 0) + delta) % 360 + 360) % 360 };
  });
}

export function groupElements(els: LabelElement[], ids: string[]): { elements: LabelElement[]; groupId: string | null } {
  if (ids.length < 2) return { elements: els, groupId: null };
  const groupId = newGroupId();
  return { elements: els.map((el) => (ids.includes(el.id) ? { ...el, groupId } : el)), groupId };
}

export const ungroupElements = (els: LabelElement[], groupId: string): LabelElement[] =>
  els.map((el) => (el.groupId === groupId ? { ...el, groupId: null } : el));

/** Expand a selection so that picking one member of a group picks the whole group. */
export function expandToGroups(els: LabelElement[], ids: string[]): string[] {
  const groups = new Set(els.filter((e) => ids.includes(e.id) && e.groupId).map((e) => e.groupId));
  if (!groups.size) return ids;
  return els.filter((e) => ids.includes(e.id) || (e.groupId && groups.has(e.groupId))).map((e) => e.id);
}

// ---- z-order --------------------------------------------------------------------

export function reorder(els: LabelElement[], id: string, how: 'front' | 'back' | 'up' | 'down'): LabelElement[] {
  const i = els.findIndex((e) => e.id === id);
  if (i < 0) return els;
  const out = [...els];
  const [el] = out.splice(i, 1);
  const j = how === 'front' ? out.length : how === 'back' ? 0 : how === 'up' ? Math.min(i + 1, out.length) : Math.max(i - 1, 0);
  out.splice(j, 0, el);
  return out;
}

// ---- multi-label zones ------------------------------------------------------------

export const inZone = (els: LabelElement[], zone: number) => els.filter((e) => (e.zone ?? 0) === zone);

export function cloneToZone(els: LabelElement[], from: number, to: number): LabelElement[] {
  if (from === to) return els;
  const src = inZone(els, from);
  if (!src.length) return els;
  const kept = els.filter((e) => (e.zone ?? 0) !== to);
  return [...kept, ...src.map((e) => ({ ...e, id: newId(), zone: to }))];
}

export function cloneToAllZones(els: LabelElement[], from: number, zones: number): LabelElement[] {
  let out = els;
  for (let z = 0; z < zones; z++) if (z !== from) out = cloneToZone(out, from, z);
  return out;
}

export const collapseToSingleZone = (els: LabelElement[]): LabelElement[] => els.map((e) => ({ ...e, zone: 0 }));

// ---- whole-design rotation (switching Portrait ↔ Landscape) ---------------------

/**
 * Rotate an entire design 90° as one rigid composition — used when the user switches the
 * label's orientation. Every element keeps its size; only its centre point and its own
 * `rotation` move, by the same 90° that the canvas itself is turning through. `curW`/`curH`
 * are the *current* canvas dimensions (before this rotation). 'cw' and 'ccw' are exact inverses
 * of each other, so switching orientation and switching back is lossless.
 */
export function rotateComposition(els: LabelElement[], curW: number, curH: number, dir: 'cw' | 'ccw'): LabelElement[] {
  return els.map((el) => {
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const [ncx, ncy] = dir === 'cw' ? [curH - cy, cx] : [cy, curW - cx];
    const rotation = (((el.rotation || 0) + (dir === 'cw' ? 90 : -90)) % 360 + 360) % 360;
    return { ...el, x: ncx - el.width / 2, y: ncy - el.height / 2, rotation };
  });
}
export const removeAboveZone = (els: LabelElement[], maxZone: number): LabelElement[] => els.filter((e) => (e.zone ?? 0) <= maxZone);
