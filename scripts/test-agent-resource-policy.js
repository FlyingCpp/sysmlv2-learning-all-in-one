'use strict';

const assert = require('node:assert/strict');
const {
  SCHEMA_VERSION,
  BOOTSTRAP_VALUES,
  DEPRECATED_KEYS,
  STUDENT_QUESTION_PROTOCOL_CEILING,
  catalog,
  validatePolicyValues,
  validatePolicySnapshot,
  createPolicySnapshot,
  runtimeProjection,
  deriveRequestEnvelopeMaxBytes,
  migratePolicyValues,
  resolvePolicyModelReferenceValues,
  diffPolicyValues
} = require('../packages/agent-resource-policy');

const currentCatalog = catalog();
const valid = validatePolicyValues(BOOTSTRAP_VALUES);
assert.equal(valid.ok, true, JSON.stringify(valid.errors));
assert.equal(SCHEMA_VERSION, 24);
assert.equal(currentCatalog.schemaVersion, 24);
assert.equal(currentCatalog.definitions.length, 45);
assert.equal(currentCatalog.definitions.length, Object.keys(BOOTSTRAP_VALUES).length);
assert(currentCatalog.definitions.every((definition) => ['teacher', 'validator', 'provider'].includes(definition.owner)));
assert(currentCatalog.definitions.every((definition) => typeof definition.description === 'string' && definition.description.length > 0));
assert(currentCatalog.definitions
  .filter((definition) => definition.valueType === 'integer')
  .every((definition) => definition.minimum !== definition.maximum));

assert.equal(BOOTSTRAP_VALUES['tool.maxCallsPerRun'], 12);
assert.equal(BOOTSTRAP_VALUES['tool.maxRetriesPerOperation'], 2);
for (const key of ['knowledge.reviewedMaxNewQueriesPerRun','knowledge.exampleMaxPerQuery','knowledge.exampleViewTokenBudget','knowledge.exampleInjectionEnabled','mainReview.modelRoute','mainReview.thinkingEnabled','mainReview.timeoutMs']) {
  assert.equal(BOOTSTRAP_VALUES[key], undefined);
  assert(DEPRECATED_KEYS[key]);
  assert.equal(migratePolicyValues({...BOOTSTRAP_VALUES, [key]: 'historical-value'}).values[key], undefined);
}
assert.equal(runtimeProjection(BOOTSTRAP_VALUES).teacher.agentStageModelRoutes.mainReview, undefined);
assert.equal(BOOTSTRAP_VALUES['stage.finalizer.reasoningPolicy'], 'disabled');
assert.equal(BOOTSTRAP_VALUES['stage.temperaturePermille'], 0);
assert.equal(BOOTSTRAP_VALUES['run.maxAutoContinuationsPerLineage'], 1);
assert.equal(BOOTSTRAP_VALUES['candidate.maxArtifactBytes'], 262144);
assert.equal(BOOTSTRAP_VALUES['context.studentQuestionMaxChars'], 16000);
assert.equal(BOOTSTRAP_VALUES['scope.hardInputTokenBudget'], 4096);
assert.equal(BOOTSTRAP_VALUES['tool.inputMaxBytes'], 8192);
assert.equal(BOOTSTRAP_VALUES['context.mainExecutionReserveTokens'], 4096);
const studentQuestionDefinition = currentCatalog.definitions.find((item) => item.key === 'context.studentQuestionMaxChars');
assert.equal(studentQuestionDefinition.minimum, 4000);
assert.equal(studentQuestionDefinition.maximum, 20000);
assert.equal(studentQuestionDefinition.maximum, STUDENT_QUESTION_PROTOCOL_CEILING);
const taskSourceDefinition = currentCatalog.definitions.find((item) => item.key === 'context.taskSourceMaxEntries');
assert.equal(taskSourceDefinition.defaultValue, 8);
assert.equal(taskSourceDefinition.minimum, 2);
assert.equal(taskSourceDefinition.maximum, 16);
assert.match(taskSourceDefinition.description, /Run Snapshot/u);
const domainEvidenceOutputDefinition = currentCatalog.definitions.find((item) => (
  item.key === 'domainEvidence.maxOutputTokensPerQuery'
));
assert.equal(domainEvidenceOutputDefinition.label, 'Domain Evidence 单问题辅助输出帽');
assert.match(domainEvidenceOutputDefinition.description, /成本与延迟/u);
assert.match(domainEvidenceOutputDefinition.description, /不限制Main、Candidate、Repair或Finalizer/u);
const scopeOutputDefinition = currentCatalog.definitions.find((item) => item.key === 'scope.maxOutputTokens');
assert.equal(scopeOutputDefinition.label, 'Scope Gate 协议输出帽');
assert.match(scopeOutputDefinition.description, /协议判读/u);
assert.match(scopeOutputDefinition.description, /不限制面向用户的正文回答/u);
const toolRetryDefinition = currentCatalog.definitions.find((item) => item.key === 'tool.maxRetriesPerOperation');
assert.equal(toolRetryDefinition.defaultValue, 2);
assert.equal(toolRetryDefinition.minimum, 0);
assert.equal(toolRetryDefinition.maximum, 2);
assert.match(toolRetryDefinition.description, /不同 Tool 和不同操作不共享失败计数/u);
assert.equal(currentCatalog.hardInvariants.length, 6);
assert(currentCatalog.hardInvariants.some((item) => item.key === 'validator.required'));
assert(currentCatalog.hardInvariants.some((item) => item.key === 'delivery.unvalidatedCodeWithheld'));

for (const removed of [
  'tool.inspectLessonContextMaxCallsPerRun',
  'tool.inspectCurrentModelMaxCallsPerRun',
  'tool.skillGuidanceMaxCallsPerRun',
  'tool.reviewedKnowledgeMaxCallsPerRun',
  'tool.domainEvidenceMaxCallsPerRun',
  'run.maxSteps',
  'api.outerTimeoutMs',
  'context.historyMaxMessages',
  'context.historyMaxTokens',
  'tool.maxVisibleOutputBytesPerRun',
  'tool.semanticCompressionReviewedKnowledgeEnabled',
  'tool.semanticCompressionSkillGuidanceEnabled',
  'tool.semanticCompressionDomainEvidenceEnabled',
  'validator.maxInFlight',
  'provider.queueWaitMs',
  'provider.requestTimeoutMs',
  'provider.maxRetries',
  'provider.retryJitter',
  'provider.retryBaseMs',
  'provider.retryMaxMs',
  'provider.circuitFailureThreshold',
  'provider.circuitFailureWindowMs',
  'provider.circuitOpenMs',
  'provider.halfOpenMaxProbes'
  ,'stage.main.maxOutputTokens'
  ,'stage.candidate.maxOutputTokens'
  ,'stage.repair.maxOutputTokens'
  ,'stage.finalizer.maxOutputTokens'
  ,'tool.maxFailuresPerRun'
  ,'run.maxRecoveryAttempts'
  ,'context.windowTokens'
  ,'validator.maxUniqueCandidatesPerRun'
]) {
  assert(!Object.hasOwn(BOOTSTRAP_VALUES, removed), `${removed} must not remain active in v14.`);
  assert(Object.hasOwn(DEPRECATED_KEYS, removed), `${removed} must have an explicit migration disposition.`);
}

const unknown = validatePolicyValues({ ...BOOTSTRAP_VALUES, 'run.unknown': 1 });
assert.equal(unknown.ok, false);
assert(unknown.errors.some((item) => item.code === 'POLICY_FIELD_UNKNOWN'));

const enumConflict = validatePolicyValues({ ...BOOTSTRAP_VALUES, 'stage.main.reasoningPolicy': 'hardcoded' });
assert.equal(enumConflict.ok, false);
assert(enumConflict.errors.some((item) => item.code === 'POLICY_FIELD_ENUM'));

const crossFieldConflict = validatePolicyValues({
  ...BOOTSTRAP_VALUES,
  'run.maxDurationMs': 120000,
  'run.finalizationReserveMs': 120000
});
assert.equal(crossFieldConflict.ok, false);
assert(crossFieldConflict.errors.some((item) => item.code === 'POLICY_CROSS_FIELD_CONFLICT'));

const modelRegistry = { profiles: [
  { aliasId: 'alias-fast-id', litellmAlias: 'ai-teacher-fast' },
  { aliasId: 'alias-reasoning-id', litellmAlias: 'ai-teacher-reasoning' }
] };
const idBasedValues = resolvePolicyModelReferenceValues(BOOTSTRAP_VALUES, modelRegistry);
assert.equal(validatePolicyValues(idBasedValues, { modelRegistry }).ok, true);
assert.equal(idBasedValues['scope.modelRoute'], 'alias-fast-id');
assert.equal(idBasedValues['stage.candidate.modelRoute'], 'alias-reasoning-id');
assert.equal(validatePolicyValues(BOOTSTRAP_VALUES, { modelRegistry }).ok, false, 'runtime Alias names are not valid policy foreign keys');
assert.equal(validatePolicyValues(idBasedValues, { modelRegistry: { aliasIds: ['alias-fast-id'] } }).ok, false);
const protocolUnreadyRegistry = {
  profiles: modelRegistry.profiles.map((profile) => ({
    ...profile,
    runtimeProtocolStatus: profile.aliasId === 'alias-reasoning-id' ? 'ambiguous' : 'ready'
  }))
};
const protocolUnreadyValidation = validatePolicyValues(idBasedValues, { modelRegistry: protocolUnreadyRegistry });
assert.equal(protocolUnreadyValidation.ok, false);
assert(protocolUnreadyValidation.errors.some((item) => item.code === 'POLICY_MODEL_PROTOCOL_UNREADY'),
  '阶段模型Alias没有唯一执行协议时，资源策略不得验证或发布。');
const alwaysThinkingRegistry = {
  profiles: modelRegistry.profiles.map((profile) => ({
    ...profile,
    runtimeProtocolStatus: 'ready',
    executionPolicy: profile.aliasId === 'alias-reasoning-id'
      ? {
          reasoning: {
            enabled: { supported: true, sdkReasoning: 'high' },
            disabled: { supported: false, sdkReasoning: 'none' }
          }
        }
      : {
          reasoning: {
            enabled: { supported: true, sdkReasoning: 'high' },
            disabled: { supported: true, sdkReasoning: 'none' }
          }
        }
  }))
};
const incompatibleReasoningValues = {
  ...idBasedValues,
  'stage.main.modelRoute': 'alias-reasoning-id',
  'stage.finalizer.modelRoute': 'alias-reasoning-id'
};
const incompatibleReasoningValidation = validatePolicyValues(incompatibleReasoningValues, {
  modelRegistry: alwaysThinkingRegistry
});
assert.equal(incompatibleReasoningValidation.ok, false);
assert.deepEqual(
  incompatibleReasoningValidation.errors
    .filter((item) => item.code === 'POLICY_MODEL_REASONING_MODE_UNSUPPORTED')
    .map((item) => item.key),
  ['stage.main.modelRoute', 'stage.finalizer.modelRoute']
);
assert.equal(validatePolicyValues({
  ...incompatibleReasoningValues,
  'stage.main.reasoningPolicy': 'provider-managed',
  'stage.finalizer.reasoningPolicy': 'provider-managed'
}, { modelRegistry: alwaysThinkingRegistry }).ok, true,
'显式切换为Provider托管思考后，always-thinking模型必须能够通过资源策略门。');
assert.equal(validatePolicyValues({ ...BOOTSTRAP_VALUES, 'context.taskSourceMaxEntries': 16 }).ok, true);
assert.equal(validatePolicyValues({ ...BOOTSTRAP_VALUES, 'context.taskSourceMaxEntries': 17 }).ok, false);
assert.equal(validatePolicyValues({ ...BOOTSTRAP_VALUES, 'tool.maxRetriesPerOperation': 0 }).ok, true);
assert.equal(validatePolicyValues({ ...BOOTSTRAP_VALUES, 'tool.maxRetriesPerOperation': 3 }).ok, false);

const snapshot = createPolicySnapshot({ versionId: 'arp_test_v21', values: BOOTSTRAP_VALUES, frozenAt: '2026-08-25T00:00:00.000Z' });
assert.equal(validatePolicySnapshot(snapshot).ok, true);
assert.equal(validatePolicySnapshot({ ...snapshot, checksum: `sha256:${'0'.repeat(64)}` }).ok, false);

const projection = runtimeProjection(BOOTSTRAP_VALUES);
assert.equal(projection.api.outerTimeoutMs, 620000);
assert.equal(projection.teacher.agentMaxSteps, 12);
assert.equal(projection.teacher.agentReadOnlyToolMaxRetriesPerOperation, 2);
assert.equal(projection.teacher.agentScopeGateHardInputTokenBudget, 4096);
assert.equal(projection.teacher.agentReadOnlyToolInputMaxBytes, 8192);
assert.equal(projection.teacher.agentMainContextExecutionReserveTokens, 4096);
assert.equal(projection.teacher.agentReviewedKnowledgeMaxNewQueriesPerRun, undefined);
assert.equal(projection.teacher.agentTemperature, 0);
assert.equal(projection.teacher.agentStageReasoningPolicies.main, 'disabled');
assert.equal(projection.teacher.agentStageReasoningPolicies.finalizer, 'disabled');
assert.equal(Object.hasOwn(BOOTSTRAP_VALUES, 'repair.materializationMode'), false);
assert.equal(Object.hasOwn(BOOTSTRAP_VALUES, 'repair.decisionMaxOutputTokens'), false);
assert.equal(Object.hasOwn(BOOTSTRAP_VALUES, 'repair.materializationMaxOutputTokens'), false);
assert.equal(Object.hasOwn(BOOTSTRAP_VALUES, 'repair.materializationThinking'), false);
assert.equal(Object.hasOwn(projection.teacher, 'agentRepairMaterializationMode'), false);
assert.equal(Object.hasOwn(projection.teacher, 'agentRepairDecisionMaxOutputTokens'), false);
assert.equal(Object.hasOwn(projection.teacher, 'agentRepairMaterializationThinking'), false);
assert.equal(validatePolicyValues({ ...BOOTSTRAP_VALUES, 'repair.materializationMode': 'two_stage' }).ok, false);
const retiredTwoStage = migratePolicyValues({
  ...BOOTSTRAP_VALUES,
  'repair.materializationMode': 'two_stage',
  'repair.decisionMaxOutputTokens': 1600,
  'repair.materializationMaxOutputTokens': 32000,
  'repair.materializationThinking': 'none'
});
assert.equal(Object.hasOwn(retiredTwoStage.values, 'repair.materializationMode'), false);
assert.equal(Object.hasOwn(retiredTwoStage.values, 'repair.materializationMaxOutputTokens'), false);
assert(retiredTwoStage.deprecatedKeys.includes('repair.materializationMode'));
assert(retiredTwoStage.deprecatedKeys.includes('repair.decisionMaxOutputTokens'));
assert(retiredTwoStage.deprecatedKeys.includes('repair.materializationMaxOutputTokens'));
assert(retiredTwoStage.deprecatedKeys.includes('repair.materializationThinking'));
assert.deepEqual(retiredTwoStage.unknownKeys, []);
assert.equal(Object.hasOwn(projection.teacher, 'agentMaxOutputTokens'), false);
assert.equal(Object.hasOwn(projection.teacher, 'agentRepairMaxOutputTokens'), false);
assert.equal(Object.hasOwn(projection.teacher, 'agentHighAnswerMaxOutputTokens'), false);
assert.equal(Object.hasOwn(projection.teacher, 'agentContextWindowTokens'), false);
assert.equal(Object.hasOwn(projection.teacher, 'agentMaxRequestBytes'), false);
assert.equal(Object.hasOwn(projection.teacher, 'agentMaxUniqueCandidateValidationsPerWorker'), false);
assert.equal(projection.teacher.run06.maxUniqueCandidateValidationsPerWorker, 4);
assert.equal(projection.teacher.run06.maxUniqueCandidateValidationsFormula, '1 + repair.maxRounds');
assert.equal(projection.teacher.run06.maxAutoContinuationsPerLineage, 1);
assert.equal(projection.teacher.run06.toolMaxRetriesPerOperation, 2);
assert.equal(projection.teacher.run06.taskSourceMaxEntries, 8);
assert.equal(projection.teacher.run06.studentQuestionMaxChars, 16000);
assert.equal(Object.hasOwn(projection.teacher.run06, 'historyMaxTokens'), false);
assert.equal(Object.hasOwn(projection.teacher.run06, 'semanticCompressionTargets'), false);
assert.equal(Object.hasOwn(projection.teacher, 'agentSemanticReviewMaxIssues'), false,
  'TaskSource count must not control the separate Semantic Review protocol.');
assert.deepEqual(Object.keys(projection.validator), ['queueLimit', 'queueWaitMs', 'executionTimeoutMs', 'toolTimeoutMs']);
assert.equal(projection.provider.maxConcurrency, 2);
assert.deepEqual(Object.keys(projection.provider), ['maxConcurrency', 'queueLimit']);
assert.equal(deriveRequestEnvelopeMaxBytes(262144, 64000), 518144);
assert.equal(runtimeProjection({
  ...BOOTSTRAP_VALUES,
  'tool.maxRetriesPerOperation': 0
}).teacher.agentReadOnlyToolMaxRetriesPerOperation, 0,
  'Admin配置0必须原样进入Teacher，不能被默认值2覆盖。');
for (const configuredLimit of [0, 2, 4]) {
  const migrated = migratePolicyValues({
    ...BOOTSTRAP_VALUES,
    'knowledge.reviewedMaxNewQueriesPerRun': configuredLimit
  });
  assert.equal(migrated.values['knowledge.reviewedMaxNewQueriesPerRun'], undefined,
    `Admin配置${configuredLimit}必须原样通过迁移，不能被默认值4覆盖。`);
  assert.equal(runtimeProjection(migrated.values).teacher.agentReviewedKnowledgeMaxNewQueriesPerRun, undefined);
}

const tuned = {
  ...BOOTSTRAP_VALUES,
  'tool.maxCallsPerRun': 24,
  'tool.maxRetriesPerOperation': 1,
  'stage.temperaturePermille': 500,
  'provider.maxConcurrentRuns': 3,
  'candidate.maxGenerationAttempts': 3,
  'repair.maxRounds': 5,
  'run.maxAutoContinuationsPerLineage': 0,
  'context.taskSourceMaxEntries': 16,
  'context.studentQuestionMaxChars': 12000,
  'scope.hardInputTokenBudget': 8192,
  'tool.inputMaxBytes': 16384,
  'context.mainExecutionReserveTokens': 8192
};
const tunedProjection = runtimeProjection(tuned);
assert.equal(tunedProjection.teacher.agentMaxSteps, 24);
assert.equal(tunedProjection.teacher.agentReadOnlyToolMaxRetriesPerOperation, 1);
assert.equal(tunedProjection.teacher.agentReviewedKnowledgeMaxNewQueriesPerRun, undefined);
assert.equal(tunedProjection.teacher.agentTemperature, 0.5);
assert.equal(tunedProjection.provider.maxConcurrency, 3);
assert.equal(tunedProjection.teacher.agentCandidateRecoveryMaxAttempts, 2);
assert.equal(tunedProjection.teacher.run06.maxUniqueCandidateValidationsPerWorker, 6);
assert.equal(tunedProjection.teacher.run06.maxAutoContinuationsPerLineage, 0);
assert.equal(tunedProjection.teacher.run06.taskSourceMaxEntries, 16);
assert.equal(tunedProjection.teacher.run06.studentQuestionMaxChars, 12000);
assert.equal(tunedProjection.teacher.agentScopeGateHardInputTokenBudget, 8192);
assert.equal(tunedProjection.teacher.agentReadOnlyToolInputMaxBytes, 16384);
assert.equal(tunedProjection.teacher.agentMainContextExecutionReserveTokens, 8192);
assert.deepEqual(diffPolicyValues(BOOTSTRAP_VALUES, tuned).map((item) => item.key), [
  'run.maxAutoContinuationsPerLineage',
  'stage.temperaturePermille',
  'tool.maxCallsPerRun',
  'tool.maxRetriesPerOperation',
  'context.taskSourceMaxEntries',
  'context.studentQuestionMaxChars',
  'context.mainExecutionReserveTokens',
  'tool.inputMaxBytes',
  'candidate.maxGenerationAttempts',
  'repair.maxRounds',
  'provider.maxConcurrentRuns'
  ,'scope.hardInputTokenBudget'
]);

console.log(`Agent resource policy v${SCHEMA_VERSION} tests passed: ${currentCatalog.definitions.length} definitions, ${currentCatalog.hardInvariants.length} hard invariants.`);
