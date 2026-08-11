'use strict';

const {
  BOOTSTRAP_VALUES: AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES,
  runtimeProjection: agentResourcePolicyRuntimeProjection
} = require('../../packages/agent-resource-policy');

const RESOURCE_POLICY_PROVIDER_DEFAULTS = agentResourcePolicyRuntimeProjection(AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES).provider;

const DEFAULT_TIERS = {
  patch: 1600,
  simple: 4096,
  medium: 6144,
  complex: 8192,
  longSynthesis: 12288,
  hardMax: 16384,
  visibleAnswerMin: 1024
};

function createProviderResilienceGateway(options = {}) {
  let settings = createResilienceConfig(options);
  const callProvider = options.callProvider;
  if (typeof callProvider !== 'function') {
    throw new Error('createProviderResilienceGateway requires callProvider');
  }
  const state = {
    inFlight: 0,
    queue: [],
    failures: [],
    circuitOpenUntil: 0,
    halfOpenProbes: 0
  };

  async function call(request) {
    if (request?.budgetReport?.rejected) {
      throw providerError('CONTEXT_BUDGET_EXCEEDED', 'AI teacher context is too large for a reliable answer. Please retry with less context.', 503, {
        internalProviderDiagnostic: 'CONTEXT_BUDGET_EXCEEDED',
        budgetReport: request.budgetReport
      });
    }
    if (isCircuitOpen(state, settings)) {
      throw providerError('CIRCUIT_OPEN', 'AI teacher provider is temporarily busy; retry later.', 429);
    }
    return enqueue(state, settings, () => runWithRetry(request, settings, state, callProvider), request.signal || request.options?.signal);
  }

  async function stream(request) {
    if (request?.budgetReport?.rejected) {
      throw providerError('CONTEXT_BUDGET_EXCEEDED', 'AI teacher context is too large for a reliable answer. Please retry with less context.', 503, {
        internalProviderDiagnostic: 'CONTEXT_BUDGET_EXCEEDED',
        budgetReport: request.budgetReport
      });
    }
    if (isCircuitOpen(state, settings)) {
      throw providerError('CIRCUIT_OPEN', 'AI teacher provider is temporarily busy; retry later.', 429);
    }
    return enqueue(state, settings, () => runStream(request, settings, state, options.callProviderStream || callProvider), request.signal || request.options?.signal);
  }

  async function step(request) {
    if (!request || typeof request.invoke !== 'function') {
      throw new TypeError('Provider step requires an invoke function');
    }
    const signal = request.signal;
    throwIfAborted(signal);
    if (isCircuitOpen(state, settings)) {
      throw providerError('CIRCUIT_OPEN', 'AI teacher provider is temporarily busy; retry later.', 429);
    }
    return enqueue(
      state,
      settings,
      () => runGuardedStep(request, settings, state),
      signal,
      // V2 Agent Step已经携带共享Run/SDK AbortSignal。固定8秒排队门会在Run仍有
      // 大量余额时提前失败；有Signal时让共享截止负责终止，无Signal旧调用仍保留兜底。
      { queueTimeoutMs: signal ? null : settings.queueTimeoutMs }
    );
  }

  function updateSettings(nextOptions = {}) {
    settings = createResilienceConfig(nextOptions);
    return { ...settings, tiers: { ...settings.tiers } };
  }

  return {
    call,
    stream,
    step,
    state,
    updateSettings,
    get settings() {
      return settings;
    }
  };
}

async function runGuardedStep(request, settings, state) {
  let attempt = 0;
  let lastError = null;
  while (attempt <= settings.maxRetries) {
    throwIfAborted(request.signal);
    try {
      const result = await request.invoke();
      throwIfAborted(request.signal);
      closeCircuitIfNeeded(state);
      return result;
    } catch (error) {
      lastError = normalizeProviderError(error);
      recordProviderFailure(state, settings, lastError);
      if (!isTransientProviderError(lastError) || attempt >= settings.maxRetries) break;
      await cancellableSleep(retryDelayMs(attempt, settings, lastError.retryAfterMs), request.signal);
      attempt += 1;
    }
  }
  throw sanitizeProviderError(lastError || providerError('PROVIDER_ERROR', 'AI teacher provider failed.', 503));
}

async function runStream(request, settings, state, callProviderStream) {
  throwIfAborted(request.signal || request.options?.signal);
  const tokenBudget = selectOutputBudget({
    context: request.context,
    intent: request.intent,
    messages: request.messages,
    llm: request.llm,
    responseFormat: request.responseFormat,
    settings
  });
  if (!tokenBudget.canFit) {
    throw providerError('PROVIDER_INVALID_RESPONSE', 'AI teacher context is too large for a reliable answer. Please retry with less context.', 503, {
      internalProviderDiagnostic: 'CONTEXT_WINDOW_EXCEEDED'
    });
  }
  try {
    const result = await callProviderStream(request.llm, request.messages, {
      ...(request.options || {}),
      maxOutputTokens: tokenBudget.maxCompletionTokens,
      signal: request.signal || request.options?.signal,
      onDelta: request.onDelta,
      onReasoning: request.onReasoning
    });
    closeCircuitIfNeeded(state);
    return {
      ...result,
      providerMeta: {
        estimatedInputTokens: tokenBudget.estimatedInputTokens,
        selectedOutputTier: tokenBudget.tier,
        maxCompletionTokens: tokenBudget.maxCompletionTokens,
        promptTokens: result.usage?.prompt_tokens || tokenBudget.estimatedInputTokens || null,
        completionTokens: result.usage?.completion_tokens || null,
        reasoningTokens: result.usage?.completion_tokens_details?.reasoning_tokens
          || result.usage?.reasoning_tokens
          || null,
        totalTokens: result.usage?.total_tokens || null,
        providerTrace: result.providerTrace || null,
        budgetReport: request.budgetReport || null,
        retryCount: 0
      }
    };
  } catch (error) {
    const normalized = normalizeProviderError(error);
    recordProviderFailure(state, settings, normalized);
    throw sanitizeProviderError(normalized);
  }
}

async function runWithRetry(request, settings, state, callProvider) {
  const signal = request.signal || request.options?.signal;
  throwIfAborted(signal);
  const tokenBudget = selectOutputBudget({
    context: request.context,
    intent: request.intent,
    messages: request.messages,
    llm: request.llm,
    responseFormat: request.responseFormat,
    settings
  });
  if (!tokenBudget.canFit) {
    throw providerError('PROVIDER_INVALID_RESPONSE', 'AI teacher context is too large for a reliable answer. Please retry with less context.', 503, {
      internalProviderDiagnostic: 'CONTEXT_WINDOW_EXCEEDED'
    });
  }

  let attempt = 0;
  let lastError = null;
  const startedAt = Date.now();
  while (attempt <= settings.maxRetries) {
    throwIfAborted(signal);
    try {
      const result = await callProvider(request.llm, request.messages, {
        ...(request.options || {}),
        maxOutputTokens: tokenBudget.maxCompletionTokens,
        signal
      });
      closeCircuitIfNeeded(state);
      return {
        ...result,
        providerMeta: {
          estimatedInputTokens: tokenBudget.estimatedInputTokens,
          selectedOutputTier: tokenBudget.tier,
          maxCompletionTokens: tokenBudget.maxCompletionTokens,
          promptTokens: result.usage?.prompt_tokens || tokenBudget.estimatedInputTokens || null,
          completionTokens: result.usage?.completion_tokens || null,
          reasoningTokens: result.usage?.completion_tokens_details?.reasoning_tokens
            || result.usage?.reasoning_tokens
            || null,
          totalTokens: result.usage?.total_tokens || null,
          providerTrace: result.providerTrace || null,
          budgetReport: request.budgetReport || null,
          retryCount: attempt
        }
      };
    } catch (error) {
      lastError = normalizeProviderError(error);
      recordProviderFailure(state, settings, lastError);
      if (!isTransientProviderError(lastError) || attempt >= settings.maxRetries) break;
      const delayMs = retryDelayMs(attempt, settings, lastError.retryAfterMs);
      if (Date.now() + delayMs - startedAt > request.llm.timeoutMs) break;
      await cancellableSleep(delayMs, signal);
      attempt += 1;
    }
  }
  throw sanitizeProviderError(lastError || providerError('PROVIDER_ERROR', 'AI teacher provider failed.', 503));
}

function enqueue(state, settings, task, signal, options = {}) {
  throwIfAborted(signal);
  if (state.inFlight < settings.maxConcurrency) {
    return startTask(state, settings, task);
  }
  if (state.queue.length >= settings.queueLimit) {
    throw providerError('AI_TEACHER_BUSY', 'AI teacher is busy; retry later.', 429);
  }
  return new Promise((resolve, reject) => {
    const queueTimeoutMs = options.queueTimeoutMs === null
      ? null
      : positiveInt(options.queueTimeoutMs, null, settings.queueTimeoutMs);
    const item = {
      task,
      resolve,
      reject,
      signal,
      abortListener: null,
      timer: queueTimeoutMs === null ? null : setTimeout(() => {
        const index = state.queue.indexOf(item);
        if (index >= 0) state.queue.splice(index, 1);
        signal?.removeEventListener('abort', item.abortListener);
        reject(providerError('AI_TEACHER_QUEUE_TIMEOUT', 'AI teacher request waited too long; retry later.', 429));
      }, queueTimeoutMs)
    };
    if (signal) {
      item.abortListener = () => {
        const index = state.queue.indexOf(item);
        if (index >= 0) state.queue.splice(index, 1);
        if (item.timer) clearTimeout(item.timer);
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
    if (item.timer) clearTimeout(item.timer);
    item.signal?.removeEventListener('abort', item.abortListener);
    startTask(state, settings, item.task).then(item.resolve, item.reject);
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw providerError('TEACHER_RUN_CANCELLED', 'Teacher run cancelled.', 499);
}

function cancellableSleep(delayMs, signal) {
  if (!signal) return sleep(delayMs);
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(providerError('TEACHER_RUN_CANCELLED', 'Teacher run cancelled.', 499));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function createResilienceConfig(options = {}) {
  return {
    maxConcurrency: positiveInt(options.maxConcurrency, undefined, RESOURCE_POLICY_PROVIDER_DEFAULTS.maxConcurrency),
    queueLimit: nonNegativeInt(options.queueLimit, undefined, RESOURCE_POLICY_PROVIDER_DEFAULTS.queueLimit),
    queueTimeoutMs: positiveInt(options.queueTimeoutMs, undefined, RESOURCE_POLICY_PROVIDER_DEFAULTS.queueTimeoutMs),
    maxRetries: nonNegativeInt(options.maxRetries, undefined, RESOURCE_POLICY_PROVIDER_DEFAULTS.maxRetries),
    retryBaseMs: positiveInt(options.retryBaseMs, undefined, RESOURCE_POLICY_PROVIDER_DEFAULTS.retryBaseMs),
    retryMaxMs: positiveInt(options.retryMaxMs, undefined, RESOURCE_POLICY_PROVIDER_DEFAULTS.retryMaxMs),
    retryJitter: options.retryJitter !== undefined ? Boolean(options.retryJitter) : RESOURCE_POLICY_PROVIDER_DEFAULTS.retryJitter,
    circuitFailureThreshold: positiveInt(options.circuitFailureThreshold, undefined, RESOURCE_POLICY_PROVIDER_DEFAULTS.circuitFailureThreshold),
    circuitFailureWindowMs: positiveInt(options.circuitFailureWindowMs, undefined, RESOURCE_POLICY_PROVIDER_DEFAULTS.circuitFailureWindowMs),
    circuitOpenMs: positiveInt(options.circuitOpenMs, undefined, RESOURCE_POLICY_PROVIDER_DEFAULTS.circuitOpenMs),
    halfOpenMaxProbes: positiveInt(options.halfOpenMaxProbes, undefined, RESOURCE_POLICY_PROVIDER_DEFAULTS.halfOpenMaxProbes),
    contextWindowTokens: positiveInt(options.contextWindowTokens, undefined, RESOURCE_POLICY_PROVIDER_DEFAULTS.contextWindowTokens),
    tiers: {
      patch: positiveInt(options.patchTier, process.env.AI_TEACHER_OUTPUT_TIER_PATCH, DEFAULT_TIERS.patch),
      simple: positiveInt(options.simpleTier, process.env.AI_TEACHER_OUTPUT_TIER_SIMPLE, DEFAULT_TIERS.simple),
      medium: positiveInt(options.mediumTier, process.env.AI_TEACHER_OUTPUT_TIER_MEDIUM, DEFAULT_TIERS.medium),
      complex: positiveInt(options.complexTier, process.env.AI_TEACHER_OUTPUT_TIER_COMPLEX, DEFAULT_TIERS.complex),
      longSynthesis: positiveInt(options.longSynthesisTier, process.env.AI_TEACHER_OUTPUT_TIER_LONG_SYNTHESIS, DEFAULT_TIERS.longSynthesis),
      hardMax: positiveInt(options.hardMaxTier, undefined, RESOURCE_POLICY_PROVIDER_DEFAULTS.hardMaxTier || DEFAULT_TIERS.hardMax),
      visibleAnswerMin: positiveInt(options.visibleAnswerMin, process.env.AI_TEACHER_VISIBLE_ANSWER_MIN_TOKENS, DEFAULT_TIERS.visibleAnswerMin)
    }
  };
}

function selectOutputBudget({ context, intent, messages, llm, responseFormat, settings = createResilienceConfig() }) {
  const normalizedIntent = normalizeIntent(intent || context?.question?.intent || '');
  const estimatedInputTokens = estimateMessagesTokens(messages);
  const complexity = classifyComplexity(context, normalizedIntent, responseFormat);
  const tier = tierForComplexity(complexity, normalizedIntent);
  const baseBudget = budgetForTier(tier, settings);
  const reasoningReserve = reasoningReserveForTier(tier, llm);
  const desired = Math.max(baseBudget, settings.tiers.visibleAnswerMin + reasoningReserve);
  const available = Math.max(0, settings.contextWindowTokens - estimatedInputTokens - 256);
  const maxCompletionTokens = Math.min(desired, settings.tiers.hardMax, available);
  return {
    canFit: maxCompletionTokens >= Math.min(settings.tiers.visibleAnswerMin, baseBudget),
    complexity,
    tier,
    estimatedInputTokens,
    maxCompletionTokens
  };
}

function classifyComplexity(context, intent, responseFormat) {
  if (intent === 'single_line_completion' || responseFormat === 'patch') return 'patch';
  if (intent === 'model_diagnostic' || intent === 'single_line_fix') return diagnosticsCount(context) > 2 ? 'complex' : 'medium';
  if (intent === 'explain_diagnostic' || diagnosticsCount(context) > 0) return 'medium';
  const question = String(context?.question?.text || '');
  const lower = question.toLowerCase();
  if (/官方|标准|standard|python|matlab|excel|转换|工具|tool|open[- ]?source|开源|执行|求解|仿真|simulation|analysis|calc|constraint/.test(lower)) {
    return 'standards_tooling';
  }
  if (question.length > 260 || selectedTextLength(context) > 500 || editorContentLength(context) > 10000 || /对比|为什么|如何|是否|证据链|架构/.test(question)) {
    return 'complex';
  }
  if (question.length > 80 || selectedTextLength(context) > 0) return 'medium';
  return 'simple';
}

function tierForComplexity(complexity, intent) {
  if (intent === 'single_line_completion' || complexity === 'patch') return 'patch';
  if (complexity === 'simple') return 'simple';
  if (complexity === 'medium') return 'medium';
  if (complexity === 'standards_tooling') return 'complex';
  if (complexity === 'long_synthesis') return 'long_synthesis';
  return 'complex';
}

function budgetForTier(tier, settings) {
  if (tier === 'patch') return settings.tiers.patch;
  if (tier === 'simple') return settings.tiers.simple;
  if (tier === 'medium') return settings.tiers.medium;
  if (tier === 'long_synthesis') return settings.tiers.longSynthesis;
  return settings.tiers.complex;
}

function reasoningReserveForTier(tier, llm) {
  if (!isReasoningBudgetModel(llm)) return 0;
  if (tier === 'patch') return 256;
  if (tier === 'simple') return 1024;
  if (tier === 'medium') return 2048;
  return 4096;
}

function isReasoningBudgetModel(llm) {
  const model = String(llm?.model || '').toLowerCase();
  return /deepseek|reason|r1|qwq|o1|o3|o4/.test(model);
}

function estimateMessagesTokens(messages) {
  return (messages || []).reduce((sum, message) => sum + estimateTextTokens(message?.content || ''), 0);
}

function estimateTextTokens(text) {
  const value = String(text || '');
  let ascii = 0;
  let nonAscii = 0;
  for (const char of value) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii * 0.8);
}

function diagnosticsCount(context) {
  return (context?.diagnostics?.officialValidator || []).length + (context?.diagnostics?.courseRules || []).length;
}

function selectedTextLength(context) {
  return String(context?.editor?.selection?.text || '').length;
}

function editorContentLength(context) {
  return (context?.editor?.files || []).reduce((sum, file) => sum + String(file.content || '').length, 0);
}

function normalizeProviderError(error) {
  const code = error?.code || 'PROVIDER_ERROR';
  const statusCode = error?.statusCode || error?.status || 503;
  if (code === 'PROVIDER_EMPTY_CONTENT') {
    return providerError('PROVIDER_INVALID_RESPONSE', 'LLM provider response did not include usable message content', 502, {
      internalProviderDiagnostic: emptyContentDiagnostic(error),
      usage: error.usage || null,
      providerTrace: error.providerTrace || null
    });
  }
  return providerError(code, error?.message || 'LLM provider request failed', statusCode, {
    retryAfterMs: error?.retryAfterMs,
    internalProviderDiagnostic: error?.internalProviderDiagnostic,
    providerTrace: error?.providerTrace || null
  });
}

function emptyContentDiagnostic(error) {
  const usage = error?.usage || {};
  const completionTokens = Number(usage.completion_tokens || 0);
  const reasoningTokens = Number(usage.completion_tokens_details?.reasoning_tokens || usage.reasoning_tokens || 0);
  if (completionTokens > 0 && reasoningTokens >= completionTokens * 0.8) return 'OUTPUT_BUDGET_EXHAUSTED';
  return 'PROVIDER_EMPTY_CONTENT';
}

function sanitizeProviderError(error) {
  const sanitized = providerError(error.code || 'PROVIDER_ERROR', error.message || 'LLM provider request failed', error.statusCode || 503);
  sanitized.internalProviderDiagnostic = error.internalProviderDiagnostic;
  sanitized.providerTrace = error.providerTrace || null;
  return sanitized;
}

function isTransientProviderError(error) {
  return [
    'PROVIDER_RATE_LIMITED',
    'PROVIDER_TIMEOUT',
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_OVERLOADED',
    'PROVIDER_ERROR'
  ].includes(error?.code);
}

function recordProviderFailure(state, settings, error) {
  if (!isTransientProviderError(error)) return;
  const now = Date.now();
  state.failures = state.failures.filter((failure) => now - failure.at <= settings.circuitFailureWindowMs);
  state.failures.push({ at: now, code: error.code });
  if (state.failures.length >= settings.circuitFailureThreshold) {
    state.circuitOpenUntil = now + settings.circuitOpenMs;
    state.halfOpenProbes = 0;
  }
}

function isCircuitOpen(state, settings) {
  const now = Date.now();
  if (state.circuitOpenUntil > now) return true;
  if (state.circuitOpenUntil && state.circuitOpenUntil <= now) {
    if (state.halfOpenProbes >= settings.halfOpenMaxProbes) return true;
    state.halfOpenProbes += 1;
    return false;
  }
  return false;
}

function closeCircuitIfNeeded(state) {
  state.failures = [];
  state.circuitOpenUntil = 0;
  state.halfOpenProbes = 0;
}

function retryDelayMs(attempt, settings, retryAfterMs) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(retryAfterMs, settings.retryMaxMs);
  const base = Math.min(settings.retryMaxMs, settings.retryBaseMs * (2 ** attempt));
  if (!settings.retryJitter) return base;
  return Math.max(1, Math.round(base * (0.5 + Math.random() * 0.5)));
}

function providerError(code, message, statusCode, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function positiveInt(optionValue, envValue, fallback) {
  const value = optionValue !== undefined ? optionValue : envValue;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInt(optionValue, envValue, fallback) {
  const value = optionValue !== undefined ? optionValue : envValue;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function normalizeIntent(intent) {
  if (intent === 'free_answer') return 'free_question';
  return String(intent || 'free_question');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  createProviderResilienceGateway,
  createResilienceConfig,
  selectOutputBudget,
  estimateMessagesTokens
};
