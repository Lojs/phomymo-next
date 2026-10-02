/**
 * core/raster/rotate.ts — the 90° packed-raster rotation used by the D-series / P12 protocols.
 *
 * A wrong rotation prints the label sideways or mirrored, so these tests pin the exact pixel
 * mapping rather than just checking dimensions.
 *
 * One property of the algorithm is worth stating, because it shaped these tests: the rotation
 * works on `widthBytes * 8` pixels, so the *rotated* width is padded up to a whole byte. That
 * makes a CW→CCW round trip exact only when the source height is a multiple of 8 — which the app
 * always satisfies, since label heights are `round(mm * 8)`. The non-multiple-of-8 cases below
 * document the padding rather than pretending it does not exist.
 */
import { describe, it, expect } from 'vitest';
import { rotateRaster90CW, rotateRaster90CCW } from '../src/core/raster/rotate';

/** Read bit (x, y) from a packed MSB-first raster. */
function bit(data: Uint8Array, widthBytes: number, x: number, y: number): number {
  return (data[y * widthBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
}

/** Build a packed raster from an ASCII picture: '#' = black, anything else = white. */
function fromArt(rows: string[]): { data: Uint8Array; widthBytes: number; heightLines: number } {
  const widthPx = rows[0].length;
  const widthBytes = Math.ceil(widthPx / 8);
  const data = new Uint8Array(widthBytes * rows.length);
  rows.forEach((row, y) => {
    for (let x = 0; x < widthPx; x++) {
      if (row[x] === '#') data[y * widthBytes + (x >> 3)] |= 1 << (7 - (x & 7));
    }
  });
  return { data, widthBytes, heightLines: rows.length };
}

/** Render a packed raster back to ASCII so a rotation can be read at a glance. */
function toArt(data: Uint8Array, widthBytes: number, heightLines: number, widthPx: number): string[] {
  const out: string[] = [];
  for (let y = 0; y < heightLines; y++) {
    let row = '';
    for (let x = 0; x < widthPx; x++) row += bit(data, widthBytes, x, y) ? '#' : '.';
    out.push(row);
  }
  return out;
}

const popcount = (d: Uint8Array) => [...d].reduce((n, b) => n + b.toString(2).split('1').length - 1, 0);

describe('rotateRaster90CW', () => {
  it('swaps the dimensions (new height = source pixel width)', () => {
    const src = fromArt(['##', '#.', '..', '.#']); // 2 px wide, 4 lines
    const out = rotateRaster90CW(src.data, src.widthBytes, src.heightLines);
    expect(out.heightLines).toBe(8); // srcW = widthBytes * 8
    expect(out.widthBytes).toBe(1);  // dstW = srcH = 4 px -> 1 byte
  });

  it('sends a top-left mark to the top of the right-hand column', () => {
    const src = fromArt(['#.......', '........', '........', '........']); // 8 px wide, 4 lines
    const out = rotateRaster90CW(src.data, src.widthBytes, src.heightLines);
    // CW: (x,y) -> (dx = srcH-1-y, dy = x). For (0,0) with srcH=4: dx = 3, dy = 0.
    expect(bit(out.data, out.widthBytes, 3, 0)).toBe(1);
    expect(toArt(out.data, out.widthBytes, out.heightLines, 4)[0]).toBe('...#');
  });

  it('an all-white raster stays all white', () => {
    const src = fromArt(['........', '........']);
    const out = rotateRaster90CW(src.data, src.widthBytes, src.heightLines);
    expect([...out.data].every((b) => b === 0)).toBe(true);
  });

  it('preserves the number of set bits', () => {
    const src = fromArt(['##.#..##', '.#..##..', '##..##.#', '..#.#...', '.#.#..#.', '##...#..', '#..#..#.', '.#.##.#.']);
    const out = rotateRaster90CW(src.data, src.widthBytes, src.heightLines);
    expect(popcount(out.data)).toBe(popcount(src.data));
  });

  it('maps a mark on the last source row to the last destination column', () => {
    const src = fromArt(['........', '........', '........', '#.......']); // mark at (0,3)
    const out = rotateRaster90CW(src.data, src.widthBytes, src.heightLines);
    // CW: dx = srcH-1-y = 0, dy = x = 0 → (0, 0)
    expect(bit(out.data, out.widthBytes, 0, 0)).toBe(1);
  });

  it('is a real rotation, not a transpose: an L-shape keeps its handedness', () => {
    // Four marks forming an L (three down the left column plus one at its foot).
    const src = fromArt(['#.......', '#.......', '##......', '........']);
    const out = rotateRaster90CW(src.data, src.widthBytes, src.heightLines);
    // CW: (x,y) -> (dx = srcH-1-y, dy = x), with srcH = 4.
    // (0,0)->(3,0)  (0,1)->(2,0)  (0,2)->(1,0)  (1,2)->(1,1)
    expect(bit(out.data, out.widthBytes, 3, 0)).toBe(1);
    expect(bit(out.data, out.widthBytes, 2, 0)).toBe(1);
    expect(bit(out.data, out.widthBytes, 1, 0)).toBe(1);
    expect(bit(out.data, out.widthBytes, 1, 1)).toBe(1);
    expect(popcount(out.data)).toBe(4);
  });
});

describe('rotateRaster90CCW', () => {
  it('sends a top-left mark to the bottom of the left-hand column', () => {
    const src = fromArt(['#.......', '........', '........', '........']);
    const out = rotateRaster90CCW(src.data, src.widthBytes, src.heightLines);
    // CCW: (x,y) -> (dx = y, dy = srcW-1-x). For (0,0): dx = 0, dy = 7.
    expect(bit(out.data, out.widthBytes, 0, 7)).toBe(1);
  });

  it('the two directions differ on an asymmetric raster', () => {
    const src = fromArt(['#.......', '........', '........', '........']);
    const cw = rotateRaster90CW(src.data, src.widthBytes, src.heightLines);
    const ccw = rotateRaster90CCW(src.data, src.widthBytes, src.heightLines);
    expect([...cw.data]).not.toEqual([...ccw.data]);
  });

  it('preserves the number of set bits', () => {
    const src = fromArt(['##.#..##', '.#..##..', '##..##.#', '..#.#...', '.#.#..#.', '##...#..', '#..#..#.', '.#.##.#.']);
    const out = rotateRaster90CCW(src.data, src.widthBytes, src.heightLines);
    expect(popcount(out.data)).toBe(popcount(src.data));
  });
});

describe('round trips', () => {
  it('CW then CCW is exact for a height that is a multiple of 8 (what the app always produces)', () => {
    const src = fromArt([
      '#.#.#.#.',
      '.#.#.#.#',
      '##..##..',
      '..##..##',
      '#..#..#.',
      '.#..#..#',
      '###...##',
      '...###..',
    ]);
    const cw = rotateRaster90CW(src.data, src.widthBytes, src.heightLines);
    const back = rotateRaster90CCW(cw.data, cw.widthBytes, cw.heightLines);
    expect(back.widthBytes).toBe(src.widthBytes);
    expect(back.heightLines).toBe(src.heightLines);
    expect([...back.data]).toEqual([...src.data]);
  });

  it('CCW then CW is likewise exact at a multiple-of-8 height', () => {
    const src = fromArt(['##..#...', '..#..##.', '.#.##..#', '#...#...', '.#.#.#.#', '##.##.#.', '#.#.#.#.', '..#...#.']);
    const ccw = rotateRaster90CCW(src.data, src.widthBytes, src.heightLines);
    const back = rotateRaster90CW(ccw.data, ccw.widthBytes, ccw.heightLines);
    expect([...back.data]).toEqual([...src.data]);
  });

  it('four 90° turns return the original raster at a multiple-of-8 height', () => {
    const src = fromArt(['#.#.#.#.', '.#.#.#.#', '##..##..', '..##..##', '#..#..#.', '.#..#..#', '###...##', '...###..']);
    let r = { ...src };
    for (let i = 0; i < 4; i++) r = rotateRaster90CW(r.data, r.widthBytes, r.heightLines) as typeof src;
    expect([...r.data]).toEqual([...src.data]);
  });

  it('a height that is not a multiple of 8 gains padding columns, by design', () => {
    // The rotated width is srcH, padded up to a byte, and the reverse rotation reads that padded
    // width back — so the result is wider. Documented, not fixed: the app's heights are always
    // round(mm * 8), and the legacy implementation behaves identically.
    const src = fromArt(['#.......', '........', '........', '........']); // 4 lines
    const cw = rotateRaster90CW(src.data, src.widthBytes, src.heightLines);
    const back = rotateRaster90CCW(cw.data, cw.widthBytes, cw.heightLines);
    expect(back.heightLines).toBe(8); // srcW = 8, not 4
    expect(popcount(back.data)).toBe(popcount(src.data)); // no pixel is lost or invented
  });
});
