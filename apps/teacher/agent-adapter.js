'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  CONTRACT_VERSION,
  TRUSTED_OFFICIAL_VALIDATOR_ATTESTATION,
  hashContent,
  validateOfficialValidatorAttestation
} = require('../../packages/teacher-contract');
const { buildSysmlKnowledgeQueryPlan } = require('./sysml-knowledge-store');
const { searchDeepSeekDomainEvidence } = require('./deepseek-web-search');
const { deriveExecutionInputHashes } = require('./execution-checkpoint');
const {
  BOOTSTRAP_VALUES: AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES,
  runtimeProjection: agentResourcePolicyRuntimeProjection
} = require('../../packages/agent-resource-policy');

const AGENT_RESOURCE_POLICY_BOOTSTRAP_PROJECTION = agentResourcePolicyRuntimeProjection(AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES);

const TOOL_SCHEMA_VERSION = 'single-entry-v3';
// Validator transport is an independent API contract. Agent orchestration versions
// must not invalidate a compatible official Validator response.
const VALIDATOR_TOOL_SCHEMA_VERSION = 'phase9-v4';
const DEFAULT_BUILD_VERSION = 'single-entry-project-p1-v1';
const OFFICIAL_VALIDATOR_SOURCE = 'official-sysml-v2-pilot-2026-04';
const OFFICIAL_VALIDATOR_RELEASE = '2026-04';
const OFFICIAL_VALIDATOR_KERNEL = '0.59.0';
const ALL_READ_TOOLS = [
  'inspect_lesson_context',
  'inspect_current_model',
  'search_skill_guidance',
  'search_reviewed_knowledge',
  'search_engineering_domain_evidence',
  'validate_candidate_workspace'
];
const SYSML_DECLARATION_PATTERN = String.raw`(?:(?:end)\b|(?:(?:private|public|protected|abstract|variation|variant|individual|ref|derived|readonly|ordered|nonunique|in|out|inout)\s+)*(?:(?:standard\s+library\s+)?package|import|alias|dependency|succession|timeslice|snapshot|event|concern|(?:part|item|port|connection|interface|action|state|calc|constraint|requirement|analysis|verification|use\s+case|view|viewpoint|metadata|enum|occurrence|attribute)(?:\s+def)?|actor|subject|objective|stakeholder|allocate|connect|bind|flow|message|perform(?:\s+action)?|send|accept|assign|terminate|return|assert|assume|require|expose|render|first|then|transition|entry|do|exit|satisfy|verify|include\s+use\s+case|inout|in|out))\b`;

let runtimeCache = null;
let runtimeCachePath = '';
const buildVersionCache = new Map();

async function loadAgentRuntime(options = {}) {
  const modulePath = path.resolve(options.modulePath || path.join(__dirname, 'dist', 'agent', 'index.mjs'));
  if (!runtimeCache || runtimeCachePath !== modulePath) {
    runtimeCachePath = modulePath;
    runtimeCache = import(pathToFileURL(modulePath).href).then((runtime) => {
      if (runtime.TOOL_SCHEMA_VERSION !== TOOL_SCHEMA_VERSION) {
        const error = new Error('AI Teacher Agent tool schema version mismatch.');
        error.code = 'AI_TEACHER_AGENT_SCHEMA_MISMATCH';
        error.statusCode = 503;
        throw error;
      }
      if (typeof runtime.runTeacherAgent !== 'function'
        || typeof runtime.createOpenAICompatibleAgentModel !== 'function'
        || !String(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS || '')
        || !String(runtime.INTENT_ORCHESTRATOR_V2_PROMPT_VERSION || '')) {
        const error = new Error('AI Teacher Agent build is missing required exports.');
        error.code = 'AI_TEACHER_AGENT_BUILD_INVALID';
        error.statusCode = 503;
        throw error;
      }
      return runtime;
    }).catch((error) => {
      runtimeCache = null;
      throw error;
    });
  }
  return runtimeCache;
}

async function agentRuntimeReadiness(config = {}) {
  try {
    const modulePath = resolveAgentModulePath(config.agentModulePath);
    const runtime = await loadAgentRuntime({ modulePath });
    const answerMode = 'result_bound_v2';
    const policy = agentPolicy(config);
    const reasoningMode = normalizeReasoningMode(config.agentReasoningMode);
    const promptVersion = runtime.INTENT_ORCHESTRATOR_V2_PROMPT_VERSION;
    const promptInstructions = runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS;
    if (!String(promptVersion || '') || !String(promptInstructions || '')) {
      const error = new Error('AI Teacher Agent workflow prompt is unavailable.');
      error.code = 'AI_TEACHER_AGENT_BUILD_INVALID';
      throw error;
    }
    return {
      supported: true,
      ready: true,
      toolSchemaVersion: runtime.TOOL_SCHEMA_VERSION,
      buildVersion: agentBuildVersion(config, modulePath),
      promptVersion,
      promptHash: hashContent(promptInstructions),
      modelAlias: agentReasoningModelAlias(
        config,
        intentV2SelectedReasoningMode(reasoningMode)
      ),
      maxOutputTokens: policy.maxOutputTokens,
      outputBudgetMode: 'run-resource-profiled',
      temperature: policy.temperature,
      reasoningMode,
      answerMode
    };
  } catch (error) {
    return {
      supported: true,
      ready: false,
      toolSchemaVersion: TOOL_SCHEMA_VERSION,
      buildVersion: config.agentBuildVersion || DEFAULT_BUILD_VERSION,
      errorCode: String(error?.code || 'AI_TEACHER_AGENT_BUILD_UNAVAILABLE')
    };
  }
}

async function runAgentCapability(hostContext, config = {}, options = {}) {
  const modulePath = resolveAgentModulePath(config.agentModulePath);
  const runtime = await loadAgentRuntime({ modulePath });
  const answerMode = 'result_bound_v2';
  const buildVersion = agentBuildVersion(config, modulePath);
  const policy = agentPolicy(config, hostContext);
  const taskPolicy = deriveAgentTaskPolicy(hostContext);
  frozenAgentWorkflowVersion(hostContext);
  const reasoningMode = normalizeReasoningMode(config.agentReasoningMode);
  const stageModelAssignment = resolvedStageModelAssignment(config, hostContext);
  const mapped = createAgentContext(hostContext);
  const stageModels = createStageModels(runtime, config, stageModelAssignment);
  const model = stageModels.main;
  const runId = config.runId || opaqueId('run', hostContext.requestId || 'request');
  const baseDependencies = createAgentDependencies({
    hostContext,
    agentContext: mapped.context,
    fileMap: mapped.fileMap,
    config,
    knowledgeMode: taskPolicy.operation === 'repair' ? 'repair_progressive' : 'legacy'
  });
  const checkpointDependencies = createExecutionCheckpointDependencies({
    hostContext,
    runId,
    conversation: config.conversation
  });
  const dependencies = {
    ...baseDependencies,
    ...checkpointDependencies,
    ...(config.agentDependencies || {})
  };
  const lifecycle = createLifecycleRecorder({ ...config, runId });
  const auditedRun = await runtime.withModelCallAuditContext({
    runId,
    promptVersion: runtime.INTENT_ORCHESTRATOR_V2_PROMPT_VERSION,
    record: lifecycle.recordModelCall
  }, async () => await runtime.runTeacherAgent({
    model,
    modelId: stageModelAssignment.stages.main.modelAlias,
    fastGateModel: stageModels.fastGate,
    fastGateModelId: stageModelAssignment.stages.fastGate.modelAlias,
    mainModel: stageModels.main,
    mainModelId: stageModelAssignment.stages.main.modelAlias,
    candidateModel: stageModels.candidate,
    candidateModelId: stageModelAssignment.stages.candidate.modelAlias,
    repairModel: stageModels.repair,
    repairModelId: stageModelAssignment.stages.repair.modelAlias,
    semanticReviewModel: stageModels.semanticReview,
    semanticReviewModelId: stageModelAssignment.stages.semanticReview.modelAlias,
    finalizerModel: stageModels.finalizer,
    finalizerModelId: stageModelAssignment.stages.finalizer.modelAlias,
    nonThinkingModel: stageModels.fastGate,
    nonThinkingModelId: stageModelAssignment.stages.fastGate.modelAlias,
    thinkingModel: stageModels.candidate,
    thinkingModelId: stageModelAssignment.stages.candidate.modelAlias,
    finalizeVisibleAnswer: (finalizedOutcome) => {
      const rendered = renderValidatedCandidateAnswer(
        finalizedOutcome,
        mapped.fileMap,
        finalizedOutcome.response.answer
      );
      const safety = rendered || (candidateExpectedForOutcome(finalizedOutcome)
        ? enforceValidatedCodeAnswer(finalizedOutcome, hostContext, mapped.fileMap)
        : enforceAnswerCodePolicy(finalizedOutcome, hostContext, mapped.fileMap));
      return {
        answer: safety.answer,
        warnings: [
          ...(safety.rendered ? ['validated_candidate_rendered_from_terminal_ledger'] : []),
          ...(safety.modelCodeDiscarded ? ['model_generated_candidate_code_discarded'] : []),
          ...(safety.recovered ? ['validated_candidate_recovered_from_terminal_ledger'] : []),
          ...(safety.withheld ? ['unvalidated_or_unbound_code_withheld'] : []),
          ...(safety.withheldReason ? [`code_withheld_reason:${safety.withheldReason}`] : [])
        ]
      };
    },
    request: {
      runId,
      question: buildAgentQuestion(hostContext),
      currentStudentQuestion: agentStudentQuestion(hostContext, config.workflowResume),
      taskSources: authorizedTaskSources(hostContext, config.workflowResume),
      operation: taskPolicy.operation,
      evaluationMode: localBenchmarkEvaluationMode(hostContext),
      capabilityGrant: taskPolicy.capabilityGrant,
      resumeContext: projectWorkflowResumeForAgent(config.workflowResume),
      context: mapped.context
    },
    dependencies: {
      ...dependencies,
      onLifecycleEvent: lifecycle.onLifecycleEvent
    },
    reasoningMode,
    stageReasoningModes: Object.fromEntries(AGENT_STAGE_IDS.map((stageId) => [
      stageId,
      stageModelAssignment.stages[stageId].reasoningMode
    ])),
    providerOptionsName: providerName(config.llm?.providerMode),
    providerCompatibility: config.agentProviderCompatibility,
    stageProtocolProfiles: stageProtocolProfilesFromAssignment(stageModelAssignment),
    policy,
    abortSignal: config.abortSignal
  }));
  const outcome = auditedRun.value;
  if (auditedRun.failures.length > 0) {
    outcome.response.warnings = [...new Set([
      ...(outcome.response.warnings || []),
      'model_call_audit_write_failed'
    ])];
  }

  try {
    // 终态台账写入不再与Run业务加工共享Hard Deadline。API请求比Run多出的外层余量
    // 为已形成的可信终态提供一次短写入窗口；用户取消仍立即终止持久化。
    const terminalPersistenceSignal = AbortSignal.timeout(
      terminalPersistenceTimeoutMs(config)
    );
    const persistenceAbortSignal = config.abortSignal
      ? AbortSignal.any([config.abortSignal, terminalPersistenceSignal])
      : terminalPersistenceSignal;
    persistenceAbortSignal?.throwIfAborted();
    await awaitWithAbortSignal(lifecycle.persistLedger(outcome.ledger), persistenceAbortSignal);
  } catch {
    outcome.response.warnings = [...new Set([
      ...(outcome.response.warnings || []),
      'ledger_persistence_failed'
    ])];
  }
  if (!outcome.ok && !isDeliverableAgentOutcome(outcome)) throw agentOutcomeError(outcome);
  if (!outcome.ok) {
    outcome.response.warnings = [...new Set([
      ...(outcome.response.warnings || []),
      'agent_outcome_safely_degraded'
    ])];
  }
  const selectedReasoningMode = outcome.response?.reasoningRoute?.selectedMode || reasoningMode;
  const selectedModelAlias = stageModelAssignment.stages.main.modelAlias;
  const promptVersion = runtime.INTENT_ORCHESTRATOR_V2_PROMPT_VERSION;
  const promptInstructions = runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS;
  return trustedOutcomeToTeacherResponse(outcome, hostContext, mapped.fileMap, {
    buildVersion,
    provider: providerName(config.llm?.providerMode),
    model: selectedModelAlias,
    promptVersion,
    promptHash: hashContent(promptInstructions),
    temperature: policy.temperature,
    reasoningMode: selectedReasoningMode,
    answerMode,
    auditRef: runId,
    stageModelAssignment
  });
}

/** 评测控制面专用：隔离Primary生成，复用生产模型路由、Tool Adapter和Agent核心链。 */
async function runEngineeringReviewEvaluationCapability(hostContext, baselineCandidate, config = {}) {
  const modulePath = resolveAgentModulePath(config.agentModulePath);
  const runtime = await loadAgentRuntime({ modulePath });
  if (typeof runtime.runEngineeringReviewEvaluation !== 'function') {
    throw new Error('AI Teacher Agent build is missing the Engineering Review evaluation entry.');
  }
  const policy = agentPolicy(config, hostContext);
  const stageModelAssignment = resolvedStageModelAssignment(config, hostContext);
  const stageModels = createStageModels(runtime, config, stageModelAssignment);
  const mapped = createAgentContext(hostContext);
  const taskPolicy = deriveAgentTaskPolicy(hostContext);
  const runId = config.runId || opaqueId('run', `engineering-evaluation:${hostContext.requestId || 'request'}`);
  const dependencies = {
    ...createAgentDependencies({
      hostContext,
      agentContext: mapped.context,
      fileMap: mapped.fileMap,
      config,
      knowledgeMode: 'legacy'
    }),
    ...(config.agentDependencies || {})
  };
  const generationOptions = {
    model: stageModels.main,
    request: {},
    dependencies,
    reasoningMode: normalizeReasoningMode(config.agentReasoningMode),
    providerOptionsName: providerName(config.llm?.providerMode),
    providerCompatibility: config.agentProviderCompatibility,
    stageProtocolProfiles: stageProtocolProfilesFromAssignment(stageModelAssignment)
  };
  const assessmentGeneration = runtime.v2GenerationSettings(generationOptions, false, 'semanticReview');
  const verificationGeneration = runtime.v2GenerationSettings(generationOptions, true, 'semanticReview');
  const mainGeneration = runtime.v2GenerationSettings(generationOptions, true, 'main');
  const candidateGeneration = runtime.v2GenerationSettings(generationOptions, false, 'candidate');
  const repairGeneration = runtime.v2RepairGenerationSettings(generationOptions);
  const modelCalls = [];
  const currentStudentQuestion = agentStudentQuestion(hostContext, config.workflowResume);
  const taskSources = authorizedTaskSources(hostContext, config.workflowResume);
  const audited = await runtime.withModelCallAuditContext({
    runId,
    promptVersion: runtime.INTENT_ORCHESTRATOR_V2_PROMPT_VERSION,
    record: async (entry) => { modelCalls.push(entry); }
  }, async () => await runtime.runEngineeringReviewEvaluation({
    request: {
      runId,
      question: buildAgentQuestion(hostContext),
      currentStudentQuestion,
      taskSources,
      operation: taskPolicy.operation,
      capabilityGrant: taskPolicy.capabilityGrant,
      context: mapped.context
    },
    policy,
    baselineCandidate,
    assessmentModel: stageModels.semanticReview,
    assessmentModelId: stageModelAssignment.stages.semanticReview.modelAlias,
    mainModel: stageModels.main,
    mainModelId: stageModelAssignment.stages.main.modelAlias,
    candidateModel: stageModels.candidate,
    candidateModelId: stageModelAssignment.stages.candidate.modelAlias,
    repairModel: stageModels.repair,
    repairModelId: stageModelAssignment.stages.repair.modelAlias,
    assessmentProviderOptions: assessmentGeneration.providerOptions,
    verificationProviderOptions: verificationGeneration.providerOptions,
    mainProviderOptions: mainGeneration.providerOptions,
    candidateProviderOptions: candidateGeneration.providerOptions,
    repairProviderOptions: repairGeneration.providerOptions,
    candidateReasoning: candidateGeneration.reasoning,
    repairReasoning: repairGeneration.reasoning,
    repairExplicitToolChoice: repairGeneration.explicitToolChoice,
    dependencies,
    abortSignal: config.abortSignal
  }));
  return Object.freeze({
    ...audited.value,
    modelCalls: Object.freeze(modelCalls),
    modelAuditFailures: Object.freeze(audited.failures),
    stageModelAssignment,
    receivedQuestionHash: hashContent(JSON.stringify(currentStudentQuestion)),
    taskSources: Object.freeze(taskSources.map((source) => Object.freeze({ ...source })))
  });
}

function createAgentContext(hostContext) {
  const editorFiles = Array.isArray(hostContext.editor?.files) ? hostContext.editor.files : [];
  const fileMap = new Map();
  const files = editorFiles.map((file, index) => {
    const workspacePath = String(file.path || `model-${index + 1}.sysml`);
    const displayName = workspacePath.slice(0, 160);
    const fileId = fileIdForPath(displayName);
    const mapped = {
      fileId,
      displayName,
      content: String(file.content || ''),
      contentHash: hashContent(file.content || ''),
      editable: file.editable !== false
    };
    const internal = { ...mapped, workspacePath };
    fileMap.set(displayName, internal);
    fileMap.set(fileId, internal);
    return mapped;
  });
  if (!files.length) {
    const mapped = {
      fileId: fileIdForPath('main.sysml'),
      displayName: 'main.sysml',
      content: '',
      contentHash: hashContent(''),
      editable: true
    };
    files.push(mapped);
    const internal = { ...mapped, workspacePath: 'main.sysml' };
    fileMap.set(mapped.displayName, internal);
    fileMap.set(mapped.fileId, internal);
  }

  const entry = fileMap.get(String(hostContext.editor?.entryFile || '')) || files[0];
  const active = fileMap.get(String(hostContext.editor?.activeFilePath || '')) || entry || files[0];
  const model = {
    files,
    entryFileId: entry?.fileId,
    activeFileId: active?.fileId,
    diagnostics: mapDiagnostics(hostContext, fileMap),
    activeDiagnosticId: optionalText(
      hostContext.diagnostics?.activeDiagnosticId
        || hostContext.editor?.contextState?.activeDiagnosticId
        || hostContext.editor?.interaction?.activeDiagnosticId,
      160
    )
  };
  Object.assign(model, mapEditorFocus(hostContext, active));

  const context = {
    tenantId: opaqueId('tenant', hostContext.tenant?.tenantId || 'local-dev'),
    userId: opaqueId('user', hostContext.tenant?.userId || 'unscoped-user'),
    threadId: opaqueId('thread', hostContext.threadId || hostContext.requestId || 'thread'),
    lesson: {
      courseId: opaqueId('course', hostContext.course?.courseId || hostContext.course?.coursePackId || 'course'),
      lessonId: opaqueId('lesson', hostContext.course?.lessonId || 'lesson'),
      title: nonEmptyText(hostContext.course?.lessonTitle, 'Current SysML v2 lesson', 240),
      objectives: textList(hostContext.course?.learningGoals, 20, 1000),
      taskHints: textList((hostContext.courseContext?.todoItems || []).map((item) => item?.text || item), 20, 1000)
    },
    model
  };
  return { context, fileMap };
}

function mapEditorFocus(hostContext, activeFile) {
  const editor = hostContext.editor || {};
  const state = editor.contextState || {};
  const selection = editor.selection || {};
  const stale = ['stale_document', 'default_context'].includes(String(state.degradedReason || ''));
  const codeIsCurrent = state.cursorOrigin === 'current'
    && state.focus === 'focused'
    && state.interactionTarget === 'code';
  const selectionExplicitlyFrozen = state.selectionOrigin === 'frozen-explicit'
    && state.cursorOrigin === 'frozen-explicit'
    && state.interactionTarget === 'ai-panel';
  const cursorExplicitlyFrozen = state.cursorOrigin === 'frozen-explicit'
    && state.interactionTarget === 'ai-panel';
  const selectionIsCurrent = codeIsCurrent && state.selectionOrigin !== 'last-known';
  const selectionUsable = !stale
    && activeFile
    && selection.empty === false
    && Number.isInteger(selection.startOffset)
    && Number.isInteger(selection.endOffset)
    && selection.endOffset > selection.startOffset
    && (selectionIsCurrent || selectionExplicitlyFrozen);
  if (selectionUsable) {
    return {
      selection: {
        fileId: activeFile.fileId,
        from: selection.startOffset,
        to: selection.endOffset
      }
    };
  }

  const nonCodeSurface = surfaceForInteraction(state.interactionTarget);
  if (nonCodeSurface && !cursorExplicitlyFrozen) {
    return { cursor: { zone: 'non_code', surface: nonCodeSurface } };
  }
  const cursorOffset = Number(editor.cursor?.offset);
  if (!stale && activeFile && Number.isInteger(cursorOffset)
    && cursorOffset >= 0 && cursorOffset <= activeFile.content.length
    && (codeIsCurrent || cursorExplicitlyFrozen)) {
    return { cursor: { zone: 'code', fileId: activeFile.fileId, offset: cursorOffset } };
  }
  return {};
}

function surfaceForInteraction(value) {
  const target = String(value || '');
  if (target === 'course-content') return 'lesson';
  if (target === 'diagnostic') return 'diagnostics';
  if (target === 'navigation') return 'navigation';
  if (target === 'ai-panel') return 'unknown';
  return '';
}

function mapDiagnostics(hostContext, fileMap) {
  const diagnostics = [
    ...(hostContext.diagnostics?.officialValidator || []),
    ...(hostContext.diagnostics?.courseRules || [])
  ];
  return diagnostics.slice(0, 100).map((item) => {
    const file = fileMap.get(String(item.file || item.filePath || ''));
    const from = nonNegativeInteger(item.from) ?? diagnosticOffset(file, item.line, item.column);
    const to = nonNegativeInteger(item.to) ?? from;
    return compactObject({
      diagnosticId: optionalText(item.diagnosticId || item.id || item.code || item.ruleId, 160),
      fileId: file?.fileId,
      severity: normalizeSeverity(item.severity),
      code: optionalText(item.code || item.ruleId, 80),
      message: nonEmptyText(item.message, 'Validator diagnostic', 2000),
      from,
      to
    });
  });
}

function capabilityGrantForContext(hostContext) {
  return deriveAgentTaskPolicy(hostContext).capabilityGrant;
}

function deriveAgentTaskPolicy(hostContext) {
  const operation = hostContext.question?.operation === 'repair' ? 'repair' : undefined;
  return {
    inputMode: 'single_entry',
    ...(operation ? { operation } : {}),
    // Capability只表示服务端允许Main按需使用；是否检索由当前证据缺口决定，
    // 不再依赖汽车、热管理或“联网”等学生文本关键词。
    capabilityGrant: [...ALL_READ_TOOLS]
  };
}

function createExecutionCheckpointDependencies({ hostContext, runId, conversation }) {
  if (!conversation
    || typeof conversation.appendExecutionCheckpoint !== 'function'
    || typeof conversation.loadLatestExecutionCheckpoint !== 'function'
    || typeof conversation.findReusableValidationArtifact !== 'function') return {};
  const currentHashes = deriveExecutionInputHashes(hostContext);
  const validationIdentity = executionValidationIdentity(hostContext);
  return {
    async persistExecutionCheckpoint(boundary) {
      const validation = boundary?.validation
        ? checkpointValidationArtifact(boundary.validation, validationIdentity)
        : undefined;
      return conversation.appendExecutionCheckpoint({
        runId,
        boundary: {
          ...boundary,
          ...currentHashes,
          ...validationIdentity,
          metadata: {
            ...(boundary?.metadata || {}),
            resourcePolicyVersion: String(hostContext?.runtimeAssignment?.resourcePolicySnapshot?.versionId || ''),
            resourcePolicyChecksum: String(hostContext?.runtimeAssignment?.resourcePolicySnapshot?.checksum || '')
          },
          ...(validation ? { validation } : {})
        }
      });
    },
    async loadLatestExecutionCheckpoint() {
      return conversation.loadLatestExecutionCheckpoint(runId, {
        currentHashes: { ...currentHashes, ...validationIdentity }
      });
    },
    async findReusableValidationArtifact(input) {
      return conversation.findReusableValidationArtifact({ runId, ...input });
    }
  };
}

function executionValidationIdentity(hostContext) {
  const course = hostContext?.course || {};
  const courseContext = hostContext?.courseContext || {};
  const validatorVersion = `${OFFICIAL_VALIDATOR_RELEASE}/${OFFICIAL_VALIDATOR_KERNEL}/${TRUSTED_OFFICIAL_VALIDATOR_ATTESTATION.artifactHash}`;
  const rulesetVersion = [
    course.coursePackId || 'no-course-pack',
    course.coursePackVersion || course.packVersion || 'unversioned',
    course.courseId || 'no-course',
    course.lessonId || 'no-lesson',
    course.ruleSetVersion || course.rulesetVersion || courseContext.ruleSetVersion || 'server-course-rules-v1'
  ].map((value) => String(value).trim()).join('/').slice(0, 300);
  const validationOptionsHash = hashContent(JSON.stringify({
    version: 'teacher-validation-options-v1',
    contractVersion: CONTRACT_VERSION,
    courseRuleMode: String(course.courseRuleMode || 'none'),
    coursePackId: String(course.coursePackId || ''),
    coursePackVersion: String(course.coursePackVersion || course.packVersion || ''),
    courseId: String(course.courseId || ''),
    lessonId: String(course.lessonId || ''),
    validatorVersion
  }));
  return { validatorVersion, rulesetVersion, validationOptionsHash };
}

function checkpointValidationArtifact(validation, identity) {
  const payload = validation && typeof validation === 'object' && Object.prototype.hasOwnProperty.call(validation, 'payload')
    ? validation.payload
    : validation;
  return {
    payload,
    candidateWorkspaceHash: String(payload?.candidateWorkspaceHash || ''),
    validatorVersion: String(payload?.validator?.version || identity.validatorVersion),
    rulesetVersion: identity.rulesetVersion,
    validationOptionsHash: identity.validationOptionsHash
  };
}

function createAgentDependencies({ hostContext, agentContext, fileMap, config, knowledgeMode = 'legacy' }) {
  const publicActivity = createPublicActivityReporter(config);
  return {
    async inspectLessonContext({ input, abortSignal }) {
      abortSignal?.throwIfAborted();
      return {
        courseId: agentContext.lesson.courseId,
        lessonId: agentContext.lesson.lessonId,
        title: agentContext.lesson.title,
        objectives: input.includeObjectives ? agentContext.lesson.objectives : [],
        taskHints: agentContext.lesson.taskHints
      };
    },
    async inspectCurrentModel({ input, grounding, abortSignal }) {
      return publicActivity.run({
        kind: 'context',
        runningMessage: '正在读取当前课程与模型上下文。',
        completeMessage: '已读取当前课程与模型上下文。'
      }, async () => {
        abortSignal?.throwIfAborted();
        const includeAllContent = input.detail === 'full';
        const focusFileId = grounding.fileId;
        return {
          files: agentContext.model.files.map((file) => compactObject({
            fileId: file.fileId,
            displayName: file.displayName,
            contentHash: file.contentHash,
            editable: file.editable,
            characterCount: file.content.length,
            content: includeAllContent || (input.detail === 'selection' && file.fileId === focusFileId)
              ? file.content
              : undefined
          })),
          activeFileId: agentContext.model.activeFileId,
          focus: grounding,
          diagnostics: agentContext.model.diagnostics,
          activeDiagnosticId: agentContext.model.activeDiagnosticId
        };
      }, (result) => ({ count: result.files.length }));
    },
    async searchSkillGuidance({ input, abortSignal }) {
      return publicActivity.run({
        kind: 'skill',
        runningMessage: '正在查阅 SysML v2 建模指南。',
        completeMessage: '已查阅 SysML v2 建模指南。'
      }, async () => {
        abortSignal?.throwIfAborted();
        const hits = typeof config.skillSource?.search === 'function'
          ? await config.skillSource.search(input.query, hostContext, { limit: input.limit, contentLimit: 4000 })
          : [];
        abortSignal?.throwIfAborted();
        return {
          query: input.query,
          items: (hits || []).slice(0, input.limit).map((hit) => {
            const excerpt = nonEmptyText(hit.content, 'No excerpt available.', 4000);
            return {
              sourceId: opaqueId('skill', hit.id || `${hit.sourceId}:${hit.filePath}`),
              title: nonEmptyText(hit.title || hit.sourceTitle, 'SysML v2 guidance', 240),
              excerpt,
              authority: skillGuidanceAuthority(hit.authorityLevel),
              version: nonEmptyText(hit.version || hit.skillName, 'local-skill', 120),
              contentHash: hashContent(excerpt)
            };
          })
        };
      }, summarizePublicSearchActivity);
    },
    async searchReviewedKnowledge({ input, abortSignal }) {
      return publicActivity.run({
        kind: 'knowledge',
        runningMessage: '正在检索已审核的 SysML v2 知识。',
        completeMessage: '已找到与问题相关的已审核知识。'
      }, async () => {
        abortSignal?.throwIfAborted();
        const normalizedInput = {
          ...input,
          limit: nonNegativeInteger(input.limit) ?? 5,
          selectedPatternIds: textList(input.selectedPatternIds, 8, 128)
        };
        const queryPlan = buildKnowledgeQueryPlan({
          requestedQuery: normalizedInput.query,
          hostContext,
          agentContext,
          requestedLimit: normalizedInput.limit
        });
        if (normalizedInput.selectedPatternIds.length === 0
          && knowledgeMode === 'repair_progressive'
          && typeof config.knowledge?.searchAnchors === 'function'
          && typeof config.knowledge?.expandClaims === 'function') {
          try {
            return await searchProgressiveReviewedKnowledge({
              knowledge: config.knowledge,
              queryPlan,
              input: normalizedInput,
              hostContext,
              abortSignal
            });
          } catch (error) {
            if (typeof config.knowledge?.search !== 'function') throw error;
          }
        }
        const hits = typeof config.knowledge?.search === 'function'
          ? await config.knowledge.search(queryPlan.effectiveQuery, hostContext, {
            limit: normalizedInput.limit,
            queryPlan,
            selectedPatternIds: normalizedInput.selectedPatternIds
          })
          : [];
        abortSignal?.throwIfAborted();
        const graph = (hits || []).find((hit) => hit?.graph)?.graph;
        const items = (hits || [])
          .filter((hit) => hit.card?.reviewStatus === 'reviewed')
          // items 是兼容展示摘要，仍保持 8 条；规范 Claim 闭包通过 graph.claims 独立返回。
          .slice(0, Math.min(normalizedInput.limit, 8))
          .map((hit) => {
            const card = hit.card;
            const excerpt = nonEmptyText(card.summary || card.content, 'Reviewed knowledge card.', 4000);
            return {
              cardId: opaqueId('knowledge', card.id),
              title: nonEmptyText(card.title, 'Reviewed SysML v2 knowledge', 240),
              excerpt,
              reviewed: true,
              evidenceLevel: graph ? knowledgeEvidenceLevel(card.authorityLevel) : 'reviewed_project',
              version: nonEmptyText(card.sourceVersion, 'reviewed-unversioned', 120),
              contentHash: normalizeContentHash(card.metadata?.bundleContentHash)
                || normalizeContentHash(card.metadata?.review?.contentHash)
                || hashContent(card.content || excerpt)
            };
          });
        return adaptReviewedKnowledgeResult({ graph, items, input: normalizedInput, queryPlan });
      }, summarizePublicKnowledgeActivity);
    },
    async searchDomainEvidence({ input, abortSignal }) {
      return publicActivity.run({
        kind: 'web',
        runningMessage: '正在搜索公开网页中的工程资料。',
        completeMessage: '已找到可供参考的公开网页。'
      }, async () => {
        abortSignal?.throwIfAborted();
        const result = await searchDeepSeekDomainEvidence(
          config.domainWebSearch,
          input,
          { signal: abortSignal, fetch: config.domainWebSearchFetch }
        );
        abortSignal?.throwIfAborted();
        return result;
      }, summarizePublicWebActivity);
    },
    async validateCandidateWorkspace({ input, abortSignal }) {
      return publicActivity.run({
        kind: 'validator',
        runningMessage: '正在使用官方 Validator 检查候选模型。',
        completeMessage: '官方 Validator 检查已完成。'
      }, async () => {
        abortSignal?.throwIfAborted();
        const validatorObservations = [];
        try {
          const result = await callValidatorTool({
            input,
            abortSignal,
            hostContext,
            fileMap,
            config,
            validatorObservations
          });
          abortSignal?.throwIfAborted();
          return { validation: result, validatorObservations };
        } catch (error) {
          if (error && typeof error === 'object') error.validatorObservations = validatorObservations;
          throw error;
        }
      }, summarizePublicValidatorActivity);
    },
    async loadProjectModelingState({ goalContractHash, abortSignal }) {
      abortSignal?.throwIfAborted();
      if (typeof config.conversation?.loadProjectModelingState !== 'function') return undefined;
      const state = await config.conversation.loadProjectModelingState(
        hostContext.threadId,
        goalContractHash
      );
      abortSignal?.throwIfAborted();
      return state || undefined;
    },
    async persistModelProjectPlan({ runId, plan, abortSignal }) {
      abortSignal?.throwIfAborted();
      if (typeof config.conversation?.saveModelProjectPlan !== 'function') return;
      await config.conversation.saveModelProjectPlan({
        threadId: hostContext.threadId,
        runId,
        plan
      });
      abortSignal?.throwIfAborted();
    },
    async persistModuleCheckpoint({ runId, checkpoint, abortSignal }) {
      abortSignal?.throwIfAborted();
      if (typeof config.conversation?.saveModuleCheckpoint !== 'function') return;
      await config.conversation.saveModuleCheckpoint({
        threadId: hostContext.threadId,
        runId,
        checkpoint
      });
      abortSignal?.throwIfAborted();
    }
  };
}

function createPublicActivityReporter(config) {
  let sequence = 0;
  const emit = async (payload) => {
    if (!config.streamWriter?.write) return;
    try {
      await config.streamWriter.write('activity', payload);
    } catch {
      // Progress UI is observational. It must never change the answer path.
    }
  };
  return {
    async run(definition, task, summarize = () => ({})) {
      const activityId = `${definition.kind}-${++sequence}`;
      await emit({
        activityId,
        kind: definition.kind,
        status: 'running',
        message: definition.runningMessage
      });
      try {
        const result = await task();
        const summary = summarize(result) || {};
        await emit({
          activityId,
          kind: definition.kind,
          status: 'complete',
          message: summary.message || definition.completeMessage,
          ...(Number.isFinite(Number(summary.count)) ? { count: Number(summary.count) } : {}),
          ...(Array.isArray(summary.items) && summary.items.length ? { items: summary.items.slice(0, 3) } : {})
        });
        return result;
      } catch (error) {
        await emit({
          activityId,
          kind: definition.kind,
          status: 'error',
          message: `${definition.runningMessage.replace(/[。.]$/u, '')}未完成。`
        });
        throw error;
      }
    }
  };
}

function summarizePublicSearchActivity(result) {
  const items = publicActivityItems(result?.items || []);
  return {
    count: Array.isArray(result?.items) ? result.items.length : 0,
    items,
    message: items.length ? `已查阅 ${result.items.length} 条 SysML v2 建模指南。` : '未找到额外的建模指南。'
  };
}

function summarizePublicKnowledgeActivity(result) {
  const sourceItems = Array.isArray(result?.items) && result.items.length
    ? result.items
    : Array.isArray(result?.newClaims) ? result.newClaims : [];
  const count = sourceItems.length || (Array.isArray(result?.graph?.claims) ? result.graph.claims.length : 0);
  return {
    count,
    items: publicActivityItems(sourceItems),
    message: count ? `找到 ${count} 条与问题相关的已审核知识。` : '本轮没有找到新的已审核知识。'
  };
}

function summarizePublicWebActivity(result) {
  const sources = Array.isArray(result?.sources) ? result.sources : [];
  return {
    count: sources.length,
    items: publicActivityItems(sources),
    message: sources.length ? `搜索到 ${sources.length} 个可供参考的网页。` : '本轮没有找到可用的公开网页。'
  };
}

function summarizePublicValidatorActivity(result) {
  const validation = result?.validation || {};
  const diagnostics = Array.isArray(validation.diagnostics) ? validation.diagnostics : [];
  const passed = validation.valid === true
    || (validation.syntax === 'passed' && validation.semantic === 'passed')
    || validation.status === 'passed';
  return {
    count: diagnostics.length,
    message: passed
      ? '官方 Validator 检查通过。'
      : diagnostics.length ? `官方 Validator 发现 ${diagnostics.length} 个需要处理的问题。` : '官方 Validator 检查已完成。'
  };
}

function publicActivityItems(items) {
  return (Array.isArray(items) ? items : [])
    .slice(0, 3)
    .map((item) => compactObject({
      title: nonEmptyText(item?.title || item?.sourceTitle || item?.claimText, '', 180),
      detail: nonEmptyText(item?.authority || item?.evidenceLevel || item?.version, '', 120) || undefined,
      url: publicHttpUrl(item?.url)
    }))
    .filter((item) => item.title);
}

function publicHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function publicEngineeringPreviousVersion(value) {
  if (!value || value.available !== true || !Array.isArray(value.files)) {
    return value ? { available: false, files: [] } : undefined;
  }
  const files = value.files.slice(0, 20).flatMap((file) => {
    const filePath = String(file?.filePath || '').trim().slice(0, 160);
    const content = typeof file?.content === 'string' ? file.content.slice(0, 200_000) : '';
    return filePath && content ? [{ filePath, content }] : [];
  });
  return files.length === value.files.length
    ? { available: true, files }
    : { available: false, files: [] };
}

function authoritativeKnowledgeQuery(query, hostQuestion) {
  return buildKnowledgeQueryPlan({
    requestedQuery: query,
    hostContext: { question: { text: String(hostQuestion || '') } },
    agentContext: { model: { files: [] } }
  }).effectiveQuery;
}

function extractKnowledgeOperators(value) {
  return [...new Set(extractKnowledgeOperatorOccurrences(value).map((occurrence) => occurrence.token))];
}

function extractKnowledgeOperatorOccurrences(value) {
  const text = String(value || '');
  const found = [];
  const multi = ['default :=', 'default =', '::>', ':>>', ':=', ':>'];
  for (let index = 0; index < text.length;) {
    const operator = multi.find((candidate) => text.startsWith(candidate, index));
    if (operator) {
      found.push({ token: operator, start: index, end: index + operator.length });
      index += operator.length;
      continue;
    }
    const current = text[index];
    const previous = text[index - 1] || '';
    const next = text[index + 1] || '';
    if (current === ':' && previous !== ':' && next !== ':' && next !== '/' && next !== '\\') {
      found.push({ token: ':', start: index, end: index + 1 });
    }
    if (current === '=' && !['<', '>', '!', '=', ':'].includes(previous) && !['=', '>'].includes(next)) {
      found.push({ token: '=', start: index, end: index + 1 });
    }
    index += 1;
  }
  return found;
}

function buildKnowledgeQueryPlan({ requestedQuery, hostContext, agentContext, requestedLimit }) {
  const storeContext = buildKnowledgeStoreContext(hostContext, agentContext);
  const planned = buildSysmlKnowledgeQueryPlan(requestedQuery, storeContext, {
    limit: requestedLimit
  });
  const requestedOperators = new Set(extractKnowledgeOperators(planned.requestedQuery));
  const addedOperators = [...planned.answerRequiredOperators, ...planned.supportingOperators]
    .filter((operator, index, values) => !requestedOperators.has(operator)
      && values.indexOf(operator) === index);
  const sources = [];
  for (const occurrence of planned.operatorOccurrences) {
    if (!addedOperators.includes(occurrence.token)) continue;
    const source = normalizeExpansionSourceType(occurrence.sourceType);
    if (source && !sources.includes(source)) sources.push(source);
  }
  const normalizedOccurrences = planned.operatorOccurrences.map(normalizeQueryPlanOccurrence);
  for (const occurrence of extractKnowledgeOperatorOccurrences(planned.requestedQuery)) {
    normalizedOccurrences.push({
      sourceType: 'model_request',
      contentHash: planned.requestedQueryHash,
      start: occurrence.start,
      end: occurrence.end,
      token: occurrence.token,
      expandedAstContextIds: expandedAstContextIdsForOperator(occurrence.token)
    });
  }
  return {
    ...planned,
    operatorOccurrences: deduplicateKnowledgeOccurrences(normalizedOccurrences),
    queryExpansion: { addedOperators, sources }
  };
}

function deduplicateKnowledgeOccurrences(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = [item.sourceType, item.fileId || '', item.contentHash, item.start, item.end, item.token].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildKnowledgeStoreContext(hostContext, agentContext) {
  const selection = agentContext?.model?.selection;
  const selectedFile = selection
    ? agentContext.model.files.find((file) => file.fileId === selection.fileId)
    : undefined;
  return {
    ...hostContext,
    question: {
      ...(hostContext?.question || {}),
      text: String(hostContext?.question?.text || '')
    },
    editor: {
      ...(hostContext?.editor || {}),
      files: agentContext?.model?.files || [],
      activeFileId: agentContext?.model?.activeFileId,
      ...(selectedFile && selection
        ? {
            selection: {
              text: selectedFile.content.slice(selection.from, selection.to),
              from: selection.from,
              to: selection.to
            }
          }
        : {})
    }
  };
}

function normalizeQueryPlanOccurrence(occurrence) {
  return compactObject({
    ...occurrence,
    sourceType: occurrence.sourceType === 'requested_query'
      ? 'model_request'
      : occurrence.sourceType === 'current_model'
        ? 'trusted_active_model'
        : occurrence.sourceType === 'effective_query_expansion'
          ? 'model_request'
          : occurrence.sourceType,
    observedAstContextId: occurrence.observedAstContextId || undefined
  });
}

function normalizeExpansionSourceType(value) {
  if (value === 'trusted_question') return 'trusted_question';
  if (value === 'trusted_selection') return 'trusted_selection';
  if (value === 'current_model' || value === 'trusted_active_model') return 'trusted_active_model';
  return '';
}

function expandedAstContextIdsForOperator(operator) {
  const contexts = {
    ':': ['sysml20:Usage'],
    ':>': ['sysml20:Definition', 'sysml20:Usage', 'kerml10:Feature'],
    ':>>': ['sysml20:Usage', 'kerml10:Feature'],
    '::>': ['sysml20:ConnectionUsage', 'kerml10:Feature'],
    '=': ['kerml10:FeatureValue'],
    ':=': ['kerml10:FeatureValue'],
    'default =': ['kerml10:FeatureValue'],
    'default :=': ['kerml10:FeatureValue']
  };
  return contexts[operator] || [];
}

async function searchProgressiveReviewedKnowledge({
  knowledge,
  queryPlan,
  input,
  hostContext,
  abortSignal
}) {
  const requestedLimit = nonNegativeInteger(input.limit);
  const anchorLimit = Math.min(4, Math.max(1, requestedLimit || 4));
  const anchorsResult = await knowledge.searchAnchors(
    queryPlan.effectiveQuery,
    hostContext,
    { limit: anchorLimit, queryPlan }
  );
  abortSignal?.throwIfAborted();

  const anchors = (Array.isArray(anchorsResult?.anchors) ? anchorsResult.anchors : [])
    .slice(0, anchorLimit);
  const closure = anchorsResult?.closure && typeof anchorsResult.closure === 'object'
    ? anchorsResult.closure
    : {};
  const closureClaimIds = textList(closure.closureClaimIds, 25, 128);
  const knowledgeAnswerRequiredClaimIds = textList(closure.knowledgeAnswerRequiredClaimIds, 25, 128);
  const knowledgeSupportingClaimIds = textList(closure.knowledgeSupportingClaimIds, 25, 128);
  const claimIds = [...new Set([
    ...closureClaimIds,
    ...anchors.map((claim) => optionalText(claim?.claimId, 128)).filter(Boolean)
  ])].slice(0, 6);
  const expansion = claimIds.length > 0
    ? await knowledge.expandClaims(claimIds, hostContext)
    : undefined;
  abortSignal?.throwIfAborted();

  const claimSources = [
    ...anchors,
    ...(Array.isArray(expansion?.claims) ? expansion.claims : [])
  ];
  const seenClaimIds = new Set();
  const disclosedClaims = claimSources.flatMap((claim) => {
    const claimId = optionalText(claim?.claimId, 128);
    const claimText = optionalText(claim?.summary || claim?.claimText, 4_000);
    if (!claimId || !claimText || seenClaimIds.has(claimId)) return [];
    seenClaimIds.add(claimId);
    return [{
      claimId,
      claimText,
      authorityLevel: claim.authorityLevel === 'A2' ? 'A2' : 'A1',
      operators: textList(claim.operators, 16, 16),
      astContextIds: textList(claim.astContextIds, 16, 128),
      evidenceIds: textList(claim.evidenceIds, 16, 128),
      selectionRole: knowledgeAnswerRequiredClaimIds.includes(claimId)
        ? 'required'
        : knowledgeSupportingClaimIds.includes(claimId)
          ? 'supporting'
          : 'additional_supporting'
    }];
  });
  const evidenceBlocks = (Array.isArray(expansion?.evidenceBlocks) ? expansion.evidenceBlocks : [])
    .flatMap((evidence) => {
      const evidenceId = optionalText(evidence?.evidenceId, 128);
      const excerpt = fullText(evidence?.excerpt || evidence?.textContent);
      if (!evidenceId || !excerpt) return [];
      return [{
        evidenceId,
        sourceId: optionalText(evidence?.sourceId, 128),
        sectionPath: nonEmptyText(evidence?.sectionPath, 'Unknown section', 500),
        excerpt,
        textHash: normalizeContentHash(evidence?.textHash) || hashContent(excerpt),
        authorityLevel: evidence?.authorityLevel === 'A2' ? 'A2' : 'A1'
      }];
    });
  const bundle = expansion?.bundle || anchorsResult?.bundle || {};
  const closureClaimIdSet = new Set(closureClaimIds);
  const additionalSupportingBudget = Math.min(input.limit, Math.max(0, 25 - closureClaimIds.length));
  const closureClaims = closureClaimIds
    .map((claimId) => disclosedClaims.find((claim) => claim.claimId === claimId))
    .filter(Boolean);
  const additionalClaims = disclosedClaims
    .filter((claim) => !closureClaimIdSet.has(claim.claimId))
    .slice(0, additionalSupportingBudget);
  const claims = [...closureClaims, ...additionalClaims];
  const returnedClaimIds = new Set(claims.map((claim) => claim.claimId));
  const missingClosureClaimIds = [...new Set([
    ...textList(closure.missingClosureClaimIds, 25, 128),
    ...closureClaimIds.filter((claimId) => !returnedClaimIds.has(claimId))
  ])];
  const returnedEvidenceIds = new Set(evidenceBlocks.map((evidence) => evidence.evidenceId));
  const missingEvidenceClaimIds = closureClaims
    .filter((claim) => claim.evidenceIds.length === 0
      || claim.evidenceIds.some((evidenceId) => !returnedEvidenceIds.has(evidenceId)))
    .map((claim) => claim.claimId);
  const closureGaps = [...new Set([
    ...textList(closure.closureGaps, 32, 240),
    ...missingClosureClaimIds.map((claimId) => `missing_claim:${claimId}`),
    ...missingEvidenceClaimIds.map((claimId) => `missing_evidence:${claimId}`)
  ])];
  const closureRequirement = closureClaimIds.length > 0 || closureGaps.length > 0
    ? 'required'
    : 'not_applicable';
  const closureStatus = closureRequirement === 'not_applicable'
    ? 'not_applicable'
    : closureGaps.length === 0 ? 'complete' : 'incomplete';
  const closureEvidenceComplete = missingClosureClaimIds.length === 0 && missingEvidenceClaimIds.length === 0;
  const progressiveGraph = {
    coverage: !bundle.bundleId || claims.length === 0
      ? 'NONE'
      : closureRequirement === 'required'
        && closureStatus === 'complete'
        && closureEvidenceComplete ? 'COMPLETE' : 'PARTIAL',
    bundleId: optionalText(bundle.bundleId, 128),
    baselineId: optionalText(bundle.baselineId, 128),
    bundleVersion: optionalText(bundle.bundleVersion, 120),
    sourceRegistryHash: normalizeContentHash(bundle.sourceRegistryHash) || undefined,
    bundleContentHash: normalizeContentHash(bundle.bundleContentHash) || undefined,
    closureProfileId: optionalText(closure.closureProfileId, 128),
    closureProfileHash: normalizeContentHash(closure.closureProfileHash) || undefined,
    closureRequirement,
    closureStatus,
    candidateKnowledgePatterns: normalizeKnowledgePatternCandidates(closure.candidateKnowledgePatterns),
    selectedKnowledgePatternIds: textList(closure.selectedKnowledgePatternIds, 8, 128),
    selectedPatternClosureClaimIds: textList(closure.selectedPatternClosureClaimIds, 25, 128),
    patternSelectionWarnings: textList(closure.patternSelectionWarnings, 16, 240),
    closureGaps,
    closureClaimIds,
    knowledgeAnswerRequiredClaimIds,
    knowledgeSupportingClaimIds,
    mandatorySupportingCount: knowledgeSupportingClaimIds.length,
    additionalSupportingClaimIds: additionalClaims.map((claim) => claim.claimId),
    missingClosureClaimIds,
    requestedLimit: input.limit,
    additionalSupportingBudget,
    selectionLimit: Math.min(25, closureClaimIds.length + additionalSupportingBudget),
    claims,
    evidenceBlocks,
    guardrails: Array.isArray(closure.guardrails) ? closure.guardrails : [],
    conflicts: [],
    excludedCandidates: {
      count: nonNegativeInteger(anchorsResult?.retrieval?.excludedCandidateCount) ?? 0,
      claimIds: []
    }
  };
  return adaptReviewedKnowledgeResult({
    graph: progressiveGraph,
    items: [],
    input,
    queryPlan
  });
}

function adaptReviewedKnowledgeResult({ graph, items, input, queryPlan }) {
  if (!graph) {
    const emptyGraphResult = {
      requestedQuery: queryPlan.requestedQuery,
      effectiveQuery: queryPlan.effectiveQuery,
      requestedQueryHash: queryPlan.requestedQueryHash,
      effectiveQueryHash: queryPlan.effectiveQueryHash,
      closureProfileId: 'sysml-general-search-v1',
      closureProfileHash: hashContent('sysml-general-search-v1'),
      closureRequirement: 'not_applicable',
      closureStatus: 'not_applicable',
      intentMode: queryPlan.intentMode,
      operatorOccurrences: queryPlan.operatorOccurrences,
      queryExpansion: queryPlan.queryExpansion,
      coverage: 'NONE',
      candidateKnowledgePatterns: [],
      selectedKnowledgePatternIds: [],
      selectedPatternClosureClaimIds: [],
      patternSelectionWarnings: [],
      closureGaps: [],
      closureClaimIds: [],
      knowledgeAnswerRequiredClaimIds: [],
      knowledgeSupportingClaimIds: [],
      mandatorySupportingCount: 0,
      additionalSupportingClaimIds: [],
      missingClosureClaimIds: [],
      requestedLimit: input.limit,
      additionalSupportingBudget: Math.min(input.limit, 25),
      selectionLimit: Math.min(input.limit, 25),
      returnedClaimCount: 0,
      resourceLimit: 25,
      claims: [],
      evidenceBlocks: [],
      guardrails: [],
      conflicts: [],
      excludedCandidates: { count: 0, claimIds: [] },
      items: []
    };
    return { ...emptyGraphResult, resultHash: hashContent(canonicalJson(emptyGraphResult)) };
  }

  const closureClaimIds = textList(graph.closureClaimIds, 25, 128);
  const knowledgeAnswerRequiredClaimIds = textList(graph.knowledgeAnswerRequiredClaimIds, 25, 128);
  const knowledgeSupportingClaimIds = textList(graph.knowledgeSupportingClaimIds, 25, 128);
  const missingClosureClaimIds = textList(graph.missingClosureClaimIds, 25, 128);
  const candidateKnowledgePatterns = normalizeKnowledgePatternCandidates(graph.candidateKnowledgePatterns);
  const selectedKnowledgePatternIds = textList(graph.selectedKnowledgePatternIds, 8, 128);
  const selectedPatternClosureClaimIds = textList(graph.selectedPatternClosureClaimIds, 25, 128);
  const patternSelectionWarnings = textList(graph.patternSelectionWarnings, 16, 240);
  const closureGaps = textList(graph.closureGaps, 32, 240);
  const closureRequirement = graph.closureRequirement === 'required'
    || closureClaimIds.length > 0
    || missingClosureClaimIds.length > 0
    || closureGaps.length > 0
      ? 'required'
      : 'not_applicable';
  const closureStatus = closureRequirement === 'not_applicable'
    ? 'not_applicable'
    : closureGaps.length > 0 || missingClosureClaimIds.length > 0 ? 'incomplete' : 'complete';
  const claims = (graph.claims || []).slice(0, 25).map((claim) => ({
    claimId: nonEmptyText(claim.claimId, 'missing-claim', 128),
    claimText: nonEmptyText(claim.claimText, 'Missing claim text.', 4000),
    authorityLevel: claim.authorityLevel === 'A2' ? 'A2' : 'A1',
    operators: textList(claim.operators, 16, 16),
    astContextIds: textList(claim.astContextIds, 16, 128),
    evidenceIds: textList(claim.evidenceIds, 16, 128),
    selectionRole: ['required', 'supporting', 'additional_supporting'].includes(claim.selectionRole)
      ? claim.selectionRole
      : knowledgeAnswerRequiredClaimIds.includes(claim.claimId)
        ? 'required'
        : knowledgeSupportingClaimIds.includes(claim.claimId)
          ? 'supporting'
          : 'additional_supporting'
  }));
  const additionalSupportingBudget = nonNegativeInteger(graph.additionalSupportingBudget)
    ?? Math.min(input.limit, Math.max(0, 25 - closureClaimIds.length));
  const adapted = {
    requestedQuery: queryPlan.requestedQuery,
    effectiveQuery: queryPlan.effectiveQuery,
    requestedQueryHash: queryPlan.requestedQueryHash,
    effectiveQueryHash: queryPlan.effectiveQueryHash,
    closureProfileId: nonEmptyText(graph.closureProfileId, 'sysml-general-search-v1', 128),
    closureProfileHash: normalizeContentHash(graph.closureProfileHash)
      || hashContent(nonEmptyText(graph.closureProfileId, 'sysml-general-search-v1', 128)),
    closureRequirement,
    closureStatus,
    intentMode: ['compare_operator_semantics', 'explain_occurrence'].includes(graph.intentMode)
      ? graph.intentMode
      : queryPlan.intentMode,
    operatorOccurrences: normalizeKnowledgeOperatorOccurrences(
      graph.operatorOccurrences,
      queryPlan.operatorOccurrences
    ),
    queryExpansion: normalizeQueryExpansion(graph.queryExpansion, queryPlan.queryExpansion),
    coverage: graph.coverage,
    no_new_evidence: graph.no_new_evidence === true
      || (graph.coverage === 'NONE' && claims.length === 0 && (graph.evidenceBlocks || []).length === 0),
    bundleId: nonEmptyText(graph.bundleId, 'missing-bundle', 128),
    baselineId: nonEmptyText(graph.baselineId, 'missing-baseline', 128),
    bundleVersion: nonEmptyText(graph.bundleVersion, 'unversioned', 120),
    sourceRegistryHash: normalizeContentHash(graph.sourceRegistryHash) || undefined,
    bundleContentHash: normalizeContentHash(graph.bundleContentHash) || undefined,
    candidateKnowledgePatterns,
    selectedKnowledgePatternIds,
    selectedPatternClosureClaimIds,
    patternSelectionWarnings,
    closureGaps,
    closureClaimIds,
    knowledgeAnswerRequiredClaimIds,
    knowledgeSupportingClaimIds,
    mandatorySupportingCount: nonNegativeInteger(graph.mandatorySupportingCount)
      ?? knowledgeSupportingClaimIds.length,
    additionalSupportingClaimIds: textList(graph.additionalSupportingClaimIds, 25, 128),
    missingClosureClaimIds,
    requestedLimit: nonNegativeInteger(graph.requestedLimit) ?? input.limit,
    additionalSupportingBudget,
    selectionLimit: nonNegativeInteger(graph.selectionLimit)
      ?? Math.min(25, closureClaimIds.length + additionalSupportingBudget),
    returnedClaimCount: claims.length,
    resourceLimit: 25,
    claims,
    evidenceBlocks: (graph.evidenceBlocks || []).map((evidence) => ({
      evidenceId: nonEmptyText(evidence.evidenceId, 'missing-evidence', 128),
      sourceId: nonEmptyText(evidence.sourceId, 'missing-source', 128),
      sectionPath: nonEmptyText(evidence.sectionPath, 'Unknown section', 500),
      excerpt: fullText(evidence.textContent || evidence.excerpt, 'Missing evidence excerpt.'),
      textHash: normalizeContentHash(evidence.textHash)
        || hashContent(evidence.textContent || evidence.excerpt),
      authorityLevel: evidence.authorityLevel === 'A2' ? 'A2' : 'A1'
    })),
    guardrails: (graph.guardrails || []).slice(0, 64).map((guardrail) => ({
      guardrailId: nonEmptyText(guardrail.guardrailId, 'missing-guardrail', 128),
      authorityClass: 'engineering_guardrail',
      description: nonEmptyText(guardrail.description, 'Missing guardrail description.', 2000),
      patternSpec: normalizeGuardrailPatternSpec(guardrail.patternSpec),
      patternHash: normalizeContentHash(guardrail.patternHash)
        || hashContent(JSON.stringify(guardrail.patternSpec || [])),
      supportedByClaimIds: textList(guardrail.supportedByClaimIds, 25, 128),
      counterexampleIds: textList(guardrail.counterexampleIds, 32, 128)
    })),
    conflicts: textList(graph.conflicts, 25, 128),
    excludedCandidates: normalizeExcludedCandidates(graph.excludedCandidates),
    items
  };
  return {
    ...adapted,
    resultHash: hashContent(canonicalJson(adapted))
  };
}

function normalizeExcludedCandidates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { count: 0, claimIds: [] };
  }
  const claimIds = textList(value.claimIds, 25, 128);
  const count = nonNegativeInteger(value.count) ?? claimIds.length;
  return { count: Math.max(count, claimIds.length), claimIds };
}

function normalizeKnowledgeOperatorOccurrences(value, fallback) {
  const items = deduplicateKnowledgeOccurrences([
    ...(Array.isArray(value) ? value : []),
    ...(Array.isArray(fallback) ? fallback : [])
  ].map(normalizeQueryPlanOccurrence));
  return items.slice(0, 128).map((occurrence) => compactObject({
    sourceType: ['model_request', 'trusted_question', 'trusted_selection', 'trusted_active_model']
      .includes(occurrence.sourceType) ? occurrence.sourceType : 'model_request',
    fileId: optionalText(occurrence.fileId, 128),
    contentHash: normalizeContentHash(occurrence.contentHash) || hashContent('missing-occurrence-source'),
    start: nonNegativeInteger(occurrence.start) ?? 0,
    end: Math.max(1, nonNegativeInteger(occurrence.end) ?? 1),
    token: nonEmptyText(occurrence.token, ':', 32),
    observedAstContextId: optionalText(occurrence.observedAstContextId, 128),
    expandedAstContextIds: textList(occurrence.expandedAstContextIds, 16, 128)
  }));
}

function normalizeQueryExpansion(value, fallback) {
  return {
    addedOperators: textList(value?.addedOperators ?? fallback.addedOperators, 32, 32),
    sources: textList(value?.sources ?? fallback.sources, 3, 32)
      .filter((source) => ['trusted_question', 'trusted_selection', 'trusted_active_model'].includes(source))
  };
}

function normalizeGuardrailPatternSpec(value) {
  const patterns = (Array.isArray(value) ? value : []).slice(0, 32).flatMap((pattern) => {
    if (!pattern || typeof pattern !== 'object') return [];
    const kind = pattern.kind === 'substring' ? 'substring' : 'regex';
    const patternValue = nonEmptyText(pattern.value, '', 2000);
    if (!patternValue) return [];
    const flags = optionalText(pattern.flags, 16);
    return [{ kind, value: patternValue, ...(flags ? { flags } : {}) }];
  });
  return patterns.length ? patterns : [{ kind: 'substring', value: '__no_match__' }];
}

async function callValidatorTool({ input, abortSignal, hostContext, fileMap, config, validatorObservations = [] }) {
  const baseUrl = String(config.platformApiUrl || process.env.PLATFORM_API_URL || 'http://localhost:8080').replace(/\/+$/, '');
  const retryMax = validatorTransientRetryMax(config.validatorTransientRetryMax);
  const callerTimeoutSignal = AbortSignal.timeout(
    positiveInteger(
      config.agentValidatorToolTimeoutMs,
      AGENT_RESOURCE_POLICY_BOOTSTRAP_PROJECTION.teacher.agentValidatorToolTimeoutMs
    )
  );
  const requestSignal = abortSignal
    ? AbortSignal.any([abortSignal, callerTimeoutSignal])
    : callerTimeoutSignal;
  const validatorUrl = new URL(`${baseUrl}/internal/teacher/validate-candidate`);
  const coursePackId = String(hostContext?.course?.coursePackId || '').trim();
  if (coursePackId) validatorUrl.searchParams.set('coursePackId', coursePackId);
  const requestBody = JSON.stringify({ context: hostContext, candidate: input });
  let response;
  let payload = {};
  for (let attempt = 0; attempt <= retryMax; attempt += 1) {
    const attemptStartedAt = Date.now();
    try {
      response = await fetch(validatorUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ai-teacher-tool-token': String(config.toolToken || '')
        },
        body: requestBody,
        signal: requestSignal
      });
    } catch (error) {
      validatorObservations.push(Object.freeze({
        attempt: attempt + 1,
        admissionOutcome: callerTimeoutSignal.aborted ? 'execution_timeout' : 'backend_unavailable',
        queueWaitMs: 0,
        executionMs: Math.max(0, Date.now() - attemptStartedAt),
        retryableBeforeStart: false,
        abortedAfterStart: abortSignal?.aborted === true
      }));
      if (abortSignal?.aborted) throw error;
      if (callerTimeoutSignal.aborted) return unavailableValidation('VALIDATOR_TOOL_CALL_TIMEOUT');
      return unavailableValidation('VALIDATOR_TOOL_UNREACHABLE');
    }
    const text = await response.text();
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    const fallbackObservation = payload?.validatorObservation || {
      admissionOutcome: validatorAdmissionOutcomeFromCode(payload?.code || payload?.error?.code),
      retryableBeforeStart: payload?.retryableBeforeStart === true
    };
    validatorObservations.push(normalizeValidatorObservation(
      fallbackObservation,
      attempt + 1,
      response.ok ? 'admitted' : 'backend_unavailable',
      Date.now() - attemptStartedAt
    ));
    const retryableBeforeStart = payload?.retryableBeforeStart === true;
    if (response.ok || !retryableBeforeStart || attempt >= retryMax) break;
    await waitForAbortableDelay(150, requestSignal);
  }
  if (!response?.ok) {
    if ([429, 502, 503, 504].includes(response?.status)) {
      return unavailableValidation(payload?.code || payload?.error?.code || `VALIDATOR_TOOL_HTTP_${response?.status}`);
    }
    const code = String(payload?.code || payload?.error?.code || `VALIDATOR_TOOL_HTTP_${response?.status}`);
    const error = new Error(`${code}: Candidate Validator tool rejected the request.`);
    error.code = code;
    error.statusCode = response?.status;
    throw error;
  }
  if (payload.toolSchemaVersion !== VALIDATOR_TOOL_SCHEMA_VERSION) {
    const error = new Error('Candidate Validator tool schema version mismatch.');
    error.code = 'VALIDATOR_TOOL_SCHEMA_MISMATCH';
    error.statusCode = 503;
    throw error;
  }
  return mapValidationOutput(payload, input, fileMap);
}

function normalizeKnowledgePatternCandidates(value) {
  return (Array.isArray(value) ? value : []).slice(0, 16).flatMap((pattern) => {
    const patternId = optionalText(pattern?.patternId, 128);
    const title = optionalText(pattern?.title, 240);
    const description = optionalText(pattern?.description, 2_000);
    if (!patternId || !title || !description) return [];
    return [{
      patternId,
      title,
      description,
      matchedAnchorNodeIds: textList(pattern.matchedAnchorNodeIds, 16, 128),
      matchedClaimIds: textList(pattern.matchedClaimIds, 25, 128),
      closureDimensions: textList(pattern.closureDimensions, 16, 120)
    }];
  });
}

function validatorAdmissionOutcomeFromCode(code) {
  const normalized = String(code || '');
  if (normalized === 'VALIDATOR_QUEUE_FULL') return 'queue_full';
  if (normalized === 'VALIDATOR_QUEUE_TIMEOUT') return 'queue_timeout';
  if (normalized === 'VALIDATOR_ABORTED_BEFORE_START') return 'aborted_before_start';
  if (normalized === 'VALIDATOR_ABORTED_AFTER_START') return 'aborted_after_start';
  if (normalized.includes('TIMEOUT')) return 'execution_timeout';
  return 'backend_unavailable';
}

function normalizeValidatorObservation(value, attempt, fallbackOutcome, fallbackExecutionMs) {
  const allowed = new Set([
    'admitted',
    'queue_full',
    'queue_timeout',
    'aborted_before_start',
    'aborted_after_start',
    'execution_timeout',
    'backend_unavailable'
  ]);
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const admissionOutcome = allowed.has(record.admissionOutcome)
    ? record.admissionOutcome
    : fallbackOutcome;
  const neverExecuted = ['queue_full', 'queue_timeout', 'aborted_before_start'].includes(admissionOutcome);
  return Object.freeze({
    attempt,
    admissionOutcome,
    queueWaitMs: nonNegativeInteger(record.queueWaitMs) ?? 0,
    executionMs: neverExecuted
      ? 0
      : nonNegativeInteger(record.executionMs) ?? Math.max(0, Math.round(fallbackExecutionMs || 0)),
    retryableBeforeStart: record.retryableBeforeStart === true,
    abortedAfterStart: record.abortedAfterStart === true
  });
}

function waitForAbortableDelay(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function mapValidationOutput(payload, input, fileMap) {
  const validatorAttestation = trustedValidatorAttestation(payload);
  const officialTrustworthy = payload.validatorSource === OFFICIAL_VALIDATOR_SOURCE
    && payload.validationCompleteness === 'official'
    && payload.fallbackActive === false
    && validatorAttestation;
  if (!officialTrustworthy) {
    return unavailableValidation('OFFICIAL_VALIDATOR_ATTESTATION_MISMATCH');
  }
  if (payload.validationCompleteness === 'official-unavailable') {
    return unavailableValidation(payload?.diagnostics?.[0]?.code || 'OFFICIAL_VALIDATOR_UNAVAILABLE');
  }
  const syntaxPassed = payload.syntaxValid === true;
  const semanticPassed = syntaxPassed && payload.semanticValid === true;
  const diagnostics = (payload.diagnostics || []).slice(0, 200).map(
    (item) => mapValidatorDiagnostic(item, fileMap, input)
  );
  const officialDiagnostics = diagnostics.filter((_, index) => {
    const source = String(payload.diagnostics?.[index]?.source || '');
    return source !== 'course-rule' && source !== 'course_rule';
  });
  const courseDiagnostics = diagnostics.filter((_, index) => {
    const source = String(payload.diagnostics?.[index]?.source || '');
    return source === 'course-rule' || source === 'course_rule';
  });
  const courseRuleCount = Number(payload.courseRuleCount);
  const courseRuleApplicability = Number.isInteger(courseRuleCount) && courseRuleCount >= 0
    ? (courseRuleCount > 0 ? 'applicable' : 'not_applicable')
    : 'unknown';
  const includeCourseDiagnostics = syntaxPassed
    && semanticPassed
    && courseRuleApplicability === 'applicable';
  const carriedDiagnosticCount = officialDiagnostics.length
    + (includeCourseDiagnostics ? courseDiagnostics.length : 0);
  const excludedIncludedDiagnosticCount = includeCourseDiagnostics ? 0 : courseDiagnostics.length;
  const result = {
    validator: {
      authority: 'official-sysml-v2-validator',
      version: `${validatorAttestation.releaseTag}/${validatorAttestation.kernelVersion}/${validatorAttestation.artifactHash}`,
      evidenceHash: hashContent(JSON.stringify({
        validatorAttestation,
        candidateWorkspaceHash: payload.candidateWorkspaceHash,
        syntaxValid: payload.syntaxValid,
        semanticValid: payload.semanticValid,
        coursePassed: payload.coursePassed,
        diagnostics: payload.diagnostics || []
      }))
    },
    official: {
      syntax: syntaxPassed ? 'passed' : 'failed',
      semantic: syntaxPassed ? (semanticPassed ? 'passed' : 'failed') : 'not_run',
      diagnostics: officialDiagnostics
    },
    courseRuleApplicability,
    completeness: ['complete', 'official'].includes(payload.validationCompleteness) ? 'complete' : 'partial',
    diagnosticSummary: mapValidatorDiagnosticSummary(
      payload,
      carriedDiagnosticCount,
      excludedIncludedDiagnosticCount
    ),
    structureEvidence: mapCandidateStructureEvidence(payload),
    candidateWorkspaceHash: normalizeContentHash(payload.candidateWorkspaceHash) || undefined,
    patches: validatedPatches(payload, input, fileMap)
  };
  if (includeCourseDiagnostics) {
    result.courseRules = {
      status: payload.courseRulesExecuted === true
        ? (payload.coursePassed === true ? 'passed' : 'failed')
        : 'not_run',
      diagnostics: courseDiagnostics
    };
  }
  return compactObject(result);
}

function trustedValidatorAttestation(payload) {
  const attestation = payload?.validatorAttestation;
  const validation = validateOfficialValidatorAttestation(attestation, {
    source: OFFICIAL_VALIDATOR_SOURCE,
    releaseTag: OFFICIAL_VALIDATOR_RELEASE,
    kernelVersion: OFFICIAL_VALIDATOR_KERNEL
  });
  if (!validation.ok
    || payload.validatorReleaseTag !== OFFICIAL_VALIDATOR_RELEASE
    || payload.validatorKernelVersion !== OFFICIAL_VALIDATOR_KERNEL) return null;
  return attestation;
}

function validatedPatches(payload, input, fileMap) {
  if (input.mode === 'standalone_model') return [];
  const candidateFiles = Array.isArray(payload.candidateFiles) ? payload.candidateFiles : [];
  return candidateFiles.flatMap((candidate) => {
    const current = fileMap.get(String(candidate.fileId || ''));
    const candidateHash = normalizeContentHash(candidate.contentHash);
    if (!current || !candidateHash || candidateHash === current.contentHash) return [];
    return [{
      fileId: current.fileId,
      baseHash: current.contentHash,
      candidateHash,
      kind: input.mode
    }];
  });
}

function mapValidatorDiagnostic(item, fileMap, input) {
  const file = fileMap.get(String(item.fileId || item.file || item.filePath || ''));
  const standalone = input?.mode === 'standalone_model';
  return compactObject({
    severity: normalizeSeverity(item.severity),
    code: optionalText(item.code || item.ruleId, 120),
    message: nonEmptyText(item.message, 'Validator diagnostic', 4000),
    fileId: standalone ? 'standalone_model' : file?.fileId,
    from: nonNegativeInteger(item.from),
    to: nonNegativeInteger(item.to),
    line: positiveIntegerOrUndefined(item.line || item.startLine),
    column: positiveIntegerOrUndefined(item.column || item.startColumn),
    lineText: optionalText(item.lineText, 20000)
  });
}

function unavailableValidation(code) {
  return {
    validator: {
      authority: 'official-sysml-v2-validator',
      version: 'unavailable',
      evidenceHash: hashContent(String(code || 'validator_unavailable'))
    },
    official: {
      syntax: 'unavailable',
      semantic: 'unavailable',
      diagnostics: [{ severity: 'warning', code: String(code || 'VALIDATOR_UNAVAILABLE').slice(0, 120), message: 'Official Validator is unavailable; no validation conclusion can be made.' }]
    },
    courseRuleApplicability: 'unknown',
    completeness: 'partial',
    patches: []
  };
}

function createLifecycleRecorder(config) {
  const runId = String(config.runId || '');
  const conversation = config.conversation;
  const startedAt = new Map();
  const startedTools = new Map();
  return {
    async recordModelCall(entry) {
      if (!conversation?.recordModelCallLedgerEntry || !runId) return;
      await conversation.recordModelCallLedgerEntry({ ...entry, runId });
    },
    async onLifecycleEvent(event) {
      if (event.type === 'tool_started' && ALL_READ_TOOLS.includes(event.toolName)) {
        startedAt.set(event.toolCallId, new Date().toISOString());
        startedTools.set(event.toolCallId, {
          toolName: event.toolName,
          argsHash: event.argsHash
        });
      }
      const projection = lifecycleProjection(event);
      if (config.streamWriter?.write) {
        await config.streamWriter.write('stage', projection);
      } else if (conversation?.recordRunEvent && runId) {
        await conversation.recordRunEvent({ runId, eventType: 'stage', payload: projection });
      }
      if (conversation?.recordRunStep && runId) {
        await conversation.recordRunStep({
          runId,
          stepType: event.type,
          status: event.type.endsWith('_finished') ? 'finished' : 'started',
          metadata: {
            stepNumber: event.stepNumber,
            phase: event.phase,
            provider: event.provider,
            modelId: event.modelId,
            finishReason: event.finishReason,
            toolName: event.toolName,
            argsHash: event.argsHash,
            durationMs: event.durationMs,
            modelCalls: event.modelCalls,
            usage: event.usage ? {
              promptTokens: event.usage.inputTokens,
              completionTokens: event.usage.outputTokens,
              reasoningTokens: event.usage.reasoningTokens,
              totalTokens: event.usage.totalTokens
            } : undefined
          }
        });
      }
      if (event.type === 'tool_started'
        && ALL_READ_TOOLS.includes(event.toolName)
        && conversation?.recordToolLedgerEntry
        && runId) {
        await conversation.recordToolLedgerEntry({
          runId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          argsHash: event.argsHash,
          status: 'started',
          startedAt: startedAt.get(event.toolCallId)
        });
      }
      if (event.type === 'tool_finished'
        && conversation?.recordToolLedgerEntry
        && runId) {
        const started = startedTools.get(event.toolCallId);
        if (started) {
          await conversation.recordToolLedgerEntry({
            runId,
            toolCallId: event.toolCallId,
            toolName: started.toolName,
            argsHash: started.argsHash,
            status: event.success ? 'succeeded' : 'failed',
            startedAt: startedAt.get(event.toolCallId),
            completedAt: new Date().toISOString()
          });
        }
      }
    },
    async persistLedger(entries) {
      if (!conversation?.recordToolLedgerEntry || !runId) return;
      for (const entry of entries || []) {
        const knowledgeAudit = ['search_reviewed_knowledge', 'search_engineering_domain_evidence']
          .includes(entry.toolName)
          ? knowledgeLedgerAudit(entry)
          : {};
        await conversation.recordToolLedgerEntry({
          runId,
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          argsHash: entry.argsHash,
          status: ledgerStatus(entry.status),
          resultHash: entry.output === undefined ? '' : hashContent(canonicalJson(entry.output)),
          resultProjection: ledgerProjection(entry),
          ...knowledgeAudit,
          startedAt: entry.startedAt || startedAt.get(entry.toolCallId),
          completedAt: entry.finishedAt
        });
        if (conversation?.recordRunStep) {
          const projection = ledgerProjection(entry);
          await conversation.recordRunStep({
            runId,
            stepType: 'tool_result',
            status: ledgerStatus(entry.status),
            metadata: {
              toolName: entry.toolName,
              argsHash: entry.argsHash,
              resultHash: entry.output === undefined ? '' : hashContent(canonicalJson(entry.output)),
              validatorStatus: projection.validatorStatus,
              replayed: Number(entry.replayCount || 0) > 0,
              errorCode: projection.errorCode
            }
          });
        }
      }
    }
  };
}

function lifecycleProjection(event) {
  const stageLabels = {
    context_started: '正在读取当前模型和选区',
    request_planning_started: '正在理解问题并确定处理方式',
    knowledge_started: '正在检索权威 Claim/Evidence',
    skill_started: '正在检索教学补充材料',
    domain_research_started: '正在受控检索工程领域资料',
    planning_started: '正在分析证据缺口并规划补充步骤',
    answer_started: '正在根据证据组织回答',
    validation_started: '正在使用官方 Validator 验证候选代码',
    feedback_started: '正在复核回答是否忠于本轮证据',
    revision_started: '正在根据复核意见修订回答'
  };
  const labels = {
    run_started: 'Agent 已开始分析问题',
    plan_ready: event.scopeDecision === 'out_of_scope'
      ? '该问题不属于 AI Teacher 的教学与工程建模范围，正在结束本轮处理'
      : `已形成处理计划：${planGoalLabel(event.taskGoal)}，目标范围为${planTargetLabel(event.target)}，建议走${planPathLabel(event.recommendedPath)}`,
    reasoning_selected: event.selectedMode === 'high'
      ? `已根据计划与证据状态启用复杂推理（${reasoningReasonLabel(event.reasons)}）`
      : '计划与证据已闭合，使用快速回答模式',
    step_started: 'Agent 正在处理当前阶段',
    stage_changed: stageLabels[event.stage] || 'Agent 正在处理当前阶段',
    tool_started: `Agent 正在调用 ${String(event.toolName || '只读工具')}`,
    tool_finished: `Agent 已完成 ${String(event.toolName || '只读工具')}`,
    step_finished: 'Agent 已完成当前推理步骤',
    run_finished: 'Agent 已完成本次分析'
  };
  return compactObject({
    stage: event.type,
    phase: event.stage,
    message: labels[event.type] || 'Agent 状态已更新',
    stepNumber: event.stepNumber,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    argsHash: event.argsHash,
    success: event.success,
    durationMs: event.durationMs,
    finishReason: event.finishReason,
    reasoningMode: event.selectedMode,
    reasoningReasons: Array.isArray(event.reasons) ? event.reasons.slice(0, 12) : undefined,
    taskGoal: event.taskGoal,
    target: event.target,
    scopeDecision: event.scopeDecision,
    recommendedPath: event.recommendedPath,
    uncertaintyCount: event.uncertaintyCount
  });
}

function planGoalLabel(value) {
  return ({ explain: '解释问题', diagnose: '诊断模型', generate: '生成候选', repair: '修复模型', validate: '验证模型' })[value]
    || '处理问题';
}

function planTargetLabel(value) {
  return ({ selection: '当前选区', diagnostic: '当前诊断', active_file: '当前文件', workspace: '工作区', standalone_model: '独立模型', general_concept: '通用概念' })[value]
    || '当前上下文';
}

function planPathLabel(value) {
  return ({ fast: '快速路径', adaptive: '自适应路径', validation: '验证路径' })[value]
    || '自适应路径';
}

function reasoningReasonLabel(reasons) {
  const labels = {
    multi_intent: '包含多个目标',
    planning_ambiguity: '任务存在歧义',
    focus_unclear: '当前焦点不明确',
    evidence_incomplete: '证据需要补充',
    required_closure_incomplete: '必需证据闭包未完成',
    evidence_conflict: '证据存在冲突',
    model_context_insufficient: '模型上下文不足',
    workspace_change: '涉及工作区级修改',
    standalone_model_generation: '需要生成独立模型',
    domain_evidence_partial: '领域证据不完整',
    domain_evidence_assumption_only: '领域证据仅能作为假设',
    external_research_unavailable: '领域联网检索不可用',
    plan_delta_required: '需要增量规划',
    validator_retry: '候选需要再次验证',
    feedback_evidence_gap: '复核发现证据缺口',
    feedback_answer_issue: '复核发现实质问题'
  };
  const visible = (Array.isArray(reasons) ? reasons : []).map((reason) => labels[reason]).filter(Boolean);
  return visible.slice(0, 3).join('、') || '任务复杂度较高';
}

function ledgerProjection(entry) {
  const validation = entry.toolName === 'validate_candidate_workspace' && entry.output && typeof entry.output === 'object'
    ? entry.output
    : null;
  const officialPassed = validation?.official?.syntax === 'passed' && validation?.official?.semantic === 'passed';
  const coursePassed = validation?.courseRuleApplicability === 'not_applicable'
    || (validation?.courseRuleApplicability === 'applicable'
      && validation?.courseRules?.status === 'passed');
  const evidenceIds = entry.toolName === 'search_skill_guidance'
    ? (entry.output?.items || []).map((item) => item.sourceId)
    : entry.toolName === 'search_reviewed_knowledge'
      ? (entry.output?.evidenceBlocks?.length
        ? entry.output.evidenceBlocks.map((item) => item.evidenceId)
        : (entry.output?.items || []).map((item) => item.cardId))
      : entry.toolName === 'search_engineering_domain_evidence'
        ? (entry.output?.sources || []).map((item) => item.sourceId)
      : validation
        ? ['official-sysml-v2-validator']
        : [];
  const knowledge = entry.toolName === 'search_reviewed_knowledge' && entry.output && typeof entry.output === 'object'
    ? entry.output
    : null;
  const domainEvidence = entry.toolName === 'search_engineering_domain_evidence'
    && entry.output && typeof entry.output === 'object'
    ? entry.output
    : null;
  const domainWarningCodes = (domainEvidence?.warnings || [])
    .map((warning) => String(warning || ''))
    .filter(Boolean)
    .slice(0, 12);
  const domainErrorCode = domainWarningCodes.find((warning) => (
    warning.startsWith('domain_web_search_result_error')
    || warning.startsWith('domain_web_search_http_')
    || warning === 'domain_web_search_timeout'
  ));
  return {
    participant: entry.executionContext?.participant || '',
    taskId: entry.executionContext?.taskId || '',
    taskRevision: entry.executionContext?.taskRevision,
    roundEpoch: entry.executionContext?.roundEpoch,
    validatorStatus: validation
      ? (officialPassed && coursePassed && validation.completeness === 'complete' ? 'validated_passed' : 'validated_failed')
      : '',
    ...(validation ? {
      validatorObservations: (entry.validatorObservations || []).slice(0, 2).map((observation) => ({
        attempt: observation.attempt,
        admissionOutcome: observation.admissionOutcome,
        queueWaitMs: observation.queueWaitMs,
        executionMs: observation.executionMs,
        retryableBeforeStart: observation.retryableBeforeStart,
        abortedAfterStart: observation.abortedAfterStart
      }))
    } : {}),
    candidateWorkspaceHash: validation?.candidateWorkspaceHash || '',
    evidenceIds: evidenceIds.filter(Boolean).slice(0, 64),
    bundleId: knowledge?.bundleId || '',
    baselineId: knowledge?.baselineId || '',
    coverage: knowledge?.coverage || '',
    sourceRegistryHash: knowledge?.sourceRegistryHash || '',
    bundleContentHash: knowledge?.bundleContentHash || '',
    requestedQueryHash: knowledge?.requestedQueryHash || '',
    effectiveQueryHash: knowledge?.effectiveQueryHash || '',
    resultHash: knowledge?.resultHash || '',
    claimIds: (knowledge?.claims || []).map((claim) => claim.claimId).filter(Boolean).slice(0, 25),
    conflictIds: (knowledge?.conflicts || []).filter(Boolean).slice(0, 25),
    domainTransportStatus: domainEvidence?.status || '',
    domainSearchRequestCount: Number(domainEvidence?.searchRequestCount || 0),
    domainSourceCount: Array.isArray(domainEvidence?.sources) ? domainEvidence.sources.length : 0,
    domainSummaryChars: String(domainEvidence?.summary || '').length,
    domainWarningCodes,
    diagnosticCount: Array.isArray(validation?.official?.diagnostics) ? validation.official.diagnostics.length : 0,
    primaryDiagnostics: validationPrimaryDiagnostics(validation),
    errorCode: entry.error?.name || domainErrorCode || '',
    errorMessage: entry.error?.message || ''
  };
}

function validationPrimaryDiagnostics(validation) {
  if (!validation || typeof validation !== 'object') return [];
  const officialPassed = validation.official?.syntax === 'passed' && validation.official?.semantic === 'passed';
  const source = officialPassed && validation.courseRules?.status === 'failed'
    ? validation.courseRules.diagnostics
    : validation.official?.diagnostics;
  const unique = new Set();
  return (Array.isArray(source) ? source : [])
    .filter((item) => item?.severity === 'error')
    .sort((left, right) => (
      Number(left?.line || Number.MAX_SAFE_INTEGER) - Number(right?.line || Number.MAX_SAFE_INTEGER)
      || Number(left?.column || Number.MAX_SAFE_INTEGER) - Number(right?.column || Number.MAX_SAFE_INTEGER)
    ))
    .flatMap((item) => {
      const diagnostic = {
        severity: 'error',
        code: String(item?.code || 'validator').slice(0, 120),
        message: String(item?.message || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240),
        fileId: String(item?.fileId || '').slice(0, 160),
        line: nonNegativeInteger(item?.line) ?? 0,
        column: nonNegativeInteger(item?.column) ?? 0
      };
      const key = `${diagnostic.fileId}:${diagnostic.line}:${diagnostic.column}:${diagnostic.code}:${diagnostic.message}`;
      if (unique.has(key)) return [];
      unique.add(key);
      return [diagnostic];
    })
    .slice(0, 3);
}

function trustedOutcomeToTeacherResponse(outcome, hostContext, fileMap, options = {}) {
  const trusted = outcome.response;
  // 最终发布层始终复核代码形状。即使 Feedback 漏报，未绑定
  // Validator 的生成代码也只能 fail closed，不能直接进入学生可见响应。
  const answerSafety = enforceAnswerCodePolicy(outcome, hostContext, fileMap);
  const safelyDegraded = Boolean(
    answerSafety.recovered || answerSafety.answer !== trusted.answer
  );
  const warnings = [...new Set([
    ...(trusted.warnings || []),
    ...(trusted.patches?.length ? ['validated_candidate_available_as_copy_only_text'] : []),
    ...(safelyDegraded ? ['post_validation_answer_safely_degraded'] : []),
    ...(answerSafety.recovered ? ['validated_candidate_recovered_from_terminal_ledger'] : []),
    ...(answerSafety.withheld ? ['unvalidated_or_unbound_code_withheld'] : []),
    ...(answerSafety.withheldReason ? [`code_withheld_reason:${answerSafety.withheldReason}`] : [])
  ])];
  const agentTrace = trustedAgentTrace(outcome, fileMap);
  const knowledgeGrounding = trustedKnowledgeGrounding(outcome);
  const codeBlockValidations = trustedCodeBlockValidations(answerSafety, trusted, fileMap);
  const candidateDelivery = candidateDeliveryContract(
    outcome,
    answerSafety,
    fileMap,
    codeBlockValidations
  );
  const candidateAttestation = trustedCandidateAttestation(
    answerSafety,
    trusted,
    codeBlockValidations,
    candidateDelivery
  );
  const publicValidatorStatus = candidateAttestation
    ? 'validated_passed'
    : (trusted.validatorStatus === 'validated_passed' ? 'not_validated' : trusted.validatorStatus);
  // 安全检查已经给出可交付的确定性结果时，必须交付该结果并在内部标记降级，
  // 不能把“内容被安全收敛”升级成整轮 503。
  const directAnswer = answerSafety.answer;
  const answerMode = 'result_bound_v2';
  const candidateRenderMode = warnings.includes('validated_candidate_rendered_from_terminal_ledger')
    ? 'terminal_ledger'
    : warnings.includes('validated_candidate_recovered_from_terminal_ledger') ? 'recovered' : 'none';
  const renderedCodeCharacters = [...String(directAnswer || '').matchAll(/```(?:sysml|sysmlv2)\s*\n([\s\S]*?)```/giu)]
    .reduce((total, match) => total + String(match[1] || '').length, 0);
  const answerCompletionStatus = candidateDelivery.status === 'incomplete'
    && trusted.answerCompletionStatus === 'complete'
    ? 'incomplete'
    : trusted.answerCompletionStatus || 'not_required';
  if (candidateDelivery.status === 'incomplete') {
    warnings.push(`candidate_delivery_incomplete:${candidateDelivery.reason}`);
  }
  const response = {
    contractVersion: CONTRACT_VERSION,
    responseId: `resp_agent_${opaqueId('id', hostContext.requestId || Date.now()).slice(3)}`,
    requestId: String(hostContext.requestId || 'agent-request'),
    answerType: 'agentic_answer',
    title: 'AI 教师',
    confidence: trusted.confidenceCap === 'high' ? 'medium' : trusted.confidenceCap,
    directAnswer,
    answerMode,
    answerCompletionStatus,
    candidateDeliveryStatus: candidateDelivery.status,
    engineeringCompletionStatus: trusted.engineeringReview?.engineeringCompletionStatus || 'not_assessed',
    engineeringReview: trusted.engineeringReview ? {
      assessmentStatus: trusted.engineeringReview.assessmentStatus,
      recommendation: trusted.engineeringReview.recommendation,
      verification: trusted.engineeringReview.verification,
      executionPlacement: trusted.engineeringReview.executionPlacement,
      engineeringCompletionStatus: trusted.engineeringReview.engineeringCompletionStatus,
      revisionDelivered: trusted.engineeringReview.revisionDelivered === true,
      engineeringResolution: trusted.engineeringReview.engineeringResolution || 'not_assessed',
      openSuggestions: (trusted.engineeringReview.openSuggestions || []).slice(0, 4).map((item) => ({
        publicSuggestionId: String(item.publicSuggestionId || '').slice(0, 200),
        summary: String(item.summary || '').slice(0, 500)
      })),
      previousVersion: publicEngineeringPreviousVersion(trusted.engineeringReview.previousVersion),
      canContinue: trusted.engineeringReview.canContinue === true
    } : undefined,
    tokenUsage: {
      promptTokens: Number(trusted.usage?.inputTokens || 0),
      completionTokens: Number(trusted.usage?.outputTokens || 0),
      reasoningTokens: Number(trusted.usage?.reasoningTokens || 0),
      totalTokens: Number(trusted.usage?.totalTokens || 0)
    },
    sections: [{
      kind: 'agent_runtime',
      title: 'Agentic teaching process',
      content: publicValidatorStatus === 'validated_passed'
        ? '候选模型结论来自受控只读工具和官方优先 Validator 流程。'
        : '模型回答已受工具账本约束；未被 Validator 工具证明的结论不会标记为已通过。'
    }],
    patches: [],
    agentTrace,
    knowledgeGrounding,
    candidateWorkspaceHash: candidateAttestation?.candidateWorkspaceHash,
    candidateAttestation,
    codeBlockValidations,
    // Agent response assembler 已按模型实际 source marker 与本 Run Ledger
    // 做过服务端绑定；发布层不得再把所有知识查询结果追加到公共响应。
    evidence: trustedEvidence(trusted.evidence || []),
    validatorStatus: publicValidatorStatus,
    warnings,
    learningEvents: [],
    __internal: {
      provider: options.provider || providerName(),
      model: options.model || '',
      promptTokens: Number(trusted.usage?.inputTokens || 0),
      completionTokens: Number(trusted.usage?.outputTokens || 0),
      reasoningTokens: Number(trusted.usage?.reasoningTokens || 0),
      totalTokens: Number(trusted.usage?.totalTokens || 0),
      knowledgeAuditRef: options.auditRef,
      agent: {
        workflowVersion: trusted.workflowVersion || 'intent-orchestrator-v2',
        stepCount: trusted.stepCount,
        stopReason: trusted.stopReason,
        stopCause: trusted.stopCause,
        toolSchemaVersion: trusted.toolSchemaVersion,
        toolTrace: trusted.toolTrace,
        validatorStatus: trusted.validatorStatus,
        candidateWorkspaceHash: trusted.candidateWorkspaceHash || '',
        buildVersion: options.buildVersion,
        promptVersion: options.promptVersion,
        promptHash: options.promptHash,
        modelAlias: options.model,
        stageModelAssignment: options.stageModelAssignment ? {
          assignmentChecksum: options.stageModelAssignment.assignmentChecksum,
          stages: Object.fromEntries(Object.entries(options.stageModelAssignment.stages || {}).map(([stageId, stage]) => [stageId, {
            modelAlias: String(stage?.modelAlias || ''),
            reasoningMode: String(stage?.reasoningMode || '')
          }]))
        } : undefined,
        fastGatePassThroughV2: trusted.fastGatePassThroughV2,
        intentV2Trace: trusted.intentV2Trace,
        mainAgentIntent: trusted.mainAgentIntent,
        mainAgentDelegation: trusted.mainAgentDelegation,
        clarificationRequest: trusted.clarificationRequest,
        mainAgentScopeResolution: trusted.mainAgentScopeResolution,
        answerCompletionStatus,
        candidateDeliveryStatus: candidateDelivery.status,
        candidateDeliveryReason: candidateDelivery.reason,
        engineeringReview: trusted.engineeringReview ? {
          assessmentStatus: trusted.engineeringReview.assessmentStatus,
          recommendation: trusted.engineeringReview.recommendation,
          verification: trusted.engineeringReview.verification,
          executionPlacement: trusted.engineeringReview.executionPlacement,
          engineeringCompletionStatus: trusted.engineeringReview.engineeringCompletionStatus,
          revisionDelivered: trusted.engineeringReview.revisionDelivered === true,
          revisionAdopted: trusted.engineeringReview.revisionAdopted === true,
          engineeringResolution: trusted.engineeringReview.engineeringResolution || 'not_assessed',
          openSuggestions: (trusted.engineeringReview.openSuggestions || []).slice(0, 4).map((item) => ({
            publicSuggestionId: String(item.publicSuggestionId || '').slice(0, 200),
            summary: String(item.summary || '').slice(0, 500)
          })),
          previousVersion: publicEngineeringPreviousVersion(trusted.engineeringReview.previousVersion),
          canContinue: trusted.engineeringReview.canContinue === true,
          pendingImprovement: trusted.engineeringReview.pendingImprovement === true,
          assessmentCallCount: nonNegativeInteger(trusted.engineeringReview.assessmentCallCount),
          mainReentryCallCount: nonNegativeInteger(trusted.engineeringReview.mainReentryCallCount),
          revisionCycleCount: nonNegativeInteger(trusted.engineeringReview.revisionCycleCount),
          verificationCallCount: nonNegativeInteger(trusted.engineeringReview.verificationCallCount)
        } : undefined,
        engineeringImprovement: trusted.engineeringReview?.pendingImprovement === true ? {
          status: 'pending',
          continuationKind: 'engineering_improvement'
        } : undefined,
        temperature: options.temperature,
        reasoningMode: options.reasoningMode,
        answerMode,
        phaseTimings: (trusted.phaseTimings || []).slice(0, 16),
        modelCalls: (trusted.modelCalls || []).slice(0, 16).map((call) => ({
          phase: String(call.phase || '').slice(0, 80),
          stepNumber: nonNegativeInteger(call.stepNumber),
          provider: String(call.provider || '').slice(0, 80),
          modelId: String(call.modelId || '').slice(0, 200),
          durationMs: nonNegativeInteger(call.durationMs) ?? 0,
          timeToFirstOutputMs: nonNegativeInteger(call.timeToFirstOutputMs),
          status: call.status === 'failed' ? 'failed' : 'succeeded',
          finishReason: String(call.finishReason || '').slice(0, 80),
          errorCategory: String(call.errorCategory || '').slice(0, 80),
          requestedOutputTokens: nonNegativeInteger(call.requestedOutputTokens),
          remainingMsAtStart: nonNegativeInteger(call.remainingMsAtStart),
          visibleOutputTokens: nonNegativeInteger(call.visibleOutputTokens),
          usage: {
            promptTokens: nonNegativeInteger(call.usage?.inputTokens) ?? 0,
            completionTokens: nonNegativeInteger(call.usage?.outputTokens) ?? 0,
            reasoningTokens: nonNegativeInteger(call.usage?.reasoningTokens) ?? 0,
            totalTokens: nonNegativeInteger(call.usage?.totalTokens) ?? 0
          }
        })),
        candidateRender: {
          mode: candidateRenderMode,
          fileCount: codeBlockValidations.length,
          characterCount: renderedCodeCharacters,
          modelCodeDiscarded: warnings.includes('model_generated_candidate_code_discarded')
        }
      }
    },
    __runtimeAttestation: {
      runtimeUsed: trusted.runtimeUsed,
      toolSchemaVersion: trusted.toolSchemaVersion,
      buildVersion: options.buildVersion,
      promptVersion: options.promptVersion,
      promptHash: options.promptHash,
      modelAlias: options.model,
      stageModelAssignmentChecksum: String(options.stageModelAssignment?.assignmentChecksum || ''),
      temperature: options.temperature,
      reasoningMode: options.reasoningMode,
      answerMode,
      workflowVersion: trusted.workflowVersion || 'intent-orchestrator-v2'
    }
  };
  return response;
}

function mapValidatorDiagnosticSummary(payload, includedFallback, excludedIncluded = 0) {
  const summary = payload?.diagnosticSummary;
  const rawIncluded = Number.isInteger(summary?.included) && summary.included >= 0
    ? Math.min(summary.included, 200)
    : Math.min(includedFallback + excludedIncluded, 200);
  const normalizedExcluded = Math.min(Math.max(0, excludedIncluded), rawIncluded);
  const included = Math.min(Math.max(0, includedFallback), rawIncluded - normalizedExcluded);
  const rawTotal = Number.isInteger(summary?.total) && summary.total >= rawIncluded
    ? summary.total
    : rawIncluded;
  // course-rule 的“官方校验未通过，规则未执行”提示不会进入 ValidationOutput.courseRules；
  // summary 必须同步减去这些被协议有意排除的诊断，避免把 Adapter 契约错误误报为 Provider 故障。
  const total = Math.max(included, rawTotal - normalizedExcluded);
  return { total, included, truncated: total > included };
}

function mapCandidateStructureEvidence(payload) {
  const evidence = payload?.structureEvidence;
  const workspaceHash = normalizeContentHash(payload?.candidateWorkspaceHash);
  const evidenceWorkspaceHash = normalizeContentHash(evidence?.candidateWorkspaceHash);
  if (!evidence || !workspaceHash || evidenceWorkspaceHash !== workspaceHash) {
    return {
      source: 'none',
      authority: 'none',
      status: 'unavailable',
      nodes: [],
      diagnostics: [{
        severity: 'warning',
        category: 'binding',
        source: 'ai-teacher-adapter',
        message: '结构证据未能绑定到本次候选工作区，已丢弃该结构视图。'
      }],
      truncated: false
    };
  }
  const source = ['official_semantic_outline', 'local_structure_analyzer', 'none'].includes(evidence.source)
    ? evidence.source
    : 'none';
  const authority = source === 'official_semantic_outline' && evidence.authority === 'authoritative'
    ? 'authoritative'
    : source === 'local_structure_analyzer' ? 'advisory' : 'none';
  const status = ['available', 'partial', 'invalid', 'unavailable'].includes(evidence.status)
    ? evidence.status
    : 'unavailable';
  const contentHash = source === 'official_semantic_outline'
    ? normalizeContentHash(evidence.contentHash)
    : undefined;
  const nodes = (Array.isArray(evidence.nodes) ? evidence.nodes : []).slice(0, 200).map((node) => compactObject({
    kind: nonEmptyText(node?.kind, 'element', 160),
    name: optionalText(node?.name, 240),
    qualifiedName: optionalText(node?.qualifiedName, 500),
    ownerPath: Array.isArray(node?.ownerPath)
      ? node.ownerPath.slice(-20).map((item) => nonEmptyText(item, 'owner', 240))
      : undefined,
    fileId: optionalText(node?.fileId, 200),
    line: positiveIntegerOrUndefined(node?.line)
  }));
  const diagnostics = (Array.isArray(evidence.diagnostics) ? evidence.diagnostics : [])
    .slice(0, 100)
    .map((item) => compactObject({
      severity: normalizeSeverity(item?.severity),
      category: optionalText(item?.category, 120),
      source: optionalText(item?.source, 160),
      message: nonEmptyText(item?.message, '结构证据诊断', 4000)
    }));
  return compactObject({
    source,
    authority,
    status,
    contentHash,
    nodes,
    diagnostics,
    truncated: evidence.truncated === true
      || (Array.isArray(evidence.nodes) && evidence.nodes.length > nodes.length)
      || (Array.isArray(evidence.diagnostics) && evidence.diagnostics.length > diagnostics.length)
  });
}

function trustedAgentTrace(outcome, fileMap) {
  const trace = outcome.response?.intentV2Trace || {};
  return compactObject({
    workflowVersion: 'intent-orchestrator-v2',
    status: ['completed', 'rejected', 'failed'].includes(trace.status) ? trace.status : 'failed',
    workerType: 'main',
    candidateValidated: outcome.response?.validatorStatus === 'validated_passed',
    stepCount: nonNegativeInteger(outcome.response?.stepCount) ?? 0,
    stopReason: nonEmptyText(outcome.response?.stopReason, 'provider_error', 40),
    stopCause: nonEmptyText(outcome.response?.stopCause, '', 40) || undefined,
    scopeHintCount: nonNegativeInteger(trace.scopeHintCount) ?? 0,
    refusedHintCount: nonNegativeInteger(trace.refusedHintCount) ?? 0,
    gateCallCount: nonNegativeInteger(trace.gateCallCount) ?? 0,
    gateOutcome: ['pass', 'mixed_scope_risk', 'reject'].includes(trace.gateOutcome)
      ? trace.gateOutcome
      : 'pass',
    gateDecisionStatus: ['completed', 'incomplete'].includes(trace.gateDecisionStatus)
      ? trace.gateDecisionStatus
      : 'incomplete',
    phaseTimings: (outcome.response?.phaseTimings || []).slice(0, 8).map((item) => ({
      phase: String(item.phase || ''),
      durationMs: nonNegativeInteger(item.durationMs) ?? 0,
      occurrences: nonNegativeInteger(item.occurrences) ?? 0
    })).filter((item) => item.phase)
  });
}

function publicModelProjectPlan(plan) {
  if (!plan || typeof plan !== 'object') return undefined;
  return compactObject({
    version: nonEmptyText(plan.version, '', 120),
    projectId: nonEmptyText(plan.projectId, '', 160),
    goalContractHash: normalizeContentHash(plan.goalContractHash),
    status: nonEmptyText(plan.status, 'active', 40),
    revision: nonNegativeInteger(plan.revision),
    currentLayerId: optionalText(plan.currentLayerId, 120),
    activeLayerIds: textList(plan.activeLayerIds, 5, 120),
    layers: (Array.isArray(plan.layers) ? plan.layers : []).slice(0, 10).map((layer) => ({
      layerId: nonEmptyText(layer.layerId, 'unknown', 120),
      title: nonEmptyText(layer.title, '未命名层', 160),
      status: nonEmptyText(layer.status, 'pending', 40),
      checkpointCount: Array.isArray(layer.checkpointIds) ? layer.checkpointIds.length : 0
    })),
    recovery: plan.recovery ? {
      resumeFromLayerId: optionalText(plan.recovery.resumeFromLayerId, 120),
      latestCheckpointId: optionalText(plan.recovery.latestCheckpointId, 160),
      resumed: plan.recovery.resumed === true
    } : undefined
  });
}

function publicModuleCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return undefined;
  return compactObject({
    version: nonEmptyText(checkpoint.version, '', 120),
    checkpointId: nonEmptyText(checkpoint.checkpointId, '', 160),
    projectId: nonEmptyText(checkpoint.projectId, '', 160),
    milestoneId: nonEmptyText(checkpoint.milestoneId, '', 160),
    layerIds: textList(checkpoint.layerIds, 5, 120),
    dependencyCheckpointIds: textList(checkpoint.dependencyCheckpointIds, 20, 160),
    candidateWorkspaceHash: normalizeContentHash(checkpoint.candidateWorkspaceHash),
    validatorEvidenceHash: normalizeContentHash(checkpoint.validatorEvidenceHash),
    domainClaimIds: textList(checkpoint.domainClaimIds, 20, 160),
    artifact: checkpoint.artifact ? {
      mode: nonEmptyText(checkpoint.artifact.mode, '', 80),
      fileCount: Array.isArray(checkpoint.artifact.files) ? checkpoint.artifact.files.length : 0,
      inventory: checkpoint.artifact.inventory
    } : undefined,
    goalEvaluation: checkpoint.goalEvaluation,
    createdAt: optionalText(checkpoint.createdAt, 80)
  });
}

function trustedKnowledgeGrounding(outcome) {
  const claimIds = new Set();
  const evidenceIds = new Set();
  for (const entry of outcome.ledger || []) {
    if (entry.toolName !== 'search_reviewed_knowledge' || entry.status !== 'succeeded') continue;
    const output = entry.output && typeof entry.output === 'object' ? entry.output : {};
    for (const claim of output.claims || output.newClaims || []) {
      if (claim?.claimId) claimIds.add(String(claim.claimId));
    }
    for (const evidence of output.evidenceBlocks || output.newEvidenceBlocks || []) {
      if (evidence?.evidenceId) evidenceIds.add(String(evidence.evidenceId));
    }
  }
  return {
    used: claimIds.size > 0 || evidenceIds.size > 0,
    uniqueClaimCount: claimIds.size,
    uniqueEvidenceCount: evidenceIds.size
  };
}

function selectAgentWorkflowVersion(hostContext, _config = {}) {
  const assigned = hostContext?.runtimeAssignment?.workflowVersion;
  if (assigned !== undefined && assigned !== 'intent-orchestrator-v2') {
    const error = new Error('AI Teacher workflow V1 has been retired.');
    error.code = 'AI_TEACHER_WORKFLOW_ASSIGNMENT_INVALID';
    throw error;
  }
  return 'intent-orchestrator-v2';
}

function frozenAgentWorkflowVersion(hostContext) {
  return selectAgentWorkflowVersion(hostContext);
}

function knowledgeLedgerAudit(entry) {
  const canonicalArgs = parseCanonicalJson(entry.canonicalArgs);
  const resultPayload = entry.output && typeof entry.output === 'object' ? entry.output : {};
  const queryCharacters = String(
    canonicalArgs?.query
      || (Array.isArray(canonicalArgs?.questions) ? canonicalArgs.questions.join('\n') : '')
  ).length;
  const resultCharacters = JSON.stringify(resultPayload).length;
  const started = Date.parse(entry.startedAt || '');
  const finished = Date.parse(entry.finishedAt || '');
  return {
    canonicalArgs,
    resultPayload,
    metrics: {
      durationMs: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0,
      queryCharacters,
      resultCharacters,
      estimatedQueryTokens: Math.ceil(queryCharacters / 4),
      estimatedResultTokens: Math.ceil(resultCharacters / 4),
      backendExecuted: !entry.replayedFromRunId && entry.replayCount === 0 && entry.output?.auditStatus !== 'duplicate_query',
      duplicateQuery: entry.replayCount > 0 || entry.output?.auditStatus === 'duplicate_query',
      replayedFromRunId: entry.replayedFromRunId || ''
    }
  };
}

function parseCanonicalJson(value) {
  try {
    return JSON.parse(String(value || '{}'));
  } catch {
    return {};
  }
}

function trustedCodeBlockValidations(answerSafety, trusted, fileMap) {
  if (answerSafety.withheld) return [];
  const blocks = [...String(answerSafety.answer || '').matchAll(/```(?:sysml|sysmlv2)\s*\n([\s\S]*?)```/giu)];
  if (trusted.validatorStatus !== 'validated_passed' || !trusted.validation) {
    return blocks.flatMap((match, index) => {
      const content = canonicalCodeBlockText(match[1]);
      const binding = currentModelExcerptBinding(content, fileMap);
      return binding ? [{
        index,
        language: 'sysml',
        status: 'current_model_excerpt',
        label: '当前模型摘录 · 未自动验证',
        message: '该代码块逐字来自学生当前模型，仅用于解释上下文；本次 Agent 未把它作为候选代码运行 Validator。',
        source: 'trusted-editor-context',
        validationCompleteness: 'not_run',
        boundFileId: binding.fileId,
        boundFileHash: binding.contentHash,
        contentHash: hashContent(content)
      }] : [];
    });
  }
  const bindings = Array.isArray(answerSafety.codeBindings) ? answerSafety.codeBindings : [];
  if (bindings.length !== blocks.length) return [];
  return blocks.map((match, index) => ({
    index,
    language: 'sysml',
    status: 'validated_passed',
    label: '已在候选工作区中通过官方 validator',
    message: '该代码块已按精确内容绑定到终末候选工作区，并在该工作区上下文中通过官方 SysML v2 Validator。',
    syntaxValid: trusted.validation.official.syntax === 'passed',
    semanticValid: trusted.validation.official.semantic === 'passed',
    coursePassed: trusted.validation.courseRuleApplicability === 'not_applicable'
      || (trusted.validation.courseRuleApplicability === 'applicable'
        && trusted.validation.courseRules?.status === 'passed'),
    source: OFFICIAL_VALIDATOR_SOURCE,
    validatorVersion: trusted.validation.validator.version,
    validationCompleteness: trusted.validation.completeness === 'complete' ? 'official' : 'partial',
    fallbackActive: false,
    candidateWorkspaceHash: trusted.candidateWorkspaceHash,
    validationScope: bindings[index].validationScope,
    boundFileId: bindings[index].fileId,
    contentHash: bindings[index].contentHash
  }));
}

function currentModelExcerptBinding(fragment, fileMap) {
  const exact = canonicalCodeBlockText(fragment);
  if (!exact) return null;
  const files = new Set(fileMap instanceof Map ? fileMap.values() : []);
  return [...files].find((file) => containsWithIdentifierBoundaries(
    canonicalCodeForBinding(file?.content),
    exact
  )) || null;
}

function canonicalCodeBlockText(value) {
  let text = String(value || '').replace(/\r\n|\r/g, '\n');
  if (text.startsWith('\n')) text = text.slice(1);
  if (text.endsWith('\n')) text = text.slice(0, -1);
  return text;
}

function trustedCandidateAttestation(answerSafety, trusted, codeBlockValidations, candidateDelivery) {
  if (answerSafety.withheld
    || !['changed_delivered', 'no_change'].includes(candidateDelivery?.status)
    || codeBlockValidations.length !== 1
    || trusted.validatorStatus !== 'validated_passed'
    || !trusted.candidateWorkspaceHash) return undefined;
  return {
    validatorStatus: 'validated_passed',
    validatorSource: OFFICIAL_VALIDATOR_SOURCE,
    validatorVersion: trusted.validation.validator.version,
    validationCompleteness: trusted.validation?.completeness === 'complete' ? 'official' : 'partial',
    fallbackActive: false,
    candidateWorkspaceHash: trusted.candidateWorkspaceHash,
    codeBlockContentHashes: codeBlockValidations.map((item) => item.contentHash)
  };
}

function candidateDeliveryContract(outcome, answerSafety, fileMap, codeBlockValidations) {
  if (!candidateExpectedForOutcome(outcome)) {
    return { status: 'not_required', reason: 'candidate_not_expected' };
  }
  const binding = terminalValidatedCandidateBinding(outcome, fileMap);
  const target = singleFileDeliveryTarget(binding);
  if (!target.ok) return { status: 'incomplete', reason: target.reason };
  if (answerSafety.withheld) {
    return { status: 'incomplete', reason: answerSafety.withheldReason || 'candidate_code_withheld' };
  }
  const expectedContentHash = hashContent(canonicalCodeForBinding(target.candidate.content));
  const bindings = Array.isArray(answerSafety.codeBindings) ? answerSafety.codeBindings : [];
  if (bindings.length !== 1
    || bindings[0]?.fileId !== target.candidate.fileId
    || bindings[0]?.contentHash !== expectedContentHash
    || codeBlockValidations.length !== 1
    || codeBlockValidations[0]?.boundFileId !== target.candidate.fileId
    || codeBlockValidations[0]?.contentHash !== expectedContentHash) {
    return { status: 'incomplete', reason: 'public_code_set_mismatch' };
  }
  return {
    status: target.changed ? 'changed_delivered' : 'no_change',
    reason: target.changed ? 'single_changed_file_delivered' : 'single_file_unchanged',
    fileId: target.candidate.fileId,
    contentHash: expectedContentHash
  };
}

function trustedEvidence(items) {
  const evidence = [{
    evidenceId: 'ev_agent_model_inference',
    authorityLevel: 'E',
    sourceType: 'llm_provider',
    sourceTitle: 'AI Teacher Agent model inference',
    sourceUrl: '',
    sourceVersion: '',
    quote: '',
    summary: 'Model-generated explanation; trusted validation and source metadata come from the server tool ledger.',
    confidence: 'medium'
  }];
  for (const item of (items || []).slice(0, 19)) {
    evidence.push({
      evidenceId: opaqueId('ev', `${item.sourceType}:${item.sourceId}:${item.contentHash}`),
      authorityLevel: evidenceAuthority(item),
      sourceType: item.sourceType,
      sourceTitle: nonEmptyText(item.sourceId, item.sourceType, 240),
      sourceUrl: '',
      sourceVersion: nonEmptyText(item.version, 'unversioned', 120),
      quote: '',
      summary: `Trusted ${item.sourceType} evidence recorded by the Agent tool ledger.`,
      confidence: item.sourceType === 'validator' ? 'high' : 'medium',
      contentHash: item.contentHash
    });
  }
  return evidence;
}

function evidenceAuthority(item) {
  if (item.sourceType === 'validator' || item.authority === 'official') return 'A';
  if (item.authority === 'reviewed_reference' || item.authority === 'project_skill') return 'B';
  if (item.authority === 'reviewed_project') return 'C';
  if (item.authority === 'reference') return 'D';
  return 'D';
}

function enforceValidatedCodeAnswer(outcome, hostContext, fileMap) {
  const answer = String(outcome.response?.answer || '');
  const candidateExpected = candidateExpectedForOutcome(outcome);
  const withhold = (reason) => withheldCodeAnswer(answer, reason, {
    discloseToStudent: candidateExpected,
    preserveCurrentModelFragments: !candidateExpected,
    preserveInlineTeachingFragments: outcome.response?.answerMode === 'result_bound_v2',
    fileMap
  });
  const parsedMarkdown = parseMarkdownFences(answer);
  const fencedBlocks = parsedMarkdown.blocks;
  const allSysmlCodeBlocks = fencedBlocks
    .filter((block) => block.closed && (block.language === 'sysml' || block.language === 'sysmlv2'))
    .map((block) => block.content)
    .filter(Boolean);
  const codeBlocks = candidateExpected
    ? allSysmlCodeBlocks
    : allSysmlCodeBlocks.filter((block) => !currentModelContainsExactFragment(block, fileMap));
  const ambiguousSysmlFences = fencedBlocks.filter(
    (block) => !block.closed || (
      !['sysml', 'sysmlv2'].includes(block.language)
      && fenceContainsSysmlStructure(block.content)
      && !currentModelContainsExactFragment(block.content, fileMap)
      && !currentModelContainsAllExcerptLines(block.content, fileMap)
    )
  );
  const ambiguousInlineSysml = [...answer.matchAll(/`([^`\r\n]+)`/gu)]
    .map((match) => String(match[1] || '').trim())
    .filter((inline) => isSysmlStatementLine(inline));
  const unboundInlineSysml = candidateExpected
    ? ambiguousInlineSysml
    : ambiguousInlineSysml.filter((inline) => !currentModelContainsExactFragment(inline, fileMap));
  // 只检查 Markdown 代码标记之外的裸语句；已经识别出的 sysml fence 会在下方
  // 通过 Validator 结果和候选工作区哈希进行绑定，不能再次被当成裸代码拦截。
  const proseOutsideCode = renderedInlineMarkdownText(parsedMarkdown.proseOutside);
  const bareSysmlStatements = findBareSysmlStatementRanges(proseOutsideCode)
    .filter((range) => (
      candidateExpected
      || !currentModelContainsExactFragment(
        proseOutsideCode.slice(range.start, range.end),
        fileMap
      )
    ));
  const requiresValidation = codeBlocks.length > 0
    || ambiguousSysmlFences.length > 0
    || unboundInlineSysml.length > 0
    || bareSysmlStatements.length > 0
    || candidateExpected;
  if (!requiresValidation) return { answer, withheld: false };
  if (ambiguousSysmlFences.length > 0
    || unboundInlineSysml.length > 0
    || bareSysmlStatements.length > 0) {
    return recoverValidatedCandidateAnswer(
      outcome,
      fileMap,
      answer,
      'unfenced_or_ambiguous_sysml'
    ) || withhold('unfenced_or_ambiguous_sysml');
  }
  if (outcome.response?.validatorStatus !== 'validated_passed') {
    return withhold('validator_not_passed');
  }

  const terminalBinding = terminalValidatedCandidateBinding(outcome, fileMap);
  if (!terminalBinding) {
    return withhold('terminal_validation_not_bound');
  }
  const deliveryTarget = singleFileDeliveryTarget(terminalBinding);
  if (!deliveryTarget.ok) return withhold(deliveryTarget.reason);
  const candidateText = {
    fileId: deliveryTarget.candidate.fileId,
    content: canonicalCodeForBinding(deliveryTarget.candidate.content)
  };
  if (codeBlocks.length !== 1) {
    return recoverValidatedCandidateAnswer(
      outcome,
      fileMap,
      answer,
      codeBlocks.length === 0 ? 'candidate_response_missing_code' : 'candidate_response_code_count_mismatch'
    ) || withhold(codeBlocks.length === 0
      ? 'candidate_response_missing_code'
      : 'candidate_response_code_count_mismatch');
  }
  const codeBindings = codeBlocks.map((block) => {
    if (candidateText.content === block) {
      return {
        fileId: candidateText.fileId,
        validationScope: 'candidate_file',
        contentHash: hashContent(block)
      };
    }
    return null;
  });
  if (codeBindings.some((binding) => !binding)) {
    return recoverValidatedCandidateAnswer(
      outcome,
      fileMap,
      answer,
      'code_block_not_bound'
    ) || withhold('code_block_not_bound');
  }

  return { answer, withheld: false, codeBindings };
}

function candidateExpectedForOutcome(outcome) {
  if (['candidate', 'repair'].includes(String(outcome.response?.mainAgentDelegation?.action || ''))) {
    return true;
  }
  // 续跑通过resume_checkpoint恢复服务端Candidate，不会再次创建Main delegation。
  // 但它仍然承担同一个候选交付义务，不能因缺少新的delegation记录而省略代码块。
  return resumedCandidateExpectedForOutcome(outcome);
}

function resumedCandidateExpectedForOutcome(outcome) {
  return outcome.mainAgentOutcome?.type === 'resume_execution';
}

function enforceAnswerCodePolicy(outcome, hostContext, fileMap) {
  const answer = String(outcome.response?.answer || '');
  if (candidateExpectedForOutcome(outcome)) {
    return enforceValidatedCodeAnswer(outcome, hostContext, fileMap);
  }
  if (outcome.response?.answerMode !== 'result_bound_v2') {
    return enforceValidatedCodeAnswer(outcome, hostContext, fileMap);
  }
  const parsed = parseMarkdownFences(answer);
  const hasExplicitSysmlBlock = parsed.blocks.some((block) => (
    (block.closed && ['sysml', 'sysmlv2'].includes(block.language))
    || fenceContainsSysmlStructure(block.content)
  ));
  // result-bound-v2 只把明确代码块视为候选模型。行内操作符、标识符和短声明
  // 是概念教学正文，不得再次触发“未验证候选”并吞掉整篇正确答案。
  return hasExplicitSysmlBlock
    ? enforceValidatedCodeAnswer(outcome, hostContext, fileMap)
    : { answer, withheld: false };
}

function parseMarkdownFences(value) {
  const lines = String(value || '').replace(/\r\n|\r/g, '\n').split('\n');
  const blocks = [];
  const proseLines = [];
  let open;
  for (const line of lines) {
    if (!open) {
      const opening = fenceOpeningCandidate(line);
      const match = /^([ \t]*)(`{3,}|~{3,})([^\r\n]*)$/.exec(opening.line);
      if (!match) {
        proseLines.push(line);
        continue;
      }
      const indentation = match[1] || '';
      const markerRun = match[2] || '';
      const info = String(match[3] || '').trim();
      open = {
        marker: markerRun[0],
        length: markerRun.length,
        language: String(info.split(/\s+/)[0] || '').toLowerCase(),
        content: [],
        containerized: opening.containerized || indentation.includes('\t') || indentation.length > 3
      };
      proseLines.push('');
      continue;
    }
    const close = open.containerized ? null : /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
    if (close && close[1]?.[0] === open.marker && close[1].length >= open.length) {
      blocks.push({
        language: open.language,
        content: canonicalCodeForBinding(open.content.join('\n')),
        closed: true
      });
      open = undefined;
      proseLines.push('');
      continue;
    }
    open.content.push(line);
    proseLines.push('');
  }
  if (open) {
    blocks.push({
      language: open.language,
      content: canonicalCodeForBinding(open.content.join('\n')),
      closed: false
    });
  }
  return { blocks, proseOutside: proseLines.join('\n') };
}

function fenceOpeningCandidate(value) {
  let line = String(value || '');
  let containerized = false;
  while (true) {
    const quote = /^[ \t]*>[ \t]?/.exec(line);
    const list = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/.exec(line);
    const prefix = quote?.[0] || list?.[0];
    if (!prefix) break;
    line = line.slice(prefix.length);
    containerized = true;
  }
  return { line, containerized };
}

function currentModelContainsExactFragment(fragment, fileMap) {
  const canonical = canonicalCodeForBinding(fragment).trim();
  if (!canonical) return false;
  const files = new Set(fileMap instanceof Map ? fileMap.values() : []);
  return [...files].some((file) => containsWithIdentifierBoundaries(
    canonicalCodeForBinding(file?.content),
    canonical
  ));
}

function currentModelContainsAllExcerptLines(fragment, fileMap) {
  const lines = canonicalCodeForBinding(fragment)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => currentModelContainsExactFragment(line, fileMap));
}

function fenceContainsSysmlStructure(value) {
  const text = stripSysmlComments(String(value || ''));
  return findBareSysmlStatementRanges(text).length > 0
    || text.split(/\r?\n/gu).some((line) => isSysmlStatementLine(line));
}

function containsWithIdentifierBoundaries(source, candidate) {
  let offset = String(source || '').indexOf(candidate);
  while (offset >= 0) {
    const before = offset > 0 ? source[offset - 1] || '' : '';
    const afterOffset = offset + candidate.length;
    const after = afterOffset < source.length ? source[afterOffset] || '' : '';
    const startsWithIdentifier = /^[\p{L}\p{N}_]/u.test(candidate);
    const endsWithIdentifier = /[\p{L}\p{N}_]$/u.test(candidate);
    const beforeIsIdentifier = /[\p{L}\p{N}_]/u.test(before);
    const afterIsIdentifier = /[\p{L}\p{N}_]/u.test(after);
    if ((!startsWithIdentifier || !beforeIsIdentifier)
      && (!endsWithIdentifier || !afterIsIdentifier)) return true;
    offset = source.indexOf(candidate, offset + 1);
  }
  return false;
}

function recoverValidatedCandidateAnswer(outcome, fileMap, originalAnswer, reason) {
  const binding = terminalValidatedCandidateBinding(outcome, fileMap);
  const target = singleFileDeliveryTarget(binding);
  if (!target.ok) return null;
  const blocks = [{
    fileId: target.candidate.fileId,
    displayName: target.candidate.displayName,
    content: canonicalCodeForBinding(target.candidate.content),
    validationScope: 'candidate_file'
  }];
  const totalCodeLength = blocks.reduce((total, block) => total + block.content.length, 0);
  if (!blocks.length
    || totalCodeLength > 100_000
    || blocks.some((block) => block.content.includes('```'))) return null;

  const sanitized = stripUntrustedSysmlFragments(originalAnswer);
  const teachingText = substantiveTeachingText(sanitized)
    ? sanitized.trim()
    : '下面给出与终末候选工作区精确绑定的已验证候选。';
  const recoveredBlocks = blocks.map((block) => {
    const displayName = String(block.displayName || block.fileId)
      .replace(/[\r\n`]/gu, '')
      .slice(0, 160);
    return `文件：${displayName}\n\n\`\`\`sysml\n${block.content}\n\`\`\``;
  }).join('\n\n');
  return {
    answer: `${teachingText}\n\n【模型生成的代码格式未能安全绑定；以下内容由服务端从终末已验证候选中精确回填。】\n\n${recoveredBlocks}`,
    withheld: false,
    recovered: true,
    recoveryReason: reason,
    codeBindings: blocks.map((block) => ({
      fileId: block.fileId,
      validationScope: block.validationScope,
      contentHash: hashContent(block.content)
    }))
  };
}

function renderValidatedCandidateAnswer(outcome, fileMap, originalAnswer) {
  if (!candidateExpectedForOutcome(outcome)) return null;
  const binding = terminalValidatedCandidateBinding(outcome, fileMap);
  const target = singleFileDeliveryTarget(binding);
  if (!target.ok) return null;
  const blocks = [{
    fileId: target.candidate.fileId,
    displayName: target.candidate.displayName,
    content: canonicalCodeForBinding(target.candidate.content),
    validationScope: 'candidate_file'
  }];
  const totalCodeLength = blocks.reduce((total, block) => total + block.content.length, 0);
  if (!blocks.length
    || totalCodeLength > 100_000
    || blocks.some((block) => block.content.includes('```'))) return null;

  const parsed = parseMarkdownFences(originalAnswer);
  const modelCodeDiscarded = parsed.blocks.some((block) => (
    ['sysml', 'sysmlv2'].includes(block.language) || fenceContainsSysmlStructure(block.content)
  )) || [...String(originalAnswer || '').matchAll(/`([^`\r\n]+)`/gu)]
    .some((match) => isSysmlStatementLine(String(match[1] || '').trim()))
    || findBareSysmlStatementRanges(renderedInlineMarkdownText(parsed.proseOutside)).length > 0;
  const sanitized = stripUntrustedSysmlFragments(originalAnswer, {
    preserveInlineTeachingFragments: false,
    fileMap
  });
  const teachingText = substantiveTeachingText(sanitized)
    ? sanitized.trim()
    : '下面给出终末候选模型及其验证结果。';
  const renderedBlocks = blocks.map((block) => {
    const displayName = String(block.displayName || block.fileId)
      .replace(/[\r\n`]/gu, '')
      .slice(0, 160);
    return `文件：${displayName}\n\n\`\`\`sysml\n${block.content}\n\`\`\``;
  }).join('\n\n');
  return {
    answer: `${teachingText}\n\n以下代码由服务端从终末已验证候选工作区直接呈现。\n\n${renderedBlocks}`,
    withheld: false,
    rendered: true,
    modelCodeDiscarded,
    codeBindings: blocks.map((block) => ({
      fileId: block.fileId,
      validationScope: block.validationScope,
      contentHash: hashContent(block.content)
    }))
  };
}

function terminalValidatedCandidateBinding(outcome, fileMap) {
  const trusted = outcome.response;
  const validation = trusted?.validation;
  const officialPassed = validation?.official?.syntax === 'passed'
    && validation?.official?.semantic === 'passed';
  const coursePassed = validation?.courseRuleApplicability === 'not_applicable'
    || (validation?.courseRuleApplicability === 'applicable'
      && validation?.courseRules?.status === 'passed');
  if (trusted?.validatorStatus !== 'validated_passed'
    || trusted.stopReason !== 'completed'
    || !officialPassed
    || !coursePassed
    || validation?.completeness !== 'complete'
    || validation?.validator?.authority !== 'official-sysml-v2-validator'
    || !String(validation?.validator?.version || '').startsWith(`${OFFICIAL_VALIDATOR_RELEASE}/${OFFICIAL_VALIDATOR_KERNEL}/sha256:`)
    || !trusted.candidateWorkspaceHash
    || validation.candidateWorkspaceHash !== trusted.candidateWorkspaceHash) {
    return null;
  }
  const validationEntries = (outcome.ledger || []).filter(
    (entry) => entry.toolName === 'validate_candidate_workspace'
  );
  const terminal = validationEntries.at(-1);
  if (!terminal || terminal.status !== 'succeeded'
    || terminal.output?.candidateWorkspaceHash !== trusted.candidateWorkspaceHash
    || terminal.output?.validator?.evidenceHash !== validation.validator.evidenceHash) {
    return null;
  }
  const candidates = candidateRecordsFromLedger(terminal, fileMap);
  if (!candidates.length) return null;
  if (candidateWorkspaceHashFromRecords(fileMap, candidates) !== trusted.candidateWorkspaceHash) return null;
  const changedCandidates = candidates.filter(
    (candidate) => canonicalCodeForBinding(candidate.base) !== canonicalCodeForBinding(candidate.content)
  );
  const patches = Array.isArray(terminal.output?.patches) ? terminal.output.patches : [];
  const standaloneCandidates = candidates.filter((candidate) => candidate.kind === 'standalone_model');
  if (standaloneCandidates.length > 0) {
    return standaloneCandidates.length === 1 && candidates.length === 1 && patches.length === 0
      ? { terminal, candidates, changedCandidates: standaloneCandidates }
      : null;
  }
  if (!changedCandidates.length) {
    return patches.length === 0 ? { terminal, candidates, changedCandidates } : null;
  }
  const uniqueFileIds = new Set(changedCandidates.map((candidate) => candidate.fileId));
  const uniquePatchFileIds = new Set(patches.map((patch) => patch?.fileId));
  if (uniqueFileIds.size !== changedCandidates.length
    || uniquePatchFileIds.size !== patches.length
    || patches.length !== changedCandidates.length) return null;
  for (const candidate of changedCandidates) {
    const current = fileMap.get(candidate.fileId);
    const patch = patches.find((item) => item?.fileId === candidate.fileId);
    if (!current
      || current.editable === false
      || !patch
      || patch.baseHash !== current.contentHash
      || patch.candidateHash !== hashContent(candidate.content)
      || patch.kind !== candidate.kind) {
      return null;
    }
  }
  return { terminal, candidates, changedCandidates };
}

function singleFileDeliveryTarget(binding) {
  if (!binding) return { ok: false, reason: 'terminal_validation_not_bound' };
  if (binding.changedCandidates.length > 1) {
    return { ok: false, reason: 'multi_file_delivery_unsupported' };
  }
  if (binding.changedCandidates.length === 1) {
    return { ok: true, changed: true, candidate: binding.changedCandidates[0] };
  }
  if (binding.candidates.length === 1) {
    return { ok: true, changed: false, candidate: binding.candidates[0] };
  }
  return {
    ok: false,
    reason: binding.candidates.length > 1 ? 'multi_file_delivery_unsupported' : 'candidate_not_bound'
  };
}

function withheldCodeAnswer(originalAnswer = '', reason = 'unvalidated_code', options = {}) {
  const sanitized = stripUntrustedSysmlFragments(originalAnswer, options);
  const disclosure = options.discloseToStudent === false
    ? ''
    : '\n\n【未显示的 SysML 代码片段未与终末官方 Validator PASS 精确绑定。】';
  return {
    answer: substantiveTeachingText(sanitized)
      ? `${sanitized.trim()}${disclosure}`
      : '当前候选代码没有与终末官方 Validator PASS 形成可核对绑定，因此本次不向学生输出代码。请重新生成并验证候选模型。',
    withheld: true,
    withheldReason: reason
  };
}

function stripUntrustedSysmlFragments(value, options = {}) {
  let text = String(value || '');
  text = text.replace(/```([^\r\n`]*)[ \t]*\r?\n([\s\S]*?)```/giu, (full, language, content) => {
    const normalizedLanguage = String(language || '').trim().toLowerCase();
    const looksLikeSysml = ['sysml', 'sysmlv2'].includes(normalizedLanguage)
      || findBareSysmlStatementRanges(content).length > 0;
    return looksLikeSysml ? '\n' : full;
  });
  const protectedInline = [];
  text = text.replace(/`([^`\r\n]+)`/gu, (full, inline) => (
    !options.preserveInlineTeachingFragments
      && isSysmlStatementLine(String(inline || '').trim())
      && !(options.preserveCurrentModelFragments === true
        && currentModelContainsExactFragment(String(inline || '').trim(), options.fileMap))
      ? ''
      : protectInlineFragment(full, protectedInline)
  ));
  text = stripBareSysmlStatements(text);
  for (let index = 0; index < protectedInline.length; index += 1) {
    text = text.replace(inlineProtectionToken(index), protectedInline[index]);
  }
  const lines = text.split(/\r?\n/u);
  const retained = lines.filter((line) => !isSysmlStatementLine(line.trim()));
  const sanitized = retained.join('\n').replace(/(?:\n\s*){3,}/gu, '\n\n').trim();
  const textForResidualStatementCheck = options.preserveInlineTeachingFragments
    ? sanitized.replace(/`[^`\r\n]+`/gu, '')
    : sanitized;
  const visibleText = renderedInlineMarkdownText(textForResidualStatementCheck);
  const stillContainsUnboundStatement = findBareSysmlStatementRanges(visibleText).some((range) => (
    !(options.preserveCurrentModelFragments === true
      && currentModelContainsExactFragment(
        visibleText.slice(range.start, range.end),
        options.fileMap
      ))
  ));
  // 对跨多个 Markdown span 拼出的声明仍然 fail closed；但先删除完整代码块，
  // 避免一个未验证示例吞掉同一回答中可以安全保留的自然语言解释。
  return stillContainsUnboundStatement ? '' : sanitized;
}

function protectInlineFragment(value, protectedInline) {
  const index = protectedInline.push(String(value || '')) - 1;
  return inlineProtectionToken(index);
}

function inlineProtectionToken(index) {
  return `\uE000AI_TEACHER_INLINE_${index}\uE001`;
}

function renderedInlineMarkdownText(value) {
  return String(value || '')
    .replace(/`([^`\r\n]+)`/gu, '$1')
    .replace(/\*\*|__|~~/gu, '');
}

function stripBareSysmlStatements(value) {
  const source = String(value || '');
  const ranges = findBareSysmlStatementRanges(source);
  if (!ranges.length) return source;
  let stripped = source;
  for (const range of [...ranges].reverse()) {
    stripped = `${stripped.slice(0, range.start)} ${stripped.slice(range.end)}`;
  }
  return stripped;
}

function findBareSysmlStatementRanges(value) {
  const source = String(value || '');
  const declarationStart = new RegExp(SYSML_DECLARATION_PATTERN, 'giu');
  const ranges = [];
  let match;
  while ((match = declarationStart.exec(source)) !== null) {
    const start = match.index;
    if (start > 0 && /[A-Za-z0-9_]/u.test(source[start - 1])) continue;
    const maximumEnd = Math.min(source.length, start + 1000);
    const tail = source.slice(start, maximumEnd);
    const paragraphBoundary = /\r?\n[ \t]*\r?\n/u.exec(tail);
    const scanLimit = paragraphBoundary ? paragraphBoundary.index : tail.length;
    const candidateWindow = tail.slice(0, scanLimit);
    const terminator = /[;{}]/u.exec(candidateWindow);
    const firstLineEnd = /\r?\n/u.exec(candidateWindow);
    const end = terminator
      ? start + terminator.index + terminator[0].length
      : start + (firstLineEnd ? firstLineEnd.index : candidateWindow.length);
    if (end <= start) continue;
    const fragment = source.slice(start, end);
    if (looksLikeBareSysmlStatement(fragment)) {
      ranges.push({ start, end });
    }
    // Do not reinterpret a nested keyword in the same natural-language
    // clause after the outer candidate has already been classified.
    declarationStart.lastIndex = Math.max(declarationStart.lastIndex, end);
  }
  return ranges;
}

function looksLikeBareSysmlStatement(value) {
  const normalized = stripMarkdownStatementPrefix(stripSysmlComments(value))
    .replace(/\*\*|__|~~/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const name = String.raw`(?:'[^']+'|[\p{L}_][\p{L}\p{N}_]*)`;
  const qualifiedName = String.raw`(?:'[^']+'|[\p{L}_][\p{L}\p{N}_]*(?:::[\p{L}_][\p{L}\p{N}_]*)*)`;
  const modifiers = String.raw`(?:(?:private|public|protected|abstract|variation|variant|individual|ref|derived|readonly|ordered|nonunique|in|out|inout)\s+)*`;
  const featureKind = String.raw`(?:(?:part|item|port|connection|interface|action|state|calc|constraint|requirement|analysis|verification|use\s+case|view|viewpoint|metadata|enum|occurrence|attribute)(?:\s+def)?|end)`;
  const valueLiteral = String.raw`(?:[-+]?\d+(?:\.\d+)?|true|false|'[^']*'|"[^"]*")`;
  const relation = new RegExp(
    `^${modifiers}${featureKind}\\s+(?:${name}\\s+)?(?::>>|::>|:>|:)\\s*${qualifiedName}(?:\\s*=\\s*${valueLiteral})?\\s*;?$`,
    'iu'
  );
  if (relation.test(normalized)) return true;
  const relationWithTeachingSuffix = new RegExp(
    `^${modifiers}${featureKind}\\s+(?:${name}\\s+)?(?::>>|::>|:>|:)\\s*${qualifiedName}(?:\\s*=\\s*${valueLiteral})?(?=\\s*(?:[，。；;!?！？]|(?:是|为|表示|means?\\b|is\\b|was\\b)))`,
    'iu'
  );
  if (relationWithTeachingSuffix.test(normalized)) return true;

  const boundAttribute = new RegExp(
    `^${modifiers}attribute\\s+${name}(?:\\s*:\\s*${qualifiedName})?\\s*(?::=|=)\\s*${valueLiteral}\\s*;?$`,
    'iu'
  );
  if (boundAttribute.test(normalized)) return true;
  const boundAttributeWithTeachingSuffix = new RegExp(
    `^${modifiers}attribute\\s+${name}(?:\\s*:\\s*${qualifiedName})?\\s*(?::=|=)\\s*${valueLiteral}\\s*;?(?=\\s*(?:[，。；;!?！？]|(?:是|为|表示|means?\\b|is\\b|was\\b)))`,
    'iu'
  );
  if (boundAttributeWithTeachingSuffix.test(normalized)) return true;

  const glossaryHeading = new RegExp(`^${SYSML_DECLARATION_PATTERN}:\\s`, 'iu');
  if (glossaryHeading.test(normalized)) return false;
  const bareParameter = new RegExp(
    `^(?:in|out|inout)\\s+${name}(?:(?:\\s*(?::>>|::>|:>|:)\\s*${qualifiedName})?(?:\\s*(?::=|=)\\s*[^;{}]+)?)\\s*;$`,
    'u'
  );
  if (/^(?:in|out|inout)\b/iu.test(normalized)) {
    if (!/^(?:in|out|inout)\b/u.test(normalized)) return false;
    if (/^in\s+(?:summary|conclusion|general|practice)\s*;$/u.test(normalized)) return false;
    if (/^(?:in|out|inout)\s+(?:part|item|port|connection|interface|action|state|calc|constraint|requirement|analysis|verification|view|viewpoint|metadata|enum|occurrence|attribute)\b[^;{}]*;$/u.test(normalized)) {
      return true;
    }
    return bareParameter.test(normalized);
  }
  if (/[;{}]\s*$/u.test(normalized) && /(?::|=|->|\[|\]|~|\{)/u.test(normalized)) {
    return true;
  }

  const genericSimple = /^(?:(?:package|concern|event|timeslice|snapshot|actor|subject|objective|stakeholder|part|item|port|connection|interface|action|state|calc|constraint|requirement|analysis|verification|view|viewpoint|metadata|enum|occurrence|attribute)(?:\s+def)?)\s+(?!(?:def|usage|definition|feature|end)\b)(?:'[^']+'|[\p{L}_][\p{L}\p{N}_]*)\s*;$/iu;
  if (genericSimple.test(normalized)) return true;
  if (/^(?:allocate\s+.+\s+to\s+.+|satisfy(?:\s+requirement)?\s+.+\s+by\s+.+|perform(?:\s+action)?\s+.+|dependency(?:\s+(?:'[^']+'|[\p{L}_][\p{L}\p{N}_]*))?\s+from\s+.+\s+to\s+.+|succession\s+first\s+.+\s+then\s+.+|connect\s+.+\s+to\s+.+|flow\s+.+\s+to\s+.+|message\s+of\s+.+\s+from\s+.+\s+to\s+.+|action\s+(?:'[^']+'|[\p{L}_][\p{L}\p{N}_]*)\s+send\s+.+\s+to\s+.+)\s*;$/iu.test(normalized)) {
    return true;
  }
  if (/^(?:first\s+.+\s+then\s+.+|transition(?:\s+(?:'[^']+'|[\p{L}_][\p{L}\p{N}_]*))?\s+first\s+.+\s+then\s+.+)\s*;$/u.test(normalized)) {
    return true;
  }
  if (/^(?:return|send|accept|assign|terminate|first|then|entry|do|exit|expose|verify)\s+(?:'[^']+'|[\p{L}_][\p{L}\p{N}_]*(?:::(?:[\p{L}_][\p{L}\p{N}_]*|\*))*)\s*;$/iu.test(normalized)) {
    return true;
  }

  const simple = new RegExp(
    `^${modifiers}(?:(?:standard\\s+library\\s+)?package|concern|event|timeslice|snapshot|(?:part|item|port|connection|interface|action|state|calc|constraint|requirement|analysis|verification|use\\s+case|view|viewpoint|metadata|enum|occurrence|attribute)(?:\\s+def)?)\\s+(?!(?:def|usage|definition|feature|end)\\b)${name}\\s*(?:;|\\{)$`,
    'iu'
  );
  if (simple.test(normalized)) return true;

  return /^(?:dependency\s+(?:'[^']+'|[\p{L}_][\p{L}\p{N}_]*)\s+from\s+.+\s+to\s+.+|succession\s+first\s+.+\s+then\s+.+|(?:private\s+|public\s+)?import\s+.+|alias\s+.+\s+for\s+.+|connect\s+.+\s+to\s+.+|flow\s+.+\s+from\s+.+\s+to\s+.+)\s*;$/iu
    .test(normalized);
}

function substantiveTeachingText(value) {
  const plain = String(value || '')
    .replace(/【未显示[^】]*】/gu, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  return plain.length >= 12;
}

function candidateRecordsFromLedger(entry, fileMap) {
  let input;
  try {
    input = JSON.parse(String(entry.canonicalArgs || ''));
  } catch {
    return [];
  }
  return candidateRecordsFromInput(input, fileMap);
}

function candidateRecordsFromInput(input, fileMap) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  if (input.mode === 'standalone_model') {
    const fileName = String(input.fileName || '').trim();
    const content = String(input.content || '');
    if (!/^[\p{L}\p{N}_-][\p{L}\p{N}._-]*\.sysml$/iu.test(fileName) || !content) return [];
    return [{
      fileId: 'standalone_model',
      displayName: fileName,
      workspacePath: `standalone/${fileName}`,
      base: '',
      content,
      kind: input.mode
    }];
  }
  if (input.mode === 'replace_entry') {
    const current = fileMap.get(String(input.fileId || ''));
    const content = String(input.content || '');
    if (!current
      || input.baseHash !== current.contentHash
      || (current.editable === false && content !== current.content)) return [];
    return [{
      fileId: current.fileId,
      displayName: current.displayName,
      workspacePath: current.workspacePath,
      base: current.content,
      content,
      kind: input.mode
    }];
  }
  if (input.mode === 'workspace_files') {
    if (!Array.isArray(input.files) || !input.files.length) return [];
    const records = [];
    const seen = new Set();
    for (const candidate of input.files) {
      const current = fileMap.get(String(candidate.fileId || ''));
      const content = String(candidate.content || '');
      if (!current
        || seen.has(current.fileId)
        || candidate.baseHash !== current.contentHash
        || (current.editable === false && content !== current.content)) return [];
      seen.add(current.fileId);
      records.push({
        fileId: current.fileId,
        displayName: current.displayName,
        workspacePath: current.workspacePath,
        base: current.content,
        content,
        kind: input.mode
      });
    }
    return records;
  }
  if (input.mode === 'apply_edits') {
    if (!Array.isArray(input.edits) || !input.edits.length || input.edits.length > 24) return [];
    const grouped = new Map();
    for (const edit of input.edits || []) {
      const current = fileMap.get(String(edit.fileId || ''));
      if (!current || current.editable === false || edit.baseHash !== current.contentHash) return [];
      const list = grouped.get(current.fileId) || [];
      list.push(edit);
      grouped.set(current.fileId, list);
    }
    const records = [];
    for (const [fileId, edits] of grouped) {
      const current = fileMap.get(String(fileId || ''));
      const lines = current.content.split(/\r\n|\r|\n/);
      const normalized = edits.map((edit) => ({
        ...edit,
        startLine: Number(edit.startLine),
        endLine: Number(edit.endLine)
      }));
      if (normalized.some((edit) => (
        !Number.isInteger(edit.startLine)
        || !Number.isInteger(edit.endLine)
        || edit.startLine < 1
        || edit.endLine < edit.startLine
        || edit.endLine > lines.length + 1
      ))) return [];
      const ordered = normalized.sort(
        (left, right) => right.startLine - left.startLine || right.endLine - left.endLine
      );
      let previousStart = Number.POSITIVE_INFINITY;
      for (const edit of ordered) {
        if (edit.endLine >= previousStart) return [];
        lines.splice(
          edit.startLine - 1,
          edit.endLine - edit.startLine + 1,
          ...String(edit.replacement || '').split(/\r\n|\r|\n/)
        );
        previousStart = edit.startLine;
      }
      records.push({
        fileId: current.fileId,
        displayName: current.displayName,
        workspacePath: current.workspacePath,
        base: current.content,
        content: lines.join('\n'),
        kind: input.mode
      });
    }
    return records;
  }
  return [];
}

function candidateWorkspaceHashFromRecords(fileMap, candidates) {
  const standaloneCandidates = candidates.filter((candidate) => candidate.kind === 'standalone_model');
  if (standaloneCandidates.length > 0) {
    if (standaloneCandidates.length !== candidates.length) return '';
    const canonicalStandalone = standaloneCandidates
      .map((candidate) => ({
        path: String(candidate.workspacePath || candidate.displayName || ''),
        content: candidate.content
      }))
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => `${file.path}\n${hashContent(String(file.content || ''))}`)
      .join('\n');
    return hashContent(canonicalStandalone);
  }
  const candidateByFileId = new Map(candidates.map((candidate) => [candidate.fileId, candidate.content]));
  const uniqueFiles = new Map();
  for (const file of fileMap.values()) {
    if (!uniqueFiles.has(file.fileId)) uniqueFiles.set(file.fileId, file);
  }
  const canonical = [...uniqueFiles.values()]
    .map((file) => ({
      path: String(file.workspacePath || file.displayName || ''),
      content: candidateByFileId.has(file.fileId)
        ? candidateByFileId.get(file.fileId)
        : file.content
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\n${hashContent(String(file.content || ''))}`)
    .join('\n');
  return hashContent(canonical);
}

function recoverPersistedCompletedCandidateDelivery({
  persistedAnswer,
  sourceResponse,
  candidateArtifact,
  validationArtifact,
  hostContext
}) {
  if (sourceResponse?.validatorStatus !== 'validated_passed') {
    return persistedDeliveryIncomplete(persistedAnswer, 'validator_not_passed');
  }
  const candidateWorkspaceHash = normalizeContentHash(sourceResponse?.candidateWorkspaceHash)
    || normalizeContentHash(candidateArtifact?.candidateWorkspaceHash)
    || normalizeContentHash(validationArtifact?.candidateWorkspaceHash);
  if (!candidateWorkspaceHash
    || !trustedPersistedValidationArtifact(validationArtifact, candidateWorkspaceHash)) {
    return persistedDeliveryIncomplete(persistedAnswer, 'checkpoint_validation_not_trusted');
  }
  const mapped = createAgentContext(hostContext || {});
  const candidates = candidateRecordsFromInput(candidateArtifact, mapped.fileMap);
  if (!candidates.length
    || candidateWorkspaceHashFromRecords(mapped.fileMap, candidates) !== candidateWorkspaceHash) {
    return persistedDeliveryIncomplete(persistedAnswer, 'checkpoint_candidate_hash_mismatch');
  }
  const changedCandidates = candidates.filter(
    (candidate) => candidate.kind === 'standalone_model'
      || canonicalCodeForBinding(candidate.base) !== canonicalCodeForBinding(candidate.content)
  );
  const target = singleFileDeliveryTarget({ candidates, changedCandidates });
  if (!target.ok) return persistedDeliveryIncomplete(persistedAnswer, target.reason);

  const content = canonicalCodeForBinding(target.candidate.content);
  if (!content || content.length > 100_000 || content.includes('```')) {
    return persistedDeliveryIncomplete(persistedAnswer, 'candidate_not_renderable');
  }
  const contentHash = hashContent(content);
  const parsed = parseMarkdownFences(persistedAnswer);
  const blocks = parsed.blocks
    .filter((block) => block.closed && ['sysml', 'sysmlv2'].includes(block.language))
    .map((block) => block.content)
    .filter(Boolean);
  const persistedHashes = sourceResponse?.candidateAttestation?.codeBlockContentHashes;
  const alreadyDelivered = blocks.length === 1
    && blocks[0] === content
    && Array.isArray(persistedHashes)
    && persistedHashes.length === 1
    && persistedHashes[0] === contentHash;
  const displayName = String(target.candidate.displayName || target.candidate.fileId)
    .replace(/[\r\n`]/gu, '')
    .slice(0, 160);
  let answer = String(persistedAnswer || '');
  if (!alreadyDelivered) {
    const sanitized = stripUntrustedSysmlFragments(answer);
    const teachingText = substantiveTeachingText(sanitized)
      ? sanitized.trim()
      : '下面给出与历史检查点精确绑定的已验证候选。';
    answer = `${teachingText}\n\n【历史回答缺少完整代码交付；以下内容由服务端从已验证检查点确定性重建。】\n\n文件：${displayName}\n\n\`\`\`sysml\n${content}\n\`\`\``;
  }
  const validatorVersion = String(
    validationArtifact?.validator?.version
    || sourceResponse?.candidateAttestation?.validatorVersion
    || ''
  );
  const coursePassed = validationArtifact?.courseRuleApplicability === 'not_applicable'
    || validationArtifact?.courseRules?.status === 'passed'
    || validationArtifact?.passed === true;
  return {
    status: target.changed ? 'changed_delivered' : 'no_change',
    reason: target.changed ? 'single_changed_file_delivered' : 'single_file_unchanged',
    answer,
    recovered: !alreadyDelivered,
    candidateWorkspaceHash,
    contentHash,
    fileId: target.candidate.fileId,
    validatorVersion,
    candidateAttestation: {
      validatorStatus: 'validated_passed',
      validatorSource: OFFICIAL_VALIDATOR_SOURCE,
      validatorVersion,
      validationCompleteness: 'official',
      fallbackActive: false,
      candidateWorkspaceHash,
      codeBlockContentHashes: [contentHash]
    },
    codeBlockValidations: [{
      index: 0,
      language: 'sysml',
      status: 'validated_passed',
      label: '已在候选工作区中通过官方 validator',
      message: '该代码块由服务端从历史终末检查点重建，并与已验证候选工作区精确绑定。',
      syntaxValid: true,
      semanticValid: true,
      coursePassed,
      source: OFFICIAL_VALIDATOR_SOURCE,
      validatorVersion,
      validationCompleteness: 'official',
      fallbackActive: false,
      candidateWorkspaceHash,
      validationScope: 'candidate_file',
      boundFileId: target.candidate.fileId,
      contentHash
    }]
  };
}

function persistedDeliveryIncomplete(persistedAnswer, reason) {
  const sanitized = stripUntrustedSysmlFragments(String(persistedAnswer || ''));
  return {
    status: 'incomplete',
    reason,
    answer: substantiveTeachingText(sanitized)
      ? sanitized.trim()
      : '历史候选结果没有通过当前单文件交付检查。'
  };
}

function trustedPersistedValidationArtifact(validation, candidateWorkspaceHash) {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) return false;
  const version = String(validation.validator?.version || '');
  const officialPassed = validation.official?.syntax === 'passed'
    && validation.official?.semantic === 'passed'
    && validation.completeness === 'complete'
    && validation.validator?.authority === 'official-sysml-v2-validator';
  const legacyCheckpointPassed = validation.passed === true;
  return (officialPassed || legacyCheckpointPassed)
    && version.startsWith(`${OFFICIAL_VALIDATOR_RELEASE}/${OFFICIAL_VALIDATOR_KERNEL}/sha256:`)
    && normalizeContentHash(validation.candidateWorkspaceHash) === candidateWorkspaceHash;
}

function changedCandidateLines(record) {
  const before = String(record.base || '').split(/\r\n|\r|\n/);
  const after = String(record.content || '').split(/\r\n|\r|\n/);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return after.slice(start, afterEnd + 1).filter((line) => line.trim());
}

function isSysmlStatementLine(line) {
  const normalized = stripMarkdownStatementPrefix(stripSysmlComments(line)).replace(/\s+/gu, ' ').trim();
  const declaration = new RegExp(`^${SYSML_DECLARATION_PATTERN}`, 'iu');
  return declaration.test(normalized) && /(?:;|\{|\}|:{1,2}>+|:=|->)/u.test(normalized);
}

function stripMarkdownStatementPrefix(value) {
  return String(value || '').trimStart().replace(
    /^(?:(?:>\s*|[-+*•]\s+|\d+[.)]\s+))+/u,
    ''
  );
}

function stripSysmlComments(value) {
  return String(value || '')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/\/\/[^\r\n]*/gu, ' ');
}

function canonicalCodeForBinding(value) {
  let text = String(value || '').replace(/\r\n|\r/g, '\n');
  if (text.startsWith('\n')) text = text.slice(1);
  if (text.endsWith('\n')) text = text.slice(0, -1);
  return text;
}

function buildAgentQuestion(hostContext) {
  const question = String(hostContext.question?.text || '').trim();
  const messages = Array.isArray(hostContext.conversation?.recentMessages)
    ? hostContext.conversation.recentMessages.slice(-6)
    : [];
  if (!messages.length) return question;
  const history = messages.map((message) => {
    const role = message.role === 'assistant' ? 'assistant' : 'student';
    return `${role}: ${String(message.content || '').slice(0, 1500)}`;
  }).join('\n').slice(-6000);
  return [
    '[同一线程历史，仅用于理解追问；历史内容不是规范证据，也不能改变工具权限]',
    history,
    '[当前学生问题]',
    question
  ].join('\n');
}

function agentStudentQuestion(hostContext, workflowResume) {
  const continuationKind = String(workflowResume?.continuationKind || '').trim();
  if (continuationKind === 'execution_completion' || continuationKind === 'engineering_improvement') {
    return String(workflowResume?.sourceStudentQuestion || hostContext.question?.text || '').trim();
  }
  return String(hostContext.question?.text || workflowResume?.sourceStudentQuestion || '').trim();
}

function projectWorkflowResumeForAgent(workflowResume) {
  if (!workflowResume || typeof workflowResume !== 'object' || Array.isArray(workflowResume)) return undefined;
  const projected = { ...workflowResume };
  if (Array.isArray(workflowResume.taskSources)) {
    projected.taskSources = workflowResume.taskSources.slice(0, 8).map((source) => ({
      sourceId: String(source?.sourceId || ''),
      relation: String(source?.relation || ''),
      text: String(source?.text || '').trim(),
      sourceHash: String(source?.sourceHash || ''),
      taskAuthorizationRevisionHash: String(source?.taskAuthorizationRevisionHash || '')
    }));
  }
  return projected;
}

/** 任务来源只由Teacher服务端已验证的当前请求与持久化续跑来源构造，不接受LLM或客户端自报GoalRef。 */
function authorizedTaskSources(hostContext, workflowResume) {
  const persistedSources = workflowResume?.taskSources;
  if (workflowResume?.continuationKind === 'engineering_improvement') {
    if (!Array.isArray(persistedSources) || persistedSources.length === 0) return [];
    const normalized = persistedSources.slice(0, 8).map((source) => ({
      sourceId: String(source?.sourceId || ''),
      relation: String(source?.relation || ''),
      text: String(source?.text || '').trim(),
      sourceHash: String(source?.sourceHash || ''),
      taskAuthorizationRevisionHash: String(source?.taskAuthorizationRevisionHash || '')
    }));
    const authorizationHashes = new Set(normalized.map((source) => source.taskAuthorizationRevisionHash));
    const valid = authorizationHashes.size === 1 && normalized.every((source) => (
      /^(?:tasksource|msg)_[a-zA-Z0-9-]{8,160}$/.test(source.sourceId)
      && ['root_user_request', 'clarification_user_answer', 'engineering_feedback'].includes(source.relation)
      && source.text
      && source.sourceHash === hashContent(source.text)
      && /^sha256:[a-f0-9]{64}$/u.test(source.taskAuthorizationRevisionHash)
    ));
    return valid ? normalized : [];
  }
  const current = String(hostContext.question?.text || '').trim();
  const root = String(workflowResume?.sourceStudentQuestion || current).trim();
  const sourceRunId = String(workflowResume?.sourceRunId || hostContext.requestId || 'current').trim();
  const candidates = [
    {
      sourceId: opaqueId('tasksource', `root:${sourceRunId}`),
      relation: 'root_user_request',
      text: root
    },
    ...(current && current !== root && workflowResume?.sourceStudentQuestion && !workflowResume?.continuationKind
      ? [{
        sourceId: opaqueId('tasksource', `clarification:${hostContext.requestId || 'current'}`),
        relation: 'clarification_user_answer',
        text: current
      }]
      : [])
  ].filter((source) => source.text);
  const authorizationMaterial = candidates.map((source) => ({
    sourceId: source.sourceId,
    relation: source.relation,
    sourceHash: hashContent(source.text)
  }));
  const taskAuthorizationRevisionHash = hashContent(JSON.stringify({
    version: 'teacher-task-source-set-v1',
    threadId: String(hostContext.threadId || ''),
    sources: authorizationMaterial
  }));
  return candidates.map((source) => ({
    ...source,
    sourceHash: hashContent(source.text),
    taskAuthorizationRevisionHash
  }));
}

function localBenchmarkEvaluationMode(hostContext) {
  if (process.env.NODE_ENV === 'production') return undefined;
  const requestId = String(hostContext?.requestId || '');
  const files = Array.isArray(hostContext?.editor?.files) ? hostContext.editor.files : [];
  const trustedLocalFixture = requestId.startsWith('benchmark-')
    && files.length > 0
    && files.every((file) => file?.source === 'ai-teacher-benchmark-v1');
  return trustedLocalFixture ? 'local_benchmark' : undefined;
}

function agentOutcomeError(outcome) {
  const reason = String(outcome.response?.stopReason || 'provider_error');
  const warnings = textList(outcome.response?.warnings, 20, 240);
  const terminalValidation = failureValidationSummary(
    outcome.response?.validation,
    outcome.response?.validatorStatus
  );
  const repairExhausted = warnings.includes('workflow_fail_closed:repair_exhausted');
  const candidateContentIncomplete = warnings.some((warning) => (
    warning === 'workflow_fail_closed:candidate_content_empty'
    || warning === 'workflow_fail_closed:candidate_content_truncated'
    || warning === 'workflow_fail_closed:candidate_content_ambiguous'
  ));
  const candidatePreparationFailed = warnings.some((warning) => (
    warning === 'workflow_fail_closed:candidate_target_unavailable'
    || warning === 'workflow_fail_closed:candidate_target_unauthorized'
    || warning === 'workflow_fail_closed:candidate_base_hash_conflict'
    || warning === 'workflow_fail_closed:candidate_internal_contract_invalid'
  ));
  const shapes = {
    cancelled: { code: 'TEACHER_RUN_CANCELLED', statusCode: 499, message: 'Teacher Agent run was cancelled.' },
    timeout: { code: 'AI_TEACHER_AGENT_TIMEOUT', statusCode: 504, message: 'Teacher Agent run timed out.' },
    repair_step_timeout: {
      code: 'AI_TEACHER_REPAIR_STEP_TIMEOUT',
      statusCode: 504,
      message: '修复模型未能在单步时限内提交候选；本轮工作区保持不变。'
    },
    step_limit: { code: 'AI_TEACHER_AGENT_STEP_LIMIT', statusCode: 503, message: 'Teacher Agent reached its step limit without a complete answer.' },
    policy_violation: { code: 'AI_TEACHER_AGENT_POLICY_VIOLATION', statusCode: 503, message: 'Teacher Agent did not complete the required trusted workflow.' },
    provider_error: { code: 'AI_TEACHER_AGENT_PROVIDER_ERROR', statusCode: 503, message: 'Teacher Agent provider call failed.' }
  };
  const shape = repairExhausted
    ? {
        code: 'AI_TEACHER_REPAIR_EXHAUSTED',
        statusCode: 422,
        message: '局部修订预算已耗尽，仍未形成可发布模型；本轮工作区保持不变。'
      }
    : candidateContentIncomplete
    ? {
        code: 'AI_TEACHER_CANDIDATE_CONTENT_INCOMPLETE',
        statusCode: 422,
        message: '本轮未形成完整、可验证的模型，因此没有发布候选。'
      }
    : candidatePreparationFailed
      ? {
          code: 'AI_TEACHER_CANDIDATE_PREPARATION_FAILED',
          statusCode: 422,
          message: '本轮未形成完整、可验证的模型，因此没有发布候选。'
        }
      : shapes[reason] || shapes.provider_error;
  const error = new Error(shape.message);
  error.code = shape.code;
  error.statusCode = shape.statusCode;
  error.promptTokens = Number(outcome.response?.usage?.inputTokens || 0);
  error.completionTokens = Number(outcome.response?.usage?.outputTokens || 0);
  error.reasoningTokens = Number(outcome.response?.usage?.reasoningTokens || 0);
  error.totalTokens = Number(outcome.response?.usage?.totalTokens || 0);
  const qualityGate = failureQualityGate(outcome.response?.warnings);
  error.agent = {
    workflowVersion: outcome.response?.workflowVersion || 'intent-orchestrator-v2',
    intentV2Trace: outcome.response?.intentV2Trace,
    fastGatePassThroughV2: outcome.response?.fastGatePassThroughV2,
    mainAgentDelegation: outcome.response?.mainAgentDelegation,
    stopReason: reason,
    stopCause: outcome.response?.stopCause,
    stepCount: Number(outcome.response?.stepCount || 0),
    phaseTimings: (outcome.response?.phaseTimings || []).map((item) => ({
      phase: String(item.phase || ''),
      durationMs: nonNegativeInteger(item.durationMs) ?? 0,
      occurrences: nonNegativeInteger(item.occurrences) ?? 0
    })).filter((item) => item.phase),
    modelCalls: (outcome.response?.modelCalls || []).slice(0, 16).map((call) => ({
      phase: String(call.phase || '').slice(0, 80),
      stepNumber: nonNegativeInteger(call.stepNumber),
      provider: String(call.provider || '').slice(0, 80),
      modelId: String(call.modelId || '').slice(0, 200),
      durationMs: nonNegativeInteger(call.durationMs) ?? 0,
      timeToFirstOutputMs: nonNegativeInteger(call.timeToFirstOutputMs),
      status: call.status === 'failed' ? 'failed' : 'succeeded',
      finishReason: String(call.finishReason || '').slice(0, 80),
      errorCategory: String(call.errorCategory || '').slice(0, 80),
      requestedOutputTokens: nonNegativeInteger(call.requestedOutputTokens),
      remainingMsAtStart: nonNegativeInteger(call.remainingMsAtStart),
      visibleOutputTokens: nonNegativeInteger(call.visibleOutputTokens),
      usage: call.usage
    })),
    toolTrace: outcome.response?.toolTrace || [],
    warnings,
    ...(qualityGate ? { qualityGate } : {}),
    terminalValidation
  };
  return error;
}

function failureQualityGate(warnings) {
  const values = Array.isArray(warnings) ? warnings.map((warning) => String(warning || '')) : [];
  const initialIssueCodes = warningIssueCodes(values, 'final_answer_quality_gate_triggered:');
  const finalIssueCodes = warningIssueCodes(values, 'final_answer_quality_gate_failed:');
  if (!initialIssueCodes.length && !finalIssueCodes.length) return undefined;
  return {
    initialIssueCodes,
    finalIssueCodes,
    repairAttempted: values.some((warning) => warning.startsWith('final_answer_quality_repair_triggered:'))
  };
}

function warningIssueCodes(warnings, prefix) {
  return [...new Set(warnings
    .filter((warning) => warning.startsWith(prefix))
    .flatMap((warning) => warning.slice(prefix.length).split(','))
    .map((code) => code.trim())
    .filter((code) => /^[a-z0-9_]{1,120}$/u.test(code))
  )].slice(0, 32);
}

function failureValidationSummary(validation, validatorStatus) {
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) return undefined;
  const applicability = ['applicable', 'not_applicable', 'unknown'].includes(validation.courseRuleApplicability)
    ? validation.courseRuleApplicability
    : 'unknown';
  const courseStatus = applicability === 'applicable'
    && ['passed', 'failed', 'not_run'].includes(validation.courseRules?.status)
    ? validation.courseRules.status
    : 'not_run';
  return {
    status: ['validated_passed', 'validated_failed', 'not_validated'].includes(validatorStatus)
      ? validatorStatus
      : 'not_validated',
    official: {
      syntax: safeValidationState(validation.official?.syntax, ['passed', 'failed', 'unavailable'], 'unavailable'),
      semantic: safeValidationState(validation.official?.semantic, ['passed', 'failed', 'not_run', 'unavailable'], 'unavailable'),
      diagnostics: failureDiagnostics(validation.official?.diagnostics)
    },
    courseRules: {
      applicability,
      status: courseStatus,
      diagnostics: failureDiagnostics(validation.courseRules?.diagnostics)
    },
    completeness: validation.completeness === 'complete' ? 'complete' : 'partial'
  };
}

function safeValidationState(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function failureDiagnostics(value) {
  const diagnostics = Array.isArray(value) ? value : [];
  const rootCandidates = diagnostics.filter((diagnostic) => diagnostic?.severity === 'error');
  return (rootCandidates.length ? rootCandidates : diagnostics).slice(0, 3).map((diagnostic) => ({
    severity: ['error', 'warning', 'info'].includes(diagnostic?.severity) ? diagnostic.severity : 'info',
    ...(optionalText(diagnostic?.code, 120) ? { code: optionalText(diagnostic.code, 120) } : {}),
    message: nonEmptyText(diagnostic?.message, 'Validator diagnostic', 1000),
    ...(optionalText(diagnostic?.fileId || diagnostic?.file, 256)
      ? { fileId: optionalText(diagnostic?.fileId || diagnostic?.file, 256) }
      : {}),
    ...(nonNegativeInteger(diagnostic?.line) !== undefined
      ? { line: nonNegativeInteger(diagnostic.line) }
      : {}),
    ...(nonNegativeInteger(diagnostic?.column) !== undefined
      ? { column: nonNegativeInteger(diagnostic.column) }
      : {}),
    ...(optionalText(diagnostic?.lineText, 240) ? { lineText: optionalText(diagnostic.lineText, 240) } : {})
  }));
}

function resolveAgentModulePath(value) {
  return path.resolve(value || path.join(__dirname, 'dist', 'agent', 'index.mjs'));
}

function agentBuildVersion(config, modulePath) {
  const artifactFiles = agentArtifactFiles(modulePath);
  const key = artifactFiles.map((file) => {
    const stat = fs.statSync(file);
    return `${file}:${stat.size}:${stat.mtimeMs}`;
  }).join('|');
  if (buildVersionCache.has(key)) return buildVersionCache.get(key);
  const label = String(config.agentBuildVersion || DEFAULT_BUILD_VERSION).replace(/[^A-Za-z0-9._-]/g, '-');
  const artifactRoot = path.dirname(modulePath);
  const manifest = artifactFiles.map((file) => ({
    path: path.relative(artifactRoot, file).replace(/\\/g, '/'),
    hash: hashContent(fs.readFileSync(file))
  }));
  const digest = hashContent(canonicalJson(manifest)).slice('sha256:'.length, 'sha256:'.length + 16);
  const version = `${label}+sha256.${digest}`;
  buildVersionCache.clear();
  buildVersionCache.set(key, version);
  return version;
}

function agentArtifactFiles(modulePath) {
  const root = path.dirname(modulePath);
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(target);
    }
  };
  visit(root);
  for (const dependencyManifest of [
    path.resolve(__dirname, '..', '..', 'package.json'),
    path.resolve(__dirname, '..', '..', 'package-lock.json')
  ]) {
    if (fs.existsSync(dependencyManifest)) files.push(dependencyManifest);
  }
  return [...new Set(files)].sort();
}

function diagnosticOffset(file, lineValue, columnValue) {
  if (!file || !Number.isInteger(Number(lineValue))) return undefined;
  const line = Math.max(1, Number(lineValue));
  const column = Math.max(1, Number(columnValue || 1));
  const content = String(file.content || '');
  const lines = content.split(/\r\n|\r|\n/);
  if (line > lines.length) return undefined;
  const starts = [0];
  const newline = /\r\n|\r|\n/g;
  let match = newline.exec(content);
  while (match) {
    starts.push(match.index + match[0].length);
    match = newline.exec(content);
  }
  return Math.min(content.length, starts[line - 1] + Math.min(column - 1, lines[line - 1].length));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON only supports finite numbers.');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : canonicalValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().flatMap((key) => (
      value[key] === undefined ? [] : [[key, canonicalValue(value[key])]]
    )));
  }
  throw new TypeError('Canonical JSON value is not serializable.');
}

function agentPolicy(config) {
  const defaults = AGENT_RESOURCE_POLICY_BOOTSTRAP_PROJECTION.teacher;
  const maxOutputTokens = positiveInteger(
    config.agentMaxOutputTokens,
    defaults.agentMaxOutputTokens
  );
  const boundedOutput = (value, fallback) => Math.min(maxOutputTokens, positiveInteger(value, fallback));
  return compactObject({
    maxSteps: positiveInteger(config.agentMaxSteps, defaults.agentMaxSteps),
    maxDurationMs: positiveInteger(config.agentMaxDurationMs, defaults.agentMaxDurationMs),
    terminalReserveMs: positiveInteger(config.agentTerminalReserveMs, defaults.agentTerminalReserveMs),
    convergeLeadMs: positiveInteger(config.agentConvergeLeadMs, defaults.agentConvergeLeadMs),
    toolTimeoutMs: positiveInteger(config.agentToolTimeoutMs, defaults.agentToolTimeoutMs),
    maxOutputTokens,
    contextWindowTokens: positiveInteger(config.agentContextWindowTokens, defaults.agentContextWindowTokens),
    scopeGateEnabled: booleanSetting(
      config.agentScopeGateEnabled,
      defaults.agentScopeGateEnabled
    ),
    scopeGateInitialTimeoutMs: positiveInteger(config.agentScopeGateInitialTimeoutMs, defaults.agentScopeGateInitialTimeoutMs),
    scopeGateReviewTimeoutMs: positiveInteger(config.agentScopeGateReviewTimeoutMs, defaults.agentScopeGateReviewTimeoutMs),
    scopeGateMaxOutputTokens: boundedOutput(
      config.agentScopeGateMaxOutputTokens,
      defaults.agentScopeGateMaxOutputTokens
    ),
    candidateRecoveryMaxAttempts: Number(config.agentCandidateRecoveryMaxAttempts ?? defaults.agentCandidateRecoveryMaxAttempts) === 0 ? 0 : 1,
    candidateMaxAttemptMs: positiveInteger(
      config.agentCandidateMaxAttemptMs,
      defaults.agentCandidateMaxAttemptMs
    ),
    candidateRepairEnabled: booleanSetting(
      config.agentCandidateRepairEnabled ?? config.agentPatchRepairEnabled,
      defaults.agentCandidateRepairEnabled
    ),
    repairPhaseReserveMs: positiveInteger(
      config.agentRepairPhaseReserveMs,
      defaults.agentRepairPhaseReserveMs
    ),
    repairMaxRounds: nonNegativeInteger(config.agentRepairMaxRounds)
      ?? defaults.agentRepairMaxRounds,
    candidateMaxArtifactBytes: positiveInteger(
      config.agentCandidateMaxArtifactBytes,
      defaults.agentCandidateMaxArtifactBytes
    ),
    semanticReviewEnabled: booleanSetting(
      config.agentSemanticReviewEnabled,
      defaults.agentSemanticReviewEnabled
    ),
    semanticReviewShadowOnly: booleanSetting(
      config.agentSemanticReviewShadowOnly,
      defaults.agentSemanticReviewShadowOnly
    ),
    semanticReviewAssessmentMaxCalls: positiveInteger(
      config.agentSemanticReviewAssessmentMaxCalls,
      defaults.agentSemanticReviewAssessmentMaxCalls
    ),
    semanticReviewAssessmentTimeoutMs: positiveInteger(
      config.agentSemanticReviewAssessmentTimeoutMs,
      defaults.agentSemanticReviewAssessmentTimeoutMs
    ),
    semanticReviewMainDecisionTimeoutMs: positiveInteger(
      config.agentSemanticReviewMainDecisionTimeoutMs,
      defaults.agentSemanticReviewMainDecisionTimeoutMs
    ),
    semanticReviewVerificationMaxCalls: positiveInteger(
      config.agentSemanticReviewVerificationMaxCalls,
      defaults.agentSemanticReviewVerificationMaxCalls
    ),
    semanticReviewVerificationTimeoutMs: positiveInteger(
      config.agentSemanticReviewVerificationTimeoutMs,
      defaults.agentSemanticReviewVerificationTimeoutMs
    ),
    semanticReviewMaxOutputTokens: boundedOutput(
      config.agentSemanticReviewMaxOutputTokens,
      defaults.agentSemanticReviewMaxOutputTokens
    ),
    semanticReviewMaxIssues: positiveInteger(
      config.agentSemanticReviewMaxIssues,
      defaults.agentSemanticReviewMaxIssues
    ),
    semanticReviewMinimumCompleteChainMs: positiveInteger(
      config.agentSemanticReviewMinimumCompleteChainMs,
      defaults.agentSemanticReviewMinimumCompleteChainMs
    ),
    semanticReviewDomainSearchReserveMs: nonNegativeInteger(config.agentSemanticReviewDomainSearchReserveMs)
      ?? defaults.agentSemanticReviewDomainSearchReserveMs,
    engineeringRevisionMaxCycles: positiveInteger(
      config.agentEngineeringRevisionMaxCycles,
      defaults.agentEngineeringRevisionMaxCycles
    ),
    engineeringRevisionMaxDurationMs: positiveInteger(
      config.agentEngineeringRevisionMaxDurationMs,
      defaults.agentEngineeringRevisionMaxDurationMs
    ),
    engineeringRevisionValidationRepairReserveMs: positiveInteger(
      config.agentEngineeringRevisionValidationRepairReserveMs,
      defaults.agentEngineeringRevisionValidationRepairReserveMs
    ),
    engineeringImprovementRunMaxDurationMs: positiveInteger(
      config.agentEngineeringImprovementRunMaxDurationMs,
      defaults.agentEngineeringImprovementRunMaxDurationMs
    ),
    engineeringImprovementApiOuterTimeoutMs: positiveInteger(
      config.agentEngineeringImprovementApiOuterTimeoutMs,
      defaults.agentEngineeringImprovementApiOuterTimeoutMs
    ),
    engineeringImprovementLineageMaxDurationMs: positiveInteger(
      config.agentEngineeringImprovementLineageMaxDurationMs,
      defaults.agentEngineeringImprovementLineageMaxDurationMs
    ),
    engineeringImprovementOrchestrationReserveMs: positiveInteger(
      config.agentEngineeringImprovementOrchestrationReserveMs,
      defaults.agentEngineeringImprovementOrchestrationReserveMs
    ),
    engineeringImprovementMinimumCompleteChainMs: positiveInteger(
      config.agentEngineeringImprovementMinimumCompleteChainMs,
      defaults.agentEngineeringImprovementMinimumCompleteChainMs
    ),
    validatorToolTimeoutMs: positiveInteger(
      config.agentValidatorToolTimeoutMs,
      defaults.agentValidatorToolTimeoutMs
    ),
    reviewedKnowledgeMaxNewQueriesPerRun: nonNegativeInteger(config.agentReviewedKnowledgeMaxNewQueriesPerRun)
      ?? defaults.agentReviewedKnowledgeMaxNewQueriesPerRun,
    lowAnswerMaxOutputTokens: positiveInteger(
      config.agentLowAnswerMaxOutputTokens,
      defaults.agentLowAnswerMaxOutputTokens
    ),
    mediumAnswerMaxOutputTokens: positiveInteger(
      config.agentMediumAnswerMaxOutputTokens,
      defaults.agentMediumAnswerMaxOutputTokens
    ),
    highAnswerMaxOutputTokens: positiveInteger(
      config.agentHighAnswerMaxOutputTokens,
      defaults.agentHighAnswerMaxOutputTokens
    ),
    temperature: 0
  });
}

function isDeliverableAgentOutcome(outcome) {
  return String(outcome?.response?.stopReason || '') !== 'cancelled'
    && String(outcome?.response?.answer || '').trim().length > 0;
}

const AGENT_STAGE_IDS = Object.freeze([
  'fastGate',
  'main',
  'candidate',
  'repair',
  'semanticReview',
  'finalizer'
]);

function resolvedStageModelAssignment(config, hostContext) {
  const configuredRoutes = config.agentStageModelRoutes || (config.agentModel || config.agentThinkingModel || config.agentNonThinkingModel
    ? {
        fastGate: agentReasoningModelAlias(config, 'disabled') || agentReasoningModelAlias(config, 'high'),
        main: agentReasoningModelAlias(config, 'high'),
        candidate: agentReasoningModelAlias(config, 'high'),
        repair: agentReasoningModelAlias(config, 'high'),
        semanticReview: agentReasoningModelAlias(config, 'high'),
        finalizer: agentReasoningModelAlias(config, 'disabled') || agentReasoningModelAlias(config, 'high')
      }
    : AGENT_RESOURCE_POLICY_BOOTSTRAP_PROJECTION.teacher.agentStageModelRoutes);
  const configuredReasoning = config.agentStageReasoningPolicies
    || AGENT_RESOURCE_POLICY_BOOTSTRAP_PROJECTION.teacher.agentStageReasoningPolicies
    || {
      fastGate: 'disabled',
      main: 'provider-managed',
      candidate: 'provider-managed',
      repair: 'provider-managed',
      semanticReview: 'provider-managed',
      finalizer: 'disabled'
    };
  const stages = Object.freeze(Object.fromEntries(AGENT_STAGE_IDS.map((stageId) => {
    const modelAlias = String(configuredRoutes?.[stageId] || '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{1,199}$/.test(modelAlias)) {
      const error = new Error(`AI Teacher stage model route is invalid: ${stageId}`);
      error.code = 'AI_TEACHER_STAGE_MODEL_ROUTE_INVALID';
      error.statusCode = 503;
      throw error;
    }
    return [stageId, Object.freeze({
      modelAlias,
      reasoningMode: normalizeReasoningMode(configuredReasoning?.[stageId]),
      ...stageProtocolProfile(config, stageId)
    })];
  })));
  const policySnapshot = hostContext?.runtimeAssignment?.resourcePolicySnapshot || config.resourcePolicySnapshot;
  const canonical = {
    policyVersionId: String(policySnapshot?.versionId || ''),
    policyChecksum: String(policySnapshot?.checksum || ''),
    stages: Object.fromEntries(AGENT_STAGE_IDS.map((stageId) => [stageId, stages[stageId]]))
  };
  return Object.freeze({
    ...canonical,
    assignmentChecksum: hashContent(JSON.stringify(canonical))
  });
}

function createStageModels(runtime, config, assignment) {
  const injected = config.agentStageModels || {};
  const models = {};
  for (const stageId of AGENT_STAGE_IDS) {
    const fallback = stageId === 'fastGate' || stageId === 'finalizer'
      ? config.agentNonThinkingModel || config.agentModel
      : config.agentThinkingModel || config.agentModel;
    const rawModel = injected[stageId] || fallback || runtime.createOpenAICompatibleAgentModel({
      name: providerName(config.llm?.providerMode),
      baseURL: config.llm?.baseUrl,
      modelId: assignment.stages[stageId].modelAlias,
      apiKey: config.llm?.apiKey,
      includeUsage: true,
      compatibilityMode: stageId !== 'fastGate'
        && stageId !== 'finalizer'
        && ((assignment.stages[stageId].executionPolicy?.continuation?.assistantContent === 'non_null'
          && assignment.stages[stageId].executionPolicy?.toolChoice?.thinking === 'omit')
          || assignment.stages[stageId].protocolMode === 'deepseek-v4-litellm')
        ? 'gateway-thinking-tools-non-null-content'
        : 'generic-openai'
    });
    models[stageId] = guardAgentModel(rawModel, config.providerGateway, config.abortSignal);
  }
  return Object.freeze(models);
}

function stageProtocolProfilesFromAssignment(assignment) {
  return Object.freeze(Object.fromEntries(AGENT_STAGE_IDS.map((stageId) => [stageId, Object.freeze({
    protocolMode: assignment.stages[stageId].protocolMode,
    adapterProfileId: assignment.stages[stageId].adapterProfileId,
    adapterProfileRevision: assignment.stages[stageId].adapterProfileRevision,
    modelProtocolProfileId: assignment.stages[stageId].modelProtocolProfileId,
    modelProtocolProfileRevision: assignment.stages[stageId].modelProtocolProfileRevision,
    executionPolicy: assignment.stages[stageId].executionPolicy
  })])));
}

function stageProtocolProfile(config, stageId) {
  const configured = config.agentStageModelProtocols?.[stageId] || {};
  const mode = String(configured.protocolMode || '').trim();
  if (['gateway-chat-v1', 'generic-openai', 'deepseek-v4-litellm', 'glm-5.2-litellm'].includes(mode)) {
    return {
      protocolMode: mode,
      adapterProfileId: String(configured.adapterProfileId || ''),
      adapterProfileRevision: Number(configured.adapterProfileRevision || 0),
      modelProtocolProfileId: String(configured.modelProtocolProfileId || ''),
      modelProtocolProfileRevision: Number(configured.modelProtocolProfileRevision || 0),
      executionPolicy: configured.executionPolicy || undefined
    };
  }
  return {
    protocolMode: String(config.agentProviderCompatibility || '').startsWith('deepseek-v4-')
      ? 'deepseek-v4-litellm'
      : 'generic-openai'
  };
}

function agentReasoningModelAlias(config, reasoningMode = normalizeReasoningMode(config.agentReasoningMode)) {
  if (reasoningMode === 'disabled') {
    return String(
      config.agentDisabledModelAlias
        || process.env.AI_TEACHER_DISABLED_MODEL
        || 'ai-teacher-reasoning-passthrough'
    ).trim();
  }
  return String(config.llm?.model || '').trim();
}

function guardAgentModel(model, providerGateway, runSignal) {
  if (!model || typeof model !== 'object' || typeof providerGateway?.step !== 'function') return model;
  return new Proxy(model, {
    get(target, property, receiver) {
      if (property !== 'doGenerate' && property !== 'doStream') {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const invokeModel = Reflect.get(target, property, target);
      if (typeof invokeModel !== 'function') return invokeModel;
      return async (options) => {
        const signal = runSignal && options?.abortSignal
          ? AbortSignal.any([runSignal, options.abortSignal])
          : (runSignal || options?.abortSignal);
        return providerGateway.step({
          signal,
          invoke: async () => await invokeModel.call(target, options)
        });
      };
    }
  });
}

function normalizeReasoningMode(value) {
  const normalized = String(value || 'provider-managed').trim().toLowerCase();
  return ['adaptive', 'provider-managed', 'max', 'high', 'medium', 'disabled'].includes(normalized)
    ? normalized
    : 'adaptive';
}

function providerName(mode) {
  const value = String(mode || 'litellm-compatible').toLowerCase();
  return value.includes('litellm') ? 'litellm' : 'openai-compatible';
}

function fileIdForPath(value) {
  return `file_${hashContent(String(value || '')).slice('sha256:'.length, 'sha256:'.length + 20)}`;
}

function opaqueId(prefix, value) {
  return `${prefix}_${hashContent(String(value || '')).slice('sha256:'.length, 'sha256:'.length + 24)}`;
}

function normalizeContentHash(value) {
  const text = String(value || '').toLowerCase();
  if (/^sha256:[a-f0-9]{64}$/.test(text)) return text;
  if (/^[a-f0-9]{64}$/.test(text)) return `sha256:${text}`;
  return '';
}

function knowledgeEvidenceLevel(value) {
  if (value === 'A' || value === 'A1') return 'official';
  if (value === 'B') return 'reviewed_reference';
  return 'reviewed_project';
}

function skillGuidanceAuthority(value) {
  if (value === 'A') return 'official';
  if (value === 'B') return 'project_skill';
  return 'reference';
}

function ledgerStatus(value) {
  if (value === 'succeeded') return 'succeeded';
  if (value === 'cancelled') return 'cancelled';
  if (value === 'timed_out') return 'timed_out';
  return 'failed';
}

function normalizeSeverity(value) {
  const severity = String(value || '').toLowerCase();
  if (severity === 'warning' || severity === 'warn') return 'warning';
  if (severity === 'info' || severity === 'information') return 'info';
  return 'error';
}

function textList(items, limit, maxLength) {
  return (Array.isArray(items) ? items : [])
    .map((item) => String(item || '').trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, limit);
}

function nonEmptyText(value, fallback, maxLength) {
  const text = String(value || '').trim() || String(fallback || '').trim();
  return text.slice(0, maxLength);
}

function optionalText(value, maxLength) {
  const text = String(value || '').trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function intentV2SelectedReasoningMode(reasoningMode) {
  if (reasoningMode === 'disabled') return 'disabled';
  if (reasoningMode === 'adaptive') return 'high';
  if (reasoningMode === 'max') return 'max';
  return 'high';
}

function fullText(value, fallback = '') {
  return String(value || '').trim() || String(fallback || '').trim();
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function validatorTransientRetryMax(value) {
  if (value === undefined || value === null || value === '') return 1;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 1) {
    throw new RangeError('AI_TEACHER_VALIDATOR_TRANSIENT_RETRY_MAX must be 0 or 1.');
  }
  return number;
}

function positiveIntegerOrUndefined(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function terminalPersistenceTimeoutMs(config) {
  return Math.min(
    25_000,
    positiveInteger(
      config.agentTerminalPersistenceTimeoutMs,
      5_000
    )
  );
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function booleanSetting(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function awaitWithAbortSignal(operation, abortSignal) {
  if (!abortSignal) return operation;
  if (abortSignal.aborted) return Promise.reject(abortSignal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      abortSignal.removeEventListener('abort', onAbort);
      reject(abortSignal.reason || new DOMException('Operation aborted', 'AbortError'));
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        abortSignal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        abortSignal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function resetAgentRuntimeForTests() {
  runtimeCache = null;
  runtimeCachePath = '';
  buildVersionCache.clear();
}

module.exports = {
  TOOL_SCHEMA_VERSION,
  agentRuntimeReadiness,
  authoritativeKnowledgeQuery,
  buildKnowledgeQueryPlan,
  capabilityGrantForContext,
  callValidatorToolForTests: callValidatorTool,
  createAgentContext,
  createStageModelsForTests: createStageModels,
  deriveAgentTaskPolicy,
  executionValidationIdentityForContext: executionValidationIdentity,
  extractKnowledgeOperatorOccurrences,
  enforceAnswerCodePolicyForTests: enforceAnswerCodePolicy,
  enforceValidatedCodeAnswerForTests: enforceValidatedCodeAnswer,
  agentStudentQuestionForTests: agentStudentQuestion,
  isDeliverableAgentOutcomeForTests: isDeliverableAgentOutcome,
  trustedOutcomeToTeacherResponseForTests: trustedOutcomeToTeacherResponse,
  agentOutcomeErrorForTests: agentOutcomeError,
  fileIdForPath,
  ledgerProjectionForTests: ledgerProjection,
  loadAgentRuntime,
  mapValidationOutputForTests: mapValidationOutput,
  recoverPersistedCompletedCandidateDelivery,
  runAgentCapability,
  runEngineeringReviewEvaluationCapability,
  frozenAgentWorkflowVersion,
  selectAgentWorkflowVersion,
  skillGuidanceAuthority,
  resetAgentRuntimeForTests,
  resolvedStageModelAssignmentForTests: resolvedStageModelAssignment
};
