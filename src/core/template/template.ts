/**
 * Template fields ({{Name}}), instant expressions ([[date|YYYY-MM-DD]]) and CSV.
 * Ported from the original templates.js with identical behaviour.
 */
import type { LabelElement } from '../model/elements';

const FIELD = /\{\{([^}]+)\}\}/g;
const EXPR = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
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
  // Token order matters: longer tokens first.
  return format
    .replace(/YYYY/g, String(year))
    .replace(/YY/g, String(year).slice(-2))
    .replace(/MM/g, p2(month))
    .replace(/M/g, String(month))
    .replace(/DD/g, p2(day))
    .replace(/D/g, String(day))
    .replace(/HH/g, p2(h24))
    .replace(/H/g, String(h24))
    .replace(/hh/g, p2(h12))
    .replace(/h/g, String(h12))
    .replace(/mm/g, p2(min))
    .replace(/m/g, String(min))
    .replace(/ss/g, p2(sec))
    .replace(/s/g, String(sec))
    .replace(/A/g, ampm)
    .replace(/a/g, ampm.toLowerCase())
    .replace(/Z/g, tz);
}

// ---- CSV ------------------------------------------------------------------------

export interface CsvResult { headers: string[]; records: TemplateRecord[]; errors: string[] }

export function parseCSV(csv: string): CsvResult {
  const lines = csv.split(/\r?\n/);
  const errors: string[] = [];
  const records: TemplateRecord[] = [];
  if (lines.length === 0) return { headers: [], records: [], errors: ['Empty CSV file'] };
  const headers = parseLine(lines[0]);
  if (headers.length === 0) return { headers: [], records: [], errors: ['No headers found in CSV'] };

  for (let i = 1; i < lines.length; i++) {
    if (records.length >= MAX_CSV_RECORDS) {
      errors.push(`CSV truncated: Maximum ${MAX_CSV_RECORDS} records allowed`);
      break;
    }
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseLine(line);
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

function parseLine(line: string): string[] {
  const values: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { values.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  values.push(cur.trim());
  return values;
}

export function toCSV(headers: string[], records: TemplateRecord[]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  return [headers.map(esc).join(','), ...records.map((r) => headers.map((h) => esc(String(r[h] || ''))).join(','))].join('\n');
}
