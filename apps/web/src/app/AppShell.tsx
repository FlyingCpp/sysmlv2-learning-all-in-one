import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from '@tanstack/react-router';
import { Blocks, Boxes, Compass, GraduationCap, Languages, LogIn, LogOut, Network, ShieldCheck, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthMeQuery } from './data-hooks';
import { useRuntimeConfigStore } from './runtime-config-store';
import { useSessionStore } from './session-store';
import { useAppApiClient } from './use-api-client';
import { requestPersistentAiTeacherPanel } from '../lib/ai-teacher/ui-events';
import { normalizeApiError } from '../lib/api/errors';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher';

type AppShellProps = {
  children: ReactNode;
};

const ACTIVITY_HEARTBEAT_MS = 60_000;

export function AppShell({ children }: AppShellProps) {
  const { t } = useTranslation('shell');
  const status = useRuntimeConfigStore((state) => state.status);
  const loadConfig = useRuntimeConfigStore((state) => state.loadConfig);
  const user = useSessionStore((state) => state.user);
  const setSession = useSessionStore((state) => state.setSession);
  const clearSession = useSessionStore((state) => state.clearSession);
  const setSessionStatus = useSessionStore((state) => state.setStatus);
  const authMeQuery = useAuthMeQuery();
  const api = useAppApiClient();
  const queryClient = useQueryClient();
  const location = useLocation();
  const isLoginRoute = location.pathname === '/login';
  const activePrimaryNav = primaryNavForPath(location.pathname);
  const isAuthenticated = Boolean(user);
  const showAdmin = Boolean(
    user?.roles?.includes('admin')
    || user?.permissions?.includes('admin.console.access')
    || user?.permissions?.includes('course.pack.manage')
    || user?.entitlements?.some((item) => item.code === 'admin.console.access' || item.code === 'course.pack.manage')
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadConfig(controller.signal);
    return () => controller.abort();
  }, [loadConfig]);

  useEffect(() => {
    if (status !== 'ready') return;
    if (authMeQuery.isPending) {
      setSessionStatus('loading');
      return;
    }
    if (authMeQuery.data) {
      setSession(authMeQuery.data.user);
      return;
    }
    if (authMeQuery.error) {
      clearSession(normalizeApiError(authMeQuery.error).code || 'AUTH_SESSION_CHECK_FAILED');
    }
  }, [authMeQuery.data, authMeQuery.error, authMeQuery.isPending, clearSession, setSession, setSessionStatus, status]);

  useEffect(() => {
    if (!user) return undefined;
    let visibleSince = document.visibilityState === 'visible' ? Date.now() : 0;
    const sendActivity = (seconds: number) => {
      void api.request('/api/auth/activity', { method: 'POST', body: { seconds } }).catch(() => ({}));
    };
    const flushVisibleTime = () => {
      if (!visibleSince) return;
      const now = Date.now();
      const seconds = Math.max(0, Math.floor((now - visibleSince) / 1000));
      visibleSince = now;
      if (seconds > 0) sendActivity(seconds);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushVisibleTime();
        visibleSince = 0;
        return;
      }
      visibleSince = Date.now();
      sendActivity(0);
    };
    sendActivity(0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') flushVisibleTime();
    }, ACTIVITY_HEARTBEAT_MS);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (document.visibilityState === 'visible') flushVisibleTime();
    };
  }, [api, user]);

  const logout = async () => {
    await api.request('/api/auth/logout', { method: 'POST' }).catch(() => ({}));
    clearSession();
    await queryClient.invalidateQueries();
  };
  return (
    <div
      className={`phase0Shell phase2Shell${isLoginRoute ? ' loginShell' : ''}${!isAuthenticated ? ' unauthShell' : ''}`}
      data-react-phase2-root
      data-react-phase4-root
      data-react-phase5-root
      data-compatibility-marker="React Phase 0 Infrastructure"
      data-phase2-shell-marker="React Phase 2 Low-Risk Pages"
    >
      <header className="appTopbar">
        <Link
          className="brandBlock"
          to={isAuthenticated ? '/' : '/login'}
          aria-label={isAuthenticated ? t('brand.homeAria') : t('brand.loginAria')}
        >
          <span className="brandMark" aria-hidden="true">
            <svg viewBox="0 0 48 48" role="img" aria-hidden="true">
              <path d="M24 4 41 14v20L24 44 7 34V14L24 4Z" fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
              <circle cx="24" cy="14" r="4" fill="currentColor" />
              <circle cx="16" cy="29" r="4" fill="currentColor" />
              <circle cx="32" cy="29" r="4" fill="currentColor" />
              <path d="M24 18v8M20 29h8" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </span>
          <span className="brandText">
            <strong>{t('brand.name')}</strong>
            <span>{t('brand.tagline')}</span>
          </span>
        </Link>
        <nav className="mainNav" aria-label={t('navigation.ariaLabel')}>
          {isAuthenticated ? (
            <>
              <Link to="/" data-primary-nav="guide" aria-current={activePrimaryNav === 'guide' ? 'page' : undefined}>
                <Compass size={15} strokeWidth={1.9} aria-hidden="true" />
                <span>{t('navigation.guide')}</span>
              </Link>
              <Link to="/knowledge" data-primary-nav="knowledge" aria-current={activePrimaryNav === 'knowledge' ? 'page' : undefined}>
                <Network size={15} strokeWidth={1.9} aria-hidden="true" />
                <span>{t('navigation.knowledge')}</span>
              </Link>
              <Link
                to="/bench"
                data-primary-nav="modeling"
                data-feature="ai-teacher"
                data-ai-teacher-nav-trigger
                aria-current={activePrimaryNav === 'modeling' ? 'page' : undefined}
                onClick={() => requestPersistentAiTeacherPanel('open')}
              >
                <Boxes size={15} strokeWidth={1.9} aria-hidden="true" />
                <span>{t('navigation.modeling')}</span>
              </Link>
              <Link to="/course-shelf" data-primary-nav="courses" aria-current={activePrimaryNav === 'courses' ? 'page' : undefined}>
                <GraduationCap size={15} strokeWidth={1.9} aria-hidden="true" />
                <span>{t('navigation.courses')}</span>
              </Link>
              <Link to="/glossary" data-primary-nav="glossary" aria-current={activePrimaryNav === 'glossary' ? 'page' : undefined}>
                <Languages size={15} strokeWidth={1.9} aria-hidden="true" />
                <span>{t('navigation.glossary')}</span>
              </Link>
              <Link to="/apps" data-primary-nav="apps" aria-current={activePrimaryNav === 'apps' ? 'page' : undefined}>
                <Blocks size={15} strokeWidth={1.9} aria-hidden="true" />
                <span>{t('navigation.apps')}</span>
              </Link>
            </>
          ) : null}
          {isAuthenticated && showAdmin ? (
            <Link to="/admin" data-primary-nav="admin" data-feature="admin" aria-current={activePrimaryNav === 'admin' ? 'page' : undefined}>
              <ShieldCheck size={15} strokeWidth={1.9} aria-hidden="true" />
              <span>{t('navigation.admin')}</span>
            </Link>
          ) : null}
        </nav>
        <div className="topbarControls">
          <LanguageSwitcher />
          {user ? (
            <div className="userPill">
              <UserRound size={15} />
              <span>{user.displayName || user.username}</span>
              <button type="button" onClick={logout} aria-label={t('account.logoutAria')}>
                <LogOut size={15} />
              </button>
            </div>
          ) : (
            <Link className="primaryLink topbarLoginLink" to="/login" data-login-entry>
              <LogIn size={15} aria-hidden="true" />
              <span>{t('account.login')}</span>
            </Link>
          )}
        </div>
      </header>

      <main className="appMain">
        {children}
      </main>
    </div>
  );
}

function primaryNavForPath(pathname: string) {
  if (pathname === '/') return 'guide';
  if (pathname === '/course-shelf' || pathname.startsWith('/courses') || pathname.startsWith('/lesson/') || pathname === '/final-project') return 'courses';
  if (pathname.startsWith('/knowledge')) return 'knowledge';
  if (pathname === '/glossary') return 'glossary';
  if (pathname.startsWith('/apps')) return 'apps';
  if (pathname.startsWith('/bench') || pathname.startsWith('/workbench') || pathname === '/ai-teacher') return 'modeling';
  if (pathname.startsWith('/admin')) return 'admin';
  return '';
}
