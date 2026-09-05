'use strict';

const assert = require('assert');
const { BOOTSTRAP_VALUES, checksumPolicyValues, validatePolicyValues, migratePolicyValues } = require('../packages/agent-resource-policy');
const { createAccountStore, agentResourcePolicyStoreTesting } = require('../apps/api/account-store');
const { defaultLiteLlmConfig } = require('../apps/api/litellm-config');

const MIGRATION_NOW = '2026-08-12T00:00:00.000Z';

async function main() {
  const legacyReasoning = { ...BOOTSTRAP_VALUES,
    'model.mainReasoningPolicy': 'provider-managed',
    'model.finalizerReasoningPolicy': 'provider-managed' };
  delete legacyReasoning['stage.main.reasoningPolicy'];
  delete legacyReasoning['stage.finalizer.reasoningPolicy'];
  const migratedReasoning = migratePolicyValues(legacyReasoning);
  assert.deepEqual(migratedReasoning.unknownKeys, []);
  assert.equal(migratedReasoning.values['stage.main.reasoningPolicy'], 'provider-managed');
  assert.equal(migratedReasoning.values['stage.finalizer.reasoningPolicy'], 'provider-managed');
  const currentReasoningWins = migratePolicyValues({ ...legacyReasoning,
    'stage.main.reasoningPolicy': 'disabled', 'stage.finalizer.reasoningPolicy': 'disabled' });
  assert.equal(currentReasoningWins.values['stage.main.reasoningPolicy'], 'disabled');
  assert.equal(currentReasoningWins.values['stage.finalizer.reasoningPolicy'], 'disabled');
  const emptyMemory = createAccountStore({ agentResourcePolicyVersions: [] });
  const [seed] = await emptyMemory.listAgentResourcePolicyVersions();
  assert.equal(seed.versionId, 'arp_bootstrap_v24');
  assert.equal(validatePolicyValues(seed.values).ok, true);

  const source = v7Version();
  const direct = migratePolicyValues(source.values);
  assert.equal(direct.values['run.maxDurationMs'], 570000);
  assert.equal(direct.values['run.finalizationReserveMs'], 30000);
  assert.equal(direct.values['knowledge.reviewedMaxNewQueriesPerRun'], undefined,
    '退役的知识专属查询门禁必须从迁移结果删除。');
  assert.equal(direct.values['tool.maxRetriesPerOperation'], 2);
  assert.equal(direct.values['context.studentQuestionMaxChars'], 16000);
  assert.equal(direct.values['scope.hardInputTokenBudget'], 4096);
  assert.equal(direct.values['tool.inputMaxBytes'], 2048,
    '历史已发布的 Tool 入参上限必须原样迁移，不能被当前默认值覆盖。');
  assert.equal(direct.values['context.mainExecutionReserveTokens'], 4096);
  assert.equal(Object.hasOwn(direct.values, 'tool.maxFailuresPerRun'), false);
  assert.equal(direct.values['stage.main.modelRoute'], 'ai-teacher-fast');
  assert.equal(Object.hasOwn(direct.values, 'stage.repair.maxOutputTokens'), false);
  assert.equal(direct.values['candidate.maxGenerationAttempts'], 2);
  assert.equal(Object.hasOwn(direct.values, 'run.maxRecoveryAttempts'), false);
  assert.equal(Object.hasOwn(direct.values, 'context.windowTokens'), false);
  assert.equal(Object.hasOwn(direct.values, 'validator.maxUniqueCandidatesPerRun'), false);
  assert(direct.deprecatedKeys.includes('tool.inspectCurrentModelMaxCallsPerRun'));
  assert.deepEqual(direct.unknownKeys, []);

  const memoryStore = createAccountStore({ agentResourcePolicyVersions: [source] });
  const memoryVersions = await memoryStore.listAgentResourcePolicyVersions();
  assertMigrated(memoryVersions, source);
  assert.equal(source.status, 'active', 'migration must not mutate caller-owned source rows');
  const idempotent = agentResourcePolicyStoreTesting.migrateMemoryAgentResourcePolicyVersions(memoryVersions, { now: MIGRATION_NOW });
  assert.equal(idempotent.length, 2);
  assertMigrated(idempotent, source);

  const emptyPostgres = createFakePolicyPool([]);
  await agentResourcePolicyStoreTesting.migratePostgresAgentResourcePolicyVersions(emptyPostgres, { now: MIGRATION_NOW });
  assert.equal(publicRow(emptyPostgres.rows[0]).versionId, 'arp_bootstrap_v24');

  const postgres = createFakePolicyPool([databaseRow(source)]);
  await agentResourcePolicyStoreTesting.migratePostgresAgentResourcePolicyVersions(postgres, { now: MIGRATION_NOW });
  await agentResourcePolicyStoreTesting.migratePostgresAgentResourcePolicyVersions(postgres, { now: MIGRATION_NOW });
  assert.equal(postgres.rows.length, 2);
  assertMigrated(postgres.rows.map(publicRow), source);

  const invalid = v7Version();
  invalid.values['unknown.resource.gate'] = 1;
  invalid.checksum = checksumPolicyValues(invalid.values);
  assert.throws(() => agentResourcePolicyStoreTesting.migrateMemoryAgentResourcePolicyVersions([invalid]), (error) => error?.code === 'AGENT_RESOURCE_POLICY_SCHEMA_MIGRATION_INVALID');
  const invalidPostgres = createFakePolicyPool([databaseRow(invalid)]);
  await assert.rejects(agentResourcePolicyStoreTesting.migratePostgresAgentResourcePolicyVersions(invalidPostgres, { now: MIGRATION_NOW }), (error) => error?.code === 'AGENT_RESOURCE_POLICY_SCHEMA_MIGRATION_INVALID');
  assert.equal(invalidPostgres.rows[0].status, 'active');

  const currentFieldWins = migratePolicyValues({
    ...BOOTSTRAP_VALUES,
    'candidate.maxGenerationAttempts': 4,
    'run.maxRecoveryAttempts': 0
  });
  assert.equal(currentFieldWins.values['candidate.maxGenerationAttempts'], 4,
    'A published candidate attempt value must win over the retired recovery alias.');

  const singleAliasRegistry = { profiles: [{
    aliasId: 'legacy_alias_reasoning_only',
    litellmAlias: 'ai-teacher-reasoning',
    runtimeProtocolStatus: 'ready'
  }] };
  const sparseModelRouteSource = {
    ...BOOTSTRAP_VALUES,
    'stage.candidate.modelRoute': 'ai-teacher-reasoning',
    'stage.repair.modelRoute': 'ai-teacher-reasoning',
    'semanticReview.modelRoute': 'ai-teacher-reasoning'
  };
  sparseModelRouteSource['stage.main.modelRoute'] = null;
  sparseModelRouteSource['stage.finalizer.modelRoute'] = '';
  sparseModelRouteSource['scope.modelRoute'] = '   ';
  const sparseModelRouteMigration = migratePolicyValues(sparseModelRouteSource, { modelRegistry: singleAliasRegistry });
  for (const key of [
    'stage.main.modelRoute',
    'stage.candidate.modelRoute',
    'stage.repair.modelRoute',
    'stage.finalizer.modelRoute',
    'scope.modelRoute',
    'semanticReview.modelRoute'
  ]) {
    assert.equal(sparseModelRouteMigration.values[key], 'legacy_alias_reasoning_only',
      `a missing or blank historical ${key} must bind to the only registered executable 运行环境 Alias during schema migration`);
  }
  const legacyDefaultRouteMigration = migratePolicyValues(BOOTSTRAP_VALUES, { modelRegistry: singleAliasRegistry });
  for (const key of [
    'stage.main.modelRoute',
    'stage.candidate.modelRoute',
    'stage.repair.modelRoute',
    'stage.finalizer.modelRoute',
    'scope.modelRoute',
    'semanticReview.modelRoute'
  ]) {
    assert.equal(legacyDefaultRouteMigration.values[key], 'legacy_alias_reasoning_only',
      `an unavailable legacy default ${key} must bind to the only executable 运行环境 Alias during schema migration`);
  }
  const registryWithUnusedAlias = { profiles: [
    ...singleAliasRegistry.profiles,
    { aliasId: 'legacy_alias_unused', litellmAlias: 'ai-teacher-unused', runtimeProtocolStatus: 'ready' }
  ] };
  const consensusRouteMigration = migratePolicyValues(BOOTSTRAP_VALUES, { modelRegistry: registryWithUnusedAlias });
  for (const key of ['stage.main.modelRoute', 'stage.finalizer.modelRoute', 'scope.modelRoute']) {
    assert.equal(consensusRouteMigration.values[key], 'legacy_alias_reasoning_only',
      `an unavailable legacy default ${key} must use the unique executable Alias already resolved by sibling stage routes`);
  }
  const environmentSpecificRegistry = { profiles: [
    { aliasId: 'alias-env-fast', litellmAlias: 'ai-teacher-fast-dp', runtimeProtocolStatus: 'ready' },
    { aliasId: 'alias-env-reasoning', litellmAlias: 'ai-teacher-reasoning-dp', runtimeProtocolStatus: 'ready' }
  ] };
  const environmentSpecificMigration = migratePolicyValues(BOOTSTRAP_VALUES, { modelRegistry: environmentSpecificRegistry });
  for (const key of ['stage.main.modelRoute', 'stage.finalizer.modelRoute', 'scope.modelRoute']) {
    assert.equal(environmentSpecificMigration.values[key], 'alias-env-fast',
      `legacy fast default ${key} must bind to the unique executable environment-specific fast Alias family`);
  }
  for (const key of ['stage.candidate.modelRoute', 'stage.repair.modelRoute', 'semanticReview.modelRoute']) {
    assert.equal(environmentSpecificMigration.values[key], 'alias-env-reasoning',
      `legacy reasoning default ${key} must bind to the unique executable environment-specific reasoning Alias family`);
  }
  assert.throws(() => migratePolicyValues(BOOTSTRAP_VALUES, { modelRegistry: { profiles: [
    ...environmentSpecificRegistry.profiles,
    { aliasId: 'alias-env-fast-secondary', litellmAlias: 'ai-teacher-fast-secondary', runtimeProtocolStatus: 'ready' }
  ] } }), (error) => error?.code === 'AGENT_RESOURCE_POLICY_SCHEMA_MIGRATION_INVALID',
  'multiple executable environment-specific Alias family matches must remain fail-closed');
  const unreadyFastRegistry = { profiles: [
    { aliasId: 'alias-unready-fast', litellmAlias: 'ai-teacher-fast', runtimeProtocolStatus: 'unsupported' },
    { aliasId: 'alias-ready-reasoning', litellmAlias: 'ai-teacher-reasoning', runtimeProtocolStatus: 'ready' }
  ] };
  const unreadyFastMigration = migratePolicyValues(BOOTSTRAP_VALUES, { modelRegistry: unreadyFastRegistry });
  for (const key of ['stage.main.modelRoute', 'stage.finalizer.modelRoute', 'scope.modelRoute']) {
    assert.equal(unreadyFastMigration.values[key], 'alias-ready-reasoning',
      `legacy default ${key} may use the unique ready sibling consensus when its matching Active profile is protocol-unready`);
  }
  assert.throws(() => migratePolicyValues({
    ...BOOTSTRAP_VALUES,
    'stage.main.modelRoute': 'alias-unready-fast'
  }, { modelRegistry: unreadyFastRegistry }), (error) => error?.code === 'AGENT_RESOURCE_POLICY_SCHEMA_MIGRATION_INVALID',
  'an explicitly selected protocol-unready Alias must remain fail-closed');
  assert.throws(() => migratePolicyValues({
    ...sparseModelRouteSource,
    'stage.main.modelRoute': 'explicit-unregistered-alias'
  }, { modelRegistry: singleAliasRegistry }), (error) => {
    assert.equal(error?.code, 'AGENT_RESOURCE_POLICY_SCHEMA_MIGRATION_INVALID');
    assert.equal(error?.details?.migrationDiagnostics?.registryProfileCount, 1);
    assert.equal(error?.details?.migrationDiagnostics?.executableProfileCount, 1);
    assert(error.details.migrationDiagnostics.routes.every((item) => typeof item.key === 'string'
      && typeof item.targetPresent === 'boolean' && typeof item.targetNonBlank === 'boolean'
      && typeof item.legacyPresent === 'boolean' && typeof item.legacyNonBlank === 'boolean'
      && typeof item.selectedMatchesLegacyDefault === 'boolean' && typeof item.fallbackEligible === 'boolean'
      && Number.isInteger(item.bootstrapFamilyMatchCount)
      && typeof item.resolved === 'boolean'));
    return true;
  },
  'an explicitly configured unregistered Alias must remain fail-closed instead of using the migration fallback');
  const fullyMissingRouteSource = { ...BOOTSTRAP_VALUES };
  for (const key of [
    'stage.main.modelRoute', 'stage.candidate.modelRoute', 'stage.repair.modelRoute',
    'stage.finalizer.modelRoute', 'scope.modelRoute', 'semanticReview.modelRoute'
  ]) fullyMissingRouteSource[key] = '';
  assert.throws(() => migratePolicyValues(fullyMissingRouteSource, { modelRegistry: registryWithUnusedAlias }),
    (error) => error?.code === 'AGENT_RESOURCE_POLICY_SCHEMA_MIGRATION_INVALID',
    'missing routes must remain fail-closed when the policy has no resolved Alias consensus and the registry has multiple executable fallbacks');

  const liveTwoStageRemnant = {
    versionId: 'arp_schema_v17_live_two_stage_remnant',
    sequence: 17,
    status: 'active',
    values: {
      ...BOOTSTRAP_VALUES,
      'repair.materializationMode': 'two_stage',
      'repair.decisionMaxOutputTokens': 1600,
      'repair.materializationMaxOutputTokens': 32000,
      'repair.materializationThinking': 'none'
    },
    checksum: checksumPolicyValues(BOOTSTRAP_VALUES),
    validation: { ok: true, errors: [], warnings: [] },
    sourceVersionId: 'arp_legacy_v15',
    notes: 'local auth-db published two-stage remnant',
    createdBy: 'test',
    validatedAt: MIGRATION_NOW,
    publishedBy: 'test',
    createdAt: MIGRATION_NOW,
    publishedAt: MIGRATION_NOW
  };
  const remnantMemory = createAccountStore({ agentResourcePolicyVersions: [liveTwoStageRemnant] });
  const remnantVersions = await remnantMemory.listAgentResourcePolicyVersions();
  const remnantActive = remnantVersions.find((item) => item.status === 'active');
  assert.equal(validatePolicyValues(remnantActive.values).ok, true);
  assert.equal(Object.hasOwn(remnantActive.values, 'repair.materializationMaxOutputTokens'), false);
  const remnantPostgres = createFakePolicyPool([databaseRow(liveTwoStageRemnant)]);
  await agentResourcePolicyStoreTesting.migratePostgresAgentResourcePolicyVersions(remnantPostgres, { now: MIGRATION_NOW });
  assert.equal(validatePolicyValues(publicRow(remnantPostgres.rows.find((row) => row.status === 'active')).values).ok, true);

  console.log('Agent resource policy v7 through v23 to v24 migration tests passed.');
}

function v7Version() {
  const values = {
    'api.outerTimeoutMs': 630000, 'run.maxSteps': 8, 'run.maxDurationMs': 570000, 'run.terminalReserveMs': 30000,
    'run.convergeLeadMs': 75000, 'run.toolTimeoutMs': 75000, 'run.terminalPersistTimeoutMs': 5000,
    'scope.enabled': true, 'scope.initialTimeoutMs': 10000, 'scope.reviewTimeoutMs': 18000, 'scope.hardInputTokenBudget': 4096, 'scope.maxOutputTokens': 500,
    'answer.hardMaxOutputTokens': 16000, 'answer.contextWindowTokens': 64000, 'answer.lowMaxOutputTokens': 3000, 'answer.mediumMaxOutputTokens': 4500, 'answer.highMaxOutputTokens': 6000,
    'tool.inspectLessonContextMaxCallsPerRun': 1, 'tool.inspectCurrentModelMaxCallsPerRun': 1, 'tool.skillGuidanceMaxCallsPerRun': 2, 'tool.reviewedKnowledgeMaxCallsPerRun': 20, 'tool.domainEvidenceMaxCallsPerRun': 2,
    'tool.maxFailuresPerRun': 3, 'tool.inputMaxBytes': 2048, 'tool.outputMaxBytesPerCall': 16000, 'tool.totalOutputMaxBytesPerRun': 48000, 'tool.readOnlyTimeoutMs': 10000, 'tool.domainEvidenceTimeoutMs': 60000,
    'knowledge.reviewedMaxNewQueriesPerRun': 2, 'candidate.recoveryMaxAttempts': 1, 'candidate.maxAttemptMs': 420000, 'candidate.repairEnabled': true, 'candidate.maxValidatorCallsPerWorker': 12,
    'repair.phaseReserveMs': 120000, 'repair.maxOutputTokens': 32000,
    'semanticReview.enabled': false, 'semanticReview.shadowOnly': false, 'semanticReview.assessmentMaxCalls': 1, 'semanticReview.assessmentTimeoutMs': 120000, 'semanticReview.mainDecisionTimeoutMs': 20000, 'semanticReview.verificationMaxCalls': 1, 'semanticReview.verificationTimeoutMs': 30000, 'semanticReview.maxOutputTokens': 12000, 'semanticReview.maxIssues': 8, 'semanticReview.minimumCompleteChainMs': 180000, 'semanticReview.domainSearchReserveMs': 0,
    'engineeringRevision.maxCycles': 1, 'engineeringRevision.maxDurationMs': 330000, 'engineeringRevision.validationRepairReserveMs': 255000,
    'engineeringImprovement.runMaxDurationMs': 900000, 'engineeringImprovement.apiOuterTimeoutMs': 930000, 'engineeringImprovement.lineageMaxDurationMs': 1500000, 'engineeringImprovement.orchestrationReserveMs': 20000, 'engineeringImprovement.minimumCompleteChainMs': 720000,
    'validator.queueLimit': 8, 'validator.queueWaitMs': 15000, 'validator.executionTimeoutMs': 25000, 'validator.toolTimeoutMs': 45000, 'validator.transientRetryMax': 1, 'validator.maxInFlight': 1,
    'provider.maxConcurrency': 2, 'provider.queueLimit': 20, 'provider.queueTimeoutMs': 8000, 'provider.maxRetries': 1, 'provider.retryJitter': true, 'provider.retryBaseMs': 500, 'provider.retryMaxMs': 3000, 'provider.circuitFailureThreshold': 5, 'provider.circuitFailureWindowMs': 60000, 'provider.circuitOpenMs': 30000, 'provider.halfOpenMaxProbes': 1,
    'probe.enabled': true, 'probe.hourlyLimit': 6, 'probe.timeoutMs': 30000,
    'model.fastRoute': 'ai-teacher-fast', 'model.mainRoute': 'ai-teacher-fast', 'model.candidateRoute': 'ai-teacher-reasoning', 'model.repairRoute': 'ai-teacher-reasoning', 'model.semanticReviewRoute': 'ai-teacher-reasoning', 'model.finalizerRoute': 'ai-teacher-fast'
  };
  return { versionId: 'arp_legacy_v7', sequence: 7, status: 'active', values, checksum: checksumPolicyValues(values), validation: { ok: true, errors: [], warnings: [] }, sourceVersionId: '', notes: 'v7 fixture', createdBy: 'test', validatedAt: MIGRATION_NOW, publishedBy: 'test', createdAt: MIGRATION_NOW, publishedAt: MIGRATION_NOW };
}

function assertMigrated(versions, source) {
  const old = versions.find((item) => item.versionId === source.versionId);
  const active = versions.find((item) => item.status === 'active');
  assert(old && active);
  assert.equal(old.status, 'retired');
  assert.deepEqual(old.values, source.values);
  assert.match(active.versionId, /^arp_schema_v24_[a-f0-9]{24}$/u);
  assert.equal(active.sourceVersionId, source.versionId);
  assert.equal(active.values['run.maxDurationMs'], 570000);
  assert.equal(active.values['knowledge.reviewedMaxNewQueriesPerRun'], undefined);
  assert.equal(active.values['knowledge.exampleMaxPerQuery'], undefined);
  assert.equal(active.values['knowledge.exampleViewTokenBudget'], undefined);
  assert.equal(active.values['knowledge.exampleInjectionEnabled'], undefined);
  assert.equal(active.values['context.studentQuestionMaxChars'], 16000);
  assert.equal(active.values['scope.hardInputTokenBudget'], 4096);
  assert.equal(active.values['tool.inputMaxBytes'], 2048);
  assert.equal(active.values['context.mainExecutionReserveTokens'], 4096);
  assert.equal(active.values['tool.maxRetriesPerOperation'], 2);
  assert.equal(Object.hasOwn(active.values, 'tool.maxFailuresPerRun'), false);
  assert.equal(Object.hasOwn(active.values, 'stage.main.maxOutputTokens'), false);
  assert.equal(Object.hasOwn(active.values, 'stage.candidate.maxOutputTokens'), false);
  assert.equal(Object.hasOwn(active.values, 'stage.repair.maxOutputTokens'), false);
  assert.equal(Object.hasOwn(active.values, 'stage.finalizer.maxOutputTokens'), false);
  assert.equal(Object.hasOwn(active.values, 'run.maxRecoveryAttempts'), false);
  assert.equal(Object.hasOwn(active.values, 'context.windowTokens'), false);
  assert.equal(Object.hasOwn(active.values, 'validator.maxUniqueCandidatesPerRun'), false);
  assert.equal(Object.hasOwn(active.values, 'repair.materializationMode'), false);
  assert.equal(Object.hasOwn(active.values, 'repair.decisionMaxOutputTokens'), false);
  assert.equal(Object.hasOwn(active.values, 'repair.materializationMaxOutputTokens'), false);
  assert.equal(Object.hasOwn(active.values, 'repair.materializationThinking'), false);
  assert.equal(validatePolicyValues(active.values).ok, true);
  assert.equal(active.checksum, checksumPolicyValues(active.values));
}

function createFakePolicyPool(initialRows) {
  const state = { rows: initialRows.map((row) => ({ ...row })) };
  const client = { query: async (sql, params = []) => {
    const normalized = sql.trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(normalized) || normalized.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
    if (normalized.includes('from ai_teacher_agent_policy_versions') && normalized.includes("where status = 'active'")) {
      const row = state.rows.filter((item) => item.status === 'active').sort((a, b) => Number(b.sequence || 0) - Number(a.sequence || 0))[0];
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (normalized.includes('from ai_teacher_litellm_config_versions') && normalized.includes("where status = 'active'")) {
      return { rows: [{
        version_id: 'default-litellm-config-v1', status: 'active', config_json: defaultLiteLlmConfig(),
        rendered_yaml: '', checksum: 'test-checksum', validation_json: { ok: true },
        created_by: 'test', published_by: 'test', notes: '', created_at: MIGRATION_NOW, published_at: MIGRATION_NOW
      }], rowCount: 1 };
    }
    if (normalized.startsWith('update ai_teacher_agent_policy_versions') && normalized.includes("set status = 'retired'")) {
      const row = state.rows.find((item) => item.version_id === params[0] && item.status === 'active');
      if (row) row.status = 'retired';
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (normalized.startsWith('insert into ai_teacher_agent_policy_versions')) {
      state.rows.push({ version_id: params[0], sequence: Math.max(0, ...state.rows.map((item) => Number(item.sequence || 0))) + 1, status: 'active', values_json: params[1], checksum: params[2], validation_json: params[3], source_version_id: params[4], notes: params[5], created_by: params[6], validated_at: params[7], published_by: params[6], created_at: params[7], published_at: params[7] });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, release() {} };
  return { get rows() { return state.rows; }, connect: async () => client };
}

function databaseRow(version) { return { version_id: version.versionId, sequence: version.sequence, status: version.status, values_json: JSON.stringify(version.values), checksum: version.checksum, validation_json: JSON.stringify(version.validation), source_version_id: version.sourceVersionId, notes: version.notes, created_by: version.createdBy, validated_at: version.validatedAt, published_by: version.publishedBy, created_at: version.createdAt, published_at: version.publishedAt }; }
function publicRow(row) { return { versionId: row.version_id, sequence: row.sequence, status: row.status, values: JSON.parse(row.values_json), checksum: row.checksum, validation: JSON.parse(row.validation_json), sourceVersionId: row.source_version_id || '', notes: row.notes, createdBy: row.created_by, validatedAt: row.validated_at, publishedBy: row.published_by, createdAt: row.created_at, publishedAt: row.published_at }; }

main().catch((error) => { console.error(error); process.exitCode = 1; });
