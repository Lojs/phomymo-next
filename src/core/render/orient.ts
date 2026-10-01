/**
 * Rotates a rendered RGBA pixel buffer 90°. This is the *user-orientation* layer: it converts
 * between what's drawn on screen (the "display" canvas, which may be landscape) and the label's
 * physical axes (always "portrait" as far as the printer/protocol pipeline is concerned).
 *
 * This is unrelated to the protocol-specific raster rotation in core/raster/rotate.ts, which
 * operates on already-packed 1-bit printer bytes for certain printer families — that logic is
 * untouched and still runs, afterwards, on whatever this layer hands it.
 */
export interface PixelBuf { pixels: Uint8ClampedArray; width: number; height: number }

function rotatePixels(src: Uint8ClampedArray, w: number, h: number, cw: boolean): PixelBuf {
  const nw = h, nh = w;
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = cw ? h - 1 - y : y;
      const ny = cw ? x : w - 1 - x;
      const s = (y * w + x) * 4;
      const d = (ny * nw + nx) * 4;
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3];
    }
  }
  return { pixels: out, width: nw, height: nh };
}

/** Display (landscape) → physical (portrait). */
export const rotatePixelsCW = (pixels: Uint8ClampedArray, w: number, h: number): PixelBuf => rotatePixels(pixels, w, h, true);
/** Physical (portrait) → display (landscape). Exact inverse of rotatePixelsCW. */
export const rotatePixelsCCW = (pixels: Uint8ClampedArray, w: number, h: number): PixelBuf => rotatePixels(pixels, w, h, false);

/** Same rotation, for an already-painted canvas (used by the print-preview overlay). */
export function rotateCanvas(src: HTMLCanvasElement, cw: boolean): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = src.height;
  cv.height = src.width;
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  if (cw) { ctx.translate(cv.width, 0); ctx.rotate(Math.PI / 2); }
  else { ctx.translate(0, cv.height); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(src, 0, 0);
  return cv;
}
