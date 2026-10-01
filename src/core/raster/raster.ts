/**
 * RGBA pixels → 1-bpp printer raster (thresholding and dithering).
 * Pure functions, ported unchanged from the original renderer so output is
 * bit-identical for the same input pixels.
 */
export type DitherMode = 'auto' | 'none' | 'threshold' | 'floyd-steinberg' | 'atkinson' | 'ordered';
export type RasterAlignment = 'left' | 'center' | 'right' | false;

/** Luma with anti-alias alpha flattened onto white, then gamma-lifted (1.3) to keep midtones readable. */
export function rgbaToGrayscale(pixels: Uint8ClampedArray | Uint8Array, width: number, height: number, gamma = 1.3): Float32Array {
  const out = new Float32Array(width * height);
  const inv = 1 / gamma;
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    let gray = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
    const a = pixels[p + 3];
    if (a < 255) gray = gray * (a / 255) + 255 * (1 - a / 255);
    out[i] = 255 * Math.pow(gray / 255, inv);
  }
  return out;
}

/** Output convention for all ditherers: 1 = black, 0 = white. */
export function floydSteinberg(gray: Float32Array, width: number, height: number): Uint8Array {
  const px = new Float32Array(gray);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = px[i];
      const nu = old < 128 ? 0 : 255;
      out[i] = nu === 0 ? 1 : 0;
      const err = old - nu;
      if (x + 1 < width) px[i + 1] += (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) px[(y + 1) * width + (x - 1)] += (err * 3) / 16;
        px[(y + 1) * width + x] += (err * 5) / 16;
        if (x + 1 < width) px[(y + 1) * width + (x + 1)] += (err * 1) / 16;
      }
    }
  }
  return out;
}

export function atkinson(gray: Float32Array, width: number, height: number): Uint8Array {
  const px = new Float32Array(gray);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = px[i];
      const nu = old < 128 ? 0 : 255;
      out[i] = nu === 0 ? 1 : 0;
      const err = (old - nu) / 8;
      if (x + 1 < width) px[i + 1] += err;
      if (x + 2 < width) px[i + 2] += err;
      if (y + 1 < height) {
        if (x > 0) px[(y + 1) * width + (x - 1)] += err;
        px[(y + 1) * width + x] += err;
        if (x + 1 < width) px[(y + 1) * width + (x + 1)] += err;
      }
      if (y + 2 < height) px[(y + 2) * width + x] += err;
    }
  }
  return out;
}

const BAYER_8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

export function ordered(gray: Float32Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const threshold = (BAYER_8[(y % 8) * 8 + (x % 8)] / 64) * 255;
      out[y * width + x] = gray[y * width + x] < threshold ? 1 : 0;
    }
  }
  return out;
}

/** Plain threshold on the (gamma-lifted) grayscale — used for previews of "none". */
export function thresholdGray(gray: Float32Array): Uint8Array {
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] < 128 ? 1 : 0;
  return out;
}

/** Heuristic for 'auto': dither only when the artwork has photo-like tones. */
export function shouldUseDithering(pixels: Uint8ClampedArray | Uint8Array, width: number, height: number): boolean {
  const sampleSize = Math.min(1000, width * height);
  const step = Math.floor((width * height) / sampleSize);
  const colors = new Set<number>();
  let gradients = 0;
  let last = -1;
  for (let i = 0; i < width * height; i += step) {
    const p = i * 4;
    const r = pixels[p];
    const g = pixels[p + 1];
    const b = pixels[p + 2];
    colors.add((r << 16) | (g << 8) | b);
    const gray = Math.round((r + g + b) / 3);
    if (last >= 0) {
      const d = Math.abs(gray - last);
      if (d > 0 && d < 30) gradients++;
    }
    last = gray;
  }
  return colors.size > 50 || gradients > sampleSize * 0.1;
}

function packBits(
  isBlack: (x: number, y: number) => boolean,
  width: number,
  height: number,
  outputWidthBytes: number,
  alignment: RasterAlignment,
): Uint8Array {
  const rowBytes = Math.ceil(width / 8);
  const out = new Uint8Array(outputWidthBytes * height);
  let offset = 0;
  if (alignment === 'center') offset = Math.floor((outputWidthBytes - rowBytes) / 2);
  else if (alignment === 'right') offset = outputWidthBytes - rowBytes;

  for (let y = 0; y < height; y++) {
    for (let bx = 0; bx < rowBytes; bx++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = bx * 8 + bit;
        if (x >= width) continue;
        if (isBlack(x, y)) byte |= 1 << (7 - bit);
      }
      const pos = y * outputWidthBytes + offset + bx;
      if (pos >= 0 && pos < out.length) out[pos] = byte;
    }
  }
  return out;
}

export function pixelsToRasterThreshold(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  outputWidthBytes: number,
  alignment: RasterAlignment = 'left',
): Uint8Array {
  return packBits(
    (x, y) => {
      const i = (y * width + x) * 4;
      return 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2] < 128;
    },
    width,
    height,
    outputWidthBytes,
    alignment,
  );
}

export function pixelsToRasterDithered(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  outputWidthBytes: number,
  alignment: RasterAlignment = 'left',
  algorithm: 'floyd-steinberg' | 'atkinson' | 'ordered' = 'floyd-steinberg',
): Uint8Array {
  const gray = rgbaToGrayscale(pixels, width, height, 1.3);
  const dithered =
    algorithm === 'atkinson' ? atkinson(gray, width, height) : algorithm === 'ordered' ? ordered(gray, width, height) : floydSteinberg(gray, width, height);
  return packBits((x, y) => dithered[y * width + x] === 1, width, height, outputWidthBytes, alignment);
}

export function pixelsToRaster(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  outputWidthBytes: number,
  alignment: RasterAlignment = 'left',
  mode: DitherMode = 'auto',
): Uint8Array {
  if (mode === 'none' || mode === 'threshold') return pixelsToRasterThreshold(pixels, width, height, outputWidthBytes, alignment);
  if (mode === 'floyd-steinberg' || mode === 'atkinson' || mode === 'ordered') {
    return pixelsToRasterDithered(pixels, width, height, outputWidthBytes, alignment, mode);
  }
  return shouldUseDithering(pixels, width, height)
    ? pixelsToRasterDithered(pixels, width, height, outputWidthBytes, alignment, 'floyd-steinberg')
    : pixelsToRasterThreshold(pixels, width, height, outputWidthBytes, alignment);
}
