import { useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { platformI18n } from './index';
import { getResolvedLocale, matchSupportedLocale } from './locale';
import { switchPlatformLocale } from './locale-switch';

type LanguageSwitchStatus = 'idle' | 'changing' | 'changeFailed' | 'persistenceFailed';

export function LanguageSwitcher() {
  const { t } = useTranslation('shell');
  const currentLocale = getResolvedLocale(platformI18n);
  const [status, setStatus] = useState<LanguageSwitchStatus>('idle');

  const changeLanguage = async (event: ChangeEvent<HTMLSelectElement>) => {
    const targetLocale = matchSupportedLocale(event.currentTarget.value);
    if (!targetLocale || targetLocale === currentLocale) return;
    setStatus('changing');
    const result = await switchPlatformLocale(platformI18n, targetLocale);
    setStatus(result === 'changed' || result === 'unchanged' ? 'idle' : result);
  };

  return (
    <div
      className={`languageSwitcher${status !== 'idle' ? ' hasStatus' : ''}`}
      data-language-switcher
    >
      <select
        className="languageSwitcherSelect"
        value={currentLocale}
        aria-label={t('language.label')}
        title={t('language.label')}
        disabled={status === 'changing'}
        onChange={changeLanguage}
      >
        <option value="zh-CN">CN</option>
        <option value="en-US">EN</option>
      </select>
      <span className="languageSwitcherStatus" role="status" aria-live="polite">
        {status === 'changing' ? t('language.changing') : null}
        {status === 'changeFailed' ? t('language.changeFailed') : null}
        {status === 'persistenceFailed' ? t('language.persistenceFailed') : null}
      </span>
    </div>
  );
}
