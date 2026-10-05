/**
 * The import boundary and what a printer may report: image sources, size limits, reported values.
 *
 *  D3  An imported image element accepted any string as imageData, including a remote URL, so a
 *      hostile design file could make the browser contact an attacker's server with the victim's
 *      IP and a query string of the attacker's choosing.
 *  D5  The 25 MB import limit was thrown with a message naming the file and the limit, and the
 *      image callers caught it with a bare `catch {}` and showed a generic toast, so the one
 *      sentence that explains the refusal never reached the user.
 *  D6  Printer-reported values were displayed verbatim: a frame of `1a 04 ff` showed "255%", and a
 *      500-byte frame produced a 500-character serial.
 *  D8  The README said printing works over USB on Windows, which it does not.
 *
 * D1 (the abandoned connect leaving the radio link up) is covered in printing-connect.test.ts, and
 * D2 (the service worker never removing dead hashed assets) in service-worker.test.ts — both where
 * the code can actually be executed rather than grepped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadDesign, parseDesignJSON } from '../src/core/storage/storage';

/**
 * A minimal valid design file, with one element of the given type and fields.
 *
 * parseDesignJSON rejects the whole file when any element fails validation, rather than dropping
 * that element — so a hostile image is refused as a bad file, not silently stripped.
 */
const designWith = (element: Record<string, unknown>) =>
  JSON.stringify({
    name: 'hostile',
    labelSize: { width: 40, height: 30, orientation: 'landscape' },
    elements: [{ id: 'e1', x: 0, y: 0, width: 40, height: 30, rotation: 0, ...element }],
  });

/** True when the file parses, i.e. every element passed isElement(). */
const imports = (element: Record<string, unknown>) => {
  try {
    parseDesignJSON(designWith(element));
    return true;
  } catch {
    return false;
  }
};

describe('D3: an imported image element may only carry inline pixels', () => {
  it('accepts a data: URL, which is the only form this app writes', () => {
    expect(imports({ type: 'image', imageData: 'data:image/png;base64,iVBORw0KGgo=' })).toBe(true);
  });

  it('rejects an image element pointing at a remote URL', () => {
    // Opening the design must not make the browser contact the attacker. The shipped container's
    // CSP would also block it, but `npm run dev`, `npm run preview` and any other host serving the
    // built files have no such policy.
    expect(imports({ type: 'image', imageData: 'https://evil.example/pixel.png?id=victim' })).toBe(false);
  });

  it.each([
    'http://evil.example/p.png',
    '//evil.example/p.png',
    'javascript:alert(1)',
    'blob:https://evil.example/abc',
    'file:///etc/passwd',
  ])('rejects %s', (src) => {
    expect(imports({ type: 'image', imageData: src })).toBe(false);
  });

  it('rejects an image element with no imageData at all', () => {
    expect(imports({ type: 'image' })).toBe(false);
  });

  it('leaves other element types alone — a text element has no imageData', () => {
    expect(imports({ type: 'text', text: 'hello' })).toBe(true);
  });
});

describe('E2: an image whose data URL has a non-image MIME type survives', () => {
  /**
   * A file the picker reports with an empty MIME type is read by FileReader as
   * `data:application/octet-stream;...` — Chrome behaviour. The guard used to require the literal
   * prefix `data:image/`, so such an element displayed and printed and then vanished on the next
   * load, with no message. The requirement was always "no network URL"; any data: URL satisfies it,
   * and browsers sniff the type from the bytes.
   */
  const octet = 'data:application/octet-stream;base64,iVBORw0KGgo=';

  it('is accepted on import', () => {
    expect(imports({ type: 'image', imageData: octet })).toBe(true);
  });

  it('is still rejected when it points at a network URL', () => {
    // The guard exists for this, and widening it to any data: URL must not widen it to anything.
    expect(imports({ type: 'image', imageData: 'https://evil.example/pixel.png?id=victim' })).toBe(false);
  });

  it('survives a save-and-reload instead of being filtered out silently', () => {
    const map = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      },
      configurable: true,
      writable: true,
    });
    const file = JSON.parse(designWith({ type: 'image', imageData: octet }));
    map.set('phomymo_designs', JSON.stringify({ hostile: { elements: file.elements, labelSize: file.labelSize } }));
    // Before the fix this came back with 0 elements: isElement() rejected the data URL, and
    // loadDesign() filters silently, so the picture simply was not there any more.
    expect(loadDesign('hostile')?.elements).toHaveLength(1);
  });
});

describe('D6: printer-reported values are not shown raw', () => {
  /** Fire a notification frame at the transport and return what it recorded. */
  const report = (t: { handleNotification: (e: unknown) => void; printerInfo: Record<string, unknown> }, bytes: number[]) => {
    const value = new DataView(Uint8Array.from(bytes).buffer);
    t.handleNotification({ target: { value } });
    return t.printerInfo;
  };

  const transport = async () => {
    const { BLETransport } = await import('../src/transport/ble');
    return new BLETransport();
  };

  it('an out-of-range battery byte is unknown, not 255%', async () => {
    const t = await transport();
    // The printer's own low-battery codes stay as they were.
    expect(report(t, [0x1a, 0x04, 0xa4]).battery).toBe(0);
    expect(report(t, [0x1a, 0x04, 0xa1]).battery).toBe(10);
    // A plain percentage passes through...
    expect(report(t, [0x1a, 0x04, 80]).battery).toBe(80);
    // ...but a byte that cannot be a percentage is not displayed as one.
    expect(report(t, [0x1a, 0x04, 0xff]).battery).toBeNull();
  });

  it('a long serial or MAC is capped rather than rendered in full', async () => {
    const t = await transport();
    const long = new Array(500).fill(0x41);   // 500 'A' bytes
    expect(report(t, [0x1a, 0x08, ...long]).serial).toHaveLength(64);
    expect(report(t, [0x1a, 0x0d, ...long]).mac).toHaveLength(64);
  });

  it('a realistic serial is untouched', async () => {
    const t = await transport();
    expect(report(t, [0x1a, 0x08, 0x41, 0x42, 0x43]).serial).toBe('ABC');
  });
});

describe('D5: the import limit reaches the user', () => {
  it('readDesignFile rejects an oversized file rather than reading it', async () => {
    // Executed rather than grepped: the v1.0.18 review's point (6.3) is that asserting words appear
    // in a source file gives false assurance — `expect(src).toMatch(/try/)` passes just as well
    // when the branch it should cover is dead. So call the function with a file it must refuse.
    const { readDesignFile } = await import('../src/services/actions');
    const huge = { size: 26 * 1024 * 1024, name: 'huge.json', text: async () => '{}' } as unknown as File;
    await expect(readDesignFile(huge)).rejects.toThrow(RangeError);
    await expect(readDesignFile(huge)).rejects.toThrow(/25 MB/);
  });

  it('a file within the limit is still read', async () => {
    const { readDesignFile } = await import('../src/services/actions');
    const ok = {
      size: 200,
      name: 'ok.json',
      text: async () => JSON.stringify({
        name: 'ok',
        labelSize: { width: 40, height: 30, orientation: 'landscape' },
        elements: [{ id: 'e1', type: 'text', text: 'hi', x: 0, y: 0, width: 40, height: 30, rotation: 0 }],
      }),
    } as unknown as File;
    await expect(readDesignFile(ok)).resolves.toMatchObject({ name: 'ok' });
  });

  it('the image callers show the thrown message instead of swallowing it', () => {
    // Both used `catch { toast(errorImage) }`, discarding the only sentence that says which file was
    // refused and what the limit is. This one is a text assertion because the catch block needs a
    // real browser File to reach; the behaviour above covers what it throws.
    const actions = readFileSync('src/services/actions.ts', 'utf8');
    expect(actions).not.toMatch(/catch\s*\{\s*st\(\)\.toast\(tr\('errorImage'\), 'error'\);\s*\}/);
    expect(actions).toMatch(/e instanceof RangeError/);
  });
});

describe('D8: the README does not promise USB on Windows', () => {
  it('names the Windows print-driver binding as the reason', () => {
    // The phrase is split across lines by markdown emphasis, so match on a whitespace-tolerant
    // pattern rather than the literal string with its line break in the middle.
    const readme = readFileSync('README.md', 'utf8').replace(/\s+/g, ' ');
    expect(readme).toMatch(/On Windows, use Bluetooth/);
    expect(readme).toMatch(/USB\s+Printing\s+Support/);
    expect(readme).toMatch(/WinUSB/);
  });
});