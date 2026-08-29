'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_CATALOG_PATH = path.resolve(__dirname, '../../config/llm-protocol-catalog.json');
const CATALOG_PATH = path.resolve(process.env.LLM_PROTOCOL_CATALOG_PATH || DEFAULT_CATALOG_PATH);
const ALLOWED_GATEWAY_PROTOCOLS = new Set(['gateway-chat.v1']);
const ALLOWED_TOOL_CHOICES = new Set(['auto', 'omit', 'unsupported']);
const ALLOWED_SDK_REASONING = new Set(['none', 'medium', 'high', 'xhigh']);
const ALLOWED_PROVIDER_OPTION_KEYS = new Set([
  'allowed_openai_params',
  'extra_body',
  'parallel_tool_calls',
  'reasoningEffort',
  'thinking'
]);

const loadedCatalog = loadCatalog(CATALOG_PATH);
const ADAPTER_PROFILE_CATALOG = loadedCatalog.adapterProfiles;
const MODEL_PROTOCOL_PROFILE_CATALOG = loadedCatalog.modelProtocolProfiles;

function loadCatalog(catalogPath) {
  let raw;
  try {
    raw = fs.readFileSync(catalogPath, 'utf8');
  } catch (error) {
    throw catalogError('LLM_PROTOCOL_CATALOG_READ_FAILED', `无法读取LLM协议Catalog：${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw catalogError('LLM_PROTOCOL_CATALOG_JSON_INVALID', `LLM协议Catalog不是有效JSON：${error.message}`);
  }
  const normalized = normalizeCatalog(parsed);
  const checksum = crypto.createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex');
  return deepFreeze({ ...normalized, checksum, sourcePath: catalogPath });
}

function normalizeCatalog(input) {
  if (!isRecord(input)) throw catalogError('LLM_PROTOCOL_CATALOG_INVALID', 'LLM协议Catalog必须是对象。');
  if (Number(input.schemaVersion) !== 1) {
    throw catalogError('LLM_PROTOCOL_CATALOG_SCHEMA_UNSUPPORTED', 'LLM协议Catalog schemaVersion必须为1。');
  }
  const gatewayContract = normalizeGatewayContract(input.gatewayContract);
  const adapterProfiles = requiredArray(input.adapterProfiles, 'adapterProfiles').map(normalizeAdapterProfile);
  const adaptersById = uniqueById(adapterProfiles, 'profileId', 'LLM_PROTOCOL_ADAPTER_DUPLICATE');
  const modelProtocolProfiles = requiredArray(input.modelProtocolProfiles, 'modelProtocolProfiles')
    .map((profile) => normalizeModelProtocolProfile(profile, adaptersById, gatewayContract.id));
  uniqueById(modelProtocolProfiles, 'profileId', 'LLM_PROTOCOL_MODEL_PROFILE_DUPLICATE');
  assertRecommendationUniqueness(modelProtocolProfiles);
  return {
    schemaVersion: 1,
    catalogVersion: requiredString(input.catalogVersion, 'catalogVersion'),
    gatewayContract,
    adapterProfiles,
    modelProtocolProfiles
  };
}

function normalizeGatewayContract(value) {
  if (!isRecord(value)) throw catalogError('LLM_PROTOCOL_GATEWAY_REQUIRED', 'gatewayContract必须是对象。');
  const id = requiredString(value.id, 'gatewayContract.id');
  if (!ALLOWED_GATEWAY_PROTOCOLS.has(id)) {
    throw catalogError('LLM_PROTOCOL_GATEWAY_UNSUPPORTED', `不支持的Gateway Contract：${id}`);
  }
  return {
    id,
    implementation: requiredString(value.implementation, 'gatewayContract.implementation'),
    testedVersion: requiredString(value.testedVersion, 'gatewayContract.testedVersion')
  };
}

function normalizeAdapterProfile(profile) {
  if (!isRecord(profile)) throw catalogError('LLM_PROTOCOL_ADAPTER_INVALID', 'Adapter Profile必须是对象。');
  const endpointPolicy = isRecord(profile.endpointPolicy) ? profile.endpointPolicy : {};
  const schemes = stringArray(endpointPolicy.schemes, 'endpointPolicy.schemes');
  if (!schemes.length || schemes.some((scheme) => !['http', 'https'].includes(scheme))) {
    throw catalogError('LLM_PROTOCOL_ENDPOINT_SCHEME_INVALID', 'endpointPolicy.schemes只能包含http或https。');
  }
  return {
    profileId: requiredId(profile.profileId, 'adapterProfiles.profileId'),
    revision: positiveInteger(profile.revision, 'adapterProfiles.revision'),
    displayName: requiredString(profile.displayName, 'adapterProfiles.displayName'),
    gatewayProtocol: requiredString(profile.gatewayProtocol, 'adapterProfiles.gatewayProtocol'),
    providerWireProtocol: requiredString(profile.providerWireProtocol, 'adapterProfiles.providerWireProtocol'),
    litellmProviderPrefix: requiredId(profile.litellmProviderPrefix, 'adapterProfiles.litellmProviderPrefix'),
    endpointPolicy: {
      schemes,
      defaultPort: positiveInteger(endpointPolicy.defaultPort, 'endpointPolicy.defaultPort'),
      recommendedHosts: stringArray(endpointPolicy.recommendedHosts || [], 'endpointPolicy.recommendedHosts')
    },
    supportedCapabilities: stringArray(profile.supportedCapabilities, 'supportedCapabilities')
  };
}

function normalizeModelProtocolProfile(profile, adaptersById, gatewayContractId) {
  if (!isRecord(profile)) throw catalogError('LLM_PROTOCOL_MODEL_PROFILE_INVALID', 'Model Protocol Profile必须是对象。');
  const profileId = requiredId(profile.profileId, 'modelProtocolProfiles.profileId');
  const adapterProfileIds = stringArray(profile.adapterProfileIds, `${profileId}.adapterProfileIds`);
  if (!adapterProfileIds.length || adapterProfileIds.some((id) => !adaptersById.has(id))) {
    throw catalogError('LLM_PROTOCOL_MODEL_ADAPTER_UNKNOWN', `${profileId}引用了不存在的Adapter Profile。`);
  }
  const executionPolicy = normalizeExecutionPolicy(profile.executionPolicy, profileId, gatewayContractId);
  const litellm = isRecord(profile.litellm) ? profile.litellm : {};
  const probePolicy = isRecord(profile.probePolicy) ? profile.probePolicy : {};
  return {
    profileId,
    revision: positiveInteger(profile.revision, `${profileId}.revision`),
    adapterProfileIds,
    recommendedModelIds: stringArray(profile.recommendedModelIds || [], `${profileId}.recommendedModelIds`),
    compatibilityScope: requiredString(profile.compatibilityScope, `${profileId}.compatibilityScope`),
    litellm: {
      extraBodyParams: stringArray(litellm.extraBodyParams || [], `${profileId}.litellm.extraBodyParams`),
      allowedOpenAiParams: stringArray(litellm.allowedOpenAiParams || [], `${profileId}.litellm.allowedOpenAiParams`)
    },
    executionPolicy,
    probePolicy: {
      defaultReasoningMode: enumValue(probePolicy.defaultReasoningMode, ['enabled', 'disabled'], executionPolicy.reasoning.defaultMode),
      thinkingMaxOutputTokens: optionalPositiveInteger(probePolicy.thinkingMaxOutputTokens, `${profileId}.probePolicy.thinkingMaxOutputTokens`)
    }
  };
}

function normalizeExecutionPolicy(value, profileId, gatewayContractId) {
  if (!isRecord(value)) throw catalogError('LLM_PROTOCOL_EXECUTION_POLICY_REQUIRED', `${profileId}缺少executionPolicy。`);
  const gatewayContract = requiredString(value.gatewayContract, `${profileId}.executionPolicy.gatewayContract`);
  if (gatewayContract !== gatewayContractId) {
    throw catalogError('LLM_PROTOCOL_EXECUTION_GATEWAY_MISMATCH', `${profileId}的Gateway Contract不匹配。`);
  }
  const reasoning = isRecord(value.reasoning) ? value.reasoning : {};
  const enabled = normalizeReasoningBranch(reasoning.enabled, `${profileId}.reasoning.enabled`);
  const disabled = normalizeReasoningBranch(reasoning.disabled, `${profileId}.reasoning.disabled`);
  const defaultMode = enumValue(reasoning.defaultMode, ['enabled', 'disabled'], 'disabled');
  if (!(defaultMode === 'enabled' ? enabled.supported : disabled.supported)) {
    throw catalogError('LLM_PROTOCOL_DEFAULT_REASONING_UNSUPPORTED', `${profileId}的默认Reasoning模式不受支持。`);
  }
  const toolChoice = isRecord(value.toolChoice) ? value.toolChoice : {};
  return {
    gatewayContract,
    reasoning: { defaultMode, enabled, disabled },
    toolChoice: {
      nonThinking: enumValue(toolChoice.nonThinking, [...ALLOWED_TOOL_CHOICES], 'auto'),
      thinking: enumValue(toolChoice.thinking, [...ALLOWED_TOOL_CHOICES], 'auto')
    },
    continuation: cloneJson(value.continuation || {})
  };
}

function normalizeReasoningBranch(value, field) {
  if (!isRecord(value) || value.supported !== true) {
    return { supported: false, sdkReasoning: 'none', providerOptions: {} };
  }
  const sdkReasoning = enumValue(value.sdkReasoning, [...ALLOWED_SDK_REASONING], 'none');
  const providerOptions = isRecord(value.providerOptions) ? cloneJson(value.providerOptions) : {};
  for (const key of Object.keys(providerOptions)) {
    if (!ALLOWED_PROVIDER_OPTION_KEYS.has(key)) {
      throw catalogError('LLM_PROTOCOL_PROVIDER_OPTION_UNSUPPORTED', `${field}.providerOptions包含不支持字段：${key}`);
    }
  }
  return { supported: true, sdkReasoning, providerOptions };
}

function findAdapterProfile(profileId) {
  return ADAPTER_PROFILE_CATALOG.find((profile) => profile.profileId === String(profileId || '')) || null;
}

function findModelProtocolProfile(adapterProfileId, providerModelId, explicitProfileId = '') {
  const adapterId = String(adapterProfileId || '');
  const requestedProfileId = String(explicitProfileId || '').trim();
  if (requestedProfileId) {
    const explicit = MODEL_PROTOCOL_PROFILE_CATALOG.find((profile) => profile.profileId === requestedProfileId) || null;
    return explicit?.adapterProfileIds.includes(adapterId) ? explicit : null;
  }
  const normalizedModelId = String(providerModelId || '').trim().toLowerCase();
  const matches = MODEL_PROTOCOL_PROFILE_CATALOG.filter((profile) => profile.adapterProfileIds.includes(adapterId)
    && profile.recommendedModelIds.some((modelId) => modelId.toLowerCase() === normalizedModelId));
  return matches.length === 1 ? matches[0] : null;
}

function publicAdapterProfileCatalog() {
  return {
    schemaVersion: loadedCatalog.schemaVersion,
    catalogVersion: loadedCatalog.catalogVersion,
    checksum: loadedCatalog.checksum,
    gatewayContract: loadedCatalog.gatewayContract,
    profiles: ADAPTER_PROFILE_CATALOG,
    modelProtocolProfiles: MODEL_PROTOCOL_PROFILE_CATALOG.map((profile) => ({
      profileId: profile.profileId,
      revision: profile.revision,
      adapterProfileIds: profile.adapterProfileIds,
      recommendedModelIds: profile.recommendedModelIds,
      compatibilityScope: profile.compatibilityScope,
      reasoningModes: {
        enabled: profile.executionPolicy.reasoning.enabled.supported,
        disabled: profile.executionPolicy.reasoning.disabled.supported,
        defaultMode: profile.executionPolicy.reasoning.defaultMode
      }
    }))
  };
}

function catalogMetadata() {
  return {
    schemaVersion: loadedCatalog.schemaVersion,
    catalogVersion: loadedCatalog.catalogVersion,
    checksum: loadedCatalog.checksum,
    gatewayContract: loadedCatalog.gatewayContract
  };
}

function assertRecommendationUniqueness(profiles) {
  const owners = new Map();
  for (const profile of profiles) {
    for (const adapterProfileId of profile.adapterProfileIds) {
      for (const modelId of profile.recommendedModelIds) {
        const key = `${adapterProfileId}:${modelId.toLowerCase()}`;
        if (owners.has(key)) {
          throw catalogError('LLM_PROTOCOL_MODEL_RECOMMENDATION_AMBIGUOUS', `${key}同时被多个Profile推荐。`);
        }
        owners.set(key, profile.profileId);
      }
    }
  }
}

function requiredArray(value, field) {
  if (!Array.isArray(value) || !value.length) throw catalogError('LLM_PROTOCOL_CATALOG_ARRAY_REQUIRED', `${field}必须是非空数组。`);
  return value;
}

function stringArray(value, field) {
  if (!Array.isArray(value)) throw catalogError('LLM_PROTOCOL_CATALOG_ARRAY_INVALID', `${field}必须是数组。`);
  return value.map((item) => requiredString(item, field));
}

function uniqueById(values, field, code) {
  const result = new Map();
  for (const value of values) {
    if (result.has(value[field])) throw catalogError(code, `${value[field]}重复。`);
    result.set(value[field], value);
  }
  return result;
}

function requiredId(value, field) {
  const normalized = requiredString(value, field);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(normalized)) {
    throw catalogError('LLM_PROTOCOL_CATALOG_ID_INVALID', `${field}格式无效。`);
  }
  return normalized;
}

function requiredString(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) throw catalogError('LLM_PROTOCOL_CATALOG_FIELD_REQUIRED', `${field}不能为空。`);
  return normalized;
}

function positiveInteger(value, field) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) throw catalogError('LLM_PROTOCOL_CATALOG_INTEGER_INVALID', `${field}必须是正整数。`);
  return normalized;
}

function optionalPositiveInteger(value, field) {
  if (value === undefined || value === null || value === '') return 0;
  return positiveInteger(value, field);
}

function enumValue(value, values, fallback) {
  const normalized = String(value || fallback);
  if (!values.includes(normalized)) throw catalogError('LLM_PROTOCOL_CATALOG_ENUM_INVALID', `不支持的配置值：${normalized}`);
  return normalized;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function catalogError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  ADAPTER_PROFILE_CATALOG,
  MODEL_PROTOCOL_PROFILE_CATALOG,
  catalogMetadata,
  findAdapterProfile,
  findModelProtocolProfile,
  loadCatalog,
  publicAdapterProfileCatalog
};
