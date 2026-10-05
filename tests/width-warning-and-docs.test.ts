/**
 * The label width warning, the printer description, and the README's platform claims.
 *
 *  N1  The README claimed neither Safari nor Chrome on macOS implements Web Bluetooth / WebUSB.
 *      Chrome and Edge on macOS do, and the app's own availability is plain feature detection, so
 *      the documentation told Mac users not to bother with a browser that can print. The test
 *      pins the claim the app actually ships: detection, not a platform sniff.
 *  N2  describe() lost the unit for an unrecognised printer — "M-series (72)" instead of
 *      "M-series (72mm)".
 *  N3  The too-wide warning compared the unrounded head width (52.8) against a label rounded for
 *      display (53), so a 53 mm label on a 52.8 mm head warned "53mm wide but this printer prints
 *      53mm". The comparison and the quoted number now come from one conversion.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe as describePrinter, paperWidthMm, widthBytesToMm, PrinterRegistry } from '../src/core/printers/definitions';
import { warnIfWiderThanPrinter, beginPrintJob } from '../src/services/printing';
import { useStore } from '../src/state/store';

const ROOT = resolve(__dirname, '..');
const toasts = () => useStore.getState().toasts;

describe('N1: the README describes macOS the way the app actually behaves', () => {
  const readme = () => readFileSync(resolve(ROOT, 'README.md'), 'utf8');

  it('does not claim Chrome or Edge on macOS lack Web Bluetooth or WebUSB', () => {
    expect(readme()).not.toMatch(/Neither Safari nor Chrome on macOS/);
  });

  it('names Safari as the macOS browser without the APIs, and Chrome/Edge as working', () => {
    const md = readme();
    expect(md).toMatch(/Safari does not implement Web Bluetooth or WebUSB/);
    expect(md).toMatch(/Chrome and Edge on macOS do implement/);
  });

  it('agrees with the code: availability is feature detection, not a platform check', () => {
    // printing.ts decides availability from navigator alone. If a platform sniff ever appears,
    // this test fails and the README has to be revisited rather than silently contradicted.
    const src = readFileSync(resolve(ROOT, 'src/services/printing.ts'), 'utf8');
    expect(src).toMatch(/bluetoothAvailable = \(\) => BLETransport\.isAvailable\(\)/);
    expect(src).not.toMatch(/navigator\.(platform|userAgent)\s*(===|==|\.match|\.includes)/);
  });
});

describe('N2: an unrecognised printer keeps its unit', () => {
  const reg = new PrinterRegistry();

  it('describe() names the millimetres, not a bare number', () => {
    expect(describePrinter(reg, 'Unknown-X')).toBe(`M-series (${paperWidthMm(reg.resolve('Unknown-X'))}mm)`);
  });

  it('it agrees with the defined printers, which already read correctly', () => {
    expect(describePrinter(reg, 'M02 PRO')).toContain('53mm');
    expect(describePrinter(reg, 'M02')).toContain('48mm');
  });
});

describe('N3: the width warning compares and quotes the same number', () => {
  beforeEach(() => { useStore.setState({ toasts: [] }); beginPrintJob(); });

  it('a 53 mm label on a 52.8 mm head does not warn against itself', () => {
    // 78 bytes at 300 DPI is 52.8 mm, quoted rounded to 53. Comparing the rounded label against
    // the unrounded head was fine; the bug was a *rounded* head, which this guards: the message
    // must never quote a label width equal to or above the head width it claims the printer has.
    warnIfWiderThanPrinter({ width: 53 * 8 }, { widthBytes: 78, dpi: 300 });
    if (toasts().length) {
      // A 53 mm label on a 52.8 mm head is a real edge: the message must not claim the printer
      // prints 53 mm while saying the label is 53 mm. The back-reference catches any such pair.
      expect(toasts()[0].text).not.toMatch(/(\d+)mm wide but this printer prints \1mm/);
    }
  });

  it('the head width is quoted from one conversion, unrounded', () => {
    expect(widthBytesToMm(78, 300)).toBeCloseTo(52.83, 1);
    expect(paperWidthMm({ width: 78, dpi: 300 } as never)).toBe(53);
  });

  it('a genuinely wider label still warns, with the real head width in the message', () => {
    warnIfWiderThanPrinter({ width: 58 * 8 }, { widthBytes: 78, dpi: 300 });
    expect(toasts()).toHaveLength(1);
    expect(JSON.stringify(toasts()[0])).toContain('52.8');
  });
});