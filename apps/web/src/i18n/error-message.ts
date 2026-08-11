import type { TFunction } from 'i18next';
import { normalizeApiError } from '../lib/api/errors';

const ERROR_KEY_BY_CODE = {
  AUTH_REQUIRED: 'codes.AUTH_REQUIRED',
  AUTH_FAILED: 'codes.AUTH_FAILED',
  AUTH_SESSION_EXPIRED: 'codes.AUTH_SESSION_EXPIRED',
  AUTH_SESSION_CHECK_FAILED: 'codes.AUTH_SESSION_CHECK_FAILED',
  REGISTRATION_DISABLED: 'codes.REGISTRATION_DISABLED',
  GUEST_LOGIN_DISABLED: 'codes.GUEST_LOGIN_DISABLED',
  REGISTER_REQUIRED_FIELDS: 'codes.REGISTER_REQUIRED_FIELDS',
  INVALID_EMAIL: 'codes.INVALID_EMAIL',
  PASSWORD_TOO_SHORT: 'codes.PASSWORD_TOO_SHORT',
  ACCOUNT_ALREADY_EXISTS: 'codes.ACCOUNT_ALREADY_EXISTS',
  ACCOUNT_DISABLED: 'codes.ACCOUNT_DISABLED',
  REGISTER_VALIDATION_FAILED: 'codes.REGISTER_VALIDATION_FAILED',
  RATE_LIMIT_EXCEEDED: 'codes.RATE_LIMIT_EXCEEDED'
} as const;

const ERROR_KEY_BY_STATUS: Record<number, string> = {
  400: 'generic.badRequest',
  401: 'generic.unauthorized',
  403: 'generic.forbidden',
  404: 'generic.notFound',
  409: 'generic.conflict',
  429: 'generic.rateLimited',
  503: 'generic.serviceUnavailable'
};

export interface LocalizedErrorDetails {
  status: number;
  code: string;
  message: string;
}

export function localizeErrorCode(code: string, t: TFunction, status = 0): LocalizedErrorDetails {
  const normalizedCode = String(code || '').trim();
  const codeKey = ERROR_KEY_BY_CODE[normalizedCode as keyof typeof ERROR_KEY_BY_CODE];
  const messageKey = codeKey || ERROR_KEY_BY_STATUS[status] || 'generic.requestFailed';
  return {
    status,
    code: normalizedCode,
    message: t(messageKey, { ns: 'errors' })
  };
}

export function localizeWebError(error: unknown, t: TFunction): LocalizedErrorDetails {
  const details = normalizeApiError(error);
  return localizeErrorCode(details.code, t, details.status);
}
