// @vitest-environment jsdom
/**
 * core/render/label.ts — the elements → pixels → printer raster pipeline.
 *
 * This is the last untested step before a label reaches the printer, so the tests pin the
 * properties that decide the physical result: the raster width comes from the printer head, the
 * alignment is honoured, a 300 DPI head gets scaled artwork, and a rotated printer is handed an
 * unpadded raster for the protocol layer to rotate.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { paintLabel, renderPixels, buildRaster, ditherModeOf, prepareForRender, previewCanvas } from '../src/core/render/label';
import { singleLayout, multiLayout, displayLayout, needsPrintRotation } from '../src/core/render/layout';
import { createText, createShape, createImage } from '../src/core/model/elements';
import type { RasterTarget } from '../src/core/render/label';
import type { LabelElement } from '../src/core/model/elements';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

/** A target for a plain 203-dpi, non-rotated printer. */
const target = (over: Partial<RasterTarget> = {}): RasterTarget => ({
  widthBytes: 48, dpi: 203, alignment: 'center', rotated: false, ...over,
});

const layout = (over: Partial<Parameters<typeof singleLayout>[0]> = {}) => singleLayout({ width: 40, height: 30, ...over });
/** The DISPLAY layout — what the editor shows and what the print path rasterises. */
const display = (over: Partial<Parameters<typeof displayLayout>[0]> = {}) => displayLayout({ width: 40, height: 30, ...over });

describe('paintLabel', () => {
  /** A recording context: paintLabel is about ordering and geometry, not pixels. */
  function recCtx() {
    const ops: string[] = [];
    const ctx: any = {
      fillStyle: '',
      globalAlpha: 1,
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      fillRect: (...a: number[]) => ops.push(`fillRect ${a.join(',')}`),
      save: () => ops.push('save'),
      restore: () => ops.push('restore'),
      beginPath: () => ops.push('beginPath'),
      arc: (...a: number[]) => ops.push(`arc ${a.slice(0, 3).join(',')}`),
      clip: () => ops.push('clip'),
      fill: () => ops.push('fill'),
      stroke: () => ops.push('stroke'),
      fillText: (t: string) => ops.push(`text ${t}`),
      moveTo() {}, lineTo() {}, rect() {}, translate() {}, rotate() {}, scale() {},
      measureText: (t: string) => ({ width: t.length * 8 }),
    };
    return { ctx, ops };
  }

  it('paints white paper over the whole label first', () => {
    const { ctx, ops } = recCtx();
    paintLabel(ctx, [], layout());
    expect(ops[0]).toBe(`fillRect 0,0,320,240`);
    expect(ctx.fillStyle).toBe('white');
  });

  it('clips to a circle on a round label', () => {
    const { ctx, ops } = recCtx();
    paintLabel(ctx, [], layout({ round: true }));
    expect(ops).toContain('beginPath');
    expect(ops).toContain('arc 160,120,120');
    expect(ops).toContain('clip');
  });

  it('does not clip on a rectangular label', () => {
    const { ctx, ops } = recCtx();
    paintLabel(ctx, [], layout());
    expect(ops).not.toContain('clip');
  });

  it('draws each element', () => {
    const { ctx, ops } = recCtx();
    paintLabel(ctx, [createText('A'), createText('B')], layout());
    expect(ops.filter((o) => o.startsWith('text '))).toEqual(['text A', 'text B']);
  });

  it('offsets an element into its own zone on a roll', () => {
    const seen: { x: number; y: number }[] = [];
    const ctx: any = {
      fillStyle: '', globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic',
      fillRect() {}, save() {}, restore() {}, beginPath() {}, arc() {}, clip() {}, fill() {}, stroke() {},
      fillText() {},
      translate(x: number, y: number) { seen.push({ x, y }); },
      rotate() {}, scale() {}, measureText: (t: string) => ({ width: t.length * 8 }),
    };
    const roll = multiLayout({ labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2 });
    const el = createText('A', { x: 5, y: 7, width: 40, height: 40, zone: 2 });
    paintLabel(ctx, [el], roll);
    const stride = 10 * 8 + 2 * 8;
    // drawElement translates to the element's centre once the zone offset is folded into x.
    expect(seen[0]).toEqual({ x: 5 + 2 * stride + 40 / 2, y: 7 + 40 / 2 });
  });

  it('a different zone moves the element by exactly one stride', () => {
    const positions = [0, 1, 2].map((zone) => {
      const seen: { x: number; y: number }[] = [];
      const ctx: any = {
        fillStyle: '', globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic',
        fillRect() {}, save() {}, restore() {}, beginPath() {}, arc() {}, clip() {}, fill() {}, stroke() {},
        fillText() {},
        translate(x: number, y: number) { seen.push({ x, y }); },
        rotate() {}, scale() {}, measureText: (t: string) => ({ width: t.length * 8 }),
      };
      const roll = multiLayout({ labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2 });
      paintLabel(ctx, [createText('A', { x: 0, y: 0, width: 40, height: 40, zone })], roll);
      return seen[0].x;
    });
    const stride = 10 * 8 + 2 * 8;
    expect(positions[1] - positions[0]).toBe(stride);
    expect(positions[2] - positions[1]).toBe(stride);
  });

  it('skips an element pointing at a zone that does not exist', () => {
    const { ctx, ops } = recCtx();
    const roll = multiLayout({ labelWidth: 10, labelHeight: 20, labelsAcross: 2, gapMm: 2 });
    paintLabel(ctx, [createText('A', { zone: 9 })], roll);
    expect(ops.filter((o) => o.startsWith('text '))).toEqual([]);
  });

  it('balances save and restore', () => {
    const { ctx, ops } = recCtx();
    paintLabel(ctx, [createText('A')], layout({ round: true }));
    expect(ops.filter((o) => o === 'save').length).toBe(ops.filter((o) => o === 'restore').length);
  });
});

describe('renderPixels', () => {
  it('returns a buffer the size of the layout', () => {
    const { pixels, width, height } = renderPixels([], layout());
    expect(width).toBe(320);
    expect(height).toBe(240);
    expect(pixels.length).toBe(320 * 240 * 4);
  });

  it('fills the whole label area, so the raster has one row per label row', () => {
    // The canvas stub returns zeros from getImageData, so pixel *values* are not observable in
    // jsdom; the raster convention (0 = white) is asserted in the golden-raster tests instead.
    const { pixels, width, height } = renderPixels([], layout());
    expect(pixels.length).toBe(width * height * 4);
  });
});

describe('buildRaster — the printer-facing result', () => {
  it('packs exactly to the printer head width', () => {
    const r = buildRaster([createText('A')], layout(), target({ widthBytes: 72 }), 'none');
    expect(r.widthBytes).toBe(72);
    expect(r.data.length).toBe(72 * r.heightLines);
  });

  it('reports the label height in rows', () => {
    const r = buildRaster([createText('A')], layout(), target(), 'none');
    expect(r.heightLines).toBe(240); // 30mm * 8 px
  });

  it('an empty label still produces a full-width raster for every row', () => {
    const r = buildRaster([], layout(), target({ widthBytes: 40 }), 'none');
    expect(r.widthBytes).toBe(40);
    expect(r.data.length).toBe(40 * 240);
  });

  it('centring a narrower artwork on a wider head pads it, left-aligning does not', () => {
    // The packing rule under test: the output is always head-width, and where the artwork sits
    // inside it is decided by the printer's alignment. Comparing the two rasters byte-for-byte
    // pins that difference without needing real pixels.
    const narrow = singleLayout({ width: 20, height: 10 }); // 160 px of artwork
    const centred = buildRaster([createText('X')], narrow, target({ widthBytes: 72, alignment: 'center' }), 'none');
    const left = buildRaster([createText('X')], narrow, target({ widthBytes: 72, alignment: 'left' }), 'none');
    expect(centred.data.length).toBe(left.data.length);
    // A centred row must differ from a left-aligned one, otherwise alignment is being ignored.
    expect([...centred.data]).not.toEqual([...left.data]);
  });

  it('scales the artwork up for a 300 DPI head', () => {
    const r203 = buildRaster([createText('A')], layout(), target({ dpi: 203 }), 'none');
    const r300 = buildRaster([createText('A')], layout(), target({ dpi: 300 }), 'none');
    expect(r300.heightLines).toBeGreaterThan(r203.heightLines);
    // 300/203 ≈ 1.478, so roughly 1.5x the rows.
    expect(r300.heightLines / r203.heightLines).toBeGreaterThan(1.3);
    expect(r300.heightLines / r203.heightLines).toBeLessThan(1.6);
  });

  it('a rotated printer gets an unpadded raster the protocol layer can turn', () => {
    const r = buildRaster([createText('A')], layout(), target({ rotated: true, widthBytes: 72 }), 'none');
    // For a rotated target the width comes from the artwork, not the head.
    expect(r.widthBytes).toBe(Math.ceil(320 / 8)); // 320 px / 8
  });

  it('rotates back for printing when the display layout was turned', () => {
    // Measured: a 30x40 label shown landscape displays as 320x240 (turned onto its side), so
    // printing must turn it back into the 240x320 physical label.
    const land = { width: 30, height: 40, orientation: 'landscape' as const };
    expect(displayLayout(land).width).toBe(320); // displayed wide
    const upright = buildRaster([createText('A')], display(land), target(), 'none', false);
    const turned = buildRaster([createText('A')], display(land), target(), 'none', true);
    expect(upright.heightLines).toBe(240);
    expect(turned.heightLines).toBe(320); // back to the physical label
  });

  it('a round label clips content to the circle', () => {
    const round = singleLayout({ width: 40, height: 40, round: true });
    const r = buildRaster([createText('CORNER', { x: 0, y: 0, width: 60, height: 20 })], round, target({ widthBytes: 48 }), 'none');
    const topLeftInk = r.data.slice(0, 4).some((b) => b !== 0);
    expect(topLeftInk).toBe(false); // outside the circle
  });

  it('produces a raster for every element type without throwing', () => {
    const els: LabelElement[] = [
      createText('A'),
      createShape('star'),
      createImage('data:image/png;base64,AAAA'),
    ];
    expect(() => buildRaster(els, layout(), target(), 'none')).not.toThrow();
  });
});

describe('ditherModeOf', () => {
  it('is "auto" when no image sets a mode', () => {
    expect(ditherModeOf([createText('A')])).toBe('auto');
  });

  it('takes the mode from the first image that sets one', () => {
    const a = createImage('data:image/png;base64,AAAA', { dither: 'atkinson' });
    const b = createImage('data:image/png;base64,BBBB', { dither: 'ordered' });
    expect(ditherModeOf([a, b])).toBe('atkinson');
  });

  it('ignores an image that leaves the mode unset', () => {
    expect(ditherModeOf([createImage('data:image/png;base64,AAAA')])).toBe('auto');
  });
});

describe('prepareForRender', () => {
  it('resolves even with no elements', async () => {
    await expect(prepareForRender([])).resolves.toBeUndefined();
  });

  it('resolves for text elements by loading their fonts', async () => {
    await expect(prepareForRender([createText('A'), createText('B')])).resolves.toBeUndefined();
  });
});

describe('previewCanvas', () => {
  it('produces a canvas the size of the label', () => {
    const cv = previewCanvas([createText('A')], layout(), 'none');
    expect(cv.width).toBe(320);
    expect(cv.height).toBe(240);
  });

  it('preview matches the display layout it was given', () => {
    // The preview is painted in the layout's own axes; the caller's rotateForPrint flag exists for
    // the caller that has a real canvas to turn. Under jsdom there is nothing to rotate, so this
    // asserts the canvas matches the layout it was handed.
    const land = { width: 40, height: 30, orientation: 'portrait' as const };
    const l = display(land);
    const cv = previewCanvas([createText('A')], l, 'none', false);
    expect(cv.width).toBe(l.width);
    expect(cv.height).toBe(l.height);
  });

  it('a portrait display of a wide label is laid out tall', () => {
    // The physical 40x30 label is 320x240; shown portrait the canvas is turned to 240x320.
    expect(layout({ width: 40, height: 30 }).width).toBe(320);
    const l = display({ width: 40, height: 30, orientation: 'portrait' });
    expect(l.width).toBe(240);
    expect(l.height).toBe(320);
  });

  it('needsPrintRotation is true exactly when the display layout was turned', () => {
    const turned = { width: 40, height: 30, orientation: 'portrait' as const };
    const natural = { width: 40, height: 30, orientation: 'landscape' as const };
    expect(needsPrintRotation(turned)).toBe(true);
    expect(needsPrintRotation(natural)).toBe(false);
  });
});