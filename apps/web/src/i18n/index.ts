import { createInstance, type InitOptions } from 'i18next';
import { initReactI18next } from 'react-i18next';
import authEnUs from './resources/en-US/auth.json';
import commonEnUs from './resources/en-US/common.json';
import errorsEnUs from './resources/en-US/errors.json';
import shellEnUs from './resources/en-US/shell.json';
import authZhCn from './resources/zh-CN/auth.json';
import commonZhCn from './resources/zh-CN/common.json';
import errorsZhCn from './resources/zh-CN/errors.json';
import shellZhCn from './resources/zh-CN/shell.json';
import {
  FALLBACK_LOCALE,
  SUPPORTED_LOCALES,
  resolveBrowserInitialLocale,
  type SupportedLocale
} from './locale';

export const platformI18n = createInstance();

export const platformResources = {
  'zh-CN': {
    common: commonZhCn,
    shell: shellZhCn,
    auth: authZhCn,
    errors: errorsZhCn
  },
  'en-US': {
    common: commonEnUs,
    shell: shellEnUs,
    auth: authEnUs,
    errors: errorsEnUs
  }
} as const;

let initializationPromise: Promise<void> | null = null;

export function initializeI18n(): Promise<void> {
  if (platformI18n.isInitialized) return Promise.resolve();
  if (initializationPromise) return initializationPromise;
  const initialLocale = resolveBrowserInitialLocale();
  platformI18n.use(initReactI18next);
  initializationPromise = initializeWithLocale(initialLocale).catch(async (initialError: unknown) => {
    console.error('Platform i18n initialization failed; retrying with zh-CN.', initialError);
    if (platformI18n.isInitialized) {
      await platformI18n.changeLanguage(FALLBACK_LOCALE);
      return;
    }
    await platformI18n.init(optionsForLocale(FALLBACK_LOCALE));
  });
  return initializationPromise;
}

async function initializeWithLocale(locale: SupportedLocale): Promise<void> {
  await platformI18n.init(optionsForLocale(locale));
}

function optionsForLocale(locale: SupportedLocale): InitOptions {
  return {
    lng: locale,
    supportedLngs: [...SUPPORTED_LOCALES],
    fallbackLng: FALLBACK_LOCALE,
    defaultNS: 'common',
    ns: ['common', 'shell', 'auth', 'errors'],
    resources: platformResources,
    returnNull: false,
    interpolation: {
      escapeValue: false
    },
    react: {
      useSuspense: false
    }
  };
}
