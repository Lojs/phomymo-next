import { describe, it, expect } from 'vitest';
import { boundsOf, rotateComposition, type LabelElement } from '../src/core/model/elements';
import { rotatePixelsCW, rotatePixelsCCW } from '../src/core/render/orient';
import { displayLayout, needsPrintRotation, orientationApplies, resolveOrientation, singleLayout, type LabelSize } from '../src/core/render/layout';

const el = (p: Partial<LabelElement> & Pick<LabelElement, 'type'>): LabelElement => ({
  id: 'e', zone: 0, x: 0, y: 0, width: 10, height: 10, rotation: 0, ...p,
} as LabelElement);

describe('rotateComposition', () => {
  it('rotates a point-like element to the expected corner (CW)', () => {
    // 40x60 canvas; a small element near the top-left corner.
    const els = [el({ type: 'text', text: 't', x: 2, y: 3, width: 4, height: 4, fontSize: 10, color: 'black', align: 'left', verticalAlign: 'top', fontFamily: 'x', fontWeight: 'normal', fontStyle: 'normal', textDecoration: 'none', background: 'transparent', noWrap: false, clipOverflow: false, autoScale: false })];
    const out = rotateComposition(els, 40, 60, 'cw');
    // New canvas is 60x40. Centre of original element: (4,5). CW: new_cx = 60-5=55, new_cy=4.
    const cx = out[0].x + out[0].width / 2;
    const cy = out[0].y + out[0].height / 2;
    expect(cx).toBeCloseTo(55, 6);
    expect(cy).toBeCloseTo(4, 6);
    expect(out[0].rotation).toBe(90);
  });

  it('cw then ccw is the identity (round-trip)', () => {
    const els = [
      el({ type: 'shape', shapeType: 'rectangle', x: 5, y: 7, width: 12, height: 8, rotation: 33, fill: 'black', stroke: 'none', strokeWidth: 2, cornerRadius: 0 }),
      el({ type: 'shape', shapeType: 'line', x: 20, y: 40, width: 30, height: 4, rotation: 0, fill: 'none', stroke: 'black', strokeWidth: 2, cornerRadius: 0 }),
    ];
    const w = 40, h = 60;
    const rotated = rotateComposition(els, w, h, 'cw');
    const back = rotateComposition(rotated, h, w, 'ccw');
    for (let i = 0; i < els.length; i++) {
      expect(back[i].x).toBeCloseTo(els[i].x, 6);
      expect(back[i].y).toBeCloseTo(els[i].y, 6);
      expect(back[i].rotation).toBe(els[i].rotation);
      expect(back[i].width).toBe(els[i].width);
      expect(back[i].height).toBe(els[i].height);
    }
  });

  it('preserves an element with its own existing rotation', () => {
    const els = [el({ type: 'shape', shapeType: 'rectangle', x: 0, y: 0, width: 10, height: 10, rotation: 15, fill: 'black', stroke: 'none', strokeWidth: 2, cornerRadius: 0 })];
    const out = rotateComposition(els, 40, 60, 'cw');
    expect(out[0].rotation).toBe(105); // 15 + 90
  });

  it('keeps all elements within bounds for a full composition rotation', () => {
    const w = 40, h = 60;
    const els = [
      el({ type: 'text', text: 'top', x: 2, y: 2, width: 30, height: 10, fontSize: 10, color: 'black', align: 'left', verticalAlign: 'top', fontFamily: 'x', fontWeight: 'normal', fontStyle: 'normal', textDecoration: 'none', background: 'transparent', noWrap: false, clipOverflow: false, autoScale: false }),
      el({ type: 'text', text: 'bottom', x: 2, y: h - 12, width: 30, height: 10, fontSize: 10, color: 'black', align: 'left', verticalAlign: 'top', fontFamily: 'x', fontWeight: 'normal', fontStyle: 'normal', textDecoration: 'none', background: 'transparent', noWrap: false, clipOverflow: false, autoScale: false }),
    ];
    // New canvas after a CW rotation is h × w (dimensions transpose). Check each element's
    // *rendered* footprint (boundsOf accounts for the element's own rotation), not its raw
    // unrotated x/y/width/height — those intentionally no longer equal the visual box once
    // rotation is 90°.
    const out = rotateComposition(els, w, h, 'cw');
    for (const o of out) {
      const b = boundsOf(o);
      expect(b.x).toBeGreaterThanOrEqual(-0.001);
      expect(b.y).toBeGreaterThanOrEqual(-0.001);
      expect(b.x + b.width).toBeLessThanOrEqual(h + 0.001);
      expect(b.y + b.height).toBeLessThanOrEqual(w + 0.001);
    }
  });
});

describe('rotatePixelsCW / rotatePixelsCCW', () => {
  it('swaps dimensions and is an exact round trip', () => {
    const w = 5, h = 3;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { px[i * 4] = i; px[i * 4 + 3] = 255; }
    const cw = rotatePixelsCW(px, w, h);
    expect(cw.width).toBe(h);
    expect(cw.height).toBe(w);
    const back = rotatePixelsCCW(cw.pixels, cw.width, cw.height);
    expect(back.width).toBe(w);
    expect(back.height).toBe(h);
    expect(Buffer.from(back.pixels).equals(Buffer.from(px))).toBe(true);
  });

  it('moves the top-left pixel to the top-right on a CW rotation', () => {
    const w = 4, h = 2;
    const px = new Uint8ClampedArray(w * h * 4);
    px[0] = 255; px[3] = 255; // pixel (0,0) marked
    const out = rotatePixelsCW(px, w, h);
    // new dims: w'=h=2, h'=w=4. Marked pixel should land at top-right corner: (x=1,y=0).
    const idx = (1 + 0 * out.width) * 4;
    expect(out.pixels[idx]).toBe(255);
  });
});

describe('layout orientation helpers', () => {
  // "Naturally tall" — literal width < height, e.g. a custom 30x100mm label.
  const tall: LabelSize = { width: 30, height: 100 };
  // "Naturally wide" — literal width > height, e.g. this app's own 40x30 tape presets.
  const wide: LabelSize = { width: 40, height: 30 };
  const square: LabelSize = { width: 40, height: 40 };
  const round: LabelSize = { width: 30, height: 30, round: true };

  it('orientationApplies only for non-square, non-round labels', () => {
    expect(orientationApplies(tall)).toBe(true);
    expect(orientationApplies(square)).toBe(false);
    expect(orientationApplies(round)).toBe(false);
  });

  it('Portrait is always tall and Landscape always wide, regardless of which literal field is bigger', () => {
    for (const size of [tall, wide]) {
      const portrait = displayLayout({ ...size, orientation: 'portrait' });
      const landscape = displayLayout({ ...size, orientation: 'landscape' });
      expect(portrait.width).toBeLessThanOrEqual(portrait.height);
      expect(landscape.width).toBeGreaterThanOrEqual(landscape.height);
      // Same physical pixels either way, just arranged onto width vs height.
      expect([portrait.width, portrait.height].sort()).toEqual([landscape.width, landscape.height].sort());
    }
  });

  it('never rewrites the physical (singleLayout) dimensions', () => {
    const phys = singleLayout(wide);
    expect(displayLayout({ ...wide, orientation: 'portrait' })).not.toEqual(phys); // display differs...
    expect(singleLayout(wide)).toEqual(phys); // ...but physical layout is untouched either way
  });

  it('backward compatibility: a legacy design with no orientation field renders exactly as it always did', () => {
    // A pre-feature design just used singleLayout(size) directly for both editing and printing.
    // displayLayout with orientation omitted must reproduce that pixel-for-pixel, whichever way
    // the label's literal width/height happen to be arranged.
    expect(displayLayout(tall)).toEqual(singleLayout(tall));
    expect(displayLayout(wide)).toEqual(singleLayout(wide));
  });

  it('resolveOrientation infers the orientation that reproduces the legacy layout', () => {
    expect(resolveOrientation(tall)).toBe('portrait'); // 30x100: already tall
    expect(resolveOrientation(wide)).toBe('landscape'); // 40x30: already wide
    expect(resolveOrientation({ ...tall, orientation: 'landscape' })).toBe('landscape'); // explicit wins
  });

  it('needsPrintRotation is true exactly when the literal dimensions need rotating to reach the resolved orientation', () => {
    expect(needsPrintRotation({ ...tall, orientation: 'portrait' })).toBe(false); // already tall
    expect(needsPrintRotation({ ...tall, orientation: 'landscape' })).toBe(true); // tall label, want wide
    expect(needsPrintRotation({ ...wide, orientation: 'landscape' })).toBe(false); // already wide
    expect(needsPrintRotation({ ...wide, orientation: 'portrait' })).toBe(true); // wide label, want tall
    expect(needsPrintRotation(tall)).toBe(false); // no explicit orientation -> inferred -> matches literal -> no rotation
    expect(needsPrintRotation(wide)).toBe(false); // same, for the "already wide" case
    expect(needsPrintRotation(square)).toBe(false);
    expect(needsPrintRotation(round)).toBe(false);
  });
});
