'use strict';

const crypto = require('crypto');

const EXECUTION_CHECKPOINT_VERSION = 'teacher-execution-checkpoint-v1';
const EXECUTION_ARTIFACT_VERSION = 'teacher-execution-artifact-v1';
const MAX_EXECUTION_PAYLOAD_BYTES = 1_000_000;
const MAX_EXECUTION_STATE_BYTES = 64_000;
const MAX_PERSISTED_ANSWER_BYTES = 200_000;
const MAX_TIMELINE_LIMIT = 200;

const EXECUTION_PHASES = new Set([
  'candidate_absent',
  'candidate_ready',
  'validation_pending',
  'validation_failed',
  'repair_in_progress',
  'validated_passed',
  'engineering_assessment_started',
  'engineering_assessment_completed',
  'engineering_improvement_pending',
  'engineering_improvement_admitted',
  'engineering_improvement_skipped',
  'engineering_revision_in_progress',
  'engineering_verification_started',
  'engineering_verification_completed',
  'finalization_pending',
  'completed'
]);

const PHASE_ALLOWED_ACTIONS = Object.freeze({
  candidate_absent: Object.freeze(['candidate']),
  candidate_ready: Object.freeze(['validator']),
  validation_pending: Object.freeze(['resolve_validation', 'validator']),
  validation_failed: Object.freeze(['repair']),
  repair_in_progress: Object.freeze(['repair']),
  validated_passed: Object.freeze(['finalizer']),
  engineering_assessment_started: Object.freeze(['finalizer']),
  engineering_assessment_completed: Object.freeze(['engineering_resume']),
  engineering_improvement_pending: Object.freeze(['engineering_resume']),
  engineering_improvement_admitted: Object.freeze(['engineering_resume']),
  engineering_improvement_skipped: Object.freeze(['finalizer']),
  engineering_revision_in_progress: Object.freeze(['engineering_resume']),
  engineering_verification_started: Object.freeze(['finalizer']),
  engineering_verification_completed: Object.freeze(['finalizer']),
  finalization_pending: Object.freeze(['finalizer']),
  completed: Object.freeze(['return_persisted'])
});

class ExecutionCheckpointError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = 'ExecutionCheckpointError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeExecutionBoundary(boundary = {}) {
  if (!boundary || typeof boundary !== 'object' || Array.isArray(boundary)) {
    throw checkpointError('EXECUTION_CHECKPOINT_BOUNDARY_INVALID', 'Execution checkpoint boundary must be an object.', 400);
  }
  const phase = String(boundary.phase || '').trim();
  if (!EXECUTION_PHASES.has(phase)) {
    throw checkpointError('EXECUTION_CHECKPOINT_PHASE_INVALID', 'Execution checkpoint phase is invalid.', 400);
  }
  const candidate = normalizeArtifactInput(boundary.candidate, 'candidate');
  const validation = normalizeArtifactInput(boundary.validation, 'validation');
  const candidateArtifactId = normalizeArtifactReference(boundary.candidateArtifactId);
  const validationArtifactId = normalizeArtifactReference(boundary.validationArtifactId);
  assertPhaseAssets(phase, {
    candidateArtifactId: candidateArtifactId || candidate?.pendingArtifactId,
    validationArtifactId: validationArtifactId || validation?.pendingArtifactId
  });
  const validatorVersion = boundedText(
    boundary.validatorVersion || validation?.validatorVersion || validation?.payload?.validator?.version,
    300
  );
  const rulesetVersion = boundedText(boundary.rulesetVersion || validation?.rulesetVersion, 300);
  const validationOptionsHash = safeHash(boundary.validationOptionsHash || validation?.validationOptionsHash);
  const requestRevisionHash = safeHash(boundary.requestRevisionHash);
  const taskContractHash = safeHash(boundary.taskContractHash);
  const editorBaseHash = safeHash(boundary.editorBaseHash);
  if (!requestRevisionHash || !taskContractHash || !editorBaseHash) {
    throw checkpointError(
      'EXECUTION_CHECKPOINT_INPUT_HASHES_REQUIRED',
      'Execution checkpoint requires request revision, task contract, and editor base hashes.',
      400
    );
  }
  const metadata = cloneExecutionPayload(boundary.metadata || {}, MAX_EXECUTION_STATE_BYTES);
  delete metadata.allowedActions;
  delete metadata.decision;
  return Object.freeze({
    version: EXECUTION_CHECKPOINT_VERSION,
    phase,
    candidate,
    validation,
    candidateArtifactId,
    validationArtifactId,
    requestRevisionHash,
    taskContractHash,
    editorBaseHash,
    validatorVersion,
    rulesetVersion,
    validationOptionsHash,
    repairRound: boundedInteger(boundary.repairRound, 0, 10_000, 0),
    repairState: cloneExecutionPayload(boundary.repairState || {}, MAX_EXECUTION_STATE_BYTES),
    knowledgeCursor: cloneExecutionPayload(boundary.knowledgeCursor || {}, MAX_EXECUTION_STATE_BYTES),
    metadata
  });
}

/**
 * 从当前、已由服务端规范化的 HostContextEnvelope 派生续跑输入指纹。
 * 只读取 question、course/courseContext 的任务合同字段和 editor 基线文件；
 * requestId、reasoning、历史消息、诊断和光标/选择状态均不参与计算。
 */
function deriveExecutionInputHashes(hostContext = {}) {
  const question = objectValue(hostContext.question);
  const course = objectValue(hostContext.course);
  const courseContext = objectValue(hostContext.courseContext);
  const editor = objectValue(hostContext.editor);
  const requestRevision = {
    version: 'teacher-question-revision-v1',
    revision: boundedText(
      question.revisionId ?? question.revision ?? question.version,
      160
    ),
    text: normalizedText(question.text, 20_000),
    intent: boundedText(question.intent, 160),
    operation: boundedText(question.operation, 80),
    hintLevel: boundedText(question.hintLevel, 80)
  };
  const taskContract = {
    version: 'teacher-task-contract-v1',
    contractVersion: boundedText(hostContext.contractVersion, 80),
    courseScope: {
      coursePackId: boundedText(course.coursePackId, 240),
      coursePackVersion: boundedText(course.coursePackVersion ?? course.packVersion, 160),
      courseId: boundedText(course.courseId, 240),
      lessonId: boundedText(course.lessonId, 240),
      lessonVersion: boundedText(course.lessonVersion ?? course.revision, 160),
      courseRuleMode: boundedText(course.courseRuleMode, 80)
    },
    learningGoals: normalizedTextList(course.learningGoals, 40, 1_000),
    taskItems: normalizedTaskItems(courseContext.todoItems),
    authority: boundedText(courseContext.authority, 120)
  };
  const editorBase = {
    version: 'teacher-editor-base-v1',
    language: boundedText(editor.language, 80),
    entryFile: normalizedPath(editor.entryFile),
    files: normalizedEditorBaseFiles(editor.files)
  };
  return Object.freeze({
    requestRevisionHash: hashJson(requestRevision),
    taskContractHash: hashJson(taskContract),
    editorBaseHash: hashJson(editorBase)
  });
}

function normalizeArtifactInput(value, expectedKind) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw checkpointError('EXECUTION_ARTIFACT_INVALID', `${expectedKind} artifact must be an object.`, 400);
  }
  if (value.artifactId) {
    throw checkpointError(
      'EXECUTION_ARTIFACT_ID_SERVER_OWNED',
      'New execution artifact identifiers are assigned by the server.',
      400
    );
  }
  const payload = cloneExecutionPayload(Object.prototype.hasOwnProperty.call(value, 'payload') ? value.payload : value);
  const candidateWorkspaceHash = safeHash(
    value.candidateWorkspaceHash || payload?.candidateWorkspaceHash
  );
  const validatorVersion = boundedText(value.validatorVersion || payload?.validator?.version, 300);
  const rulesetVersion = boundedText(value.rulesetVersion, 300);
  const validationOptionsHash = safeHash(value.validationOptionsHash);
  const artifactHash = safeHash(value.artifactHash) || hashJson({
    kind: expectedKind,
    candidateWorkspaceHash,
    validatorVersion,
    rulesetVersion,
    validationOptionsHash,
    payload
  });
  const effectiveCandidateWorkspaceHash = candidateWorkspaceHash
    || (expectedKind === 'candidate' ? artifactHash : '');
  return Object.freeze({
    version: EXECUTION_ARTIFACT_VERSION,
    kind: expectedKind,
    artifactId: '',
    pendingArtifactId: 'pending',
    artifactHash,
    candidateArtifactHash: '',
    candidateWorkspaceHash: effectiveCandidateWorkspaceHash,
    validatorVersion,
    rulesetVersion,
    validationOptionsHash,
    validationReuseKey: expectedKind === 'validation'
      ? validationReuseKey({ candidateWorkspaceHash, validatorVersion, rulesetVersion, validationOptionsHash })
      : '',
    payload
  });
}

/**
 * Validation只能在Repository已经解析出Candidate Artifact后建立绑定。
 * 绑定字段由服务端派生，并进入Validation Artifact内容hash；调用方不能声明或覆盖。
 */
function bindValidationArtifactCandidate(validation, candidateArtifact) {
  if (!validation) return null;
  const candidateArtifactHash = safeHash(candidateArtifact?.artifactHash);
  const candidateKind = String(candidateArtifact?.artifactKind || candidateArtifact?.kind || '');
  if (candidateKind !== 'candidate' || !candidateArtifactHash) {
    throw checkpointError(
      'EXECUTION_VALIDATION_CANDIDATE_REQUIRED',
      'Validation artifact requires a resolved Candidate artifact.',
      400
    );
  }
  const artifactHash = hashJson({
    kind: 'validation',
    candidateArtifactHash,
    candidateWorkspaceHash: validation.candidateWorkspaceHash,
    validatorVersion: validation.validatorVersion,
    rulesetVersion: validation.rulesetVersion,
    validationOptionsHash: validation.validationOptionsHash,
    payload: validation.payload
  });
  return Object.freeze({
    ...validation,
    artifactHash,
    candidateArtifactHash
  });
}

function createArtifactRecord({ rootRunId, sourceRunId, artifact }) {
  if (!artifact) return null;
  const artifactId = artifact.artifactId || deterministicArtifactId(rootRunId, artifact.kind, artifact.artifactHash);
  return Object.freeze({
    version: EXECUTION_ARTIFACT_VERSION,
    artifactId,
    rootRunId: safeRunId(rootRunId),
    sourceRunId: safeRunId(sourceRunId),
    artifactKind: artifact.kind,
    artifactHash: artifact.artifactHash,
    candidateArtifactHash: artifact.candidateArtifactHash,
    candidateWorkspaceHash: artifact.candidateWorkspaceHash,
    validatorVersion: artifact.validatorVersion,
    rulesetVersion: artifact.rulesetVersion,
    validationOptionsHash: artifact.validationOptionsHash,
    validationReuseKey: artifact.validationReuseKey,
    payload: artifact.payload
  });
}

function deriveResumeDecision(checkpoint, current = {}) {
  if (!checkpoint || typeof checkpoint !== 'object') return null;
  const phase = String(checkpoint.phase || '');
  if (!EXECUTION_PHASES.has(phase)) return null;
  const staleReasons = [];
  compareBoundHash('request_revision_changed', checkpoint.requestRevisionHash, current.requestRevisionHash, staleReasons);
  compareBoundHash('task_contract_changed', checkpoint.taskContractHash, current.taskContractHash, staleReasons);
  compareBoundHash('editor_base_changed', checkpoint.editorBaseHash, current.editorBaseHash, staleReasons);
  const stale = staleReasons.length > 0;
  const checkpointValidatorVersion = boundedText(checkpoint.validatorVersion, 300);
  const checkpointRulesetVersion = boundedText(checkpoint.rulesetVersion, 300);
  const checkpointValidationOptionsHash = safeHash(checkpoint.validationOptionsHash);
  const currentValidatorVersion = boundedText(current.validatorVersion, 300);
  const currentRulesetVersion = boundedText(current.rulesetVersion, 300);
  const currentValidationOptionsHash = safeHash(current.validationOptionsHash);
  const candidateArtifactId = safeArtifactId(checkpoint.candidateArtifactId);
  const validationArtifactId = safeArtifactId(checkpoint.validationArtifactId);
  const hasValidationDerivedState = Boolean(validationArtifactId)
    || !['candidate_absent', 'candidate_ready'].includes(phase);
  const validationIdentityChanged = Boolean(candidateArtifactId && hasValidationDerivedState && (
    (currentValidatorVersion && currentValidatorVersion !== checkpointValidatorVersion)
    || (currentRulesetVersion && currentRulesetVersion !== checkpointRulesetVersion)
    || (currentValidationOptionsHash && currentValidationOptionsHash !== checkpointValidationOptionsHash)
  ));
  const engineeringPhase = phase.startsWith('engineering_');
  const effectivePhase = validationIdentityChanged && !engineeringPhase ? 'candidate_ready' : phase;
  const validatorVersion = currentValidatorVersion || checkpointValidatorVersion;
  const rulesetVersion = currentRulesetVersion || checkpointRulesetVersion;
  const validationOptionsHash = currentValidationOptionsHash || checkpointValidationOptionsHash;
  return Object.freeze({
    version: 'teacher-resume-decision-v1',
    phase: effectivePhase,
    allowedActions: Object.freeze(stale
      ? ['replan_or_clarify']
      : [...PHASE_ALLOWED_ACTIONS[effectivePhase]]),
    stale,
    staleReasons: Object.freeze(staleReasons),
    ...(candidateArtifactId ? { candidateArtifactId } : {}),
    ...(!validationIdentityChanged && validationArtifactId ? { validationArtifactId } : {}),
    requestRevisionHash: safeHash(checkpoint.requestRevisionHash),
    taskContractHash: safeHash(checkpoint.taskContractHash),
    editorBaseHash: safeHash(checkpoint.editorBaseHash),
    repairRound: boundedInteger(checkpoint.repairRound, 0, 10_000, 0),
    continuationKind: boundedText(checkpoint.metadata?.engineering?.continuationKind, 80)
      || (engineeringPhase ? 'engineering_improvement' : 'execution_completion'),
    ...(validatorVersion ? { validatorVersion } : {}),
    ...(rulesetVersion ? { rulesetVersion } : {}),
    ...(validationOptionsHash ? { validationOptionsHash } : {})
  });
}

function validationReuseKey(input = {}) {
  const candidateWorkspaceHash = safeHash(input.candidateWorkspaceHash);
  const validatorVersion = boundedText(input.validatorVersion, 300);
  const rulesetVersion = boundedText(input.rulesetVersion, 300);
  const validationOptionsHash = safeHash(input.validationOptionsHash);
  if (!candidateWorkspaceHash || !validatorVersion || !rulesetVersion || !validationOptionsHash) return '';
  return hashJson({ candidateWorkspaceHash, validatorVersion, rulesetVersion, validationOptionsHash });
}

function executionResumeProjection({
  checkpoint,
  candidateArtifact,
  validationArtifact,
  currentHashes,
  persistedAnswer
}) {
  if (!checkpoint) return undefined;
  const decision = deriveResumeDecision(checkpoint, currentHashes);
  if (!decision) return undefined;
  return Object.freeze({
    version: 'teacher-execution-resume-v1',
    lineageRootRunId: safeRunId(checkpoint.rootRunId),
    checkpointId: safeCheckpointId(checkpoint.checkpointId),
    revision: boundedInteger(checkpoint.revision, 1, Number.MAX_SAFE_INTEGER, 1),
    decision,
    ...(checkpoint.phase === 'completed' && decision.phase === 'completed' && !decision.stale && persistedAnswer
      ? { persistedAnswer: boundedUtf8Text(persistedAnswer, MAX_PERSISTED_ANSWER_BYTES) }
      : {}),
    worker: Object.freeze({
      ...(candidateArtifact ? { candidate: cloneExecutionPayload(candidateArtifact.payload) } : {}),
      ...(decision.validationArtifactId && validationArtifact
        ? { validation: cloneExecutionPayload(validationArtifact.payload) }
        : {}),
      ...(hasObjectKeys(checkpoint.repairState)
        ? { repairState: cloneExecutionPayload(checkpoint.repairState, MAX_EXECUTION_STATE_BYTES) }
        : {})
    })
  });
}

function projectPersistedAnswer(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return '';
  const answer = typeof response.directAnswer === 'string'
    ? response.directAnswer
    : typeof response.answer === 'string'
      ? response.answer
      : typeof response.answer?.directAnswer === 'string'
        ? response.answer.directAnswer
        : '';
  return boundedUtf8Text(answer, MAX_PERSISTED_ANSWER_BYTES);
}

function checkpointRecord(input) {
  const boundary = input.boundary;
  return Object.freeze({
    version: EXECUTION_CHECKPOINT_VERSION,
    checkpointId: safeCheckpointId(input.checkpointId),
    rootRunId: safeRunId(input.rootRunId),
    runId: safeRunId(input.runId),
    revision: boundedInteger(input.revision, 1, Number.MAX_SAFE_INTEGER, 1),
    phase: boundary.phase,
    candidateArtifactId: safeArtifactId(input.candidateArtifactId),
    validationArtifactId: safeArtifactId(input.validationArtifactId),
    requestRevisionHash: boundary.requestRevisionHash,
    taskContractHash: boundary.taskContractHash,
    editorBaseHash: boundary.editorBaseHash,
    validatorVersion: boundary.validatorVersion,
    rulesetVersion: boundary.rulesetVersion,
    validationOptionsHash: boundary.validationOptionsHash,
    repairRound: boundary.repairRound,
    repairState: boundary.repairState,
    knowledgeCursor: boundary.knowledgeCursor,
    metadata: boundary.metadata,
    createdAt: input.createdAt || new Date().toISOString()
  });
}

function deterministicArtifactId(rootRunId, kind, artifactHash) {
  const digest = crypto.createHash('sha256')
    .update(`${safeRunId(rootRunId)}\n${kind}\n${safeHash(artifactHash)}`, 'utf8')
    .digest('hex');
  return `execart_${digest.slice(0, 40)}`;
}

function newCheckpointId() {
  return `execcp_${crypto.randomUUID()}`;
}

function cloneExecutionPayload(value, maximumBytes = MAX_EXECUTION_PAYLOAD_BYTES) {
  let serialized;
  try {
    serialized = JSON.stringify(value ?? {});
  } catch {
    throw checkpointError('EXECUTION_ARTIFACT_INVALID', 'Execution artifact payload must be JSON serializable.', 400);
  }
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw checkpointError('EXECUTION_PAYLOAD_TOO_LARGE', 'Execution payload exceeds the persistence limit.', 413);
  }
  return JSON.parse(serialized);
}

function hasObjectKeys(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length > 0;
}

function timelineLimit(value, fallback = 50) {
  return boundedInteger(value, 1, MAX_TIMELINE_LIMIT, fallback);
}

function checkpointError(code, message, statusCode) {
  return new ExecutionCheckpointError(code, message, statusCode);
}

function assertPhaseAssets(phase, refs) {
  const candidateRequired = [
    'candidate_ready',
    'validation_pending',
    'validation_failed',
    'repair_in_progress',
    'validated_passed',
    'engineering_assessment_started',
    'engineering_assessment_completed',
    'engineering_improvement_pending',
    'engineering_improvement_admitted',
    'engineering_improvement_skipped',
    'engineering_revision_in_progress',
    'engineering_verification_started',
    'engineering_verification_completed',
    'finalization_pending',
    'completed'
  ].includes(phase);
  const validationRequired = [
    'validation_failed',
    'repair_in_progress',
    'validated_passed',
    'engineering_assessment_started',
    'engineering_assessment_completed',
    'engineering_improvement_pending',
    'engineering_improvement_admitted',
    'engineering_improvement_skipped',
    'engineering_revision_in_progress',
    'engineering_verification_started',
    'engineering_verification_completed',
    'finalization_pending',
    'completed'
  ].includes(phase);
  if (candidateRequired && !refs.candidateArtifactId) {
    throw checkpointError('EXECUTION_CHECKPOINT_CANDIDATE_REQUIRED', `Phase ${phase} requires a Candidate artifact.`, 400);
  }
  if (validationRequired && !refs.validationArtifactId) {
    throw checkpointError('EXECUTION_CHECKPOINT_VALIDATION_REQUIRED', `Phase ${phase} requires a Validation artifact.`, 400);
  }
}

function compareBoundHash(reason, stored, current, output) {
  const storedHash = safeHash(stored);
  const currentHash = safeHash(current);
  if (storedHash && currentHash && storedHash !== currentHash) output.push(reason);
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function boundedText(value, maximum) {
  return String(value || '').trim().slice(0, maximum);
}

function boundedUtf8Text(value, maximumBytes) {
  const text = String(value || '').trim();
  if (Buffer.byteLength(text, 'utf8') <= maximumBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
  }
  return text.slice(0, end);
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizedText(value, maximum) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, maximum);
}

function normalizedTextList(value, maximumItems, maximumText) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => normalizedText(item?.text ?? item, maximumText))
    .filter(Boolean))]
    .sort(stableTextCompare)
    .slice(0, maximumItems);
}

function normalizedTaskItems(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { id: '', text: normalizedText(item, 2_000), required: false };
    }
    return {
      id: boundedText(item.id ?? item.todoId ?? item.taskId, 240),
      text: normalizedText(item.text ?? item.title ?? item.description, 2_000),
      required: item.required === true
    };
  }).filter((item) => item.id || item.text)
    .sort((left, right) => stableTextCompare(JSON.stringify(left), JSON.stringify(right)))
    .slice(0, 100);
}

function normalizedEditorBaseFiles(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((file, index) => {
    const safe = objectValue(file);
    const path = normalizedPath(safe.path || `model-${index + 1}.sysml`);
    const content = String(safe.content || '').replace(/\r\n?/g, '\n');
    return {
      path,
      contentHash: hashJson(content),
      editable: safe.editable !== false,
      source: boundedText(safe.source, 120),
      loadPolicy: boundedText(safe.loadPolicy, 120)
    };
  }).sort((left, right) => stableTextCompare(left.path, right.path)
    || stableTextCompare(left.contentHash, right.contentHash));
}

function normalizedPath(value) {
  return String(value || '').trim().replace(/\\/g, '/').slice(0, 500);
}

function stableTextCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeHash(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^sha256:[0-9a-f]{64}$/.test(text) ? text : '';
}

function safeRunId(value) {
  const text = String(value || '').trim();
  return /^run_[a-zA-Z0-9-]{8,160}$/.test(text) ? text : '';
}

function safeArtifactId(value) {
  const text = String(value || '').trim();
  return /^execart_[a-zA-Z0-9-]{8,160}$/.test(text) ? text : '';
}

function normalizeArtifactReference(value) {
  if (value === undefined || value === null || value === '') return '';
  const artifactId = safeArtifactId(value);
  if (!artifactId) {
    throw checkpointError('EXECUTION_ARTIFACT_ID_INVALID', 'Execution artifact reference is invalid.', 400);
  }
  return artifactId;
}

function safeCheckpointId(value) {
  const text = String(value || '').trim();
  return /^execcp_[a-zA-Z0-9-]{8,160}$/.test(text) ? text : '';
}

function hashJson(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value ?? null), 'utf8').digest('hex')}`;
}

module.exports = {
  EXECUTION_PHASES,
  ExecutionCheckpointError,
  checkpointError,
  checkpointRecord,
  bindValidationArtifactCandidate,
  cloneExecutionPayload,
  createArtifactRecord,
  deriveExecutionInputHashes,
  deriveResumeDecision,
  executionResumeProjection,
  newCheckpointId,
  normalizeExecutionBoundary,
  projectPersistedAnswer,
  timelineLimit,
  validationReuseKey
};
