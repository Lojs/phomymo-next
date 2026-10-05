// @vitest-environment jsdom
/**
 * Why a printed label looked speckled and hollow while the same design looked clean on screen.
 *
 * Three causes, all measured before anything was changed:
 *
 *  1. Dithering was applied to line art. The print path asked for 'auto', and the ported
 *     `shouldUseDithering` heuristic answers "yes, dither" for anything with more than 50 distinct
 *     colours — which antialiased glyph edges supply by the hundred. Error diffusion then scatters
 *     those edges: a text-only label produced 453 isolated single dots that thresholding produces
 *     none of, plus the eroded interiors seen in the print.
 *
 *  2. A 300 DPI head was fed 203 DPI artwork interpolated up. Every element coordinate is on an
 *     8 px/mm grid (PX_PER_MM), so the label was rendered at 203 DPI and then resampled. Measured
 *     on a 53 mm M02 Pro label, 6954 of ~8855 ink dots landed on a different dot than a native
 *     300 DPI render, and the edges came out rounded and wavy.
 *
 *  3. Fixing 1 by "threshold unless the label contains an image" still dithered a label with a logo
 *     *and* text, because the image put the whole composite back on the photo path. The rule now
 *     belongs to the image: each one is binarised by its own mode while it is drawn, and the
 *     composite is always a plain threshold, so text can never be dragged into a halftone by a
 *     picture beside it.
 *
 * What is testable here and what is not: jsdom's canvas stub discards drawing, so no test in this
 * file can see a pixel. `resolveImageMode` is pure — pixels in, mode out — so it is tested directly
 * and that is where the decision now lives. The composite behaviour was measured in a real browser
 * instead (the text region of a text+image label carries no isolated speckle), which is the same
 * split used for the 300 DPI fix: unit-test the decision, measure the pixels.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildRaster, renderPixels, rasterScale, type RasterTarget } from '../src/core/render/label';
import { singleLayout } from '../src/core/render/layout';
import { createText } from '../src/core/model/elements';
import { resolveImageMode } from '../src/core/render/draw';

afterEach(() => vi.restoreAllMocks());

const target = (over: Partial<RasterTarget> = {}): RasterTarget => ({
  widthBytes: 78, dpi: 300, alignment: 'left', rotated: false, ...over,
});
const layout = () => singleLayout({ width: 53, height: 40 });   // 424 x 320 px at 203 DPI

/** Record every setTransform the renderer applies, so the render scale is observable. */
function recordTransforms() {
  const seen: number[][] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return {
      canvas: this, font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt',
      lineJoin: 'miter', textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1,
      imageSmoothingEnabled: true, imageSmoothingQuality: 'low', shadowColor: '', shadowBlur: 0,
      shadowOffsetX: 0, shadowOffsetY: 0, filter: 'none',
      measureText: (t: string) => ({ width: t.length * 8 }) as TextMetrics,
      save: () => {}, restore: () => {}, scale: () => {}, rotate: () => {}, translate: () => {},
      transform: () => {}, resetTransform: () => {},
      setTransform: (...a: number[]) => seen.push(a),
      beginPath: () => {}, closePath: () => {}, moveTo: () => {}, lineTo: () => {},
      bezierCurveTo: () => {}, quadraticCurveTo: () => {}, arc: () => {}, arcTo: () => {},
      ellipse: () => {}, rect: () => {}, fill: () => {}, stroke: () => {}, clip: () => {},
      fillRect: () => {}, strokeRect: () => {}, clearRect: () => {}, fillText: () => {},
      strokeText: () => {}, drawImage: () => {}, putImageData: () => {},
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) as ImageData,
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) as ImageData,
      setLineDash: () => {}, getLineDash: () => [],
    } as unknown as CanvasRenderingContext2D;
  });
  return seen;
}

describe('rasterScale', () => {
  it('leaves a 203 DPI head alone', () => {
    expect(rasterScale(203)).toBe(1);
    expect(rasterScale(100)).toBe(1);
  });

  it('renders a 300 DPI head at its own resolution', () => {
    expect(rasterScale(300)).toBeCloseTo(300 / 203, 6);
    expect(rasterScale(300)).toBeGreaterThan(1.4);
    expect(rasterScale(300)).toBeLessThan(1.5);
  });

  it('caps an absurd DPI rather than allocating an absurd canvas', () => {
    expect(rasterScale(1200)).toBe(3);
    expect(rasterScale(96_000)).toBe(3);
  });
});

describe('the artwork is rendered at the head resolution, not upscaled to it', () => {
  it('scales the context by the DPI ratio for a 300 DPI head', () => {
    const seen = recordTransforms();
    renderPixels([createText('A')], layout(), rasterScale(300));
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBeCloseTo(300 / 203, 6);
    expect(seen[0][3]).toBeCloseTo(300 / 203, 6);
  });

  it('does not touch the transform for a 203 DPI head', () => {
    const seen = recordTransforms();
    renderPixels([createText('A')], layout(), rasterScale(203));
    expect(seen).toHaveLength(0);
  });

  it('renders a 300 DPI raster from one canvas, not three', () => {
    // The old path made the artwork canvas, then a source and a destination canvas to interpolate
    // between. A native render needs only the first.
    const created: string[] = [];
    const real = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') created.push(tag);
      return real(tag);
    });
    buildRaster([createText('A')], layout(), target({ dpi: 300 }), 'threshold');
    expect(created).toHaveLength(1);
  });

  it('keeps the artwork pixel dimensions identical to the old upscale', () => {
    // The scale changes only the detail, so nothing downstream — byte counts, row counts, the
    // encoder — can shift because of it.
    const r = buildRaster([createText('A')], layout(), target({ dpi: 300 }), 'threshold');
    expect(r.heightLines).toBe(Math.round(320 * (300 / 203)));
  });

  it('gives a 203 DPI head the layout size unchanged', () => {
    const r = buildRaster([createText('A')], layout(), target({ dpi: 203 }), 'threshold');
    expect(r.heightLines).toBe(320);
  });
});

const W = 40;
const H = 40;

/** Two tones and no near-neighbour deltas: the heuristic's "line art". */
function flatPixels(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    const v = (i % W) < W / 2 ? 0 : 255;
    px[p] = px[p + 1] = px[p + 2] = v;
    px[p + 3] = 255;
  }
  return px;
}

/** A smooth gradient: well over 50 distinct colours, so the heuristic's "photograph". */
function photoPixels(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const v = Math.round((255 * (x + y)) / (W + H));
      px[p] = px[p + 1] = px[p + 2] = v;
      px[p + 3] = 255;
    }
  }
  return px;
}

describe('an image decides its own binarisation', () => {
  it('gives flat art a plain threshold', () => {
    expect(resolveImageMode(flatPixels(), W, H, undefined)).toBe('none');
    expect(resolveImageMode(flatPixels(), W, H, 'auto')).toBe('none');
  });

  it('gives a photograph error diffusion', () => {
    expect(resolveImageMode(photoPixels(), W, H, undefined)).toBe('floyd-steinberg');
    expect(resolveImageMode(photoPixels(), W, H, 'auto')).toBe('floyd-steinberg');
  });

  it('honours a mode the element asked for by name, whatever the image looks like', () => {
    expect(resolveImageMode(photoPixels(), W, H, 'ordered')).toBe('ordered');
    expect(resolveImageMode(photoPixels(), W, H, 'none')).toBe('none');
    expect(resolveImageMode(flatPixels(), W, H, 'atkinson')).toBe('atkinson');
  });

  it('never returns "auto" — the caller needs a mode it can act on', () => {
    // 'auto' means "decide", and deciding is this function's job. Handing it back would push the
    // decision to a caller that has no pixels to decide with, which is how the composite ended up
    // halftoning text in the first place.
    for (const declared of [undefined, 'auto'] as const) {
      expect(resolveImageMode(flatPixels(), W, H, declared)).not.toBe('auto');
      expect(resolveImageMode(photoPixels(), W, H, declared)).not.toBe('auto');
    }
  });
});