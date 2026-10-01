/** Pure editor geometry: resize, rotate and snap. Coordinates are label pixels. */
import { rotatePoint, type Bounds, type Point } from '../../core/model/elements';

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export interface Box { x: number; y: number; width: number; height: number; rotation: number }

const isCorner = (h: HandleId) => h.length === 2;

/** Position of a handle on a (possibly rotated) box, in label pixels. */
export function handlePoint(box: Box, h: HandleId): Point {
  const fx = h.includes('w') ? 0 : h.includes('e') ? 1 : 0.5;
  const fy = h.includes('n') ? 0 : h.includes('s') ? 1 : 0.5;
  const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  return rotatePoint({ x: box.x + box.width * fx, y: box.y + box.height * fy }, c, box.rotation || 0);
}

export function resizeBox(
  box: Box, handle: HandleId, pointer: Point,
  opts: { keepAspect?: boolean; minWidth?: number; minHeight?: number } = {},
): Box {
  const { keepAspect = false, minWidth = 10, minHeight = 10 } = opts;
  const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const q = rotatePoint(pointer, c, -(box.rotation || 0)); // pointer in the box's own (unrotated) frame

  let x0 = box.x, x1 = box.x + box.width, y0 = box.y, y1 = box.y + box.height;
  if (handle.includes('w')) x0 = Math.min(q.x, x1 - minWidth);
  if (handle.includes('e')) x1 = Math.max(q.x, x0 + minWidth);
  if (handle.includes('n')) y0 = Math.min(q.y, y1 - minHeight);
  if (handle.includes('s')) y1 = Math.max(q.y, y0 + minHeight);

  let w = x1 - x0;
  let h = y1 - y0;
  if (keepAspect && isCorner(handle) && box.width > 0 && box.height > 0) {
    const s = Math.max(w / box.width, h / box.height, Math.max(minWidth / box.width, minHeight / box.height));
    w = box.width * s;
    h = box.height * s;
    if (handle.includes('w')) x0 = x1 - w; else x1 = x0 + w;
    if (handle.includes('n')) y0 = y1 - h; else y1 = y0 + h;
  }

  // The opposite edge/corner must not move in the world: recentre through the old rotation.
  const centre = rotatePoint({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, c, box.rotation || 0);
  return { x: centre.x - w / 2, y: centre.y - h / 2, width: w, height: h, rotation: box.rotation };
}

/** Angle (degrees, 0–360) of the rotation handle for a pointer position around `center`. */
export function rotationFromPointer(center: Point, pointer: Point, snap: boolean): number {
  let deg = (Math.atan2(pointer.y - center.y, pointer.x - center.x) * 180) / Math.PI + 90;
  deg = ((deg % 360) + 360) % 360;
  const nearest = Math.round(deg / 15) * 15;
  if (snap || Math.abs(deg - nearest) < 3) deg = nearest;
  return ((deg % 360) + 360) % 360;
}

/** Resize an axis-aligned group box by a handle; returns scale factors and the fixed anchor. */
export function groupResize(b: Bounds, handle: HandleId, pointer: Point, keepAspect: boolean) {
  const next = resizeBox({ x: b.x, y: b.y, width: b.width, height: b.height, rotation: 0 }, handle, pointer, { keepAspect, minWidth: 10, minHeight: 10 });
  const anchor = {
    x: handle.includes('w') ? b.x + b.width : handle.includes('e') ? b.x : b.x + b.width / 2,
    y: handle.includes('n') ? b.y + b.height : handle.includes('s') ? b.y : b.y + b.height / 2,
  };
  return { sx: b.width ? next.width / b.width : 1, sy: b.height ? next.height / b.height : 1, anchor };
}

// ---- snapping -----------------------------------------------------------------------

export interface Guide { axis: 'x' | 'y'; pos: number }

/** Snap a moving box to label edges/centre and to other elements' edges/centres. */
export function snapBox(
  moving: Bounds, targets: Bounds[], label: { width: number; height: number }, threshold: number,
): { dx: number; dy: number; guides: Guide[] } {
  const xs = [0, label.width / 2, label.width];
  const ys = [0, label.height / 2, label.height];
  for (const t of targets) {
    xs.push(t.x, t.x + t.width / 2, t.x + t.width);
    ys.push(t.y, t.y + t.height / 2, t.y + t.height);
  }
  const mx = [moving.x, moving.x + moving.width / 2, moving.x + moving.width];
  const my = [moving.y, moving.y + moving.height / 2, moving.y + moving.height];

  const best = (mine: number[], lines: number[]) => {
    let d = 0, pos: number | null = null, dist = threshold + 1e-9;
    for (const m of mine) for (const l of lines) {
      const delta = l - m;
      if (Math.abs(delta) < dist) { dist = Math.abs(delta); d = delta; pos = l; }
    }
    return { d, pos };
  };
  const bx = best(mx, xs);
  const by = best(my, ys);
  const guides: Guide[] = [];
  if (bx.pos !== null) guides.push({ axis: 'x', pos: bx.pos });
  if (by.pos !== null) guides.push({ axis: 'y', pos: by.pos });
  return { dx: bx.pos !== null ? bx.d : 0, dy: by.pos !== null ? by.d : 0, guides };
}
