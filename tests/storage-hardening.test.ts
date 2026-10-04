/**
 * storage.ts — the hostile-input and failure paths.
 *
 * Everything here is about values the app did not write itself: names that collide with
 * Object.prototype, records that failed to persist, and a stored autosave that is structurally an
 * object but not a usable design. Each of those used to pass a shape check and then break something
 * the user could not recover from.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  KEYS, designExists, loadDesign, saveDesign, deleteDesign, renameDesign, listDesigns,
  saveAutosave, loadAutosave, saveDeviceModel, getDeviceModel, saveDeviceTapeWidth, getDeviceTapeWidth,
  loadSettings, saveSettings, type Design,
} from '../src/core/storage/storage';
import { createText } from '../src/core/model/elements';

const design = (): Design => ({ elements: [createText('A')], labelSize: { width: 40, height: 30 } });

let store: Record<string, string>;
beforeEach(() => {
  store = {};
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = String(v); },
      removeItem: (k: string) => { delete store[k]; },
      clear: () => { store = {}; },
    },
    configurable: true,
    writable: true,
  });
});

describe('names that collide with Object.prototype', () => {
  // `'constructor' in {}` and `'__proto__' in {}` are both true on a plain object, so a design called
  // "constructor" reported as already existing, and loading it returned Object.prototype's member
  // instead of null — which then rendered as a broken design.
  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])('does not claim %s already exists', (name) => {
    expect(designExists(name)).toBe(false);
  });

  it.each(['constructor', 'toString', '__proto__'])('returns null when loading a design named %s that was never saved', (name) => {
    expect(loadDesign(name)).toBeNull();
  });

  it('saves and loads a design whose name is "constructor"', () => {
    saveDesign('constructor', design());
    expect(designExists('constructor')).toBe(true);
    expect(loadDesign('constructor')?.elements).toHaveLength(1);
  });

  it('saves and loads a design whose name is "__proto__"', () => {
    saveDesign('__proto__', design());
    expect(designExists('__proto__')).toBe(true);
    expect(loadDesign('__proto__')?.elements).toHaveLength(1);
    expect(listDesigns().map((d) => d.name)).toContain('__proto__');
  });

  it('a "__proto__" design does not pollute the prototype of anything', () => {
    saveDesign('__proto__', design());
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(store[KEYS.DESIGNS] ? JSON.parse(store[KEYS.DESIGNS]) : {})).toContain('__proto__');
  });

  it('a design named "__proto__" can be deleted', () => {
    saveDesign('__proto__', design());
    deleteDesign('__proto__');
    expect(designExists('__proto__')).toBe(false);
  });

  it('renaming a design that does not exist throws, rather than matching a prototype member', () => {
    expect(() => renameDesign('constructor', 'x')).toThrow(/not found/i);
  });
});

describe('saveAutosave reports failure instead of failing silently', () => {
  // A base64 photo can push a design past the ~5MB quota. The old code discarded write()'s boolean,
  // so a broken autosave was indistinguishable from a working one until the reload.
  it('returns true when the write lands', () => {
    expect(saveAutosave(design())).toBe(true);
  });

  it('returns false when localStorage rejects the write', () => {
    const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {}, clear: () => {} };
    Object.defineProperty(globalThis, 'localStorage', { value: full, configurable: true, writable: true });
    expect(saveAutosave(design())).toBe(false);
  });
});

describe('a corrupt autosave is salvaged, not discarded', () => {
  // Rejecting the whole autosave over one bad field cost the user everything; so did letting a partial
  // one through and crashing at startup. Now bad elements are dropped individually and the rest of
  // the design survives.
  it.each([
    ['an array', []],
    ['a bare string', 'design'],
    ['null', null],
    ['unparseable JSON', '{not json'],
  ])('returns null for %s — there is nothing to salvage', (_label, value) => {
    if (typeof value === 'string') store[KEYS.AUTOSAVE] = value;
    else store[KEYS.AUTOSAVE] = JSON.stringify(value);
    expect(loadAutosave()).toBeNull();
  });

  it('drops a malformed element and keeps the good ones', () => {
    const good = createText('A');
    store[KEYS.AUTOSAVE] = JSON.stringify({
      elements: [good, { type: 'text' }, { nope: true }, createText('B')],
      labelSize: { width: 40, height: 30 },
    });
    const back = loadAutosave();
    expect(back?.elements).toHaveLength(2);
    expect(back?.elements.map((e) => (e as { text: string }).text)).toEqual(['A', 'B']);
  });

  it('falls back to a default label size when it is missing', () => {
    store[KEYS.AUTOSAVE] = JSON.stringify({ elements: [createText('A')] });
    expect(loadAutosave()?.labelSize).toEqual({ width: 40, height: 30 });
  });

  it('keeps a valid label size', () => {
    store[KEYS.AUTOSAVE] = JSON.stringify({ elements: [], labelSize: { width: 30, height: 20, round: true } });
    expect(loadAutosave()?.labelSize).toMatchObject({ width: 30, round: true });
  });

  it('returns null when nothing recognisable survives', () => {
    // An object with neither elements nor a label size is not a design; opening an empty one would
    // look to the user like their work vanished.
    store[KEYS.AUTOSAVE] = JSON.stringify({ somethingElse: true });
    expect(loadAutosave()).toBeNull();
  });

  it('repairs a non-finite multiLabel field rather than propagating NaN to a label', () => {
    store[KEYS.AUTOSAVE] = JSON.stringify({
      elements: [createText('A')],
      labelSize: { width: 40, height: 30 },
      multiLabel: { enabled: true, labelsAcross: 'four' },
    });
    expect(loadAutosave()?.multiLabel).toMatchObject({ labelsAcross: 4 });
  });

  it('repairs a zero roll width instead of honouring it', () => {
    // A 0 mm label cannot be printed. An earlier clamp preserved 0 as "a legitimate value",
    // which let a corrupt file produce a 0x0 label — and a roll with `labelsAcross: 0` divides
    // the record count by zero, so a batch asked for Infinity rows.
    store[KEYS.AUTOSAVE] = JSON.stringify({
      elements: [createText('A')],
      labelSize: { width: 40, height: 30 },
      multiLabel: { enabled: true, labelWidth: 0 },
    });
    expect(loadAutosave()?.multiLabel?.labelWidth).toBe(5);
  });

  it('preserves a 5 mm roll label, the smallest the roll dialog accepts', () => {
    // Rolls are cut into narrow strips, so their minimum is 5 mm rather than the 10 mm a whole
    // label uses. Clamping a roll to the whole-label minimum rewrote a valid 5 mm roll to 10 mm
    // on every reload.
    store[KEYS.AUTOSAVE] = JSON.stringify({
      elements: [createText('A')],
      labelSize: { width: 40, height: 30 },
      multiLabel: { enabled: true, labelWidth: 5, labelHeight: 5 },
    });
    expect(loadAutosave()?.multiLabel).toMatchObject({ labelWidth: 5, labelHeight: 5 });
  });

  it('keeps a zero gap, which is the roll minimum', () => {
    store[KEYS.AUTOSAVE] = JSON.stringify({
      elements: [createText('A')],
      labelSize: { width: 40, height: 30 },
      multiLabel: { enabled: true, gapMm: 0 },
    });
    expect(loadAutosave()?.multiLabel?.gapMm).toBe(0);
  });

  it('repairs a zero labelsAcross rather than dividing by it', () => {
    store[KEYS.AUTOSAVE] = JSON.stringify({
      elements: [createText('A')],
      labelSize: { width: 40, height: 30 },
      multiLabel: { enabled: true, labelsAcross: 0 },
    });
    expect(loadAutosave()?.multiLabel?.labelsAcross).toBe(1);
  });

  it('repairs a 0x0 label size', () => {
    store[KEYS.AUTOSAVE] = JSON.stringify({
      elements: [createText('A')],
      labelSize: { width: 0, height: 0 },
    });
    expect(loadAutosave()?.labelSize).toMatchObject({ width: 10, height: 10 });
  });

  it('repairs out-of-range settings', () => {
    store[KEYS.SETTINGS] = JSON.stringify({ copies: 0, density: 0, feed: 9999 });
    const s = loadSettings();
    expect(s.copies).toBe(1);
    expect(s.density).toBe(1);
    expect(s.feed).toBe(255);
  });

  it('still loads a well-formed autosave unchanged', () => {
    const d = { elements: [createText('A'), createText('B')], labelSize: { width: 50, height: 25 } };
    saveAutosave(d);
    expect(loadAutosave()?.elements).toHaveLength(2);
    expect(loadAutosave()?.labelSize).toMatchObject({ width: 50 });
  });
});

describe('a corrupt entry cannot break the designs list', () => {
  it('drops a non-object entry and keeps the rest', () => {
    // listDesigns() reads d.elements?.length off every entry, so one bad value used to throw and take
    // the whole library with it — including the dialog you would use to delete it.
    store[KEYS.DESIGNS] = JSON.stringify({ Good: { elements: [createText('A')], labelSize: { width: 40, height: 30 } }, Bad: 'nope', AlsoBad: null });
    expect(listDesigns().map((d) => d.name)).toEqual(['Good']);
  });

  it('a design named "__proto__" still survives the filter', () => {
    // Written with a computed key on purpose: `{ __proto__: x }` in an object literal sets the
    // prototype rather than creating a property, so JSON.stringify drops it and the test would pass
    // without ever producing the key it claims to test.
    store[KEYS.DESIGNS] = JSON.stringify({ ['__proto__']: { elements: [createText('A')], labelSize: { width: 40, height: 30 } } });
    expect(store[KEYS.DESIGNS]).toContain('__proto__');
    expect(listDesigns().map((d) => d.name)).toContain('__proto__');
  });
});

describe('per-device memory', () => {
  it('stores and reads a model for a device named "constructor"', () => {
    saveDeviceModel('constructor', 'm221');
    expect(getDeviceModel('constructor')).toBe('m221');
  });

  it('reports no model for a device that was never remembered', () => {
    expect(getDeviceModel('toString')).toBeNull();
    expect(getDeviceTapeWidth('toString')).toBeNull();
  });

  it('stores and reads a tape width', () => {
    saveDeviceTapeWidth('A30', 15);
    expect(getDeviceTapeWidth('A30')).toBe(15);
  });

  it('reads the older bare-string format', () => {
    store[KEYS.DEVICE_MAPPING] = JSON.stringify({ M221: 'm221' });
    expect(getDeviceModel('M221')).toBe('m221');
  });
});

describe('settings', () => {
  it('falls back to the defaults when the stored object is junk', () => {
    store[KEYS.SETTINGS] = '"nope"';
    expect(loadSettings().density).toBe(6);
  });

  it('round-trips', () => {
    saveSettings({ density: 3, copies: 2, feed: 8, printerModel: 'm221', tapeWidth: 15, ditherPreview: true });
    expect(loadSettings().density).toBe(3);
    expect(loadSettings().printerModel).toBe('m221');
  });

  it('a stored "__proto__" cannot become a setting', () => {
    store[KEYS.SETTINGS] = '{"__proto__":{"density":99}}';
    expect(loadSettings().density).toBe(6);
  });
});

describe('a failing autosave says so, once per failure streak', () => {
  // saveAutosave returns false on a full quota. Nothing told the user, so an autosave that had been
  // failing for weeks looked exactly like a working one — and the work was only found to be gone at
  // reload. The toast is per streak, not per keystroke: the quota fails on every edit.
  const fillStorage = () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {}, clear: () => {} },
      configurable: true, writable: true,
    });
  };

  it('warns on the first failure', async () => {
    const store = await import('../src/state/store');
    store.useStore.getState().newDesign();
    store.useStore.setState({ toasts: [] });
    fillStorage();
    store.useStore.getState().add(createText('A'));
    await new Promise((r) => setTimeout(r, 700));
    const toasts = store.useStore.getState().toasts;
    expect(toasts.some((t) => t.kind === 'error')).toBe(true);
  });

  it('stays quiet on the failures that follow, so it cannot bury the editing', async () => {
    const store = await import('../src/state/store');
    store.useStore.getState().newDesign();
    fillStorage();
    const countToasts = () => store.useStore.getState().toasts.length;
    store.useStore.getState().add(createText('B'));
    await new Promise((r) => setTimeout(r, 700));
    const afterFirst = countToasts();
    for (let i = 0; i < 3; i++) {
      store.useStore.getState().add(createText(`C${i}`));
      await new Promise((r) => setTimeout(r, 700));
    }
    expect(countToasts()).toBe(afterFirst);
  });

  it('flushAutosave reports the failure', async () => {
    const store = await import('../src/state/store');
    store.useStore.getState().newDesign();
    fillStorage();
    store.useStore.getState().add(createText('D'));
    expect(store.flushAutosave()).toBe(false);
  });

  it('flushAutosave is a no-op, and says so, when nothing is pending', async () => {
    const store = await import('../src/state/store');
    expect(store.flushAutosave()).toBe(true);
  });
});
