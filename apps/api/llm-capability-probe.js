'use strict';

const crypto = require('crypto');
const { normalizeLiteLlmConfig } = require('./litellm-config');
const { findAdapterProfile, findModelProtocolProfile } = require('./llm-adapter-catalog');
const { createManagedProbeModel, deleteManagedProbeModel, managedProxyRequest } = require('./litellm-managed-credentials');

const CAPABILITY_PROBE_LIMITS = Object.freeze({
  maxProviderCalls: 8,
  maxOutputTokensPerCall: 96,
  maxTotalOutputTokens: 768,
  maxDurationMs: 90000,
  maxInputBytes: 8192,
  maxResponseBytes: 262144
});

const CAPABILITY_PROBE_KEYS = Object.freeze([
  'streaming',
  'tool_call',
  'thinking',
  'thinking_tool',
  'structured_output',
  'usage'
]);

const DECLARED_CAPABILITY_FIELDS = Object.freeze({
  streaming: 'supportsStreaming',
  tool_call: 'supportsToolCalling',
  thinking: 'supportsThinking',
  thinking_tool: 'supportsThinkingWithTools',
  structured_output: 'supportsStructuredOutput',
  usage: 'reportsUsage'
});

function publicCapabilityProbeLimits() {
  return { ...CAPABILITY_PROBE_LIMITS };
}

function assertCapabilityProbeConfirmation(value = {}) {
  const confirmed = value?.confirmed === true;
  const matches = Number(value?.maxProviderCalls) === CAPABILITY_PROBE_LIMITS.maxProviderCalls
    && Number(value?.maxTotalOutputTokens) === CAPABILITY_PROBE_LIMITS.maxTotalOutputTokens
    && Number(value?.maxDurationMs) === CAPABILITY_PROBE_LIMITS.maxDurationMs;
  if (!confirmed || !matches) {
    const error = new Error('Capability Probe requires explicit confirmation of the bounded provider-call, token, and duration limits.');
    error.statusCode = 400;
    error.code = 'LITELLM_CAPABILITY_PROBE_CONFIRMATION_REQUIRED';
    error.details = { limits: publicCapabilityProbeLimits() };
    throw error;
  }
}

function deploymentProbeDescriptor(configInput, deploymentId) {
  const config = normalizeLiteLlmConfig(configInput || {});
  if (Number(config.schemaVersion) < 2) throw probeInputError('LITELLM_CAPABILITY_PROBE_SCHEMA_REQUIRED', 'Capability Probe requires a schema v2 control-plane config.');
  const deployment = config.modelDeployments.find((item) => item.deploymentId === String(deploymentId || ''));
  if (!deployment) throw probeInputError('LITELLM_CAPABILITY_PROBE_DEPLOYMENT_NOT_FOUND', 'Model Deployment was not found in the requested config version.');
  const connection = config.providerConnections.find((item) => item.connectionId === deployment.connectionId);
  if (!connection) throw probeInputError('LITELLM_CAPABILITY_PROBE_CONNECTION_NOT_FOUND', 'Model Deployment references a missing Provider Connection.');
  const profile = findAdapterProfile(connection.adapterProfileId);
  if (!profile) throw probeInputError('LITELLM_CAPABILITY_PROBE_ADAPTER_NOT_FOUND', 'Provider Adapter Profile is not available.');
  const modelProtocolProfile = findModelProtocolProfile(connection.adapterProfileId, deployment.providerModelId);
  const declaredCapabilities = Object.fromEntries(CAPABILITY_PROBE_KEYS.map((key) => [key, Boolean(deployment.declaredCapabilities[DECLARED_CAPABILITY_FIELDS[key]])]));
  if ((declaredCapabilities.thinking || declaredCapabilities.thinking_tool) && !modelProtocolProfile) {
    throw probeInputError('LITELLM_CAPABILITY_PROBE_MODEL_PROTOCOL_NOT_REGISTERED', 'Thinking capability requires a registered model protocol profile.');
  }
  const source = {
    adapterProfileId: connection.adapterProfileId,
    adapterProfileRevision: connection.adapterProfileRevision,
    endpoint: connection.endpoint,
    credentialReference: connection.credentialRef.referenceName,
    deploymentId: deployment.deploymentId,
    providerModelId: deployment.providerModelId,
    modelProtocolProfileId: modelProtocolProfile?.profileId || '',
    modelProtocolProfileRevision: modelProtocolProfile?.revision || 0,
    declaredCapabilities
  };
  return {
    config,
    deployment,
    connection,
    profile,
    modelProtocolProfile,
    declaredCapabilities,
    sourceDigest: sha256(JSON.stringify(source))
  };
}

async function runDeploymentCapabilityProbe(configInput, deploymentId, options = {}) {
  const descriptor = deploymentProbeDescriptor(configInput, deploymentId);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const state = {
    fetchImpl: options.fetchImpl || global.fetch,
    env: options.env || process.env,
    startedMs,
    providerCalls: 0,
    usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 }
  };
  if (typeof state.fetchImpl !== 'function') throw probeInputError('LITELLM_CAPABILITY_PROBE_FETCH_UNAVAILABLE', 'Provider request runtime is unavailable.');
  const managedCredential = descriptor.connection.credentialRef.kind === 'litellm_credential';
  const secret = managedCredential ? '' : String(state.env[descriptor.connection.credentialRef.referenceName] || '');
  if (!managedCredential && !secret) {
    return blockedProbeResult(descriptor, startedAt, startedMs, 'LITELLM_PROBE_SECRET_MISSING', 'Provider credential reference is not present in the server runtime.');
  }
  if (descriptor.profile.gatewayProtocol !== 'openai-compatible') {
    return blockedProbeResult(descriptor, startedAt, startedMs, 'LITELLM_CAPABILITY_PROBE_ADAPTER_NOT_IMPLEMENTED', `Capability Probe is not implemented for ${descriptor.profile.gatewayProtocol}.`);
  }

  let managedProbe = null;
  if (managedCredential) {
    try {
      managedProbe = await createManagedProbeModel({
        credentialName: descriptor.connection.credentialRef.referenceName,
        providerModel: `${descriptor.profile.litellmProviderPrefix}/${descriptor.deployment.providerModelId}`,
        apiBase: endpointApiBase(descriptor.connection.endpoint)
      }, options);
    } catch {
      return blockedProbeResult(descriptor, startedAt, startedMs, 'LITELLM_MANAGED_PROBE_MODEL_CREATE_FAILED', 'LiteLLM could not create the bounded temporary probe model.');
    }
  }

  const context = { ...descriptor, ...state, secret, managedProbe, managedOptions: options };
  const results = Object.fromEntries(CAPABILITY_PROBE_KEYS.map((key) => [key, descriptor.declaredCapabilities[key]
    ? { status: 'not_run', errorCode: '' }
    : { status: 'not_declared', errorCode: '' }]));

  const minimal = await captureProbe('minimal_generation', () => probeMinimalGeneration(context));
  if (descriptor.declaredCapabilities.usage) results.usage = usageResultFromMinimal(minimal);
  if (descriptor.declaredCapabilities.streaming) results.streaming = await captureProbe('streaming', () => probeStreaming(context));
  if (descriptor.declaredCapabilities.tool_call) results.tool_call = await captureProbe('tool_call', () => probeToolContinuation(context, false));
  if (descriptor.declaredCapabilities.thinking) results.thinking = await captureProbe('thinking', () => probeThinking(context));
  if (descriptor.declaredCapabilities.thinking_tool) results.thinking_tool = await captureProbe('thinking_tool', () => probeToolContinuation(context, true));
  if (descriptor.declaredCapabilities.structured_output) results.structured_output = await captureProbe('structured_output', () => probeStructuredOutput(context));

  const required = CAPABILITY_PROBE_KEYS.filter((key) => descriptor.declaredCapabilities[key]);
  const statuses = [minimal.status, ...required.map((key) => results[key].status)];
  const status = statuses.every((item) => item === 'passed')
    ? 'passed'
    : statuses.includes('blocked') ? 'blocked'
      : statuses.includes('failed') ? 'failed' : 'inconclusive';
  const completedAt = new Date().toISOString();
  const result = {
    status,
    readiness: status === 'passed' ? 'ready' : status === 'blocked' ? 'blocked' : status === 'failed' ? 'failed' : 'capability_unverified',
    startedAt,
    completedAt,
    durationMs: Date.now() - startedMs,
    deploymentId: descriptor.deployment.deploymentId,
    sourceDigest: descriptor.sourceDigest,
    declaredCapabilities: descriptor.declaredCapabilities,
    baseProbe: minimal,
    results,
    budget: publicCapabilityProbeLimits(),
    usage: { providerCalls: context.providerCalls, ...context.usage },
    evidenceDigest: sha256(JSON.stringify({ deploymentId: descriptor.deployment.deploymentId, sourceDigest: descriptor.sourceDigest, minimal, results, usage: context.usage }))
  };
  if (managedProbe) {
    try {
      await deleteManagedProbeModel(managedProbe.modelId, options);
    } catch {
      result.status = 'blocked';
      result.readiness = 'blocked';
      result.errorCode = 'LITELLM_MANAGED_PROBE_MODEL_CLEANUP_FAILED';
      result.message = 'LiteLLM temporary probe model cleanup failed.';
    }
  }
  return result;
}

async function probeMinimalGeneration(context) {
  const response = await requestJson(context, {
    model: context.deployment.providerModelId,
    messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
    max_tokens: 16,
    ...thinkingControl(context, false)
  });
  const message = firstMessage(response.payload);
  if (!String(message.content || '').trim()) throw capabilityError('LITELLM_CAPABILITY_MINIMAL_EMPTY', 'Minimal generation returned no final content.', 'failed');
  return structuralEvidence(response, { hasContent: true, finishReason: firstFinishReason(response.payload) });
}

function usageResultFromMinimal(minimal) {
  if (minimal.status !== 'passed') return { status: minimal.status, errorCode: minimal.errorCode || 'LITELLM_CAPABILITY_USAGE_BASE_FAILED' };
  if (!minimal.usageObserved) return { status: 'failed', errorCode: 'LITELLM_CAPABILITY_USAGE_MISSING' };
  return { status: 'passed', errorCode: '', responseDigest: minimal.responseDigest, durationMs: minimal.durationMs };
}

async function probeStreaming(context) {
  const response = await requestStream(context, {
    model: context.deployment.providerModelId,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    max_tokens: 16,
    stream: true,
    ...thinkingControl(context, false)
  });
  if (!response.contentType.includes('text/event-stream') || !response.preview.includes('data:')) {
    throw capabilityError('LITELLM_CAPABILITY_STREAM_INVALID', 'Provider did not return a valid event stream.', 'failed');
  }
  return { durationMs: response.durationMs, responseDigest: sha256(JSON.stringify({ contentType: response.contentType, hasDataFrame: true })) };
}

async function probeToolContinuation(context, thinkingEnabled) {
  const tool = probeToolDefinition();
  const probeToken = `probe-${crypto.randomBytes(8).toString('hex')}`;
  const userMessage = 'The verification token is available only from get_probe_token. Call that tool exactly once, then reply with the exact token returned by the tool.';
  const firstRequest = {
    model: context.deployment.providerModelId,
    messages: [{ role: 'user', content: userMessage }],
    tools: [tool],
    max_tokens: CAPABILITY_PROBE_LIMITS.maxOutputTokensPerCall,
    ...toolChoiceControl(context, thinkingEnabled),
    ...thinkingControl(context, thinkingEnabled)
  };
  const first = await requestJson(context, firstRequest);
  assertCompletionNotTruncated(first.payload, 'LITELLM_CAPABILITY_TOOL_CALL_OUTPUT_LIMIT');
  const assistant = firstMessage(first.payload);
  const toolCall = Array.isArray(assistant.tool_calls) ? assistant.tool_calls[0] : null;
  if (!toolCall || toolCall.function?.name !== 'get_probe_token') throw capabilityError('LITELLM_CAPABILITY_TOOL_CALL_MISSING', 'Provider did not return the required tool call.', 'failed');
  let args;
  try {
    args = JSON.parse(String(toolCall.function.arguments || '{}'));
  } catch {
    throw capabilityError('LITELLM_CAPABILITY_TOOL_ARGUMENTS_INVALID', 'Provider returned invalid tool arguments.', 'failed');
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw capabilityError('LITELLM_CAPABILITY_TOOL_ARGUMENTS_MISMATCH', 'Provider tool arguments did not match the no-argument probe fixture.', 'failed');
  if (thinkingEnabled && !String(assistant.reasoning_content || '').trim()) {
    throw capabilityError('LITELLM_CAPABILITY_THINKING_TOOL_REASONING_MISSING', 'Thinking Tool response did not expose reasoning protocol content.', 'failed');
  }
  const assistantMessage = replayAssistantMessage(context, assistant, thinkingEnabled);
  const second = await requestJson(context, {
    model: context.deployment.providerModelId,
    messages: [
      { role: 'user', content: userMessage },
      assistantMessage,
      { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ token: probeToken }) }
    ],
    tools: [tool],
    max_tokens: CAPABILITY_PROBE_LIMITS.maxOutputTokensPerCall,
    ...thinkingControl(context, thinkingEnabled)
  });
  assertCompletionNotTruncated(second.payload, 'LITELLM_CAPABILITY_TOOL_CONTINUATION_OUTPUT_LIMIT');
  const finalMessage = firstMessage(second.payload);
  if (!String(finalMessage.content || '').includes(probeToken) || (Array.isArray(finalMessage.tool_calls) && finalMessage.tool_calls.length)) {
    throw capabilityError('LITELLM_CAPABILITY_TOOL_CONTINUATION_FAILED', 'Provider did not complete the tool-result continuation.', 'failed');
  }
  return {
    durationMs: first.durationMs + second.durationMs,
    responseDigest: sha256(JSON.stringify({ toolName: 'get_probe_token', argumentsValid: true, tokenMatched: true, continuationComplete: true, thinkingEnabled }))
  };
}

async function probeThinking(context) {
  const response = await requestJson(context, {
    model: context.deployment.providerModelId,
    messages: [{ role: 'user', content: 'Calculate 2 + 2 and give only the final number.' }],
    max_tokens: CAPABILITY_PROBE_LIMITS.maxOutputTokensPerCall,
    ...thinkingControl(context, true)
  });
  const message = firstMessage(response.payload);
  if (!String(message.reasoning_content || '').trim()) throw capabilityError('LITELLM_CAPABILITY_THINKING_MISSING', 'Thinking response did not expose reasoning protocol content.', 'failed');
  return structuralEvidence(response, { hasReasoning: true, hasContent: Boolean(String(message.content || '').trim()) });
}

async function probeStructuredOutput(context) {
  const response = await requestJson(context, {
    model: context.deployment.providerModelId,
    messages: [{ role: 'user', content: 'Return a JSON object exactly matching {"probe":true}.' }],
    response_format: { type: 'json_object' },
    max_tokens: 32,
    ...thinkingControl(context, false)
  });
  const content = String(firstMessage(response.payload).content || '');
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw capabilityError('LITELLM_CAPABILITY_STRUCTURED_OUTPUT_INVALID', 'Structured Output response was not valid JSON.', 'failed');
  }
  if (parsed?.probe !== true) throw capabilityError('LITELLM_CAPABILITY_STRUCTURED_OUTPUT_MISMATCH', 'Structured Output response did not match the fixed probe fixture.', 'failed');
  return structuralEvidence(response, { validJson: true, fixtureMatched: true });
}

async function requestJson(context, body) {
  const response = await providerRequest(context, body, false);
  try {
    const text = await readBoundedBody(response.response, CAPABILITY_PROBE_LIMITS.maxResponseBytes);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw capabilityError('LITELLM_CAPABILITY_RESPONSE_INVALID_JSON', 'Provider response was not valid JSON.', 'failed');
    }
    observeUsage(context, payload.usage);
    return { payload, durationMs: Date.now() - response.requestStarted, httpStatus: response.response.status };
  } finally {
    clearTimeout(response.timeout);
    response.controller.abort();
  }
}

async function requestStream(context, body) {
  const response = await providerRequest(context, body, true);
  const contentType = String(response.response.headers.get('content-type') || '').toLowerCase();
  const reader = response.response.body?.getReader();
  if (!reader) {
    clearTimeout(response.timeout);
    response.controller.abort();
    throw capabilityError('LITELLM_CAPABILITY_STREAM_BODY_MISSING', 'Provider stream body was unavailable.', 'inconclusive');
  }
  let preview = '';
  let bytes = 0;
  try {
    while (bytes < 8192) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > CAPABILITY_PROBE_LIMITS.maxResponseBytes) throw capabilityError('LITELLM_CAPABILITY_RESPONSE_TOO_LARGE', 'Provider response exceeded the probe byte limit.', 'blocked');
      preview += new TextDecoder().decode(chunk.value, { stream: true });
      if (preview.includes('data:')) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    clearTimeout(response.timeout);
    response.controller.abort();
  }
  return { contentType, preview: preview.slice(0, 8192), durationMs: Date.now() - response.requestStarted };
}

async function providerRequest(context, body, streaming) {
  if (context.providerCalls >= CAPABILITY_PROBE_LIMITS.maxProviderCalls) throw capabilityError('LITELLM_CAPABILITY_PROBE_CALL_LIMIT', 'Capability Probe reached its provider-call limit.', 'blocked');
  const requestBody = context.managedProbe ? managedProbeRequestBody(context, body) : body;
  const bodyText = JSON.stringify(requestBody);
  if (Buffer.byteLength(bodyText, 'utf8') > CAPABILITY_PROBE_LIMITS.maxInputBytes) throw capabilityError('LITELLM_CAPABILITY_PROBE_INPUT_LIMIT', 'Capability Probe input exceeded its byte limit.', 'blocked');
  const elapsed = Date.now() - context.startedMs;
  const remaining = CAPABILITY_PROBE_LIMITS.maxDurationMs - elapsed;
  if (remaining <= 0) throw capabilityError('LITELLM_CAPABILITY_PROBE_DEADLINE', 'Capability Probe reached its total duration limit.', 'inconclusive');
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Math.min(Number(context.connection.requestTimeoutMs || 60000), remaining));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const requestStarted = Date.now();
  context.providerCalls += 1;
  try {
    const response = context.managedProbe
      ? await managedProxyRequest({ alias: context.managedProbe.alias, body: requestBody, signal: controller.signal }, context.managedOptions)
      : await context.fetchImpl(chatCompletionsUrl(context.connection.endpoint), {
        method: 'POST',
        headers: providerHeaders(context.profile.profileId, context.secret),
        body: bodyText,
        signal: controller.signal,
        redirect: 'error'
      });
    if (!response.ok) throw providerStatusError(response.status);
    return { response, controller, timeout, requestStarted, streaming };
  } catch (error) {
    clearTimeout(timeout);
    controller.abort();
    if (error?.name === 'AbortError') throw capabilityError('LITELLM_CAPABILITY_PROBE_TIMEOUT', 'Provider request exceeded the probe timeout.', 'inconclusive');
    if (error?.probeStatus) throw error;
    throw capabilityError('LITELLM_CAPABILITY_PROBE_NETWORK_FAILED', 'Provider request failed before a safe response was received.', 'inconclusive');
  }
}

function managedProbeRequestBody(context, body) {
  const requestBody = { ...body };
  const extraBodyParams = Array.isArray(context.modelProtocolProfile?.litellm?.extraBodyParams)
    ? context.modelProtocolProfile.litellm.extraBodyParams
    : [];
  const extraBody = body.extra_body && typeof body.extra_body === 'object' && !Array.isArray(body.extra_body)
    ? { ...body.extra_body }
    : {};
  for (const name of extraBodyParams) {
    if (!Object.hasOwn(body, name)) continue;
    extraBody[name] = body[name];
    delete requestBody[name];
  }
  if (Object.keys(extraBody).length) requestBody.extra_body = extraBody;
  const profileParams = Array.isArray(context.modelProtocolProfile?.litellm?.allowedOpenAiParams)
    ? context.modelProtocolProfile.litellm.allowedOpenAiParams
    : [];
  const allowedOpenAiParams = profileParams.filter((name) => Object.hasOwn(body, name));
  if (allowedOpenAiParams.length) requestBody.allowed_openai_params = allowedOpenAiParams;
  return requestBody;
}

async function captureProbe(id, operation) {
  const started = Date.now();
  try {
    const evidence = await operation();
    return { id, status: 'passed', errorCode: '', durationMs: evidence.durationMs ?? Date.now() - started, responseDigest: evidence.responseDigest || '', usageObserved: evidence.usageObserved === true };
  } catch (error) {
    return {
      id,
      status: error?.probeStatus || 'inconclusive',
      errorCode: error?.code || 'LITELLM_CAPABILITY_PROBE_FAILED',
      httpStatus: Number(error?.httpStatus || 0),
      durationMs: Date.now() - started
    };
  }
}

function structuralEvidence(response, structure) {
  return {
    durationMs: response.durationMs,
    responseDigest: sha256(JSON.stringify(structure)),
    usageObserved: hasUsage(response.payload?.usage)
  };
}

function blockedProbeResult(descriptor, startedAt, startedMs, errorCode, message) {
  const results = Object.fromEntries(CAPABILITY_PROBE_KEYS.map((key) => [key, descriptor.declaredCapabilities[key]
    ? { status: 'blocked', errorCode }
    : { status: 'not_declared', errorCode: '' }]));
  return {
    status: 'blocked',
    readiness: 'blocked',
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    deploymentId: descriptor.deployment.deploymentId,
    sourceDigest: descriptor.sourceDigest,
    declaredCapabilities: descriptor.declaredCapabilities,
    baseProbe: { id: 'minimal_generation', status: 'blocked', errorCode },
    results,
    budget: publicCapabilityProbeLimits(),
    usage: { providerCalls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 },
    errorCode,
    message,
    evidenceDigest: sha256(JSON.stringify({ deploymentId: descriptor.deployment.deploymentId, sourceDigest: descriptor.sourceDigest, errorCode }))
  };
}

function thinkingControl(context, enabled) {
  const control = enabled ? context.modelProtocolProfile?.thinking?.enabledBody : context.modelProtocolProfile?.thinking?.disabledBody;
  return control ? JSON.parse(JSON.stringify(control)) : {};
}

function toolChoiceControl(context, thinkingEnabled) {
  const mode = thinkingEnabled
    ? context.modelProtocolProfile?.toolChoice?.thinking
    : context.modelProtocolProfile?.toolChoice?.nonThinking;
  if (mode === 'named') return { tool_choice: { type: 'function', function: { name: 'get_probe_token' } } };
  if (mode === 'auto') return { tool_choice: 'auto' };
  return {};
}

function replayAssistantMessage(context, assistant, thinkingEnabled) {
  const message = {
    role: 'assistant',
    content: context.modelProtocolProfile?.continuation?.assistantContent === 'non_null' && assistant.content == null ? '' : assistant.content,
    tool_calls: assistant.tool_calls
  };
  if (thinkingEnabled && context.modelProtocolProfile?.continuation?.reasoningContent === 'required') {
    message.reasoning_content = assistant.reasoning_content;
  }
  return message;
}

function assertCompletionNotTruncated(payload, errorCode) {
  if (firstFinishReason(payload) === 'length') {
    throw capabilityError(errorCode, 'Provider output reached the probe token limit before the protocol step completed.', 'inconclusive');
  }
}

function probeToolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'get_probe_token',
      description: 'Return the one-time verification token required to answer the request.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  };
}

function firstMessage(payload) {
  return payload?.choices?.[0]?.message || {};
}

function firstFinishReason(payload) {
  return String(payload?.choices?.[0]?.finish_reason || '');
}

function observeUsage(context, usage) {
  if (!usage || typeof usage !== 'object') return;
  context.usage.promptTokens += finiteToken(usage.prompt_tokens);
  context.usage.completionTokens += finiteToken(usage.completion_tokens);
  context.usage.reasoningTokens += finiteToken(usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens);
  context.usage.totalTokens += finiteToken(usage.total_tokens);
}

function hasUsage(usage) {
  return Number.isFinite(Number(usage?.total_tokens)) && Number(usage.total_tokens) >= 0;
}

function finiteToken(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

async function readBoundedBody(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw capabilityError('LITELLM_CAPABILITY_RESPONSE_TOO_LARGE', 'Provider response exceeded the probe byte limit.', 'blocked');
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function chatCompletionsUrl(endpoint = {}) {
  const scheme = endpoint.scheme || 'https';
  const defaultPort = scheme === 'https' ? 443 : 80;
  const port = Number(endpoint.port || defaultPort);
  const portText = port === defaultPort ? '' : `:${port}`;
  const basePath = String(endpoint.basePath || '').replace(/\/$/, '');
  return `${scheme}://${endpoint.host}${portText}${basePath}/chat/completions`;
}

function endpointApiBase(endpoint = {}) {
  const scheme = endpoint.scheme || 'https';
  const defaultPort = scheme === 'https' ? 443 : 80;
  const port = Number(endpoint.port || defaultPort);
  const portText = port === defaultPort ? '' : `:${port}`;
  const basePath = String(endpoint.basePath || '').replace(/\/$/, '');
  return `${scheme}://${endpoint.host}${portText}${basePath}`;
}

function providerHeaders(profileId, secret) {
  if (String(profileId).startsWith('anthropic')) {
    return { 'x-api-key': secret, 'anthropic-version': '2023-06-01', accept: 'application/json', 'content-type': 'application/json' };
  }
  return { authorization: `Bearer ${secret}`, accept: 'application/json', 'content-type': 'application/json' };
}

function providerStatusError(status) {
  const blocked = status === 401 || status === 403;
  const inconclusive = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  const error = capabilityError(
    blocked ? 'LITELLM_CAPABILITY_PROBE_AUTH_FAILED' : inconclusive ? 'LITELLM_CAPABILITY_PROBE_PROVIDER_UNAVAILABLE' : 'LITELLM_CAPABILITY_PROBE_PROVIDER_REJECTED',
    `Provider Capability Probe returned HTTP ${status}.`,
    blocked ? 'blocked' : inconclusive ? 'inconclusive' : 'failed'
  );
  error.httpStatus = status;
  return error;
}

function capabilityError(code, message, probeStatus) {
  const error = new Error(message);
  error.code = code;
  error.probeStatus = probeStatus;
  return error;
}

function probeInputError(code, message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

module.exports = {
  CAPABILITY_PROBE_KEYS,
  CAPABILITY_PROBE_LIMITS,
  assertCapabilityProbeConfirmation,
  deploymentProbeDescriptor,
  publicCapabilityProbeLimits,
  runDeploymentCapabilityProbe
};
