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

describe('a corrupt autosave degrades to "none"', () => {
  it.each([
    ['an object with no elements', { labelSize: { width: 40, height: 30 } }],
    ['an object with no labelSize', { elements: [] }],
    ['elements that is not an array', { elements: 'nope', labelSize: { width: 40, height: 30 } }],
    ['a malformed labelSize', { elements: [], labelSize: { width: 'wide', height: 30 } }],
    ['an array', []],
    ['a bare string', 'design'],
  ])('ignores %s', (_label, value) => {
    store[KEYS.AUTOSAVE] = JSON.stringify(value);
    expect(loadAutosave()).toBeNull();
  });

  it('still loads a well-formed autosave', () => {
    const d = design();
    saveAutosave(d);
    expect(loadAutosave()?.elements).toHaveLength(1);
  });

  it('ignores unparseable JSON', () => {
    store[KEYS.AUTOSAVE] = '{not json';
    expect(loadAutosave()).toBeNull();
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
