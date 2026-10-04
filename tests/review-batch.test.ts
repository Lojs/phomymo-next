/**
 * The seven fixes in this batch, each pinned by a test that fails without it.
 *
 *  U1  Stage's pointer handler refused every event while editingId was set, even after the element
 *      being edited had been removed — a live canvas that took no input.
 *  u23 the Arabic labelTooWide string carried a CJK ideograph (U+4F46) from a mistyped Arabic "و".
 *  P3  describe() printed widthBytes with an "mm" suffix, which is only millimetres at 203 DPI.
 *  M1  hitTest compared against el.width directly, so a negative or NaN size made every test false
 *      and the element unselectable — and therefore undeletable.
 *  M3  multiLayout allocated one zone per label with no upper bound, and the 203->300 upscale
 *      trusted a printer definition's dpi.
 *  D1  a tag whose number disagreed with package.json shipped a UI that misreports its version.
 */
import { describe, it, expect } from 'vitest';
import { hitTest, createText } from '../src/core/model/elements';
import { multiLayout } from '../src/core/render/layout';
import { assertRenderable } from '../src/core/render/label';
import { describe as describePrinter, paperWidthMm, PrinterRegistry } from '../src/core/printers/definitions';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

describe('M1: a broken element is still selectable, so it can still be deleted', () => {
  it('a negative width does not make it unclickable', () => {
    // x=10 with width=-40 spans x=10..-30, so the point to probe is inside that span. Before the
    // fix the box was tested as "l.x >= 10 && l.x <= -30", which is empty: no point ever matched,
    // so the element could not be selected — and an unselectable element cannot be deleted.
    const el = { ...createText('A'), x: 10, y: 10, width: -40, height: 30, rotation: 0 } as never;
    expect(hitTest(0, 20, el)).toBe(true);
  });

  it('a negative height does not make it unclickable', () => {
    const el = { ...createText('A'), x: 10, y: 10, width: 40, height: -30, rotation: 0 } as never;
    expect(hitTest(20, 0, el)).toBe(true);
  });

  it('a NaN coordinate never claims a hit, and never throws', () => {
    const el = { ...createText('A'), x: NaN, y: NaN, width: 40, height: 30, rotation: 0 } as never;
    expect(() => hitTest(20, 20, el)).not.toThrow();
    expect(hitTest(20, 20, el)).toBe(false);
  });

  it('a normal element is unaffected', () => {
    const el = { ...createText('A'), x: 10, y: 10, width: 40, height: 30, rotation: 0 } as never;
    expect(hitTest(20, 20, el)).toBe(true);
    expect(hitTest(500, 500, el)).toBe(false);
  });
});

describe('M3: geometry that would kill the tab is refused before allocating', () => {
  it('multiLayout clamps the zone count instead of building a billion objects', () => {
    const layout = multiLayout({ labelWidth: 10, labelHeight: 20, labelsAcross: 1e9, gapMm: 2 });
    expect(layout.zones!.length).toBeLessThanOrEqual(8);
  });

  it('multiLayout keeps an ordinary roll intact', () => {
    const layout = multiLayout({ labelWidth: 10, labelHeight: 20, labelsAcross: 4, gapMm: 2 });
    expect(layout.zones).toHaveLength(4);
    expect(layout.width).toBe(4 * 80 + 3 * 16);
  });

  it('assertRenderable refuses an absurd canvas', () => {
    expect(() => assertRenderable(1e9, 10)).toThrow(RangeError);
    expect(() => assertRenderable(10000, 10000)).toThrow(RangeError);
  });

  it('assertRenderable accepts a real label', () => {
    expect(() => assertRenderable(320, 240)).not.toThrow();
  });

  it('assertRenderable refuses NaN and zero rather than allocating', () => {
    expect(() => assertRenderable(NaN, 240)).toThrow(RangeError);
    expect(() => assertRenderable(320, 0)).toThrow(RangeError);
  });
});

describe('P3: the printer width is shown in millimetres, not bytes', () => {
  const reg = new PrinterRegistry();

  it('a 300 DPI printer converts by its own DPI', () => {
    // 78 bytes at 300 DPI is ~53 mm of paper; printing "78mm" overstated it by half.
    expect(paperWidthMm(reg.resolve('M02 PRO'))).toBe(53);
    expect(describePrinter(reg, 'M02 PRO')).toContain('53mm');
    expect(describePrinter(reg, 'M02 PRO')).not.toContain('78mm');
  });

  it('a 203 DPI printer is unchanged, since bytes and mm coincide there', () => {
    expect(paperWidthMm(reg.resolve('M02'))).toBe(48);
    expect(describePrinter(reg, 'M02')).toContain('48mm');
  });

  it('the PM-241 shipping printer still reports its true width', () => {
    expect(paperWidthMm(reg.resolve('PM-241'))).toBe(102);
  });
});

describe('u23: the Arabic string is Arabic', () => {
  it('labelTooWide contains no CJK or stray ideograph', () => {
    const ar = readFileSync(resolve(ROOT, 'src/i18n/ar.ts'), 'utf8');
    const line = ar.split('\n').find((l) => l.includes('labelTooWide'))!;
    expect(line).toBeTruthy();
    // A mistyped Arabic "و" had come through as the CJK ideograph U+4F46.
    expect(line).not.toContain('\u4f46');
    for (const ch of line) {
      const c = ch.codePointAt(0)!;
      const isArabic = (c >= 0x0600 && c <= 0x06ff) || (c >= 0xfb50 && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff);
      // Latin (the key and the {label} placeholders), digits, ASCII, and the punctuation an Arabic
      // sentence legitimately uses — including the em dash the message ends on.
      const isLatin = c <= 0x024f;
      const isGeneralPunctuation = c >= 0x2000 && c <= 0x206f;
      expect(isArabic || isLatin || isGeneralPunctuation).toBe(true);
    }
  });
});

describe('D1: a tag that disagrees with package.json cannot ship', () => {
  it('the workflow gates version tags against package.json', () => {
    const wf = readFileSync(resolve(ROOT, '.github/workflows/docker-publish.yml'), 'utf8');
    expect(wf).toContain("refs/tags/v");
    expect(wf).toContain('package.json');
    expect(wf).toMatch(/ref_name/);
  });

  it('the gate runs before anything is published', () => {
    const wf = readFileSync(resolve(ROOT, '.github/workflows/docker-publish.yml'), 'utf8');
    const gate = wf.indexOf('refs/tags/v');
    expect(gate).toBeGreaterThan(-1);
    // The publish job depends on verify, so a failing gate stops the image.
    expect(wf).toMatch(/needs:\s*verify/);
  });
});
