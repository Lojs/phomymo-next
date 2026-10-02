/**
 * i18n — key parity and placeholder integrity.
 *
 * The UI is Arabic-first, so a key that exists in English but not Arabic falls back to English
 * text in an otherwise Arabic interface; a key missing from both renders the raw key name. And a
 * substitution placeholder that is spelled differently between the two dictionaries shows a
 * literal `{n}` to the user. Both are cheap to check and expensive to notice by hand.
 *
 * Note on `{{Name}}`: that is a *literal* example of the template-field syntax the user types,
 * not a substitution slot — so it is deliberately translated (`{{الاسم}}` in Arabic) and is
 * excluded from the placeholder comparison below.
 */
import { describe, it, expect, vi } from 'vitest';

// i18n/index.ts pulls in the store (for the useT hook), which reads localStorage at module load —
// before any beforeAll runs. vi.hoisted installs the globals first.
vi.hoisted(() => {
  (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-US' },
    configurable: true,
    writable: true,
  });
});

import { en } from '../src/i18n/en';
import { ar } from '../src/i18n/ar';
import { translate, dirOf } from '../src/i18n';

const enKeys = Object.keys(en).sort();
const arKeys = Object.keys(ar).sort();

/**
 * Substitution slots in a string: single braces only. Double braces are the template-field
 * syntax shown to the user as an example, so they are stripped before matching.
 */
const placeholders = (s: string) =>
  [...s.replace(/\{\{[^}]*\}\}/g, '').matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();

describe('dictionary parity', () => {
  it('English and Arabic define exactly the same keys', () => {
    expect(arKeys).toEqual(enKeys);
  });

  it('every English key is present in Arabic', () => {
    const missing = enKeys.filter((k) => !(k in ar));
    expect(missing, `missing from ar.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('Arabic defines no key that English lacks', () => {
    const extra = arKeys.filter((k) => !(k in en));
    expect(extra, `extra in ar.ts: ${extra.join(', ')}`).toEqual([]);
  });

  it('no translation is an empty string', () => {
    for (const [k, v] of Object.entries(en)) expect(v, `en.${k}`).not.toBe('');
    for (const [k, v] of Object.entries(ar)) expect(v, `ar.${k}`).not.toBe('');
  });
});

describe('placeholder integrity', () => {
  it('a key uses the same placeholders in both languages', () => {
    const mismatched: string[] = [];
    for (const k of enKeys) {
      const a = placeholders(en[k as keyof typeof en] ?? '');
      const b = placeholders(ar[k as keyof typeof ar] ?? '');
      if (a.join(',') !== b.join(',')) mismatched.push(`${k}: en{${a}} vs ar{${b}}`);
    }
    expect(mismatched, mismatched.join(' | ')).toEqual([]);
  });

  it('substitutes a variable into both languages', () => {
    expect(translate('en', 'printedN', { n: 3 })).toContain('3');
    expect(translate('ar', 'printedN', { n: 3 })).toContain('3');
    expect(translate('en', 'printedN', { n: 3 })).not.toContain('{n}');
    expect(translate('ar', 'printedN', { n: 3 })).not.toContain('{n}');
  });

  it('leaves an unfilled placeholder visible rather than silently dropping it', () => {
    // Documents the contract: callers must pass the variables a key declares.
    expect(translate('en', 'printedN')).toContain('{n}');
  });
});

describe('translate', () => {
  it('returns the key itself for an unknown key instead of undefined', () => {
    expect(translate('en', 'definitelyNotAKey' as never)).toBe('definitelyNotAKey');
  });

  it('returns real text for a known key in both languages', () => {
    expect(translate('en', 'print')).toBe('Print');
    expect(translate('ar', 'print')).toBe('طباعة');
  });

  it('the two languages actually differ (not a copy-paste of English)', () => {
    expect(translate('ar', 'print')).not.toBe(translate('en', 'print'));
  });

  it('newly added keys resolve in both languages', () => {
    expect(translate('en', 'csvNoRecords')).toMatch(/no records/i);
    expect(translate('ar', 'csvNoRecords')).toMatch(/سجلات/);
  });
});

describe('direction', () => {
  it('Arabic is right-to-left and English is left-to-right', () => {
    expect(dirOf('ar')).toBe('rtl');
    expect(dirOf('en')).toBe('ltr');
  });
});
