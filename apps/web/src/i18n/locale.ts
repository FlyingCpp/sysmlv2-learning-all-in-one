import type { i18n } from 'i18next';

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;
export type SupportedLocale = typeof SUPPORTED_LOCALES[number];

export const DEFAULT_LOCALE: SupportedLocale = 'zh-CN';
export const FALLBACK_LOCALE: SupportedLocale = 'zh-CN';
export const LOCALE_PREFERENCE_KEY = 'sysmlv2.ui-locale.v1';

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type LocaleProjectionSource = Pick<i18n, 'resolvedLanguage' | 'languages' | 'language'>;

export function matchSupportedLocale(value: unknown): SupportedLocale | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/_/g, '-').toLowerCase();
  if (!normalized) return null;
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en-US';
  if (
    normalized === 'zh'
    || normalized === 'zh-cn'
    || normalized === 'zh-sg'
    || normalized === 'zh-hans'
    || normalized === 'zh-hans-cn'
    || normalized === 'zh-hans-sg'
  ) return 'zh-CN';
  return null;
}

export function resolveInitialLocale(
  storedPreference: unknown,
  navigatorLanguages: readonly string[] = []
): SupportedLocale {
  const storedLocale = matchSupportedLocale(storedPreference);
  if (storedLocale) return storedLocale;
  for (const candidate of navigatorLanguages) {
    const locale = matchSupportedLocale(candidate);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

export function getResolvedLocale(instance: LocaleProjectionSource): SupportedLocale {
  return matchSupportedLocale(
    instance.resolvedLanguage
      || instance.languages[0]
      || instance.language
  ) || FALLBACK_LOCALE;
}

export function readLocalePreference(storage: LocaleStorage | null = browserStorage()): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(LOCALE_PREFERENCE_KEY);
  } catch {
    return null;
  }
}

export function persistLocalePreference(
  locale: SupportedLocale,
  storage: LocaleStorage | null = browserStorage()
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LOCALE_PREFERENCE_KEY, locale);
    return true;
  } catch {
    return false;
  }
}

export function browserNavigatorLanguages(): readonly string[] {
  try {
    const values = globalThis.navigator?.languages;
    if (Array.isArray(values) && values.length > 0) return values;
    return globalThis.navigator?.language ? [globalThis.navigator.language] : [];
  } catch {
    return [];
  }
}

export function resolveBrowserInitialLocale(): SupportedLocale {
  return resolveInitialLocale(readLocalePreference(), browserNavigatorLanguages());
}

export function directionForLocale(_locale: SupportedLocale): 'ltr' | 'rtl' {
  return 'ltr';
}

function browserStorage(): LocaleStorage | null {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}
