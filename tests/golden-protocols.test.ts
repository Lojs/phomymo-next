/**
 * Golden tests: the new encoders must emit exactly the same wire traffic
 * (bytes, delays, waits, progress) as the original printer.js.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { PrinterRegistry, BUILTIN_PRINTERS } from '../src/core/printers/definitions';
import { encodePrint, encodeDensityTest } from '../src/core/protocols/encoders';
import { runOps, type Op } from '../src/core/protocols/ops';
import { randomBytes } from './helpers';

type Rec = string[];

function recorder(rec: Rec) {
  const hex = (d: Uint8Array) => Buffer.from(d).toString('hex');
  return {
    send: async (d: Uint8Array) => void rec.push('send:' + hex(d)),
    delay: async (ms: number) => void rec.push('delay:' + ms),
    waitForResponse: async (ms: number) => void rec.push('wait:' + ms),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let legacy: any;

beforeAll(async () => {
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as any).fetch = async () => ({
    json: async () => JSON.parse(readFileSync(new URL('../src/core/printers/printers.json', import.meta.url), 'utf8')),
  });
  console.log = () => {}; // legacy code is chatty
  // @ts-ignore legacy JS has no types
  legacy = await import('./legacy/printer.js');
  await legacy.loadPrinterDefinitions();
});

const registry = new PrinterRegistry();

const rasters = [
  { widthBytes: 6, heightLines: 37 },
  { widthBytes: 48, heightLines: 30 }, // 1440 bytes: crosses several chunk boundaries
  { widthBytes: 12, heightLines: 96 },
];

async function runNew(ops: Op[]): Promise<Rec> {
  const rec: Rec = [];
  await runOps(recorder(rec), ops, { onProgress: (p) => rec.push('progress:' + p) });
  return rec;
}

describe('encodePrint matches legacy print()', () => {
  const models = ['auto', ...BUILTIN_PRINTERS.map((p) => p.id)];
  const deviceNames = ['', 'M02S', 'D30', 'Q199E', 'PM-241-BT', 'P12 PRO', 'M04S', 'M110S'];

  for (const model of models) {
    for (const deviceName of model === 'auto' ? deviceNames : ['']) {
      for (const isBLE of [true, false]) {
        it(`${model} / "${deviceName}" / ${isBLE ? 'BLE' : 'USB'}`, async () => {
          for (const [ri, dim] of rasters.entries()) {
            for (const [density, feed, continuous] of [
              [6, 32, false],
              [1, 0, false],
              [8, 48, true],
            ] as const) {
              const data = randomBytes(dim.widthBytes * dim.heightLines, ri * 7 + density);
              const raster = { data, ...dim };

              const expected: Rec = [];
              await legacy.print(recorder(expected), raster, {
                isBLE,
                deviceName,
                printerModel: model,
                density,
                feed,
                continuous,
                onProgress: (p: number) => expected.push('progress:' + p),
              });

              const cfg = registry.resolve(deviceName, model);
              const actual = await runNew(encodePrint(raster, { cfg, isBLE, density, feed, continuous }));
              expect(actual).toEqual(expected);
            }
          }
        });
      }
    }
  }
});

describe('encodeDensityTest matches legacy printDensityTest()', () => {
  for (const isBLE of [true, false]) {
    it(isBLE ? 'BLE' : 'USB', async () => {
      const expected: Rec = [];
      await legacy.printDensityTest(recorder(expected), isBLE, (p: number) => expected.push('progress:' + p));
      const actual = await runNew(encodeDensityTest(isBLE));
      expect(actual).toEqual(expected);
    });
  }
});

describe('printer resolution matches legacy', () => {
  const names = ['', 'M02', 'M02S', 'M02 PRO', 'M04S-1234', 'M110', 'M110S', 'M220-AB', 'D30', 'D110', 'Q30S', 'P12PRO', 'A30', 'PM-241-BT', 'Phomemo X', 'zzz'];
  for (const name of names) {
    for (const model of ['auto', 'm220', 'd-series', 'm04s-80', 'pm241', 'p12', 'nope']) {
      it(`${name || '(empty)'} / ${model}`, () => {
        const cfg = registry.resolve(name, model);
        expect(cfg.protocol === 'p12').toBe(legacy.isP12Printer(name, model));
        expect(cfg.protocol === 'm02').toBe(legacy.isM02Printer(name, model));
        expect(cfg.protocol === 'd-series').toBe(legacy.isDSeriesPrinter(name, model));
        expect(cfg.protocol === 'tspl').toBe(legacy.isTSPLPrinter(name, model));
        expect(registry.widthBytes(name, model)).toBe(legacy.getPrinterWidthBytes(name, model));
        expect(cfg.dpi).toBe(legacy.getPrinterDpi(name, model));
      });
    }
  }
});
