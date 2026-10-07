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
import { createImage, createText } from '../src/core/model/elements';
import { ditherPreview, drawElement, resolveImageMode } from '../src/core/render/draw';

// drawElement() needs a decoded image, and jsdom never loads one. Everything else in this file draws
// text, so this is the only module that has to be faked.
vi.mock('../src/core/render/images', () => ({
  getImage: () => ({ naturalWidth: 4, naturalHeight: 4 }) as HTMLImageElement,
  loadImage: async () => null,
  onImageLoaded: () => () => {},
}));

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

/**
 * N1, from the v1.0.24 review: an image was binarised at the label grid and then smooth-upscaled by
 * the render scale, so on a 300 DPI head the halftone was interpolated and the threshold that
 * followed turned the blurred dots into clumps. Measured in a browser on a black-to-white ramp:
 * mean tone error per band 0.096 against 0.0007 for a device-resolution binarisation, the 53% grey
 * band printing as 37% and the 30% band as 14%, with the isolated-dot share falling 0.267 -> 0.119.
 *
 * jsdom cannot see those pixels, so what is pinned here is what decides them: the halftone's own
 * dimensions, and that it reaches the canvas without being resampled.
 */
describe('N1: an image is binarised at the resolution it will print at', () => {
  const img = { naturalWidth: 4, naturalHeight: 4 } as HTMLImageElement;
  const image = () => createImage('data:image/png;base64,AAAA', { width: 200, height: 120 });

  it('binarises at the label grid for a 203 DPI head', () => {
    const cv = ditherPreview(img, image(), rasterScale(203));
    expect(cv.width).toBe(200);
    expect(cv.height).toBe(120);
  });

  it('binarises at the device resolution for a 300 DPI head', () => {
    const scale = rasterScale(300);
    const cv = ditherPreview(img, image(), scale);
    // Before this fix the scale did not exist: this canvas was 200x120 on every head, and the
    // 1.478x upscale happened after the halftone had already been made.
    expect(cv.width).toBe(Math.round(200 * scale));
    expect(cv.height).toBe(Math.round(120 * scale));
  });

  it('does not serve a 300 DPI render from the 203 DPI cache entry', () => {
    // The cache is keyed on the resulting pixel dimensions, so two heads cannot share an entry.
    const el = image();
    const small = ditherPreview(img, el, 1);
    const large = ditherPreview(img, el, rasterScale(300));
    expect(small.width).toBe(200);
    expect(large.width).toBe(Math.round(200 * rasterScale(300)));
    expect(ditherPreview(img, el, 1).width).toBe(200);
  });

  it('reaches that device size through renderPixels, not only through drawElement', () => {
    // M1: this is the line that carries the scale from renderPixels() into the draw, and nothing
    // checked it. Deleting `scale` from the options object left the whole suite green — every image
    // would go back to being binarised at the label grid on a 300 DPI head, silently.
    const draws = recordDraws();
    renderPixels([image()], layout(), rasterScale(300));
    expect(draws.length).toBeGreaterThan(0);
    expect(draws[draws.length - 1].src.width).toBe(Math.round(200 * rasterScale(300)));
  });

  it('draws it at the device size, with smoothing off', () => {
    const draws = recordDraws();
    const ctx = document.createElement('canvas').getContext('2d')!;
    drawElement(ctx, image(), { ditherImages: true, scale: rasterScale(300) });
    // Two draws: the first is ditherPreview() putting the source image onto its own canvas, the
    // second is the finished halftone going onto the label.
    expect(draws).toHaveLength(2);
    const halftone = draws[1];
    expect(halftone.src.width).toBe(Math.round(200 * rasterScale(300)));
    // A 1:1 mapping needs no interpolation, and interpolating a 1-bit image is what merged the dots.
    expect(halftone.smoothing).toBe(false);
  });

  it('leaves the 203 DPI path exactly as it was', () => {
    const draws = recordDraws();
    const ctx = document.createElement('canvas').getContext('2d')!;
    drawElement(ctx, image(), { ditherImages: true, scale: 1 });
    expect(draws[1].src.width).toBe(200);
    expect(draws[1].src.height).toBe(120);
  });
});
describe('M4: an off-right-angle rotation is binarised in the orientation it prints in', () => {
  // jsdom cannot show moire, so what is pinned is the mechanism that avoids it: for an angle that is
  // not a multiple of 90 the halftone is made from the rotated image, in a canvas large enough to
  // hold it, and the draw cancels the parent rotation. Rendering it showed the difference — the
  // drawn-rotated version had vertical columnar banding and clumped dots through the midtones.
  const img = { naturalWidth: 4, naturalHeight: 4 } as HTMLImageElement;
  const image = (rotation: number) => createImage('data:image/png;base64,AAAA', { width: 200, height: 120, rotation });
  const bounds = (angle: number) => {
    const rad = (angle * Math.PI) / 180;
    return {
      w: Math.ceil(Math.abs(200 * Math.cos(rad)) + Math.abs(120 * Math.sin(rad))),
      h: Math.ceil(Math.abs(200 * Math.sin(rad)) + Math.abs(120 * Math.cos(rad))),
    };
  };

  it('bakes a free angle into a canvas that holds the rotated image', () => {
    const cv = ditherPreview(img, image(17), 1, true);
    expect(cv.width).toBe(bounds(17).w);
    expect(cv.height).toBe(bounds(17).h);
    expect(cv.width).toBeGreaterThan(200);
  });

  it('does not bake a right angle, which maps pixels exactly', () => {
    // 90, 180 and 270 turn a pixel grid onto itself, so the halftone can be made unrotated.
    for (const angle of [0, 90, 180, 270]) {
      const cv = ditherPreview(img, image(angle), 1, false);
      expect([cv.width, cv.height]).toEqual([200, 120]);
    }
  });

  it('draws a free angle from the baked halftone', () => {
    const draws = recordDraws();
    const ctx = document.createElement('canvas').getContext('2d')!;
    drawElement(ctx, image(17), { ditherImages: true, scale: 1 });
    expect(draws[draws.length - 1].src.width).toBe(bounds(17).w);
  });

  it('draws a right angle from the unrotated halftone, exactly as before', () => {
    const draws = recordDraws();
    const ctx = document.createElement('canvas').getContext('2d')!;
    drawElement(ctx, image(90), { ditherImages: true, scale: 1 });
    expect(draws[draws.length - 1].src.width).toBe(200);
    expect(draws[draws.length - 1].src.height).toBe(120);
  });

  it('keeps two rotations of the same element apart in the cache', () => {
    // The key used to ignore rotation entirely, which was harmless while the halftone did not depend
    // on it. It does now, so a 17 degree entry must not answer for a 0 degree one.
    const el = { ...image(0), id: 'same-element' };
    const straight = ditherPreview(img, el, 1, false);
    const turned = ditherPreview(img, { ...el, rotation: 17 }, 1, true);
    expect(straight.width).toBe(200);
    expect(turned.width).toBe(bounds(17).w);
  });
});

/** Record every drawImage along with the smoothing setting in force when it was called. */
function recordDraws() {
  const draws: { src: HTMLCanvasElement; smoothing: boolean | undefined }[] = [];
  const underlying = HTMLCanvasElement.prototype.getContext;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, ...args: unknown[]) {
    const ctx = (underlying as (...a: unknown[]) => CanvasRenderingContext2D | null).apply(this, args);
    if (ctx) {
      ctx.drawImage = ((src: HTMLCanvasElement) => void draws.push({ src, smoothing: ctx.imageSmoothingEnabled })) as typeof ctx.drawImage;
    }
    return ctx;
  });
  return draws;
}

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