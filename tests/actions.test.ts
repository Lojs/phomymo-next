/**
 * services/actions.ts — element insertion sizing, file-name sanitising, and import error paths.
 *
 * The export paths (PNG/PDF/CSV) touch canvas, Blob and jsPDF, so they are exercised through
 * their observable contract: what gets downloaded, and what the user is told when an import is
 * malformed. Everything here runs against the real store behind an in-memory localStorage.
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

/** Capture the anchors the download helper creates, and the names handed to them. */
function captureDownloads() {
  const saved: { name: string }[] = [];
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el: any = realCreate(tag);
    if (tag === 'a') {
      el.click = () => saved.push({ name: el.download });
    }
    return el;
  });
  return saved;
}

let store: ReturnType<typeof makeStorage>;

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  store = makeStorage();
  (globalThis as any).localStorage = store;
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', {
    value: { createElement: () => ({ style: {}, appendChild() {}, remove() {}, click() {} }), body: { appendChild() {}, removeChild() {} } },
    configurable: true,
    writable: true,
  });
  // Blob and the object-URL helpers: the download path validates that it was handed a real Blob,
  // so a hand-rolled stub is rejected. Node's own Blob is the real thing; only the object-URL
  // pair needs faking (jsdom-less Node has no URL.createObjectURL).
  const realBlob = (globalThis as any).Blob;
  if (typeof realBlob !== 'function') {
    (globalThis as any).Blob = class { constructor(public parts: unknown[], public opts?: unknown) {} };
  }
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:fake', configurable: true, writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true, writable: true });
});

async function setup() {
  const useStore = (await import('../src/state/store')).useStore;
  const actions = await import('../src/services/actions');
  return { useStore, actions };
}

describe('inserting elements sizes them to the label', () => {
  it('addText stays inside the label width and is horizontally centred', async () => {
    const { useStore, actions } = await setup();
    useStore.getState().setLabelSize({ width: 40, height: 30 }); // 320 x 240 px
    actions.addText();
    const el = useStore.getState().elements[0];
    const l = useStore.getState().layout();
    expect(el.width).toBeLessThanOrEqual(l.labelWidth);
    expect(el.x).toBeGreaterThanOrEqual(0);
    expect(el.x + el.width).toBeLessThanOrEqual(l.labelWidth);
  });

  it('addText never makes a text box narrower than 50px on a tiny label', async () => {
    const { useStore, actions } = await setup();
    useStore.getState().setLabelSize({ width: 5, height: 5 }); // 40 x 40 px
    actions.addText();
    expect(useStore.getState().elements[0].width).toBe(50);
  });

  it('addBarcode keeps the barcode inside the label', async () => {
    const { useStore, actions } = await setup();
    useStore.getState().setLabelSize({ width: 40, height: 30 });
    actions.addBarcode();
    const el = useStore.getState().elements[0];
    const l = useStore.getState().layout();
    expect(el.width).toBeLessThanOrEqual(l.labelWidth);
    expect(el.height).toBeLessThanOrEqual(l.labelHeight);
  });

  it('addQR produces a square that fits the smaller label side', async () => {
    const { useStore, actions } = await setup();
    useStore.getState().setLabelSize({ width: 40, height: 30 });
    actions.addQR();
    const el = useStore.getState().elements[0];
    expect(el.width).toBe(el.height);
    expect(el.width).toBeLessThanOrEqual(useStore.getState().layout().labelHeight);
  });

  it('addShape makes a line stroked but unfilled, and a rectangle filled', async () => {
    const { useStore, actions } = await setup();
    actions.addShape('line');
    const line = useStore.getState().elements[0] as any;
    expect(line.fill).toBe('none');
    expect(line.stroke).toBe('black');

    actions.addShape('rectangle');
    const rect = useStore.getState().elements[1] as any;
    expect(rect.fill).toBe('black');
    expect(rect.stroke).toBe('none');
  });

  it('every inserted element is undoable', async () => {
    const { useStore, actions } = await setup();
    actions.addText();
    actions.addQR();
    expect(useStore.getState().elements.length).toBe(2);
    useStore.getState().undo();
    expect(useStore.getState().elements.length).toBe(1);
  });
});

describe('file names', () => {
  it('sanitises the design name into a safe file base', async () => {
    const { useStore, actions } = await setup();
    useStore.setState({ designName: 'my label/2026:v1*' });
    // exportCsv builds `${fileBase()}-data.csv`; capture the download name.
    const saved = captureDownloads();
    actions.exportCsv();
    expect(saved.length).toBe(1);
    expect(saved[0].name).toBe('my label_2026_v1_-data.csv');
  });

  it('falls back to "label" when the design is untitled', async () => {
    const { useStore, actions } = await setup();
    useStore.setState({ designName: null });
    const saved = captureDownloads();
    actions.exportJson();
    expect(saved[0].name).toBe('label.json');
  });
});

describe('CSV import', () => {
  const fileOf = (text: string) => ({ text: async () => text }) as unknown as File;

  it('loads valid records and reports the count', async () => {
    const { useStore, actions } = await setup();
    await actions.importCsvFile(fileOf('SKU,Name\nA1,Widget\nA2,Gadget\n'));
    expect(useStore.getState().templateData.length).toBe(2);
    expect(useStore.getState().templateData[0]).toEqual({ SKU: 'A1', Name: 'Widget' });
  });

  it('reports an error and loads nothing when the CSV has no usable rows', async () => {
    const { useStore, actions } = await setup();
    await actions.importCsvFile(fileOf(''));
    expect(useStore.getState().templateData).toEqual([]);
    const toast = useStore.getState().toasts.at(-1)!;
    expect(toast.kind).toBe('error');
  });

  it('keeps the good rows and warns about the bad ones', async () => {
    const { useStore, actions } = await setup();
    await actions.importCsvFile(fileOf('SKU,Name\nA1,Widget\nBROKEN\nA3,Thing\n'));
    expect(useStore.getState().templateData.length).toBe(2);
    const toast = useStore.getState().toasts.at(-1)!;
    expect(toast.kind).toBe('info'); // partial success is informational, not a failure
  });
});

describe('design import', () => {
  const fileOf = (text: string, name = 'design.json') => ({ text: async () => text, name }) as unknown as File;

  it('imports a valid design and adopts its name', async () => {
    const { useStore, actions } = await setup();
    const good = JSON.stringify({
      name: 'imported',
      elements: [{ id: 'e1', type: 'text', zone: 0, x: 1, y: 2, width: 3, height: 4, rotation: 0, text: 'hi' }],
      labelSize: { width: 40, height: 30 },
    });
    await actions.importDesignFile(fileOf(good));
    expect(useStore.getState().elements.length).toBe(1);
    expect(useStore.getState().designName).toBe('imported');
  });

  it('rejects malformed JSON without touching the current document', async () => {
    const { useStore, actions } = await setup();
    const { createText } = await import('../src/core/model/elements');
    useStore.getState().add(createText('KEEP'));
    await actions.importDesignFile(fileOf('{not json'));
    expect(useStore.getState().elements.length).toBe(1);
    expect(useStore.getState().toasts.at(-1)!.kind).toBe('error');
  });

  it('rejects a design whose element geometry is non-numeric', async () => {
    const { useStore, actions } = await setup();
    const bad = JSON.stringify({
      elements: [{ id: 'e1', type: 'text', zone: 0, x: 'oops', y: 2, width: 3, height: 4, rotation: 0 }],
      labelSize: { width: 40, height: 30 },
    });
    await actions.importDesignFile(fileOf(bad));
    expect(useStore.getState().elements).toEqual([]);
    expect(useStore.getState().toasts.at(-1)!.kind).toBe('error');
  });

  it('falls back to the file name when the design carries none', async () => {
    const { useStore, actions } = await setup();
    const good = JSON.stringify({ elements: [], labelSize: { width: 40, height: 30 } });
    await actions.importDesignFile(fileOf(good, 'my-file.json'));
    expect(useStore.getState().designName).toBe('my-file');
  });
});

describe('saving', () => {
  it('saveCurrentDesign stores the design and clears the dirty flag', async () => {
    const { useStore, actions } = await setup();
    const { createText } = await import('../src/core/model/elements');
    useStore.getState().add(createText('X'));
    expect(useStore.getState().dirty).toBe(true);

    const ok = actions.saveCurrentDesign('My Design');
    expect(ok).toBe(true);
    expect(useStore.getState().dirty).toBe(false);
    expect(useStore.getState().designName).toBe('My Design');
    expect(store.map.has('phomymo_designs')).toBe(true);
  });

  it('saveCurrentDesign reports failure instead of throwing when storage is full', async () => {
    const { useStore, actions } = await setup();
    store.setItem = () => { throw new Error('QuotaExceededError'); };
    const ok = actions.saveCurrentDesign('Nope');
    expect(ok).toBe(false);
    expect(useStore.getState().toasts.at(-1)!.kind).toBe('error');
  });
});
