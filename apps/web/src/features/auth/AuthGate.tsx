import type { ReactNode } from 'react';
import { useRuntimeConfigStore } from '../../app/runtime-config-store';
import { useSessionStore } from '../../app/session-store';
import { LoginPage } from './LoginPage';
import { SilentLoadingState } from '../shared/ui';
import { useTranslation } from 'react-i18next';

export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation('auth');
  const runtimeStatus = useRuntimeConfigStore((state) => state.status);
  const sessionStatus = useSessionStore((state) => state.status);
  const user = useSessionStore((state) => state.user);

  if (runtimeStatus !== 'ready' || sessionStatus === 'idle' || sessionStatus === 'loading') {
    return <SilentLoadingState />;
  }

  if (!user) {
    return <LoginPage message={t('feedback.loginRequired')} />;
  }

  return <>{children}</>;
}
