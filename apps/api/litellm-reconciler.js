'use strict';

const crypto = require('crypto');

const { normalizeLiteLlmConfig } = require('./litellm-config');
const { executionProtocolForAlias, legacyAliasId } = require('./ai-teacher-model-registry');

const MANAGED_BY = 'sysmlv2-teaching-platform';
const DEFAULT_SETTLE_SCHEDULE_MS = Object.freeze([0, 250, 500, 1000, 2000, 3500]);
const REQUIRED_CAPABILITIES = [
  ['GET', '/model/info'],
  ['GET', '/v1/models'],
  ['GET', '/router/settings'],
  ['POST', '/v1/chat/completions'],
  ['POST', '/model/new'],
  ['PATCH', '/model/{model_id}/update'],
  ['POST', '/model/delete']
];

function buildLiteLlmDesiredState(version = {}) {
  const config = normalizeLiteLlmConfig(version.config || {});
  const aliasIds = new Map((config.businessModelAliases || []).map((alias) => [alias.litellmAlias, alias.aliasId]));
  const deployments = [];
  for (const group of config.modelGroups) {
    const alias = (config.businessModelAliases || []).find((item) => item.litellmAlias === group.modelName);
    const members = new Map((alias?.members || []).map((member) => [member.deploymentId, member]));
    for (const deployment of group.deployments.filter((item) => item.enabled !== false)) {
      const managedKey = `${group.modelName}:${deployment.deploymentId}`;
      const member = members.get(deployment.deploymentId) || {};
      const credentialRefKind = deployment.litellmCredentialName
        ? 'litellm_credential'
        : deployment.apiKeyEnv ? 'environment' : 'none';
      const credentialRefName = deployment.litellmCredentialName || deployment.apiKeyEnv || '';
      const providerDefaultKeyEnv = credentialRefKind === 'environment'
        ? providerDefaultApiKeyEnv(deployment.model)
        : '';
      const credentialRuntimeMode = providerDefaultKeyEnv ? 'provider_default_env' : credentialRefKind;
      deployments.push({
        managedKey,
        modelName: group.modelName,
        deploymentId: deployment.deploymentId,
        aliasId: aliasIds.get(group.modelName) || group.modelName,
        memberPriority: Number(member.priority || 0),
        memberWeight: Number(member.weight || 0),
        credentialRefKind,
        credentialRefName,
        providerDefaultKeyEnv,
        credentialRuntimeMode,
        litellmParams: compactObject({
          model: deployment.model,
          api_base: deployment.apiBase || (deployment.apiBaseEnv ? `os.environ/${deployment.apiBaseEnv}` : ''),
          api_key: deployment.apiKeyEnv ? `os.environ/${deployment.apiKeyEnv}` : '',
          litellm_credential_name: deployment.litellmCredentialName || '',
          rpm: positiveOrUndefined(deployment.rpm),
          tpm: positiveOrUndefined(deployment.tpm),
          max_parallel_requests: positiveOrUndefined(deployment.maxParallelRequests)
        }),
        modelInfo: {
          managed_by: MANAGED_BY,
          managed_key: managedKey,
          alias_id: aliasIds.get(group.modelName) || group.modelName,
          deployment_id: deployment.deploymentId,
          member_priority: Number(member.priority || 0),
          member_weight: Number(member.weight || 0),
          credential_ref_kind: credentialRefKind,
          credential_ref_name: credentialRefName,
          provider_default_key_env: providerDefaultKeyEnv,
          credential_runtime_mode: credentialRuntimeMode,
          config_version_id: String(version.versionId || ''),
          config_checksum: String(version.checksum || '')
        }
      });
    }
  }
  deployments.sort((left, right) => left.managedKey.localeCompare(right.managedKey));
  const firstRouter = config.modelGroups[0]?.router || {};
  const routerSettings = {
    routing_strategy: firstRouter.routingStrategy || 'simple-shuffle',
    num_retries: Number(firstRouter.numRetries || 0),
    allowed_fails: Number(firstRouter.allowedFails || 0),
    cooldown_time: Number(firstRouter.cooldownTime || 0)
  };
  const aliases = [...new Set(deployments.map((item) => item.modelName))].sort();
  const comparable = { deployments: deployments.map(comparableDesiredDeployment), routerSettings };
  return {
    versionId: String(version.versionId || ''),
    configChecksum: String(version.checksum || ''),
    deployments,
    aliases,
    routerSettings,
    digest: digestJson(comparable)
  };
}

function providerDefaultApiKeyEnv(model = '') {
  const provider = String(model || '').split('/', 1)[0].trim().toLowerCase();
  return ({
    deepseek: 'DEEPSEEK_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY'
  })[provider] || '';
}

function dynamicEnvironmentCredentialIssues(version = {}) {
  if (Number(version.config?.schemaVersion || 1) < 2) return [];
  const config = normalizeLiteLlmConfig(version.config || {});
  return config.modelGroups.flatMap((group) => group.deployments
    .filter((deployment) => deployment.enabled !== false && deployment.apiKeyEnv && !providerDefaultApiKeyEnv(deployment.model))
    .map((deployment) => ({
      modelName: group.modelName,
      deploymentId: deployment.deploymentId,
      code: 'provider_default_environment_unknown'
    })));
}

function validateLiteLlmReferenceClosure(version = {}, policyReferences = []) {
  const config = normalizeLiteLlmConfig(version.config || {});
  const readyAliases = new Set(config.modelGroups.map((group) => group.modelName));
  const readyAliasIds = new Set((config.businessModelAliases || [])
    .filter((alias) => alias.enabled !== false && readyAliases.has(alias.litellmAlias))
    .map((alias) => alias.aliasId));
  const aliasIdByRuntimeName = new Map((config.businessModelAliases || [])
    .filter((alias) => alias.enabled !== false && readyAliases.has(alias.litellmAlias))
    .map((alias) => [alias.litellmAlias, alias.aliasId]));
  if (!readyAliasIds.size) {
    for (const runtimeName of readyAliases) {
      const aliasId = legacyAliasId(runtimeName);
      readyAliasIds.add(aliasId);
      aliasIdByRuntimeName.set(runtimeName, aliasId);
    }
  }
  const references = (Array.isArray(policyReferences) ? policyReferences : [])
    .map((reference) => {
      const requestedReference = String(reference?.aliasId || reference?.alias || '').trim();
      return {
        key: String(reference?.key || '').trim(),
        aliasId: aliasIdByRuntimeName.get(requestedReference) || requestedReference,
        requestedReference
      };
    })
    .filter((reference) => reference.key && reference.aliasId);
  const unresolvedStageAliases = references.filter((reference) => !readyAliasIds.has(reference.aliasId));
  const orphanedDeployments = [];
  const aliasesWithoutReadyMembers = [];
  const aliasesWithoutExecutableProtocol = [];

  if (Number(config.schemaVersion || 1) >= 2) {
    const connections = new Map(config.providerConnections.map((connection) => [connection.connectionId, connection]));
    const deployments = new Map(config.modelDeployments.map((deployment) => [deployment.deploymentId, deployment]));
    const enabledAliases = config.businessModelAliases.filter((alias) => alias.enabled !== false);
    const referencedDeploymentIds = new Set(enabledAliases.flatMap((alias) => alias.members.map((member) => member.deploymentId)));

    for (const deployment of config.modelDeployments) {
      const connection = connections.get(deployment.connectionId);
      if (deployment.enabled !== false && connection?.enabled !== false && !referencedDeploymentIds.has(deployment.deploymentId)) {
        orphanedDeployments.push(deployment.deploymentId);
      }
    }
    for (const alias of enabledAliases) {
      const hasReadyMember = alias.members.some((member) => {
        const deployment = deployments.get(member.deploymentId);
        const connection = deployment ? connections.get(deployment.connectionId) : null;
        return deployment?.enabled !== false && connection?.enabled !== false;
      });
      if (!hasReadyMember) aliasesWithoutReadyMembers.push(alias.litellmAlias);
      const protocol = executionProtocolForAlias(config, alias.aliasId);
      if (protocol.status !== 'ready') {
        aliasesWithoutExecutableProtocol.push({
          aliasId: alias.aliasId,
          alias: alias.litellmAlias,
          status: protocol.status
        });
      }
    }
  }

  const errors = [];
  if (unresolvedStageAliases.length) {
    errors.push({
      code: 'LITELLM_STAGE_ALIAS_UNRESOLVED',
      aliasIds: [...new Set(unresolvedStageAliases.map((reference) => reference.aliasId))].sort(),
      aliases: [...new Set(unresolvedStageAliases.map((reference) => reference.requestedReference))].sort(),
      references: unresolvedStageAliases
    });
  }
  if (orphanedDeployments.length) {
    errors.push({ code: 'LITELLM_DEPLOYMENT_ORPHANED', deploymentIds: orphanedDeployments.sort() });
  }
  if (aliasesWithoutReadyMembers.length) {
    errors.push({ code: 'LITELLM_ALIAS_NO_READY_MEMBER', aliases: aliasesWithoutReadyMembers.sort() });
  }
  if (aliasesWithoutExecutableProtocol.length) {
    errors.push({
      code: 'LITELLM_ALIAS_PROTOCOL_UNREADY',
      aliases: aliasesWithoutExecutableProtocol.sort((left, right) => left.alias.localeCompare(right.alias))
    });
  }
  return {
    ok: errors.length === 0,
    versionId: String(version.versionId || ''),
    policyReferences: references,
    readyAliasIds: [...readyAliasIds].sort(),
    readyAliases: [...readyAliases].sort(),
    errors
  };
}

async function probeLiteLlmReconcileCapabilities(client) {
  const [openApi, liveliness] = await Promise.all([
    client.request('GET', '/openapi.json'),
    client.request('GET', '/health/liveliness')
  ]);
  if (!liveliness.ok) {
    return failure('LITELLM_GATEWAY_UNHEALTHY', `LiteLLM liveliness check failed with ${liveliness.status}.`, {
      httpStatus: liveliness.status
    });
  }
  if (!openApi.ok) {
    return failure('LITELLM_CAPABILITY_READ_FAILED', `LiteLLM OpenAPI read failed with ${openApi.status}.`, {
      httpStatus: openApi.status
    });
  }
  const paths = openApi.payload?.paths || {};
  const missing = REQUIRED_CAPABILITIES.filter(([method, path]) => {
    const operation = paths[path]?.[method.toLowerCase()];
    return !operation;
  }).map(([method, path]) => `${method} ${path}`);
  if (missing.length) {
    return failure('LITELLM_RECONCILE_CAPABILITY_MISSING', 'LiteLLM does not expose the required dynamic model management API.', { missing });
  }
  return { ok: true, required: REQUIRED_CAPABILITIES.map(([method, path]) => `${method} ${path}`) };
}

async function observeLiteLlmRuntime(client, desired, options = {}) {
  const [modelInfoResponse, modelsResponse, routerResponse] = await Promise.all([
    client.request('GET', '/model/info'),
    client.request('GET', '/v1/models'),
    client.request('GET', '/router/settings')
  ]);
  const failedReads = [
    ['model_info', modelInfoResponse],
    ['models', modelsResponse],
    ['router_settings', routerResponse]
  ].filter(([, response]) => !response.ok);
  if (failedReads.length) {
    return {
      status: 'unavailable',
      matched: false,
      checkedAt: new Date().toISOString(),
      errorCode: 'LITELLM_READBACK_FAILED',
      failedReads: failedReads.map(([source, response]) => ({ source, httpStatus: response.status }))
    };
  }

  const modelRows = extractModelInfoRows(modelInfoResponse.payload);
  const publicAliases = extractModelAliases(modelsResponse.payload);
  const managedRows = modelRows.filter(isPlatformManagedRow);
  const desiredByKey = new Map(desired.deployments.map((item) => [item.managedKey, item]));
  const activeManagedRows = managedRows.filter((row) => !isBlocked(row));
  const observedDeployments = [];
  const mismatchCodes = [];
  const deploymentMismatches = [];

  for (const target of desired.deployments) {
    const candidates = activeManagedRows.filter((row) => managedKeyFromRow(row) === target.managedKey);
    if (candidates.length !== 1) mismatchCodes.push(`deployment_cardinality:${target.managedKey}:${candidates.length}`);
    const expectedModelId = modelIdByManagedKey(options.expectedModelIdsByKey, target.managedKey);
    const matching = candidates.find((row) => deploymentMatches(row, target)
      && (!expectedModelId || modelIdFromRow(row) === expectedModelId));
    if (!matching) {
      mismatchCodes.push(`deployment_mismatch:${target.managedKey}`);
      deploymentMismatches.push({
        managedKey: target.managedKey,
        candidateCount: candidates.length,
        mismatchFields: [...new Set(candidates.flatMap((row) => [
          ...deploymentMismatchFields(row, target),
          ...(expectedModelId && modelIdFromRow(row) !== expectedModelId ? ['model_id'] : [])
        ]))].sort()
      });
    }
    else observedDeployments.push(comparableObservedDeployment(matching));
  }
  for (const alias of desired.aliases) {
    if (!publicAliases.includes(alias)) mismatchCodes.push(`alias_missing:${alias}`);
  }
  for (const row of activeManagedRows) {
    const key = managedKeyFromRow(row);
    if (!desiredByKey.has(key)) mismatchCodes.push(`unexpected_active_managed_deployment:${key || 'unknown'}`);
  }

  const observedRouter = comparableRouterSettings(routerResponse.payload);
  if (canonicalJson(observedRouter) !== canonicalJson(desired.routerSettings)) mismatchCodes.push('router_settings_mismatch');
  observedDeployments.sort((left, right) => left.managedKey.localeCompare(right.managedKey));
  const comparable = { deployments: observedDeployments, routerSettings: observedRouter };
  const matched = mismatchCodes.length === 0 && observedDeployments.length === desired.deployments.length;
  return {
    status: matched ? 'matched' : 'drift',
    matched,
    checkedAt: new Date().toISOString(),
    digest: digestJson(comparable),
    targetDigest: desired.digest,
    modelAliases: publicAliases,
    targetAliases: desired.aliases,
    managedDeploymentCount: managedRows.length,
    targetDeploymentCount: desired.deployments.length,
    mismatchCodes,
    deploymentMismatches
  };
}

async function reconcileLiteLlmRuntime(client, desired, hooks = {}) {
  const capability = await probeLiteLlmReconcileCapabilities(client);
  if (!capability.ok) return { ...capability, status: 'failed', stage: 'preflight' };
  const initialReadback = await readManagedRows(client);
  if (!initialReadback.ok) return { ...initialReadback, status: 'failed', stage: 'preflight' };
  const initialRouter = await client.request('GET', '/router/settings');
  if (!initialRouter.ok) {
    return {
      ...failure('LITELLM_ROUTER_READ_FAILED', `LiteLLM router settings read failed with ${initialRouter.status}.`, { httpStatus: initialRouter.status }),
      status: 'failed',
      stage: 'preflight'
    };
  }

  const previousRows = initialReadback.rows;
  const staticAliasConflicts = initialReadback.allRows
    .filter((row) => row.model_info?.db_model === false
      && !isBlocked(row)
      && desired.aliases.includes(String(row.model_name || '')))
    .map((row) => String(row.model_name || ''));
  if (staticAliasConflicts.length) {
    return {
      ...failure(
        'LITELLM_STATIC_ALIAS_OWNERSHIP_CONFLICT',
        'LiteLLM static model aliases must be retired by the deployment owner before dynamic publication.',
        {
          restartRequired: true,
          conflictingAliases: [...new Set(staticAliasConflicts)].sort()
        }
      ),
      status: 'failed',
      stage: 'preflight'
    };
  }
  const previousRouter = comparableRouterSettings(initialRouter.payload);
  const previousByKey = new Map();
  for (const row of previousRows) {
    const key = managedKeyFromRow(row);
    if (!key) continue;
    if (!previousByKey.has(key) || (isBlocked(previousByKey.get(key)) && !isBlocked(row))) previousByKey.set(key, row);
  }
  const replacementKeys = new Set(desired.deployments
    .filter((target) => previousByKey.has(target.managedKey) && requiresCredentialRuntimeReplacement(previousByKey.get(target.managedKey), target))
    .map((target) => target.managedKey));
  const stagedModelIds = [];
  const stagedModelIdsByKey = new Map();
  const createdModelIds = [];
  const createdModelIdsByKey = new Map();
  const changedSnapshots = [];
  let firstFailure = null;
  let routerChanged = false;
  let stagedReadbackEvidence = null;
  let appliedReadbackEvidence = null;

  try {
    await hooks.onStage?.({ stage: 'stage', desiredDigest: desired.digest });
    for (const target of desired.deployments) {
      if (previousByKey.has(target.managedKey) && !replacementKeys.has(target.managedKey)) continue;
      const create = await client.request('POST', '/model/new', modelCreateBody(target, true));
      if (!create.ok) throw reconcileError('LITELLM_MODEL_STAGE_FAILED', `LiteLLM failed to stage ${target.managedKey}.`, create.status);
      const modelId = extractModelId(create.payload);
      if (!modelId) throw reconcileError('LITELLM_MODEL_STAGE_ID_MISSING', `LiteLLM did not return a model id for ${target.managedKey}.`, create.status);
      stagedModelIds.push(modelId);
      stagedModelIdsByKey.set(target.managedKey, modelId);
    }

    if (stagedModelIds.length) {
      const stagedReadback = await waitForModelIds(client, stagedModelIds, settleOptions(hooks));
      stagedReadbackEvidence = stagedReadback;
      if (!stagedReadback.matched) {
        const error = reconcileError(
          stagedReadback.status === 'unavailable' ? 'LITELLM_STAGE_READBACK_FAILED' : 'LITELLM_STAGE_READBACK_TIMEOUT',
          stagedReadback.status === 'unavailable'
            ? 'LiteLLM staged model readback failed.'
            : 'LiteLLM staged models did not become observable within the bounded convergence window.',
          0
        );
        error.observed = stagedReadback;
        throw error;
      }
      await hooks.onStageObserved?.({
        stage: 'stage_observed',
        desiredDigest: desired.digest,
        readbackAttempts: stagedReadback.readbackAttempts
      });
      const stageAliases = desired.deployments
        .filter((target) => stagedModelIdsByKey.has(target.managedKey))
        .map(stageModelName);
      const stageCanary = await canaryLiteLlmAliases(client, stageAliases);
      if (!stageCanary.ok) {
        throw reconcileError('LITELLM_STAGE_CANARY_FAILED', `LiteLLM staged deployment canary failed for ${stageCanary.failedAlias}.`, stageCanary.httpStatus);
      }
    }

    await hooks.onApply?.({ stage: 'apply', desiredDigest: desired.digest });
    for (const target of desired.deployments) {
      if (!stagedModelIdsByKey.has(target.managedKey)) continue;
      const stagedModelId = stagedModelIdsByKey.get(target.managedKey);
      const removeStage = await client.request('POST', '/model/delete', { id: stagedModelId });
      if (!removeStage.ok) throw reconcileError('LITELLM_STAGED_MODEL_DELETE_FAILED', `LiteLLM failed to retire staged deployment ${target.managedKey}.`, removeStage.status);
      stagedModelIds.splice(stagedModelIds.indexOf(stagedModelId), 1);
      const create = await client.request('POST', '/model/new', modelCreateBody(target, false));
      if (!create.ok) throw reconcileError('LITELLM_MODEL_APPLY_FAILED', `LiteLLM failed to create final deployment ${target.managedKey}.`, create.status);
      const modelId = extractModelId(create.payload);
      if (!modelId) throw reconcileError('LITELLM_MODEL_APPLY_ID_MISSING', `LiteLLM did not return a final model id for ${target.managedKey}.`, create.status);
      createdModelIds.push(modelId);
      createdModelIdsByKey.set(target.managedKey, modelId);
    }

    if (createdModelIds.length) {
      const appliedReadback = await waitForModelIds(client, createdModelIds, settleOptions(hooks));
      appliedReadbackEvidence = appliedReadback;
      if (!appliedReadback.matched) {
        const error = reconcileError(
          appliedReadback.status === 'unavailable' ? 'LITELLM_APPLY_READBACK_FAILED' : 'LITELLM_APPLY_READBACK_TIMEOUT',
          appliedReadback.status === 'unavailable'
            ? 'LiteLLM final model readback failed.'
            : 'LiteLLM final models did not become observable within the bounded convergence window.',
          0
        );
        error.observed = appliedReadback;
        throw error;
      }
    }

    for (const target of desired.deployments) {
      const existing = previousByKey.get(target.managedKey);
      if (existing && !replacementKeys.has(target.managedKey)) {
        const modelId = modelIdFromRow(existing);
        if (!modelId) throw reconcileError('LITELLM_MANAGED_MODEL_ID_MISSING', `Managed deployment ${target.managedKey} has no model id.`, 0);
        const snapshot = safeManagedSnapshot(existing);
        if (!snapshot) throw reconcileError('LITELLM_MANAGED_MODEL_UNSAFE_TO_UPDATE', `Managed deployment ${target.managedKey} contains a non-reference credential.`, 0);
        changedSnapshots.push(snapshot);
        const update = await client.request('PATCH', `/model/${encodeURIComponent(modelId)}/update`, modelWriteBody(target, false));
        if (!update.ok) throw reconcileError('LITELLM_MODEL_UPDATE_FAILED', `LiteLLM failed to update ${target.managedKey}.`, update.status);
      } else {
        const modelId = createdModelIdsByKey.get(target.managedKey);
        if (!modelId) throw reconcileError('LITELLM_FINAL_MODEL_MISSING', `Final deployment ${target.managedKey} is missing.`, 0);
        if (existing) {
          const oldModelId = modelIdFromRow(existing);
          const snapshot = safeManagedSnapshot(existing);
          if (!oldModelId || !snapshot) throw reconcileError('LITELLM_MANAGED_MODEL_UNSAFE_TO_REPLACE', `Managed deployment ${target.managedKey} cannot be safely replaced.`, 0);
          changedSnapshots.push(snapshot);
          const block = await client.request('PATCH', `/model/${encodeURIComponent(oldModelId)}/update`, { blocked: true });
          if (!block.ok) throw reconcileError('LITELLM_REPLACED_MODEL_BLOCK_FAILED', `LiteLLM failed to block the replaced deployment ${target.managedKey}.`, block.status);
        }
      }
    }

    const router = await client.request('POST', '/config/update', { router_settings: desired.routerSettings });
    if (!router.ok) throw reconcileError('LITELLM_ROUTER_UPDATE_FAILED', 'LiteLLM router settings update failed.', router.status);
    routerChanged = true;

    const desiredKeys = new Set(desired.deployments.map((item) => item.managedKey));
    for (const existing of previousRows) {
      const key = managedKeyFromRow(existing);
      if (!key || desiredKeys.has(key) || isBlocked(existing)) continue;
      const modelId = modelIdFromRow(existing);
      const snapshot = safeManagedSnapshot(existing);
      if (!modelId || !snapshot) throw reconcileError('LITELLM_STALE_MODEL_UNSAFE_TO_BLOCK', `Managed deployment ${key} cannot be safely blocked.`, 0);
      changedSnapshots.push(snapshot);
      const block = await client.request('PATCH', `/model/${encodeURIComponent(modelId)}/update`, { blocked: true });
      if (!block.ok) throw reconcileError('LITELLM_STALE_MODEL_BLOCK_FAILED', `LiteLLM failed to block stale deployment ${key}.`, block.status);
    }

    const expectedModelIdsByKey = new Map(desired.deployments.map((target) => [
      target.managedKey,
      createdModelIdsByKey.get(target.managedKey) || modelIdFromRow(previousByKey.get(target.managedKey))
    ]));
    await hooks.onObserve?.({ stage: 'observe', appliedDigest: desired.digest });
    const observed = await waitForObservedRuntime(client, desired, {
      ...settleOptions(hooks),
      expectedModelIdsByKey
    });
    if (!observed.matched) {
      const error = reconcileError(
        observed.status === 'unavailable' ? 'LITELLM_READBACK_FAILED' : 'LITELLM_READBACK_MISMATCH',
        observed.status === 'unavailable' ? 'LiteLLM runtime readback failed after apply.' : 'LiteLLM runtime does not match the desired model set after apply.',
        0
      );
      error.observed = observed;
      throw error;
    }
    const canary = await canaryLiteLlmAliases(client, desired.aliases);
    if (!canary.ok) {
      throw reconcileError('LITELLM_ALIAS_CANARY_FAILED', `LiteLLM alias canary failed for ${canary.failedAlias}.`, canary.httpStatus);
    }
    return {
      ok: true,
      status: 'succeeded',
      stage: 'observed',
      appliedDigest: desired.digest,
      observed,
      capability,
      canary,
      stagedReadback: stagedReadbackEvidence,
      appliedReadback: appliedReadbackEvidence,
      createdCount: createdModelIds.length,
      updatedCount: changedSnapshots.length
    };
  } catch (error) {
    firstFailure = {
      code: error.code || 'LITELLM_RECONCILE_FAILED',
      message: error.message || 'LiteLLM reconcile failed.',
      httpStatus: Number(error.httpStatus || 0),
      observed: error.observed || null
    };
    const compensation = await compensate(client, [...stagedModelIds, ...createdModelIds], changedSnapshots, routerChanged ? previousRouter : null);
    return {
      ok: false,
      status: 'failed',
      stage: 'reconcile',
      errorCode: firstFailure.code,
      message: firstFailure.message,
      httpStatus: firstFailure.httpStatus,
      observed: firstFailure.observed,
      compensation,
      capability
    };
  }
}

async function canaryLiteLlmAliases(client, aliases = []) {
  const results = [];
  for (const alias of aliases) {
    const response = await client.request('POST', '/v1/chat/completions', {
      model: alias,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 8,
      stream: false
    });
    const content = String(response.payload?.choices?.[0]?.message?.content
      || response.payload?.choices?.[0]?.message?.reasoning_content
      || '').trim();
    const passed = response.ok && Boolean(content);
    results.push({ alias, status: passed ? 'passed' : 'failed', httpStatus: response.status, usagePresent: Boolean(response.payload?.usage) });
    if (!passed) return { ok: false, failedAlias: alias, httpStatus: response.status, results };
  }
  return { ok: true, results };
}

function createLiteLlmAdminClient({ baseUrl, headers = {}, fetchImpl = fetch, requestTimeoutMs = 15_000, maxResponseBytes = 2_000_000 } = {}) {
  return {
    async request(method, path, body) {
      try {
        const response = await fetchImpl(new URL(path, baseUrl), {
          method,
          headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(requestTimeoutMs)
        });
        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength > maxResponseBytes) return { ok: false, status: 502, payload: {}, error: 'LiteLLM response exceeds the allowed size.' };
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) return { ok: false, status: 502, payload: {}, error: 'LiteLLM response exceeds the allowed size.' };
        let payload = {};
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch {
            payload = {};
          }
        }
        return {
          ok: response.ok,
          status: response.status,
          payload
        };
      } catch (error) {
        return { ok: false, status: 0, payload: {}, error: error.message || 'LiteLLM request failed.' };
      }
    }
  };
}

async function compensate(client, createdModelIds, changedSnapshots, previousRouter = null) {
  const actions = [];
  for (const snapshot of [...changedSnapshots].reverse()) {
    const response = await client.request('PATCH', `/model/${encodeURIComponent(snapshot.modelId)}/update`, snapshot.body);
    actions.push({ action: 'restore', modelId: snapshot.modelId, status: response.ok ? 'restored' : 'failed', httpStatus: response.status });
  }
  for (const modelId of [...createdModelIds].reverse()) {
    const response = await client.request('POST', '/model/delete', { id: modelId });
    actions.push({ action: 'delete_staged', modelId, status: response.ok ? 'deleted' : 'failed', httpStatus: response.status });
  }
  if (previousRouter) {
    const response = await client.request('POST', '/config/update', { router_settings: previousRouter });
    actions.push({ action: 'restore_router', status: response.ok ? 'restored' : 'failed', httpStatus: response.status });
  }
  return {
    status: actions.every((item) => item.status !== 'failed') ? 'completed' : 'incomplete',
    actions
  };
}

async function readManagedRows(client) {
  const response = await client.request('GET', '/model/info');
  if (!response.ok) return failure('LITELLM_MODEL_INFO_READ_FAILED', `LiteLLM model info read failed with ${response.status}.`, { httpStatus: response.status });
  const allRows = extractModelInfoRows(response.payload);
  return { ok: true, allRows, rows: allRows.filter(isPlatformManagedRow) };
}

async function waitForModelIds(client, modelIds, options = {}) {
  const expected = new Set((Array.isArray(modelIds) ? modelIds : []).map(String).filter(Boolean));
  const scheduleMs = normalizeSettleSchedule(options.scheduleMs);
  const sleep = typeof options.sleep === 'function' ? options.sleep : delay;
  let last = null;
  let attempts = 0;
  const startedAt = Date.now();
  for (let index = 0; index < scheduleMs.length; index += 1) {
    if (scheduleMs[index] > 0) await sleep(scheduleMs[index]);
    attempts += 1;
    const response = await client.request('GET', '/model/info');
    if (!response.ok) {
      last = {
        status: 'unavailable',
        matched: false,
        failedRead: { source: 'model_info', httpStatus: response.status }
      };
      continue;
    }
    const observedIds = new Set(extractModelInfoRows(response.payload).map(modelIdFromRow).filter(Boolean));
    const missingModelIds = [...expected].filter((modelId) => !observedIds.has(modelId));
    last = { status: missingModelIds.length ? 'pending' : 'matched', matched: missingModelIds.length === 0, missingModelIds };
    if (last.matched) break;
  }
  return {
    ...(last || { status: 'pending', matched: false, missingModelIds: [...expected] }),
    readbackAttempts: attempts,
    convergenceMs: Date.now() - startedAt
  };
}

async function waitForObservedRuntime(client, desired, options = {}) {
  const scheduleMs = normalizeSettleSchedule(options.scheduleMs);
  const sleep = typeof options.sleep === 'function' ? options.sleep : delay;
  const startedAt = Date.now();
  let observed = null;
  let attempts = 0;
  for (const waitMs of scheduleMs) {
    if (waitMs > 0) await sleep(waitMs);
    attempts += 1;
    observed = await observeLiteLlmRuntime(client, desired, options);
    if (observed.matched) break;
  }
  return {
    ...(observed || {
      status: 'unavailable',
      matched: false,
      errorCode: 'LITELLM_READBACK_FAILED'
    }),
    readbackAttempts: attempts,
    convergenceMs: Date.now() - startedAt
  };
}

function settleOptions(hooks = {}) {
  return {
    scheduleMs: hooks.settleScheduleMs,
    sleep: hooks.sleep
  };
}

function normalizeSettleSchedule(value) {
  if (!Array.isArray(value) || !value.length) return [...DEFAULT_SETTLE_SCHEDULE_MS];
  return value.map((item) => Math.max(0, Math.floor(Number(item) || 0))).slice(0, 16);
}

function modelIdByManagedKey(source, managedKey) {
  if (source instanceof Map) return String(source.get(managedKey) || '');
  return String(source?.[managedKey] || '');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function modelWriteBody(target, blocked) {
  const body = {
    model_name: blocked ? stageModelName(target) : target.modelName,
    litellm_params: dynamicModelWriteParams(target),
    model_info: blocked ? { ...target.modelInfo, stage_state: 'staged' } : target.modelInfo
  };
  if (!blocked) body.blocked = false;
  return body;
}

function modelCreateBody(target, staged) {
  return {
    model_name: staged ? stageModelName(target) : target.modelName,
    litellm_params: dynamicModelWriteParams(target),
    model_info: staged ? { ...target.modelInfo, stage_state: 'staged' } : target.modelInfo
  };
}

function dynamicModelWriteParams(target) {
  const params = { ...target.litellmParams };
  if (target.credentialRuntimeMode === 'provider_default_env') delete params.api_key;
  return params;
}

function requiresCredentialRuntimeReplacement(row, target) {
  const modelInfo = row?.model_info || {};
  return String(modelInfo.credential_runtime_mode || '') !== target.credentialRuntimeMode
    || String(modelInfo.credential_ref_kind || '') !== target.credentialRefKind
    || String(modelInfo.credential_ref_name || '') !== target.credentialRefName;
}

function stageModelName(target) {
  const suffix = String(target.managedKey || target.deploymentId || 'deployment')
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .slice(0, 80);
  return `sysmlv2-stage-${suffix}`;
}

function safeManagedSnapshot(row) {
  const modelId = modelIdFromRow(row);
  const params = row.litellm_params || {};
  const apiKeyReference = safeApiKeyReferenceFromRow(row);
  if (!modelId || apiKeyReference === null) return null;
  return {
    modelId,
    body: {
      model_name: String(row.model_name || ''),
      litellm_params: compactObject({
        model: params.model,
        api_base: params.api_base,
        api_key: apiKeyReference,
        litellm_credential_name: params.litellm_credential_name,
        rpm: params.rpm,
        tpm: params.tpm,
        max_parallel_requests: params.max_parallel_requests
      }),
      model_info: row.model_info || {},
      blocked: isBlocked(row)
    }
  };
}

function safeCredentialReference(value) {
  const text = String(value || '');
  return !text || /^os\.environ\/[A-Z][A-Z0-9_]*$/.test(text);
}

function safeApiKeyReferenceFromRow(row = {}) {
  const params = row.litellm_params || {};
  if (params.api_key) return safeCredentialReference(params.api_key) ? String(params.api_key) : null;
  const kind = String(row.model_info?.credential_ref_kind || '');
  const name = String(row.model_info?.credential_ref_name || '');
  if (kind === 'environment' && /^[A-Z][A-Z0-9_]*$/.test(name)) return `os.environ/${name}`;
  return '';
}

function deploymentMatches(row, target) {
  if (isBlocked(row) || String(row.model_name || '') !== target.modelName) return false;
  return canonicalJson(comparableLitellmParams(row.litellm_params)) === canonicalJson(comparableLitellmParams(target.litellmParams))
    && managedKeyFromRow(row) === target.managedKey
    && String(row.model_info?.alias_id || '') === target.aliasId
    && String(row.model_info?.deployment_id || '') === target.deploymentId
    && Number(row.model_info?.member_priority || 0) === target.memberPriority
    && Number(row.model_info?.member_weight || 0) === target.memberWeight
    && String(row.model_info?.credential_ref_kind || '') === target.credentialRefKind
    && String(row.model_info?.credential_ref_name || '') === target.credentialRefName
    && String(row.model_info?.provider_default_key_env || '') === target.providerDefaultKeyEnv
    && String(row.model_info?.credential_runtime_mode || '') === target.credentialRuntimeMode;
}

function deploymentMismatchFields(row, target) {
  const fields = [];
  if (isBlocked(row)) fields.push('blocked');
  if (String(row.model_name || '') !== target.modelName) fields.push('model_name');
  const observed = comparableObservedDeployment(row);
  if (canonicalJson(observed.litellmParams) !== canonicalJson(comparableLitellmParams(target.litellmParams))) fields.push('litellm_params');
  if (managedKeyFromRow(row) !== target.managedKey) fields.push('managed_key');
  if (String(row.model_info?.alias_id || '') !== target.aliasId) fields.push('alias_id');
  if (String(row.model_info?.deployment_id || '') !== target.deploymentId) fields.push('deployment_id');
  if (Number(row.model_info?.member_priority || 0) !== target.memberPriority) fields.push('member_priority');
  if (Number(row.model_info?.member_weight || 0) !== target.memberWeight) fields.push('member_weight');
  if (String(row.model_info?.credential_ref_kind || '') !== target.credentialRefKind) fields.push('credential_ref_kind');
  if (String(row.model_info?.credential_ref_name || '') !== target.credentialRefName) fields.push('credential_ref_name');
  if (String(row.model_info?.provider_default_key_env || '') !== target.providerDefaultKeyEnv) fields.push('provider_default_key_env');
  if (String(row.model_info?.credential_runtime_mode || '') !== target.credentialRuntimeMode) fields.push('credential_runtime_mode');
  return fields;
}

function comparableDesiredDeployment(target) {
  return {
    managedKey: target.managedKey,
    modelName: target.modelName,
    aliasId: target.aliasId,
    deploymentId: target.deploymentId,
    memberPriority: target.memberPriority,
    memberWeight: target.memberWeight,
    credentialRefKind: target.credentialRefKind,
    credentialRefName: target.credentialRefName,
    providerDefaultKeyEnv: target.providerDefaultKeyEnv,
    credentialRuntimeMode: target.credentialRuntimeMode,
    litellmParams: comparableLitellmParams(target.litellmParams)
  };
}

function comparableObservedDeployment(row) {
  const params = row.litellm_params || {};
  return {
    managedKey: managedKeyFromRow(row),
    modelName: String(row.model_name || ''),
    aliasId: String(row.model_info?.alias_id || ''),
    deploymentId: String(row.model_info?.deployment_id || ''),
    memberPriority: Number(row.model_info?.member_priority || 0),
    memberWeight: Number(row.model_info?.member_weight || 0),
    credentialRefKind: String(row.model_info?.credential_ref_kind || ''),
    credentialRefName: String(row.model_info?.credential_ref_name || ''),
    providerDefaultKeyEnv: String(row.model_info?.provider_default_key_env || ''),
    credentialRuntimeMode: String(row.model_info?.credential_runtime_mode || ''),
    litellmParams: comparableLitellmParams(params)
  };
}

function comparableLitellmParams(params = {}) {
  return compactObject({
    model: params.model,
    api_base: params.api_base,
    litellm_credential_name: params.litellm_credential_name,
    rpm: positiveOrUndefined(params.rpm),
    tpm: positiveOrUndefined(params.tpm),
    max_parallel_requests: positiveOrUndefined(params.max_parallel_requests)
  });
}

function comparableRouterSettings(payload = {}) {
  const source = payload.router_settings || payload.current_values || payload;
  return {
    routing_strategy: String(source.routing_strategy || 'simple-shuffle'),
    num_retries: Number(source.num_retries || 0),
    allowed_fails: Number(source.allowed_fails || 0),
    cooldown_time: Number(source.cooldown_time || 0)
  };
}

function extractModelInfoRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.models)) return payload.models;
  return [];
}

function extractModelAliases(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return [...new Set(rows.map((row) => String(row?.id || row?.model_name || '')).filter(Boolean))].sort();
}

function extractModelId(payload) {
  return String(payload?.model_id || payload?.modelInfo?.model_id || payload?.model_info?.model_id || payload?.id || '');
}

function modelIdFromRow(row = {}) {
  return String(row.model_info?.id || row.model_info?.model_id || row.model_id || row.id || '');
}

function managedKeyFromRow(row = {}) {
  return String(row.model_info?.managed_key || '');
}

function isPlatformManagedRow(row = {}) {
  // LiteLLM can merge dynamic model metadata into a matching static-config row
  // after traffic is routed. Static rows advertise db_model=false and must not
  // become owned deployments or inflate read-back cardinality.
  return row.model_info?.managed_by === MANAGED_BY && row.model_info?.db_model !== false;
}

function isBlocked(row = {}) {
  return row.blocked === true || row.model_info?.blocked === true;
}

function compactObject(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== '' && item !== undefined && item !== null));
}

function positiveOrUndefined(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestJson(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function reconcileError(code, message, httpStatus) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

function failure(errorCode, message, details = {}) {
  return { ok: false, errorCode, message, ...details };
}

module.exports = {
  MANAGED_BY,
  buildLiteLlmDesiredState,
  createLiteLlmAdminClient,
  dynamicEnvironmentCredentialIssues,
  observeLiteLlmRuntime,
  providerDefaultApiKeyEnv,
  probeLiteLlmReconcileCapabilities,
  reconcileLiteLlmRuntime,
  validateLiteLlmReferenceClosure,
  waitForObservedRuntime
};
