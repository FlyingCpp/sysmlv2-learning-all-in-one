import { useMemo } from 'react';
import { createApiClient } from '../lib/api/client';
import { useCoursePackStore } from './course-pack-store';
import { useRuntimeConfigStore } from './runtime-config-store';
import { useSessionStore } from './session-store';

export function useAppApiClient() {
  const config = useRuntimeConfigStore((state) => state.config);
  const activeCoursePackId = useCoursePackStore((state) => state.activeCoursePackId);
  const clearSession = useSessionStore((state) => state.clearSession);
  const setSession = useSessionStore((state) => state.setSession);

  return useMemo(() => createApiClient({
    baseUrl: config?.apiBaseUrl || '',
    activeCoursePackId,
    async onUnauthorized() {
      const baseUrl = (config?.apiBaseUrl || '').replace(/\/$/, '');
      const response = await fetch(`${baseUrl}/api/auth/me`, { credentials: 'include' }).catch(() => null);
      const payload = await response?.json().catch(() => null);
      if (response?.ok && payload?.authenticated && payload.user) {
        setSession(payload.user);
        return;
      }
      clearSession('AUTH_SESSION_EXPIRED');
    }
  }), [activeCoursePackId, clearSession, config?.apiBaseUrl, setSession]);
}
