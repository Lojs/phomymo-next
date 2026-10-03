/** Golden tests for raster conversion and template logic against the original code. */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { pixelsToRaster, type DitherMode, type RasterAlignment } from '../src/core/raster/raster';
import * as T from '../src/core/template/template';
import type { LabelElement } from '../src/core/model/elements';
import { randomRGBA, type Flavor } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
let renderer: any;
let legacyT: any;

beforeAll(async () => {
  // @ts-ignore legacy JS has no types
  const { CanvasRenderer } = await import('./legacy/canvas.js');
  renderer = new CanvasRenderer({ getContext: () => ({}), style: {}, addEventListener() {} });
  // @ts-ignore legacy JS has no types
  legacyT = await import('./legacy/templates.js');
});

describe('pixelsToRaster matches legacy _pixelsToRaster', () => {
  const flavors: Flavor[] = ['bw', 'gray', 'color', 'alpha'];
  const modes: DitherMode[] = ['auto', 'none', 'threshold', 'floyd-steinberg', 'atkinson', 'ordered'];
  const aligns: RasterAlignment[] = ['left', 'center', 'right', false];
  const sizes = [[37, 21], [64, 64], [100, 10], [5, 3], [1000, 2]];

  for (const flavor of flavors) {
    for (const mode of modes) {
      it(`${flavor} / ${mode}`, () => {
        for (const [si, [w, h]] of sizes.entries()) {
          const px = randomRGBA(w, h, si * 31 + 5, flavor);
          for (const align of aligns) {
            const outBytes = Math.ceil(w / 8) + (align ? 5 : 0);
            const expected = renderer._pixelsToRaster(px, w, h, outBytes, align, mode);
            const actual = pixelsToRaster(px, w, h, outBytes, align, mode);
            expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
          }
        }
      });
    }
  }
});

const sample: LabelElement[] = [
  { id: 'a', type: 'text', zone: 0, x: 0, y: 0, width: 10, height: 10, rotation: 0, text: 'Hi {{Name}} on [[date|DD/MM/YYYY]] {{ Missing }}', fontSize: 12, color: 'black', align: 'left', verticalAlign: 'top', fontFamily: 'x', fontWeight: 'normal', fontStyle: 'normal', textDecoration: 'none', background: 'transparent', noWrap: false, clipOverflow: false, autoScale: false },
  { id: 'b', type: 'barcode', zone: 1, x: 0, y: 0, width: 10, height: 10, rotation: 0, barcodeData: '{{Code}}-[[year]]', barcodeFormat: 'CODE128' },
  { id: 'c', type: 'qr', zone: 0, x: 0, y: 0, width: 10, height: 10, rotation: 0, qrData: 'https://x/{{Name}}?t=[[ts]]' },
];

describe('templates match legacy', () => {
  it('extractFields / substituteFields / byZone', () => {
    expect(T.extractFields(sample)).toEqual(legacyT.extractFields(sample));
    const rec = { Name: 'Ali', Code: '42' };
    expect(T.substituteFields(sample, rec)).toEqual(legacyT.substituteFields(sample, rec));
    const zr = [{ Name: 'A', Code: '1' }, undefined];
    expect(T.substituteFieldsByZone(sample, zr)).toEqual(legacyT.substituteFieldsByZone(sample, zr, 2));
  });

  it('evaluateExpressions (frozen clock)', () => {
    vi.useFakeTimers();
    for (const iso of ['2026-01-05T03:04:05', '2026-09-22T15:45:09', '2027-12-31T23:59:59']) {
      vi.setSystemTime(new Date(iso));
      expect(T.evaluateExpressions(sample)).toEqual(legacyT.evaluateExpressions(sample));
    }
    const fmts = ['YYYY-MM-DD HH:mm:ss', 'D/M/YY h:m:s a', 'hh:mm A Z', 'foo'];
    for (const f of fmts) {
      const els = [{ ...sample[0], text: `[[dt|${f}]] [[time]] [[day]] [[unknown]]` }] as LabelElement[];
      expect(T.evaluateExpressions(els)).toEqual(legacyT.evaluateExpressions(els));
    }
    vi.useRealTimers();
  });

  it('parseCSV / toCSV', () => {
    const csv = 'Name,Note\r\nAli,"a, b"\n"Sa""m",x\n\nbad\nLast,"multi word"\n';
    // The legacy parser and this one now disagree on exactly one thing, deliberately: it counted a
    // blank line as a row when building the "Row N" message, so the broken row after a blank line was
    // reported as row 5 when it is physically row 4. This parser reports the real line number. Assert
    // the rest identically, so a future regression anywhere else in the parser still fails here.
    const mine = T.parseCSV(csv);
    const legacy = legacyT.parseCSV(csv);
    expect(mine.headers).toEqual(legacy.headers);
    expect(mine.records).toEqual(legacy.records);
    const stripRow = (e: string) => e.replace(/^Row \d+: /, 'Row N: ');
    expect(mine.errors.map(stripRow)).toEqual(legacy.errors.map(stripRow));
    expect(mine.errors).toEqual(['Row 4: Expected 2 columns, got 1']);
    expect(mine.errors).not.toEqual(legacy.errors);   // and the difference is real, not accidental

    // An empty file: the legacy parser returned `headers: ['']` with no error, which reads as "one
    // column with an empty name" — a successful parse of nothing. This parser reports an empty file,
    // so the import surfaces a real problem instead of silently adding a blank column.
    expect(T.parseCSV('')).toEqual({ headers: [], records: [], errors: ['Empty CSV file'] });
    expect(legacyT.parseCSV('')).toEqual({ headers: [''], records: [], errors: [] });
    const recs = [{ Name: 'a,b', Note: 'q"q' }, { Name: 'x', Note: '' }];
    expect(T.toCSV(['Name', 'Note'], recs)).toEqual(legacyT.toCSV(['Name', 'Note'], recs));
  });
});
