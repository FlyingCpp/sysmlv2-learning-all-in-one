'use strict';

const { createAccountStore } = require('./account-store');

function createBetterAuthAdapter(options = {}) {
  const accountStore = options.accountStore || createAccountStore(options);
  const authDatabaseUrl = options.authDatabaseUrl || process.env.AUTH_DATABASE_URL || process.env.BETTER_AUTH_DATABASE_URL || '';
  const allowMemoryAuthAdapter = options.allowMemoryAuthAdapter === true || process.env.NODE_ENV === 'test';
  const memoryDb = { user: [], session: [], account: [], verification: [] };
  let runtimePromise = null;

  async function runtime() {
    if (!runtimePromise) runtimePromise = createRuntime();
    return runtimePromise;
  }

  async function createRuntime() {
    const { betterAuth } = await import('better-auth');
    const { anonymous } = await import('better-auth/plugins/anonymous');
    const { fromNodeHeaders, toNodeHandler } = await import('better-auth/node');
    const database = await createAuthDatabase();
    const auth = betterAuth({
      appName: process.env.BETTER_AUTH_APP_NAME || 'SysML v2 Learning Platform',
      baseURL: authBaseUrl(),
      trustedOrigins: trustedOrigins(),
      database,
      emailAndPassword: {
        enabled: process.env.AUTH_EMAIL_PASSWORD_ENABLED !== 'false'
      },
      socialProviders: socialProviders(),
      plugins: [anonymous({
        generateName: () => '游客',
        generateEmail: () => `guest-${Date.now()}-${Math.random().toString(16).slice(2)}@guest.local`
      })]
    });
    return { auth, fromNodeHeaders, nodeHandler: toNodeHandler(auth) };
  }

  async function createAuthDatabase() {
    if (authDatabaseUrl) {
      const { Pool } = require('pg');
      return new Pool({ connectionString: authDatabaseUrl });
    }
    if (!allowMemoryAuthAdapter) {
      const error = new Error('AUTH_DATABASE_URL is required for Better Auth runtime.');
      error.code = 'AUTH_DATABASE_URL_REQUIRED';
      throw error;
    }
    const { memoryAdapter } = await import('better-auth/adapters/memory');
    return memoryAdapter(memoryDb);
  }

  async function handleNode(req, res) {
    const { nodeHandler } = await runtime();
    return nodeHandler(req, res);
  }

  async function getSession(req) {
    const { auth, fromNodeHeaders } = await runtime();
    return auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  }

  async function currentUser(req) {
    const session = await getSession(req);
    if (!session?.user?.id) return null;
    return accountStore.publicUserFromAuthUser(session.user);
  }

  async function register(body = {}) {
    const settings = await accountStore.getAuthSettings();
    if (!settings.registrationEnabled) throwAuthDisabled('REGISTRATION_DISABLED', '当前平台暂未开放用户注册。');
    const email = String(body.email || body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const name = String(body.name || body.displayName || email).trim();
    if (!email || !password) {
      const error = new Error('请填写邮箱和密码。');
      error.statusCode = 400;
      error.code = 'REGISTER_REQUIRED_FIELDS';
      throw error;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const error = new Error('请输入有效的邮箱地址。');
      error.statusCode = 400;
      error.code = 'INVALID_EMAIL';
      throw error;
    }
    if (password.length < 8) {
      const error = new Error('密码至少需要 8 位。');
      error.statusCode = 400;
      error.code = 'PASSWORD_TOO_SHORT';
      throw error;
    }
    const { auth } = await runtime();
    const result = await auth.api.signUpEmail({ body: { email, password, name }, returnHeaders: true });
    const user = await accountStore.publicUserFromAuthUser(result.response.user);
    await accountStore.recordAuthAudit({
      userId: user.id,
      eventType: 'login_succeeded',
      provider: 'password',
      metadata: { source: 'register' }
    });
    return { headers: result.headers, body: { user } };
  }

  async function login(body = {}) {
    const email = String(body.email || body.username || '').trim();
    const password = String(body.password || '');
    if (!email || !password) return null;
    const { auth } = await runtime();
    const result = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    const user = await accountStore.publicUserFromAuthUser(result.response.user);
    if (!user) {
      const error = new Error('账号已被禁用。');
      error.statusCode = 403;
      error.code = 'ACCOUNT_DISABLED';
      throw error;
    }
    await accountStore.recordAuthAudit({
      userId: user.id,
      eventType: 'login_succeeded',
      provider: 'password',
      metadata: { source: 'login' }
    });
    return { headers: result.headers, body: { user } };
  }

  async function signInAnonymous(req) {
    const settings = await accountStore.getAuthSettings();
    if (!settings.guestLoginEnabled) throwAuthDisabled('GUEST_LOGIN_DISABLED', '当前平台暂未开放游客登录。');
    const { auth, fromNodeHeaders } = await runtime();
    const result = await auth.api.signInAnonymous({
      headers: fromNodeHeaders(req.headers),
      returnHeaders: true
    });
    const user = await accountStore.publicUserFromAuthUser(result.response.user);
    await accountStore.recordAuthAudit({
      userId: user.id,
      eventType: 'login_succeeded',
      provider: 'anonymous',
      metadata: { source: 'guest' }
    });
    return { headers: result.headers, body: { user } };
  }

  async function logout(req) {
    const { auth, fromNodeHeaders } = await runtime();
    try {
      await auth.api.signOut({ headers: fromNodeHeaders(req.headers) });
    } catch {
      // Local logout should not fail when the current request has no Better Auth session.
    }
    return { ok: true };
  }

  async function wechatStart(callbackURL) {
    if (!isWechatConfigured()) {
      const error = new Error('微信网页扫码登录尚未配置。');
      error.statusCode = 503;
      error.code = 'WECHAT_AUTH_NOT_CONFIGURED';
      throw error;
    }
    const { auth } = await runtime();
    return auth.api.signInSocial({
      body: {
        provider: 'wechat',
        callbackURL: callbackURL || process.env.WECHAT_AUTH_CALLBACK_URL || process.env.AUTH_SIGN_IN_CALLBACK_URL || 'http://localhost:3000/#/'
      }
    });
  }

  async function migrateSchema(options = {}) {
    if (!authDatabaseUrl) {
      const error = new Error('AUTH_DATABASE_URL is required for Better Auth schema migration.');
      error.code = 'AUTH_DATABASE_URL_REQUIRED';
      throw error;
    }
    const { auth } = await runtime();
    const { getMigrations } = await import('better-auth/db/migration');
    const migrations = await getMigrations(auth.options);
    const sql = await migrations.compileMigrations();
    if (!options.dryRun) {
      await migrations.runMigrations();
      await accountStore.ensureSchema();
    }
    return {
      sql,
      toBeCreated: migrations.toBeCreated.map((item) => item.table),
      toBeAdded: migrations.toBeAdded.map((item) => item.table)
    };
  }

  async function providers() {
    const settings = await accountStore.getAuthSettings();
    return {
      emailPassword: process.env.AUTH_EMAIL_PASSWORD_ENABLED !== 'false',
      wechat: isWechatConfigured(),
      guest: Boolean(settings.guestLoginEnabled),
      registration: Boolean(settings.registrationEnabled)
    };
  }

  function isWechatConfigured() {
    return Boolean(process.env.WECHAT_CLIENT_ID && process.env.WECHAT_CLIENT_SECRET);
  }

  return {
    accountStore,
    currentUser,
    getSession,
    handleNode,
    login,
    logout,
    migrateSchema,
    providers,
    register,
    signInAnonymous,
    wechatStart
  };
}

function throwAuthDisabled(code, message) {
  const error = new Error(message);
  error.statusCode = 403;
  error.code = code;
  throw error;
}

function authBaseUrl() {
  return process.env.BETTER_AUTH_URL || process.env.AUTH_BASE_URL || process.env.API_PUBLIC_URL || 'http://localhost:8080';
}

function trustedOrigins() {
  const configured = String(process.env.BETTER_AUTH_TRUSTED_ORIGINS || process.env.AUTH_TRUSTED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  return [...new Set(['http://localhost:3000', 'http://127.0.0.1:3000', ...configured])];
}

function socialProviders() {
  const providers = {};
  if (process.env.WECHAT_CLIENT_ID && process.env.WECHAT_CLIENT_SECRET) {
    providers.wechat = {
      clientId: process.env.WECHAT_CLIENT_ID,
      clientSecret: process.env.WECHAT_CLIENT_SECRET,
      lang: process.env.WECHAT_AUTH_LANG || 'cn',
      scope: (process.env.WECHAT_AUTH_SCOPE || 'snsapi_login').split(',').map((item) => item.trim()).filter(Boolean)
    };
  }
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.google = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET
    };
  }
  if (process.env.APPLE_CLIENT_ID && process.env.APPLE_CLIENT_SECRET) {
    providers.apple = {
      clientId: process.env.APPLE_CLIENT_ID,
      clientSecret: process.env.APPLE_CLIENT_SECRET
    };
  }
  return providers;
}

module.exports = { createBetterAuthAdapter };
