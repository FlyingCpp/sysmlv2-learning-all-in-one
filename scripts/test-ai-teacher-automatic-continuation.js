'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  validateHostContextEnvelope,
  validateTeacherCapabilityResponse
} = require('../packages/teacher-contract');
const {
  createMemoryConversationStore,
  createPostgresConversationStore
} = require('../apps/teacher/conversation-store');
const {
  deriveExecutionInputHashes
} = require('../apps/teacher/execution-checkpoint');
const {
  agentStudentQuestionForTests
} = require('../apps/teacher/agent-adapter');
const baseHostFixture = require('../packages/teacher-contract/fixtures/host-context-basic.json');

async function main() {
  const contractResponse = {
    contractVersion: '1.1',
    responseId: 'resp_continuation_test',
    requestId: 'req_continuation_test',
    answerType: 'agentic_answer',
    title: 'AI 教师',
    confidence: 'medium',
    directAnswer: '已完成阶段性工作。',
    answerCompletionStatus: 'incomplete',
    continuation: {
      kind: 'execution_completion',
      status: 'user_confirmation_required',
      sourceRunId: 'run_12345678',
      autoContinuationUsed: true,
      canContinue: true,
      completedItems: [{ title: '已生成候选模型', status: 'completed' }],
      remainingItems: [{ title: '完成剩余验证', status: 'remaining' }]
    }
  };
  assert.deepStrictEqual(validateTeacherCapabilityResponse(contractResponse, {}).errors, undefined);

  const store = createMemoryConversationStore();
  const context = teacherContext('req_source');
  const thread = await store.ensureThread(context, 'thread_automatic_continuation');
  const sourceRun = await store.createRun({
    threadId: thread.threadId,
    context,
    intent: 'single_entry',
    route: 'automatic-continuation-test'
  });
  await store.appendExecutionCheckpoint({
    runId: sourceRun.runId,
    boundary: {
      phase: 'candidate_absent',
      ...deriveExecutionInputHashes(context)
    }
  });
  await store.completeRun({
    runId: sourceRun.runId,
    context,
    response: contractResponse,
    providerMeta: eligibleProviderMeta()
  });

  const continuationContext = teacherContext('req_source:auto-1');
  const firstContinuation = await store.createAutomaticContinuationRun({
    threadId: thread.threadId,
    context: continuationContext,
    intent: 'single_entry',
    route: 'automatic-continuation-test',
    sourceRunId: sourceRun.runId
  });
  assert.strictEqual(firstContinuation.automaticContinuation, true);
  assert.strictEqual(firstContinuation.run.metadata.continuationRootRunId, sourceRun.runId,
    '自动续跑必须绑定root lineage');
  assert.deepStrictEqual({
    automaticContinuationCount: store.state.executionLineages.get(sourceRun.runId)?.automaticContinuationCount,
    automaticContinuationRunId: store.state.executionLineages.get(sourceRun.runId)?.automaticContinuationRunId
  }, {
    automaticContinuationCount: 1,
    automaticContinuationRunId: firstContinuation.run.runId
  }, 'root lineage必须原子记录唯一一次自动续跑');
  assert.strictEqual(firstContinuation.workflowResume.sourceRunId, sourceRun.runId);
  assert.strictEqual(firstContinuation.workflowResume.execution.decision.stale, false);
  assert.deepStrictEqual(firstContinuation.workflowResume.execution.decision.allowedActions, ['candidate'],
    '相同学生问题、任务合同和编辑器基线必须复用Checkpoint');
  assert.strictEqual(firstContinuation.workflowResume.fastGate.gateOutcome, 'pass');
  assert.strictEqual(firstContinuation.workflowResume.sourceStudentQuestion, context.question.text,
    '自动续跑必须从源Run恢复原始学生任务，不能只把通用继续文案交给Worker');
  assert.strictEqual(agentStudentQuestionForTests(
    { question: { text: '请继续完成上一轮尚未完成的工作。' } },
    firstContinuation.workflowResume
  ), context.question.text, 'Candidate Worker必须优先使用服务端恢复的源任务');
  assert.strictEqual(agentStudentQuestionForTests(
    { question: { text: '当前澄清答案' } },
    { sourceRunId: sourceRun.runId, fastGate: firstContinuation.workflowResume.fastGate, priorToolLedger: [] }
  ), '当前澄清答案', '非自动续跑不得覆盖当前学生问题');

  const duplicate = await store.createAutomaticContinuationRun({
    threadId: thread.threadId,
    context: continuationContext,
    intent: 'single_entry',
    route: 'automatic-continuation-test',
    sourceRunId: sourceRun.runId
  });
  assert.strictEqual(duplicate.reused, true);
  assert.strictEqual(duplicate.run.runId, firstContinuation.run.runId);

  const finalResponse = {
    ...contractResponse,
    responseId: 'resp_continuation_final',
    requestId: continuationContext.requestId,
    continuation: {
      ...contractResponse.continuation,
      sourceRunId: sourceRun.runId
    }
  };
  await store.completeRun({
    runId: firstContinuation.run.runId,
    context: continuationContext,
    response: finalResponse,
    providerMeta: eligibleProviderMeta()
  });

  const messages = await store.listMessages(thread.threadId, { limit: 20 });
  assert.strictEqual(messages.filter((message) => message.role === 'user').length, 1,
    '自动续跑不得复制用户消息');
  assert.strictEqual(messages.filter((message) => message.role === 'assistant').length, 2,
    '源 Run 阶段性结果和自动续跑终态都必须可审计');

  await assert.rejects(
    store.createAutomaticContinuationRun({
      threadId: thread.threadId,
      context: teacherContext('req_illegal_auto_2'),
      intent: 'single_entry',
      route: 'automatic-continuation-test',
      sourceRunId: firstContinuation.run.runId
    }),
    (error) => error.code === 'AUTOMATIC_CONTINUATION_UNAVAILABLE',
    '自动续跑 Run 不得成为第三轮自动续跑的来源'
  );

  await assertAutomaticContinuationStale('request_revision_changed', (value) => ({
    ...value,
    question: { ...value.question, text: '请改为完成另一个模型。' }
  }));
  await assertAutomaticContinuationStale('task_contract_changed', (value) => ({
    ...value,
    course: { ...value.course, lessonId: 'lesson-test-revision-2' }
  }));
  await assertAutomaticContinuationStale('editor_base_changed', (value) => ({
    ...value,
    editor: {
      ...value.editor,
      files: value.editor.files.map((file) => ({ ...file, content: `${file.content}\npart def Changed;` }))
    }
  }));

  await testManualContinuationUsesLatestLineageCheckpoint(contractResponse);
  await testManualContinuationOwnershipAndStaleInput(contractResponse);
  await testManualContinuationRejectsCompleteResponse();
  await testPostgresManualContinuationOwnershipGate();
  await testModelTranscriptExcludesIncompleteAssistantNarration();
  await testPostgresTranscriptKeepsFailedUsers();
  await testPostgresListMessagesProjectsAutomaticSource();

  console.log('ai teacher automatic continuation tests passed');
}

async function testModelTranscriptExcludesIncompleteAssistantNarration() {
  const store = createMemoryConversationStore();
  const firstContext = teacherContext('req_transcript_incomplete');
  const { threadId } = await store.ensureThread(firstContext, 'thread_transcript_terminal_state');
  const incompleteRun = await store.createRun({
    threadId,
    context: firstContext,
    intent: 'single_entry',
    route: 'transcript-terminal-state-test'
  });
  await store.completeRun({
    runId: incompleteRun.runId,
    context: firstContext,
    response: {
      contractVersion: '1.1',
      responseId: 'resp_transcript_incomplete',
      requestId: firstContext.requestId,
      answerType: 'agentic_answer',
      title: 'AI 教师',
      confidence: 'low',
      directAnswer: '模型说已经修复，但本轮实际上没有形成终末候选。',
      answerCompletionStatus: 'incomplete'
    },
    providerMeta: eligibleProviderMeta()
  });

  const completeContext = teacherContext('req_transcript_complete');
  const completeRun = await store.createRun({
    threadId,
    context: completeContext,
    intent: 'single_entry',
    route: 'transcript-terminal-state-test'
  });
  await store.completeRun({
    runId: completeRun.runId,
    context: completeContext,
    response: {
      contractVersion: '1.1',
      responseId: 'resp_transcript_complete',
      requestId: completeContext.requestId,
      answerType: 'explanation',
      title: 'AI 教师',
      confidence: 'high',
      directAnswer: '这是一个已完成的教学解释。',
      answerCompletionStatus: 'complete'
    },
    providerMeta: { agent: { stopReason: 'completed', answerCompletionStatus: 'complete' } }
  });

  const auditHistory = await store.listMessages(threadId, { limit: 20 });
  assert(auditHistory.some((message) => message.runId === incompleteRun.runId && message.role === 'assistant'),
    '不完整Assistant消息必须留在审计历史中');
  const modelTranscript = await store.listSuccessfulMessages(threadId, { limit: 20 });
  assert(!modelTranscript.some((message) => message.runId === incompleteRun.runId && message.role === 'assistant'),
    '不完整Assistant叙述不得作为下一轮模型事实进入Transcript');
  assert(modelTranscript.some((message) => message.runId === completeRun.runId && message.role === 'assistant'),
    '已完成Assistant教学回答应继续进入模型Transcript');
  assert(modelTranscript.some((message) => message.runId === incompleteRun.runId && message.role === 'user'),
    '学生原始任务即使对应Run未完成也必须保留在模型Transcript中');
}

async function testPostgresTranscriptKeepsFailedUsers() {
  let capturedSql = '';
  const store = createPostgresConversationStore({
    pool: {
      async query(sql) {
        capturedSql = String(sql).replace(/\s+/g, ' ').trim();
        return {
          rows: [
            {
              message_id: 'msg_failed_user', thread_id: 'thread_pg_transcript', run_id: 'run_failed',
              role: 'user', status: 'failed', content: '失败运行中的学生原文', response: null,
              request_id: 'req_failed', created_at: '2026-08-30T00:00:00.000Z'
            },
            {
              message_id: 'msg_failed_assistant', thread_id: 'thread_pg_transcript', run_id: 'run_failed',
              role: 'assistant', status: 'failed', content: '不可信失败叙述', response: null,
              request_id: 'req_failed', created_at: '2026-08-30T00:00:01.000Z'
            },
            {
              message_id: 'msg_complete_assistant', thread_id: 'thread_pg_transcript', run_id: 'run_complete',
              role: 'assistant', status: 'succeeded', content: '可信教学回答',
              response: { answerCompletionStatus: 'complete' }, request_id: 'req_complete',
              created_at: '2026-08-30T00:00:02.000Z'
            }
          ]
        };
      }
    }
  });
  const transcript = await store.listSuccessfulMessages('thread_pg_transcript');
  assert(capturedSql.includes("role = 'user' or status = 'succeeded'"),
    'Postgres Transcript查询必须先保留所有User，再对Assistant施加成功状态门');
  assert(transcript.some((message) => message.messageId === 'msg_failed_user'));
  assert(!transcript.some((message) => message.messageId === 'msg_failed_assistant'));
  assert(transcript.some((message) => message.messageId === 'msg_complete_assistant'));
}

async function testPostgresListMessagesProjectsAutomaticSource() {
  let capturedSql = '';
  const store = createPostgresConversationStore({
    pool: {
      async query(sql) {
        capturedSql = String(sql).replace(/\s+/g, ' ').trim();
        return {
          rows: [{
            message_id: 'msg_pg_auto_child', thread_id: 'thread_pg_auto', run_id: 'run_pg_auto_child',
            role: 'assistant', status: 'succeeded', content: '自动续跑终态', response: {
              answerCompletionStatus: 'incomplete',
              continuation: { status: 'user_confirmation_required', autoContinuationUsed: true }
            }, request_id: 'req_pg_auto_child', created_at: '2026-08-30T00:00:00.000Z',
            automatic_continuation_source_run_id: 'run_pg_auto_source'
          }]
        };
      }
    }
  });
  const messages = await store.listMessages('thread_pg_auto', { limit: 20 });
  assert(capturedSql.includes("metadata ->> 'automaticContinuationSourceRunId'"),
    'Postgres普通消息列表必须投影既有自动续跑父Run元数据，供API折叠父阶段消息');
  assert.strictEqual(messages[0]?.automaticContinuationSourceRunId, 'run_pg_auto_source');
}

async function testManualContinuationRejectsCompleteResponse() {
  const store = createMemoryConversationStore();
  const context = teacherContext('req_manual_complete_source');
  const { threadId } = await store.ensureThread(context, 'thread_manual_complete_source');
  const sourceRun = await store.createRun({
    threadId,
    context,
    intent: 'single_entry',
    route: 'manual-complete-source-test'
  });
  await store.appendExecutionCheckpoint({
    runId: sourceRun.runId,
    boundary: { phase: 'candidate_absent', ...deriveExecutionInputHashes(context) }
  });
  await store.completeRun({
    runId: sourceRun.runId,
    context,
    response: {
      contractVersion: '1.1', responseId: 'resp_manual_complete_source', requestId: context.requestId,
      answerType: 'agentic_answer', title: 'AI 教师', confidence: 'medium', directAnswer: '任务已完成。',
      answerCompletionStatus: 'complete',
      continuation: {
        kind: 'execution_completion', status: 'complete', sourceRunId: sourceRun.runId,
        autoContinuationUsed: true, canContinue: false, completedItems: [], remainingItems: []
      }
    },
    providerMeta: { agent: { answerCompletionStatus: 'complete', stopReason: 'completed' } }
  });
  await assert.rejects(
    store.createManualContinuationRun({
      threadId,
      context: { ...teacherContext('req_manual_complete_attempt'), manualContinuationSourceRunId: sourceRun.runId },
      intent: 'single_entry',
      route: 'manual-complete-source-test',
      sourceRunId: sourceRun.runId
    }),
    (error) => error.code === 'MANUAL_CONTINUATION_SOURCE_STALE',
    '已complete且canContinue=false的Run不得仅因Checkpoint仍存在而人工续跑'
  );
}

async function testManualContinuationUsesLatestLineageCheckpoint(contractResponse) {
  const store = createMemoryConversationStore();
  const sourceContext = teacherContext('req_manual_source');
  const { threadId } = await store.ensureThread(sourceContext, 'thread_manual_continuation');
  const sourceRun = await store.createRun({
    threadId,
    context: sourceContext,
    intent: 'single_entry',
    route: 'manual-continuation-test'
  });
  const hashes = deriveExecutionInputHashes(sourceContext);
  const candidate = await store.appendExecutionCheckpoint({
    runId: sourceRun.runId,
    boundary: {
      phase: 'candidate_ready',
      ...hashes,
      candidate: {
        candidateWorkspaceHash: hash('manual-candidate-workspace'),
        payload: {
          mode: 'standalone_model',
          fileName: 'manual-resume.sysml',
          content: 'package ManualResume { part def Vehicle; }'
        }
      }
    }
  });
  const validation = await store.appendExecutionCheckpoint({
    runId: sourceRun.runId,
    boundary: {
      phase: 'validation_failed',
      ...hashes,
      candidateArtifactId: candidate.candidateArtifact.artifactId,
      validation: {
        candidateWorkspaceHash: candidate.candidateArtifact.candidateWorkspaceHash,
        validatorVersion: 'manual-validator-v1',
        rulesetVersion: 'manual-rules-v1',
        validationOptionsHash: hash('manual-validation-options'),
        payload: {
          passed: false,
          diagnostic: 'missing port usage',
          validator: { version: 'manual-validator-v1' }
        }
      }
    }
  });
  await store.completeRun({
    runId: sourceRun.runId,
    context: sourceContext,
    response: contractResponse,
    providerMeta: eligibleProviderMeta()
  });

  const automaticContext = teacherContext('req_manual_source:auto-1');
  const automatic = await store.createAutomaticContinuationRun({
    threadId,
    context: automaticContext,
    intent: 'single_entry',
    route: 'manual-continuation-test',
    sourceRunId: sourceRun.runId
  });
  await store.appendExecutionCheckpoint({
    runId: automatic.run.runId,
    boundary: {
      phase: 'repair_in_progress',
      ...hashes,
      candidateArtifactId: candidate.candidateArtifact.artifactId,
      validationArtifactId: validation.validationArtifact.artifactId,
      repairRound: 2,
      repairState: { targetDiagnostics: ['missing port usage'] }
    }
  });
  const automaticResponse = {
    ...contractResponse,
    responseId: 'resp_manual_automatic_final',
    requestId: automaticContext.requestId,
    directAnswer: '自动续跑已到 Repair round 2，仍需继续。'
  };
  await store.completeRun({
    runId: automatic.run.runId,
    context: automaticContext,
    response: automaticResponse,
    providerMeta: eligibleProviderMeta()
  });

  const manualContext = {
    ...teacherContext('req_manual_continue_1'),
    manualContinuationSourceRunId: automatic.run.runId
  };
  const publicEnvelope = JSON.parse(JSON.stringify(baseHostFixture));
  publicEnvelope.requestId = manualContext.requestId;
  publicEnvelope.manualContinuationSourceRunId = automatic.run.runId;
  assert.strictEqual(validateHostContextEnvelope(publicEnvelope).ok, true,
    '公共契约必须接收manualContinuationSourceRunId');
  const engineeringFeedbackEnvelope = { ...publicEnvelope, manualContinuationKind: 'engineering_feedback' };
  assert.strictEqual(validateHostContextEnvelope(engineeringFeedbackEnvelope).ok, true,
    '公共契约必须接收与manual source绑定的engineering_feedback');
  delete engineeringFeedbackEnvelope.manualContinuationSourceRunId;
  assert.strictEqual(validateHostContextEnvelope(engineeringFeedbackEnvelope).ok, false,
    'engineering_feedback没有source Run时必须拒绝');
  const manual = await store.createManualContinuationRun({
    threadId,
    context: manualContext,
    intent: 'single_entry',
    route: 'manual-continuation-test',
    sourceRunId: automatic.run.runId
  });
  assert.strictEqual(manual.manualContinuation, true);
  assert.strictEqual(manual.run.metadata.manualContinuationSourceRunId, automatic.run.runId);
  assert.strictEqual(manual.run.metadata.continuationRootRunId, sourceRun.runId);
  assert.strictEqual(manual.workflowResume.sourceStudentQuestion, sourceContext.question.text,
    '人工续跑必须恢复root Run的原始任务文本');
  assert.strictEqual(manual.workflowResume.execution.decision.phase, 'repair_in_progress');
  assert.strictEqual(manual.workflowResume.execution.decision.repairRound, 2);
  assert.deepStrictEqual(manual.workflowResume.execution.decision.allowedActions, ['repair']);
  assert.strictEqual(
    manual.workflowResume.execution.worker.candidate.content,
    'package ManualResume { part def Vehicle; }',
    '人工续跑必须直接继承现有Candidate，不能触发重新生成'
  );
  assert.strictEqual(manual.sourceResponse.directAnswer, automaticResponse.directAnswer,
    '人工续跑必须绑定lineage最新已持久化响应');
  assert.strictEqual(store.state.executionLineages.get(sourceRun.runId).automaticContinuationCount, 1,
    '人工续跑不得增加或重置自动续跑配额');

  const duplicate = await store.createManualContinuationRun({
    threadId,
    context: manualContext,
    intent: 'single_entry',
    route: 'manual-continuation-test',
    sourceRunId: automatic.run.runId
  });
  assert.strictEqual(duplicate.reused, true, '同一个requestId必须幂等复用人工续跑Run');
  assert.strictEqual(duplicate.run.runId, manual.run.runId);
  await assert.rejects(
    store.createManualContinuationRun({
      threadId,
      context: { ...manualContext, requestId: 'req_manual_continue_concurrent' },
      intent: 'single_entry',
      route: 'manual-continuation-test',
      sourceRunId: automatic.run.runId
    }),
    (error) => error.code === 'MANUAL_CONTINUATION_IN_PROGRESS',
    '同一lineage运行中的人工续跑必须拒绝并发重复点击'
  );

  await store.completeRun({
    runId: manual.run.runId,
    context: manualContext,
    response: {
      ...automaticResponse,
      responseId: 'resp_manual_continue_1',
      requestId: manualContext.requestId
    },
    providerMeta: eligibleProviderMeta()
  });
  const secondManualContext = {
    ...teacherContext('req_manual_continue_2'),
    manualContinuationSourceRunId: manual.run.runId
  };
  const secondManual = await store.createManualContinuationRun({
    threadId,
    context: secondManualContext,
    intent: 'single_entry',
    route: 'manual-continuation-test',
    sourceRunId: manual.run.runId
  });
  assert.notStrictEqual(secondManual.run.runId, manual.run.runId,
    '前一人工续跑结束后，新的显式用户动作可继续同一lineage');
  assert.strictEqual(store.state.executionLineages.get(sourceRun.runId).automaticContinuationCount, 1);
}

async function testManualContinuationOwnershipAndStaleInput(contractResponse) {
  const store = createMemoryConversationStore();
  const sourceContext = teacherContext('req_manual_owner_source');
  const { threadId } = await store.ensureThread(sourceContext, 'thread_manual_owner');
  const sourceRun = await store.createRun({
    threadId,
    context: sourceContext,
    intent: 'single_entry',
    route: 'manual-continuation-owner-test'
  });
  await store.appendExecutionCheckpoint({
    runId: sourceRun.runId,
    boundary: {
      phase: 'candidate_absent',
      ...deriveExecutionInputHashes(sourceContext)
    }
  });
  await store.completeRun({
    runId: sourceRun.runId,
    context: sourceContext,
    response: contractResponse,
    providerMeta: eligibleProviderMeta()
  });

  for (const [label, context, requestedThreadId] of [
    ['thread', teacherContext('req_manual_wrong_thread'), 'thread_other_owner_scope'],
    ['user', {
      ...teacherContext('req_manual_wrong_user'),
      tenant: { ...sourceContext.tenant, userId: 'another-user' }
    }, threadId]
  ]) {
    await assert.rejects(
      store.createManualContinuationRun({
        threadId: requestedThreadId,
        context,
        intent: 'single_entry',
        route: 'manual-continuation-owner-test',
        sourceRunId: sourceRun.runId
      }),
      (error) => error.code === 'MANUAL_CONTINUATION_UNAVAILABLE',
      `跨${label}人工续跑必须拒绝`
    );
  }

  const changedEditorContext = {
    ...teacherContext('req_manual_editor_changed'),
    manualContinuationSourceRunId: sourceRun.runId,
    editor: {
      ...sourceContext.editor,
      files: sourceContext.editor.files.map((file) => ({
        ...file,
        content: `${file.content}\npart def Changed;`
      }))
    }
  };
  const stale = await store.createManualContinuationRun({
    threadId,
    context: changedEditorContext,
    intent: 'single_entry',
    route: 'manual-continuation-owner-test',
    sourceRunId: sourceRun.runId
  });
  assert.deepStrictEqual(stale.workflowResume.execution.decision.staleReasons, ['editor_base_changed']);
  assert.deepStrictEqual(stale.workflowResume.execution.decision.allowedActions, ['replan_or_clarify']);

  const conflicting = JSON.parse(JSON.stringify(baseHostFixture));
  conflicting.requestId = 'req_manual_contract_conflict';
  conflicting.manualContinuationSourceRunId = sourceRun.runId;
  conflicting.automaticContinuationSourceRunId = sourceRun.runId;
  assert.strictEqual(validateHostContextEnvelope(conflicting).ok, false,
    'manual、automatic和clarification续跑入口必须互斥');
}

async function testPostgresManualContinuationOwnershipGate() {
  const statements = [];
  let released = false;
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push({ sql: normalized, params });
      if (/^select \* from teacher_runs where run_id/u.test(normalized)) return { rows: [] };
      return { rows: [] };
    },
    release() {
      released = true;
    }
  };
  const store = createPostgresConversationStore({
    pool: { connect: async () => client }
  });
  const context = teacherContext('req_manual_postgres_owner_gate');
  await assert.rejects(
    store.createManualContinuationRun({
      threadId: 'thread_manual_postgres_owner_gate',
      context,
      intent: 'single_entry',
      route: 'manual-continuation-postgres-test',
      sourceRunId: 'run_manual_postgres_source'
    }),
    (error) => error.code === 'MANUAL_CONTINUATION_UNAVAILABLE'
  );
  const ownershipSelect = statements.find((entry) => /thread_id = \$2 and tenant_id = \$3 and user_id = \$4/u.test(entry.sql));
  assert(ownershipSelect, 'Postgres人工续跑必须在同一条锁查询中校验thread、tenant和user归属');
  assert.deepStrictEqual(ownershipSelect.params, [
    'run_manual_postgres_source',
    'thread_manual_postgres_owner_gate',
    context.tenant.tenantId,
    context.tenant.userId
  ]);
  assert(statements.some((entry) => entry.sql === 'rollback'),
    'Postgres人工续跑归属失败必须回滚事务');
  assert.strictEqual(released, true, 'Postgres人工续跑必须释放连接');
}

async function assertAutomaticContinuationStale(reason, changeContext) {
  const store = createMemoryConversationStore();
  const context = teacherContext(`req_stale_source_${reason}`);
  const { threadId } = await store.ensureThread(context, `thread_stale_${reason}`);
  const sourceRun = await store.createRun({
    threadId,
    context,
    intent: 'single_entry',
    route: 'automatic-continuation-stale-test'
  });
  await store.appendExecutionCheckpoint({
    runId: sourceRun.runId,
    boundary: {
      phase: 'candidate_absent',
      ...deriveExecutionInputHashes(context)
    }
  });
  await store.completeRun({
    runId: sourceRun.runId,
    context,
    response: {
      contractVersion: '1.1',
      responseId: `resp_${reason}`,
      requestId: context.requestId,
      answerType: 'agentic_answer',
      title: 'AI 教师',
      confidence: 'medium',
      directAnswer: '阶段性结果。',
      answerCompletionStatus: 'incomplete'
    },
    providerMeta: eligibleProviderMeta()
  });
  const continuationContext = changeContext(teacherContext(`req_stale_continue_${reason}`));
  const continuation = await store.createAutomaticContinuationRun({
    threadId,
    context: continuationContext,
    intent: 'single_entry',
    route: 'automatic-continuation-stale-test',
    sourceRunId: sourceRun.runId
  });
  assert.deepStrictEqual(continuation.workflowResume.execution.decision.staleReasons, [reason]);
  assert.deepStrictEqual(
    continuation.workflowResume.execution.decision.allowedActions,
    ['replan_or_clarify']
  );
}

function teacherContext(requestId) {
  return {
    contractVersion: '1.1',
    requestId,
    tenant: { tenantId: 'tenant-test', userId: 'user-test' },
    course: {
      coursePackId: 'pack-test',
      courseId: 'course-test',
      lessonId: 'lesson-test',
      courseRuleMode: 'lesson_after_official_pass',
      learningGoals: ['完成长任务']
    },
    courseContext: {
      authority: 'server-course-pack',
      todoItems: [{ id: 'todo-long-task', text: '完成长任务', required: true }]
    },
    editor: {
      language: 'sysmlv2',
      entryFile: 'main.sysml',
      activeFilePath: 'main.sysml',
      files: [{ path: 'main.sysml', content: 'package Base {}', editable: true }]
    },
    question: { text: '请完成一个长任务。', intent: 'modeling_task', revision: 'student-revision-1' }
  };
}

function eligibleProviderMeta() {
  return {
    agent: {
      stopReason: 'timeout',
      stopCause: 'work_deadline_reached',
      answerCompletionStatus: 'incomplete',
      fastGatePassThroughV2: { gateOutcome: 'pass', gateDecisionStatus: 'completed' }
    }
  };
}

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
