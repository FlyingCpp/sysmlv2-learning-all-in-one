'use strict';

const { createBetterAuthAdapter } = require('./better-auth-adapter');

function createAuthService(options = {}) {
  const aiTeacherEnabled = optionFlag(options.aiTeacherEnabled, envFlag(process.env.AI_TEACHER_ENABLED, true));
  const betterAuth = options.betterAuthAdapter || createBetterAuthAdapter(options);

  async function login(credentials = {}) {
    try {
      return await betterAuth.login({
        email: credentials.email || credentials.username,
        password: credentials.password
      });
    } catch (error) {
      const normalized = normalizeBetterAuthError(error);
      if (normalized.statusCode === 401) normalized.code = 'INVALID_CREDENTIALS';
      throw normalized;
    }
  }

  async function register(credentials = {}) {
    try {
      return await betterAuth.register(credentials);
    } catch (error) {
      throw normalizeRegisterError(error);
    }
  }

  async function signInGuest(req) {
    try {
      return await betterAuth.signInAnonymous(req);
    } catch (error) {
      throw normalizeBetterAuthError(error);
    }
  }

  async function currentUser(req) {
    try {
      return await betterAuth.currentUser(req);
    } catch {
      return null;
    }
  }

  async function optionalUser(req) {
    if (!cookieHeader(req)) return null;
    const user = await currentUser(req);
    if (user) return user;
    const error = new Error('登录已失效，请重新登录。');
    error.statusCode = 401;
    error.code = 'INVALID_SESSION';
    throw error;
  }

  async function requireUser(req) {
    const user = await currentUser(req);
    if (user) return user;
    const error = new Error('请先登录。');
    error.statusCode = 401;
    error.code = 'AUTH_REQUIRED';
    throw error;
  }

  async function requirePermission(req, permission) {
    return requireEntitlement(req, permission);
  }

  async function requireEntitlement(req, entitlementCode, scopeOptions = {}) {
    const user = await requireUser(req);
    if (serviceHasEntitlement(user, entitlementCode, scopeOptions)) return user;
    const error = new Error('当前账号无权使用该功能。');
    error.statusCode = 403;
    error.code = 'PERMISSION_DENIED';
    throw error;
  }

  async function logout(req) {
    return betterAuth.logout(req);
  }

  async function wechatStart(callbackURL) {
    return betterAuth.wechatStart(callbackURL);
  }

  async function providers() {
    return betterAuth.providers();
  }

  function serviceHasPermission(user, permission) {
    return serviceHasEntitlement(user, permission);
  }

  function serviceHasEntitlement(user, entitlementCode, scopeOptions = {}) {
    if (entitlementCode === 'ai.teacher.use' && !aiTeacherEnabled) return false;
    return hasEntitlement(user, entitlementCode, scopeOptions);
  }

  return {
    login,
    register,
    signInGuest,
    currentUser,
    optionalUser,
    requireUser,
    requirePermission,
    requireEntitlement,
    hasPermission: serviceHasPermission,
    hasEntitlement: serviceHasEntitlement,
    logout,
    providers,
    wechatStart,
    betterAuth,
    aiTeacherEnabled
  };
}

function hasEntitlement(user, entitlementCode, scopeOptions = {}) {
  if (!user || !entitlementCode) return false;
  const entitlements = Array.isArray(user.entitlements) ? user.entitlements : [];
  if (!entitlements.length) return false;
  return entitlements.some((entitlement) => {
    if (entitlement.code !== entitlementCode) return false;
    return scopeMatches(entitlement, scopeOptions);
  });
}

function scopeMatches(entitlement, scopeOptions = {}) {
  const requestedScope = scopeOptions.scope || 'global';
  const requestedRef = scopeOptions.scopeRef || scopeOptions.scope_ref || '*';
  if (!scopeOptions.scope && !scopeOptions.scopeRef && !scopeOptions.scope_ref) return true;
  if (entitlement.scope === 'global' && entitlement.scopeRef === '*') return true;
  if (entitlement.scope !== requestedScope) return false;
  return entitlement.scopeRef === '*' || entitlement.scopeRef === requestedRef;
}

function normalizeBetterAuthError(error) {
  if (error?.statusCode || error?.status) {
    if (typeof error.statusCode !== 'number') error.statusCode = statusCodeFromBetterAuth(error.status || error.statusCode);
    return error;
  }
  const wrapped = new Error(error?.message || '认证请求失败。');
  wrapped.statusCode = 401;
  wrapped.code = error?.code || 'AUTH_FAILED';
  return wrapped;
}

function normalizeRegisterError(error) {
  const normalized = normalizeBetterAuthError(error);
  const message = String(normalized.message || '');
  const lower = message.toLowerCase();
  if (normalized.code === 'REGISTER_REQUIRED_FIELDS' || normalized.code === 'INVALID_EMAIL' || normalized.code === 'PASSWORD_TOO_SHORT') return normalized;
  if (lower.includes('already exists') || lower.includes('user already')) {
    normalized.statusCode = 409;
    normalized.code = 'ACCOUNT_ALREADY_EXISTS';
    normalized.message = '该邮箱已注册，请直接登录或更换邮箱。';
    return normalized;
  }
  if (lower.includes('password too short')) {
    normalized.statusCode = 400;
    normalized.code = 'PASSWORD_TOO_SHORT';
    normalized.message = '密码至少需要 8 位。';
    return normalized;
  }
  if (lower.includes('invalid email') || lower.includes('[body.email]')) {
    normalized.statusCode = 400;
    normalized.code = 'INVALID_EMAIL';
    normalized.message = '请输入有效的邮箱地址。';
    return normalized;
  }
  if (normalized.statusCode === 422) {
    normalized.statusCode = 400;
    normalized.code = normalized.code || 'REGISTER_VALIDATION_FAILED';
    normalized.message = message || '注册信息不符合要求，请检查邮箱和密码。';
  }
  return normalized;
}

function statusCodeFromBetterAuth(status) {
  if (typeof status === 'number') return status;
  const normalized = String(status || '').toUpperCase();
  if (normalized === 'UNAUTHORIZED') return 401;
  if (normalized === 'FORBIDDEN') return 403;
  if (normalized === 'BAD_REQUEST') return 400;
  if (normalized === 'UNPROCESSABLE_ENTITY') return 422;
  if (normalized === 'NOT_FOUND') return 404;
  if (normalized === 'CONFLICT') return 409;
  return 401;
}

function envFlag(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  return !/^(0|false|no|off|disabled)$/i.test(String(value).trim());
}

function optionFlag(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  return Boolean(value);
}

function cookieHeader(req) {
  return req?.headers?.cookie || req?.headers?.Cookie || '';
}

module.exports = { createAuthService };
