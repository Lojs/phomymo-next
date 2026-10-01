/** Rotate a 1-bpp packed raster by 90°. Bit order is MSB-first, matching the printer wire format. */
export interface PackedRaster {
  data: Uint8Array;
  widthBytes: number;
  heightLines: number;
}

function rotate(data: Uint8Array, widthBytes: number, heightLines: number, clockwise: boolean): PackedRaster {
  const srcW = widthBytes * 8;
  const srcH = heightLines;
  const dstW = srcH;
  const dstH = srcW;
  const dstWidthBytes = Math.ceil(dstW / 8);
  const out = new Uint8Array(dstWidthBytes * dstH);

  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      if (!((data[y * widthBytes + (x >> 3)] >> (7 - (x & 7))) & 1)) continue;
      const dx = clockwise ? srcH - 1 - y : y;
      const dy = clockwise ? x : srcW - 1 - x;
      out[dy * dstWidthBytes + (dx >> 3)] |= 1 << (7 - (dx & 7));
    }
  }
  return { data: out, widthBytes: dstWidthBytes, heightLines: dstH };
}

export const rotateRaster90CW = (d: Uint8Array, w: number, h: number) => rotate(d, w, h, true);
export const rotateRaster90CCW = (d: Uint8Array, w: number, h: number) => rotate(d, w, h, false);
