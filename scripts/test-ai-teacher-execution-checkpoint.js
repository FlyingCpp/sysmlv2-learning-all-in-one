'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  createMemoryConversationStore,
  createPostgresConversationStore,
  migrateTeacherConversationStore
} = require('../apps/teacher/conversation-store');
const {
  deriveExecutionInputHashes
} = require('../apps/teacher/execution-checkpoint');

async function main() {
  await testProvisionalCandidateValidationBinding();
  await testMemoryRecoveryMatrixAndLineage();
  await testClarificationResumeUsesCurrentInputHashes();
  await testMigrationSqlShape();
  await testStablePostgresRepositoryError();
  console.log('ai teacher execution checkpoint tests passed');
}

async function testProvisionalCandidateValidationBinding() {
  const store = createMemoryConversationStore();
  const context = teacherContext('req_provisional_candidate_binding');
  const { threadId } = await store.ensureThread(context, 'thread_provisional_candidate_binding');
  const run = await store.createRun({
    threadId,
    context,
    intent: 'single_entry',
    route: 'provisional-candidate-binding-test'
  });
  const inputHashes = deriveExecutionInputHashes(context);
  const validationOptionsHash = hash('validator-options-provisional-binding');
  const realWorkspaceHash = hash('validator-computed-workspace');
  const candidateReady = await store.appendExecutionCheckpoint({
    runId: run.runId,
    boundary: {
      phase: 'candidate_ready',
      ...inputHashes,
      candidate: {
        payload: {
          mode: 'standalone_model',
          fileName: 'generated_architecture.sysml',
          content: 'part def Vehicle;'
        }
      }
    }
  });
  assert.strictEqual(
    candidateReady.candidateArtifact.candidateWorkspaceHash,
    candidateReady.candidateArtifact.artifactHash,
    'Validator执行前Candidate只能以内容Artifact hash作为provisional workspace binding'
  );

  const validationFailed = await store.appendExecutionCheckpoint({
    runId: run.runId,
    boundary: {
      phase: 'validation_failed',
      ...inputHashes,
      candidateArtifactId: candidateReady.candidateArtifact.artifactId,
      validation: validationArtifactInput({
        candidateWorkspaceHash: realWorkspaceHash,
        validationOptionsHash,
        passed: false,
        diagnostic: 'missing interface usage'
      })
    }
  });
  assert.strictEqual(validationFailed.validationArtifact.candidateWorkspaceHash, realWorkspaceHash);
  assert.strictEqual(
    validationFailed.validationArtifact.candidateArtifactHash,
    candidateReady.candidateArtifact.artifactHash,
    'Validation Artifact必须由服务端绑定精确Candidate Artifact内容hash'
  );

  const secondCandidate = await store.appendExecutionCheckpoint({
    runId: run.runId,
    boundary: {
      phase: 'candidate_ready',
      ...inputHashes,
      candidate: {
        payload: {
          mode: 'standalone_model',
          fileName: 'generated_architecture.sysml',
          content: 'part def DifferentVehicle;'
        }
      }
    }
  });
  await assert.rejects(
    store.appendExecutionCheckpoint({
      runId: run.runId,
      boundary: {
        phase: 'validation_failed',
        ...inputHashes,
        candidateArtifactId: secondCandidate.candidateArtifact.artifactId,
        validationArtifactId: validationFailed.validationArtifact.artifactId
      }
    }),
    (error) => error.code === 'EXECUTION_VALIDATION_CANDIDATE_MISMATCH',
    '已绑定的Validation Artifact不得被另一个provisional Candidate引用'
  );
}

async function testClarificationResumeUsesCurrentInputHashes() {
  const sameInput = await createClarificationResumeScenario('same', (context) => context);
  assert.strictEqual(sameInput.workflowResume.execution.decision.stale, false,
    '澄清恢复仅requestId变化时必须复用Checkpoint');

  const editorChanged = await createClarificationResumeScenario('editor', (context) => ({
    ...context,
    editor: {
      ...context.editor,
      files: context.editor.files.map((file) => ({ ...file, content: `${file.content}\npart def Changed;` }))
    }
  }));
  assert.deepStrictEqual(
    editorChanged.workflowResume.execution.decision.staleReasons,
    ['editor_base_changed']
  );
  assert.deepStrictEqual(
    editorChanged.workflowResume.execution.decision.allowedActions,
    ['replan_or_clarify']
  );
}

async function createClarificationResumeScenario(suffix, changeContext) {
  const store = createMemoryConversationStore();
  const sourceContext = teacherContext(`req_clarification_source_${suffix}`);
  const { threadId } = await store.ensureThread(sourceContext, `thread_clarification_${suffix}`);
  const sourceRun = await store.createRun({
    threadId,
    context: sourceContext,
    intent: 'single_entry',
    route: 'clarification-hash-test'
  });
  await store.appendExecutionCheckpoint({
    runId: sourceRun.runId,
    boundary: {
      phase: 'candidate_absent',
      ...deriveExecutionInputHashes(sourceContext)
    }
  });
  const checkpoint = {
    checkpointId: `clar_execution_${suffix}_12345678`,
    acceptedToolCallId: `clarification-call-${suffix}`,
    question: '请确认模型范围。',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  await store.pauseRunForClarification({
    runId: sourceRun.runId,
    context: sourceContext,
    response: {
      contractVersion: '1.1',
      responseId: `resp_clarification_${suffix}`,
      requestId: sourceContext.requestId,
      answerType: 'clarification',
      title: 'AI 教师',
      confidence: 'medium',
      directAnswer: checkpoint.question
    },
    providerMeta: eligibleProviderMeta(),
    checkpoint
  });
  const resumedContext = changeContext({
    ...teacherContext(`req_clarification_resume_${suffix}`),
    clarificationCheckpointId: checkpoint.checkpointId
  });
  return store.createResumedRun({
    threadId,
    context: resumedContext,
    intent: 'single_entry',
    route: 'clarification-hash-test',
    checkpointId: checkpoint.checkpointId
  });
}

async function testMemoryRecoveryMatrixAndLineage() {
  const store = createMemoryConversationStore();
  const context = teacherContext('req_execution_source');
  const { threadId } = await store.ensureThread(context, 'thread_execution_checkpoint');
  const sourceRun = await store.createRun({
    threadId,
    context,
    intent: 'single_entry',
    route: 'execution-checkpoint-test'
  });
  sourceRun.metadata = {};
  store.state.executionLineages.delete(sourceRun.runId);
  const inputHashes = deriveExecutionInputHashes(context);
  const candidateWorkspaceHash1 = hash('candidate-workspace-1');
  const validationOptionsHash = hash('validator-options-strict');

  const candidateAbsent = await store.appendExecutionCheckpoint({
    runId: sourceRun.runId,
    boundary: { phase: 'candidate_absent', ...inputHashes }
  });
  assert.strictEqual(candidateAbsent.checkpoint.revision, 1);
  assert.deepStrictEqual(candidateAbsent.execution.decision.allowedActions, ['candidate']);
  assert.strictEqual(store.state.executionLineages.get(sourceRun.runId)?.rootRunId, sourceRun.runId,
    '缺少新metadata和lineage行的旧Run必须按自身惰性回填root lineage');

  const candidateReady = await store.appendExecutionCheckpoint({
    runId: sourceRun.runId,
    boundary: {
      phase: 'candidate_ready',
      ...inputHashes,
      candidate: {
        candidateWorkspaceHash: candidateWorkspaceHash1,
        payload: {
          workspace: {
            files: [{ path: 'model.sysml', content: 'part def Vehicle;' }]
          }
        }
      },
      metadata: {
        allowedActions: ['publish_without_validation'],
        workerNote: 'candidate persisted'
      }
    }
  });
  assert.strictEqual(candidateReady.checkpoint.revision, 2);
  assert.deepStrictEqual(candidateReady.execution.decision.allowedActions, ['validator']);
  assert.strictEqual(candidateReady.checkpoint.metadata.allowedActions, undefined,
    'allowedActions必须由服务端根据phase派生');
  assert.strictEqual(candidateReady.candidateArtifact.payload.workspace.files[0].content, 'part def Vehicle;');
  assert.strictEqual(candidateReady.checkpoint.candidateArtifactId, candidateReady.candidateArtifact.artifactId);

  const artifactCountBeforeRejectedAppend = store.state.executionArtifacts.size;
  await assert.rejects(
    store.appendExecutionCheckpoint({
      runId: sourceRun.runId,
      boundary: {
        phase: 'validation_failed',
        ...inputHashes,
        candidateArtifactId: candidateReady.candidateArtifact.artifactId,
        validation: validationArtifactInput({
          candidateWorkspaceHash: hash('wrong-candidate-workspace'),
          validationOptionsHash,
          passed: false,
          diagnostic: 'must be rolled back'
        })
      }
    }),
    (error) => error.code === 'EXECUTION_VALIDATION_CANDIDATE_MISMATCH'
  );
  assert.strictEqual(store.state.executionArtifacts.size, artifactCountBeforeRejectedAppend,
    'Memory Repository失败写入不得遗留孤儿Artifact');
  assert.strictEqual(store.state.executionLineages.get(sourceRun.runId).nextCheckpointRevision, 3,
    'Memory Repository失败写入不得消耗append-only revision');

  const validationPending = await store.appendExecutionCheckpoint({
    runId: sourceRun.runId,
    boundary: {
      phase: 'validation_pending',
      ...inputHashes,
      candidateArtifactId: candidateReady.candidateArtifact.artifactId,
      validatorVersion: 'official-validator-2026.08',
      rulesetVersion: 'course-rules-2026.08',
      validationOptionsHash
    }
  });
  assert.strictEqual(validationPending.checkpoint.revision, 3);
  assert.deepStrictEqual(validationPending.execution.decision.allowedActions, ['resolve_validation', 'validator']);
  assert.deepStrictEqual({
    validatorVersion: validationPending.execution.decision.validatorVersion,
    rulesetVersion: validationPending.execution.decision.rulesetVersion,
    validationOptionsHash: validationPending.execution.decision.validationOptionsHash
  }, {
    validatorVersion: 'official-validator-2026.08',
    rulesetVersion: 'course-rules-2026.08',
    validationOptionsHash
  }, 'validation_pending必须投影只读Validator复用元数据');

  const failedValidation = await store.appendExecutionCheckpoint({
    runId: sourceRun.runId,
    boundary: {
      phase: 'validation_failed',
      ...inputHashes,
      candidateArtifactId: candidateReady.candidateArtifact.artifactId,
      validation: validationArtifactInput({
        candidateWorkspaceHash: candidateWorkspaceHash1,
        validationOptionsHash,
        passed: false,
        diagnostic: 'missing interface usage'
      }),
      repairRound: 0,
      repairState: { targetDiagnostics: ['missing interface usage'] }
    }
  });
  assert.strictEqual(failedValidation.checkpoint.revision, 4);
  assert.deepStrictEqual(failedValidation.execution.decision.allowedActions, ['repair']);
  assert.strictEqual(failedValidation.execution.worker.validation.passed, false);

  const storedCheckpoints = store.state.executionCheckpoints.get(sourceRun.runId);
  assert.strictEqual(storedCheckpoints.length, 4);
  assert.strictEqual(JSON.stringify(storedCheckpoints).includes('part def Vehicle'), false,
    'checkpoint只能保存Artifact引用，不能内嵌Candidate payload');
  assert.strictEqual(JSON.stringify(storedCheckpoints).includes('"passed":false'), false,
    'checkpoint只能保存Artifact引用，不能内嵌Validator payload');

  await store.completeRun({
    runId: sourceRun.runId,
    context,
    response: incompleteResponse(context.requestId, sourceRun.runId),
    providerMeta: eligibleProviderMeta()
  });
  const continuationContext = teacherContext('req_execution_source:auto-1');
  const continuation = await store.createAutomaticContinuationRun({
    threadId,
    context: continuationContext,
    intent: 'single_entry',
    route: 'execution-checkpoint-test',
    sourceRunId: sourceRun.runId
  });
  assert.strictEqual(continuation.workflowResume.execution.revision, 4);
  assert.deepStrictEqual(continuation.workflowResume.execution.decision.allowedActions, ['repair']);
  assert.strictEqual(continuation.workflowResume.execution.persistedAnswer, undefined,
    '未到completed阶段不得投影历史assistant回答');
  assert.strictEqual(
    continuation.workflowResume.execution.worker.candidate.workspace.files[0].content,
    'part def Vehicle;',
    'Worker恢复投影必须包含Candidate资产'
  );
  assert.strictEqual(
    continuation.workflowResume.execution.worker.validation.diagnostic,
    'missing interface usage',
    'Worker恢复投影必须包含Validator资产'
  );
  assert.deepStrictEqual(
    continuation.workflowResume.execution.worker.repairState.targetDiagnostics,
    ['missing interface usage'],
    '多轮Repair必须恢复上一轮的问题点状态'
  );
  const lineage = store.state.executionLineages.get(sourceRun.runId);
  assert.strictEqual(lineage.automaticContinuationCount, 1);
  assert.strictEqual(lineage.automaticContinuationRunId, continuation.run.runId);
  assert.strictEqual(continuation.run.metadata.continuationRootRunId, sourceRun.runId);

  const repairInProgress = await store.appendExecutionCheckpoint({
    runId: continuation.run.runId,
    boundary: {
      phase: 'repair_in_progress',
      ...inputHashes,
      candidateArtifactId: candidateReady.candidateArtifact.artifactId,
      validationArtifactId: failedValidation.validationArtifact.artifactId,
      repairRound: 1,
      repairState: { targetDiagnostics: ['missing interface usage'] }
    }
  });
  assert.strictEqual(repairInProgress.checkpoint.revision, 5,
    '跨Run续跑必须沿root lineage递增revision');
  assert.deepStrictEqual(repairInProgress.execution.decision.allowedActions, ['repair']);

  const candidateWorkspaceHash2 = hash('candidate-workspace-2');
  const repairedCandidate = await store.appendExecutionCheckpoint({
    runId: continuation.run.runId,
    boundary: {
      phase: 'candidate_ready',
      ...inputHashes,
      candidate: {
        candidateWorkspaceHash: candidateWorkspaceHash2,
        payload: {
          workspace: {
            files: [{ path: 'model.sysml', content: 'interface def VehicleBus;' }]
          }
        }
      },
      repairRound: 1
    }
  });
  assert.strictEqual(repairedCandidate.checkpoint.revision, 6);

  await store.appendExecutionCheckpoint({
    runId: continuation.run.runId,
    boundary: {
      phase: 'validation_pending',
      ...inputHashes,
      candidateArtifactId: repairedCandidate.candidateArtifact.artifactId,
      validatorVersion: 'official-validator-2026.08',
      rulesetVersion: 'course-rules-2026.08',
      validationOptionsHash,
      repairRound: 1
    }
  });
  const passedValidation = await store.appendExecutionCheckpoint({
    runId: continuation.run.runId,
    boundary: {
      phase: 'validated_passed',
      ...inputHashes,
      candidateArtifactId: repairedCandidate.candidateArtifact.artifactId,
      validation: validationArtifactInput({
        candidateWorkspaceHash: candidateWorkspaceHash2,
        validationOptionsHash,
        passed: true,
        diagnostic: ''
      }),
      repairRound: 1
    }
  });
  assert.strictEqual(passedValidation.checkpoint.revision, 8);
  assert.deepStrictEqual(passedValidation.execution.decision.allowedActions, ['replan_or_clarify'],
    'Validator PASS仍必须回到Main复核，不能在恢复时直接进入Finalizer');

  const finalizationPending = await store.appendExecutionCheckpoint({
    runId: continuation.run.runId,
    boundary: {
      phase: 'finalization_pending',
      ...inputHashes,
      candidateArtifactId: repairedCandidate.candidateArtifact.artifactId,
      validationArtifactId: passedValidation.validationArtifact.artifactId,
      repairRound: 1
    }
  });
  assert.strictEqual(finalizationPending.checkpoint.revision, 9);
  assert.deepStrictEqual(finalizationPending.execution.decision.allowedActions, ['finalizer']);

  const completed = await store.appendExecutionCheckpoint({
    runId: continuation.run.runId,
    boundary: {
      phase: 'completed',
      ...inputHashes,
      candidateArtifactId: repairedCandidate.candidateArtifact.artifactId,
      validationArtifactId: passedValidation.validationArtifact.artifactId,
      repairRound: 1
    }
  });
  assert.strictEqual(completed.checkpoint.revision, 10);
  assert.deepStrictEqual(completed.execution.decision.allowedActions, ['return_persisted']);
  assert.strictEqual(completed.checkpoint.validatorVersion, 'official-validator-2026.08',
    '仅引用Validation Artifact时也必须恢复Validator复用元数据');

  const finalDirectAnswer = '最终模型已经通过验证。' + '终'.repeat(70_000);
  await store.completeRun({
    runId: continuation.run.runId,
    context: continuationContext,
    response: {
      contractVersion: '1.1',
      responseId: 'resp_execution_completed',
      requestId: continuationContext.requestId,
      answerType: 'agentic_answer',
      title: 'AI 教师',
      confidence: 'high',
      directAnswer: finalDirectAnswer,
      internal: { reasoning: 'must never enter persistedAnswer' }
    },
    providerMeta: { agent: { answerCompletionStatus: 'complete' } }
  });

  const latestFromRoot = await store.loadLatestExecutionCheckpoint(sourceRun.runId, {
    currentHashes: inputHashes
  });
  const latestFromContinuation = await store.loadLatestExecutionCheckpoint(continuation.run.runId, {
    currentHashes: inputHashes
  });
  assert.strictEqual(latestFromRoot.checkpoint.checkpointId, latestFromContinuation.checkpoint.checkpointId);
  assert.strictEqual(latestFromRoot.execution.worker.candidate.workspace.files[0].content,
    'interface def VehicleBus;');
  assert.strictEqual(typeof latestFromRoot.execution.persistedAnswer, 'string');
  assert.strictEqual(Buffer.byteLength(latestFromRoot.execution.persistedAnswer, 'utf8') <= 200_000, true,
    'persistedAnswer必须按UTF-8字节数限制在200k内');
  assert.strictEqual(latestFromRoot.execution.persistedAnswer.startsWith('最终模型已经通过验证。'), true);
  assert.strictEqual(JSON.stringify(latestFromRoot.execution.persistedAnswer).includes('reasoning'), false,
    'persistedAnswer不得包含内部响应payload');
  assert.deepStrictEqual({
    validatorVersion: latestFromRoot.execution.decision.validatorVersion,
    rulesetVersion: latestFromRoot.execution.decision.rulesetVersion,
    validationOptionsHash: latestFromRoot.execution.decision.validationOptionsHash
  }, {
    validatorVersion: 'official-validator-2026.08',
    rulesetVersion: 'course-rules-2026.08',
    validationOptionsHash
  });

  const changedValidationIdentity = await store.loadLatestExecutionCheckpoint(continuation.run.runId, {
    currentHashes: {
      ...inputHashes,
      validatorVersion: 'official-validator-2026.08',
      rulesetVersion: 'course-rules-2026.09',
      validationOptionsHash
    }
  });
  assert.strictEqual(changedValidationIdentity.execution.decision.phase, 'candidate_ready',
    'Validator或规则身份变化时必须保留Candidate并回到待验证状态');
  assert.deepStrictEqual(changedValidationIdentity.execution.decision.allowedActions, ['validator']);
  assert.strictEqual(changedValidationIdentity.execution.decision.validationArtifactId, undefined,
    'Validator或规则身份变化时不得投影旧Validation Artifact');
  assert.strictEqual(changedValidationIdentity.execution.worker.validation, undefined,
    'Validator或规则身份变化时Worker不得读取旧PASS');
  assert.strictEqual(changedValidationIdentity.execution.persistedAnswer, undefined,
    'Validator或规则身份变化时不得零LLM返回旧答案');

  const sameInputHashes = deriveExecutionInputHashes({ ...context, requestId: 'req_transport_retry_only' });
  assert.deepStrictEqual(sameInputHashes, inputHashes,
    'requestId变化不是学生问题revision变化，不得使Checkpoint失效');
  const historyAndReasoningIgnored = deriveExecutionInputHashes({
    ...context,
    reasoning: 'internal reasoning must be ignored',
    history: [{ role: 'assistant', content: 'old answer must be ignored' }],
    messages: [{ role: 'assistant', content: 'another old answer' }],
    diagnostics: { officialValidator: [{ message: 'transient diagnostic' }] },
    editor: {
      ...context.editor,
      activeFilePath: 'another-view.sysml',
      cursor: { line: 99, column: 4 },
      selection: { text: 'transient selection' }
    }
  });
  assert.deepStrictEqual(historyAndReasoningIgnored, inputHashes,
    'reasoning、历史assistant文本、诊断和编辑器焦点不得进入续跑输入指纹');
  const questionChanged = await store.loadLatestExecutionCheckpoint(continuation.run.runId, {
    currentHashes: deriveExecutionInputHashes({
      ...context,
      question: { ...context.question, text: '请改为构建飞行器模型。' }
    })
  });
  assert.deepStrictEqual(questionChanged.execution.decision.staleReasons, ['request_revision_changed']);
  assert.deepStrictEqual(questionChanged.execution.decision.allowedActions, ['replan_or_clarify']);
  assert.strictEqual(questionChanged.execution.persistedAnswer, undefined,
    '输入已变化时不得零LLM返回旧的persistedAnswer');
  const taskChanged = await store.loadLatestExecutionCheckpoint(continuation.run.runId, {
    currentHashes: deriveExecutionInputHashes({
      ...context,
      course: { ...context.course, lessonId: 'lesson-test-revision-2' }
    })
  });
  assert.deepStrictEqual(taskChanged.execution.decision.staleReasons, ['task_contract_changed']);
  assert.deepStrictEqual(taskChanged.execution.decision.allowedActions, ['replan_or_clarify']);
  const editorChanged = await store.loadLatestExecutionCheckpoint(continuation.run.runId, {
    currentHashes: deriveExecutionInputHashes({
      ...context,
      editor: {
        ...context.editor,
        files: context.editor.files.map((file) => ({ ...file, content: `${file.content}\npart def Changed;` }))
      }
    })
  });
  assert.deepStrictEqual(editorChanged.execution.decision.staleReasons, ['editor_base_changed']);
  assert.deepStrictEqual(editorChanged.execution.decision.allowedActions, ['replan_or_clarify']);

  const timeline = await store.listExecutionCheckpointTimeline(sourceRun.runId, { limit: 20 });
  assert.deepStrictEqual(timeline.map((entry) => entry.checkpoint.revision), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepStrictEqual(timeline.map((entry) => entry.checkpoint.phase), [
    'candidate_absent',
    'candidate_ready',
    'validation_pending',
    'validation_failed',
    'repair_in_progress',
    'candidate_ready',
    'validation_pending',
    'validated_passed',
    'finalization_pending',
    'completed'
  ]);

  const reusable = await store.findReusableValidationArtifact({
    runId: continuation.run.runId,
    candidateWorkspaceHash: candidateWorkspaceHash2,
    validatorVersion: 'official-validator-2026.08',
    rulesetVersion: 'course-rules-2026.08',
    validationOptionsHash
  });
  assert.strictEqual(reusable.artifactId, passedValidation.validationArtifact.artifactId);
  const changedRules = await store.findReusableValidationArtifact({
    runId: continuation.run.runId,
    candidateWorkspaceHash: candidateWorkspaceHash2,
    validatorVersion: 'official-validator-2026.08',
    rulesetVersion: 'course-rules-2026.09',
    validationOptionsHash
  });
  assert.strictEqual(changedRules, null, 'Validator复用必须匹配完整复合键');

  const duplicateContinuation = await store.createAutomaticContinuationRun({
    threadId,
    context: continuationContext,
    intent: 'single_entry',
    route: 'execution-checkpoint-test',
    sourceRunId: sourceRun.runId
  });
  assert.strictEqual(duplicateContinuation.reused, true);
  assert.strictEqual(duplicateContinuation.run.runId, continuation.run.runId);
  assert.strictEqual(
    duplicateContinuation.workflowResume.execution.persistedAnswer.startsWith('最终模型已经通过验证。'),
    true,
    '幂等续跑读取completed Checkpoint时必须支持零LLM返回持久化答案'
  );
  const siblingRunId = 'run_legacy-resumed-sibling-0001';
  store.state.runs.set(siblingRunId, {
    runId: siblingRunId,
    threadId,
    requestId: 'req_legacy_sibling',
    tenantId: context.tenant.tenantId,
    userId: context.tenant.userId,
    status: 'succeeded',
    metadata: {
      sourceRunId: sourceRun.runId,
      continuationRootRunId: sourceRun.runId
    },
    providerMeta: eligibleProviderMeta(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await assert.rejects(
    store.createAutomaticContinuationRun({
      threadId,
      context: teacherContext('req_execution_sibling_auto'),
      intent: 'single_entry',
      route: 'execution-checkpoint-test',
      sourceRunId: siblingRunId
    }),
    (error) => error.code === 'AUTOMATIC_CONTINUATION_LIMIT_REACHED',
    '同一root lineage的其他Run不得复用或创建第二次自动续跑'
  );
  await assert.rejects(
    store.createAutomaticContinuationRun({
      threadId,
      context: teacherContext('req_execution_illegal_auto_2'),
      intent: 'single_entry',
      route: 'execution-checkpoint-test',
      sourceRunId: continuation.run.runId
    }),
    (error) => error.code === 'AUTOMATIC_CONTINUATION_UNAVAILABLE'
  );

  await assert.rejects(
    store.appendExecutionCheckpoint({
      runId: continuation.run.runId,
      boundary: { phase: 'candidate_absent' }
    }),
    (error) => error.code === 'EXECUTION_CHECKPOINT_INPUT_HASHES_REQUIRED',
    'Repository必须用稳定错误拒绝缺少三个输入hash的checkpoint'
  );
}

async function testMigrationSqlShape() {
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(String(sql));
      return { rows: [] };
    }
  };
  await migrateTeacherConversationStore({ pool });
  const sql = statements.join('\n').replace(/\s+/g, ' ').toLowerCase();
  assert.match(sql, /create table if not exists teacher_execution_lineages/);
  assert.match(sql, /create table if not exists teacher_execution_artifacts/);
  assert.match(sql, /create table if not exists teacher_execution_checkpoints/);
  assert.match(sql, /automatic_continuation_count between 0 and 1/);
  assert.match(sql, /unique \(root_run_id, artifact_kind, artifact_hash\)/);
  assert.match(sql, /unique \(root_run_id, revision\)/);
  assert.match(sql, /teacher_execution_validation_reuse_idx/);
  assert.match(sql, /candidate_artifact_hash/);
  assert.match(sql, /candidate_workspace_hash/);
  assert.match(sql, /validation_options_hash/);
  assert.match(sql, /alter table teacher_execution_checkpoints add column if not exists request_revision_hash/);
}

async function testStablePostgresRepositoryError() {
  const store = createPostgresConversationStore({
    pool: {
      async connect() {
        throw new Error('raw connection detail must not cross repository boundary');
      }
    }
  });
  await assert.rejects(
    store.loadLatestExecutionCheckpoint('run_12345678'),
    (error) => error.code === 'EXECUTION_CHECKPOINT_LOAD_FAILED'
      && error.message === 'Execution checkpoint repository operation failed.'
      && !JSON.stringify(error).includes('raw connection detail')
  );
}

function validationArtifactInput({ candidateWorkspaceHash, validationOptionsHash, passed, diagnostic }) {
  return {
    candidateWorkspaceHash,
    validatorVersion: 'official-validator-2026.08',
    rulesetVersion: 'course-rules-2026.08',
    validationOptionsHash,
    payload: {
      passed,
      diagnostic,
      validator: { version: 'official-validator-2026.08' }
    }
  };
}

function teacherContext(requestId) {
  return {
    contractVersion: '1.1',
    requestId,
    tenant: { tenantId: 'tenant-execution-test', userId: 'user-execution-test' },
    course: {
      coursePackId: 'pack-test',
      courseId: 'course-test',
      lessonId: 'lesson-test',
      courseRuleMode: 'lesson_after_official_pass',
      learningGoals: ['构建并验证SysML v2模型']
    },
    courseContext: {
      authority: 'server-course-pack',
      todoItems: [{ id: 'todo-model', text: '完成模型并通过验证', required: true }]
    },
    editor: {
      language: 'sysmlv2',
      entryFile: 'main.sysml',
      activeFilePath: 'main.sysml',
      files: [{ path: 'main.sysml', content: 'package Base {}', editable: true }]
    },
    question: {
      text: '请构建并验证一个SysML v2模型。',
      intent: 'modeling_task',
      revision: 'student-revision-1'
    }
  };
}

function incompleteResponse(requestId, sourceRunId) {
  return {
    contractVersion: '1.1',
    responseId: `resp_${requestId}`,
    requestId,
    answerType: 'agentic_answer',
    title: 'AI 教师',
    confidence: 'medium',
    directAnswer: '候选模型已生成，验证后需要继续修复。',
    answerCompletionStatus: 'incomplete',
    continuation: {
      status: 'user_confirmation_required',
      sourceRunId,
      autoContinuationUsed: true,
      canContinue: true,
      completedItems: [],
      remainingItems: []
    }
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
