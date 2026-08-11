import type { SupportedLocale } from './locale';
import { getResolvedLocale, persistLocalePreference, type LocaleProjectionSource } from './locale';

export type LocaleSwitchResult = 'unchanged' | 'changed' | 'changeFailed' | 'persistenceFailed';

export interface LanguageChangeSource extends LocaleProjectionSource {
  changeLanguage(locale: SupportedLocale): Promise<unknown>;
}

export async function switchPlatformLocale(
  instance: LanguageChangeSource,
  targetLocale: SupportedLocale,
  persist: (locale: SupportedLocale) => boolean = persistLocalePreference
): Promise<LocaleSwitchResult> {
  const previousLocale = getResolvedLocale(instance);
  if (previousLocale === targetLocale) return 'unchanged';
  try {
    await instance.changeLanguage(targetLocale);
    if (getResolvedLocale(instance) !== targetLocale) {
      await rollbackLanguage(instance, previousLocale);
      return 'changeFailed';
    }
    return persist(targetLocale) ? 'changed' : 'persistenceFailed';
  } catch {
    await rollbackLanguage(instance, previousLocale);
    return 'changeFailed';
  }
}

async function rollbackLanguage(
  instance: LanguageChangeSource,
  previousLocale: SupportedLocale
): Promise<void> {
  try {
    await instance.changeLanguage(previousLocale);
  } catch {
    // The caller reports the failure and no new preference is persisted.
  }
}
