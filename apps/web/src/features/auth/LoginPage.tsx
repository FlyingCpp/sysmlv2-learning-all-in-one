import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn, UserPlus, UserRound } from 'lucide-react';
import { FormEvent, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../app/session-store';
import { useAppApiClient } from '../../app/use-api-client';
import type { UserProfile } from '../../lib/course/types';
import loginGoldenSpiralDesktopUrl from '../../assets/login-golden-spiral-1280.jpg';
import loginGoldenSpiralMobileUrl from '../../assets/login-golden-spiral-640.jpg';
import { localizeErrorCode, localizeWebError } from '../../i18n/error-message';

type LoginResponse = {
  user: UserProfile;
};

type AuthProvidersResponse = {
  emailPassword?: boolean;
  registration?: boolean;
  guest?: boolean;
  wechat?: boolean;
};

type LoginPageProps = {
  message?: string;
};

const loginCurvePath = 'M 195 678 C 195 374 438 128 740 128 C 926 128 1077 278 1077 466 C 1077 583 984 678 868 678 C 797 678 740 620 740 548 C 740 503 776 467 821 467 C 848 467 870 489 870 516 C 870 534 855 548 837 548 C 826 548 819 539 819 529';

export function LoginPage({ message = '' }: LoginPageProps) {
  const { t } = useTranslation(['auth', 'errors']);
  const api = useAppApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setSession = useSessionStore((state) => state.setSession);
  const sessionError = useSessionStore((state) => state.error);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const providersQuery = useQuery({
    queryKey: ['auth', 'providers'],
    queryFn: () => api.request<AuthProvidersResponse>('/api/auth/providers')
  });
  const providers = providersQuery.data;
  const registrationEnabled = providers?.registration !== false;
  const guestLoginEnabled = providers?.guest !== false;

  const handleAuthSuccess = (result: LoginResponse) => {
    setSession(result.user);
    queryClient.setQueryData(['auth', 'me'], { authenticated: true, user: result.user });
    void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
    void navigate({ to: '/' });
  };

  const loginMutation = useMutation({
    mutationFn: () => api.request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: { email, password }
    }),
    onSuccess: handleAuthSuccess
  });

  const registerMutation = useMutation({
    mutationFn: () => api.request<LoginResponse>('/api/auth/register', {
      method: 'POST',
      body: { email, password, name: email }
    }),
    onSuccess: handleAuthSuccess
  });

  const guestMutation = useMutation({
    mutationFn: () => api.request<LoginResponse>('/api/auth/guest', { method: 'POST' }),
    onSuccess: handleAuthSuccess
  });
  const mutationError = loginMutation.error || registerMutation.error || guestMutation.error;
  const authError = mutationError
    ? localizeWebError(mutationError, t).message
    : (sessionError ? localizeErrorCode(sessionError, t).message : '');
  const authMessage = authError
    || t(registrationEnabled ? 'feedback.registrationOpen' : 'feedback.registrationClosed', { ns: 'auth' });
  const isSubmitting = loginMutation.isPending || registerMutation.isPending || guestMutation.isPending;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    loginMutation.mutate();
  };

  const onRegister = () => {
    if (!formRef.current?.reportValidity()) return;
    registerMutation.mutate();
  };

  return (
    <section className="loginPage" data-login-form>
      <div className="loginVisual">
        <picture className="loginVisualPicture">
          <source media="(max-width: 820px)" srcSet={loginGoldenSpiralMobileUrl} />
          <img
            className="loginVisualImage"
            src={loginGoldenSpiralDesktopUrl}
            alt=""
            width="1280"
            height="800"
            loading="eager"
            decoding="async"
            fetchPriority="high"
          />
        </picture>
        <div className="loginVisualCopy">
          <h1>{t('visual.title', { ns: 'auth' })}</h1>
          <p>{t('visual.subtitle', { ns: 'auth' })}</p>
        </div>
        <svg className="loginCurveAnimation" viewBox="0 0 1280 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
          <defs>
            <filter id="loginCurveGlowBlur" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="5" />
            </filter>
          </defs>
          <g className="loginCurveTraveler">
            <animateMotion path={loginCurvePath} dur="6.2s" repeatCount="indefinite" rotate="auto" />
            <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.07;0.9;1" dur="6.2s" repeatCount="indefinite" />
            <ellipse className="loginCurveGlowHalo" rx="18" ry="5" />
            <ellipse className="loginCurveGlowCore" rx="9" ry="2.2" />
          </g>
          <g className="loginCurveReducedPoint" transform="translate(837 529)">
            <ellipse className="loginCurveGlowHalo" rx="18" ry="5" />
            <ellipse className="loginCurveGlowCore" rx="9" ry="2.2" />
          </g>
        </svg>
      </div>

      <div className="loginPanel">
        <div className="loginPanelHeader">
          <span className="loginSystemLabel">{t('header.systemLabel', { ns: 'auth' })}</span>
          <h2>{t('header.title', { ns: 'auth' })}</h2>
          <p>{message || t(registrationEnabled ? 'header.descriptionRegistrationOpen' : 'header.descriptionLoginOnly', { ns: 'auth' })}</p>
        </div>
        <form ref={formRef} onSubmit={onSubmit}>
          <label>
            <span>{t('form.email', { ns: 'auth' })}</span>
            <input
              name="email"
              type="email"
              value={email}
              autoComplete="email"
              required
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            <span>{t('form.password', { ns: 'auth' })}</span>
            <input
              name="password"
              type="password"
              value={password}
              autoComplete="current-password"
              required
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button className="primaryAction" type="submit" disabled={isSubmitting}>
            <LogIn size={17} />
            {loginMutation.isPending ? t('actions.loggingIn', { ns: 'auth' }) : t('actions.login', { ns: 'auth' })}
          </button>
          {registrationEnabled ? (
            <button className="secondaryAction registerAction" type="button" disabled={isSubmitting} onClick={onRegister}>
              <UserPlus size={17} />
              {registerMutation.isPending ? t('actions.registering', { ns: 'auth' }) : t('actions.register', { ns: 'auth' })}
            </button>
          ) : null}
          {guestLoginEnabled ? (
            <button className="secondaryAction" type="button" disabled={isSubmitting} onClick={() => guestMutation.mutate()}>
              <UserRound size={17} />
              {guestMutation.isPending ? t('actions.entering', { ns: 'auth' }) : t('actions.guest', { ns: 'auth' })}
            </button>
          ) : null}
          <p
            className={`authFeedback${authError ? ' isError' : ''}`}
            aria-live="polite"
            aria-hidden={!authMessage}
          >
            {authMessage || '\u00a0'}
          </p>
        </form>
      </div>
    </section>
  );
}
