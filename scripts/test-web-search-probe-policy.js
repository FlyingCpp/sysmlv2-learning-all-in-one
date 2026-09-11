'use strict';

const assert = require('assert');
const { createDeepSeekWebSearchConfig } = require('../apps/teacher/deepseek-web-search');
const {
  createMemoryProbeStateStore,
  createWebSearchProbeController,
  createWebSearchProbePolicyConfig
} = require('../apps/teacher/web-search-probe-policy');

async function main() {
  let currentTime = Date.parse('2026-07-23T00:00:00.000Z');
  let searchCalls = 0;
  const searchInputs = [];
  const searchConfig = createDeepSeekWebSearchConfig({
    enabled: false,
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-v4-flash'
  });
  const policy = createWebSearchProbePolicyConfig({
    enabled: true,
    cooldownSeconds: [30, 60, 180, 600],
    resetAfterSeconds: 900,
    hourlyLimit: 6,
    timeoutMs: 5000
  });
  const controller = createWebSearchProbeController({
    policy,
    searchConfig,
    store: createMemoryProbeStateStore(),
    clock: () => new Date(currentTime),
    search: async (config, input) => {
      searchCalls += 1;
      searchInputs.push({ config, input });
      return {
        version: 'domain-search-result-v3',
        status: 'complete',
        provider: 'deepseek-native-web-search',
        questions: input.questions,
        summary: 'Probe summary.',
        searchRequestCount: 1,
        sources: [{
          sourceId: 'domain_0123456789abcdef0123',
          title: 'Probe source',
          url: 'https://example.test/private-canary-body'
        }],
        warnings: []
      };
    }
  });

  const first = await controller.enableAndProbe();
  assert.equal(first.action, 'enabled_and_probed');
  assert.equal(searchConfig.enabled, true);
  assert.equal(searchCalls, 1, 'first enable must execute exactly one paid probe');
  assert.equal(first.domainWebSearch.ready, true);
  assert.equal(first.probe.status, 'complete');
  assert.equal(first.probe.attemptCount, 1);
  assert.equal(first.probe.retryAfterMs, 30000);
  assert.deepEqual(searchInputs[0].config.maxUses, 1);
  assert.deepEqual(searchInputs[0].config.maxOutputTokens, 512);
  assert.equal(searchInputs[0].input.questions.length, 1);
  assert(!JSON.stringify(first).includes('private-canary-body'), 'probe response must not expose canary source content');
  controller.updatePolicy({ enabled: true, hourlyLimit: 6, timeoutMs: 17000 });
  assert.deepEqual(controller.policyState(), { enabled: true, hourlyLimit: 6, timeoutMs: 17000 });

  await assert.rejects(
    () => controller.probe(),
    (error) => error.code === 'WEB_SEARCH_PROBE_COOLDOWN' && error.statusCode === 429
  );
  assert.equal(searchCalls, 1, 'cooldown rejection must not call the provider');

  currentTime += 30000;
  const second = await controller.probe();
  assert.equal(searchInputs.at(-1).config.timeoutMs, 17000, 'runtime timeout update must reach the next paid probe');
  assert.equal(second.probe.attemptCount, 2);
  assert.equal(second.probe.retryAfterMs, 60000);
  currentTime += 60000;
  const third = await controller.probe();
  assert.equal(third.probe.attemptCount, 3);
  assert.equal(third.probe.retryAfterMs, 180000);
  currentTime += 180000;
  const fourth = await controller.probe();
  assert.equal(fourth.probe.attemptCount, 4);
  assert.equal(fourth.probe.retryAfterMs, 600000);

  const disabled = await controller.disable();
  assert.equal(disabled.domainWebSearch.enabled, false, 'disable must remain immediate during cooldown');
  const deferredEnable = await controller.enableAndProbe();
  assert.equal(deferredEnable.action, 'enabled_probe_deferred');
  assert.equal(deferredEnable.domainWebSearch.enabled, true, 'cooldown must not prevent the free runtime enablement');
  assert.equal(searchCalls, 4, 'deferred enable must not call the provider');

  currentTime += 900000;
  const reset = await controller.publicState();
  assert.equal(reset.attemptCount, 0, '900 seconds without a probe must reset the cooldown tier');
  assert.equal(reset.retryAfterMs, 0);
  const afterReset = await controller.probe();
  assert.equal(afterReset.probe.attemptCount, 1);
  assert.equal(afterReset.probe.retryAfterMs, 30000);

  let heldResolve;
  let concurrentCalls = 0;
  const concurrentConfig = createDeepSeekWebSearchConfig({
    enabled: false,
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com/anthropic'
  });
  const concurrentController = createWebSearchProbeController({
    policy,
    searchConfig: concurrentConfig,
    store: createMemoryProbeStateStore(),
    clock: () => new Date(currentTime),
    search: async () => {
      concurrentCalls += 1;
      await new Promise((resolve) => { heldResolve = resolve; });
      return {
        version: 'domain-search-result-v3',
        status: 'partial',
        provider: 'deepseek-native-web-search',
        questions: ['probe'],
        summary: '',
        searchRequestCount: 1,
        sources: [],
        warnings: ['domain_web_search_sources_missing']
      };
    }
  });
  const concurrentFirst = concurrentController.enableAndProbe();
  await new Promise((resolve) => setImmediate(resolve));
  const concurrentSecond = await concurrentController.enableAndProbe();
  assert.equal(concurrentSecond.action, 'enabled_probe_deferred');
  assert.equal(concurrentCalls, 1, 'concurrent enable requests must reserve only one provider call');
  heldResolve();
  const concurrentResult = await concurrentFirst;
  assert.equal(concurrentResult.probe.status, 'partial');

  const pausedConfig = createDeepSeekWebSearchConfig({
    enabled: false,
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com/anthropic'
  });
  const pausedController = createWebSearchProbeController({
    policy: createWebSearchProbePolicyConfig({ enabled: false }),
    searchConfig: pausedConfig,
    store: createMemoryProbeStateStore(),
    search: async () => { throw new Error('paused policy must not call search'); }
  });
  const paused = await pausedController.enableAndProbe();
  assert.equal(paused.action, 'enabled_probe_paused');
  assert.equal(paused.domainWebSearch.enabled, true);
  assert.equal(paused.probe.status, 'paused');

  let unavailableSearchCalls = 0;
  const unavailableConfig = createDeepSeekWebSearchConfig({
    enabled: false,
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com/anthropic'
  });
  const unavailableController = createWebSearchProbeController({
    policy,
    searchConfig: unavailableConfig,
    store: {
      async ready() { throw new Error('database details must stay private'); },
      async read() { throw new Error('database details must stay private'); },
      async update() { throw new Error('database details must stay private'); }
    },
    search: async () => { unavailableSearchCalls += 1; }
  });
  const unavailable = await unavailableController.enableAndProbe();
  assert.equal(unavailable.action, 'enabled_probe_unavailable');
  assert.equal(unavailable.domainWebSearch.enabled, true, 'probe storage failure must not couple into the business switch');
  assert.equal(unavailable.probe.status, 'storage_unavailable');
  assert.equal(unavailableSearchCalls, 0, 'storage failure must fail closed before a paid call');
  await assert.rejects(
    () => unavailableController.probe(),
    (error) => error.code === 'WEB_SEARCH_PROBE_STORAGE_UNAVAILABLE' && error.statusCode === 503
  );

  const limitedConfig = createDeepSeekWebSearchConfig({
    enabled: true,
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com/anthropic'
  });
  let limitedTime = Date.parse('2026-07-23T02:00:00.000Z');
  const limitedController = createWebSearchProbeController({
    policy: createWebSearchProbePolicyConfig({ cooldownSeconds: [1], hourlyLimit: 2, resetAfterSeconds: 900 }),
    searchConfig: limitedConfig,
    store: createMemoryProbeStateStore(),
    clock: () => new Date(limitedTime),
    search: async () => ({
      version: 'domain-search-result-v3',
      status: 'complete',
      provider: 'deepseek-native-web-search',
      questions: ['probe'],
      summary: 'Probe summary.',
      searchRequestCount: 1,
      sources: [{
        sourceId: 'domain_0123456789abcdef0123',
        title: 'Probe source',
        url: 'https://example.test/probe'
      }],
      warnings: []
    })
  });
  await limitedController.probe();
  limitedTime += 1000;
  await limitedController.probe();
  limitedTime += 1000;
  await assert.rejects(
    () => limitedController.probe(),
    (error) => error.code === 'WEB_SEARCH_PROBE_HOURLY_LIMIT' && error.statusCode === 429
  );
  limitedController.updatePolicy({ enabled: false, hourlyLimit: 0, timeoutMs: 9000 });
  assert.deepEqual(limitedController.policyState(), { enabled: false, hourlyLimit: 0, timeoutMs: 9000 });
  await assert.rejects(() => limitedController.probe(), (error) => error.code === 'WEB_SEARCH_PROBE_PAUSED');

  console.log('web search probe policy tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
