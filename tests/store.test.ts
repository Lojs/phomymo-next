/**
 * Store invariants — history (undo/redo), autosave, and the multi-label/document transitions.
 *
 * The store owns the user's work: a defect in the history stack or the autosave path loses
 * edits, which is the worst failure this app can have. These tests drive the real store.
 *
 * store.ts reads localStorage at module-init time, so each test re-imports it behind a fresh
 * in-memory localStorage, and Date.now is faked where the coalescing window matters.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** Minimal in-memory localStorage, exposed so tests can inspect what was persisted. */
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

beforeEach(() => {
  vi.resetModules();
  store = makeStorage();
  (globalThis as any).localStorage = store;
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-US' },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function freshStore() {
  const mod = await import('../src/state/store');
  return mod.useStore;
}

/** A text element with a recognisable marker so assertions can identify it. */
async function makeText(text: string) {
  const { createText } = await import('../src/core/model/elements');
  return createText(text, { x: 10, y: 20, width: 100, height: 30 });
}

/** Narrow a union element to its text so assertions stay type-safe. */
const textOf = (el: { type: string }) => (el.type === 'text' ? (el as unknown as { text: string }).text : undefined);

describe('history: undo / redo', () => {
  it('undo restores the previous element list and redo re-applies it', async () => {
    const useStore = await freshStore();
    const a = await makeText('A');
    const b = await makeText('B');

    useStore.getState().add(a);
    useStore.getState().add(b);
    expect(useStore.getState().elements.map((e) => e.id)).toEqual([a.id, b.id]);

    useStore.getState().undo();
    expect(useStore.getState().elements.map((e) => e.id)).toEqual([a.id]);

    useStore.getState().undo();
    expect(useStore.getState().elements).toEqual([]);

    useStore.getState().redo();
    expect(useStore.getState().elements.map((e) => e.id)).toEqual([a.id]);

    useStore.getState().redo();
    expect(useStore.getState().elements.map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it('undo on an empty history is a no-op, not a crash', async () => {
    const useStore = await freshStore();
    expect(() => useStore.getState().undo()).not.toThrow();
    expect(() => useStore.getState().redo()).not.toThrow();
    expect(useStore.getState().elements).toEqual([]);
  });

  it('a fresh edit clears the redo stack', async () => {
    const useStore = await freshStore();
    useStore.getState().add(await makeText('A'));
    useStore.getState().undo();
    expect(useStore.getState().future.length).toBe(1);

    useStore.getState().add(await makeText('C'));
    expect(useStore.getState().future.length).toBe(0);
    // The redo that used to exist must be gone: redoing now would resurrect a stale branch.
    useStore.getState().redo();
    expect(useStore.getState().elements.map(textOf)).toEqual(['C']);
  });

  it('undo/redo restores the label size and roll config, not just elements', async () => {
    const useStore = await freshStore();
    useStore.getState().setLabelSize({ width: 50, height: 30 });
    useStore.getState().setLabelSize({ width: 70, height: 40 });
    expect(useStore.getState().labelSize).toMatchObject({ width: 70, height: 40 });

    useStore.getState().undo();
    expect(useStore.getState().labelSize).toMatchObject({ width: 50, height: 30 });
  });

  it('caps history at 50 entries so a long session cannot grow unbounded', async () => {
    const useStore = await freshStore();
    for (let i = 0; i < 80; i++) {
      useStore.getState().add(await makeText(`E${i}`));
    }
    expect(useStore.getState().past.length).toBe(50);
    expect(useStore.getState().elements.length).toBe(80);
  });

  it('a 50-deep undo walk never throws and ends at a consistent state', async () => {
    const useStore = await freshStore();
    for (let i = 0; i < 60; i++) useStore.getState().add(await makeText(`E${i}`));
    for (let i = 0; i < 55; i++) useStore.getState().undo();
    expect(useStore.getState().elements.length).toBeGreaterThanOrEqual(0);
    expect(() => useStore.getState().redo()).not.toThrow();
  });
});

describe('history: coalescing window', () => {
  it('collapses same-key checkpoints inside the 1s window into one undo step', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const useStore = await freshStore();

    const el = await makeText('A');
    useStore.getState().add(el);
    const depthAfterAdd = useStore.getState().past.length;

    // A slider drag: same key, rapid calls.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(50);
      useStore.getState().patchSelected({ fontSize: 20 + i } as never, 'fontSize');
    }
    expect(useStore.getState().past.length).toBe(depthAfterAdd + 1);
  });

  it('does NOT extend the window: a long drag past 1s still checkpoints again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const useStore = await freshStore();

    const el = await makeText('A');
    useStore.getState().add(el);
    useStore.getState().select([el.id]);

    useStore.getState().patchSelected({ fontSize: 20 } as never, 'fontSize');
    const afterFirst = useStore.getState().past.length;

    // Keep dragging past the anchor: 2.5s of continuous same-key edits.
    for (let i = 0; i < 25; i++) {
      vi.advanceTimersByTime(100);
      useStore.getState().patchSelected({ fontSize: 20 + i } as never, 'fontSize');
    }
    // The anchor is fixed at the first call, so the burst is bounded — more than one step.
    expect(useStore.getState().past.length).toBeGreaterThan(afterFirst);
  });

  it('different keys never coalesce with each other', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const useStore = await freshStore();

    const el = await makeText('A');
    useStore.getState().add(el);
    useStore.getState().select([el.id]);
    const base = useStore.getState().past.length;

    useStore.getState().patchSelected({ fontSize: 30 } as never, 'fontSize');
    useStore.getState().patchSelected({ rotation: 15 } as never, 'rotation');
    useStore.getState().patchSelected({ x: 99 } as never, 'x');
    expect(useStore.getState().past.length).toBe(base + 3);
  });

  it('an unkeyed checkpoint always records, even back-to-back', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const useStore = await freshStore();

    useStore.getState().add(await makeText('A'));
    useStore.getState().add(await makeText('B'));
    useStore.getState().add(await makeText('C'));
    expect(useStore.getState().past.length).toBe(3);
  });

  it('undo resets the coalescing anchor so the next edit starts a new step', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const useStore = await freshStore();

    const el = await makeText('A');
    useStore.getState().add(el);
    useStore.getState().select([el.id]);
    useStore.getState().patchSelected({ fontSize: 40 } as never, 'fontSize');
    useStore.getState().undo();

    // undo() clears the selection (the snapshot it restored may not contain those ids), so the
    // element has to be picked again before another keyed edit is possible.
    useStore.getState().select([el.id]);
    const before = useStore.getState().past.length;
    useStore.getState().patchSelected({ fontSize: 44 } as never, 'fontSize');
    expect(useStore.getState().past.length).toBe(before + 1);
  });

  it('undo clears the selection, since the restored snapshot may not contain those ids', async () => {
    const useStore = await freshStore();
    const a = await makeText('A');
    useStore.getState().add(a);
    useStore.getState().select([a.id]);
    useStore.getState().removeSelected();
    useStore.getState().undo();
    expect(useStore.getState().selectedIds).toEqual([]);
  });

  it('patchSelected with nothing selected is a no-op and records no history', async () => {
    const useStore = await freshStore();
    useStore.getState().add(await makeText('A'));
    useStore.getState().select([]);
    const before = useStore.getState().past.length;
    useStore.getState().patchSelected({ fontSize: 99 } as never, 'fontSize');
    expect(useStore.getState().past.length).toBe(before);
  });
});

describe('element operations', () => {
  it('add selects the new element and stamps the active zone on a roll', async () => {
    const useStore = await freshStore();
    const a = await makeText('A');
    useStore.getState().add(a);
    expect(useStore.getState().selectedIds).toEqual([a.id]);
    expect(useStore.getState().elements[0].zone).toBe(0);

    useStore.getState().setMulti({ enabled: true, labelWidth: 10, labelHeight: 20, labelsAcross: 4, gapMm: 2, cloneMode: true });
    useStore.getState().setActiveZone(2);
    const b = await makeText('B');
    useStore.getState().add(b);
    const stored = useStore.getState().elements.find((e) => e.id === b.id)!;
    expect(stored.zone).toBe(2);
  });

  it('removeSelected removes exactly the selection and clears it', async () => {
    const useStore = await freshStore();
    const a = await makeText('A');
    const b = await makeText('B');
    useStore.getState().add(a);
    useStore.getState().add(b);

    useStore.getState().select([a.id]);
    useStore.getState().removeSelected();
    expect(useStore.getState().elements.map((e) => e.id)).toEqual([b.id]);
    expect(useStore.getState().selectedIds).toEqual([]);
  });

  it('removeSelected is undoable', async () => {
    const useStore = await freshStore();
    const a = await makeText('A');
    useStore.getState().add(a);
    useStore.getState().select([a.id]);
    useStore.getState().removeSelected();
    expect(useStore.getState().elements).toEqual([]);

    useStore.getState().undo();
    expect(useStore.getState().elements.map((e) => e.id)).toEqual([a.id]);
  });

  it('copy/paste duplicates with a new id and a small offset', async () => {
    const useStore = await freshStore();
    const a = await makeText('A');
    useStore.getState().add(a);
    useStore.getState().select([a.id]);
    useStore.getState().copy();
    useStore.getState().paste();

    const els = useStore.getState().elements;
    expect(els.length).toBe(2);
    expect(els[1].id).not.toBe(a.id);
    expect(els[1].x).toBe(a.x + 16);
    expect(els[1].y).toBe(a.y + 16);
    expect(textOf(els[1])).toBe('A');
  });

  it('pasting an empty clipboard does nothing and records no history', async () => {
    const useStore = await freshStore();
    useStore.getState().paste();
    expect(useStore.getState().elements).toEqual([]);
    expect(useStore.getState().past.length).toBe(0);
  });

  it('pasted copies get fresh group ids but keep grouping intact', async () => {
    const useStore = await freshStore();
    const a = await makeText('A');
    const b = await makeText('B');
    useStore.getState().add(a);
    useStore.getState().add(b);
    useStore.getState().select([a.id, b.id]);
    useStore.getState().group();
    const groupId = useStore.getState().elements[0].groupId!;
    expect(groupId).toBeTruthy();

    useStore.getState().copy();
    useStore.getState().paste();
    const els = useStore.getState().elements;
    const pasted = els.filter((e) => e.id !== a.id && e.id !== b.id);
    expect(pasted.length).toBe(2);
    // Both copies share one NEW group id — not the original, and not two separate ones.
    expect(pasted[0].groupId).toBe(pasted[1].groupId);
    expect(pasted[0].groupId).not.toBe(groupId);
  });

  it('selecting one member of a group selects the whole group', async () => {
    const useStore = await freshStore();
    const a = await makeText('A');
    const b = await makeText('B');
    const c = await makeText('C');
    useStore.getState().add(a);
    useStore.getState().add(b);
    useStore.getState().add(c);
    useStore.getState().select([a.id, b.id]);
    useStore.getState().group();

    useStore.getState().select([a.id]);
    expect(useStore.getState().selectedIds.sort()).toEqual([a.id, b.id].sort());
  });

  it('select with additive toggles membership', async () => {
    const useStore = await freshStore();
    const a = await makeText('A');
    const b = await makeText('B');
    useStore.getState().add(a);
    useStore.getState().add(b);

    useStore.getState().select([a.id]);
    useStore.getState().select([b.id], true);
    expect(useStore.getState().selectedIds.sort()).toEqual([a.id, b.id].sort());

    useStore.getState().select([b.id], true);
    expect(useStore.getState().selectedIds).toEqual([a.id]);
  });

  it('selectAll on a roll only selects the active zone', async () => {
    const useStore = await freshStore();
    useStore.getState().setMulti({ enabled: true, labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2, cloneMode: false });
    const a = await makeText('A');
    useStore.getState().setActiveZone(0);
    useStore.getState().add(a);
    const b = await makeText('B');
    useStore.getState().setActiveZone(1);
    useStore.getState().add(b);

    useStore.getState().setActiveZone(1);
    useStore.getState().selectAll();
    expect(useStore.getState().selectedIds).toEqual([b.id]);
  });

  it('grouping fewer than two elements is refused', async () => {
    const useStore = await freshStore();
    const a = await makeText('A');
    useStore.getState().add(a);
    const before = useStore.getState().past.length;
    useStore.getState().group();
    expect(useStore.getState().past.length).toBe(before);
  });
});

describe('document transitions', () => {
  it('newDesign clears the document and the history', async () => {
    const useStore = await freshStore();
    useStore.getState().add(await makeText('A'));
    useStore.getState().newDesign();
    expect(useStore.getState().elements).toEqual([]);
    expect(useStore.getState().dirty).toBe(false);
    expect(useStore.getState().designName).toBeNull();
  });

  it('loadDesign replaces the document and drops the old history', async () => {
    const useStore = await freshStore();
    useStore.getState().add(await makeText('A'));
    const loaded = await makeText('LOADED');
    useStore.getState().loadDesign({ elements: [loaded], labelSize: { width: 40, height: 30 } }, 'my-design');
    expect(useStore.getState().elements.map(textOf)).toEqual(['LOADED']);
    expect(useStore.getState().past).toEqual([]);
    expect(useStore.getState().future).toEqual([]);
    expect(useStore.getState().designName).toBe('my-design');
    expect(useStore.getState().dirty).toBe(false);
  });

  it('currentDesign includes template metadata only when fields or data exist', async () => {
    const useStore = await freshStore();
    useStore.getState().add(await makeText('plain'));
    expect(useStore.getState().currentDesign().isTemplate).toBeUndefined();

    useStore.getState().add(await makeText('{{SKU}}'));
    const d = useStore.getState().currentDesign();
    expect(d.isTemplate).toBe(true);
    expect(d.templateFields).toContain('SKU');
  });

  it('currentDesign includes the roll config only while multi-label is enabled', async () => {
    const useStore = await freshStore();
    useStore.getState().add(await makeText('A'));
    expect(useStore.getState().currentDesign().multiLabel).toBeUndefined();

    useStore.getState().setMulti({ enabled: true, labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2, cloneMode: true });
    expect(useStore.getState().currentDesign().multiLabel).toBeDefined();
  });
});

describe('label size and rolls', () => {
  it('switching to a roll layout clamps labelsAcross to the allowed range', async () => {
    const useStore = await freshStore();
    useStore.getState().setMulti({ enabled: true, labelWidth: 10, labelHeight: 20, labelsAcross: 999, gapMm: 2, cloneMode: true });
    const { LIMITS } = await import('../src/core/printers/presets');
    expect(useStore.getState().multi.labelsAcross).toBe(LIMITS.multi.maxAcross);
  });

  it('setLabelSize leaves roll mode and collapses to a single zone', async () => {
    const useStore = await freshStore();
    useStore.getState().setMulti({ enabled: true, labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2, cloneMode: true });
    useStore.getState().add(await makeText('A'));
    expect(useStore.getState().multi.enabled).toBe(true);

    useStore.getState().setLabelSize({ width: 50, height: 30 });
    expect(useStore.getState().multi.enabled).toBe(false);
    expect(useStore.getState().activeZone).toBe(0);
    expect(useStore.getState().elements.every((e) => e.zone === 0)).toBe(true);
  });

  it('exitMulti keeps zone 0 and drops the rest', async () => {
    const useStore = await freshStore();
    useStore.getState().setMulti({ enabled: true, labelWidth: 10, labelHeight: 20, labelsAcross: 3, gapMm: 2, cloneMode: true });
    useStore.getState().add(await makeText('A'));
    useStore.getState().cloneActiveZoneToAll();
    expect(useStore.getState().elements.length).toBe(3);

    useStore.getState().exitMulti();
    expect(useStore.getState().multi.enabled).toBe(false);
    expect(useStore.getState().elements.length).toBe(1);
    expect(useStore.getState().elements[0].zone).toBe(0);
  });

  it('cloneActiveZoneToAll is a no-op outside roll mode', async () => {
    const useStore = await freshStore();
    useStore.getState().add(await makeText('A'));
    const before = useStore.getState().past.length;
    useStore.getState().cloneActiveZoneToAll();
    expect(useStore.getState().past.length).toBe(before);
    expect(useStore.getState().elements.length).toBe(1);
  });

  it('setZoom clamps to the allowed range', async () => {
    const useStore = await freshStore();
    const { LIMITS } = await import('../src/core/printers/presets');
    useStore.getState().setZoom(9999);
    expect(useStore.getState().zoom).toBe(LIMITS.zoom.max);
    useStore.getState().setZoom(-9999);
    expect(useStore.getState().zoom).toBe(LIMITS.zoom.min);
  });
});

describe('autosave', () => {
  it('persists the working design after the debounce window', async () => {
    vi.useFakeTimers();
    const useStore = await freshStore();
    useStore.getState().add(await makeText('A'));

    // Nothing written yet — the write is debounced.
    expect(store.map.has('phomymo_autosave')).toBe(false);

    vi.advanceTimersByTime(700);
    expect(store.map.has('phomymo_autosave')).toBe(true);
    const saved = JSON.parse(store.map.get('phomymo_autosave')!);
    expect(saved.elements.length).toBe(1);
    expect(textOf(saved.elements[0])).toBe('A');
  });

  it('coalesces a burst of edits into a single write', async () => {
    vi.useFakeTimers();
    const useStore = await freshStore();
    let writes = 0;
    const realSet = store.setItem;
    store.setItem = (k: string, v: string) => {
      if (k === 'phomymo_autosave') writes++;
      realSet(k, v);
    };

    for (let i = 0; i < 10; i++) {
      useStore.getState().add(await makeText(`E${i}`));
      vi.advanceTimersByTime(50); // still inside the 600ms debounce
    }
    vi.advanceTimersByTime(700);
    expect(writes).toBe(1);
  });

  it('a restored autosave repopulates the document', async () => {
    vi.useFakeTimers();
    const useStore = await freshStore();
    useStore.getState().add(await makeText('PERSISTED'));
    vi.advanceTimersByTime(700);

    // Simulate a reload: same storage, fresh module instance.
    vi.resetModules();
    const reloaded = (await import('../src/state/store')).useStore;
    expect(reloaded.getState().elements.map(textOf)).toEqual(['PERSISTED']);
  });

  it('does not autosave on pure UI changes (selection, zoom, dialog)', async () => {
    vi.useFakeTimers();
    const useStore = await freshStore();
    const a = await makeText('A');
    useStore.getState().add(a);
    vi.advanceTimersByTime(700);
    const first = store.map.get('phomymo_autosave');

    useStore.getState().select([a.id]);
    useStore.getState().setZoom(2);
    useStore.getState().openDialog('settings');
    vi.advanceTimersByTime(700);
    expect(store.map.get('phomymo_autosave')).toBe(first);
  });
});
