// @vitest-environment jsdom
/**
 * Importing a design file must never destroy work without asking.
 *
 * importDesignFile used to call saveDesign() unconditionally. A file whose name matched a saved design
 * replaced it, with no confirmation, no undo, and only a success toast — so the user found out that
 * the design they had been working on was gone.
 *
 * The service reports the clash and lets the caller decide, because only the UI can ask a question.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { importDesignAs, importDesignFile, readDesignFile } from '../src/services/actions';
import { listDesigns, loadDesign, saveDesign } from '../src/core/storage/storage';
import { useStore } from '../src/state/store';
import { createText } from '../src/core/model/elements';

beforeEach(() => {
  localStorage.clear();
  useStore.getState().newDesign();
  useStore.setState({ toasts: [], dialog: null });
});

const designJSON = (name: string, text: string) =>
  JSON.stringify({ name, elements: [{ ...createText(text) }], labelSize: { width: 40, height: 30 } });

const file = (name: string, body: string) =>
  ({ name, type: 'application/json', text: async () => body, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as File;

describe('a name that is free', () => {
  it('imports and opens the design', async () => {
    const r = await importDesignFile(file('a.json', designJSON('Fresh', 'HELLO')));
    expect(r.ok).toBe(true);
    expect(r.conflict).toBeNull();
    expect(useStore.getState().designName).toBe('Fresh');
    expect(useStore.getState().elements).toHaveLength(1);
  });

  it('falls back to the file name when the JSON carries no name', async () => {
    const body = JSON.stringify({ elements: [{ ...createText('X') }], labelSize: { width: 40, height: 30 } });
    const r = await importDesignFile(file('from-file.json', body));
    expect(r.ok).toBe(true);
    expect(r.name).toBe('from-file');
  });

  it('uses the file name with .json stripped', async () => {
    const body = JSON.stringify({ elements: [{ ...createText('X') }], labelSize: { width: 40, height: 30 } });
    expect((await importDesignFile(file('My Design.JSON', body))).name).toBe('My Design');
  });

  it('saves it so it appears in the designs list', async () => {
    await importDesignFile(file('a.json', designJSON('Fresh', 'HELLO')));
    expect(listDesigns().map((d) => d.name)).toContain('Fresh');
  });
});

describe('a name that already exists', () => {
  beforeEach(() => { saveDesign('Taken', { elements: [createText('ORIGINAL')], labelSize: { width: 40, height: 30 } }); });

  it('refuses and reports the clash rather than overwriting', async () => {
    const r = await importDesignFile(file('t.json', designJSON('Taken', 'REPLACEMENT')));
    expect(r.ok).toBe(false);
    expect(r.conflict).toBe('Taken');
    expect(r.name).toBe('Taken');
  });

  it('leaves the existing design untouched', async () => {
    await importDesignFile(file('t.json', designJSON('Taken', 'REPLACEMENT')));
    expect(loadDesign('Taken')?.elements[0]).toMatchObject({ text: 'ORIGINAL' });
  });

  it('does not open the incoming design either', async () => {
    // Loading it into the editor without saving would still lose the user's current work.
    await importDesignFile(file('t.json', designJSON('Taken', 'REPLACEMENT')));
    expect(useStore.getState().designName).not.toBe('Taken');
  });

  it('does not report success', async () => {
    await importDesignFile(file('t.json', designJSON('Taken', 'REPLACEMENT')));
    expect(useStore.getState().toasts.at(-1)?.kind).not.toBe('success');
  });

  it('importDesignAs then replaces it, as the confirmed path does', async () => {
    const { design } = await readDesignFile(file('t.json', designJSON('Taken', 'REPLACEMENT')));
    expect(importDesignAs('Taken', design)).toBe(true);
    expect(loadDesign('Taken')?.elements[0]).toMatchObject({ text: 'REPLACEMENT' });
    expect(useStore.getState().designName).toBe('Taken');
  });
});

describe('a malformed file', () => {
  it('reports the error and imports nothing', async () => {
    const r = await importDesignFile(file('bad.json', '{not json'));
    expect(r.ok).toBe(false);
    expect(r.conflict).toBeNull();
    expect(useStore.getState().toasts.at(-1)?.kind).toBe('error');
    expect(listDesigns()).toEqual([]);
  });

  it('reports a shape error', async () => {
    const r = await importDesignFile(file('bad.json', JSON.stringify({ elements: 'nope' })));
    expect(r.ok).toBe(false);
    expect(useStore.getState().toasts.at(-1)?.kind).toBe('error');
  });

  it('a name colliding with Object.prototype is still just a clash', async () => {
    saveDesign('constructor', { elements: [createText('ORIGINAL')], labelSize: { width: 40, height: 30 } });
    const r = await importDesignFile(file('t.json', designJSON('constructor', 'NEW')));
    expect(r.conflict).toBe('constructor');
    expect(loadDesign('constructor')?.elements[0]).toMatchObject({ text: 'ORIGINAL' });
  });

  it('readDesignFile parses without saving', async () => {
    const parsed = await readDesignFile(file('x.json', designJSON('Peek', 'P')));
    expect(parsed.name).toBe('Peek');
    expect(parsed.design.elements).toHaveLength(1);
    expect(listDesigns()).toEqual([]);
  });
});

describe('the confirmation strings are translated', () => {
  it('both languages carry the keys with a name placeholder', async () => {
    const { translate } = await import('../src/i18n');
    for (const lang of ['en', 'ar'] as const) {
      const overwrite = translate(lang, 'confirmOverwriteName', { name: 'مطعم' });
      expect(overwrite).toContain('مطعم');
      expect(overwrite).not.toBe('confirmOverwriteName');
      const del = translate(lang, 'confirmDeleteNamed', { name: 'x' });
      expect(del).toContain('x');
    }
  });

  it('no prompt is a bare "${n}?" any more', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/ui/Dialogs.tsx', 'utf8');
    expect(src).not.toMatch(/confirm\(`\$\{n\}\?`\)/);
    expect(src).not.toMatch(/\$\{t\('delete'\)\}: \$\{/);
  });
});
