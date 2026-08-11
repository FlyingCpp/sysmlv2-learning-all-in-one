'use strict';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 60000;
const DEFAULT_STALE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_MANUAL_COOLDOWN_MS = 30 * 1000;
const DEFAULT_READ_REFRESH_MS = 60 * 1000;
const MAX_FEED_BYTES = 256 * 1024;
const MAX_TITLE_LENGTH = 240;
const MAX_DETAIL_LENGTH = 600;

const PROVIDER_FEEDS = Object.freeze([
  Object.freeze({
    id: 'deepseek',
    name: 'DeepSeek',
    officialStatusUrl: 'https://status.deepseek.com/',
    feedUrl: 'https://status.deepseek.com/history.atom',
    subscriptionChannels: Object.freeze(['email', 'slack', 'atom', 'rss'])
  }),
  Object.freeze({
    id: 'moonshot',
    name: 'Kimi / Moonshot',
    officialStatusUrl: 'https://status.moonshot.cn/',
    feedUrl: 'https://status.moonshot.cn/history.atom',
    subscriptionChannels: Object.freeze(['atom', 'rss', 'json'])
  })
]);

const PROVIDERS_WITHOUT_PUBLIC_FEEDS = Object.freeze([
  Object.freeze({
    id: 'zhipu',
    name: 'GLM / 智谱',
    status: 'not_available',
    phase: '',
    officialStatusUrl: '',
    subscriptionAvailable: false,
    subscriptionChannels: Object.freeze([]),
    latestIncident: null,
    sourceFreshness: 'not_available',
    note: '当前未发现可验证的公开官方状态订阅；接入后应使用 LiteLLM 与业务主动探针。'
  })
]);

function createProviderStatusAggregator(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const now = options.now || (() => Date.now());
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 500, 15000);
  const cacheTtlMs = boundedInteger(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 1000, 10 * 60 * 1000);
  const staleTtlMs = boundedInteger(options.staleTtlMs, DEFAULT_STALE_TTL_MS, cacheTtlMs, 60 * 60 * 1000);
  const cache = new Map();

  return {
    async getSnapshot(refreshOptions = {}) {
      if (refreshOptions.force === true) cache.clear();
      const providers = await Promise.all(PROVIDER_FEEDS.map((provider) => readProvider(provider)));
      return {
        generatedAt: new Date(now()).toISOString(),
        refreshAfterMs: cacheTtlMs,
        providers: [...providers, ...PROVIDERS_WITHOUT_PUBLIC_FEEDS.map(cloneProvider)]
      };
    },
    clearCache() {
      cache.clear();
    }
  };

  async function readProvider(provider) {
    const timestamp = now();
    const cached = cache.get(provider.id);
    if (cached && timestamp < cached.expiresAt) return cloneProvider(cached.value);

    try {
      if (typeof fetchImpl !== 'function') throw providerStatusError('fetch_unavailable');
      const response = await fetchImpl(provider.feedUrl, {
        method: 'GET',
        headers: {
          accept: 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8',
          'user-agent': 'sysmlv2-ai-teacher-provider-status/1.0'
        },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw providerStatusError(`http_${response.status}`);
      const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
      if (!/(atom|xml)/u.test(contentType)) throw providerStatusError('content_type_invalid');
      const declaredLength = Number(response.headers?.get?.('content-length') || 0);
      if (declaredLength > MAX_FEED_BYTES) throw providerStatusError('feed_too_large');
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > MAX_FEED_BYTES) throw providerStatusError('feed_too_large');

      const incident = parseLatestAtomIncident(body, provider);
      const value = {
        id: provider.id,
        name: provider.name,
        status: incident.status,
        phase: incident.phase,
        officialStatusUrl: provider.officialStatusUrl,
        subscriptionAvailable: true,
        subscriptionChannels: [...provider.subscriptionChannels],
        latestIncident: incident.latestIncident,
        sourceFreshness: 'fresh',
        sourceCheckedAt: new Date(timestamp).toISOString(),
        note: provider.id === 'deepseek'
          ? '官方公告仅代表厂商声明；DeepSeek Web Search 仍需结合 Teacher 实测状态。'
          : '官方公告仅代表厂商声明；实际模型可用性仍需结合 LiteLLM 或业务探针。'
      };
      cache.set(provider.id, {
        value,
        expiresAt: timestamp + cacheTtlMs,
        staleUntil: timestamp + staleTtlMs
      });
      return cloneProvider(value);
    } catch (error) {
      const errorCode = safeProviderStatusErrorCode(error);
      if (cached && timestamp < cached.staleUntil) {
        return {
          ...cloneProvider(cached.value),
          sourceFreshness: 'stale',
          errorCode
        };
      }
      return {
        id: provider.id,
        name: provider.name,
        status: 'unknown',
        phase: '',
        officialStatusUrl: provider.officialStatusUrl,
        subscriptionAvailable: true,
        subscriptionChannels: [...provider.subscriptionChannels],
        latestIncident: null,
        sourceFreshness: 'unavailable',
        errorCode,
        note: '官方状态订阅暂时无法读取；不得据此推断服务正常。'
      };
    }
  }
}

function createProviderStatusMonitor(options = {}) {
  const aggregator = options.aggregator || createProviderStatusAggregator(options);
  const now = options.now || (() => Date.now());
  const refreshIntervalMs = boundedInteger(options.refreshIntervalMs, DEFAULT_REFRESH_INTERVAL_MS, 1000, 60 * 60 * 1000);
  const manualCooldownMs = boundedInteger(options.manualCooldownMs, DEFAULT_MANUAL_COOLDOWN_MS, 1000, 5 * 60 * 1000);
  const readRefreshMs = boundedInteger(options.readRefreshMs, DEFAULT_READ_REFRESH_MS, 1000, 10 * 60 * 1000);
  const scheduleTimeout = options.setTimeout || setTimeout;
  const cancelTimeout = options.clearTimeout || clearTimeout;
  let latestSnapshot = { generatedAt: '', providers: [] };
  let started = false;
  let timer = null;
  let startupPromise = null;
  let refreshPromise = null;
  let lastManualAt = 0;
  const sync = {
    intervalMs: refreshIntervalMs,
    manualCooldownMs,
    lastAttemptAt: '',
    lastSuccessAt: '',
    lastCompletedAt: '',
    nextScheduledAt: '',
    lastTrigger: '',
    lastOutcome: 'not_started',
    errorCode: '',
    inProgress: false
  };

  return {
    start,
    stop,
    ready: () => startupPromise || Promise.resolve(),
    refresh,
    getSnapshot
  };

  function start() {
    if (started) return startupPromise || Promise.resolve(getSnapshot());
    started = true;
    startupPromise = refresh({ trigger: 'startup' }).finally(() => {
      startupPromise = null;
      if (started) scheduleNext();
    });
    return startupPromise;
  }

  function stop() {
    started = false;
    if (timer) cancelTimeout(timer);
    timer = null;
    sync.nextScheduledAt = '';
  }

  async function refresh(refreshOptions = {}) {
    const trigger = normalizeTrigger(refreshOptions.trigger);
    const timestamp = now();
    if (trigger === 'manual') {
      const retryAfterMs = lastManualAt + manualCooldownMs - timestamp;
      if (retryAfterMs > 0) throw manualCooldownError(retryAfterMs);
      lastManualAt = timestamp;
    }
    if (refreshPromise) return refreshPromise;

    sync.lastAttemptAt = new Date(timestamp).toISOString();
    sync.lastTrigger = trigger;
    sync.lastOutcome = 'running';
    sync.errorCode = '';
    sync.inProgress = true;
    refreshPromise = Promise.resolve()
      .then(() => aggregator.getSnapshot({ force: true }))
      .then((incoming) => {
        latestSnapshot = mergeWithLastGoodSnapshot(latestSnapshot, incoming, now());
        const failedProviders = latestSnapshot.providers.filter((provider) => (
          provider.subscriptionAvailable && provider.sourceFreshness !== 'fresh'
        ));
        sync.lastOutcome = failedProviders.length ? 'partial' : 'success';
        if (!failedProviders.length) sync.lastSuccessAt = latestSnapshot.generatedAt;
      })
      .catch((error) => {
        sync.lastOutcome = 'failed';
        sync.errorCode = safeProviderStatusErrorCode(error);
        latestSnapshot = markSnapshotStale(latestSnapshot, sync.errorCode, now());
      })
      .finally(() => {
        sync.lastCompletedAt = new Date(now()).toISOString();
        sync.inProgress = false;
        refreshPromise = null;
      })
      .then(() => getSnapshot());
    return refreshPromise;
  }

  function getSnapshot() {
    return {
      generatedAt: latestSnapshot.generatedAt,
      refreshAfterMs: readRefreshMs,
      sync: { ...sync },
      providers: latestSnapshot.providers.map(cloneProvider)
    };
  }

  function scheduleNext() {
    if (!started) return;
    if (timer) cancelTimeout(timer);
    sync.nextScheduledAt = new Date(now() + refreshIntervalMs).toISOString();
    timer = scheduleTimeout(async () => {
      timer = null;
      sync.nextScheduledAt = '';
      await refresh({ trigger: 'scheduled' });
      if (started) scheduleNext();
    }, refreshIntervalMs);
    timer?.unref?.();
  }
}

function mergeWithLastGoodSnapshot(previous, incoming, timestamp) {
  const previousById = new Map((previous?.providers || []).map((provider) => [provider.id, provider]));
  const providers = (incoming?.providers || []).map((provider) => {
    if (!provider.subscriptionAvailable || provider.sourceFreshness === 'fresh') return cloneProvider(provider);
    const lastGood = previousById.get(provider.id);
    if (!lastGood || !['fresh', 'stale'].includes(lastGood.sourceFreshness)) return cloneProvider(provider);
    return {
      ...cloneProvider(lastGood),
      sourceFreshness: 'stale',
      errorCode: provider.errorCode || 'refresh_failed'
    };
  });
  return {
    generatedAt: incoming?.generatedAt || new Date(timestamp).toISOString(),
    providers
  };
}

function markSnapshotStale(snapshot, errorCode, timestamp) {
  return {
    generatedAt: new Date(timestamp).toISOString(),
    providers: (snapshot?.providers || []).map((provider) => provider.subscriptionAvailable ? {
      ...cloneProvider(provider),
      sourceFreshness: 'stale',
      errorCode: errorCode || 'refresh_failed'
    } : cloneProvider(provider))
  };
}

function normalizeTrigger(value) {
  const trigger = String(value || '').trim().toLowerCase();
  return ['startup', 'scheduled', 'manual'].includes(trigger) ? trigger : 'manual';
}

function manualCooldownError(retryAfterMs) {
  const error = new Error('状态刚刚刷新，请稍后再试。');
  error.statusCode = 429;
  error.code = 'PROVIDER_STATUS_REFRESH_COOLDOWN';
  error.details = { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  return error;
}

function parseLatestAtomIncident(xml, provider) {
  const entry = String(xml || '').match(/<entry\b[^>]*>([\s\S]*?)<\/entry>/iu)?.[1];
  if (!entry) throw providerStatusError('feed_entry_missing');

  const title = boundedText(decodeXmlText(extractElement(entry, 'title')), MAX_TITLE_LENGTH);
  const updatedAt = normalizedTimestamp(extractElement(entry, 'updated') || extractElement(entry, 'published'));
  const content = extractElement(entry, 'summary') || extractElement(entry, 'content');
  const plainContent = boundedText(decodeXmlText(content), MAX_DETAIL_LENGTH);
  const phase = extractIncidentPhase(plainContent);
  const link = safeIncidentUrl(extractLinkHref(entry), provider.officialStatusUrl);
  if (!title || !phase) throw providerStatusError('feed_incident_invalid');

  return {
    status: statusForPhase(phase),
    phase,
    latestIncident: {
      title,
      detail: plainContent,
      updatedAt,
      url: link
    }
  };
}

function extractElement(value, name) {
  const match = String(value || '').match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'iu'));
  return match?.[1] || '';
}

function extractLinkHref(value) {
  const links = [...String(value || '').matchAll(/<link\b([^>]*)>/giu)];
  for (const [, attributes] of links) {
    const rel = attributes.match(/\brel=["']([^"']+)["']/iu)?.[1] || '';
    const href = attributes.match(/\bhref=["']([^"']+)["']/iu)?.[1] || '';
    if (href && (!rel || rel === 'alternate')) return decodeXmlEntities(href);
  }
  return '';
}

function extractIncidentPhase(value) {
  const text = String(value || '');
  const explicit = text.match(/\bstatus\s*:\s*(resolved|completed|investigating|identified|monitoring|scheduled|in[ _-]?progress)\b/iu)?.[1];
  const fallback = text.match(/\b(resolved|completed|investigating|identified|monitoring|scheduled|in[ _-]?progress)\b/iu)?.[1];
  return normalizePhase(explicit || fallback || '');
}

function normalizePhase(value) {
  return String(value || '').trim().toLowerCase().replace(/[ -]+/gu, '_');
}

function statusForPhase(phase) {
  if (phase === 'resolved' || phase === 'completed') return 'operational';
  if (phase === 'monitoring') return 'degraded';
  if (phase === 'investigating' || phase === 'identified' || phase === 'scheduled' || phase === 'in_progress') return 'incident';
  return 'unknown';
}

function safeIncidentUrl(value, officialStatusUrl) {
  try {
    const url = new URL(String(value || ''), officialStatusUrl);
    const official = new URL(officialStatusUrl);
    if (url.protocol !== 'https:' || url.origin !== official.origin || !url.pathname.startsWith('/incidents/')) return officialStatusUrl;
    return url.toString();
  } catch {
    return officialStatusUrl;
  }
}

function decodeXmlText(value) {
  const decoded = decodeXmlEntities(value);
  return decoded
    .replace(/<br\s*\/?\s*>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => safeCodePoint(parseInt(code, 16)))
    .replace(/&#([0-9]+);/gu, (_, code) => safeCodePoint(parseInt(code, 10)))
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&apos;/giu, "'")
    .replace(/&amp;/giu, '&');
}

function safeCodePoint(value) {
  try {
    return Number.isInteger(value) ? String.fromCodePoint(value) : '';
  } catch {
    return '';
  }
}

function normalizedTimestamp(value) {
  const date = new Date(String(value || '').trim());
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function boundedText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function providerStatusError(code) {
  const error = new Error(code);
  error.providerStatusCode = code;
  return error;
}

function safeProviderStatusErrorCode(error) {
  const direct = String(error?.providerStatusCode || '');
  if (/^[a-z0-9_]{1,80}$/u.test(direct)) return direct;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  return 'network_error';
}

function cloneProvider(provider) {
  return {
    ...provider,
    subscriptionChannels: [...(provider.subscriptionChannels || [])],
    latestIncident: provider.latestIncident ? { ...provider.latestIncident } : null
  };
}

module.exports = {
  PROVIDER_FEEDS,
  createProviderStatusAggregator,
  createProviderStatusMonitor,
  parseLatestAtomIncident,
  statusForPhase
};
