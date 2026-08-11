import { createTheme, ThemeProvider } from '@mui/material/styles';
import { enUS, zhCN } from '@mui/material/locale';
import { useLayoutEffect, useMemo, type ReactNode } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { platformI18n } from './index';
import { getResolvedLocale, type SupportedLocale } from './locale';
import { applyLocaleProjection } from './projection';

const MUI_LOCALE_BY_PLATFORM_LOCALE = {
  'zh-CN': zhCN,
  'en-US': enUS
} satisfies Record<SupportedLocale, typeof zhCN>;

export function PlatformI18nProvider({ children }: { children: ReactNode }) {
  return (
    <I18nextProvider i18n={platformI18n}>
      <LocaleProjectionProvider>{children}</LocaleProjectionProvider>
    </I18nextProvider>
  );
}

function LocaleProjectionProvider({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation('shell');
  const locale = getResolvedLocale(i18n);
  const theme = useMemo(
    () => createTheme({}, MUI_LOCALE_BY_PLATFORM_LOCALE[locale]),
    [locale]
  );

  useLayoutEffect(() => {
    applyLocaleProjection(locale, t('document.title'));
  }, [locale, t]);

  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
}
