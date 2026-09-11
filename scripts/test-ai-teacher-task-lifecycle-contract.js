'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  TaskLifecycleContractError,
  applyTaskLifecycleContractEvent,
  createTaskLifecycleContract,
  projectTaskLifecycleContract,
  taskLifecycleContractHash,
  validateTaskLifecycleContract
} = require('../packages/teacher-contract/task-lifecycle-contract');
const { createMemoryConversationStore } = require('../apps/teacher/conversation-store');
const { taskLifecycleServerForTests } = require('../apps/teacher/server');
const { loadTaskContractContextForAgentForTests } = require('../apps/teacher/agent-adapter');
const hostFixture = require('../packages/teacher-contract/fixtures/host-context-basic.json');

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function transition(contract, eventType, payload = {}) {
  return applyTaskLifecycleContractEvent(contract, {
    expectedRevision: contract.revision,
    eventType,
    payload,
    sourceRunId: 'run_task_contract_test',
    actor: { type: 'server' },
    createdAt: new Date(Date.parse(contract.updatedAt) + 1_000).toISOString()
  }).contract;
}

function candidateBinding() {
  return {
    candidateArtifactId: 'artifact_candidate_1',
    candidateWorkspaceHash: sha256('candidate'),
    validationArtifactId: 'artifact_validation_1',
    validatorStatus: 'validated_passed'
  };
}

async function main() {
  const created = createTaskLifecycleContract({
    contractId: 'task_contract_test',
    rootRunId: 'run_task_contract_test',
    threadId: 'thread_task_contract_test',
    tenantId: 'tenant_test',
    userId: 'user_test',
    rootUserRequest: '创建完整的月球探测器模型。',
    taskProfile: 'model_authoring',
    preservationConstraints: ['保留已经验证的模型正文'],
    createdAt: '2026-09-01T00:00:00.000Z'
  });
  assert.equal(created.status, 'provisional');
  assert.equal(created.revision, 0);
  assert.equal(created.goals.length, 1);
  assert.equal(created.goals[0].origin, 'root_user_request');
  assert.equal(created.snapshotHash, taskLifecycleContractHash(created));
  assert.equal(validateTaskLifecycleContract(created).ok, true);
  assert(Object.isFrozen(created));

  let relatedContract = createTaskLifecycleContract({
    contractId: 'task_contract_related',
    rootRunId: 'run_task_contract_related',
    threadId: 'thread_task_contract_test',
    rootUserRequest: '在上一任务基础上补充接口。',
    taskProfile: 'model_refinement',
    createdAt: '2026-09-01T00:00:00.000Z'
  });
  relatedContract = transition(relatedContract, 'link_predecessor', {
    predecessorContractId: created.contractId,
    taskRelation: 'amend'
  });
  assert.equal(relatedContract.predecessorContractId, created.contractId);
  assert.equal(relatedContract.taskRelation, 'amend');
  assert.equal(created.revision, 0, 'linking a successor must not mutate its predecessor');
  assert.throws(() => transition(relatedContract, 'link_predecessor', {
    predecessorContractId: 'another_contract',
    taskRelation: 'continue'
  }), (error) => error instanceof TaskLifecycleContractError
    && error.code === 'TASK_CONTRACT_PREDECESSOR_ALREADY_LINKED');
  let supersededContract = createTaskLifecycleContract({
    contractId: 'task_contract_to_supersede',
    rootRunId: 'run_task_contract_to_supersede',
    threadId: 'thread_task_contract_test',
    rootUserRequest: '执行一个尚未完成的旧任务。',
    taskProfile: 'analysis',
    createdAt: '2026-09-01T00:00:00.000Z'
  });
  supersededContract = transition(supersededContract, 'activate');
  supersededContract = transition(supersededContract, 'supersede', {
    supersededByContractId: relatedContract.contractId
  });
  assert.equal(supersededContract.status, 'superseded');
  assert.equal(supersededContract.deliveryStatus, 'superseded');

  let contract = transition(created, 'activate');
  contract = transition(contract, 'update_goals', {
    addGoals: [
      { statement: '包含通信、能源、热控和制导子系统。', origin: 'main_derived', required: true },
      { statement: '通过官方 Validator。', origin: 'platform_required', required: true }
    ],
    objectiveSummary: '交付完整且可验证的月球探测器模型。',
    assumptions: ['生成单文件模型'],
    exclusions: ['不生成仿真数值结果'],
    openQuestions: [],
    preservationConstraints: ['保留已经验证的模型正文'],
    hiddenThought: '不得进入契约'
  });
  assert.equal(contract.goals.length, 3);
  assert.equal('hiddenThought' in contract, false);

  const remainingGoalIds = contract.goals.map((goal) => goal.goalId);
  contract = transition(contract, 'set_iteration_directive', {
    mode: 'complete',
    subject: 'current_workspace',
    taskSummary: '交付完整且可验证的月球探测器模型。',
    instruction: '补全四类子系统和接口，返回完整模型。'
  });
  assert.equal(contract.currentDirective.contractRevision, contract.revision);
  const candidateView = projectTaskLifecycleContract(contract, { mode: 'candidate' });
  assert.equal(candidateView.rootUserRequest, undefined);
  assert.equal(candidateView.assumptions, undefined);
  assert.equal(candidateView.currentDirective.instruction, '补全四类子系统和接口，返回完整模型。');

  assert.throws(() => applyTaskLifecycleContractEvent(contract, {
    expectedRevision: 1,
    eventType: 'begin_execution',
    sourceRunId: 'run_task_contract_test'
  }), (error) => error instanceof TaskLifecycleContractError && error.code === 'TASK_CONTRACT_REVISION_CONFLICT');
  const legacy = structuredClone(contract);
  legacy.version = 'teacher-task-lifecycle-contract-v1';
  legacy.snapshotHash = taskLifecycleContractHash(legacy);
  assert.equal(validateTaskLifecycleContract(legacy).ok, true);
  assert.throws(() => transition(legacy, 'seal_for_finalization', candidateBinding()),
    (error) => error.code === 'TASK_CONTRACT_REQUIRED_GOALS_OPEN');
  assert.equal(contract.goals.every((goal) => goal.status === 'open'), true);
  contract = transition(contract, 'bind_validated_candidate', candidateBinding());
  contract = transition(contract, 'seal_for_finalization', candidateBinding());
  assert.equal(contract.status, 'sealed_for_finalization');
  assert.equal(contract.sealedRevision, contract.revision);
  assert.equal(contract.currentDirective, null);
  const finalizerView = projectTaskLifecycleContract(contract, { mode: 'finalizer' });
  assert.equal(finalizerView.selectedDelivery.candidateWorkspaceHash, candidateBinding().candidateWorkspaceHash);
  contract = transition(contract, 'begin_finalization');
  contract = transition(contract, 'mark_delivered', {
    ...candidateBinding(),
    answerMessageId: 'message_final_1'
  });
  assert.equal(contract.status, 'delivered');
  assert.equal(contract.deliveryStatus, 'delivered');
  assert.throws(() => transition(contract, 'begin_execution'), (error) => (
    error instanceof TaskLifecycleContractError && error.code === 'TASK_CONTRACT_TERMINAL'
  ));

  let directContract = createTaskLifecycleContract({
    contractId: 'task_contract_direct',
    rootRunId: 'run_task_contract_direct',
    threadId: 'thread_task_contract_direct',
    rootUserRequest: '解释 SysML v2 与 v1 的主要区别。',
    taskProfile: 'direct_answer',
    createdAt: '2026-09-01T00:00:00.000Z'
  });
  directContract = transition(directContract, 'activate');
  directContract = transition(directContract, 'update_goals', {
    statusUpdates: [{
      goalId: directContract.rootGoalId,
      status: 'covered',
      evidenceRefs: ['main:answer_ready'],
      note: 'Main已完成任务判读'
    }]
  });
  directContract = transition(directContract, 'seal_for_finalization', {
    deliveryKind: 'direct_answer',
    answerSource: 'finalizer'
  });
  assert.equal(directContract.selectedDelivery.deliveryKind, 'direct_answer');
  directContract = transition(directContract, 'begin_finalization');
  directContract = transition(directContract, 'mark_delivered', {
    deliveryKind: 'direct_answer',
    answerMessageId: 'message_direct_final'
  });
  assert.equal(directContract.status, 'delivered');

  const store = createMemoryConversationStore();
  const context = structuredClone(hostFixture);
  context.requestId = 'request_task_contract_store';
  context.question.text = '创建一个汽车热管理模型。';
  const { threadId } = await store.createThread(context);
  const rootRun = await store.createRun({ threadId, context, intent: 'single_entry', route: 'agent' });
  const persisted = await store.ensureTaskLifecycleContract({
    runId: rootRun.runId,
    taskProfile: 'model_authoring'
  });
  assert.equal(persisted.rootUserRequest, context.question.text);
  assert.equal((await store.listTaskLifecycleContractEvents(rootRun.runId)).length, 1);
  const activated = await store.appendTaskLifecycleContractEvent({
    runId: rootRun.runId,
    expectedRevision: 0,
    eventType: 'activate',
    actor: { type: 'server' }
  });
  assert.equal(activated.contract.revision, 1);
  assert.equal(activated.contract.status, 'active');

  const childRunId = 'run_task_contract_child';
  store.state.runs.set(childRunId, {
    ...rootRun,
    runId: childRunId,
    metadata: { continuationRootRunId: rootRun.runId, sourceRunId: rootRun.runId }
  });
  const inherited = await store.loadTaskLifecycleContract(childRunId);
  assert.equal(inherited.contractId, persisted.contractId);
  assert.equal(inherited.revision, 1);
  assert.equal((await store.listTaskLifecycleContractEvents(childRunId)).length, 2);

  const runtime = await import('../apps/teacher/dist/agent/index.mjs');
  const dependencies = {
    ensureTaskLifecycleContract: (input) => store.ensureTaskLifecycleContract({ runId: rootRun.runId, ...input }),
    loadTaskLifecycleContract: () => store.loadTaskLifecycleContract(rootRun.runId),
    appendTaskLifecycleContractEvent: (input) => store.appendTaskLifecycleContractEvent({ runId: rootRun.runId, ...input })
  };
  const taskSummary = '创建汽车热管理模型，保留已有连接并表达冷却行为。';
  const prepared = await runtime.prepareCandidateTaskContract({
    dependencies, runId: rootRun.runId,
    outcome: { type: 'delegate_candidate', mode: 'refine', subject: 'current_workspace',
      taskSummary, instruction: '补齐电池到热管理系统的热状态连接。', acceptedToolCallId: 'first' }
  });
  assert.deepEqual(prepared.warnings, []);
  assert.equal(prepared.directive.taskSummary, taskSummary);
  const beforeIteration = await store.loadTaskLifecycleContract(rootRun.runId);
  const second = await runtime.prepareCandidateTaskContract({
    dependencies, runId: rootRun.runId,
    outcome: { type: 'delegate_candidate', mode: 'refine', subject: 'current_validated_candidate',
      taskSummary, instruction: '保留连接，补充冷却行为。', acceptedToolCallId: 'second' }
  });
  assert.deepEqual(second.warnings, []);
  assert.equal(second.directive.taskSummary, taskSummary);
  assert.equal(second.directive.instruction, '保留连接，补充冷却行为。');
  const afterIteration = await store.loadTaskLifecycleContract(rootRun.runId);
  assert.deepEqual(afterIteration.goals, beforeIteration.goals, '返工不新增或重开覆盖表');
  assert.equal(afterIteration.rootUserRequest, context.question.text, '原始用户要求不可被摘要替换');
  const candidateWorkspaceHash = sha256('validated-candidate');
  const checkpoint = { candidateArtifactId: 'candidate_new', validationArtifactId: 'validation_new' };
  assert.deepEqual((await runtime.bindValidatedCandidateTaskContract({
    dependencies, checkpoint, candidateWorkspaceHash, candidateContent: '任意已验证正文'
  })).warnings, []);
  const sealed = await runtime.sealCandidateTaskContract({
    dependencies, checkpoint, candidateWorkspaceHash,
    candidateContent: '不需要逐字覆盖证据', finalizationRequestId: 'finish',
    resultCheckCompleted: true, limitations: '冷却行为尚未完成。'
  });
  assert.deepEqual(sealed.warnings, []);
  assert.equal(sealed.view.taskSummary, taskSummary);
  assert.equal(sealed.view.status, 'finalizing');
  assert.equal('goals' in sealed.view, false);
  const persistedResponse = { warnings: [] };
  await taskLifecycleServerForTests.markTaskLifecycleDeliveredFailSoft({
    conversation: store, runId: rootRun.runId, answerMessageId: 'persisted_answer', response: persistedResponse
  });
  const delivered = await store.loadTaskLifecycleContract(rootRun.runId);
  assert.equal(delivered.status, 'delivered');
  const { loadTaskFinalizationDecision } = await import('../apps/teacher/dist/agent/task-contract-runtime.mjs');
  assert.deepEqual(await loadTaskFinalizationDecision(dependencies, candidateWorkspaceHash), {
    completed: true, limitations: '冷却行为尚未完成。'
  }, '持久化及回放必须保留检查完成与任务仍有限制两个不同事实');
  assert.equal((await loadTaskFinalizationDecision(dependencies, sha256('other'))).completed, false);
  assert(delivered.goals.every((goal) => goal.status === 'open'), '交付不伪造目标完成');
  const followupContext = structuredClone(context);
  followupContext.requestId = 'new-followup';
  followupContext.question.text = '改为仅说明热连接。';
  const followupRun = await store.createRun({ threadId, context: followupContext, intent: 'single_entry', route: 'agent' });
  const followupDependencies = {
    ensureTaskLifecycleContract: (input) => store.ensureTaskLifecycleContract({ runId: followupRun.runId, ...input }),
    loadTaskLifecycleContract: () => store.loadTaskLifecycleContract(followupRun.runId),
    appendTaskLifecycleContractEvent: (input) => store.appendTaskLifecycleContractEvent({ runId: followupRun.runId, ...input })
  };
  const followup = await runtime.sealDirectTaskContract({ dependencies: followupDependencies,
    taskContractContext: await loadTaskContractContextForAgentForTests(store, followupRun.runId),
    finalizationRequestId: 'followup-direct', answerSource: 'finalizer' });
  assert.deepEqual(followup.warnings, []);
  const followupContract = await store.loadTaskLifecycleContract(followupRun.runId);
  assert.equal(followupContract.goals.length, 1, '后续解释不继承上一轮建模义务');
  assert.equal(followupContract.predecessorContractId, delivered.contractId);
  assert.equal((await store.loadTaskLifecycleContract(rootRun.runId)).snapshotHash, delivered.snapshotHash);
  const legacyReadonly = await runtime.prepareCandidateTaskContract({
    dependencies: { ...dependencies, ensureTaskLifecycleContract: async () => legacy },
    runId: rootRun.runId,
    outcome: { type: 'delegate_candidate', mode: 'refine', subject: 'current_workspace',
      taskSummary, instruction: '保留旧记录。', acceptedToolCallId: 'legacy' }
  });
  assert(legacyReadonly.warnings.includes('task_contract_update_failed:TASK_CONTRACT_LEGACY_READ_ONLY'));
  const directContext = structuredClone(hostFixture);
  directContext.requestId = 'request_task_contract_direct_delivery';
  directContext.question.text = '解释 definition 与 usage 的区别。';
  const directStore = createMemoryConversationStore();
  const directThread = await directStore.createThread(directContext);
  const directRun = await directStore.createRun({
    threadId: directThread.threadId,
    context: directContext,
    intent: 'single_entry',
    route: 'agent'
  });
  const directDependencies = {
    ensureTaskLifecycleContract: (input) => directStore.ensureTaskLifecycleContract({ runId: directRun.runId, ...input }),
    loadTaskLifecycleContract: () => directStore.loadTaskLifecycleContract(directRun.runId),
    appendTaskLifecycleContractEvent: (input) => directStore.appendTaskLifecycleContractEvent({ runId: directRun.runId, ...input })
  };
  const sealedDirect = await runtime.sealDirectTaskContract({
    dependencies: directDependencies,
    finalizationRequestId: 'direct-finalize-phase3',
    answerSource: 'finalizer'
  });
  assert.deepEqual(sealedDirect.warnings, []);
  assert.equal(sealedDirect.view.status, 'finalizing');
  assert.equal(sealedDirect.view.selectedDelivery.deliveryKind, 'direct_answer');
  assert.deepEqual(await runtime.markTaskContractDeliveryPending({ dependencies: directDependencies }), []);
  assert.equal((await directStore.loadTaskLifecycleContract(directRun.runId)).status, 'delivery_pending');
  const directPersistedResponse = { warnings: [] };
  await taskLifecycleServerForTests.markTaskLifecycleDeliveredFailSoft({
    conversation: directStore,
    runId: directRun.runId,
    answerMessageId: 'message_direct_delivered',
    response: directPersistedResponse
  });
  assert.equal((await directStore.loadTaskLifecycleContract(directRun.runId)).status, 'delivered');

  const clarificationStore = createMemoryConversationStore();
  const clarificationContext = structuredClone(hostFixture);
  clarificationContext.requestId = 'request_task_contract_clarification';
  clarificationContext.question.text = '帮我完善这个模型。';
  const clarificationThread = await clarificationStore.createThread(clarificationContext);
  const clarificationRun = await clarificationStore.createRun({
    threadId: clarificationThread.threadId,
    context: clarificationContext,
    intent: 'single_entry',
    route: 'agent'
  });
  const clarificationDependencies = {
    ensureTaskLifecycleContract: (input) => clarificationStore.ensureTaskLifecycleContract({ runId: clarificationRun.runId, ...input }),
    loadTaskLifecycleContract: () => clarificationStore.loadTaskLifecycleContract(clarificationRun.runId),
    appendTaskLifecycleContractEvent: (input) => clarificationStore.appendTaskLifecycleContractEvent({ runId: clarificationRun.runId, ...input })
  };
  assert.deepEqual(await runtime.prepareClarificationTaskContract({
    dependencies: clarificationDependencies,
    clarificationQuestion: '你指的是当前编辑器模型还是上一轮已验证候选？',
    acceptedToolCallId: 'main-clarification-1'
  }), []);
  const waitingContract = await clarificationStore.loadTaskLifecycleContract(clarificationRun.runId);
  assert.equal(waitingContract.status, 'waiting_user');
  assert.deepEqual(waitingContract.openQuestions, ['你指的是当前编辑器模型还是上一轮已验证候选？']);
  const clarificationChildRunId = 'run_task_contract_clarification_child';
  clarificationStore.state.runs.set(clarificationChildRunId, {
    ...clarificationRun,
    runId: clarificationChildRunId,
    metadata: { continuationRootRunId: clarificationRun.runId, sourceRunId: clarificationRun.runId }
  });
  const sameLineageContext = await loadTaskContractContextForAgentForTests(
    clarificationStore,
    clarificationChildRunId
  );
  assert.equal(sameLineageContext.relation, 'same_lineage');
  assert.equal(sameLineageContext.contract.contractId, waitingContract.contractId);
  const resumedClarification = await runtime.prepareCandidateTaskContract({
    dependencies: {
      ensureTaskLifecycleContract: (input) => clarificationStore.ensureTaskLifecycleContract({ runId: clarificationChildRunId, ...input }),
      loadTaskLifecycleContract: () => clarificationStore.loadTaskLifecycleContract(clarificationChildRunId),
      appendTaskLifecycleContractEvent: (input) => clarificationStore.appendTaskLifecycleContractEvent({ runId: clarificationChildRunId, ...input })
    },
    runId: clarificationChildRunId,
    taskContractContext: sameLineageContext,
    outcome: {
      type: 'delegate_candidate',
      mode: 'complete',
      subject: 'current_workspace',
      taskSummary: '按用户确认的当前编辑器模型补全结构。',
      instruction: '输出完整模型。',
      acceptedToolCallId: 'main-clarification-resume'
    }
  });
  assert.deepEqual(resumedClarification.warnings, []);
  const resumedContract = await clarificationStore.loadTaskLifecycleContract(clarificationChildRunId);
  assert.equal(resumedContract.contractId, waitingContract.contractId);
  assert.equal(resumedContract.status, 'executing');

  const source = require('fs').readFileSync(require.resolve('../apps/teacher/conversation-store'), 'utf8');
  assert(source.includes('create table if not exists teacher_task_lifecycle_contracts'));
  assert(source.includes('create table if not exists teacher_task_lifecycle_contract_events'));
  assert(source.includes('teacher_task_lifecycle_contracts_thread_owner_idx'));
  assert(source.includes('where root_run_id = $1 and revision = $2'));
  assert(source.includes('unique (contract_id, revision)'));
  assert.equal(resumedContract.objectiveSummary, '按用户确认的当前编辑器模型补全结构。');
  assert.equal(resumedContract.rootUserRequest, clarificationContext.question.text);
  console.log('AI Teacher task lifecycle contract tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
