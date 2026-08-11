import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from './app/providers';
import { AppRouter } from './app/router';
import { initializeI18n, platformI18n } from './i18n';
import { getResolvedLocale } from './i18n/locale';
import { applyLocaleProjection } from './i18n/projection';
import './styles/tokens.css';
import './styles/app.css';

void startApplication();

async function startApplication() {
  const rootElement = document.getElementById('react-root');
  if (!rootElement) throw new Error('React root element #react-root was not found.');

  try {
    await initializeI18n();
    applyLocaleProjection(
      getResolvedLocale(platformI18n),
      platformI18n.t('document.title', { ns: 'shell' })
    );
  } catch (error) {
    console.error('Platform i18n could not be initialized.', error);
    document.documentElement.lang = 'zh-CN';
    rootElement.setAttribute('role', 'alert');
    rootElement.textContent = '平台界面初始化失败，请刷新页面后重试。';
    return;
  }

  createRoot(rootElement).render(
    <React.StrictMode>
      <AppProviders>
        <AppRouter />
      </AppProviders>
    </React.StrictMode>
  );
}
