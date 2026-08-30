'use strict';

const crypto = require('crypto');
const { normalizeLiteLlmConfig } = require('./litellm-config');
const { legacyAliasId } = require('./ai-teacher-model-registry');
const { ADAPTER_PROFILE_CATALOG, findAdapterProfile, publicAdapterProfileCatalog } = require('./llm-adapter-catalog');
const { testManagedCredentialConnection } = require('./litellm-managed-credentials');
const {
  BOOTSTRAP_VALUES: AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES,
  runtimeProjection: agentResourcePolicyRuntimeProjection
} = require('../../packages/agent-resource-policy');

const DEFAULT_PROVIDER_PROBE_TIMEOUT_MS = agentResourcePolicyRuntimeProjection(
  AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES
).probe.timeoutMs;

function assignServerControlPlaneIds(config = {}, baselineConfig = null) {
  if (Number(config.schemaVersion) < 2) return config;
  const hasBaseline = Boolean(baselineConfig);
  const baselineHasStableIds = Boolean(baselineConfig && Number(baselineConfig.schemaVersion) >= 2);
  const baselineConnectionIds = new Set((baselineConfig?.providerConnections || []).map((item) => String(item.connectionId || '')));
  const baselineDeploymentIds = new Set((baselineConfig?.modelDeployments || []).map((item) => String(item.deploymentId || '')));
  const baselineAliasEntries = baselineHasStableIds
    ? (baselineConfig?.businessModelAliases || [])
    : (baselineConfig?.modelGroups || []).map((group) => ({
      aliasId: legacyAliasId(group.modelName),
      litellmAlias: group.modelName
    }));
  const baselineAliasIds = new Set(baselineAliasEntries.map((item) => String(item.aliasId || '')));
  const baselineAliasByRuntimeName = new Map(
    baselineAliasEntries.map((item) => [String(item.litellmAlias || ''), item])
  );
  const connectionMap = new Map();
  const deploymentMap = new Map();
  const providerConnections = (config.providerConnections || []).map((connection) => {
    const previous = String(connection.connectionId || '');
    const connectionId = serverOwnedObjectId(previous, 'connection', baselineConnectionIds, hasBaseline);
    connectionMap.set(previous, connectionId);
    return { ...connection, connectionId };
  });
  const modelDeployments = (config.modelDeployments || []).map((deployment) => {
    const previous = String(deployment.deploymentId || '');
    const deploymentId = serverOwnedObjectId(previous, 'deployment', baselineDeploymentIds, hasBaseline);
    deploymentMap.set(previous, deploymentId);
    return {
      ...deployment,
      deploymentId,
      connectionId: connectionMap.get(String(deployment.connectionId || '')) || deployment.connectionId
    };
  });
  const businessModelAliases = (config.businessModelAliases || []).map((alias) => {
    const previous = String(alias.aliasId || '');
    const runtimeName = String(alias.litellmAlias || '');
    const baselineAlias = baselineAliasByRuntimeName.get(runtimeName);
    if (baselineHasStableIds && baselineAlias && previous !== String(baselineAlias.aliasId || '')) {
      const error = new Error('Business Model Alias ID is immutable after creation.');
      error.statusCode = 409;
      error.code = 'LITELLM_ALIAS_ID_IMMUTABLE';
      throw error;
    }
    return {
      ...alias,
      aliasId: baselineAlias
        ? String(baselineAlias.aliasId || '')
        : serverOwnedObjectId(previous, 'alias', baselineAliasIds, hasBaseline),
      members: (alias.members || []).map((member) => ({
        ...member,
        deploymentId: deploymentMap.get(String(member.deploymentId || '')) || member.deploymentId
      }))
    };
  });
  return { ...config, providerConnections, modelDeployments, businessModelAliases };
}

function serverOwnedObjectId(requestedId, prefix, baselineIds, hasBaseline) {
  const requested = String(requestedId || '').trim();
  if (!requested.startsWith('draft-') && (!hasBaseline || baselineIds.has(requested))) return requested;
  return `${prefix}_${crypto.randomUUID()}`;
}

async function probeProviderConnection(connection = {}, options = {}) {
  const normalized = normalizeProbeConnection(connection);
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const checks = [{ id: 'endpoint_policy', label: 'Endpoint 与网络策略', status: 'passed' }];
  const secretName = normalized.credentialRef.referenceName;
  if (normalized.credentialRef.kind === 'litellm_credential') {
    return probeManagedCredentialConnection(normalized, String(options.providerModelId || ''), checkedAt, startedAt, checks, options);
  }
  const secret = process.env[secretName] || '';
  if (!secret) {
    checks.push({ id: 'secret_reference', label: 'Secret 引用就绪', status: 'blocked' });
    return {
      status: 'blocked',
      checkedAt,
      durationMs: Date.now() - startedAt,
      checks,
      errorCode: 'LITELLM_PROBE_SECRET_MISSING',
      message: `Credential reference ${secretName} is not present in the server runtime.`
    };
  }
  checks.push({ id: 'secret_reference', label: 'Secret 引用就绪', status: 'passed' });

  const controller = new AbortController();
  const timeoutMs = positiveProbeTimeout(options.timeoutMs, DEFAULT_PROVIDER_PROBE_TIMEOUT_MS);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const requestStartedAt = Date.now();
  try {
    const response = await fetch(providerModelsUrl(normalized.endpoint), {
      method: 'GET',
      headers: probeHeaders(normalized.adapterProfileId, secret),
      signal: controller.signal,
      redirect: 'error'
    });
    const durationMs = Date.now() - startedAt;
    const requestDurationMs = Date.now() - requestStartedAt;
    if (!response.ok) {
      checks.push({ id: 'provider_models', label: 'Provider 最小只读探测', status: 'failed', durationMs: requestDurationMs });
      return {
        status: 'failed',
        checkedAt,
        durationMs,
        httpStatus: response.status,
        checks,
        errorCode: response.status === 401 || response.status === 403 ? 'LITELLM_PROBE_AUTH_FAILED' : 'LITELLM_PROBE_PROVIDER_REJECTED',
        message: `Provider probe returned HTTP ${response.status}.`
      };
    }
    checks.push({ id: 'provider_models', label: 'Provider 最小只读探测', status: 'passed', durationMs: requestDurationMs });
    return { status: 'passed', checkedAt, durationMs, httpStatus: response.status, checks };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    checks.push({ id: 'provider_models', label: 'Provider 最小只读探测', status: 'failed', durationMs: Date.now() - requestStartedAt });
    return {
      status: 'failed',
      checkedAt,
      durationMs: Date.now() - startedAt,
      checks,
      errorCode: aborted ? 'LITELLM_PROBE_TIMEOUT' : 'LITELLM_PROBE_NETWORK_FAILED',
      message: aborted ? `Provider probe exceeded ${timeoutMs} ms.` : 'Provider probe failed before receiving a safe response.'
    };
  } finally {
    clearTimeout(timeout);
  }
}

function positiveProbeTimeout(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number <= 0) throw new RangeError('Provider probe timeout must come from the active resource policy.');
  return number;
}

async function probeManagedCredentialConnection(connection, providerModelId, checkedAt, startedAt, checks, options) {
  if (!providerModelId) {
    checks.push({ id: 'provider_model', label: '真实模型 ID', status: 'blocked' });
    return {
      status: 'blocked',
      checkedAt,
      durationMs: Date.now() - startedAt,
      checks,
      errorCode: 'LITELLM_PROBE_MODEL_REQUIRED',
      message: 'A dependent deployment model ID is required to test a managed credential.'
    };
  }
  const profile = findAdapterProfile(connection.adapterProfileId);
  const providerModel = `${profile?.litellmProviderPrefix || 'openai'}/${providerModelId}`;
  try {
    const result = await testManagedCredentialConnection({
      credentialName: connection.credentialRef.referenceName,
      model: providerModel,
      apiBase: endpointApiBase(connection.endpoint)
    }, options);
    checks.push({ id: 'managed_credential', label: 'LiteLLM 托管凭据', status: result.status === 'passed' ? 'passed' : 'failed' });
    return { status: result.status, checkedAt, durationMs: Date.now() - startedAt, checks };
  } catch (error) {
    checks.push({ id: 'managed_credential', label: 'LiteLLM 托管凭据', status: 'failed' });
    return {
      status: 'failed',
      checkedAt,
      durationMs: Date.now() - startedAt,
      checks,
      errorCode: error?.code || 'LITELLM_PROBE_MANAGED_CREDENTIAL_FAILED',
      message: 'LiteLLM managed credential probe failed.'
    };
  }
}

function normalizeProbeConnection(connection) {
  const config = normalizeLiteLlmConfig({
    schemaVersion: 2,
    // Connection lifecycle state controls publication, not whether an
    // administrator may verify the connection before enabling it.
    providerConnections: [{ ...connection, enabled: true }],
    modelDeployments: [{
      deploymentId: 'probe-deployment',
      connectionId: connection.connectionId || 'probe-connection',
      displayName: 'Probe Deployment',
      providerModelId: 'probe-model',
      enabled: true,
      limits: {},
      declaredCapabilities: {}
    }],
    businessModelAliases: [{
      aliasId: 'probe-alias',
      litellmAlias: 'probe-alias',
      displayName: 'Probe Alias',
      enabled: true,
      members: [{ deploymentId: 'probe-deployment', priority: 1, weight: 100 }],
      routing: {}
    }],
    general: { masterKeyEnv: 'LITELLM_MASTER_KEY', databaseUrlEnv: 'LITELLM_DATABASE_URL' }
  });
  return config.providerConnections[0];
}

function providerModelsUrl(endpoint = {}) {
  const scheme = endpoint.scheme || 'https';
  const defaultPort = scheme === 'https' ? 443 : 80;
  const port = Number(endpoint.port || defaultPort);
  const portText = port === defaultPort ? '' : `:${port}`;
  const basePath = String(endpoint.basePath || '').replace(/\/$/, '');
  return `${scheme}://${endpoint.host}${portText}${basePath}/models`;
}

function endpointApiBase(endpoint = {}) {
  const scheme = endpoint.scheme || 'https';
  const defaultPort = scheme === 'https' ? 443 : 80;
  const port = Number(endpoint.port || defaultPort);
  const portText = port === defaultPort ? '' : `:${port}`;
  const basePath = String(endpoint.basePath || '').replace(/\/$/, '');
  return `${scheme}://${endpoint.host}${portText}${basePath}`;
}

function probeHeaders(profileId, secret) {
  if (String(profileId).startsWith('anthropic')) {
    return { 'x-api-key': secret, 'anthropic-version': '2023-06-01', accept: 'application/json' };
  }
  return { authorization: `Bearer ${secret}`, accept: 'application/json' };
}

module.exports = {
  ADAPTER_PROFILE_CATALOG,
  assignServerControlPlaneIds,
  publicAdapterProfileCatalog,
  probeProviderConnection
};
