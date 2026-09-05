'use strict';

const crypto = require('crypto');
const {
  STUDENT_QUESTION_PROTOCOL_CEILING,
  runtimeProjection: agentResourcePolicyRuntimeProjection
} = require('../../packages/agent-resource-policy');
const {
  applyTaskLifecycleContractEvent,
  createTaskLifecycleContract
} = require('../../packages/teacher-contract/task-lifecycle-contract');
const {
  EXECUTION_PHASES,
  ExecutionCheckpointError,
  bindValidationArtifactCandidate,
  checkpointError,
  checkpointRecord,
  createArtifactRecord,
  deriveExecutionInputHashes,
  executionResumeProjection,
  newCheckpointId,
  normalizeExecutionBoundary,
  projectPersistedAnswer,
  timelineLimit,
  validationReuseKey
} = require('./execution-checkpoint');

const DEFAULT_BACKEND = 'memory';
const EXECUTION_COMPLETION_CONTINUATION = 'execution_completion';
const ENGINEERING_IMPROVEMENT_CONTINUATION = 'engineering_improvement';
const ENGINEERING_FEEDBACK_CONTINUATION = 'engineering_feedback';
const AUTOMATIC_CONTINUATION_KINDS = new Set([
  EXECUTION_COMPLETION_CONTINUATION,
  ENGINEERING_IMPROVEMENT_CONTINUATION
]);

function createConversationStore(options = {}) {
  const backend = String(options.backend || process.env.AI_TEACHER_CONVERSATION_BACKEND || DEFAULT_BACKEND).toLowerCase();
  if (backend === 'postgres') return createPostgresConversationStore(options);
  return createMemoryConversationStore(options);
}

function createMemoryConversationStore(options = {}) {
  const state = options.state || {
    threads: new Map(),
    messages: new Map(),
    runs: new Map(),
    runSteps: [],
    runEvents: new Map(),
    toolLedger: new Map(),
    modelCallLedger: new Map(),
    projectPlans: new Map(),
    moduleCheckpoints: new Map(),
    clarificationCheckpoints: new Map(),
    automaticContinuations: new Map(),
    executionLineages: new Map(),
    executionArtifacts: new Map(),
    executionCheckpoints: new Map(),
    taskLifecycleContracts: new Map(),
    taskLifecycleContractEvents: new Map(),
    summaries: new Map(),
    usageLedger: [],
    auditEvents: []
  };
  if (!state.toolLedger) state.toolLedger = new Map();
  if (!state.modelCallLedger) state.modelCallLedger = new Map();
  if (!state.projectPlans) state.projectPlans = new Map();
  if (!state.moduleCheckpoints) state.moduleCheckpoints = new Map();
  if (!state.clarificationCheckpoints) state.clarificationCheckpoints = new Map();
  if (!state.automaticContinuations) state.automaticContinuations = new Map();
  if (!state.executionLineages) state.executionLineages = new Map();
  if (!state.executionArtifacts) state.executionArtifacts = new Map();
  if (!state.executionCheckpoints) state.executionCheckpoints = new Map();
  if (!state.taskLifecycleContracts) state.taskLifecycleContracts = new Map();
  if (!state.taskLifecycleContractEvents) state.taskLifecycleContractEvents = new Map();

  return {
    mode: 'memory',
    state,
    async createThread(context) {
      const threadId = `thread_${crypto.randomUUID()}`;
      state.threads.set(threadId, createThreadRecord(context, threadId));
      state.messages.set(threadId, []);
      return { threadId };
    },
    async ensureThread(context, requestedThreadId) {
      const requested = safeId(requestedThreadId);
      const requestedThread = requested ? state.threads.get(requested) : null;
      const threadId = requested && (!requestedThread || sameThreadOwner(requestedThread, context))
        ? requested
        : findDefaultThreadId(state, context) || `thread_${crypto.randomUUID()}`;
      if (!state.threads.has(threadId)) {
        state.threads.set(threadId, createThreadRecord(context, threadId));
        state.messages.set(threadId, []);
      }
      return { threadId };
    },
    async listThreads(context, options = {}) {
      const scope = String(options.scope || 'all');
      const limit = Math.max(1, Math.min(100, Number(options.limit || 50)));
      return Array.from(state.threads.values())
        .filter((thread) => thread.tenantId === tenantId(context) && thread.userId === userId(context))
        .filter((thread) => {
          if (scope === 'current') return sameCurrentContext(thread, context);
          if (scope === 'course') return thread.coursePackId === (context?.course?.coursePackId || '') && thread.courseId === (context?.course?.courseId || '');
          return true;
        })
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
        .slice(0, limit)
        .map((thread) => projectThreadSummary(
          thread,
          state.messages.get(thread.threadId) || [],
          options.contextLimitTokens
        ));
    },
    async deleteThread(context, threadId) {
      const id = safeId(threadId);
      const thread = id ? state.threads.get(id) : null;
      if (!thread || !sameThreadOwner(thread, context)) return { deleted: false, reason: 'not_found' };
      const hasActiveRun = Array.from(state.runs.values())
        .some((run) => run.threadId === id && run.status === 'running');
      if (hasActiveRun) return { deleted: false, reason: 'active_run' };
      deleteMemoryThreadState(state, id);
      return { deleted: true, threadId: id };
    },
    async listMessages(threadId, options = {}) {
      const limit = Math.max(1, Math.min(200, Number(options.limit || 50)));
      return (state.messages.get(threadId) || [])
        .filter((message) => message.role === 'user'
          || message.status === 'succeeded'
          || visibleFallbackBaselineMessage(state, message))
        .slice(-limit)
        .map((message) => ({
          ...message,
          automaticContinuationSourceRunId: String(
            state.runs.get(message.runId)?.metadata?.automaticContinuationSourceRunId || ''
          )
        }));
    },
    async listSuccessfulMessages(threadId) {
      return (state.messages.get(threadId) || [])
        .filter(modelConversationMessage);
    },
    async createRun({ threadId, context, intent, route }) {
      const runId = `run_${crypto.randomUUID()}`;
      const run = {
        runId,
        threadId,
        requestId: context?.requestId || '',
        tenantId: tenantId(context),
        userId: userId(context),
        intent: intent || 'single_entry',
        route: route || '',
        status: 'running',
        metadata: {
          continuationRootRunId: runId,
          automaticContinuationSequence: 0
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      state.runs.set(run.runId, run);
      ensureMemoryExecutionLineage(state, run);
      state.runEvents.set(run.runId, []);
      const messages = state.messages.get(run.threadId) || [];
      if (!state.messages.has(run.threadId)) state.messages.set(run.threadId, messages);
      messages.push({
        messageId: `msg_${crypto.randomUUID()}`,
        threadId: run.threadId,
        runId: run.runId,
        role: 'user',
        status: 'received',
        content: String(context?.question?.text || ''),
        requestId: context?.requestId || '',
        createdAt: run.createdAt
      });
      await this.recordAuditEvent({
        eventType: 'teacher.run.created',
        tenantId: run.tenantId,
        userId: run.userId,
        requestId: run.requestId,
        runId: run.runId,
        status: 'running',
        metadata: { intent: run.intent, route: run.route }
      });
      return run;
    },
    async createResumedRun({ threadId, context, intent, route, checkpointId }) {
      const checkpoint = state.clarificationCheckpoints.get(safeId(checkpointId));
      if (!checkpoint || checkpoint.threadId !== threadId
        || checkpoint.tenantId !== tenantId(context) || checkpoint.userId !== userId(context)) {
        throw clarificationCheckpointError('CLARIFICATION_CHECKPOINT_UNAVAILABLE', 404);
      }
      const nowMs = Date.now();
      if (checkpoint.state === 'waiting' && Date.parse(checkpoint.expiresAt) <= nowMs) {
        checkpoint.state = 'expired';
        throw clarificationCheckpointError('CLARIFICATION_CHECKPOINT_EXPIRED', 409);
      }
      if (checkpoint.state === 'resolved') {
        if (checkpoint.resumeRequestId !== String(context?.requestId || '')) {
          throw clarificationCheckpointError('CLARIFICATION_CHECKPOINT_CONSUMED', 409);
        }
        const existingRun = state.runs.get(checkpoint.resumedRunId);
        const responseMessage = (state.messages.get(threadId) || []).find((message) => (
          message.runId === checkpoint.resumedRunId && message.role === 'assistant' && message.status === 'succeeded'
        ));
        return {
          run: { ...existingRun },
          reused: true,
          response: responseMessage?.response,
          workflowResume: buildMemoryWorkflowResume(
            state,
            checkpoint,
            context,
            checkpoint.resumedRunId
          )
        };
      }
      if (checkpoint.state !== 'waiting') {
        throw clarificationCheckpointError('CLARIFICATION_CHECKPOINT_UNAVAILABLE', 409);
      }
      const sourceRun = state.runs.get(checkpoint.sourceRunId);
      const continuationRootRunId = memoryExecutionRootRunId(state, sourceRun);
      const run = {
        runId: `run_${crypto.randomUUID()}`,
        threadId,
        requestId: context?.requestId || '',
        tenantId: tenantId(context),
        userId: userId(context),
        intent: intent || 'single_entry',
        route: route || '',
        status: 'running',
        metadata: {
          resumedFromCheckpointId: checkpoint.checkpointId,
          sourceRunId: checkpoint.sourceRunId,
          continuationRootRunId
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      checkpoint.state = 'resolved';
      checkpoint.resumeRequestId = run.requestId;
      checkpoint.responseMessageId = `msg_${crypto.randomUUID()}`;
      checkpoint.resumedRunId = run.runId;
      checkpoint.resolvedAt = run.createdAt;
      state.runs.set(run.runId, run);
      ensureMemoryExecutionLineage(state, sourceRun || run, continuationRootRunId);
      state.runEvents.set(run.runId, []);
      const messages = state.messages.get(threadId) || [];
      if (!state.messages.has(threadId)) state.messages.set(threadId, messages);
      messages.push({
        messageId: checkpoint.responseMessageId,
        threadId,
        runId: run.runId,
        role: 'user',
        status: 'received',
        content: String(context?.question?.text || ''),
        requestId: run.requestId,
        createdAt: run.createdAt
      });
      return {
        run,
        reused: false,
        workflowResume: buildMemoryWorkflowResume(state, checkpoint, context, run.runId),
        sourceResponse: automaticContinuationSourceResponse(state, sourceRun)
      };
    },
    async createAutomaticContinuationRun({
      threadId,
      context,
      intent,
      route,
      sourceRunId,
      continuationKind,
      continuationBudget
    }) {
      const sourceId = safeId(sourceRunId);
      const sourceRun = state.runs.get(sourceId);
      const kind = normalizeAutomaticContinuationKind(continuationKind || context?.automaticContinuationKind);
      if (!eligibleAutomaticContinuationSource(sourceRun, { threadId, context, continuationKind: kind })) {
        throw automaticContinuationError('AUTOMATIC_CONTINUATION_UNAVAILABLE', 409);
      }
      const continuationRootRunId = memoryExecutionRootRunId(state, sourceRun);
      const lineage = ensureMemoryExecutionLineage(state, sourceRun, continuationRootRunId);
      const existingRunId = lineage.automaticContinuationRunId
        || state.automaticContinuations.get(sourceId)
        || state.automaticContinuations.get(continuationRootRunId);
      if (existingRunId) {
        const existingRun = state.runs.get(existingRunId);
        if (!existingRun) {
          throw automaticContinuationError('AUTOMATIC_CONTINUATION_STATE_INVALID', 409);
        }
        if (existingRun.metadata?.automaticContinuationSourceRunId !== sourceId
          || normalizeAutomaticContinuationKind(existingRun.metadata?.automaticContinuationKind) !== kind) {
          throw automaticContinuationError('AUTOMATIC_CONTINUATION_LIMIT_REACHED', 409);
        }
        lineage.automaticContinuationCount = 1;
        lineage.automaticContinuationRunId = existingRunId;
        lineage.updatedAt = new Date().toISOString();
        const existingBudget = existingRun.metadata?.automaticContinuationBudget || null;
        const responseMessage = (state.messages.get(threadId) || []).find((message) => (
          message.runId === existingRunId && message.role === 'assistant' && message.status === 'succeeded'
        ));
        const workflowResume = buildMemoryWorkflowResume(state, {
          sourceRunId: sourceId,
          includeSourceStudentQuestion: true,
          continuationKind: kind,
          continuationBudget: existingBudget
        }, context);
        assertPersistedTaskSourceSet(existingRun.metadata?.taskSourceSet, workflowResume.taskSources);
        return {
          run: { ...existingRun },
          reused: true,
          response: responseMessage?.response,
          workflowResume,
          automaticContinuation: true,
          sourceResponse: automaticContinuationSourceResponse(state, sourceRun)
        };
      }
      if (lineage.automaticContinuationCount >= 1) {
        throw automaticContinuationError('AUTOMATIC_CONTINUATION_LIMIT_REACHED', 409);
      }
      const budget = validateAutomaticContinuationBudget({
        kind,
        context,
        continuationBudget: continuationBudget || context?.automaticContinuationBudget,
        lineageCreatedAt: lineage.createdAt
      });
      const workflowResume = buildMemoryWorkflowResume(state, {
        sourceRunId: sourceId,
        includeSourceStudentQuestion: true,
        continuationKind: kind,
        continuationBudget: budget
      }, context);
      assertAutomaticContinuationResumeEligible(workflowResume, kind);
      const sourceResponse = automaticContinuationSourceResponse(state, sourceRun);
      const run = {
        runId: `run_${crypto.randomUUID()}`,
        threadId,
        requestId: context?.requestId || '',
        tenantId: tenantId(context),
        userId: userId(context),
        intent: intent || 'single_entry',
        route: route || '',
        status: 'running',
        metadata: {
          automaticContinuationSourceRunId: sourceId,
          automaticContinuationKind: kind,
          automaticContinuationBudget: budget,
          taskSourceSet: persistedTaskSourceSet(workflowResume.taskSources),
          automaticContinuationSequence: 1,
          continuationRootRunId
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      lineage.automaticContinuationCount = 1;
      lineage.automaticContinuationRunId = run.runId;
      lineage.updatedAt = run.createdAt;
      state.automaticContinuations.set(sourceId, run.runId);
      state.automaticContinuations.set(continuationRootRunId, run.runId);
      state.runs.set(run.runId, run);
      state.runEvents.set(run.runId, []);
      await this.recordAuditEvent({
        eventType: 'teacher.run.automatic_continuation_created',
        tenantId: run.tenantId,
        userId: run.userId,
        requestId: run.requestId,
        runId: run.runId,
        status: 'running',
        metadata: { sourceRunId: sourceId, kind, sequence: 1, effectiveDurationMs: budget?.effectiveDurationMs || 0 }
      });
      return {
        run,
        reused: false,
        workflowResume,
        automaticContinuation: true,
        sourceResponse
      };
    },
    async createManualContinuationRun({ threadId, context, intent, route, sourceRunId, continuationKind }) {
      const sourceId = safeId(sourceRunId);
      const sourceRun = state.runs.get(sourceId);
      const manualKind = normalizeManualContinuationKind(continuationKind || context?.manualContinuationKind);
      if (!eligibleManualContinuationSource(sourceRun, { threadId, context })) {
        throw manualContinuationError('MANUAL_CONTINUATION_UNAVAILABLE', 409);
      }
      const continuationRootRunId = memoryExecutionRootRunId(state, sourceRun);
      const lineage = ensureMemoryExecutionLineage(state, sourceRun, continuationRootRunId);
      const requestId = String(context?.requestId || '');
      const userMessageId = `msg_${crypto.randomUUID()}`;
      const existingRun = [...state.runs.values()].find((candidate) => (
        candidate.metadata?.manualContinuationRequestId === requestId
        && candidate.metadata?.continuationRootRunId === continuationRootRunId
        && candidate.metadata?.manualContinuationSourceRunId === sourceId
        && candidate.metadata?.manualContinuationKind === manualKind
      ));
      if (existingRun) {
        const responseMessage = (state.messages.get(threadId) || []).find((message) => (
          message.runId === existingRun.runId && message.role === 'assistant' && message.status === 'succeeded'
        ));
        return {
          run: { ...existingRun },
          reused: true,
          response: responseMessage?.response,
          workflowResume: buildMemoryManualWorkflowResume(state, continuationRootRunId, context, {
            sourceRunId: sourceId,
            continuationKind: manualKind,
            feedbackMessageId: userMessageId,
          }),
          manualContinuation: true,
          automaticContinuationUsed: lineage.automaticContinuationCount >= 1,
          sourceResponse: memoryRunSourceResponse(state, sourceId)
        };
      }
      if (manualKind === ENGINEERING_FEEDBACK_CONTINUATION) {
        assertMemoryEngineeringFeedbackSource(state, sourceRun, continuationRootRunId);
      } else {
        assertMemoryLatestExecutionContinuationSource(state, sourceRun, continuationRootRunId);
      }
      const activeContinuationRun = [...state.runs.values()].find((candidate) => (
        candidate.runId !== continuationRootRunId
        && candidate.metadata?.continuationRootRunId === continuationRootRunId
        && ['running', 'waiting_for_clarification'].includes(candidate.status)
      ));
      if (activeContinuationRun) {
        throw manualContinuationError('MANUAL_CONTINUATION_IN_PROGRESS', 409);
      }
      const workflowResume = buildMemoryManualWorkflowResume(state, continuationRootRunId, context, {
        sourceRunId: sourceId,
        continuationKind: manualKind,
        feedbackMessageId: userMessageId,
      });
      const sourceResponse = memoryRunSourceResponse(state, sourceId);
      const run = {
        runId: `run_${crypto.randomUUID()}`,
        threadId,
        requestId,
        tenantId: tenantId(context),
        userId: userId(context),
        intent: intent || 'single_entry',
        route: route || '',
        status: 'running',
        metadata: {
          manualContinuation: true,
          manualContinuationSourceRunId: sourceId,
          manualContinuationRequestId: requestId,
          manualContinuationKind: manualKind,
          sourceRunId: sourceId,
          continuationRootRunId
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      state.runs.set(run.runId, run);
      state.runEvents.set(run.runId, []);
      const messages = state.messages.get(threadId) || [];
      if (!state.messages.has(threadId)) state.messages.set(threadId, messages);
      messages.push({
        messageId: userMessageId,
        threadId,
        runId: run.runId,
        role: 'user',
        status: 'received',
        content: manualKind === ENGINEERING_FEEDBACK_CONTINUATION
          ? boundedResumeQuestion(context?.question?.text)
          : workflowResume.sourceStudentQuestion,
        requestId,
        createdAt: run.createdAt
      });
      await this.recordAuditEvent({
        eventType: 'teacher.run.manual_continuation_created',
        tenantId: run.tenantId,
        userId: run.userId,
        requestId: run.requestId,
        runId: run.runId,
        status: 'running',
        metadata: { sourceRunId: sourceId, continuationRootRunId, continuationKind: manualKind }
      });
      return {
        run,
        reused: false,
        workflowResume,
        manualContinuation: true,
        automaticContinuationUsed: lineage.automaticContinuationCount >= 1,
        sourceResponse
      };
    },
    async pauseRunForClarification({ runId, context, response, providerMeta, checkpoint }) {
      const run = state.runs.get(runId);
      if (!run) throw new Error(`Unknown teacher run: ${runId}`);
      if (run.status !== 'running') return { messageId: run.messageId || '', status: run.status };
      const now = new Date().toISOString();
      const messageId = `msg_${crypto.randomUUID()}`;
      const savedCheckpoint = Object.freeze({
        ...checkpoint,
        sourceRunId: runId,
        threadId: run.threadId,
        tenantId: run.tenantId,
        userId: run.userId,
        state: 'waiting',
        createdAt: checkpoint.createdAt || now
      });
      run.status = 'waiting_for_clarification';
      run.updatedAt = now;
      run.messageId = messageId;
      run.providerMeta = sanitizeProviderMeta(providerMeta);
      state.clarificationCheckpoints.set(savedCheckpoint.checkpointId, { ...savedCheckpoint });
      const messages = state.messages.get(run.threadId) || [];
      const receivedMessage = messages.find((message) => (
        message.runId === runId && message.role === 'user' && message.status === 'received'
      ));
      if (receivedMessage) {
        receivedMessage.status = 'succeeded';
        receivedMessage.content = String(context?.question?.text || receivedMessage.content || '');
      }
      messages.push({
        messageId,
        threadId: run.threadId,
        runId,
        role: 'assistant',
        status: 'succeeded',
        content: String(response?.directAnswer || ''),
        response,
        requestId: context?.requestId || '',
        createdAt: now
      });
      await this.recordRunEvent({
        runId,
        eventType: 'clarification_requested',
        payload: { checkpointId: savedCheckpoint.checkpointId, expiresAt: savedCheckpoint.expiresAt }
      });
      await this.recordUsageEvent(usageFromProviderMeta({ run, providerMeta, status: 'waiting_for_clarification' }));
      return { messageId, checkpoint: savedCheckpoint };
    },
    async cancelClarificationCheckpoint({ checkpointId, threadId, context }) {
      const checkpoint = state.clarificationCheckpoints.get(safeId(checkpointId));
      if (!checkpoint || checkpoint.threadId !== threadId
        || checkpoint.tenantId !== tenantId(context) || checkpoint.userId !== userId(context)) {
        throw clarificationCheckpointError('CLARIFICATION_CHECKPOINT_UNAVAILABLE', 404);
      }
      if (checkpoint.state === 'waiting') checkpoint.state = 'cancelled';
      return { checkpointId: checkpoint.checkpointId, state: checkpoint.state };
    },
    async completeRun({ runId, context, response, providerMeta }) {
      const run = state.runs.get(runId);
      if (!run) throw new Error(`Unknown teacher run: ${runId}`);
      if (run.status === 'cancelled') return { messageId: run.messageId || '', cancelled: true };
      if (run.status && run.status !== 'running') return { messageId: run.messageId || '', status: run.status };
      const now = new Date().toISOString();
      run.status = 'succeeded';
      run.updatedAt = now;
      run.messageId = `msg_${crypto.randomUUID()}`;
      run.providerMeta = sanitizeProviderMeta(providerMeta);
      const messages = state.messages.get(run.threadId) || [];
      if (!state.messages.has(run.threadId)) state.messages.set(run.threadId, messages);
      const receivedMessage = messages.find((message) => (
        message.runId === runId && message.role === 'user' && message.status === 'received'
      ));
      if (receivedMessage) {
        receivedMessage.status = 'succeeded';
        receivedMessage.content = String(context?.question?.text || receivedMessage.content || '');
        receivedMessage.requestId = context?.requestId || receivedMessage.requestId || '';
      } else if (!run.metadata?.automaticContinuationSourceRunId) {
        messages.push({
          messageId: `msg_${crypto.randomUUID()}`,
          threadId: run.threadId,
          runId,
          role: 'user',
          status: 'succeeded',
          content: String(context?.question?.text || ''),
          requestId: context?.requestId || '',
          createdAt: now
        });
      }
      messages.push({
        messageId: run.messageId,
        threadId: run.threadId,
        runId,
        role: 'assistant',
        status: engineeringImprovementPendingResponse(response, providerMeta) ? 'internal_baseline' : 'succeeded',
        content: String(response?.directAnswer || ''),
        response,
        requestId: context?.requestId || '',
        createdAt: now
      });
      const delivery = deliveryObservation(response, providerMeta);
      await this.recordUsageEvent(usageFromProviderMeta({ run, providerMeta, status: 'succeeded' }));
      await this.recordAuditEvent({
        eventType: delivery.status === 'degraded' ? 'teacher.run.degraded' : 'teacher.run.succeeded',
        tenantId: run.tenantId,
        userId: run.userId,
        requestId: run.requestId,
        runId,
        status: delivery.status,
        metadata: {
          messageId: run.messageId,
          answerType: response?.answerType || '',
          delivery,
          budgetReport: providerMeta?.budgetReport || null,
          usage: summarizeUsage(providerMeta),
          providerTrace: providerMeta?.providerTrace || null
        }
      });
      return { messageId: run.messageId };
    },
    async failRun({ runId, error }) {
      const run = state.runs.get(runId);
      if (!run) return null;
      if (run.status === 'cancelled') return { ...run };
      if (run.status && run.status !== 'running') return { ...run };
      const now = new Date().toISOString();
      const status = runFailureStatus(error);
      run.status = status;
      run.updatedAt = now;
      run.errorCode = error?.code || 'TEACHER_RUN_FAILED';
      run.errorMessage = safeErrorMessage(error);
      const messages = state.messages.get(run.threadId) || [];
      const receivedMessage = messages.find((message) => (
        message.runId === runId && message.role === 'user' && message.status === 'received'
      ));
      if (receivedMessage) receivedMessage.status = status;
      await this.recordUsageEvent(usageFromProviderMeta({ run, providerMeta: error, status }));
      await this.recordAuditEvent({
        eventType: status === 'timed_out' ? 'teacher.run.timed_out' : 'teacher.run.failed',
        tenantId: run.tenantId,
        userId: run.userId,
        requestId: run.requestId,
        runId,
        status,
        metadata: {
          code: run.errorCode,
          statusCode: error?.statusCode || error?.status || null,
          internalProviderDiagnostic: error?.internalProviderDiagnostic || null,
          providerTrace: error?.providerTrace || null
        }
      });
      return run;
    },
    async getRun(runId) {
      const run = state.runs.get(runId);
      return run ? { ...run } : null;
    },
    async ensureTaskLifecycleContract(input = {}) {
      return ensureMemoryTaskLifecycleContract(state, input);
    },
    async loadTaskLifecycleContract(runId) {
      return loadMemoryTaskLifecycleContract(state, runId);
    },
    async loadLatestTaskLifecycleContractForThread(runId) {
      return loadLatestMemoryTaskLifecycleContractForThread(state, runId);
    },
    async appendTaskLifecycleContractEvent(input = {}) {
      return appendMemoryTaskLifecycleContractEvent(state, input);
    },
    async listTaskLifecycleContractEvents(runId) {
      return listMemoryTaskLifecycleContractEvents(state, runId);
    },
    async appendExecutionCheckpoint({ runId, boundary }) {
      return appendMemoryExecutionCheckpoint(state, { runId, boundary });
    },
    async loadLatestExecutionCheckpoint(runId, options = {}) {
      return loadLatestMemoryExecutionCheckpoint(state, runId, options);
    },
    async listExecutionCheckpointTimeline(runId, options = {}) {
      return listMemoryExecutionCheckpointTimeline(state, runId, options);
    },
    async findReusableValidationArtifact(input = {}) {
      return findMemoryReusableValidationArtifact(state, input);
    },
    async getRunIntentAudit(runId) {
      const run = state.runs.get(runId);
      if (!run) return null;
      const receivedMessage = (state.messages.get(run.threadId) || []).find((message) => (
        message.runId === runId && message.role === 'user'
      ));
      return intentAuditFromProviderMeta(run.providerMeta, receivedMessage?.content);
    },
    async cancelRun({ runId, error }) {
      const run = state.runs.get(runId);
      if (!run) return null;
      if (run.status && run.status !== 'running') return { ...run };
      const now = new Date().toISOString();
      run.status = 'cancelled';
      run.updatedAt = now;
      run.errorCode = error?.code || 'TEACHER_RUN_CANCELLED';
      run.errorMessage = safeErrorMessage(error || new Error('Teacher run cancelled'));
      const messages = state.messages.get(run.threadId) || [];
      const receivedMessage = messages.find((message) => (
        message.runId === runId && message.role === 'user' && message.status === 'received'
      ));
      if (receivedMessage) receivedMessage.status = 'cancelled';
      await this.recordRunEvent({
        runId,
        eventType: 'cancelled',
        payload: { code: run.errorCode, message: run.errorMessage, status: 499 }
      });
      await this.recordAuditEvent({
        eventType: 'teacher.run.cancelled',
        tenantId: run.tenantId,
        userId: run.userId,
        requestId: run.requestId,
        runId,
        status: 'cancelled',
        metadata: { code: run.errorCode }
      });
      return { ...run };
    },
    async recordRunEvent(event) {
      const runId = event.runId || '';
      if (!runId) return null;
      const events = state.runEvents.get(runId) || [];
      if (!state.runEvents.has(runId)) state.runEvents.set(runId, events);
      const safe = {
        eventId: `event_${crypto.randomUUID()}`,
        runId,
        seq: events.length + 1,
        eventType: event.eventType || event.type || '',
        payload: sanitizeRunEventPayload(event.payload || {}),
        createdAt: new Date().toISOString()
      };
      events.push(safe);
      return safe;
    },
    async listRunEvents(runId, options = {}) {
      const afterSeq = Math.max(0, Number(options.afterSeq || 0));
      return (state.runEvents.get(runId) || []).filter((event) => Number(event.seq || 0) > afterSeq);
    },
    async recordRunStep(step) {
      state.runSteps.push({ ...sanitizeRunStep(step), createdAt: new Date().toISOString() });
    },
    async recordModelCallLedgerEntry(entry) {
      const safe = sanitizeModelCallLedgerEntry(entry);
      state.modelCallLedger.set(`${safe.runId}:${safe.callId}:${safe.stepNumber}`, safe);
      return safe;
    },
    async listModelCallLedgerEntries(runId) {
      return [...state.modelCallLedger.values()]
        .filter((entry) => entry.runId === runId)
        .sort((left, right) => left.stepNumber - right.stepNumber
          || String(left.startedAt || '').localeCompare(String(right.startedAt || '')));
    },
    async getToolLedgerEntry(runId, toolCallId) {
      return state.toolLedger.get(`${runId}:${toolCallId}`) || null;
    },
    async listToolLedgerEntries(runId, options = {}) {
      return [...state.toolLedger.values()]
        .filter((entry) => entry.runId === runId && (!options.toolName || entry.toolName === options.toolName))
        .sort((left, right) => String(left.startedAt || '').localeCompare(String(right.startedAt || '')));
    },
    async recordToolLedgerEntry(entry) {
      const safe = sanitizeToolLedgerEntry(entry);
      const key = `${safe.runId}:${safe.toolCallId}`;
      const existing = state.toolLedger.get(key);
      if (existing && existing.argsHash !== safe.argsHash) throw toolReplayMismatchError();
      if (existing && existing.status !== 'started' && safe.status === 'started') return existing;
      state.toolLedger.set(key, safe);
      return safe;
    },
    async loadProjectModelingState(threadId, goalContractHash) {
      const key = projectPlanKey(threadId, goalContractHash);
      const exactPlan = state.projectPlans.get(key);
      const plan = exactPlan || [...state.projectPlans.entries()]
        .filter(([storedKey, candidate]) => storedKey.startsWith(`${String(threadId || '')}:`) && candidate?.status === 'active')
        .map(([, candidate]) => candidate)
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0];
      if (!plan) return null;
      const checkpoints = state.moduleCheckpoints.get(plan.projectId) || [];
      return cloneBoundedProjectPayload({ plan, checkpoints });
    },
    async saveModelProjectPlan({ threadId, plan }) {
      const safe = cloneBoundedProjectPayload(plan);
      const key = projectPlanKey(threadId, safe.goalContractHash);
      state.projectPlans.set(key, safe);
      return cloneBoundedProjectPayload(safe);
    },
    async saveModuleCheckpoint({ checkpoint }) {
      const safe = cloneBoundedProjectPayload(checkpoint);
      const current = state.moduleCheckpoints.get(safe.projectId) || [];
      const next = current.filter((item) => item.checkpointId !== safe.checkpointId);
      next.push(safe);
      state.moduleCheckpoints.set(safe.projectId, next.slice(-20));
      return cloneBoundedProjectPayload(safe);
    },
    async recordMessageFeedback({ messageId, context, outcome, reasonCodes, judgeVersion, judgeLabel }) {
      const message = [...state.messages.values()].flat().find((item) => item.messageId === messageId && item.role === 'assistant');
      const run = message ? state.runs.get(message.runId) : null;
      if (!message || !run || run.tenantId !== tenantId(context) || run.userId !== userId(context)) return null;
      const feedback = {
        messageId,
        outcome,
        reasonCodes,
        judgeVersion,
        judgeLabel,
        updatedAt: new Date().toISOString()
      };
      await this.recordAuditEvent({
        eventType: 'teacher.message.feedback',
        tenantId: run.tenantId,
        userId: run.userId,
        requestId: run.requestId,
        runId: run.runId,
        status: outcome,
        metadata: feedback
      });
      return feedback;
    },
    async recordUsageEvent(event) {
      if (!event) return;
      state.usageLedger.push({ ledgerId: `usage_${crypto.randomUUID()}`, ...event, createdAt: new Date().toISOString() });
    },
    async dailyUsageTokens(tenantIdValue, userIdValue) {
      const today = new Date().toISOString().slice(0, 10);
      return state.usageLedger
        .filter((event) => event.tenantId === tenantIdValue && event.userId === userIdValue && String(event.createdAt || '').startsWith(today))
        .reduce((sum, event) => sum + number(event.totalTokens), 0);
    },
    async getFailureObservability(options = {}) {
      return failureObservabilitySnapshot(state.auditEvents, {
        ...options,
        observationEnabled: process.env.AI_TEACHER_AUDIT_ENABLED !== 'false'
      });
    },
    async recordAuditEvent(event) {
      if (process.env.AI_TEACHER_AUDIT_ENABLED === 'false') return;
      state.auditEvents.push(redactAuditEvent({
        auditId: `audit_${crypto.randomUUID()}`,
        ...event,
        createdAt: new Date().toISOString()
      }));
    },
    async close() {}
  };
}

function createPostgresConversationStore(options = {}) {
  const pool = options.pool || createPool(options);
  const ownedPool = !options.pool;
  return {
    mode: 'postgres',
    async createThread(context) {
      const threadId = `thread_${crypto.randomUUID()}`;
      await pool.query(`
        insert into teacher_threads (thread_id, tenant_id, user_id, course_pack_id, course_id, lesson_id, metadata)
        values ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `, [
        threadId,
        tenantId(context),
        userId(context),
        context?.course?.coursePackId || '',
        context?.course?.courseId || '',
        context?.course?.lessonId || '',
        JSON.stringify({ requestId: context?.requestId || '' })
      ]);
      return { threadId };
    },
    async ensureThread(context, requestedThreadId) {
      const requested = safeId(requestedThreadId);
      const requestedThread = requested ? await loadThread(pool, requested) : null;
      const threadId = requested && (!requestedThread || sameThreadOwner(requestedThread, context))
        ? requested
        : await findDefaultPostgresThreadId(pool, context) || `thread_${crypto.randomUUID()}`;
      await pool.query(`
        insert into teacher_threads (thread_id, tenant_id, user_id, course_pack_id, course_id, lesson_id, metadata, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
        on conflict (thread_id) do update set updated_at = now()
      `, [
        threadId,
        tenantId(context),
        userId(context),
        context?.course?.coursePackId || '',
        context?.course?.courseId || '',
        context?.course?.lessonId || '',
        JSON.stringify({ requestId: context?.requestId || '' })
      ]);
      return { threadId };
    },
    async listThreads(context, options = {}) {
      const scope = String(options.scope || 'all');
      const limit = Math.max(1, Math.min(100, Number(options.limit || 50)));
      const params = [tenantId(context), userId(context)];
      let where = 't.tenant_id = $1 and t.user_id = $2';
      if (scope === 'current') {
        params.push(context?.course?.coursePackId || '', context?.course?.courseId || '', context?.course?.lessonId || '');
        where += ' and t.course_pack_id = $3 and t.course_id = $4 and t.lesson_id = $5';
      } else if (scope === 'course') {
        params.push(context?.course?.coursePackId || '', context?.course?.courseId || '');
        where += ' and t.course_pack_id = $3 and t.course_id = $4';
      }
      params.push(limit);
      const result = await pool.query(`
        select t.thread_id, t.tenant_id, t.user_id, t.course_pack_id, t.course_id, t.lesson_id, t.created_at, t.updated_at,
          count(m.message_id)::int as message_count,
          coalesce((array_agg(m.content order by m.created_at) filter (where m.role = 'user'))[1], '') as title,
          coalesce(sum(octet_length(m.content)), 0)::bigint as context_byte_count
        from teacher_threads t
        left join teacher_messages m on m.thread_id = t.thread_id and m.status = 'succeeded'
        where ${where}
        group by t.thread_id
        order by t.updated_at desc
        limit $${params.length}
      `, params);
      return result.rows.map((row) => threadRow(row, options.contextLimitTokens));
    },
    async deleteThread(context, threadId) {
      const id = safeId(threadId);
      if (!id) return { deleted: false, reason: 'not_found' };
      const result = await pool.query(`
        delete from teacher_threads t
        where t.thread_id = $1 and t.tenant_id = $2 and t.user_id = $3
          and not exists (
            select 1 from teacher_runs r where r.thread_id = t.thread_id and r.status = 'running'
          )
        returning t.thread_id
      `, [id, tenantId(context), userId(context)]);
      if (result.rowCount) return { deleted: true, threadId: id };
      const active = await pool.query(`
        select 1
        from teacher_threads t
        join teacher_runs r on r.thread_id = t.thread_id and r.status = 'running'
        where t.thread_id = $1 and t.tenant_id = $2 and t.user_id = $3
        limit 1
      `, [id, tenantId(context), userId(context)]);
      return { deleted: false, reason: active.rowCount ? 'active_run' : 'not_found' };
    },
    async listMessages(threadId, options = {}) {
      const limit = Math.max(1, Math.min(200, Number(options.limit || 50)));
      const result = await pool.query(`
        select message_id, thread_id, run_id, role, status, content, response, request_id, created_at,
          coalesce((select metadata ->> 'automaticContinuationSourceRunId'
            from teacher_runs where run_id = teacher_messages.run_id), '') as automatic_continuation_source_run_id
        from teacher_messages
        where thread_id = $1 and (
          role = 'user'
          or status = 'succeeded'
          or (
            role = 'assistant' and status = 'internal_baseline'
            and not exists (
              select 1 from teacher_runs child
              join teacher_messages child_message on child_message.run_id = child.run_id
                and child_message.role = 'assistant' and child_message.status = 'succeeded'
              where child.metadata ->> 'automaticContinuationSourceRunId' = teacher_messages.run_id
            )
          )
        )
        order by created_at desc, run_id desc,
          case role when 'assistant' then 0 when 'user' then 1 else 2 end asc,
          message_id desc
        limit $2
      `, [threadId, limit]);
      return result.rows.reverse().map(messageRow);
    },
    async listSuccessfulMessages(threadId) {
      const result = await pool.query(`
        select message_id, thread_id, run_id, role, status, content, response, request_id, created_at,
          coalesce((select metadata ->> 'automaticContinuationSourceRunId'
            from teacher_runs where run_id = teacher_messages.run_id), '') as automatic_continuation_source_run_id
        from teacher_messages
        where thread_id = $1 and (role = 'user' or status = 'succeeded')
        order by created_at desc, run_id desc,
          case role when 'assistant' then 0 when 'user' then 1 else 2 end asc,
          message_id desc
      `, [threadId]);
      return result.rows.reverse().map(messageRow).filter(modelConversationMessage);
    },
    async createRun({ threadId, context, intent, route }) {
      const run = {
        runId: `run_${crypto.randomUUID()}`,
        threadId,
        requestId: context?.requestId || '',
        tenantId: tenantId(context),
        userId: userId(context),
        intent: intent || 'single_entry',
        route: route || ''
      };
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`
          insert into teacher_runs (run_id, thread_id, request_id, tenant_id, user_id, intent, route, status, metadata, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, 'running', $8::jsonb, now(), now())
        `, [run.runId, run.threadId, run.requestId, run.tenantId, run.userId, run.intent, run.route,
          JSON.stringify({ continuationRootRunId: run.runId, automaticContinuationSequence: 0 })]);
        await client.query(`
          insert into teacher_execution_lineages (
            root_run_id, thread_id, tenant_id, user_id, automatic_continuation_count,
            next_checkpoint_revision, created_at, updated_at
          ) values ($1, $2, $3, $4, 0, 1, now(), now())
          on conflict (root_run_id) do nothing
        `, [run.runId, run.threadId, run.tenantId, run.userId]);
        await client.query(`
          insert into teacher_messages (message_id, thread_id, run_id, role, status, content, request_id, metadata)
          values ($1, $2, $3, 'user', 'received', $4, $5, '{}'::jsonb)
        `, [`msg_${crypto.randomUUID()}`, run.threadId, run.runId, String(context?.question?.text || ''), run.requestId]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      await this.recordAuditEvent({
        eventType: 'teacher.run.created',
        tenantId: run.tenantId,
        userId: run.userId,
        requestId: run.requestId,
        runId: run.runId,
        status: 'running',
        metadata: { intent: run.intent, route: run.route }
      });
      return { ...run, status: 'running' };
    },
    async createResumedRun({ threadId, context, intent, route, checkpointId }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const selected = await client.query(`
          select * from teacher_clarification_checkpoints
          where checkpoint_id = $1 and thread_id = $2 and tenant_id = $3 and user_id = $4
          for update
        `, [safeId(checkpointId), threadId, tenantId(context), userId(context)]);
        const checkpoint = selected.rows[0];
        if (!checkpoint) throw clarificationCheckpointError('CLARIFICATION_CHECKPOINT_UNAVAILABLE', 404);
        if (checkpoint.state === 'waiting' && new Date(checkpoint.expires_at).getTime() <= Date.now()) {
          await client.query(`update teacher_clarification_checkpoints set state = 'expired' where checkpoint_id = $1`, [checkpoint.checkpoint_id]);
          await client.query('commit');
          throw clarificationCheckpointError('CLARIFICATION_CHECKPOINT_EXPIRED', 409);
        }
        if (checkpoint.state === 'resolved') {
          if (checkpoint.resume_request_id !== String(context?.requestId || '')) {
            throw clarificationCheckpointError('CLARIFICATION_CHECKPOINT_CONSUMED', 409);
          }
          const existingRun = await client.query('select * from teacher_runs where run_id = $1', [checkpoint.resumed_run_id]);
          const existingResponse = await client.query(`
            select response from teacher_messages
            where run_id = $1 and role = 'assistant' and status = 'succeeded'
            order by created_at desc limit 1
          `, [checkpoint.resumed_run_id]);
          const workflowResume = await buildPostgresWorkflowResume(
            client,
            checkpoint,
            context,
            checkpoint.resumed_run_id
          );
          await client.query('commit');
          return {
            run: runRow(existingRun.rows[0]),
            reused: true,
            response: existingResponse.rows[0]?.response || undefined,
            workflowResume
          };
        }
        if (checkpoint.state !== 'waiting') {
          throw clarificationCheckpointError('CLARIFICATION_CHECKPOINT_UNAVAILABLE', 409);
        }
        const run = {
          runId: `run_${crypto.randomUUID()}`,
          threadId,
          requestId: context?.requestId || '',
          tenantId: tenantId(context),
          userId: userId(context),
          intent: intent || 'single_entry',
          route: route || ''
        };
        const continuationRootRunId = await ensurePostgresExecutionLineage(client, checkpoint.source_run_id);
        const responseMessageId = `msg_${crypto.randomUUID()}`;
        await client.query(`
          insert into teacher_runs (run_id, thread_id, request_id, tenant_id, user_id, intent, route, status, metadata, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, 'running', $8::jsonb, now(), now())
        `, [run.runId, run.threadId, run.requestId, run.tenantId, run.userId, run.intent, run.route,
          JSON.stringify({
            resumedFromCheckpointId: checkpoint.checkpoint_id,
            sourceRunId: checkpoint.source_run_id,
            continuationRootRunId
          })]);
        await client.query(`
          insert into teacher_messages (message_id, thread_id, run_id, role, status, content, request_id, metadata)
          values ($1, $2, $3, 'user', 'received', $4, $5, '{}'::jsonb)
        `, [responseMessageId, run.threadId, run.runId, String(context?.question?.text || ''), run.requestId]);
        await client.query(`
          update teacher_clarification_checkpoints
          set state = 'resolved', resume_request_id = $2, response_message_id = $3,
              resumed_run_id = $4, resolved_at = now()
          where checkpoint_id = $1 and state = 'waiting'
        `, [checkpoint.checkpoint_id, run.requestId, responseMessageId, run.runId]);
        const workflowResume = await buildPostgresWorkflowResume(client, checkpoint, context, run.runId);
        const sourceResponse = await postgresAutomaticContinuationSourceResponse(client, checkpoint.source_run_id);
        await client.query('commit');
        return { run: { ...run, status: 'running' }, reused: false, workflowResume, sourceResponse };
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async createAutomaticContinuationRun({
      threadId,
      context,
      intent,
      route,
      sourceRunId,
      continuationKind,
      continuationBudget
    }) {
      const sourceId = safeId(sourceRunId);
      const kind = normalizeAutomaticContinuationKind(continuationKind || context?.automaticContinuationKind);
      const client = await pool.connect();
      try {
        await client.query('begin');
        const sourceResult = await client.query(`
          select * from teacher_runs
          where run_id = $1 and thread_id = $2 and tenant_id = $3 and user_id = $4
          for update
        `, [sourceId, threadId, tenantId(context), userId(context)]);
        const sourceRun = sourceResult.rows[0];
        if (!eligibleAutomaticContinuationSourceRow(sourceRun, kind)) {
          throw automaticContinuationError('AUTOMATIC_CONTINUATION_UNAVAILABLE', 409);
        }
        const continuationRootRunId = await ensurePostgresExecutionLineage(client, sourceId, sourceRun);
        const lineageResult = await client.query(`
          select * from teacher_execution_lineages where root_run_id = $1 for update
        `, [continuationRootRunId]);
        const lineage = lineageResult.rows[0];
        const existing = await client.query(`
          select * from teacher_runs
          where metadata ->> 'automaticContinuationSourceRunId' = $1
             or ($2 <> '' and run_id = $2)
          order by created_at asc limit 1
        `, [sourceId, lineage?.automatic_continuation_run_id || '']);
        if (existing.rows[0]) {
          if (existing.rows[0].metadata?.automaticContinuationSourceRunId !== sourceId
            || normalizeAutomaticContinuationKind(existing.rows[0].metadata?.automaticContinuationKind) !== kind) {
            throw automaticContinuationError('AUTOMATIC_CONTINUATION_LIMIT_REACHED', 409);
          }
          await client.query(`
            update teacher_execution_lineages
            set automatic_continuation_count = 1, automatic_continuation_run_id = $2, updated_at = now()
            where root_run_id = $1
          `, [continuationRootRunId, existing.rows[0].run_id]);
          const existingResponse = await client.query(`
            select response from teacher_messages
            where run_id = $1 and role = 'assistant' and status = 'succeeded'
            order by created_at desc limit 1
          `, [existing.rows[0].run_id]);
          const sourceResponse = await postgresAutomaticContinuationSourceResponse(client, sourceId);
          const existingBudget = existing.rows[0].metadata?.automaticContinuationBudget || null;
          const workflowResume = await buildPostgresWorkflowResume(client, {
            source_run_id: sourceId,
            includeSourceStudentQuestion: true,
            continuationKind: kind,
            continuationBudget: existingBudget
          }, context);
          assertPersistedTaskSourceSet(existing.rows[0].metadata?.taskSourceSet, workflowResume.taskSources);
          await client.query('commit');
          return {
            run: runRow(existing.rows[0]),
            reused: true,
            response: existingResponse.rows[0]?.response || undefined,
            workflowResume,
            automaticContinuation: true,
            sourceResponse
          };
        }
        if (Number(lineage?.automatic_continuation_count || 0) >= 1) {
          throw automaticContinuationError('AUTOMATIC_CONTINUATION_LIMIT_REACHED', 409);
        }
        const budget = validateAutomaticContinuationBudget({
          kind,
          context,
          continuationBudget: continuationBudget || context?.automaticContinuationBudget,
          lineageCreatedAt: lineage?.created_at || sourceRun.created_at
        });
        const workflowResume = await buildPostgresWorkflowResume(client, {
          source_run_id: sourceId,
          includeSourceStudentQuestion: true,
          continuationKind: kind,
          continuationBudget: budget
        }, context);
        assertAutomaticContinuationResumeEligible(workflowResume, kind);
        const run = {
          runId: `run_${crypto.randomUUID()}`,
          threadId,
          requestId: context?.requestId || '',
          tenantId: tenantId(context),
          userId: userId(context),
          intent: intent || 'single_entry',
          route: route || '',
          metadata: {
            automaticContinuationSourceRunId: sourceId,
            automaticContinuationKind: kind,
            automaticContinuationBudget: budget,
            taskSourceSet: persistedTaskSourceSet(workflowResume.taskSources),
            automaticContinuationSequence: 1,
            continuationRootRunId
          }
        };
        await client.query(`
          insert into teacher_runs (run_id, thread_id, request_id, tenant_id, user_id, intent, route, status, metadata, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, 'running', $8::jsonb, now(), now())
        `, [run.runId, run.threadId, run.requestId, run.tenantId, run.userId, run.intent, run.route,
          JSON.stringify(run.metadata)]);
        await client.query(`
          update teacher_execution_lineages
          set automatic_continuation_count = 1, automatic_continuation_run_id = $2, updated_at = now()
          where root_run_id = $1 and automatic_continuation_count = 0
        `, [continuationRootRunId, run.runId]);
        const sourceResponse = await postgresAutomaticContinuationSourceResponse(client, sourceId);
        await client.query('commit');
        await this.recordAuditEvent({
          eventType: 'teacher.run.automatic_continuation_created',
          tenantId: run.tenantId,
          userId: run.userId,
          requestId: run.requestId,
          runId: run.runId,
          status: 'running',
          metadata: { sourceRunId: sourceId, kind, sequence: 1, effectiveDurationMs: budget?.effectiveDurationMs || 0 }
        });
        return {
          run: { ...run, status: 'running' },
          reused: false,
          workflowResume,
          automaticContinuation: true,
          sourceResponse
        };
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async createManualContinuationRun({ threadId, context, intent, route, sourceRunId, continuationKind }) {
      const sourceId = safeId(sourceRunId);
      const requestId = String(context?.requestId || '');
      const manualKind = normalizeManualContinuationKind(continuationKind || context?.manualContinuationKind);
      const userMessageId = `msg_${crypto.randomUUID()}`;
      const client = await pool.connect();
      try {
        await client.query('begin');
        const sourceResult = await client.query(`
          select * from teacher_runs
          where run_id = $1 and thread_id = $2 and tenant_id = $3 and user_id = $4
          for update
        `, [sourceId, threadId, tenantId(context), userId(context)]);
        const sourceRun = sourceResult.rows[0];
        if (!eligibleManualContinuationSourceRow(sourceRun)) {
          throw manualContinuationError('MANUAL_CONTINUATION_UNAVAILABLE', 409);
        }
        const continuationRootRunId = await ensurePostgresExecutionLineage(client, sourceId, sourceRun);
        const lineageResult = await client.query(`
          select * from teacher_execution_lineages where root_run_id = $1 for update
        `, [continuationRootRunId]);
        const lineage = lineageResult.rows[0];
        const existing = await client.query(`
          select * from teacher_runs
          where metadata ->> 'manualContinuationRequestId' = $1
            and metadata ->> 'continuationRootRunId' = $2
            and metadata ->> 'manualContinuationSourceRunId' = $3
            and metadata ->> 'manualContinuationKind' = $4
          order by created_at asc limit 1
        `, [requestId, continuationRootRunId, sourceId, manualKind]);
        if (existing.rows[0]) {
          const existingResponse = await client.query(`
            select response from teacher_messages
            where run_id = $1 and role = 'assistant' and status = 'succeeded'
            order by created_at desc limit 1
          `, [existing.rows[0].run_id]);
          const workflowResume = await buildPostgresManualWorkflowResume(
            client,
            continuationRootRunId,
            context,
            { sourceRunId: sourceId, continuationKind: manualKind, feedbackMessageId: userMessageId }
          );
          const sourceResponse = await postgresRunSourceResponse(client, sourceId);
          await client.query('commit');
          return {
            run: runRow(existing.rows[0]),
            reused: true,
            response: existingResponse.rows[0]?.response || undefined,
            workflowResume,
            manualContinuation: true,
            automaticContinuationUsed: Number(lineage?.automatic_continuation_count || 0) >= 1,
            sourceResponse
          };
        }
        if (manualKind === ENGINEERING_FEEDBACK_CONTINUATION) {
          await assertPostgresEngineeringFeedbackSource(client, sourceRun, continuationRootRunId);
        } else {
          await assertPostgresLatestExecutionContinuationSource(client, sourceRun, continuationRootRunId);
        }
        const active = await client.query(`
          select run_id from teacher_runs
          where run_id <> $1
            and metadata ->> 'continuationRootRunId' = $1
            and status in ('running', 'waiting_for_clarification')
          order by created_at asc limit 1
        `, [continuationRootRunId]);
        if (active.rows[0]) {
          throw manualContinuationError('MANUAL_CONTINUATION_IN_PROGRESS', 409);
        }
        const workflowResume = await buildPostgresManualWorkflowResume(
          client,
          continuationRootRunId,
          context,
          { sourceRunId: sourceId, continuationKind: manualKind, feedbackMessageId: userMessageId }
        );
        const sourceResponse = await postgresRunSourceResponse(client, sourceId);
        const run = {
          runId: `run_${crypto.randomUUID()}`,
          threadId,
          requestId,
          tenantId: tenantId(context),
          userId: userId(context),
          intent: intent || 'single_entry',
          route: route || ''
        };
        await client.query(`
          insert into teacher_runs (run_id, thread_id, request_id, tenant_id, user_id, intent, route, status, metadata, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, 'running', $8::jsonb, now(), now())
        `, [run.runId, run.threadId, run.requestId, run.tenantId, run.userId, run.intent, run.route,
          JSON.stringify({
            manualContinuation: true,
            manualContinuationSourceRunId: sourceId,
            manualContinuationRequestId: requestId,
            manualContinuationKind: manualKind,
            sourceRunId: sourceId,
            continuationRootRunId
          })]);
        await client.query(`
          insert into teacher_messages (message_id, thread_id, run_id, role, status, content, request_id, metadata)
          values ($1, $2, $3, 'user', 'received', $4, $5, '{}'::jsonb)
        `, [
          userMessageId,
          run.threadId,
          run.runId,
          manualKind === ENGINEERING_FEEDBACK_CONTINUATION
            ? boundedResumeQuestion(context?.question?.text)
            : workflowResume.sourceStudentQuestion,
          run.requestId
        ]);
        await client.query('commit');
        await this.recordAuditEvent({
          eventType: 'teacher.run.manual_continuation_created',
          tenantId: run.tenantId,
          userId: run.userId,
          requestId: run.requestId,
          runId: run.runId,
          status: 'running',
          metadata: { sourceRunId: sourceId, continuationRootRunId }
        });
        return {
          run: { ...run, status: 'running', metadata: {
            manualContinuation: true,
            manualContinuationSourceRunId: sourceId,
            manualContinuationRequestId: requestId,
            manualContinuationKind: manualKind,
            sourceRunId: sourceId,
            continuationRootRunId
          } },
          reused: false,
          workflowResume,
          manualContinuation: true,
          automaticContinuationUsed: Number(lineage?.automatic_continuation_count || 0) >= 1,
          sourceResponse
        };
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async pauseRunForClarification({ runId, context, response, providerMeta, checkpoint }) {
      const messageId = `msg_${crypto.randomUUID()}`;
      const run = await loadRun(pool, runId);
      if (!run) throw new Error(`Unknown teacher run: ${runId}`);
      if (run.status !== 'running') return { messageId: run.message_id || '', status: run.status };
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`
          update teacher_messages set status = 'succeeded', content = $2, request_id = $3
          where run_id = $1 and role = 'user' and status = 'received'
        `, [runId, String(context?.question?.text || ''), context?.requestId || '']);
        await client.query(`
          insert into teacher_messages (message_id, thread_id, run_id, role, status, content, response, request_id, metadata)
          values ($1, $2, $3, 'assistant', 'succeeded', $4, $5::jsonb, $6, '{}'::jsonb)
        `, [messageId, run.thread_id, runId, String(response?.directAnswer || ''), JSON.stringify(response || {}), context?.requestId || '']);
        await client.query(`
          insert into teacher_clarification_checkpoints (
            checkpoint_id, source_run_id, thread_id, tenant_id, user_id, accepted_tool_call_id,
            question, state, created_at, expires_at
          ) values ($1, $2, $3, $4, $5, $6, $7, 'waiting', $8, $9)
        `, [checkpoint.checkpointId, runId, run.thread_id, run.tenant_id, run.user_id,
          checkpoint.acceptedToolCallId, checkpoint.question, checkpoint.createdAt, checkpoint.expiresAt]);
        await client.query(`
          update teacher_runs set status = 'waiting_for_clarification', message_id = $2,
            provider_meta = $3::jsonb, updated_at = now()
          where run_id = $1 and status = 'running'
        `, [runId, messageId, JSON.stringify(sanitizeProviderMeta(providerMeta))]);
        const seq = Number(run.next_event_seq || 0) + 1;
        await client.query(`update teacher_runs set next_event_seq = $2 where run_id = $1`, [runId, seq]);
        await client.query(`
          insert into teacher_run_events (event_id, run_id, seq, event_type, payload)
          values ($1, $2, $3, 'clarification_requested', $4::jsonb)
        `, [`event_${crypto.randomUUID()}`, runId, seq, JSON.stringify({ checkpointId: checkpoint.checkpointId, expiresAt: checkpoint.expiresAt })]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      await this.recordUsageEvent(usageFromProviderMeta({ run: rowRun(run), providerMeta, status: 'waiting_for_clarification' }));
      return { messageId, checkpoint: { ...checkpoint, sourceRunId: runId, state: 'waiting' } };
    },
    async cancelClarificationCheckpoint({ checkpointId, threadId, context }) {
      const result = await pool.query(`
        update teacher_clarification_checkpoints
        set state = case when state = 'waiting' then 'cancelled' else state end
        where checkpoint_id = $1 and thread_id = $2 and tenant_id = $3 and user_id = $4
        returning checkpoint_id, state
      `, [safeId(checkpointId), threadId, tenantId(context), userId(context)]);
      if (!result.rows[0]) throw clarificationCheckpointError('CLARIFICATION_CHECKPOINT_UNAVAILABLE', 404);
      return { checkpointId: result.rows[0].checkpoint_id, state: result.rows[0].state };
    },
    async completeRun({ runId, context, response, providerMeta }) {
      const messageId = `msg_${crypto.randomUUID()}`;
      const assistantMessageStatus = engineeringImprovementPendingResponse(response, providerMeta)
        ? 'internal_baseline'
        : 'succeeded';
      const run = await loadRun(pool, runId);
      if (!run) throw new Error(`Unknown teacher run: ${runId}`);
      if (run.status === 'cancelled') return { messageId: run.message_id || '', cancelled: true };
      if (run.status && run.status !== 'running') return { messageId: run.message_id || '', status: run.status };
      const client = await pool.connect();
      try {
        await client.query('begin');
        const updatedUser = await client.query(`
          update teacher_messages
          set status = 'succeeded', content = $2, request_id = $3
          where run_id = $1 and role = 'user' and status = 'received'
        `, [runId, String(context?.question?.text || ''), context?.requestId || '']);
        if (updatedUser.rowCount === 0 && !run.metadata?.automaticContinuationSourceRunId) {
          await client.query(`
            insert into teacher_messages (message_id, thread_id, run_id, role, status, content, request_id, metadata)
            values ($1, $2, $3, 'user', 'succeeded', $4, $5, '{}'::jsonb)
          `, [`msg_${crypto.randomUUID()}`, run.thread_id, runId, String(context?.question?.text || ''), context?.requestId || '']);
        }
        await client.query(`
          insert into teacher_messages (message_id, thread_id, run_id, role, status, content, response, request_id, metadata)
          values ($1, $2, $3, 'assistant', $4, $5, $6::jsonb, $7, '{}'::jsonb)
        `, [
          messageId,
          run.thread_id,
          runId,
          assistantMessageStatus,
          String(response?.directAnswer || ''),
          JSON.stringify(response || {}),
          context?.requestId || ''
        ]);
        await client.query(`
          update teacher_runs
          set status = 'succeeded', message_id = $2, provider_meta = $3::jsonb, updated_at = now()
          where run_id = $1
        `, [runId, messageId, JSON.stringify(sanitizeProviderMeta(providerMeta))]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      const delivery = deliveryObservation(response, providerMeta);
      await this.recordUsageEvent(usageFromProviderMeta({ run: rowRun(run), providerMeta, status: 'succeeded' }));
      await this.recordAuditEvent({
        eventType: delivery.status === 'degraded' ? 'teacher.run.degraded' : 'teacher.run.succeeded',
        tenantId: run.tenant_id,
        userId: run.user_id,
        requestId: run.request_id,
        runId,
        status: delivery.status,
        metadata: {
          messageId,
          answerType: response?.answerType || '',
          delivery,
          budgetReport: providerMeta?.budgetReport || null,
          usage: summarizeUsage(providerMeta),
          providerTrace: providerMeta?.providerTrace || null
        }
      });
      return { messageId };
    },
    async failRun({ runId, error }) {
      const run = await loadRun(pool, runId);
      if (!run) return null;
      if (run.status === 'cancelled') return runRow(run);
      if (run.status && run.status !== 'running') return runRow(run);
      const status = runFailureStatus(error);
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`
          update teacher_runs
          set status = $2, error_code = $3, error_message = $4, provider_meta = $5::jsonb, updated_at = now()
          where run_id = $1
        `, [
          runId,
          status,
          error?.code || 'TEACHER_RUN_FAILED',
          safeErrorMessage(error),
          JSON.stringify(sanitizeProviderMeta(error))
        ]);
        await client.query(`
          update teacher_messages
          set status = $2
          where run_id = $1 and role = 'user' and status = 'received'
        `, [runId, status]);
        await client.query('commit');
      } catch (transactionError) {
        await client.query('rollback').catch(() => {});
        throw transactionError;
      } finally {
        client.release();
      }
      await this.recordUsageEvent(usageFromProviderMeta({ run: rowRun(run), providerMeta: error, status }));
      await this.recordAuditEvent({
        eventType: status === 'timed_out' ? 'teacher.run.timed_out' : 'teacher.run.failed',
        tenantId: run.tenant_id,
        userId: run.user_id,
        requestId: run.request_id,
        runId,
        status,
        metadata: {
          code: error?.code || 'TEACHER_RUN_FAILED',
          statusCode: error?.statusCode || error?.status || null,
          internalProviderDiagnostic: error?.internalProviderDiagnostic || null,
          providerTrace: error?.providerTrace || null
        }
      });
      return { runId };
    },
    async getRun(runId) {
      const run = await loadRun(pool, runId);
      return run ? runRow(run) : null;
    },
    async ensureTaskLifecycleContract(input = {}) {
      return ensurePostgresTaskLifecycleContract(pool, input);
    },
    async loadTaskLifecycleContract(runId) {
      return loadPostgresTaskLifecycleContract(pool, runId);
    },
    async loadLatestTaskLifecycleContractForThread(runId) {
      return loadLatestPostgresTaskLifecycleContractForThread(pool, runId);
    },
    async appendTaskLifecycleContractEvent(input = {}) {
      return appendPostgresTaskLifecycleContractEvent(pool, input);
    },
    async listTaskLifecycleContractEvents(runId) {
      return listPostgresTaskLifecycleContractEvents(pool, runId);
    },
    async appendExecutionCheckpoint({ runId, boundary }) {
      return appendPostgresExecutionCheckpoint(pool, { runId, boundary });
    },
    async loadLatestExecutionCheckpoint(runId, options = {}) {
      return loadLatestPostgresExecutionCheckpoint(pool, runId, options);
    },
    async listExecutionCheckpointTimeline(runId, options = {}) {
      return listPostgresExecutionCheckpointTimeline(pool, runId, options);
    },
    async findReusableValidationArtifact(input = {}) {
      return findPostgresReusableValidationArtifact(pool, input);
    },
    async getRunIntentAudit(runId) {
      const run = await loadRun(pool, runId);
      if (!run) return null;
      const received = await pool.query(`
        select content
        from teacher_messages
        where run_id = $1 and role = 'user'
        order by created_at asc
        limit 1
      `, [runId]);
      return intentAuditFromProviderMeta(run.provider_meta, received.rows[0]?.content);
    },
    async cancelRun({ runId, error }) {
      const run = await loadRun(pool, runId);
      if (!run) return null;
      if (run.status && run.status !== 'running') return runRow(run);
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`
          update teacher_runs
          set status = 'cancelled', error_code = $2, error_message = $3, updated_at = now()
          where run_id = $1 and status = 'running'
        `, [runId, error?.code || 'TEACHER_RUN_CANCELLED', safeErrorMessage(error || new Error('Teacher run cancelled'))]);
        await client.query(`
          update teacher_messages
          set status = 'cancelled'
          where run_id = $1 and role = 'user' and status = 'received'
        `, [runId]);
        await client.query('commit');
      } catch (transactionError) {
        await client.query('rollback').catch(() => {});
        throw transactionError;
      } finally {
        client.release();
      }
      await this.recordRunEvent({
        runId,
        eventType: 'cancelled',
        payload: {
          code: error?.code || 'TEACHER_RUN_CANCELLED',
          message: safeErrorMessage(error || new Error('Teacher run cancelled')),
          status: 499
        }
      });
      await this.recordAuditEvent({
        eventType: 'teacher.run.cancelled',
        tenantId: run.tenant_id,
        userId: run.user_id,
        requestId: run.request_id,
        runId,
        status: 'cancelled',
        metadata: { code: error?.code || 'TEACHER_RUN_CANCELLED' }
      });
      return { ...rowRun(run), status: 'cancelled' };
    },
    async recordRunEvent(event) {
      const runId = event.runId || '';
      if (!runId) return null;
      const next = await pool.query(`
        update teacher_runs
           set next_event_seq = next_event_seq + 1
         where run_id = $1
         returning next_event_seq
      `, [runId]);
      if (!next.rows[0]) throw new Error(`Unknown teacher run: ${runId}`);
      const seq = Number(next.rows[0].next_event_seq);
      const eventId = `event_${crypto.randomUUID()}`;
      const payload = sanitizeRunEventPayload(event.payload || {});
      await pool.query(`
        insert into teacher_run_events (event_id, run_id, seq, event_type, payload)
        values ($1, $2, $3, $4, $5::jsonb)
      `, [eventId, runId, seq, event.eventType || event.type || '', JSON.stringify(payload)]);
      return { eventId, runId, seq, eventType: event.eventType || event.type || '', payload, createdAt: new Date().toISOString() };
    },
    async listRunEvents(runId, options = {}) {
      const afterSeq = Math.max(0, Number(options.afterSeq || 0));
      const result = await pool.query(`
        select event_id, run_id, seq, event_type, payload, created_at
        from teacher_run_events
        where run_id = $1 and seq > $2
        order by seq asc
      `, [runId, afterSeq]);
      return result.rows.map(runEventRow);
    },
    async recordRunStep(step) {
      const safe = sanitizeRunStep(step);
      await pool.query(`
        insert into teacher_run_steps (run_id, step_type, status, metadata)
        values ($1, $2, $3, $4::jsonb)
      `, [safe.runId, safe.stepType, safe.status, JSON.stringify(safe.metadata)]);
    },
    async recordModelCallLedgerEntry(entry) {
      const safe = sanitizeModelCallLedgerEntry(entry);
      const result = await pool.query(`
        insert into teacher_model_call_ledger (
          run_id, call_id, phase, step_number, provider, model_id, prompt_version,
          status, parser_status, input_payload, output_payload, input_hash, output_hash,
          finish_reason, error_category, usage, started_at, completed_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13,
          $14, $15, $16::jsonb, $17, $18
        )
        on conflict (run_id, call_id, step_number) do update set
          phase = excluded.phase,
          provider = excluded.provider,
          model_id = excluded.model_id,
          prompt_version = excluded.prompt_version,
          status = excluded.status,
          parser_status = excluded.parser_status,
          input_payload = excluded.input_payload,
          output_payload = excluded.output_payload,
          input_hash = excluded.input_hash,
          output_hash = excluded.output_hash,
          finish_reason = excluded.finish_reason,
          error_category = excluded.error_category,
          usage = excluded.usage,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at
        returning *
      `, [
        safe.runId, safe.callId, safe.phase, safe.stepNumber, safe.provider, safe.modelId,
        safe.promptVersion, safe.status, safe.parserStatus, JSON.stringify(safe.inputPayload),
        JSON.stringify(safe.outputPayload), safe.inputHash, safe.outputHash, safe.finishReason,
        safe.errorCategory, JSON.stringify(safe.usage), safe.startedAt, safe.completedAt
      ]);
      return modelCallLedgerRow(result.rows[0]);
    },
    async listModelCallLedgerEntries(runId) {
      const result = await pool.query(`
        select * from teacher_model_call_ledger
        where run_id = $1
        order by started_at asc, step_number asc, call_id asc
      `, [runId]);
      return result.rows.map(modelCallLedgerRow);
    },
    async getToolLedgerEntry(runId, toolCallId) {
      const result = await pool.query(`
        select run_id, tool_call_id, tool_name, args_hash, status, result_hash, result_projection,
               canonical_args, result_payload, metrics,
               started_at, completed_at
          from teacher_tool_ledger
         where run_id = $1 and tool_call_id = $2
      `, [runId, toolCallId]);
      return result.rows[0] ? toolLedgerRow(result.rows[0]) : null;
    },
    async listToolLedgerEntries(runId, options = {}) {
      const values = [runId];
      const toolFilter = options.toolName ? ' and tool_name = $2' : '';
      if (options.toolName) values.push(String(options.toolName));
      const result = await pool.query(`
        select run_id, tool_call_id, tool_name, args_hash, status, result_hash, result_projection,
               canonical_args, result_payload, metrics, started_at, completed_at
          from teacher_tool_ledger
         where run_id = $1${toolFilter}
         order by started_at asc nulls last, tool_call_id asc
      `, values);
      return result.rows.map(toolLedgerRow);
    },
    async recordToolLedgerEntry(entry) {
      const safe = sanitizeToolLedgerEntry(entry);
      const existing = await this.getToolLedgerEntry(safe.runId, safe.toolCallId);
      if (existing && existing.argsHash !== safe.argsHash) throw toolReplayMismatchError();
      if (existing && existing.status !== 'started' && safe.status === 'started') return existing;
      const result = await pool.query(`
        insert into teacher_tool_ledger (
          run_id, tool_call_id, tool_name, args_hash, status, result_hash, result_projection,
          canonical_args, result_payload, metrics, started_at, completed_at
        ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12)
        on conflict (run_id, tool_call_id) do update
          set tool_name = excluded.tool_name,
              status = excluded.status,
              result_hash = excluded.result_hash,
              result_projection = excluded.result_projection,
              canonical_args = excluded.canonical_args,
              result_payload = excluded.result_payload,
              metrics = excluded.metrics,
              completed_at = excluded.completed_at
          where teacher_tool_ledger.args_hash = excluded.args_hash
        returning run_id, tool_call_id, tool_name, args_hash, status, result_hash, result_projection,
                  canonical_args, result_payload, metrics, started_at, completed_at
      `, [
        safe.runId,
        safe.toolCallId,
        safe.toolName,
        safe.argsHash,
        safe.status,
        safe.resultHash,
        JSON.stringify(safe.resultProjection),
        JSON.stringify(safe.canonicalArgs),
        JSON.stringify(safe.resultPayload),
        JSON.stringify(safe.metrics),
        safe.startedAt,
        safe.completedAt
      ]);
      if (!result.rows[0]) throw toolReplayMismatchError();
      return toolLedgerRow(result.rows[0]);
    },
    async loadProjectModelingState(threadId, goalContractHash) {
      let planResult = await pool.query(`
        select plan
        from teacher_model_project_plans
        where thread_id = $1 and goal_contract_hash = $2
        order by updated_at desc
        limit 1
      `, [String(threadId || ''), String(goalContractHash || '')]);
      if (!planResult.rows[0]?.plan) {
        planResult = await pool.query(`
          select plan
          from teacher_model_project_plans
          where thread_id = $1 and status = 'active'
          order by updated_at desc
          limit 1
        `, [String(threadId || '')]);
      }
      const plan = planResult.rows[0]?.plan;
      if (!plan) return null;
      const checkpointsResult = await pool.query(`
        select checkpoint
        from teacher_module_checkpoints
        where project_id = $1
        order by created_at asc, checkpoint_id asc
        limit 20
      `, [String(plan.projectId || '')]);
      return cloneBoundedProjectPayload({
        plan,
        checkpoints: checkpointsResult.rows.map((row) => row.checkpoint),
      });
    },
    async saveModelProjectPlan({ threadId, runId, plan }) {
      const safe = cloneBoundedProjectPayload(plan);
      await pool.query(`
        insert into teacher_model_project_plans (
          project_id, thread_id, goal_contract_hash, status, revision, latest_run_id, plan, created_at, updated_at
        ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $9::timestamptz)
        on conflict (project_id) do update
          set status = excluded.status,
              revision = excluded.revision,
              latest_run_id = excluded.latest_run_id,
              plan = excluded.plan,
              updated_at = excluded.updated_at
      `, [
        safe.projectId,
        String(threadId || ''),
        safe.goalContractHash,
        safe.status,
        safe.revision,
        String(runId || ''),
        JSON.stringify(safe),
        safe.createdAt,
        safe.updatedAt,
      ]);
      return safe;
    },
    async saveModuleCheckpoint({ threadId, runId, checkpoint }) {
      const safe = cloneBoundedProjectPayload(checkpoint);
      await pool.query(`
        insert into teacher_module_checkpoints (
          checkpoint_id, project_id, thread_id, run_id, milestone_id, layer_ids,
          artifact_hash, checkpoint, created_at
        ) values ($1, $2, $3, $4, $5, $6::text[], $7, $8::jsonb, $9::timestamptz)
        on conflict (checkpoint_id) do update
          set checkpoint = excluded.checkpoint,
              artifact_hash = excluded.artifact_hash
      `, [
        safe.checkpointId,
        safe.projectId,
        String(threadId || ''),
        String(runId || ''),
        safe.milestoneId,
        safe.layerIds,
        safe.candidateWorkspaceHash,
        JSON.stringify(safe),
        safe.createdAt,
      ]);
      return safe;
    },
    async recordMessageFeedback({ messageId, context, outcome, reasonCodes, judgeVersion, judgeLabel }) {
      const result = await pool.query(`
        select m.message_id, r.run_id, r.request_id, r.tenant_id, r.user_id
        from teacher_messages m
        join teacher_runs r on r.run_id = m.run_id
        where m.message_id = $1 and m.role = 'assistant' and r.tenant_id = $2 and r.user_id = $3
        limit 1
      `, [messageId, tenantId(context), userId(context)]);
      const row = result.rows[0];
      if (!row) return null;
      const feedback = {
        messageId,
        outcome,
        reasonCodes,
        judgeVersion,
        judgeLabel,
        updatedAt: new Date().toISOString()
      };
      await this.recordAuditEvent({
        eventType: 'teacher.message.feedback',
        tenantId: row.tenant_id,
        userId: row.user_id,
        requestId: row.request_id,
        runId: row.run_id,
        status: outcome,
        metadata: feedback
      });
      return feedback;
    },
    async recordUsageEvent(event) {
      if (!event) return;
      await pool.query(`
        insert into ai_usage_ledger (
          ledger_id, tenant_id, user_id, request_id, run_id, provider, model, intent,
          prompt_tokens, completion_tokens, reasoning_tokens, total_tokens, estimated_cost, status, metadata
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
      `, [
        `usage_${crypto.randomUUID()}`,
        event.tenantId,
        event.userId,
        event.requestId,
        event.runId,
        event.provider || '',
        event.model || '',
        event.intent || '',
        event.promptTokens,
        event.completionTokens,
        event.reasoningTokens,
        event.totalTokens,
        event.estimatedCost || 0,
        event.status,
        JSON.stringify(redactMetadata(event.metadata || {}))
      ]);
    },
    async dailyUsageTokens(tenantIdValue, userIdValue) {
      const result = await pool.query(`
        select coalesce(sum(total_tokens), 0)::int as total_tokens
        from ai_usage_ledger
        where tenant_id = $1 and user_id = $2 and created_at >= date_trunc('day', now())
      `, [tenantIdValue, userIdValue]);
      return Number(result.rows[0]?.total_tokens || 0);
    },
    async getFailureObservability(options = {}) {
      const normalized = failureObservabilityOptions({
        ...options,
        observationEnabled: process.env.AI_TEACHER_AUDIT_ENABLED !== 'false'
      });
      if (!normalized.observationEnabled) return failureObservabilitySnapshot([], normalized);
      const eventTypes = [...TERMINAL_AUDIT_EVENT_TYPES];
      const result = await pool.query(`
        select audit_id, event_type, tenant_id, request_id, run_id, status, metadata, created_at
        from ai_teacher_audit_events
        where created_at >= now() - ($1 * interval '1 hour')
          and event_type = any($2::text[])
          and ($3 = '' or tenant_id = $3)
        order by created_at desc
        limit 5000
      `, [normalized.windowHours, eventTypes, normalized.tenantId]);
      return failureObservabilitySnapshot(result.rows.map(auditEventRow), normalized);
    },
    async recordAuditEvent(event) {
      if (process.env.AI_TEACHER_AUDIT_ENABLED === 'false') return;
      const safe = redactAuditEvent(event);
      await pool.query(`
        insert into ai_teacher_audit_events (
          audit_id, event_type, tenant_id, user_id, request_id, run_id, status, metadata
        ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `, [
        `audit_${crypto.randomUUID()}`,
        safe.eventType || safe.event_type || '',
        safe.tenantId || '',
        safe.userId || '',
        safe.requestId || '',
        safe.runId || '',
        safe.status || '',
        JSON.stringify(safe.metadata || {})
      ]);
    },
    async close() {
      if (ownedPool) await pool.end();
    }
  };
}

async function migrateTeacherConversationStore(options = {}) {
  const pool = options.pool || createPool(options);
  try {
    await pool.query(`
      create table if not exists teacher_threads (
        thread_id text primary key,
        tenant_id text not null,
        user_id text not null default '',
        course_pack_id text not null default '',
        course_id text not null default '',
        lesson_id text not null default '',
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await pool.query(`alter table teacher_threads add column if not exists course_id text not null default ''`);
    await pool.query(`create index if not exists teacher_threads_tenant_user_idx on teacher_threads (tenant_id, user_id, updated_at desc)`);
    await pool.query(`create index if not exists teacher_threads_context_idx on teacher_threads (tenant_id, user_id, course_pack_id, course_id, lesson_id, updated_at desc)`);
    await pool.query(`
      create table if not exists teacher_runs (
        run_id text primary key,
        thread_id text not null references teacher_threads(thread_id) on delete cascade,
        request_id text not null default '',
        tenant_id text not null,
        user_id text not null default '',
        intent text not null default '',
        route text not null default '',
        status text not null,
        message_id text not null default '',
        error_code text not null default '',
        error_message text not null default '',
        provider_meta jsonb not null default '{}'::jsonb,
        metadata jsonb not null default '{}'::jsonb,
        next_event_seq int not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await pool.query(`alter table teacher_runs add column if not exists next_event_seq int not null default 0`);
    await pool.query(`create index if not exists teacher_runs_thread_created_idx on teacher_runs (thread_id, created_at desc)`);
    await pool.query(`create index if not exists teacher_runs_tenant_status_idx on teacher_runs (tenant_id, status, created_at desc)`);
    await pool.query(`
      create table if not exists teacher_execution_lineages (
        root_run_id text primary key references teacher_runs(run_id) on delete cascade,
        thread_id text not null references teacher_threads(thread_id) on delete cascade,
        tenant_id text not null,
        user_id text not null default '',
        automatic_continuation_count smallint not null default 0,
        automatic_continuation_run_id text references teacher_runs(run_id) on delete set null,
        next_checkpoint_revision int not null default 1,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        check (automatic_continuation_count between 0 and 1),
        check (next_checkpoint_revision >= 1)
      )
    `);
    await pool.query(`alter table teacher_execution_lineages add column if not exists automatic_continuation_count smallint not null default 0`);
    await pool.query(`alter table teacher_execution_lineages add column if not exists automatic_continuation_run_id text references teacher_runs(run_id) on delete set null`);
    await pool.query(`alter table teacher_execution_lineages add column if not exists next_checkpoint_revision int not null default 1`);
    await pool.query(`create index if not exists teacher_execution_lineages_owner_idx on teacher_execution_lineages (tenant_id, user_id, updated_at desc)`);
    await pool.query(`
      create table if not exists teacher_task_lifecycle_contracts (
        contract_id text primary key,
        root_run_id text not null unique references teacher_execution_lineages(root_run_id) on delete cascade,
        thread_id text not null references teacher_threads(thread_id) on delete cascade,
        tenant_id text not null,
        user_id text not null default '',
        revision int not null default 0,
        status text not null,
        snapshot_hash text not null,
        current_snapshot jsonb not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        check (revision >= 0),
        check (status in (
          'provisional', 'active', 'waiting_user', 'executing',
          'sealed_for_finalization', 'finalizing', 'delivery_pending',
          'delivered', 'cancelled', 'superseded'
        ))
      )
    `);
    await pool.query(`create index if not exists teacher_task_lifecycle_contracts_owner_idx on teacher_task_lifecycle_contracts (tenant_id, user_id, updated_at desc)`);
    await pool.query(`create index if not exists teacher_task_lifecycle_contracts_thread_owner_idx on teacher_task_lifecycle_contracts (thread_id, tenant_id, user_id, updated_at desc)`);
    await pool.query(`
      create table if not exists teacher_task_lifecycle_contract_events (
        event_id text primary key,
        contract_id text not null references teacher_task_lifecycle_contracts(contract_id) on delete cascade,
        root_run_id text not null references teacher_execution_lineages(root_run_id) on delete cascade,
        revision int not null,
        event_type text not null,
        source_run_id text references teacher_runs(run_id) on delete set null,
        actor jsonb not null default '{}'::jsonb,
        payload jsonb not null default '{}'::jsonb,
        resulting_status text not null,
        resulting_snapshot_hash text not null,
        created_at timestamptz not null,
        unique (contract_id, revision),
        check (revision >= 0)
      )
    `);
    await pool.query(`create index if not exists teacher_task_lifecycle_contract_events_root_revision_idx on teacher_task_lifecycle_contract_events (root_run_id, revision asc)`);
    await pool.query(`
      insert into teacher_execution_lineages (
        root_run_id, thread_id, tenant_id, user_id, automatic_continuation_count,
        next_checkpoint_revision, created_at, updated_at
      )
      select r.run_id, r.thread_id, r.tenant_id, r.user_id, 0, 1, r.created_at, r.updated_at
      from teacher_runs r
      where coalesce(r.metadata ->> 'continuationRootRunId', '') in ('', r.run_id)
        and coalesce(r.metadata ->> 'automaticContinuationSourceRunId', '') = ''
        and coalesce(r.metadata ->> 'sourceRunId', '') = ''
      on conflict (root_run_id) do nothing
    `);
    await pool.query(`
      update teacher_execution_lineages lineage
      set automatic_continuation_count = 1,
          automatic_continuation_run_id = child.run_id,
          updated_at = greatest(lineage.updated_at, child.updated_at)
      from (
        select distinct on (metadata ->> 'automaticContinuationSourceRunId')
          run_id, updated_at, metadata ->> 'automaticContinuationSourceRunId' as source_run_id
        from teacher_runs
        where coalesce(metadata ->> 'automaticContinuationSourceRunId', '') <> ''
        order by metadata ->> 'automaticContinuationSourceRunId', created_at asc
      ) child
      where child.source_run_id = lineage.root_run_id
        and lineage.automatic_continuation_count = 0
    `);
    await pool.query(`
      create table if not exists teacher_execution_artifacts (
        artifact_id text primary key,
        root_run_id text not null references teacher_execution_lineages(root_run_id) on delete cascade,
        source_run_id text references teacher_runs(run_id) on delete set null,
        artifact_kind text not null,
        artifact_hash text not null,
        candidate_artifact_hash text not null default '',
        candidate_workspace_hash text not null default '',
        validator_version text not null default '',
        ruleset_version text not null default '',
        validation_options_hash text not null default '',
        validation_reuse_key text not null default '',
        payload jsonb not null,
        created_at timestamptz not null default now(),
        unique (root_run_id, artifact_kind, artifact_hash),
        check (artifact_kind in ('candidate', 'validation'))
      )
    `);
    await pool.query(`alter table teacher_execution_artifacts add column if not exists candidate_artifact_hash text not null default ''`);
    await pool.query(`alter table teacher_execution_artifacts add column if not exists candidate_workspace_hash text not null default ''`);
    await pool.query(`alter table teacher_execution_artifacts add column if not exists validator_version text not null default ''`);
    await pool.query(`alter table teacher_execution_artifacts add column if not exists ruleset_version text not null default ''`);
    await pool.query(`alter table teacher_execution_artifacts add column if not exists validation_options_hash text not null default ''`);
    await pool.query(`alter table teacher_execution_artifacts add column if not exists validation_reuse_key text not null default ''`);
    await pool.query(`create index if not exists teacher_execution_artifacts_root_created_idx on teacher_execution_artifacts (root_run_id, created_at asc)`);
    await pool.query(`create index if not exists teacher_execution_validation_reuse_idx on teacher_execution_artifacts (root_run_id, validation_reuse_key) where artifact_kind = 'validation' and validation_reuse_key <> ''`);
    await pool.query(`
      create table if not exists teacher_execution_checkpoints (
        checkpoint_id text primary key,
        root_run_id text not null references teacher_execution_lineages(root_run_id) on delete cascade,
        run_id text references teacher_runs(run_id) on delete set null,
        revision int not null,
        phase text not null,
        candidate_artifact_id text references teacher_execution_artifacts(artifact_id) on delete cascade,
        validation_artifact_id text references teacher_execution_artifacts(artifact_id) on delete cascade,
        request_revision_hash text not null default '',
        task_contract_hash text not null default '',
        editor_base_hash text not null default '',
        validator_version text not null default '',
        ruleset_version text not null default '',
        validation_options_hash text not null default '',
        repair_round int not null default 0,
        repair_state jsonb not null default '{}'::jsonb,
        knowledge_cursor jsonb not null default '{}'::jsonb,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        unique (root_run_id, revision),
        check (revision >= 1),
        check (repair_round >= 0),
        check (phase in (${executionCheckpointPhaseSqlList()}))
      )
    `);
    await pool.query(executionCheckpointPhaseConstraintSql());
    await pool.query(`alter table teacher_execution_checkpoints add column if not exists request_revision_hash text not null default ''`);
    await pool.query(`alter table teacher_execution_checkpoints add column if not exists task_contract_hash text not null default ''`);
    await pool.query(`alter table teacher_execution_checkpoints add column if not exists editor_base_hash text not null default ''`);
    await pool.query(`alter table teacher_execution_checkpoints add column if not exists validation_options_hash text not null default ''`);
    await pool.query(`create index if not exists teacher_execution_checkpoints_root_revision_idx on teacher_execution_checkpoints (root_run_id, revision desc)`);
    await pool.query(`
      update teacher_execution_lineages lineage
      set next_checkpoint_revision = greatest(lineage.next_checkpoint_revision, latest.next_revision)
      from (
        select root_run_id, max(revision) + 1 as next_revision
        from teacher_execution_checkpoints
        group by root_run_id
      ) latest
      where latest.root_run_id = lineage.root_run_id
    `);
    await pool.query(`
      create table if not exists teacher_clarification_checkpoints (
        checkpoint_id text primary key,
        source_run_id text not null unique references teacher_runs(run_id) on delete cascade,
        thread_id text not null references teacher_threads(thread_id) on delete cascade,
        tenant_id text not null,
        user_id text not null default '',
        accepted_tool_call_id text not null,
        question text not null,
        state text not null,
        created_at timestamptz not null,
        expires_at timestamptz not null,
        resume_request_id text not null default '',
        response_message_id text not null default '',
        resumed_run_id text unique references teacher_runs(run_id) on delete set null,
        resolved_at timestamptz
      )
    `);
    await pool.query(`create index if not exists teacher_clarification_checkpoint_owner_idx on teacher_clarification_checkpoints (tenant_id, user_id, thread_id, state)`);
    await pool.query(`
      create table if not exists teacher_messages (
        message_id text primary key,
        thread_id text not null references teacher_threads(thread_id) on delete cascade,
        run_id text not null references teacher_runs(run_id) on delete cascade,
        role text not null,
        status text not null,
        content text not null default '',
        response jsonb,
        request_id text not null default '',
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      )
    `);
    await pool.query(`create index if not exists teacher_messages_thread_created_idx on teacher_messages (thread_id, created_at desc)`);
    await pool.query(`
      create table if not exists teacher_run_events (
        event_id text primary key,
        run_id text not null references teacher_runs(run_id) on delete cascade,
        seq int not null,
        event_type text not null,
        payload jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        unique(run_id, seq)
      )
    `);
    await pool.query(`create index if not exists teacher_run_events_run_seq_idx on teacher_run_events (run_id, seq)`);
    await pool.query(`
      create table if not exists teacher_run_steps (
        step_id bigserial primary key,
        run_id text not null references teacher_runs(run_id) on delete cascade,
        step_type text not null,
        status text not null default '',
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      )
    `);
    await pool.query(`
      create table if not exists teacher_model_call_ledger (
        run_id text not null references teacher_runs(run_id) on delete cascade,
        call_id text not null,
        phase text not null,
        step_number int not null,
        provider text not null default '',
        model_id text not null default '',
        prompt_version text not null default '',
        status text not null,
        parser_status text not null,
        input_payload jsonb not null default '{}'::jsonb,
        output_payload jsonb not null default '{}'::jsonb,
        input_hash text not null,
        output_hash text not null,
        finish_reason text not null default '',
        error_category text not null default '',
        usage jsonb not null default '{}'::jsonb,
        started_at timestamptz not null,
        completed_at timestamptz not null,
        primary key (run_id, call_id, step_number)
      )
    `);
    await pool.query(`create index if not exists teacher_model_call_ledger_run_started_idx on teacher_model_call_ledger (run_id, started_at asc, step_number asc)`);
    await pool.query(`create index if not exists teacher_model_call_ledger_phase_idx on teacher_model_call_ledger (phase, started_at desc)`);
    await pool.query(`
      create table if not exists teacher_tool_ledger (
        run_id text not null references teacher_runs(run_id) on delete cascade,
        tool_call_id text not null,
        tool_name text not null,
        args_hash text not null,
        status text not null,
        result_hash text not null default '',
        result_projection jsonb not null default '{}'::jsonb,
        canonical_args jsonb not null default '{}'::jsonb,
        result_payload jsonb not null default '{}'::jsonb,
        metrics jsonb not null default '{}'::jsonb,
        started_at timestamptz,
        completed_at timestamptz,
        primary key (run_id, tool_call_id)
      )
    `);
    await pool.query(`alter table teacher_tool_ledger add column if not exists canonical_args jsonb not null default '{}'::jsonb`);
    await pool.query(`alter table teacher_tool_ledger add column if not exists result_payload jsonb not null default '{}'::jsonb`);
    await pool.query(`alter table teacher_tool_ledger add column if not exists metrics jsonb not null default '{}'::jsonb`);
    await pool.query(`
      create table if not exists teacher_model_project_plans (
        project_id text primary key,
        thread_id text not null references teacher_threads(thread_id) on delete cascade,
        goal_contract_hash text not null,
        status text not null,
        revision int not null,
        latest_run_id text not null default '',
        plan jsonb not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        unique(thread_id, goal_contract_hash)
      )
    `);
    await pool.query(`create index if not exists teacher_model_project_plans_thread_updated_idx on teacher_model_project_plans (thread_id, updated_at desc)`);
    await pool.query(`
      create table if not exists teacher_module_checkpoints (
        checkpoint_id text primary key,
        project_id text not null references teacher_model_project_plans(project_id) on delete cascade,
        thread_id text not null references teacher_threads(thread_id) on delete cascade,
        run_id text not null references teacher_runs(run_id) on delete cascade,
        milestone_id text not null,
        layer_ids text[] not null default '{}',
        artifact_hash text not null,
        checkpoint jsonb not null,
        created_at timestamptz not null
      )
    `);
    await pool.query(`create index if not exists teacher_module_checkpoints_project_created_idx on teacher_module_checkpoints (project_id, created_at asc)`);
    await pool.query(`
      create table if not exists teacher_thread_summaries (
        thread_id text primary key references teacher_threads(thread_id) on delete cascade,
        summary text not null default '',
        summary_hash text not null default '',
        updated_at timestamptz not null default now()
      )
    `);
    await pool.query(`
      create table if not exists ai_usage_ledger (
        ledger_id text primary key,
        tenant_id text not null,
        user_id text not null default '',
        request_id text not null default '',
        run_id text not null default '',
        provider text not null default '',
        model text not null default '',
        intent text not null default '',
        prompt_tokens int not null default 0,
        completion_tokens int not null default 0,
        reasoning_tokens int not null default 0,
        total_tokens int not null default 0,
        estimated_cost numeric not null default 0,
        status text not null,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      )
    `);
    await pool.query(`create index if not exists ai_usage_ledger_tenant_user_created_idx on ai_usage_ledger (tenant_id, user_id, created_at desc)`);
    await pool.query(`
      create table if not exists ai_teacher_audit_events (
        audit_id text primary key,
        event_type text not null,
        tenant_id text not null default '',
        user_id text not null default '',
        request_id text not null default '',
        run_id text not null default '',
        status text not null default '',
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      )
    `);
    await pool.query(`create index if not exists ai_teacher_audit_events_tenant_created_idx on ai_teacher_audit_events (tenant_id, created_at desc)`);
  } finally {
    if (!options.pool) await pool.end();
  }
}

function memoryExecutionRootRunId(state, run) {
  if (!run) return '';
  let current = run;
  const visited = new Set();
  for (let depth = 0; depth < 16 && current; depth += 1) {
    if (visited.has(current.runId)) break;
    visited.add(current.runId);
    const declaredRoot = safeId(current.metadata?.continuationRootRunId);
    if (declaredRoot && state.runs.has(declaredRoot)) return declaredRoot;
    const parentRunId = safeId(
      current.metadata?.automaticContinuationSourceRunId || current.metadata?.sourceRunId
    );
    if (!parentRunId) return current.runId;
    current = state.runs.get(parentRunId);
  }
  return current?.runId || run.runId;
}

function ensureMemoryExecutionLineage(state, run, requestedRootRunId = '') {
  if (!run) throw checkpointError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found.', 404);
  const rootRunId = safeId(requestedRootRunId) || memoryExecutionRootRunId(state, run);
  const rootRun = state.runs.get(rootRunId) || run;
  let lineage = state.executionLineages.get(rootRunId);
  if (!lineage) {
    const legacyContinuationRunId = state.automaticContinuations.get(rootRunId)
      || [...state.runs.values()].find((candidate) => (
        candidate.metadata?.automaticContinuationSourceRunId === rootRunId
      ))?.runId
      || '';
    const now = new Date().toISOString();
    lineage = {
      rootRunId,
      threadId: rootRun.threadId,
      tenantId: rootRun.tenantId,
      userId: rootRun.userId,
      automaticContinuationCount: legacyContinuationRunId ? 1 : 0,
      automaticContinuationRunId: legacyContinuationRunId,
      nextCheckpointRevision: 1,
      createdAt: rootRun.createdAt || now,
      updatedAt: rootRun.updatedAt || now
    };
    state.executionLineages.set(rootRunId, lineage);
  }
  return lineage;
}

function appendMemoryExecutionCheckpoint(state, input) {
  try {
    const run = state.runs.get(safeId(input.runId));
    if (!run) throw checkpointError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found.', 404);
    let boundary = normalizeExecutionBoundary(input.boundary);
    const rootRunId = memoryExecutionRootRunId(state, run);
    const lineage = ensureMemoryExecutionLineage(state, run, rootRunId);
    boundary = inheritMemoryEngineeringBaselineReferences(state, rootRunId, boundary);
    const candidateArtifact = prepareMemoryExecutionArtifact(state, createArtifactRecord({
      rootRunId,
      sourceRunId: run.runId,
      artifact: boundary.candidate
    }));
    const candidateArtifactId = resolveExecutionArtifactId(
      boundary.candidateArtifactId,
      candidateArtifact,
      'candidate'
    );
    const resolvedCandidate = candidateArtifact
      || loadMemoryExecutionArtifact(state, rootRunId, candidateArtifactId, 'candidate');
    const validationArtifact = prepareMemoryExecutionArtifact(state, createArtifactRecord({
      rootRunId,
      sourceRunId: run.runId,
      artifact: bindValidationArtifactCandidate(boundary.validation, resolvedCandidate)
    }));
    const validationArtifactId = resolveExecutionArtifactId(
      boundary.validationArtifactId,
      validationArtifact,
      'validation'
    );
    const resolvedValidation = validationArtifact
      || loadMemoryExecutionArtifact(state, rootRunId, validationArtifactId, 'validation');
    assertExecutionArtifactPair(resolvedCandidate, resolvedValidation);
    const checkpointBoundary = bindServerOwnedEngineeringBaselineReferences(
      bindExecutionBoundaryValidationMetadata(boundary, resolvedValidation),
      resolvedCandidate,
      resolvedValidation
    );
    const revision = lineage.nextCheckpointRevision;
    const checkpoint = checkpointRecord({
      checkpointId: newCheckpointId(),
      rootRunId,
      runId: run.runId,
      revision,
      boundary: checkpointBoundary,
      candidateArtifactId,
      validationArtifactId
    });
    commitMemoryExecutionArtifact(state, candidateArtifact);
    commitMemoryExecutionArtifact(state, validationArtifact);
    lineage.nextCheckpointRevision += 1;
    lineage.updatedAt = checkpoint.createdAt;
    const timeline = state.executionCheckpoints.get(rootRunId) || [];
    timeline.push(checkpoint);
    state.executionCheckpoints.set(rootRunId, timeline);
    return hydrateExecutionCheckpoint(
      checkpoint,
      resolvedCandidate,
      resolvedValidation,
      undefined,
      '',
      resolveMemoryEngineeringBaseline(state, rootRunId, checkpoint, [resolvedCandidate, resolvedValidation])
    );
  } catch (error) {
    throw stableExecutionRepositoryError(error, 'EXECUTION_CHECKPOINT_PERSIST_FAILED');
  }
}

function loadLatestMemoryExecutionCheckpoint(state, runId, options = {}) {
  try {
    const run = state.runs.get(safeId(runId));
    if (!run) throw checkpointError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found.', 404);
    const rootRunId = memoryExecutionRootRunId(state, run);
    ensureMemoryExecutionLineage(state, run, rootRunId);
    const checkpoint = (state.executionCheckpoints.get(rootRunId) || []).slice(-1)[0];
    if (!checkpoint) return null;
    const persistedAnswer = checkpoint.phase === 'completed'
      ? memoryPersistedAnswer(state, checkpoint.runId)
      : '';
    return hydrateExecutionCheckpoint(
      checkpoint,
      loadMemoryExecutionArtifact(state, rootRunId, checkpoint.candidateArtifactId, 'candidate'),
      loadMemoryExecutionArtifact(state, rootRunId, checkpoint.validationArtifactId, 'validation'),
      options.currentHashes,
      persistedAnswer,
      resolveMemoryEngineeringBaseline(state, rootRunId, checkpoint)
    );
  } catch (error) {
    throw stableExecutionRepositoryError(error, 'EXECUTION_CHECKPOINT_LOAD_FAILED');
  }
}

function listMemoryExecutionCheckpointTimeline(state, runId, options = {}) {
  try {
    const run = state.runs.get(safeId(runId));
    if (!run) throw checkpointError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found.', 404);
    const rootRunId = memoryExecutionRootRunId(state, run);
    ensureMemoryExecutionLineage(state, run, rootRunId);
    const limit = timelineLimit(options.limit);
    return (state.executionCheckpoints.get(rootRunId) || [])
      .slice(-limit)
      .map((checkpoint) => checkpointTimelineEntry(checkpoint, options.currentHashes));
  } catch (error) {
    throw stableExecutionRepositoryError(error, 'EXECUTION_CHECKPOINT_LOAD_FAILED');
  }
}

function findMemoryReusableValidationArtifact(state, input) {
  try {
    const run = state.runs.get(safeId(input.runId));
    if (!run) throw checkpointError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found.', 404);
    const rootRunId = memoryExecutionRootRunId(state, run);
    const reuseKey = requiredValidationReuseKey(input);
    return [...state.executionArtifacts.values()]
      .filter((artifact) => artifact.rootRunId === rootRunId
        && artifact.artifactKind === 'validation'
        && artifact.validationReuseKey === reuseKey)
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0]
      || null;
  } catch (error) {
    throw stableExecutionRepositoryError(error, 'EXECUTION_ARTIFACT_LOAD_FAILED');
  }
}

function prepareMemoryExecutionArtifact(state, artifact) {
  if (!artifact) return null;
  assertValidationArtifactReuseFields(artifact);
  const existing = state.executionArtifacts.get(artifact.artifactId);
  if (existing) {
    assertSameExecutionArtifact(existing, artifact);
    return existing;
  }
  return Object.freeze({ ...artifact, createdAt: new Date().toISOString() });
}

function commitMemoryExecutionArtifact(state, artifact) {
  if (artifact && !state.executionArtifacts.has(artifact.artifactId)) {
    state.executionArtifacts.set(artifact.artifactId, artifact);
  }
}

function loadMemoryExecutionArtifact(state, rootRunId, artifactId, expectedKind) {
  if (!artifactId) return null;
  const artifact = state.executionArtifacts.get(artifactId);
  assertExecutionArtifactScope(artifact, rootRunId, expectedKind);
  return artifact;
}

function memoryPersistedAnswer(state, runId) {
  const run = state.runs.get(runId);
  if (!run) return '';
  const message = [...(state.messages.get(run.threadId) || [])].reverse().find((entry) => (
    entry.runId === runId && entry.role === 'assistant' && entry.status === 'succeeded'
  ));
  return projectPersistedAnswer(message?.response);
}

function ensureMemoryTaskLifecycleContract(state, input = {}) {
  const run = state.runs.get(safeId(input.runId));
  if (!run) throw taskLifecycleStoreError('TASK_CONTRACT_RUN_NOT_FOUND', 'Task contract run was not found.', 404);
  const rootRunId = memoryExecutionRootRunId(state, run);
  ensureMemoryExecutionLineage(state, run, rootRunId);
  const existing = state.taskLifecycleContracts.get(rootRunId);
  if (existing) return structuredClone(existing);
  const rootRun = state.runs.get(rootRunId) || run;
  const rootUserRequest = String(input.rootUserRequest || memoryRootUserRequest(state, rootRun)).trim();
  if (!rootUserRequest) {
    throw taskLifecycleStoreError('TASK_CONTRACT_ROOT_REQUEST_MISSING', 'Task contract root user request was not found.', 409);
  }
  const contract = createTaskLifecycleContract({
    contractId: taskLifecycleContractId(rootRunId),
    rootRunId,
    threadId: rootRun.threadId,
    tenantId: rootRun.tenantId,
    userId: rootRun.userId,
    rootUserRequest,
    taskProfile: input.taskProfile,
    objectiveSummary: input.objectiveSummary,
    preservationConstraints: input.preservationConstraints,
    createdAt: rootRun.createdAt
  });
  state.taskLifecycleContracts.set(rootRunId, structuredClone(contract));
  state.taskLifecycleContractEvents.set(rootRunId, [taskLifecycleCreationEvent(contract, run.runId)]);
  return structuredClone(contract);
}

function loadMemoryTaskLifecycleContract(state, runId) {
  const run = state.runs.get(safeId(runId));
  if (!run) return null;
  const contract = state.taskLifecycleContracts.get(memoryExecutionRootRunId(state, run));
  return contract ? structuredClone(contract) : null;
}

function loadLatestMemoryTaskLifecycleContractForThread(state, runId) {
  const run = state.runs.get(safeId(runId));
  if (!run) return null;
  const currentRootRunId = memoryExecutionRootRunId(state, run);
  const contract = [...state.taskLifecycleContracts.entries()]
    .filter(([rootRunId, candidate]) => rootRunId !== currentRootRunId
      && candidate.threadId === run.threadId
      && candidate.tenantId === run.tenantId
      && candidate.userId === run.userId)
    .map(([, candidate]) => candidate)
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0];
  return contract ? structuredClone(contract) : null;
}

function appendMemoryTaskLifecycleContractEvent(state, input = {}) {
  const run = state.runs.get(safeId(input.runId));
  if (!run) throw taskLifecycleStoreError('TASK_CONTRACT_RUN_NOT_FOUND', 'Task contract run was not found.', 404);
  const rootRunId = memoryExecutionRootRunId(state, run);
  const current = state.taskLifecycleContracts.get(rootRunId);
  if (!current) throw taskLifecycleStoreError('TASK_CONTRACT_NOT_FOUND', 'Task lifecycle contract was not found.', 404);
  const transition = applyTaskLifecycleContractEvent(current, {
    expectedRevision: input.expectedRevision,
    eventType: input.eventType,
    payload: input.payload,
    actor: input.actor,
    sourceRunId: run.runId,
    eventId: input.eventId,
    createdAt: input.createdAt
  });
  state.taskLifecycleContracts.set(rootRunId, structuredClone(transition.contract));
  const events = state.taskLifecycleContractEvents.get(rootRunId) || [];
  events.push(structuredClone(transition.event));
  state.taskLifecycleContractEvents.set(rootRunId, events);
  return { contract: structuredClone(transition.contract), event: structuredClone(transition.event) };
}

function listMemoryTaskLifecycleContractEvents(state, runId) {
  const run = state.runs.get(safeId(runId));
  if (!run) return [];
  const rootRunId = memoryExecutionRootRunId(state, run);
  return structuredClone(state.taskLifecycleContractEvents.get(rootRunId) || []);
}

function memoryRootUserRequest(state, rootRun) {
  return (state.messages.get(rootRun.threadId) || []).find((message) => (
    message.runId === rootRun.runId && message.role === 'user'
  ))?.content || '';
}

async function ensurePostgresExecutionLineage(client, runId, suppliedRun) {
  let current = suppliedRun || (await client.query('select * from teacher_runs where run_id = $1', [runId])).rows[0];
  if (!current) throw checkpointError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found.', 404);
  const visited = new Set();
  let root = current;
  for (let depth = 0; depth < 16 && current; depth += 1) {
    if (visited.has(current.run_id)) break;
    visited.add(current.run_id);
    const declaredRootRunId = safeId(current.metadata?.continuationRootRunId);
    if (declaredRootRunId) {
      const declared = await client.query('select * from teacher_runs where run_id = $1', [declaredRootRunId]);
      if (declared.rows[0]) root = declared.rows[0];
      break;
    }
    const parentRunId = safeId(
      current.metadata?.automaticContinuationSourceRunId || current.metadata?.sourceRunId
    );
    if (!parentRunId) {
      root = current;
      break;
    }
    const parent = await client.query('select * from teacher_runs where run_id = $1', [parentRunId]);
    if (!parent.rows[0]) break;
    current = parent.rows[0];
    root = current;
  }
  await client.query(`
    insert into teacher_execution_lineages (
      root_run_id, thread_id, tenant_id, user_id, automatic_continuation_count,
      next_checkpoint_revision, created_at, updated_at
    ) values ($1, $2, $3, $4, 0, 1, coalesce($5::timestamptz, now()), now())
    on conflict (root_run_id) do nothing
  `, [root.run_id, root.thread_id, root.tenant_id, root.user_id, root.created_at || null]);
  const legacyContinuation = await client.query(`
    select run_id from teacher_runs
    where metadata ->> 'automaticContinuationSourceRunId' = $1
    order by created_at asc limit 1
  `, [root.run_id]);
  if (legacyContinuation.rows[0]) {
    await client.query(`
      update teacher_execution_lineages
      set automatic_continuation_count = 1,
          automatic_continuation_run_id = coalesce(automatic_continuation_run_id, $2),
          updated_at = now()
      where root_run_id = $1
    `, [root.run_id, legacyContinuation.rows[0].run_id]);
  }
  return root.run_id;
}

async function ensurePostgresTaskLifecycleContract(pool, input = {}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const run = (await client.query('select * from teacher_runs where run_id = $1 for update', [safeId(input.runId)])).rows[0];
    if (!run) throw taskLifecycleStoreError('TASK_CONTRACT_RUN_NOT_FOUND', 'Task contract run was not found.', 404);
    const rootRunId = await ensurePostgresExecutionLineage(client, run.run_id, run);
    const existing = (await client.query(`
      select current_snapshot
      from teacher_task_lifecycle_contracts
      where root_run_id = $1
      for update
    `, [rootRunId])).rows[0];
    if (existing) {
      await client.query('commit');
      return structuredClone(existing.current_snapshot);
    }
    const rootRun = (await client.query('select * from teacher_runs where run_id = $1', [rootRunId])).rows[0] || run;
    const message = (await client.query(`
      select content
      from teacher_messages
      where run_id = $1 and role = 'user'
      order by created_at asc
      limit 1
    `, [rootRunId])).rows[0];
    const rootUserRequest = String(input.rootUserRequest || message?.content || '').trim();
    if (!rootUserRequest) {
      throw taskLifecycleStoreError('TASK_CONTRACT_ROOT_REQUEST_MISSING', 'Task contract root user request was not found.', 409);
    }
    const contract = createTaskLifecycleContract({
      contractId: taskLifecycleContractId(rootRunId),
      rootRunId,
      threadId: rootRun.thread_id,
      tenantId: rootRun.tenant_id,
      userId: rootRun.user_id,
      rootUserRequest,
      taskProfile: input.taskProfile,
      objectiveSummary: input.objectiveSummary,
      preservationConstraints: input.preservationConstraints,
      createdAt: rootRun.created_at
    });
    const creationEvent = taskLifecycleCreationEvent(contract, run.run_id);
    await client.query(`
      insert into teacher_task_lifecycle_contracts (
        contract_id, root_run_id, thread_id, tenant_id, user_id,
        revision, status, snapshot_hash, current_snapshot, created_at, updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz, $10::timestamptz)
    `, [
      contract.contractId,
      rootRunId,
      contract.threadId,
      contract.tenantId,
      contract.userId,
      contract.revision,
      contract.status,
      contract.snapshotHash,
      JSON.stringify(contract),
      contract.createdAt
    ]);
    await insertPostgresTaskLifecycleEvent(client, rootRunId, creationEvent);
    await client.query('commit');
    return structuredClone(contract);
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function loadPostgresTaskLifecycleContract(pool, runId) {
  const result = await pool.query(`
    select contract.current_snapshot
    from teacher_runs run
    join teacher_task_lifecycle_contracts contract
      on contract.root_run_id = coalesce(nullif(run.metadata ->> 'continuationRootRunId', ''), run.run_id)
    where run.run_id = $1
  `, [safeId(runId)]);
  return result.rows[0] ? structuredClone(result.rows[0].current_snapshot) : null;
}

async function loadLatestPostgresTaskLifecycleContractForThread(pool, runId) {
  const result = await pool.query(`
    select contract.current_snapshot
    from teacher_runs run
    join teacher_task_lifecycle_contracts contract
      on contract.thread_id = run.thread_id
     and contract.tenant_id = run.tenant_id
     and contract.user_id = run.user_id
    where run.run_id = $1
      and contract.root_run_id <> coalesce(nullif(run.metadata ->> 'continuationRootRunId', ''), run.run_id)
    order by contract.updated_at desc, contract.created_at desc
    limit 1
  `, [safeId(runId)]);
  return result.rows[0] ? structuredClone(result.rows[0].current_snapshot) : null;
}

async function appendPostgresTaskLifecycleContractEvent(pool, input = {}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const run = (await client.query('select * from teacher_runs where run_id = $1 for update', [safeId(input.runId)])).rows[0];
    if (!run) throw taskLifecycleStoreError('TASK_CONTRACT_RUN_NOT_FOUND', 'Task contract run was not found.', 404);
    const rootRunId = await ensurePostgresExecutionLineage(client, run.run_id, run);
    const row = (await client.query(`
      select current_snapshot
      from teacher_task_lifecycle_contracts
      where root_run_id = $1
      for update
    `, [rootRunId])).rows[0];
    if (!row) throw taskLifecycleStoreError('TASK_CONTRACT_NOT_FOUND', 'Task lifecycle contract was not found.', 404);
    const transition = applyTaskLifecycleContractEvent(row.current_snapshot, {
      expectedRevision: input.expectedRevision,
      eventType: input.eventType,
      payload: input.payload,
      actor: input.actor,
      sourceRunId: run.run_id,
      eventId: input.eventId,
      createdAt: input.createdAt
    });
    const updated = await client.query(`
      update teacher_task_lifecycle_contracts
      set revision = $3,
          status = $4,
          snapshot_hash = $5,
          current_snapshot = $6::jsonb,
          updated_at = $7::timestamptz
      where root_run_id = $1 and revision = $2
      returning contract_id
    `, [
      rootRunId,
      Number(input.expectedRevision),
      transition.contract.revision,
      transition.contract.status,
      transition.contract.snapshotHash,
      JSON.stringify(transition.contract),
      transition.contract.updatedAt
    ]);
    if (!updated.rows[0]) {
      throw taskLifecycleStoreError('TASK_CONTRACT_REVISION_CONFLICT', 'Task contract revision changed during persistence.', 409);
    }
    await insertPostgresTaskLifecycleEvent(client, rootRunId, transition.event);
    await client.query('commit');
    return { contract: structuredClone(transition.contract), event: structuredClone(transition.event) };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function listPostgresTaskLifecycleContractEvents(pool, runId) {
  const result = await pool.query(`
    select event.event_id, event.contract_id, event.root_run_id, event.revision,
           event.event_type, event.source_run_id, event.actor, event.payload,
           event.resulting_status, event.resulting_snapshot_hash, event.created_at
    from teacher_runs run
    join teacher_task_lifecycle_contract_events event
      on event.root_run_id = coalesce(nullif(run.metadata ->> 'continuationRootRunId', ''), run.run_id)
    where run.run_id = $1
    order by event.revision asc
  `, [safeId(runId)]);
  return result.rows.map((row) => ({
    version: row.revision === 0 ? 'teacher-task-lifecycle-event-v1' : 'teacher-task-lifecycle-event-v1',
    eventId: row.event_id,
    contractId: row.contract_id,
    lineageId: row.root_run_id,
    revision: Number(row.revision),
    eventType: row.event_type,
    actor: row.actor || {},
    sourceRunId: row.source_run_id || '',
    payload: row.payload || {},
    resultingStatus: row.resulting_status,
    resultingSnapshotHash: row.resulting_snapshot_hash,
    createdAt: new Date(row.created_at).toISOString()
  }));
}

async function insertPostgresTaskLifecycleEvent(client, rootRunId, event) {
  await client.query(`
    insert into teacher_task_lifecycle_contract_events (
      event_id, contract_id, root_run_id, revision, event_type, source_run_id,
      actor, payload, resulting_status, resulting_snapshot_hash, created_at
    ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11::timestamptz)
  `, [
    event.eventId,
    event.contractId,
    rootRunId,
    event.revision,
    event.eventType,
    event.sourceRunId || null,
    JSON.stringify(event.actor || {}),
    JSON.stringify(event.payload || {}),
    event.resultingStatus,
    event.resultingSnapshotHash,
    event.createdAt
  ]);
}

async function appendPostgresExecutionCheckpoint(pool, input) {
  let client;
  try {
    client = await pool.connect();
    let boundary = normalizeExecutionBoundary(input.boundary);
    await client.query('begin');
    const runResult = await client.query('select * from teacher_runs where run_id = $1 for update', [safeId(input.runId)]);
    const run = runResult.rows[0];
    if (!run) throw checkpointError('EXECUTION_RUN_NOT_FOUND', 'Execution run was not found.', 404);
    const rootRunId = await ensurePostgresExecutionLineage(client, run.run_id, run);
    boundary = await inheritPostgresEngineeringBaselineReferences(client, rootRunId, boundary);
    const candidateArtifact = await persistPostgresExecutionArtifact(client, createArtifactRecord({
      rootRunId,
      sourceRunId: run.run_id,
      artifact: boundary.candidate
    }));
    const candidateArtifactId = resolveExecutionArtifactId(
      boundary.candidateArtifactId,
      candidateArtifact,
      'candidate'
    );
    const resolvedCandidate = candidateArtifact
      || await loadPostgresExecutionArtifact(client, rootRunId, candidateArtifactId, 'candidate');
    const validationArtifact = await persistPostgresExecutionArtifact(client, createArtifactRecord({
      rootRunId,
      sourceRunId: run.run_id,
      artifact: bindValidationArtifactCandidate(boundary.validation, resolvedCandidate)
    }));
    const validationArtifactId = resolveExecutionArtifactId(
      boundary.validationArtifactId,
      validationArtifact,
      'validation'
    );
    const resolvedValidation = validationArtifact
      || await loadPostgresExecutionArtifact(client, rootRunId, validationArtifactId, 'validation');
    assertExecutionArtifactPair(resolvedCandidate, resolvedValidation);
    const checkpointBoundary = bindServerOwnedEngineeringBaselineReferences(
      bindExecutionBoundaryValidationMetadata(boundary, resolvedValidation),
      resolvedCandidate,
      resolvedValidation
    );
    const revisionResult = await client.query(`
      update teacher_execution_lineages
      set next_checkpoint_revision = next_checkpoint_revision + 1, updated_at = now()
      where root_run_id = $1
      returning next_checkpoint_revision - 1 as revision
    `, [rootRunId]);
    const revision = Number(revisionResult.rows[0]?.revision || 0);
    if (!revision) throw checkpointError('EXECUTION_LINEAGE_UNAVAILABLE', 'Execution lineage was not available.', 409);
    const checkpoint = checkpointRecord({
      checkpointId: newCheckpointId(),
      rootRunId,
      runId: run.run_id,
      revision,
      boundary: checkpointBoundary,
      candidateArtifactId,
      validationArtifactId
    });
    await client.query(`
      insert into teacher_execution_checkpoints (
        checkpoint_id, root_run_id, run_id, revision, phase,
        candidate_artifact_id, validation_artifact_id,
        request_revision_hash, task_contract_hash, editor_base_hash,
        validator_version, ruleset_version, validation_options_hash,
        repair_round, repair_state, knowledge_cursor, metadata, created_at
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17::jsonb, $18::timestamptz
      )
    `, [
      checkpoint.checkpointId,
      checkpoint.rootRunId,
      checkpoint.runId,
      checkpoint.revision,
      checkpoint.phase,
      checkpoint.candidateArtifactId || null,
      checkpoint.validationArtifactId || null,
      checkpoint.requestRevisionHash,
      checkpoint.taskContractHash,
      checkpoint.editorBaseHash,
      checkpoint.validatorVersion,
      checkpoint.rulesetVersion,
      checkpoint.validationOptionsHash,
      checkpoint.repairRound,
      JSON.stringify(checkpoint.repairState),
      JSON.stringify(checkpoint.knowledgeCursor),
      JSON.stringify(checkpoint.metadata),
      checkpoint.createdAt
    ]);
    const engineeringBaseline = await resolvePostgresEngineeringBaseline(client, rootRunId, checkpoint);
    await client.query('commit');
    return hydrateExecutionCheckpoint(
      checkpoint,
      resolvedCandidate,
      resolvedValidation,
      undefined,
      '',
      engineeringBaseline
    );
  } catch (error) {
    if (client) await client.query('rollback').catch(() => {});
    throw stableExecutionRepositoryError(error, 'EXECUTION_CHECKPOINT_PERSIST_FAILED');
  } finally {
    client?.release();
  }
}

async function persistPostgresExecutionArtifact(client, artifact) {
  if (!artifact) return null;
  assertValidationArtifactReuseFields(artifact);
  await client.query(`
    insert into teacher_execution_artifacts (
      artifact_id, root_run_id, source_run_id, artifact_kind, artifact_hash,
      candidate_artifact_hash, candidate_workspace_hash, validator_version, ruleset_version,
      validation_options_hash, validation_reuse_key, payload, created_at
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, now())
    on conflict (artifact_id) do nothing
  `, [
    artifact.artifactId,
    artifact.rootRunId,
    artifact.sourceRunId,
    artifact.artifactKind,
    artifact.artifactHash,
    artifact.candidateArtifactHash,
    artifact.candidateWorkspaceHash,
    artifact.validatorVersion,
    artifact.rulesetVersion,
    artifact.validationOptionsHash,
    artifact.validationReuseKey,
    JSON.stringify(artifact.payload)
  ]);
  const stored = await client.query('select * from teacher_execution_artifacts where artifact_id = $1', [artifact.artifactId]);
  const mapped = executionArtifactRow(stored.rows[0]);
  assertSameExecutionArtifact(mapped, artifact);
  return mapped;
}

async function loadPostgresExecutionArtifact(client, rootRunId, artifactId, expectedKind) {
  if (!artifactId) return null;
  const result = await client.query('select * from teacher_execution_artifacts where artifact_id = $1', [artifactId]);
  const artifact = executionArtifactRow(result.rows[0]);
  assertExecutionArtifactScope(artifact, rootRunId, expectedKind);
  return artifact;
}

function inheritMemoryEngineeringBaselineReferences(state, rootRunId, boundary) {
  const engineering = boundary?.metadata?.engineering;
  if (!engineering || typeof engineering !== 'object' || Array.isArray(engineering)) return boundary;
  const previous = [...(state.executionCheckpoints.get(rootRunId) || [])].reverse().find((checkpoint) => (
    checkpoint?.metadata?.engineering
    && safeArtifactReference(checkpoint.metadata.engineering.baselineCandidateArtifactId)
    && safeArtifactReference(checkpoint.metadata.engineering.baselineValidationArtifactId)
  ));
  return previous
    ? inheritEngineeringBaselineReferences(boundary, previous.metadata.engineering)
    : clearUntrustedEngineeringBaselineReferences(boundary);
}

async function inheritPostgresEngineeringBaselineReferences(client, rootRunId, boundary) {
  const engineering = boundary?.metadata?.engineering;
  if (!engineering || typeof engineering !== 'object' || Array.isArray(engineering)) return boundary;
  const result = await client.query(`
    select metadata from teacher_execution_checkpoints
    where root_run_id = $1 and metadata -> 'engineering' is not null
    order by revision desc limit 1
  `, [rootRunId]);
  return result.rows[0]?.metadata?.engineering
    ? inheritEngineeringBaselineReferences(boundary, result.rows[0].metadata.engineering)
    : clearUntrustedEngineeringBaselineReferences(boundary);
}

function clearUntrustedEngineeringBaselineReferences(boundary) {
  const engineering = { ...boundary.metadata.engineering };
  delete engineering.baselineCandidateArtifactId;
  delete engineering.baselineCandidateArtifactHash;
  delete engineering.baselineValidationArtifactId;
  delete engineering.baselineValidationArtifactHash;
  return Object.freeze({
    ...boundary,
    metadata: { ...boundary.metadata, engineering }
  });
}

function inheritEngineeringBaselineReferences(boundary, previousEngineering) {
  const engineering = boundary?.metadata?.engineering;
  if (!engineering || !previousEngineering) return boundary;
  const inheritedCandidateId = safeArtifactReference(previousEngineering.baselineCandidateArtifactId);
  const inheritedValidationId = safeArtifactReference(previousEngineering.baselineValidationArtifactId);
  if (!inheritedCandidateId || !inheritedValidationId) return boundary;
  return Object.freeze({
    ...boundary,
    metadata: {
      ...boundary.metadata,
      engineering: {
        ...engineering,
        baselineCandidateArtifactId: inheritedCandidateId,
        baselineCandidateArtifactHash: safeHashValue(previousEngineering.baselineCandidateArtifactHash),
        baselineValidationArtifactId: inheritedValidationId,
        baselineValidationArtifactHash: safeHashValue(previousEngineering.baselineValidationArtifactHash)
      }
    }
  });
}

function bindServerOwnedEngineeringBaselineReferences(boundary, candidateArtifact, validationArtifact) {
  const engineering = boundary?.metadata?.engineering;
  if (!engineering || typeof engineering !== 'object' || Array.isArray(engineering)) return boundary;
  const inheritedCandidateId = safeArtifactReference(engineering.baselineCandidateArtifactId);
  const inheritedValidationId = safeArtifactReference(engineering.baselineValidationArtifactId);
  const baselineCandidate = inheritedCandidateId ? null : candidateArtifact;
  const baselineValidation = inheritedValidationId ? null : validationArtifact;
  if ((!inheritedCandidateId && !baselineCandidate) || (!inheritedValidationId && !baselineValidation)) {
    return boundary;
  }
  return Object.freeze({
    ...boundary,
    metadata: {
      ...boundary.metadata,
      engineering: {
        ...engineering,
        baselineCandidateArtifactId: inheritedCandidateId || baselineCandidate.artifactId,
        baselineCandidateArtifactHash: inheritedCandidateId
          ? safeHashValue(engineering.baselineCandidateArtifactHash)
          : baselineCandidate.artifactHash,
        baselineValidationArtifactId: inheritedValidationId || baselineValidation.artifactId,
        baselineValidationArtifactHash: inheritedValidationId
          ? safeHashValue(engineering.baselineValidationArtifactHash)
          : baselineValidation.artifactHash
      }
    }
  });
}

function resolveMemoryEngineeringBaseline(state, rootRunId, checkpoint, transientArtifacts = []) {
  const engineering = engineeringMetadata(checkpoint);
  const references = requiredEngineeringBaselineReferences(engineering);
  if (!references) return null;
  const loadArtifact = (artifactId, expectedKind) => {
    const transient = transientArtifacts.find((artifact) => artifact?.artifactId === artifactId);
    if (transient) {
      assertExecutionArtifactScope(transient, rootRunId, expectedKind);
      return transient;
    }
    return loadMemoryExecutionArtifact(state, rootRunId, artifactId, expectedKind);
  };
  const candidateArtifact = loadArtifact(references.candidateArtifactId, 'candidate');
  const validationArtifact = loadArtifact(references.validationArtifactId, 'validation');
  assertResolvedEngineeringBaseline(engineering, candidateArtifact, validationArtifact);
  return { candidateArtifact, validationArtifact };
}

async function resolvePostgresEngineeringBaseline(client, rootRunId, checkpoint) {
  return resolveEngineeringBaseline(checkpoint, (artifactId, expectedKind) => (
    loadPostgresExecutionArtifact(client, rootRunId, artifactId, expectedKind)
  ));
}

async function resolveEngineeringBaseline(checkpoint, loadArtifact) {
  const engineering = engineeringMetadata(checkpoint);
  const references = requiredEngineeringBaselineReferences(engineering);
  if (!references) return null;
  const candidateArtifact = await loadArtifact(references.candidateArtifactId, 'candidate');
  const validationArtifact = await loadArtifact(references.validationArtifactId, 'validation');
  assertResolvedEngineeringBaseline(engineering, candidateArtifact, validationArtifact);
  return { candidateArtifact, validationArtifact };
}

function engineeringMetadata(checkpoint) {
  const engineering = checkpoint?.metadata?.engineering;
  return engineering && typeof engineering === 'object' && !Array.isArray(engineering) ? engineering : null;
}

function requiredEngineeringBaselineReferences(engineering) {
  if (!engineering) return null;
  const candidateArtifactId = safeArtifactReference(engineering.baselineCandidateArtifactId);
  const validationArtifactId = safeArtifactReference(engineering.baselineValidationArtifactId);
  if (!candidateArtifactId && !validationArtifactId) return null;
  if (!candidateArtifactId || !validationArtifactId) {
    throw checkpointError(
      'ENGINEERING_BASELINE_REFERENCE_INCOMPLETE',
      'Engineering baseline requires both Candidate and Validation artifact references.',
      409
    );
  }
  return { candidateArtifactId, validationArtifactId };
}

function assertResolvedEngineeringBaseline(engineering, candidateArtifact, validationArtifact) {
  assertExecutionArtifactPair(candidateArtifact, validationArtifact);
  assertEngineeringBaselineHash(engineering.baselineCandidateArtifactHash, candidateArtifact);
  assertEngineeringBaselineHash(engineering.baselineValidationArtifactHash, validationArtifact);
}

function assertEngineeringBaselineHash(expectedHash, artifact) {
  const expected = safeHashValue(expectedHash);
  if (expected && expected !== artifact?.artifactHash) {
    throw checkpointError(
      'ENGINEERING_BASELINE_HASH_MISMATCH',
      'Engineering baseline artifact hash does not match the persisted reference.',
      409
    );
  }
}

async function loadLatestPostgresExecutionCheckpoint(pool, runId, options = {}) {
  let client;
  try {
    client = await pool.connect();
    return await loadLatestPostgresExecutionCheckpointWithClient(client, runId, options);
  } catch (error) {
    throw stableExecutionRepositoryError(error, 'EXECUTION_CHECKPOINT_LOAD_FAILED');
  } finally {
    client?.release();
  }
}

async function loadLatestPostgresExecutionCheckpointWithClient(client, runId, options = {}) {
  try {
    const rootRunId = await ensurePostgresExecutionLineage(client, safeId(runId));
    const result = await client.query(`
      select * from teacher_execution_checkpoints
      where root_run_id = $1
      order by revision desc limit 1
    `, [rootRunId]);
    if (!result.rows[0]) return null;
    const checkpoint = executionCheckpointRow(result.rows[0]);
    const candidateArtifact = await loadPostgresExecutionArtifact(
      client,
      rootRunId,
      checkpoint.candidateArtifactId,
      'candidate'
    );
    const validationArtifact = await loadPostgresExecutionArtifact(
      client,
      rootRunId,
      checkpoint.validationArtifactId,
      'validation'
    );
    let persistedAnswer = '';
    if (checkpoint.phase === 'completed' && checkpoint.runId) {
      const answerResult = await client.query(`
        select response from teacher_messages
        where run_id = $1 and role = 'assistant' and status = 'succeeded'
        order by created_at desc limit 1
      `, [checkpoint.runId]);
      persistedAnswer = projectPersistedAnswer(answerResult.rows[0]?.response);
    }
    return hydrateExecutionCheckpoint(
      checkpoint,
      candidateArtifact,
      validationArtifact,
      options.currentHashes,
      persistedAnswer,
      await resolvePostgresEngineeringBaseline(client, rootRunId, checkpoint)
    );
  } catch (error) {
    throw stableExecutionRepositoryError(error, 'EXECUTION_CHECKPOINT_LOAD_FAILED');
  }
}

async function listPostgresExecutionCheckpointTimeline(pool, runId, options = {}) {
  let client;
  try {
    client = await pool.connect();
    const rootRunId = await ensurePostgresExecutionLineage(client, safeId(runId));
    const result = await client.query(`
      select * from teacher_execution_checkpoints
      where root_run_id = $1
      order by revision desc limit $2
    `, [rootRunId, timelineLimit(options.limit)]);
    return result.rows.reverse().map((row) => checkpointTimelineEntry(
      executionCheckpointRow(row),
      options.currentHashes
    ));
  } catch (error) {
    throw stableExecutionRepositoryError(error, 'EXECUTION_CHECKPOINT_LOAD_FAILED');
  } finally {
    client?.release();
  }
}

async function findPostgresReusableValidationArtifact(pool, input) {
  let client;
  try {
    client = await pool.connect();
    const rootRunId = await ensurePostgresExecutionLineage(client, safeId(input.runId));
    const reuseKey = requiredValidationReuseKey(input);
    const result = await client.query(`
      select * from teacher_execution_artifacts
      where root_run_id = $1 and artifact_kind = 'validation' and validation_reuse_key = $2
      order by created_at desc limit 1
    `, [rootRunId, reuseKey]);
    return executionArtifactRow(result.rows[0]);
  } catch (error) {
    throw stableExecutionRepositoryError(error, 'EXECUTION_ARTIFACT_LOAD_FAILED');
  } finally {
    client?.release();
  }
}

function resolveExecutionArtifactId(referenceId, createdArtifact, expectedKind) {
  if (referenceId && createdArtifact && referenceId !== createdArtifact.artifactId) {
    throw checkpointError(
      'EXECUTION_ARTIFACT_REFERENCE_CONFLICT',
      `${expectedKind} artifact payload conflicts with its reference.`,
      409
    );
  }
  return createdArtifact?.artifactId || referenceId || '';
}

function assertExecutionArtifactScope(artifact, rootRunId, expectedKind) {
  if (!artifact) throw checkpointError('EXECUTION_ARTIFACT_NOT_FOUND', 'Execution artifact was not found.', 404);
  if (artifact.rootRunId !== rootRunId || artifact.artifactKind !== expectedKind) {
    throw checkpointError('EXECUTION_ARTIFACT_SCOPE_MISMATCH', 'Execution artifact does not belong to this lineage.', 409);
  }
}

function assertSameExecutionArtifact(existing, proposed) {
  if (!existing || existing.rootRunId !== proposed.rootRunId
    || existing.artifactKind !== proposed.artifactKind
    || existing.artifactHash !== proposed.artifactHash
    || existing.candidateArtifactHash !== proposed.candidateArtifactHash
    || existing.candidateWorkspaceHash !== proposed.candidateWorkspaceHash
    || existing.validatorVersion !== proposed.validatorVersion
    || existing.rulesetVersion !== proposed.rulesetVersion
    || existing.validationOptionsHash !== proposed.validationOptionsHash
    || existing.validationReuseKey !== proposed.validationReuseKey) {
    throw checkpointError('EXECUTION_ARTIFACT_CONFLICT', 'Execution artifact identity conflicts with persisted content.', 409);
  }
}

function assertValidationArtifactReuseFields(artifact) {
  if (artifact?.artifactKind !== 'validation') return;
  const expectedReuseKey = validationReuseKey(artifact);
  if (!artifact.candidateArtifactHash || !expectedReuseKey || artifact.validationReuseKey !== expectedReuseKey) {
    throw checkpointError(
      'EXECUTION_VALIDATION_REUSE_KEY_INCOMPLETE',
      'Validation artifact requires a Candidate binding and the complete Validator reuse key.',
      400
    );
  }
}

function assertExecutionArtifactPair(candidateArtifact, validationArtifact) {
  if (!candidateArtifact || !validationArtifact) return;
  const candidateArtifactHash = candidateArtifact.artifactHash;
  const boundCandidateArtifactHash = validationArtifact.candidateArtifactHash;
  const candidateWorkspaceHash = candidateArtifact.candidateWorkspaceHash || candidateArtifactHash;
  const candidateWorkspaceHashIsProvisional = candidateWorkspaceHash === candidateArtifactHash;
  const bindingMismatch = boundCandidateArtifactHash
    ? boundCandidateArtifactHash !== candidateArtifactHash
    : validationArtifact.candidateWorkspaceHash !== candidateWorkspaceHash;
  const authoritativeWorkspaceMismatch = !candidateWorkspaceHashIsProvisional
    && validationArtifact.candidateWorkspaceHash !== candidateWorkspaceHash;
  if (bindingMismatch || authoritativeWorkspaceMismatch) {
    throw checkpointError(
      'EXECUTION_VALIDATION_CANDIDATE_MISMATCH',
      'Validation artifact does not match the Candidate artifact binding.',
      409
    );
  }
}

function bindExecutionBoundaryValidationMetadata(boundary, validationArtifact) {
  if (!validationArtifact) return boundary;
  for (const field of ['validatorVersion', 'rulesetVersion', 'validationOptionsHash']) {
    if (boundary[field] && boundary[field] !== validationArtifact[field]) {
      throw checkpointError(
        'EXECUTION_VALIDATION_METADATA_MISMATCH',
        'Checkpoint Validator metadata does not match the referenced Validation artifact.',
        409
      );
    }
  }
  return Object.freeze({
    ...boundary,
    validatorVersion: validationArtifact.validatorVersion,
    rulesetVersion: validationArtifact.rulesetVersion,
    validationOptionsHash: validationArtifact.validationOptionsHash
  });
}

function requiredValidationReuseKey(input) {
  const reuseKey = validationReuseKey(input);
  if (!reuseKey) {
    throw checkpointError(
      'EXECUTION_VALIDATION_REUSE_KEY_INCOMPLETE',
      'Validation reuse lookup requires Candidate, Validator, ruleset, and options hashes.',
      400
    );
  }
  return reuseKey;
}

function hydrateExecutionCheckpoint(
  checkpoint,
  candidateArtifact,
  validationArtifact,
  currentHashes,
  persistedAnswer = '',
  engineeringBaseline = null
) {
  const execution = executionResumeProjection({
    checkpoint,
    candidateArtifact,
    validationArtifact,
    currentHashes,
    persistedAnswer
  });
  return {
    checkpoint,
    candidateArtifact: candidateArtifact || null,
    validationArtifact: validationArtifact || null,
    execution: attachEngineeringResumeProjection(execution, checkpoint, engineeringBaseline)
  };
}

function attachEngineeringResumeProjection(execution, checkpoint, engineeringBaseline) {
  if (!execution) return execution;
  const engineering = engineeringMetadata(checkpoint);
  if (!engineering && !engineeringBaseline) return execution;
  const continuationKind = normalizeAutomaticContinuationKind(
    engineering?.continuationKind || execution?.decision?.continuationKind
  );
  const status = boundedEngineeringText(engineering?.status, 80)
    || (checkpoint?.phase === 'engineering_improvement_pending' ? 'pending' : '');
  return Object.freeze({
    ...execution,
    continuationKind,
    engineering: Object.freeze({
      status,
      continuationKind,
      baselineCandidateArtifactId: safeArtifactReference(engineering?.baselineCandidateArtifactId),
      baselineCandidateArtifactHash: safeHashValue(engineering?.baselineCandidateArtifactHash),
      baselineValidationArtifactId: safeArtifactReference(engineering?.baselineValidationArtifactId),
      baselineValidationArtifactHash: safeHashValue(engineering?.baselineValidationArtifactHash),
      assessmentCount: boundedEngineeringCount(engineering?.assessmentCount),
      mainReentryCount: boundedEngineeringCount(engineering?.mainReentryCount),
      revisionCount: boundedEngineeringCount(engineering?.revisionCount ?? engineering?.revisionCycleCount),
      verificationCount: boundedEngineeringCount(engineering?.verificationCount),
      selectionCount: boundedEngineeringCount(engineering?.selectionCount),
      verification: ['not_run', 'resolved', 'unresolved', 'unavailable'].includes(engineering?.verification)
        ? engineering.verification
        : 'not_run',
      revisionDelivered: engineering?.revisionDelivered === true || engineering?.revisionAdopted === true,
      revisionAdopted: engineering?.revisionAdopted === true,
      ...(boundedEngineeringScorecard(engineering?.scorecard)
        ? { scorecard: boundedEngineeringScorecard(engineering.scorecard) }
        : {}),
      ...(boundedEngineeringScorecard(engineering?.revisionScorecard)
        ? { revisionScorecard: boundedEngineeringScorecard(engineering.revisionScorecard) }
        : {}),
      openSuggestions: boundedEngineeringSuggestions(engineering?.openSuggestions),
      previousSuggestions: publicEngineeringSuggestions(engineering?.previousSuggestions),
      taskGoalRefs: boundedEngineeringList(engineering?.taskGoalRefs, 32),
      issueSummaries: boundedEngineeringList(engineering?.issueSummaries || engineering?.issues, 8),
      ...(engineeringBaseline?.candidateArtifact
        ? { baselineCandidate: engineeringBaseline.candidateArtifact.payload }
        : {}),
      ...(engineeringBaseline?.validationArtifact
        ? { baselineValidation: engineeringBaseline.validationArtifact.payload }
        : {})
    })
  });
}

function boundedEngineeringList(value, limit) {
  if (!Array.isArray(value)) return [];
  return JSON.parse(JSON.stringify(value.slice(0, limit)));
}

function boundedEngineeringScorecard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const dimensions = [
    ['userGoalCoverage', 40],
    ['engineeringClosure', 25],
    ['consistencyAndPreservation', 20],
    ['evidenceAndUncertainty', 15],
    ['total', 100]
  ];
  const bounded = {};
  for (const [name, maximum] of dimensions) {
    const score = Number(value[name]);
    if (!Number.isInteger(score) || score < 0 || score > maximum) return undefined;
    bounded[name] = score;
  }
  if (bounded.total !== bounded.userGoalCoverage + bounded.engineeringClosure
    + bounded.consistencyAndPreservation + bounded.evidenceAndUncertainty
    || !['deliver', 'deliver_with_advisory', 'optimize'].includes(value.reviewerRecommendation)) {
    return undefined;
  }
  bounded.reviewerRecommendation = value.reviewerRecommendation;
  return Object.freeze(bounded);
}

function boundedEngineeringSuggestions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 4).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const publicSuggestionId = String(item.publicSuggestionId || '').slice(0, 200);
    const sourceIssueId = String(item.sourceIssueId || '').slice(0, 200);
    const goalRefId = String(item.goalRefId || '').slice(0, 200);
    const summary = String(item.summary || '').trim().slice(0, 500);
    return publicSuggestionId && sourceIssueId && goalRefId && summary
      ? [{ publicSuggestionId, sourceIssueId, goalRefId, summary }]
      : [];
  });
}

function boundedEngineeringText(value, limit) {
  return String(value || '').trim().slice(0, limit);
}

function boundedEngineeringCount(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, 10) : 0;
}

function checkpointTimelineEntry(checkpoint, currentHashes) {
  const execution = executionResumeProjection({ checkpoint, currentHashes });
  return {
    checkpoint,
    decision: execution?.decision || null
  };
}

function executionArtifactRow(row) {
  if (!row) return null;
  return Object.freeze({
    version: 'teacher-execution-artifact-v1',
    artifactId: row.artifact_id,
    rootRunId: row.root_run_id,
    sourceRunId: row.source_run_id,
    artifactKind: row.artifact_kind,
    artifactHash: row.artifact_hash,
    candidateArtifactHash: row.candidate_artifact_hash || '',
    candidateWorkspaceHash: row.candidate_workspace_hash || '',
    validatorVersion: row.validator_version || '',
    rulesetVersion: row.ruleset_version || '',
    validationOptionsHash: row.validation_options_hash || '',
    validationReuseKey: row.validation_reuse_key || '',
    payload: row.payload || {},
    createdAt: row.created_at
  });
}

function executionCheckpointRow(row) {
  return Object.freeze({
    version: 'teacher-execution-checkpoint-v1',
    checkpointId: row.checkpoint_id,
    rootRunId: row.root_run_id,
    runId: row.run_id,
    revision: Number(row.revision || 0),
    phase: row.phase,
    candidateArtifactId: row.candidate_artifact_id || '',
    validationArtifactId: row.validation_artifact_id || '',
    requestRevisionHash: row.request_revision_hash || '',
    taskContractHash: row.task_contract_hash || '',
    editorBaseHash: row.editor_base_hash || '',
    validatorVersion: row.validator_version || '',
    rulesetVersion: row.ruleset_version || '',
    validationOptionsHash: row.validation_options_hash || '',
    repairRound: Number(row.repair_round || 0),
    repairState: row.repair_state || {},
    knowledgeCursor: row.knowledge_cursor || {},
    metadata: row.metadata || {},
    createdAt: row.created_at
  });
}

function stableExecutionRepositoryError(error, fallbackCode) {
  if (error instanceof ExecutionCheckpointError) return error;
  const stable = checkpointError(fallbackCode, 'Execution checkpoint repository operation failed.', 500);
  Object.defineProperty(stable, 'cause', { value: error, enumerable: false });
  return stable;
}

function createPool(options = {}) {
  return require('./database-pool-policy').createTeacherDatabasePool(options, 'postgres conversation storage');
}

async function loadRun(pool, runId) {
  const result = await pool.query('select * from teacher_runs where run_id = $1', [runId]);
  return result.rows[0] || null;
}

async function loadThread(pool, threadId) {
  const result = await pool.query('select * from teacher_threads where thread_id = $1', [threadId]);
  return result.rows[0] || null;
}

async function findDefaultPostgresThreadId(pool, context) {
  const result = await pool.query(`
    select thread_id
    from teacher_threads
    where tenant_id = $1 and user_id = $2 and course_pack_id = $3 and course_id = $4 and lesson_id = $5
    order by updated_at desc
    limit 1
  `, [
    tenantId(context),
    userId(context),
    context?.course?.coursePackId || '',
    context?.course?.courseId || '',
    context?.course?.lessonId || ''
  ]);
  return result.rows[0]?.thread_id || '';
}

function findDefaultThreadId(state, context) {
  const threads = Array.from(state.threads.values())
    .filter((thread) => sameCurrentContext(thread, context))
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  return threads[0]?.threadId || '';
}

function sameCurrentContext(thread, context) {
  return thread.tenantId === tenantId(context)
    && thread.userId === userId(context)
    && thread.coursePackId === (context?.course?.coursePackId || '')
    && (thread.courseId || '') === (context?.course?.courseId || '')
    && thread.lessonId === (context?.course?.lessonId || '');
}

function sameThreadOwner(thread, context) {
  return String(thread.tenantId || thread.tenant_id || '') === tenantId(context)
    && String(thread.userId || thread.user_id || '') === userId(context);
}

function createThreadRecord(context, threadId) {
  const now = new Date().toISOString();
  return {
    threadId,
    tenantId: tenantId(context),
    userId: userId(context),
    coursePackId: context?.course?.coursePackId || '',
    courseId: context?.course?.courseId || '',
    lessonId: context?.course?.lessonId || '',
    createdAt: now,
    updatedAt: now
  };
}

function projectThreadSummary(thread, messages, contextLimitTokens) {
  const succeeded = messages.filter((message) => message.status === 'succeeded');
  const firstQuestion = succeeded.find((message) => message.role === 'user')?.content || '';
  const contextByteCount = succeeded.reduce(
    (sum, message) => sum + Buffer.byteLength(String(message.content || ''), 'utf8'),
    0
  );
  return {
    ...thread,
    title: threadTitle(firstQuestion),
    messageCount: succeeded.length,
    ...threadContextProjection(contextByteCount, contextLimitTokens)
  };
}

function threadRow(row, contextLimitTokens) {
  return {
    threadId: row.thread_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    coursePackId: row.course_pack_id || '',
    courseId: row.course_id || '',
    lessonId: row.lesson_id || '',
    title: threadTitle(row.title),
    messageCount: Number(row.message_count || 0),
    ...threadContextProjection(row.context_byte_count, contextLimitTokens),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function threadTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (!title) return '新对话';
  return title.length > 48 ? `${title.slice(0, 48)}…` : title;
}

function threadContextProjection(contextByteCount, contextLimitTokens) {
  const estimatedTokens = Math.max(0, Math.ceil(Number(contextByteCount || 0) / 3));
  const limitTokens = Number(contextLimitTokens);
  if (!Number.isInteger(limitTokens) || limitTokens <= 0) {
    throw new RangeError('Thread context limit must come from the active resource policy.');
  }
  const ratio = limitTokens > 0 ? Math.min(1, estimatedTokens / limitTokens) : 0;
  return {
    contextUsage: {
      estimatedTokens,
      limitTokens,
      ratio,
      state: ratio >= 0.9 ? 'critical' : ratio >= 0.75 ? 'approaching' : 'normal'
    }
  };
}

function deleteMemoryThreadState(state, threadId) {
  const runIds = new Set(Array.from(state.runs.entries())
    .filter(([, run]) => run?.threadId === threadId)
    .map(([runId]) => runId));
  state.threads.delete(threadId);
  state.messages.delete(threadId);
  for (const [runId] of state.runs) {
    if (runIds.has(runId)) state.runs.delete(runId);
  }
  for (const mapName of [
    'runEvents',
    'toolLedger',
    'modelCallLedger',
    'projectPlans',
    'moduleCheckpoints',
    'clarificationCheckpoints',
    'automaticContinuations',
    'executionLineages',
    'executionArtifacts',
    'executionCheckpoints',
    'taskLifecycleContracts',
    'taskLifecycleContractEvents',
    'summaries'
  ]) {
    const map = state[mapName];
    if (!(map instanceof Map)) continue;
    for (const [key, value] of map) {
      const belongsToThread = value?.threadId === threadId
        || runIds.has(String(value?.runId || ''))
        || runIds.has(String(value?.rootRunId || ''))
        || runIds.has(String(value?.sourceRunId || ''))
        || String(key) === threadId
        || String(key).startsWith(`${threadId}:`)
        || runIds.has(String(key));
      if (belongsToThread) map.delete(key);
    }
  }
  filterArrayInPlace(state.runSteps, (entry) => !runIds.has(String(entry?.runId || '')));
  filterArrayInPlace(state.usageLedger, (entry) => entry?.threadId !== threadId && !runIds.has(String(entry?.runId || '')));
  filterArrayInPlace(state.auditEvents, (entry) => entry?.threadId !== threadId && !runIds.has(String(entry?.runId || '')));
}

function filterArrayInPlace(value, predicate) {
  if (!Array.isArray(value)) return;
  const kept = value.filter(predicate);
  value.splice(0, value.length, ...kept);
}

function messageRow(row) {
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    runId: row.run_id,
    role: row.role,
    status: row.status,
    content: row.content || '',
    response: sanitizeBrowserPayload(row.response || null),
    requestId: row.request_id || '',
    automaticContinuationSourceRunId: row.automatic_continuation_source_run_id || '',
    createdAt: row.created_at
  };
}

function runRow(row) {
  return {
    runId: row.run_id,
    threadId: row.thread_id,
    requestId: row.request_id || '',
    tenantId: row.tenant_id,
    userId: row.user_id,
    intent: row.intent || '',
    route: row.route || '',
    status: row.status || '',
    messageId: row.message_id || '',
    errorCode: row.error_code || '',
    errorMessage: row.error_message || '',
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function auditEventRow(row) {
  return {
    auditId: row.audit_id,
    eventType: row.event_type,
    tenantId: row.tenant_id || '',
    requestId: row.request_id || '',
    runId: row.run_id || '',
    status: row.status || '',
    metadata: redactMetadata(row.metadata || {}),
    createdAt: row.created_at
  };
}

function runEventRow(row) {
  return {
    eventId: row.event_id,
    runId: row.run_id,
    seq: Number(row.seq || 0),
    eventType: row.event_type,
    payload: sanitizeRunEventPayload(row.payload || {}),
    createdAt: row.created_at
  };
}

function rowRun(row) {
  return {
    runId: row.run_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    requestId: row.request_id,
    intent: row.intent
  };
}

function sanitizeRunEventPayload(payload) {
  const clean = sanitizeBrowserPayload(payload);
  if (!clean || typeof clean !== 'object') return {};
  return clean;
}

function sanitizeBrowserPayload(value) {
  const blocked = new Set([
    'providerMeta',
    'internalProviderDiagnostic',
    'selectedOutputTier',
    'maxCompletionTokens',
    'estimatedInputTokens',
    'completionTokens',
    'reasoningTokens',
    'promptTokens',
    'totalTokens',
    'providerTrace',
    'budgetReport',
    'skillSource',
    'usage',
    'internalDiagnostic',
    '__internal'
  ]);
  if (Array.isArray(value)) return value.map(sanitizeBrowserPayload);
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (blocked.has(key)) continue;
    clean[key] = sanitizeBrowserPayload(item);
  }
  return clean;
}

function usageFromProviderMeta({ run, providerMeta, status }) {
  const meta = providerMeta?.providerMeta || providerMeta || {};
  const promptTokens = number(meta.promptTokens ?? meta.prompt_tokens ?? meta.estimatedInputTokens);
  const completionTokens = number(meta.completionTokens ?? meta.completion_tokens);
  const reasoningTokens = number(meta.reasoningTokens ?? meta.reasoning_tokens);
  const totalTokens = number(meta.totalTokens ?? meta.total_tokens ?? (promptTokens + completionTokens));
  return {
    tenantId: run.tenantId || run.tenant_id || '',
    userId: run.userId || run.user_id || '',
    requestId: run.requestId || run.request_id || '',
    runId: run.runId || run.run_id || '',
    provider: meta.provider || '',
    model: String(meta.model || meta.agent?.modelAlias || '').slice(0, 200),
    intent: run.intent || '',
    promptTokens,
    completionTokens,
    reasoningTokens,
    totalTokens,
    estimatedCost: 0,
    status,
    metadata: {
      selectedOutputTier: meta.selectedOutputTier || '',
      maxCompletionTokens: meta.maxCompletionTokens || 0,
      internalProviderDiagnostic: meta.internalProviderDiagnostic || providerMeta?.internalProviderDiagnostic || '',
      providerTrace: meta.providerTrace || null,
      phaseTimings: Array.isArray(meta.agent?.phaseTimings) ? meta.agent.phaseTimings.slice(0, 16) : [],
      modelCalls: Array.isArray(meta.agent?.modelCalls) ? meta.agent.modelCalls.slice(0, 16) : [],
      scopeGate: meta.agent?.scopeGate || null,
      initialAdmissionBudget: meta.agent?.initialAdmissionBudget || null,
      phaseBudget: meta.agent?.phaseBudget || null,
      candidateRecovery: meta.agent?.candidateRecovery || null,
      repairTrace: meta.agent?.repairTrace || null,
      candidateRender: meta.agent?.candidateRender || null
    }
  };
}

function summarizeUsage(providerMeta) {
  const meta = providerMeta?.providerMeta || providerMeta || {};
  return {
    promptTokens: number(meta.promptTokens ?? meta.estimatedInputTokens),
    completionTokens: number(meta.completionTokens),
    reasoningTokens: number(meta.reasoningTokens),
    totalTokens: number(meta.totalTokens)
  };
}

function deliveryObservation(response, providerMeta) {
  const agent = providerMeta?.agent || providerMeta?.providerMeta?.agent || {};
  const answerCompletionStatus = String(
    response?.answerCompletionStatus || agent.answerCompletionStatus || 'not_required'
  ).slice(0, 40);
  const stopReason = safeOperationalCode(agent.stopReason || response?.stopReason || 'completed');
  const validatorStatus = safeOperationalCode(response?.validatorStatus || agent.validatorStatus || 'not_validated');
  const reasonCodes = [...new Set([
    ...operationalWarningCodes(response?.warnings),
    ...(answerCompletionStatus === 'incomplete' ? ['answer_incomplete'] : []),
    ...(stopReason && !['completed', 'clarification_required'].includes(stopReason)
      ? [`stop_reason:${stopReason}`]
      : [])
  ])].slice(0, 16);
  const degraded = answerCompletionStatus === 'incomplete' || reasonCodes.length > 0;
  return {
    status: degraded ? 'degraded' : 'succeeded',
    frontendResultReturned: true,
    answerCompletionStatus,
    stopReason: stopReason || 'completed',
    validatorStatus: validatorStatus || 'not_validated',
    reasonCodes
  };
}

function operationalWarningCodes(warnings) {
  return (Array.isArray(warnings) ? warnings : []).flatMap((warning) => {
    const value = String(warning || '');
    if (value.startsWith('workflow_fail_closed:')) {
      const detail = safeOperationalCode(value.slice('workflow_fail_closed:'.length));
      return detail ? [`workflow_fail_closed:${detail}`] : ['workflow_fail_closed'];
    }
    if (value.startsWith('code_withheld_reason:')) {
      const detail = safeOperationalCode(value.slice('code_withheld_reason:'.length));
      return detail ? [`code_withheld:${detail}`] : ['code_withheld'];
    }
    if (value.startsWith('main_finalizer_fallback:')) return ['main_finalizer_fallback'];
    if (value.startsWith('final_answer_worker_fallback:')) return ['final_answer_worker_fallback'];
    if (value.startsWith('lifecycle_callback_failed:')) return ['lifecycle_callback_failed'];
    if (value.startsWith('intent_v2_tool_degraded:')) return ['intent_v2_tool_degraded'];
    if (value.startsWith('intent_v2_gate_fallback:')) return ['intent_v2_gate_fallback'];
    if ([
      'post_validation_answer_safely_degraded',
      'agent_outcome_safely_degraded',
      'unvalidated_or_unbound_code_withheld',
      'intent_v2_generation_failed',
      'intent_v2_contract_invalid',
      'model_call_audit_write_failed',
      'ledger_persistence_failed',
      'intent_v2_tool_context_budget_exhausted'
    ].includes(value)) return [value];
    return [];
  });
}

function safeOperationalCode(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function sanitizeProviderMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  return redactMetadata({
    estimatedInputTokens: meta.estimatedInputTokens ?? meta.providerMeta?.estimatedInputTokens,
    selectedOutputTier: meta.selectedOutputTier ?? meta.providerMeta?.selectedOutputTier,
    maxCompletionTokens: meta.maxCompletionTokens ?? meta.providerMeta?.maxCompletionTokens,
    promptTokens: meta.promptTokens ?? meta.providerMeta?.promptTokens,
    completionTokens: meta.completionTokens ?? meta.providerMeta?.completionTokens,
    reasoningTokens: meta.reasoningTokens ?? meta.providerMeta?.reasoningTokens,
    totalTokens: meta.totalTokens ?? meta.providerMeta?.totalTokens,
    providerTrace: meta.providerTrace ?? meta.providerMeta?.providerTrace,
    retryCount: meta.retryCount ?? meta.providerMeta?.retryCount,
    internalProviderDiagnostic: meta.internalProviderDiagnostic ?? meta.providerMeta?.internalProviderDiagnostic,
    budgetReport: meta.budgetReport ?? meta.providerMeta?.budgetReport,
    skillSource: meta.skillSource ?? meta.providerMeta?.skillSource,
    agent: meta.agent ?? meta.providerMeta?.agent
  });
}

function redactAuditEvent(event) {
  return {
    ...event,
    metadata: redactMetadata(event.metadata || {})
  };
}

function sanitizeRunStep(step = {}) {
  const metadata = step.metadata || {};
  return {
    runId: String(step.runId || ''),
    stepType: String(step.stepType || step.type || '').slice(0, 80),
    status: String(step.status || '').slice(0, 40),
    metadata: {
      stepNumber: number(metadata.stepNumber),
      phase: String(metadata.phase || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
      provider: String(metadata.provider || '').replace(/[^a-zA-Z0-9:._-]/g, '').slice(0, 80),
      modelId: String(metadata.modelId || '').replace(/[^a-zA-Z0-9:._/-]/g, '_').slice(0, 200),
      finishReason: String(metadata.finishReason || '').slice(0, 80),
      toolName: String(metadata.toolName || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
      argsHash: safeHash(metadata.argsHash),
      resultHash: safeHash(metadata.resultHash),
      durationMs: number(metadata.durationMs),
      validatorStatus: String(metadata.validatorStatus || '').slice(0, 40),
      replayed: Boolean(metadata.replayed),
      errorCode: String(metadata.errorCode || '').slice(0, 80),
      modelCalls: sanitizeModelCalls(metadata.modelCalls),
      usage: {
        promptTokens: number(metadata.usage?.promptTokens),
        completionTokens: number(metadata.usage?.completionTokens),
        reasoningTokens: number(metadata.usage?.reasoningTokens),
        totalTokens: number(metadata.usage?.totalTokens)
      }
    }
  };
}

function sanitizeModelCalls(value) {
  return (Array.isArray(value) ? value : []).slice(0, 16).map((call) => ({
    phase: String(call?.phase || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
    stepNumber: number(call?.stepNumber),
    provider: String(call?.provider || '').replace(/[^a-zA-Z0-9:._-]/g, '').slice(0, 80),
    modelId: String(call?.modelId || '').replace(/[^a-zA-Z0-9:._/-]/g, '_').slice(0, 200),
    durationMs: number(call?.durationMs),
    ...(nonNegativeIntegerOrUndefined(call?.timeToFirstOutputMs) === undefined
      ? {}
      : { timeToFirstOutputMs: nonNegativeIntegerOrUndefined(call.timeToFirstOutputMs) }),
    status: call?.status === 'failed' ? 'failed' : 'succeeded',
    finishReason: String(call?.finishReason || '').slice(0, 80),
    errorCategory: String(call?.errorCategory || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
    usage: {
      promptTokens: number(call?.usage?.inputTokens ?? call?.usage?.promptTokens),
      completionTokens: number(call?.usage?.outputTokens ?? call?.usage?.completionTokens),
      reasoningTokens: number(call?.usage?.reasoningTokens),
      totalTokens: number(call?.usage?.totalTokens)
    }
  }));
}

async function buildPostgresWorkflowResume(client, checkpoint, context, taskSourceRunId = checkpoint.source_run_id) {
  const sourceRun = await client.query('select provider_meta from teacher_runs where run_id = $1', [checkpoint.source_run_id]);
  const fastGate = sourceRun.rows[0]?.provider_meta?.agent?.fastGatePassThroughV2;
  if (!fastGate) throw clarificationCheckpointError('CLARIFICATION_CHECKPOINT_UNAVAILABLE', 409);
  const ledger = await client.query(`
    select tool_call_id, tool_name, canonical_args, result_payload, result_projection
    from teacher_tool_ledger
    where run_id = $1
      and tool_name in ('search_reviewed_knowledge', 'search_engineering_domain_evidence')
      and status = 'succeeded'
    order by started_at asc nulls last, tool_call_id asc
    limit 22
  `, [checkpoint.source_run_id]);
  // 澄清恢复先创建新Run和当前用户消息，再从新Run向源Run回溯。这样当前回答扩展
  // 已有TaskSourceSet，而不是只作为非规范conversationContext到达模型。
  const taskSources = await buildPostgresTaskSources(client, taskSourceRunId);
  const sourceStudentQuestion = checkpoint.includeSourceStudentQuestion === true
    ? taskSources[0]?.text || await postgresSourceStudentQuestion(client, checkpoint.source_run_id)
    : '';
  const latestExecution = await loadLatestPostgresExecutionCheckpointWithClient(
    client,
    checkpoint.source_run_id,
    { currentHashes: deriveExecutionInputHashes(context) }
  );
  const continuationKind = normalizeAutomaticContinuationKind(checkpoint.continuationKind);
  return {
    sourceRunId: checkpoint.source_run_id,
    continuationKind,
    ...(checkpoint.continuationBudget ? { continuationBudget: checkpoint.continuationBudget } : {}),
    fastGate,
    ...(sourceStudentQuestion ? { sourceStudentQuestion } : {}),
    ...(taskSources.length ? { taskSources } : {}),
    ...(latestExecution?.execution ? {
      execution: { ...latestExecution.execution, continuationKind }
    } : {}),
    priorToolLedger: ledger.rows.map((entry) => ({
      toolCallId: entry.tool_call_id,
      toolName: entry.tool_name,
      input: entry.canonical_args || {},
      output: entry.result_payload || entry.result_projection || {}
    }))
  };
}

function sanitizeModelCallLedgerEntry(entry = {}) {
  const inputPayload = sanitizeModelAuditPayload(entry.inputPayload);
  const outputPayload = sanitizeModelAuditPayload(entry.outputPayload);
  const startedAt = safeTimestamp(entry.startedAt) || new Date().toISOString();
  return {
    runId: String(entry.runId || '').replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 160),
    callId: String(entry.callId || '').replace(/[^\p{L}\p{N}:._/-]/gu, '_').slice(0, 160),
    phase: String(entry.phase || 'unclassified_model_call').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80),
    stepNumber: nonNegativeIntegerOrUndefined(entry.stepNumber) ?? 0,
    provider: String(entry.provider || '').replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 80),
    modelId: String(entry.modelId || '').replace(/[^a-zA-Z0-9:._/-]/g, '_').slice(0, 200),
    promptVersion: String(entry.promptVersion || '').replace(/[^a-zA-Z0-9:._/-]/g, '_').slice(0, 160),
    status: entry.status === 'failed' ? 'failed' : 'succeeded',
    parserStatus: ['ai_sdk_parsed', 'schema_valid', 'not_applicable', 'failed'].includes(entry.parserStatus)
      ? entry.parserStatus
      : 'not_applicable',
    inputPayload,
    outputPayload,
    inputHash: safeHash(entry.inputHash) || hashJsonValue(inputPayload),
    outputHash: safeHash(entry.outputHash) || hashJsonValue(outputPayload),
    finishReason: String(entry.finishReason || '').replace(/[\r\n\t]+/g, ' ').slice(0, 80),
    errorCategory: redactSensitiveText(String(entry.errorCategory || '')).replace(/[\r\n\t]+/g, ' ').slice(0, 240),
    usage: {
      inputTokens: number(entry.usage?.inputTokens),
      outputTokens: number(entry.usage?.outputTokens),
      reasoningTokens: number(entry.usage?.reasoningTokens),
      totalTokens: number(entry.usage?.totalTokens)
    },
    startedAt,
    completedAt: safeTimestamp(entry.completedAt) || startedAt
  };
}

function sanitizeModelAuditPayload(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { byteLength: value.byteLength, omitted: 'binary' };
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (isReasoningAuditPart(item)) return [];
      const safe = sanitizeModelAuditPayload(item, seen);
      return safe === undefined ? [] : [safe];
    });
  }
  if (!value || typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (isSecretAuditKey(normalized) || isReasoningAuditKey(normalized) || isReasoningAuditPart(item)) continue;
    const safe = sanitizeModelAuditPayload(item, seen);
    if (safe !== undefined) output[key] = safe;
  }
  seen.delete(value);
  return output;
}

function isSecretAuditKey(key) {
  return ['authorization', 'apikey', 'accesstoken', 'refreshtoken', 'password', 'secret', 'clientsecret', 'cookie', 'setcookie'].includes(key);
}

function isReasoningAuditKey(key) {
  return ['reasoning', 'reasoningcontent', 'reasoningtext', 'chainofthought'].includes(key);
}

function isReasoningAuditPart(value) {
  return Boolean(value && typeof value === 'object' && typeof value.type === 'string' && /^reasoning(?:-|$)/i.test(value.type));
}

function hashJsonValue(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')}`;
}

function redactSensitiveText(value) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-api-key]');
}

function sanitizeToolLedgerEntry(entry = {}) {
  const retainKnowledgePayload = entry.toolName === 'search_reviewed_knowledge'
    || entry.toolName === 'search_engineering_domain_evidence';
  return {
    runId: String(entry.runId || ''),
    toolCallId: String(entry.toolCallId || '').replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 160),
    toolName: String(entry.toolName || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
    argsHash: safeHash(entry.argsHash),
    status: ['started', 'succeeded', 'failed', 'cancelled', 'timed_out'].includes(entry.status) ? entry.status : 'failed',
    resultHash: safeHash(entry.resultHash),
    resultProjection: {
      participant: ['main', 'candidate', 'repair'].includes(entry.resultProjection?.participant)
        ? entry.resultProjection.participant
        : '',
      taskId: String(entry.resultProjection?.taskId || '').replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 160),
      taskRevision: number(entry.resultProjection?.taskRevision),
      roundEpoch: number(entry.resultProjection?.roundEpoch),
      validatorStatus: String(entry.resultProjection?.validatorStatus || '').slice(0, 40),
      validatorObservations: sanitizeValidatorObservations(entry.resultProjection?.validatorObservations),
      candidateId: String(entry.resultProjection?.candidateId || '').replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 160),
      candidateWorkspaceHash: safeHash(entry.resultProjection?.candidateWorkspaceHash),
      evidenceIds: Array.isArray(entry.resultProjection?.evidenceIds)
        ? entry.resultProjection.evidenceIds.slice(0, 20).map((value) => String(value).replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 120))
        : [],
      bundleId: String(entry.resultProjection?.bundleId || '').replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 160),
      baselineId: String(entry.resultProjection?.baselineId || '').replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 160),
      coverage: ['COMPLETE', 'PARTIAL', 'NONE'].includes(entry.resultProjection?.coverage)
        ? entry.resultProjection.coverage
        : '',
      sourceRegistryHash: safeHash(entry.resultProjection?.sourceRegistryHash),
      bundleContentHash: safeHash(entry.resultProjection?.bundleContentHash),
      requestedQueryHash: safeHash(entry.resultProjection?.requestedQueryHash),
      effectiveQueryHash: safeHash(entry.resultProjection?.effectiveQueryHash),
      resultHash: safeHash(entry.resultProjection?.resultHash),
      claimIds: safeIdList(entry.resultProjection?.claimIds),
      conflictIds: safeIdList(entry.resultProjection?.conflictIds),
      domainTransportStatus: ['complete', 'partial', 'unavailable'].includes(entry.resultProjection?.domainTransportStatus)
        ? entry.resultProjection.domainTransportStatus
        : '',
      domainSearchRequestCount: number(entry.resultProjection?.domainSearchRequestCount),
      domainSourceCount: number(entry.resultProjection?.domainSourceCount),
      domainSummaryChars: number(entry.resultProjection?.domainSummaryChars),
      domainWarningCodes: Array.isArray(entry.resultProjection?.domainWarningCodes)
        ? entry.resultProjection.domainWarningCodes
          .slice(0, 12)
          .map((value) => String(value).replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 160))
        : [],
      diagnosticCount: number(entry.resultProjection?.diagnosticCount),
      primaryDiagnostics: sanitizePrimaryDiagnostics(entry.resultProjection?.primaryDiagnostics),
      errorCode: String(entry.resultProjection?.errorCode || '').slice(0, 80),
      errorMessage: redactSensitiveText(String(entry.resultProjection?.errorMessage || ''))
        .replace(/[\r\n\t]+/g, ' ')
        .trim()
        .slice(0, 240)
    },
    canonicalArgs: retainKnowledgePayload ? safeJsonValue(entry.canonicalArgs) : {},
    resultPayload: retainKnowledgePayload ? safeJsonValue(entry.resultPayload) : {},
    metrics: retainKnowledgePayload ? {
      durationMs: number(entry.metrics?.durationMs),
      queryCharacters: number(entry.metrics?.queryCharacters),
      resultCharacters: number(entry.metrics?.resultCharacters),
      estimatedQueryTokens: number(entry.metrics?.estimatedQueryTokens),
      estimatedResultTokens: number(entry.metrics?.estimatedResultTokens),
      backendExecuted: entry.metrics?.backendExecuted !== false,
      duplicateQuery: entry.metrics?.duplicateQuery === true,
      replayedFromRunId: String(entry.metrics?.replayedFromRunId || '')
        .replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 160)
    } : {},
    startedAt: safeTimestamp(entry.startedAt),
    completedAt: safeTimestamp(entry.completedAt)
  };
}

function sanitizeValidatorObservations(value) {
  const outcomes = new Set([
    'admitted',
    'queue_full',
    'queue_timeout',
    'aborted_before_start',
    'aborted_after_start',
    'execution_timeout',
    'backend_unavailable'
  ]);
  return (Array.isArray(value) ? value : []).slice(0, 2).map((item, index) => ({
    attempt: number(item?.attempt) || index + 1,
    admissionOutcome: outcomes.has(item?.admissionOutcome) ? item.admissionOutcome : 'backend_unavailable',
    queueWaitMs: number(item?.queueWaitMs),
    executionMs: number(item?.executionMs),
    retryableBeforeStart: item?.retryableBeforeStart === true,
    abortedAfterStart: item?.abortedAfterStart === true
  }));
}

function sanitizePrimaryDiagnostics(value) {
  return (Array.isArray(value) ? value : []).slice(0, 3).map((item) => ({
    severity: ['error', 'warning', 'info'].includes(item?.severity) ? item.severity : 'error',
    code: String(item?.code || '').replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 120),
    message: String(item?.message || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240),
    fileId: String(item?.fileId || '').replace(/[^a-zA-Z0-9:._/-]/g, '_').slice(0, 160),
    line: number(item?.line),
    column: number(item?.column)
  }));
}

function safeIdList(value) {
  return Array.isArray(value)
    ? value.slice(0, 20).map((item) => String(item).replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 160)).filter(Boolean)
    : [];
}

function toolLedgerRow(row) {
  return sanitizeToolLedgerEntry({
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    argsHash: row.args_hash,
    status: row.status,
    resultHash: row.result_hash,
    resultProjection: row.result_projection,
    canonicalArgs: row.canonical_args,
    resultPayload: row.result_payload,
    metrics: row.metrics,
    startedAt: row.started_at,
    completedAt: row.completed_at
  });
}

function modelCallLedgerRow(row) {
  return sanitizeModelCallLedgerEntry({
    runId: row.run_id,
    callId: row.call_id,
    phase: row.phase,
    stepNumber: row.step_number,
    provider: row.provider,
    modelId: row.model_id,
    promptVersion: row.prompt_version,
    status: row.status,
    parserStatus: row.parser_status,
    inputPayload: row.input_payload,
    outputPayload: row.output_payload,
    inputHash: row.input_hash,
    outputHash: row.output_hash,
    finishReason: row.finish_reason,
    errorCategory: row.error_category,
    usage: row.usage,
    startedAt: row.started_at,
    completedAt: row.completed_at
  });
}

function intentAuditFromProviderMeta(meta, receivedQuestion) {
  const agent = meta?.agent && typeof meta.agent === 'object' ? meta.agent : {};
  const understanding = agent.mainAgentIntent;
  return {
    workflowVersion: String(agent.workflowVersion || '').slice(0, 80),
    receivedQuestionHash: typeof receivedQuestion === 'string'
      ? hashJsonValue(receivedQuestion)
      : null,
    fastGate: agent.fastGatePassThroughV2 && typeof agent.fastGatePassThroughV2 === 'object'
      ? redactMetadata(agent.fastGatePassThroughV2)
      : null,
    fastGateTrace: agent.intentV2Trace && typeof agent.intentV2Trace === 'object'
      ? redactMetadata(agent.intentV2Trace)
      : null,
    mainAgentIntent: understanding && typeof understanding === 'object'
      ? redactMetadata(understanding)
      : null,
    mainAgentDelegation: agent.mainAgentDelegation && typeof agent.mainAgentDelegation === 'object'
      ? redactMetadata(agent.mainAgentDelegation)
      : null,
    mainAgentScopeResolution: agent.mainAgentScopeResolution && typeof agent.mainAgentScopeResolution === 'object'
      ? redactMetadata(agent.mainAgentScopeResolution)
      : null,
    modelCalls: sanitizeModelCalls(agent.modelCalls || []).filter((call) => (
      call.phase === 'scope_gate_v2'
      || call.phase === 'scope_gate_v2_review'
      || call.phase === 'main_agent_intent_understanding'
      || call.phase === 'intent_orchestration_v2'
    ))
  };
}

function safeJsonValue(value) {
  if (value === undefined || value === null || value === '') return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return JSON.parse(JSON.stringify(parsed));
  } catch {
    return {};
  }
}

function toolReplayMismatchError() {
  const error = new Error('Tool call id was reused with different arguments.');
  error.code = 'TEACHER_TOOL_REPLAY_MISMATCH';
  error.statusCode = 409;
  return error;
}

function runFailureStatus(error) {
  const code = String(error?.code || '').toUpperCase();
  const statusCode = Number(error?.statusCode || error?.status || 0);
  return statusCode === 504 || code.includes('TIMEOUT') || code.includes('TIMED_OUT')
    ? 'timed_out'
    : 'failed';
}

function safeHash(value) {
  const hash = String(value || '').toLowerCase();
  if (/^sha256:[a-f0-9]{64}$/.test(hash)) return hash;
  return /^[a-f0-9]{64}$/.test(hash) ? `sha256:${hash}` : '';
}

function safeTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function redactMetadata(value) {
  if (Array.isArray(value)) return value.map(redactMetadata);
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveMetadataKey(key)) continue;
    clean[key] = redactMetadata(item);
  }
  return clean;
}

const SAFE_TOKEN_COUNTER_KEYS = new Set([
  'promptTokens',
  'completionTokens',
  'reasoningTokens',
  'totalTokens',
  'inputTokens',
  'outputTokens',
  'estimatedInputTokens',
  'maxCompletionTokens'
]);

function sensitiveMetadataKey(key) {
  if (/api[_-]?key|authorization|secret|rawProviderBody|studentCode|fullCode/i.test(key)) return true;
  if (!/token/i.test(key)) return false;
  return !SAFE_TOKEN_COUNTER_KEYS.has(key);
}

function safeId(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 120);
}

function tenantId(context) {
  return String(context?.tenant?.tenantId || process.env.AI_TEACHER_RAG_TENANT_ID || 'local-dev');
}

function userId(context) {
  return String(context?.tenant?.userId || 'unscoped-user');
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function projectPlanKey(threadId, goalContractHash) {
  return `${String(threadId || '').slice(0, 200)}:${safeHash(goalContractHash)}`;
}

function cloneBoundedProjectPayload(value) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 1_000_000) {
    const error = new Error('AI Teacher project modeling payload exceeds the persistence limit.');
    error.code = 'TEACHER_PROJECT_PAYLOAD_TOO_LARGE';
    error.statusCode = 413;
    throw error;
  }
  return JSON.parse(serialized);
}

function nonNegativeIntegerOrUndefined(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function safeErrorMessage(error) {
  return String(error?.message || 'Teacher run failed').slice(0, 500);
}

function eligibleAutomaticContinuationSource(run, { threadId, context, continuationKind }) {
  if (!run || run.threadId !== threadId || run.tenantId !== tenantId(context) || run.userId !== userId(context)) {
    return false;
  }
  return run.status === 'succeeded'
    && !run.metadata?.automaticContinuationSourceRunId
    && automaticContinuationAgentEligible(run.providerMeta?.agent, continuationKind);
}

function eligibleAutomaticContinuationSourceRow(run, continuationKind) {
  return Boolean(run)
    && run.status === 'succeeded'
    && !run.metadata?.automaticContinuationSourceRunId
    && automaticContinuationAgentEligible(run.provider_meta?.agent, continuationKind);
}

function eligibleManualContinuationSource(run, { threadId, context }) {
  return Boolean(run)
    && run.threadId === threadId
    && run.tenantId === tenantId(context)
    && run.userId === userId(context)
    && run.status === 'succeeded';
}

function eligibleManualContinuationSourceRow(run) {
  return Boolean(run) && run.status === 'succeeded';
}

function automaticContinuationAgentEligible(agent, continuationKind) {
  if (normalizeAutomaticContinuationKind(continuationKind) === ENGINEERING_IMPROVEMENT_CONTINUATION) {
    return agent?.answerCompletionStatus === 'complete'
      && agent?.engineeringImprovement?.status === 'pending';
  }
  const stopReason = String(agent?.stopReason || '');
  const stopCause = String(agent?.stopCause || '');
  return agent?.answerCompletionStatus === 'incomplete'
    && ['timeout', 'hard_timeout'].includes(stopReason)
    && ['work_deadline_reached', 'hard_deadline_reached'].includes(stopCause);
}

function normalizeAutomaticContinuationKind(value) {
  const kind = String(value || '').trim();
  return AUTOMATIC_CONTINUATION_KINDS.has(kind) ? kind : EXECUTION_COMPLETION_CONTINUATION;
}

function validateAutomaticContinuationBudget({ kind, context, continuationBudget, lineageCreatedAt }) {
  if (kind !== ENGINEERING_IMPROVEMENT_CONTINUATION) return null;
  const values = context?.runtimeAssignment?.resourcePolicySnapshot?.values || {};
  const policy = agentResourcePolicyRuntimeProjection(values).teacher;
  const runMaxDurationMs = policy.agentEngineeringImprovementRunMaxDurationMs;
  const lineageMaxDurationMs = policy.agentEngineeringImprovementLineageMaxDurationMs;
  const orchestrationReserveMs = policy.agentEngineeringImprovementOrchestrationReserveMs;
  const minimumCompleteChainMs = policy.agentEngineeringImprovementMinimumCompleteChainMs;
  const requestedDurationMs = positiveInteger(continuationBudget?.effectiveDurationMs, 0);
  const lineageStartedAtMs = Date.parse(String(lineageCreatedAt || ''));
  const elapsedMs = Number.isFinite(lineageStartedAtMs) ? Math.max(0, Date.now() - lineageStartedAtMs) : 0;
  const remainingLineageMs = Math.max(0, lineageMaxDurationMs - elapsedMs - orchestrationReserveMs);
  const effectiveDurationMs = Math.min(requestedDurationMs, runMaxDurationMs, remainingLineageMs);
  if (!requestedDurationMs || effectiveDurationMs < minimumCompleteChainMs) {
    throw automaticContinuationError('ENGINEERING_IMPROVEMENT_BUDGET_INSUFFICIENT', 409);
  }
  return Object.freeze({
    kind,
    effectiveDurationMs,
    runMaxDurationMs,
    lineageMaxDurationMs,
    orchestrationReserveMs,
    minimumCompleteChainMs,
    lineageDeadlineAt: new Date(
      (Number.isFinite(lineageStartedAtMs) ? lineageStartedAtMs : Date.now()) + lineageMaxDurationMs
    ).toISOString()
  });
}

function assertAutomaticContinuationResumeEligible(workflowResume, kind) {
  if (kind !== ENGINEERING_IMPROVEMENT_CONTINUATION) return;
  const execution = workflowResume?.execution;
  const engineering = execution?.engineering;
  const validation = engineering?.baselineValidation;
  const validationPassed = validation?.passed === true
    || validation?.validatorStatus === 'validated_passed';
  if (!execution
    || execution.decision?.stale === true
    || engineering?.status !== 'pending'
    || !engineering?.baselineCandidate
    || !validationPassed
    || !execution?.worker?.candidate
    || !execution?.worker?.validation) {
    throw automaticContinuationError('ENGINEERING_IMPROVEMENT_BASELINE_UNAVAILABLE', 409);
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeArtifactReference(value) {
  const text = String(value || '').trim();
  return /^execart_[a-zA-Z0-9-]{8,160}$/.test(text) ? text : '';
}

function safeHashValue(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^sha256:[a-f0-9]{64}$/.test(text) ? text : '';
}

function engineeringImprovementPendingResponse(response, providerMeta) {
  return (response?.continuation?.kind === ENGINEERING_IMPROVEMENT_CONTINUATION
      && response?.continuation?.status === 'automatic_pending')
    || (providerMeta?.agent?.answerCompletionStatus === 'complete'
      && providerMeta?.agent?.engineeringImprovement?.status === 'pending');
}

function visibleFallbackBaselineMessage(state, message) {
  if (message?.role !== 'assistant' || message?.status !== 'internal_baseline') return false;
  return ![...state.runs.values()].some((run) => {
    if (run.metadata?.automaticContinuationSourceRunId !== message.runId || run.status !== 'succeeded') return false;
    return (state.messages.get(run.threadId) || []).some((candidate) => (
      candidate.runId === run.runId
      && candidate.role === 'assistant'
      && candidate.status === 'succeeded'
    ));
  });
}

/**
 * 历史页面仍保留所有可见消息；进入下一次模型调用的Transcript只接收已完成回答
 * 和澄清问题。未完成的Assistant正文不是执行事实，续跑改由Checkpoint恢复。
 */
function modelConversationMessage(message) {
  if (message?.role === 'user') return Boolean(String(message.content || '').trim());
  if (message?.role !== 'assistant' || message?.status !== 'succeeded') return false;
  const completion = String(message.response?.answerCompletionStatus || '').trim();
  return !completion || completion === 'complete' || completion === 'waiting_for_clarification';
}

function buildMemoryTaskSources(state, sourceRunId) {
  const runs = [];
  let run = state.runs.get(safeId(sourceRunId));
  const visited = new Set();
  while (run && runs.length < 8 && !visited.has(run.runId)) {
    runs.push(run);
    visited.add(run.runId);
    run = state.runs.get(safeId(run.metadata?.sourceRunId));
  }
  const entries = runs.reverse().flatMap((candidateRun, index) => {
    const message = (state.messages.get(candidateRun.threadId) || []).find((entry) => (
      entry.runId === candidateRun.runId && entry.role === 'user'
    ));
    const text = boundedResumeQuestion(message?.content);
    return message?.messageId && text
      ? [{
          messageId: message.messageId,
          sourceId: message.messageId,
          relation: index === 0
            ? 'root_user_request'
            : candidateRun.metadata?.manualContinuationKind === ENGINEERING_FEEDBACK_CONTINUATION
              ? 'engineering_feedback'
              : 'clarification_user_answer',
          text,
          sourceHash: hashTextValue(text)
        }]
      : [];
  });
  return authorizeTaskSources(entries, state.runs.get(safeId(sourceRunId))?.threadId);
}

async function buildPostgresTaskSources(client, sourceRunId) {
  const result = await client.query(`
    with recursive source_lineage as (
      select run_id, thread_id, metadata, 0 as depth
      from teacher_runs where run_id = $1
      union all
      select parent.run_id, parent.thread_id, parent.metadata, child.depth + 1
      from teacher_runs parent
      join source_lineage child on parent.run_id = child.metadata ->> 'sourceRunId'
      where child.depth < 7
    )
    select lineage.run_id, lineage.thread_id, lineage.depth, lineage.metadata,
      message.message_id, message.content
    from source_lineage lineage
    join lateral (
      select message_id, content from teacher_messages
      where run_id = lineage.run_id and role = 'user'
      order by created_at asc, message_id asc limit 1
    ) message on true
    order by lineage.depth desc
  `, [sourceRunId]);
  const entries = result.rows.flatMap((row, index) => {
    const text = boundedResumeQuestion(row.content);
    return row.message_id && text
      ? [{
          messageId: row.message_id,
          sourceId: row.message_id,
          relation: index === 0
            ? 'root_user_request'
            : row.metadata?.manualContinuationKind === ENGINEERING_FEEDBACK_CONTINUATION
              ? 'engineering_feedback'
              : 'clarification_user_answer',
          text,
          sourceHash: hashTextValue(text)
        }]
      : [];
  });
  return authorizeTaskSources(entries, result.rows[0]?.thread_id);
}

function authorizeTaskSources(entries, threadId) {
  if (!entries.length) return [];
  const taskAuthorizationRevisionHash = hashJsonValue({
    version: 'teacher-task-source-set-v1',
    threadId: String(threadId || ''),
    sources: entries.map((entry) => ({
      messageId: entry.messageId,
      relation: entry.relation,
      sourceHash: entry.sourceHash
    }))
  });
  return entries.map((entry) => Object.freeze({
    ...entry,
    authorizationRevisionHash: taskAuthorizationRevisionHash,
    taskAuthorizationRevisionHash
  }));
}

function persistedTaskSourceSet(taskSources) {
  const entries = Array.isArray(taskSources) ? taskSources : [];
  return Object.freeze({
    version: 'teacher-task-source-set-v1',
    authorizationRevisionHash: safeHashValue(entries[0]?.taskAuthorizationRevisionHash),
    sources: entries.map((entry) => Object.freeze({
      messageId: String(entry.messageId || ''),
      sourceHash: safeHashValue(entry.sourceHash),
      relation: entry.relation === 'engineering_feedback'
        ? 'engineering_feedback'
        : entry.relation === 'clarification_user_answer'
          ? 'clarification_user_answer'
          : 'root_user_request'
    }))
  });
}

function assertPersistedTaskSourceSet(persisted, taskSources) {
  if (!persisted || typeof persisted !== 'object') return;
  const current = persistedTaskSourceSet(taskSources);
  if (hashJsonValue(persisted) !== hashJsonValue(current)) {
    throw automaticContinuationError('AUTOMATIC_CONTINUATION_TASK_SOURCE_MISMATCH', 409);
  }
}

function hashTextValue(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}

function automaticContinuationSourceResponse(state, sourceRun) {
  return (state.messages.get(sourceRun.threadId) || []).find((message) => (
    message.runId === sourceRun.runId
      && message.role === 'assistant'
      && ['succeeded', 'internal_baseline'].includes(message.status)
  ))?.response;
}

async function postgresAutomaticContinuationSourceResponse(client, sourceRunId) {
  const result = await client.query(`
    select response from teacher_messages
    where run_id = $1 and role = 'assistant' and status in ('succeeded', 'internal_baseline')
    order by created_at desc limit 1
  `, [sourceRunId]);
  return result.rows[0]?.response || undefined;
}

function automaticContinuationError(code, statusCode) {
  const error = new Error('Automatic continuation is unavailable.');
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function manualContinuationError(code, statusCode) {
  const error = new Error('Manual continuation is unavailable.');
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function clarificationCheckpointError(code, statusCode) {
  const error = new Error('Clarification checkpoint is unavailable.');
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function buildMemoryWorkflowResume(state, checkpoint, context, taskSourceRunId = checkpoint.sourceRunId) {
  const sourceRun = state.runs.get(checkpoint.sourceRunId);
  const fastGate = sourceRun?.providerMeta?.agent?.fastGatePassThroughV2;
  if (!fastGate) throw clarificationCheckpointError('CLARIFICATION_CHECKPOINT_UNAVAILABLE', 409);
  const priorToolLedger = [...state.toolLedger.values()]
    .filter((entry) => entry.runId === checkpoint.sourceRunId
      && ['search_reviewed_knowledge', 'search_engineering_domain_evidence'].includes(entry.toolName)
      && entry.status === 'succeeded')
    .slice(0, 22)
    .map((entry) => ({
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      input: entry.canonicalArgs || {},
      output: entry.resultPayload || entry.resultProjection || {}
    }));
  // 与PostgreSQL路径保持同一事实：澄清回答属于新恢复Run的授权来源链。
  const taskSources = buildMemoryTaskSources(state, taskSourceRunId);
  const sourceStudentQuestion = checkpoint.includeSourceStudentQuestion === true
    ? taskSources[0]?.text || boundedResumeQuestion((state.messages.get(sourceRun.threadId) || []).find((entry) => (
      entry.runId === checkpoint.sourceRunId && entry.role === 'user'
    ))?.content)
    : '';
  const latestExecution = loadLatestMemoryExecutionCheckpoint(state, checkpoint.sourceRunId, {
    currentHashes: deriveExecutionInputHashes(context)
  });
  const continuationKind = normalizeAutomaticContinuationKind(checkpoint.continuationKind);
  return {
    sourceRunId: checkpoint.sourceRunId,
    continuationKind,
    ...(checkpoint.continuationBudget ? { continuationBudget: checkpoint.continuationBudget } : {}),
    fastGate,
    ...(sourceStudentQuestion ? { sourceStudentQuestion } : {}),
    ...(taskSources.length ? { taskSources } : {}),
    ...(latestExecution?.execution ? {
      execution: { ...latestExecution.execution, continuationKind }
    } : {}),
    priorToolLedger
  };
}

async function buildPostgresManualWorkflowResume(client, rootRunId, context, options = {}) {
  const rootResult = await client.query(
    'select thread_id, provider_meta from teacher_runs where run_id = $1',
    [rootRunId]
  );
  const rootRun = rootResult.rows[0];
  const fastGate = rootRun?.provider_meta?.agent?.fastGatePassThroughV2;
  if (!fastGate) throw manualContinuationError('MANUAL_CONTINUATION_UNAVAILABLE', 409);
  const ledger = await client.query(`
    select ledger.tool_call_id, ledger.tool_name, ledger.canonical_args,
      ledger.result_payload, ledger.result_projection
    from teacher_tool_ledger ledger
    join teacher_runs run on run.run_id = ledger.run_id
    where (run.run_id = $1 or run.metadata ->> 'continuationRootRunId' = $1)
      and ledger.tool_name in ('search_reviewed_knowledge', 'search_engineering_domain_evidence')
      and ledger.status = 'succeeded'
    order by ledger.started_at desc nulls last, ledger.tool_call_id desc
    limit 22
  `, [rootRunId]);
  const sourceStudentQuestion = await postgresSourceStudentQuestion(client, rootRunId);
  const latestExecution = options.continuationKind === ENGINEERING_FEEDBACK_CONTINUATION
    ? await loadPostgresEngineeringFeedbackExecution(client, rootRunId, context)
    : await loadLatestPostgresExecutionCheckpointWithClient(
        client,
        rootRunId,
        { currentHashes: deriveExecutionInputHashes(context) }
      );
  if (!latestExecution?.execution || !sourceStudentQuestion) {
    throw manualContinuationError('MANUAL_CONTINUATION_UNAVAILABLE', 409);
  }
  const taskSources = options.continuationKind === ENGINEERING_FEEDBACK_CONTINUATION
    ? appendEngineeringFeedbackTaskSource(
        await buildPostgresTaskSources(client, options.sourceRunId),
        context,
        options.feedbackMessageId,
        rootRun.thread_id
      )
    : await buildPostgresTaskSources(client, options.sourceRunId);
  const priorSuggestions = options.continuationKind === ENGINEERING_FEEDBACK_CONTINUATION
    ? publicEngineeringSuggestions((await postgresLatestLineageSourceResponse(client, rootRunId))?.engineeringReview?.openSuggestions)
    : [];
  return {
    sourceRunId: rootRunId,
    continuationKind: options.continuationKind === ENGINEERING_FEEDBACK_CONTINUATION
      ? ENGINEERING_IMPROVEMENT_CONTINUATION
      : EXECUTION_COMPLETION_CONTINUATION,
    fastGate,
    sourceStudentQuestion,
    ...(taskSources.length ? { taskSources } : {}),
    execution: options.continuationKind === ENGINEERING_FEEDBACK_CONTINUATION
      ? engineeringFeedbackExecution(latestExecution.execution, priorSuggestions)
      : latestExecution.execution,
    priorToolLedger: ledger.rows.reverse().map((entry) => ({
      toolCallId: entry.tool_call_id,
      toolName: entry.tool_name,
      input: entry.canonical_args || {},
      output: entry.result_payload || entry.result_projection || {}
    }))
  };
}

async function postgresLatestLineageSourceResponse(client, rootRunId, excludeRunId = '') {
  const result = await client.query(`
    select message.response
    from teacher_messages message
    join teacher_runs run on run.run_id = message.run_id
    where message.role = 'assistant' and message.status = 'succeeded'
      and (run.run_id = $1 or run.metadata ->> 'continuationRootRunId' = $1)
      and ($2 = '' or run.run_id <> $2)
    order by message.created_at desc, message.message_id desc
    limit 1
  `, [rootRunId, excludeRunId]);
  return result.rows[0]?.response || undefined;
}

function buildMemoryManualWorkflowResume(state, rootRunId, context, options = {}) {
  const rootRun = state.runs.get(rootRunId);
  const fastGate = rootRun?.providerMeta?.agent?.fastGatePassThroughV2;
  if (!fastGate) throw manualContinuationError('MANUAL_CONTINUATION_UNAVAILABLE', 409);
  const lineageRunIds = new Set([...state.runs.values()]
    .filter((run) => memoryExecutionRootRunId(state, run) === rootRunId)
    .map((run) => run.runId));
  const priorToolLedger = [...state.toolLedger.values()]
    .filter((entry) => lineageRunIds.has(entry.runId)
      && ['search_reviewed_knowledge', 'search_engineering_domain_evidence'].includes(entry.toolName)
      && entry.status === 'succeeded')
    .slice(-22)
    .map((entry) => ({
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      input: entry.canonicalArgs || {},
      output: entry.resultPayload || entry.resultProjection || {}
    }));
  const sourceStudentQuestion = boundedResumeQuestion((state.messages.get(rootRun.threadId) || []).find((entry) => (
    entry.runId === rootRunId && entry.role === 'user'
  ))?.content);
  const latestExecution = options.continuationKind === ENGINEERING_FEEDBACK_CONTINUATION
    ? loadMemoryEngineeringFeedbackExecution(state, rootRunId, context)
    : loadLatestMemoryExecutionCheckpoint(state, rootRunId, {
        currentHashes: deriveExecutionInputHashes(context)
      });
  if (!latestExecution?.execution || !sourceStudentQuestion) {
    throw manualContinuationError('MANUAL_CONTINUATION_UNAVAILABLE', 409);
  }
  const taskSources = options.continuationKind === ENGINEERING_FEEDBACK_CONTINUATION
    ? appendEngineeringFeedbackTaskSource(
        buildMemoryTaskSources(state, options.sourceRunId),
        context,
        options.feedbackMessageId,
        rootRun.threadId
      )
    : buildMemoryTaskSources(state, options.sourceRunId);
  const priorSuggestions = options.continuationKind === ENGINEERING_FEEDBACK_CONTINUATION
    ? publicEngineeringSuggestions(latestMemoryLineageSourceResponse(state, rootRunId)?.engineeringReview?.openSuggestions)
    : [];
  return {
    sourceRunId: rootRunId,
    continuationKind: options.continuationKind === ENGINEERING_FEEDBACK_CONTINUATION
      ? ENGINEERING_IMPROVEMENT_CONTINUATION
      : EXECUTION_COMPLETION_CONTINUATION,
    fastGate,
    sourceStudentQuestion,
    ...(taskSources.length ? { taskSources } : {}),
    execution: options.continuationKind === ENGINEERING_FEEDBACK_CONTINUATION
      ? engineeringFeedbackExecution(latestExecution.execution, priorSuggestions)
      : latestExecution.execution,
    priorToolLedger
  };
}

function loadMemoryEngineeringFeedbackExecution(state, rootRunId, context) {
  const latest = loadLatestMemoryExecutionCheckpoint(state, rootRunId);
  return validateEngineeringFeedbackExecution(latest, context);
}

async function loadPostgresEngineeringFeedbackExecution(client, rootRunId, context) {
  const latest = await loadLatestPostgresExecutionCheckpointWithClient(client, rootRunId);
  return validateEngineeringFeedbackExecution(latest, context);
}

function validateEngineeringFeedbackExecution(latest, context) {
  const execution = latest?.execution;
  const current = deriveExecutionInputHashes(context);
  if (!execution
    || execution.decision?.stale === true
    || execution.decision?.phase !== 'completed'
    || execution.decision?.taskContractHash !== current.taskContractHash
    || execution.decision?.editorBaseHash !== current.editorBaseHash
    || !execution.worker?.candidate
    || !execution.worker?.validation
    || !execution.decision?.candidateArtifactId
    || !execution.decision?.validationArtifactId) {
    throw manualContinuationError('ENGINEERING_FEEDBACK_VERSION_CONFLICT', 409);
  }
  const validation = execution.worker.validation;
  const passed = validation?.passed === true
    || validation?.validatorStatus === 'validated_passed'
    || (validation?.completeness === 'complete'
      && validation?.official?.syntax === 'passed'
      && validation?.official?.semantic === 'passed');
  if (!passed) throw manualContinuationError('ENGINEERING_FEEDBACK_BASELINE_UNAVAILABLE', 409);
  return latest;
}

function engineeringFeedbackExecution(execution, priorSuggestions = []) {
  return Object.freeze({
    ...execution,
    continuationKind: ENGINEERING_IMPROVEMENT_CONTINUATION,
    decision: Object.freeze({
      ...execution.decision,
      phase: 'engineering_improvement_pending',
      allowedActions: Object.freeze(['engineering_resume']),
      stale: false,
      staleReasons: Object.freeze([]),
      repairRound: 0,
      continuationKind: ENGINEERING_IMPROVEMENT_CONTINUATION,
    }),
    engineering: Object.freeze({
      status: 'pending',
      continuationKind: ENGINEERING_IMPROVEMENT_CONTINUATION,
      baselineCandidateArtifactId: execution.decision.candidateArtifactId,
      baselineValidationArtifactId: execution.decision.validationArtifactId,
      assessmentCount: 0,
      mainReentryCount: 0,
      revisionCount: 0,
      verificationCount: 0,
      verification: 'not_run',
      revisionDelivered: false,
      revisionAdopted: false,
      taskGoalRefs: [],
      issueSummaries: [],
      openSuggestions: [],
      previousSuggestions: publicEngineeringSuggestions(priorSuggestions),
      baselineCandidate: execution.worker.candidate,
      baselineValidation: execution.worker.validation,
    }),
  });
}

function publicEngineeringSuggestions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 4).flatMap((item) => {
    const publicSuggestionId = String(item?.publicSuggestionId || '').slice(0, 200);
    const summary = String(item?.summary || '').trim().slice(0, 500);
    return publicSuggestionId && summary ? [{ publicSuggestionId, summary }] : [];
  });
}

function appendEngineeringFeedbackTaskSource(taskSources, context, messageId, threadId) {
  const text = boundedResumeQuestion(context?.question?.text);
  if (!text || !/^msg_[a-zA-Z0-9-]{8,160}$/.test(String(messageId || ''))) {
    throw manualContinuationError('ENGINEERING_FEEDBACK_INVALID', 400);
  }
  const entries = (Array.isArray(taskSources) ? taskSources : []).slice(0, 7).map((source) => ({
    messageId: source.messageId,
    sourceId: source.sourceId,
    relation: source.relation,
    text: source.text,
    sourceHash: source.sourceHash,
  }));
  entries.push({
    messageId,
    sourceId: messageId,
    relation: 'engineering_feedback',
    text,
    sourceHash: hashTextValue(text),
  });
  return authorizeTaskSources(entries, threadId);
}

function assertMemoryEngineeringFeedbackSource(state, sourceRun, rootRunId) {
  const latest = [...(state.messages.get(sourceRun.threadId) || [])].reverse().find((message) => {
    const run = state.runs.get(message.runId);
    return message.role === 'assistant'
      && message.status === 'succeeded'
      && run?.status === 'succeeded'
      && memoryExecutionRootRunId(state, run) === rootRunId;
  });
  const response = (state.messages.get(sourceRun.threadId) || []).find((message) => (
    message.runId === sourceRun.runId && message.role === 'assistant' && message.status === 'succeeded'
  ))?.response;
  if (latest?.runId !== sourceRun.runId
    || response?.validatorStatus !== 'validated_passed'
    || response?.engineeringReview?.canContinue !== true) {
    throw manualContinuationError('ENGINEERING_FEEDBACK_SOURCE_STALE', 409);
  }
}

async function assertPostgresEngineeringFeedbackSource(client, sourceRun, rootRunId) {
  const latest = await client.query(`
    select run.run_id, message.response
    from teacher_runs run
    join lateral (
      select response, created_at, message_id from teacher_messages
      where run_id = run.run_id and role = 'assistant' and status = 'succeeded'
      order by created_at desc, message_id desc limit 1
    ) message on true
    where run.status = 'succeeded'
      and (run.run_id = $1 or run.metadata ->> 'continuationRootRunId' = $1)
    order by message.created_at desc, message.message_id desc
    limit 1
  `, [rootRunId]);
  const row = latest.rows[0];
  if (row?.run_id !== sourceRun.run_id
    || row?.response?.validatorStatus !== 'validated_passed'
    || row?.response?.engineeringReview?.canContinue !== true) {
    throw manualContinuationError('ENGINEERING_FEEDBACK_SOURCE_STALE', 409);
  }
}

function normalizeManualContinuationKind(value) {
  return value === ENGINEERING_FEEDBACK_CONTINUATION
    ? ENGINEERING_FEEDBACK_CONTINUATION
    : EXECUTION_COMPLETION_CONTINUATION;
}

function assertMemoryLatestExecutionContinuationSource(state, sourceRun, rootRunId) {
  const latest = [...(state.messages.get(sourceRun.threadId) || [])].reverse().find((message) => {
    const run = state.runs.get(message.runId);
    return message.role === 'assistant'
      && message.status === 'succeeded'
      && run?.status === 'succeeded'
      && memoryExecutionRootRunId(state, run) === rootRunId;
  });
  const response = memoryRunSourceResponse(state, sourceRun.runId);
  const completedReplayAvailable = loadLatestMemoryExecutionCheckpoint(state, rootRunId)
    ?.execution?.decision?.phase === 'completed';
  if (latest?.runId !== sourceRun.runId
    || !executionContinuationResponseEligible(response, completedReplayAvailable)) {
    throw manualContinuationError('MANUAL_CONTINUATION_SOURCE_STALE', 409);
  }
}

function executionCheckpointPhaseSqlList() {
  return [...EXECUTION_PHASES]
    .map((phase) => `'${String(phase).replaceAll("'", "''")}'`)
    .join(', ');
}

function executionCheckpointPhaseConstraintSql() {
  return `
    alter table teacher_execution_checkpoints
      drop constraint if exists teacher_execution_checkpoints_phase_check,
      add constraint teacher_execution_checkpoints_phase_check
      check (phase in (${executionCheckpointPhaseSqlList()}))
  `;
}

async function assertPostgresLatestExecutionContinuationSource(client, sourceRun, rootRunId) {
  const latest = await client.query(`
    select run.run_id, message.response
    from teacher_runs run
    join teacher_messages message on message.run_id = run.run_id
      and message.role = 'assistant' and message.status = 'succeeded'
    where run.status = 'succeeded'
      and (run.run_id = $1 or run.metadata ->> 'continuationRootRunId' = $1)
    order by message.created_at desc, message.message_id desc
    limit 1
  `, [rootRunId]);
  const completedReplayAvailable = (await loadLatestPostgresExecutionCheckpointWithClient(client, rootRunId))
    ?.execution?.decision?.phase === 'completed';
  if (latest.rows[0]?.run_id !== sourceRun.run_id
    || !executionContinuationResponseEligible(latest.rows[0]?.response, completedReplayAvailable)) {
    throw manualContinuationError('MANUAL_CONTINUATION_SOURCE_STALE', 409);
  }
}

function executionContinuationResponseEligible(response, completedReplayAvailable = false) {
  if (response?.answerCompletionStatus === 'complete') return completedReplayAvailable === true;
  return response?.answerCompletionStatus === 'incomplete'
    && response?.continuation?.kind === EXECUTION_COMPLETION_CONTINUATION
    && response?.continuation?.status === 'user_confirmation_required'
    && response?.continuation?.canContinue === true;
}

function latestMemoryLineageSourceResponse(state, rootRunId, excludeRunId = '') {
  const rootRun = state.runs.get(rootRunId);
  if (!rootRun) return undefined;
  return [...(state.messages.get(rootRun.threadId) || [])].reverse().find((message) => {
    const messageRun = state.runs.get(message.runId);
    return message.role === 'assistant'
      && message.status === 'succeeded'
      && message.runId !== excludeRunId
      && memoryExecutionRootRunId(state, messageRun) === rootRunId;
  })?.response;
}

function memoryRunSourceResponse(state, runId) {
  const run = state.runs.get(safeId(runId));
  if (!run) return undefined;
  return [...(state.messages.get(run.threadId) || [])].reverse().find((message) => (
    message.runId === run.runId
    && message.role === 'assistant'
    && message.status === 'succeeded'
  ))?.response;
}

async function postgresRunSourceResponse(client, runId) {
  const result = await client.query(`
    select response from teacher_messages
    where run_id = $1 and role = 'assistant' and status = 'succeeded'
    order by created_at desc, message_id desc limit 1
  `, [runId]);
  return result.rows[0]?.response || undefined;
}

function boundedResumeQuestion(value) {
  return String(value || '').trim().slice(0, STUDENT_QUESTION_PROTOCOL_CEILING);
}

const TERMINAL_AUDIT_EVENT_TYPES = new Set([
  'teacher.run.succeeded',
  'teacher.run.degraded',
  'teacher.run.failed',
  'teacher.run.timed_out',
  'teacher.run.cancelled'
]);

function failureObservabilityOptions(options = {}) {
  return {
    windowHours: boundedPositiveInteger(options.windowHours, 24, 168),
    limit: boundedPositiveInteger(options.limit, 40, 100),
    tenantId: String(options.tenantId || '').slice(0, 160),
    observationEnabled: options.observationEnabled !== false
  };
}

async function postgresSourceStudentQuestion(client, sourceRunId) {
  const result = await client.query(`
    select content from teacher_messages
    where run_id = $1 and role = 'user'
    order by created_at asc limit 1
  `, [sourceRunId]);
  return boundedResumeQuestion(result.rows[0]?.content);
}

function failureObservabilitySnapshot(events, options = {}) {
  const normalized = failureObservabilityOptions(options);
  const cutoff = Date.now() - normalized.windowHours * 60 * 60 * 1000;
  const terminal = (Array.isArray(events) ? events : [])
    .filter((event) => TERMINAL_AUDIT_EVENT_TYPES.has(String(event?.eventType || '')))
    .filter((event) => !normalized.tenantId || event.tenantId === normalized.tenantId)
    .filter((event) => {
      const createdAt = Date.parse(event?.createdAt || '');
      return Number.isFinite(createdAt) && createdAt >= cutoff;
    })
    .sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''));
  const counts = {
    succeeded: terminal.filter((event) => event.eventType === 'teacher.run.succeeded').length,
    degraded: terminal.filter((event) => event.eventType === 'teacher.run.degraded').length,
    failed: terminal.filter((event) => event.eventType === 'teacher.run.failed').length,
    timedOut: terminal.filter((event) => event.eventType === 'teacher.run.timed_out').length,
    cancelled: terminal.filter((event) => event.eventType === 'teacher.run.cancelled').length
  };
  const total = terminal.length;
  const resultReturned = counts.succeeded + counts.degraded;
  const reasonCountMap = new Map();
  for (const event of terminal) {
    for (const reasonCode of auditReasonCodes(event)) {
      reasonCountMap.set(reasonCode, (reasonCountMap.get(reasonCode) || 0) + 1);
    }
  }
  const reasonCounts = [...reasonCountMap.entries()]
    .map(([reasonCode, count]) => ({ reasonCode, count }))
    .sort((left, right) => right.count - left.count || left.reasonCode.localeCompare(right.reasonCode))
    .slice(0, 20);
  return {
    generatedAt: new Date().toISOString(),
    windowHours: normalized.windowHours,
    refreshAfterMs: 60_000,
    observationEnabled: normalized.observationEnabled,
    status: !normalized.observationEnabled
      ? 'unavailable'
      : counts.failed + counts.timedOut > 0 ? 'incident' : counts.degraded > 0 ? 'degraded' : 'healthy',
    summary: {
      totalTerminalRuns: total,
      frontendResultReturned: resultReturned,
      complete: counts.succeeded,
      degraded: counts.degraded,
      failed: counts.failed,
      timedOut: counts.timedOut,
      cancelled: counts.cancelled,
      frontendDeliveryRate: total > 0 ? resultReturned / total : 1,
      degradationRate: resultReturned > 0 ? counts.degraded / resultReturned : 0
    },
    reasonCounts,
    recent: terminal.slice(0, normalized.limit).map((event) => ({
      runId: String(event.runId || '').slice(0, 160),
      requestId: String(event.requestId || '').slice(0, 160),
      status: auditDeliveryStatus(event),
      frontendResultReturned: event.metadata?.delivery?.frontendResultReturned === true,
      answerCompletionStatus: safeOperationalCode(event.metadata?.delivery?.answerCompletionStatus),
      stopReason: safeOperationalCode(event.metadata?.delivery?.stopReason),
      validatorStatus: safeOperationalCode(event.metadata?.delivery?.validatorStatus),
      reasonCodes: auditReasonCodes(event),
      createdAt: safeTimestamp(event.createdAt)
    }))
  };
}

function auditDeliveryStatus(event) {
  if (event.eventType === 'teacher.run.degraded') return 'degraded';
  if (event.eventType === 'teacher.run.succeeded') return 'succeeded';
  if (event.eventType === 'teacher.run.timed_out') return 'timed_out';
  if (event.eventType === 'teacher.run.cancelled') return 'cancelled';
  return 'failed';
}

function auditReasonCodes(event) {
  const deliveryCodes = Array.isArray(event?.metadata?.delivery?.reasonCodes)
    ? event.metadata.delivery.reasonCodes.map(safeReasonCode).filter(Boolean)
    : [];
  const failureCode = safeReasonCode(event?.metadata?.code);
  return [...new Set([
    ...deliveryCodes,
    ...(failureCode ? [failureCode] : [])
  ])].slice(0, 16);
}

function safeReasonCode(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160);
}

function taskLifecycleContractId(rootRunId) {
  return `task_contract_${crypto.createHash('sha256').update(String(rootRunId)).digest('hex').slice(0, 24)}`;
}

function taskLifecycleCreationEvent(contract, sourceRunId) {
  return Object.freeze({
    version: 'teacher-task-lifecycle-event-v1',
    eventId: `tcevt_${crypto.createHash('sha256').update(`${contract.contractId}:0:created`).digest('hex').slice(0, 24)}`,
    contractId: contract.contractId,
    lineageId: contract.lineageId,
    revision: 0,
    eventType: 'created',
    actor: { type: 'server', id: '' },
    sourceRunId: String(sourceRunId || ''),
    payload: { rootGoalId: contract.rootGoalId },
    resultingStatus: contract.status,
    resultingSnapshotHash: contract.snapshotHash,
    createdAt: contract.createdAt
  });
}

function taskLifecycleStoreError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(parsed)));
}

module.exports = {
  createConversationStore,
  createMemoryConversationStore,
  createPostgresConversationStore,
  migrateTeacherConversationStore,
  conversationStoreTesting: Object.freeze({
    boundedResumeQuestion,
    executionCheckpointPhaseConstraintSql,
    executionCheckpointPhaseSqlList
  })
};
