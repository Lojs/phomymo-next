/**
 * N4 from the v1.0.16 review — input hardening that was left half done.
 *
 *  - m04/m110 clamped density but CMD.DENSITY, HEAT_SETTINGS, LINE_SPACING and tsplDensity took the
 *    raw value. A NaN became 0 in the Uint8Array and a value past 255 wrapped round, so any caller
 *    that bypassed storage clamping printed silently wrong instead of failing.
 *  - multiLayout() clamped the zone count but not labelWidth / labelHeight / gap, so a NaN there
 *    produced a NaN layout that passed every later check.
 *  - the PNG/PDF export path (scale 4) had no canvas guard, unlike printing; and no import read a
 *    size limit, so a large file could exhaust the tab with nothing to catch it.
 */
import { describe, it, expect } from 'vitest';
import { encodePrint, type Raster } from '../src/core/protocols/encoders';
import { multiLayout } from '../src/core/render/layout';
import { PrinterRegistry } from '../src/core/printers/definitions';
import { MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE, assertRenderable } from '../src/core/render/label';
import { MAX_IMPORT_BYTES, assertImportable } from '../src/services/actions';

const raster: Raster = { data: new Uint8Array(48 * 10), widthBytes: 48, heightLines: 10 };
const reg = new PrinterRegistry();

/** The last byte of the first `send` op whose bytes start with `prefix`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lastByteOf(ops: any[], prefix: number[]): number | undefined {
  for (const op of ops) {
    if (op.t !== 'send') continue;
    const d = op.data as Uint8Array;
    if (prefix.every((b, i) => d[i] === b)) return d[d.length - 1];
  }
  return undefined;
}

const encode = (device: string, density: number, isBLE = true) =>
  encodePrint(raster, { cfg: reg.resolve(device), isBLE, density, feed: 0, continuous: false });

describe('every single-byte protocol field is bounded', () => {
  it('a NaN density does not become 0 on the wire', () => {
    const density = lastByteOf(encode('M221', NaN), [0x1d, 0x7c]);
    expect(density).toBeGreaterThan(0);
  });

  it('a density past 255 does not wrap round to a low value', () => {
    const density = lastByteOf(encode('M221', 9999), [0x1d, 0x7c]);
    expect(density).toBeLessThanOrEqual(255);
  });

  it('a normal density is untouched, so the golden output is unchanged', () => {
    expect(lastByteOf(encode('M221', 3), [0x1d, 0x7c])).toBe(3);
  });

  it('a TSPL density stays in the 0-15 the printer accepts', () => {
    const ops = encode('PM-241', 999, false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const line = ops.filter((o: any) => o.t === 'send')
      .map((o: any) => new TextDecoder().decode(o.data as Uint8Array))
      .find((s: string) => s.startsWith('DENSITY'));
    const n = Number(line!.split(' ')[1]);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(15);
  });
});

describe('multiLayout bounds the sizes, not just the zone count', () => {
  it('a NaN label width does not produce NaN geometry', () => {
    const l = multiLayout({ labelWidth: NaN, labelHeight: 40, labelsAcross: 2, gapMm: 2 });
    expect(Number.isFinite(l.width)).toBe(true);
    expect(Number.isFinite(l.height)).toBe(true);
    for (const z of l.zones!) {
      expect(Number.isFinite(z.x)).toBe(true);
      expect(Number.isFinite(z.width)).toBe(true);
    }
  });

  it('a NaN height and gap are bounded too', () => {
    const l = multiLayout({ labelWidth: 50, labelHeight: NaN, labelsAcross: 2, gapMm: NaN });
    expect(Number.isFinite(l.width)).toBe(true);
    expect(Number.isFinite(l.height)).toBe(true);
  });

  it('ordinary values are unchanged', () => {
    const l = multiLayout({ labelWidth: 50, labelHeight: 40, labelsAcross: 2, gapMm: 2 });
    expect(l.labelWidth).toBe(400);
    expect(l.zones).toHaveLength(2);
  });
});

describe('the export canvas is guarded like the print canvas', () => {
  it('the guard rejects the sizes the export scale can ask for', () => {
    expect(() => assertRenderable(MAX_CANVAS_SIDE + 1, 100)).toThrow(RangeError);
    expect(() => assertRenderable(8000, MAX_CANVAS_PIXELS / 8000 + 1)).toThrow(RangeError);
  });

  it('a NaN export size is refused rather than allocated', () => {
    expect(() => assertRenderable(NaN, 400)).toThrow(RangeError);
  });
});

describe('imports are size-limited', () => {
  const file = (size: number) => ({ size, name: 'big.png' }) as unknown as File;

  it('refuses a file above the limit, naming the limit', () => {
    expect(() => assertImportable(file(MAX_IMPORT_BYTES + 1))).toThrow(RangeError);
    expect(() => assertImportable(file(MAX_IMPORT_BYTES + 1))).toThrow(/25 MB/);
  });

  it('accepts a file at or below it', () => {
    expect(() => assertImportable(file(MAX_IMPORT_BYTES))).not.toThrow();
    expect(() => assertImportable(file(1024))).not.toThrow();
  });
});