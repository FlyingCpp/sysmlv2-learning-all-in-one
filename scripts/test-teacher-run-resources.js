'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function providerUsage(input = 10, output = 5) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 }
  };
}

function toolCall(toolCallId, toolName, input) {
  return { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) };
}

function generatedToolCalls(calls) {
  return {
    content: calls,
    finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
    usage: providerUsage(),
    warnings: []
  };
}

function generatedText(text) {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: providerUsage(),
    warnings: []
  };
}

async function main() {
  const runtime = await import('../apps/teacher/dist/agent/index.mjs');
  const { MockLanguageModelV4 } = await import('ai/test');
  const { stepCountIs, tool } = await import('ai');
  const { z } = await import('zod');

  const request = runtime.agentRunRequestSchema.parse({
    runId: 'run_slice_b_shared_workbench',
    question: '修复当前模型。',
    currentStudentQuestion: '修复当前模型。',
    operation: 'repair',
    capabilityGrant: ['search_reviewed_knowledge', 'validate_candidate_workspace'],
    context: {
      tenantId: 'tenant-slice-b',
      userId: 'user-slice-b',
      threadId: 'thread-slice-b',
      lesson: {
        courseId: 'course-slice-b',
        lessonId: 'lesson-slice-b',
        title: 'Slice B',
        objectives: [],
        taskHints: []
      },
      model: {
        files: [{
          fileId: 'file-slice-b',
          displayName: 'model.sysml',
          content: 'package Demo {}',
          contentHash: hash('package Demo {}'),
          editable: true
        }],
        entryFileId: 'file-slice-b',
        activeFileId: 'file-slice-b',
        diagnostics: []
      }
    }
  });
  const resources = runtime.createRunResources({
    request,
    policy: runtime.DEFAULT_AGENT_POLICY,
    deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
  });

  assert(Object.isFrozen(resources));
  assert.match(resources.scopeKey, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(resources.ledger.scopeKey, resources.scopeKey);
  assert(Object.isFrozen(resources.resourcePolicy));
  assert.equal(resources.resourcePolicy.maxUniqueCandidateValidationsPerWorker, 4);
  assert.equal(resources.resourcePolicy.maxExecutionsPerTool.validate_candidate_workspace, 4);
  assert.equal(resources.resourcePolicy.operationLimits.validator, 4);
  assert.equal(resources.resourcePolicy.operationLimits.candidate_generation, 2);
  assert.equal(resources.resourcePolicy.operationLimits.knowledge_backend, 12);
  assert.equal(resources.resourcePolicy.maxExecutionsPerTool.search_engineering_domain_evidence, undefined);
  assert.equal(resources.resourcePolicy.maxExecutionsPerTool.inspect_lesson_context, undefined);
  assert.equal(resources.resourcePolicy.maxExecutionsPerTool.inspect_current_model, undefined);
  assert.equal(resources.resourcePolicy.maxExecutionsPerTool.search_skill_guidance, undefined);
  assert.equal(resources.resourcePolicy.maxExecutionsPerTool.search_reviewed_knowledge, undefined);

  const contextClosedResources = runtime.createRunResources({
    request: runtime.agentRunRequestSchema.parse({ ...request, runId: 'run_reviewed_knowledge_context_closed' }),
    policy: { ...runtime.DEFAULT_AGENT_POLICY, contextWindowTokens: 16_000 },
    deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
  });
  contextClosedResources.budget.settleModelCall({
    callId: 'fill-reviewed-knowledge-context-reserve',
    usage: { inputTokens: 11_904, totalTokens: 11_904 }
  });
  assert.doesNotThrow(
    () => contextClosedResources.assertNewReviewedKnowledgeQueryAllowed({ query: 'new query', limit: 5 }),
    '累计计费Token不能冒充当前模型上下文窗口'
  );

  const operationClosedResources = runtime.createRunResources({
    request: runtime.agentRunRequestSchema.parse({ ...request, runId: 'run_reviewed_knowledge_operation_closed' }),
    policy: runtime.DEFAULT_AGENT_POLICY,
    deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
  });
  for (let index = 0; index < 12; index += 1) {
    const permit = operationClosedResources.budget.reserve('knowledge_backend');
    operationClosedResources.budget.settle(permit, 'succeeded');
  }
  assert.doesNotThrow(
    () => operationClosedResources.assertNewReviewedKnowledgeQueryAllowed({ query: 'new query', limit: 5 }),
    'Reviewed Knowledge必须只由可配置新查询计数器控制，不能被Skill/Domain通用预算重复关闭'
  );
  assert.equal(operationClosedResources.knowledge.reviewedKnowledgeQueryBudget().admittedNewQueries, 12);
  assert.equal(operationClosedResources.isNewReviewedKnowledgeQueryAllowed(), false);

  const timeClosedResources = runtime.createRunResources({
    request: runtime.agentRunRequestSchema.parse({ ...request, runId: 'run_reviewed_knowledge_time_closed' }),
    policy: runtime.DEFAULT_AGENT_POLICY,
    startedAtMs: 1_000,
    deadlineAtMs: 241_000
  });
  assert.throws(
    () => timeClosedResources.assertNewReviewedKnowledgeQueryAllowed({ query: 'new query', limit: 5 }),
    (error) => error?.code === 'RUN_PHASE_ACTION_NOT_ALLOWED' && error?.phase === 'expired',
    '达到Run时间硬顶后必须关闭新查询'
  );

  const validatorBudgetProbe = runtime.createRunResources({
    request: runtime.agentRunRequestSchema.parse({ ...request, runId: 'run_slice_b_validator_budget_probe' }),
    policy: runtime.DEFAULT_AGENT_POLICY,
    deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
  });
  for (let index = 0; index < 4; index += 1) {
    const permit = validatorBudgetProbe.budget.reserve('validator');
    validatorBudgetProbe.budget.settle(permit, 'succeeded');
  }
  assert.equal(validatorBudgetProbe.budget.view().remainingOperations.validator, 0);
  assert.throws(
    () => validatorBudgetProbe.budget.reserve('validator'),
    /Run budget exceeded for validator/u,
    '第5个唯一Candidate的Validator请求必须由初始候选加Repair轮次的派生上界拒绝'
  );

  const expandedResourcePolicy = runtime.createRunResourcePolicy({
    ...runtime.DEFAULT_AGENT_POLICY,
    maxSteps: 24,
    repairMaxRounds: 12
  });
  assert.equal(expandedResourcePolicy.operationLimits.validator, 13);
  assert.equal(expandedResourcePolicy.maxExecutionsPerTool.validate_candidate_workspace, 13);
  assert.equal(expandedResourcePolicy.maxExecutionsPerTool.inspect_lesson_context, undefined);
  assert.equal(expandedResourcePolicy.maxExecutionsPerTool.inspect_current_model, undefined);
  assert.equal(expandedResourcePolicy.maxExecutionsPerTool.search_skill_guidance, undefined);
  assert.equal(expandedResourcePolicy.maxExecutionsPerTool.search_reviewed_knowledge, undefined);
  assert.equal(expandedResourcePolicy.maxExecutionsPerTool.search_engineering_domain_evidence, undefined);
  assert.equal(
    expandedResourcePolicy.maxToolExecutions,
    37,
    'Tool Ledger只保留共享只读预算和初始候选加Repair轮次的派生容量'
  );

  let backendCalls = 0;
  const input = { query: '  Part   Definition  ', limit: 5 };
  const operation = async () => {
    backendCalls += 1;
    return {
      claims: [{
        claimId: 'claim-1',
        claimText: 'A part usage is typed by a part definition.',
        authorityLevel: 'A1',
        evidenceIds: ['evidence-1']
      }],
      evidenceBlocks: [{
        evidenceId: 'evidence-1',
        sectionPath: 'Parts',
        excerpt: 'A part usage may be typed by a part definition.',
        authorityLevel: 'A1'
      }]
    };
  };
  const mainOutput = await resources.ledger.execute({
    toolCallId: 'main-search-1',
    toolName: 'search_reviewed_knowledge',
    input,
    operation
  });
  const workerOutput = await resources.ledger.execute({
    toolCallId: 'worker-search-1',
    toolName: 'search_reviewed_knowledge',
    input,
    operation
  });
  assert.deepEqual(workerOutput, mainOutput);
  assert.equal(backendCalls, 1, 'Main和Worker的相同调用必须只执行一次后端');
  assert.equal(resources.ledger.snapshot().length, 2);
  assert.equal(resources.ledger.snapshot()[1].replayCount, 1);

  resources.knowledge.observeToolResult('search_reviewed_knowledge', input, {
    bundleId: 'bundle-slice-b',
    sourceRegistryHash: hash('registry'),
    coverage: 'COMPLETE',
    claims: [{ claimId: 'claim-1' }],
    evidenceBlocks: [{ evidenceId: 'evidence-1' }]
  });
  const domainInput = { questions: ['电池热管理系统有哪些主要工程部件？'] };
  const domainOutput = {
    version: 'domain-search-result-v3',
    status: 'complete',
    provider: 'deepseek-native-web-search',
    questions: domainInput.questions,
    summary: '公开工程资料显示，典型系统包含冷却板、冷却液回路、泵、换热器与控制器。',
    sources: [{
      sourceId: 'domain_0123456789abcdef0123',
      title: 'Battery thermal management overview',
      url: 'https://example.edu/battery-thermal-management',
      pageAge: '2026-07-28'
    }],
    searchRequestCount: 1,
    warnings: []
  };
  await resources.ledger.execute({
    toolCallId: 'main-domain-search-1',
    toolName: 'search_engineering_domain_evidence',
    input: domainInput,
    operation: async () => domainOutput
  });
  resources.knowledge.observeToolResult(
    'search_engineering_domain_evidence',
    domainInput,
    domainOutput
  );
  const outcome = {
    type: 'delegate_repair',
    scope: 'active_file',
    acceptedToolCallId: 'delegate-repair-1'
  };
  const task = resources.tasks.materialize({
    questionHash: hash(request.currentStudentQuestion),
    outcome,
    context: request.context
  });
  assert.equal(resources.tasks.materialize({
    questionHash: hash(request.currentStudentQuestion),
    outcome,
    context: request.context
  }), task, '重复委派必须返回同一Task对象');
  assert.throws(() => resources.tasks.materialize({
    questionHash: hash('different question'),
    outcome,
    context: request.context
  }), /rebound to different task facts/u, '同一acceptedToolCallId不得重绑定不同任务事实');
  assert.deepEqual(resources.knowledge.projectForTask(task).claimIds, ['claim-1']);
  assert.deepEqual(resources.knowledge.projectForTask(task).evidenceIds, ['evidence-1']);
  assert.deepEqual(resources.knowledge.projectForTask(task).domainSourceIds,
    ['domain_0123456789abcdef0123']);
  const evidenceView = runtime.projectWorkerEvidenceView(resources, task);
  assert.deepEqual(evidenceView.disclosedClaimIds, ['claim-1']);
  assert.deepEqual(evidenceView.disclosedEvidenceIds, ['evidence-1']);
  assert.deepEqual(evidenceView.disclosedEvidenceSpanIds, ['evidence-1:all']);
  assert.equal(evidenceView.claims[0].claimText, 'A part usage is typed by a part definition.');
  assert.equal(evidenceView.evidenceBlocks[0].excerpt, 'A part usage may be typed by a part definition.');
  assert.deepEqual(evidenceView.sourceToolCallIds, ['worker-search-1', 'main-search-1']);
  assert.equal(evidenceView.domainEvidence.trust, 'untrusted_external_domain_evidence');
  assert.deepEqual(evidenceView.domainEvidence.disclosedSourceIds,
    ['domain_0123456789abcdef0123']);
  assert.equal(evidenceView.domainEvidence.researches[0].sourceToolCallId, 'main-domain-search-1');
  assert.match(evidenceView.domainEvidence.researches[0].summary, /冷却板/u);
  assert.equal(evidenceView.domainEvidence.researches[0].sources[0].url,
    'https://example.edu/battery-thermal-management');
  assert.doesNotMatch(JSON.stringify(evidenceView.domainEvidence), /encrypted_content/u);

  // RUN01 S3: examples use an independent Worker token budget and must not reduce claim budget.
  {
    const exampleBudgetResources = runtime.createRunResources({
      request: runtime.agentRunRequestSchema.parse({
        ...request,
        runId: 'run_example_independent_budget'
      }),
      policy: {
        ...runtime.DEFAULT_AGENT_POLICY,
        knowledgeExampleViewTokenBudget: 2_000
      },
      deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
    });
    assert.equal(exampleBudgetResources.resourcePolicy.exampleViewTokenBudget, undefined);

    const denseClaims = Array.from({ length: 40 }, (_, index) => ({
      claimId: `claim-budget-${index}`,
      claimText: `Claim budget filler ${index}: ${'part usage typed by part definition. '.repeat(8)}`,
      authorityLevel: 'A1',
      evidenceIds: [`evidence-budget-${index}`]
    }));
    const denseEvidence = denseClaims.map((claim, index) => ({
      evidenceId: `evidence-budget-${index}`,
      sectionPath: `Section ${index}`,
      excerpt: `Evidence budget filler ${index}: ${'A usage may be typed by a definition. '.repeat(6)}`,
      authorityLevel: 'A1'
    }));
    const largeExample = {
      exampleId: 'ex-budget-ports-01',
      title: 'Ports Example',
      intentText: 'Define directed ports and connect them.',
      modelText: `package PortsExample {\n${'  part def BlockX;\n'.repeat(220)}}`,
      constructTags: ['port-def', 'connect'],
      exampleAuthority: 'official-example',
      languageVersionTrack: '2.1-beta-forward',
      validatorPassed: true
    };

    await exampleBudgetResources.ledger.execute({
      toolCallId: 'example-budget-search-1',
      toolName: 'search_reviewed_knowledge',
      input: { query: 'ports connect', limit: 8 },
      operation: async () => ({
        claims: denseClaims,
        evidenceBlocks: denseEvidence,
        examples: [largeExample]
      })
    });
    exampleBudgetResources.knowledge.observeToolResult(
      'search_reviewed_knowledge',
      { query: 'ports connect', limit: 8 },
      {
        claims: denseClaims,
        evidenceBlocks: denseEvidence,
        examples: [largeExample]
      }
    );
    const claimsOnlyResources = runtime.createRunResources({
      request: runtime.agentRunRequestSchema.parse({
        ...request,
        runId: 'run_example_claims_only_budget'
      }),
      policy: runtime.DEFAULT_AGENT_POLICY,
      deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
    });
    await claimsOnlyResources.ledger.execute({
      toolCallId: 'claims-only-search-1',
      toolName: 'search_reviewed_knowledge',
      input: { query: 'ports connect', limit: 8 },
      operation: async () => ({
        claims: denseClaims,
        evidenceBlocks: denseEvidence
      })
    });

    const exampleTask = exampleBudgetResources.tasks.materialize({
      questionHash: hash(request.currentStudentQuestion),
      outcome: {
        type: 'delegate_repair',
        scope: 'active_file',
        acceptedToolCallId: 'delegate-repair-example-budget'
      },
      context: request.context
    });
    const claimsOnlyTask = claimsOnlyResources.tasks.materialize({
      questionHash: hash(request.currentStudentQuestion),
      outcome: {
        type: 'delegate_repair',
        scope: 'active_file',
        acceptedToolCallId: 'delegate-repair-claims-only'
      },
      context: request.context
    });
    const withExamplesView = runtime.projectWorkerEvidenceView(exampleBudgetResources, exampleTask);
    const claimsOnlyView = runtime.projectWorkerEvidenceView(claimsOnlyResources, claimsOnlyTask);
    assert.equal(
      withExamplesView.disclosedClaimIds.length,
      claimsOnlyView.disclosedClaimIds.length,
      'independent example budget must not reduce disclosed claim count'
    );
    assert.equal(
      withExamplesView.disclosedEvidenceIds.length,
      claimsOnlyView.disclosedEvidenceIds.length,
      'independent example budget must not reduce disclosed evidence count'
    );
    assert.ok(withExamplesView.examples?.length >= 1, 'examples must project under independent budget');
    assert.deepEqual(withExamplesView.disclosedExampleIds, ['ex-budget-ports-01']);
    assert.deepEqual(exampleBudgetResources.knowledge.projectForTask(exampleTask).exampleIds, [
      'ex-budget-ports-01'
    ]);
  }

  const running = resources.tasks.transition(task.taskId, task.revision, { type: 'worker_started' });
  assert.equal(running.status, 'worker_running');
  assert.throws(
    () => resources.tasks.transition(task.taskId, task.revision, { type: 'worker_started' }),
    /revision mismatch/u
  );
  const cancelled = resources.tasks.transition(running.taskId, running.revision, {
    type: 'cancelled', reason: 'caller_cancelled'
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.throws(
    () => resources.tasks.transition(cancelled.taskId, cancelled.revision, { type: 'worker_completed' }),
    /terminal/u,
    '取消后的迟到结果不得覆盖终态'
  );

  const initialBudget = resources.budget.view();
  resources.budget.settleModelCall({
    callId: 'model-call-1',
    usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2, totalTokens: 15 }
  });
  resources.budget.settleModelCall({
    callId: 'model-call-1',
    usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2, totalTokens: 15 }
  });
  assert.equal(resources.budget.view().modelTotalTokens, 15, '相同SDK callId只能结算一次');
  assert(resources.budget.view().hardRemainingMs <= initialBudget.hardRemainingMs);
  assert(resources.budget.view().workRemainingMs <= initialBudget.workRemainingMs);

  const timing = runtime.createRunTiming(1_000, 241_000);
  assert.equal(timing.hardDeadlineAtMs, 241_000);
  assert.equal(timing.workDeadlineAtMs, 211_000, '240秒Run必须预留30秒终态区');
  assert.equal(timing.convergeAtMs, 181_000, '终态区前必须有30秒Converge提交区');
  assert.equal(runtime.DEFAULT_AGENT_POLICY.convergeLeadMs, 90_000);
  const productionTiming = runtime.createRunTiming(
    1_000,
    241_000,
    runtime.DEFAULT_AGENT_POLICY.convergeLeadMs
  );
  assert.equal(productionTiming.convergeAtMs, 131_000, 'Allocator按工作窗口三分之一派生COMMIT水位，不再被75秒隐藏上限钳制');
  const run05Timing = runtime.createRunTiming(
    0,
    600_000,
    75_000,
    {
      terminalReserveMs: 30_000,
      candidateMaxAttemptMs: 420_000,
      repairPhaseReserveMs: 120_000,
      validatorToolTimeoutMs: 45_000
    }
  );
  assert.equal(run05Timing.workDeadlineAtMs, 570_000, 'RUN05必须保留30秒终态区');
  assert.equal(run05Timing.candidatePhaseDeadlineAtMs, 405_000, 'Candidate不得占用Validator和Repair预留');
  assert.equal(run05Timing.repairDeadlineAtMs, 570_000, 'Repair必须在终态区之前结束');
  assert.equal(runtime.candidateAttemptDeadlineAt(run05Timing, 0), 405_000);
  assert.equal(runtime.candidateAttemptDeadlineAt(run05Timing, 100_000), 405_000);
  assert.equal(runtime.repairPhaseDeadlineAt(run05Timing, 100_000), 220_000,
    'Repair ToolLoop只能使用派生的120秒阶段窗口，不能独占全部剩余Run预算');
  assert.equal(runtime.repairPhaseDeadlineAt(run05Timing, 500_000), 570_000,
    'Repair阶段窗口仍不得越过work deadline');
  const independentToolTimeoutPolicy = {
    ...runtime.DEFAULT_AGENT_POLICY,
    toolTimeoutMs: 12_345
  };
  const independentResources = runtime.createRunResources({
    request: runtime.agentRunRequestSchema.parse({ ...request, runId: 'run_converge_independence_probe' }),
    policy: independentToolTimeoutPolicy,
    startedAtMs: 1_000,
    deadlineAtMs: 241_000
  });
  assert.equal(independentResources.convergeAtMs, 101_000, 'Tool timeout调整不得改变由60秒终态预留派生的阶段水位');
  const phaseBudget = new runtime.RunBudgetAccount(timing);
  assert.equal(phaseBudget.view(180_999).phase, 'normal');
  assert.equal(phaseBudget.view(180_999).state, 'NORMAL');
  assert.equal(phaseBudget.view(181_000).phase, 'converge');
  assert.equal(phaseBudget.view(181_000).state, 'COMMIT');
  assert.equal(phaseBudget.view(211_000).phase, 'finalize');
  assert.equal(phaseBudget.view(211_000).state, 'FINALIZE');
  assert.equal(phaseBudget.view(241_000).phase, 'expired');
  assert.equal(phaseBudget.view(241_000).state, 'EXPIRED');
  assert.equal(phaseBudget.view(211_000).workRemainingMs, 0);
  assert.equal(phaseBudget.view(211_000).hardRemainingMs, 30_000);
  const expectedPhaseMatrix = {
    normal: {
      knowledge_search: true,
      candidate_validate: true,
      finalize_answer: true
    },
    converge: {
      knowledge_search: false,
      candidate_validate: true,
      finalize_answer: true
    },
    finalize: {
      knowledge_search: false,
      candidate_validate: false,
      finalize_answer: true
    },
    expired: {
      knowledge_search: false,
      candidate_validate: false,
      finalize_answer: false
    }
  };
  for (const [phase, actions] of Object.entries(expectedPhaseMatrix)) {
    for (const [action, expected] of Object.entries(actions)) {
      assert.equal(runtime.evaluateRunPhaseAdmission(action, phase).allowed, expected, `${phase}:${action}`);
    }
  }
  const remainingBeforeExpiredReserve = phaseBudget.view().remainingOperations.validator;
  assert.throws(
    () => phaseBudget.reserve('validator'),
    (error) => error?.code === 'RUN_PHASE_ACTION_NOT_ALLOWED' && error?.phase === 'expired'
  );
  assert.equal(
    phaseBudget.view().remainingOperations.validator,
    remainingBeforeExpiredReserve,
    '阶段拒绝不得消耗Validator次数'
  );

  const observationLedger = new runtime.ToolExecutionLedger();
  await observationLedger.execute({
    toolCallId: 'validator-observation-call',
    toolName: 'validate_candidate_workspace',
    input: { mode: 'standalone_model' },
    operation: async () => {
      await Promise.resolve();
      observationLedger.appendValidatorObservations('validator-observation-call', [{
        attempt: 1,
        admissionOutcome: 'admitted',
        queueWaitMs: 3,
        executionMs: 7,
        retryableBeforeStart: false,
        abortedAfterStart: false
      }]);
      return { ok: true };
    }
  });
  assert.deepStrictEqual(
    observationLedger.snapshot()[0].validatorObservations,
    [{
      attempt: 1,
      admissionOutcome: 'admitted',
      queueWaitMs: 3,
      executionMs: 7,
      retryableBeforeStart: false,
      abortedAfterStart: false
    }]
  );

  const toolContext = runtime.createRunToolContext(resources, 'main');
  const executionView = runtime.createRunExecutionView(resources, 'main');
  assert(Object.isFrozen(toolContext));
  assert(Object.isFrozen(executionView));
  let receivedContext;
  const contextualTool = tool({
    description: 'Slice B SDK context probe',
    inputSchema: z.object({ value: z.string() }).strict(),
    contextSchema: runtime.runToolContextSchema,
    execute: async ({ value }, execution) => {
      receivedContext = execution.context;
      runtime.assertRunToolContext(resources, execution.context);
      return { value };
    }
  });
  const model = new MockLanguageModelV4({
    doGenerate: [
      generatedToolCalls([toolCall('sdk-context-call', 'context_probe', { value: 'ok' })]),
      generatedText('done')
    ]
  });
  const modelAuditEntries = [];
  const observedAudit = await runtime.withModelCallAuditContext({
    runId: request.runId,
    promptVersion: 'run-resource-context-probe-v1',
    record: async (entry) => { modelAuditEntries.push(entry); }
  }, async () => await runtime.generateObservedToolLoopText({
    model,
    prompt: 'run context probe',
    tools: { context_probe: contextualTool },
    toolsContext: runtime.createRunToolsContext(resources, 'main', ['context_probe']),
    runtimeContext: executionView,
    stopWhen: stepCountIs(2),
    timeout: { totalMs: 5_000, toolMs: 2_000 },
    onToolExecutionStart: (event) => resources.recordToolLifecycle({
      toolCallId: event.toolCall.toolCallId,
      toolName: event.toolCall.toolName,
      participant: 'main',
      status: 'started'
    }),
    onToolExecutionEnd: (event) => resources.recordToolLifecycle({
      toolCallId: event.toolCall.toolCallId,
      toolName: event.toolCall.toolName,
      participant: 'main',
      status: event.toolOutput.type === 'tool-result' ? 'succeeded' : 'failed'
    })
  }));
  const observed = observedAudit.value;
  assert.equal(observed.text, 'done');
  assert.deepEqual({
    runId: receivedContext.runId,
    scopeKey: receivedContext.scopeKey,
    threadId: receivedContext.threadId,
    participant: receivedContext.participant,
    allowedActions: receivedContext.allowedActions
  }, toolContext);
  assert.equal(receivedContext.toolName, 'context_probe');
  assert.match(receivedContext.idempotencyKey, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(resources.toolLifecycleSnapshot().map((event) => event.status), ['started', 'succeeded']);
  const providerCall = JSON.stringify(model.doGenerateCalls);
  assert(!providerCall.includes(resources.scopeKey), 'Run/Tool Context不得进入Provider请求');
  assert.equal(modelAuditEntries.length, 2);
  assert.match(JSON.stringify(modelAuditEntries[1].inputPayload.messages), /"value":"ok"/u,
    'AI SDK下一Provider调用的审计输入必须包含上一Step的Tool Result');

  console.log('teacher run resources tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
