/**
 * Encoder bounds, from a code review of v1.0.12.
 *
 *  FEED is a single byte on the wire. `u8(0x1b, 0x4a, dots)` let Uint8Array wrap a value over
 *  255, so a feed of 300 arrived as 44 — a shorter feed than asked for, with no error anywhere.
 *
 *  The raster header carries widthBytes and heightLines as 16-bit little-endian. Its high byte
 *  was hardcoded 0x00, so a label taller than 255 lines reported a wrong row count on the wire.
 *
 *  The m04/m110 density maps and densityToHeatTime are only meaningful for the 1-8 the UI
 *  offers. A NaN density indexed the heat table with NaN and produced undefined, which became
 *  NaN in the header byte.
 */
import { describe, it, expect } from 'vitest';
import { encodePrint, densityToHeatTime } from '../src/core/protocols/encoders';
import { PrinterRegistry } from '../src/core/printers/definitions';
import { runOps, type Op } from '../src/core/protocols/ops';

const registry = new PrinterRegistry();

async function wire(ops: Op[]): Promise<Uint8Array> {
  const chunks: number[] = [];
  await runOps(
    { send: async (d) => void chunks.push(...d), delay: async () => {}, waitForResponse: async () => null },
    ops,
  );
  return Uint8Array.from(chunks);
}

const raster = { data: new Uint8Array(40 * 10).fill(0), widthBytes: 40, heightLines: 10 };
const print = (device: string, over: Partial<Parameters<typeof encodePrint>[1]> = {}) =>
  wire(encodePrint(raster, { cfg: registry.resolve(device), isBLE: true, density: 6, feed: 32, continuous: false, ...over }));

/** Byte offset of the first 1d 76 sequence (the raster header marker). */
function headerAt(b: Uint8Array): number {
  for (let i = 0; i < b.length - 1; i++) if (b[i] === 0x1d && b[i + 1] === 0x76) return i;
  return -1;
}

describe('FEED is clamped to the single byte the wire carries', () => {
  it('a feed over 255 no longer wraps', async () => {
    const b = await print('M221', { feed: 300 });
    // 300 % 256 = 44 would have been the wrapped byte.
    for (let i = 0; i < b.length - 2; i++) {
      if (b[i] === 0x1b && b[i + 1] === 0x4a) expect(b[i + 2]).toBe(255);
    }
  });

  it('a feed inside the range reaches the wire unchanged', async () => {
    const b = await print('M221', { feed: 32 });
    let found = false;
    for (let i = 0; i < b.length - 2; i++) {
      if (b[i] === 0x1b && b[i + 1] === 0x4a) { expect(b[i + 2]).toBe(32); found = true; }
    }
    expect(found).toBe(true);
  });

  it('a negative feed does not wrap to a large byte', async () => {
    const b = await print('M221', { feed: -5 });
    for (let i = 0; i < b.length - 2; i++) {
      if (b[i] === 0x1b && b[i + 1] === 0x4a) expect(b[i + 2]).toBe(0);
    }
  });
});

describe('the raster header uses 16-bit dimensions', () => {
  it('a row count over 255 sets the high byte', async () => {
    const tall = { data: new Uint8Array(10 * 300), widthBytes: 10, heightLines: 300 };
    const b = await wire(encodePrint(tall, {
      cfg: registry.resolve('M221'), isBLE: true, density: 6, feed: 32, continuous: false,
    }));
    const at = headerAt(b);
    expect(at).toBeGreaterThan(-1);
    // 1d 76 30 00 | wLo wHi | hLo hHi   — offsets from the marker at `at`.
    expect(b[at + 4]).toBe(10);      // width low byte
    expect(b[at + 6]).toBe(300 % 256);  // height low byte
    expect(b[at + 7]).toBe(1);       // 300 = 0x012C; the high byte used to be hardcoded 0
  });

  it('an ordinary height leaves the high byte at zero', async () => {
    const b = await print('M221');
    const at = headerAt(b);
    expect(at).toBeGreaterThan(-1);
    expect(b[at + 7]).toBe(0);       // 240 rows fits in the low byte
  });
});

describe('density is bounded everywhere it is used', () => {
  it('densityToHeatTime returns a finite value for any input', () => {
    for (const d of [-5, 0, 1, 4, 8, 99, NaN, Infinity, -Infinity]) {
      const t = densityToHeatTime(d);
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThan(0);
    }
  });

  it('a NaN density does not put NaN on the wire', async () => {
    const b = await print('M221', { density: NaN });
    expect(b.length).toBeGreaterThan(0);
    // Every byte is a Uint8, so NaN cannot appear — but the header must still be well-formed.
    expect(headerAt(b)).toBeGreaterThan(-1);
  });

  it('an out-of-range density does not throw in the m04 or m110 encoders', async () => {
    for (const model of ['M04S', 'M110']) {
      await expect(wire(encodePrint(raster, {
        cfg: registry.resolve(model), isBLE: true, density: 99, feed: 32, continuous: false,
      }))).resolves.toBeDefined();
    }
  });
});
