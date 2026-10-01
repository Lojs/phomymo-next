import { useCallback } from 'react';
import { en, type Key } from './en';
import { ar } from './ar';
import { useStore } from '../state/store';

export type Lang = 'en' | 'ar';
export type { Key };

const dict: Record<Lang, Record<Key, string>> = { en, ar };

export function translate(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  let s = dict[lang][key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export const dirOf = (lang: Lang) => (lang === 'ar' ? 'rtl' : 'ltr');

export function useT() {
  const lang = useStore((s) => s.lang);
  return useCallback((key: Key, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang]);
}
