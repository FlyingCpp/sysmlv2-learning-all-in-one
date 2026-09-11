'use strict';

const crypto = require('crypto');

const TASK_LIFECYCLE_CONTRACT_VERSION = 'teacher-task-lifecycle-contract-v2';
const LEGACY_TASK_LIFECYCLE_CONTRACT_VERSION = 'teacher-task-lifecycle-contract-v1';
const TASK_LIFECYCLE_EVENT_VERSION = 'teacher-task-lifecycle-event-v1';

const TASK_LIFECYCLE_STATUSES = Object.freeze([
  'provisional',
  'active',
  'waiting_user',
  'executing',
  'sealed_for_finalization',
  'finalizing',
  'delivery_pending',
  'delivered',
  'cancelled',
  'superseded'
]);

const TASK_GOAL_STATUSES = Object.freeze([
  'open',
  'in_progress',
  'covered',
  'blocked',
  'waived'
]);

const TASK_GOAL_ORIGINS = Object.freeze([
  'root_user_request',
  'clarification_user_answer',
  'main_derived',
  'predecessor_inherited',
  'engineering_advisory',
  'platform_required'
]);

const TASK_CONTRACT_RELATIONS = Object.freeze([
  'new_task',
  'contextual_reference',
  'continue',
  'amend',
  'supersede'
]);

const TASK_LIFECYCLE_EVENT_TYPES = Object.freeze([
  'activate',
  'wait_for_user',
  'resume_execution',
  'begin_execution',
  'link_predecessor',
  'update_goals',
  'set_iteration_directive',
  'bind_validated_candidate',
  'seal_for_finalization',
  'begin_finalization',
  'mark_delivery_pending',
  'mark_delivered',
  'cancel',
  'supersede'
]);

const STATUS_TRANSITIONS = Object.freeze({
  activate: Object.freeze({ from: ['provisional'], to: 'active' }),
  wait_for_user: Object.freeze({ from: ['active', 'executing'], to: 'waiting_user' }),
  resume_execution: Object.freeze({ from: ['waiting_user', 'active', 'delivery_pending'], to: 'executing' }),
  begin_execution: Object.freeze({ from: ['active', 'executing', 'delivery_pending'], to: 'executing' }),
  seal_for_finalization: Object.freeze({ from: ['active', 'executing'], to: 'sealed_for_finalization' }),
  begin_finalization: Object.freeze({ from: ['sealed_for_finalization'], to: 'finalizing' }),
  mark_delivery_pending: Object.freeze({ from: ['sealed_for_finalization', 'finalizing'], to: 'delivery_pending' }),
  mark_delivered: Object.freeze({ from: ['sealed_for_finalization', 'finalizing', 'delivery_pending'], to: 'delivered' }),
  cancel: Object.freeze({ from: ['provisional', 'active', 'waiting_user', 'executing', 'delivery_pending'], to: 'cancelled' }),
  supersede: Object.freeze({ from: ['provisional', 'active', 'waiting_user', 'executing', 'delivery_pending'], to: 'superseded' })
});

class TaskLifecycleContractError extends Error {
  constructor(code, message, statusCode = 409, details = undefined) {
    super(message);
    this.name = 'TaskLifecycleContractError';
    this.code = code;
    this.statusCode = statusCode;
    if (details !== undefined) this.details = details;
  }
}

function createTaskLifecycleContract(input = {}) {
  const contractId = requireIdentifier(input.contractId, 'contractId');
  const rootRunId = requireIdentifier(input.rootRunId, 'rootRunId');
  const threadId = requireIdentifier(input.threadId, 'threadId');
  const rootUserRequest = requireBoundedText(input.rootUserRequest, 'rootUserRequest', 200_000);
  const createdAt = safeTimestamp(input.createdAt);
  const rootGoal = Object.freeze({
    goalId: deterministicId('goal', `${contractId}:root`),
    statement: rootUserRequest,
    origin: 'root_user_request',
    required: true,
    status: 'open',
    evidenceRefs: [],
    note: ''
  });
  const contract = {
    version: TASK_LIFECYCLE_CONTRACT_VERSION,
    contractId,
    lineageId: rootRunId,
    rootRunId,
    threadId,
    tenantId: boundedIdentifier(input.tenantId),
    userId: boundedIdentifier(input.userId),
    predecessorContractId: '',
    taskRelation: 'new_task',
    revision: 0,
    status: 'provisional',
    taskProfile: normalizeTaskProfile(input.taskProfile),
    rootGoalId: rootGoal.goalId,
    rootUserRequest,
    objectiveSummary: boundedText(input.objectiveSummary, 4_000),
    goals: [rootGoal],
    assumptions: [],
    exclusions: [],
    openQuestions: [],
    preservationConstraints: normalizeTextList(input.preservationConstraints, 32, 1_000),
    currentDirective: null,
    lastValidatedCandidate: null,
    sealedRevision: null,
    selectedDelivery: null,
    deliveryStatus: 'not_started',
    createdAt,
    updatedAt: createdAt
  };
  contract.snapshotHash = taskLifecycleContractHash(contract);
  return deepFreeze(contract);
}

function applyTaskLifecycleContractEvent(current, input = {}) {
  const contract = cloneAndValidateContract(current);
  const expectedRevision = requireRevision(input.expectedRevision, 'expectedRevision');
  if (contract.revision !== expectedRevision) {
    throw new TaskLifecycleContractError(
      'TASK_CONTRACT_REVISION_CONFLICT',
      `Task contract revision conflict: expected ${expectedRevision}, current ${contract.revision}.`,
      409,
      { expectedRevision, currentRevision: contract.revision }
    );
  }
  if (isTerminalStatus(contract.status)) {
    throw new TaskLifecycleContractError(
      'TASK_CONTRACT_TERMINAL',
      `Task contract ${contract.contractId} is already ${contract.status}.`
    );
  }
  const eventType = String(input.eventType || '');
  if (!TASK_LIFECYCLE_EVENT_TYPES.includes(eventType)) {
    throw new TaskLifecycleContractError('TASK_CONTRACT_EVENT_INVALID', `Unsupported task contract event: ${eventType || '(empty)'}.`, 400);
  }
  const sourceRunId = requireIdentifier(input.sourceRunId, 'sourceRunId');
  const actor = normalizeActor(input.actor);
  const payload = normalizeEventPayload(eventType, input.payload || {});
  const nextRevision = contract.revision + 1;
  const eventId = input.eventId
    ? requireIdentifier(input.eventId, 'eventId')
    : deterministicId('tcevt', `${contract.contractId}:${nextRevision}:${eventType}`);
  const createdAt = safeTimestamp(input.createdAt);

  applyStatusTransition(contract, eventType);
  if (eventType === 'link_predecessor') applyPredecessorLink(contract, payload);
  if (eventType === 'update_goals') applyGoalUpdates(contract, payload, nextRevision);
  if (eventType === 'set_iteration_directive') {
    contract.currentDirective = createIterationDirective(contract, payload, nextRevision);
    if (contract.version === TASK_LIFECYCLE_CONTRACT_VERSION) {
      contract.objectiveSummary = contract.currentDirective.taskSummary;
    }
  }
  if (eventType === 'bind_validated_candidate') contract.lastValidatedCandidate = normalizeCandidateBinding(payload);
  if (eventType === 'seal_for_finalization') applySeal(contract, payload, nextRevision);
  if (eventType === 'mark_delivery_pending') {
    contract.deliveryStatus = 'pending';
    contract.selectedDelivery = normalizeDeliverySelection(payload, false, contract.selectedDelivery);
  }
  if (eventType === 'mark_delivered') {
    contract.deliveryStatus = 'delivered';
    contract.selectedDelivery = normalizeDeliverySelection(payload, true, contract.selectedDelivery);
  }
  if (eventType === 'cancel') contract.deliveryStatus = 'cancelled';
  if (eventType === 'supersede') contract.deliveryStatus = 'superseded';

  contract.revision = nextRevision;
  contract.updatedAt = createdAt;
  contract.snapshotHash = taskLifecycleContractHash(contract);
  const event = deepFreeze({
    version: TASK_LIFECYCLE_EVENT_VERSION,
    eventId,
    contractId: contract.contractId,
    lineageId: contract.lineageId,
    revision: nextRevision,
    eventType,
    actor,
    sourceRunId,
    payload,
    resultingStatus: contract.status,
    resultingSnapshotHash: contract.snapshotHash,
    createdAt
  });
  return { contract: deepFreeze(contract), event };
}

function projectTaskLifecycleContract(contract, options = {}) {
  const value = cloneAndValidateContract(contract);
  const mode = options.mode === 'finalizer' ? 'finalizer' : options.mode === 'candidate' ? 'candidate' : 'main';
  const goals = value.goals.map((goal) => ({
    goalId: goal.goalId,
    statement: goal.statement,
    origin: goal.origin,
    required: goal.required,
    status: goal.status,
    evidenceRefs: [...goal.evidenceRefs],
    note: goal.note
  }));
  const projection = {
    version: value.version,
    contractId: value.contractId,
    lineageId: value.lineageId,
    revision: value.revision,
    status: value.status,
    taskProfile: value.taskProfile,
    predecessorContractId: boundedIdentifier(value.predecessorContractId),
    taskRelation: TASK_CONTRACT_RELATIONS.includes(value.taskRelation) ? value.taskRelation : 'new_task',
    rootGoalId: value.rootGoalId,
    objectiveSummary: value.objectiveSummary,
    goals,
    preservationConstraints: [...value.preservationConstraints],
    currentDirective: value.currentDirective ? structuredClone(value.currentDirective) : null,
    lastValidatedCandidate: value.lastValidatedCandidate ? structuredClone(value.lastValidatedCandidate) : null,
    sealedRevision: value.sealedRevision,
    deliveryStatus: value.deliveryStatus,
    snapshotHash: value.snapshotHash
  };
  if (mode === 'main') {
    projection.rootUserRequest = value.rootUserRequest;
    projection.assumptions = [...value.assumptions];
    projection.exclusions = [...value.exclusions];
    projection.openQuestions = [...value.openQuestions];
  }
  if (mode === 'finalizer') {
    if (value.status !== 'sealed_for_finalization' && value.status !== 'finalizing' && value.status !== 'delivery_pending') {
      throw new TaskLifecycleContractError('TASK_CONTRACT_NOT_SEALED', 'Finalizer may only receive a sealed task contract.', 409);
    }
    projection.selectedDelivery = value.selectedDelivery ? structuredClone(value.selectedDelivery) : null;
  }
  return deepFreeze(projection);
}

function validateTaskLifecycleContract(value) {
  try {
    cloneAndValidateContract(value);
    return { ok: true, errors: [] };
  } catch (error) {
    return { ok: false, errors: [String(error?.message || error)] };
  }
}

function taskLifecycleContractHash(value) {
  const material = structuredClone(value || {});
  delete material.snapshotHash;
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(material)).digest('hex')}`;
}

function applyStatusTransition(contract, eventType) {
  const transition = STATUS_TRANSITIONS[eventType];
  if (!transition) return;
  if (!transition.from.includes(contract.status)) {
    throw new TaskLifecycleContractError(
      'TASK_CONTRACT_STATUS_CONFLICT',
      `Event ${eventType} is not allowed while task contract is ${contract.status}.`,
      409,
      { eventType, status: contract.status, allowedFrom: transition.from }
    );
  }
  contract.status = transition.to;
}

function applyGoalUpdates(contract, payload, nextRevision) {
  const byId = new Map(contract.goals.map((goal) => [goal.goalId, goal]));
  for (const update of payload.statusUpdates) {
    const goal = byId.get(update.goalId);
    if (!goal) throw new TaskLifecycleContractError('TASK_CONTRACT_GOAL_NOT_FOUND', `Unknown task goal: ${update.goalId}.`, 404);
    if (goal.goalId === contract.rootGoalId && update.status === 'waived') {
      throw new TaskLifecycleContractError('TASK_CONTRACT_ROOT_GOAL_REQUIRED', 'The root user goal cannot be waived.', 409);
    }
    goal.status = update.status;
    goal.evidenceRefs = update.evidenceRefs;
    goal.note = update.note;
  }
  payload.addGoals.forEach((goal, index) => {
    const goalId = deterministicId('goal', `${contract.contractId}:${nextRevision}:${index}:${goal.statement}`);
    if (byId.has(goalId)) return;
    const created = {
      goalId,
      statement: goal.statement,
      origin: goal.origin,
      required: goal.required,
      status: 'open',
      evidenceRefs: [],
      note: ''
    };
    contract.goals.push(created);
    byId.set(goalId, created);
  });
  contract.objectiveSummary = payload.objectiveSummary || contract.objectiveSummary;
  contract.assumptions = payload.assumptions;
  contract.exclusions = payload.exclusions;
  contract.openQuestions = payload.openQuestions;
  contract.preservationConstraints = payload.preservationConstraints;
}

function applyPredecessorLink(contract, payload) {
  if (contract.predecessorContractId) {
    throw new TaskLifecycleContractError(
      'TASK_CONTRACT_PREDECESSOR_ALREADY_LINKED',
      `Task contract ${contract.contractId} already has a predecessor.`,
      409
    );
  }
  if (payload.predecessorContractId === contract.contractId) {
    throw new TaskLifecycleContractError(
      'TASK_CONTRACT_PREDECESSOR_SELF_REFERENCE',
      'Task contract cannot reference itself as predecessor.',
      409
    );
  }
  contract.predecessorContractId = payload.predecessorContractId;
  contract.taskRelation = payload.taskRelation;
}

function createIterationDirective(contract, payload, revision) {
  if (contract.version === TASK_LIFECYCLE_CONTRACT_VERSION) {
    return {
      directiveId: deterministicId('directive', `${contract.contractId}:${revision}`),
      contractRevision: revision,
      mode: payload.mode,
      subject: payload.subject,
      taskSummary: payload.taskSummary || contract.objectiveSummary,
      instruction: payload.instruction
    };
  }
  const goalIds = payload.goalIds.length
    ? payload.goalIds
    : contract.goals.filter((goal) => goal.required && !['covered', 'waived'].includes(goal.status)).map((goal) => goal.goalId);
  for (const goalId of goalIds) {
    if (!contract.goals.some((goal) => goal.goalId === goalId)) {
      throw new TaskLifecycleContractError('TASK_CONTRACT_GOAL_NOT_FOUND', `Iteration directive references unknown goal: ${goalId}.`, 404);
    }
  }
  return {
    directiveId: deterministicId('directive', `${contract.contractId}:${revision}`),
    contractRevision: revision,
    mode: payload.mode,
    subject: payload.subject,
    goalIds,
    remainingGoals: payload.remainingGoals,
    gapRefs: payload.gapRefs,
    acceptanceNotes: payload.acceptanceNotes
  };
}

function applySeal(contract, payload, revision) {
  const unresolved = contract.goals.filter((goal) => goal.required && !['covered', 'waived'].includes(goal.status));
  if (contract.version === LEGACY_TASK_LIFECYCLE_CONTRACT_VERSION && unresolved.length) {
    throw new TaskLifecycleContractError(
      'TASK_CONTRACT_REQUIRED_GOALS_OPEN',
      'Task contract cannot be sealed while required goals remain unresolved.',
      409,
      { goalIds: unresolved.map((goal) => goal.goalId) }
    );
  }
  if (payload.deliveryKind === 'direct_answer') {
    if (!['direct_answer', 'analysis'].includes(contract.taskProfile)) {
      throw new TaskLifecycleContractError(
        'TASK_CONTRACT_DIRECT_DELIVERY_NOT_ALLOWED',
        `Task profile ${contract.taskProfile} requires a validated candidate delivery.`,
        409
      );
    }
    contract.selectedDelivery = {
      deliveryKind: 'direct_answer',
      answerSource: payload.answerSource,
      answerMessageId: ''
    };
    contract.sealedRevision = revision;
    contract.deliveryStatus = 'sealed';
    contract.currentDirective = null;
    return;
  }
  const candidate = normalizeCandidateBinding(payload);
  if (contract.lastValidatedCandidate
    && contract.lastValidatedCandidate.candidateWorkspaceHash !== candidate.candidateWorkspaceHash) {
    throw new TaskLifecycleContractError('TASK_CONTRACT_DELIVERY_BINDING_MISMATCH', 'Sealed delivery must match the latest validated candidate.', 409);
  }
  contract.lastValidatedCandidate = candidate;
  contract.selectedDelivery = {
    deliveryKind: 'validated_candidate',
    candidateArtifactId: candidate.candidateArtifactId,
    candidateWorkspaceHash: candidate.candidateWorkspaceHash,
    validationArtifactId: candidate.validationArtifactId,
    validatorStatus: candidate.validatorStatus,
    ...(contract.version === TASK_LIFECYCLE_CONTRACT_VERSION ? {
      resultCheckCompleted: payload.resultCheckCompleted === true,
      limitations: payload.limitations || ''
    } : {}),
    answerMessageId: ''
  };
  contract.sealedRevision = revision;
  contract.deliveryStatus = 'sealed';
  contract.currentDirective = null;
}

function normalizeEventPayload(eventType, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskLifecycleContractError('TASK_CONTRACT_EVENT_PAYLOAD_INVALID', 'Task contract event payload must be an object.', 400);
  }
  if (eventType === 'update_goals') {
    return {
      addGoals: (Array.isArray(value.addGoals) ? value.addGoals : []).slice(0, 32).map((goal) => ({
        statement: requireBoundedText(goal?.statement, 'addGoals.statement', 4_000),
        origin: TASK_GOAL_ORIGINS.includes(goal?.origin) ? goal.origin : 'main_derived',
        required: goal?.required !== false
      })),
      statusUpdates: (Array.isArray(value.statusUpdates) ? value.statusUpdates : []).slice(0, 64).map((update) => ({
        goalId: requireIdentifier(update?.goalId, 'statusUpdates.goalId'),
        status: TASK_GOAL_STATUSES.includes(update?.status) ? update.status : invalidValue('statusUpdates.status'),
        evidenceRefs: normalizeTextList(update?.evidenceRefs, 16, 240),
        note: boundedText(update?.note, 1_000)
      })),
      objectiveSummary: boundedText(value.objectiveSummary, 4_000),
      assumptions: normalizeTextList(value.assumptions, 32, 1_000),
      exclusions: normalizeTextList(value.exclusions, 32, 1_000),
      openQuestions: normalizeTextList(value.openQuestions, 32, 1_000),
      preservationConstraints: normalizeTextList(value.preservationConstraints, 32, 1_000)
    };
  }
  if (eventType === 'set_iteration_directive') {
    const mode = ['create', 'complete', 'refine', 'milestone'].includes(value.mode) ? value.mode : invalidValue('mode');
    const subject = ['current_workspace', 'current_validated_candidate', 'previous_validated_candidate', 'last_validated_candidate', 'standalone_model'].includes(value.subject)
      ? value.subject
      : invalidValue('subject');
    return {
      mode,
      subject,
      taskSummary: boundedText(value.taskSummary, 4_000),
      instruction: boundedText(value.instruction, 4_000),
      goalIds: normalizeTextList(value.goalIds, 32, 160),
      remainingGoals: normalizeTextList(value.remainingGoals, 32, 2_000),
      gapRefs: normalizeTextList(value.gapRefs, 32, 240),
      acceptanceNotes: normalizeTextList(value.acceptanceNotes, 32, 1_000)
    };
  }
  if (eventType === 'link_predecessor') {
    const taskRelation = ['contextual_reference', 'continue', 'amend', 'supersede'].includes(value.taskRelation)
      ? value.taskRelation
      : invalidValue('taskRelation');
    return {
      predecessorContractId: requireIdentifier(value.predecessorContractId, 'predecessorContractId'),
      taskRelation
    };
  }
  if (eventType === 'bind_validated_candidate') {
    return normalizeCandidateBinding(value);
  }
  if (eventType === 'seal_for_finalization') return normalizeSealBinding(value);
  if (eventType === 'mark_delivery_pending' || eventType === 'mark_delivered') {
    return normalizeDeliverySelection(value, eventType === 'mark_delivered');
  }
  if (eventType === 'supersede') {
    return { supersededByContractId: requireIdentifier(value.supersededByContractId, 'supersededByContractId') };
  }
  if (eventType === 'cancel') return { reason: boundedText(value.reason, 1_000) };
  return {};
}

function normalizeCandidateBinding(value) {
  const validatorStatus = value?.validatorStatus === 'validated_passed' ? 'validated_passed' : invalidValue('validatorStatus');
  return {
    candidateArtifactId: requireIdentifier(value?.candidateArtifactId, 'candidateArtifactId'),
    candidateWorkspaceHash: requireSha256(value?.candidateWorkspaceHash, 'candidateWorkspaceHash'),
    validationArtifactId: requireIdentifier(value?.validationArtifactId, 'validationArtifactId'),
    validatorStatus
  };
}

function normalizeSealBinding(value) {
  if (value?.deliveryKind === 'direct_answer') {
    return {
      deliveryKind: 'direct_answer',
      answerSource: ['main_draft', 'finalizer'].includes(value.answerSource) ? value.answerSource : 'finalizer'
    };
  }
  return { deliveryKind: 'validated_candidate', ...normalizeCandidateBinding(value),
    resultCheckCompleted: value.resultCheckCompleted === true, limitations: boundedText(value.limitations, 4_000) };
}

function normalizeDeliverySelection(value, requireMessage, currentSelection = null) {
  const deliveryKind = value?.deliveryKind || currentSelection?.deliveryKind || 'validated_candidate';
  if (deliveryKind === 'direct_answer') {
    const selection = {
      deliveryKind: 'direct_answer',
      answerSource: ['main_draft', 'finalizer'].includes(value?.answerSource)
        ? value.answerSource
        : currentSelection?.answerSource || 'finalizer',
      answerMessageId: boundedIdentifier(value?.answerMessageId)
    };
    if (requireMessage && !selection.answerMessageId) invalidValue('answerMessageId');
    return selection;
  }
  const selection = {
    deliveryKind: 'validated_candidate',
    ...(currentSelection && Object.hasOwn(currentSelection, 'resultCheckCompleted') ? {
      resultCheckCompleted: currentSelection.resultCheckCompleted,
      limitations: currentSelection.limitations
    } : {}),
    candidateArtifactId: requireIdentifier(value?.candidateArtifactId, 'candidateArtifactId'),
    candidateWorkspaceHash: requireSha256(value?.candidateWorkspaceHash, 'candidateWorkspaceHash'),
    validationArtifactId: requireIdentifier(value?.validationArtifactId, 'validationArtifactId'),
    validatorStatus: value?.validatorStatus === 'validated_passed' ? 'validated_passed' : invalidValue('validatorStatus'),
    answerMessageId: boundedIdentifier(value?.answerMessageId)
  };
  if (requireMessage && !selection.answerMessageId) invalidValue('answerMessageId');
  return selection;
}

function cloneAndValidateContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidValue('contract');
  const contract = structuredClone(value);
  if (![TASK_LIFECYCLE_CONTRACT_VERSION, LEGACY_TASK_LIFECYCLE_CONTRACT_VERSION].includes(contract.version)) invalidValue('contract.version');
  requireIdentifier(contract.contractId, 'contract.contractId');
  requireIdentifier(contract.rootRunId, 'contract.rootRunId');
  requireIdentifier(contract.threadId, 'contract.threadId');
  const predecessorContractId = boundedIdentifier(contract.predecessorContractId);
  const taskRelation = contract.taskRelation === undefined ? 'new_task' : contract.taskRelation;
  if (!TASK_CONTRACT_RELATIONS.includes(taskRelation)) invalidValue('contract.taskRelation');
  if ((taskRelation === 'new_task') !== !predecessorContractId) {
    invalidValue('contract.predecessorContractId/taskRelation');
  }
  requireRevision(contract.revision, 'contract.revision');
  if (!TASK_LIFECYCLE_STATUSES.includes(contract.status)) invalidValue('contract.status');
  if (!Array.isArray(contract.goals) || contract.goals.length < 1) invalidValue('contract.goals');
  const goalIds = new Set();
  for (const goal of contract.goals) {
    requireIdentifier(goal.goalId, 'contract.goals.goalId');
    if (goalIds.has(goal.goalId)) invalidValue('contract.goals.goalId duplicate');
    goalIds.add(goal.goalId);
    requireBoundedText(goal.statement, 'contract.goals.statement', 4_000);
    if (!TASK_GOAL_ORIGINS.includes(goal.origin)) invalidValue('contract.goals.origin');
    if (!TASK_GOAL_STATUSES.includes(goal.status)) invalidValue('contract.goals.status');
    goal.evidenceRefs = normalizeTextList(goal.evidenceRefs, 16, 240);
    goal.note = boundedText(goal.note, 1_000);
  }
  if (!goalIds.has(contract.rootGoalId)) invalidValue('contract.rootGoalId');
  if (contract.snapshotHash && contract.snapshotHash !== taskLifecycleContractHash(contract)) {
    throw new TaskLifecycleContractError('TASK_CONTRACT_HASH_MISMATCH', 'Task contract snapshot hash does not match its content.', 409);
  }
  return contract;
}

function normalizeActor(value) {
  const actorType = ['server', 'main', 'candidate', 'finalizer', 'user', 'operator'].includes(value?.type)
    ? value.type
    : 'server';
  return { type: actorType, id: boundedIdentifier(value?.id) };
}

function normalizeTaskProfile(value) {
  return ['direct_answer', 'model_authoring', 'model_refinement', 'validation_repair', 'analysis'].includes(value)
    ? value
    : 'analysis';
}

function isTerminalStatus(status) {
  return status === 'delivered' || status === 'cancelled' || status === 'superseded';
}

function deterministicId(prefix, material) {
  return `${prefix}_${crypto.createHash('sha256').update(String(material)).digest('hex').slice(0, 24)}`;
}

function requireRevision(value, path) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0) invalidValue(path);
  return revision;
}

function requireIdentifier(value, path) {
  const identifier = boundedIdentifier(value);
  if (!identifier) invalidValue(path);
  return identifier;
}

function boundedIdentifier(value) {
  return String(value || '').replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 200);
}

function requireSha256(value, path) {
  const hash = String(value || '');
  if (!/^sha256:[a-f0-9]{64}$/u.test(hash)) invalidValue(path);
  return hash;
}

function requireBoundedText(value, path, limit) {
  const text = boundedText(value, limit);
  if (!text) invalidValue(path);
  return text;
}

function boundedText(value, limit) {
  return String(value || '').trim().slice(0, limit);
}

function normalizeTextList(value, maxItems, maxLength) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => boundedText(item, maxLength))
    .filter(Boolean))].slice(0, maxItems);
}

function safeTimestamp(value) {
  const parsed = value ? new Date(value) : new Date();
  if (!Number.isFinite(parsed.getTime())) invalidValue('createdAt');
  return parsed.toISOString();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function invalidValue(path) {
  throw new TaskLifecycleContractError('TASK_CONTRACT_INPUT_INVALID', `Invalid task lifecycle contract value: ${path}.`, 400);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

module.exports = {
  TASK_LIFECYCLE_CONTRACT_VERSION,
  TASK_LIFECYCLE_EVENT_VERSION,
  TASK_LIFECYCLE_STATUSES,
  TASK_GOAL_STATUSES,
  TASK_GOAL_ORIGINS,
  TASK_CONTRACT_RELATIONS,
  TASK_LIFECYCLE_EVENT_TYPES,
  TaskLifecycleContractError,
  createTaskLifecycleContract,
  applyTaskLifecycleContractEvent,
  projectTaskLifecycleContract,
  validateTaskLifecycleContract,
  taskLifecycleContractHash
};
