/**
 * core/storage/storage.ts — persistence, shape validation, and recovery from poisoned data.
 *
 * Every read here is defensive by design: a structurally-valid-but-wrong-typed value (a legacy
 * `"null"`, an array where an object belongs) used to flow into callers that assumed the type and
 * take down the designs list with no way to recover. These tests hold that contract down.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

function makeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

let store: ReturnType<typeof makeStorage>;
let S: typeof import('../src/core/storage/storage');
let makeElement: () => import('../src/core/model/elements').TextElement;

beforeEach(async () => {
  vi.resetModules();
  store = makeStorage();
  (globalThis as any).localStorage = store;
  S = await import('../src/core/storage/storage');
  const els = await import('../src/core/model/elements');
  makeElement = () => els.createText('hi', { x: 1, y: 2, width: 3, height: 4 });
});

const design = (over: Record<string, unknown> = {}) => ({
  elements: [makeElement()],
  labelSize: { width: 40, height: 30 },
  ...over,
}) as unknown as import('../src/core/storage/storage').Design;

describe('poisoned storage never throws', () => {
  const poisons = ['"null"', 'null', '[]', '"hello"', '42', '{bad json', 'true'];

  for (const poison of poisons) {
    it(`survives ${poison} in the designs key`, () => {
      store.map.set(S.KEYS.DESIGNS, poison);
      expect(() => S.listDesigns()).not.toThrow();
      expect(S.listDesigns()).toEqual([]);
      expect(S.loadDesign('anything')).toBeNull();
      expect(() => S.saveDesign('ok', design())).not.toThrow();
    });

    it(`survives ${poison} in the settings key`, () => {
      store.map.set(S.KEYS.SETTINGS, poison);
      const s = S.loadSettings();
      expect(s).toEqual(S.DEFAULT_SETTINGS);
    });

    it(`survives ${poison} in the autosave key`, () => {
      store.map.set(S.KEYS.AUTOSAVE, poison);
      expect(() => S.loadAutosave()).not.toThrow();
      expect(S.loadAutosave()).toBeNull();
    });

    it(`survives ${poison} in the device-mapping key`, () => {
      store.map.set(S.KEYS.DEVICE_MAPPING, poison);
      expect(() => S.getDeviceModel('M221')).not.toThrow();
      expect(S.getDeviceModel('M221')).toBeNull();
    });

    it(`survives ${poison} in the multi-preset key`, () => {
      store.map.set(S.KEYS.MULTI_LABEL_PRESETS, poison);
      expect(() => S.loadMultiPresets()).not.toThrow();
      expect(S.loadMultiPresets()).toEqual({});
    });

    it(`survives ${poison} in the custom-printers key`, () => {
      store.map.set(S.KEYS.CUSTOM_PRINTERS, poison);
      expect(() => S.loadCustomPrinters()).not.toThrow();
      expect(S.loadCustomPrinters()).toEqual([]);
    });
  }

  it('a saved design survives a corrupted neighbour key', () => {
    S.saveDesign('keeper', design());
    store.map.set(S.KEYS.SETTINGS, '"null"');
    expect(S.loadDesign('keeper')).not.toBeNull();
    expect(S.listDesigns().map((d) => d.name)).toEqual(['keeper']);
  });
});

describe('designs CRUD', () => {
  it('saves, loads and lists a design with a timestamp and element count', () => {
    S.saveDesign('My Label', design());
    const loaded = S.loadDesign('My Label');
    expect(loaded!.elements.length).toBe(1);
    expect(loaded!.savedAt).toBeGreaterThan(0);

    const list = S.listDesigns();
    expect(list).toEqual([
      expect.objectContaining({ name: 'My Label', elementCount: 1, isTemplate: false, recordCount: 0 }),
    ]);
  });

  it('refuses a blank design name', () => {
    expect(() => S.saveDesign('   ', design())).toThrow(/name is required/i);
  });

  it('trims the name on save, so " x " and "x" are the same design', () => {
    S.saveDesign('  spaced  ', design());
    expect(S.designExists('spaced')).toBe(true);
    expect(S.listDesigns().length).toBe(1);
  });

  it('overwrites an existing design of the same name', () => {
    S.saveDesign('dup', design());
    S.saveDesign('dup', design({ elements: [] }));
    expect(S.listDesigns().length).toBe(1);
    expect(S.loadDesign('dup')!.elements).toEqual([]);
  });

  it('lists designs newest-first', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    S.saveDesign('older', design());
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    S.saveDesign('newer', design());
    expect(S.listDesigns().map((d) => d.name)).toEqual(['newer', 'older']);
    vi.useRealTimers();
  });

  it('reports template metadata in the summary', () => {
    S.saveDesign('tpl', design({ isTemplate: true, templateFields: ['SKU'], templateData: [{ SKU: 'a' }, { SKU: 'b' }] }));
    expect(S.listDesigns()[0]).toMatchObject({ isTemplate: true, recordCount: 2 });
  });

  it('deletes a design', () => {
    S.saveDesign('gone', design());
    S.deleteDesign('gone');
    expect(S.loadDesign('gone')).toBeNull();
    expect(S.listDesigns()).toEqual([]);
  });

  it('throws when saving fails because storage is full', () => {
    store.setItem = () => { throw new Error('QuotaExceeded'); };
    expect(() => S.saveDesign('nope', design())).toThrow(/storage full/i);
  });
});

describe('renameDesign', () => {
  it('renames and keeps the content', () => {
    S.saveDesign('before', design());
    S.renameDesign('before', 'after');
    expect(S.loadDesign('before')).toBeNull();
    expect(S.loadDesign('after')!.elements.length).toBe(1);
  });

  it('refuses an unknown source', () => {
    expect(() => S.renameDesign('ghost', 'x')).toThrow(/not found/i);
  });

  it('refuses a blank target name', () => {
    S.saveDesign('a', design());
    expect(() => S.renameDesign('a', '   ')).toThrow(/name is required/i);
  });

  it('refuses to overwrite a different existing design', () => {
    S.saveDesign('a', design());
    S.saveDesign('b', design());
    expect(() => S.renameDesign('a', 'b')).toThrow(/already exists/i);
    expect(S.loadDesign('b')).not.toBeNull();
  });

  it('renaming to the same name (modulo whitespace) is allowed', () => {
    S.saveDesign('same', design());
    expect(() => S.renameDesign('same', ' same ')).not.toThrow();
    expect(S.listDesigns().length).toBe(1);
  });
});

describe('parseDesignJSON', () => {
  it('round-trips a design through export and import', () => {
    const d = design();
    const json = S.exportDesignJSON('round', d);
    const { name, design: parsed } = S.parseDesignJSON(json);
    expect(name).toBe('round');
    expect(parsed.elements.length).toBe(1);
    expect(parsed.labelSize).toEqual({ width: 40, height: 30 });
  });

  it('rejects malformed JSON', () => {
    expect(() => S.parseDesignJSON('{nope')).toThrow(/invalid json/i);
  });

  it('rejects a design with no elements array', () => {
    expect(() => S.parseDesignJSON('{"labelSize":{"width":1,"height":1}}')).toThrow(/missing elements/i);
  });

  it('rejects a missing or malformed label size', () => {
    expect(() => S.parseDesignJSON('{"elements":[]}')).toThrow(/label size/i);
    expect(() => S.parseDesignJSON('{"elements":[],"labelSize":{"width":"x","height":1}}')).toThrow(/label size/i);
  });

  it('rejects an element whose geometry is not finite', () => {
    const bad = JSON.stringify({
      elements: [{ id: 'e', type: 'text', zone: 0, x: 'oops', y: 1, width: 1, height: 1, rotation: 0 }],
      labelSize: { width: 10, height: 10 },
    });
    expect(() => S.parseDesignJSON(bad)).toThrow(/element 1 is malformed/i);
  });

  it('names the offending element by position', () => {
    const bad = JSON.stringify({
      elements: [
        { id: 'a', type: 'text', zone: 0, x: 1, y: 1, width: 1, height: 1, rotation: 0 },
        { id: 'b', type: 'text', zone: 0, x: 1, y: 1, width: 1, height: 1, rotation: 0 },
        { id: 'c', type: 'text', zone: 0, x: null, y: 1, width: 1, height: 1, rotation: 0 },
      ],
      labelSize: { width: 10, height: 10 },
    });
    expect(() => S.parseDesignJSON(bad)).toThrow(/element 3/i);
  });

  it('rejects an unknown element type', () => {
    const bad = JSON.stringify({
      elements: [{ id: 'e', type: 'wormhole', zone: 0, x: 1, y: 1, width: 1, height: 1, rotation: 0 }],
      labelSize: { width: 10, height: 10 },
    });
    expect(() => S.parseDesignJSON(bad)).toThrow(/malformed/i);
  });

  it('rejects an element with no id', () => {
    const bad = JSON.stringify({
      elements: [{ type: 'text', zone: 0, x: 1, y: 1, width: 1, height: 1, rotation: 0 }],
      labelSize: { width: 10, height: 10 },
    });
    expect(() => S.parseDesignJSON(bad)).toThrow(/malformed/i);
  });

  it('rejects a bad orientation', () => {
    const bad = JSON.stringify({ elements: [], labelSize: { width: 10, height: 10, orientation: 'sideways' } });
    expect(() => S.parseDesignJSON(bad)).toThrow(/label size/i);
  });

  it('accepts a legacy design that omits orientation', () => {
    const legacy = JSON.stringify({ elements: [], labelSize: { width: 10, height: 10 } });
    expect(S.parseDesignJSON(legacy).design.labelSize).toEqual({ width: 10, height: 10 });
  });

  it('returns a null name when the file has none', () => {
    const json = JSON.stringify({ elements: [], labelSize: { width: 10, height: 10 } });
    expect(S.parseDesignJSON(json).name).toBeNull();
  });

  it('normalises the multi-label block and defaults missing fields', () => {
    const json = JSON.stringify({
      elements: [],
      labelSize: { width: 10, height: 10 },
      multiLabel: { enabled: true },
    });
    const m = S.parseDesignJSON(json).design.multiLabel!;
    expect(m).toEqual({ enabled: true, labelWidth: 10, labelHeight: 20, labelsAcross: 4, gapMm: 2, cloneMode: true });
  });

  it('ignores a multiLabel that is not an object', () => {
    const json = JSON.stringify({ elements: [], labelSize: { width: 10, height: 10 }, multiLabel: 'nope' });
    expect(S.parseDesignJSON(json).design.multiLabel).toBeUndefined();
  });
});

describe('settings', () => {
  it('returns defaults on a fresh install', () => {
    expect(S.loadSettings()).toEqual(S.DEFAULT_SETTINGS);
  });

  it('merges a partial saved settings object over the defaults', () => {
    store.map.set(S.KEYS.SETTINGS, JSON.stringify({ density: 3 }));
    const s = S.loadSettings();
    expect(s.density).toBe(3);
    expect(s.copies).toBe(S.DEFAULT_SETTINGS.copies); // untouched fields keep their default
  });
});

describe('per-device memory', () => {
  it('remembers a model per device name', () => {
    S.saveDeviceModel('M221', 'm221');
    expect(S.getDeviceModel('M221')).toBe('m221');
    expect(S.getDeviceModel('Other')).toBeNull();
  });

  it('remembers a tape width per device name', () => {
    S.saveDeviceTapeWidth('A30', 15);
    expect(S.getDeviceTapeWidth('A30')).toBe(15);
  });

  it('reading a legacy bare-string entry as a model still works', () => {
    store.map.set(S.KEYS.DEVICE_MAPPING, JSON.stringify({ M221: 'm110' }));
    expect(S.getDeviceModel('M221')).toBe('m110');
  });

  it('patching one field keeps the other for the same device', () => {
    S.saveDeviceModel('M221', 'm221');
    S.saveDeviceTapeWidth('M221', 12);
    expect(S.getDeviceModel('M221')).toBe('m221');
    expect(S.getDeviceTapeWidth('M221')).toBe(12);
  });

  it('ignores an empty device name instead of writing a junk key', () => {
    S.saveDeviceModel('', 'm221');
    expect(store.map.has(S.KEYS.DEVICE_MAPPING)).toBe(false);
  });
});

describe('custom printers and multi presets', () => {
  it('round-trips a custom printer list', () => {
    const list = [{ id: 'x', name: 'X', protocol: 'm-series', widthBytes: 72, dpi: 203, namePatterns: ['X'] }] as never;
    S.saveCustomPrinters(list);
    expect(S.loadCustomPrinters()).toEqual(list);
  });

  it('saves, lists and deletes a multi-label preset', () => {
    S.saveMultiPreset('roll', { labelWidth: 10, labelHeight: 20, labelsAcross: 4, gapMm: 2 });
    expect(S.loadMultiPresets().roll).toMatchObject({ labelsAcross: 4 });
    S.deleteMultiPreset('roll');
    expect(S.loadMultiPresets()).toEqual({});
  });

  it('trims the preset name on save', () => {
    S.saveMultiPreset('  roll  ', { labelWidth: 10, labelHeight: 20, labelsAcross: 4, gapMm: 2 });
    expect(Object.keys(S.loadMultiPresets())).toEqual(['roll']);
  });
});

describe('autosave', () => {
  it('round-trips the working design', () => {
    S.saveAutosave(design({ elements: [] }) as never);
    expect(S.loadAutosave()!.labelSize).toEqual({ width: 40, height: 30 });
  });

  it('returns null when nothing was autosaved', () => {
    expect(S.loadAutosave()).toBeNull();
  });
});
