/**
 * F-02: a label wider than the printer's own print width.
 *
 * packBits() computed a horizontal offset from the alignment, so when the label was wider than
 * the printer the offset went NEGATIVE and the leading columns were computed and then discarded
 * by the bounds check — what printed was the label's RIGHT edge instead of its left. With the
 * 'left' alignment (the default for the 300-DPI path, and therefore every TSPL printer) the row
 * index then spilled past the buffer into the NEXT row and clobbered it, so rows were destroyed
 * rather than merely mis-positioned.
 *
 * The state is reachable: LIMITS.label.maxW is 100mm while a printer's widthBytes is typically
 * 12-40, and the store deliberately preserves a user-defined size the new family does not offer.
 *
 * The fix clamps the offset to a usable range and stops each row at that row's own end. A label
 * that does not fit is therefore CLIPPED to the printer's width from the left — the columns the
 * printer physically cannot reach are dropped, and every row keeps its own bytes.
 */
import { describe, it, expect } from 'vitest';
import { pixelsToRaster } from '../src/core/raster/raster';

/** `count` black columns starting at `fromX`, on an otherwise white label. */
function label(width = 480, height = 2, fromX = 0, count = 480) {
  const px = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) {
    for (let x = fromX; x < fromX + count; x++) {
      const p = (y * width + x) * 4;
      px[p] = px[p + 1] = px[p + 2] = 0;
    }
  }
  return { px, width, height };
}

const countBits = (u8: Uint8Array): number => {
  let n = 0;
  for (const b of u8) { let v = b; while (v) { n += v & 1; v >>= 1; } }
  return n;
};

describe('a label wider than the printer is clipped, not mangled', () => {
  // 480px label on a 40-byte (320px) printer. The printer can only reach x=0..319.
  it.each(['left', 'center', 'right'] as const)('%s alignment emits exactly one row-buffer of output', (align) => {
    const { px, width, height } = label(480, 2);
    const r = pixelsToRaster(px, width, height, 40, align, 'threshold');
    expect(r.length).toBe(40 * height);
    // Black starts at x=0, so the reachable 320 columns are all black: 2 rows x 320 = 640.
    expect(countBits(r)).toBe(640);
  });

  it('keeps the LEFT edge of a too-wide label, for every alignment', () => {
    // Black only in x=0..159 — inside the printable width. All three alignments must keep it:
    // 'center'/'right' used to shift it by a negative offset and drop it entirely.
    for (const align of ['left', 'center', 'right'] as const) {
      const { px, width, height } = label(480, 2, 0, 160);
      expect(countBits(pixelsToRaster(px, width, height, 40, align, 'threshold'))).toBe(320);
    }
  });

  it('drops only the columns the printer cannot reach', () => {
    // Black in x=320..479 (beyond 320px). Clipping means none of it is printed, but the two rows
    // must still be intact — the old code overwrote row y+1 and produced a blank strip.
    const { px, width, height } = label(480, 4, 320, 160);
    const r = pixelsToRaster(px, width, height, 40, 'left', 'threshold');
    expect(countBits(r)).toBe(0);
    // All four rows identical and all-white proves no cross-row corruption happened.
    for (let y = 1; y < 4; y++) expect(r.subarray(0, 40)).toEqual(r.subarray(y * 40, y * 40 + 40));
  });

  it('does not let one row overwrite the next', () => {
    // Distinct content per row: if rows spilled into each other the raster would be uniform.
    const px = new Uint8ClampedArray(480 * 3 * 4).fill(255);
    for (let x = 0; x < 320; x++) {
      for (const y of [0, 2]) { const p = (y * 480 + x) * 4; px[p] = px[p + 1] = px[p + 2] = 0; }
    }
    const r = pixelsToRaster(px, 480, 3, 40, 'left', 'threshold');
    expect(countBits(r.subarray(0, 40))).toBe(320);
    expect(countBits(r.subarray(40, 80))).toBe(0);
    expect(countBits(r.subarray(80, 120))).toBe(320);
  });

  it('a label exactly the printer width is unchanged', () => {
    // The regression guard: the normal case must not move.
    for (const align of ['left', 'center', 'right'] as const) {
      const { px, width, height } = label(320, 2, 0, 160);
      expect(countBits(pixelsToRaster(px, width, height, 40, align, 'threshold'))).toBe(320);
    }
  });

  it('a label narrower than the printer still honours alignment', () => {
    const { px, width, height } = label(200, 2, 0, 100);
    // 200px = 25 bytes in a 40-byte row; the black half is 100px in all three alignments.
    for (const align of ['left', 'center', 'right'] as const) {
      expect(countBits(pixelsToRaster(px, width, height, 40, align, 'threshold'))).toBe(200);
    }
  });
});
