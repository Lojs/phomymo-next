/**
 * CSV parsing and the date format string — the two places where "obviously simple" text handling
 * quietly loses data.
 *
 * Every case here is one that worked before and silently did the wrong thing: a quoted cell holding a
 * newline broke into two rows, a semicolon file became a single column, and a quantity of 0 exported as
 * a blank. The round-trip tests matter most — the app exports CSV and reads it back, so a writer that
 * produces something its own reader cannot parse is a real defect, not a theoretical one.
 */
import { describe, it, expect } from 'vitest';
import { parseCSV, toCSV, evaluateExpressions, type TemplateRecord } from '../src/core/template/template';
import type { TextElement } from '../src/core/model/elements';

const text = (t: string) => [{ id: 'e', type: 'text', text: t, x: 0, y: 0, width: 10, height: 10 }] as never;
const rendered = (t: string) => (evaluateExpressions(text(t))[0] as TextElement).text;

describe('a newline inside a quoted cell is data, not a row break', () => {
  // The exporter writes exactly this shape (see the round-trip tests below), so the reader failing to
  // handle it meant the app could not re-import its own export.
  it('keeps a multi-line cell as one field', () => {
    const r = parseCSV('a,b\n"line1\nline2",x\n');
    expect(r.errors).toEqual([]);
    expect(r.headers).toEqual(['a', 'b']);
    expect(r.records).toHaveLength(1);
    expect(r.records[0].a).toBe('line1\nline2');
    expect(r.records[0].b).toBe('x');
  });

  it('keeps a comma inside a quoted cell', () => {
    const r = parseCSV('a,b\n"x,y",z\n');
    expect(r.records[0].a).toBe('x,y');
  });

  it('handles an escaped quote inside a quoted cell', () => {
    const r = parseCSV('a,b\n"say ""hi""",z\n');
    expect(r.records[0].a).toBe('say "hi"');
  });

  it('handles CRLF line endings', () => {
    const r = parseCSV('a,b\r\n1,2\r\n');
    expect(r.records).toHaveLength(1);
    expect(r.records[0].a).toBe('1');
    expect(r.records[0].b).toBe('2');
  });

  it('handles a quoted cell containing CRLF', () => {
    const r = parseCSV('a,b\r\n"x\r\ny",2\r\n');
    expect(r.records[0].a).toBe('x\r\ny');
  });

  it('ignores blank lines', () => {
    const r = parseCSV('a,b\n1,2\n\n3,4\n');
    expect(r.records).toHaveLength(2);
    expect(r.errors).toEqual([]);
  });

  it('reports a genuinely short row rather than guessing', () => {
    const r = parseCSV('a,b,c\n1,2\n');
    expect(r.records).toHaveLength(0);
    expect(r.errors[0]).toMatch(/Expected 3 columns, got 2/);
  });
});

describe('delimiter detection', () => {
  it('reads a semicolon-separated file, as Excel writes under several locales', () => {
    const r = parseCSV('a;b;c\n1;2;3\n');
    expect(r.errors).toEqual([]);
    expect(r.headers).toEqual(['a', 'b', 'c']);
    expect(r.records[0]).toMatchObject({ a: '1', b: '2', c: '3' });
  });

  it('reads a tab-separated file', () => {
    const r = parseCSV('a\tb\n1\t2\n');
    expect(r.headers).toEqual(['a', 'b']);
    expect(r.records[0]).toMatchObject({ a: '1', b: '2' });
  });

  it('still reads a plain comma file', () => {
    const r = parseCSV('a,b\n1,2\n');
    expect(r.headers).toEqual(['a', 'b']);
    expect(r.records[0]).toMatchObject({ a: '1', b: '2' });
  });

  it('does not count a delimiter that appears inside a quoted header', () => {
    // "last, first" is one column; the comma inside the quotes must not win the detection.
    const r = parseCSV('"last, first";age\n"Smith";30\n');
    expect(r.headers).toEqual(['last, first', 'age']);
    expect(r.records[0]).toMatchObject({ 'last, first': 'Smith', age: '30' });
  });

  it('a single-column file is still one column', () => {
    const r = parseCSV('name\nalpha\n');
    expect(r.headers).toEqual(['name']);
    expect(r.records[0].name).toBe('alpha');
  });
});

describe('toCSV preserves a zero', () => {
  // `r[h] || ''` used to write an empty cell for 0, so every zero row exported blank and a round-trip
  // lost the value entirely.
  it('writes 0 rather than an empty cell', () => {
    expect(toCSV(['qty'], [{ qty: 0 } as never])).toBe('qty\n0');
  });

  it('writes false rather than an empty cell', () => {
    expect(toCSV(['flag'], [{ flag: false } as never])).toBe('flag\nfalse');
  });

  it('writes a real empty cell only for null/undefined', () => {
    expect(toCSV(['v'], [{ v: null } as never, { v: undefined } as never])).toBe('v\n\n');
  });

  it('quotes a value containing a newline, and quotes a CR', () => {
    expect(toCSV(['v'], [{ v: 'a\nb' } as never])).toBe('v\n"a\nb"');
    expect(toCSV(['v'], [{ v: 'a\rb' } as never])).toBe('v\n"a\rb"');
  });
});

describe('CSV round-trips through the app\'s own writer and reader', () => {
  // Numbers are the point of these rows, so they are cast rather than stringified by hand.
  const rows = [
    { sku: 'A-1', name: 'Bean, dark roast', qty: 0 },
    { sku: 'B-2', name: 'Line one\nline two', qty: 12 },
    { sku: 'C-3', name: 'He said "hi"', qty: 0 },
  ] as unknown as TemplateRecord[];

  it('a multi-line and comma-bearing cell survives export then import', () => {
    const out = toCSV(['sku', 'name', 'qty'], rows);
    const back = parseCSV(out);
    expect(back.errors).toEqual([]);
    expect(back.records).toHaveLength(3);
    expect(back.records[1].name).toBe('Line one\nline two');
    expect(back.records[0].name).toBe('Bean, dark roast');
  });

  it('a zero quantity survives export then import', () => {
    const back = parseCSV(toCSV(['sku', 'qty'], rows));
    expect(back.records[0].qty).toBe('0');
    expect(back.records[2].qty).toBe('0');
    expect(back.records[1].qty).toBe('12');
  });

  it('a quote inside a cell survives export then import', () => {
    const back = parseCSV(toCSV(['sku', 'name'], rows));
    expect(back.records[2].name).toBe('He said "hi"');
  });
});

describe('empty input', () => {
  it.each(['', '   ', '\n\n'])('reports an empty file for %j', (csv) => {
    const r = parseCSV(csv);
    expect(r.records).toEqual([]);
    expect(r.headers).toEqual([]);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe('the date format string', () => {
  // The old implementation ran a chain of global replacements, so every literal D, a, s, h and m in
  // the format was eaten. A format like "DD days" lost the word "days".
  it('substitutes the standard tokens', () => {
    expect(rendered('[[date|YYYY-MM-DD]]')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rendered('[[date|HH:mm:ss]]')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('keeps a word containing token letters intact', () => {
    // Before the fix this rendered as "15 " and the word vanished.
    const out = rendered(`[[date|DD [days] HH]]`);
    expect(out).toMatch(/days/);
  });

  it('supports a backslash escape', () => {
    const out = rendered('[[date|YYYY\\D\\D]]');
    expect(out).toMatch(/^\d{4}DD$/);
  });

  it('supports a literal block containing token letters', () => {
    // The brackets themselves are the delimiters and are consumed; the text between them is literal,
    // which is how dayjs-style escapes read.
    expect(rendered('[[date|[YYYY] YYYY]]')).toMatch(/^YYYY \d{4}$/);
  });

  it('still prefers the longer token, so MM is a month and not two Ms', () => {
    expect(rendered('[[date|MM]]')).toMatch(/^\d{2}$/);
    expect(rendered('[[date|M]]')).toMatch(/^\d{1,2}$/);
  });

  it('leaves an unrecognised character alone', () => {
    expect(rendered('[[date|YYYY|MM/DD]]')).toMatch(/^\d{4}\|\d{2}\/\d{2}$/);
  });
});

describe('an empty quoted cell is data, not a blank line', () => {
  // `""` is an empty cell. Treating it as a blank line drops the row and loses that column's value —
  // and the exporter writes exactly this shape for an empty field that must stay empty.
  it('keeps a row whose only content is a quoted empty field', () => {
    const r = parseCSV('a,b\n"",x\n');
    expect(r.errors).toEqual([]);
    expect(r.records).toHaveLength(1);
    expect(r.records[0].a).toBe('');
    expect(r.records[0].b).toBe('x');
  });

  it('still skips a genuinely blank line', () => {
    const r = parseCSV('a,b\n1,2\n\n3,4\n');
    expect(r.records).toHaveLength(2);
  });

  it('keeps a row of only empty quoted fields', () => {
    const r = parseCSV('a,b\n"",""\n');
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toEqual({ a: '', b: '' });
  });

  it('survives the round-trip', () => {
    const rows = [{ a: '', b: 'x' }] as TemplateRecord[];
    const back = parseCSV(toCSV(['a', 'b'], rows));
    expect(back.errors).toEqual([]);
    expect(back.records).toHaveLength(1);
    expect(back.records[0].a).toBe('');
  });
});

describe('a byte-order mark is not part of the first header', () => {
  // Excel writes a BOM. Left in place it becomes part of the header name, so a column the template
  // calls "name" is really "\uFEFFname" and the field never matches.
  it('strips it', () => {
    const r = parseCSV('\uFEFFname,qty\nBean,3\n');
    expect(r.headers).toEqual(['name', 'qty']);
    expect(r.records[0]).toMatchObject({ name: 'Bean', qty: '3' });
  });

  it('leaves a file without one alone', () => {
    expect(parseCSV('name\nBean\n').headers).toEqual(['name']);
  });
});

describe('error messages point at the physical line', () => {
  it('reports the real line after a multi-line cell', () => {
    // The quoted cell spans lines 2-4, so "bad" is physically line 5 — while it is only the third
    // row. Counting rows would point at the wrong line.
    const r = parseCSV('a,b\n"x\ny\nz",2\nbad\n');
    expect(r.errors).toEqual(['Row 5: Expected 2 columns, got 1']);
  });

  it('reports the real line after blank lines', () => {
    const r = parseCSV('a,b\n1,2\n\n\nbad\n');
    expect(r.errors).toEqual(['Row 5: Expected 2 columns, got 1']);
  });
});
