'use strict';

const assert = require('node:assert/strict');
const {
  BOOTSTRAP_MODEL_CONTEXT_WINDOW_TOKENS,
  modelCapabilitySnapshotFromLiteLlmVersion
} = require('../apps/api/ai-teacher-model-registry');
const { validateModelCapabilitySnapshot } = require('../packages/teacher-contract');

const declared = modelCapabilitySnapshotFromLiteLlmVersion({
  versionId: 'litellm_model_capability_v1',
  checksum: `sha256:${'1'.repeat(64)}`,
  config: {
    modelDeployments: [
      deployment('deployment-fast-a', 128000),
      deployment('deployment-fast-b', 64000),
      deployment('deployment-reasoning', 96000)
    ],
    businessModelAliases: [
      alias('alias-fast', 'ai-teacher-fast', ['deployment-fast-a', 'deployment-fast-b']),
      alias('alias-reasoning', 'ai-teacher-reasoning', ['deployment-reasoning'])
    ]
  }
}, {
  main: 'alias-fast',
  candidate: 'alias-reasoning'
});

assert.equal(validateModelCapabilitySnapshot(declared).ok, true);
assert.equal(declared.schemaVersion, 2);
assert.equal(declared.stages.main.protocolStatus, 'ready');
assert.equal(declared.stages.main.protocolMode, 'gateway-chat-v1');
assert.equal(declared.stages.main.executionPolicy.gatewayContract, 'gateway-chat.v1');
assert.equal(declared.protocolCatalog.gatewayContract.testedVersion, '1.90.0');
assert.equal(declared.stages.main.contextWindowTokens, 64000,
  'Alias能力必须采用所有可达Deployment中的保守最小值。');
assert.equal(declared.stages.main.source, 'model_deployment_declared');
assert.equal(declared.stages.main.aliasId, 'alias-fast');
assert.equal(declared.stages.main.alias, 'ai-teacher-fast');
assert.equal(declared.stages.candidate.contextWindowTokens, 96000);
assert.equal(declared.effectiveContextWindowTokens, 64000,
  'Run能力必须采用所有阶段路由中的保守最小值。');

const unknown = modelCapabilitySnapshotFromLiteLlmVersion({
  versionId: 'litellm_model_capability_unknown',
  checksum: `sha256:${'2'.repeat(64)}`,
  config: {
    modelDeployments: [deployment('deployment-unknown', 0)],
    businessModelAliases: [alias('alias-fast', 'ai-teacher-fast', ['deployment-unknown'])]
  }
}, { main: 'alias-fast' });
assert.equal(unknown.stages.main.contextWindowTokens, BOOTSTRAP_MODEL_CONTEXT_WINDOW_TOKENS);
assert.equal(unknown.stages.main.source, 'bootstrap_fallback',
  '旧配置缺少能力声明时必须显式标记Fallback，不能伪装成已声明能力。');
assert.equal(validateModelCapabilitySnapshot({ ...unknown, checksum: `sha256:${'0'.repeat(64)}` }).ok, false,
  'Teacher必须验证Snapshot内容绑定，防止能力值与API冻结结果发生漂移。');

const providerAware = modelCapabilitySnapshotFromLiteLlmVersion({
  versionId: 'litellm_model_protocol_v2',
  checksum: `sha256:${'3'.repeat(64)}`,
  config: {
    schemaVersion: 2,
    providerConnections: [
      connection('connection-deepseek', 'deepseek-v4.v1'),
      connection('connection-glm', 'zai-glm.v1')
    ],
    modelDeployments: [
      protocolDeployment('deployment-deepseek', 'connection-deepseek', 'deepseek-v4-flash'),
      protocolDeployment('deployment-glm', 'connection-glm', 'glm-5.3-flash')
    ],
    businessModelAliases: [
      alias('alias-deepseek', 'ai-teacher-deepseek', ['deployment-deepseek']),
      alias('alias-glm', 'ai-teacher-glm', ['deployment-glm'])
    ]
  }
}, { main: 'alias-glm', repair: 'alias-deepseek' });
assert.equal(validateModelCapabilitySnapshot(providerAware).ok, true);
assert.equal(providerAware.stages.main.protocolMode, 'gateway-chat-v1');
assert.equal(providerAware.stages.main.modelProtocolProfileId, 'glm-5.3-standard-chat.v1');
assert.equal(providerAware.stages.main.executionPolicy.reasoning.disabled.supported, false);
assert.equal(providerAware.stages.repair.protocolMode, 'gateway-chat-v1');

const incompatibleFastGate = modelCapabilitySnapshotFromLiteLlmVersion({
  versionId: 'litellm_model_protocol_incompatible_fast_gate',
  checksum: `sha256:${'5'.repeat(64)}`,
  config: providerAwareConfig()
}, { fastGate: 'alias-glm' });
assert.equal(incompatibleFastGate.stages.fastGate.protocolStatus, 'incompatible',
  'always-thinking GLM standard profile must not be assigned to the forced non-thinking Fast Gate');
assert.equal(validateModelCapabilitySnapshot(incompatibleFastGate).ok, false);

const providerManagedFinalizer = modelCapabilitySnapshotFromLiteLlmVersion({
  versionId: 'litellm_model_protocol_provider_managed_finalizer',
  checksum: `sha256:${'6'.repeat(64)}`,
  config: providerAwareConfig()
}, { finalizer: 'alias-glm' }, { finalizer: 'provider-managed' });
assert.equal(providerManagedFinalizer.stages.finalizer.protocolStatus, 'ready',
  'always-thinking GLM standard profile must be valid when Finalizer is explicitly provider-managed');
assert.equal(validateModelCapabilitySnapshot(providerManagedFinalizer).ok, true);

const disabledMain = modelCapabilitySnapshotFromLiteLlmVersion({
  versionId: 'litellm_model_protocol_disabled_main',
  checksum: `sha256:${'7'.repeat(64)}`,
  config: providerAwareConfig()
}, { main: 'alias-glm' }, { main: 'disabled' });
assert.equal(disabledMain.stages.main.protocolStatus, 'incompatible',
  'always-thinking GLM standard profile must reject an explicitly disabled Main policy');
assert.equal(validateModelCapabilitySnapshot(disabledMain).ok, false);

const ambiguous = modelCapabilitySnapshotFromLiteLlmVersion({
  versionId: 'litellm_model_protocol_ambiguous',
  checksum: `sha256:${'4'.repeat(64)}`,
  config: {
    schemaVersion: 2,
    providerConnections: [
      connection('connection-deepseek', 'deepseek-v4.v1'),
      connection('connection-glm', 'zai-glm.v1')
    ],
    modelDeployments: [
      protocolDeployment('deployment-deepseek', 'connection-deepseek', 'deepseek-v4-flash'),
      protocolDeployment('deployment-glm', 'connection-glm', 'glm-5.2')
    ],
    businessModelAliases: [alias('alias-mixed', 'ai-teacher-mixed', ['deployment-deepseek', 'deployment-glm'])]
  }
}, { main: 'alias-mixed' });
assert.equal(ambiguous.stages.main.protocolStatus, 'ambiguous');
assert.equal(validateModelCapabilitySnapshot(ambiguous).ok, false,
  '同一Alias混用不同Provider协议时不得冻结为可执行Run。');

console.log('AI Teacher model capability snapshot tests passed.');

function providerAwareConfig() {
  return {
    schemaVersion: 2,
    providerConnections: [
      connection('connection-deepseek', 'deepseek-v4.v1'),
      connection('connection-glm', 'zai-glm.v1')
    ],
    modelDeployments: [
      protocolDeployment('deployment-deepseek', 'connection-deepseek', 'deepseek-v4-flash'),
      protocolDeployment('deployment-glm', 'connection-glm', 'glm-5.3-flash')
    ],
    businessModelAliases: [
      alias('alias-deepseek', 'ai-teacher-deepseek', ['deployment-deepseek']),
      alias('alias-glm', 'ai-teacher-glm', ['deployment-glm'])
    ]
  };
}
function deployment(deploymentId, contextWindowTokens) {
  return {
    deploymentId,
    enabled: true,
    declaredCapabilities: { contextWindowTokens }
  };
}

function alias(aliasId, litellmAlias, deploymentIds) {
  return {
    aliasId,
    litellmAlias,
    members: deploymentIds.map((deploymentId) => ({ deploymentId }))
  };
}

function connection(connectionId, adapterProfileId) {
  return { connectionId, adapterProfileId, adapterProfileRevision: 1, enabled: true };
}

function protocolDeployment(deploymentId, connectionId, providerModelId) {
  return {
    deploymentId,
    connectionId,
    providerModelId,
    enabled: true,
    declaredCapabilities: { contextWindowTokens: 128000 }
  };
}
