// @vitest-environment jsdom
/**
 * fonts.ts — the label font catalogue and system-font discovery.
 *
 * The catalogue is what the inspector offers, and every entry must be usable: a duplicate value
 * would make two menu rows select the same font, and a value whose family does not match its
 * label would show the wrong name on the label.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LABEL_FONTS, isLocalFontAccessAvailable, queryLocalFontFamilies } from '../src/fonts';

describe('the font catalogue', () => {
  it('is non-empty', () => {
    expect(LABEL_FONTS.length).toBeGreaterThan(0);
  });

  it('has no duplicate css values, which would make two menu rows pick the same font', () => {
    const values = LABEL_FONTS.map((f) => f.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('has no duplicate labels', () => {
    const labels = LABEL_FONTS.map((f) => f.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('every entry names a real font family and a generic fallback', () => {
    for (const f of LABEL_FONTS) {
      expect(f.value, `${f.label} has no family`).toMatch(/\S/);
      // A trailing generic family means text still renders if the webfont fails to load.
      expect(f.value, `${f.label} has no generic fallback`).toMatch(/,\s*(sans-serif|serif|monospace|cursive)$/);
    }
  });

  it('the label matches the leading family name, allowing a shortened display name', () => {
    // Most entries use the family name verbatim. "Comic Sans MS" is the only one shown under a
    // shorter label ("Comic Sans"), which is a deliberate display choice, not a mismatch.
    const shortened: Record<string, string> = { 'Comic Sans': 'Comic Sans MS' };
    for (const f of LABEL_FONTS) {
      const first = f.value.split(',')[0].trim();
      const expected = shortened[f.label] ?? f.label;
      expect(first, `${f.label} label does not match its family`).toBe(expected);
    }
  });

  it('every entry belongs to a known group', () => {
    const groups = new Set(['sans', 'serif', 'mono', 'display', 'arabic']);
    for (const f of LABEL_FONTS) expect(groups.has(f.group), `${f.label}: ${f.group}`).toBe(true);
  });

  it('offers Arabic faces, since the app is Arabic-first', () => {
    const arabic = LABEL_FONTS.filter((f) => f.group === 'arabic');
    expect(arabic.length).toBeGreaterThanOrEqual(3);
    for (const f of arabic) expect(f.value).toMatch(/Arabic|Cairo|Tajawal|Amiri/);
  });

  it('covers all five groups', () => {
    const groups = new Set(LABEL_FONTS.map((f) => f.group));
    expect([...groups].sort()).toEqual(['arabic', 'display', 'mono', 'sans', 'serif']);
  });
});

describe('system font access', () => {
  beforeEach(() => {
    delete (window as { queryLocalFonts?: unknown }).queryLocalFonts;
  });

  it('reports unavailable when the browser has no Local Font Access API', () => {
    expect(isLocalFontAccessAvailable()).toBe(false);
  });

  it('reports available when the API exists', () => {
    (window as unknown as { queryLocalFonts: () => Promise<unknown[]> }).queryLocalFonts = async () => [];
    expect(isLocalFontAccessAvailable()).toBe(true);
  });

  it('returns sorted, de-duplicated family names', async () => {
    (window as unknown as { queryLocalFonts: () => Promise<{ family: string }[]> }).queryLocalFonts = async () => [
      { family: 'Zeta' },
      { family: 'Alpha' },
      { family: 'Alpha' }, // a face and its bold share a family
      { family: 'Mid' },
    ];
    expect(await queryLocalFontFamilies()).toEqual(['Alpha', 'Mid', 'Zeta']);
  });

  it('propagates a denied permission rather than pretending there are no fonts', async () => {
    (window as unknown as { queryLocalFonts: () => Promise<never> }).queryLocalFonts = async () => {
      throw new DOMException('Permission denied', 'SecurityError');
    };
    await expect(queryLocalFontFamilies()).rejects.toThrow(/denied/i);
  });

  it('handles an empty font list', async () => {
    (window as unknown as { queryLocalFonts: () => Promise<never[]> }).queryLocalFonts = async () => [];
    expect(await queryLocalFontFamilies()).toEqual([]);
  });
});
