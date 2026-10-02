/**
 * core/render/draw.ts — the pure text-layout and barcode-encoding logic.
 *
 * These functions decide what actually lands on paper: how a string breaks into lines, how large
 * the font ends up, and whether a barcode is encodable at all. They are pure enough to test
 * headlessly with a measuring context stub whose measureText scales with the font size (the real
 * canvas does too, which is what makes the binary search in autoScaleFontSize meaningful).
 */
import { describe, it, expect } from 'vitest';
import { wrapText, autoScaleFontSize, encodeBarcode, DITHER_FILLS, drawElement } from '../src/core/render/draw';
import { createText, createBarcode, createQR, createShape, createImage } from '../src/core/model/elements';

/** A 2D-context stub: records text draws, measures proportionally to the font size. */
function makeCtx(charWidthRatio = 0.6) {
  const calls: { font: string; text: string }[] = [];
  const ctx: any = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    measureText(text: string) {
      const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? '16');
      return { width: text.length * size * charWidthRatio };
    },
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, closePath() {}, rect() {}, arc() {}, ellipse() {},
    moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    clip() {}, fill() {}, stroke() {}, fillRect() {}, strokeRect() {},
    fillText(text: string) { calls.push({ font: ctx.font, text }); },
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    drawImage() {},
    imageSmoothingEnabled: true,
    _calls: calls,
  };
  return ctx;
}

/** Install the browser globals draw.ts reaches for (Image, document.createElement('canvas')). */
function installDomShims() {
  if (!(globalThis as any).Image) {
    (globalThis as any).Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 0;
      set src(_v: string) { /* never loads in this environment */ }
    };
  }
  if (!(globalThis as any).document) {
    (globalThis as any).document = {
      createElement: (tag: string) => (tag === 'canvas'
        ? { width: 0, height: 0, getContext: () => makeCtx() }
        : { style: {} }),
    };
  }
}

/** A context stub whose text width is proportional to the font size, like a real monospace-ish face. */
function measuringCtx(charWidthRatio = 0.6) {
  installDomShims();
  return makeCtx(charWidthRatio);
}

describe('wrapText', () => {
  it('keeps a short string on one line', () => {
    const ctx = measuringCtx();
    expect(wrapText(ctx, 'hello', 200, 16, 'Inter', 'normal', 'normal')).toEqual(['hello']);
  });

  it('breaks a long string across lines at word boundaries', () => {
    const ctx = measuringCtx();
    const lines = wrapText(ctx, 'one two three four', 100, 16, 'Inter', 'normal', 'normal');
    expect(lines.length).toBeGreaterThan(1);
    // No word may be split: every line is a concatenation of whole source words.
    const source = 'one two three four'.split(' ');
    const flat = lines.flatMap((l) => l.split(' '));
    expect(flat).toEqual(source);
  });

  it('preserves explicit newlines as separate lines', () => {
    const ctx = measuringCtx();
    expect(wrapText(ctx, 'a\nb', 200, 16, 'Inter', 'normal', 'normal')).toEqual(['a', 'b']);
  });

  it('turns a blank paragraph into an empty line rather than dropping it', () => {
    const ctx = measuringCtx();
    expect(wrapText(ctx, 'a\n\nb', 200, 16, 'Inter', 'normal', 'normal')).toEqual(['a', '', 'b']);
  });

  it('collapses runs of spaces and tabs into single breaks', () => {
    const ctx = measuringCtx();
    expect(wrapText(ctx, 'a\t\t  b', 200, 16, 'Inter', 'normal', 'normal')).toEqual(['a b']);
  });

  it('never returns an empty array, so callers can index the first line', () => {
    const ctx = measuringCtx();
    expect(wrapText(ctx, '', 200, 16, 'Inter', 'normal', 'normal')).toEqual(['']);
    expect(wrapText(ctx, '   ', 200, 16, 'Inter', 'normal', 'normal')).toEqual(['']);
  });

  it('keeps a word that is itself wider than the box (it cannot be split further)', () => {
    const ctx = measuringCtx();
    const lines = wrapText(ctx, 'supercalifragilistic', 20, 16, 'Inter', 'normal', 'normal');
    expect(lines).toEqual(['supercalifragilistic']);
  });

  it('a wider box produces no more lines than a narrower one', () => {
    const ctx = measuringCtx();
    const text = 'alpha beta gamma delta epsilon';
    const narrow = wrapText(ctx, text, 80, 16, 'Inter', 'normal', 'normal');
    const wide = wrapText(ctx, text, 400, 16, 'Inter', 'normal', 'normal');
    expect(wide.length).toBeLessThanOrEqual(narrow.length);
  });

  it('sets the font on the context before measuring', () => {
    const ctx = measuringCtx();
    wrapText(ctx, 'x', 100, 24, 'Inter', 'bold', 'italic');
    expect(ctx.font).toContain('24px');
    expect(ctx.font).toContain('bold');
    expect(ctx.font).toContain('italic');
  });
});

describe('autoScaleFontSize', () => {
  const box = (over: Record<string, unknown> = {}) => ({ ...createText('Hi', { width: 200, height: 60 }), ...over });

  it('returns a larger size for a taller box', () => {
    const ctx = measuringCtx();
    const small = autoScaleFontSize(ctx, box({ height: 40 }), 200, 40);
    const large = autoScaleFontSize(ctx, box({ height: 200 }), 200, 200);
    expect(large).toBeGreaterThan(small);
  });

  it('returns a larger size for a wider box when width is the binding constraint', () => {
    const ctx = measuringCtx();
    // A long unbreakable word: its width, not the box height, is what limits the size.
    const el = box({ text: 'WWWWWWWWWWWWWWWWWWWWWWWW', noWrap: true, height: 400 });
    const narrow = autoScaleFontSize(ctx, el, 60, 400);
    const wide = autoScaleFontSize(ctx, el, 400, 400);
    expect(wide).toBeGreaterThan(narrow);
  });

  it('a short word in a tall box is limited by height, so width stops mattering', () => {
    const ctx = measuringCtx();
    const el = box({ text: 'Hi' });
    expect(autoScaleFontSize(ctx, el, 400, 60)).toBe(autoScaleFontSize(ctx, el, 60, 60));
  });

  it('the chosen size actually fits the box height', () => {
    const ctx = measuringCtx();
    const el = box();
    const size = autoScaleFontSize(ctx, el, 200, 60);
    const lines = wrapText(ctx, el.text, 200 - 8, size, el.fontFamily, el.fontWeight, el.fontStyle);
    expect(lines.length * size * 1.2).toBeLessThanOrEqual(60 - 8 + 1e-6);
  });

  it('a size one step larger would not fit — the search is tight, not conservative', () => {
    const ctx = measuringCtx();
    const el = box();
    const size = autoScaleFontSize(ctx, el, 200, 60);
    const lines = wrapText(ctx, el.text, 200 - 8, size + 1, el.fontFamily, el.fontWeight, el.fontStyle);
    expect(lines.length * (size + 1) * 1.2).toBeGreaterThan(60 - 8);
  });

  it('never goes below the 6px floor, even in a box too small for any text', () => {
    const ctx = measuringCtx();
    expect(autoScaleFontSize(ctx, box(), 4, 4)).toBe(8); // early return for a non-positive area
    expect(autoScaleFontSize(ctx, box(), 10, 10)).toBeGreaterThanOrEqual(6);
  });

  it('handles a box with no usable inner area without dividing by zero', () => {
    const ctx = measuringCtx();
    expect(() => autoScaleFontSize(ctx, box(), 0, 0)).not.toThrow();
    expect(autoScaleFontSize(ctx, box(), 8, 8)).toBe(8);
  });

  it('noWrap measures the widest line, so a long line shrinks the font', () => {
    const ctx = measuringCtx();
    const wrapped = autoScaleFontSize(ctx, box({ text: 'aaaa bbbb cccc dddd' }), 120, 120);
    const noWrap = autoScaleFontSize(ctx, box({ text: 'aaaa bbbb cccc dddd', noWrap: true }), 120, 120);
    expect(noWrap).toBeLessThanOrEqual(wrapped);
  });

  it('respects explicit newlines in noWrap mode', () => {
    const ctx = measuringCtx();
    const one = autoScaleFontSize(ctx, box({ text: 'a', noWrap: true }), 200, 100);
    const two = autoScaleFontSize(ctx, box({ text: 'a\nb', noWrap: true }), 200, 100);
    expect(two).toBeLessThan(one); // two lines need more height, so the size must drop
  });
});

describe('encodeBarcode', () => {
  it('encodes a valid CODE128 payload as a run of modules', () => {
    const out = encodeBarcode('12345678', 'CODE128');
    expect(out).toBeTruthy();
    expect(out!).toMatch(/^[01]+$/);
  });

  it('encodes the other supported formats', () => {
    expect(encodeBarcode('123456789012', 'EAN13')).toMatch(/^[01]+$/);
    expect(encodeBarcode('ABC-123', 'CODE39')).toMatch(/^[01]+$/);
    expect(encodeBarcode('123456789012', 'UPC')).toMatch(/^[01]+$/);
  });

  it('returns null instead of throwing for data invalid in the chosen format', () => {
    // EAN13 needs exactly 12 (or 13) digits; letters cannot be encoded.
    expect(encodeBarcode('not-digits', 'EAN13')).toBeNull();
    expect(encodeBarcode('123', 'EAN13')).toBeNull();
  });

  it('returns null for an unknown format', () => {
    expect(encodeBarcode('123', 'NOT-A-FORMAT')).toBeNull();
  });

  it('returns null for empty data', () => {
    expect(encodeBarcode('', 'CODE128')).toBeNull();
  });

  it('the same payload always encodes identically (no hidden state)', () => {
    expect(encodeBarcode('SAME', 'CODE128')).toBe(encodeBarcode('SAME', 'CODE128'));
  });

  it('a longer payload produces a longer encoding', () => {
    const short = encodeBarcode('1', 'CODE128')!;
    const long = encodeBarcode('12345678901234567890', 'CODE128')!;
    expect(long.length).toBeGreaterThan(short.length);
  });
});

describe('DITHER_FILLS', () => {
  it('lists every dither fill the shape renderer understands, densest last', () => {
    expect(DITHER_FILLS).toEqual([
      'dither-6', 'dither-12', 'dither-25', 'dither-37', 'dither-50',
      'dither-62', 'dither-75', 'dither-87', 'dither-94',
    ]);
  });
});

describe('drawElement dispatch', () => {
  it('draws each element type without throwing', () => {
    const ctx = measuringCtx();
    const els = [
      createText('t'),
      createBarcode('12345678'),
      createQR('https://example.com'),
      createShape('rectangle'),
      createShape('line'),
      createShape('star'),
      createShape('heart'),
      createShape('check'),
    ];
    for (const el of els) {
      expect(() => drawElement(ctx, el)).not.toThrow();
    }
  });

  it('skips an empty text element rather than drawing nothing-visible', () => {
    const ctx = measuringCtx();
    drawElement(ctx, createText('   '));
    expect(ctx._calls.length).toBe(0);
  });

  it('an image element with no decoded source is skipped, not crashed on', () => {
    const ctx = measuringCtx();
    expect(() => drawElement(ctx, createImage('data:image/png;base64,AAAA'))).not.toThrow();
  });

  it('an empty barcode payload draws nothing', () => {
    const ctx = measuringCtx();
    expect(() => drawElement(ctx, createBarcode(''))).not.toThrow();
  });
});
