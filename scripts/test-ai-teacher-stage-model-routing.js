'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createStageModelsForTests,
  resolvedStageModelAssignmentForTests
} = require('../apps/teacher/agent-adapter');

const routes = {
  fastGate: 'ai-teacher-fast',
  main: 'ai-teacher-fast',
  candidate: 'ai-teacher-reasoning',
  repair: 'ai-teacher-reasoning',
  semanticReview: 'ai-teacher-reasoning',
  finalizer: 'ai-teacher-fast'
};
const context = {
  runtimeAssignment: {
    resourcePolicySnapshot: {
      versionId: 'arp_stage_route_test',
      checksum: `sha256:${'1'.repeat(64)}`
    }
  }
};
const config = {
  agentStageModelRoutes: routes,
  agentStageModelProtocols: {
    fastGate: { protocolMode: 'generic-openai' },
    main: { protocolMode: 'glm-5.2-litellm' },
    candidate: { protocolMode: 'deepseek-v4-litellm' },
    repair: { protocolMode: 'deepseek-v4-litellm' },
    semanticReview: { protocolMode: 'deepseek-v4-litellm' },
    finalizer: { protocolMode: 'generic-openai' }
  },
  agentProviderCompatibility: 'deepseek-v4-litellm',
  llm: {
    providerMode: 'litellm-compatible',
    baseUrl: 'http://litellm.test/v1',
    apiKey: 'test-only-placeholder'
  }
};

const assignment = resolvedStageModelAssignmentForTests(config, context);
assert.equal(assignment.policyVersionId, 'arp_stage_route_test');
assert.equal(assignment.stages.fastGate.modelAlias, 'ai-teacher-fast');
assert.equal(assignment.stages.fastGate.reasoningMode, 'disabled');
assert.equal(assignment.stages.main.modelAlias, 'ai-teacher-fast');
assert.equal(assignment.stages.main.protocolMode, 'glm-5.2-litellm');
assert.equal(assignment.stages.candidate.modelAlias, 'ai-teacher-reasoning');
assert.equal(assignment.stages.candidate.protocolMode, 'deepseek-v4-litellm');
assert.equal(assignment.stages.repair.modelAlias, 'ai-teacher-reasoning');
assert.equal(assignment.stages.semanticReview.modelAlias, 'ai-teacher-reasoning');
assert.equal(assignment.stages.finalizer.reasoningMode, 'disabled');
assert.match(assignment.assignmentChecksum, /^sha256:[a-f0-9]{64}$/u);

const created = [];
const runtime = {
  createOpenAICompatibleAgentModel(options) {
    created.push(options);
    return { modelId: options.modelId, compatibilityMode: options.compatibilityMode };
  }
};
const models = createStageModelsForTests(runtime, config, assignment);
assert.equal(models.fastGate.modelId, 'ai-teacher-fast');
assert.equal(models.main.modelId, 'ai-teacher-fast');
assert.equal(models.candidate.modelId, 'ai-teacher-reasoning');
assert.equal(models.repair.modelId, 'ai-teacher-reasoning');
assert.equal(models.semanticReview.modelId, 'ai-teacher-reasoning');
assert.equal(models.finalizer.modelId, 'ai-teacher-fast');
assert.equal(created.find((item) => item.modelId === 'ai-teacher-fast')?.compatibilityMode, 'generic-openai');
assert(created.some((item) => item.modelId === 'ai-teacher-reasoning' && item.compatibilityMode === 'gateway-thinking-tools-non-null-content'));

assert.throws(
  () => resolvedStageModelAssignmentForTests({ ...config, agentStageModelRoutes: { ...routes, repair: 'invalid alias' } }, context),
  (error) => error?.code === 'AI_TEACHER_STAGE_MODEL_ROUTE_INVALID'
);

const executionSource = fs.readFileSync(path.join(__dirname, '..', 'apps', 'teacher', 'agent', 'intent-v2-execution.mts'), 'utf8');
const orchestratorSource = fs.readFileSync(path.join(__dirname, '..', 'apps', 'teacher', 'agent', 'intent-orchestrator-v2.mts'), 'utf8');
assert(executionSource.includes('options.candidateModel ?? options.thinkingModel ?? options.model'));
assert(executionSource.includes('options.repairModel ?? options.thinkingModel ?? options.model'));
assert(executionSource.includes('options.semanticReviewModel ?? options.thinkingModel ?? options.model'));
assert(executionSource.includes('options.mainModel ?? options.model'));
assert(executionSource.includes('options.finalizerModel ?? options.nonThinkingModel ?? options.model'));
assert(executionSource.includes('const finalizerGeneration = v2GenerationSettings(options, true, "finalizer")'));
assert(executionSource.includes('providerOptions: finalizerGeneration.providerOptions'));
assert(orchestratorSource.includes('options.fastGateModel ?? options.nonThinkingModel ?? options.model'));
assert(orchestratorSource.includes('const mainModel = options.mainModel'));

console.log('AI Teacher stage model routing tests passed.');
