'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAccountStore } = require('../apps/api/account-store');
const {
  defaultLiteLlmConfig,
  normalizeLiteLlmConfig,
  renderLiteLlmConfigYaml,
  validateLiteLlmConfig,
  publicLiteLlmConfigVersionForHistory
} = require('../apps/api/litellm-config');
const { assignServerControlPlaneIds, probeProviderConnection, publicAdapterProfileCatalog } = require('../apps/api/llm-control-plane');
const { findModelProtocolProfile, loadCatalog } = require('../apps/api/llm-adapter-catalog');
const {
  CAPABILITY_PROBE_LIMITS,
  assertCapabilityProbeConfirmation,
  runDeploymentCapabilityProbe
} = require('../apps/api/llm-capability-probe');

async function main() {
  testRenderDefaultConfig();
  testRejectRawSecrets();
  testControlPlaneSchemaV2();
  testProtocolCatalogGovernance();
  testZaiProviderProjection();
  testGlmProtocolFamilyCompatibility();
  testHistoricalVersionCompatibilityBoundary();
  testManagedCredentialConfig();
  await testControlPlaneProbeSecretGate();
  await testDeploymentCapabilityProbe();
  await testCapabilityProbeJudgementBoundaries();
  await testManagedCredentialCapabilityProbe();
  await testMemoryConfigVersions();
  await testMemoryCapabilityProbeRuns();
  console.log('litellm config tests passed');
}

function testHistoricalVersionCompatibilityBoundary() {
  const incompatibleConfig = glmControlPlaneFixture();
  incompatibleConfig.modelDeployments[0].providerModelId = 'glm-5.3';
  delete incompatibleConfig.modelDeployments[0].modelProtocolProfileId;
  const historical = publicLiteLlmConfigVersionForHistory({
    versionId: 'litellm_cfg_historical_incompatible',
    status: 'draft',
    config: incompatibleConfig,
    checksum: 'historical-checksum',
    createdAt: '2026-08-01T00:00:00.000Z'
  });
  assert.strictEqual(historical.status, 'incompatible');
  assert.strictEqual(historical.storedStatus, 'draft');
  assert.strictEqual(historical.migrationRequired, true);
  assert.strictEqual(historical.config, null, '不兼容历史版本不得把未验证配置重新暴露为可执行草稿');
  assert.strictEqual(historical.validation.errors[0].code, 'LITELLM_MODEL_PROTOCOL_PROFILE_REQUIRED');
}

function testProtocolCatalogGovernance() {
  const catalogPath = path.join(__dirname, '..', 'config', 'llm-protocol-catalog.json');
  const apiDockerfilePath = path.join(__dirname, '..', 'apps', 'api', 'Dockerfile');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const apiDockerfile = fs.readFileSync(apiDockerfilePath, 'utf8');
  assert.match(
    apiDockerfile,
    /^COPY config\/llm-protocol-catalog\.json \.\/config\/llm-protocol-catalog\.json$/m,
    'API Docker镜像必须包含协议Catalog，避免源码通过但容器启动失败',
  );
  const adapterIds = new Set(catalog.adapterProfiles.map((profile) => profile.profileId));
  for (const required of ['deepseek-v4.v1', 'zai-glm.v1', 'moonshot.v1', 'openai.v1', 'anthropic.v1']) {
    assert(adapterIds.has(required), `protocol catalog must include ${required}`);
  }
  assert(catalog.modelProtocolProfiles.some((profile) => profile.profileId === 'claude-manual-thinking.v1'));
  assert(catalog.modelProtocolProfiles.some((profile) => profile.profileId === 'claude-adaptive-thinking.v1'));

  const configurable = JSON.parse(JSON.stringify(catalog));
  configurable.catalogVersion = 'test-config-only-model-addition';
  configurable.modelProtocolProfiles.find((profile) => profile.profileId === 'openai-chat.v1')
    .recommendedModelIds.push('future-openai-chat-test');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-protocol-catalog-test-'));
  const tmpCatalog = path.join(tmpDir, 'catalog.json');
  try {
    fs.writeFileSync(tmpCatalog, `${JSON.stringify(configurable, null, 2)}\n`, 'utf8');
    const loaded = loadCatalog(tmpCatalog);
    assert(loaded.modelProtocolProfiles.some((profile) => (
      profile.profileId === 'openai-chat.v1'
      && profile.recommendedModelIds.includes('future-openai-chat-test')
    )), 'a compatible model addition must be accepted through catalog data without source changes');

    const unsafe = JSON.parse(JSON.stringify(configurable));
    unsafe.modelProtocolProfiles[0].executionPolicy.reasoning.enabled.providerOptions.apiKey = 'forbidden';
    fs.writeFileSync(tmpCatalog, `${JSON.stringify(unsafe, null, 2)}\n`, 'utf8');
    assert.throws(() => loadCatalog(tmpCatalog), (error) => error?.code === 'LLM_PROTOCOL_PROVIDER_OPTION_UNSUPPORTED');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testManagedCredentialConfig() {
  const config = controlPlaneFixture();
  config.providerConnections[0].credentialRef = { kind: 'litellm_credential', referenceName: 'deepseek-production' };
  const normalized = normalizeLiteLlmConfig(config);
  assert.strictEqual(normalized.modelGroups[0].deployments[0].litellmCredentialName, 'deepseek-production');
  assert.strictEqual(normalized.modelGroups[0].deployments[0].apiKeyEnv, '');
  const yaml = renderLiteLlmConfigYaml(config, { modelOwner: 'static' });
  assert(yaml.includes('litellm_credential_name: deepseek-production'));
  assert(!yaml.includes('api_key: os.environ/CONTROL_PLANE_TEST_KEY'));
  const invalid = JSON.parse(JSON.stringify(config));
  invalid.providerConnections[0].credentialRef.referenceName = 'invalid credential name';
  assert.strictEqual(validateLiteLlmConfig(invalid).ok, false);
}

function testControlPlaneSchemaV2() {
  const config = controlPlaneFixture();
  const validation = validateLiteLlmConfig(config);
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.errors));
  const normalized = normalizeLiteLlmConfig(config);
  assert.strictEqual(normalized.schemaVersion, 2);
  assert.strictEqual(normalized.modelGroups[0].modelName, 'ai-teacher-reasoning');
  assert.strictEqual(normalized.modelGroups[0].deployments[0].deploymentId, 'deployment-deepseek-pro');
  const yaml = renderLiteLlmConfigYaml(config, { modelOwner: 'static' });
  assert(yaml.includes('api_base: https://api.deepseek.com'));
  assert(yaml.includes('api_key: os.environ/CONTROL_PLANE_TEST_KEY'));
  assert(yaml.includes('model: deepseek/deepseek-v4-pro'));
  assert(!yaml.includes('secret-material'));
  const dynamicOwnerYaml = renderLiteLlmConfigYaml(config, { modelOwner: 'dynamic' });
  assert(dynamicOwnerYaml.startsWith('model_list: []\n'));
  assert(!dynamicOwnerYaml.includes('model_name:'), 'dynamic runtime ownership must not recreate static business aliases after restart');
  assert(dynamicOwnerYaml.includes('router_settings:'));
  assert(dynamicOwnerYaml.includes('database_url: os.environ/LITELLM_DATABASE_URL'));
  assert.throws(
    () => renderLiteLlmConfigYaml(config, { modelOwner: 'invalid-owner' }),
    (error) => error.code === 'LITELLM_RUNTIME_MODEL_OWNER_INVALID'
  );

  const invalid = JSON.parse(JSON.stringify(config));
  invalid.modelDeployments[0].connectionId = 'connection-missing';
  assert.strictEqual(validateLiteLlmConfig(invalid).ok, false, 'v2 validation must reject orphan deployments');

  const unknownProfile = JSON.parse(JSON.stringify(config));
  unknownProfile.providerConnections[0].adapterProfileId = 'unmanaged-provider.v1';
  assert.strictEqual(validateLiteLlmConfig(unknownProfile).ok, false, 'v2 validation must reject profiles outside the governed catalog');

  const unsupportedCapability = JSON.parse(JSON.stringify(config));
  unsupportedCapability.providerConnections[0].adapterProfileId = 'openai.v1';
  unsupportedCapability.modelDeployments[0].declaredCapabilities.supportsThinking = true;
  assert.strictEqual(validateLiteLlmConfig(unsupportedCapability).ok, false, 'v2 validation must reject declarations unsupported by the selected profile');

  const untestedGateway = JSON.parse(JSON.stringify(config));
  untestedGateway.general.gatewayRuntime = {
    contract: 'gateway-chat.v1',
    implementation: 'litellm',
    version: 'latest',
    image: 'ghcr.io/berriai/litellm:main-latest'
  };
  assert(validateLiteLlmConfig(untestedGateway).errors.includes('LITELLM_GATEWAY_RUNTIME_UNTESTED'),
    'an unpinned or untested gateway runtime must invalidate protocol evidence');

  const temporary = JSON.parse(JSON.stringify(config));
  temporary.providerConnections[0].connectionId = 'draft-connection-1';
  temporary.modelDeployments[0].connectionId = 'draft-connection-1';
  temporary.modelDeployments[0].deploymentId = 'draft-deployment-1';
  temporary.businessModelAliases[0].members[0].deploymentId = 'draft-deployment-1';
  const assigned = assignServerControlPlaneIds(temporary);
  assert(assigned.providerConnections[0].connectionId.startsWith('connection_'));
  assert(assigned.modelDeployments[0].deploymentId.startsWith('deployment_'));
  assert.strictEqual(assigned.modelDeployments[0].connectionId, assigned.providerConnections[0].connectionId);
  assert.strictEqual(assigned.businessModelAliases[0].members[0].deploymentId, assigned.modelDeployments[0].deploymentId);
  const renamed = JSON.parse(JSON.stringify(config));
  renamed.businessModelAliases[0].litellmAlias = 'ai-teacher-reasoning-renamed';
  const renamedAssigned = assignServerControlPlaneIds(renamed, config);
  assert.strictEqual(renamedAssigned.businessModelAliases[0].aliasId, config.businessModelAliases[0].aliasId,
    'renaming the mutable LiteLLM route must preserve immutable Alias identity');
  const identityMutation = JSON.parse(JSON.stringify(config));
  identityMutation.businessModelAliases[0].aliasId = 'alias-client-mutated';
  assert.throws(() => assignServerControlPlaneIds(identityMutation, config), (error) => error?.code === 'LITELLM_ALIAS_ID_IMMUTABLE');
  assert(publicAdapterProfileCatalog().profiles.some((profile) => profile.profileId === 'deepseek-v4.v1'));
  assert(publicAdapterProfileCatalog().profiles.some((profile) => profile.profileId === 'zai-glm.v1'));
  assert(publicAdapterProfileCatalog().profiles.some((profile) => profile.profileId === 'anthropic.v1'));
  assert(publicAdapterProfileCatalog().modelProtocolProfiles.some((profile) => profile.profileId === 'glm-5.2-chat.v1'));
  assert(publicAdapterProfileCatalog().modelProtocolProfiles.some((profile) => profile.profileId === 'glm-5.3-standard-chat.v1'));
  assert.strictEqual(publicAdapterProfileCatalog().gatewayContract.testedVersion, '1.90.0');
}

function testZaiProviderProjection() {
  const config = glmControlPlaneFixture();
  const normalized = normalizeLiteLlmConfig(config);
  assert.strictEqual(normalized.modelGroups[0].deployments[0].model, 'zai/glm-5.2');
  assert(renderLiteLlmConfigYaml(config, { modelOwner: 'static' }).includes('model: zai/glm-5.2'));
}

function testGlmProtocolFamilyCompatibility() {
  const glm52 = findModelProtocolProfile('zai-glm.v1', 'glm-5.2');
  const glm53Flash = findModelProtocolProfile('zai-glm.v1', 'glm-5.3-flash');
  const futureGlm5Minor = findModelProtocolProfile('zai-glm.v1', 'glm-5.10-air');
  assert.strictEqual(glm52?.profileId, 'glm-5.2-chat.v1');
  assert.strictEqual(glm52?.revision, 4,
    'GLM non-thinking control changes must invalidate older capability evidence.');
  assert.strictEqual(glm53Flash?.profileId, 'glm-5.3-standard-chat.v1');
  assert.strictEqual(glm53Flash?.executionPolicy.reasoning.disabled.supported, false,
    'GLM-5.3 standard API must not receive a fabricated disabled-thinking branch.');
  assert.strictEqual(futureGlm5Minor, null,
    'unknown future models require a catalog binding instead of family-name inference');
  assert.strictEqual(
    findModelProtocolProfile('zai-glm-coding.v1', 'glm-5.3-flash')?.profileId,
    'glm-5.3-coding-chat.v1',
    'standard and coding endpoints must keep distinct protocol profiles'
  );
  assert.strictEqual(findModelProtocolProfile('zai-glm.v1', 'glm-5.1'), null,
    'models outside the confirmed 5.2+ family must not be silently upgraded');
  assert.strictEqual(findModelProtocolProfile('openai-compatible-public.v1', 'glm-5.3-flash'), null,
    'model names must not bypass the selected Provider Adapter boundary');
}

async function testControlPlaneProbeSecretGate() {
  const previous = process.env.CONTROL_PLANE_TEST_KEY;
  delete process.env.CONTROL_PLANE_TEST_KEY;
  try {
    const result = await probeProviderConnection(controlPlaneFixture().providerConnections[0]);
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.errorCode, 'LITELLM_PROBE_SECRET_MISSING');
    assert(!JSON.stringify(result).includes('secret-material'));

    const disabledConnection = controlPlaneFixture().providerConnections[0];
    disabledConnection.enabled = false;
    const disabledResult = await probeProviderConnection(disabledConnection);
    assert.strictEqual(disabledResult.status, 'blocked');
    assert.strictEqual(disabledResult.errorCode, 'LITELLM_PROBE_SECRET_MISSING');
    assert.strictEqual(disabledConnection.enabled, false, 'probe normalization must not mutate publication state');

    disabledConnection.credentialRef = { kind: 'litellm_credential', referenceName: 'disabled-probe-credential' };
    const managedResult = await probeProviderConnection(disabledConnection);
    assert.strictEqual(managedResult.status, 'blocked');
    assert.strictEqual(managedResult.errorCode, 'LITELLM_PROBE_MODEL_REQUIRED');
  } finally {
    if (previous === undefined) delete process.env.CONTROL_PLANE_TEST_KEY;
    else process.env.CONTROL_PLANE_TEST_KEY = previous;
  }
}

async function testDeploymentCapabilityProbe() {
  assert.throws(
    () => assertCapabilityProbeConfirmation({ confirmed: true, maxProviderCalls: 7, maxTotalOutputTokens: 768, maxDurationMs: 90000 }),
    (error) => error.code === 'LITELLM_CAPABILITY_PROBE_CONFIRMATION_REQUIRED'
  );
  assert.doesNotThrow(() => assertCapabilityProbeConfirmation({
    confirmed: true,
    maxProviderCalls: CAPABILITY_PROBE_LIMITS.maxProviderCalls,
    maxTotalOutputTokens: CAPABILITY_PROBE_LIMITS.maxTotalOutputTokens,
    maxDurationMs: CAPABILITY_PROBE_LIMITS.maxDurationMs
  }));

  const calls = [];
  const providerFetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    if (body.response_format) return probeJsonResponse({ probe: true });
    const toolResult = body.messages.find((message) => message.role === 'tool');
    if (toolResult) {
      const token = JSON.parse(toolResult.content).token;
      return probeJsonResponse(token);
    }
    if (body.tools) {
      const message = {
        content: '',
        tool_calls: [{ id: `call-${calls.length}`, type: 'function', function: { name: 'get_probe_token', arguments: '{}' } }]
      };
      if ((body.thinking || body.extra_body?.thinking)?.type === 'enabled') message.reasoning_content = 'private structural fixture';
      return probeJsonResponse('', message);
    }
    if ((body.thinking || body.extra_body?.thinking)?.type === 'enabled') return probeJsonResponse('4', { content: '4', reasoning_content: 'private structural fixture' });
    return probeJsonResponse('OK');
  };
  const fetchImpl = gatewayProbeFetch(providerFetch);
  const run = await runDeploymentCapabilityProbe(controlPlaneFixture(), 'deployment-deepseek-pro', {
    fetchImpl,
    baseUrl: 'http://litellm.test',
    masterKey: 'test-master-key',
    env: {}
  });
  assert.strictEqual(run.status, 'passed', JSON.stringify(run));
  assert.strictEqual(run.executionPath, 'litellm_gateway');
  assert.strictEqual(run.usage.providerCalls, 8);
  assert(calls.length <= CAPABILITY_PROBE_LIMITS.maxProviderCalls);
  assert(Object.values(run.results).every((result) => result.status === 'passed'), JSON.stringify(run.results));
  const deepSeekThinkingToolCalls = calls.filter((body) => body.tools && body.thinking?.type === 'enabled');
  assert.strictEqual(deepSeekThinkingToolCalls.length, 4);
  assert(deepSeekThinkingToolCalls.every((body) => !Object.hasOwn(body, 'tool_choice')), 'DeepSeek Thinking Tool requests must omit tool_choice');
  const deepSeekContinuation = deepSeekThinkingToolCalls.find((body) => body.messages.some((message) => message.role === 'tool'));
  const replayedAssistant = deepSeekContinuation.messages.find((message) => message.role === 'assistant');
  assert.strictEqual(replayedAssistant.content, '');
  assert.strictEqual(replayedAssistant.reasoning_content, 'private structural fixture');
  assert(calls.every((body) => body.thinking?.type === 'enabled'),
    'orthogonal probes must preserve the profile default reasoning mode');
  const publicEvidence = JSON.stringify(run);
  assert(!publicEvidence.includes('private structural fixture'), 'probe evidence must not persist reasoning content');
  assert(!publicEvidence.includes('tool continuation complete'), 'probe evidence must not persist provider response content');

  const blocked = await runDeploymentCapabilityProbe(controlPlaneFixture(), 'deployment-deepseek-pro', {
    fetchImpl: providerFetch,
    env: {}
  });
  assert.strictEqual(blocked.status, 'blocked');
  assert.strictEqual(blocked.errorCode, 'LITELLM_MANAGED_PROBE_MODEL_CREATE_FAILED');
  assert.strictEqual(blocked.usage.providerCalls, 0);

  const glmCalls = [];
  const glmFetch = async (url, options = {}) => {
    const body = JSON.parse(options.body);
    glmCalls.push(body);
    return fetchImpl(url, options);
  };
  const glmRun = await runDeploymentCapabilityProbe(glmControlPlaneFixture(), 'deployment-glm-5-2', {
    fetchImpl: gatewayProbeFetch(glmFetch),
    baseUrl: 'http://litellm.test',
    masterKey: 'test-master-key',
    env: {}
  });
  assert.strictEqual(glmRun.status, 'passed', JSON.stringify(glmRun));
  const glmThinkingToolCalls = glmCalls.filter((body) => body.tools && body.extra_body?.thinking?.type === 'enabled');
  assert.strictEqual(glmThinkingToolCalls.length, 4);
  assert.strictEqual(glmThinkingToolCalls[0].tool_choice, 'auto');
  assert(glmThinkingToolCalls.filter((body) => body.messages.some((message) => message.role === 'tool'))
    .every((body) => !Object.hasOwn(body, 'tool_choice')));
  assert(glmThinkingToolCalls.every((body) => body.extra_body.thinking.clear_thinking === false));
  assert(glmCalls.every((body) => body.extra_body?.thinking?.type === 'enabled'),
    'GLM probes must not couple streaming/tool/structured-output checks to disabled thinking');
  assert.strictEqual(glmCalls[0].max_tokens, CAPABILITY_PROBE_LIMITS.baseGenerationMaxOutputTokens,
    '基础生成必须为强制思考模型预留足够的有界最终答案空间');
  assert(
    CAPABILITY_PROBE_LIMITS.baseGenerationMaxOutputTokens
      + 16
      + (CAPABILITY_PROBE_LIMITS.maxOutputTokensPerCall * 5)
      + CAPABILITY_PROBE_LIMITS.structuredOutputMaxOutputTokens
      <= CAPABILITY_PROBE_LIMITS.maxTotalOutputTokens,
    '各能力调用的理论输出上限不得超过整轮确认预算',
  );

  const glm53Config = glmControlPlaneFixture();
  glm53Config.modelDeployments[0].providerModelId = 'glm-5.3-flash';
  const glm53Run = await runDeploymentCapabilityProbe(glm53Config, 'deployment-glm-5-2', {
    fetchImpl,
    baseUrl: 'http://litellm.test',
    masterKey: 'test-master-key',
    env: {}
  });
  assert.strictEqual(glm53Run.status, 'passed',
    'GLM-5.3-Flash must enter the real capability suite through the compatible protocol family.');
  assert.strictEqual(glm53Run.usage.providerCalls, CAPABILITY_PROBE_LIMITS.maxProviderCalls);
  assert.strictEqual(
    glmCalls.find((body) => body.response_format)?.max_tokens,
    CAPABILITY_PROBE_LIMITS.structuredOutputMaxOutputTokens,
    '强制思考模型的Structured Output必须拥有独立且有界的最终JSON空间',
  );
}

async function testCapabilityProbeJudgementBoundaries() {
  const thinkingUsageConfig = controlPlaneFixture();
  thinkingUsageConfig.modelDeployments[0].declaredCapabilities = {
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsThinking: true,
    supportsThinkingWithTools: false,
    supportsStructuredOutput: false,
    reportsUsage: false
  };
  let thinkingUsageCall = 0;
  const thinkingUsageRun = await runDeploymentCapabilityProbe(thinkingUsageConfig, 'deployment-deepseek-pro', {
    fetchImpl: gatewayProbeFetch(async () => {
      thinkingUsageCall += 1;
      if (thinkingUsageCall === 1) return probeJsonResponse('OK');
      return probeJsonResponse('703', null, {
        prompt_tokens: 8,
        completion_tokens: 4,
        total_tokens: 12,
        completion_tokens_details: { reasoning_tokens: 3 }
      });
    }),
    baseUrl: 'http://litellm.test',
    masterKey: 'test-master-key',
    env: {}
  });
  assert.strictEqual(thinkingUsageRun.results.thinking.status, 'passed',
    'Provider明确报告reasoning tokens时，不应要求每次都返回可见reasoning_content');

  const usageConfig = controlPlaneFixture();
  usageConfig.modelDeployments[0].declaredCapabilities = {
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsThinking: false,
    supportsThinkingWithTools: false,
    supportsStructuredOutput: false,
    reportsUsage: true
  };
  const usageRun = await runDeploymentCapabilityProbe(usageConfig, 'deployment-deepseek-pro', {
    fetchImpl: gatewayProbeFetch(async () => probeJsonResponse('', { content: '', reasoning_content: 'bounded reasoning' })),
    baseUrl: 'http://litellm.test',
    masterKey: 'test-master-key',
    env: {}
  });
  assert.strictEqual(usageRun.baseProbe.status, 'failed');
  assert.strictEqual(usageRun.baseProbe.errorCode, 'LITELLM_CAPABILITY_MINIMAL_EMPTY');
  assert.strictEqual(usageRun.results.usage.status, 'passed', 'Usage evidence must not inherit an unrelated empty-content failure');
  assert.strictEqual(usageRun.status, 'failed', 'The minimal generation gate must remain independent from Usage evidence');

  const structuredConfig = controlPlaneFixture();
  structuredConfig.modelDeployments[0].declaredCapabilities = {
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsThinking: false,
    supportsThinkingWithTools: false,
    supportsStructuredOutput: true,
    reportsUsage: false
  };
  let structuredCall = 0;
  const structuredRun = await runDeploymentCapabilityProbe(structuredConfig, 'deployment-deepseek-pro', {
    fetchImpl: gatewayProbeFetch(async () => {
      structuredCall += 1;
      if (structuredCall === 1) return probeJsonResponse('OK');
      return probeJsonResponseWithFinishReason('{', 'length', { reasoning_tokens: CAPABILITY_PROBE_LIMITS.maxOutputTokensPerCall - 1 });
    }),
    baseUrl: 'http://litellm.test',
    masterKey: 'test-master-key',
    env: {}
  });
  assert.strictEqual(structuredRun.results.structured_output.status, 'inconclusive');
  assert.strictEqual(structuredRun.results.structured_output.errorCode, 'LITELLM_CAPABILITY_STRUCTURED_OUTPUT_LIMIT');
  assert.strictEqual(structuredRun.status, 'inconclusive');

  const thinkingToolConfig = controlPlaneFixture();
  thinkingToolConfig.modelDeployments[0].declaredCapabilities = {
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsThinking: false,
    supportsThinkingWithTools: true,
    supportsStructuredOutput: false,
    reportsUsage: false
  };
  let thinkingToolCall = 0;
  const thinkingToolRun = await runDeploymentCapabilityProbe(thinkingToolConfig, 'deployment-deepseek-pro', {
    fetchImpl: gatewayProbeFetch(async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      thinkingToolCall += 1;
      if (thinkingToolCall === 1) return probeJsonResponse('OK');
      const toolResult = body.messages.find((message) => message.role === 'tool');
      if (toolResult) {
        const replayedAssistant = body.messages.find((message) => message.role === 'assistant');
        assert(!Object.hasOwn(replayedAssistant, 'reasoning_content'), 'Absent Provider reasoning must remain absent during continuation replay');
        return probeJsonResponse(JSON.parse(toolResult.content).token);
      }
      return probeJsonResponse('', {
        content: '',
        tool_calls: [{ id: 'call-without-reasoning', type: 'function', function: { name: 'get_probe_token', arguments: '{}' } }]
      });
    }),
    baseUrl: 'http://litellm.test',
    masterKey: 'test-master-key',
    env: {}
  });
  assert.strictEqual(thinkingToolRun.results.thinking_tool.status, 'passed', 'Thinking Tool compatibility must not require reasoning text on every Tool Call');
  assert.strictEqual(thinkingToolRun.status, 'passed');
}

async function testManagedCredentialCapabilityProbe() {
  const config = glmControlPlaneFixture();
  config.providerConnections[0].credentialRef = { kind: 'litellm_credential', referenceName: 'glm-production' };
  const lifecycle = [];
  const providerBodies = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    if (path === '/model/new') {
      lifecycle.push('create');
      assert.strictEqual(body.litellm_params.litellm_credential_name, 'glm-production');
      assert.strictEqual(body.litellm_params.model, 'zai/glm-5.2');
      assert(!Object.hasOwn(body.litellm_params, 'api_key'));
      return new Response(JSON.stringify({ model_info: { id: body.model_info.id } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/model/delete') {
      lifecycle.push('delete');
      return new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/v1/chat/completions') {
      providerBodies.push(body);
      assert.deepStrictEqual(body.extra_body?.thinking, body.reasoning_effort === 'high'
        ? { type: 'enabled', clear_thinking: false }
        : { type: 'disabled' });
      const expectedAllowedParams = [];
      if (body.reasoning_effort) expectedAllowedParams.push('reasoning_effort');
      if (body.response_format) expectedAllowedParams.push('response_format');
      assert.deepStrictEqual(body.allowed_openai_params || [], expectedAllowedParams);
      assert(!Object.hasOwn(body, 'thinking'));
      if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      if (body.response_format) return probeJsonResponse({ probe: true });
      const toolResult = body.messages.find((message) => message.role === 'tool');
      if (toolResult) return probeJsonResponse(JSON.parse(toolResult.content).token);
      if (body.tools) {
        const message = { content: '', tool_calls: [{ id: 'call-managed', type: 'function', function: { name: 'get_probe_token', arguments: '{}' } }] };
        if (body.extra_body?.thinking?.type === 'enabled') message.reasoning_content = 'managed structural fixture';
        return probeJsonResponse('', message);
      }
      if (body.extra_body?.thinking?.type === 'enabled') return probeJsonResponse('4', { content: '4', reasoning_content: 'managed structural fixture' });
      return probeJsonResponse('OK');
    }
    throw new Error(`unexpected managed probe URL ${url}`);
  };
  const run = await runDeploymentCapabilityProbe(config, 'deployment-glm-5-2', {
    fetchImpl,
    baseUrl: 'http://litellm.test',
    masterKey: 'test-master-key',
    env: {}
  });
  assert.strictEqual(run.status, 'passed', JSON.stringify(run));
  assert.deepStrictEqual(lifecycle, ['create', 'delete']);
  assert.strictEqual(providerBodies.length, CAPABILITY_PROBE_LIMITS.maxProviderCalls);
  assert(providerBodies.every((body) => String(body.model).startsWith('sysml-probe-')));
  assert(!JSON.stringify(run).includes('sysml-probe-'));
}

function probeJsonResponse(content, messageOverride = null, usageOverride = null) {
  const message = messageOverride || { content: typeof content === 'string' ? content : JSON.stringify(content) };
  return new Response(JSON.stringify({
    choices: [{ message, finish_reason: 'stop' }],
    usage: usageOverride || { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function gatewayProbeFetch(providerFetch) {
  return async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    const body = options.body ? JSON.parse(options.body) : {};
    if (pathname === '/model/new') {
      assert.strictEqual(body.litellm_params.api_key, 'os.environ/CONTROL_PLANE_TEST_KEY');
      assert(!Object.hasOwn(body.litellm_params, 'litellm_credential_name'));
      return new Response(JSON.stringify({ model_info: { id: body.model_info.id } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (pathname === '/model/delete') {
      return new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (pathname === '/v1/chat/completions') return providerFetch(url, options);
    throw new Error(`unexpected gateway probe URL ${url}`);
  };
}

function probeJsonResponseWithFinishReason(content, finishReason, completionTokensDetails = {}) {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: {
      prompt_tokens: 3,
      completion_tokens: CAPABILITY_PROBE_LIMITS.maxOutputTokensPerCall,
      total_tokens: CAPABILITY_PROBE_LIMITS.maxOutputTokensPerCall + 3,
      completion_tokens_details: completionTokensDetails
    }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function controlPlaneFixture() {
  return {
    schemaVersion: 2,
    providerConnections: [{
      connectionId: 'connection-deepseek-production',
      displayName: 'DeepSeek 生产连接',
      enabled: true,
      adapterProfileId: 'deepseek-v4.v1',
      adapterProfileRevision: 1,
      endpoint: { scheme: 'https', host: 'api.deepseek.com', port: 443, basePath: '' },
      networkZone: 'public_provider',
      credentialRef: { kind: 'environment', referenceName: 'CONTROL_PLANE_TEST_KEY' },
      tlsPolicy: 'verify_full',
      metadata: { owner: 'AI Teacher', purpose: 'test' }
    }],
    modelDeployments: [{
      deploymentId: 'deployment-deepseek-pro',
      connectionId: 'connection-deepseek-production',
      displayName: 'DeepSeek V4 Pro',
      providerModelId: 'deepseek-v4-pro',
      enabled: true,
      limits: { rpm: 60, tpm: 120000, maxParallelRequests: 2 },
      declaredCapabilities: { supportsStreaming: true, supportsToolCalling: true, supportsThinking: true, supportsThinkingWithTools: true, supportsStructuredOutput: true, reportsUsage: true }
    }],
    businessModelAliases: [{
      aliasId: 'alias-ai-teacher-reasoning',
      litellmAlias: 'ai-teacher-reasoning',
      displayName: '推理模型',
      enabled: true,
      members: [{ deploymentId: 'deployment-deepseek-pro', priority: 1, weight: 100 }],
      routing: { strategy: 'simple-shuffle', numRetries: 1, allowedFails: 5, cooldownTimeSeconds: 30 }
    }],
    general: { masterKeyEnv: 'LITELLM_MASTER_KEY', databaseUrlEnv: 'LITELLM_DATABASE_URL' }
  };
}

function glmControlPlaneFixture() {
  const config = controlPlaneFixture();
  config.providerConnections[0].adapterProfileId = 'zai-glm.v1';
  config.providerConnections[0].displayName = 'GLM 生产连接';
  config.providerConnections[0].endpoint.host = 'open.bigmodel.cn';
  config.modelDeployments[0].deploymentId = 'deployment-glm-5-2';
  config.modelDeployments[0].displayName = 'GLM-5.2';
  config.modelDeployments[0].providerModelId = 'glm-5.2';
  config.businessModelAliases[0].members[0].deploymentId = 'deployment-glm-5-2';
  return config;
}

function testRenderDefaultConfig() {
  const config = defaultLiteLlmConfig();
  const validation = validateLiteLlmConfig(config);
  assert.strictEqual(validation.ok, true, JSON.stringify(validation.errors));
  const yaml = renderLiteLlmConfigYaml(config);
  assert(yaml.includes('model_name: ai-teacher-reasoning'));
  assert(yaml.includes('model_name: ai-teacher-fast'));
  assert(yaml.includes('model: deepseek/deepseek-v4-pro'));
  assert(yaml.includes('model: deepseek/deepseek-v4-flash'));
  assert(!yaml.includes('deepseek-chat'));
  assert(yaml.includes('api_key: os.environ/DEEPSEEK_API_KEY_1'));
  assert(yaml.includes('api_base: os.environ/DEEPSEEK_API_BASE'));
  assert(yaml.includes('master_key: os.environ/LITELLM_MASTER_KEY'));
  assert(!yaml.includes('sk-'), 'rendered config must not contain raw API keys');
}

function testRejectRawSecrets() {
  assert.throws(() => normalizeLiteLlmConfig({
    modelGroups: [{
      modelName: 'ai-teacher-reasoning',
      deployments: [{
        enabled: true,
        model: 'openai/deepseek-v4-flash',
        apiKey: 'sk-should-not-be-here'
      }]
    }]
  }), /raw API keys|LITELLM_CONFIG_RAW_SECRET_REJECTED/);
}

async function testMemoryConfigVersions() {
  const store = createAccountStore();
  const active = await store.getActiveLiteLlmConfigVersion({ includeRenderedYaml: true });
  assert(active.versionId, 'default active config version should be seeded');
  assert.strictEqual(active.status, 'active');
  assert(active.renderedYaml.includes('model_list:'));
  assert(!JSON.stringify(active).includes('sk-'));

  const custom = await store.createLiteLlmConfigVersion({
    createdBy: 'test-suite',
    notes: 'draft config',
    config: {
      schemaVersion: 1,
      modelGroups: [{
        modelName: 'ai-teacher-reasoning',
        deployments: [{
          deploymentId: 'fake-provider',
          enabled: true,
          provider: 'openai-compatible',
          model: 'openai/fake-model',
          apiBaseEnv: 'FAKE_API_BASE',
          apiKeyEnv: 'FAKE_API_KEY',
          rpm: 5,
          tpm: 1000,
          maxParallelRequests: 2
        }],
        router: { routingStrategy: 'simple-shuffle', numRetries: 0, allowedFails: 1, cooldownTime: 3 },
        fallbacks: []
      }],
      general: { masterKeyEnv: 'LITELLM_MASTER_KEY', databaseUrlEnv: 'LITELLM_DATABASE_URL' }
    }
  });
  assert.strictEqual(custom.status, 'draft');
  assert(custom.renderedYaml.includes('max_parallel_requests: 2'));
  const published = await store.publishLiteLlmConfigVersion({ versionId: custom.versionId, actorUserId: 'test-suite' });
  assert.strictEqual(published.status, 'active');
  const nextActive = await store.getActiveLiteLlmConfigVersion();
  assert.strictEqual(nextActive.versionId, custom.versionId);
}

async function testMemoryCapabilityProbeRuns() {
  const store = createAccountStore();
  const recorded = await store.recordLiteLlmCapabilityProbeRun({
    versionId: 'litellm_cfg_test',
    configChecksum: 'checksum-test',
    actorUserId: 'test-suite',
    run: {
      deploymentId: 'deployment-deepseek-pro',
      sourceDigest: 'source-digest-test',
      status: 'passed',
      readiness: 'ready',
      declaredCapabilities: { streaming: true },
      baseProbe: { id: 'minimal_generation', status: 'passed' },
      results: { streaming: { status: 'passed' } },
      budget: CAPABILITY_PROBE_LIMITS,
      usage: { providerCalls: 2, totalTokens: 10 },
      evidenceDigest: 'evidence-digest-test',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString(),
      durationMs: 1
    }
  });
  assert(recorded.probeRunId.startsWith('litellm_probe_'));
  const latest = await store.findLatestLiteLlmCapabilityProbeRun({ deploymentId: 'deployment-deepseek-pro', sourceDigest: 'source-digest-test' });
  assert.strictEqual(latest.probeRunId, recorded.probeRunId);
  const listed = await store.listLiteLlmCapabilityProbeRuns({ versionId: 'litellm_cfg_test' });
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].status, 'passed');
}

async function testPublisherDryRunAndApply() {
  const dryRun = await publishLiteLlmConfig({});
  assert.strictEqual(dryRun.applied, false);
  assert(dryRun.renderedYaml.includes('model_list:'));
  assert(dryRun.summary.modelGroups.some((group) => group.modelName === 'ai-teacher-reasoning'));
  assert(dryRun.summary.modelGroups.some((group) => group.modelName === 'ai-teacher-fast'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'litellm-config-test-'));
  const outputPath = path.join(tmpDir, 'config.yaml');
  const applied = await publishLiteLlmConfig({ apply: true, outputPath });
  assert.strictEqual(applied.applied, true);
  const written = fs.readFileSync(outputPath, 'utf8');
  assert.strictEqual(written, applied.renderedYaml);
  assert(written.includes('database_url: os.environ/LITELLM_DATABASE_URL'));
  const dynamicOutputPath = path.join(tmpDir, 'dynamic-config.yaml');
  const dynamic = await publishLiteLlmConfig({ apply: true, outputPath: dynamicOutputPath, runtimeOwner: 'dynamic' });
  assert.strictEqual(dynamic.summary.runtimeOwner, 'dynamic');
  const dynamicWritten = fs.readFileSync(dynamicOutputPath, 'utf8');
  assert(dynamicWritten.startsWith('model_list: []\n'));
  assert(!dynamicWritten.includes('model_name:'));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
