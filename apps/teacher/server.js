'use strict';

const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');
const {
  CONTRACT_VERSION,
  DEFAULT_MAX_REQUEST_BYTES,
  validateHostContextEnvelope,
  validateTeacherCapabilityResponse,
  validateSingleLinePatchSuggestion,
  applySingleLinePatchSuggestion,
  validateRequestSize,
  redactSecrets,
  publicError,
  validateModelCapabilitySnapshot
} = require('../../packages/teacher-contract');
const { createTeacherRetriever, retrieverStatus } = require('./retriever');
const {
  createLlmConfig,
  llmPublicState,
  callOpenAiCompatible,
  callOpenAiCompatibleStream
} = require('./llm-provider');
const { createProviderResilienceGateway } = require('./provider-resilience');
const { createConversationStore } = require('./conversation-store');
const { createSkillSourceAdapter } = require('./skill-source');
const {
  createDeepSeekWebSearchConfig,
  deepSeekWebSearchPublicState
} = require('./deepseek-web-search');
const {
  createWebSearchProbeController,
  createWebSearchProbePolicyConfig
} = require('./web-search-probe-policy');
const {
  agentRuntimeReadiness,
  executionValidationIdentityForContext,
  frozenAgentWorkflowVersion,
  recoverPersistedCompletedCandidateDelivery,
  runAgentCapability
} = require('./agent-adapter');
const { deriveExecutionInputHashes } = require('./execution-checkpoint');
const {
  SCHEMA_VERSION: AGENT_RESOURCE_POLICY_SCHEMA_VERSION,
  BOOTSTRAP_VALUES: AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES,
  createPolicySnapshot: createAgentResourcePolicySnapshot,
  validatePolicySnapshot: validateAgentResourcePolicySnapshot,
  runtimeProjection: agentResourcePolicyRuntimeProjection
} = require('../../packages/agent-resource-policy');

const PORT = Number(process.env.PORT || 7070);
const HOST = process.env.HOST || '0.0.0.0';
const AGENT_TOOL_SCHEMA_VERSION = 'single-entry-v3';
const TEACHER_BUILD_VERSION = process.env.AI_TEACHER_BUILD_VERSION || 'single-entry-project-p1-v1';

function createServer(options = {}) {
  const config = createConfig(options);

  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'OPTIONS') return send(res, 204, {}, config);

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, await health(config), config);
      }

      if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
        return send(res, 200, await capabilities(config), config);
      }

      if (req.method === 'GET' && url.pathname === '/v1/admin/failure-observability') {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        return send(res, 200, await config.conversation.getFailureObservability({
          windowHours: url.searchParams.get('windowHours') || 24,
          limit: url.searchParams.get('limit') || 40
        }), config);
      }

      if (req.method === 'GET' && url.pathname === '/v1/admin/execution-checkpoints') {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const runId = String(url.searchParams.get('runId') || '').trim();
        if (!/^run_[a-zA-Z0-9-]{8,160}$/u.test(runId)) {
          return send(res, 400, publicError('INVALID_RUN_ID', 'runId is invalid', 400), config);
        }
        return send(res, 200, await executionCheckpointObservability(config, runId), config);
      }

      if (req.method === 'GET' && url.pathname === '/v1/admin/resource-policy/state') {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        return send(res, 200, resourcePolicyOwnerState(config), config);
      }

      if (req.method === 'POST' && url.pathname === '/v1/admin/resource-policy/stage') {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const payload = await readJson(req, config.maxRequestBytes);
        return send(res, 200, stageResourcePolicy(config, payload.snapshot), config);
      }

      if (req.method === 'POST' && url.pathname === '/v1/admin/resource-policy/activate') {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const payload = await readJson(req, config.maxRequestBytes);
        return send(res, 200, activateResourcePolicy(config, payload.snapshot), config);
      }

      if (req.method === 'PATCH' && url.pathname === '/v1/admin/domain-web-search') {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const payload = domainWebSearchControlPayload(await readJson(req, config.maxRequestBytes));
        const result = payload.enabled
          ? await config.domainWebSearchProbe.enableAndProbe()
          : await config.domainWebSearchProbe.disable();
        return send(res, 200, result, config);
      }

      if (req.method === 'POST' && url.pathname === '/v1/admin/domain-web-search/probe') {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        domainWebSearchProbePayload(await readJson(req, config.maxRequestBytes));
        return send(res, 200, await config.domainWebSearchProbe.probe(), config);
      }

      if (url.pathname === '/v1/retrieval/debug' || url.pathname === '/v1/teacher/retrieve-debug') {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const payload = req.method === 'POST' ? await readJson(req, config.maxRequestBytes) : {};
        const query = payload.query || url.searchParams.get('q') || '';
        return send(res, 200, await config.knowledge.debug(query, payload.context || {}, { limit: payload.limit || 5 }), config);
      }

      if (req.method === 'POST' && url.pathname === '/v1/teacher/answer') {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const payload = await readJson(req, config.maxRequestBytes);
        return await handleTeacherRequest(req, res, payload, config, answerCapability);
      }

      if (req.method === 'POST' && url.pathname === '/v1/teacher/answer-stream') {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const payload = await readJson(req, config.maxRequestBytes);
        return await handleTeacherStreamRequest(req, res, payload, config, answerCapability, 'answerCapability');
      }

      const threadMessagesMatch = url.pathname.match(/^\/v1\/teacher\/threads\/([^/]+)\/messages$/);
      const threadMatch = url.pathname.match(/^\/v1\/teacher\/threads\/([^/]+)$/);
      const messageFeedbackMatch = url.pathname.match(/^\/v1\/teacher\/messages\/([^/]+)\/feedback$/);
      const clarificationCancelMatch = url.pathname.match(/^\/v1\/teacher\/clarifications\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && url.pathname === '/v1/teacher/threads') {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const payload = await readJson(req, config.maxRequestBytes);
        const context = payload?.context && typeof payload.context === 'object' ? payload.context : {};
        const thread = await config.conversation.createThread(context);
        return send(res, 201, thread, config);
      }

      if (req.method === 'GET' && url.pathname === '/v1/teacher/threads') {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const context = contextFromQuery(url);
        const threads = await config.conversation.listThreads(context, {
          scope: url.searchParams.get('scope') || 'current',
          limit: url.searchParams.get('limit') || 50,
          contextLimitTokens: config.agentContextWindowTokens
        });
        return send(res, 200, { threads }, config);
      }

      if (req.method === 'DELETE' && threadMatch) {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const context = contextFromQuery(url);
        const outcome = await config.conversation.deleteThread(context, threadMatch[1]);
        if (outcome.reason === 'active_run') {
          return send(res, 409, publicError('THREAD_HAS_ACTIVE_RUN', 'Teacher thread has an active run', 409), config);
        }
        if (!outcome.deleted) {
          return send(res, 404, publicError('THREAD_NOT_FOUND', 'Teacher thread not found', 404), config);
        }
        return send(res, 200, { deleted: true, threadId: outcome.threadId }, config);
      }

      if (req.method === 'GET' && threadMessagesMatch) {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const context = contextFromQuery(url);
        const threads = await config.conversation.listThreads(context, {
          scope: 'all',
          limit: 100,
          contextLimitTokens: config.agentContextWindowTokens
        });
        if (!threads.some((thread) => thread.threadId === threadMessagesMatch[1])) {
          return send(res, 404, publicError('THREAD_NOT_FOUND', 'Teacher thread not found', 404), config);
        }
        const messages = await config.conversation.listMessages(threadMessagesMatch[1], {
          limit: url.searchParams.get('limit') || 50
        });
        return send(res, 200, { threadId: threadMessagesMatch[1], messages }, config);
      }

      if (req.method === 'POST' && messageFeedbackMatch) {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const payload = await readJson(req, config.maxRequestBytes);
        const outcome = ['resolved', 'unresolved'].includes(payload?.outcome) ? payload.outcome : '';
        if (!outcome) return send(res, 400, publicError('INVALID_MESSAGE_FEEDBACK', 'outcome must be resolved or unresolved', 400), config);
        const context = payload?.context && typeof payload.context === 'object' ? payload.context : {};
        const feedback = await config.conversation.recordMessageFeedback({
          messageId: messageFeedbackMatch[1],
          context,
          outcome,
          reasonCodes: Array.isArray(payload.reasonCodes)
            ? [...new Set(payload.reasonCodes.map(String).filter((item) => /^[a-z0-9_-]{1,80}$/u.test(item)))].slice(0, 8)
            : [],
          judgeVersion: String(payload.judgeVersion || '').slice(0, 120),
          judgeLabel: ['high', 'medium', 'uncertain'].includes(payload.judgeLabel) ? payload.judgeLabel : ''
        });
        if (!feedback) return send(res, 404, publicError('MESSAGE_NOT_FOUND', 'Teacher message not found', 404), config);
        return send(res, 200, { feedback }, config);
      }

      const knowledgeAuditMatch = url.pathname.match(/^\/v1\/teacher\/runs\/([^/]+)\/knowledge-audit$/);
      const intentAuditMatch = url.pathname.match(/^\/v1\/teacher\/runs\/([^/]+)\/intent-audit$/);
      const runEventsMatch = url.pathname.match(/^\/v1\/teacher\/runs\/([^/]+)\/events$/);
      const runMatch = url.pathname.match(/^\/v1\/teacher\/runs\/([^/]+)$/);
      if (req.method === 'GET' && knowledgeAuditMatch) {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const context = contextFromQuery(url);
        const runId = knowledgeAuditMatch[1];
        const run = await config.conversation.getRun(runId);
        if (!run || !runMatchesContext(run, context)) {
          return send(res, 404, publicError('RUN_NOT_FOUND', 'Teacher run not found', 404), config);
        }
        const entries = await config.conversation.listToolLedgerEntries(runId, {
          toolName: 'search_reviewed_knowledge'
        });
        return send(res, 200, {
          runId,
          queryCount: entries.length,
          entries
        }, config);
      }

      if (req.method === 'POST' && clarificationCancelMatch) {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const payload = await readJson(req, config.maxRequestBytes);
        const context = payload?.context && typeof payload.context === 'object' ? payload.context : {};
        const cancelled = await config.conversation.cancelClarificationCheckpoint({
          checkpointId: clarificationCancelMatch[1],
          threadId: String(payload.threadId || ''),
          context
        });
        return send(res, 200, { clarification: cancelled }, config);
      }
      if (req.method === 'GET' && intentAuditMatch) {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const context = contextFromQuery(url);
        const runId = intentAuditMatch[1];
        const run = await config.conversation.getRun(runId);
        if (!run || !runMatchesContext(run, context)) {
          return send(res, 404, publicError('RUN_NOT_FOUND', 'Teacher run not found', 404), config);
        }
        if (typeof config.conversation.getRunIntentAudit !== 'function') {
          return send(res, 503, publicError('INTENT_AUDIT_UNAVAILABLE', 'Main Agent intent audit is unavailable', 503), config);
        }
        const audit = await config.conversation.getRunIntentAudit(runId);
        return send(res, 200, { runId, audit }, config);
      }
      if (req.method === 'GET' && runEventsMatch) {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const context = contextFromQuery(url);
        const run = await config.conversation.getRun(runEventsMatch[1]);
        if (!run || !runMatchesContext(run, context)) return send(res, 404, publicError('RUN_NOT_FOUND', 'Teacher run not found', 404), config);
        const events = await config.conversation.listRunEvents(runEventsMatch[1], {
          afterSeq: url.searchParams.get('afterSeq') || 0
        });
        return send(res, 200, { runId: runEventsMatch[1], events: events.map(browserRunEvent) }, config);
      }

      if (req.method === 'GET' && runMatch) {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const context = contextFromQuery(url);
        const run = await config.conversation.getRun(runMatch[1]);
        if (!run || !runMatchesContext(run, context)) return send(res, 404, publicError('RUN_NOT_FOUND', 'Teacher run not found', 404), config);
        return send(res, 200, { run }, config);
      }

      const runCancelMatch = url.pathname.match(/^\/v1\/teacher\/runs\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && runCancelMatch) {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const context = contextFromQuery(url);
        const run = await config.conversation.getRun(runCancelMatch[1]);
        if (!run || !runMatchesContext(run, context)) return send(res, 404, publicError('RUN_NOT_FOUND', 'Teacher run not found', 404), config);
        const active = config.activeRuns.get(runCancelMatch[1]);
        if (active && !active.controller.signal.aborted) {
          active.controller.abort(Object.assign(new Error('Teacher run cancelled'), {
            code: 'TEACHER_RUN_CANCELLED',
            statusCode: 499
          }));
        }
        const cancelled = await config.conversation.cancelRun({
          runId: runCancelMatch[1],
          error: Object.assign(new Error('Teacher run cancelled'), {
            code: 'TEACHER_RUN_CANCELLED',
            statusCode: 499
          })
        });
        if (!cancelled) return send(res, 404, publicError('RUN_NOT_FOUND', 'Teacher run not found', 404), config);
        return send(res, 200, { run: cancelled }, config);
      }

      if (req.method === 'POST' && url.pathname === '/v1/teacher/validate-patch') {
        const authError = requireInternalToken(req, config);
        if (authError) return send(res, authError.status, authError.body, config);
        const payload = await readJson(req, config.maxRequestBytes);
        return send(res, 200, validateSingleLinePatchPayload(payload), config);
      }

      return send(res, 404, publicError('NOT_FOUND', 'Route not found', 404), config);
    } catch (error) {
      const status = error.statusCode || 500;
      const code = error.code || (status === 413 ? 'REQUEST_TOO_LARGE' : status === 400 ? 'INVALID_JSON' : 'INTERNAL_ERROR');
      const message = status === 500 ? 'Teacher service failed to process the request' : error.message;
      logRequest(req, url, status, startedAt, config, error);
      return send(res, status, publicError(code, message, status), config);
    }
  });
}

function createConfig(options) {
  const providerMode = String(options.providerMode || process.env.AI_TEACHER_PROVIDER || 'litellm-compatible').toLowerCase();
  const llm = createLlmConfig({ ...options, providerMode });
  const bootstrapResourcePolicySnapshot = createAgentResourcePolicySnapshot({
    versionId: `arp_bootstrap_v${AGENT_RESOURCE_POLICY_SCHEMA_VERSION}`,
    values: AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES,
    frozenAt: new Date(0).toISOString()
  });
  const bootstrapResourcePolicyProjection = agentResourcePolicyRuntimeProjection(bootstrapResourcePolicySnapshot.values);
  const envEnabled = process.env.AI_TEACHER_ENABLED;
  const providerEnabled = options.providerEnabled !== undefined
    ? Boolean(options.providerEnabled)
    : envEnabled === undefined || !['0', 'false', 'disabled', 'off'].includes(String(envEnabled).toLowerCase());
  const activeBundleRequired = options.activeBundleRequired !== undefined
    ? Boolean(options.activeBundleRequired)
    : booleanSetting(process.env.AI_TEACHER_REQUIRE_ACTIVE_BUNDLE, true);
  const domainWebSearch = options.domainWebSearch || createDeepSeekWebSearchConfig(options.domainWebSearchOptions || {});
  const domainWebSearchProbe = options.domainWebSearchProbe || createWebSearchProbeController({
    policy: options.domainWebSearchProbePolicy || createWebSearchProbePolicyConfig({
      ...bootstrapResourcePolicyProjection.probe,
      ...(options.domainWebSearchProbePolicyOptions || {})
    }),
    searchConfig: domainWebSearch,
    store: options.domainWebSearchProbeStore,
    storeOptions: options.domainWebSearchProbeStoreOptions,
    search: options.domainWebSearchProbeSearch,
    fetch: options.domainWebSearchFetch,
    clock: options.domainWebSearchProbeClock
  });
  const providerGateway = options.providerGateway || createProviderResilienceGateway({
    ...bootstrapResourcePolicyProjection.provider,
    ...(options.providerResilienceOptions || {}),
    callProvider: options.callProvider || callOpenAiCompatible,
    callProviderStream: options.callProviderStream || callOpenAiCompatibleStream
  });
  const config = {
    providerMode,
    providerEnabled,
    activeBundleRequired,
    llm,
    internalToken: options.internalToken || process.env.AI_TEACHER_INTERNAL_TOKEN || '',
    toolToken: options.toolToken || process.env.AI_TEACHER_TOOL_TOKEN || '',
    maxRequestBytes: Number(options.maxRequestBytes || process.env.AI_TEACHER_MAX_REQUEST_BYTES || DEFAULT_MAX_REQUEST_BYTES),
    tokenBudgetDaily: Number(options.tokenBudgetDaily || process.env.AI_TEACHER_TOKEN_BUDGET_DAILY || 0),
    secrets: [
      process.env.AI_TEACHER_API_KEY,
      process.env.OPENAI_API_KEY,
      llm.apiKey,
      options.apiKey,
      options.toolToken,
      process.env.AI_TEACHER_TOOL_TOKEN,
      options.domainWebSearch?.apiKey,
      options.domainWebSearchOptions?.apiKey,
      process.env.AI_TEACHER_DOMAIN_WEB_SEARCH_API_KEY,
      process.env.DEEPSEEK_API_KEY_1
    ].filter(Boolean),
    knowledge: options.knowledge || createTeacherRetriever(options.knowledgeOptions || {}),
    skillSource: options.skillSource || createSkillSourceAdapter(options.skillSourceOptions || {}),
    domainWebSearch,
    domainWebSearchProbe,
    domainWebSearchFetch: options.domainWebSearchFetch,
    conversation: options.conversation || createConversationStore(options.conversationOptions || {}),
    automaticContinuationEnabled: options.automaticContinuationEnabled !== undefined
      ? Boolean(options.automaticContinuationEnabled)
      : booleanSetting(process.env.AI_TEACHER_AUTOMATIC_CONTINUATION_ENABLED, true),
    activeRuns: options.activeRuns || new Map(),
    agentModulePath: options.agentModulePath,
    agentModel: options.agentModel,
    agentNonThinkingModel: options.agentNonThinkingModel,
    agentThinkingModel: options.agentThinkingModel,
    agentStageModels: options.agentStageModels,
    agentDependencies: options.agentDependencies,
    agentBuildVersion: options.agentBuildVersion || TEACHER_BUILD_VERSION,
    ...bootstrapResourcePolicyProjection.teacher,
    agentMaxSteps: options.agentMaxSteps ?? bootstrapResourcePolicyProjection.teacher.agentMaxSteps,
    agentMaxDurationMs: options.agentMaxDurationMs ?? bootstrapResourcePolicyProjection.teacher.agentMaxDurationMs,
    agentTerminalReserveMs: options.agentTerminalReserveMs
      ?? bootstrapResourcePolicyProjection.teacher.agentTerminalReserveMs,
    agentConvergeLeadMs: options.agentConvergeLeadMs ?? bootstrapResourcePolicyProjection.teacher.agentConvergeLeadMs,
    agentToolTimeoutMs: options.agentToolTimeoutMs ?? bootstrapResourcePolicyProjection.teacher.agentToolTimeoutMs,
    agentTerminalPersistenceTimeoutMs: options.agentTerminalPersistenceTimeoutMs
      ?? bootstrapResourcePolicyProjection.teacher.agentTerminalPersistenceTimeoutMs,
    validatorTransientRetryMax: validatorTransientRetryMax(
      options.validatorTransientRetryMax ?? bootstrapResourcePolicyProjection.validator.transientRetryMax
    ),
    agentMaxOutputTokens: options.agentMaxOutputTokens ?? bootstrapResourcePolicyProjection.teacher.agentMaxOutputTokens,
    agentContextWindowTokens: options.agentContextWindowTokens ?? bootstrapResourcePolicyProjection.teacher.agentContextWindowTokens,
    agentScopeGateEnabled: options.agentScopeGateEnabled ?? bootstrapResourcePolicyProjection.teacher.agentScopeGateEnabled,
    agentScopeGateInitialTimeoutMs: options.agentScopeGateInitialTimeoutMs
      ?? bootstrapResourcePolicyProjection.teacher.agentScopeGateInitialTimeoutMs,
    agentScopeGateReviewTimeoutMs: options.agentScopeGateReviewTimeoutMs
      ?? bootstrapResourcePolicyProjection.teacher.agentScopeGateReviewTimeoutMs,
    agentScopeGateMaxOutputTokens: options.agentScopeGateMaxOutputTokens
      ?? bootstrapResourcePolicyProjection.teacher.agentScopeGateMaxOutputTokens,
    agentCandidateRecoveryMaxAttempts: options.agentCandidateRecoveryMaxAttempts
      ?? bootstrapResourcePolicyProjection.teacher.agentCandidateRecoveryMaxAttempts,
    agentCandidateMaxAttemptMs: options.agentCandidateMaxAttemptMs
      ?? bootstrapResourcePolicyProjection.teacher.agentCandidateMaxAttemptMs,
    agentCandidateRepairEnabled: options.agentCandidateRepairEnabled
      ?? bootstrapResourcePolicyProjection.teacher.agentCandidateRepairEnabled,
    agentRepairPhaseReserveMs: options.agentRepairPhaseReserveMs
      ?? bootstrapResourcePolicyProjection.teacher.agentRepairPhaseReserveMs,
    agentRepairMaxRounds: options.agentRepairMaxRounds
      ?? bootstrapResourcePolicyProjection.teacher.agentRepairMaxRounds,
    agentCandidateMaxArtifactBytes: options.agentCandidateMaxArtifactBytes
      ?? bootstrapResourcePolicyProjection.teacher.agentCandidateMaxArtifactBytes,
    agentValidatorToolTimeoutMs: options.agentValidatorToolTimeoutMs
      ?? bootstrapResourcePolicyProjection.teacher.agentValidatorToolTimeoutMs,
    agentReviewedKnowledgeMaxNewQueriesPerRun: options.agentReviewedKnowledgeMaxNewQueriesPerRun
      ?? bootstrapResourcePolicyProjection.teacher.agentReviewedKnowledgeMaxNewQueriesPerRun,
    agentLowAnswerMaxOutputTokens: options.agentLowAnswerMaxOutputTokens
      ?? bootstrapResourcePolicyProjection.teacher.agentLowAnswerMaxOutputTokens,
    agentMediumAnswerMaxOutputTokens: options.agentMediumAnswerMaxOutputTokens
      ?? bootstrapResourcePolicyProjection.teacher.agentMediumAnswerMaxOutputTokens,
    agentHighAnswerMaxOutputTokens: options.agentHighAnswerMaxOutputTokens
      ?? bootstrapResourcePolicyProjection.teacher.agentHighAnswerMaxOutputTokens,
    agentTemperature: 0,
    agentReasoningMode: 'provider-managed',
    agentProviderCompatibility: normalizeAgentProviderCompatibility(
      options.agentProviderCompatibility || process.env.AI_TEACHER_AGENT_PROVIDER_COMPATIBILITY
    ),
    platformApiUrl: options.platformApiUrl || process.env.PLATFORM_API_URL || 'http://localhost:8080',
    providerGateway,
    activeResourcePolicySnapshot: bootstrapResourcePolicySnapshot,
    stagedResourcePolicySnapshot: null,
    allowCors: options.allowCors !== undefined ? Boolean(options.allowCors) : process.env.NODE_ENV !== 'production'
  };
  if (!config.internalToken && process.env.NODE_ENV !== 'test' && process.env.ALLOW_MISSING_AI_TEACHER_INTERNAL_TOKEN_FOR_LOCAL !== 'true') {
    throw new Error('AI_TEACHER_INTERNAL_TOKEN is required for the AI Teacher sidecar outside test/local override.');
  }
  if (config.toolToken && config.internalToken && config.toolToken === config.internalToken) {
    throw new Error('AI_TEACHER_TOOL_TOKEN must be different from AI_TEACHER_INTERNAL_TOKEN.');
  }
  if (!config.toolToken && process.env.NODE_ENV === 'production') {
    throw new Error('AI_TEACHER_TOOL_TOKEN is required for the Agent Validator tool in production.');
  }
  return config;
}

function stageResourcePolicy(config, snapshot) {
  const validation = validateAgentResourcePolicySnapshot(snapshot);
  if (!validation.ok) throwInvalidResourcePolicySnapshot(validation);
  config.stagedResourcePolicySnapshot = Object.freeze({
    ...snapshot,
    values: Object.freeze({ ...validation.values })
  });
  return {
    accepted: true,
    status: 'staged',
    versionId: snapshot.versionId,
    checksum: snapshot.checksum,
    warnings: validation.warnings
  };
}

function activateResourcePolicy(config, snapshot) {
  const validation = validateAgentResourcePolicySnapshot(snapshot);
  if (!validation.ok) throwInvalidResourcePolicySnapshot(validation);
  const staged = config.stagedResourcePolicySnapshot;
  if (!staged || staged.versionId !== snapshot.versionId || staged.checksum !== snapshot.checksum) {
    const error = new Error('Agent resource policy must be staged before activation.');
    error.code = 'AGENT_RESOURCE_POLICY_NOT_STAGED';
    error.statusCode = 409;
    throw error;
  }
  const projection = agentResourcePolicyRuntimeProjection(validation.values);
  config.providerGateway.updateSettings?.(projection.provider);
  Object.assign(config, projection.teacher, {
    validatorTransientRetryMax: projection.validator.transientRetryMax
  });
  config.activeResourcePolicySnapshot = Object.freeze({
    ...snapshot,
    values: Object.freeze({ ...validation.values }),
    frozenAt: new Date().toISOString()
  });
  config.stagedResourcePolicySnapshot = null;
  return resourcePolicyOwnerState(config);
}

function resourcePolicyOwnerState(config) {
  const snapshot = config.activeResourcePolicySnapshot;
  return {
    status: 'active',
    versionId: snapshot.versionId,
    checksum: snapshot.checksum,
    values: { ...snapshot.values },
    observedAt: new Date().toISOString(),
    owners: {
      teacher: 'active',
      provider: 'active',
      apiValidatorTool: 'snapshot_per_run',
      validatorProcessCapacity: 'restart_required',
      probe: 'restart_required'
    }
  };
}

function resourcePolicyConfigForContext(config, context) {
  const snapshot = context?.runtimeAssignment?.resourcePolicySnapshot || config.activeResourcePolicySnapshot;
  const validation = validateAgentResourcePolicySnapshot(snapshot);
  if (!validation.ok) throwInvalidResourcePolicySnapshot(validation);
  if (context?.runtimeAssignment && !context.runtimeAssignment.resourcePolicySnapshot) {
    context.runtimeAssignment.resourcePolicySnapshot = snapshot;
  }
  const projection = agentResourcePolicyRuntimeProjection(validation.values);
  const modelCapabilitySnapshot = context?.runtimeAssignment?.modelCapabilitySnapshot;
  const modelCapabilityValidation = validateModelCapabilitySnapshot(modelCapabilitySnapshot);
  const contextWindowTokens = modelCapabilityValidation.ok
    ? modelCapabilitySnapshot.effectiveContextWindowTokens
    : config.agentContextWindowTokens;
  const resolvedStageModelRoutes = modelCapabilityValidation.ok
    ? resolveStageModelRoutes(projection.teacher.agentStageModelRoutes, modelCapabilitySnapshot)
    : projection.teacher.agentStageModelRoutes;
  const resolvedStageModelProtocols = modelCapabilityValidation.ok && modelCapabilitySnapshot.schemaVersion >= 2
    ? resolveStageModelProtocols(projection.teacher.agentStageModelRoutes, modelCapabilitySnapshot)
    : undefined;
  return {
    ...config,
    ...projection.teacher,
    agentStageModelRoutes: Object.freeze(resolvedStageModelRoutes),
    ...(resolvedStageModelProtocols
      ? { agentStageModelProtocols: Object.freeze(resolvedStageModelProtocols) }
      : {}),
    agentContextWindowTokens: contextWindowTokens,
    validatorTransientRetryMax: projection.validator.transientRetryMax,
    resourcePolicySnapshot: Object.freeze({
      ...snapshot,
      values: Object.freeze({ ...validation.values })
    })
  };
}

function resolveStageModelRoutes(policyReferences, modelCapabilitySnapshot) {
  return Object.fromEntries(Object.entries(policyReferences || {}).map(([stageId, aliasReference]) => {
    const stage = modelCapabilitySnapshot?.stages?.[stageId];
    const reference = String(aliasReference || '').trim();
    const resolvedAliasId = String(stage?.aliasId || '').trim();
    const runtimeAlias = String(stage?.alias || '').trim();
    if (!runtimeAlias || (resolvedAliasId !== reference && runtimeAlias !== reference)) {
      const error = new Error(`AI Teacher model reference could not be resolved for stage ${stageId}.`);
      error.code = 'AI_TEACHER_MODEL_REFERENCE_UNRESOLVED';
      error.statusCode = 503;
      throw error;
    }
    return [stageId, runtimeAlias];
  }));
}

function resolveStageModelProtocols(policyReferences, modelCapabilitySnapshot) {
  return Object.fromEntries(Object.entries(policyReferences || {}).map(([stageId, aliasReference]) => {
    const stage = modelCapabilitySnapshot?.stages?.[stageId];
    const reference = String(aliasReference || '').trim();
    const resolvedAliasId = String(stage?.aliasId || '').trim();
    const runtimeAlias = String(stage?.alias || '').trim();
    if (stage?.protocolStatus !== 'ready'
      || !String(stage?.protocolMode || '').trim()
      || (resolvedAliasId !== reference && runtimeAlias !== reference)) {
      const error = new Error(`AI Teacher model protocol could not be resolved for stage ${stageId}.`);
      error.code = 'AI_TEACHER_MODEL_PROTOCOL_UNRESOLVED';
      error.statusCode = 503;
      throw error;
    }
    return [stageId, Object.freeze({
      protocolMode: String(stage.protocolMode),
      adapterProfileId: String(stage.adapterProfileId || ''),
      adapterProfileRevision: Number(stage.adapterProfileRevision || 0),
      modelProtocolProfileId: String(stage.modelProtocolProfileId || ''),
      modelProtocolProfileRevision: Number(stage.modelProtocolProfileRevision || 0),
      executionPolicy: deepFreezeProtocolValue(stage.executionPolicy || null)
    })];
  }));
}

function deepFreezeProtocolValue(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeProtocolValue(child);
  return Object.freeze(value);
}

function throwInvalidResourcePolicySnapshot(validation) {
  const error = new Error('Agent resource policy snapshot is invalid.');
  error.code = 'AGENT_RESOURCE_POLICY_SNAPSHOT_INVALID';
  error.statusCode = 400;
  error.details = validation;
  throw error;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function validatorTransientRetryMax(value) {
  if (value === undefined || value === null || value === '') return 1;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 1) {
    throw new RangeError('AI_TEACHER_VALIDATOR_TRANSIENT_RETRY_MAX must be 0 or 1.');
  }
  return number;
}

function normalizeAgentProviderCompatibility(value) {
  const normalized = String(value || 'generic-openai').trim().toLowerCase();
  return ['deepseek-v4-direct', 'deepseek-v4-litellm'].includes(normalized)
    ? normalized
    : 'generic-openai';
}

function booleanSetting(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function domainWebSearchControlPayload(payload) {
  const keys = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload)
    : [];
  if (keys.length !== 1 || keys[0] !== 'enabled' || typeof payload.enabled !== 'boolean') {
    const error = new Error('请求体只能包含布尔字段 enabled。');
    error.code = 'DOMAIN_WEB_SEARCH_CONTROL_INVALID';
    error.statusCode = 400;
    throw error;
  }
  return { enabled: payload.enabled };
}

function domainWebSearchProbePayload(payload) {
  const keys = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload)
    : [];
  if (keys.length !== 0) {
    const error = new Error('验证请求体必须为空对象。');
    error.code = 'DOMAIN_WEB_SEARCH_PROBE_INVALID';
    error.statusCode = 400;
    throw error;
  }
  return {};
}

async function handleTeacherStreamRequest(req, res, payload, config, responder, routeName) {
  const stream = startTeacherNdjsonStream(res, config);
  const providerState = providerPublicState(config);
  if (!providerState.enabled) {
    stream.write('error', publicError('PROVIDER_DISABLED', 'AI teacher provider is disabled for this service', 503).error);
    return stream.end();
  }
  const contract = validateHostContextEnvelope(payload);
  if (!contract.ok) {
    stream.write('error', {
      code: 'INVALID_CONTRACT',
      message: 'HostContextEnvelope is invalid',
      details: contract.errors
    });
    return stream.end();
  }
  let startMetadata;
  try {
    startMetadata = await runtimeStartMetadata(contract.value, config);
  } catch (error) {
    stream.write('error', {
      code: error.code || 'AI_TEACHER_AGENT_PREFLIGHT_FAILED',
      message: error.message,
      status: error.statusCode || 503
    });
    return stream.end();
  }
  const thread = await config.conversation.ensureThread(contract.value, payload.threadId || contract.value.threadId);
  const execution = await createOrResumeRun(config.conversation, {
    threadId: thread.threadId,
    context: contract.value,
    intent: 'single_entry',
    route: `${routeName || responder.name || 'teacher_request'}:stream`
  }, { automaticContinuationEnabled: config.automaticContinuationEnabled });
  const run = execution.run;
  if (execution.reused) {
    await stream.writeAndWait('start', { threadId: thread.threadId, runId: run.runId, ...startMetadata });
    if (execution.response) {
      await stream.writeAndWait('final', execution.response);
      const executionDelivery = await loadExecutionCheckpointForDelivery(config, run, execution.response);
      await persistExecutionDeliveryCheckpointFailSoft(config, run, execution.response, executionDelivery.latest, true);
    }
    else stream.write('error', execution.automaticContinuation
      ? { code: 'AUTOMATIC_CONTINUATION_IN_PROGRESS', message: 'Automatic continuation is already in progress.', status: 409 }
      : execution.manualContinuation
        ? { code: 'MANUAL_CONTINUATION_IN_PROGRESS', message: 'Manual continuation is already in progress.', status: 409 }
        : { code: 'CLARIFICATION_RESUME_IN_PROGRESS', message: 'Clarification resume is already in progress.', status: 409 });
    return stream.end();
  }
  const persistedResume = persistedCompletedResumeResponse({
    execution,
    context: contract.value,
    startMetadata,
    run,
    thread
  });
  if (persistedResume) {
    await stream.writeAndWait('start', { threadId: thread.threadId, runId: run.runId, ...startMetadata });
    const responseContract = validateTeacherCapabilityResponse(persistedResume.response, contract.value);
    if (!responseContract.ok) {
      await config.conversation.failRun({
        runId: run.runId,
        error: Object.assign(new Error('Persisted Teacher response failed contract validation'), {
          code: 'INVALID_PERSISTED_TEACHER_RESPONSE',
          statusCode: 500
        })
      });
      stream.write('error', { code: 'INVALID_PERSISTED_TEACHER_RESPONSE', message: 'Teacher service failed to process the request', status: 500 });
      return stream.end();
    }
    const persisted = await config.conversation.completeRun({
      runId: run.runId,
      context: contract.value,
      response: persistedResume.response,
      providerMeta: persistedResume.internal
    });
    const executionDelivery = await loadExecutionCheckpointForDelivery(config, run, persistedResume.response);
    await persistExecutionDeliveryCheckpointFailSoft(config, run, persistedResume.response, executionDelivery.latest, false);
    persistedResume.response.threadId = thread.threadId;
    persistedResume.response.runId = run.runId;
    persistedResume.response.messageId = persisted.messageId;
    await stream.writeAndWait('final', persistedResume.response);
    await persistExecutionDeliveryCheckpointFailSoft(config, run, persistedResume.response, executionDelivery.latest, true);
    return stream.end();
  }
  const controller = new AbortController();
  const recordingStream = createRecordingStream(stream, config.conversation, run.runId);
  config.activeRuns.set(run.runId, {
    controller,
    writer: recordingStream,
    runtime: startMetadata.runtimeUsed
  });
  const abortForDisconnect = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort(Object.assign(new Error('Teacher stream client disconnected'), {
        code: 'TEACHER_RUN_CANCELLED',
        statusCode: 499
      }));
    }
  };
  req.once('aborted', abortForDisconnect);
  res.once('close', abortForDisconnect);
  await recordingStream.writeAndWait('start', {
    threadId: thread.threadId,
    runId: run.runId,
    ...startMetadata
  });
  try {
    const budgetError = await checkTokenBudget(config, contract.value);
    if (budgetError) throw budgetError;
    const previousMessages = await config.conversation.listSuccessfulMessages(thread.threadId, 8);
    const context = {
      ...contract.value,
      threadId: thread.threadId,
      conversation: {
        ...(contract.value.conversation || {}),
        recentMessages: previousMessages.map((message) => ({
          role: message.role,
          content: message.content,
          createdAt: message.createdAt || message.created_at || ''
        }))
      }
    };
    const requestConfig = resourcePolicyConfigForContext(config, context);
    const response = await responder(context, {
      ...requestConfig,
      streamWriter: recordingStream,
      abortSignal: controller.signal,
      runId: run.runId,
      workflowResume: execution.workflowResume
    });
    throwIfRunAborted(controller.signal);
    await recordingStream.drain();
    const runtimeAttestation = response.__runtimeAttestation;
    delete response.__runtimeAttestation;
    const finalRuntimeMetadata = runtimeMetadata(context, runtimeAttestation);
    Object.assign(response, finalRuntimeMetadata);
    const internal = response.__internal || {};
    const checkpoint = attachClarificationCheckpoint(response, run, thread, internal, config);
    const executionDelivery = await loadExecutionCheckpointForDelivery(config, run, response);
    attachExecutionContinuation(response, {
      execution,
      run,
      internal,
      enabled: config.automaticContinuationEnabled,
      recoveryAvailable: executionDelivery.recoveryAvailable
    });
    attachEngineeringFeedbackAction(response, run);
    const responseContract = validateTeacherCapabilityResponse(response, context);
    if (!responseContract.ok) {
      const error = new Error('Teacher response failed contract validation');
      error.statusCode = 500;
      error.code = 'INVALID_TEACHER_RESPONSE';
      error.details = responseContract.errors;
      throw error;
    }
    delete response.__internal;
    const persisted = checkpoint
      ? await config.conversation.pauseRunForClarification({ runId: run.runId, context, response, providerMeta: internal, checkpoint })
      : await config.conversation.completeRun({ runId: run.runId, context, response, providerMeta: internal });
    if (persisted.cancelled) return stream.end();
    if (!checkpoint) {
      await persistExecutionDeliveryCheckpointFailSoft(config, run, response, executionDelivery.latest, false);
    }
    response.threadId = thread.threadId;
    response.runId = run.runId;
    response.messageId = persisted.messageId;
    if (response.continuation?.kind === 'engineering_improvement'
      && response.continuation?.status === 'automatic_pending') {
      await recordingStream.writeAndWait('baseline_ready', {
        sourceRunId: run.runId,
        message: '已保存并通过官方Validator的基线，正在进入工程语义完善。'
      });
    }
    await recordingStream.writeAndWait('final', response);
    if (!checkpoint) {
      await persistExecutionDeliveryCheckpointFailSoft(config, run, response, executionDelivery.latest, true);
    }
    stream.end();
  } catch (error) {
    const cancelled = controller.signal.aborted || error.code === 'TEACHER_RUN_CANCELLED';
    if (cancelled) {
      await config.conversation.cancelRun({ runId: run.runId, error });
      if (!res.destroyed) {
        await recordingStream.writeAndWait('cancelled', {
          code: 'TEACHER_RUN_CANCELLED',
          message: 'AI Teacher run was cancelled.',
          status: 499
        }).catch(() => {});
      }
    } else {
      await config.conversation.failRun({ runId: run.runId, error });
      const agentFailure = publicAgentFailureEnvelope(error, {
        runId: run.runId,
        threadId: thread.threadId,
        runtime: startMetadata
      });
      const errorPayload = {
        code: error.code || 'TEACHER_STREAM_FAILED',
        message: error.statusCode === 500 ? 'Teacher service failed to process the request' : error.message,
        status: error.statusCode || error.status || 503,
        ...(agentFailure || {})
      };
      if (!res.destroyed) await recordingStream.writeAndWait('error', errorPayload).catch(() => {});
    }
    stream.end();
  } finally {
    config.activeRuns.delete(run.runId);
    req.off('aborted', abortForDisconnect);
    res.off('close', abortForDisconnect);
  }
}

async function createOrResumeRun(conversation, input, options = {}) {
  const checkpointId = safeClarificationId(input.context?.clarificationCheckpointId);
  const continuationSourceRunId = options.automaticContinuationEnabled
    ? safeAutomaticContinuationSourceRunId(input.context?.automaticContinuationSourceRunId)
    : '';
  const manualContinuationSourceRunId = safeManualContinuationSourceRunId(
    input.context?.manualContinuationSourceRunId
  );
  const manualContinuationKind = safeManualContinuationKind(input.context?.manualContinuationKind);
  if ([checkpointId, continuationSourceRunId, manualContinuationSourceRunId].filter(Boolean).length > 1) {
    const error = new Error('Clarification, automatic continuation, and manual continuation cannot be requested together.');
    error.code = 'INVALID_CONTINUATION_REQUEST';
    error.statusCode = 400;
    throw error;
  }
  if (continuationSourceRunId) {
    const execution = await conversation.createAutomaticContinuationRun({
      ...input,
      sourceRunId: continuationSourceRunId,
      continuationKind: safeAutomaticContinuationKind(input.context?.automaticContinuationKind),
      continuationBudget: safeAutomaticContinuationBudget(input.context?.automaticContinuationBudget)
    });
    return refreshWorkflowResumeExecution(conversation, execution, input.context);
  }
  if (manualContinuationSourceRunId) {
    const execution = await conversation.createManualContinuationRun({
      ...input,
      sourceRunId: manualContinuationSourceRunId,
      continuationKind: manualContinuationKind
    });
    return refreshWorkflowResumeExecution(conversation, execution, input.context);
  }
  if (!checkpointId) {
    return { run: await conversation.createRun(input), reused: false, workflowResume: undefined };
  }
  const execution = await conversation.createResumedRun({ ...input, checkpointId });
  return refreshWorkflowResumeExecution(conversation, execution, input.context);
}

async function refreshWorkflowResumeExecution(conversation, execution, context) {
  if (execution?.run?.metadata?.manualContinuationKind === 'engineering_feedback') return execution;
  if (!execution?.workflowResume?.execution
    || !execution?.run?.runId
    || typeof conversation?.loadLatestExecutionCheckpoint !== 'function') return execution;
  const currentHashes = {
    ...deriveExecutionInputHashes(context),
    ...executionValidationIdentityForContext(context)
  };
  const latest = await conversation.loadLatestExecutionCheckpoint(execution.run.runId, { currentHashes });
  if (!latest?.execution) return execution;
  return {
    ...execution,
    workflowResume: {
      ...execution.workflowResume,
      execution: latest.execution
    }
  };
}

/** Completed续跑零LLM回放，但必须重新执行与新回答相同的单文件交付契约。 */
function persistedCompletedResumeResponse({ execution, context, startMetadata, run, thread }) {
  const resume = execution?.workflowResume?.execution;
  const source = execution?.sourceResponse;
  if (execution?.workflowResume?.continuationKind === 'engineering_improvement'
    || resume?.continuationKind === 'engineering_improvement'
    || resume?.decision?.phase !== 'completed'
    || resume?.decision?.stale === true
    || !String(resume?.persistedAnswer || '').trim()
    || !source
    || typeof source !== 'object'
    || source.validatorStatus !== 'validated_passed') return null;
  const response = JSON.parse(JSON.stringify(source));
  delete response.__internal;
  delete response.__runtimeAttestation;
  delete response.clarification;
  response.contractVersion = CONTRACT_VERSION;
  response.responseId = `resp_checkpoint_${crypto.randomUUID()}`;
  response.requestId = String(context?.requestId || run.requestId || 'checkpoint-resume');
  const delivery = recoverPersistedCompletedCandidateDelivery({
    persistedAnswer: resume.persistedAnswer,
    sourceResponse: source,
    candidateArtifact: resume.worker?.candidate,
    validationArtifact: resume.worker?.validation,
    hostContext: context
  });
  const deliveryComplete = ['changed_delivered', 'no_change'].includes(delivery.status);
  response.directAnswer = deliveryComplete
    ? delivery.answer
    : `${String(delivery.answer || '').trim()}\n\n【历史结果未通过当前单文件交付检查，系统未将其标记为完成。】`;
  response.answerCompletionStatus = deliveryComplete ? 'complete' : 'incomplete';
  response.candidateDeliveryStatus = delivery.status;
  if (deliveryComplete) {
    response.validatorStatus = 'validated_passed';
    response.candidateWorkspaceHash = delivery.candidateWorkspaceHash;
    response.candidateAttestation = delivery.candidateAttestation;
    response.codeBlockValidations = delivery.codeBlockValidations;
  } else {
    response.validatorStatus = 'not_validated';
    response.codeBlockValidations = [];
    delete response.candidateAttestation;
  }
  response.tokenUsage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  response.warnings = [...new Set([
    ...(Array.isArray(response.warnings) ? response.warnings : []),
    delivery.recovered
      ? 'completed_execution_response_rebuilt_from_checkpoint'
      : 'completed_execution_response_reused',
    ...(!deliveryComplete ? [`candidate_delivery_incomplete:${delivery.reason}`] : [])
  ])];
  response.agentTrace = {
    ...(response.agentTrace || {}),
    status: 'completed',
    stepCount: 0,
    stopReason: 'completed',
    phaseTimings: []
  };
  response.continuation = {
    status: deliveryComplete ? 'complete' : 'user_confirmation_required',
    sourceRunId: String(execution?.workflowResume?.sourceRunId || ''),
    autoContinuationUsed: execution?.automaticContinuation === true
      || execution?.automaticContinuationUsed === true,
    canContinue: false,
    completedItems: completedContinuationItems(response),
    remainingItems: deliveryComplete ? [] : [{
      title: '重新生成单文件候选结果',
      detail: delivery.reason === 'multi_file_delivery_unsupported'
        ? '当前公共交付仅支持一个修改文件；本次多文件结果未标记完成。'
        : '历史候选或验证证据无法与当前公共回答形成完整绑定。',
      status: 'blocked'
    }]
  };
  Object.assign(response, startMetadata);
  const internal = {
    provider: 'execution-checkpoint',
    model: '',
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    agent: {
      workflowVersion: response.workflowVersion || 'intent-orchestrator-v2',
      stepCount: 0,
      stopReason: 'completed',
      validatorStatus: response.validatorStatus,
      candidateWorkspaceHash: response.candidateWorkspaceHash || '',
      answerCompletionStatus: response.answerCompletionStatus,
      candidateDeliveryStatus: delivery.status,
      candidateDeliveryReason: delivery.reason,
      replayedFromRunId: String(execution?.workflowResume?.sourceRunId || ''),
      zeroLlmResume: true
    }
  };
  response.threadId = thread.threadId;
  response.runId = run.runId;
  return { response, internal };
}

async function loadExecutionCheckpointForDelivery(config, run, response) {
  const warnings = Array.isArray(response?.warnings) ? response.warnings : [];
  if (warnings.includes('execution_checkpoint_persistence_failed')) {
    await recordExecutionCheckpointAudit(config, run, 'persistence_failed');
  }
  if (typeof config.conversation?.loadLatestExecutionCheckpoint !== 'function') {
    await recordExecutionCheckpointAudit(config, run, 'repository_unavailable');
    return { latest: null, recoveryAvailable: false };
  }
  try {
    const latest = await config.conversation.loadLatestExecutionCheckpoint(run.runId);
    if (!latest?.checkpoint) {
      const deadlinePartial = response?.answerCompletionStatus === 'incomplete'
        && ['timeout', 'hard_timeout'].includes(String(response?.agentTrace?.stopReason || ''));
      if (deadlinePartial) await recordExecutionCheckpointAudit(config, run, 'checkpoint_missing');
      return { latest: null, recoveryAvailable: false };
    }
    return { latest, recoveryAvailable: true };
  } catch {
    await recordExecutionCheckpointAudit(config, run, 'checkpoint_read_failed');
    return { latest: null, recoveryAvailable: false };
  }
}

async function persistExecutionDeliveryCheckpointFailSoft(
  config,
  run,
  response,
  latest,
  frontendResultReturned = false
) {
  if (!latest?.checkpoint || typeof config.conversation?.appendExecutionCheckpoint !== 'function') return;
  const checkpoint = latest.checkpoint;
  const completeValidated = response?.answerCompletionStatus === 'complete'
    && response?.validatorStatus === 'validated_passed'
    && checkpoint.candidateArtifactId
    && checkpoint.validationArtifactId;
  const degraded = response?.answerCompletionStatus !== 'complete'
    || (Array.isArray(response?.warnings) && response.warnings.length > 0);
  const engineeringImprovementPending = response?.continuation?.kind === 'engineering_improvement'
    && response?.continuation?.status === 'automatic_pending';
  if (!completeValidated && !degraded) return;
  try {
    await config.conversation.appendExecutionCheckpoint({
      runId: run.runId,
      boundary: {
        phase: completeValidated && !engineeringImprovementPending ? 'completed' : checkpoint.phase,
        candidateArtifactId: checkpoint.candidateArtifactId || undefined,
        validationArtifactId: checkpoint.validationArtifactId || undefined,
        requestRevisionHash: checkpoint.requestRevisionHash,
        taskContractHash: checkpoint.taskContractHash,
        editorBaseHash: checkpoint.editorBaseHash,
        validatorVersion: checkpoint.validatorVersion || undefined,
        rulesetVersion: checkpoint.rulesetVersion || undefined,
        validationOptionsHash: checkpoint.validationOptionsHash || undefined,
        repairRound: checkpoint.repairRound || 0,
        repairState: checkpoint.repairState || {},
        knowledgeCursor: checkpoint.knowledgeCursor || {},
        metadata: {
          ...(checkpoint.metadata || {}),
          engineeringDeliveryStatus: frontendResultReturned ? 'delivery_confirmed' : 'delivery_selected',
          frontendResultReturned,
          deliveryResponseHash: `sha256:${crypto.createHash('sha256')
            .update(JSON.stringify(publicDeliveryProjection(response)), 'utf8')
            .digest('hex')}`,
          selectionReason: response?.engineeringReview?.revisionDelivered === true
            ? 'revision_official_validator_passed'
            : 'latest_validated_baseline',
          degraded,
          answerCompletionStatus: String(response?.answerCompletionStatus || ''),
          errorCategory: executionErrorCategory(response, checkpoint)
        }
      }
    });
  } catch {
    response.warnings = [...new Set([
      ...(Array.isArray(response.warnings) ? response.warnings : []),
      'execution_checkpoint_delivery_persistence_failed'
    ])];
    await recordExecutionCheckpointAudit(config, run, 'delivery_checkpoint_write_failed');
  }
}

function publicDeliveryProjection(response) {
  return {
    responseId: String(response?.responseId || ''),
    directAnswer: String(response?.directAnswer || ''),
    validatorStatus: String(response?.validatorStatus || ''),
    candidateWorkspaceHash: String(response?.candidateWorkspaceHash || ''),
    engineeringReview: response?.engineeringReview || null,
  };
}

function executionErrorCategory(response, checkpoint) {
  const stopReason = String(response?.agentTrace?.stopReason || '');
  const warningText = (Array.isArray(response?.warnings) ? response.warnings : []).join(' ');
  if (/checkpoint/iu.test(warningText)) return 'checkpoint_failure';
  if (checkpoint?.repairState?.metrics?.noProgress === true) return 'repair_no_progress';
  if (checkpoint?.repairState?.metrics?.contextInflationDetected === true) return 'context_inflation';
  if (['timeout', 'hard_timeout', 'repair_step_timeout'].includes(stopReason)) return 'provider_timeout';
  if (response?.answerCompletionStatus !== 'complete') return 'degraded_incomplete';
  return '';
}

async function recordExecutionCheckpointAudit(config, run, reasonCode) {
  if (typeof config.conversation?.recordAuditEvent !== 'function') return;
  await config.conversation.recordAuditEvent({
    eventType: 'teacher.execution_checkpoint.failed',
    tenantId: run.tenantId || '',
    userId: run.userId || '',
    requestId: run.requestId || '',
    runId: run.runId,
    status: 'degraded',
    metadata: { reasonCode: String(reasonCode || 'checkpoint_failure').slice(0, 80) }
  }).catch(() => {});
}

function attachClarificationCheckpoint(response, run, thread, internal, config) {
  const request = internal?.agent?.clarificationRequest;
  if (!request || typeof request.question !== 'string' || typeof request.acceptedToolCallId !== 'string') return null;
  const createdAt = new Date();
  const configuredTtlMs = Number(config.clarificationTtlMs || process.env.AI_TEACHER_CLARIFICATION_TTL_MS || 86_400_000);
  const ttlMs = Number.isFinite(configuredTtlMs)
    ? Math.max(60_000, Math.min(604_800_000, configuredTtlMs))
    : 86_400_000;
  const checkpoint = {
    checkpointId: `clar_${crypto.randomUUID()}`,
    sourceRunId: run.runId,
    threadId: thread.threadId,
    acceptedToolCallId: request.acceptedToolCallId,
    question: request.question,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString()
  };
  response.answerCompletionStatus = 'waiting_for_clarification';
  response.clarification = {
    checkpointId: checkpoint.checkpointId,
    questionId: `question_${crypto.createHash('sha256')
      .update(`${checkpoint.checkpointId}:${request.acceptedToolCallId}`, 'utf8')
      .digest('hex').slice(0, 24)}`,
    status: 'waiting',
    question: checkpoint.question,
    ...(Array.isArray(request.options) ? {
      options: request.options.slice(0, 5).map((label, index) => ({
        optionId: `option_${crypto.createHash('sha256')
          .update(`${checkpoint.checkpointId}:${index}:${label}`, 'utf8')
          .digest('hex').slice(0, 24)}`,
        label: String(label || '').trim().slice(0, 120)
      })).filter((option) => option.label)
    } : {}),
    expiresAt: checkpoint.expiresAt
  };
  return checkpoint;
}

function attachExecutionContinuation(response, { execution, run, internal, enabled, recoveryAvailable }) {
  const manualContinuation = execution?.manualContinuation === true;
  if ((!enabled && !manualContinuation) || !response || typeof response !== 'object') return null;
  const automaticContinuation = execution?.automaticContinuation === true;
  const automaticContinuationUsed = automaticContinuation
    || execution?.automaticContinuationUsed === true;
  const agent = internal?.agent || {};
  const pendingEngineeringImprovement = response.answerCompletionStatus === 'complete'
    && response.validatorStatus === 'validated_passed'
    && agent?.engineeringImprovement?.status === 'pending';
  const continuationKind = pendingEngineeringImprovement
    ? 'engineering_improvement'
    : safeAutomaticContinuationKind(
        execution?.workflowResume?.continuationKind
        || execution?.run?.metadata?.automaticContinuationKind
        || 'execution_completion'
      );
  const deadlinePartial = response.answerCompletionStatus === 'incomplete'
    && ['timeout', 'hard_timeout'].includes(String(agent.stopReason || response.agentTrace?.stopReason || ''))
    && ['work_deadline_reached', 'hard_deadline_reached'].includes(String(agent.stopCause || response.agentTrace?.stopCause || ''));
  if (!automaticContinuation && !manualContinuation && !deadlinePartial && !pendingEngineeringImprovement) return null;

  const sourceResponse = execution?.sourceResponse && typeof execution.sourceResponse === 'object'
    ? execution.sourceResponse
    : null;
  const completedItems = mergeContinuationItems(
    sourceResponse?.continuation?.completedItems,
    completedContinuationItems(response)
  );
  const waitingForClarification = response.answerCompletionStatus === 'waiting_for_clarification';
  const complete = response.answerCompletionStatus === 'complete' && !pendingEngineeringImprovement;
  const remainingItems = complete
    ? []
    : waitingForClarification
      ? [{ title: '等待您补充必要信息', detail: response.clarification?.question || '需要补充信息后才能继续。', status: 'blocked' }]
      : remainingContinuationItems(response, agent);
  const continuation = {
    kind: continuationKind,
    status: complete
      ? 'complete'
      : !recoveryAvailable
      ? 'user_confirmation_required'
      : automaticContinuation || manualContinuation
      ? 'user_confirmation_required'
      : 'automatic_pending',
    sourceRunId: automaticContinuation || manualContinuation
      ? String(manualContinuation ? run.runId : execution?.workflowResume?.sourceRunId || '')
      : run.runId,
    autoContinuationUsed: automaticContinuationUsed,
    canContinue: Boolean(recoveryAvailable)
      && (automaticContinuation || manualContinuation)
      && !complete
      && !waitingForClarification,
    completedItems,
    remainingItems
  };
  response.continuation = continuation;

  if (!recoveryAvailable && !complete && !waitingForClarification) {
    response.warnings = [...new Set([
      ...(Array.isArray(response.warnings) ? response.warnings : []),
      'automatic_continuation_disabled:checkpoint_unavailable'
    ])];
    continuation.remainingItems = mergeContinuationItems(continuation.remainingItems, [{
      title: '自动续跑已安全停用',
      detail: '本轮执行检查点不可用，系统没有自动重放可能过期的中间状态；已在后台记录问题。',
      status: 'blocked'
    }]);
  }

  if ((automaticContinuation || manualContinuation) && !complete && !waitingForClarification) {
    response.directAnswer = appendContinuationReport(response.directAnswer, continuation);
    response.sections = [
      ...(Array.isArray(response.sections) ? response.sections : []),
      {
        kind: 'execution_continuation',
        title: '本轮执行状态',
        content: automaticContinuation
          ? '本次任务已经自动续跑 1 次，达到自动执行上限。请查看已完成和未完成事项后决定是否继续。'
          : '本次人工续跑已保存新的阶段性成果。请查看已完成和未完成事项后决定是否继续。'
      }
    ];
  }
  return continuation;
}

function completedContinuationItems(response) {
  const items = [];
  if (Array.isArray(response?.evidence) && response.evidence.length > 0) {
    items.push({ title: '已完成相关知识与证据检索', detail: `已绑定 ${response.evidence.length} 条可公开证据。`, status: 'completed' });
  }
  if (response?.candidateDeliveryStatus === 'changed_delivered') {
    items.push({ title: '已交付候选模型', detail: '单个修改文件已由服务端按内容 Hash 完整交付。', status: 'completed' });
  } else if (response?.candidateDeliveryStatus === 'no_change') {
    items.push({ title: '已确认模型无需修改', detail: '候选与当前单文件模型内容一致。', status: 'completed' });
  }
  if (response?.validatorStatus === 'validated_passed'
    && ['changed_delivered', 'no_change'].includes(response?.candidateDeliveryStatus)) {
    items.push({ title: '候选模型已通过官方 Validator', detail: '该完成状态来自可信 Validator 结果。', status: 'validated' });
  }
  if (response?.answerCompletionStatus === 'complete' && String(response?.directAnswer || '').trim()) {
    items.push({ title: '已形成阶段性回答', detail: '当前可交付内容已保存到对话记录。', status: 'completed' });
  }
  return items.slice(0, 8);
}

function attachEngineeringFeedbackAction(response, run) {
  const review = response?.engineeringReview;
  if (!review || typeof review !== 'object' || Array.isArray(review)) return;
  const canContinue = response?.answerCompletionStatus === 'complete'
    && response?.validatorStatus === 'validated_passed'
    && review.canContinue === true
    && /^run_[a-zA-Z0-9-]{8,160}$/.test(String(run?.runId || ''));
  review.canContinue = canContinue;
  if (canContinue) {
    review.sourceRunId = run.runId;
    review.continuationAction = 'continue_engineering_improvement';
  } else {
    delete review.sourceRunId;
    delete review.continuationAction;
  }
}

function remainingContinuationItems(response, agent) {
  const items = [];
  if (response?.candidateWorkspaceHash && response?.validatorStatus !== 'validated_passed') {
    items.push({ title: '完成候选模型验证或修复', detail: '当前候选尚未取得官方 Validator PASS。', status: 'remaining' });
  }
  const stopCause = String(agent?.stopCause || response?.agentTrace?.stopCause || '');
  items.push({
    title: '完成剩余任务并形成完整答复',
    detail: ['work_deadline_reached', 'hard_deadline_reached'].includes(stopCause)
      ? '自动续跑轮次达到 300 秒执行边界。'
      : '自动续跑未能关闭全部任务义务。',
    status: 'remaining'
  });
  return items.slice(0, 8);
}

function mergeContinuationItems(...lists) {
  const seen = new Set();
  return lists.flatMap((list) => Array.isArray(list) ? list : []).filter((item) => {
    const key = String(item?.title || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function appendContinuationReport(answer, continuation) {
  const completed = continuation.completedItems.map((item) => `- ${item.title}`).join('\n') || '- 暂无可确认完成项';
  const remaining = continuation.remainingItems.map((item) => `- ${item.title}${item.detail ? `：${item.detail}` : ''}`).join('\n');
  return [
    String(answer || '').trim(),
    '本次任务已经自动续跑 1 次，达到本轮自动执行上限。',
    '已完成：',
    completed,
    '尚未完成：',
    remaining,
    '是否继续完成剩余工作？'
  ].filter(Boolean).join('\n\n');
}

async function executionCheckpointObservability(config, runId) {
  const run = await config.conversation.getRun(runId);
  if (!run) {
    const error = new Error('Teacher run not found');
    error.code = 'RUN_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  const [entries, failures] = await Promise.all([
    config.conversation.listExecutionCheckpointTimeline(runId, { limit: 200 }),
    config.conversation.getFailureObservability({ windowHours: 168, limit: 100 })
  ]);
  const failure = (failures?.recent || []).find((item) => item.runId === runId);
  const timeline = entries.map((entry, index) => executionTimelineItem(
    entry,
    entries[index - 1],
    failure,
    index === entries.length - 1
  ));
  const regeneration = candidateRegenerationDespiteCheckpoint(timeline);
  const alerts = executionObservabilityAlerts(timeline, failure, regeneration);
  const latestMetadata = entries.at(-1)?.checkpoint?.metadata || {};
  return {
    runId,
    policy: {
      versionId: String(latestMetadata.resourcePolicyVersion || ''),
      checksum: String(latestMetadata.resourcePolicyChecksum || '')
    },
    timeline,
    alerts
  };
}

function executionTimelineItem(entry, previous, failure, isLatest) {
  const checkpoint = entry?.checkpoint || {};
  const repairMetrics = checkpoint?.repairState?.metrics || {};
  const admissions = Array.isArray(checkpoint?.repairState?.contextAdmissions)
    ? checkpoint.repairState.contextAdmissions
    : [];
  const latestAdmission = admissions.at(-1) || {};
  const createdAtMs = Date.parse(checkpoint.createdAt || '');
  const previousAtMs = Date.parse(previous?.checkpoint?.createdAt || '');
  const durationMs = Number.isFinite(createdAtMs) && Number.isFinite(previousAtMs)
    ? Math.max(0, createdAtMs - previousAtMs)
    : 0;
  const metadata = checkpoint.metadata || {};
  const isLatestDelivery = metadata.frontendResultReturned === true
    || (isLatest && failure?.frontendResultReturned === true);
  return {
    checkpointId: String(checkpoint.checkpointId || ''),
    revision: Number(checkpoint.revision || 0),
    phase: String(checkpoint.phase || ''),
    createdAt: checkpoint.createdAt || null,
    candidateArtifactId: checkpoint.candidateArtifactId || null,
    validationArtifactId: checkpoint.validationArtifactId || null,
    repairRound: Number(checkpoint.repairRound || 0),
    allowedActions: Array.isArray(entry?.execution?.decision?.allowedActions)
      ? entry.execution.decision.allowedActions.slice(0, 3)
      : [],
    degraded: metadata.degraded === true || failure?.status === 'degraded',
    errorCategory: String(metadata.errorCategory || executionFailureCategory(failure) || ''),
    frontendResultReturned: isLatestDelivery,
    engineeringDeliveryStatus: String(metadata.engineeringDeliveryStatus || ''),
    selectionReason: String(metadata.selectionReason || ''),
    engineeringResolution: String(metadata.engineering?.verification || ''),
    revisionDelivered: metadata.engineering?.revisionDelivered === true
      || metadata.engineering?.revisionAdopted === true,
    metrics: {
      durationMs,
      contextTokens: Number(repairMetrics.maxInputAfterPrune || latestAdmission.estimatedInputTokens || 0),
      promptTokens: Number(repairMetrics.maxInputBeforePrune || latestAdmission.estimatedInputTokensBeforePrune || 0),
      messageCount: Number(latestAdmission.messageCountAfterPrune || 0),
      noProgressRounds: repairMetrics.noProgress === true ? 2 : 0,
      contextCompactionRequired: repairMetrics.contextInflationDetected === true,
      prunedInputTokens: Number(repairMetrics.prunedInputTokens || 0)
    }
  };
}

function candidateRegenerationDespiteCheckpoint(timeline) {
  let currentCandidate = '';
  let repairAdmitted = false;
  let count = 0;
  for (const item of timeline) {
    if (item.phase === 'validation_failed' || item.phase === 'repair_in_progress') repairAdmitted = true;
    const candidateId = String(item.candidateArtifactId || '');
    if (!candidateId) continue;
    const repairCandidate = repairAdmitted || Number(item.repairRound || 0) > 0;
    if (currentCandidate && candidateId !== currentCandidate && !repairCandidate) count += 1;
    if (candidateId !== currentCandidate) {
      currentCandidate = candidateId;
      repairAdmitted = false;
    }
  }
  return count;
}

function executionObservabilityAlerts(timeline, failure, regeneration) {
  const alerts = [];
  if (regeneration > 0) alerts.push({
    code: 'candidate_regenerated_despite_checkpoint',
    category: 'checkpoint_failure',
    message: `检测到 ${regeneration} 次已有 Candidate 后的非 Repair 重生成。`,
    severity: 'error'
  });
  if (timeline.some((item) => item.metrics?.noProgressRounds >= 2)) alerts.push({
    code: 'repair_no_progress', category: 'repair_no_progress', message: 'Repair 连续两轮没有减少问题集。', severity: 'warning'
  });
  if (timeline.some((item) => item.metrics?.contextCompactionRequired === true)) alerts.push({
    code: 'context_inflation', category: 'context_bloat', message: 'Repair 输入在裁剪前出现上下文膨胀。', severity: 'warning'
  });
  for (const reasonCode of Array.isArray(failure?.reasonCodes) ? failure.reasonCodes : []) {
    alerts.push({
      code: String(reasonCode).slice(0, 100),
      category: executionFailureCategory(failure),
      message: '该异常已按运行审计策略记录；学生可见响应未包含内部堆栈。',
      severity: failure?.frontendResultReturned ? 'warning' : 'error',
      createdAt: failure?.createdAt || null
    });
  }
  return alerts.slice(0, 20);
}

function executionFailureCategory(failure) {
  const signal = [failure?.stopReason, ...(failure?.reasonCodes || [])].join(' ').toLowerCase();
  if (/checkpoint/u.test(signal)) return 'checkpoint_failure';
  if (/timeout|deadline/u.test(signal)) return 'provider_timeout';
  if (/no[_ -]?progress/u.test(signal)) return 'repair_no_progress';
  if (/context/u.test(signal)) return 'context_inflation';
  return failure?.status === 'degraded' ? 'degraded_incomplete' : '';
}

function safeClarificationId(value) {
  const text = String(value || '').trim();
  return /^clar_[a-zA-Z0-9-]{8,120}$/.test(text) ? text : '';
}

async function health(config) {
  const [retrieval, agentRuntime] = await Promise.all([
    retrieverStatus(config.knowledge),
    agentRuntimeReadiness(config)
  ]);
  const runtimeReady = isAgentRuntimeReady(config, retrieval, agentRuntime);
  return {
    ok: runtimeReady,
    service: 'teacher',
    contractVersion: CONTRACT_VERSION,
    provider: providerPublicState(config),
    providerResources: providerResourcePublicState(config),
    retrieval: {
      mode: retrieval.mode,
      enabled: true,
      ready: retrieval.ready !== false,
      cardCount: retrieval.cardCount || 0,
      tenantId: retrieval.tenantId,
      activeBundle: retrieval.activeBundle,
      error: retrieval.error
    },
    knowledgePolicy: {
      activeBundleRequired: config.activeBundleRequired,
      reviewedKnowledgeActive: Boolean(retrieval.activeBundle)
    },
    agentRuntime: publicAgentRuntimeState(agentRuntime, config),
    domainWebSearch: await domainWebSearchPublicState(config),
    limits: {
      maxRequestBytes: config.maxRequestBytes
    }
  };
}

async function capabilities(config) {
  const [retrieval, agentRuntime] = await Promise.all([
    retrieverStatus(config.knowledge),
    agentRuntimeReadiness(config)
  ]);
  const runtimeReady = isAgentRuntimeReady(config, retrieval, agentRuntime);
  return {
    contractVersion: CONTRACT_VERSION,
    service: 'teacher',
    supportedRuntimes: ['ai-sdk'],
    runtimeReadiness: {
      'ai-sdk': runtimeReady
    },
    agentRuntime: publicAgentRuntimeState(agentRuntime, config),
    domainWebSearch: await domainWebSearchPublicState(config),
    toolSchemaVersion: agentRuntime.toolSchemaVersion,
    buildVersion: agentRuntime.buildVersion,
    provider: providerPublicState(config),
    providerResources: providerResourcePublicState(config),
    retrieval: {
      mode: retrieval.mode,
      enabled: true,
      ready: retrieval.ready !== false,
      cardCount: retrieval.cardCount || 0,
      tenantId: retrieval.tenantId,
      activeBundle: retrieval.activeBundle,
      error: retrieval.error
    },
    knowledgePolicy: {
      activeBundleRequired: config.activeBundleRequired,
      reviewedKnowledgeActive: Boolean(retrieval.activeBundle)
    },
    limits: {
      maxRequestBytes: config.maxRequestBytes
    },
    capabilities: [
      {
        id: 'answer',
        route: '/v1/teacher/answer',
        enabled: isProviderEnabled(config),
        answerTypes: ['agentic_answer'],
        streaming: true,
        patchSuggestions: 'single_line_only'
      },
      {
        id: 'validate_patch',
        route: '/v1/teacher/validate-patch',
        enabled: true,
        answerTypes: ['patch_validation'],
        streaming: false,
        patchSuggestions: 'single_line_only'
      },
      {
        id: 'retrieval_debug',
        route: '/v1/retrieval/debug',
        enabled: true,
        answerTypes: ['retrieval_debug'],
        streaming: false,
        patchSuggestions: false
      }
    ]
  };
}

function providerPublicState(config) {
  if (!config.providerEnabled || ['disabled', 'off', 'none'].includes(config.providerMode)) {
    return { mode: 'disabled', enabled: false };
  }
  return llmPublicState(config);
}

function safeAutomaticContinuationSourceRunId(value) {
  const text = String(value || '').trim();
  return /^run_[a-zA-Z0-9-]{8,160}$/.test(text) ? text : '';
}

function safeAutomaticContinuationKind(value) {
  return value === 'engineering_improvement' ? 'engineering_improvement' : 'execution_completion';
}

function safeAutomaticContinuationBudget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const effectiveDurationMs = Number(value.effectiveDurationMs);
  if (!Number.isInteger(effectiveDurationMs) || effectiveDurationMs <= 0) return undefined;
  return Object.freeze({ effectiveDurationMs });
}

function safeManualContinuationSourceRunId(value) {
  const text = String(value || '').trim();
  return /^run_[a-zA-Z0-9-]{8,160}$/.test(text) ? text : '';
}

function safeManualContinuationKind(value) {
  return value === 'engineering_feedback' ? 'engineering_feedback' : '';
}

function providerResourcePublicState(config) {
  const gateway = config.providerGateway;
  return {
    maxConcurrency: Number(gateway?.settings?.maxConcurrency || 0),
    queueLimit: Number(gateway?.settings?.queueLimit || 0),
    legacyQueueTimeoutMs: Number(gateway?.settings?.queueTimeoutMs || 0),
    inFlight: Number(gateway?.state?.inFlight || 0),
    queueDepth: Array.isArray(gateway?.state?.queue) ? gateway.state.queue.length : 0
  };
}

function isProviderEnabled(config) {
  return providerPublicState(config).enabled;
}

async function handleTeacherRequest(req, res, payload, config, responder) {
  const providerState = providerPublicState(config);
  if (!providerState.enabled) {
    const reason = providerState.reason ? `: ${providerState.reason}` : '';
    return send(res, 503, publicError('PROVIDER_DISABLED', `AI teacher provider is disabled for this service${reason}`, 503), config);
  }

  const contract = validateHostContextEnvelope(payload);
  if (!contract.ok) {
    return send(res, 400, {
      error: {
        code: 'INVALID_CONTRACT',
        message: 'HostContextEnvelope is invalid',
        details: contract.errors
      }
    }, config);
  }

  const startMetadata = await runtimeStartMetadata(contract.value, config);

  const thread = await config.conversation.ensureThread(contract.value, payload.threadId || contract.value.threadId);
  const execution = await createOrResumeRun(config.conversation, {
    threadId: thread.threadId,
    context: contract.value,
    intent: 'single_entry',
    route: responder.name || 'teacher_request'
  }, { automaticContinuationEnabled: config.automaticContinuationEnabled });
  const run = execution.run;
  if (execution.reused) {
    if (execution.response) {
      const sent = send(res, 200, execution.response, config);
      const executionDelivery = await loadExecutionCheckpointForDelivery(config, run, execution.response);
      await persistExecutionDeliveryCheckpointFailSoft(config, run, execution.response, executionDelivery.latest, true);
      return sent;
    }
    return execution.automaticContinuation
      ? send(res, 409, publicError('AUTOMATIC_CONTINUATION_IN_PROGRESS', 'Automatic continuation is already in progress.', 409), config)
      : execution.manualContinuation
        ? send(res, 409, publicError('MANUAL_CONTINUATION_IN_PROGRESS', 'Manual continuation is already in progress.', 409), config)
        : send(res, 409, publicError('CLARIFICATION_RESUME_IN_PROGRESS', 'Clarification resume is already in progress.', 409), config);
  }
  const persistedResume = persistedCompletedResumeResponse({
    execution,
    context: contract.value,
    startMetadata,
    run,
    thread
  });
  if (persistedResume) {
    const responseContract = validateTeacherCapabilityResponse(persistedResume.response, contract.value);
    if (!responseContract.ok) {
      await config.conversation.failRun({
        runId: run.runId,
        error: Object.assign(new Error('Persisted Teacher response failed contract validation'), {
          code: 'INVALID_PERSISTED_TEACHER_RESPONSE',
          statusCode: 500
        })
      });
      return send(res, 500, publicError('INVALID_PERSISTED_TEACHER_RESPONSE', 'Teacher service failed to process the request', 500), config);
    }
    const persisted = await config.conversation.completeRun({
      runId: run.runId,
      context: contract.value,
      response: persistedResume.response,
      providerMeta: persistedResume.internal
    });
    const executionDelivery = await loadExecutionCheckpointForDelivery(config, run, persistedResume.response);
    await persistExecutionDeliveryCheckpointFailSoft(config, run, persistedResume.response, executionDelivery.latest, false);
    persistedResume.response.threadId = thread.threadId;
    persistedResume.response.runId = run.runId;
    persistedResume.response.messageId = persisted.messageId;
    const sent = send(res, 200, persistedResume.response, config);
    await persistExecutionDeliveryCheckpointFailSoft(config, run, persistedResume.response, executionDelivery.latest, true);
    return sent;
  }
  const controller = new AbortController();
  config.activeRuns.set(run.runId, { controller, writer: null, runtime: runtimeUsed(contract.value) });
  const abortForDisconnect = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort(Object.assign(new Error('Teacher client disconnected'), {
        code: 'TEACHER_RUN_CANCELLED',
        statusCode: 499
      }));
    }
  };
  req.once('aborted', abortForDisconnect);
  res.once('close', abortForDisconnect);
  try {
    const budgetError = await checkTokenBudget(config, contract.value);
    if (budgetError) throw budgetError;
    const previousMessages = await config.conversation.listSuccessfulMessages(thread.threadId, 8);
    const context = {
      ...contract.value,
      threadId: thread.threadId,
      conversation: {
        ...(contract.value.conversation || {}),
        recentMessages: previousMessages.map((message) => ({
          role: message.role,
          content: message.content,
          createdAt: message.createdAt || message.created_at || ''
        }))
      }
    };
    const requestConfig = resourcePolicyConfigForContext(config, context);
    const response = await responder(context, {
      ...requestConfig,
      abortSignal: controller.signal,
      runId: run.runId,
      workflowResume: execution.workflowResume
    });
    throwIfRunAborted(controller.signal);
    const runtimeAttestation = response.__runtimeAttestation;
    delete response.__runtimeAttestation;
    const finalRuntimeMetadata = runtimeMetadata(context, runtimeAttestation);
    Object.assign(response, finalRuntimeMetadata);
    const internal = response.__internal || {};
    const checkpoint = attachClarificationCheckpoint(response, run, thread, internal, config);
    const executionDelivery = await loadExecutionCheckpointForDelivery(config, run, response);
    attachExecutionContinuation(response, {
      execution,
      run,
      internal,
      enabled: config.automaticContinuationEnabled,
      recoveryAvailable: executionDelivery.recoveryAvailable
    });
    attachEngineeringFeedbackAction(response, run);
    const responseContract = validateTeacherCapabilityResponse(response, context);
    if (!responseContract.ok) {
      const error = new Error('Teacher response failed contract validation');
      error.statusCode = 500;
      error.code = 'INVALID_TEACHER_RESPONSE';
      error.details = responseContract.errors;
      throw error;
    }
    delete response.__internal;
    const persisted = checkpoint
      ? await config.conversation.pauseRunForClarification({ runId: run.runId, context, response, providerMeta: internal, checkpoint })
      : await config.conversation.completeRun({ runId: run.runId, context, response, providerMeta: internal });
    if (persisted.cancelled) throwIfRunAborted(controller.signal);
    if (!checkpoint) {
      await persistExecutionDeliveryCheckpointFailSoft(config, run, response, executionDelivery.latest, false);
    }
    response.threadId = thread.threadId;
    response.runId = run.runId;
    response.messageId = persisted.messageId;
    const sent = send(res, 200, response, config);
    if (!checkpoint) {
      await persistExecutionDeliveryCheckpointFailSoft(config, run, response, executionDelivery.latest, true);
    }
    return sent;
  } catch (error) {
    if (controller.signal.aborted || error.code === 'TEACHER_RUN_CANCELLED') {
      await config.conversation.cancelRun({ runId: run.runId, error });
    } else {
      await config.conversation.failRun({ runId: run.runId, error });
    }
    if (error.code === 'TOKEN_BUDGET_EXCEEDED') {
      await config.conversation.recordAuditEvent({
        eventType: 'teacher.budget.rejected',
        tenantId: contract.value.tenant?.tenantId || '',
        userId: contract.value.tenant?.userId || '',
        requestId: contract.value.requestId || '',
        runId: run.runId,
        status: 'rejected',
        metadata: { reason: 'daily_token_budget' }
      });
    }
    const agentFailure = publicAgentFailureEnvelope(error, {
      runId: run.runId,
      threadId: thread.threadId,
      runtime: startMetadata
    });
    if (agentFailure) {
      const status = error.statusCode || error.status || 503;
      const errorPayload = {
        code: error.code || 'TEACHER_RUN_FAILED',
        message: error.message,
        status,
        ...agentFailure
      };
      await config.conversation.recordRunEvent({
        runId: run.runId,
        eventType: 'error',
        payload: errorPayload
      }).catch(() => {});
      return send(res, status, {
        ...publicError(errorPayload.code, errorPayload.message, status),
        ...agentFailure
      }, config);
    }
    if (error.code === 'INVALID_TEACHER_RESPONSE') {
      return send(res, 500, {
        error: {
          code: 'INVALID_TEACHER_RESPONSE',
          message: 'Teacher response failed contract validation',
          details: error.details || []
        }
      }, config);
    }
    throw error;
  } finally {
    config.activeRuns.delete(run.runId);
    req.off('aborted', abortForDisconnect);
    res.off('close', abortForDisconnect);
  }
}

async function domainWebSearchPublicState(config) {
  const runtime = deepSeekWebSearchPublicState(config.domainWebSearch);
  const probe = await config.domainWebSearchProbe.publicState();
  if (!runtime.enabled || runtime.verificationStatus !== 'not_checked') return { ...runtime, probe };
  if (probe.status === 'complete') {
    return {
      ...runtime,
      ready: true,
      reason: undefined,
      verificationStatus: 'complete',
      lastCheckedAt: probe.lastCheckedAt || undefined,
      warningCode: probe.warningCode || undefined,
      probe
    };
  }
  if (probe.status === 'partial' || probe.status === 'unavailable') {
    return {
      ...runtime,
      ready: false,
      reason: probe.status === 'partial' ? 'provider_partial' : 'provider_unavailable',
      verificationStatus: probe.status,
      lastCheckedAt: probe.lastCheckedAt || undefined,
      warningCode: probe.warningCode || undefined,
      probe
    };
  }
  return { ...runtime, probe };
}

function isAgentRuntimeReady(config, retrieval, agentRuntime) {
  const activeBundle = retrieval?.activeBundle;
  const persistentKnowledgeStorageReady = retrieval?.mode === 'postgres_pgvector'
    && (retrieval?.ready === true
      || (!config.activeBundleRequired
        && retrieval?.error === 'ACTIVE_SYSML_KNOWLEDGE_BUNDLE_REQUIRED'));
  const activeBundleReady = !config.activeBundleRequired
    || (/^sha256:[a-f0-9]{64}$/.test(String(activeBundle?.sourceRegistryHash || ''))
      && /^sha256:[a-f0-9]{64}$/.test(String(activeBundle?.contentHash || '')));
  return isProviderEnabled(config)
    && agentRuntime?.ready === true
    && persistentKnowledgeStorageReady
    && activeBundleReady;
}

function publicAgentRuntimeState(agentRuntime, config) {
  return {
    supported: agentRuntime?.supported === true,
    ready: agentRuntime?.ready === true,
    toolSchemaVersion: String(agentRuntime?.toolSchemaVersion || ''),
    buildVersion: String(agentRuntime?.buildVersion || ''),
    promptVersion: String(agentRuntime?.promptVersion || ''),
    promptHash: String(agentRuntime?.promptHash || ''),
    maxOutputTokens: Number.isFinite(agentRuntime?.maxOutputTokens) ? agentRuntime.maxOutputTokens : undefined,
    outputBudgetMode: String(agentRuntime?.outputBudgetMode || ''),
    temperature: Number.isFinite(agentRuntime?.temperature) ? agentRuntime.temperature : undefined,
    reasoningMode: String(agentRuntime?.reasoningMode || ''),
    providerCompatibility: ['generic-openai', 'deepseek-v4-direct', 'deepseek-v4-litellm']
      .includes(config?.agentProviderCompatibility)
      ? config.agentProviderCompatibility
      : 'generic-openai',
    answerMode: String(agentRuntime?.answerMode || ''),
    errorCode: agentRuntime?.ready === true ? undefined : String(agentRuntime?.errorCode || '')
  };
}

async function checkTokenBudget(config, context) {
  if (!config.tokenBudgetDaily) return null;
  const tenantId = context.tenant?.tenantId || 'local-dev';
  const userId = context.tenant?.userId || 'unscoped-user';
  const used = await config.conversation.dailyUsageTokens(tenantId, userId);
  if (used < config.tokenBudgetDaily) return null;
  const error = new Error('AI teacher daily token budget exceeded');
  error.statusCode = 429;
  error.code = 'TOKEN_BUDGET_EXCEEDED';
  return error;
}

async function answerCapability(context, config) {
  return runAgentCapability(context, config);
}

function validateSingleLinePatchPayload(payload) {
  const contextPayload = payload.context || payload.envelope || payload.hostContext || {};
  const patch = payload.patch || (Array.isArray(payload.patches) ? payload.patches[0] : null);
  const contract = validateHostContextEnvelope(contextPayload);
  if (!contract.ok) {
    return {
      ok: false,
      code: 'INVALID_CONTRACT',
      errors: contract.errors
    };
  }
  const validation = validateSingleLinePatchSuggestion(patch, contract.value);
  if (!validation.ok) {
    return {
      ok: false,
      code: 'INVALID_PATCH',
      errors: validation.errors
    };
  }
  const applied = applySingleLinePatchSuggestion(patch, contract.value);
  if (!applied.ok) {
    return {
      ok: false,
      code: 'PATCH_APPLY_FAILED',
      errors: applied.errors
    };
  }
  return {
    ok: true,
    mode: 'single_line_patch',
    patch: {
      ...patch,
      validatorStatus: patch.validatorStatus || 'not_validated',
      applyPolicy: 'copy_only'
    },
    files: applied.files,
    warnings: []
  };
}

function responseId(prefix, requestId) {
  const safeRequestId = String(requestId || 'local').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return `${prefix}_${safeRequestId}`;
}

function requireInternalToken(req, config) {
  if (!config.internalToken && process.env.NODE_ENV === 'test') return null;
  if (req.headers['x-ai-teacher-token'] === config.internalToken) return null;
  return {
    status: 401,
    body: publicError('UNAUTHORIZED', 'Teacher internal token is missing or invalid', 401)
  };
}

function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let sizeError = null;
    req.on('data', (chunk) => {
      total += chunk.length;
      const size = validateRequestSize(total, maxBytes);
      if (!size.ok && !sizeError) {
        const error = new Error(size.errors[0]);
        error.statusCode = 413;
        sizeError = error;
      }
      if (!sizeError) chunks.push(chunk);
    });
    req.on('end', () => {
      if (sizeError) return reject(sizeError);
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload, config) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-ai-teacher-token',
    'cache-control': 'no-store'
  };
  if (!config || config.allowCors) headers['access-control-allow-origin'] = '*';
  res.writeHead(status, headers);
  res.end(status === 204 ? '' : JSON.stringify(payload, null, 2));
}

function contextFromQuery(url) {
  return {
    requestId: url.searchParams.get('requestId') || '',
    tenant: {
      tenantId: url.searchParams.get('tenantId') || 'local-dev',
      userId: url.searchParams.get('userId') || 'unscoped-user'
    },
    course: {
      coursePackId: url.searchParams.get('coursePackId') || '',
      courseId: url.searchParams.get('courseId') || '',
      lessonId: url.searchParams.get('lessonId') || ''
    }
  };
}

function browserRunEvent(event) {
  return {
    eventId: event.eventId,
    runId: event.runId,
    seq: event.seq,
    type: event.eventType || event.type || '',
    payload: event.payload || {},
    createdAt: event.createdAt
  };
}

function runMatchesContext(run, context) {
  return String(run?.tenantId || '') === String(context?.tenant?.tenantId || '')
    && String(run?.userId || '') === String(context?.tenant?.userId || '');
}

function runtimeUsed(context) {
  if (context?.runtimeAssignment?.runtime !== 'ai-sdk') {
    const error = new Error('AI Teacher requires the single ai-sdk Agent runtime assignment.');
    error.code = 'AI_TEACHER_AGENT_ASSIGNMENT_REQUIRED';
    error.statusCode = 503;
    throw error;
  }
  return 'ai-sdk';
}

async function runtimeStartMetadata(context, config) {
  runtimeUsed(context);
  resourcePolicyConfigForContext(config, context);
  const workflowVersion = freezeAgentWorkflowVersion(context);
  const readiness = await agentRuntimeReadiness({ ...config, workflowVersion });
  if (!readiness.ready) {
    const error = new Error('AI Teacher Agent runtime is not ready.');
    error.code = readiness.errorCode || 'AI_TEACHER_AGENT_BUILD_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  return runtimeMetadata(context, {
    runtimeUsed: 'ai-sdk',
    workflowVersion,
    toolSchemaVersion: readiness.toolSchemaVersion,
    buildVersion: readiness.buildVersion,
    promptVersion: readiness.promptVersion,
    promptHash: readiness.promptHash,
    modelAlias: readiness.modelAlias,
    temperature: readiness.temperature,
    reasoningMode: readiness.reasoningMode,
    answerMode: readiness.answerMode
  });
}

function runtimeMetadata(context, attestation) {
  runtimeUsed(context);
  const expected = context?.runtimeAssignment || {};
  const workflowVersion = frozenAgentWorkflowVersion(context);
  const attestedWorkflowVersion = attestation?.workflowVersion;
  const resourcePolicySnapshot = expected.resourcePolicySnapshot;
  const resourcePolicyValidation = validateAgentResourcePolicySnapshot(resourcePolicySnapshot);
  if (attestation?.runtimeUsed !== 'ai-sdk'
    || attestation?.toolSchemaVersion !== AGENT_TOOL_SCHEMA_VERSION
    || !attestation?.buildVersion
    || !attestation?.promptVersion
    || !/^sha256:[a-f0-9]{64}$/.test(String(attestation?.promptHash || ''))
    || !attestation?.modelAlias
    || !Number.isFinite(attestation?.temperature)
    || !['adaptive', 'provider-managed', 'max', 'high', 'medium', 'disabled'].includes(attestation?.reasoningMode)
    || attestation?.answerMode !== 'result_bound_v2'
    || attestedWorkflowVersion !== workflowVersion
    || (expected.toolSchemaVersion && expected.toolSchemaVersion !== attestation.toolSchemaVersion)
    || (expected.buildVersion && expected.buildVersion !== attestation.buildVersion)
    || !resourcePolicyValidation.ok) {
    const error = new Error('AI Teacher Agent runtime attestation mismatch.');
    error.code = 'AI_TEACHER_RUNTIME_ATTESTATION_MISMATCH';
    error.statusCode = 503;
    throw error;
  }
  return {
    runtimeUsed: attestation.runtimeUsed,
    runtimeAssignmentId: String(expected.runtimeAssignmentId || ''),
    workflowVersion,
    toolSchemaVersion: attestation.toolSchemaVersion,
    buildVersion: attestation.buildVersion,
    promptVersion: attestation.promptVersion,
    promptHash: attestation.promptHash,
    temperature: attestation.temperature,
    reasoningMode: attestation.reasoningMode,
    answerMode: attestation.answerMode,
    resourcePolicyVersion: resourcePolicySnapshot.versionId,
    resourcePolicyChecksum: resourcePolicySnapshot.checksum
  };
}

function freezeAgentWorkflowVersion(context) {
  const assignment = context?.runtimeAssignment;
  if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) {
    const error = new Error('AI Teacher requires a trusted runtime assignment before starting a Run.');
    error.code = 'AI_TEACHER_AGENT_ASSIGNMENT_REQUIRED';
    error.statusCode = 503;
    throw error;
  }

  const assigned = assignment.workflowVersion;
  if (assigned !== undefined && assigned !== 'intent-orchestrator-v2') {
    const error = new Error('AI Teacher workflow assignment is invalid.');
    error.code = 'AI_TEACHER_WORKFLOW_ASSIGNMENT_INVALID';
    error.statusCode = 503;
    throw error;
  }
  if (assigned === undefined) {
    assignment.workflowVersion = 'intent-orchestrator-v2';
  }
  return frozenAgentWorkflowVersion(context);
}

function publicAgentFailureEnvelope(error, identity) {
  const stopReason = String(error?.agent?.stopReason || '');
  if (![
    'policy_violation',
    'timeout',
    'step_limit',
    'provider_error',
    'repair_step_timeout',
    'validator_queue_full',
    'validator_queue_timeout',
    'validator_execution_timeout',
    'validator_unavailable'
  ].includes(stopReason)) return null;
  const trace = error?.agent?.intentV2Trace || {};
  const phaseTimings = publicFailurePhaseTimings(error?.agent?.phaseTimings).slice(0, 8);
  return {
    runId: safeFailureId(identity?.runId, 160),
    threadId: safeFailureId(identity?.threadId, 160),
    ...publicFailureRuntime(identity?.runtime),
    agentTrace: {
      workflowVersion: 'intent-orchestrator-v2',
      status: 'failed',
      workerType: 'main',
      candidateValidated: false,
      stepCount: safeFailureInteger(error?.agent?.stepCount),
      stopReason,
      stopCause: ['caller_cancelled', 'work_deadline_reached', 'hard_deadline_reached'].includes(error?.agent?.stopCause)
        ? error.agent.stopCause
        : undefined,
      scopeHintCount: safeFailureInteger(trace.scopeHintCount),
      refusedHintCount: safeFailureInteger(trace.refusedHintCount),
      gateCallCount: safeFailureInteger(trace.gateCallCount),
      gateDecisionStatus: ['completed', 'incomplete'].includes(trace.gateDecisionStatus)
        ? trace.gateDecisionStatus
        : 'incomplete',
      gateOutcome: ['pass', 'mixed_scope_risk', 'reject'].includes(trace.gateOutcome)
        ? trace.gateOutcome
        : 'pass',
      phaseTimings
    },
    tokenUsage: {
      promptTokens: safeFailureInteger(error?.promptTokens),
      completionTokens: safeFailureInteger(error?.completionTokens),
      reasoningTokens: safeFailureInteger(error?.reasoningTokens),
      totalTokens: safeFailureInteger(error?.totalTokens)
    }
  };
}

function publicFailurePhaseTimings(value) {
  const allowed = new Set([
    'scope_gate', 'main_agent_orchestration', 'candidate_generation',
    'candidate_repair', 'validator_execution', 'answer_generation', 'total'
  ]);
  return (Array.isArray(value) ? value : []).slice(0, 16).flatMap((item) => {
    const phase = String(item?.phase || '');
    if (!allowed.has(phase)) return [];
    return [{
      phase,
      durationMs: safeFailureInteger(item?.durationMs),
      occurrences: safeFailureInteger(item?.occurrences)
    }];
  });
}

function publicFailureRuntime(runtime) {
  return {
    runtimeUsed: 'ai-sdk',
    runtimeAssignmentId: safeFailureId(runtime.runtimeAssignmentId, 160),
    toolSchemaVersion: safeFailureName(runtime.toolSchemaVersion, 80),
    buildVersion: String(runtime.buildVersion || '').slice(0, 240),
    promptVersion: safeFailureName(runtime.promptVersion, 120),
    promptHash: safeFailureHash(runtime.promptHash),
    temperature: Number.isFinite(runtime.temperature) ? runtime.temperature : 0,
    reasoningMode: ['adaptive', 'provider-managed', 'max', 'high', 'medium', 'disabled'].includes(runtime.reasoningMode)
      ? runtime.reasoningMode
      : 'disabled',
    answerMode: 'result_bound_v2'
  };
}

function safeFailureHash(value) {
  const hash = String(value || '').toLowerCase();
  return /^sha256:[a-f0-9]{64}$/.test(hash) ? hash : '';
}

function safeFailureId(value, limit) {
  return String(value || '').replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, limit);
}

function safeFailureName(value, limit) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, limit);
}

function safeFailureInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function throwIfRunAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Teacher run cancelled');
  error.code = 'TEACHER_RUN_CANCELLED';
  error.statusCode = 499;
  throw error;
}

function createRecordingStream(stream, conversation, runId) {
  let chain = Promise.resolve();
  let writerError = null;
  const enqueue = (type, payload) => {
    chain = chain.then(async () => {
      try {
        await conversation.recordRunEvent({ runId, eventType: type, payload });
      } catch (error) {
        writerError ||= error;
      }
    });
    return chain;
  };
  return {
    write(type, payload = {}) {
      stream.write(type, payload);
      return enqueue(type, payload);
    },
    async writeAndWait(type, payload = {}) {
      stream.write(type, payload);
      await enqueue(type, payload);
      if (writerError) throw writerError;
    },
    async record(type, payload = {}) {
      await enqueue(type, payload);
      if (writerError) throw writerError;
    },
    async drain() {
      await chain;
      if (writerError) throw writerError;
    },
    end() {
      stream.end();
    }
  };
}

function startTeacherNdjsonStream(res, config) {
  const headers = {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'access-control-allow-origin': config?.allowCors ? '*' : undefined,
    'cache-control': 'no-store',
    'x-accel-buffering': 'no'
  };
  Object.keys(headers).forEach((key) => {
    if (headers[key] === undefined) delete headers[key];
  });
  res.writeHead(200, headers);
  return {
    write(type, payload = {}) {
      res.write(`${JSON.stringify({ type, ...payload })}\n`);
    },
    end() {
      res.end();
    }
  };
}

function logRequest(req, url, status, startedAt, config, error) {
  if (process.env.AI_TEACHER_LOG_LEVEL === 'silent') return;
  const body = {
    service: 'teacher',
    method: req.method,
    path: url.pathname,
    status,
    latencyMs: Date.now() - startedAt,
    error: error ? error.message : undefined
  };
  if (status >= 500) {
    console.error(redactSecrets(body, config.secrets));
  }
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => {
    console.log(`teacher listening on ${HOST}:${PORT}`);
  });
}

module.exports = {
  createServer,
  createConfigForEvaluation: createConfig,
  engineeringImprovementServerForTests: Object.freeze({
    attachExecutionContinuation,
    persistedCompletedResumeResponse,
    safeAutomaticContinuationBudget,
    safeAutomaticContinuationKind
  })
};
