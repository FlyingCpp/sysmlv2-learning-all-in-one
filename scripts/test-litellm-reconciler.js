'use strict';

const assert = require('assert');

const {
  MANAGED_BY,
  buildLiteLlmDesiredState,
  observeLiteLlmRuntime,
  reconcileLiteLlmRuntime,
  validateLiteLlmReferenceClosure
} = require('../apps/api/litellm-reconciler');

async function main() {
  await testUnknownConfigUpdateCannotBecomeApplied();
  testProductionTopologyReferenceClosureBlocksAliasDriftAndOrphans();
  await testStaticAliasOwnershipConflictRequiresRestartBeforeWrites();
  await testDelayedReadbackConvergesBeforeActivation();
  await testHttp200NoOpNeverBecomesObserved();
  await testHealthyGatewayWithMissingAliasIsDrift();
  await testReadbackFailureCompensatesRuntime();
  await testRouterSettingsEnvelopeAndEmptyDefaultAreNormalized();
  await testRedactedEnvironmentCredentialReadbackMatchesManagedBinding();
  await testLegacyEnvironmentCredentialIsReplacedWithoutDeletingOldModel();
  await testEnvironmentCredentialIsReplacedWhenSwitchingToManagedCredential();
  await testMatchingReadbackSucceedsAndIsIdempotent();
  await testAliasCanaryFailureCompensatesRuntime();
  await testUnrelatedModelsArePreserved();
  console.log('litellm reconciler tests passed');
}

async function testAliasCanaryFailureCompensatesRuntime() {
  const desired = buildLiteLlmDesiredState(versionFixture());
  const client = statefulClient({ failCanaryAlias: desired.aliases[0] });
  const result = await reconcileLiteLlmRuntime(client, desired, fastHooks());
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, 'LITELLM_ALIAS_CANARY_FAILED');
  assert.strictEqual(result.compensation.status, 'completed');
}

async function testUnknownConfigUpdateCannotBecomeApplied() {
  const desired = buildLiteLlmDesiredState(versionFixture());
  const client = statefulClient({ ignoreModelWrites: true });
  const legacy = await client.request('POST', '/config/update', {
    versionId: desired.versionId,
    checksum: desired.configChecksum,
    config_yaml: 'ignored'
  });
  assert.strictEqual(legacy.ok, true, 'the regression fixture must reproduce an ignored HTTP 200');
  const result = await reconcileLiteLlmRuntime(client, desired, fastHooks());
  assert.strictEqual(result.ok, false);
  assert.notStrictEqual(result.status, 'succeeded');
  assert(client.state.configUpdates.every((body) => body.router_settings || body.config_yaml), 'only native router settings may be sent by the reconciler');
}

function testProductionTopologyReferenceClosureBlocksAliasDriftAndOrphans() {
  const drifted = productionTopologyFixture();
  drifted.config.businessModelAliases.find((alias) => alias.litellmAlias === 'ai-teacher-fast').litellmAlias = 'ai-teacher-fast-model';
  const references = productionPolicyReferences();
  const driftedClosure = validateLiteLlmReferenceClosure(drifted, references);
  assert.strictEqual(driftedClosure.ok, false);
  assert.strictEqual(driftedClosure.errors[0].code, 'LITELLM_STAGE_ALIAS_UNRESOLVED');
  assert.deepStrictEqual(driftedClosure.errors[0].aliases, ['ai-teacher-fast']);

  const idReferences = references.map((reference) => ({
    key: reference.key,
    aliasId: reference.alias === 'ai-teacher-fast'
      ? 'alias-ai-teacher-fast'
      : 'alias-ai-teacher-reasoning'
  }));
  const renamedClosure = validateLiteLlmReferenceClosure(drifted, idReferences);
  assert.strictEqual(renamedClosure.ok, true, 'renaming a runtime Alias must not break immutable ID references');

  const orphaned = productionTopologyFixture();
  orphaned.config.modelDeployments.push({
    ...structuredClone(orphaned.config.modelDeployments[1]),
    deploymentId: 'deployment-flash-orphan'
  });
  const orphanedClosure = validateLiteLlmReferenceClosure(orphaned, references);
  assert.strictEqual(orphanedClosure.ok, false);
  assert(orphanedClosure.errors.some((error) => error.code === 'LITELLM_DEPLOYMENT_ORPHANED'
    && error.deploymentIds.includes('deployment-flash-orphan')));

  const mixedProtocol = productionTopologyFixture();
  mixedProtocol.config.providerConnections.push({
    ...structuredClone(mixedProtocol.config.providerConnections[0]),
    connectionId: 'connection-glm-managed',
    adapterProfileId: 'zai-glm.v1',
    endpoint: { scheme: 'https', host: 'api.z.ai', port: 443, basePath: '' },
    credentialRef: { kind: 'litellm_credential', referenceName: 'glm-production' }
  });
  mixedProtocol.config.modelDeployments.push({
    ...structuredClone(mixedProtocol.config.modelDeployments[1]),
    deploymentId: 'deployment-glm-5-2',
    connectionId: 'connection-glm-managed',
    providerModelId: 'glm-5.2'
  });
  mixedProtocol.config.businessModelAliases
    .find((alias) => alias.aliasId === 'alias-ai-teacher-fast')
    .members.push({ deploymentId: 'deployment-glm-5-2', priority: 2, weight: 100 });
  const mixedProtocolClosure = validateLiteLlmReferenceClosure(mixedProtocol, references);
  assert.strictEqual(mixedProtocolClosure.ok, false);
  assert(mixedProtocolClosure.errors.some((error) => error.code === 'LITELLM_ALIAS_PROTOCOL_UNREADY'),
    '同一业务Alias混用不同模型协议时不得发布LiteLLM配置。');

  const closed = validateLiteLlmReferenceClosure(productionTopologyFixture(), references);
  assert.strictEqual(closed.ok, true, JSON.stringify(closed));
  assert.deepStrictEqual(closed.readyAliases, ['ai-teacher-fast', 'ai-teacher-reasoning']);
}

async function testStaticAliasOwnershipConflictRequiresRestartBeforeWrites() {
  const desired = buildLiteLlmDesiredState(productionTopologyFixture());
  const staticRows = desired.deployments.map((target, index) => ({
    ...managedModelRow(target, `static-${index + 1}`),
    model_info: { ...structuredClone(target.modelInfo), db_model: false }
  }));
  const client = statefulClient({ models: staticRows });
  const result = await reconcileLiteLlmRuntime(client, desired, fastHooks());
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.stage, 'preflight');
  assert.strictEqual(result.errorCode, 'LITELLM_STATIC_ALIAS_OWNERSHIP_CONFLICT');
  assert.strictEqual(result.restartRequired, true);
  assert.deepStrictEqual(result.conflictingAliases, ['ai-teacher-fast', 'ai-teacher-reasoning']);
  assert.strictEqual(client.state.createBodies.length, 0, 'static owner conflicts must stop before any model write');
}

async function testDelayedReadbackConvergesBeforeActivation() {
  const desired = buildLiteLlmDesiredState(productionTopologyFixture());
  const client = statefulClient({ stageVisibilityDelayReads: 2, applyVisibilityDelayReads: 2 });
  const result = await reconcileLiteLlmRuntime(client, desired, fastHooks(8));
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.observed.status, 'matched');
  assert(result.stagedReadback.readbackAttempts >= 3, 'delayed staged visibility must require multiple reads');
  assert(result.appliedReadback.readbackAttempts >= 3, 'delayed final visibility must require multiple reads');
  assert.strictEqual(result.canary.results.length, 2);
  assert(result.canary.results.every((item) => item.status === 'passed'));
  assert.strictEqual(client.state.models.filter((row) => row.blocked !== true).length, 2);
  assert.deepStrictEqual(
    [...new Set(client.state.models.filter((row) => row.blocked !== true).map((row) => row.model_name))].sort(),
    ['ai-teacher-fast', 'ai-teacher-reasoning']
  );
}

async function testHttp200NoOpNeverBecomesObserved() {
  const desired = buildLiteLlmDesiredState(productionTopologyFixture());
  const client = statefulClient({ ignoreFinalModelWrites: true });
  const result = await reconcileLiteLlmRuntime(client, desired, fastHooks(4));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, 'LITELLM_APPLY_READBACK_TIMEOUT');
  assert.strictEqual(result.compensation.status, 'completed');
  assert(result.observed.readbackAttempts >= 4);
  assert.strictEqual(client.state.models.length, 0, 'HTTP 200 no-op must compensate every staged model');
}

async function testHealthyGatewayWithMissingAliasIsDrift() {
  const desired = buildLiteLlmDesiredState(versionFixture());
  const client = statefulClient({
    models: [managedModelRow(desired.deployments[0], 'existing-1')],
    hideAliases: true,
    routerSettings: desired.routerSettings
  });
  const observed = await observeLiteLlmRuntime(client, desired);
  assert.strictEqual(observed.status, 'drift');
  assert.strictEqual(observed.matched, false);
  assert(observed.mismatchCodes.includes(`alias_missing:${desired.aliases[0]}`));
}

async function testMatchingReadbackSucceedsAndIsIdempotent() {
  const desired = buildLiteLlmDesiredState(versionFixture());
  const client = statefulClient();
  const first = await reconcileLiteLlmRuntime(client, desired, fastHooks());
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.strictEqual(first.observed.status, 'matched');
  const applied = client.state.models.find((row) => row.blocked !== true);
  assert.strictEqual(applied.litellm_params.model, 'deepseek/test-model');
  assert.strictEqual(applied.litellm_params.api_base, 'https://api.deepseek.com');
  assert.strictEqual(applied.litellm_params.rpm, 10);
  assert.strictEqual(applied.litellm_params.tpm, 1000);
  assert.strictEqual(applied.litellm_params.max_parallel_requests, 3);
  assert.deepStrictEqual(client.state.routerSettings, {
    routing_strategy: 'simple-shuffle',
    num_retries: 1,
    allowed_fails: 5,
    cooldown_time: 30
  });
  assert.strictEqual(first.canary.results[0].status, 'passed');
  assert(client.state.createBodies.some((body) => body.blocked === undefined && body.model_name.startsWith('sysmlv2-stage-')), 'new deployments must first stage under an inert alias accepted by the live Deployment schema');
  assert(client.state.createBodies.some((body) => body.blocked === undefined && body.model_name === desired.aliases[0]), 'final deployment must be created directly under the business alias when LiteLLM does not apply model-name PATCH');
  assert(client.state.createBodies.every((body) => body.litellm_params.api_key === undefined), 'dynamic DeepSeek deployments must use the provider-default environment binding instead of persisting a literal env reference');
  const modelCount = client.state.models.length;
  const second = await reconcileLiteLlmRuntime(client, desired, fastHooks());
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.strictEqual(client.state.models.length, modelCount, 'reconcile must not duplicate managed deployments');
  assert.strictEqual(second.observed.digest, desired.digest);
}

async function testReadbackFailureCompensatesRuntime() {
  const desired = buildLiteLlmDesiredState(versionFixture());
  const previousRouter = { routing_strategy: 'least-busy', num_retries: 2, allowed_fails: 3, cooldown_time: 9 };
  const client = statefulClient({ hideAliases: true, routerSettings: previousRouter });
  const result = await reconcileLiteLlmRuntime(client, desired, fastHooks());
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, 'LITELLM_READBACK_MISMATCH');
  assert.strictEqual(result.compensation.status, 'completed');
  assert.deepStrictEqual(client.state.routerSettings, previousRouter, 'failed readback must restore the previous router settings');
  assert.strictEqual(client.state.models.filter((row) => row.model_info?.managed_by === MANAGED_BY).length, 0, 'failed readback must remove models staged by this operation');
}

async function testRouterSettingsEnvelopeAndEmptyDefaultAreNormalized() {
  const desired = buildLiteLlmDesiredState(versionFixture());
  const client = statefulClient({
    routerEnvelope: true,
    routerSettings: { routing_strategy: '', num_retries: 0, allowed_fails: 0, cooldown_time: 0 }
  });
  const result = await reconcileLiteLlmRuntime(client, desired, fastHooks());
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(client.state.routerSettings.routing_strategy, 'simple-shuffle', 'an empty live strategy must be treated as LiteLLM default and never written back as an invalid value');
  assert(!result.observed.mismatchCodes.includes('router_settings_mismatch'));
}

async function testRedactedEnvironmentCredentialReadbackMatchesManagedBinding() {
  const desired = buildLiteLlmDesiredState(versionFixture());
  const client = statefulClient({ redactApiKeyOnRead: true });
  const result = await reconcileLiteLlmRuntime(client, desired, fastHooks());
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.observed.status, 'matched');
  assert(client.state.models.every((row) => row.model_info?.credential_ref_kind === 'environment'));
  assert(client.state.models.every((row) => row.model_info?.credential_ref_name), 'managed metadata must preserve the credential binding reference while LiteLLM redacts api_key');
}

async function testLegacyEnvironmentCredentialIsReplacedWithoutDeletingOldModel() {
  const desired = buildLiteLlmDesiredState(versionFixture());
  const legacy = managedModelRow(desired.deployments[0], 'legacy-environment-model');
  delete legacy.model_info.credential_runtime_mode;
  delete legacy.model_info.provider_default_key_env;
  const client = statefulClient({ models: [legacy], redactApiKeyOnRead: true });
  const result = await reconcileLiteLlmRuntime(client, desired, fastHooks());
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const rows = client.state.models.filter((row) => row.model_info?.managed_key === desired.deployments[0].managedKey);
  assert.strictEqual(rows.filter((row) => row.blocked !== true).length, 1, 'replacement must leave exactly one active deployment');
  assert.strictEqual(rows.find((row) => row.model_id === 'legacy-environment-model')?.blocked, true, 'the unsafe legacy deployment must be blocked for rollback instead of deleted');
  assert(!client.state.deletedIds.includes('legacy-environment-model'));
  assert.strictEqual(rows.find((row) => row.blocked !== true)?.litellm_params.api_key, undefined);
}

async function testEnvironmentCredentialIsReplacedWhenSwitchingToManagedCredential() {
  const desired = buildLiteLlmDesiredState(productionTopologyFixture());
  const target = desired.deployments[0];
  const existing = managedModelRow(target, 'environment-credential-model');
  existing.litellm_params = {
    ...existing.litellm_params,
    api_key: 'os.environ/DEEPSEEK_API_KEY_1'
  };
  delete existing.litellm_params.litellm_credential_name;
  existing.model_info = {
    ...existing.model_info,
    credential_ref_kind: 'environment',
    credential_ref_name: 'DEEPSEEK_API_KEY_1',
    provider_default_key_env: 'DEEPSEEK_API_KEY',
    credential_runtime_mode: 'provider_default_env'
  };
  const client = statefulClient({ models: [existing], redactApiKeyOnRead: true });
  const result = await reconcileLiteLlmRuntime(client, desired, fastHooks());
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  const rows = client.state.models.filter((row) => row.model_info?.managed_key === target.managedKey);
  const replacement = rows.find((row) => row.blocked !== true);
  assert.strictEqual(rows.find((row) => row.model_id === existing.model_id)?.blocked, true, 'credential-kind migration must block the old deployment for rollback');
  assert.notStrictEqual(replacement?.model_id, existing.model_id, 'credential-kind migration must create a clean deployment instead of patching secret fields');
  assert.strictEqual(replacement?.litellm_params.api_key, undefined, 'managed-credential deployments must not retain the old environment api_key field');
  assert.strictEqual(replacement?.litellm_params.litellm_credential_name, target.credentialRefName);
}

async function testUnrelatedModelsArePreserved() {
  const desired = buildLiteLlmDesiredState(versionFixture());
  const unmanaged = {
    model_name: 'legacy-unmanaged-model',
    model_id: 'legacy-unmanaged-id',
    litellm_params: { model: 'openai/legacy', api_key: 'os.environ/LEGACY_KEY' },
    model_info: { owner: 'external' },
    blocked: false
  };
  const staleManaged = {
    model_name: 'old-managed-alias',
    model_id: 'old-managed-id',
    litellm_params: { model: 'openai/old', api_key: 'os.environ/OLD_KEY' },
    model_info: { managed_by: MANAGED_BY, managed_key: 'old-managed-alias:old-deployment' },
    blocked: false
  };
  const staticMetadataLeak = {
    model_name: 'legacy-static-alias',
    model_id: 'legacy-static-id',
    litellm_params: { model: desired.deployments[0].litellmParams.model },
    model_info: {
      ...structuredClone(desired.deployments[0].modelInfo),
      db_model: false
    },
    blocked: false
  };
  const client = statefulClient({ models: [unmanaged, staleManaged, staticMetadataLeak] });
  const result = await reconcileLiteLlmRuntime(client, desired, fastHooks());
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert(client.state.models.some((row) => row.model_id === unmanaged.model_id), 'unmanaged model must be preserved');
  assert.strictEqual(client.state.models.find((row) => row.model_id === staticMetadataLeak.model_id)?.blocked, false, 'a static-config row with leaked dynamic metadata must remain unrelated');
  assert.strictEqual(client.state.models.find((row) => row.model_id === staleManaged.model_id)?.blocked, true, 'stale managed model must be blocked, not deleted');
  assert(!client.state.deletedIds.includes(unmanaged.model_id));
  assert(!client.state.deletedIds.includes(staticMetadataLeak.model_id));
  assert(!client.state.deletedIds.includes(staleManaged.model_id));
}

function statefulClient(options = {}) {
  const state = {
    models: structuredClone(options.models || []),
    visibleModels: structuredClone(options.models || []),
    routerSettings: { routing_strategy: 'simple-shuffle', num_retries: 1, allowed_fails: 5, cooldown_time: 30, ...(options.routerSettings || {}) },
    configUpdates: [],
    createBodies: [],
    deletedIds: [],
    nextId: 1,
    visibilityCountdown: 0
  };
  const scheduleVisibility = (reads) => {
    state.visibilityCountdown = Math.max(0, Number(reads || 0));
    if (state.visibilityCountdown === 0) state.visibleModels = structuredClone(state.models);
  };
  return {
    state,
    async request(method, path, body) {
      if (method === 'GET' && path === '/openapi.json') return { ok: true, status: 200, payload: openApiFixture() };
      if (method === 'GET' && path === '/health/liveliness') return { ok: true, status: 200, payload: { status: 'ok' } };
      if (method === 'GET' && path === '/model/info') {
        if (state.visibilityCountdown > 0) state.visibilityCountdown -= 1;
        else state.visibleModels = structuredClone(state.models);
        const rows = structuredClone(state.visibleModels);
        if (options.redactApiKeyOnRead) {
          for (const row of rows) delete row.litellm_params?.api_key;
        }
        return { ok: true, status: 200, payload: { data: rows } };
      }
      if (method === 'GET' && path === '/v1/models') {
        const active = options.hideAliases ? [] : state.visibleModels.filter((row) => row.blocked !== true);
        return { ok: true, status: 200, payload: { data: active.map((row) => ({ id: row.model_name })) } };
      }
      if (method === 'GET' && path === '/router/settings') {
        return {
          ok: true,
          status: 200,
          payload: options.routerEnvelope
            ? { fields: [], current_values: structuredClone(state.routerSettings) }
            : structuredClone(state.routerSettings)
        };
      }
      if (method === 'POST' && path === '/config/update') {
        state.configUpdates.push(structuredClone(body || {}));
        if (body?.router_settings) state.routerSettings = { ...state.routerSettings, ...body.router_settings };
        return { ok: true, status: 200, payload: { message: 'Config updated successfully' } };
      }
      if (method === 'POST' && path === '/v1/chat/completions') {
        if (options.failCanaryAlias === body?.model) {
          return { ok: false, status: 503, payload: { error: 'canary failed' } };
        }
        return {
          ok: true,
          status: 200,
          payload: { choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 2 } }
        };
      }
      if (method === 'POST' && path === '/model/new') {
        const modelId = `created-${state.nextId++}`;
        state.createBodies.push(structuredClone(body));
        const isStage = String(body?.model_name || '').startsWith('sysmlv2-stage-');
        const ignoreWrite = options.ignoreModelWrites || (options.ignoreFinalModelWrites && !isStage);
        if (!ignoreWrite) {
          state.models.push({ ...structuredClone(body), model_id: modelId });
          scheduleVisibility(isStage ? options.stageVisibilityDelayReads : options.applyVisibilityDelayReads);
        }
        return { ok: true, status: 200, payload: { model_id: modelId } };
      }
      const updateMatch = method === 'PATCH' && path.match(/^\/model\/([^/]+)\/update$/);
      if (updateMatch) {
        const modelId = decodeURIComponent(updateMatch[1]);
        const index = state.models.findIndex((row) => row.model_id === modelId);
        if (index < 0) return { ok: false, status: 404, payload: {} };
        if (options.ignoreEnableUpdates && body?.blocked === false) {
          return { ok: true, status: 200, payload: { model_id: modelId } };
        }
        state.models[index] = {
          ...state.models[index],
          ...structuredClone(body),
          model_id: modelId,
          litellm_params: body?.litellm_params ? structuredClone(body.litellm_params) : state.models[index].litellm_params,
          model_info: body?.model_info ? structuredClone(body.model_info) : state.models[index].model_info
        };
        scheduleVisibility(options.applyVisibilityDelayReads);
        return { ok: true, status: 200, payload: { model_id: modelId } };
      }
      if (method === 'POST' && path === '/model/delete') {
        state.deletedIds.push(String(body?.id || ''));
        state.models = state.models.filter((row) => row.model_id !== body?.id);
        state.visibleModels = structuredClone(state.models);
        state.visibilityCountdown = 0;
        return { ok: true, status: 200, payload: { deleted: true } };
      }
      return { ok: false, status: 404, payload: {} };
    }
  };
}

function fastHooks(attempts = 3) {
  return {
    settleScheduleMs: Array.from({ length: attempts }, () => 0),
    sleep: async () => {}
  };
}

function managedModelRow(target, modelId) {
  return {
    model_name: target.modelName,
    model_id: modelId,
    litellm_params: structuredClone(target.litellmParams),
    model_info: structuredClone(target.modelInfo),
    blocked: false
  };
}

function openApiFixture() {
  return {
    paths: {
      '/model/info': { get: {} },
      '/v1/models': { get: {} },
      '/router/settings': { get: {} },
      '/v1/chat/completions': { post: {} },
      '/model/new': { post: {} },
      '/model/{model_id}/update': { patch: {} },
      '/model/delete': { post: {} },
      '/config/update': { post: {} }
    }
  };
}

function versionFixture() {
  return {
    versionId: 'litellm_cfg_test',
    checksum: 'fixture-checksum',
    config: {
      schemaVersion: 1,
      modelGroups: [{
        modelName: 'ai-teacher-fast-test',
        deployments: [{
          deploymentId: 'fast-test-primary',
          enabled: true,
          provider: 'deepseek',
          model: 'deepseek/test-model',
          apiBase: 'https://api.deepseek.com',
          apiKeyEnv: 'TEST_PROVIDER_KEY',
          rpm: 10,
          tpm: 1000,
          maxParallelRequests: 3
        }],
        router: { routingStrategy: 'simple-shuffle', numRetries: 1, allowedFails: 5, cooldownTime: 30 },
        fallbacks: []
      }],
      general: { masterKeyEnv: 'LITELLM_MASTER_KEY', databaseUrlEnv: 'LITELLM_DATABASE_URL' }
    }
  };
}

function productionPolicyReferences() {
  return [
    { key: 'scope.modelRoute', alias: 'ai-teacher-fast' },
    { key: 'stage.main.modelRoute', alias: 'ai-teacher-fast' },
    { key: 'stage.candidate.modelRoute', alias: 'ai-teacher-reasoning' },
    { key: 'stage.repair.modelRoute', alias: 'ai-teacher-reasoning' },
    { key: 'stage.finalizer.modelRoute', alias: 'ai-teacher-fast' },
    { key: 'semanticReview.modelRoute', alias: 'ai-teacher-reasoning' }
  ];
}

function productionTopologyFixture() {
  return {
    versionId: 'litellm_cfg_runtime_schema_v2',
    checksum: 'runtime-schema-v2-fixture-checksum',
    config: {
      schemaVersion: 2,
      providerConnections: [{
        connectionId: 'connection-deepseek-managed',
        displayName: 'DeepSeek Managed',
        enabled: true,
        adapterProfileId: 'deepseek-v4.v1',
        adapterProfileRevision: 1,
        endpoint: { scheme: 'https', host: 'api.deepseek.com', port: 443, basePath: '' },
        networkZone: 'public_provider',
        credentialRef: { kind: 'litellm_credential', referenceName: 'deepseek-production' },
        tlsPolicy: 'verify_full',
        metadata: { owner: 'AI Teacher', purpose: 'runtime publication regression fixture' }
      }],
      modelDeployments: [{
        deploymentId: 'deployment-deepseek-pro',
        connectionId: 'connection-deepseek-managed',
        displayName: 'DeepSeek V4 Pro',
        providerModelId: 'deepseek-v4-pro',
        enabled: true,
        limits: { rpm: 60, tpm: 120000, maxParallelRequests: 2 },
        declaredCapabilities: productionCapabilities()
      }, {
        deploymentId: 'deployment-deepseek-flash',
        connectionId: 'connection-deepseek-managed',
        displayName: 'DeepSeek V4 Flash',
        providerModelId: 'deepseek-v4-flash',
        enabled: true,
        limits: { rpm: 120, tpm: 180000, maxParallelRequests: 3 },
        declaredCapabilities: productionCapabilities()
      }],
      businessModelAliases: [{
        aliasId: 'alias-ai-teacher-reasoning',
        litellmAlias: 'ai-teacher-reasoning',
        displayName: 'AI Teacher Reasoning',
        enabled: true,
        members: [{ deploymentId: 'deployment-deepseek-pro', priority: 1, weight: 100 }],
        routing: { strategy: 'simple-shuffle', numRetries: 1, allowedFails: 5, cooldownTimeSeconds: 30 }
      }, {
        aliasId: 'alias-ai-teacher-fast',
        litellmAlias: 'ai-teacher-fast',
        displayName: 'AI Teacher Fast',
        enabled: true,
        members: [{ deploymentId: 'deployment-deepseek-flash', priority: 1, weight: 100 }],
        routing: { strategy: 'simple-shuffle', numRetries: 1, allowedFails: 5, cooldownTimeSeconds: 30 }
      }],
      general: { masterKeyEnv: 'LITELLM_MASTER_KEY', databaseUrlEnv: 'LITELLM_DATABASE_URL' }
    }
  };
}

function productionCapabilities() {
  return {
    contextWindowTokens: 128000,
    maxOutputTokens: 8192,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsThinking: true,
    supportsThinkingWithTools: true,
    supportsStructuredOutput: true,
    reportsUsage: true
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
