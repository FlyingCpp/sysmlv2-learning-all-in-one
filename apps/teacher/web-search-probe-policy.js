'use strict';

const crypto = require('crypto');
const {
  deepSeekWebSearchPublicState,
  recordDeepSeekWebSearchRuntimeState,
  searchDeepSeekDomainEvidence,
  setDeepSeekWebSearchEnabled
} = require('./deepseek-web-search');

const CAPABILITY_KEY = 'deepseek-web-search';
const DEFAULT_COOLDOWN_SECONDS = [30, 60, 180, 600];
const DEFAULT_RESET_AFTER_SECONDS = 900;
const DEFAULT_HOURLY_LIMIT = 6;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_CANARY_QUESTION = 'OMG SysML v2 规范的公开发布页面提供了哪些正文级说明？';
const HOUR_MS = 60 * 60 * 1000;

function createWebSearchProbePolicyConfig(options = {}) {
  return {
    enabled: parseBoolean(
      options.enabled !== undefined
        ? options.enabled
        : process.env.AI_TEACHER_WEB_SEARCH_PROBE_ENABLED,
      true
    ),
    cooldownMs: parseCooldownSchedule(
      options.cooldownSeconds !== undefined
        ? options.cooldownSeconds
        : process.env.AI_TEACHER_WEB_SEARCH_PROBE_COOLDOWN_SECONDS
    ).map((seconds) => seconds * 1000),
    resetAfterMs: boundedInteger(
      options.resetAfterSeconds || process.env.AI_TEACHER_WEB_SEARCH_PROBE_RESET_AFTER_SECONDS,
      DEFAULT_RESET_AFTER_SECONDS,
      60,
      86400
    ) * 1000,
    hourlyLimit: boundedInteger(
      options.hourlyLimit !== undefined
        ? options.hourlyLimit
        : process.env.AI_TEACHER_WEB_SEARCH_PROBE_HOURLY_LIMIT,
      DEFAULT_HOURLY_LIMIT,
      0,
      60
    ),
    timeoutMs: boundedInteger(
      options.timeoutMs || process.env.AI_TEACHER_WEB_SEARCH_PROBE_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      1000,
      120000
    ),
    maxUses: 1,
    maxContinuations: 2,
    maxOutputTokens: 512,
    canaryQuestion: DEFAULT_CANARY_QUESTION
  };
}

function createWebSearchProbeController(options = {}) {
  let policy = options.policy || createWebSearchProbePolicyConfig(options.policyOptions || {});
  const searchConfig = options.searchConfig;
  const store = options.store || createWebSearchProbeStateStore(options.storeOptions || {});
  const search = options.search || searchDeepSeekDomainEvidence;
  const fetchImpl = options.fetch;
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date();
  const readyPromise = Promise.resolve().then(() => store.ready?.());

  async function publicState() {
    if (!policy.enabled) return publicProbeState({}, policy, nowMs(clock), { status: 'paused' });
    try {
      await readyPromise;
      return publicProbeState(await store.read(CAPABILITY_KEY), policy, nowMs(clock));
    } catch {
      return publicProbeState({}, policy, nowMs(clock), {
        status: 'storage_unavailable',
        warningCode: 'probe_state_storage_unavailable'
      });
    }
  }

  function updatePolicy(nextPolicy = {}) {
    policy = {
      ...policy,
      enabled: parseBoolean(nextPolicy.enabled, policy.enabled),
      hourlyLimit: boundedInteger(nextPolicy.hourlyLimit, policy.hourlyLimit, 0, 60),
      timeoutMs: boundedInteger(nextPolicy.timeoutMs, policy.timeoutMs, 1000, 180000)
    };
    return policyState();
  }

  function policyState() {
    return {
      enabled: policy.enabled,
      hourlyLimit: policy.hourlyLimit,
      timeoutMs: policy.timeoutMs
    };
  }

  async function disable() {
    const domainWebSearch = setDeepSeekWebSearchEnabled(searchConfig, false);
    return { domainWebSearch, probe: await publicState(), action: 'disabled' };
  }

  async function enableAndProbe() {
    setDeepSeekWebSearchEnabled(searchConfig, true);
    if (!policy.enabled) {
      return {
        domainWebSearch: deepSeekWebSearchPublicState(searchConfig),
        probe: await publicState(),
        action: 'enabled_probe_paused'
      };
    }
    try {
      return await executeProbe('enable');
    } catch (error) {
      return {
        domainWebSearch: deepSeekWebSearchPublicState(searchConfig),
        probe: await publicState(),
        action: ['WEB_SEARCH_PROBE_COOLDOWN', 'WEB_SEARCH_PROBE_HOURLY_LIMIT', 'WEB_SEARCH_PROBE_IN_PROGRESS'].includes(error?.code)
          ? 'enabled_probe_deferred'
          : 'enabled_probe_unavailable'
      };
    }
  }

  async function probe() {
    if (!searchConfig?.enabled) {
      throw probeError('WEB_SEARCH_PROBE_REQUIRES_ENABLED', '请先开启 Web Search，再执行验证。', 409);
    }
    if (!policy.enabled) {
      throw probeError('WEB_SEARCH_PROBE_PAUSED', '付费搜索探针已由服务端策略暂停。', 409);
    }
    try {
      return await executeProbe('manual');
    } catch (error) {
      if (error?.code) throw error;
      throw probeError(
        'WEB_SEARCH_PROBE_STORAGE_UNAVAILABLE',
        '付费搜索探针状态存储不可用，未执行验证。',
        503
      );
    }
  }

  async function executeProbe(trigger) {
    await readyPromise;
    const reservationId = `probe_${crypto.randomUUID()}`;
    const startedAtMs = nowMs(clock);
    const reservation = await store.update(CAPABILITY_KEY, (stored) => reserveProbe(
      stored,
      policy,
      startedAtMs,
      reservationId
    ));
    const probeConfig = {
      ...searchConfig,
      enabled: true,
      maxUses: policy.maxUses,
      maxContinuations: policy.maxContinuations,
      timeoutMs: policy.timeoutMs,
      maxOutputTokens: policy.maxOutputTokens,
      runtimeState: { status: 'not_checked', checkedAt: '', warningCode: '' },
      runtimeControl: { ...(searchConfig.runtimeControl || {}) }
    };
    let result;
    try {
      result = await search(probeConfig, {
        questions: [policy.canaryQuestion]
      }, {
        fetch: fetchImpl
      });
    } catch (error) {
      result = {
        status: 'unavailable',
        searchRequestCount: 0,
        sources: [],
        warnings: [safeWarning(error)]
      };
    }
    const completedAtMs = nowMs(clock);
    recordDeepSeekWebSearchRuntimeState(searchConfig, result, {
      checkedAt: new Date(completedAtMs).toISOString()
    });
    await store.update(CAPABILITY_KEY, (stored) => completeProbe(
      stored,
      reservationId,
      result,
      startedAtMs,
      completedAtMs,
      trigger
    ));
    return {
      domainWebSearch: deepSeekWebSearchPublicState(searchConfig),
      probe: await publicState(),
      action: trigger === 'enable' ? 'enabled_and_probed' : 'probed'
    };
  }

  return {
    get policy() {
      return policy;
    },
    publicState,
    updatePolicy,
    policyState,
    disable,
    enableAndProbe,
    probe,
    close: async () => store.close?.()
  };
}

function reserveProbe(stored, policy, now, reservationId) {
  const state = normalizeStoredState(stored, policy, now);
  if (state.inFlight && isoMs(state.inFlight.leaseUntil) > now) {
    throw probeError('WEB_SEARCH_PROBE_IN_PROGRESS', 'Web Search 正在验证，请等待本次探针完成。', 409, {
      nextAllowedAt: state.inFlight.leaseUntil
    });
  }
  const cooldownUntil = isoMs(state.nextAllowedAt);
  if (cooldownUntil > now) {
    throw probeError('WEB_SEARCH_PROBE_COOLDOWN', 'Web Search 验证仍在冷却中。', 429, {
      retryAfterMs: cooldownUntil - now,
      nextAllowedAt: state.nextAllowedAt
    });
  }
  const recentAttempts = state.recentAttempts.filter((value) => isoMs(value) > now - HOUR_MS);
  if (recentAttempts.length >= policy.hourlyLimit) {
    const nextAllowedAt = new Date(isoMs(recentAttempts[0]) + HOUR_MS).toISOString();
    throw probeError('WEB_SEARCH_PROBE_HOURLY_LIMIT', 'Web Search 验证已达到小时上限。', 429, {
      retryAfterMs: Math.max(0, isoMs(nextAllowedAt) - now),
      nextAllowedAt
    });
  }
  const attemptCount = state.attemptCount + 1;
  const cooldownMs = policy.cooldownMs[Math.min(attemptCount - 1, policy.cooldownMs.length - 1)];
  const startedAt = new Date(now).toISOString();
  const nextState = {
    ...state,
    attemptCount,
    lastProbeAt: startedAt,
    nextAllowedAt: new Date(now + cooldownMs).toISOString(),
    recentAttempts: [...recentAttempts, startedAt],
    inFlight: {
      reservationId,
      startedAt,
      leaseUntil: new Date(now + policy.timeoutMs + 10000).toISOString()
    }
  };
  return { state: nextState, value: { attemptCount, nextAllowedAt: nextState.nextAllowedAt } };
}

function completeProbe(stored, reservationId, result, startedAt, completedAt, trigger) {
  const state = sanitizeStoredState(stored);
  if (state.inFlight?.reservationId !== reservationId) return { state, value: state };
  const warningCode = (Array.isArray(result?.warnings) ? result.warnings : [])
    .map((value) => String(value || '').slice(0, 100))
    .find(Boolean) || '';
  const nextState = {
    ...state,
    inFlight: null,
    lastResult: {
      status: ['complete', 'partial', 'unavailable'].includes(result?.status) ? result.status : 'unavailable',
      checkedAt: new Date(completedAt).toISOString(),
      warningCode,
      durationMs: Math.max(0, completedAt - startedAt),
      sourceCount: Math.max(0, Math.min(20, Number(result?.sources?.length || 0))),
      searchRequestCount: Math.max(0, Math.min(2, Number(result?.searchRequestCount || 0))),
      trigger: trigger === 'enable' ? 'enable' : 'manual'
    }
  };
  return { state: nextState, value: nextState };
}

function publicProbeState(stored, policy, now, override = {}) {
  const state = normalizeStoredState(stored, policy, now);
  const recentAttempts = state.recentAttempts.filter((value) => isoMs(value) > now - HOUR_MS);
  const hourlyNextAllowedAt = recentAttempts.length >= policy.hourlyLimit
    ? isoMs(recentAttempts[0]) + HOUR_MS
    : 0;
  const cooldownNextAllowedAt = isoMs(state.nextAllowedAt) > now ? isoMs(state.nextAllowedAt) : 0;
  const nextAllowedAtMs = Math.max(hourlyNextAllowedAt, cooldownNextAllowedAt);
  const inProgress = Boolean(state.inFlight && isoMs(state.inFlight.leaseUntil) > now);
  const status = override.status
    || (inProgress ? 'running' : state.lastResult?.status || 'not_checked');
  return {
    policyEnabled: policy.enabled,
    status,
    inProgress,
    attemptCount: state.attemptCount,
    cooldownScheduleSeconds: policy.cooldownMs.map((value) => value / 1000),
    resetAfterSeconds: policy.resetAfterMs / 1000,
    hourlyLimit: policy.hourlyLimit,
    remainingHourlyAttempts: Math.max(0, policy.hourlyLimit - recentAttempts.length),
    lastAttemptAt: state.lastProbeAt || '',
    lastCheckedAt: state.lastResult?.checkedAt || '',
    nextAllowedAt: nextAllowedAtMs ? new Date(nextAllowedAtMs).toISOString() : '',
    retryAfterMs: nextAllowedAtMs ? Math.max(0, nextAllowedAtMs - now) : 0,
    warningCode: override.warningCode || state.lastResult?.warningCode || '',
    durationMs: Number(state.lastResult?.durationMs || 0),
    sourceCount: Number(state.lastResult?.sourceCount || 0),
    searchRequestCount: Number(state.lastResult?.searchRequestCount || 0),
    lastTrigger: state.lastResult?.trigger || ''
  };
}

function normalizeStoredState(stored, policy, now) {
  const state = sanitizeStoredState(stored);
  const lastProbeAt = isoMs(state.lastProbeAt);
  if (lastProbeAt && now - lastProbeAt >= policy.resetAfterMs) {
    return {
      ...state,
      attemptCount: 0,
      nextAllowedAt: '',
      inFlight: state.inFlight && isoMs(state.inFlight.leaseUntil) > now ? state.inFlight : null,
      recentAttempts: state.recentAttempts.filter((value) => isoMs(value) > now - HOUR_MS)
    };
  }
  return {
    ...state,
    inFlight: state.inFlight && isoMs(state.inFlight.leaseUntil) > now ? state.inFlight : null,
    recentAttempts: state.recentAttempts.filter((value) => isoMs(value) > now - HOUR_MS)
  };
}

function sanitizeStoredState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    attemptCount: Math.max(0, Math.min(1000, Number(source.attemptCount || 0))),
    lastProbeAt: safeIso(source.lastProbeAt),
    nextAllowedAt: safeIso(source.nextAllowedAt),
    recentAttempts: (Array.isArray(source.recentAttempts) ? source.recentAttempts : [])
      .map(safeIso)
      .filter(Boolean)
      .slice(-60),
    inFlight: source.inFlight && typeof source.inFlight === 'object'
      ? {
          reservationId: String(source.inFlight.reservationId || '').slice(0, 100),
          startedAt: safeIso(source.inFlight.startedAt),
          leaseUntil: safeIso(source.inFlight.leaseUntil)
        }
      : null,
    lastResult: source.lastResult && typeof source.lastResult === 'object'
      ? {
          status: String(source.lastResult.status || '').slice(0, 40),
          checkedAt: safeIso(source.lastResult.checkedAt),
          warningCode: String(source.lastResult.warningCode || '').replace(/[^a-z0-9_:-]/giu, '').slice(0, 100),
          durationMs: Math.max(0, Number(source.lastResult.durationMs || 0)),
          sourceCount: Math.max(0, Number(source.lastResult.sourceCount || 0)),
          searchRequestCount: Math.max(0, Number(source.lastResult.searchRequestCount || 0)),
          trigger: String(source.lastResult.trigger || '').slice(0, 20)
        }
      : null
  };
}

function createWebSearchProbeStateStore(options = {}) {
  const backend = String(
    options.backend
      || process.env.AI_TEACHER_WEB_SEARCH_PROBE_STATE_BACKEND
      || process.env.AI_TEACHER_CONVERSATION_BACKEND
      || 'memory'
  ).trim().toLowerCase();
  if (backend !== 'postgres') return createMemoryProbeStateStore(options);
  try {
    return createPostgresProbeStateStore(options);
  } catch {
    return createUnavailableProbeStateStore();
  }
}

function createUnavailableProbeStateStore() {
  const unavailable = () => {
    throw probeError(
      'WEB_SEARCH_PROBE_STORAGE_UNAVAILABLE',
      '付费搜索探针状态存储不可用。',
      503
    );
  };
  return {
    mode: 'unavailable',
    ready: unavailable,
    read: unavailable,
    update: unavailable,
    async close() {}
  };
}

function createMemoryProbeStateStore(options = {}) {
  const states = options.states || new Map();
  let queue = Promise.resolve();
  return {
    mode: 'memory',
    async ready() {},
    async read(key) {
      return clone(states.get(key) || {});
    },
    async update(key, updater) {
      let release;
      const previous = queue;
      queue = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        const updated = updater(clone(states.get(key) || {}));
        states.set(key, clone(updated.state || {}));
        return updated.value;
      } finally {
        release();
      }
    },
    async close() {}
  };
}

function createPostgresProbeStateStore(options = {}) {
  const pool = options.pool || createPool(options);
  const ownedPool = !options.pool;
  let readyPromise;
  const ready = async () => {
    if (!readyPromise) {
      readyPromise = pool.query(`
        create table if not exists teacher_capability_probe_state (
          capability_key text primary key,
          state jsonb not null default '{}'::jsonb,
          updated_at timestamptz not null default now()
        )
      `);
    }
    await readyPromise;
  };
  return {
    mode: 'postgres',
    ready,
    async read(key) {
      await ready();
      const result = await pool.query(
        'select state from teacher_capability_probe_state where capability_key = $1',
        [key]
      );
      return clone(result.rows[0]?.state || {});
    },
    async update(key, updater) {
      await ready();
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`
          insert into teacher_capability_probe_state (capability_key, state)
          values ($1, '{}'::jsonb)
          on conflict (capability_key) do nothing
        `, [key]);
        const current = await client.query(
          'select state from teacher_capability_probe_state where capability_key = $1 for update',
          [key]
        );
        const updated = updater(clone(current.rows[0]?.state || {}));
        await client.query(`
          update teacher_capability_probe_state
          set state = $2::jsonb, updated_at = now()
          where capability_key = $1
        `, [key, JSON.stringify(updated.state || {})]);
        await client.query('commit');
        return updated.value;
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      if (ownedPool) await pool.end();
    }
  };
}

function createPool(options) {
  return require('./database-pool-policy').createTeacherDatabasePool(options, 'postgres probe state');
}

function parseCooldownSchedule(value) {
  const items = Array.isArray(value)
    ? value
    : String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  const parsed = items
    .map(Number)
    .filter((item) => Number.isInteger(item) && item >= 1 && item <= 86400)
    .slice(0, 8);
  return parsed.length > 0 ? parsed : DEFAULT_COOLDOWN_SECONDS;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function nowMs(clock) {
  const value = clock();
  const time = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(time) ? time : Date.now();
}

function safeIso(value) {
  const time = isoMs(value);
  return time ? new Date(time).toISOString() : '';
}

function isoMs(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : 0;
}

function safeWarning(error) {
  const code = String(error?.code || 'domain_web_search_probe_failed').toLowerCase();
  return /^[a-z0-9_:-]{1,100}$/u.test(code) ? code : 'domain_web_search_probe_failed';
}

function probeError(code, message, statusCode, details) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

module.exports = {
  createMemoryProbeStateStore,
  createWebSearchProbeController,
  createWebSearchProbePolicyConfig,
  createWebSearchProbeStateStore,
  publicProbeState,
  reserveProbe
};
