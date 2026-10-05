/** Whole-label rendering: elements → pixels → printer raster. */
import type { LabelElement } from '../model/elements';
import { drawElement, type DrawOptions } from './draw';
import { loadImage } from './images';
import type { LabelLayout } from './layout';
import { pixelsToRaster, type DitherMode, type RasterAlignment } from '../raster/raster';
import type { Raster } from '../protocols/encoders';
import type { Alignment } from '../printers/definitions';
import { rotateCanvas, rotatePixelsCW } from './orient';

export interface PixelBuffer { pixels: Uint8ClampedArray; width: number; height: number }

/** Paint the label (white paper, round clip, zone offsets) onto a canvas context. */
export function paintLabel(ctx: CanvasRenderingContext2D, elements: LabelElement[], layout: LabelLayout, opts: DrawOptions = {}): void {
  const { width, height } = layout;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  if (layout.round) {
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, Math.min(width, height) / 2, 0, Math.PI * 2);
    ctx.clip();
  }
  for (const el of elements) {
    if (layout.zones) {
      const zone = layout.zones[el.zone ?? 0];
      if (!zone) continue;
      drawElement(ctx, { ...el, x: el.x + zone.x, y: el.y + zone.y }, opts);
    } else {
      drawElement(ctx, el, opts);
    }
  }
  ctx.restore();
}

/**
 * Refuse a canvas the browser cannot allocate, before it is allocated.
 *
 * Storage clamps imported and autosaved sizes, but a custom label size, a custom printer
 * definition's DPI, or a multi-label roll set in the same session reaches here directly. A canvas
 * of width x height plus the getImageData copy is 4 bytes per pixel, and the 300 DPI path builds
 * several such canvases, so an extreme value kills the tab rather than failing visibly — and a
 * canvas this size could not have printed anything useful anyway.
 */
export const MAX_CANVAS_SIDE = 8000;
export const MAX_CANVAS_PIXELS = 16_000_000;   // 64 MB of RGBA per buffer

export function assertRenderable(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new RangeError(`Label size is not a usable pixel size: ${width}x${height}`);
  }
  if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) {
    throw new RangeError(`Label is ${width}x${height}px, larger than the ${MAX_CANVAS_SIDE}px limit`);
  }
  if (width * height > MAX_CANVAS_PIXELS) {
    throw new RangeError(`Label is ${width * height} pixels, above the ${MAX_CANVAS_PIXELS} limit`);
  }
}

/**
 * How much larger than the 203 DPI authoring grid a head needs the artwork rasterised.
 *
 * Every element coordinate in this app is in label pixels at 8 px/mm (PX_PER_MM), which is a
 * 203 DPI grid. A 300 DPI head needs 300/203 ≈ 1.478x that. Rendering the label at 203 DPI and
 * then interpolating the finished bitmap up to 300 was measurably worse than rendering at 300 in
 * the first place: measured on a 53 mm M02 Pro label, thresholded to 1-bpp, 6954 of ~8855 ink dots
 * landed on a different dot, and the glyph edges came out rounded and wavy rather than crisp.
 * Interpolation cannot invent the detail the 203 DPI render never had.
 *
 * The cap stays: a head's DPI comes from a printer definition, including a user's own, so an
 * absurd value would allocate an absurd canvas. The scale is only ever meant to cover 203 -> 300.
 */
export function rasterScale(dpi: number): number {
  return dpi > 203 ? Math.min(3, dpi / 203) : 1;
}

/**
 * @param scale - render at `scale`x the layout's pixel size. The layout and the elements stay in
 *   label pixels; the context is scaled instead, so everything that has no coordinate of its own —
 *   stroke widths, corner radii, barcode module sizes, image resampling — scales with it.
 */
export function renderPixels(elements: LabelElement[], layout: LabelLayout, scale = 1): PixelBuffer {
  const width = Math.round(layout.width * scale);
  const height = Math.round(layout.height * scale);
  assertRenderable(width, height);
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not get a 2D canvas context');
  if (scale !== 1) ctx.setTransform(scale, 0, 0, scale, 0, 0);
  paintLabel(ctx, elements, layout);
  return { pixels: ctx.getImageData(0, 0, width, height).data, width, height };
}

/** Everything the rasteriser needs to know about the target printer. */
export interface RasterTarget {
  widthBytes: number;
  dpi: number;
  alignment: Alignment;
  /** D-series / P12: send an unpadded raster; the encoder rotates it. */
  rotated: boolean;
}

/**
 * @param rotateForPrint - true when `layout` is the landscape *display* layout and this raster
 *   needs rotating back to the label's physical (portrait) axes first. The rest of this function
 *   — and everything downstream of it (widthBytes, dpi scaling, protocol rotation) — is exactly
 *   the original, orientation-unaware pipeline; this is the only place orientation is handled.
 */
export function buildRaster(elements: LabelElement[], layout: LabelLayout, target: RasterTarget, mode: DitherMode, rotateForPrint = false): Raster {
  // A 300 DPI head gets the artwork rasterised at its own resolution, not a 203 DPI render
  // interpolated up — see rasterScale(). The artwork's pixel dimensions are unchanged either way,
  // so only the detail differs.
  const scale = target.rotated ? 1 : rasterScale(target.dpi);
  let { pixels, width, height } = renderPixels(elements, layout, scale);
  if (rotateForPrint) ({ pixels, width, height } = rotatePixelsCW(pixels, width, height));

  if (target.rotated) {
    const widthBytes = Math.ceil(width / 8);
    return { data: pixelsToRaster(pixels, width, height, widthBytes, false, mode), widthBytes, heightLines: height };
  }

  if (target.dpi > 203) {
    // High-DPI heads left-align: the artwork is at head resolution now, so it may be a few dots
    // wider than the head's byte count, and centring would then push the overflow off both sides.
    return { data: pixelsToRaster(pixels, width, height, target.widthBytes, 'left', mode), widthBytes: target.widthBytes, heightLines: height };
  }

  const align: RasterAlignment = target.alignment;
  return { data: pixelsToRaster(pixels, width, height, target.widthBytes, align, mode), widthBytes: target.widthBytes, heightLines: height };
}

/** Dither mode of a label: taken from the first image that sets one, otherwise 'auto'. */
export function ditherModeOf(elements: LabelElement[]): DitherMode {
  for (const el of elements) if (el.type === 'image' && el.dither) return el.dither;
  return 'auto';
}

/**
 * What will actually land on paper (1-bpp), as a canvas. Used by the print preview.
 * Dithers in the label's physical orientation (matching real print order) and, if the display
 * is landscape, rotates the result back so it lines up with what's on screen.
 */
export function previewCanvas(elements: LabelElement[], layout: LabelLayout, mode: DitherMode, rotateForPrint = false): HTMLCanvasElement {
  let { pixels, width, height } = renderPixels(elements, layout);
  if (rotateForPrint) ({ pixels, width, height } = rotatePixelsCW(pixels, width, height));
  const widthBytes = Math.ceil(width / 8);
  const data = pixelsToRaster(pixels, width, height, widthBytes, false, mode);
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d')!;
  const out = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const black = (data[y * widthBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      const p = (y * width + x) * 4;
      out.data[p] = out.data[p + 1] = out.data[p + 2] = black ? 0 : 255;
      out.data[p + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return rotateForPrint ? rotateCanvas(cv, false) : cv;
}

/** Make sure every image and web font used by the label is ready before rasterising. */
export async function prepareForRender(elements: LabelElement[]): Promise<void> {
  const images = elements.flatMap((e) => (e.type === 'image' && e.imageData ? [e.imageData] : []));
  const fonts = new Set<string>();
  for (const e of elements) {
    if (e.type !== 'text') continue;
    const w = e.fontWeight === 'bold' ? 'bold' : 'normal';
    const s = e.fontStyle === 'italic' ? 'italic' : 'normal';
    fonts.add(`${s} ${w} 16px ${e.fontFamily}`);
  }
  await Promise.all([
    ...images.map(loadImage),
    ...[...fonts].map((f) => document.fonts.load(f).catch(() => [])),
  ]);
}
