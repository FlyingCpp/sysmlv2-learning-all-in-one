'use strict';

const crypto = require('crypto');
const {
  BOOTSTRAP_MODEL_CONTEXT_WINDOW_TOKENS
} = require('../../packages/teacher-contract');
const {
  catalogMetadata,
  findAdapterProfile,
  findModelProtocolProfile
} = require('./llm-adapter-catalog');

function modelRegistryFromLiteLlmVersion(version = {}) {
  const config = version?.config || {};
  const groups = Array.isArray(version?.config?.modelGroups) ? version.config.modelGroups : [];
  const configuredAliases = Array.isArray(version?.config?.businessModelAliases)
    ? version.config.businessModelAliases
    : [];
  const aliasByRuntimeName = new Map(configuredAliases.map((alias) => [String(alias?.litellmAlias || '').trim(), alias]));
  const profiles = groups.flatMap((group) => {
    const litellmAlias = String(group?.modelName || '').trim();
    const deployments = Array.isArray(group?.deployments)
      ? group.deployments.filter((deployment) => deployment?.enabled !== false)
      : [];
    if (!litellmAlias || !deployments.length) return [];
    const configuredAlias = aliasByRuntimeName.get(litellmAlias);
    const aliasId = String(configuredAlias?.aliasId || legacyAliasId(litellmAlias)).trim();
    const providers = [...new Set(deployments.map((deployment) => String(deployment?.provider || '').trim()).filter(Boolean))].sort();
    const protocol = executionProtocolForAlias(config, configuredAlias ? aliasId : litellmAlias);
    return [{
      profileId: `model_profile_${shortHash(aliasId)}`,
      aliasId,
      litellmAlias,
      displayName: String(configuredAlias?.displayName || litellmAlias).trim(),
      status: 'registered',
      capabilityStatus: 'not_probed',
      runtimeProtocolStatus: protocol.status,
      protocolMode: protocol.protocolMode,
      adapterProfileId: protocol.adapterProfileId,
      adapterProfileRevision: protocol.adapterProfileRevision,
      modelProtocolProfileId: protocol.modelProtocolProfileId,
      modelProtocolProfileRevision: protocol.modelProtocolProfileRevision,
      executionPolicy: protocol.executionPolicy,
      deploymentCount: deployments.length,
      providers
    }];
  }).sort((left, right) => left.litellmAlias.localeCompare(right.litellmAlias));
  return {
    registryRevision: String(version?.versionId || ''),
    registryChecksum: String(version?.checksum || ''),
    source: 'active_litellm_config',
    aliasIds: profiles.map((profile) => profile.aliasId),
    aliases: profiles.map((profile) => profile.litellmAlias),
    profiles
  };
}

/**
 * Model Deployment是上下文能力唯一Owner。Alias可能路由到多个Deployment，
 * 因此Run只能采用所有可达成员中的最小窗口；未声明的旧Deployment使用显式
 * Bootstrap兼容值并在Snapshot中标记，不能伪装成已观测能力。
 */
function modelCapabilitySnapshotFromLiteLlmVersion(version = {}, stageRoutes = {}, stageReasoningPolicies = {}) {
  const config = version?.config || {};
  const deployments = new Map((config.modelDeployments || []).map((deployment) => [
    String(deployment?.deploymentId || ''),
    deployment
  ]));
  const aliasesById = new Map((config.businessModelAliases || []).map((alias) => [String(alias?.aliasId || ''), alias]));
  const aliasesByRuntimeName = new Map((config.businessModelAliases || []).map((alias) => [String(alias?.litellmAlias || ''), alias]));
  const legacyGroups = new Map((config.modelGroups || []).map((group) => [
    String(group?.modelName || ''),
    group
  ]));
  const stages = Object.fromEntries(Object.entries(stageRoutes || {}).map(([stageId, route]) => {
    const aliasReference = String(route || '').trim();
    const capability = contextCapabilityForAlias(aliasReference, aliasesById, aliasesByRuntimeName, deployments, legacyGroups);
    const protocol = executionProtocolForAlias(config, aliasReference);
    const reasoningPolicy = String(stageReasoningPolicies?.[stageId] || defaultStageReasoningPolicy(stageId));
    const protocolStatus = protocolStatusForStage(protocol, reasoningPolicy);
    return [stageId, {
      aliasId: capability.aliasId,
      alias: capability.litellmAlias,
      contextWindowTokens: capability.contextWindowTokens,
      source: capability.source,
      deploymentIds: capability.deploymentIds,
      protocolStatus,
      protocolMode: protocol.protocolMode,
      adapterProfileId: protocol.adapterProfileId,
      adapterProfileRevision: protocol.adapterProfileRevision,
      modelProtocolProfileId: protocol.modelProtocolProfileId,
      modelProtocolProfileRevision: protocol.modelProtocolProfileRevision,
      executionPolicy: protocol.executionPolicy
    }];
  }));
  const stageWindows = Object.values(stages)
    .map((stage) => Number(stage.contextWindowTokens))
    .filter((value) => Number.isInteger(value) && value > 0);
  const effectiveContextWindowTokens = stageWindows.length
    ? Math.min(...stageWindows)
    : BOOTSTRAP_MODEL_CONTEXT_WINDOW_TOKENS;
  const material = {
    schemaVersion: 2,
    registryRevision: String(version?.versionId || ''),
    registryChecksum: String(version?.checksum || ''),
    protocolCatalog: catalogMetadata(),
    gatewayRuntime: config.general?.gatewayRuntime || catalogMetadata().gatewayContract,
    effectiveContextWindowTokens,
    stages
  };
  return {
    ...material,
    checksum: `sha256:${crypto.createHash('sha256').update(canonicalJson(material), 'utf8').digest('hex')}`
  };
}

function executionProtocolForAlias(config = {}, aliasReference = '') {
  const reference = String(aliasReference || '').trim();
  const configuredAliases = Array.isArray(config.businessModelAliases) ? config.businessModelAliases : [];
  const configuredAlias = configuredAliases.find((alias) => (
    String(alias?.aliasId || '').trim() === reference
      || String(alias?.litellmAlias || '').trim() === reference
  ));
  const legacyGroup = (config.modelGroups || []).find((group) => {
    const modelName = String(group?.modelName || '').trim();
    return modelName === reference || legacyAliasId(modelName) === reference;
  });
  const runtimeAlias = String(configuredAlias?.litellmAlias || legacyGroup?.modelName || reference).trim();
  const connections = new Map((config.providerConnections || []).map((connection) => [
    String(connection?.connectionId || '').trim(),
    connection
  ]));
  const deployments = new Map((config.modelDeployments || []).map((deployment) => [
    String(deployment?.deploymentId || '').trim(),
    deployment
  ]));
  const members = configuredAlias
    ? (configuredAlias.members || []).map((member) => deployments.get(String(member?.deploymentId || '').trim()))
    : (legacyGroup?.deployments || []);
  const protocols = members
    .filter((deployment) => deployment?.enabled !== false)
    .map((deployment) => protocolForDeployment(deployment, connections.get(String(deployment?.connectionId || '').trim())))
    .filter(Boolean);
  if (!protocols.length || protocols.some((protocol) => protocol.status !== 'ready')) {
    return unresolvedProtocol('unresolved');
  }
  const signatures = new Set(protocols.map((protocol) => [
    protocol.protocolMode,
    protocol.adapterProfileId,
    protocol.adapterProfileRevision,
    protocol.modelProtocolProfileId,
    protocol.modelProtocolProfileRevision,
    crypto.createHash('sha256').update(canonicalJson(protocol.executionPolicy || {}), 'utf8').digest('hex')
  ].join(':')));
  if (signatures.size !== 1) return unresolvedProtocol('ambiguous');
  return protocols[0];
}

function protocolForDeployment(deployment, connection) {
  const providerModelId = String(
    deployment?.providerModelId
      || String(deployment?.model || '').split('/').slice(1).join('/')
      || deployment?.model
      || ''
  ).trim();
  const inferredAdapterProfileId = legacyAdapterProfileId(deployment);
  const adapterProfileId = String(connection?.adapterProfileId || inferredAdapterProfileId).trim();
  const adapterProfile = findAdapterProfile(adapterProfileId);
  if (!adapterProfile || connection?.enabled === false) return unresolvedProtocol('unresolved');
  const modelProtocolProfile = findModelProtocolProfile(
    adapterProfileId,
    providerModelId,
    deployment?.modelProtocolProfileId
  );
  if (deployment?.modelProtocolProfileId && !modelProtocolProfile) return unresolvedProtocol('unresolved');
  const protocolMode = adapterProfile.gatewayProtocol === 'gateway-chat.v1' ? 'gateway-chat-v1' : '';
  if (!protocolMode) return unresolvedProtocol('unresolved');
  return {
    status: 'ready',
    protocolMode,
    adapterProfileId,
    adapterProfileRevision: Number(connection?.adapterProfileRevision || adapterProfile.revision),
    modelProtocolProfileId: String(modelProtocolProfile?.profileId || ''),
    modelProtocolProfileRevision: Number(modelProtocolProfile?.revision || 0),
    executionPolicy: modelProtocolProfile?.executionPolicy || genericGatewayExecutionPolicy()
  };
}

function legacyAdapterProfileId(deployment = {}) {
  const provider = String(deployment?.provider || '').trim().toLowerCase();
  const model = String(deployment?.model || '').trim().toLowerCase();
  if (provider === 'deepseek' || model.startsWith('deepseek/')) return 'deepseek-v4.v1';
  if (provider === 'zai' || model.startsWith('zai/')) return 'zai-glm.v1';
  return 'openai-compatible-public.v1';
}

function unresolvedProtocol(status) {
  return {
    status,
    protocolMode: '',
    adapterProfileId: '',
    adapterProfileRevision: 0,
    modelProtocolProfileId: '',
    modelProtocolProfileRevision: 0,
    executionPolicy: null
  };
}

function genericGatewayExecutionPolicy() {
  return {
    gatewayContract: 'gateway-chat.v1',
    reasoning: {
      defaultMode: 'disabled',
      enabled: { supported: true, sdkReasoning: 'high', providerOptions: {} },
      disabled: { supported: true, sdkReasoning: 'none', providerOptions: {} }
    },
    toolChoice: { nonThinking: 'auto', thinking: 'auto' },
    continuation: { reasoningContent: 'omit', assistantContent: 'provider_default' }
  };
}

function defaultStageReasoningPolicy(stageId) {
  return stageId === 'fastGate' || stageId === 'finalizer' ? 'disabled' : 'provider-managed';
}

function protocolStatusForStage(protocol, reasoningPolicy) {
  if (protocol?.status !== 'ready') return protocol?.status || 'unresolved';
  const reasoning = protocol.executionPolicy?.reasoning;
  if (reasoningPolicy === 'disabled') {
    return reasoning?.disabled?.supported ? 'ready' : 'incompatible';
  }
  return reasoningPolicy === 'provider-managed'
    && reasoning?.enabled?.supported
    && reasoning.enabled.sdkReasoning !== 'none'
    ? 'ready'
    : 'incompatible';
}

function contextCapabilityForAlias(aliasReference, aliasesById, aliasesByRuntimeName, deployments, legacyGroups) {
  const configuredAlias = aliasesById.get(aliasReference) || aliasesByRuntimeName.get(aliasReference);
  const litellmAlias = String(configuredAlias?.litellmAlias || aliasReference).trim();
  const memberDeployments = configuredAlias
    ? (configuredAlias.members || [])
      .map((member) => deployments.get(String(member?.deploymentId || '')))
      .filter((deployment) => deployment?.enabled !== false)
    : (legacyGroups.get(litellmAlias)?.deployments || []).filter((deployment) => deployment?.enabled !== false);
  const deploymentIds = memberDeployments
    .map((deployment) => String(deployment?.deploymentId || ''))
    .filter(Boolean);
  const declared = memberDeployments.map((deployment) => {
    const value = Number(deployment?.declaredCapabilities?.contextWindowTokens);
    return Number.isInteger(value) && value > 0 ? value : null;
  });
  const allDeclared = declared.length > 0 && declared.every((value) => value !== null);
  return {
    aliasId: String(configuredAlias?.aliasId || legacyAliasId(litellmAlias)).trim(),
    litellmAlias,
    contextWindowTokens: allDeclared
      ? Math.min(...declared)
      : BOOTSTRAP_MODEL_CONTEXT_WINDOW_TOKENS,
    source: allDeclared ? 'model_deployment_declared' : 'bootstrap_fallback',
    deploymentIds
  };
}

function legacyAliasId(litellmAlias) {
  return `legacy_alias_${shortHash(String(litellmAlias || '').trim())}`;
}

function canonicalJson(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value || {}).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 24);
}

module.exports = {
  BOOTSTRAP_MODEL_CONTEXT_WINDOW_TOKENS,
  modelRegistryFromLiteLlmVersion,
  modelCapabilitySnapshotFromLiteLlmVersion,
  executionProtocolForAlias,
  legacyAliasId
};
