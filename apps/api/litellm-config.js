'use strict';

const { findAdapterProfile } = require('./llm-adapter-catalog');

const crypto = require('crypto');

const DEFAULT_LITELLM_CONFIG_VERSION_ID = 'default-litellm-config-v1';

function defaultLiteLlmConfig() {
  return normalizeLiteLlmConfig({
    schemaVersion: 1,
    modelGroups: [
      {
        modelName: 'ai-teacher-reasoning',
        deployments: [{
          deploymentId: 'deepseek-reasoning-primary',
          enabled: true,
          provider: 'deepseek',
          model: 'deepseek/deepseek-v4-pro',
          apiBaseEnv: 'DEEPSEEK_API_BASE',
          apiKeyEnv: 'DEEPSEEK_API_KEY_1',
          rpm: 60,
          tpm: 120000
        }],
        router: {
          routingStrategy: 'simple-shuffle',
          numRetries: 1,
          allowedFails: 5,
          cooldownTime: 30
        },
        fallbacks: []
      },
      {
        modelName: 'ai-teacher-fast',
        deployments: [{
          deploymentId: 'deepseek-fast-primary',
          enabled: true,
          provider: 'deepseek',
          model: 'deepseek/deepseek-v4-flash',
          apiBaseEnv: 'DEEPSEEK_API_BASE',
          apiKeyEnv: 'DEEPSEEK_API_KEY_1',
          rpm: 120,
          tpm: 180000
        }],
        router: {
          routingStrategy: 'simple-shuffle',
          numRetries: 1,
          allowedFails: 5,
          cooldownTime: 30
        },
        fallbacks: []
      }
    ],
    general: {
      masterKeyEnv: 'LITELLM_MASTER_KEY',
      databaseUrlEnv: 'LITELLM_DATABASE_URL'
    }
  });
}

function normalizeLiteLlmConfig(input = {}) {
  const config = input && typeof input === 'object' ? input : {};
  assertNoRawSecrets(config);
  if (Number(config.schemaVersion) >= 2 || hasControlPlaneShape(config)) {
    return normalizeControlPlaneConfig(config);
  }
  const modelGroups = Array.isArray(config.modelGroups) ? config.modelGroups : [];
  if (!modelGroups.length) throw validationError('LITELLM_CONFIG_MODEL_GROUPS_REQUIRED', 'LiteLLM config requires at least one model group.');
  const normalizedGroups = modelGroups.map(normalizeModelGroup);
  const general = normalizeGeneralSettings(config.general || {});
  return {
    schemaVersion: positiveInteger(config.schemaVersion, 1),
    modelGroups: normalizedGroups,
    general
  };
}

function validateLiteLlmConfig(input = {}) {
  const errors = [];
  try {
    const config = normalizeLiteLlmConfig(input);
    const yaml = renderLiteLlmConfigYaml(config);
    return {
      ok: true,
      errors,
      checksum: checksumText(yaml),
      deploymentCount: config.modelGroups.reduce((sum, group) => sum + group.deployments.filter((deployment) => deployment.enabled).length, 0),
      modelGroups: config.modelGroups.map((group) => group.modelName)
    };
  } catch (error) {
    errors.push(error.code || error.message || String(error));
    return { ok: false, errors };
  }
}

function renderLiteLlmConfigYaml(input = {}) {
  const config = normalizeLiteLlmConfig(input);
  const lines = ['model_list:'];
  for (const group of config.modelGroups) {
    for (const deployment of group.deployments.filter((item) => item.enabled)) {
      lines.push('  - model_name: ' + yamlScalar(group.modelName));
      lines.push('    litellm_params:');
      lines.push('      model: ' + yamlScalar(deployment.model));
      if (deployment.apiBase) lines.push('      api_base: ' + yamlScalar(deployment.apiBase));
      else if (deployment.apiBaseEnv) lines.push('      api_base: os.environ/' + deployment.apiBaseEnv);
      if (deployment.litellmCredentialName) {
        lines.push('      litellm_credential_name: ' + yamlScalar(deployment.litellmCredentialName));
      } else {
        lines.push('      api_key: os.environ/' + deployment.apiKeyEnv);
      }
      if (deployment.rpm > 0) lines.push('      rpm: ' + deployment.rpm);
      if (deployment.tpm > 0) lines.push('      tpm: ' + deployment.tpm);
      if (deployment.maxParallelRequests > 0) lines.push('      max_parallel_requests: ' + deployment.maxParallelRequests);
    }
  }
  lines.push('');
  lines.push('router_settings:');
  const router = mergeRouterSettings(config.modelGroups);
  lines.push('  routing_strategy: ' + yamlScalar(router.routingStrategy));
  lines.push('  num_retries: ' + router.numRetries);
  lines.push('  allowed_fails: ' + router.allowedFails);
  lines.push('  cooldown_time: ' + router.cooldownTime);
  const fallbacks = config.modelGroups.flatMap((group) => group.fallbacks.map((fallback) => ({ [group.modelName]: fallback.targets })));
  if (fallbacks.length) {
    lines.push('  fallbacks:');
    for (const fallback of fallbacks) {
      const [source, targets] = Object.entries(fallback)[0];
      lines.push('    - ' + yamlScalar(source) + ': [' + targets.map(yamlScalar).join(', ') + ']');
    }
  }
  lines.push('');
  lines.push('general_settings:');
  lines.push('  master_key: os.environ/' + config.general.masterKeyEnv);
  lines.push('  database_url: os.environ/' + config.general.databaseUrlEnv);
  return lines.join('\n') + '\n';
}

function createLiteLlmConfigVersionDraft({ config, createdBy = '', notes = '', status = 'draft' } = {}) {
  const normalized = normalizeLiteLlmConfig(config || defaultLiteLlmConfig());
  const renderedYaml = renderLiteLlmConfigYaml(normalized);
  const validation = validateLiteLlmConfig(normalized);
  const versionId = `litellm_cfg_${crypto.randomUUID()}`;
  return {
    versionId,
    status,
    config: normalized,
    renderedYaml,
    checksum: checksumText(renderedYaml),
    validation,
    createdBy,
    publishedBy: '',
    notes,
    createdAt: new Date().toISOString(),
    publishedAt: null
  };
}

function publicLiteLlmConfigVersion(row = {}, options = {}) {
  const config = row.config || row.config_json || {};
  const normalized = normalizeLiteLlmConfig(config);
  const publicConfig = {
    ...normalized,
    modelGroups: normalized.modelGroups.map((group) => ({
      ...group,
      deployments: group.deployments.map((deployment) => ({
        deploymentId: deployment.deploymentId,
        enabled: deployment.enabled,
        provider: deployment.provider,
        model: deployment.model,
        apiBase: deployment.apiBase,
        apiBaseEnv: deployment.apiBaseEnv,
        apiKeyRef: deployment.apiKeyEnv,
        litellmCredentialName: deployment.litellmCredentialName,
        rpm: deployment.rpm,
        tpm: deployment.tpm,
        maxParallelRequests: deployment.maxParallelRequests
      }))
    }))
  };
  const result = {
    versionId: row.versionId || row.version_id || '',
    status: row.status || 'draft',
    checksum: row.checksum || '',
    config: publicConfig,
    validation: row.validation || row.validation_json || validateLiteLlmConfig(normalized),
    createdBy: row.createdBy || row.created_by || '',
    publishedBy: row.publishedBy || row.published_by || '',
    notes: row.notes || '',
    createdAt: isoString(row.createdAt || row.created_at),
    publishedAt: isoString(row.publishedAt || row.published_at)
  };
  if (options.includeRenderedYaml) result.renderedYaml = row.renderedYaml || row.rendered_yaml || renderLiteLlmConfigYaml(normalized);
  return result;
}

function normalizeModelGroup(group = {}, index = 0) {
  const modelName = requiredString(group.modelName || group.model_name, `modelGroups[${index}].modelName`);
  const deployments = Array.isArray(group.deployments) ? group.deployments.map((deployment, deploymentIndex) => normalizeDeployment(deployment, index, deploymentIndex)) : [];
  if (!deployments.some((deployment) => deployment.enabled)) {
    throw validationError('LITELLM_CONFIG_NO_ENABLED_DEPLOYMENT', `Model group ${modelName} requires at least one enabled deployment.`);
  }
  const fallbackTargets = Array.isArray(group.fallbacks) ? group.fallbacks.map(normalizeFallback).filter((item) => item.targets.length) : [];
  return {
    modelName,
    deployments,
    router: normalizeRouter(group.router || {}),
    fallbacks: fallbackTargets
  };
}

function normalizeDeployment(deployment = {}, groupIndex = 0, deploymentIndex = 0) {
  assertNoRawSecrets(deployment);
  const prefix = `modelGroups[${groupIndex}].deployments[${deploymentIndex}]`;
  const enabled = deployment.enabled !== false;
  const apiKeyEnv = optionalEnvName(deployment.apiKeyEnv || deployment.api_key_env || deployment.secretRef || deployment.apiKeyRef);
  const litellmCredentialName = optionalCredentialName(deployment.litellmCredentialName || deployment.litellm_credential_name);
  if (!apiKeyEnv && !litellmCredentialName) {
    throw validationError('LITELLM_CONFIG_CREDENTIAL_REQUIRED', `${prefix} requires an environment or LiteLLM managed credential reference.`);
  }
  if (apiKeyEnv && litellmCredentialName) {
    throw validationError('LITELLM_CONFIG_CREDENTIAL_AMBIGUOUS', `${prefix} must use exactly one credential reference kind.`);
  }
  return {
    deploymentId: String(deployment.deploymentId || deployment.deployment_id || `${groupIndex}-${deploymentIndex}`).trim(),
    enabled,
    provider: String(deployment.provider || 'openai-compatible').trim(),
    model: requiredString(deployment.model, `${prefix}.model`),
    apiBase: optionalApiBase(deployment.apiBase || deployment.api_base || ''),
    apiBaseEnv: optionalEnvName(deployment.apiBaseEnv || deployment.api_base_env || ''),
    apiKeyEnv,
    litellmCredentialName,
    rpm: nonNegativeInteger(deployment.rpm, 0),
    tpm: nonNegativeInteger(deployment.tpm, 0),
    maxParallelRequests: nonNegativeInteger(deployment.maxParallelRequests || deployment.max_parallel_requests, 0)
  };
}

function hasControlPlaneShape(config = {}) {
  return Array.isArray(config.providerConnections)
    || Array.isArray(config.modelDeployments)
    || Array.isArray(config.businessModelAliases);
}

function normalizeControlPlaneConfig(config = {}) {
  const providerConnections = Array.isArray(config.providerConnections)
    ? config.providerConnections.map(normalizeProviderConnection)
    : [];
  const modelDeployments = Array.isArray(config.modelDeployments)
    ? config.modelDeployments.map(normalizeControlPlaneDeployment)
    : [];
  const businessModelAliases = Array.isArray(config.businessModelAliases)
    ? config.businessModelAliases.map(normalizeBusinessModelAlias)
    : [];
  if (!providerConnections.length) throw validationError('LITELLM_CONNECTIONS_REQUIRED', 'At least one Provider Connection is required.');
  if (!modelDeployments.length) throw validationError('LITELLM_DEPLOYMENTS_REQUIRED', 'At least one Model Deployment is required.');
  if (!businessModelAliases.length) throw validationError('LITELLM_ALIASES_REQUIRED', 'At least one Business Model Alias is required.');

  const connectionsById = new Map(providerConnections.map((item) => [item.connectionId, item]));
  const connectionIds = new Set(connectionsById.keys());
  const deploymentIds = new Set(modelDeployments.map((item) => item.deploymentId));
  assertUniqueIds(providerConnections, 'connectionId', 'LITELLM_CONNECTION_ID_DUPLICATE');
  assertUniqueIds(modelDeployments, 'deploymentId', 'LITELLM_DEPLOYMENT_ID_DUPLICATE');
  assertUniqueIds(businessModelAliases, 'aliasId', 'LITELLM_ALIAS_ID_DUPLICATE');
  for (const deployment of modelDeployments) {
    if (!connectionIds.has(deployment.connectionId)) {
      throw validationError('LITELLM_DEPLOYMENT_CONNECTION_MISSING', `Deployment ${deployment.deploymentId} references missing connection ${deployment.connectionId}.`);
    }
    validateDeclaredCapabilities(deployment, connectionsById.get(deployment.connectionId));
  }
  for (const alias of businessModelAliases) {
    if (!alias.members.length) throw validationError('LITELLM_ALIAS_MEMBERS_REQUIRED', `Alias ${alias.aliasId} requires at least one deployment member.`);
    for (const member of alias.members) {
      if (!deploymentIds.has(member.deploymentId)) {
        throw validationError('LITELLM_ALIAS_DEPLOYMENT_MISSING', `Alias ${alias.aliasId} references missing deployment ${member.deploymentId}.`);
      }
    }
  }

  const normalized = {
    schemaVersion: 2,
    providerConnections,
    modelDeployments,
    businessModelAliases,
    general: normalizeGeneralSettings(config.general || {})
  };
  return {
    ...normalized,
    modelGroups: projectControlPlaneToModelGroups(normalized)
  };
}

function normalizeProviderConnection(connection = {}, index = 0) {
  const prefix = `providerConnections[${index}]`;
  const endpoint = connection.endpoint && typeof connection.endpoint === 'object' ? connection.endpoint : {};
  const apiBase = connection.apiBase || endpointToApiBase(endpoint);
  const adapterProfileId = requiredString(connection.adapterProfileId || 'openai-compatible-public.v1', `${prefix}.adapterProfileId`);
  const adapterProfile = findAdapterProfile(adapterProfileId);
  if (!adapterProfile) {
    throw validationError('LITELLM_ADAPTER_PROFILE_UNKNOWN', `Adapter Profile ${adapterProfileId} is not present in the governed catalog.`);
  }
  const adapterProfileRevision = positiveInteger(connection.adapterProfileRevision, adapterProfile.revision);
  if (adapterProfileRevision !== adapterProfile.revision) {
    throw validationError('LITELLM_ADAPTER_PROFILE_REVISION_UNSUPPORTED', `Adapter Profile ${adapterProfileId} revision ${adapterProfileRevision} is not supported.`);
  }
  const credentialKind = enumValue(connection.credentialRef?.kind, ['environment', 'secret_manager', 'litellm_credential'], 'environment');
  const credentialReferenceName = credentialKind === 'litellm_credential'
    ? requiredCredentialName(connection.credentialRef?.referenceName || connection.apiKeyRef, `${prefix}.credentialRef.referenceName`)
    : requiredEnvName(connection.credentialRef?.referenceName || connection.apiKeyRef, `${prefix}.credentialRef.referenceName`);
  return {
    connectionId: requiredObjectId(connection.connectionId, `${prefix}.connectionId`),
    displayName: requiredString(connection.displayName, `${prefix}.displayName`),
    enabled: connection.enabled !== false,
    adapterProfileId,
    adapterProfileRevision,
    endpoint: normalizeEndpoint(endpoint, apiBase, prefix),
    apiBaseEnv: optionalEnvName(connection.apiBaseEnv || ''),
    networkZone: enumValue(connection.networkZone, ['public_provider', 'approved_private', 'local_development'], 'public_provider'),
    credentialRef: {
      kind: credentialKind,
      referenceName: credentialReferenceName
    },
    tlsPolicy: enumValue(connection.tlsPolicy, ['verify_full', 'private_ca'], 'verify_full'),
    requestTimeoutMs: boundedInteger(connection.requestTimeoutMs, 60000, 1000, 300000),
    metadata: {
      owner: String(connection.metadata?.owner || '').trim().slice(0, 120),
      purpose: String(connection.metadata?.purpose || '').trim().slice(0, 240)
    }
  };
}

function validateDeclaredCapabilities(deployment, connection) {
  const profile = findAdapterProfile(connection?.adapterProfileId);
  if (!profile) return;
  const declarations = [
    ['supportsStreaming', 'streaming'],
    ['supportsToolCalling', 'tool_calling'],
    ['supportsThinking', 'thinking'],
    ['supportsThinkingWithTools', 'thinking_with_tools'],
    ['supportsStructuredOutput', 'structured_output'],
    ['reportsUsage', 'usage']
  ];
  const unsupported = declarations
    .filter(([field, capability]) => deployment.declaredCapabilities[field] && !profile.supportedCapabilities.includes(capability))
    .map(([, capability]) => capability);
  if (unsupported.length) {
    throw validationError(
      'LITELLM_DECLARED_CAPABILITY_UNSUPPORTED',
      `Deployment ${deployment.deploymentId} declares capabilities unsupported by ${profile.profileId}: ${unsupported.join(', ')}.`
    );
  }
}

function normalizeControlPlaneDeployment(deployment = {}, index = 0) {
  const prefix = `modelDeployments[${index}]`;
  const capabilities = deployment.declaredCapabilities || {};
  return {
    deploymentId: requiredObjectId(deployment.deploymentId, `${prefix}.deploymentId`),
    connectionId: requiredObjectId(deployment.connectionId, `${prefix}.connectionId`),
    displayName: requiredString(deployment.displayName || deployment.deploymentId, `${prefix}.displayName`),
    providerModelId: requiredString(deployment.providerModelId, `${prefix}.providerModelId`),
    enabled: deployment.enabled !== false,
    limits: {
      rpm: nonNegativeInteger(deployment.limits?.rpm ?? deployment.rpm, 0),
      tpm: nonNegativeInteger(deployment.limits?.tpm ?? deployment.tpm, 0),
      maxParallelRequests: nonNegativeInteger(deployment.limits?.maxParallelRequests ?? deployment.maxParallelRequests, 0),
      requestTimeoutMs: boundedInteger(deployment.limits?.requestTimeoutMs, 0, 0, 300000)
    },
    declaredCapabilities: {
      contextWindowTokens: nonNegativeInteger(capabilities.contextWindowTokens, 0),
      maxOutputTokens: nonNegativeInteger(capabilities.maxOutputTokens, 0),
      supportsStreaming: Boolean(capabilities.supportsStreaming),
      supportsToolCalling: Boolean(capabilities.supportsToolCalling),
      supportsThinking: Boolean(capabilities.supportsThinking),
      supportsThinkingWithTools: Boolean(capabilities.supportsThinkingWithTools),
      supportsStructuredOutput: Boolean(capabilities.supportsStructuredOutput),
      reportsUsage: capabilities.reportsUsage !== false
    }
  };
}

function normalizeBusinessModelAlias(alias = {}, index = 0) {
  const prefix = `businessModelAliases[${index}]`;
  const members = Array.isArray(alias.members) ? alias.members.map((member, memberIndex) => ({
    deploymentId: requiredObjectId(member.deploymentId, `${prefix}.members[${memberIndex}].deploymentId`),
    priority: positiveInteger(member.priority, memberIndex + 1),
    weight: boundedInteger(member.weight, 100, 0, 100)
  })) : [];
  return {
    aliasId: requiredObjectId(alias.aliasId, `${prefix}.aliasId`),
    litellmAlias: requiredString(alias.litellmAlias, `${prefix}.litellmAlias`),
    displayName: requiredString(alias.displayName || alias.litellmAlias, `${prefix}.displayName`),
    enabled: alias.enabled !== false,
    members,
    routing: {
      strategy: enumValue(alias.routing?.strategy, ['simple-shuffle', 'least-busy', 'usage-based-routing', 'latency-based-routing'], 'simple-shuffle'),
      numRetries: nonNegativeInteger(alias.routing?.numRetries, 1),
      allowedFails: nonNegativeInteger(alias.routing?.allowedFails, 5),
      cooldownTimeSeconds: nonNegativeInteger(alias.routing?.cooldownTimeSeconds, 30)
    }
  };
}

function projectControlPlaneToModelGroups(config) {
  const connections = new Map(config.providerConnections.map((connection) => [connection.connectionId, connection]));
  const deployments = new Map(config.modelDeployments.map((deployment) => [deployment.deploymentId, deployment]));
  return config.businessModelAliases
    .filter((alias) => alias.enabled)
    .map((alias) => ({
      modelName: alias.litellmAlias,
      deployments: alias.members
        .slice()
        .sort((left, right) => left.priority - right.priority)
        .map((member) => {
          const deployment = deployments.get(member.deploymentId);
          const connection = deployment ? connections.get(deployment.connectionId) : null;
          if (!deployment || !connection || !deployment.enabled || !connection.enabled) return null;
          return {
            deploymentId: deployment.deploymentId,
            enabled: true,
            provider: adapterProvider(connection.adapterProfileId),
            model: providerModelName(connection.adapterProfileId, deployment.providerModelId),
            apiBase: endpointToApiBase(connection.endpoint),
            apiBaseEnv: connection.apiBaseEnv,
            apiKeyEnv: connection.credentialRef.kind === 'litellm_credential' ? '' : connection.credentialRef.referenceName,
            litellmCredentialName: connection.credentialRef.kind === 'litellm_credential' ? connection.credentialRef.referenceName : '',
            rpm: deployment.limits.rpm,
            tpm: deployment.limits.tpm,
            maxParallelRequests: deployment.limits.maxParallelRequests
          };
        })
        .filter(Boolean),
      router: {
        routingStrategy: alias.routing.strategy,
        numRetries: alias.routing.numRetries,
        allowedFails: alias.routing.allowedFails,
        cooldownTime: alias.routing.cooldownTimeSeconds
      },
      fallbacks: []
    }))
    .map(normalizeModelGroup);
}

function normalizeEndpoint(endpoint = {}, apiBase = '', prefix = 'endpoint') {
  if (apiBase) {
    const url = new URL(optionalApiBase(apiBase));
    return {
      scheme: url.protocol.replace(':', ''),
      host: url.hostname,
      port: url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80),
      basePath: url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
    };
  }
  const scheme = enumValue(endpoint.scheme, ['https', 'http'], 'https');
  const host = requiredString(endpoint.host, `${prefix}.endpoint.host`).toLowerCase();
  const port = boundedInteger(endpoint.port, scheme === 'https' ? 443 : 80, 1, 65535);
  const basePath = normalizeBasePath(endpoint.basePath || '');
  validateEndpointPolicy({ scheme, host, port, basePath });
  return { scheme, host, port, basePath };
}

function endpointToApiBase(endpoint = {}) {
  if (!endpoint || !endpoint.host) return '';
  const scheme = endpoint.scheme || 'https';
  const defaultPort = scheme === 'https' ? 443 : 80;
  const port = Number(endpoint.port || defaultPort);
  const portText = port === defaultPort ? '' : `:${port}`;
  return `${scheme}://${endpoint.host}${portText}${normalizeBasePath(endpoint.basePath || '')}`;
}

function optionalApiBase(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw validationError('LITELLM_CONFIG_INVALID_API_BASE', 'API Base must be a valid absolute URL.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw validationError('LITELLM_CONFIG_INVALID_API_BASE', 'API Base cannot contain credentials, query, or fragment.');
  }
  const endpoint = {
    scheme: url.protocol.replace(':', ''),
    host: url.hostname.toLowerCase(),
    port: url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80),
    basePath: url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  };
  validateEndpointPolicy(endpoint);
  return endpointToApiBase(endpoint);
}

function validateEndpointPolicy(endpoint) {
  if (!['https', 'http'].includes(endpoint.scheme)) throw validationError('LITELLM_CONFIG_ENDPOINT_SCHEME', 'Provider endpoint must use HTTPS or approved local HTTP.');
  const localHost = endpoint.host === 'localhost' || endpoint.host === '127.0.0.1' || endpoint.host === '::1';
  if (endpoint.scheme === 'http' && !localHost) throw validationError('LITELLM_CONFIG_ENDPOINT_TLS_REQUIRED', 'Public provider endpoints must use HTTPS.');
  if (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(endpoint.host) && !localHost) {
    throw validationError('LITELLM_CONFIG_ENDPOINT_PRIVATE_IP', 'Private IP endpoints require a separately approved private adapter profile.');
  }
}

function normalizeBasePath(value) {
  const text = String(value || '').trim();
  if (!text || text === '/') return '';
  if (!text.startsWith('/') || text.includes('?') || text.includes('#') || text.includes('..')) {
    throw validationError('LITELLM_CONFIG_ENDPOINT_PATH', 'Endpoint base path must be an absolute safe path.');
  }
  return text.replace(/\/$/, '');
}

function adapterProvider(profileId) {
  if (String(profileId).startsWith('deepseek')) return 'deepseek';
  if (String(profileId).startsWith('anthropic')) return 'anthropic';
  if (String(profileId).startsWith('azure')) return 'azure';
  return 'openai';
}

function providerModelName(profileId, modelId) {
  const value = String(modelId || '').trim();
  if (value.includes('/')) return value;
  const provider = adapterProvider(profileId);
  return `${provider}/${value}`;
}

function requiredObjectId(value, field) {
  const id = requiredString(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/.test(id)) throw validationError('LITELLM_CONFIG_INVALID_OBJECT_ID', `${field} is invalid.`);
  return id;
}

function assertUniqueIds(items, key, code) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item[key])) throw validationError(code, `${key} must be unique.`);
    seen.add(item[key]);
  }
}

function enumValue(value, allowed, fallback) {
  const normalized = String(value || '').trim();
  return allowed.includes(normalized) ? normalized : fallback;
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizeRouter(router = {}) {
  return {
    routingStrategy: String(router.routingStrategy || router.routing_strategy || 'simple-shuffle').trim(),
    numRetries: nonNegativeInteger(router.numRetries ?? router.num_retries, 1),
    allowedFails: nonNegativeInteger(router.allowedFails ?? router.allowed_fails, 5),
    cooldownTime: nonNegativeInteger(router.cooldownTime ?? router.cooldown_time, 30)
  };
}

function normalizeFallback(fallback = {}) {
  if (Array.isArray(fallback)) return { targets: fallback.map((item) => String(item || '').trim()).filter(Boolean) };
  return { targets: (fallback.targets || fallback.modelGroups || []).map((item) => String(item || '').trim()).filter(Boolean) };
}

function normalizeGeneralSettings(general = {}) {
  return {
    masterKeyEnv: requiredEnvName(general.masterKeyEnv || general.master_key_env || 'LITELLM_MASTER_KEY', 'general.masterKeyEnv'),
    databaseUrlEnv: requiredEnvName(general.databaseUrlEnv || general.database_url_env || 'LITELLM_DATABASE_URL', 'general.databaseUrlEnv')
  };
}

function mergeRouterSettings(modelGroups) {
  return normalizeRouter(modelGroups.find((group) => group.router)?.router || {});
}

function assertNoRawSecrets(value) {
  const text = JSON.stringify(value || {});
  if (/"api[_-]?key"\s*:/.test(text) || /sk-[A-Za-z0-9_-]{8,}/.test(text)) {
    throw validationError('LITELLM_CONFIG_RAW_SECRET_REJECTED', 'LiteLLM config must reference secret env names, not raw API keys.');
  }
}

function requiredString(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) throw validationError('LITELLM_CONFIG_REQUIRED_FIELD', `${field} is required.`);
  return normalized;
}

function optionalEnvName(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return requiredEnvName(normalized, 'env');
}

function optionalCredentialName(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return requiredCredentialName(normalized, 'credentialName');
}

function requiredCredentialName(value, field) {
  const normalized = requiredString(value, field);
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,119}$/.test(normalized)) {
    throw validationError('LITELLM_CONFIG_INVALID_CREDENTIAL_NAME', `${field} must be a valid LiteLLM credential name.`);
  }
  return normalized;
}

function requiredEnvName(value, field) {
  const normalized = requiredString(value, field);
  if (!/^[A-Z][A-Z0-9_]*$/.test(normalized)) {
    throw validationError('LITELLM_CONFIG_INVALID_ENV_NAME', `${field} must be an environment variable name.`);
  }
  return normalized;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function yamlScalar(value) {
  const text = String(value || '');
  if (/^[A-Za-z0-9_.:/-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function checksumText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function isoString(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  DEFAULT_LITELLM_CONFIG_VERSION_ID,
  defaultLiteLlmConfig,
  normalizeLiteLlmConfig,
  validateLiteLlmConfig,
  renderLiteLlmConfigYaml,
  createLiteLlmConfigVersionDraft,
  publicLiteLlmConfigVersion,
  checksumText
};
