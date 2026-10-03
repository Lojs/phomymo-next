/**
 * Template fields ({{Name}}), instant expressions ([[date|YYYY-MM-DD]]) and CSV.
 * Ported from the original templates.js with identical behaviour.
 */
import type { LabelElement } from '../model/elements';

const FIELD = /\{\{([^}]+)\}\}/g;
// The format group accepts anything up to the final `]]`, so a literal block like
// "[[date|[YYYY] YYYY]]" reaches formatDateTime intact. The previous `[^\]]*` stopped at the first
// `]`, which meant the literal-block escape could never actually be written by a user.
const EXPR = /\[\[([^\]|]+)(?:\|((?:[^\]]|\](?!\]))*))?\]\]/g;
const MAX_CSV_RECORDS = 10000;

export type TemplateRecord = Record<string, string>;

/** Elements' string fields that may contain placeholders. */
const TEXT_KEYS = ['text', 'barcodeData', 'qrData'] as const;

function mapStrings(el: LabelElement, fn: (s: string) => string): LabelElement {
  const clone = { ...el } as Record<string, unknown>;
  for (const k of TEXT_KEYS) {
    const v = clone[k];
    if (typeof v === 'string' && v) clone[k] = fn(v);
  }
  return clone as unknown as LabelElement;
}

export function extractFields(elements: LabelElement[]): string[] {
  const fields = new Set<string>();
  for (const el of elements) {
    for (const k of TEXT_KEYS) {
      const v = (el as unknown as Record<string, unknown>)[k];
      if (typeof v !== 'string') continue;
      for (const m of v.matchAll(FIELD)) fields.add(m[1].trim());
    }
  }
  return [...fields];
}

const subst = (str: string, rec: TemplateRecord) =>
  str.replace(FIELD, (match, field: string) => {
    const f = field.trim();
    return Object.prototype.hasOwnProperty.call(rec, f) ? rec[f] : match;
  });

export const substituteFields = (els: LabelElement[], rec: TemplateRecord) => els.map((el) => mapStrings(el, (s) => subst(s, rec)));

/** Multi-label rolls with "clone" off: each zone gets its own record. */
export function substituteFieldsByZone(els: LabelElement[], records: (TemplateRecord | undefined)[]): LabelElement[] {
  return els.map((el) => {
    const rec = records[el.zone || 0];
    return rec ? mapStrings(el, (s) => subst(s, rec)) : { ...el };
  });
}

export const createEmptyRecord = (fields: string[]): TemplateRecord => Object.fromEntries(fields.map((f) => [f, '']));

export const generateSampleData = (fields: string[], count = 3): TemplateRecord[] =>
  Array.from({ length: count }, (_, i) => Object.fromEntries(fields.map((f) => [f, `${f} ${i + 1}`])));

// ---- expressions --------------------------------------------------------------

export function hasExpressions(els: LabelElement[]): boolean {
  const probe = new RegExp(EXPR.source);
  return els.some((el) => TEXT_KEYS.some((k) => {
    const v = (el as unknown as Record<string, unknown>)[k];
    return typeof v === 'string' && probe.test(v);
  }));
}

export function evaluateExpressions(els: LabelElement[], now: Date = new Date()): LabelElement[] {
  return els.map((el) => mapStrings(el, (s) => evalString(s, now)));
}

function evalString(str: string, now: Date): string {
  return str.replace(EXPR, (match, expr: string, format?: string) => {
    const e = expr.trim().toLowerCase();
    const f = format?.trim() || null;
    const pad = (n: number) => String(n).padStart(2, '0');
    switch (e) {
      case 'dt':
      case 'datetime': return formatDateTime(now, f || 'YYYY-MM-DD HH:mm:ss');
      case 'date': return formatDateTime(now, f || 'YYYY-MM-DD');
      case 'time': return formatDateTime(now, f || 'HH:mm:ss');
      case 'timestamp':
      case 'ts': return String(now.getTime());
      case 'year': return String(now.getFullYear());
      case 'month': return pad(now.getMonth() + 1);
      case 'day': return pad(now.getDate());
      case 'hour': return pad(now.getHours());
      case 'minute':
      case 'min': return pad(now.getMinutes());
      case 'second':
      case 'sec': return pad(now.getSeconds());
      default: return match;
    }
  });
}

function formatDateTime(d: Date, format: string): string {
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const h24 = d.getHours();
  const h12 = h24 % 12 || 12;
  const min = d.getMinutes();
  const sec = d.getSeconds();
  const ampm = h24 < 12 ? 'AM' : 'PM';
  const off = d.getTimezoneOffset();
  const tz = `${off <= 0 ? '+' : '-'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`;
  const p2 = (n: number) => String(n).padStart(2, '0');

  /*
   * Token scan rather than a chain of global replacements.
   *
   * The old chain replaced every literal D, a, s, h and m in the format, so any ordinary word
   * containing those letters was mangled — "DD days" lost its "days", and a user's own text could be
   * rewritten without warning. Three rules fix that while keeping every existing format string working
   * exactly as before:
   *
   *   - tokens are matched longest-first, so MM is a month and not two Ms;
   *   - `\` escapes the next character, so `\d` is a literal d;
   *   - `[...]` is a literal block, the usual dayjs-style escape for text containing letters.
   *
   * Unknown characters pass through untouched, which is what the old `default: return match` did for
   * unrecognised expressions.
   */
  const TOKENS: Record<string, string> = {
    YYYY: String(year), YY: String(year).slice(-2),
    MM: p2(month), M: String(month),
    DD: p2(day), D: String(day),
    HH: p2(h24), H: String(h24),
    hh: p2(h12), h: String(h12),
    mm: p2(min), m: String(min),
    ss: p2(sec), s: String(sec),
    A: ampm, a: ampm.toLowerCase(),
    Z: tz,
  };
  // Longest first: MM must win over M, and so on down the list.
  const NAMES = Object.keys(TOKENS).sort((a, b) => b.length - a.length);

  let out = '';
  for (let i = 0; i < format.length; i++) {
    const ch = format[i];

    if (ch === '\\') {                                  // escaped character
      if (i + 1 < format.length) out += format[++i];
      continue;
    }
    if (ch === '[') {                                     // literal block, may nest
      let depth = 1;
      i++;
      while (i < format.length && depth > 0) {
        if (format[i] === '[') depth++;
        else if (format[i] === ']') { depth--; if (depth === 0) break; }
        out += format[i++];
      }
      continue;
    }
    const name = NAMES.find((n) => format.startsWith(n, i));
    if (name) { out += TOKENS[name]; i += name.length - 1; continue; }
    out += ch;
  }
  return out;
}

// ---- CSV ------------------------------------------------------------------------

export interface CsvResult { headers: string[]; records: TemplateRecord[]; errors: string[] }

/**
 * Split CSV text into rows of fields.
 *
 * This walks the whole text as one character stream rather than splitting on newlines first. That
 * order matters: a quoted cell is allowed to contain a newline ("line1\nline2" is one cell), and
 * splitting first turned such a cell into two broken rows — so the app could not read a file that
 * its own exporter had just written. Quoting is the only thing that suppresses a delimiter or a
 * line break; outside quotes both are structural.
 *
 * `delim` is detected by the caller and passed in, because Excel under several locales writes
 * semicolon-separated files and a fixed comma turned those into a single column named "a;b".
 */
function parseRows(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  let started = false; // a row exists once any character, including a delimiter, has been seen

  const endField = () => { row.push(cur.trim()); cur = ''; };
  const endRow = () => { endField(); if (started) rows.push(row); row = []; started = false; };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }   // "" is an escaped quote
        else quoted = false;
      } else cur += ch;                                   // newlines inside quotes are data
      continue;
    }
    if (ch === '"') { quoted = true; started = true; continue; }
    if (ch === delim) { started = true; endField(); continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i++; endRow(); continue; }
    if (ch === '\n') { endRow(); continue; }
    if (ch !== ' ') started = true;
    cur += ch;
  }
  if (started || cur !== '') endRow();
  return rows;
}

/**
 * Pick the delimiter from the header line.
 *
 * Counts each candidate outside quotes and takes the one that appears most; ties go to comma, so a
 * plain comma file is unchanged. Only the first physical line is inspected, because that is where the
 * column count is decided.
 */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  let quoted = false;
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i];
    if (ch === '"') {
      if (quoted && firstLine[i + 1] === '"') i++;
      quoted = !quoted;
      continue;
    }
    if (!quoted && ch in counts) counts[ch] += 1;
  }
  let best = ',';
  let bestCount = counts[','];
  for (const d of [';', '\t']) if (counts[d] > bestCount) { best = d; bestCount = counts[d]; }
  return best;
}

export function parseCSV(csv: string): CsvResult {
  const errors: string[] = [];
  const records: TemplateRecord[] = [];
  if (!csv.trim()) return { headers: [], records: [], errors: ['Empty CSV file'] };

  const delim = detectDelimiter(csv);
  const rows = parseRows(csv, delim);
  if (rows.length === 0) return { headers: [], records: [], errors: ['Empty CSV file'] };

  const headers = rows[0];
  if (headers.length === 0 || headers.every((h) => h === '')) {
    return { headers: [], records: [], errors: ['No headers found in CSV'] };
  }

  for (let i = 1; i < rows.length; i++) {
    if (records.length >= MAX_CSV_RECORDS) {
      errors.push(`CSV truncated: Maximum ${MAX_CSV_RECORDS} records allowed`);
      break;
    }
    const values = rows[i];
    if (values.length === 1 && values[0] === '') continue;   // blank line
    if (values.length !== headers.length) {
      errors.push(`Row ${i + 1}: Expected ${headers.length} columns, got ${values.length}`);
      continue;
    }
    const rec: TemplateRecord = {};
    headers.forEach((h, j) => (rec[h] = values[j]));
    records.push(rec);
  }
  return { headers, records, errors };
}

export function toCSV(headers: string[], records: TemplateRecord[]): string {
  const esc = (v: string) => (/[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  // `r[h] || ''` turned a legitimate 0 into an empty cell, so a quantity column exported blanks for
  // every zero row and a round-trip lost the data. Only null/undefined/'' are genuinely empty; 0 and
  // false are values.
  const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return [
    headers.map(esc).join(','),
    ...records.map((r) => headers.map((h) => esc(cell(r[h]))).join(',')),
  ].join('\n');
}
