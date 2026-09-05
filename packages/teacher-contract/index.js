'use strict';
const { sysmlCodeBlocks } = require('./candidate-content');

const crypto = require('crypto');
const OFFICIAL_VALIDATOR_ARTIFACT_MANIFEST = require('./official-validator-runtime-artifacts.json');
const taskLifecycleContract = require('./task-lifecycle-contract');

const CONTRACT_VERSION = '1.0';
const MODEL_CAPABILITY_SNAPSHOT_VERSION = 2;
const SUPPORTED_MODEL_CAPABILITY_SNAPSHOT_VERSIONS = Object.freeze([1, 2]);
const MODEL_PROTOCOL_MODES = Object.freeze([
  'gateway-chat-v1',
  'generic-openai',
  'deepseek-v4-litellm',
  'glm-5.2-litellm'
]);
const BOOTSTRAP_MODEL_CONTEXT_WINDOW_TOKENS = 64_000;
const MAX_EDITOR_FILES = 20;
const MAX_RESPONSE_SECTIONS = 12;
const MAX_RESPONSE_EVIDENCE = 20;
const MAX_RESPONSE_PATCHES = 5;
const MAX_PATCH_OPERATIONS = 20;

const VALID_CONFIDENCE = new Set(['low', 'medium', 'high']);
const VALID_VALIDATOR_STATUS = new Set([
  'not_applicable',
  'not_validated',
  'validated_passed',
  'validated_failed',
  'validator_unavailable',
  'passed',
  'failed',
  'unavailable'
]);
const VALID_APPLY_POLICY = new Set(['user_confirm_required', 'disabled', 'copy_only']);
const VALID_PATCH_OPS = new Set(['replaceRange']);
const VALID_EVIDENCE_LEVELS = new Set(['A', 'B', 'C', 'D', 'E']);
const VALID_EDITOR_FOCUS = new Set(['focused', 'blurred', 'not-mounted']);
const VALID_INTERACTION_TARGET = new Set(['code', 'diagnostic', 'course-content', 'ai-panel', 'non-code', 'unknown']);
const VALID_CURSOR_ORIGIN = new Set(['current', 'frozen-explicit', 'last-known', 'default']);
const VALID_SELECTION_ORIGIN = new Set(['current', 'frozen-explicit', 'last-known', 'none']);
const VALID_CODE_VALIDATION_SCOPE = new Set(['candidate_file', 'candidate_workspace_changed_line']);
const DIAGNOSTIC_ID_PATTERN = /^diag-[0-9a-f]{8}$/;
const OFFICIAL_VALIDATOR_SOURCE = OFFICIAL_VALIDATOR_ARTIFACT_MANIFEST.source;
const OFFICIAL_VALIDATOR_RELEASE = OFFICIAL_VALIDATOR_ARTIFACT_MANIFEST.releaseTag;
const OFFICIAL_VALIDATOR_KERNEL = OFFICIAL_VALIDATOR_ARTIFACT_MANIFEST.kernelVersion;
const TRUSTED_OFFICIAL_VALIDATOR_ATTESTATION = Object.freeze({
  source: OFFICIAL_VALIDATOR_SOURCE,
  releaseTag: OFFICIAL_VALIDATOR_RELEASE,
  kernelVersion: OFFICIAL_VALIDATOR_KERNEL,
  jarHash: OFFICIAL_VALIDATOR_ARTIFACT_MANIFEST.components.jarHash,
  libraryHash: OFFICIAL_VALIDATOR_ARTIFACT_MANIFEST.components.libraryHash,
  wrapperHash: OFFICIAL_VALIDATOR_ARTIFACT_MANIFEST.components.wrapperHash,
  artifactHash: OFFICIAL_VALIDATOR_ARTIFACT_MANIFEST.artifactHash
});

function validateHostContextEnvelope(value) {
  const errors = [];
  if (!isObject(value)) {
    return fail('HostContextEnvelope must be an object');
  }

  requireString(value.contractVersion, 'contractVersion', errors);
  requireString(value.requestId, 'requestId', errors);
  requireObject(value.host, 'host', errors);
  requireObject(value.tenant, 'tenant', errors);
  requireObject(value.course, 'course', errors);
  requireObject(value.editor, 'editor', errors);
  requireObject(value.question, 'question', errors);
  if (value.clarificationCheckpointId !== undefined
    && !/^clar_[a-zA-Z0-9-]{8,120}$/.test(String(value.clarificationCheckpointId))) {
    errors.push('clarificationCheckpointId is invalid');
  }
  if (value.automaticContinuationSourceRunId !== undefined
    && !/^run_[a-zA-Z0-9-]{8,160}$/.test(String(value.automaticContinuationSourceRunId))) {
    errors.push('automaticContinuationSourceRunId is invalid');
  }
  if (value.manualContinuationSourceRunId !== undefined
    && !/^run_[a-zA-Z0-9-]{8,160}$/.test(String(value.manualContinuationSourceRunId))) {
    errors.push('manualContinuationSourceRunId is invalid');
  }
  if (value.manualContinuationKind !== undefined
    && value.manualContinuationKind !== 'engineering_feedback') {
    errors.push('manualContinuationKind is invalid');
  }
  if (value.manualContinuationKind !== undefined && value.manualContinuationSourceRunId === undefined) {
    errors.push('manualContinuationKind requires manualContinuationSourceRunId');
  }
  const continuationEntrypoints = [
    value.clarificationCheckpointId,
    value.automaticContinuationSourceRunId,
    value.manualContinuationSourceRunId
  ].filter((entry) => entry !== undefined);
  if (continuationEntrypoints.length > 1) {
    errors.push('clarification, automatic continuation, and manual continuation cannot be requested together');
  }

  if (value.contractVersion && !String(value.contractVersion).startsWith('1.')) {
    errors.push('contractVersion must be compatible with 1.x');
  }

  if (isObject(value.host)) {
    requireString(value.host.hostAppId, 'host.hostAppId', errors);
    requireString(value.host.integrationMode, 'host.integrationMode', errors);
  }

  if (isObject(value.tenant)) {
    requireString(value.tenant.tenantId, 'tenant.tenantId', errors);
    requireObject(value.tenant.dataPolicy, 'tenant.dataPolicy', errors);
  }

  if (isObject(value.course)) {
    requireString(value.course.coursePackId, 'course.coursePackId', errors);
    if (value.course.courseRuleMode !== undefined
      && !['none', 'lesson_after_official_pass'].includes(value.course.courseRuleMode)) {
      errors.push('course.courseRuleMode must be none or lesson_after_official_pass when provided');
    }
    if (value.course.learningGoals !== undefined && !Array.isArray(value.course.learningGoals)) {
      errors.push('course.learningGoals must be an array when provided');
    }
  }

  if (isObject(value.editor)) {
    requireString(value.editor.language, 'editor.language', errors);
    requireString(value.editor.entryFile, 'editor.entryFile', errors);
    requireString(value.editor.activeFilePath, 'editor.activeFilePath', errors);
    if (!Array.isArray(value.editor.files)) {
      errors.push('editor.files must be an array');
    } else {
      if (value.editor.files.length < 1) errors.push('editor.files must include at least one file');
      if (value.editor.files.length > MAX_EDITOR_FILES) errors.push(`editor.files must include at most ${MAX_EDITOR_FILES} files`);
      value.editor.files.forEach((file, index) => validateEditorFile(file, `editor.files[${index}]`, errors));
    }
    if (value.editor.selection !== undefined && !isObject(value.editor.selection)) {
      errors.push('editor.selection must be an object when provided');
    }
    if (value.editor.cursor !== undefined && !isObject(value.editor.cursor)) {
      errors.push('editor.cursor must be an object when provided');
    }
    if (isGroundingContractVersion(value.contractVersion)) {
      validateStrictEditorGrounding(value.editor, errors);
    }
  }

  if (isObject(value.diagnostics)) {
    if (value.diagnostics.officialValidator !== undefined && !Array.isArray(value.diagnostics.officialValidator)) {
      errors.push('diagnostics.officialValidator must be an array when provided');
    }
    if (value.diagnostics.courseRules !== undefined && !Array.isArray(value.diagnostics.courseRules)) {
      errors.push('diagnostics.courseRules must be an array when provided');
    }
    validateDiagnosticContext(value.diagnostics, errors);
  }

  if (isObject(value.question)) {
    if (typeof value.question.text !== 'string') errors.push('question.text must be a string');
    if (value.question.intent !== undefined && typeof value.question.intent !== 'string') {
      errors.push('question.intent must be a string when provided');
    }
    if (value.question.operation !== undefined && value.question.operation !== 'repair') {
      errors.push('question.operation must be repair when provided');
    }
  }

  if (value.runtimeAssignment !== undefined) {
    if (!isObject(value.runtimeAssignment)) {
      errors.push('runtimeAssignment must be an object when provided');
    } else if (value.runtimeAssignment.workflowVersion !== undefined
      && value.runtimeAssignment.workflowVersion !== 'intent-orchestrator-v2') {
      errors.push('runtimeAssignment.workflowVersion must be intent-orchestrator-v2');
    } else if (value.runtimeAssignment.modelCapabilitySnapshot !== undefined) {
      const capabilityValidation = validateModelCapabilitySnapshot(
        value.runtimeAssignment.modelCapabilitySnapshot
      );
      errors.push(...capabilityValidation.errors);
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: normalizeHostContextEnvelope(value) };
}

function validateTeacherCapabilityResponse(value, context) {
  const errors = [];
  if (!isObject(value)) {
    return fail('TeacherCapabilityResponse must be an object');
  }

  requireString(value.contractVersion, 'contractVersion', errors);
  requireString(value.responseId, 'responseId', errors);
  requireString(value.requestId, 'requestId', errors);
  requireString(value.answerType, 'answerType', errors);
  requireString(value.title, 'title', errors);
  requireString(value.confidence, 'confidence', errors);
  requireString(value.directAnswer, 'directAnswer', errors);

  if (value.contractVersion && !String(value.contractVersion).startsWith('1.')) {
    errors.push('contractVersion must be compatible with 1.x');
  }
  if (value.confidence && !VALID_CONFIDENCE.has(value.confidence)) {
    errors.push('confidence must be low, medium, or high');
  }
  if (value.validatorStatus && !VALID_VALIDATOR_STATUS.has(value.validatorStatus)) {
    errors.push('validatorStatus is not supported');
  }
  validateSections(value.sections, errors);
  validateEvidenceList(value.evidence, errors);
  validatePatchList(value.patches, context, errors);
  validateAgentResponse(value, context, errors);
  if (value.warnings !== undefined && !Array.isArray(value.warnings)) {
    errors.push('warnings must be an array when provided');
  }
  if (value.learningEvents !== undefined && !Array.isArray(value.learningEvents)) {
    errors.push('learningEvents must be an array when provided');
  }

  return errors.length ? { ok: false, errors } : { ok: true, value };
}

function validateAgentResponse(value, context, errors) {
  const isAgent = value.runtimeUsed === 'ai-sdk' || value.agentTrace !== undefined;
  if (!isAgent) return;
  if (value.runtimeUsed !== 'ai-sdk') errors.push('runtimeUsed must be ai-sdk when agentTrace is provided');
  requireString(value.runtimeAssignmentId, 'runtimeAssignmentId', errors);
  requireString(value.toolSchemaVersion, 'toolSchemaVersion', errors);
  requireString(value.buildVersion, 'buildVersion', errors);
  requireString(value.promptVersion, 'promptVersion', errors);
  if (value.workflowVersion !== 'intent-orchestrator-v2') {
    errors.push('workflowVersion must be intent-orchestrator-v2');
  }
  if (!isSha256Hash(value.promptHash)) errors.push('promptHash must be a sha256 hash');
  if (!Number.isFinite(value.temperature)) errors.push('temperature must be a finite number');
  if (!['provider-managed', 'max', 'high', 'medium', 'disabled'].includes(value.reasoningMode)) {
    errors.push('reasoningMode must be provider-managed, max, high, medium, or disabled');
  }
  if (value.modelAlias !== undefined) errors.push('modelAlias must not be exposed in a student-facing response');
  if (context?.requestId && value.requestId !== context.requestId) errors.push('requestId must match the HostContextEnvelope');
  if (Array.isArray(value.patches) && value.patches.length > 0) {
    errors.push('Agent responses must not expose directly applicable patches');
  }

  validateAgentTrace(value.agentTrace, errors);
  if (value.workflowVersion !== undefined
    && value.agentTrace?.workflowVersion !== undefined
    && value.workflowVersion !== value.agentTrace.workflowVersion) {
    errors.push('workflowVersion must match agentTrace.workflowVersion');
  }
  validateKnowledgeGrounding(value.knowledgeGrounding, errors);
  if (value.knowledgeAttestations !== undefined) {
    errors.push('knowledgeAttestations is internal-only and must not be exposed');
  }
  if (value.answerMode !== 'result_bound_v2') {
    errors.push('answerMode must be result_bound_v2 for Agent responses');
  }
  if (value.accuracyReview !== undefined) {
    errors.push('accuracyReview is no longer supported; semantic review belongs in evaluation artifacts');
  }
  if (value.feedbackEvaluation !== undefined) errors.push('feedbackEvaluation is retired');
  validateAnswerCompletion(value, errors);
  validateCandidateDelivery(value, errors);
  validateClarification(value, errors);
  validateExecutionContinuation(value, errors);
  if (value.alignmentReview !== undefined) errors.push('alignmentReview is retired');
  if (value.judgeEvaluation !== undefined) errors.push('judgeEvaluation is not supported');
  if (value.claimGateAttestation !== undefined) errors.push('claimGateAttestation is not supported');
  const candidateHash = value.candidateWorkspaceHash;
  if (candidateHash !== undefined && !isSha256Hash(candidateHash)) {
    errors.push('candidateWorkspaceHash must be a sha256 hash when provided');
  }
  validateCandidateAttestation(value.candidateAttestation, value, errors);
  validateCodeBlockAttestations(value.codeBlockValidations, value, context, errors);
}

function validateExecutionContinuation(value, errors) {
  const continuation = value.continuation;
  if (continuation === undefined) return;
  if (!isObject(continuation)) {
    errors.push('continuation must be an object');
    return;
  }
  if (!['automatic_pending', 'complete', 'user_confirmation_required'].includes(continuation.status)) {
    errors.push('continuation.status is not supported');
  }
  if (typeof continuation.autoContinuationUsed !== 'boolean') {
    errors.push('continuation.autoContinuationUsed must be boolean');
  }
  if (typeof continuation.canContinue !== 'boolean') {
    errors.push('continuation.canContinue must be boolean');
  }
  if (continuation.sourceRunId !== undefined
    && !/^run_[a-zA-Z0-9-]{8,160}$/.test(String(continuation.sourceRunId))) {
    errors.push('continuation.sourceRunId is invalid');
  }
  validateContinuationItems(continuation.completedItems, 'continuation.completedItems', errors);
  validateContinuationItems(continuation.remainingItems, 'continuation.remainingItems', errors);
  if (continuation.status === 'complete' && continuation.canContinue) {
    errors.push('complete continuation must not allow another continuation');
  }
  if (continuation.status === 'automatic_pending' && continuation.autoContinuationUsed) {
    errors.push('automatic_pending continuation must not be marked used');
  }
}

function validateContinuationItems(value, path, errors) {
  if (!Array.isArray(value) || value.length > 12) {
    errors.push(`${path} must be an array with at most 12 items`);
    return;
  }
  value.forEach((item, index) => {
    if (!isObject(item)) {
      errors.push(`${path}[${index}] must be an object`);
      return;
    }
    requireString(item.title, `${path}[${index}].title`, errors);
    if (item.detail !== undefined && typeof item.detail !== 'string') {
      errors.push(`${path}[${index}].detail must be a string when provided`);
    }
    if (item.status !== undefined && !['completed', 'validated', 'remaining', 'blocked'].includes(item.status)) {
      errors.push(`${path}[${index}].status is not supported`);
    }
  });
}

function validateAnswerCompletion(value, errors) {
  const status = value.answerCompletionStatus;
  if (status === undefined) return;
  if (!['complete', 'incomplete', 'insufficient_evidence', 'unverified', 'not_required', 'waiting_for_clarification'].includes(status)) {
    errors.push('answerCompletionStatus is not supported');
    return;
  }
  if (value.answerContractHash !== undefined || value.coverageReviewHash !== undefined) {
    errors.push('V2 answer completion must not expose retired contract or coverage hashes');
  }
}

function validateCandidateDelivery(value, errors) {
  const status = value.candidateDeliveryStatus;
  if (status === undefined) return;
  if (!['changed_delivered', 'no_change', 'incomplete', 'not_required'].includes(status)) {
    errors.push('candidateDeliveryStatus is not supported');
    return;
  }
  if (status === 'incomplete' && value.answerCompletionStatus === 'complete') {
    errors.push('incomplete candidate delivery must not mark the answer complete');
  }
}

function validateClarification(value, errors) {
  const clarification = value.clarification;
  if (clarification === undefined) {
    if (value.answerCompletionStatus === 'waiting_for_clarification') {
      errors.push('waiting_for_clarification requires clarification');
    }
    return;
  }
  if (!isObject(clarification)) {
    errors.push('clarification must be an object');
    return;
  }
  if (!/^clar_[a-zA-Z0-9-]{8,120}$/.test(String(clarification.checkpointId || ''))) {
    errors.push('clarification.checkpointId is invalid');
  }
  if (clarification.status !== 'waiting') errors.push('clarification.status must be waiting');
  requireString(clarification.question, 'clarification.question', errors);
  if (clarification.options !== undefined) {
    if (!Array.isArray(clarification.options) || clarification.options.length < 2 || clarification.options.length > 5) {
      errors.push('clarification.options must contain 2 to 5 choices');
    } else {
      clarification.options.forEach((option, index) => {
        if (!isObject(option)) errors.push(`clarification.options[${index}] must be an object`);
        else {
          requireString(option.optionId, `clarification.options[${index}].optionId`, errors);
          requireString(option.label, `clarification.options[${index}].label`, errors);
        }
      });
    }
  }
  if (!Number.isFinite(Date.parse(String(clarification.expiresAt || '')))) {
    errors.push('clarification.expiresAt must be an ISO timestamp');
  }
  if (value.answerCompletionStatus !== 'waiting_for_clarification') {
    errors.push('clarification requires waiting_for_clarification');
  }
  if (value.directAnswer !== clarification.question) {
    errors.push('clarification.question must match directAnswer');
  }
}

function validateAgentTrace(agentTrace, errors) {
  if (!isObject(agentTrace)) {
    errors.push('agentTrace must be an object for Agent responses');
    return;
  }
  if (agentTrace.toolCalls !== undefined) {
    errors.push('agentTrace.toolCalls is internal-only and must not be exposed');
  }
  if (agentTrace.workflowVersion !== 'intent-orchestrator-v2') {
    errors.push('agentTrace.workflowVersion must be intent-orchestrator-v2');
    return;
  }
  const allowed = new Set([
      'workflowVersion',
      'status',
      'workerType',
      'candidateValidated',
      'stepCount',
      'stopReason',
      'stopCause',
      'scopeHintCount',
      'refusedHintCount',
      'gateCallCount',
      'gateDecisionStatus',
      'gateOutcome',
      'phaseTimings'
    ]);
  for (const key of Object.keys(agentTrace)) {
    if (!allowed.has(key)) errors.push(`agentTrace.${key} is not allowed for intent-orchestrator-v2`);
  }
  if (!['completed', 'rejected', 'failed'].includes(agentTrace.status)) {
    errors.push('agentTrace.status is not supported for intent-orchestrator-v2');
  }
  if (agentTrace.workerType !== 'main') errors.push('agentTrace.workerType must be main for intent-orchestrator-v2');
  if (typeof agentTrace.candidateValidated !== 'boolean') {
    errors.push('agentTrace.candidateValidated must be boolean for intent-orchestrator-v2');
  }
  for (const field of ['stepCount', 'scopeHintCount', 'refusedHintCount', 'gateCallCount']) {
    if (!Number.isInteger(agentTrace[field]) || agentTrace[field] < 0) {
      errors.push(`agentTrace.${field} must be a non-negative integer`);
    }
  }
  if (![
    'completed',
    'step_limit',
    'cancelled',
    'timeout',
    'hard_timeout',
    'repair_step_timeout',
    'validator_queue_full',
    'validator_queue_timeout',
    'validator_execution_timeout',
    'validator_unavailable',
    'provider_error',
    'policy_violation'
  ].includes(agentTrace.stopReason)) {
    errors.push('agentTrace.stopReason is not supported for intent-orchestrator-v2');
  }
  if (agentTrace.stopCause !== undefined
    && !['caller_cancelled', 'work_deadline_reached', 'hard_deadline_reached'].includes(agentTrace.stopCause)) {
    errors.push('agentTrace.stopCause is not supported for intent-orchestrator-v2');
  }
  if (!['pass', 'mixed_scope_risk', 'reject'].includes(agentTrace.gateOutcome)) {
    errors.push('agentTrace.gateOutcome is not supported for intent-orchestrator-v2');
  }
  if (!['completed', 'incomplete'].includes(agentTrace.gateDecisionStatus)) {
    errors.push('agentTrace.gateDecisionStatus is not supported for intent-orchestrator-v2');
  }
  if (!Array.isArray(agentTrace.phaseTimings) || agentTrace.phaseTimings.length > 8) {
    errors.push('agentTrace.phaseTimings must contain at most 8 items for intent-orchestrator-v2');
  } else {
    agentTrace.phaseTimings.forEach((item, index) => {
      if (!isObject(item)
        || typeof item.phase !== 'string'
        || !Number.isInteger(item.durationMs) || item.durationMs < 0
        || !Number.isInteger(item.occurrences) || item.occurrences < 0) {
        errors.push(`agentTrace.phaseTimings[${index}] is invalid`);
      }
    });
  }
}

function validateKnowledgeGrounding(grounding, errors) {
  if (!isObject(grounding)) {
    errors.push('knowledgeGrounding must be an object for Agent responses');
    return;
  }
  if (typeof grounding.used !== 'boolean') errors.push('knowledgeGrounding.used must be boolean');
  for (const field of ['uniqueClaimCount', 'uniqueEvidenceCount']) {
    if (!Number.isInteger(grounding[field]) || grounding[field] < 0) {
      errors.push(`knowledgeGrounding.${field} must be a non-negative integer`);
    }
  }
  if (grounding.used === false
    && (grounding.uniqueClaimCount !== 0 || grounding.uniqueEvidenceCount !== 0)) {
    errors.push('knowledgeGrounding counts must be zero when used is false');
  }
  if (grounding.auditRef !== undefined) {
    errors.push('knowledgeGrounding.auditRef is internal-only and must not be exposed');
  }
}

function validateCandidateAttestation(attestation, response, errors) {
  if (attestation === undefined) {
    if (response.validatorStatus === 'validated_passed') {
      errors.push('candidateAttestation is required when validatorStatus=validated_passed');
    }
    return;
  }
  if (!isObject(attestation)) {
    errors.push('candidateAttestation must be an object when provided');
    return;
  }
  if (response.validatorStatus !== 'validated_passed') {
    errors.push('candidateAttestation requires validatorStatus=validated_passed');
  }
  if (attestation.validatorStatus !== 'validated_passed') errors.push('candidateAttestation.validatorStatus must be validated_passed');
  if (attestation.validatorSource !== 'official-sysml-v2-pilot-2026-04') errors.push('candidateAttestation.validatorSource is not the pinned official source');
  if (!isPinnedValidatorVersion(attestation.validatorVersion)) errors.push('candidateAttestation.validatorVersion is not a pinned artifact version');
  if (attestation.validationCompleteness !== 'official') errors.push('candidateAttestation.validationCompleteness must be official');
  if (attestation.fallbackActive !== false) errors.push('candidateAttestation.fallbackActive must be false');
  if (!isSha256Hash(attestation.candidateWorkspaceHash)) errors.push('candidateAttestation.candidateWorkspaceHash must be a sha256 hash');
  if (response.candidateWorkspaceHash !== attestation.candidateWorkspaceHash) {
    errors.push('candidateAttestation.candidateWorkspaceHash must match candidateWorkspaceHash');
  }
  if (!Array.isArray(attestation.codeBlockContentHashes)
    || attestation.codeBlockContentHashes.length === 0
    || attestation.codeBlockContentHashes.some((hash) => !isSha256Hash(hash))) {
    errors.push('candidateAttestation.codeBlockContentHashes must contain at least one sha256 hash');
  } else if (new Set(attestation.codeBlockContentHashes).size !== attestation.codeBlockContentHashes.length) {
    errors.push('candidateAttestation.codeBlockContentHashes must not contain duplicates');
  }
}

function validateOfficialValidatorAttestation(attestation, options = {}) {
  const errors = [];
  if (!isObject(attestation)) return fail('validatorAttestation must be an object');
  const expectedSource = options.source || OFFICIAL_VALIDATOR_SOURCE;
  const expectedRelease = options.releaseTag || OFFICIAL_VALIDATOR_RELEASE;
  const expectedKernel = options.kernelVersion || OFFICIAL_VALIDATOR_KERNEL;
  if (attestation.source !== expectedSource) errors.push('validatorAttestation.source mismatch');
  if (attestation.releaseTag !== expectedRelease) errors.push('validatorAttestation.releaseTag mismatch');
  if (attestation.kernelVersion !== expectedKernel) errors.push('validatorAttestation.kernelVersion mismatch');
  for (const field of ['jarHash', 'libraryHash', 'wrapperHash', 'artifactHash']) {
    if (!isSha256Hash(attestation[field])) errors.push(`validatorAttestation.${field} must be a sha256 hash`);
  }
  if (errors.length) return { ok: false, errors };
  const aggregate = {
    source: attestation.source,
    releaseTag: attestation.releaseTag,
    kernelVersion: attestation.kernelVersion,
    jarHash: attestation.jarHash,
    libraryHash: attestation.libraryHash,
    wrapperHash: attestation.wrapperHash
  };
  const computedArtifactHash = hashContent(JSON.stringify(aggregate));
  if (attestation.artifactHash !== computedArtifactHash) {
    errors.push('validatorAttestation.artifactHash does not bind the component hashes');
  }
  for (const field of ['source', 'releaseTag', 'kernelVersion', 'jarHash', 'libraryHash', 'wrapperHash', 'artifactHash']) {
    if (attestation[field] !== TRUSTED_OFFICIAL_VALIDATOR_ATTESTATION[field]) {
      errors.push(`validatorAttestation.${field} does not match the reviewed official artifact manifest`);
    }
  }
  if (options.expectedArtifactHash && attestation.artifactHash !== options.expectedArtifactHash) {
    errors.push('validatorAttestation.artifactHash does not match the trusted evaluation artifact');
  }
  return errors.length
    ? { ok: false, errors, computedArtifactHash }
    : { ok: true, value: aggregate, artifactHash: computedArtifactHash };
}

function validateCodeBlockAttestations(validations, response, context, errors) {
  if (!Array.isArray(validations)) {
    errors.push('codeBlockValidations must be an array for Agent responses');
    return;
  }
  const blocks = sysmlCodeBlocks(response.directAnswer).map(block => canonicalCodeBlockText(block.content));
  if (blocks.length !== validations.length) {
    errors.push('codeBlockValidations must match SysML code blocks one-to-one');
  }
  validations.forEach((validation, index) => {
    const prefix = `codeBlockValidations[${index}]`;
    if (!isObject(validation)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    if (validation.index !== index) errors.push(`${prefix}.index must match code block order`);
    const expectedHash = blocks[index] === undefined ? '' : hashContent(blocks[index]);
    if (!isSha256Hash(validation.contentHash) || validation.contentHash !== expectedHash) {
      errors.push(`${prefix}.contentHash must match the exact SysML code block`);
    }
    if (validation.status === 'current_model_excerpt') {
      if (validation.source !== 'trusted-editor-context') errors.push(`${prefix}.source must identify trusted editor context`);
      if (validation.validationCompleteness !== 'not_run') errors.push(`${prefix}.validationCompleteness must be not_run`);
      requireString(validation.boundFileId, `${prefix}.boundFileId`, errors);
      if (!isSha256Hash(validation.boundFileHash)) errors.push(`${prefix}.boundFileHash must be a sha256 hash`);
      const matchingFile = Array.isArray(context?.editor?.files)
        ? context.editor.files.find((file) => (
            hashContent(String(file?.content || '')) === validation.boundFileHash
            && canonicalCodeBlockText(file?.content).includes(canonicalCodeBlockText(blocks[index]))
          ))
        : undefined;
      if (!matchingFile) errors.push(`${prefix} must bind to an exact current-model excerpt`);
      return;
    }
    if (validation.status !== 'validated_passed') errors.push(`${prefix}.status must be validated_passed`);
    if (validation.source !== 'official-sysml-v2-pilot-2026-04') errors.push(`${prefix}.source is not the pinned official source`);
    if (!isPinnedValidatorVersion(validation.validatorVersion)) errors.push(`${prefix}.validatorVersion is not a pinned artifact version`);
    if (isObject(response.candidateAttestation)
      && validation.validatorVersion !== response.candidateAttestation.validatorVersion) {
      errors.push(`${prefix}.validatorVersion must match candidateAttestation.validatorVersion`);
    }
    if (validation.validationCompleteness !== 'official') errors.push(`${prefix}.validationCompleteness must be official`);
    if (validation.fallbackActive !== false) errors.push(`${prefix}.fallbackActive must be false`);
    if (validation.syntaxValid !== true || validation.semanticValid !== true) errors.push(`${prefix} must attest syntaxValid and semanticValid`);
    if (!VALID_CODE_VALIDATION_SCOPE.has(validation.validationScope)) errors.push(`${prefix}.validationScope is not supported`);
    if (!isSha256Hash(validation.candidateWorkspaceHash)
      || validation.candidateWorkspaceHash !== response.candidateWorkspaceHash) {
      errors.push(`${prefix}.candidateWorkspaceHash must match candidateWorkspaceHash`);
    }
  });
  const validatedBlocks = validations.filter((validation) => validation?.status === 'validated_passed');
  if (validatedBlocks.length > 0 && !isObject(response.candidateAttestation)) {
    errors.push('codeBlockValidations require candidateAttestation');
  }
  if (isObject(response.candidateAttestation)) {
    const hashes = validatedBlocks.map((validation) => validation?.contentHash);
    if (JSON.stringify(response.candidateAttestation.codeBlockContentHashes || []) !== JSON.stringify(hashes)) {
      errors.push('candidateAttestation.codeBlockContentHashes must match codeBlockValidations');
    }
  }
}

function canonicalCodeBlockText(value) {
  let text = String(value || '').replace(/\r\n|\r/g, '\n');
  if (text.startsWith('\n')) text = text.slice(1);
  if (text.endsWith('\n')) text = text.slice(0, -1);
  return text;
}

function isSha256Hash(value) {
  return /^sha256:[a-f0-9]{64}$/.test(String(value || ''));
}

function isPinnedValidatorVersion(value) {
  return String(value || '') === `${OFFICIAL_VALIDATOR_RELEASE}/${OFFICIAL_VALIDATOR_KERNEL}/${TRUSTED_OFFICIAL_VALIDATOR_ATTESTATION.artifactHash}`;
}

function validatePatchSuggestion(value, context) {
  const errors = [];
  validatePatch(value, context, 'patch', errors);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

function validateSingleLinePatchSuggestion(value, context) {
  const baseResult = validatePatchSuggestion(value, context);
  const errors = baseResult.ok ? [] : [...baseResult.errors];
  if (!isObject(value)) return { ok: false, errors };
  const operations = Array.isArray(value.operations) ? value.operations : [];
  if (operations.length !== 1) {
    errors.push('patch.operations must include exactly one operation for Phase 6A single-line suggestions');
  }
  const operation = operations[0];
  if (isObject(operation)) {
    if (operation.op !== 'replaceRange') errors.push('patch operation must be replaceRange');
    if (operation.startLine !== operation.endLine) {
      errors.push('patch operation must stay on a single line');
    }
    if (typeof operation.replacement === 'string') {
      if (/[\r\n]/.test(operation.replacement)) {
        errors.push('patch operation replacement must not contain newlines');
      }
      if (!operation.replacement.trim()) {
        errors.push('patch operation replacement must contain code text');
      }
      if (operation.replacement.length > 240) {
        errors.push('patch operation replacement must stay under 240 characters');
      }
    }
    const file = getContextFiles(context).get(value.baseFilePath);
    if (file && Number.isInteger(operation.startLine)) {
      const lines = String(file.content || '').split(/\r\n|\r|\n/);
      const line = lines[operation.startLine - 1] || '';
      const maxColumn = line.length + 1;
      if (Number.isInteger(operation.startColumn) && operation.startColumn > maxColumn) {
        errors.push('patch operation startColumn is outside the target line');
      }
      if (Number.isInteger(operation.endColumn) && operation.endColumn > maxColumn) {
        errors.push('patch operation endColumn is outside the target line');
      }
      if (
        Number.isInteger(operation.startColumn)
        && Number.isInteger(operation.endColumn)
        && operation.endColumn < operation.startColumn
      ) {
        errors.push('patch operation endColumn must be greater than or equal to startColumn');
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

function applySingleLinePatchSuggestion(patch, context) {
  const validation = validateSingleLinePatchSuggestion(patch, context);
  if (!validation.ok) return validation;
  const operation = patch.operations[0];
  const files = (context.editor.files || []).map((file) => ({ ...file }));
  const target = files.find((file) => file.path === patch.baseFilePath);
  if (!target) return { ok: false, errors: ['patch target file was not found'] };
  const content = String(target.content || '');
  const startOffset = lineColumnToOffset(content, operation.startLine, operation.startColumn);
  const endOffset = lineColumnToOffset(content, operation.endLine, operation.endColumn);
  target.content = `${content.slice(0, startOffset)}${operation.replacement}${content.slice(endOffset)}`;
  return { ok: true, files, content: target.content };
}

function hashContent(content) {
  return `sha256:${crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex')}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateRequestSize(byteLength, maxBytes) {
  if (!Number.isFinite(byteLength) || byteLength < 0) return { ok: false, errors: ['request size must be a non-negative number'] };
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) return { ok: false, errors: ['request max bytes must be a positive integer'] };
  if (byteLength > maxBytes) return { ok: false, errors: [`request body exceeds ${maxBytes} bytes`] };
  return { ok: true, errors: [] };
}

function redactSecrets(value, secretValues) {
  const secrets = normalizeSecrets(secretValues);
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) {
    text = text.split(secret).join('[redacted]');
  }
  text = text.replace(/(api[_-]?key|authorization|bearer)\s*[:=]\s*["']?[^"'\s,}]+/gi, '$1=[redacted]');
  return text;
}

function containsSecret(value, secretValues) {
  const secrets = normalizeSecrets(secretValues);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return secrets.some((secret) => secret && text.includes(secret));
}

function publicError(code, message, status) {
  return {
    error: {
      code,
      message,
      status
    }
  };
}

function normalizeHostContextEnvelope(value) {
  const clone = JSON.parse(JSON.stringify(value));
  clone.editor.files = clone.editor.files.map((file) => ({
    path: file.path,
    content: String(file.content || ''),
    editable: file.editable === undefined ? true : Boolean(file.editable),
    source: file.source || 'unknown'
  }));
  normalizeEditorGrounding(clone.editor);
  if (!clone.model) clone.model = { modelElements: [], symbolsSummary: {} };
  clone.diagnostics = normalizeDiagnosticContext(clone.diagnostics);
  if (!clone.courseContext) clone.courseContext = {};
  return clone;
}

function validateDiagnosticContext(diagnostics, errors) {
  const entries = [
    ...(Array.isArray(diagnostics.officialValidator) ? diagnostics.officialValidator : []),
    ...(Array.isArray(diagnostics.courseRules) ? diagnostics.courseRules : [])
  ];
  const canonicalIds = new Set();
  entries.forEach((diagnostic, index) => {
    const prefix = `diagnostics.entries[${index}]`;
    if (!isObject(diagnostic)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    const canonicalId = diagnosticIdFor(diagnostic);
    canonicalIds.add(canonicalId);
    if (diagnostic.diagnosticId !== undefined) {
      if (typeof diagnostic.diagnosticId !== 'string' || !DIAGNOSTIC_ID_PATTERN.test(diagnostic.diagnosticId)) {
        errors.push(`${prefix}.diagnosticId is not supported`);
      } else if (diagnostic.diagnosticId !== canonicalId) {
        errors.push(`${prefix}.diagnosticId must match the canonical diagnostic content`);
      }
    }
  });

  const activeDiagnosticId = diagnostics.activeDiagnosticId;
  if (activeDiagnosticId === undefined || activeDiagnosticId === null || activeDiagnosticId === '') return;
  if (typeof activeDiagnosticId !== 'string' || !DIAGNOSTIC_ID_PATTERN.test(activeDiagnosticId)) {
    errors.push('diagnostics.activeDiagnosticId is not supported');
  } else if (!canonicalIds.has(activeDiagnosticId)) {
    errors.push('diagnostics.activeDiagnosticId must identify a supplied diagnostic');
  }
}

function normalizeDiagnosticContext(value) {
  const diagnostics = isObject(value) ? value : {};
  const officialValidator = normalizeDiagnosticList(diagnostics.officialValidator);
  const courseRules = normalizeDiagnosticList(diagnostics.courseRules);
  const ids = new Set([...officialValidator, ...courseRules].map((item) => item.diagnosticId));
  const activeDiagnosticId = typeof diagnostics.activeDiagnosticId === 'string'
    && ids.has(diagnostics.activeDiagnosticId)
    ? diagnostics.activeDiagnosticId
    : null;
  return {
    ...diagnostics,
    officialValidator,
    courseRules,
    lastValidation: diagnostics.lastValidation || null,
    activeDiagnosticId
  };
}

function normalizeDiagnosticList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const normalized = [];
  for (const diagnostic of value) {
    if (!isObject(diagnostic)) continue;
    const diagnosticId = diagnosticIdFor(diagnostic);
    if (seen.has(diagnosticId)) continue;
    seen.add(diagnosticId);
    normalized.push({ ...diagnostic, diagnosticId });
  }
  return normalized;
}

function diagnosticIdFor(value) {
  const diagnostic = isObject(value) ? value : {};
  const signature = [
    diagnostic.source,
    diagnostic.ruleId,
    diagnostic.code,
    diagnostic.category,
    diagnostic.severity,
    diagnostic.file,
    diagnostic.line,
    diagnostic.column,
    diagnostic.message
  ].map((item) => String(item ?? '').trim()).join('\u001f');
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `diag-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function validateStrictEditorGrounding(editor, errors) {
  const files = Array.isArray(editor.files) ? editor.files : [];
  const activeFile = files.find((file) => file?.path === editor.activeFilePath);
  if (!activeFile) {
    errors.push('editor.activeFilePath must identify a file in editor.files');
    return;
  }
  const content = String(activeFile.content || '');
  validateStrictEditorPosition(editor.cursor, 'editor.cursor', content, errors);

  const selection = editor.selection;
  if (!isObject(selection)) {
    errors.push('editor.selection must be an object');
  } else {
    for (const field of ['startOffset', 'startLine', 'startColumn', 'endOffset', 'endLine', 'endColumn']) {
      if (!Number.isInteger(selection[field]) || selection[field] < (field.endsWith('Offset') ? 0 : 1)) {
        errors.push(`editor.selection.${field} must be a ${field.endsWith('Offset') ? 'non-negative' : 'positive'} integer`);
      }
    }
    if (typeof selection.text !== 'string') errors.push('editor.selection.text must be a string');
    if (typeof selection.empty !== 'boolean') errors.push('editor.selection.empty must be a boolean');
    const startValid = validatePositionConsistency({
      offset: selection.startOffset,
      line: selection.startLine,
      column: selection.startColumn
    }, 'editor.selection.start', content, errors);
    const endValid = validatePositionConsistency({
      offset: selection.endOffset,
      line: selection.endLine,
      column: selection.endColumn
    }, 'editor.selection.end', content, errors);
    if (startValid && endValid) {
      if (selection.endOffset < selection.startOffset) {
        errors.push('editor.selection end must not precede start');
      } else {
        const canonicalText = content.slice(selection.startOffset, selection.endOffset);
        if (selection.text !== canonicalText) errors.push('editor.selection.text must match the selected active-file range');
        const empty = selection.startOffset === selection.endOffset;
        if (selection.empty !== empty) errors.push('editor.selection.empty must match the selected range');
      }
    }
  }

  if (typeof editor.symbolName !== 'string') {
    errors.push('editor.symbolName must be a string');
  } else if (editor.symbolName.length > 256) {
    errors.push('editor.symbolName must stay under 256 characters');
  }

  const contextState = editor.contextState;
  if (!isObject(contextState)) {
    errors.push('editor.contextState must be an object');
    return;
  }
  if (!VALID_EDITOR_FOCUS.has(contextState.focus)) errors.push('editor.contextState.focus is not supported');
  if (!VALID_INTERACTION_TARGET.has(contextState.interactionTarget)) errors.push('editor.contextState.interactionTarget is not supported');
  if (!VALID_CURSOR_ORIGIN.has(contextState.cursorOrigin)) errors.push('editor.contextState.cursorOrigin is not supported');
  if (contextState.selectionOrigin !== undefined && !VALID_SELECTION_ORIGIN.has(contextState.selectionOrigin)) {
    errors.push('editor.contextState.selectionOrigin is not supported');
  }
  if (typeof contextState.capturedAt !== 'string' || !Number.isFinite(Date.parse(contextState.capturedAt))) {
    errors.push('editor.contextState.capturedAt must be a valid timestamp');
  }
  if (typeof contextState.documentRevision !== 'string' || !/^fnv1a32:[0-9a-f]{8}:\d+$/.test(contextState.documentRevision)) {
    errors.push('editor.contextState.documentRevision is not supported');
  }
  if (contextState.degradedReason !== undefined && typeof contextState.degradedReason !== 'string') {
    errors.push('editor.contextState.degradedReason must be a string when provided');
  }
  if (
    contextState.focus === 'focused'
    && contextState.interactionTarget === 'code'
    && contextState.cursorOrigin === 'current'
    && contextState.documentRevision === documentRevisionForText(content)
    && typeof editor.symbolName === 'string'
    && isObject(editor.cursor)
    && editor.symbolName !== symbolAt(content, editor.cursor.offset)
  ) {
    errors.push('editor.symbolName must match the current cursor position');
  }
}

function validateStrictEditorPosition(position, path, content, errors) {
  if (!isObject(position)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const field of ['offset', 'line', 'column']) {
    if (!Number.isInteger(position[field]) || position[field] < (field === 'offset' ? 0 : 1)) {
      errors.push(`${path}.${field} must be a ${field === 'offset' ? 'non-negative' : 'positive'} integer`);
    }
  }
  validatePositionConsistency(position, path, content, errors);
}

function validatePositionConsistency(position, path, content, errors) {
  if (!Number.isInteger(position?.offset) || !Number.isInteger(position?.line) || !Number.isInteger(position?.column)) return false;
  if (position.offset < 0 || position.offset > content.length) {
    errors.push(`${path}.offset is outside the active file`);
    return false;
  }
  const expected = positionAtOffset(content, position.offset);
  if (position.line !== expected.line || position.column !== expected.column) {
    errors.push(`${path} offset, line, and column must identify the same active-file position`);
    return false;
  }
  return true;
}

function normalizeEditorGrounding(editor) {
  const files = Array.isArray(editor.files) ? editor.files : [];
  const activeFile = files.find((file) => file.path === editor.activeFilePath) || files[0] || { content: '' };
  const content = String(activeFile.content || '');
  const hadCursor = isObject(editor.cursor);
  const sourceCursor = normalizeEditorPosition(editor.cursor, content);
  const sourceSelection = normalizeEditorSelection(editor.selection, sourceCursor, content);
  const suppliedState = isObject(editor.contextState) ? editor.contextState : {};
  const expectedRevision = documentRevisionForText(content);
  const documentRevision = typeof suppliedState.documentRevision === 'string'
    ? suppliedState.documentRevision
    : expectedRevision;
  const focus = VALID_EDITOR_FOCUS.has(suppliedState.focus)
    ? suppliedState.focus
    : hadCursor ? 'blurred' : 'not-mounted';
  const interactionTarget = VALID_INTERACTION_TARGET.has(suppliedState.interactionTarget)
    ? suppliedState.interactionTarget
    : 'unknown';
  const sourceOrigin = VALID_CURSOR_ORIGIN.has(suppliedState.cursorOrigin)
    ? suppliedState.cursorOrigin
    : hadCursor ? 'last-known' : 'default';
  const sourceSelectionOrigin = VALID_SELECTION_ORIGIN.has(suppliedState.selectionOrigin)
    ? suppliedState.selectionOrigin
    : sourceSelection.empty ? 'none' : sourceOrigin === 'current' ? 'current' : 'last-known';
  const suppliedSymbolName = Object.prototype.hasOwnProperty.call(editor, 'symbolName')
    && typeof editor.symbolName === 'string'
    ? editor.symbolName
    : null;
  const grounding = normalizedGroundingState({
    focus,
    interactionTarget,
    documentRevision,
    expectedRevision,
    sourceOrigin
  });
  const cursor = grounding.cursorOrigin === 'default' ? positionAtOffset(content, 0) : sourceCursor;
  const selection = grounding.cursorOrigin === 'default'
    ? normalizeEditorSelection(null, cursor, content)
    : sourceSelection;
  const selectionOrigin = normalizedSelectionOrigin({
    sourceSelectionOrigin,
    hasSelection: !selection.empty,
    cursorOrigin: grounding.cursorOrigin
  });

  editor.cursor = cursor;
  editor.selection = selection;
  editor.symbolName = grounding.cursorOrigin === 'default'
    ? ''
    : suppliedSymbolName === null ? symbolAt(content, cursor.offset) : suppliedSymbolName;
  editor.contextState = {
    focus,
    interactionTarget,
    capturedAt: typeof suppliedState.capturedAt === 'string' && Number.isFinite(Date.parse(suppliedState.capturedAt))
      ? suppliedState.capturedAt
      : new Date().toISOString(),
    documentRevision,
    cursorOrigin: grounding.cursorOrigin,
    selectionOrigin,
    degradedReason: grounding.degradedReason
  };
}

function normalizeEditorPosition(position, content) {
  if (Number.isInteger(position?.offset)) return positionAtOffset(content, position.offset);
  return positionAtOffset(content, lineColumnToOffset(content, position?.line || 1, position?.column || 1));
}

function normalizeEditorSelection(selection, cursor, content) {
  const startOffset = Number.isInteger(selection?.startOffset)
    ? selection.startOffset
    : lineColumnToOffset(content, selection?.startLine || cursor.line, selection?.startColumn || cursor.column);
  const endOffset = Number.isInteger(selection?.endOffset)
    ? selection.endOffset
    : lineColumnToOffset(content, selection?.endLine || cursor.line, selection?.endColumn || cursor.column);
  const start = positionAtOffset(content, Math.min(startOffset, endOffset));
  const end = positionAtOffset(content, Math.max(startOffset, endOffset));
  return {
    startOffset: start.offset,
    startLine: start.line,
    startColumn: start.column,
    endOffset: end.offset,
    endLine: end.line,
    endColumn: end.column,
    text: content.slice(start.offset, end.offset),
    empty: start.offset === end.offset
  };
}

function normalizedGroundingState({ focus, interactionTarget, documentRevision, expectedRevision, sourceOrigin }) {
  if (sourceOrigin === 'default' || focus === 'not-mounted') {
    return { cursorOrigin: 'default', degradedReason: 'default_context' };
  }
  if (documentRevision !== expectedRevision) {
    return { cursorOrigin: 'last-known', degradedReason: 'stale_document' };
  }
  if (sourceOrigin === 'frozen-explicit' && interactionTarget === 'ai-panel') {
    return { cursorOrigin: 'frozen-explicit', degradedReason: 'explicit_context_frozen' };
  }
  if (interactionTarget !== 'code' && interactionTarget !== 'unknown') {
    return { cursorOrigin: 'last-known', degradedReason: 'non_code_interaction' };
  }
  if (focus !== 'focused') {
    return { cursorOrigin: 'last-known', degradedReason: 'editor_blurred' };
  }
  if (interactionTarget !== 'code') {
    return { cursorOrigin: 'last-known', degradedReason: 'interaction_unknown' };
  }
  if (sourceOrigin !== 'current') {
    return { cursorOrigin: 'last-known', degradedReason: 'source_not_current' };
  }
  return { cursorOrigin: 'current', degradedReason: '' };
}

function normalizedSelectionOrigin({ sourceSelectionOrigin, hasSelection, cursorOrigin }) {
  if (!hasSelection || cursorOrigin === 'default') return 'none';
  if (cursorOrigin === 'current' && sourceSelectionOrigin === 'current') return 'current';
  if (cursorOrigin === 'frozen-explicit' && sourceSelectionOrigin === 'frozen-explicit') {
    return 'frozen-explicit';
  }
  return 'last-known';
}

function isGroundingContractVersion(value) {
  const match = String(value || '').match(/^1\.(\d+)/);
  return Boolean(match && Number(match[1]) >= 1);
}

function documentRevisionForText(value) {
  const text = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

function positionAtOffset(contentValue, offsetValue) {
  const content = String(contentValue || '');
  const offset = Math.max(0, Math.min(Number.isFinite(offsetValue) ? Math.floor(offsetValue) : 0, content.length));
  const starts = lineStarts(content);
  let lineIndex = starts.length - 1;
  while (lineIndex > 0 && starts[lineIndex] > offset) lineIndex -= 1;
  return { offset, line: lineIndex + 1, column: offset - starts[lineIndex] + 1 };
}

function lineStarts(content) {
  const starts = [0];
  const pattern = /\r\n|\r|\n/g;
  let match = pattern.exec(content);
  while (match) {
    starts.push(match.index + match[0].length);
    match = pattern.exec(content);
  }
  return starts;
}

function symbolAt(contentValue, offsetValue) {
  const content = String(contentValue || '');
  const offset = Math.max(0, Math.min(Number(offsetValue || 0), content.length));
  const left = content.slice(0, offset).match(/[A-Za-z_][A-Za-z0-9_:]*$/)?.[0] || '';
  const right = content.slice(offset).match(/^[A-Za-z0-9_:]+/)?.[0] || '';
  const symbol = `${left}${right}`;
  return /^[A-Za-z_][A-Za-z0-9_:]*$/.test(symbol) ? symbol : '';
}

function validateEditorFile(file, path, errors) {
  if (!isObject(file)) {
    errors.push(`${path} must be an object`);
    return;
  }
  requireString(file.path, `${path}.path`, errors);
  if (typeof file.content !== 'string') errors.push(`${path}.content must be a string`);
  if (file.editable !== undefined && typeof file.editable !== 'boolean') {
    errors.push(`${path}.editable must be a boolean when provided`);
  }
  if (file.source !== undefined && typeof file.source !== 'string') {
    errors.push(`${path}.source must be a string when provided`);
  }
}

function validateSections(sections, errors) {
  if (sections === undefined) return;
  if (!Array.isArray(sections)) {
    errors.push('sections must be an array when provided');
    return;
  }
  if (sections.length > MAX_RESPONSE_SECTIONS) errors.push(`sections must include at most ${MAX_RESPONSE_SECTIONS} items`);
  sections.forEach((section, index) => {
    const prefix = `sections[${index}]`;
    if (!isObject(section)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    requireString(section.kind, `${prefix}.kind`, errors);
    requireString(section.title, `${prefix}.title`, errors);
    requireString(section.content, `${prefix}.content`, errors);
  });
}

function validateEvidenceList(evidence, errors) {
  if (evidence === undefined) return;
  if (!Array.isArray(evidence)) {
    errors.push('evidence must be an array when provided');
    return;
  }
  if (evidence.length > MAX_RESPONSE_EVIDENCE) errors.push(`evidence must include at most ${MAX_RESPONSE_EVIDENCE} items`);
  evidence.forEach((item, index) => {
    const prefix = `evidence[${index}]`;
    if (!isObject(item)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    requireString(item.evidenceId, `${prefix}.evidenceId`, errors);
    requireString(item.authorityLevel, `${prefix}.authorityLevel`, errors);
    requireString(item.sourceType, `${prefix}.sourceType`, errors);
    requireString(item.sourceTitle, `${prefix}.sourceTitle`, errors);
    requireString(item.confidence, `${prefix}.confidence`, errors);
    if (item.authorityLevel && !VALID_EVIDENCE_LEVELS.has(item.authorityLevel)) {
      errors.push(`${prefix}.authorityLevel must be A, B, C, D, or E`);
    }
    if (item.confidence && !VALID_CONFIDENCE.has(item.confidence)) {
      errors.push(`${prefix}.confidence must be low, medium, or high`);
    }
  });
}

function validatePatchList(patches, context, errors) {
  if (patches === undefined) return;
  if (!Array.isArray(patches)) {
    errors.push('patches must be an array when provided');
    return;
  }
  if (patches.length > MAX_RESPONSE_PATCHES) errors.push(`patches must include at most ${MAX_RESPONSE_PATCHES} items`);
  patches.forEach((patch, index) => validatePatch(patch, context, `patches[${index}]`, errors));
}

function validatePatch(patch, context, prefix, errors) {
  if (!isObject(patch)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  requireString(patch.patchId, `${prefix}.patchId`, errors);
  requireString(patch.title, `${prefix}.title`, errors);
  requireString(patch.baseFilePath, `${prefix}.baseFilePath`, errors);
  requireString(patch.baseContentHash, `${prefix}.baseContentHash`, errors);
  if (patch.baseContentHash && !patch.baseContentHash.startsWith('sha256:')) {
    errors.push(`${prefix}.baseContentHash must start with sha256:`);
  }
  requireString(patch.previewText, `${prefix}.previewText`, errors);
  requireString(patch.validatorStatus, `${prefix}.validatorStatus`, errors);
  requireString(patch.applyPolicy, `${prefix}.applyPolicy`, errors);
  if (patch.validatorStatus && !VALID_VALIDATOR_STATUS.has(patch.validatorStatus)) {
    errors.push(`${prefix}.validatorStatus is not supported`);
  }
  if (patch.applyPolicy && !VALID_APPLY_POLICY.has(patch.applyPolicy)) {
    errors.push(`${prefix}.applyPolicy is not supported`);
  }
  if (!Array.isArray(patch.validationDiagnostics)) {
    errors.push(`${prefix}.validationDiagnostics must be an array`);
  }
  if (patch.warnings !== undefined && !Array.isArray(patch.warnings)) {
    errors.push(`${prefix}.warnings must be an array when provided`);
  }
  if (!Array.isArray(patch.operations)) {
    errors.push(`${prefix}.operations must be an array`);
    return;
  }
  if (patch.operations.length > MAX_PATCH_OPERATIONS) {
    errors.push(`${prefix}.operations must include at most ${MAX_PATCH_OPERATIONS} items`);
  }

  const filesByPath = getContextFiles(context);
  const baseFile = filesByPath.get(patch.baseFilePath);
  if (baseFile && baseFile.editable === false) {
    errors.push(`${prefix}.baseFilePath targets a read-only file`);
  }
  if (baseFile && patch.baseContentHash && patch.baseContentHash !== hashContent(baseFile.content)) {
    errors.push(`${prefix}.baseContentHash does not match the current file content`);
  }

  patch.operations.forEach((operation, index) => {
    validatePatchOperation(operation, patch, baseFile, `${prefix}.operations[${index}]`, errors);
  });
}

function validatePatchOperation(operation, patch, file, prefix, errors) {
  if (!isObject(operation)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  requireString(operation.op, `${prefix}.op`, errors);
  requireString(operation.filePath, `${prefix}.filePath`, errors);
  if (operation.op && !VALID_PATCH_OPS.has(operation.op)) errors.push(`${prefix}.op is not supported`);
  if (operation.filePath && patch.baseFilePath && operation.filePath !== patch.baseFilePath) {
    errors.push(`${prefix}.filePath must match baseFilePath before cross-file patches are enabled`);
  }
  for (const field of ['startLine', 'startColumn', 'endLine', 'endColumn']) {
    if (!Number.isInteger(operation[field]) || operation[field] < 1) errors.push(`${prefix}.${field} must be a positive integer`);
  }
  if (typeof operation.replacement !== 'string') errors.push(`${prefix}.replacement must be a string`);
  if (file && Number.isInteger(operation.startLine) && Number.isInteger(operation.endLine)) {
    const lines = String(file.content || '').split(/\r\n|\r|\n/);
    if (operation.startLine > lines.length || operation.endLine > lines.length) {
      errors.push(`${prefix} line range is outside the target file`);
    }
    if (operation.endLine < operation.startLine) {
      errors.push(`${prefix}.endLine must be greater than or equal to startLine`);
    }
  }
}

function getContextFiles(context) {
  const files = new Map();
  const input = context && context.editor && Array.isArray(context.editor.files) ? context.editor.files : [];
  for (const file of input) {
    if (file && typeof file.path === 'string') {
      files.set(file.path, {
        path: file.path,
        content: String(file.content || ''),
        editable: file.editable === undefined ? true : Boolean(file.editable)
      });
    }
  }
  return files;
}

function lineColumnToOffset(content, lineNumber, columnNumber) {
  const value = String(content || '');
  const line = Math.max(1, Number(lineNumber || 1));
  const column = Math.max(1, Number(columnNumber || 1));
  let currentLine = 1;
  let offset = 0;
  while (currentLine < line && offset < value.length) {
    const char = value[offset];
    if (char === '\r') {
      offset += value[offset + 1] === '\n' ? 2 : 1;
      currentLine += 1;
    } else if (char === '\n') {
      offset += 1;
      currentLine += 1;
    } else {
      offset += 1;
    }
  }
  return Math.min(value.length, offset + column - 1);
}

function normalizeSecrets(secretValues) {
  if (!secretValues) return [];
  const list = Array.isArray(secretValues) ? secretValues : [secretValues];
  return list.filter((value) => typeof value === 'string' && value.length >= 6);
}

function requireString(value, path, errors) {
  if (typeof value !== 'string' || value.length === 0) errors.push(`${path} must be a non-empty string`);
}

function requireObject(value, path, errors) {
  if (!isObject(value)) errors.push(`${path} must be an object`);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  return { ok: false, errors: [message] };
}

function validateModelCapabilitySnapshot(value) {
  const errors = [];
  if (!isObject(value)) return fail('modelCapabilitySnapshot must be an object');
  if (!SUPPORTED_MODEL_CAPABILITY_SNAPSHOT_VERSIONS.includes(value.schemaVersion)) {
    errors.push('modelCapabilitySnapshot.schemaVersion is not supported');
  }
  if (!Number.isInteger(value.effectiveContextWindowTokens) || value.effectiveContextWindowTokens <= 0) {
    errors.push('modelCapabilitySnapshot.effectiveContextWindowTokens must be a positive integer');
  }
  if (!isObject(value.stages)) {
    errors.push('modelCapabilitySnapshot.stages must be an object');
  } else {
    const stageWindows = Object.entries(value.stages).map(([stageId, stage]) => {
      if (!isObject(stage)) {
        errors.push(`modelCapabilitySnapshot.stages.${stageId} must be an object`);
        return null;
      }
      if (typeof stage.alias !== 'string' || !stage.alias.trim()) {
        errors.push(`modelCapabilitySnapshot.stages.${stageId}.alias is required`);
      }
      if (stage.aliasId !== undefined && (typeof stage.aliasId !== 'string' || !stage.aliasId.trim())) {
        errors.push(`modelCapabilitySnapshot.stages.${stageId}.aliasId must be a non-empty string when provided`);
      }
      if (!Number.isInteger(stage.contextWindowTokens) || stage.contextWindowTokens <= 0) {
        errors.push(`modelCapabilitySnapshot.stages.${stageId}.contextWindowTokens must be a positive integer`);
        return null;
      }
      if (value.schemaVersion >= 2) {
        if (stage.protocolStatus !== 'ready') {
          errors.push(`modelCapabilitySnapshot.stages.${stageId}.protocolStatus must be ready`);
        }
        if (!MODEL_PROTOCOL_MODES.includes(stage.protocolMode)) {
          errors.push(`modelCapabilitySnapshot.stages.${stageId}.protocolMode is not supported`);
        }
        if (typeof stage.adapterProfileId !== 'string' || !stage.adapterProfileId.trim()) {
          errors.push(`modelCapabilitySnapshot.stages.${stageId}.adapterProfileId is required`);
        }
        if (!Number.isInteger(stage.adapterProfileRevision) || stage.adapterProfileRevision <= 0) {
          errors.push(`modelCapabilitySnapshot.stages.${stageId}.adapterProfileRevision must be a positive integer`);
        }
        if (stage.modelProtocolProfileId
          && (!Number.isInteger(stage.modelProtocolProfileRevision) || stage.modelProtocolProfileRevision <= 0)) {
          errors.push(`modelCapabilitySnapshot.stages.${stageId}.modelProtocolProfileRevision must be a positive integer when a profile is present`);
        }
        if (stage.protocolMode === 'gateway-chat-v1') {
          validateGatewayExecutionPolicy(stage.executionPolicy, stageId, errors);
        }
      }
      return stage.contextWindowTokens;
    }).filter((item) => item !== null);
    if (stageWindows.length > 0
      && value.effectiveContextWindowTokens !== Math.min(...stageWindows)) {
      errors.push('modelCapabilitySnapshot.effectiveContextWindowTokens must equal the minimum stage capability');
    }
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(String(value.checksum || ''))) {
    errors.push('modelCapabilitySnapshot.checksum must be a SHA-256 identifier');
  } else {
    const { checksum, ...material } = value;
    if (checksum !== hashContent(canonicalJson(material))) {
      errors.push('modelCapabilitySnapshot.checksum does not match the snapshot content');
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateGatewayExecutionPolicy(value, stageId, errors) {
  const prefix = `modelCapabilitySnapshot.stages.${stageId}.executionPolicy`;
  if (!isObject(value)) {
    errors.push(`${prefix} must be an object for gateway-chat-v1`);
    return;
  }
  if (value.gatewayContract !== 'gateway-chat.v1') {
    errors.push(`${prefix}.gatewayContract must be gateway-chat.v1`);
  }
  if (!isObject(value.reasoning) || !['enabled', 'disabled'].includes(value.reasoning.defaultMode)) {
    errors.push(`${prefix}.reasoning is invalid`);
  } else {
    for (const mode of ['enabled', 'disabled']) {
      const branch = value.reasoning[mode];
      if (!isObject(branch) || typeof branch.supported !== 'boolean') {
        errors.push(`${prefix}.reasoning.${mode} is invalid`);
      }
    }
  }
  if (!isObject(value.toolChoice)
    || !['auto', 'omit', 'unsupported'].includes(value.toolChoice.nonThinking)
    || !['auto', 'omit', 'unsupported'].includes(value.toolChoice.thinking)) {
    errors.push(`${prefix}.toolChoice is invalid`);
  }
}

module.exports = {
  CONTRACT_VERSION,
  MODEL_CAPABILITY_SNAPSHOT_VERSION,
  BOOTSTRAP_MODEL_CONTEXT_WINDOW_TOKENS,
  TRUSTED_OFFICIAL_VALIDATOR_ATTESTATION,
  validateHostContextEnvelope,
  validateTeacherCapabilityResponse,
  validatePatchSuggestion,
  validateSingleLinePatchSuggestion,
  applySingleLinePatchSuggestion,
  validateRequestSize,
  validateOfficialValidatorAttestation,
  diagnosticIdFor,
  hashContent,
  redactSecrets,
  containsSecret,
  publicError,
  validateModelCapabilitySnapshot,
  ...taskLifecycleContract
};
