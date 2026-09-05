'use strict';

const {
  BOOTSTRAP_VALUES: AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES,
  runtimeProjection: agentResourcePolicyRuntimeProjection
} = require('../../packages/agent-resource-policy');

const RESOURCE_POLICY_PROVIDER_DEFAULTS = agentResourcePolicyRuntimeProjection(
  AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES
).provider;

/**
 * Teacher只负责本进程的Agent Run准入。Provider重试、退避、熔断和请求超时
 * 由LiteLLM Provider Owner负责，避免同一次失败在两层被重复放大。
 */
function createProviderResilienceGateway(options = {}) {
  let settings = createAdmissionConfig(options);
  const state = {
    inFlight: 0,
    queue: []
  };

  async function run(request) {
    if (!request || typeof request.invoke !== 'function') {
      throw new TypeError('Provider Run admission requires an invoke function.');
    }
    throwIfAborted(request.signal);
    return enqueue(state, settings, async () => {
      throwIfAborted(request.signal);
      const result = await request.invoke();
      throwIfAborted(request.signal);
      return result;
    }, request.signal);
  }

  function updateSettings(nextOptions = {}) {
    settings = createAdmissionConfig(nextOptions);
    return { ...settings };
  }

  return {
    run,
    state,
    updateSettings,
    get settings() {
      return settings;
    }
  };
}

function createAdmissionConfig(options = {}) {
  assertRetiredProviderControlsAbsent(options);
  return {
    maxConcurrency: positiveInt(
      options.maxConcurrency,
      RESOURCE_POLICY_PROVIDER_DEFAULTS.maxConcurrency
    ),
    queueLimit: nonNegativeInt(
      options.queueLimit,
      RESOURCE_POLICY_PROVIDER_DEFAULTS.queueLimit
    )
  };
}

function assertRetiredProviderControlsAbsent(options) {
  const retired = [
    'queueTimeoutMs',
    'queueWaitMs',
    'requestTimeoutMs',
    'maxRetries',
    'retryJitter',
    'retryBaseMs',
    'retryMaxMs',
    'circuitFailureThreshold',
    'circuitFailureWindowMs',
    'circuitOpenMs',
    'halfOpenMaxProbes'
  ].filter((key) => Object.hasOwn(options, key));
  if (retired.length === 0) return;
  throw new RangeError(`Teacher Provider controls were removed: ${retired.join(', ')}`);
}

function enqueue(state, settings, task, signal) {
  throwIfAborted(signal);
  if (state.inFlight < settings.maxConcurrency) {
    return startTask(state, settings, task);
  }
  if (state.queue.length >= settings.queueLimit) {
    throw providerError('AI_TEACHER_BUSY', 'AI teacher is busy; retry later.', 429);
  }
  return new Promise((resolve, reject) => {
    const item = {
      task,
      resolve,
      reject,
      signal,
      abortListener: null
    };
    if (signal) {
      item.abortListener = () => {
        const index = state.queue.indexOf(item);
        if (index >= 0) state.queue.splice(index, 1);
        reject(providerError('TEACHER_RUN_CANCELLED', 'Teacher run cancelled.', 499));
      };
      signal.addEventListener('abort', item.abortListener, { once: true });
    }
    state.queue.push(item);
  });
}

async function startTask(state, settings, task) {
  state.inFlight += 1;
  try {
    return await task();
  } finally {
    state.inFlight -= 1;
    drainQueue(state, settings);
  }
}

function drainQueue(state, settings) {
  while (state.inFlight < settings.maxConcurrency && state.queue.length > 0) {
    const item = state.queue.shift();
    item.signal?.removeEventListener('abort', item.abortListener);
    startTask(state, settings, item.task).then(item.resolve, item.reject);
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw providerError('TEACHER_RUN_CANCELLED', 'Teacher run cancelled.', 499);
}

function providerError(code, message, statusCode, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

module.exports = {
  createProviderResilienceGateway,
  createAdmissionConfig
};
