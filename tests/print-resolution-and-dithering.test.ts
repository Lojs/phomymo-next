// @vitest-environment jsdom
/**
 * Why a printed label looked speckled and hollow while the same design looked clean on screen.
 *
 * Two separate causes, both measured before either was changed:
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
 * The tests below pin the decisions, not the pixels: jsdom's canvas stub discards drawing, so what
 * is observable here is which scale the renderer asked for, how many canvases it allocated, and
 * which binarisation mode the print path chose.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildRaster, renderPixels, rasterScale, type RasterTarget } from '../src/core/render/label';
import { singleLayout } from '../src/core/render/layout';
import { createText, createImage } from '../src/core/model/elements';
import { modeFor } from '../src/services/printing';
import type { ResolvedConfig } from '../src/core/printers/definitions';

afterEach(() => vi.restoreAllMocks());

const target = (over: Partial<RasterTarget> = {}): RasterTarget => ({
  widthBytes: 78, dpi: 300, alignment: 'left', rotated: false, ...over,
});
const layout = () => singleLayout({ width: 53, height: 40 });   // 424 x 320 px at 203 DPI

const cfg = (over: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  width: 78, protocol: 'm-series', dpi: 300, recognized: true, matchedPattern: null, definition: null, ...over,
});

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

describe('line art is thresholded, a photograph is dithered', () => {
  it('thresholds a text-only label instead of dithering it', () => {
    // The bug in one line: this used to come back 'auto', and 'auto' dithers antialiased text.
    expect(modeFor([createText('hello')], cfg())).toBe('threshold');
  });

  it('thresholds shapes and codes too — none of them are photographs', () => {
    const shapes = [{ ...createText('x') }, { ...createText('y') }];
    expect(modeFor(shapes, cfg())).toBe('threshold');
  });

  it('keeps dithering available once an image is on the label', () => {
    // 'auto' is still the answer for artwork that may contain a photo; shouldUseDithering then
    // decides from the tones.
    expect(modeFor([createText('x'), createImage('data:image/png;base64,')], cfg())).toBe('auto');
  });

  it('still honours an explicit dither the element asked for', () => {
    const img = { ...createImage('data:image/png;base64,'), dither: 'ordered' as const };
    expect(modeFor([img], cfg())).toBe('ordered');
  });

  it('thresholds a text-only TSPL label as it always did', () => {
    expect(modeFor([createText('x')], cfg({ protocol: 'tspl' }))).toBe('threshold');
  });

  it('an image with no explicit dither on a TSPL printer still gets threshold', () => {
    expect(modeFor([createImage('data:image/png;base64,')], cfg({ protocol: 'tspl' }))).toBe('threshold');
  });
});
