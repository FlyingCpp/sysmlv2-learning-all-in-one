'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function request(runId, question = '生成一个最小车辆模型。', taskSources = [], conversationMessages = [{ role: 'user', content: question }]) {
  return {
    runId,
    question,
    currentStudentQuestion: question,
    conversationMessages,
    taskSources,
    capabilityGrant: ['search_reviewed_knowledge', 'validate_candidate_workspace'],
    context: {
      tenantId: 'tenant-slice-c',
      userId: 'user-slice-c',
      threadId: 'thread-slice-c',
      lesson: {
        courseId: 'course-slice-c',
        lessonId: 'lesson-slice-c',
        title: 'Slice C',
        objectives: [],
        taskHints: []
      },
      model: {
        files: [{
          fileId: 'file-slice-c',
          displayName: 'model.sysml',
          content: 'package Demo {}',
          contentHash: hash('package Demo {}'),
          editable: true
        }],
        entryFileId: 'file-slice-c',
        activeFileId: 'file-slice-c',
        diagnostics: []
      }
    }
  };
}

function passedCandidate(view) {
  const content = 'package Demo { part def Vehicle; }';
  return Object.freeze({
    version: 'worker-result-v2',
    runId: view.runId,
    taskId: view.taskId,
    taskRevision: view.taskRevision,
    workerType: 'candidate',
    mode: view.mode,
    status: 'validated_passed',
    candidate: Object.freeze({
      mode: 'replace_entry', fileId: view.target.fileId, baseHash: view.target.baseHash, content
    }),
    validation: Object.freeze({
      validator: { authority: 'official-sysml-v2-validator', version: 'test', evidenceHash: hash('validator evidence') },
      official: { syntax: 'passed', semantic: 'passed', diagnostics: [] },
      courseRuleApplicability: 'not_applicable',
      completeness: 'complete',
      candidateWorkspaceHash: hash(`${view.model.files[0].displayName}\n${hash(content)}`),
      patches: []
    }),
    attemptCount: 1
  });
}

async function main() {
  const runtime = await import('../apps/teacher/dist/agent/index.mjs');

  for (const fileName of [
    'worker-contracts.mts',
    'worker-dispatcher.mts',
    'candidate-worker.mts',
    'repair-worker.mts'
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'apps', 'teacher', 'agent', fileName), 'utf8');
    assert(!/\bRequestPlan\b|runTeacherAgent\s*\(/u.test(source), `${fileName}不得依赖旧主流程`);
  }
  const productionHandlersSource = fs.readFileSync(
    path.join(__dirname, '..', 'apps', 'teacher', 'agent', 'production-worker-handlers.mts'),
    'utf8'
  );
  const candidateAdmissionIndex = productionHandlersSource.indexOf(
    'input.resources.assertAdmitted("candidate_validate");'
  );
  const validationStartedIndex = productionHandlersSource.indexOf(
    'markValidationStarted(input.resources, input.task.taskId);'
  );
  assert(candidateAdmissionIndex >= 0 && validationStartedIndex > candidateAdmissionIndex,
    'candidate_validate必须先通过阶段准入，再把Task迁移为validation_started');

  const orchestratorSource = fs.readFileSync(
    path.join(__dirname, '..', 'apps', 'teacher', 'agent', 'intent-orchestrator-v2.mts'),
    'utf8'
  );
  const readToolWrapper = orchestratorSource.slice(
    orchestratorSource.indexOf('function createDegradingReadOnlyTool'),
    orchestratorSource.indexOf('function recordVisibleEvidenceReferences')
  );
  assert(!/AbortSignal\.timeout|safeParse\(|awaitWithAbort/u.test(readToolWrapper),
    'Main只读Tool包装器不得重新实现AI SDK已提供的Tool计时或输入解析');
  assert.match(readToolWrapper, /toModelOutput/u,
    'Main只读Tool必须通过AI SDK toModelOutput提供有界模型视图');

  const runResourcesSource = fs.readFileSync(
    path.join(__dirname, '..', 'apps', 'teacher', 'agent', 'run-resources.mts'),
    'utf8'
  );
  assert(!/project_safe_terminal|persist_terminal/u.test(runResourcesSource),
    '确定性安全投影和终态持久化不得伪装为Run业务Action');

  const candidateTaskSources = [
    {
      sourceId: 'source-dispatch-root',
      relation: 'root_user_request',
      text: '由发动机和电源组成',
      sourceHash: hash('由发动机和电源组成'),
      taskAuthorizationRevisionHash: hash('dispatch-candidate-task-sources')
    },
    {
      sourceId: 'source-dispatch-scope',
      relation: 'clarification_user_answer',
      text: '暂时不考虑接口等',
      sourceHash: hash('暂时不考虑接口等'),
      taskAuthorizationRevisionHash: hash('dispatch-candidate-task-sources')
    }
  ];
  const parsed = runtime.agentRunRequestSchema.parse(request(
    'run_slice_c_dispatch_candidate',
    '动力与供电系统，就按这个来',
    candidateTaskSources,
    [
      { role: 'user', content: '由发动机和电源组成' },
      { role: 'assistant', content: '请补充建模范围。' },
      { role: 'user', content: '动力与供电系统，就按这个来' }
    ]
  ));
  const resources = runtime.createRunResources({
    request: parsed,
    policy: runtime.DEFAULT_AGENT_POLICY,
    deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
  });
  assert(Object.isFrozen(resources.input));
  assert(Object.isFrozen(resources.input.model));
  assert(Object.isFrozen(resources.input.model.files));
  assert(Object.isFrozen(resources.input.taskSources));
  assert(resources.input.taskSources.every(Object.isFrozen));
  assert.deepEqual(resources.input.conversationMessages, parsed.conversationMessages);
  assert.equal(resources.input.questionHash, hash(JSON.stringify(parsed.currentStudentQuestion)));
  assert.match(resources.input.authorizationScopeRef, /^sha256:[a-f0-9]{64}$/u);
  await resources.ledger.recordObservation({
    toolCallId: 'inspect-lesson-before-dispatch',
    toolName: 'inspect_lesson_context',
    input: { includeObjectives: true, detail: 'full' },
    output: {
      courseId: parsed.context.lesson.courseId,
      lessonId: parsed.context.lesson.lessonId,
      title: parsed.context.lesson.title,
      objectives: [],
      taskHints: [],
      courseRules: [{
        id: 'course-vehicle', type: 'elementExists', severity: 'error',
        message: '课程期望包含Vehicle。', selector: { kind: 'partDef', name: 'Vehicle' }
      }],
      referenceModel: {
        entryFile: 'model.sysml',
        files: [{
          displayName: 'model.sysml', content: 'package Demo {}',
          contentHash: hash('package Demo {}'), editable: true
        }]
      }
    }
  });

  const delegated = resources.tasks.materialize({
    questionHash: resources.input.questionHash,
    outcome: {
      type: 'delegate_candidate',
      mode: 'create',
      subject: 'current_workspace',
      acceptedToolCallId: 'delegate-candidate-slice-c'
    },
    context: parsed.context
  });
  let receivedCandidateView;
  const outcome = await runtime.dispatchWorker({
    resources,
    taskId: delegated.taskId,
    expectedRevision: delegated.revision,
    abortSignal: new AbortController().signal,
    workers: {
      candidate: async (view) => {
        receivedCandidateView = view;
        assert.equal(view.workerType, 'candidate');
        assert.equal(view.mode, 'create');
        assert.equal(view.question, parsed.currentStudentQuestion);
        assert(Object.is(view.conversationMessages, resources.input.conversationMessages));
        assert(Object.is(view.taskSources, resources.input.taskSources));
        assert.deepEqual(view.taskSources.map((source) => source.text), [
          '由发动机和电源组成',
          '暂时不考虑接口等'
        ]);
        assert.equal(view.courseContext.courseRules[0].id, 'course-vehicle');
        assert.equal(view.courseContext.referenceModel.entryFile, 'model.sysml');
        assert(Object.isFrozen(view));
        assert(!Object.hasOwn(view, 'action'));
        assert(!Object.hasOwn(view, 'mainAgentOutcome'));
        return passedCandidate(view);
      },
      repair: async () => { throw new Error('repair worker must not run'); }
    }
  });
  assert.equal(outcome.type, 'completed');
  assert.equal(outcome.result.status, 'validated_passed');
  assert.equal(resources.tasks.get(delegated.taskId).status, 'worker_completed');
  assert(!Object.hasOwn(resources.tasks.get(delegated.taskId), 'currentCandidateRef'));
  assert.equal(receivedCandidateView.taskRevision, 1, 'Worker必须读取worker_started后的Task revision');

  const previousContent = 'package PriorCandidate { part def Vehicle; part vehicle : Vehicle; }';
  const previousRequestRaw = request(
    'run_slice_c_previous_candidate',
    '继续修改你上一轮生成的代码。'
  );
  previousRequestRaw.context.conversationSubjects = {
    lastValidatedCandidate: {
      sourceRunId: 'run-prior-source',
      candidateWorkspaceHash: hash('prior-workspace'),
      fileId: 'prior-candidate-file',
      displayName: 'generated_architecture.sysml',
      content: previousContent,
      contentHash: hash(previousContent),
      currentWorkspaceMatches: false
    }
  };
  const previousRequest = runtime.agentRunRequestSchema.parse(previousRequestRaw);
  const previousResources = runtime.createRunResources({
    request: previousRequest,
    policy: runtime.DEFAULT_AGENT_POLICY,
    deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
  });
  const previousTask = previousResources.tasks.materialize({
    questionHash: previousResources.input.questionHash,
    outcome: {
      type: 'delegate_candidate',
      mode: 'refine',
      subject: 'previous_validated_candidate',
      acceptedToolCallId: 'delegate-prior-candidate'
    },
    context: previousRequest.context
  });
  assert.deepEqual(previousTask.target, {
    kind: 'standalone_model',
    fileName: 'generated_architecture.sysml'
  });
  const previousDispatch = await runtime.dispatchWorker({
    resources: previousResources,
    taskId: previousTask.taskId,
    expectedRevision: previousTask.revision,
    abortSignal: new AbortController().signal,
    workers: {
      candidate: async (view) => {
        assert.equal(view.subject, 'previous_validated_candidate');
        assert.equal(view.validatedCandidateBinding, undefined);
        assert.equal(view.model.files.length, 1);
        assert.equal(view.model.files[0].content, previousContent);
        assert(!JSON.stringify(view.model).includes('package Demo {}'),
          'Main绑定上一轮Candidate后，Worker不得再看到当前编辑器旧模型');
        return Object.freeze({
          version: 'worker-result-v2',
          runId: view.runId,
          taskId: view.taskId,
          taskRevision: view.taskRevision,
          workerType: 'candidate',
          mode: view.mode,
          status: 'worker_error',
          attemptCount: 0,
          reason: 'projection-only-test'
        });
      },
      repair: async () => { throw new Error('repair worker must not run'); }
    }
  });
  assert.equal(previousDispatch.type, 'completed');
  assert.equal(previousDispatch.result.reason, 'projection-only-test');

  const repeated = await runtime.dispatchWorker({
    resources,
    taskId: delegated.taskId,
    expectedRevision: delegated.revision,
    abortSignal: new AbortController().signal,
    workers: {
      candidate: async () => { throw new Error('must not run'); },
      repair: async () => { throw new Error('must not run'); }
    }
  });
  assert.deepEqual(repeated, { type: 'rejected', reason: 'task_revision_conflict' });

  const cancelledRequest = runtime.agentRunRequestSchema.parse(request('run_slice_c_cancelled'));
  const cancelledResources = runtime.createRunResources({
    request: cancelledRequest,
    policy: runtime.DEFAULT_AGENT_POLICY,
    deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
  });
  const cancelledTask = cancelledResources.tasks.materialize({
    questionHash: cancelledResources.input.questionHash,
    outcome: {
      type: 'delegate_candidate', mode: 'complete', subject: 'current_workspace', acceptedToolCallId: 'delegate-cancelled'
    },
    context: cancelledRequest.context
  });
  const cancelledController = new AbortController();
  cancelledController.abort(new Error('caller cancelled'));
  const cancelledDispatch = await runtime.dispatchWorker({
    resources: cancelledResources,
    taskId: cancelledTask.taskId,
    expectedRevision: cancelledTask.revision,
    abortSignal: cancelledController.signal,
    workers: {
      candidate: async () => { throw new Error('cancelled worker must not run'); },
      repair: async () => { throw new Error('cancelled worker must not run'); }
    }
  });
  assert.deepEqual(cancelledDispatch, { type: 'rejected', reason: 'cancelled' });
  assert.equal(cancelledResources.tasks.get(cancelledTask.taskId).status, 'delegated');

  const repairRequest = runtime.agentRunRequestSchema.parse(request(
    'run_slice_c_dispatch_repair',
    '修复当前模型。'
  ));
  const repairResources = runtime.createRunResources({
    request: repairRequest,
    policy: runtime.DEFAULT_AGENT_POLICY,
    deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
  });
  const repairTask = repairResources.tasks.materialize({
    questionHash: repairResources.input.questionHash,
    outcome: {
      type: 'delegate_repair',
      scope: 'active_file',
      acceptedToolCallId: 'delegate-repair-slice-c'
    },
    context: repairRequest.context
  });
  const repairOutcome = await runtime.dispatchWorker({
    resources: repairResources,
    taskId: repairTask.taskId,
    expectedRevision: repairTask.revision,
    abortSignal: new AbortController().signal,
    workers: {
      candidate: async () => { throw new Error('candidate worker must not run'); },
      repair: async (view) => Object.freeze({
        version: 'worker-result-v2',
        runId: view.runId,
        taskId: view.taskId,
        taskRevision: view.taskRevision,
        workerType: 'repair',
        scope: view.scope,
        status: 'validated_failed',
        attemptCount: 2,
        reason: 'validator_failed'
      })
    }
  });
  assert.equal(repairOutcome.type, 'completed');
  assert.equal(repairOutcome.result.workerType, 'repair');
  assert.equal(repairResources.tasks.get(repairTask.taskId).status, 'worker_failed');

  const wrongRequest = runtime.agentRunRequestSchema.parse(request('run_slice_c_wrong_result'));
  const wrongResources = runtime.createRunResources({
    request: wrongRequest,
    policy: runtime.DEFAULT_AGENT_POLICY,
    deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
  });
  const wrongTask = wrongResources.tasks.materialize({
    questionHash: wrongResources.input.questionHash,
    outcome: {
      type: 'delegate_candidate',
      mode: 'refine',
      subject: 'current_workspace',
      acceptedToolCallId: 'delegate-wrong-result'
    },
    context: wrongRequest.context
  });
  const wrongOutcome = await runtime.dispatchWorker({
    resources: wrongResources,
    taskId: wrongTask.taskId,
    expectedRevision: wrongTask.revision,
    abortSignal: new AbortController().signal,
    workers: {
      candidate: async (view) => ({ ...passedCandidate(view), taskId: 'task_from_other_run' }),
      repair: async () => { throw new Error('must not run'); }
    }
  });
  assert.equal(wrongOutcome.type, 'completed');
  assert.equal(wrongOutcome.result.status, 'worker_error');
  assert.match(wrongOutcome.result.reason, /not bound/u);
  assert.equal(wrongResources.tasks.get(wrongTask.taskId).status, 'worker_failed');

  console.log('teacher worker dispatcher tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
