/**
 * Print protocol encoders for Phomemo printers.
 *
 * Every function here is a faithful port of the original Phomymo protocol
 * code (which was verified on real hardware) but returns a list of Ops
 * instead of talking to a transport. Delays, chunk sizes and command bytes
 * are intentionally unchanged.
 */
import type { Op } from './ops';
import type { ResolvedConfig } from '../printers/definitions';
import { isDSeries, isTspl } from '../printers/definitions';
import { rotateRaster90CW } from '../raster/rotate';

export interface Raster {
  data: Uint8Array;
  widthBytes: number;
  heightLines: number;
}

export interface EncodeOptions {
  cfg: ResolvedConfig;
  isBLE: boolean;
  /** 1–8 */
  density: number;
  /** dots */
  feed: number;
  continuous: boolean;
}

const enc = new TextEncoder();
const u8 = (...b: number[]) => new Uint8Array(b);
const send = (data: Uint8Array): Op => ({ t: 'send', data });
const delay = (ms: number): Op => ({ t: 'delay', ms });

// ---- command builders -------------------------------------------------------

/**
 * Density 1–8 → heat time (higher = darker).
 *
 * The index is clamped, and a non-finite density falls back to the middle of the range. Without
 * the NaN case, `heatTimes[NaN]` is undefined, which reached HEAT_SETTINGS and became NaN in the
 * header byte — the printer would have received an undefined heat time.
 */
export function densityToHeatTime(density: number): number {
  const heatTimes = [40, 60, 80, 100, 120, 140, 160, 200];
  if (!Number.isFinite(density)) return heatTimes[4];
  return heatTimes[Math.max(0, Math.min(7, Math.round(density) - 1))];
}

const dims16 = (widthBytes: number, rows: number) => [
  widthBytes % 256,
  Math.floor(widthBytes / 256),
  rows % 256,
  Math.floor(rows / 256),
];

const CMD = {
  INIT: u8(0x1b, 0x40),
  // Feed is a single byte on the wire: clamp instead of letting Uint8Array wrap (feed > 255).
  FEED: (dots: number) => u8(0x1b, 0x4a, Math.max(0, Math.min(255, Math.round(dots)))),
  // Density is one byte too. A NaN here became 0 in the Uint8Array and a value past 255 wrapped
  // round, so a level that bypassed storage clamping (a test, a future path) printed silently wrong.
  //
  // A non-finite level falls back to DEFAULT_DENSITY, not to clampByte's mid-byte 128: the valid
  // domain here is the small 1-8 the UI offers, so 128 is not the middle of anything — it is just a
  // large out-of-range command. That also makes the fallback agree with densityToHeatTime(), which
  // already resolves a bad density to the middle of its own range.
  DENSITY: (level: number) => u8(0x1d, 0x7c, clampByte(level, DEFAULT_DENSITY)),
  HEAT_SETTINGS: (maxDots: number, heatTime: number, heatInterval: number) =>
    u8(0x1b, 0x37, clampByte(maxDots), clampByte(heatTime), clampByte(heatInterval)),
  LINE_SPACING: (dots: number) => u8(0x1b, 0x33, clampByte(dots)),
  RASTER_HEADER: (widthBytes: number, heightLines: number) =>
    u8(0x1d, 0x76, 0x30, 0x00, ...dims16(widthBytes, heightLines)),
};

/**
 * One unsigned byte, rounded and bounded.
 *
 * `fallback` is what a non-finite input becomes. It defaults to 128, the middle of the byte domain,
 * which is right for a field whose whole range is 0-255 but wrong for one whose range is 1-8 —
 * hence DENSITY passing DEFAULT_DENSITY. Never returns 0: a NaN that lands at 0 is a silent "off"
 * command where the caller meant "unknown".
 */
function clampByte(v: number, fallback = 128): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** The density the UI opens with, and the fallback for a value that is not a number. */
const DEFAULT_DENSITY = 5;

const M02_PREFIX = u8(0x10, 0xff, 0xfe, 0x01);

const D_HEADER = (widthBytes: number, rows: number) =>
  u8(0x1b, 0x40, 0x1d, 0x76, 0x30, 0x00, ...dims16(widthBytes, rows));
const D_END = u8(0x1b, 0x64, 0x00);

const M110 = {
  SPEED: (s: number) => u8(0x1b, 0x4e, 0x0d, s),
  DENSITY: (d: number) => u8(0x1b, 0x4e, 0x04, d),
  MEDIA_TYPE: (t: number) => u8(0x1f, 0x11, t),
  FOOTER: u8(0x1f, 0xf0, 0x05, 0x00, 0x1f, 0xf0, 0x03, 0x00),
};

const M04 = {
  DENSITY: (l: number) => u8(0x1f, 0x11, 0x02, l),
  HEAT: (p: number) => u8(0x1f, 0x11, 0x37, p),
  INIT: u8(0x1f, 0x11, 0x0b),
  COMPRESSION: (m: number) => u8(0x1f, 0x11, 0x35, m),
  RASTER_HEADER: (widthBytes: number, rows: number) => u8(0x1d, 0x76, 0x30, 0x00, ...dims16(widthBytes, rows)),
  FEED: u8(0x1b, 0x64, 0x02),
};

const P12 = {
  INIT_SEQUENCE: [
    u8(0x1f, 0x11, 0x38),
    u8(0x1f, 0x11, 0x11, 0x1f, 0x11, 0x12, 0x1f, 0x11, 0x09, 0x1f, 0x11, 0x13),
    u8(0x1f, 0x11, 0x09),
    u8(0x1f, 0x11, 0x19, 0x1f, 0x11, 0x11),
    u8(0x1f, 0x11, 0x19),
    u8(0x1f, 0x11, 0x07),
  ],
  FEED: u8(0x1b, 0x64, 0x0d),
};

const tspl = (s: string) => enc.encode(`${s}\r\n`);

// ---- shared chunk streaming -------------------------------------------------

function streamChunks(ops: Op[], data: Uint8Array, chunkSize: number, chunkDelay: number): void {
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.slice(i, Math.min(i + chunkSize, data.length));
    ops.push(send(chunk), delay(chunkDelay), {
      t: 'progress',
      pct: Math.round(((i + chunk.length) / data.length) * 100),
    });
  }
}

// ---- protocols ----------------------------------------------------------------

function dSeries(r: Raster, density: number, continuous: boolean, feed: number): Op[] {
  const ops: Op[] = [];
  const rotated = rotateRaster90CW(r.data, r.widthBytes, r.heightLines);

  // Continuous tape ignores ESC J feed, so blank rows are baked into the image.
  let printData = rotated.data;
  let printRows = rotated.heightLines;
  if (continuous && feed > 0) {
    const cutterOffset = 56; // ~7 mm head-to-cutter distance at 203 DPI
    const paddingRows = cutterOffset + feed;
    const padded = new Uint8Array(rotated.data.length + paddingRows * rotated.widthBytes);
    padded.set(rotated.data);
    printData = padded;
    printRows = rotated.heightLines + paddingRows;
  }

  ops.push(send(CMD.HEAT_SETTINGS(7, densityToHeatTime(density), 2)), delay(30));
  ops.push(send(u8(0x1f, 0x11, continuous ? 0x0b : 0x0a)), delay(30));
  ops.push(send(D_HEADER(rotated.widthBytes, printRows)));
  streamChunks(ops, printData, 128, 20);
  ops.push(delay(100), send(D_END));
  return ops;
}

function p12(r: Raster): Op[] {
  const ops: Op[] = [];
  const rotated = rotateRaster90CW(r.data, r.widthBytes, r.heightLines);
  for (const cmd of P12.INIT_SEQUENCE) ops.push(send(cmd), { t: 'wait', ms: 500 });
  ops.push(send(D_HEADER(rotated.widthBytes, rotated.heightLines)));
  streamChunks(ops, rotated.data, 128, 20);
  ops.push(delay(100), send(P12.FEED), delay(50), send(P12.FEED));
  return ops;
}

function m02(r: Raster, density: number): Op[] {
  const ops: Op[] = [];
  ops.push(send(M02_PREFIX), delay(50));
  ops.push(send(CMD.INIT), delay(100));
  ops.push(send(CMD.HEAT_SETTINGS(7, densityToHeatTime(density), 2)), delay(30));
  ops.push(send(CMD.RASTER_HEADER(r.widthBytes, r.heightLines)));
  streamChunks(ops, r.data, 128, 20);
  ops.push(delay(300), send(CMD.FEED(8)), delay(500));
  return ops;
}

function m04(r: Raster, density: number, feed: number): Op[] {
  const ops: Op[] = [];
  // The heat/density maps below are only meaningful for the 1-8 the UI offers. A value outside
  // that range produced a heat time past the table's end rather than an obvious error.
  const d = Math.max(1, Math.min(8, Math.round(density)));
  const m04Density = Math.round((d / 8) * 15);
  const m04Heat = Math.round(100 + ((d - 1) * 50) / 3);
  ops.push(send(M04.DENSITY(m04Density)), delay(30));
  ops.push(send(M04.HEAT(m04Heat)), delay(30));
  ops.push(send(M04.INIT), delay(30));
  ops.push(send(M04.COMPRESSION(0x00)), delay(30));
  ops.push(send(M04.RASTER_HEADER(r.widthBytes, r.heightLines)));
  streamChunks(ops, r.data, 256, 20);
  ops.push(delay(300));
  const feedCount = Math.max(1, Math.round(feed / 16));
  for (let i = 0; i < feedCount; i++) ops.push(send(M04.FEED), delay(30));
  ops.push(delay(500));
  return ops;
}

function m110(r: Raster, density: number): Op[] {
  const ops: Op[] = [];
  const d = Math.max(1, Math.min(8, Math.round(density)));
  const m110Density = Math.round(5 + d * 1.25);
  ops.push(send(M110.SPEED(5)), delay(30));
  ops.push(send(M110.DENSITY(m110Density)), delay(30));
  ops.push(send(M110.MEDIA_TYPE(10)), delay(30));
  ops.push(send(CMD.RASTER_HEADER(r.widthBytes, r.heightLines)));
  streamChunks(ops, r.data, 128, 20);
  ops.push(delay(300), send(M110.FOOTER), delay(500));
  return ops;
}

function mSeriesBle(r: Raster, density: number, feed: number): Op[] {
  const ops: Op[] = [];
  ops.push(send(CMD.INIT), delay(100));
  ops.push(send(CMD.HEAT_SETTINGS(7, densityToHeatTime(density), 2)), delay(30));
  ops.push(send(CMD.DENSITY(density)), delay(50));
  ops.push(send(CMD.RASTER_HEADER(r.widthBytes, r.heightLines)));
  streamChunks(ops, r.data, 128, 20);
  ops.push(delay(300), send(CMD.FEED(feed)), delay(800));
  return ops;
}

function mSeriesUsb(r: Raster, density: number, feed: number): Op[] {
  const ops: Op[] = [];
  ops.push(send(CMD.INIT), delay(100));
  ops.push(send(CMD.DENSITY(density)));
  ops.push(send(CMD.LINE_SPACING(0)));
  ops.push(send(CMD.FEED(0x0c)), delay(50));
  ops.push(send(CMD.RASTER_HEADER(r.widthBytes, r.heightLines)));
  streamChunks(ops, r.data, 512, 20);
  ops.push(delay(100), send(CMD.FEED(feed)));
  return ops;
}

function tsplPrint(r: Raster, density: number): Op[] {
  const ops: Op[] = [];
  const labelWidthMm = Math.round((r.widthBytes * 8) / 8); // 8 dots/mm at 203 DPI
  const labelHeightMm = Math.round(r.heightLines / 8);
  const tsplDensity = Math.max(0, Math.min(15, Math.round((density / 8) * 15)));

  ops.push(send(tspl(`SIZE ${labelWidthMm} mm, ${labelHeightMm} mm`)), delay(50));
  ops.push(send(tspl('GAP 3 mm, 0 mm')), delay(50));
  ops.push(send(tspl('OFFSET -3 mm')), delay(50));
  ops.push(send(tspl(`DENSITY ${tsplDensity}`)), delay(50));
  ops.push(send(tspl('SPEED 4')), delay(50));
  ops.push(send(tspl('DIRECTION 0')), delay(50));
  ops.push(send(tspl('CLS')), delay(50));
  ops.push(send(enc.encode(`BITMAP 0,0,${r.widthBytes},${r.heightLines},0,`)));

  // TSPL expects 0 = black, 1 = white (inverse of our raster).
  const inverted = new Uint8Array(r.data.length);
  for (let i = 0; i < r.data.length; i++) inverted[i] = r.data[i] ^ 0xff;
  streamChunks(ops, inverted, 512, 10);

  ops.push(send(enc.encode('\r\n')), delay(50));
  ops.push(send(tspl('PRINT 1')), delay(50));
  ops.push(send(tspl('END')));
  return ops;
}

/** Pick the protocol for the resolved printer and encode the whole job. */
export function encodePrint(raster: Raster, o: EncodeOptions): Op[] {
  const { cfg, isBLE, density, feed, continuous } = o;
  if (isTspl(cfg)) return tsplPrint(raster, density);
  if (cfg.protocol === 'p12' && isBLE) return p12(raster);
  if (isDSeries(cfg) && isBLE) return dSeries(raster, density, continuous, feed);
  if (cfg.protocol === 'm02' && isBLE) return m02(raster, density);
  if (cfg.protocol === 'm04' && isBLE) return m04(raster, density, feed);
  if (cfg.protocol === 'm110' && isBLE) return m110(raster, density);
  if (isBLE) return mSeriesBle(raster, density, feed);
  return mSeriesUsb(raster, density, feed);
}

/** 8 solid strips at density 1–8, to check the heat setting works on a given printer. */
export function encodeDensityTest(isBLE = true): Op[] {
  const ops: Op[] = [];
  const stripHeight = 30;
  const widthBytes = 320 / 8;
  const gap = 8;

  for (let density = 1; density <= 8; density++) {
    ops.push({ t: 'progress', pct: Math.round(((density - 1) / 8) * 100) });
    const strip = new Uint8Array(widthBytes * stripHeight).fill(0xff);
    ops.push(send(CMD.INIT), delay(50));
    ops.push(send(CMD.HEAT_SETTINGS(7, densityToHeatTime(density), 2)), delay(30));
    ops.push(send(CMD.DENSITY(density)), delay(30));
    ops.push(send(CMD.RASTER_HEADER(widthBytes, stripHeight)));
    const chunkSize = isBLE ? 128 : 512;
    for (let i = 0; i < strip.length; i += chunkSize) {
      ops.push(send(strip.slice(i, Math.min(i + chunkSize, strip.length))), delay(isBLE ? 20 : 10));
    }
    if (density < 8) ops.push(delay(200), send(CMD.FEED(gap)), delay(300));
  }
  ops.push(delay(300), send(CMD.FEED(48)), delay(500), { t: 'progress', pct: 100 });
  return ops;
}
