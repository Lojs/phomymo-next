// @vitest-environment jsdom
/**
 * The import boundary: what a design file is allowed to contain, and what the app does when it does
 * not fit.
 *
 * A design file is the one place untrusted, hand-editable data enters the app, and everything that is
 * accepted here reaches the rasteriser or the printer. Accepting a structurally-plausible value with
 * the wrong shape produces failures far from their cause — "NaN" printed onto a label, or an import
 * that reports success and silently loses the multi-label roll the file asked for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseDesignJSON, exportDesignJSON } from '../src/core/storage/storage';
import { createText } from '../src/core/model/elements';
import * as actions from '../src/services/actions';
import { useStore } from '../src/state/store';

beforeEach(() => { localStorage.clear(); useStore.getState().newDesign(); });

const base = { elements: [{ ...createText('A') }], labelSize: { width: 40, height: 30 } };
const withExtra = (extra: Record<string, unknown>) => JSON.stringify({ ...base, ...extra });

describe('multiLabel is validated, not assumed', () => {
  it('accepts a well-formed config', () => {
    const json = JSON.stringify({ ...base, multiLabel: { enabled: true, labelWidth: 10, labelHeight: 20, labelsAcross: 4, gapMm: 2, cloneMode: true } });
    expect(parseDesignJSON(json).design.multiLabel).toMatchObject({ enabled: true, labelsAcross: 4 });
  });

  it.each([
    ['a non-object', 'nope'],
    ['an array', [1, 2]],
  ])('rejects %s', (_label, multiLabel) => {
    expect(() => parseDesignJSON(withExtra({ multiLabel }))).toThrow(/multiLabel/i);
  });

  it.each([
    ['labelsAcross', 'labelsAcross', 'four'],
    ['labelWidth', 'labelWidth', null],
    ['gapMm', 'gapMm', NaN],
    ['labelHeight', 'labelHeight', Infinity],
  ])('rejects a non-finite %s rather than substituting a default', (_label, field, value) => {
    // The old `|| 10` also swallowed a legitimate 0 and quietly turned NaN into 10.
    expect(() => parseDesignJSON(withExtra({ multiLabel: { [field]: value } }))).toThrow(new RegExp(field, 'i'));
  });

  it('keeps a legitimate zero', () => {
    const json = JSON.stringify({ ...base, multiLabel: { enabled: true, labelWidth: 0 } });
    expect(parseDesignJSON(json).design.multiLabel?.labelWidth).toBe(0);
  });

  it('applies the default only when a field is genuinely absent', () => {
    const json = JSON.stringify({ ...base, multiLabel: { enabled: true } });
    expect(parseDesignJSON(json).design.multiLabel).toMatchObject({ labelWidth: 10, labelsAcross: 4, gapMm: 2 });
  });
});

describe('templateFields and templateData are validated', () => {
  it('accepts an array of strings', () => {
    const json = withExtra({ templateFields: ['SKU', 'name'], isTemplate: true });
    expect(parseDesignJSON(json).design.templateFields).toEqual(['SKU', 'name']);
  });

  it('rejects a templateFields entry that is not a string', () => {
    expect(() => parseDesignJSON(withExtra({ templateFields: ['ok', 42] }))).toThrow(/templateFields/i);
  });

  it('rejects templateData that is not an array', () => {
    expect(() => parseDesignJSON(withExtra({ templateData: { a: 1 } }))).toThrow(/templateData/i);
  });

  it('rejects a templateData row that is not an object', () => {
    expect(() => parseDesignJSON(withExtra({ templateData: ['nope'] }))).toThrow(/templateData/i);
  });

  it('rejects a nested object as a cell value', () => {
    // These values are substituted into label text, so an object would print "[object Object]".
    expect(() => parseDesignJSON(withExtra({ templateData: [{ a: { deep: 1 } }] }))).toThrow(/templateData/i);
  });

  it.each([
    ['a number', 42],
    ['a boolean', true],
    ['a null', null],
  ])('accepts %s as a cell value', (_label, value) => {
    expect(() => parseDesignJSON(withExtra({ templateData: [{ a: value }] }))).not.toThrow();
  });

  it('names the offending row and field so the message is actionable', () => {
    expect(() => parseDesignJSON(withExtra({ templateData: [{ ok: 'x' }, { bad: { deep: 1 } }] })))
      .toThrow(/row 2/i);
    expect(() => parseDesignJSON(withExtra({ templateData: [{ ok: 'x' }, { bad: { deep: 1 } }] })))
      .toThrow(/"bad"/);
  });
});

describe('a valid file still round-trips', () => {
  it('exports and re-imports without loss', () => {
    const design = {
      ...base,
      isTemplate: true,
      templateFields: ['SKU', 'name'],
      templateData: [{ SKU: 'A-1', name: 'Bean' }],
      multiLabel: { enabled: true, labelWidth: 10, labelHeight: 20, labelsAcross: 4, gapMm: 2, cloneMode: true },
    };
    const back = parseDesignJSON(exportDesignJSON('My design', design)).design;
    expect(back.elements).toHaveLength(1);
    expect(back.templateFields).toEqual(['SKU', 'name']);
    expect(back.templateData).toEqual([{ SKU: 'A-1', name: 'Bean' }]);
    expect(back.multiLabel).toMatchObject({ labelsAcross: 4 });
  });
});

describe('export filenames keep Arabic letters', () => {
  // The old pattern used \w, which is ASCII-only, so every Arabic character became an underscore and
  // "ملصق القهوة" exported as "_____.json" — an Arabic-first app whose exports were unusable.
  // Measured through the real download element rather than the helper, so the assertion is about what
  // a browser would save.
  const exportedName = (designName: string | null) => {
    useStore.getState().newDesign();
    useStore.setState({ designName });
    const created: HTMLAnchorElement[] = [];
    const realCreate = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string, ...rest: unknown[]) => {
      const el = realCreate(tag, ...(rest as []));
      if (tag === 'a') created.push(el as HTMLAnchorElement);
      return el;
    });
    actions.exportJson();
    spy.mockRestore();
    return created[0]?.download;
  };

  it('keeps an Arabic design name intact', () => {
    expect(exportedName('ملصق القهوة')).toBe('ملصق القهوة.json');
  });

  it('keeps a mixed Arabic and Latin name', () => {
    expect(exportedName('قهوة Arabica 2')).toBe('قهوة Arabica 2.json');
  });

  it('replaces a path separator rather than creating a path', () => {
    expect(exportedName('a/b')).toBe('a_b.json');
  });

  it('strips a leading dot so the file is not hidden', () => {
    expect(exportedName('...secret')).toBe('secret.json');
  });

  it('falls back to a name when the design name is only dots and spaces', () => {
    expect(exportedName('   ')).toBe('label.json');
  });

  it('does not produce an empty filename', () => {
    expect(exportedName('')).toBeTruthy();
  });
});
