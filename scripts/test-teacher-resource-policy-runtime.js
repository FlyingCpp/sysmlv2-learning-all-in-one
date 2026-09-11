'use strict';

const assert = require('assert');
const { once } = require('events');
const { createServer } = require('../apps/teacher/server');
const { agentPolicyForTests } = require('../apps/teacher/agent-adapter');
const {
  BOOTSTRAP_VALUES,
  createPolicySnapshot,
  runtimeProjection
} = require('../packages/agent-resource-policy');

async function main() {
  assert.equal(agentPolicyForTests(runtimeProjection({ ...BOOTSTRAP_VALUES, 'semanticReview.maxCycles': 0 }).teacher).semanticReviewAssessmentMaxCalls, 0,
    '兼容配置0必须跳过工程意见，不能由默认值重新启用');
  assert.equal(agentPolicyForTests(runtimeProjection({ ...BOOTSTRAP_VALUES, 'semanticReview.maxCycles': 4 }).teacher).semanticReviewAssessmentMaxCalls, 1,
    '旧次数上限只保留一次只读评议，不产生独立改进循环');
  const settingsUpdates = [];
  let providerSettings = runtimeProjection(BOOTSTRAP_VALUES).provider;
  let probeSettings = runtimeProjection(BOOTSTRAP_VALUES).probe;
  const server = createServer({
    providerMode: 'mock',
    providerEnabled: false,
    agentProviderCompatibility: 'deepseek-v4-litellm',
    internalToken: 'resource-policy-internal-token',
    toolToken: 'resource-policy-tool-token',
    knowledge: { async debug() { return {}; } },
    skillSource: { async retrieve() { return []; } },
    conversation: { async close() {} },
    providerGateway: {
      updateSettings(settings) { providerSettings = settings; settingsUpdates.push(settings); },
      get settings() { return providerSettings; }
    },
    domainWebSearchProbe: {
      async publicState() { return { status: 'not_checked' }; },
      updatePolicy(settings) { probeSettings = { ...settings }; return probeSettings; },
      policyState() { return { ...probeSettings }; },
      async close() {}
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = {
    'content-type': 'application/json',
    'x-ai-teacher-token': 'resource-policy-internal-token'
  };

  try {
    const bootstrap = await requestJson(`${baseUrl}/v1/admin/resource-policy/state`, { headers });
    assert.equal(bootstrap.response.status, 200);
    assert.equal(bootstrap.body.versionId, 'arp_bootstrap_v24');
    assert.equal(bootstrap.body.owners.teacher.status, 'applied');
    assert.equal(bootstrap.body.owners.provider.status, 'applied');
    assert.equal(bootstrap.body.values['run.maxDurationMs'], 600000);
    assert.equal(bootstrap.body.values['run.finalizationReserveMs'], 60000);
    assert.equal(bootstrap.body.values['tool.maxCallsPerRun'], 12);
    assert.equal(bootstrap.body.values['knowledge.reviewedMaxNewQueriesPerRun'], undefined);
    assert.equal(Object.hasOwn(bootstrap.body.values, 'stage.main.maxOutputTokens'), false);
    assert.equal(Object.hasOwn(bootstrap.body.values, 'stage.candidate.maxOutputTokens'), false);
    assert.equal(Object.hasOwn(bootstrap.body.values, 'stage.repair.maxOutputTokens'), false);
    assert.equal(Object.hasOwn(bootstrap.body.values, 'stage.finalizer.maxOutputTokens'), false);
    assert.equal(bootstrap.body.values['semanticReview.enabled'], false);
    assert.equal(bootstrap.body.values['semanticReview.shadowOnly'], false);
    assert.equal(bootstrap.body.values['repair.maxRounds'], 3);
    assert.equal(Object.hasOwn(bootstrap.body.values, 'context.windowTokens'), false);
    assert.equal(Object.hasOwn(bootstrap.body.values, 'run.maxRecoveryAttempts'), false);
    assert.equal(Object.hasOwn(bootstrap.body.values, 'validator.maxUniqueCandidatesPerRun'), false);
    assert.equal(bootstrap.body.values['context.taskSourceMaxEntries'], 8);
    assert.equal(bootstrap.body.values['context.studentQuestionMaxChars'], 16000);
    assert.equal(bootstrap.body.values['scope.hardInputTokenBudget'], 4096);
    assert.equal(bootstrap.body.values['tool.inputMaxBytes'], 8192);
    assert.equal(bootstrap.body.values['context.mainExecutionReserveTokens'], 4096);
    const bootstrapProjection = runtimeProjection(bootstrap.body.values);
    assert.equal(Object.hasOwn(bootstrapProjection.teacher, 'agentMaxRequestBytes'), false,
      '请求体上限必须由Model Deployment Capability与Candidate Artifact派生，不能留在Run Policy投影');
    assert.equal(bootstrapProjection.teacher.run06.maxUniqueCandidateValidationsPerWorker, 4);
    const noDomainSearchProjection = runtimeProjection({
      ...bootstrap.body.values,
      'domainEvidence.maxQueriesPerRun': 0
    });
    const projectedAgentPolicy = agentPolicyForTests(noDomainSearchProjection.teacher);
    assert.equal(Object.hasOwn(projectedAgentPolicy, 'semanticReviewMaxIssues'), false,
      'Policy v19 must not project the deleted semanticReview.maxIssues option.');
    const agentRuntime = await import('../apps/teacher/dist/agent/index.mjs');
    const { semanticReviewMaxIssues: _removedReviewIssueLimit, ...policyWithoutReviewIssueLimit } =
      agentRuntime.DEFAULT_AGENT_POLICY;
    assert.equal(agentRuntime.agentPolicySchema.parse(policyWithoutReviewIssueLimit).semanticReviewMaxIssues, 8,
      'Reviewer issue count must fall back to the fixed protocol safety bound.');
    assert.equal(projectedAgentPolicy.domainEvidenceMaxCallsPerRun, 0,
      '管理页配置 0 必须真实关闭领域网页检索，不能回退为默认值');
    const maxCodingPlanProjection = runtimeProjection({
      ...bootstrap.body.values,
      'run.maxDurationMs': 1200000,
      'domainEvidence.maxQueriesPerRun': 0,
    });
    assert.doesNotThrow(() => agentRuntime.agentPolicySchema.parse(
      {
        ...agentRuntime.DEFAULT_AGENT_POLICY,
        ...agentPolicyForTests(maxCodingPlanProjection.teacher)
      }
    ), '管理页允许的 20 分钟 Run 必须能通过实际 Agent Policy Schema');
    const capabilities = await requestJson(`${baseUrl}/v1/capabilities`, { headers });
    assert.equal(capabilities.response.status, 200);
    assert.equal(capabilities.body.agentRuntime.providerCompatibility, 'deepseek-v4-litellm');
    assert.equal(capabilities.body.limits.maxRequestBytes, 262144 + 64000 * 4);

    const values = {
      ...BOOTSTRAP_VALUES,
      'tool.maxCallsPerRun': BOOTSTRAP_VALUES['tool.maxCallsPerRun'] - 1,
      'context.taskSourceMaxEntries': 16,
      'context.studentQuestionMaxChars': 12000,
      'scope.hardInputTokenBudget': 8192,
      'tool.inputMaxBytes': 16384,
      'context.mainExecutionReserveTokens': 8192,
      'provider.maxConcurrentRuns': 3,
      'provider.queueLimit': 7,
      'probe.enabled': false,
      'probe.hourlyLimit': 0,
      'probe.timeoutMs': 17000
    };
    const snapshot = createPolicySnapshot({ versionId: 'arp_runtime_test_v3', values });
    const activateBeforeStage = await requestJson(`${baseUrl}/v1/admin/resource-policy/activate`, {
      method: 'POST', headers, body: JSON.stringify({ snapshot })
    });
    assert.equal(activateBeforeStage.response.status, 409);

    const stage = await requestJson(`${baseUrl}/v1/admin/resource-policy/stage`, {
      method: 'POST', headers, body: JSON.stringify({ snapshot })
    });
    assert.equal(stage.response.status, 200);
    assert.equal(stage.body.status, 'staged');

    const activate = await requestJson(`${baseUrl}/v1/admin/resource-policy/activate`, {
      method: 'POST', headers, body: JSON.stringify({ snapshot })
    });
    assert.equal(activate.response.status, 200);
    assert.equal(activate.body.versionId, snapshot.versionId);
    assert.equal(activate.body.checksum, snapshot.checksum);
    assert.equal(activate.body.values['mainReview.thinkingEnabled'], undefined);
    assert.equal(activate.body.values['mainReview.timeoutMs'], undefined);
    const reviewAgentPolicy = agentPolicyForTests(runtimeProjection(activate.body.values).teacher);
    assert.equal(reviewAgentPolicy.mainWorkerReviewThinkingEnabled, undefined);
    assert.equal(reviewAgentPolicy.mainWorkerReviewTimeoutMs, undefined);
    assert.equal(bootstrap.body.values['mainReview.thinkingEnabled'], undefined, '激活新版本不得更改旧快照');
    assert.equal(bootstrap.body.values['mainReview.timeoutMs'], undefined);
    assert.equal(activate.body.values['tool.maxCallsPerRun'], values['tool.maxCallsPerRun']);
    assert.equal(activate.body.values['context.taskSourceMaxEntries'], 16);
    assert.equal(runtimeProjection(activate.body.values).teacher.run06.taskSourceMaxEntries, 16);
    assert.equal(runtimeProjection(activate.body.values).teacher.run06.studentQuestionMaxChars, 12000);
    assert.equal(runtimeProjection(activate.body.values).teacher.agentScopeGateHardInputTokenBudget, 8192);
    assert.equal(runtimeProjection(activate.body.values).teacher.agentReadOnlyToolInputMaxBytes, 16384);
    assert.equal(runtimeProjection(activate.body.values).teacher.agentMainContextExecutionReserveTokens, 8192);
    assert.equal(settingsUpdates.length, 1);
    const activeState = await requestJson(`${baseUrl}/v1/admin/resource-policy/state`, { headers });
    assert.equal(Object.hasOwn(activeState.body.values, 'stage.repair.maxOutputTokens'), false);
    assert.equal(activeState.body.values['context.taskSourceMaxEntries'], 16);
    assert.equal(activeState.body.owners.provider.observed.maxConcurrency,
      values['provider.maxConcurrentRuns']);
    assert.equal(activeState.body.owners.provider.observed.queueLimit, values['provider.queueLimit']);
    assert.equal(activeState.body.owners.probe.status, 'applied');
    assert.deepEqual(activeState.body.owners.probe.observed, {
      enabled: false,
      hourlyLimit: 0,
      timeoutMs: 17000
    });

    const invalid = { ...snapshot, checksum: 'sha256:invalid' };
    const invalidStage = await requestJson(`${baseUrl}/v1/admin/resource-policy/stage`, {
      method: 'POST', headers, body: JSON.stringify({ snapshot: invalid })
    });
    assert.equal(invalidStage.response.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('Teacher resource policy runtime tests passed.');
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
