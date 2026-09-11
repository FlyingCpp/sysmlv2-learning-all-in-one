'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  createMemoryConversationStore,
  createPostgresConversationStore
} = require('../apps/teacher/conversation-store');
const { deriveExecutionInputHashes } = require('../apps/teacher/execution-checkpoint');
const {
  engineeringImprovementServerForTests
} = require('../apps/teacher/server');
const {
  engineeringImprovementApiForTests
} = require('../apps/api/server');
const {
  BOOTSTRAP_VALUES,
  SCHEMA_VERSION,
  createPolicySnapshot
} = require('../packages/agent-resource-policy');

const IMPROVEMENT_KIND = 'engineering_improvement';

async function main() {
  await testMemoryImprovementContinuation();
  await testClarificationTaskSourceSet();
  await testEngineeringFeedbackContinuation();
  await testPostgresOwnershipGate();
  testTeacherAndApiContinuationBoundary();
  console.log('ai teacher engineering improvement continuation tests passed');
}

async function testEngineeringFeedbackContinuation() {
  const store = createMemoryConversationStore();
  const sourceContext = teacherContext('req_engineering_feedback_source');
  sourceContext.question.text = '构建热管理系统，并覆盖关键回路。';
  const { threadId } = await store.ensureThread(sourceContext, 'thread_engineering_feedback');
  const sourceRun = await store.createRun({ threadId, context: sourceContext, intent: 'single_entry', route: 'test' });
  const hashes = deriveExecutionInputHashes(sourceContext);
  const workspaceHash = hash('engineering-feedback-workspace');
  const candidate = await store.appendExecutionCheckpoint({
    runId: sourceRun.runId,
    boundary: {
      phase: 'candidate_ready', ...hashes,
      candidate: {
        candidateWorkspaceHash: workspaceHash,
        payload: {
          mode: 'standalone_model', fileName: 'thermal.sysml',
          content: 'package Thermal { part def DeliveredRevision; }'
        }
      }
    }
  });
  const validation = await store.appendExecutionCheckpoint({
    runId: sourceRun.runId,
    boundary: {
      phase: 'validated_passed', ...hashes,
      candidateArtifactId: candidate.candidateArtifact.artifactId,
      validation: {
        candidateWorkspaceHash: workspaceHash,
        validatorVersion: 'official-validator-test-v1',
        rulesetVersion: 'official-rules-test-v1',
        validationOptionsHash: hash('engineering-feedback-options'),
        payload: {
          passed: true, validatorStatus: 'validated_passed', completeness: 'complete',
          official: { syntax: 'passed', semantic: 'passed', diagnostics: [] },
          courseRuleApplicability: 'not_applicable',
          candidateWorkspaceHash: workspaceHash
        }
      },
      validatorVersion: 'official-validator-test-v1',
      rulesetVersion: 'official-rules-test-v1',
      validationOptionsHash: hash('engineering-feedback-options')
    }
  });
  await store.appendExecutionCheckpoint({
    runId: sourceRun.runId,
    boundary: {
      phase: 'completed', ...hashes,
      candidateArtifactId: candidate.candidateArtifact.artifactId,
      validationArtifactId: validation.validationArtifact.artifactId,
      validatorVersion: 'official-validator-test-v1',
      rulesetVersion: 'official-rules-test-v1',
      validationOptionsHash: hash('engineering-feedback-options'),
      metadata: { engineeringDeliveryStatus: 'delivery_confirmed', frontendResultReturned: true }
    }
  });
  await store.completeRun({
    runId: sourceRun.runId,
    context: sourceContext,
    response: {
      ...completedBaselineResponse(sourceContext.requestId),
      continuation: {
        kind: IMPROVEMENT_KIND, status: 'complete', autoContinuationUsed: true,
        canContinue: false, completedItems: [], remainingItems: []
      },
      engineeringReview: {
        revisionDelivered: true,
        engineeringResolution: 'unresolved',
        openSuggestions: [{ publicSuggestionId: 'suggestion_feedback_12345678', summary: '补充关键控制关系。' }],
        canContinue: true,
        sourceRunId: sourceRun.runId
      }
    },
    providerMeta: {
      agent: {
        answerCompletionStatus: 'complete',
        fastGatePassThroughV2: { gateOutcome: 'pass' }
      }
    }
  });

  const feedbackContext = teacherContext('req_engineering_feedback_next');
  feedbackContext.question.text = '优先补充控制关系，并保留当前组件命名。';
  feedbackContext.manualContinuationSourceRunId = sourceRun.runId;
  feedbackContext.manualContinuationKind = 'engineering_feedback';
  const resumed = await store.createManualContinuationRun({
    threadId,
    context: feedbackContext,
    intent: 'single_entry',
    route: 'test',
    sourceRunId: sourceRun.runId,
    continuationKind: 'engineering_feedback'
  });
  assert.equal(resumed.workflowResume.continuationKind, IMPROVEMENT_KIND);
  assert.equal(resumed.workflowResume.execution.decision.phase, 'engineering_improvement_pending');
  assert.deepStrictEqual(resumed.workflowResume.execution.decision.allowedActions, ['engineering_resume']);
  assert.deepStrictEqual(resumed.workflowResume.execution.engineering.previousSuggestions, [{
    publicSuggestionId: 'suggestion_feedback_12345678', summary: '补充关键控制关系。'
  }], '下一轮必须继承上一轮有界公开建议，而不是全量Review文本');
  assert.equal(resumed.workflowResume.execution.worker.candidate.content,
    'package Thermal { part def DeliveredRevision; }',
    '用户反馈续跑必须直接复用最近Delivered PASS Candidate，不重新生成Primary');
  assert.deepStrictEqual(
    resumed.workflowResume.taskSources.map((source) => ({ relation: source.relation, text: source.text })),
    [
      { relation: 'root_user_request', text: sourceContext.question.text },
      { relation: 'engineering_feedback', text: feedbackContext.question.text }
    ]
  );
  const persistedUser = store.state.messages.get(threadId).find((message) => message.runId === resumed.run.runId && message.role === 'user');
  assert.equal(persistedUser.content, feedbackContext.question.text, '用户意见必须作为正式User Message持久化');
  assert.equal(resumed.run.metadata.manualContinuationKind, 'engineering_feedback');

  const feedbackResponse = {
    ...completedBaselineResponse(feedbackContext.requestId),
    warnings: [],
    continuation: {
      kind: IMPROVEMENT_KIND,
      status: 'complete',
      autoContinuationUsed: true,
      canContinue: false,
      completedItems: [],
      remainingItems: []
    },
    engineeringReview: {
      revisionDelivered: true,
      engineeringResolution: 'resolved',
      openSuggestions: [],
      canContinue: false,
      sourceRunId: resumed.run.runId
    }
  };
  await store.completeRun({
    runId: resumed.run.runId,
    context: feedbackContext,
    response: feedbackResponse,
    providerMeta: {
      agent: {
        answerCompletionStatus: 'complete',
        fastGatePassThroughV2: { gateOutcome: 'pass' }
      }
    }
  });
  const idempotentRetry = await store.createManualContinuationRun({
    threadId,
    context: feedbackContext,
    intent: 'single_entry',
    route: 'test',
    sourceRunId: sourceRun.runId,
    continuationKind: 'engineering_feedback'
  });
  assert.equal(idempotentRetry.reused, true,
    '同requestId网络重试必须在latest/CAS检查前重放已持久化feedback Run');
  assert.equal(idempotentRetry.run.runId, resumed.run.runId);
  assert.deepStrictEqual(idempotentRetry.response, feedbackResponse);
  assert.equal(
    store.state.messages.get(threadId).filter((message) => message.runId === resumed.run.runId && message.role === 'user').length,
    1,
    '幂等重放不得重复持久化用户意见'
  );

  await assert.rejects(
    store.createManualContinuationRun({
      threadId,
      context: { ...feedbackContext, requestId: 'req_engineering_feedback_stale' },
      intent: 'single_entry', route: 'test', sourceRunId: sourceRun.runId,
      continuationKind: 'engineering_feedback'
    }),
    (error) => ['ENGINEERING_FEEDBACK_SOURCE_STALE', 'MANUAL_CONTINUATION_IN_PROGRESS'].includes(error.code),
    '旧版本或已有活动续跑时不得再次从过期Delivered Candidate启动'
  );
}

async function testMemoryImprovementContinuation() {
  const store = createMemoryConversationStore();
  const sourceContext = teacherContext('req_engineering_source');
  const { threadId } = await store.ensureThread(sourceContext, 'thread_engineering_improvement');
  const sourceRun = await store.createRun({
    threadId,
    context: sourceContext,
    intent: 'single_entry',
    route: 'engineering-improvement-test'
  });
  const hashes = deriveExecutionInputHashes(sourceContext);
  const candidateWorkspaceHash = hash('engineering-baseline-workspace');
  const candidate = await store.appendExecutionCheckpoint({
    runId: sourceRun.runId,
    boundary: {
      phase: 'candidate_ready',
      ...hashes,
      candidate: {
        candidateWorkspaceHash,
        payload: {
          mode: 'standalone_model',
          fileName: 'thermal-baseline.sysml',
          content: 'package ThermalBaseline { part def ThermalSystem; }'
        }
      }
    }
  });
  const validation = await store.appendExecutionCheckpoint({
    runId: sourceRun.runId,
    boundary: {
      phase: 'validated_passed',
      ...hashes,
      candidateArtifactId: candidate.candidateArtifact.artifactId,
      validation: {
        candidateWorkspaceHash,
        validatorVersion: 'official-validator-test-v1',
        rulesetVersion: 'official-rules-test-v1',
        validationOptionsHash: hash('official-validation-options'),
        payload: {
          passed: true,
          validatorStatus: 'validated_passed',
          validator: { version: 'official-validator-test-v1' }
        }
      },
      validatorVersion: 'official-validator-test-v1',
      rulesetVersion: 'official-rules-test-v1',
      validationOptionsHash: hash('official-validation-options')
    }
  });
  await store.appendExecutionCheckpoint({
    runId: sourceRun.runId,
    boundary: {
      phase: 'engineering_improvement_pending',
      ...hashes,
      candidateArtifactId: candidate.candidateArtifact.artifactId,
      validationArtifactId: validation.validationArtifact.artifactId,
      metadata: {
        engineering: {
          continuationKind: IMPROVEMENT_KIND,
          baselineCandidateArtifactId: candidate.candidateArtifact.artifactId,
          baselineCandidateArtifactHash: candidate.candidateArtifact.artifactHash,
          baselineValidationArtifactId: validation.validationArtifact.artifactId,
          baselineValidationArtifactHash: validation.validationArtifact.artifactHash,
          taskGoalRefs: [{ sourceKind: 'initial_question', start: 0, end: 16 }],
          issueSummaries: [{ title: '热管理回路覆盖仍需完善' }],
          assessmentCount: 1,
          verificationCount: 0
        }
      }
    }
  });
  await store.completeRun({
    runId: sourceRun.runId,
    context: sourceContext,
    response: completedBaselineResponse(sourceContext.requestId),
    providerMeta: eligibleImprovementProviderMeta(candidate, validation)
  });
  assert.strictEqual(
    store.state.messages.get(threadId).find((message) => message.runId === sourceRun.runId && message.role === 'assistant').status,
    'internal_baseline',
    'Primary PASS基线待自动完善时不得成为普通公开assistant消息'
  );

  const continuationContext = teacherContext('req_engineering_source:auto-1');
  const continuation = await store.createAutomaticContinuationRun({
    threadId,
    context: continuationContext,
    intent: 'single_entry',
    route: 'engineering-improvement-test',
    sourceRunId: sourceRun.runId,
    continuationKind: IMPROVEMENT_KIND,
    continuationBudget: improvementBudget()
  });

  assert.strictEqual(continuation.automaticContinuation, true);
  assert.strictEqual(continuation.run.metadata.automaticContinuationKind, IMPROVEMENT_KIND);
  assert.strictEqual(JSON.stringify(continuation.run.metadata.taskSourceSet).includes(sourceContext.question.text), false,
    'Run metadata只保存TaskSource引用与hash，不复制用户正文');
  assert.strictEqual(continuation.workflowResume.continuationKind, IMPROVEMENT_KIND);
  assert.strictEqual(continuation.workflowResume.execution.continuationKind, IMPROVEMENT_KIND);
  assert.strictEqual(continuation.workflowResume.taskSources.length, 1);
  assert.strictEqual(continuation.workflowResume.taskSources[0].relation, 'root_user_request');
  assert.match(continuation.workflowResume.taskSources[0].messageId, /^msg_/u);
  assert.match(continuation.workflowResume.taskSources[0].sourceHash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(continuation.workflowResume.taskSources[0].taskAuthorizationRevisionHash, /^sha256:[a-f0-9]{64}$/u);
  assert.strictEqual(
    continuation.workflowResume.taskSources[0].authorizationRevisionHash,
    continuation.workflowResume.taskSources[0].taskAuthorizationRevisionHash
  );
  assert.strictEqual(
    continuation.workflowResume.execution.engineering.baselineCandidate.content,
    'package ThermalBaseline { part def ThermalSystem; }',
    'Repository必须按Artifact引用恢复PASS基线正文'
  );
  assert.strictEqual(
    continuation.workflowResume.execution.engineering.baselineValidation.passed,
    true,
    'Repository必须按Artifact引用恢复PASS验证证据'
  );
  assert.strictEqual(
    continuation.workflowResume.execution.worker.candidate.content,
    'package ThermalBaseline { part def ThermalSystem; }',
    '当前Checkpoint Candidate仍是revision工作区，不能触发Primary重生成'
  );
  assert.deepStrictEqual(
    continuation.workflowResume.execution.engineering.taskGoalRefs,
    [{ sourceKind: 'initial_question', start: 0, end: 16 }]
  );
  assert.strictEqual(
    JSON.stringify(continuation.workflowResume.execution.engineering.metadata || {}).includes('package ThermalBaseline'),
    false,
    'Engineering metadata不得复制Candidate正文'
  );
  assert.strictEqual(store.state.executionLineages.get(sourceRun.runId).automaticContinuationCount, 1);

  const duplicate = await store.createAutomaticContinuationRun({
    threadId,
    context: continuationContext,
    intent: 'single_entry',
    route: 'engineering-improvement-test',
    sourceRunId: sourceRun.runId,
    continuationKind: IMPROVEMENT_KIND,
    continuationBudget: improvementBudget()
  });
  assert.strictEqual(duplicate.reused, true, '相同source/kind/request必须幂等复用唯一child');
  assert.strictEqual(duplicate.run.runId, continuation.run.runId);
  await store.completeRun({
    runId: continuation.run.runId,
    context: continuationContext,
    response: {
      ...completedBaselineResponse(continuationContext.requestId),
      directAnswer: '工程语义完善后的唯一公开结果。',
      continuation: {
        kind: IMPROVEMENT_KIND,
        status: 'complete',
        sourceRunId: sourceRun.runId,
        autoContinuationUsed: true,
        canContinue: false,
        completedItems: [],
        remainingItems: []
      }
    },
    providerMeta: { agent: { answerCompletionStatus: 'complete' } }
  });
  const visibleMessages = await store.listMessages(threadId, { limit: 20 });
  const visibleAssistants = visibleMessages.filter((message) => message.role === 'assistant');
  assert.strictEqual(visibleAssistants.length, 1, 'Thread history整条lineage只能保留一个公开assistant final');
  assert.strictEqual(visibleAssistants[0].content, '工程语义完善后的唯一公开结果。');

  await assert.rejects(
    store.createAutomaticContinuationRun({
      threadId,
      context: teacherContext('req_engineering_different_kind'),
      intent: 'single_entry',
      route: 'engineering-improvement-test',
      sourceRunId: sourceRun.runId,
      continuationKind: 'execution_completion'
    }),
    (error) => ['AUTOMATIC_CONTINUATION_LIMIT_REACHED', 'AUTOMATIC_CONTINUATION_UNAVAILABLE'].includes(error.code),
    '同一root lineage不得因kind不同创建第二个自动child'
  );
  assert.strictEqual(store.state.executionLineages.get(sourceRun.runId).automaticContinuationCount, 1);

  await assert.rejects(
    store.createAutomaticContinuationRun({
      threadId,
      context: { ...continuationContext, tenant: { ...continuationContext.tenant, userId: 'other-user' } },
      intent: 'single_entry',
      route: 'engineering-improvement-test',
      sourceRunId: sourceRun.runId,
      continuationKind: IMPROVEMENT_KIND,
      continuationBudget: improvementBudget()
    }),
    (error) => error.code === 'AUTOMATIC_CONTINUATION_UNAVAILABLE',
    '跨用户不得恢复工程资产'
  );
  await assert.rejects(
    store.createAutomaticContinuationRun({
      threadId: 'thread_engineering_other',
      context: continuationContext,
      intent: 'single_entry',
      route: 'engineering-improvement-test',
      sourceRunId: sourceRun.runId,
      continuationKind: IMPROVEMENT_KIND,
      continuationBudget: improvementBudget()
    }),
    (error) => error.code === 'AUTOMATIC_CONTINUATION_UNAVAILABLE',
    '跨Thread不得恢复工程资产'
  );

  const secondStore = await createEligibleImprovementStore('budget');
  await assert.rejects(
    secondStore.store.createAutomaticContinuationRun({
      threadId: secondStore.threadId,
      context: teacherContext('req_engineering_budget:auto-1'),
      intent: 'single_entry',
      route: 'engineering-improvement-budget-test',
      sourceRunId: secondStore.sourceRunId,
      continuationKind: IMPROVEMENT_KIND,
      continuationBudget: { ...improvementBudget(), effectiveDurationMs: 100_000, minimumCompleteChainMs: 180_000 }
    }),
    (error) => error.code === 'ENGINEERING_IMPROVEMENT_BUDGET_INSUFFICIENT',
    '低于完整工程链最低预算时不得创建child'
  );
}

async function testClarificationTaskSourceSet() {
  const store = createMemoryConversationStore();
  const rootContext = teacherContext('req_task_source_root');
  rootContext.question.text = '构建汽车热管理系统架构模型。';
  const { threadId } = await store.ensureThread(rootContext, 'thread_task_source_clarification');
  const rootRun = await store.createRun({ threadId, context: rootContext, intent: 'single_entry', route: 'test' });
  const clarificationCheckpointId = 'clar_task_source_12345678';
  await store.pauseRunForClarification({
    runId: rootRun.runId,
    context: rootContext,
    response: {
      ...completedBaselineResponse(rootContext.requestId),
      answerCompletionStatus: 'waiting_for_clarification',
      validatorStatus: undefined,
      directAnswer: '请补充工程边界。'
    },
    providerMeta: { agent: { fastGatePassThroughV2: { gateOutcome: 'pass' } } },
    checkpoint: {
      checkpointId: clarificationCheckpointId,
      acceptedToolCallId: 'tool_task_source_clarification',
      question: '请补充工程边界。',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }
  });
  const clarificationContext = teacherContext('req_task_source_clarification');
  clarificationContext.question.text = '需要覆盖乘员舱、电池和快充热管理回路。';
  clarificationContext.clarificationCheckpointId = clarificationCheckpointId;
  const resumed = await store.createResumedRun({
    threadId,
    context: clarificationContext,
    intent: 'single_entry',
    route: 'test',
    checkpointId: clarificationCheckpointId
  });
  const hashes = deriveExecutionInputHashes(clarificationContext);
  const workspaceHash = hash('clarification-baseline-workspace');
  const candidate = await store.appendExecutionCheckpoint({
    runId: resumed.run.runId,
    boundary: {
      phase: 'candidate_ready',
      ...hashes,
      candidate: {
        candidateWorkspaceHash: workspaceHash,
        payload: { content: 'package ClarifiedThermal { part def ThermalSystem; }' }
      }
    }
  });
  const validation = await store.appendExecutionCheckpoint({
    runId: resumed.run.runId,
    boundary: {
      phase: 'validated_passed',
      ...hashes,
      candidateArtifactId: candidate.candidateArtifact.artifactId,
      validation: {
        candidateWorkspaceHash: workspaceHash,
        validatorVersion: 'official-validator-test-v1',
        rulesetVersion: 'official-rules-test-v1',
        validationOptionsHash: hash('clarification-validation-options'),
        payload: { passed: true, validator: { version: 'official-validator-test-v1' } }
      }
    }
  });
  await store.appendExecutionCheckpoint({
    runId: resumed.run.runId,
    boundary: {
      phase: 'engineering_improvement_pending',
      ...hashes,
      candidateArtifactId: candidate.candidateArtifact.artifactId,
      validationArtifactId: validation.validationArtifact.artifactId,
      metadata: { engineering: { continuationKind: IMPROVEMENT_KIND } }
    }
  });
  await store.completeRun({
    runId: resumed.run.runId,
    context: clarificationContext,
    response: completedBaselineResponse(clarificationContext.requestId),
    providerMeta: eligibleImprovementProviderMeta(candidate, validation)
  });
  const continuationContext = {
    ...clarificationContext,
    requestId: 'req_task_source_clarification:auto-1'
  };
  delete continuationContext.clarificationCheckpointId;
  const child = await store.createAutomaticContinuationRun({
    threadId,
    context: continuationContext,
    intent: 'single_entry',
    route: 'test',
    sourceRunId: resumed.run.runId,
    continuationKind: IMPROVEMENT_KIND,
    continuationBudget: improvementBudget()
  });
  assert.deepStrictEqual(
    child.workflowResume.taskSources.map((source) => ({ relation: source.relation, text: source.text })),
    [
      { relation: 'root_user_request', text: rootContext.question.text },
      { relation: 'clarification_user_answer', text: clarificationContext.question.text }
    ],
    'engineering child必须恢复root初始问题与澄清回答，不能只传入口继续文案'
  );
  assert.strictEqual(new Set(child.workflowResume.taskSources.map(
    (source) => source.taskAuthorizationRevisionHash
  )).size, 1, 'TaskSourceSet必须共享同一不可变授权revision hash');
}

async function createEligibleImprovementStore(suffix) {
  const store = createMemoryConversationStore();
  const context = teacherContext(`req_engineering_${suffix}`);
  const { threadId } = await store.ensureThread(context, `thread_engineering_${suffix}`);
  const run = await store.createRun({ threadId, context, intent: 'single_entry', route: 'test' });
  await store.appendExecutionCheckpoint({
    runId: run.runId,
    boundary: { phase: 'candidate_absent', ...deriveExecutionInputHashes(context) }
  });
  await store.completeRun({
    runId: run.runId,
    context,
    response: completedBaselineResponse(context.requestId),
    providerMeta: eligibleImprovementProviderMeta()
  });
  return { store, threadId, sourceRunId: run.runId };
}

async function testPostgresOwnershipGate() {
  const statements = [];
  let released = false;
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push({ sql: normalized, params });
      if (/^select \* from teacher_runs/u.test(normalized)) return { rows: [] };
      return { rows: [] };
    },
    release() {
      released = true;
    }
  };
  const store = createPostgresConversationStore({ pool: { connect: async () => client } });
  const context = teacherContext('req_engineering_postgres_owner');
  await assert.rejects(
    store.createAutomaticContinuationRun({
      threadId: 'thread_engineering_postgres_owner',
      context,
      intent: 'single_entry',
      route: 'engineering-improvement-postgres-test',
      sourceRunId: 'run_engineering_postgres_source',
      continuationKind: IMPROVEMENT_KIND,
      continuationBudget: improvementBudget()
    }),
    (error) => error.code === 'AUTOMATIC_CONTINUATION_UNAVAILABLE'
  );
  const ownershipSelect = statements.find((entry) => (
    /thread_id = \$2 and tenant_id = \$3 and user_id = \$4/u.test(entry.sql)
    && /for update/u.test(entry.sql)
  ));
  assert(ownershipSelect, 'Postgres必须在加锁查询中绑定thread/tenant/user');
  assert(statements.some((entry) => entry.sql === 'rollback'));
  assert.strictEqual(released, true);
}

function testTeacherAndApiContinuationBoundary() {
  const sourceResponse = completedBaselineResponse('req_boundary_source');
  const continuation = engineeringImprovementServerForTests.attachExecutionContinuation(sourceResponse, {
    execution: { automaticContinuation: false },
    run: { runId: 'run_engineering_boundary_source' },
    internal: {
      agent: {
        engineeringImprovement: { status: 'pending', continuationKind: IMPROVEMENT_KIND }
      }
    },
    enabled: true,
    recoveryAvailable: true
  });
  assert.deepStrictEqual({
    kind: continuation.kind,
    status: continuation.status,
    answerCompletionStatus: sourceResponse.answerCompletionStatus,
    validatorStatus: sourceResponse.validatorStatus
  }, {
    kind: IMPROVEMENT_KIND,
    status: 'automatic_pending',
    answerCompletionStatus: 'complete',
    validatorStatus: 'validated_passed'
  }, 'Teacher必须将PASS基线投影为非阻断engineering_improvement pending');

  const sourceValidated = {
    ...completedBaselineResponse('req_execution_source'),
    directAnswer: '已验证候选正文\n```sysml\npackage Lunar { part def Lander; }\n```',
    answerCompletionStatus: 'incomplete',
    candidateDeliveryStatus: 'changed_delivered',
    candidateWorkspaceHash: `sha256:${'a'.repeat(64)}`,
    candidateAttestation: { authority: 'server', candidateWorkspaceHash: `sha256:${'a'.repeat(64)}` },
    patches: [{ fileId: 'main.sysml', kind: 'replace_entry', content: 'package Lunar { part def Lander; }' }],
    codeBlockValidations: [{ language: 'sysml', status: 'validated_passed' }]
  };
  const continuationWithoutNewCandidate = {
    ...completedBaselineResponse('req_execution_child'),
    directAnswer: '本轮未形成可交付候选。',
    answerCompletionStatus: 'incomplete',
    validatorStatus: 'not_validated',
    candidateDeliveryStatus: 'not_required',
    patches: [],
    codeBlockValidations: []
  };
  engineeringImprovementServerForTests.attachExecutionContinuation(continuationWithoutNewCandidate, {
    execution: { automaticContinuation: true, sourceResponse: sourceValidated },
    run: { runId: 'run_execution_child' },
    internal: { agent: { stopReason: 'timeout', stopCause: 'work_deadline_reached' } },
    enabled: true,
    recoveryAvailable: true
  });
  assert.strictEqual(continuationWithoutNewCandidate.validatorStatus, 'validated_passed');
  assert.strictEqual(continuationWithoutNewCandidate.candidateDeliveryStatus, 'changed_delivered');
  assert.match(continuationWithoutNewCandidate.directAnswer, /package Lunar/u,
    '自动续跑没有新候选时必须保留父Run的last-good可见正文');
  assert.doesNotMatch(continuationWithoutNewCandidate.directAnswer, /^本轮未形成可交付候选/u,
    '子Run失败摘要不得覆盖父Run已交付的Official Validator PASS候选');
  assert.strictEqual(continuationWithoutNewCandidate.patches.length, 1,
    '自动续跑投影必须保留父Run可应用的候选Patch');

  assert.strictEqual(engineeringImprovementServerForTests.persistedCompletedResumeResponse({
    execution: {
      workflowResume: {
        continuationKind: IMPROVEMENT_KIND,
        execution: {
          continuationKind: IMPROVEMENT_KIND,
          decision: { phase: 'completed', stale: false },
          persistedAnswer: '不能零LLM返回的旧基线'
        }
      },
      sourceResponse
    },
    context: { requestId: 'req_boundary_resume' },
    startMetadata: {},
    run: { requestId: 'req_boundary_resume' },
    thread: { threadId: 'thread_boundary' }
  }), null, 'Improvement child不得被completed基线短路为零LLM返回');

  const snapshot = createPolicySnapshot({
    versionId: `arp_engineering_test_v${SCHEMA_VERSION}`,
    values: BOOTSTRAP_VALUES,
    frozenAt: new Date(0).toISOString()
  });
  const envelope = {
    requestId: 'req_boundary_source',
    runtimeAssignment: { resourcePolicySnapshot: snapshot }
  };
  const automaticEnvelope = engineeringImprovementApiForTests.automaticContinuationEnvelope(
    envelope,
    'run_engineering_boundary_source',
    IMPROVEMENT_KIND,
    Date.now()
  );
  assert.strictEqual(automaticEnvelope.automaticContinuationKind, IMPROVEMENT_KIND);
  const projectedPolicy = require('../packages/agent-resource-policy')
    .runtimeProjection(BOOTSTRAP_VALUES).teacher;
  assert(automaticEnvelope.automaticContinuationBudget.effectiveDurationMs
    <= projectedPolicy.agentEngineeringImprovementRunMaxDurationMs,
  JSON.stringify(automaticEnvelope.automaticContinuationBudget));
  assert(automaticEnvelope.automaticContinuationBudget.effectiveDurationMs
    >= projectedPolicy.agentEngineeringImprovementRunMaxDurationMs - 1_000,
  JSON.stringify(automaticEnvelope.automaticContinuationBudget));
  assert.strictEqual(automaticEnvelope.runtimeAssignment, undefined,
    'child必须重新取得服务端runtime assignment，但沿用可信冻结policy snapshot进行预算预留');

  const fallback = engineeringImprovementApiForTests.finalizeAutomaticContinuationFallback(
    sourceResponse,
    Object.assign(new Error('internal continuation failure'), { code: 'TEACHER_TIMEOUT' }),
    true
  );
  assert.strictEqual(fallback.answerCompletionStatus, 'complete');
  assert.strictEqual(fallback.validatorStatus, 'validated_passed');
  assert.strictEqual(fallback.continuation.kind, IMPROVEMENT_KIND);
  assert.strictEqual(fallback.continuation.status, 'user_confirmation_required');
  assert(!fallback.directAnswer.includes('internal continuation failure'),
    '内部异常不得抛给学生前端');

  assert.deepStrictEqual(
    engineeringImprovementApiForTests.projectStudentTeacherStreamEvent({ type: 'baseline_ready' }),
    {
      type: 'activity',
      stage: 'baseline_ready',
      message: '已保存并通过官方Validator的基线，正在准备工程语义完善。'
    },
    'baseline_ready只能作为活动事件，不能形成第一条final'
  );
  assert.deepStrictEqual(
    engineeringImprovementApiForTests.projectStudentTeacherStreamEvent({
      type: 'activity',
      activityId: 'repair-2',
      kind: 'repair',
      status: 'running',
      message: '正在进行第 2/3 轮修复。',
      count: 5,
      candidate: 'must-not-leak'
    }),
    {
      type: 'activity',
      activityId: 'repair-2',
      kind: 'repair',
      status: 'running',
      message: '正在进行第 2/3 轮修复。',
      count: 5
    },
    'API必须保留公开Repair状态，同时删除Candidate等内部字段'
  );
  assert.strictEqual(
    engineeringImprovementApiForTests.publicExecutionContinuation(continuation).kind,
    IMPROVEMENT_KIND,
    '公共投影必须显式保留continuation.kind'
  );
}

function completedBaselineResponse(requestId) {
  return {
    contractVersion: '1.1',
    responseId: `resp_${crypto.randomUUID()}`,
    requestId,
    answerType: 'agentic_answer',
    title: 'AI 教师',
    confidence: 'medium',
    directAnswer: '已形成并通过官方Validator的基线模型。',
    answerCompletionStatus: 'complete',
    validatorStatus: 'validated_passed',
    warnings: ['engineering_semantic_review_pending'],
    continuation: {
      kind: IMPROVEMENT_KIND,
      status: 'automatic_pending',
      autoContinuationUsed: false,
      canContinue: false,
      completedItems: [],
      remainingItems: []
    }
  };
}

function eligibleImprovementProviderMeta(candidate, validation) {
  return {
    agent: {
      fastGatePassThroughV2: { version: 'fast-gate-pass-through-v2', gateOutcome: 'pass' },
      answerCompletionStatus: 'complete',
      engineeringImprovement: {
        status: 'pending',
        baselineCandidateArtifactId: candidate?.candidateArtifact?.artifactId || '',
        baselineValidationArtifactId: validation?.validationArtifact?.artifactId || ''
      }
    }
  };
}

function improvementBudget() {
  return {
    effectiveDurationMs: 800_000,
    maximumDurationMs: 900_000,
    lineageMaximumDurationMs: 1_500_000,
    orchestrationReserveMs: 20_000,
    minimumCompleteChainMs: 180_000
  };
}

function teacherContext(requestId) {
  const resourcePolicySnapshot = createPolicySnapshot({
    versionId: `arp_engineering_context_v${SCHEMA_VERSION}`,
    values: BOOTSTRAP_VALUES,
    frozenAt: new Date(0).toISOString()
  });
  return {
    contractVersion: '1.1',
    requestId,
    runtimeAssignment: { resourcePolicySnapshot },
    tenant: { tenantId: 'tenant-test', userId: 'user-test' },
    course: {
      coursePackId: 'pack-test',
      courseId: 'course-test',
      lessonId: 'lesson-test',
      courseRuleMode: 'lesson_after_official_pass',
      learningGoals: ['形成工程完整的热管理架构']
    },
    courseContext: {
      authority: 'server-course-pack',
      todoItems: [{ id: 'todo-engineering', text: '形成工程完整的热管理架构', required: true }]
    },
    editor: {
      language: 'sysmlv2',
      entryFile: 'main.sysml',
      activeFilePath: 'main.sysml',
      files: [{ path: 'main.sysml', content: '' }]
    },
    question: { text: '构建汽车热管理系统架构模型，并覆盖明确提出的工程目标。' },
    diagnostics: { officialValidator: [], courseRules: [] }
  };
}

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
