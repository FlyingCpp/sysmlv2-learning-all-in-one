'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');

process.env.AI_TEACHER_INTERNAL_TOKEN = process.env.AI_TEACHER_INTERNAL_TOKEN || 'test-teacher-internal-token';
process.env.AI_TEACHER_TOOL_TOKEN = process.env.AI_TEACHER_TOOL_TOKEN || 'test-teacher-validator-tool-token';

const {
  agentOutcomeErrorForTests,
  createAgentContext,
  deriveAgentTaskPolicy,
  runAgentCapability,
  selectAgentWorkflowVersion
} = require('../apps/teacher/agent-adapter');
const { createServer } = require('../apps/teacher/server');
const { createMemoryConversationStore } = require('../apps/teacher/conversation-store');
const {
  hashContent,
  validateHostContextEnvelope,
  validateTeacherCapabilityResponse
} = require('../packages/teacher-contract');
const baseFixture = require('../packages/teacher-contract/fixtures/host-context-basic.json');

function providerUsage(input = 24, output = 12) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 }
  };
}

async function testValidatorObservationPersistence() {
  const conversation = createMemoryConversationStore();
  await conversation.recordToolLedgerEntry({
    runId: 'run_validator_observation',
    toolCallId: 'validator-call-1',
    toolName: 'validate_candidate_workspace',
    argsHash: hashContent('validator-observation-args'),
    status: 'succeeded',
    resultHash: hashContent('validator-observation-result'),
    resultProjection: {
      validatorStatus: 'validated_passed',
      validatorObservations: [{
        attempt: 1,
        admissionOutcome: 'admitted',
        queueWaitMs: 7,
        executionMs: 23,
        retryableBeforeStart: false,
        abortedAfterStart: false,
        candidateContent: 'must not persist'
      }]
    },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });
  const [entry] = await conversation.listToolLedgerEntries('run_validator_observation');
  assert.deepStrictEqual(entry.resultProjection.validatorObservations, [{
    attempt: 1,
    admissionOutcome: 'admitted',
    queueWaitMs: 7,
    executionMs: 23,
    retryableBeforeStart: false,
    abortedAfterStart: false
  }]);
}

function testExplicitRunStopCauses(runtime) {
  const result = { status: 'cancelled', reason: 'cancelled' };
  const open = new AbortController();
  const caller = new AbortController();
  caller.abort(new Error('caller'));
  assert.equal(runtime.intentV2ExecutionTesting.workerStopReason(result, {
    externalSignal: caller.signal,
    workDeadlineSignal: open.signal,
    hardDeadlineSignal: open.signal
  }), 'cancelled');
  assert.equal(runtime.intentV2ExecutionTesting.runStopCauseFromSignals({
    externalSignal: caller.signal,
    workDeadlineSignal: open.signal,
    hardDeadlineSignal: open.signal
  }), 'caller_cancelled');

  const work = new AbortController();
  work.abort(new Error('work'));
  assert.equal(runtime.intentV2ExecutionTesting.workerStopReason(result, {
    workDeadlineSignal: work.signal,
    hardDeadlineSignal: open.signal
  }), 'timeout');
  assert.equal(runtime.intentV2ExecutionTesting.runStopCauseFromSignals({
    workDeadlineSignal: work.signal,
    hardDeadlineSignal: open.signal
  }), 'work_deadline_reached');

  assert.equal(runtime.intentV2ExecutionTesting.workerStopReason({
    status: 'worker_error', reason: 'The operation was aborted due to timeout'
  }, {
    workDeadlineSignal: open.signal,
    hardDeadlineSignal: open.signal,
    workRemainingMs: 0
  }), 'timeout', 'SDK timeout与Work Deadline竞态不得误归类为provider_error');
  assert.equal(runtime.intentV2ExecutionTesting.isInternalDeadlineOutcome({
    response: { stopReason: 'timeout' }
  }, undefined, open.signal, open.signal), true,
  'Provider/阶段timeout先于Run计时器一个tick返回时仍必须形成可交付incomplete结果');
  assert.equal(runtime.intentV2ExecutionTesting.isInternalDeadlineOutcome({
    response: { stopReason: 'timeout' }
  }, caller.signal, open.signal, open.signal), false,
  '调用方主动取消不得借timeout分类发布迟到结果');
  assert.equal(runtime.intentV2ExecutionTesting.classifyFinalAnswerFailureStopReason(
    'The operation timed out before completion', open.signal
  ), 'timeout', 'FinalAnswer自身timeout不得误报为provider_error');
  assert.equal(runtime.intentV2ExecutionTesting.classifyFinalAnswerFailureStopReason(
    'provider unavailable', open.signal
  ), 'provider_error');
  assert.deepEqual(runtime.intentV2ExecutionTesting.finalAnswerTimeoutBudget({
    terminalReserveMs: 60_000,
    hardRemainingMs: 900_000,
    hasSafeFallback: true
  }), { softMs: 60_000, totalMs: 60_000, borrowed: false },
  '存在安全公开兜底时，Finalizer不得借用Run工作预算');
  assert.deepEqual(runtime.intentV2ExecutionTesting.finalAnswerTimeoutBudget({
    terminalReserveMs: 60_000,
    hardRemainingMs: 900_000,
    hasSafeFallback: false
  }), { softMs: 60_000, totalMs: 900_000, borrowed: true },
  'tool-only Direct没有公开草稿时，必须允许同一次Finalizer使用全部Run剩余硬预算');
  assert.deepEqual(runtime.intentV2ExecutionTesting.finalAnswerTimeoutBudget({
    terminalReserveMs: 60_000,
    hardRemainingMs: 75_000,
    hasSafeFallback: false
  }), { softMs: 60_000, totalMs: 75_000, borrowed: true },
  '借用预算不得越过Run hard deadline');
  assert.deepEqual(runtime.intentV2ExecutionTesting.finalAnswerTimeoutBudget({
    terminalReserveMs: 60_000,
    hardRemainingMs: 40_000,
    hasSafeFallback: false
  }), { softMs: 40_000, totalMs: 40_000, borrowed: false },
  'Run剩余不足软预算时不得伪造额外时间');
  assert.equal(runtime.intentV2ExecutionTesting.workerStopReason({
    status: 'worker_error', reason: 'VALIDATOR_QUEUE_FULL:Candidate Validator tool rejected the request.'
  }, {
    workDeadlineSignal: open.signal,
    hardDeadlineSignal: open.signal,
    workRemainingMs: 120_000
  }), 'validator_queue_full', 'Validator容量拒绝必须形成可交付资源终态');
  assert.equal(runtime.intentV2ExecutionTesting.workerStopReason({
    status: 'exhausted', reason: 'validator_queue_full'
  }, {
    workDeadlineSignal: open.signal,
    hardDeadlineSignal: open.signal,
    workRemainingMs: 120_000
  }), 'validator_queue_full', 'Repair归一化容量终态必须保持可交付分类');
  const readOnlyFailure = {
    status: 'worker_error',
    reason: 'CANDIDATE_TARGET_READ_ONLY:Read-only candidate must match the trusted snapshot: file_test'
  };
  assert.equal(runtime.intentV2ExecutionTesting.workerStopReason(readOnlyFailure, {
    workDeadlineSignal: open.signal,
    hardDeadlineSignal: open.signal,
    workRemainingMs: 120_000
  }), 'policy_violation', '只读候选拒绝不得误报为Provider故障');
  assert.deepEqual(runtime.intentV2ExecutionTesting.workerFailureWarnings(readOnlyFailure), [
    'workflow_fail_closed:candidate_read_only_target'
  ]);

  const hard = new AbortController();
  hard.abort(new Error('hard'));
  assert.equal(runtime.intentV2ExecutionTesting.workerStopReason(result, {
    workDeadlineSignal: work.signal,
    hardDeadlineSignal: hard.signal
  }), 'hard_timeout');
  assert.equal(runtime.intentV2ExecutionTesting.runStopCauseFromSignals({
    workDeadlineSignal: work.signal,
    hardDeadlineSignal: hard.signal
  }), 'hard_deadline_reached');
}

function generatedText(text, finishReason = 'stop') {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: finishReason, raw: finishReason },
    usage: providerUsage(),
    warnings: []
  };
}

function generatedToolCalls(calls, text) {
  return {
    content: text ? [...calls, { type: 'text', text }] : calls,
    finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
    usage: providerUsage(),
    warnings: []
  };
}

function generatedDirectAnswer(text = '') {
  return generatedToolCalls([
    toolCall(`direct-answer-${crypto.randomUUID()}`, 'request_final_answer', {})
  ], text);
}

function goalCoverage() { return {}; }

function expectedDirectTerminalAnswer(text) {
  return text;
}

const EXPECTED_INCOMPLETE_TERMINAL_ANSWER = '本轮未形成可交付候选。本轮没有形成可绑定的 Official Validator PASS。';

function toolCall(toolCallId, toolName, input) {
  return { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) };
}

function generationToolNames(call) {
  return (Array.isArray(call?.tools) ? call.tools : [])
    .map((entry) => String(entry?.name || entry?.toolName || ''))
    .filter(Boolean);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function testModelCallAuditLedger(runtime) {
  const conversation = createMemoryConversationStore();
  const context = {
    requestId: 'req_model_call_audit',
    tenant: { tenantId: 'tenant-audit', userId: 'student-audit' },
    course: { coursePackId: 'course-pack-audit', courseId: 'course-audit', lessonId: 'lesson-audit' },
    question: { text: '请解释这个模型，并保留完整的中文原始请求。' }
  };
  const thread = await conversation.ensureThread(context, 'thread_model_call_audit');
  const run = await conversation.createRun({ threadId: thread.threadId, context, intent: 'analysis', route: 'agent' });
  const received = conversation.state.messages.get(thread.threadId);
  assert.equal(received.length, 1);
  assert.equal(received[0].status, 'received');
  assert.equal(received[0].content, context.question.text);
  const visibleWhileRunning = await conversation.listMessages(thread.threadId, { limit: 10 });
  assert.equal(visibleWhileRunning[0]?.status, 'received',
    'history restore must expose the submitted question while its run is still active');

  const longVisibleText = `完整可见回答:${'证据'.repeat(400)}`;
  const audited = await runtime.withModelCallAuditContext({
    runId: run.runId,
    promptVersion: 'audit-test-v1',
    record: async (entry) => await conversation.recordModelCallLedgerEntry(entry)
  }, async () => {
    await runtime.recordModelGeneration({
      phase: 'scope_gate_v2',
      request: {
        prompt: context.question.text,
        authorization: 'Bearer must-not-be-recorded',
        nested: { apiKey: 'test-api-key-value', keep: 'actual-input' }
      },
      steps: [{
        callId: 'call-audit-1',
        stepNumber: 0,
        model: { provider: 'mock-provider', modelId: 'mock-model' },
        request: {
          messages: [{ role: 'user', content: context.question.text }],
          body: { tools: [{ name: 'submit_scope_advice' }], reasoning_content: 'hidden-input' }
        },
        text: longVisibleText,
        reasoning: [{ type: 'reasoning', text: 'hidden-output' }],
        toolCalls: [{ toolName: 'submit_scope_advice', input: { decision: 'pass' } }],
        response: {
          messages: [{ role: 'assistant', content: [{ type: 'text', text: longVisibleText }, { type: 'reasoning', text: 'hidden-part' }] }],
          body: { result: 'visible', reasoning_content: 'hidden-body' }
        },
        finishReason: 'tool-calls',
        usage: { inputTokens: 21, outputTokens: 34, reasoningTokens: 13, totalTokens: 55 }
      }],
      parserStatus: 'ai_sdk_parsed',
      startedAt: new Date().toISOString()
    });
    return 'done';
  });
  assert.equal(audited.value, 'done');
  assert.deepEqual(audited.failures, []);
  const entries = await conversation.listModelCallLedgerEntries(run.runId);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].phase, 'scope_gate_v2');
  assert.equal(entries[0].outputPayload.visibleText, longVisibleText, 'visible output must not be truncated');
  assert.deepEqual(entries[0].outputPayload.toolCalls,
    [{ toolName: 'submit_scope_advice', input: { decision: 'pass' } }]);
  const serialized = JSON.stringify(entries[0]);
  assert.doesNotMatch(serialized, /must-not-be-recorded|hidden-input|hidden-output|hidden-part|hidden-body/u);
  assert.match(serialized, /actual-input/u);

  const orderedTimingAudit = [];
  const ordered = await runtime.withModelCallAuditContext({
    runId: run.runId,
    promptVersion: 'ordered-provider-timing-v1',
    record: async (entry) => { orderedTimingAudit.push(entry); }
  }, async () => {
    await runtime.recordModelGeneration({
      phase: 'ordered_tool_loop',
      request: { prompt: 'two sequential provider steps' },
      // AI SDK生产StepResult当前没有callId；映射必须使用Provider回调顺序。
      steps: [
        { stepNumber: 0, text: '', finishReason: 'tool-calls' },
        { stepNumber: 1, text: 'done', finishReason: 'stop' }
      ],
      providerCalls: [
        {
          callId: 'call-ordered',
          request: { callId: 'call-ordered', provider: 'mock-provider', modelId: 'mock-model', messages: [] },
          startedAt: '2026-07-29T00:00:00.000Z',
          completedAt: '2026-07-29T00:00:01.000Z'
        },
        {
          callId: 'call-ordered',
          request: { callId: 'call-ordered', provider: 'mock-provider', modelId: 'mock-model', messages: [] },
          startedAt: '2026-07-29T00:00:02.000Z',
          completedAt: '2026-07-29T00:00:05.000Z'
        }
      ],
      startedAt: '2026-07-29T00:00:00.000Z',
      completedAt: '2026-07-29T00:00:06.000Z'
    });
  });
  assert.deepEqual(ordered.failures, []);
  assert.deepEqual(
    orderedTimingAudit.map(({ callId, startedAt, completedAt }) => ({ callId, startedAt, completedAt })),
    [
      { callId: 'call-ordered/step-0', startedAt: '2026-07-29T00:00:00.000Z', completedAt: '2026-07-29T00:00:01.000Z' },
      { callId: 'call-ordered/step-1', startedAt: '2026-07-29T00:00:02.000Z', completedAt: '2026-07-29T00:00:05.000Z' }
    ],
    'AI SDK ToolLoop的Provider回调顺序必须映射为每个Step独立起止时间'
  );

  const auditWriteFailure = await runtime.withModelCallAuditContext({
    runId: run.runId,
    promptVersion: 'audit-test-v1',
    record: async () => { throw new Error('audit store unavailable'); }
  }, async () => {
    await runtime.recordModelGeneration({
      phase: 'audit_failure_degradation',
      request: { prompt: 'still answer the student' },
      steps: [{ text: 'visible answer remains valid' }],
      startedAt: new Date().toISOString()
    });
    return 'business-result-preserved';
  });
  assert.equal(auditWriteFailure.value, 'business-result-preserved');
  assert.equal(auditWriteFailure.failures.length, 1,
    'audit persistence failure must be captured without failing the business result');

  await conversation.failRun({ runId: run.runId, error: Object.assign(new Error('provider failed'), { code: 'PROVIDER_FAILED' }) });
  assert.equal(received[0].status, 'failed', 'failed runs must preserve the question with a truthful terminal status');

  const cancelledRun = await conversation.createRun({ threadId: thread.threadId, context, intent: 'analysis', route: 'agent' });
  await conversation.cancelRun({
    runId: cancelledRun.runId,
    error: Object.assign(new Error('student stopped the run'), { code: 'TEACHER_RUN_CANCELLED' })
  });
  const cancelledQuestion = (await conversation.listMessages(thread.threadId, { limit: 10 }))
    .find((message) => message.runId === cancelledRun.runId && message.role === 'user');
  assert.equal(cancelledQuestion?.status, 'cancelled',
    'explicit stop must preserve the submitted question and mark it cancelled');
  const terminalTranscript = await conversation.listSuccessfulMessages(thread.threadId);
  assert(terminalTranscript.some((message) => message.runId === run.runId && message.role === 'user'),
    'failed Run的学生原文必须继续进入模型Transcript');
  assert(terminalTranscript.some((message) => message.runId === cancelledRun.runId && message.role === 'user'),
    'cancelled Run的学生原文必须继续进入模型Transcript');

  const successRun = await conversation.createRun({ threadId: thread.threadId, context, intent: 'analysis', route: 'agent' });
  await conversation.completeRun({
    runId: successRun.runId,
    context,
    response: { directAnswer: '最终回答', answerType: 'explanation' },
    providerMeta: {}
  });
  const successMessages = conversation.state.messages.get(thread.threadId)
    .filter((message) => message.runId === successRun.runId);
  assert.equal(successMessages.filter((message) => message.role === 'user').length, 1,
    'successful completion must update the received request instead of duplicating it');
  assert.equal(successMessages.find((message) => message.role === 'user').status, 'succeeded');
  assert.equal(successMessages.find((message) => message.role === 'assistant').content, '最终回答');
}

function normalizedHost(question, requestId = 'req_intent_v2') {
  const fixture = clone(baseFixture);
  const content = 'package Vehicle {\n  part def Car;\n  part car : Car;\n}\n';
  fixture.contractVersion = '1.1';
  fixture.requestId = requestId;
  fixture.threadId = `thread_${requestId}`;
  fixture.editor.files[0].content = content;
  fixture.editor.cursor = positionAt(content, content.indexOf('car : Car'));
  fixture.editor.selection = positionSelection(content, 0, 0);
  fixture.editor.symbolName = 'car';
  fixture.editor.contextState = {
    focus: 'focused',
    interactionTarget: 'code',
    capturedAt: new Date().toISOString(),
    documentRevision: documentRevisionForText(content),
    cursorOrigin: 'current',
    selectionOrigin: 'current',
    degradedReason: ''
  };
  fixture.question.text = question;
  const parsed = validateHostContextEnvelope(fixture);
  assert.equal(parsed.ok, true, parsed.errors?.join('\n'));
  return parsed.value;
}

function positionAt(content, offset) {
  const before = content.slice(0, offset);
  const lines = before.split('\n');
  return { offset, line: lines.length, column: lines.at(-1).length + 1 };
}

function positionSelection(content, startOffset, endOffset) {
  const start = positionAt(content, startOffset);
  const end = positionAt(content, endOffset);
  return {
    startOffset,
    startLine: start.line,
    startColumn: start.column,
    endOffset,
    endLine: end.line,
    endColumn: end.column,
    text: content.slice(startOffset, endOffset),
    empty: startOffset === endOffset
  };
}

function documentRevisionForText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

function v2Config(model, overrides = {}) {
  const configuredStages = overrides.agentStageModels || {};
  const finalizerModel = configuredStages.finalizer || overrides.agentNonThinkingModel || new model.constructor({
    doGenerate: async (options) => generatedText(finalAnswerDraftFromCall(options))
  });
  return {
    agentModel: model,
    feedbackModel: model,
    agentScopeGateEnabled: true,
    agentProviderCompatibility: 'deepseek-v4-litellm',
    llm: { providerMode: 'mock', model: 'mock-intent-v2' },
    ...overrides,
    agentStageModels: {
      ...configuredStages,
      finalizer: finalizerModel
    }
  };
}

function finalAnswerDraftFromCall(options) {
  const prompt = [
    ...(Array.isArray(options?.prompt) ? options.prompt : []),
    ...(Array.isArray(options?.messages) ? options.messages : []),
    ...(Array.isArray(options?.instructions) ? options.instructions : [])
  ];
  for (const message of [...prompt].reverse()) {
    const parts = Array.isArray(message?.content) ? message.content : [message?.content];
    for (const part of [...parts].reverse()) {
      const text = typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '';
      if (!text) continue;
      try {
        const jsonText = text.startsWith('[') && text.includes('\n')
          ? text.slice(text.indexOf('\n') + 1)
          : text;
        const parsed = JSON.parse(jsonText);
        if (typeof parsed?.source?.mainDraft === 'string' && parsed.source.mainDraft.trim()) {
          return parsed.source.mainDraft;
        }
      } catch {
        // 不是FinalAnswerTask JSON，继续查找上一段。
      }
    }
  }
  return '结论已经整理为面向学生的最终说明。';
}

function completeKnowledgeOutput(query) {
  const requestedQuery = String(query || 'Definition and Usage');
  return {
    requestedQuery,
    effectiveQuery: requestedQuery,
    requestedQueryHash: hashContent(requestedQuery),
    effectiveQueryHash: hashContent(requestedQuery),
    closureProfileId: 'sysml-general-search-v1',
    closureProfileHash: hashContent('sysml-general-search-v1'),
    closureRequirement: 'not_applicable',
    closureStatus: 'not_applicable',
    intentMode: 'general_semantic_search',
    operatorOccurrences: [],
    queryExpansion: { addedOperators: [], sources: [] },
    coverage: 'COMPLETE',
    bundleId: 'bundle_intent_v2',
    baselineId: 'sysml20-model-user',
    bundleVersion: 'v003',
    sourceRegistryHash: hashContent('source-registry-v003'),
    bundleContentHash: hashContent('bundle-content-v003'),
    resultHash: hashContent(`result:${requestedQuery}`),
    closureClaimIds: [],
    knowledgeAnswerRequiredClaimIds: [],
    knowledgeSupportingClaimIds: [],
    mandatorySupportingCount: 0,
    additionalSupportingClaimIds: ['claim-definition-usage'],
    missingClosureClaimIds: [],
    requestedLimit: 5,
    additionalSupportingBudget: 25,
    selectionLimit: 25,
    returnedClaimCount: 1,
    resourceLimit: 25,
    claims: [{
      claimId: 'claim-definition-usage',
      claimText: 'A Usage may be typed by a Definition.',
      authorityLevel: 'A1',
      operators: [],
      astContextIds: ['sysml20:Usage'],
      evidenceIds: ['evidence-definition-usage'],
      selectionRole: 'additional_supporting'
    }],
    evidenceBlocks: [{
      evidenceId: 'evidence-definition-usage',
      sourceId: 'sysml20-part1-formal-text',
      sectionPath: 'Definitions and Usages',
      excerpt: 'A Usage may be typed by a Definition.',
      textHash: hashContent('A Usage may be typed by a Definition.'),
      authorityLevel: 'A1'
    }],
    guardrails: [],
    conflicts: [],
    excludedCandidates: { count: 0, claimIds: [] },
    items: [{
      cardId: 'knowledge-definition-usage',
      title: 'Definition and Usage',
      excerpt: 'A Usage may be typed by a Definition.',
      reviewed: true,
      evidenceLevel: 'official',
      version: 'v003',
      contentHash: hashContent('bundle-content-v003')
    }]
  };
}

function completeDomainEvidenceOutput(questions) {
  return {
    version: 'domain-search-result-v3',
    status: 'complete',
    provider: 'deepseek-native-web-search',
    questions,
    summary: '公开工程资料显示，电池热管理通常由冷却板、冷却回路、泵、换热器和控制器组成。',
    sources: [{
      sourceId: 'domain_0123456789abcdef0123',
      title: 'Battery thermal management overview',
      url: 'https://example.edu/battery-thermal-management',
      pageAge: '2026-07-28'
    }],
    searchRequestCount: 1,
    warnings: []
  };
}

async function testServerOwnedAdmission() {
  const host = normalizedHost('请解释 Definition 和 Usage。', 'req_admission_allowed');
  host.question.intent = 'forged_generate_mode';
  assert.equal(selectAgentWorkflowVersion(host), 'intent-orchestrator-v2');
  const candidate = normalizedHost('请生成一个完整车辆模型。', 'req_candidate_v2');
  assert.equal(selectAgentWorkflowVersion(candidate), 'intent-orchestrator-v2');
  host.question.operation = 'repair';
  assert.equal(selectAgentWorkflowVersion(host), 'intent-orchestrator-v2',
    'Repair must use the same V2 production entry');
  host.runtimeAssignment = { workflowVersion: 'v1' };
  assert.throws(() => selectAgentWorkflowVersion(host), /V1 has been retired/u);
}

async function testSimpleZeroSearch(MockLanguageModelV4) {
  const host = normalizedHost('用人话解释 part def 是什么。', 'req_v2_simple');
  const model = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedDirectAnswer('`part def` 定义可复用的部件类型；具体 `part` usage 则是在模型上下文中使用这个类型。')
    ]
  });
  let knowledgeCalls = 0;
  const response = await runAgentCapability(host, v2Config(model, {
    agentDependencies: {
      searchReviewedKnowledge: async () => {
        knowledgeCalls += 1;
        return completeKnowledgeOutput('unused');
      }
    }
  }));
  assert.equal(response.agentTrace.workflowVersion, 'intent-orchestrator-v2');
  assert.equal(response.agentTrace.status, 'completed');
  assert.equal(response.agentTrace.gateOutcome, 'pass');
  assert.equal(response.agentTrace.gateCallCount, 1);
  assert.equal(knowledgeCalls, 0, 'a simple concept question must support a zero-search path');
  assert.equal(response.answerCompletionStatus, 'complete');
  assert.equal(response.answerContractHash, undefined);
  assert.equal(response.__internal.agent.answerContract, undefined);
  assert.equal(response.__internal.agent.fastGateProjection, undefined);
  assert.equal(response.__internal.agent.plannerTrace, undefined);
  const mainModelCall = response.__internal.agent.modelCalls.find((call) => (
    call.phase === 'intent_orchestration_v2'
  ));
  const finalAnswerModelCall = response.__internal.agent.modelCalls.find((call) => (
    call.phase === 'answer_generation'
  ));
  assert(finalAnswerModelCall,
    '响应级modelCalls必须包含独立FinalAnswerWorker调用，与step/timing/Ledger一致');
  assert.equal(finalAnswerModelCall.status, 'succeeded');
  assert.equal(model.doGenerateCalls.length, 2);
  const gateCallShape = JSON.stringify(model.doGenerateCalls[0]);
  const mainCallShape = JSON.stringify(model.doGenerateCalls[1]);
  assert(!gateCallShape.includes('report_scope_risk'));
  assert(!gateCallShape.includes('"tools"'), 'Fast Gate must not receive any Tool Schema');
  assert(!gateCallShape.includes('request_plan'));
  assert(mainCallShape.includes('inspect_current_model'));
  assert(mainCallShape.includes('search_reviewed_knowledge'));
  assert(mainCallShape.includes('delegate_candidate'));
  assert(mainCallShape.includes('delegate_repair'));
  assert(!mainCallShape.includes('record_task_understanding'));
  assert(!mainCallShape.includes('validate_candidate_workspace'));
  assert.equal(knowledgeCalls, 0, '授权Domain Search不等于强制检索，简单稳定问题仍应零查询');
  assert.equal(mainModelCall.modelId, 'mock-intent-v2',
    'adaptive V2 audit must record the actual high-reasoning model alias');
  assert.equal(model.doGenerateCalls[0].reasoning, 'none', 'Fast Gate must remain non-thinking');
  assert.equal(model.doGenerateCalls[0].providerOptions['openai-compatible'].thinking.type, 'disabled');
  assert.equal(model.doGenerateCalls[1].reasoning, 'high', 'adaptive V2 Main must use the high-reasoning route');
  assert.equal(model.doGenerateCalls[1].providerOptions['openai-compatible'].thinking.type, 'enabled');
  assert.equal(model.doGenerateCalls[1].maxOutputTokens, undefined,
    'Main开放式生成必须省略Provider输出硬帽');
  assert.equal(mainModelCall.requestedOutputTokens, undefined,
    'Main审计不得伪造已删除的请求输出上限');
  for (const call of model.doGenerateCalls) {
    assert.equal(call.providerOptions['openai-compatible'].parallel_tool_calls, false,
      'DeepSeek-compatible V2 calls must serialize tool continuations');
  }
  assert(!mainCallShape.includes('[服务端可信上下文摘要]'),
    'the Main prompt must not advertise active-file metadata before the Agent chooses Inspect');
  assert.doesNotMatch(response.directAnswer, /根据你的描述和当前草稿整体来看/u,
    'V2 must not prepend the legacy grounding-process disclosure');
  assert.notEqual(model.doGenerateCalls[1].responseFormat?.type, 'json',
    'the final explanation must remain ordinary natural language, not a hard Structured Output gate');
}

async function testClarificationPauseAndResume(MockLanguageModelV4) {
  const sourceHost = normalizedHost('请帮我生成车辆接口模型，但接口边界需要你先确认。', 'req_v2_clarification');
  const sourceModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedToolCalls([
        toolCall('clarification-call-1', 'request_clarification', { question: '接口边界只包含车辆内部端口，还是也包含外部环境端口？' })
      ])
    ]
  });
  const pausedResponse = await runAgentCapability(sourceHost, v2Config(sourceModel, {
    runId: 'run_v2_clarification_source'
  }));
  assert.equal(pausedResponse.answerCompletionStatus, 'waiting_for_clarification');
  assert.equal(pausedResponse.directAnswer, '接口边界只包含车辆内部端口，还是也包含外部环境端口？');
  assert.deepEqual(pausedResponse.__internal.agent.clarificationRequest, {
    question: pausedResponse.directAnswer,
    acceptedToolCallId: 'clarification-call-1'
  });
  assert.equal(pausedResponse.__internal.agent.mainAgentDelegation, undefined);
  assert.equal(sourceModel.doGenerateCalls.length, 2,
    'no-execute clarification must stop the AI SDK loop without an extra model step');
  assert(generationToolNames(sourceModel.doGenerateCalls[1]).includes('request_clarification'),
    'the first run in a trusted task lineage must expose the single blocking clarification Tool');

  const conversation = createMemoryConversationStore();
  const thread = await conversation.ensureThread(sourceHost, sourceHost.threadId);
  const sourceRun = await conversation.createRun({
    threadId: thread.threadId,
    context: sourceHost,
    intent: 'single_entry',
    route: 'clarification-test'
  });
  const priorQuery = 'vehicle internal port boundary';
  await conversation.recordToolLedgerEntry({
    runId: sourceRun.runId,
    toolCallId: 'source-knowledge-call',
    toolName: 'search_reviewed_knowledge',
    argsHash: hashContent(JSON.stringify({ query: priorQuery, limit: 5 })),
    status: 'succeeded',
    resultHash: hashContent('source-knowledge-result'),
    canonicalArgs: { query: priorQuery, limit: 5 },
    resultPayload: completeKnowledgeOutput(priorQuery),
    metrics: { backendExecuted: true },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });
  const priorDomainQuestions = ['车辆接口通常如何划分？'];
  await conversation.recordToolLedgerEntry({
    runId: sourceRun.runId,
    toolCallId: 'source-domain-call',
    toolName: 'search_engineering_domain_evidence',
    argsHash: hashContent(JSON.stringify({ questions: priorDomainQuestions })),
    status: 'succeeded',
    resultHash: hashContent('source-domain-result'),
    canonicalArgs: { questions: priorDomainQuestions },
    resultPayload: completeDomainEvidenceOutput(priorDomainQuestions),
    resultProjection: {
      participant: 'main',
      domainTransportStatus: 'complete',
      domainSearchRequestCount: 1,
      domainSourceCount: 1,
      domainSummaryChars: 48,
      domainWarningCodes: []
    },
    metrics: { backendExecuted: true },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });
  const checkpoint = {
    checkpointId: 'clar_12345678-abcd',
    acceptedToolCallId: 'clarification-call-1',
    question: pausedResponse.directAnswer,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const persistedPublicResponse = clone(pausedResponse);
  delete persistedPublicResponse.__internal;
  persistedPublicResponse.clarification = {
    checkpointId: checkpoint.checkpointId,
    status: 'waiting',
    question: checkpoint.question,
    expiresAt: checkpoint.expiresAt
  };
  await conversation.pauseRunForClarification({
    runId: sourceRun.runId,
    context: sourceHost,
    response: persistedPublicResponse,
    providerMeta: pausedResponse.__internal,
    checkpoint
  });
  assert.equal((await conversation.getRun(sourceRun.runId)).status, 'waiting_for_clarification');

  const resumedHost = normalizedHost('只包含车辆内部端口。', 'req_v2_clarification_resume');
  resumedHost.threadId = thread.threadId;
  resumedHost.clarificationCheckpointId = checkpoint.checkpointId;
  const resumed = await conversation.createResumedRun({
    threadId: thread.threadId,
    context: resumedHost,
    intent: 'single_entry',
    route: 'clarification-test-resume',
    checkpointId: checkpoint.checkpointId
  });
  assert.equal(resumed.reused, false);
  assert.equal(resumed.workflowResume.sourceRunId, sourceRun.runId);
  assert.deepEqual(
    resumed.workflowResume.taskSources.map((source) => ({ relation: source.relation, text: source.text })),
    [
      { relation: 'root_user_request', text: sourceHost.question.text },
      { relation: 'clarification_user_answer', text: resumedHost.question.text }
    ],
    '澄清恢复Run必须在进入Adapter前把当前回答扩展进受信TaskSourceSet'
  );
  assert.equal(
    new Set(resumed.workflowResume.taskSources.map((source) => source.taskAuthorizationRevisionHash)).size,
    1,
    '澄清恢复必须复用既有TaskSourceSet授权机制，为扩展后的完整集合形成一个共享revision'
  );
  const rootSource = resumed.workflowResume.taskSources[0];
  const rootOnlyRevision = `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    version: 'teacher-task-source-set-v1',
    threadId: thread.threadId,
    sources: [{
      messageId: rootSource.messageId,
      relation: rootSource.relation,
      sourceHash: rootSource.sourceHash
    }]
  })).digest('hex')}`;
  assert.notEqual(
    resumed.workflowResume.taskSources[0].taskAuthorizationRevisionHash,
    rootOnlyRevision,
    '新增澄清回答后必须由既有机制重算扩展集合revision，而不是沿用root-only revision'
  );
  assert.equal(resumed.workflowResume.priorToolLedger.length, 2);
  assert.equal(
    resumed.workflowResume.priorToolLedger.find((entry) => (
      entry.toolName === 'search_engineering_domain_evidence'
    )).output.version,
    'domain-search-result-v3',
    '澄清恢复必须持久化复用已规范化Domain结果，而不是再次调用Provider'
  );
  const resumeModel = new MockLanguageModelV4({
    doGenerate: [
      generatedToolCalls([
        toolCall('resumed-domain-call', 'search_engineering_domain_evidence', {
          questions: priorDomainQuestions
        })
      ]),
      generatedToolCalls([
        toolCall('resumed-knowledge-call', 'search_reviewed_knowledge', { query: priorQuery, limit: 5 })
      ]),
      generatedDirectAnswer('已确认只处理车辆内部端口。')
    ]
  });
  let resumedKnowledgeBackendCalls = 0;
  let resumedDomainBackendCalls = 0;
  const resumedResponse = await runAgentCapability(resumedHost, v2Config(resumeModel, {
    runId: resumed.run.runId,
    workflowResume: resumed.workflowResume,
    agentDependencies: {
      searchReviewedKnowledge: async ({ input }) => {
        resumedKnowledgeBackendCalls += 1;
        return completeKnowledgeOutput(input.query);
      },
      searchDomainEvidence: async ({ input }) => {
        resumedDomainBackendCalls += 1;
        return completeDomainEvidenceOutput(input.questions);
      }
    }
  }));
  assert.equal(resumedResponse.answerCompletionStatus, 'complete');
  assert.equal(resumeModel.doGenerateCalls.length, 3,
    'resumed execution must skip Fast Gate and use only the Main Tool continuations');
  assert.equal(resumedKnowledgeBackendCalls, 0,
    'an exact prior knowledge query must replay the persisted result without calling the backend');
  assert.equal(resumedDomainBackendCalls, 0,
    'an exact prior Domain query must replay the normalized result without calling the Provider');
  assert.equal(resumedResponse.__internal.agent.intentV2Trace.gateCallCount, 0);
  assert(!generationToolNames(resumeModel.doGenerateCalls[0]).includes('request_clarification'),
    'after one trusted clarification answer the server must remove the blocking clarification Tool');
  const resumedMainCall = JSON.stringify(resumeModel.doGenerateCalls[0]);
  assert(resumedMainCall.includes('blockingClarificationAllowed')
    && resumedMainCall.includes('proceed_with_safe_defaults'),
    'the Main model must receive the server-owned clarification policy projection');
  assert(resumedMainCall.includes('请帮我生成车辆接口模型')
    && resumedMainCall.includes('只包含车辆内部端口'),
    'the Main model must receive root and current clarification facts from server-owned task inputs');

  const idempotent = await conversation.createResumedRun({
    threadId: thread.threadId,
    context: resumedHost,
    intent: 'single_entry',
    route: 'clarification-test-resume',
    checkpointId: checkpoint.checkpointId
  });
  assert.equal(idempotent.reused, true);
  assert.equal(idempotent.run.runId, resumed.run.runId);
  await assert.rejects(
    conversation.createResumedRun({
      threadId: thread.threadId,
      context: { ...resumedHost, requestId: 'req_v2_other_answer' },
      intent: 'single_entry',
      route: 'clarification-test-resume',
      checkpointId: checkpoint.checkpointId
    }),
    (error) => error.code === 'CLARIFICATION_CHECKPOINT_CONSUMED'
  );
}

async function testMainAgentIntentUnderstanding(MockLanguageModelV4, runtime) {
  const question = '解释 View 和 Viewpoint 的区别，并分析当前模型中的 view usage。';
  const host = normalizedHost(question, 'req_v2_main_intent');
  const model = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedDirectAnswer('Viewpoint定义关注点和呈现规则，View依据它组织模型暴露内容；当前view usage应按其引用关系分析。')
    ]
  });
  const response = await runAgentCapability(host, v2Config(model));
  assert.equal(response.__internal.agent.mainAgentIntent, undefined,
    'the retired structured intent capture must not run');
  assert.equal(response.__internal.agent.mainAgentDelegation, undefined,
    'direct answers do not require a side-effect delegation record');
  assert(!response.__internal.agent.modelCalls.some((call) => (
    call.phase === 'main_agent_intent_understanding'
  )), 'the pre-loop structured intent capture phase must be absent');
  assert.equal(model.doGenerateCalls.length, 2,
    'direct answers use exactly Fast Gate plus the Main Agent loop');
  assert.equal(response.agentTrace.requestPlan, undefined);
  assert(runtime.mainAgentDelegationSchema.safeParse({
    version: 'main-agent-delegation-v1',
    action: 'candidate',
    mode: 'create',
    questionHash: hashContent(question),
    status: 'accepted',
    forgedRunId: 'not-allowed'
  }).success === false, 'server-owned fields must not enter the delegation contract');
}

async function testMainInternalPlanningRecovery(MockLanguageModelV4) {
  const question = '动力与供电系统，就按这个来。';
  const host = normalizedHost(question, 'req_v2_internal_planning_recovery');
  const leakedPlanning = '学生说“动力与供电系统，就按这个来”。我认为这里不需要新的委派，我应该确认，我直接确认即可。';
  const model = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedText(leakedPlanning),
      generatedDirectAnswer('好的，后续模型统一使用“动力与供电系统”这个名称。')
    ]
  });
  const response = await runAgentCapability(host, v2Config(model));
  assert.equal(response.directAnswer,
    expectedDirectTerminalAnswer('好的，后续模型统一使用“动力与供电系统”这个名称。'));
  assert.equal(model.doGenerateCalls.length, 3,
    '内部规划叙述必须在同一Run剩余资源中获得一次纠正机会');
  assert(response.warnings.includes('main_agent_internal_orchestration_narration'));
  const mainCalls = response.__internal.agent.modelCalls.filter((call) => (
    call.phase === 'intent_orchestration_v2'
  ));
  assert.deepEqual(mainCalls.map((call) => [call.status, call.errorCategory]), [
    ['failed', 'internal_orchestration_narration'],
    ['succeeded', '']
  ], '每次Main尝试必须分别记录真实的失败与恢复结果');
  assert(!response.directAnswer.includes('我应该'));
}

async function testV2CandidateWorkerExecution(MockLanguageModelV4, runtime) {
  const question = '生成一个包含 Car definition 和 car usage 的最小完整模型。';
  const host = normalizedHost(question, 'req_v2_candidate_worker');
  const candidate = 'package GeneratedVehicle {\n  part def Car;\n  part car : Car;\n}\n';
  const candidateFile = createAgentContext(host).context.model.files[0];
  const validation = {
    validator: {
      authority: 'official-sysml-v2-validator',
      version: '2026-04/0.59.0/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidenceHash: hashContent('v2-candidate-validator-evidence')
    },
    official: { syntax: 'passed', semantic: 'passed', diagnostics: [] },
    courseRuleApplicability: 'not_applicable',
    completeness: 'complete',
    candidateWorkspaceHash: hashContent(`${host.editor.files[0].path}\n${hashContent(candidate)}`),
    patches: [{
      fileId: candidateFile.fileId,
      baseHash: candidateFile.contentHash,
      candidateHash: hashContent(candidate),
      kind: 'replace_entry'
    }]
  };
  const model = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedText('我应该调用delegate_candidate，mode=create。'),
      generatedToolCalls([
        toolCall('delegate-candidate', 'delegate_candidate', {
          mode: 'create', subject: 'current_workspace', instruction: ['生成完整候选模型。'].join("\n")
        })
      ], '任务已理解，将由Candidate Worker生成并验证候选，无需Repair Worker。'),
      generatedText(candidate),
      generatedToolCalls([
        toolCall('candidate-final-answer', 'request_final_answer', goalCoverage('生成完整候选模型。'))
      ])
    ]
  });
  const finalizerModel = new MockLanguageModelV4({
    doGenerate: [generatedText('候选已经生成。你可以在编辑器中通过应用入口将其写入模型。')]
  });
  let validatorInput;
  const lifecycleEvents = [];
  const response = await runAgentCapability(host, v2Config(model, {
    runId: 'run_v2_candidate_worker',
    agentStageModels: { finalizer: finalizerModel },
    conversation: {
      recordRunEvent: async (event) => lifecycleEvents.push(event)
    },
    feedbackFinalAnswer: async (request) => runtime.buildFinalAnswerFeedback({
      output: { issues: [] },
      request,
      modelId: 'phase2-feedback'
    }),
    reviewAnswerCoverage: async (request) => ({
      version: 'teacher-answer-coverage-v1',
      contractHash: request.contractHash,
      answerHash: request.answerHash,
      answeredPartIds: request.answerContract.requirements.map((part) => part.partId),
      unansweredPartIds: [],
      declinedPartIds: request.answerContract.declinedParts.map((part) => part.partId),
      improperlyAnsweredDeclinedPartIds: [],
      unsupportedEvidenceRefs: [],
      outcome: 'complete'
    }),
    agentDependencies: {
      searchReviewedKnowledge: async ({ input }) => completeKnowledgeOutput(input.query),
      searchSkillGuidance: async ({ input }) => ({ query: input.query, items: [] }),
      validateCandidateWorkspace: async ({ input }) => {
        validatorInput = input;
        return validation;
      }
    }
  }));
  assert.equal(response.agentTrace.workflowVersion, 'intent-orchestrator-v2');
  assert.equal(response.agentTrace.candidateValidated, true);
  assert.equal(response.validatorStatus, 'validated_passed');
  assert.equal(response.__internal.agent.plannerTrace, undefined,
    'V2 delegated execution must not invoke the retired Request Planner');
  assert.equal(response.__internal.agent.scopeGate, undefined,
    'C2 delegated execution must not synthesize a second legacy scope gate');
  assert.deepEqual(response.__internal.agent.mainAgentDelegation, {
    version: 'main-agent-delegation-v1',
    action: 'candidate',
    mode: 'create',
    subject: 'current_workspace',
    instruction: ['生成完整候选模型。'].join("\n"),
    taskSummary: '生成完整候选模型。',
    questionHash: response.__internal.agent.fastGatePassThroughV2.originalQuestionHash,
    status: 'accepted'
  });
  assert.equal(response.__internal.agent.answerContract, undefined,
    'new V2 Runs stop creating the retired AnswerContract');
  assert.equal(validatorInput.mode, 'replace_entry');
  assert.match(validatorInput.fileId, /^file_[a-f0-9]+$/u);
  assert.equal(validatorInput.baseHash, hashContent(host.editor.files[0].content));
  assert.equal(validatorInput.content, candidate);
  const serializedCalls = JSON.stringify(model.doGenerateCalls);
  assert(serializedCalls.includes('完整、可独立验证的SysML v2文本'));
  assert(serializedCalls.includes('delegate_candidate'));
  assert(!serializedCalls.includes('"mode":"create"'),
    'the accepted Tool Result must stop the SDK loop before it is replayed into another Main request');
  assert(!serializedCalls.includes('你是Request Planner'));
  assert.equal(model.doGenerateCalls.length, 4,
    '验证候选后直接终末解释，不重复调用Main Review');
  assert(response.warnings.includes('main_agent_structured_tool_call_missing'),
    'the recovered Provider protocol failure must remain recorded');
  assert(!response.warnings.includes('main_agent_duplicate_delegation_ignored'),
    '已接受Candidate后的“无需Repair”否定叙述不得触发第二次委派');
  const mainCalls = response.__internal.agent.modelCalls
    .filter((call) => call.phase === 'intent_orchestration_v2');
  assert.deepEqual(mainCalls.map((call) => ({ status: call.status, errorCategory: call.errorCategory || '' })), [
    { status: 'failed', errorCategory: 'structured_tool_call_missing' },
    { status: 'succeeded', errorCategory: '' }
  ]);
  assert.doesNotMatch(response.directAnswer, /任务已理解，将由Candidate Worker生成并验证候选/u,
    'text emitted in the accepted delegation step must not become a student-visible answer');
  assert.doesNotMatch(response.directAnswer, /执行状态（服务端）|\*\*教学说明\*\*/u,
    '学生公开回答不得呈现内部终态标题或兼容格式标题');
  assert.doesNotMatch(response.directAnswer, /服务端验证状态/u,
    'Validator可信状态不得作为内部状态段落拼进学生正文');
  assert.doesNotMatch(response.directAnswer, /通过应用入口|点击应用按钮|自动应用/u,
    '学生公开回答不得声称当前不存在的候选应用能力');
  assert.match(response.directAnswer, /当前页面没有一键应用候选入口。候选尚未应用；如需写入编辑器，请复制下方候选代码并手动粘贴。/u,
    '已验证候选必须给出当前真实可用的复制粘贴路径');
  assert.equal(finalizerModel.doGenerateCalls.length, 1);
  assert(JSON.stringify(finalizerModel.doGenerateCalls[0]).includes('当前页面没有一键应用候选入口'),
    'Finalizer提示必须明确当前不存在一键应用入口');
  assert.equal((response.directAnswer.match(/以下代码由服务端从已验证候选直接呈现。/gu) || []).length, 1,
    '服务端重复执行候选装配时也只能保留一份候选引导文案');
  assert.equal((response.directAnswer.match(/文件：[^\r\n]+\.sysml/gu) || []).length, 1,
    '学生正文中只能出现一个服务端确定的候选文件标签');
  const lifecycleStages = lifecycleEvents.map((event) => event.payload?.stage);
  assert.equal(lifecycleStages.filter((stage) => stage === 'run_started').length, 1,
    'Main and delegated worker must share exactly one outer run_started event');
  assert.equal(lifecycleStages.filter((stage) => stage === 'run_finished').length, 1,
    'Main and delegated worker must share exactly one outer run_finished event');
}

async function testV2RepairWorkerExecution(MockLanguageModelV4) {
  const question = '修复当前模型中的语法错误。';
  const host = normalizedHost(question, 'req_v2_repair_worker');
  host.question.operation = 'repair';
  const repaired = 'package Demo { part def Vehicle; }';
  const repairFile = createAgentContext(host).context.model.files[0];
  const failedValidation = {
    validator: {
      authority: 'official-sysml-v2-validator', version: 'test', evidenceHash: hashContent('repair-failed')
    },
    official: {
      syntax: 'failed', semantic: 'not_run',
      diagnostics: [{ severity: 'error', message: 'syntax error' }]
    },
    courseRuleApplicability: 'not_applicable',
    completeness: 'complete',
    candidateWorkspaceHash: hashContent('repair-failed-workspace'),
    patches: []
  };
  const passedValidation = {
    validator: {
      authority: 'official-sysml-v2-validator',
      version: '2026-04/0.59.0/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidenceHash: hashContent('repair-passed')
    },
    official: { syntax: 'passed', semantic: 'passed', diagnostics: [] },
    courseRuleApplicability: 'not_applicable',
    completeness: 'complete',
    candidateWorkspaceHash: hashContent(`${host.editor.files[0].path}\n${hashContent(repaired)}`),
    patches: [{
      fileId: repairFile.fileId,
      baseHash: repairFile.contentHash,
      candidateHash: hashContent(repaired),
      kind: 'replace_entry'
    }]
  };
  const nonThinkingModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedText('已修复候选并通过官方语法与语义检查。')
    ]
  });
  const thinkingModel = new MockLanguageModelV4({
    doGenerate: [
      generatedToolCalls([
        toolCall('delegate-repair', 'delegate_repair', { scope: 'active_file' })
      ]),
      generatedToolCalls([
        toolCall('submit-repair', 'submit_candidate_for_validation', { content: repaired })
      ]),
      generatedToolCalls([
        toolCall('repair-final-answer', 'request_final_answer', {})
      ])
    ]
  });
  let validatorCalls = 0;
  const response = await runAgentCapability(host, v2Config(nonThinkingModel, {
    runId: 'run_v2_repair_worker',
    agentNonThinkingModel: nonThinkingModel,
    agentThinkingModel: thinkingModel,
    agentReasoningMode: 'adaptive',
    agentDependencies: {
      validateCandidateWorkspace: async () => {
        validatorCalls += 1;
        return validatorCalls === 1 ? failedValidation : passedValidation;
      }
    }
  }));
  assert.equal(validatorCalls, 2, 'Repair必须先验证基线，再验证ToolLoop提交的修订候选');
  assert.equal(response.validatorStatus, 'validated_passed');
  assert.equal(response.__internal.agent.mainAgentDelegation.action, 'repair');
  assert.equal(response.__internal.agent.answerContract, undefined);
  assert.equal(nonThinkingModel.doGenerateCalls.length, 2,
    'Non-Thinking模型只允许Fast Gate和最终说明，不得承担Repair首轮');
  assert.equal(thinkingModel.doGenerateCalls.length, 2,
    'Main委派后执行Repair ToolLoop，验证通过后不再重复复核');
}

async function testRepairBaselinePassCanTruthfullyEndWithoutChange(MockLanguageModelV4) {
  const question = '请检查当前模型；只有存在Official Validator错误时才修复，否则如实说明无需修改。';
  const host = normalizedHost(question, 'req_v2_repair_no_change');
  const baseline = host.editor.files[0].content;
  const model = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedToolCalls([toolCall('no-change-repair', 'delegate_repair', { scope: 'active_file' })]),
      generatedToolCalls([toolCall('no-change-final', 'request_final_answer', {})])
    ]
  });
  const maliciousFinalizer = new MockLanguageModelV4({
    doGenerate: [generatedText('已修复并新增了完整模型。')]
  });
  const response = await runAgentCapability(host, v2Config(model, {
    runId: 'run_v2_repair_no_change',
    agentStageModels: { finalizer: maliciousFinalizer },
    agentDependencies: {
      validateCandidateWorkspace: async ({ input }) => ({
        validator: {
          authority: 'official-sysml-v2-validator',
          version: `2026-04/0.59.0/sha256:${'a'.repeat(64)}`,
          evidenceHash: hashContent('no-change-pass')
        },
        official: { syntax: 'passed', semantic: 'passed', diagnostics: [] },
        courseRuleApplicability: 'not_applicable',
        completeness: 'complete',
        candidateWorkspaceHash: hashContent(`${host.editor.files[0].path}\n${hashContent(input.content)}`),
        patches: []
      })
    }
  }));
  assert.equal(maliciousFinalizer.doGenerateCalls.length, 1);
  assert.equal(response.validatorStatus, 'validated_passed', JSON.stringify({
    warnings: response.__internal?.agent?.warnings,
    internalValidatorStatus: response.__internal?.agent?.validatorStatus,
    internalCompletion: response.__internal?.agent?.answerCompletionStatus,
    internalStopReason: response.__internal?.agent?.stopReason,
    delegation: response.__internal?.agent?.mainAgentDelegation,
    directAnswer: response.directAnswer,
    calls: model.doGenerateCalls.length,
    trace: response.__internal?.agent?.toolTrace
  }));
  assert.equal(response.answerCompletionStatus, 'complete');
  assert.equal(response.candidateDeliveryStatus, 'no_change');
  assert(response.directAnswer.includes('只验证了输入基线'));
  assert(response.directAnswer.includes(baseline));
  assert(!response.directAnswer.includes('已修复并新增'));
}

async function testPreviousValidatedCandidateSubjectBinding(MockLanguageModelV4) {
  const question = '继续修改你上一轮生成的代码，增加一个驾驶员部件。';
  const host = normalizedHost(question, 'req_v2_previous_candidate_subject');
  const currentEditor = 'package CurrentEditor { part def OldEditorOnly; }';
  host.editor.files[0].content = currentEditor;
  const previousContent = 'package PreviousModel { part def Vehicle; part vehicle : Vehicle; }';
  const generated = 'package PreviousModel {\n  part def Driver;\n  part def Vehicle { part driver : Driver; }\n  part vehicle : Vehicle;\n}\n';
  const candidateWorkspaceHash = hashContent(
    `standalone/previous.sysml\n${hashContent(generated)}`
  );
  const validation = {
    validator: {
      authority: 'official-sysml-v2-validator',
      version: '2026-04/0.59.0/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidenceHash: hashContent('previous-candidate-validator-evidence')
    },
    official: { syntax: 'passed', semantic: 'passed', diagnostics: [] },
    courseRuleApplicability: 'not_applicable',
    completeness: 'complete',
    candidateWorkspaceHash,
    patches: []
  };
  const fastGateModel = new MockLanguageModelV4({ doGenerate: [generatedText('PASS')] });
  const mainModel = new MockLanguageModelV4({
    doGenerate: [
      generatedToolCalls([
        toolCall('delegate-previous-candidate', 'delegate_candidate', {
          mode: 'refine',
          subject: 'previous_validated_candidate',
          instruction: ['在上一轮已验证候选上完成本轮细化。'].join("\n")
        })
      ]),
      generatedToolCalls([
        toolCall('previous-final-answer', 'request_final_answer', goalCoverage('在上一轮已验证候选上完成本轮细化。'))
      ]),
      generatedText('DELIVER')
    ]
  });
  const candidateModel = new MockLanguageModelV4({ doGenerate: [generatedText(generated)] });
  const semanticReviewModel = new MockLanguageModelV4({
    doGenerate: [generatedText('SCORE_USER_GOAL: 39\nSCORE_ENGINEERING_CLOSURE: 23\nSCORE_CONSISTENCY: 19\nSCORE_EVIDENCE: 13\nTOTAL_SCORE: 94\nRECOMMENDATION: DELIVER')]
  });
  const finalizerModel = new MockLanguageModelV4({
    doGenerate: [generatedText(`已按你的细化要求完成并通过验证。\n\n\`\`\`sysml\n${generated}\n\`\`\``)]
  });
  let validatorInput;
  const response = await runAgentCapability(host, v2Config(mainModel, {
    runId: 'run_v2_previous_candidate_subject',
    agentSemanticReviewEnabled: true,
    agentMaxDurationMs: 1500000,
    agentCandidateMaxAttemptMs: 330000,
    agentRepairPhaseReserveMs: 300000,
    agentStageModels: {
      fastGate: fastGateModel,
      main: mainModel,
      candidate: candidateModel,
      repair: candidateModel,
      semanticReview: semanticReviewModel,
      finalizer: finalizerModel
    },
    lastValidatedCandidate: {
      sourceRunId: 'run_previous_validated_source',
      candidateWorkspaceHash: hashContent('previous-validated-workspace'),
      fileId: 'previous-candidate-file',
      displayName: 'previous.sysml',
      content: previousContent,
      contentHash: hashContent(previousContent)
    },
    agentDependencies: {
      validateCandidateWorkspace: async ({ input }) => {
        validatorInput = input;
        return validation;
      }
    }
  }));
  assert.equal(response.validatorStatus, 'validated_passed', JSON.stringify({
    validatorStatus: response.validatorStatus,
    validatorInput,
    warnings: response.warnings,
    internal: response.__internal?.agent
  }));
  assert.equal(response.__internal.agent.mainAgentDelegation.subject, 'previous_validated_candidate');
  assert.equal(validatorInput.mode, 'standalone_model');
  assert.equal(validatorInput.fileName, 'previous.sysml');
  assert.equal(validatorInput.content, generated);
  assert.equal(response.engineeringReview?.scorecard, undefined, '只读建议不要求评分表');
  assert.equal(response.engineeringReview, undefined, "普通生成不再运行额外工程评议");
  const candidateCall = JSON.stringify(candidateModel.doGenerateCalls[0]);
  assert(candidateCall.includes(previousContent),
    'Candidate Worker必须收到Main已绑定的上一轮完整Candidate');
  assert(!candidateCall.includes(currentEditor),
    'Candidate Worker不得同时收到未选中的当前编辑器旧模型');
}

async function testCourseTaskHintLoadsLessonAssetsWithoutBlockingDelivery(MockLanguageModelV4) {
  const question = '请补全当前课时模型并改正其中遗漏的车辆定义。';
  const host = normalizedHost(question, 'req_v2_course_task_context');
  const candidate = 'package Vehicle {\n  part def ElectricVehicle;\n  part vehicle : ElectricVehicle;\n}\n';
  const agentContext = createAgentContext(host).context;
  const courseContext = {
    courseId: agentContext.lesson.courseId,
    lessonId: agentContext.lesson.lessonId,
    title: '当前课时',
    objectives: ['补全车辆定义'],
    taskHints: ['保留现有package并补全TODO'],
    courseRules: [{
      id: 'course-electric-vehicle',
      type: 'elementExists',
      severity: 'error',
      message: '课程期望包含ElectricVehicle。',
      selector: { kind: 'partDef', name: 'ElectricVehicle' }
    }],
    referenceModel: {
      entryFile: host.editor.files[0].path,
      files: [{
        displayName: host.editor.files[0].path,
        content: host.editor.files[0].content,
        contentHash: hashContent(host.editor.files[0].content),
        editable: true
      }]
    }
  };
  const model = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS|COURSE_TASK'),
      generatedToolCalls([toolCall('inspect-course-full', 'inspect_lesson_context', {
        includeObjectives: true, detail: 'full'
      })]),
      generatedToolCalls([toolCall('delegate-course-complete', 'delegate_candidate', {
        mode: 'complete', subject: 'current_workspace', instruction: ['完成课程模型中的明确TODO。'].join("\n")
      })]),
      generatedText(candidate),
      generatedToolCalls([toolCall('course-final-answer', 'request_final_answer', goalCoverage('完成课程模型中的明确TODO。'))])
    ]
  });
  const response = await runAgentCapability(host, v2Config(model, {
    agentDependencies: {
      inspectLessonContext: async () => courseContext,
      validateCandidateWorkspace: async ({ input }) => ({
        validator: {
          authority: 'official-sysml-v2-validator',
          version: `2026-04/0.59.0/sha256:${'a'.repeat(64)}`,
          evidenceHash: hashContent('course-task-official-pass')
        },
        official: { syntax: 'passed', semantic: 'passed', diagnostics: [] },
        courseRuleApplicability: 'applicable',
        courseRules: {
          status: 'failed',
          diagnostics: [{
            severity: 'error', code: 'COURSE_STRETCH_EXPECTATION',
            message: '另一项课程扩展目标尚未覆盖。'
          }]
        },
        completeness: 'complete',
        candidateWorkspaceHash: hashContent(`${host.editor.files[0].path}\n${hashContent(input.content)}`),
        patches: [{
          fileId: input.fileId,
          baseHash: input.baseHash,
          candidateHash: hashContent(input.content),
          kind: 'replace_entry'
        }]
      })
    }
  }));
  assert.equal(response.__internal.agent.fastGatePassThroughV2.courseTaskIntentHint, 'course_task');
  assert(model.doGenerateCalls[1].tools.some((candidate) => candidate.name === 'inspect_lesson_context'),
    'Fast Gate明确判为课程任务后，Main才获得课程资产Tool');
  assert.equal(response.validatorStatus, 'validated_passed');
  assert.equal(response.agentTrace.candidateValidated, true);
  const candidateCall = JSON.stringify(model.doGenerateCalls[3]);
  assert(candidateCall.includes('inspectedCourseContext'));
  assert(candidateCall.includes('course-electric-vehicle'));
  assert(candidateCall.includes('referenceModel'));
  assert(candidateCall.includes(host.editor.files[0].path));
  assert(!JSON.stringify(model.doGenerateCalls).includes('submit_candidate_for_validation'),
    'Official PASS加课程规则失败不得启动Repair循环');
}

async function testUnknownCourseHintDoesNotExposeLessonAssets(MockLanguageModelV4) {
  const host = normalizedHost('由发动机和电源组成，帮我建立一个SysML模型。', 'req_v2_general_task_no_course_assets');
  const model = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS|COURSE_UNKNOWN'),
      generatedDirectAnswer('可以按发动机和电源两个组成部分建立最小结构模型。')
    ]
  });
  const response = await runAgentCapability(host, v2Config(model));
  assert.equal(response.__internal.agent.fastGatePassThroughV2.courseTaskIntentHint, 'unknown');
  assert(!JSON.stringify(model.doGenerateCalls[0]).includes(host.course.lessonTitle),
    'Fast Gate只能按当前学生原文判断课程意图，不得由宿主课时标题诱导为课程任务');
  assert(!model.doGenerateCalls[1].tools.some((candidate) => candidate.name === 'inspect_lesson_context'),
    '课程意图未知时不得向Main暴露完整课程资产，避免课程规则污染一般建模任务');
}

async function testReviewAdviceCannotControlDelivery(MockLanguageModelV4) {
  const candidate = 'package AdviceCase { part def Device; part device : Device; }';
  for (const kind of ['optional_detail', 'core_gap', 'empty', 'tool_call', 'timeout']) {
    const advice = kind === 'core_gap' ? '用户要求的开关行为当前尚未实现，可在后续补齐。' : '后续可补充功率参数和接口类型。';
    const host = normalizedHost(kind === 'core_gap'
      ? '建立设备模型，包含开关行为，并说明当前边界。'
      : '建立设备模型并说明当前边界。', 'req_advice_' + kind);
    const main = new MockLanguageModelV4({ doGenerate: [
      generatedToolCalls([toolCall('delegate-' + kind, 'delegate_candidate', {
        mode: 'create', subject: 'current_workspace', instruction: '建立设备结构。'
      })])
    ] });
    const review = new MockLanguageModelV4({ doGenerate: async (call) => {
      assert.equal((call.tools || []).length, 0, '建议阶段不得暴露返工、澄清或交付Tool');
      if (kind === 'timeout') {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('review timeout signal missing')), 6000);
          call.abortSignal.addEventListener('abort', () => { clearTimeout(timer); reject(call.abortSignal.reason); }, {once:true});
        });
      }
      if (kind === 'tool_call') return generatedToolCalls([toolCall('unauthorized-refine', 'delegate_candidate', {
        mode: 'refine', subject: 'current_validated_candidate', instruction: '不得发布，重新生成。'
      })]);
      return generatedText(kind === 'empty' ? '' : advice);
    } });
    const generator = new MockLanguageModelV4({doGenerate:[generatedText(candidate)]});
    const finalizer = new MockLanguageModelV4({doGenerate: async call => {
      const input = JSON.stringify(call);
      if (kind === 'optional_detail' || kind === 'core_gap') {
        assert(!input.includes('main_worker_result_review'), 'Finalizer直接基于任务与候选解释');
      }
      return generatedText('已提供设备结构。' + ((kind === 'optional_detail' || kind === 'core_gap') ? advice : '模型已通过验证。'));
    }});
    let validations=0;
    const response = await runAgentCapability(host, v2Config(main, {
      runId:'run_advice_' + kind,
      agentSemanticReviewEnabled:false,
      agentMainWorkerReviewTimeoutMs: 5000,
      agentStageModels:{main, mainReview:review, candidate:generator, finalizer,
        fastGate:new MockLanguageModelV4({doGenerate:[generatedText('PASS')]})},
      agentDependencies:{validateCandidateWorkspace:async ({input}) => {
        validations++;
        return {
          validator:{authority:'official-sysml-v2-validator',version:'2026-04/0.59.0/sha256:' + 'a'.repeat(64),evidenceHash:hashContent('advice-' + kind)},
          official:{syntax:'passed',semantic:'passed',diagnostics:[]},
          completeness:'complete',courseRuleApplicability:'not_applicable',
          candidateWorkspaceHash:hashContent(host.editor.files[0].path + '\n' + hashContent(input.content)),
          patches:[{fileId:input.fileId,baseHash:input.baseHash,candidateHash:hashContent(input.content),kind:'replace_entry'}]
        };
      }}
    }));
    assert.equal(response.answerCompletionStatus,'complete', kind + ': 建议和建议失败都不能阻断完整回答交付');
    assert.equal(response.validatorStatus,'validated_passed');
    assert.equal(response.candidateDeliveryStatus,'changed_delivered');
    assert(response.directAnswer.includes(candidate));
    assert.equal(main.doGenerateCalls.length,1);
    assert.equal(generator.doGenerateCalls.length,1);
    assert.equal(review.doGenerateCalls.length,0);
    assert.equal(validations,1,'建议不得触发重生成或重新验证');
    if (kind === 'optional_detail' || kind === 'core_gap') assert(response.directAnswer.includes(advice));
    else assert(!response.warnings.some(w=>w.startsWith('main_worker_review_')), '未运行的建议阶段不能伪造失败诊断');
  }
}

async function testV2FailedRunLifecycle(MockLanguageModelV4) {
  const question = '补全当前模型。';
  const host = normalizedHost(question, 'req_v2_failed_lifecycle');
  const nonThinkingModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedText('本轮没有发布候选。')
    ]
  });
  const thinkingModel = new MockLanguageModelV4({
    doGenerate: [
      generatedToolCalls([
        toolCall('delegate-failed-candidate', 'delegate_candidate', {
          mode: 'complete', subject: 'current_workspace', instruction: ['完成当前模型并通过Validator。'].join("\n")
        })
      ]),
      generatedText('```sysml\npackage Demo { part def CompletedVehicle; }\n```')
    ]
  });
  const lifecycleEvents = [];
  let validatorCalls = 0;
  const response = await runAgentCapability(host, v2Config(nonThinkingModel, {
      runId: 'run_v2_failed_lifecycle',
      conversation: {
        recordRunEvent: async (event) => lifecycleEvents.push(event)
      },
      agentNonThinkingModel: nonThinkingModel,
      agentThinkingModel: thinkingModel,
      agentReasoningMode: 'adaptive',
      agentDependencies: {
        validateCandidateWorkspace: async () => {
          validatorCalls += 1;
          throw Object.assign(
            new Error('Read-only candidate must match the trusted snapshot: file_test'),
            { code: 'CANDIDATE_TARGET_READ_ONLY' }
          );
        }
      }
    }));
  assert.equal(validatorCalls, 1,
    '候选验证异常必须停止本轮且不重试发布');
  assert.equal(response.answerCompletionStatus, 'incomplete');
  assert.equal(response.patches.length, 0, '只读门禁必须继续阻止候选发布');
  assert.match(response.directAnswer, /本轮未形成可交付候选.*没有形成可绑定的 Official Validator PASS/u,
    '候选子流程失败必须由服务端给出确定性可见终态，而不是复用模型的成功或修改声明');
  assert(response.warnings.includes('workflow_fail_closed:candidate_read_only_target'),
    '可信失败原因必须保留在后台响应和审计记录中');
  const lifecycleStages = lifecycleEvents.map((event) => event.payload?.stage);
  assert.equal(lifecycleStages.filter((stage) => stage === 'run_started').length, 1);
  assert.equal(lifecycleStages.filter((stage) => stage === 'run_finished').length, 1,
    '可交付降级结果必须正常结束Run，不能再向前端抛error');
}

async function testV2CandidateModeMaterialization(runtime) {
  const contractQuestion = '继续上一轮任务。';
  const contractHost = normalizedHost(contractQuestion, 'req_v2_task_contract_context');
  const taskContractContext = {
    relation: 'prior_dialogue',
    contract: {
      contractId: 'task_contract_previous',
      revision: 7,
      status: 'delivered',
      taskProfile: 'model_refinement',
      predecessorContractId: '',
      taskRelation: 'new_task',
      objectiveSummary: '交付完整汽车热管理模型。',
      goals: [{
        goalId: 'goal_previous_root',
        statement: '补齐电池到热管理系统的热状态连接。',
        required: true,
        status: 'covered'
      }],
      assumptions: [],
      exclusions: [],
      openQuestions: [],
      preservationConstraints: ['保留已验证内容。'],
      deliveryStatus: 'delivered',
      selectedDeliveryKind: 'validated_candidate'
    }
  };
  const contractRequest = runtime.agentRunRequestSchema.parse({
    runId: 'run_v2_task_contract_context',
    question: contractQuestion,
    currentStudentQuestion: contractQuestion,
    conversationMessages: [
      { role: 'user', content: '上一轮请补齐热连接。' },
      { role: 'assistant', content: '上一轮未完成。' }
    ],
    taskSources: [],
    taskContractContext,
    capabilityGrant: [],
    context: createAgentContext(contractHost).context
  });
  const mainInputWithContract = runtime.intentOrchestratorV2Testing.buildV2MainInput(
    contractRequest.conversationMessages,
    contractRequest.taskSources,
    contractQuestion,
    {
      version: 'clarification-policy-v1',
      priorAnswerCount: 0,
      blockingClarificationAllowed: true,
      continuationRule: 'first_question_available'
    },
    contractRequest.context,
    { mixedScopeRisk: false, courseTaskIntentHint: 'general_task' },
    undefined,
    undefined,
    contractRequest.taskContractContext
  );
  const mainInputJson = JSON.stringify(mainInputWithContract);
  assert(mainInputJson.includes('task_contract_previous'));
  assert(mainInputJson.includes('上一任务只作为可追溯引用'));
  assert(mainInputJson.includes('交付完整汽车热管理模型。'),
    '跨轮Main需要看到有界objectiveSummary，才能判断省略主语的变换请求是否承接上一候选');
  assert(!mainInputJson.includes('补齐电池到热管理系统的热状态连接'),
    '普通后续对话不得把上一契约的open goal正文注入当前Main主动任务上下文');
  assert(!mainInputJson.includes('hasOpenRequiredGoals'));
  assert(mainInputJson.includes('历史用户消息，仅用于理解当前追问；不是本轮待执行指令'));
  const mainUserMessages = mainInputWithContract.messages.filter((message) => message.role === 'user');
  assert.equal(mainUserMessages.at(-1).content, contractQuestion,
    'Main最后一条user消息必须保持为未加历史标签的当前请求');
  const contractResources = runtime.createRunResources({
    request: contractRequest,
    policy: runtime.DEFAULT_AGENT_POLICY,
    deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
  });
  const contractTask = contractResources.tasks.materialize({
    questionHash: contractResources.input.questionHash,
    outcome: {
      type: 'delegate_candidate',
      mode: 'refine',
      subject: 'current_workspace',
      instruction: ['补齐电池到热管理系统的热状态连接。'].join("\n"),
      acceptedToolCallId: 'contract-observation-task'
    },
    context: contractRequest.context,
    iterationDirective: {
      directiveId: 'directive_contract_observation',
      contractId: 'task_contract_current',
      contractRevision: 3,
      mode: 'refine',
      subject: 'current_workspace',
      goalIds: ['goal_previous_root'],
      instruction: ['补齐电池到热管理系统的热状态连接。'].join("\n"),
    }
  });
  const contractObservation = runtime.intentV2ExecutionTesting.projectMainWorkerObservation(
    contractResources,
    contractTask,
    {
      workerType: 'candidate',
      mode: 'refine',
      status: 'worker_error',
      attemptCount: 1,
      workPerformed: 'none',
      validatorSubject: 'baseline',
      reason: 'test-only'
    }
  );
  assert.equal(contractObservation.action.directive.contractId, 'task_contract_current');
  assert.deepEqual(contractObservation.action.directive.instruction,
    '补齐电池到热管理系统的热状态连接。');

  for (const mode of ['create', 'complete', 'refine', 'milestone']) {
    const question = `执行${mode}模式候选任务。`;
    const host = normalizedHost(question, `req_v2_mode_${mode}`);
    const request = runtime.agentRunRequestSchema.parse({
      runId: `run_v2_mode_${mode}`,
      question,
      currentStudentQuestion: question,
      capabilityGrant: ['validate_candidate_workspace'],
      context: createAgentContext(host).context
    });
    const resources = runtime.createRunResources({
      request,
      policy: runtime.DEFAULT_AGENT_POLICY,
      deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
    });
    const task = resources.tasks.materialize({
      questionHash: resources.input.questionHash,
      outcome: {
        type: 'delegate_candidate', mode, subject: 'current_workspace',
        instruction: [`完成${mode}模式目标。`].join("\n"),
        acceptedToolCallId: `mode-${mode}`
      },
      context: request.context
    });
    assert.equal(task.mode, mode);
    assert.equal(task.target.kind, 'active_file',
      'Main选择current_workspace后，Candidate mode不得擅自改换工作对象');
  }
  for (const targetCase of [
    { id: 'knowledge-markdown', path: 'engineering-knowledge-catalog.md', editable: true },
    { id: 'readonly-sysml', path: 'reference.sysml', editable: false }
  ]) {
    for (const mode of ['create', 'complete', 'refine', 'milestone']) {
      const question = `执行${mode}模式候选任务。`;
      const host = normalizedHost(question, `req_v2_${mode}_${targetCase.id}`);
      host.editor.entryFile = targetCase.path;
      host.editor.activeFilePath = targetCase.path;
      host.editor.files[0].path = targetCase.path;
      host.editor.files[0].editable = targetCase.editable;
      const request = runtime.agentRunRequestSchema.parse({
        runId: `run_v2_${mode}_${targetCase.id}`,
        question,
        currentStudentQuestion: question,
        capabilityGrant: ['validate_candidate_workspace'],
        context: createAgentContext(host).context
      });
      const resources = runtime.createRunResources({
        request,
        policy: runtime.DEFAULT_AGENT_POLICY,
        deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
      });
      const task = resources.tasks.materialize({
        questionHash: resources.input.questionHash,
        outcome: {
          type: 'delegate_candidate',
          mode,
          subject: 'current_workspace',
          instruction: [`完成${mode}模式目标。`].join("\n"),
          acceptedToolCallId: `mode-${mode}-${targetCase.id}`
        },
        context: request.context
      });
      assert.equal(task.target.kind, 'standalone_model',
        'every Candidate mode must use a governed standalone SysML target on non-SysML or read-only surfaces');
    }
  }
  const repairQuestion = '修复当前模型中的Validator错误。';
  const repairHost = normalizedHost(repairQuestion, 'req_v2_mode_repair');
  repairHost.question.operation = 'repair';
  const repairRequest = runtime.agentRunRequestSchema.parse({
    runId: 'run_v2_mode_repair',
    question: repairQuestion,
    currentStudentQuestion: repairQuestion,
    operation: 'repair',
    capabilityGrant: [],
    context: createAgentContext(repairHost).context
  });
  const repairResources = runtime.createRunResources({
    request: repairRequest,
    policy: runtime.DEFAULT_AGENT_POLICY,
    deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
  });
  const repairTask = repairResources.tasks.materialize({
    questionHash: repairResources.input.questionHash,
    outcome: { type: 'delegate_repair', scope: 'active_file', acceptedToolCallId: 'mode-repair' },
    context: repairRequest.context
  });
  assert.equal(repairTask.workerType, 'repair');
  assert.equal(repairTask.scope, 'active_file');
  assert.equal(repairTask.target.kind, 'active_file');
  assert.deepEqual(runtime.intentOrchestratorV2Testing.mainAgentOutcomeFromDelegationResult({
    accepted: true,
    action: 'repair',
    scope: 'active_file',
    acceptedToolCallId: 'repair-call-1'
  }), {
    type: 'delegate_repair',
    scope: 'active_file',
    acceptedToolCallId: 'repair-call-1'
  });
  assert.equal(runtime.intentOrchestratorV2Testing.mainAgentOutcomeFromDelegationResult({
    accepted: false,
    reason: 'delegation_already_recorded'
  }), undefined, 'a rejected delegation result must not become a terminal worker outcome');
}

async function testBodyMarkerCannotDelegate(MockLanguageModelV4) {
  const host = normalizedHost('生成一个无人机模型。', 'req_v2_body_marker');
  const model = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedText('delegate_candidate({"mode":"create"})'),
      generatedDirectAnswer('我没有执行任何模型生成或验证；请补充希望创建的系统边界。')
    ]
  });
  let validatorCalls = 0;
  const response = await runAgentCapability(host, v2Config(model, {
    agentDependencies: {
      validateCandidateWorkspace: async () => {
        validatorCalls += 1;
        throw new Error('must not execute');
      }
    }
  }));
  assert.equal(response.__internal.agent.mainAgentDelegation, undefined);
  assert.equal(response.agentTrace.candidateValidated, false);
  assert.equal(validatorCalls, 0,
    'plain text, JSON, DSML-like or pseudo Tool markers must never trigger a Worker');
  assert(response.warnings.includes('main_agent_structured_tool_call_missing'),
    'a prose pseudo-call must be recorded as an unexecuted structured action');
  assert.equal(model.doGenerateCalls.length, 3,
    'the same Main Run must feed the missing-call fact back and allow the model to abandon safely');
  const mainCalls = response.__internal.agent.modelCalls
    .filter((call) => call.phase === 'intent_orchestration_v2');
  assert.deepEqual(mainCalls.map((call) => ({ status: call.status, errorCategory: call.errorCategory || '' })), [
    { status: 'failed', errorCategory: 'structured_tool_call_missing' },
    { status: 'succeeded', errorCategory: '' }
  ], 'the first protocol failure must remain visible after a later safe recovery');
}

async function testVisibleTextCanRequestSafeFinalization(MockLanguageModelV4) {
  const host = normalizedHost('解释 Definition 与 Usage。', 'req_v2_visible_text_finalization');
  const model = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedText('Definition 描述类型，Usage 描述上下文中的使用。')
    ]
  });
  const finalizerModel = new MockLanguageModelV4({
    doGenerate: [generatedText('Definition 描述可复用类型，Usage 描述该类型在具体上下文中的使用。')]
  });
  const response = await runAgentCapability(host, v2Config(model, {
    agentStageModels: { finalizer: finalizerModel }
  }));
  assert.equal(response.answerCompletionStatus, 'complete');
  assert.equal(response.agentTrace.stopReason, 'completed');
  assert.equal(response.directAnswer,
    'Definition 描述可复用类型，Usage 描述该类型在具体上下文中的使用。');
  assert.equal(finalizerModel.doGenerateCalls.length, 1,
    '无副作用的Main可见正文应作为Finalizer草稿，而不是因缺少终末Tool被丢弃');
  assert(response.warnings.includes('main_agent_visible_text_finalization_accepted'));
  assert(!response.warnings.includes('intent_v2_structured_tool_call_missing'));
}

async function testFinalizerTimeoutUsesServerBoundMainDraft(MockLanguageModelV4) {
  const host = normalizedHost('解释 Definition 与 Usage。', 'req_v2_finalizer_timeout_main_draft');
  const mainDraft = 'Definition 描述可复用类型，Usage 描述该类型在具体上下文中的使用。';
  const model = new MockLanguageModelV4({
    doGenerate: [generatedText('PASS'), generatedDirectAnswer(mainDraft)]
  });
  const finalizerModel = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }
  });
  const response = await runAgentCapability(host, v2Config(model, {
    agentStageModels: { finalizer: finalizerModel }
  }));
  assert.equal(response.answerCompletionStatus, 'complete',
    'Finalizer超时时，非空且已由服务端绑定清洗的Main草稿应保持Direct回答可交付');
  assert.equal(response.agentTrace.stopReason, 'completed');
  assert.equal(response.directAnswer, mainDraft);
  assert(response.warnings.includes('final_answer_worker_timeout_server_bound_main_draft_used'));
  assert(response.warnings.some((warning) => warning.startsWith('final_answer_worker_fallback:')),
    'Finalizer首次超时证据必须保留，不能被Main草稿降级覆盖');
  assert.equal(response.validatorStatus, 'not_validated');
}

async function testAutonomousKnowledgeSearch(MockLanguageModelV4) {
  const host = normalizedHost('比较 Definition 和 Usage 的语义边界。', 'req_v2_compare');
  const model = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedToolCalls([
        toolCall('knowledge-1', 'search_reviewed_knowledge', {
          query: 'SysML v2 Definition Usage semantic distinction',
          limit: 5
        })
      ]),
      generatedDirectAnswer('Definition 描述可复用的类型；Usage 表示该类型在特定上下文中的使用。[source:knowledge-definition-usage]')
    ]
  });
  let knowledgeCalls = 0;
  const response = await runAgentCapability(host, v2Config(model, {
    agentDependencies: {
      searchReviewedKnowledge: async ({ input }) => {
        knowledgeCalls += 1;
        return completeKnowledgeOutput(input.query);
      }
    }
  }));
  assert.equal(knowledgeCalls, 1, 'the Main Agent must be able to choose reviewed knowledge autonomously');
  assert.equal(response.knowledgeGrounding.used, true, JSON.stringify(response.__internal, null, 2));
  assert.equal(response.knowledgeGrounding.uniqueClaimCount, 1);
  assert.equal(response.__internal.agent.answerContract, undefined);
  assert.doesNotMatch(response.directAnswer, /\[source:/u, 'internal source markers must be removed from visible text');
  assert.equal(response.agentTrace.requestPlan, undefined);
  assert.equal(response.agentTrace.fastGateProjection, undefined);
}

async function testToolOnlyDirectActionReachesFinalAnswerWorker(MockLanguageModelV4) {
  const host = normalizedHost('SysML v2 与 SysML v1 的主要区别是什么？', 'req_v2_tool_only_direct');
  const mainModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS|COURSE_UNKNOWN'),
      generatedToolCalls([
        toolCall('knowledge-tool-only', 'search_reviewed_knowledge', {
          query: 'SysML v2 SysML v1 semantic differences',
          limit: 5
        })
      ]),
      generatedDirectAnswer()
    ]
  });
  const finalizerModel = new MockLanguageModelV4({
    doGenerate: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return generatedText('SysML v2采用正式文本语法和更精确的语义基础，并强化了API、互操作和数字工程集成。');
    }
  });
  let knowledgeCalls = 0;
  const response = await runAgentCapability(host, v2Config(mainModel, {
    agentMaxDurationMs: 500,
    agentTerminalReserveMs: 20,
    agentStageModels: { finalizer: finalizerModel },
    agentDependencies: {
      searchReviewedKnowledge: async ({ input }) => {
        knowledgeCalls += 1;
        return completeKnowledgeOutput(input.query);
      }
    }
  }));

  assert.equal(knowledgeCalls, 1);
  assert.equal(response.answerCompletionStatus, 'complete');
  assert.equal(response.agentTrace.stopReason, 'completed');
  assert.equal(response.directAnswer,
    'SysML v2采用正式文本语法和更精确的语义基础，并强化了API、互操作和数字工程集成。');
  assert.equal(finalizerModel.doGenerateCalls.length, 1,
    '接受request_final_answer后必须且只能启动一次Final Answer Worker');
  assert(response.warnings.includes('final_answer_worker_borrowed_run_budget'),
    'tool-only Direct没有安全草稿时，Finalizer必须能够借用一次终末预算完成回答');
  assert(JSON.stringify(finalizerModel.doGenerateCalls[0]).includes('\\"mainDraft\\":\\"\\"'),
    'tool-only终末动作必须把空Main草稿原样交给Finalizer，不得伪造占位正文');
  assert(!JSON.stringify(finalizerModel.doGenerateCalls[0]).includes('package GeneralViewExample'),
    '普通Direct Answer的Finalizer不得注入无关的8组标准View示例');
  assert.deepEqual(response.__internal.agent.modelCalls.map((call) => call.phase), [
    'scope_gate_v2',
    'intent_orchestration_v2',
    'answer_generation'
  ]);
  assert(!response.warnings.includes('intent_v2_generation_failed'));
  assert(!response.warnings.includes('agent_stopped:provider_error'));
  assert.equal(response.validatorStatus, 'not_validated',
    'Direct Answer不应为了终末生成而调用Official Validator');
}

async function testDirectFinalizerReceivesMainReadOnlyEvidenceAndCannotPromiseAttachment(MockLanguageModelV4) {
  const host = normalizedHost('给我描述这个模型', 'req_v2_direct_finalizer_evidence');
  const mainModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS|COURSE_UNKNOWN'),
      generatedToolCalls([toolCall('inspect-for-finalizer', 'inspect_current_model', {
        source: 'current_workspace',
        detail: 'full'
      })]),
      generatedDirectAnswer()
    ]
  });
  const finalizerModel = new MockLanguageModelV4({
    doGenerate: [generatedText(
      '这个模型在 Vehicle 包中定义了 Car，并声明了 car usage。\n\n服务端会在下方呈现完整候选代码，请直接复制。'
    )]
  });
  const response = await runAgentCapability(host, v2Config(mainModel, {
    agentStageModels: { finalizer: finalizerModel }
  }));

  const finalizerInput = JSON.stringify(finalizerModel.doGenerateCalls[0]);
  assert(finalizerInput.includes('package Vehicle'),
    'Main已读取的模型正文必须由服务端投影给Finalizer，不能在Main到Finalizer交接时丢失');
  assert.match(response.directAnswer, /Vehicle 包中定义了 Car/u);
  assert.doesNotMatch(response.directAnswer, /服务端.*下方.*候选代码/u,
    'Direct Answer没有候选附件时必须确定性删除未绑定的附件承诺');
}

async function testConfiguredKnowledgeLimitRemovesSearch(MockLanguageModelV4) {
  const host = normalizedHost('请基于受审核知识解释 Definition 和 Usage。', 'req_v2_knowledge_limit');
  const model = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedToolCalls([
        toolCall('knowledge-limit-1', 'search_reviewed_knowledge', {
          query: 'SysML v2 Definition Usage semantic distinction',
          limit: 5
        })
      ]),
      generatedDirectAnswer('Definition 描述类型，Usage 表示类型在上下文中的使用。')
    ]
  });
  let backendCalls = 0;
  const response = await runAgentCapability(host, v2Config(model, {
    agentReviewedKnowledgeMaxNewQueriesPerRun: 1,
    agentDependencies: {
      searchReviewedKnowledge: async ({ input }) => {
        backendCalls += 1;
        return completeKnowledgeOutput(input.query);
      }
    }
  }));
  assert.equal(response.answerCompletionStatus, 'complete');
  assert.equal(backendCalls, 1);
  assert(generationToolNames(model.doGenerateCalls[1]).includes('search_reviewed_knowledge'),
    '配置额度尚有剩余时Main应暴露Search');
  assert(generationToolNames(model.doGenerateCalls[2]).includes('search_reviewed_knowledge'),
    '退休配置不能关闭互补查询');

  const zeroModel = new MockLanguageModelV4({
    doGenerate: [generatedText('PASS'), generatedDirectAnswer('无需检索即可回答。')]
  });
  await runAgentCapability(
    normalizedHost('什么是 part definition？', 'req_v2_knowledge_limit_zero'),
    v2Config(zeroModel, { agentReviewedKnowledgeMaxNewQueriesPerRun: 0 })
  );
  assert(generationToolNames(zeroModel.doGenerateCalls[1]).includes('search_reviewed_knowledge'),
    '历史配置0不再覆盖共享工具预算');
}

function testDomainSearchPromptPolicy(runtime) {
  const prompt = runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS;
  assert.match(prompt,
    /明确要求“参考、对标或仿照”某个具名的现实产品、系统、平台或工程设计/u,
    'a named real-world reference must be recognized as a generic evidence-requiring case');
  assert.match(prompt,
    /当前上下文与已检索证据没有直接支撑.*必须在委派Candidate之前调用search_engineering_domain_evidence/u,
    'missing direct evidence for a named real-world reference must trigger Domain Search before Candidate');
  assert.match(prompt, /不得仅凭模型记忆写出可由外部资料核验的具体/u,
    'externally verifiable engineering details must not be supplied from model memory alone');
  assert.match(prompt, /纯概念任务且未引用任何现实对象.*允许零次Domain检索/u,
    'purely conceptual tasks without a real-world reference must retain the zero-search path');
  assert.doesNotMatch(prompt, /Tesla|特斯拉|汽车|热管理/iu,
    'the generic Domain Search policy must not hardcode the acceptance fixture or its industry');
}

async function testDomainSearchToolContinuation(MockLanguageModelV4) {
  const host = normalizedHost(
    '请联网查找电动汽车电池热管理系统的主要组成，并给出公开来源。',
    'req_v2_domain_search'
  );
  const questions = ['电动汽车电池热管理系统通常由哪些工程部件组成？'];
  const model = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedToolCalls([
        toolCall('domain-search-1', 'search_engineering_domain_evidence', { questions })
      ]),
      generatedDirectAnswer('电池热管理通常包含冷却板、冷却回路、泵、换热器和控制器。')
    ]
  });
  let domainCalls = 0;
  const response = await runAgentCapability(host, v2Config(model, {
    agentDependencies: {
      searchDomainEvidence: async ({ input }) => {
        domainCalls += 1;
        return completeDomainEvidenceOutput(input.questions);
      }
    }
  }));
  assert.equal(response.answerCompletionStatus, 'complete');
  assert.equal(domainCalls, 1, 'Main选择Domain Tool后只能执行一次对应后端调用');
  assert.equal(model.doGenerateCalls.length, 3,
    'AI SDK必须把Domain Tool Result带入下一Step后再生成最终回答');
  const continuationCall = JSON.stringify(model.doGenerateCalls[2]);
  assert.match(continuationCall, /电池热管理通常由冷却板/u);
  assert.match(continuationCall, /https:\/\/example\.edu\/battery-thermal-management/u);
  assert.doesNotMatch(continuationCall, /encrypted_content/u,
    'Provider opaque encrypted_content不得进入Main下一Step');
}

async function testFrozenModelPairAndAudit(MockLanguageModelV4) {
  const host = normalizedHost('解释 Definition 和 Usage。', 'req_v2_model_pair');
  const nonThinkingModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedText('Definition 描述类型，Usage 描述上下文中的使用。')
    ]
  });
  const adaptiveThinkingModel = new MockLanguageModelV4({
    doGenerate: [generatedDirectAnswer('Definition 描述类型，Usage 描述上下文中的使用。')]
  });
  const adaptiveResponse = await runAgentCapability(host, v2Config(nonThinkingModel, {
    agentNonThinkingModel: nonThinkingModel,
    agentThinkingModel: adaptiveThinkingModel,
    agentReasoningMode: 'adaptive',
    agentDisabledModelAlias: 'mock-v2-nonthinking',
    llm: { providerMode: 'mock', model: 'mock-v2-thinking' }
  }));
  assert.equal(nonThinkingModel.doGenerateCalls.length, 2,
    'Non-Thinking阶段模型必须分别承担Fast Gate与FinalAnswerWorker');
  assert.equal(adaptiveThinkingModel.doGenerateCalls.length, 1);
  assert.equal(adaptiveResponse.__internal.agent.modelCalls.find((call) => (
    call.phase === 'intent_orchestration_v2'
  )).modelId, 'mock-v2-thinking');

  const highGateModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedText('Definition 描述类型，Usage 描述上下文中的使用。')
    ]
  });
  const highMainModel = new MockLanguageModelV4({
    doGenerate: [generatedDirectAnswer('Definition 描述类型，Usage 描述上下文中的使用。')]
  });
  const highResponse = await runAgentCapability(
    normalizedHost('再解释一次 Definition 和 Usage。', 'req_v2_model_pair_high'),
    v2Config(highMainModel, {
      agentNonThinkingModel: highGateModel,
      agentThinkingModel: highMainModel,
      agentReasoningMode: 'provider-managed',
      agentDisabledModelAlias: 'mock-v2-nonthinking',
      llm: { providerMode: 'mock', model: 'mock-v2-thinking' }
    })
  );
  assert.equal(highGateModel.doGenerateCalls.length, 2,
    '冻结的Non-Thinking模型必须同时服务Fast Gate和FinalAnswerWorker');
  assert.equal(highMainModel.doGenerateCalls.length, 1);
  assert.equal(highResponse.__internal.agent.reasoningMode, 'high',
    'outer attestation must record the effective V2 reasoning mode');
  assert.equal(highResponse.__runtimeAttestation.reasoningMode, 'high');
  const highCalls = highResponse.__internal.agent.modelCalls;
  assert.equal(highCalls.find((call) => call.phase === 'scope_gate_v2').modelId,
    'mock-v2-nonthinking');
  assert.equal(highCalls.find((call) => call.phase === 'intent_orchestration_v2').modelId,
    'mock-v2-thinking');
}

async function testGraphEvidenceBinding(MockLanguageModelV4) {
  const host = normalizedHost('Definition 和 Usage 的关系依据是什么？', 'req_v2_graph_citation');
  const model = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedToolCalls([
        toolCall('knowledge-graph', 'search_reviewed_knowledge', {
          query: 'SysML v2 Definition Usage relationship',
          limit: 5
        })
      ]),
      generatedDirectAnswer('Usage 可以由 Definition 定型。[source:evidence-definition-usage]')
    ]
  });
  const response = await runAgentCapability(host, v2Config(model, {
    agentDependencies: {
      searchReviewedKnowledge: async ({ input }) => {
        const output = completeKnowledgeOutput(input.query);
        output.additionalSupportingClaimIds.push('claim-unrelated');
        output.returnedClaimCount = 2;
        output.claims.push({
          claimId: 'claim-unrelated',
          claimText: 'An unrelated statement must not be disclosed.',
          authorityLevel: 'A1',
          operators: [],
          astContextIds: [],
          evidenceIds: ['evidence-unrelated'],
          selectionRole: 'additional_supporting'
        });
        output.evidenceBlocks.push({
          evidenceId: 'evidence-unrelated',
          sourceId: 'another-reviewed-source',
          sectionPath: 'Unrelated',
          excerpt: 'This evidence was retrieved but not cited.',
          textHash: hashContent('This evidence was retrieved but not cited.'),
          authorityLevel: 'A1'
        });
        return output;
      }
    }
  }));
  const knowledgeEvidence = response.evidence.filter((item) => item.sourceType === 'knowledge');
  assert.deepEqual(knowledgeEvidence.map((item) => item.sourceTitle), ['evidence-definition-usage'],
    'a cited graph evidenceId must bind only that Evidence without publishing unrelated retrievals');
  assert.equal(response.__internal.agent.answerContract, undefined);

  const documentSourceHost = normalizedHost('Definition 和 Usage 的关系依据是什么？', 'req_v2_document_source');
  const documentSourceModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedToolCalls([
        toolCall('knowledge-document-source', 'search_reviewed_knowledge', {
          query: 'SysML v2 Definition Usage relationship',
          limit: 5
        })
      ]),
      generatedDirectAnswer('Usage 可以由 Definition 定型。[source:sysml20-part1-formal-text]')
    ]
  });
  const documentSourceResponse = await runAgentCapability(documentSourceHost, v2Config(documentSourceModel, {
    agentDependencies: {
      searchReviewedKnowledge: async ({ input }) => completeKnowledgeOutput(input.query)
    }
  }));
  assert.equal(documentSourceResponse.evidence.some((item) => item.sourceType === 'knowledge'), false,
    'a document-level graph sourceId must not expand to every Evidence block sharing that source');
  assert.equal(documentSourceResponse.__internal.agent.answerContract, undefined);
}

function testModelVisibleEvidenceBoundary(runtime) {
  const now = new Date().toISOString();
  const facts = (modelText) => ({
    modelText,
    workflowVersion: 'intent-orchestrator-v2',
    finishReason: 'stop',
    stepCount: 2,
    invalidToolCallCount: 0,
    stopReason: 'completed',
    usage: {}
  });
  const skillEntry = {
    sequence: 0,
    toolCallId: 'hidden-skill',
    toolName: 'search_skill_guidance',
    canonicalArgs: '{}',
    argsHash: hashContent('hidden-skill-args'),
    status: 'succeeded',
    replayCount: 0,
    startedAt: now,
    finishedAt: now,
    output: {
      query: 'hidden skill',
      items: [{
        sourceId: 'skill-hidden-source',
        title: 'Hidden skill',
        excerpt: 'The bounded model view omitted this item.',
        authority: 'project_skill',
        version: 'v1',
        contentHash: hashContent('hidden skill')
      }]
    }
  };
  const emptyVisibility = {
    skillSourceIds: new Set(),
    knowledgeCardIds: new Set(),
    graphClaimIds: new Set(),
    graphEvidenceIds: new Set()
  };
  const hiddenSkill = runtime.assembleTrustedResponse(
    facts('根据已有信息回答。'),
    [skillEntry],
    { evidenceCitationVisibility: emptyVisibility }
  );
  assert.equal(hiddenSkill.evidence.length, 0,
    'V2 must not recover the unique Skill item when its bounded model view omitted it');

  const graphEntry = {
    ...skillEntry,
    toolCallId: 'hidden-graph',
    toolName: 'search_reviewed_knowledge',
    argsHash: hashContent('hidden-graph-args'),
    output: completeKnowledgeOutput('Definition Usage')
  };
  const guessedGraph = runtime.assembleTrustedResponse(
    facts('结论。[source:knowledge-definition-usage] [source:evidence-definition-usage]'),
    [graphEntry],
    { evidenceCitationVisibility: emptyVisibility }
  );
  assert.equal(guessedGraph.evidence.length, 0,
    'a guessed cardId or evidenceId hidden by the bounded view must not be published');

  const visibleClaimOnly = runtime.assembleTrustedResponse(
    facts('结论。[source:claim-definition-usage]'),
    [graphEntry],
    {
      evidenceCitationVisibility: {
        ...emptyVisibility,
        graphClaimIds: new Set(['claim-definition-usage'])
      }
    }
  );
  assert.equal(visibleClaimOnly.evidence.length, 0,
    'a visible Claim must not bind an associated Evidence block that the model did not see');

  const closedVisibleGraph = runtime.assembleTrustedResponse(
    facts('结论。[source:claim-definition-usage]'),
    [graphEntry],
    {
      evidenceCitationVisibility: {
        ...emptyVisibility,
        graphClaimIds: new Set(['claim-definition-usage']),
        graphEvidenceIds: new Set(['evidence-definition-usage'])
      }
    }
  );
  assert.deepEqual(
    closedVisibleGraph.evidence.map((item) => item.sourceId),
    ['evidence-definition-usage'],
    'claim citation may bind only the Evidence subset present in the model-visible projection'
  );
}

async function testMainFailureDegradationAndBounds(MockLanguageModelV4, runtime) {
  assert.match(
    runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS,
    /显式语言声明只是当前草稿文本事实/u,
    'the Main Agent must prioritize explicit authorized model declarations over generic naming hypotheses'
  );
  assert.match(
    runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS,
    /较窄结果不足，可以升级到full/u,
    'inspect_current_model必须恢复按需升级，而不是首次强制full'
  );
  const { inspectCurrentModelInputSchema } = await import('../apps/teacher/dist/agent/types.mjs');
  assert.equal(inspectCurrentModelInputSchema.parse({}).detail, 'summary',
    '省略detail时必须恢复历史summary默认值');
  assert.equal(
    runtime.intentOrchestratorV2Testing.shouldFinalizeIntentV2Step(2, 5, {
      callCount: 2,
      maxCalls: 5
    }),
    false,
    'successful tool calls alone must not force finalization before evidence sufficiency is known'
  );
  assert.equal(
    runtime.intentOrchestratorV2Testing.shouldFinalizeIntentV2Step(4, 5, {
      callCount: 2,
      maxCalls: 5
    }),
    true,
    'the final model step must remain reserved for a natural-language answer'
  );
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /不得把声明本身、当前绑定值或语法通过自动称为验证证据/u,
    'normative explanations must separate declarations from actual verification evidence');
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /不得从Usage声明数量推断实例数量/u,
    'definition/usage explanations must not infer instance counts without multiplicity or value evidence');
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /item usage（包括part usage，但connection usage例外）/u,
    'feature-usage explanations must preserve the closed default-multiplicity kind set and connection exception');
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /由Definition或另一个Usage拥有而不是由Package拥有/u,
    'the tighter default must preserve its ownership condition');
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /Usage本身不是物理实例/u,
    'definition/usage explanations must explicitly preserve the Usage-value-Definition layers');
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /可以有零个或多个显式的in参数/u,
    'constraint explanations must preserve parameter optionality');
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /多概念问题优先构造一个包含全部比较对象和共同维度的联合查询/u,
    'multi-concept explanations must prefer a shared retrieval frame before complementary queries');
  assert.equal(
    runtime.intentOrchestratorV2Testing.intentV2RunDurationMs({ maxDurationMs: 300_000 }),
    300_000,
    'V2 must accept the configured 300-second Run ceiling'
  );
  assert.deepEqual(
    runtime.intentOrchestratorV2Testing.classifyMainCompletion({
      text: '这是被截断的部分解释。',
      finishReason: 'length',
      steps: [{}]
    }, 5),
    {
      completed: false,
      stopReason: 'step_limit',
      warning: 'intent_v2_incomplete_finish:length'
    },
    'a non-empty length-truncated answer must never be marked completed'
  );
  assert.equal(runtime.intentOrchestratorV2Testing.classifyMainCompletion({
    text: '这是被内容过滤截断的部分解释。',
    finishReason: 'content-filter',
    steps: [{}]
  }, 5).completed, false);

  const repeatedInspectHost = normalizedHost('解释一下当前模型。', 'req_v2_repeated_current_model_read');
  const repeatedInspectModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedToolCalls([toolCall('inspect-summary', 'inspect_current_model', { detail: 'summary' })]),
      generatedToolCalls([toolCall('inspect-full', 'inspect_current_model', { detail: 'full' })]),
      generatedDirectAnswer('当前模型正文未能在本轮取得，因此不编造解释。')
    ]
  });
  const repeatedInspectResponse = await runAgentCapability(
    repeatedInspectHost,
    v2Config(repeatedInspectModel)
  );
  assert(!repeatedInspectResponse.warnings.some((warning) => warning.includes('inspect_current_model:tool_budget_exceeded')),
    'RUN06共享Tool预算不得用旧的单Tool一次硬门拒绝第二次调用');
  assert(!repeatedInspectResponse.warnings.some((warning) => warning.includes('inspect_current_model:provider_error')),
    'Tool调用次数超限不得伪装成Provider故障');

  const duplicateInspectModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedToolCalls([toolCall('inspect-full-first', 'inspect_current_model', { detail: 'full' })]),
      generatedToolCalls([toolCall('inspect-full-duplicate', 'inspect_current_model', { detail: 'full' })]),
      generatedDirectAnswer('已基于同一份当前模型快照完成解释。')
    ]
  });
  let duplicateInspectBackendCalls = 0;
  const duplicateInspectResponse = await runAgentCapability(
    normalizedHost('解释当前完整模型。', 'req_v2_duplicate_current_model_read'),
    v2Config(duplicateInspectModel, {
      agentDependencies: {
        inspectCurrentModel: async () => {
          duplicateInspectBackendCalls += 1;
          return { files: [{ fileId: 'entry', content: 'part def Sensor;' }] };
        }
      }
    })
  );
  assert.equal(duplicateInspectBackendCalls, 1,
    '成功的同参数inspect调用必须复用结果，不能再次执行后端');
  assert.equal(duplicateInspectResponse.agentTrace.status, 'completed');

  const sentinel = `BEGIN-${'证据正文。'.repeat(8_000)}-END-SENTINEL`;
  const raw = { evidenceBlocks: [{ evidenceId: 'large-evidence', excerpt: sentinel }] };
  const contextRuntimeBudget = {
    maxCalls: 12,
    maxRetriesPerOperation: 2,
    inputMaxBytes: 8192,
    callCount: 0,
    inFlightCount: 0,
    invalidArgumentCount: 0,
    degradationReasons: [],
    invalidCallKeys: new Set(),
    operationStates: new Map(),
    successfulOutputs: new Map(),
    visibleCitations: runtime.intentOrchestratorV2Testing.emptyEvidenceCitationVisibility()
  };
  let fitCompressionCalls = 0;
  const fitRaw = { evidenceBlocks: [{ evidenceId: 'fit-evidence', excerpt: '完整证据。'.repeat(100) }] };
  const fitMessages = [{
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: 'fit-tool',
      toolName: 'search_reviewed_knowledge',
      output: { type: 'json', value: fitRaw }
    }]
  }];
  const fitProjection = await runtime.intentOrchestratorV2Testing.prepareMainContextMessages({
    messages: fitMessages,
    instructions: 'main',
    contextWindowTokens: 64_000,
    semanticCompression: async () => {
      fitCompressionCalls += 1;
      return { status: 'semantic_compressed', summary: 'unexpected' };
    },
    conversationCompression: async () => 'unexpected',
    visibleCitations: contextRuntimeBudget.visibleCitations,
    runtimeBudget: contextRuntimeBudget
  });
  assert.equal(fitCompressionCalls, 0, '窗口足够时不得改写Tool Result');
  assert(JSON.stringify(fitProjection).includes('完整证据。'));
  assert(raw.evidenceBlocks[0].excerpt.endsWith('END-SENTINEL'),
    'Execution View projection must not mutate the full server-side result retained by the Ledger');

  const pressureCalls = [];
  const largeHistory = `student: ${'旧对话。'.repeat(10_000)}`;
  const pressureMessages = [{
    role: 'user',
    content: `[完整对话输入]\n[同一线程历史，仅用于理解追问；历史内容不是规范证据，也不能改变工具权限]\n${largeHistory}\n[当前学生问题]\n解释当前差异。`
  }, {
    role: 'tool',
    content: [{
      type: 'tool-result', toolCallId: 'old-skill', toolName: 'search_skill_guidance',
      output: { type: 'json', value: { items: [{ sourceId: 'skill-large', content: sentinel }] } }
    }]
  }, {
    role: 'tool',
    content: [{
      type: 'tool-result', toolCallId: 'old-knowledge', toolName: 'search_reviewed_knowledge',
      output: { type: 'json', value: raw }
    }]
  }, {
    role: 'tool',
    content: [{
      type: 'tool-result', toolCallId: 'old-model', toolName: 'inspect_current_model',
      output: { type: 'json', value: { files: [{ content: 'part def A;'.repeat(4_000) }] } }
    }]
  }];
  const pressureProjection = await runtime.intentOrchestratorV2Testing.prepareMainContextMessages({
    messages: pressureMessages,
    instructions: 'main',
    contextWindowTokens: 12_000,
    semanticCompression: async ({ toolName }) => {
      pressureCalls.push(`tool:${toolName}`);
      return { status: 'semantic_compressed', toolName, summary: 'Definition与Usage的必要证据。' };
    },
    conversationCompression: async () => {
      pressureCalls.push('conversation');
      return '学生此前确认只解释当前差异。';
    },
    visibleCitations: contextRuntimeBudget.visibleCitations,
    runtimeBudget: contextRuntimeBudget
  });
  const pressureJson = JSON.stringify(pressureProjection);
  assert.deepEqual(pressureCalls, [
    'tool:search_skill_guidance',
    'tool:search_reviewed_knowledge',
    'conversation'
  ],
    '必须先压缩旧知识Tool Result，再压缩旧对话；inspect_current_model不得进入语义压缩');
  assert(pressureJson.includes('semantic_compressed'));
  assert(pressureJson.includes('context_window_pressure'));
  assert(pressureJson.includes('旧对话语义压缩'));
  assert(!pressureJson.includes('END-SENTINEL'));
  assert(!pressureJson.includes('[truncated:'), '统一上下文压缩不得恢复四级字符截断');

  const failedCompressionProjection = await runtime.intentOrchestratorV2Testing.prepareMainContextMessages({
    messages: pressureMessages,
    instructions: 'main',
    contextWindowTokens: 12_000,
    semanticCompression: async ({ toolName, value }) => ({
      status: 'available_but_omitted',
      toolName,
      reason: 'semantic_compression_provider_error',
      originalBytes: Buffer.byteLength(JSON.stringify(value), 'utf8')
    }),
    conversationCompression: async () => undefined,
    visibleCitations: contextRuntimeBudget.visibleCitations,
    runtimeBudget: contextRuntimeBudget
  });
  const failedCompressionJson = JSON.stringify(failedCompressionProjection);
  assert(failedCompressionJson.includes('semantic_compression_provider_error'));
  assert(failedCompressionJson.includes('旧对话因本次模型上下文容量未展开'));
  assert(!failedCompressionJson.includes('END-SENTINEL'),
    '压缩失败必须降级Execution View，不能重新关闭后续Tool或泄漏完整大结果');

  const projectionHost = normalizedHost(
    '解释 Definition 与 Usage。',
    'req_v2_sdk_tool_projection'
  );
  const projectionModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedToolCalls([toolCall('knowledge-projection', 'search_reviewed_knowledge', {
        query: 'Definition Usage relationship', limit: 5
      })]),
      generatedText('Usage可以由Definition定型。[source:evidence-definition-usage]'),
      generatedDirectAnswer('Definition 描述分类规则；Usage 描述上下文中的使用。')
    ]
  });
  const projectionOutput = completeKnowledgeOutput('Definition Usage relationship');
  const projectionSentinel = `BEGIN-${'evidence '.repeat(5_000)}-END-SENTINEL`;
  projectionOutput.evidenceBlocks[0].excerpt = projectionSentinel;
  projectionOutput.evidenceBlocks[0].textHash = hashContent(projectionSentinel);
  await runAgentCapability(projectionHost, v2Config(projectionModel, {
    agentContextWindowTokens: 20_000,
    agentDependencies: {
      searchReviewedKnowledge: async () => projectionOutput
    }
  }));
  const providerContinuation = JSON.stringify(projectionModel.doGenerateCalls.at(-1));
  assert(!providerContinuation.includes('END-SENTINEL'),
    'AI SDK Tool toModelOutput必须阻止完整大结果进入Provider续轮');
  assert(providerContinuation.includes('semantic_compressed'),
    '超限Reviewed Knowledge必须把AI SDK语义压缩结果交给Provider');
  assert(providerContinuation.includes('[source:evidence-definition-usage]'));
  assert(!providerContinuation.includes('[truncated:'),
    'AI SDK Tool toModelOutput不得恢复字符级截断');

  const invalidHost = normalizedHost('解释 Definition。', 'req_v2_invalid_read_tool');
  const invalidModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedToolCalls([
        toolCall('knowledge-invalid', 'search_reviewed_knowledge', { query: 'x', limit: 5 })
      ]),
      generatedDirectAnswer('Definition 描述可复用的类型；本次检索参数无效，因此只给出有边界的基础解释。')
    ]
  });
  let invalidKnowledgeCalls = 0;
  const invalidResponse = await runAgentCapability(invalidHost, v2Config(invalidModel, {
    agentDependencies: {
      searchReviewedKnowledge: async () => {
        invalidKnowledgeCalls += 1;
        return completeKnowledgeOutput('unused');
      }
    }
  }));
  assert.equal(invalidResponse.agentTrace.status, 'completed');
  assert.equal(invalidKnowledgeCalls, 0, 'invalid Tool input must be rejected before the dependency executes');
  assert(invalidResponse.warnings.includes('invalid_tool_arguments_rejected'));

  const timeoutHost = normalizedHost('比较 Definition 与 Usage。', 'req_v2_read_tool_timeout');
  const timeoutModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedToolCalls([
        toolCall('knowledge-timeout', 'search_reviewed_knowledge', {
          query: 'Definition Usage semantic boundary',
          limit: 5
        })
      ]),
      generatedDirectAnswer('检索本轮不可用；Definition 是可复用类型描述，Usage 是上下文中的使用。')
    ]
  });
  const timeoutStartedAt = Date.now();
  const timeoutResponse = await runAgentCapability(timeoutHost, v2Config(timeoutModel, {
    agentToolTimeoutMs: 20,
    agentDependencies: {
      searchReviewedKnowledge: async ({ abortSignal }) => await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(completeKnowledgeOutput('late tool result')), 300);
        abortSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(abortSignal.reason || new DOMException('Timed out', 'TimeoutError'));
        }, { once: true });
      })
    }
  }));
  assert(Date.now() - timeoutStartedAt < 1_000, 'AI SDK tool timeout must abort a cooperative dependency');
  assert.equal(timeoutResponse.agentTrace.status, 'completed');
  assert(timeoutResponse.warnings.some((warning) => warning.includes('search_reviewed_knowledge:timeout')));

  const retryHost = normalizedHost('解释一下当前模型。', 'req_v2_read_tool_retry_limit');
  const retryInput = { detail: 'full' };
  const retryModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedToolCalls([toolCall('inspect-failure-initial', 'inspect_current_model', retryInput)]),
      generatedToolCalls([toolCall('inspect-failure-retry-1', 'inspect_current_model', retryInput)]),
      generatedToolCalls([toolCall('inspect-failure-retry-2', 'inspect_current_model', retryInput)]),
      generatedToolCalls([toolCall('inspect-failure-blocked', 'inspect_current_model', retryInput)]),
      generatedDirectAnswer('当前模型读取暂时不可用，因此这一轮不编造模型正文。')
    ]
  });
  let retryBackendCalls = 0;
  const retryResponse = await runAgentCapability(retryHost, v2Config(retryModel, {
    agentReadOnlyToolMaxRetriesPerOperation: 2,
    agentDependencies: {
      inspectCurrentModel: async () => {
        retryBackendCalls += 1;
        throw new Error('provider unavailable');
      }
    }
  }));
  assert.equal(retryBackendCalls, 3,
    '同一语义操作只能执行首次调用和两次重试，第四次调用必须在后端前短路');
  assert.equal(retryResponse.agentTrace.status, 'completed',
    'Tool重试耗尽不得阻断Main使用已有上下文形成回答');
  assert(retryResponse.warnings.some((warning) => warning.includes('operation_retry_exhausted')));
  const retryProviderView = JSON.stringify(retryModel.doGenerateCalls);
  assert(retryProviderView.includes('"executionStatus":"failed"'));
  assert(retryProviderView.includes('"retriesRemaining":2'));
  assert(retryProviderView.includes('服务端只读Tool状态'),
    'AI SDK prepareStep必须把最新失败状态带入后续模型步骤');
  const postExhaustionTools = retryModel.doGenerateCalls[4]?.tools || [];
  assert(postExhaustionTools.some((candidate) => candidate.name === 'request_clarification'));
  assert(postExhaustionTools.some((candidate) => candidate.name === 'delegate_candidate'));
  assert(postExhaustionTools.some((candidate) => candidate.name === 'delegate_repair'),
    '单个只读操作重试耗尽不得关闭澄清、Candidate或Repair能力');

  const zeroRetryModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedToolCalls([toolCall('inspect-zero-initial', 'inspect_current_model', retryInput)]),
      generatedToolCalls([toolCall('inspect-zero-blocked', 'inspect_current_model', retryInput)]),
      generatedDirectAnswer('当前模型读取失败，本轮不编造正文。')
    ]
  });
  let zeroRetryBackendCalls = 0;
  await runAgentCapability(retryHost, v2Config(zeroRetryModel, {
    agentReadOnlyToolMaxRetriesPerOperation: 0,
    agentDependencies: {
      inspectCurrentModel: async () => {
        zeroRetryBackendCalls += 1;
        throw new Error('provider unavailable');
      }
    }
  }));
  assert.equal(zeroRetryBackendCalls, 1,
    'Admin配置0时首次失败后必须立即短路，不能被运行时默认值2覆盖');

  const persistenceHost = normalizedHost(
    '解释 Definition 与 Usage。',
    'req_v2_terminal_persistence_window'
  );
  const persistenceModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedToolCalls([toolCall('terminal-ledger-search', 'search_reviewed_knowledge', {
        query: 'Definition Usage relationship', limit: 5
      })]),
      generatedDirectAnswer('Definition 描述分类规则；Usage 描述上下文中的使用。')
    ]
  });
  let terminalLedgerPersisted = false;
  const persistenceResponse = await runAgentCapability(persistenceHost, v2Config(persistenceModel, {
    runId: 'run_v2_terminal_persistence_window',
    agentMaxDurationMs: 400,
    agentTerminalPersistenceTimeoutMs: 700,
    conversation: {
      recordToolLedgerEntry: async (entry) => {
        if (!entry.resultProjection) return;
        await new Promise((resolve) => setTimeout(resolve, 450));
        terminalLedgerPersisted = true;
      }
    },
    agentDependencies: {
      searchReviewedKnowledge: async ({ input }) => completeKnowledgeOutput(input.query)
    }
  }));
  assert.equal(terminalLedgerPersisted, true,
    '可信终态台账必须能使用Run结束后的短持久化窗口完成写入');
  assert(!persistenceResponse.warnings.includes('ledger_persistence_failed'));

  const recoveryHost = normalizedHost('比较 Definition 与 Usage。', 'req_v2_main_timeout_recovery');
  const recoveryGateModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedText('Definition 描述分类规则；Usage 是上下文中的特征。Usage 本身不是物理实例，其 value 才是被 Definition 分类的实例。')
    ]
  });
  let recoveryMainCalls = 0;
  const recoveryMainModel = new MockLanguageModelV4({
    doGenerate: async (options) => {
      recoveryMainCalls += 1;
      if (recoveryMainCalls === 1) {
        return generatedToolCalls([toolCall(
          'knowledge-before-timeout',
          'search_reviewed_knowledge',
          { query: 'Definition Usage value relationship', limit: 5 }
        )]);
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('step timeout signal was not delivered')), 1_000);
        options.abortSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(options.abortSignal.reason || new DOMException('Timed out', 'TimeoutError'));
        }, { once: true });
      });
      throw new Error('unreachable');
    }
  });
  const mainTimeoutResponse = await runAgentCapability(recoveryHost, v2Config(recoveryGateModel, {
    agentNonThinkingModel: recoveryGateModel,
    agentThinkingModel: recoveryMainModel,
    agentMaxDurationMs: 500,
    agentTerminalReserveMs: 200,
    agentDependencies: {
      searchReviewedKnowledge: async ({ input }) => completeKnowledgeOutput(input.query)
    }
  }));
  assert.equal(mainTimeoutResponse.__internal.agent.stopReason, 'timeout');
  assert.equal(mainTimeoutResponse.answerCompletionStatus, 'incomplete');
  assert.ok(mainTimeoutResponse.directAnswer, 'Run deadline must preserve a deterministic student-visible partial result');
  assert.equal(recoveryGateModel.doGenerateCalls.length, 1,
    'the Run work deadline must not start a second no-tool recovery model call');
  assert(!mainTimeoutResponse.__internal.agent.modelCalls?.some((call) => (
    call.phase === 'intent_orchestration_v2_recovery'
  )), 'the removed recovery phase must not reappear in the audit');

  const lifecycleModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedDirectAnswer('Definition 描述分类规则，Usage 描述上下文中的使用。')
    ]
  });
  const lifecycleStartedAt = Date.now();
  const lifecycleResponse = await runAgentCapability(
    normalizedHost('解释 Definition 与 Usage。', 'req_v2_lifecycle_deadline'),
    v2Config(lifecycleModel, {
      runId: 'run_v2_lifecycle_deadline',
      agentMaxDurationMs: 150,
      conversation: {
        recordRunEvent: async () => await new Promise((resolve) => {
          setTimeout(resolve, 300);
        })
      }
    })
  );
  assert(Date.now() - lifecycleStartedAt < 1_000,
    'a hanging run_finished persistence callback must not exceed the Run deadline');
  assert(lifecycleResponse.warnings.some((warning) => warning.startsWith('lifecycle_callback_')),
    'a bounded lifecycle failure must remain visible in internal warnings');
}

async function testMixedScopeBinding(MockLanguageModelV4) {
  const question = '解释当前模型中的 part usage，再帮我规划周末旅行🙂e\u0301。';
  const host = normalizedHost(question, 'req_v2_mixed');
  const model = new MockLanguageModelV4({
    doGenerate: [
      generatedText('RISK_MIXED'),
      generatedDirectAnswer('当前模型中的 `part usage` 是在此上下文使用某个部件定义的具体用法。旅行规划不属于本教学助手的处理范围。')
    ]
  });
  const response = await runAgentCapability(host, v2Config(model));
  const gate = response.__internal.agent.fastGatePassThroughV2;
  assert.equal(response.agentTrace.gateOutcome, 'mixed_scope_risk');
  assert.equal(response.agentTrace.scopeHintCount, 1);
  assert.equal(response.agentTrace.refusedHintCount, 0);
  assert.equal(response.__internal.agent.answerContract, undefined);
  assert.equal(gate.mixedScopeRisk, true);
  assert.equal(response.__internal.agent.mainAgentScopeResolution.status, 'forwarded_to_main');
  assert.equal(response.agentTrace.requestPlan, undefined);
  assert.equal(response.agentTrace.fastGateProjectionHash, undefined);
}

async function testRejectRequiresTwoIndependentCalls(MockLanguageModelV4) {
  const host = normalizedHost('给我推荐周末旅行路线。', 'req_v2_reject');
  const model = new MockLanguageModelV4({
    doGenerate: (options) => {
      if (model.doGenerateCalls.length === 1) {
        return generatedText('RISK_FULL');
      }
      return generatedText('RISK_FULL');
    }
  });
  const response = await runAgentCapability(host, v2Config(model));
  assert.equal(response.agentTrace.status, 'rejected');
  assert.equal(response.agentTrace.gateOutcome, 'reject');
  assert.equal(response.agentTrace.gateCallCount, 2);
  assert.equal(response.answerCompletionStatus, 'not_required');
  assert.equal(response.answerContractHash, undefined);
  assert(!response.directAnswer.startsWith('根据你的描述和当前草稿整体来看'),
    'a V2 Gate rejection must not inherit the V1 grounding disclosure');
  assert(!response.warnings.includes('grounding_scope_disclosed'),
    'a V2 Gate rejection must suppress the V1 grounding warning');
  assert.equal(model.doGenerateCalls.length, 2, 'a rejected request must not enter the Main Agent');
}

async function testGateFailuresOpen(MockLanguageModelV4) {
  const host = normalizedHost('解释 requirement definition。', 'req_v2_gate_failure');
  let callCount = 0;
  const model = new MockLanguageModelV4({
    doGenerate: () => {
      callCount += 1;
      if (callCount === 1) throw new Error('scope provider unavailable');
      return generatedDirectAnswer('Requirement Definition 描述可复用的需求类型。');
    }
  });
  const response = await runAgentCapability(host, v2Config(model));
  assert.equal(response.agentTrace.status, 'completed');
  assert.equal(response.agentTrace.gateOutcome, 'pass');
  assert.equal(response.agentTrace.gateCallCount, 1);
  assert(response.warnings.some((warning) => warning.startsWith('intent_v2_gate_fallback:')));

  const invalidRangeHost = normalizedHost('解释 action usage。', 'req_v2_invalid_range');
  const invalidRangeModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('pass'),
      generatedDirectAnswer('Action Usage 表示动作在上下文中的使用。')
    ]
  });
  const invalidRange = await runAgentCapability(invalidRangeHost, v2Config(invalidRangeModel));
  assert.equal(invalidRange.agentTrace.status, 'completed');
  assert.equal(invalidRange.agentTrace.gateOutcome, 'pass');
  assert.equal(invalidRange.agentTrace.scopeHintCount, 0);
  assert.equal(invalidRange.agentTrace.gateDecisionStatus, 'incomplete');
  assert(invalidRange.warnings.includes('intent_v2_gate_fallback:unrecognized_output'));

  const invalidSchemaHost = normalizedHost('解释 port definition。', 'req_v2_invalid_schema');
  const invalidSchemaModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS，因为这是范围内问题。'),
      generatedDirectAnswer('Port Definition 描述可复用的端口类型。')
    ]
  });
  const invalidSchema = await runAgentCapability(invalidSchemaHost, v2Config(invalidSchemaModel));
  assert.equal(invalidSchema.agentTrace.status, 'completed');
  assert.equal(invalidSchema.agentTrace.gateOutcome, 'pass');
  assert(invalidSchema.warnings.some((warning) => warning.startsWith('intent_v2_gate_fallback:')),
    'unrecognized Gate text must fail open');

  const timeoutHost = normalizedHost('解释 item usage。', 'req_v2_gate_timeout');
  let timeoutCalls = 0;
  const timeoutModel = new MockLanguageModelV4({
    doGenerate: async (options) => {
      timeoutCalls += 1;
      if (timeoutCalls === 1) {
        await new Promise((resolve, reject) => {
          if (options.abortSignal?.aborted) return reject(options.abortSignal.reason);
          const keepAlive = setTimeout(() => reject(new Error('timeout signal not delivered')), 1_000);
          options.abortSignal?.addEventListener('abort', () => {
            clearTimeout(keepAlive);
            reject(options.abortSignal.reason || new DOMException('Timed out', 'TimeoutError'));
          }, { once: true });
        });
      }
      return generatedDirectAnswer('Item Usage 表示项目在具体上下文中的使用。');
    }
  });
  const timeout = await runAgentCapability(timeoutHost, v2Config(timeoutModel, {
    agentScopeGateInitialTimeoutMs: 20
  }));
  assert.equal(timeout.agentTrace.status, 'completed');
  assert.equal(timeout.agentTrace.gateOutcome, 'pass');
  assert(timeout.warnings.includes('intent_v2_gate_fallback:timeout'));

  const reviewTimeoutHost = normalizedHost('给我推荐周末旅行路线。', 'req_v2_gate_review_timeout');
  let reviewTimeoutCalls = 0;
  const reviewTimeoutModel = new MockLanguageModelV4({
    doGenerate: async (options) => {
      reviewTimeoutCalls += 1;
      if (reviewTimeoutCalls === 1) return generatedText('RISK_FULL');
      if (reviewTimeoutCalls === 2) {
        await new Promise((resolve, reject) => {
          if (options.abortSignal?.aborted) return reject(options.abortSignal.reason);
          const keepAlive = setTimeout(() => reject(new Error('review timeout signal not delivered')), 1_000);
          options.abortSignal?.addEventListener('abort', () => {
            clearTimeout(keepAlive);
            reject(options.abortSignal.reason || new DOMException('Timed out', 'TimeoutError'));
          }, { once: true });
        });
      }
      return generatedDirectAnswer('这个请求不属于SysML v2课程范围，但范围门禁复核未完成，因此按失败放行策略继续处理。');
    }
  });
  const reviewTimeout = await runAgentCapability(reviewTimeoutHost, v2Config(reviewTimeoutModel, {
    agentScopeGateReviewTimeoutMs: 20
  }));
  assert.equal(reviewTimeout.agentTrace.status, 'completed');
  assert.equal(reviewTimeout.agentTrace.gateOutcome, 'pass');
  assert.equal(reviewTimeout.agentTrace.gateDecisionStatus, 'incomplete');
  assert(reviewTimeout.warnings.includes('intent_v2_gate_fallback:review_timeout'));

  const longHost = normalizedHost(`解释 requirement usage。${'边界内容'.repeat(600)}`, 'req_v2_gate_budget');
  const longModel = new MockLanguageModelV4({
    doGenerate: [generatedDirectAnswer('这是一个较长但仍在范围内的问题；Gate已跳过，我只给出有边界的解释。')]
  });
  const longResponse = await runAgentCapability(longHost, v2Config(longModel, {
    agentScopeGateHardInputTokenBudget: 2048
  }));
  assert.equal(longResponse.agentTrace.status, 'completed');
  assert.equal(longResponse.agentTrace.gateCallCount, 0);
  assert(longResponse.warnings.includes('intent_v2_gate_fallback:input_budget_exceeded'));

  const boundedInputHost = normalizedHost(`解释 requirement usage。${'边'.repeat(600)}`, 'req_v2_gate_token_budget');
  const boundedInputModel = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedDirectAnswer('这是一个仍处于2048 Token筛选预算内的中文问题。')
    ]
  });
  const boundedInputResponse = await runAgentCapability(boundedInputHost, v2Config(boundedInputModel, {
    agentScopeGateHardInputTokenBudget: 2048
  }));
  assert.equal(boundedInputResponse.agentTrace.gateCallCount, 1,
    'the Gate hard input budget is measured in conservative Tokens, not raw UTF-8 bytes');
}

async function testPublicTraceContract(MockLanguageModelV4) {
  const model = new MockLanguageModelV4({
    doGenerate: [
      generatedText('PASS'),
      generatedDirectAnswer('Definition 描述类型，Usage 表示上下文中的使用。')
    ]
  });
  const conversation = createMemoryConversationStore();
  const server = createServer({
    providerMode: 'mock',
    model: 'mock-intent-v2',
    providerEnabled: true,
    internalToken: process.env.AI_TEACHER_INTERNAL_TOKEN,
    toolToken: process.env.AI_TEACHER_TOOL_TOKEN,
    agentModel: model,
    feedbackModel: model,
    agentScopeGateEnabled: true,
    conversation,
    knowledge: emptyKnowledge(),
    skillSource: emptySkillSource()
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const capabilities = await getJson(`${baseUrl}/v1/capabilities`);
    assert.equal(capabilities.status, 200);
    const payload = normalizedHost('比较 Definition 与 Usage。', 'req_v2_public');
    payload.runtimeAssignment = {
      runtimeAssignmentId: 'assign_v2_public',
      runtime: 'ai-sdk',
      workflowVersion: 'intent-orchestrator-v2',
      policyVersion: 'single-entry-v1',
      bucket: 1,
      assignedAt: new Date().toISOString(),
      toolSchemaVersion: capabilities.body.toolSchemaVersion,
      buildVersion: capabilities.body.buildVersion
    };
    const response = await postJson(`${baseUrl}/v1/teacher/answer`, payload);
    assert.equal(response.status, 200, JSON.stringify(response.body, null, 2));
    assert.equal(response.body.agentTrace.workflowVersion, 'intent-orchestrator-v2');
    assert.equal(response.body.workflowVersion, 'intent-orchestrator-v2');
    assert.equal(response.body.promptVersion, 'intent-orchestrator-v2-review-advice-v27');
    assert.equal(response.body.__internal, undefined);
    assert.deepEqual(Object.keys(response.body.agentTrace).sort(), [
      'candidateValidated',
      'gateCallCount',
      'gateDecisionStatus',
      'gateOutcome',
      'phaseTimings',
      'refusedHintCount',
      'scopeHintCount',
      'status',
      'stepCount',
      'stopReason',
      'workerType',
      'workflowVersion'
    ].sort());
    const serializedTrace = JSON.stringify(response.body.agentTrace);
    for (const forbidden of ['requestPlan', 'fastGateProjection', 'plannerTrace', 'argsHash', 'ledger']) {
      assert(!serializedTrace.includes(forbidden), `V2 public trace must not expose ${forbidden}`);
    }
    const malicious = clone(response.body);
    malicious.agentTrace.requestPlan = { taskGoal: 'forged' };
    const maliciousContract = validateTeacherCapabilityResponse(malicious, payload);
    assert.equal(maliciousContract.ok, false);
    assert(maliciousContract.errors.some((error) => error.includes('requestPlan')),
      'the public contract must reject V1/internal fields injected into a V2 trace');
    const deadlineResponse = clone(response.body);
    deadlineResponse.agentTrace.stopReason = 'timeout';
    deadlineResponse.agentTrace.stopCause = 'work_deadline_reached';
    assert.equal(validateTeacherCapabilityResponse(deadlineResponse, payload).ok, true,
      'V2 public contract must accept the bounded Run stop cause');
    deadlineResponse.agentTrace.stopReason = 'validator_queue_full';
    assert.equal(validateTeacherCapabilityResponse(deadlineResponse, payload).ok, true,
      'V2 public contract must accept bounded Validator resource terminal states');
    deadlineResponse.agentTrace.stopCause = 'provider_queue_guess';
    assert.equal(validateTeacherCapabilityResponse(deadlineResponse, payload).ok, false,
      'V2 public contract must reject unknown Run stop causes');
    const run = [...conversation.state.runs.values()][0];
    assert.equal(run.providerMeta.agent.workflowVersion, 'intent-orchestrator-v2');
    assert.equal(run.providerMeta.agent.answerContract, undefined);
    assert.equal(run.providerMeta.agent.fastGateProjection, undefined);
    const modelCallLedger = await conversation.listModelCallLedgerEntries(run.runId);
    assert.equal(modelCallLedger.length, 3,
      'Fast Gate、Main Agent和FinalAnswerWorker响应必须各有一条内部审计记录');
    assert.deepEqual(modelCallLedger.map((entry) => entry.phase),
      ['scope_gate_v2', 'intent_orchestration_v2', 'answer_generation']);
    assert.equal(modelCallLedger[0].outputPayload.visibleText, 'PASS');
    assert.equal(modelCallLedger[1].outputPayload.visibleText, 'Definition 描述类型，Usage 表示上下文中的使用。');
    assert.equal(modelCallLedger[1].outputPayload.toolCalls[0]?.toolName, 'request_final_answer',
      'the Main audit must bind Direct completion to the accepted typed action');
    assert.equal(modelCallLedger[2].promptVersion, 'final-answer-worker-v16-identifier-advice');
    assert(!JSON.stringify(response.body).includes('modelCallLedger'),
      'the internal model call ledger must not be exposed in the public response');
    const auditQuery = new URLSearchParams({
      requestId: payload.requestId,
      tenantId: payload.tenant.tenantId,
      userId: payload.tenant.userId,
      coursePackId: payload.course.coursePackId,
      courseId: payload.course.courseId,
      lessonId: payload.course.lessonId
    });
    const auditUrl = `${baseUrl}/v1/teacher/runs/${encodeURIComponent(response.body.runId)}/intent-audit?${auditQuery}`;
    const unauthorizedAudit = await fetch(auditUrl);
    assert.equal(unauthorizedAudit.status, 401,
      'the Main Agent intent audit must require the internal service token');
    const audit = await getJson(auditUrl);
    assert.equal(audit.status, 200);
    assert.equal(audit.body.runId, response.body.runId);
    assert.equal(audit.body.audit.workflowVersion, 'intent-orchestrator-v2');
    assert.equal(audit.body.audit.receivedQuestionHash,
      `sha256:${crypto.createHash('sha256').update(JSON.stringify(payload.question.text)).digest('hex')}`,
      'the internal audit must bind the exact UTF-8 student question even when later phases fail');
    assert.equal(audit.body.audit.mainAgentIntent, null,
      'the retired structured intent capture must remain absent');
    assert.equal(audit.body.audit.mainAgentDelegation, null,
      'direct answers must not create a side-effect delegation');
    const serializedAudit = JSON.stringify(audit.body);
    assert(!serializedAudit.includes('providerMeta'), 'the audit must expose a bounded projection, not raw provider metadata');
    const toolAuditUrl = `${baseUrl}/v1/teacher/runs/${encodeURIComponent(response.body.runId)}/tool-audit?${auditQuery}`;
    const unauthorizedToolAudit = await fetch(toolAuditUrl);
    assert.equal(unauthorizedToolAudit.status, 401,
      'the complete Tool audit must require the internal service token');
    const toolAudit = await getJson(toolAuditUrl);
    assert.equal(toolAudit.status, 200);
    assert.equal(toolAudit.body.runId, response.body.runId);
    assert.equal(toolAudit.body.entryCount, 0,
      'the action identity belongs to the Model Call audit and must not be duplicated into the business Tool ledger');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function testPublicNarrationProjectionThroughServer(MockLanguageModelV4) {
  const cases = [
    {
      requestId: 'req_v2_public_runtime_field',
      question: '解释一个内部字段泄漏防护样例。',
      modelAnswer: 'The server emitted runtimeAssignmentId assign_v2_public.',
      finalizerAnswer: '这个样例说明：内部运行字段不属于学生答案，最终说明只应保留可公开的业务结论。',
      expectedAnswer: '这个样例说明：内部运行字段不属于学生答案，最终说明只应保留可公开的业务结论。',
      stream: false
    },
    {
      requestId: 'req_v2_public_legitimate_terms',
      question: '解释下面两句领域描述。',
      modelAnswer: '内部路由决定数据包路径。Agent 表示系统中的自主参与者。\n\n知识检索完成后返回候选文档。\n\nThis request is ready for stakeholder review.\n\nThe Tool call returns a structured result used by the API.',
      finalizerAnswer: '内部路由决定数据包路径。Agent 表示系统中的自主参与者。\n\n知识检索完成后返回候选文档。\n\nThis request is ready for stakeholder review.\n\nThe Tool call returns a structured result used by the API.',
      expectedAnswer: '内部路由决定数据包路径。Agent 表示系统中的自主参与者。\n\n知识检索完成后返回候选文档。\n\nThis request is ready for stakeholder review.\n\nThe Tool call returns a structured result used by the API.',
      forbiddenWarnings: [
        'internal_orchestration_narration_suppressed',
        'internal_process_preamble_removed'
      ],
      stream: false
    },
    {
      requestId: 'req_v2_public_process_preamble',
      question: '解释 Definition 与 Usage。',
      modelAnswer: '证据充分，现在直接回答。\n\nDefinition 描述类型，Usage 描述上下文中的使用。',
      finalizerAnswer: 'Definition 描述类型，Usage 描述上下文中的使用。',
      expectedAnswer: 'Definition 描述类型，Usage 描述上下文中的使用。',
      forbiddenWarnings: ['internal_process_preamble_removed'],
      stream: false
    },
    {
      requestId: 'req_v2_public_stream_tool_narration',
      question: '解释 Tool 过程旁白为什么不应展示。',
      modelAnswer: 'This request is ready. The Tool call completed successfully.',
      finalizerAnswer: '工具执行过程不应作为最终回答展示；最终说明只保留与学生问题相关的结果。',
      expectedAnswer: '工具执行过程不应作为最终回答展示；最终说明只保留与学生问题相关的结果。',
      stream: true
    },
    {
      requestId: 'req_v2_public_failed_tool_narration',
      question: '解释失败状态旁白为何不应展示。',
      modelAnswer: 'This request failed. A Tool call failed.',
      finalizerAnswer: '失败过程的内部旁白不应公开；面向学生只需说明可信的失败边界和可执行下一步。',
      expectedAnswer: '失败过程的内部旁白不应公开；面向学生只需说明可信的失败边界和可执行下一步。',
      stream: false
    },
    {
      requestId: 'req_v2_public_source_marker',
      question: '解释来源标记为何不应直接显示。',
      modelAnswer: '来源标记由服务端绑定。 [source:claim_public_projection]',
      finalizerAnswer: '来源标记由服务端绑定。 [source:claim_public_projection]',
      expectedAnswer: '来源标记由服务端绑定。',
      stream: false
    },
    {
      requestId: 'req_v2_final_answer_protocol_leak',
      question: '解释最终回答边界。',
      modelAnswer: '最终回答应只包含面向学生的内容。',
      finalizerAnswer: '我将调用 delegate_candidate 继续处理。',
      expectedAnswer: '本轮已经完成问题分析，但最终说明生成失败。为避免把内部处理过程当作正式答案返回，本次没有直接展示内部草稿；请重新提交本轮问题。',
      expectedWarningPrefix: 'final_answer_worker_fallback:',
      expectedIncompleteTerminal: true,
      stream: false
    },
    {
      requestId: 'req_v2_direct_false_execution_claim',
      question: '只读解释当前模型，不要修改。',
      modelAnswer: '当前模型中的定义与用法应分别理解。',
      finalizerAnswer: '我已经修改当前模型，并且本轮已通过 Official Validator。',
      expectedDirectConflict: true,
      expectedWarning: 'direct_teaching_execution_claim_discarded',
      stream: false
    },
    {
      requestId: 'req_v2_direct_false_execution_claim_passive_zh',
      question: '只读解释模型结构。',
      modelAnswer: '只做结构解释。',
      finalizerAnswer: '模型修改完成并通过 Official Validator。',
      expectedDirectConflict: true,
      expectedWarning: 'direct_teaching_execution_claim_discarded',
      stream: false
    },
    {
      requestId: 'req_v2_direct_false_execution_claim_passive_en',
      question: 'Explain the model without changing it.',
      modelAnswer: 'This is a read-only explanation.',
      finalizerAnswer: 'The model was modified and passed Validator.',
      expectedDirectConflict: true,
      expectedWarning: 'direct_teaching_execution_claim_discarded',
      stream: false
    },
    {
      requestId: 'req_v2_direct_negative_execution_statement',
      question: '说明本轮为什么没有候选。',
      modelAnswer: '本轮没有修改。',
      finalizerAnswer: '本轮没有成功修改模型，因此没有候选。',
      expectedAnswer: '本轮没有成功修改模型，因此没有候选。',
      forbiddenWarnings: ['direct_teaching_execution_claim_discarded'],
      stream: false
    },
    {
      requestId: 'req_v2_direct_domain_generation_statement',
      question: '解释能源系统。',
      modelAnswer: '解释能源流。',
      finalizerAnswer: '系统成功生成电能并输送到负载。',
      expectedAnswer: '系统成功生成电能并输送到负载。',
      forbiddenWarnings: ['direct_teaching_execution_claim_discarded'],
      stream: false
    },
    {
      requestId: 'req_v2_direct_historical_model_statement',
      question: '解释已有信号。',
      modelAnswer: '解释已有结构。',
      finalizerAnswer: '我们说明系统已生成的信号如何流动。',
      expectedAnswer: '我们说明系统已生成的信号如何流动。',
      forbiddenWarnings: ['direct_teaching_execution_claim_discarded'],
      stream: false
    }
  ];
  const model = new MockLanguageModelV4({
    doGenerate: cases.flatMap((item) => [
      generatedText('PASS'),
      generatedDirectAnswer(item.modelAnswer)
    ])
  });
  const finalizerModel = new MockLanguageModelV4({
    doGenerate: cases.map((item) => generatedText(item.finalizerAnswer))
  });
  const conversation = createMemoryConversationStore();
  const server = createServer({
    providerMode: 'mock',
    model: 'mock-intent-v2-public-projection',
    providerEnabled: true,
    internalToken: process.env.AI_TEACHER_INTERNAL_TOKEN,
    toolToken: process.env.AI_TEACHER_TOOL_TOKEN,
    agentModel: model,
    feedbackModel: model,
    agentStageModels: { finalizer: finalizerModel },
    agentScopeGateEnabled: true,
    conversation,
    knowledge: emptyKnowledge(),
    skillSource: emptySkillSource()
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const capabilities = await getJson(`${baseUrl}/v1/capabilities`);
    assert.equal(capabilities.status, 200);
    for (const item of cases) {
      const payload = normalizedHost(item.question, item.requestId);
      payload.runtimeAssignment = {
        runtimeAssignmentId: `assign_${item.requestId}`,
        runtime: 'ai-sdk',
        workflowVersion: 'intent-orchestrator-v2',
        policyVersion: 'single-entry-v1',
        bucket: 1,
        assignedAt: new Date().toISOString(),
        toolSchemaVersion: capabilities.body.toolSchemaVersion,
        buildVersion: capabilities.body.buildVersion
      };
      let final;
      if (item.stream) {
        const streamed = await postNdjson(`${baseUrl}/v1/teacher/answer-stream`, payload);
        assert.equal(streamed.status, 200);
        assert(item.modelAnswer === item.expectedAnswer || !JSON.stringify(streamed.events).includes(item.modelAnswer),
          'no NDJSON event may expose the raw Provider process narration');
        const finalEvents = streamed.events.filter((event) => event.type === 'final');
        assert.equal(finalEvents.length, 1, 'the V2 stream must emit exactly one final event');
        final = finalEvents[0];
        assert(final, 'the real V2 stream route must emit a final event');
      } else {
        const response = await postJson(`${baseUrl}/v1/teacher/answer`, payload);
        assert.equal(response.status, 200, JSON.stringify(response.body, null, 2));
        final = response.body;
      }
      assert.equal(final.workflowVersion, 'intent-orchestrator-v2');
      const expectedPublicAnswer = item.expectedIncompleteTerminal
        ? item.expectedAnswer
        : item.expectedDirectConflict
          ? '当前回答仅提供教学解释，没有生成、验证或应用新的模型候选。'
          : expectedDirectTerminalAnswer(item.expectedAnswer);
      assert.equal(final.directAnswer, expectedPublicAnswer);
      if (item.expectedWarning) assert(final.warnings.includes(item.expectedWarning));
      if (item.expectedWarningPrefix) {
        assert(final.warnings.some((warning) => warning.startsWith(item.expectedWarningPrefix)));
      }
      for (const warning of item.forbiddenWarnings || []) {
        assert(!final.warnings.includes(warning), `legitimate answer must not receive ${warning}`);
      }
      const messages = await conversation.listMessages(payload.threadId, { limit: 10 });
      const assistant = messages.find((message) => message.role === 'assistant');
      assert(assistant, 'the projected V2 answer must be persisted as an assistant message');
      assert.equal(assistant.content, expectedPublicAnswer,
        'conversation history must persist the projected answer, not raw Provider narration');
      assert.equal(assistant.response.directAnswer, expectedPublicAnswer);
    }
    assert.equal(finalizerModel.doGenerateCalls.length, cases.length,
      '每个Direct Run必须由独立FinalAnswerWorker执行一次终末生成');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
  }
}

function emptyKnowledge() {
  return {
    search: async () => [],
    debug: async () => ({ hits: [] }),
    status: async () => ({
      mode: 'postgres_pgvector',
      ready: true,
      cardCount: 0,
      activeBundle: {
        bundleId: 'bundle_intent_v2',
        baselineId: 'sysml20-model-user',
        version: 'v003',
        sourceRegistryHash: `sha256:${'1'.repeat(64)}`,
        contentHash: `sha256:${'2'.repeat(64)}`
      }
    })
  };
}

function emptySkillSource() {
  return { search: async () => [], status: () => ({ ready: true }) };
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { 'x-ai-teacher-token': process.env.AI_TEACHER_INTERNAL_TOKEN }
  });
  return { status: response.status, body: await response.json() };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ai-teacher-token': process.env.AI_TEACHER_INTERNAL_TOKEN
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function postNdjson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ai-teacher-token': process.env.AI_TEACHER_INTERNAL_TOKEN
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    events: text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
  };
}

async function main() {
  const { MockLanguageModelV4 } = await import('ai/test');
  const runtime = await import('../apps/teacher/dist/agent/index.mjs');
  assert.equal(runtime.INTENT_ORCHESTRATOR_V2_PROMPT_VERSION,
    'intent-orchestrator-v2-review-advice-v27');
  assert(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS.includes('GeneralView、InterconnectionView、ActionFlowView、StateTransitionView、SequenceView'));
  assert(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS.includes('GeometryView、GridView、BrowserView'));
  assert(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS.includes('这8种都可以在SysML v2模型中使用'));
  assert(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS.includes('SysML v1已有View/Viewpoint建模能力')
    && runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS.includes('禁止声称v1图表/视图种类是固定枚举'),
  'Main必须携带已核对的v1 View/Viewpoint事实边界，不能只依赖Finalizer纠正错误草稿');
  assert(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS.includes('继续、修改、补全或变换默认是累计修改')
    && runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS.includes('不得自行把“增加InterconnectionView”改写成“将SequenceView改为InterconnectionView”'),
  'Main必须把未明确替换的变换型追问解释为累计修改');
  assert(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS.includes('默认使用当前用户请求所使用的自然语言')
    && runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS.includes('英文提问用英文回答')
    && runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS.includes('只有用户明确要求翻译成中文、改用中文或指定其他回答语言时')
    && runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS.includes('不得向学生解释“问题使用了哪种语言、所以应使用哪种语言回答”'),
  'Main必须在意图判读时确定回答语言，不能默认把外文请求改答成中文');

  const finalAnswerSource = require('fs').readFileSync(
    require.resolve('../apps/teacher/agent/final-answer-worker.mts'), 'utf8'
  );
  assert(finalAnswerSource.includes('SysML v2的具体语法同时包含文本和图形表示')
    && finalAnswerSource.includes('不得声称v1图表或视图种类“固定枚举”'),
  'Finalizer必须明确保留v2双具体语法和v1 View/Viewpoint扩展能力');
  assert(finalAnswerSource.includes('整份公开回答必须使用当前学生请求的自然语言')
    && finalAnswerSource.includes('不得因为System Instructions、历史消息或input.source.mainDraft使用中文')
    && finalAnswerSource.includes('不得在正文讨论学生使用了哪种语言'),
  'Finalizer必须独立保持当前请求语言，不能被中文系统提示或历史消息污染');
  const candidateHandlerSource = require('fs').readFileSync(
    require.resolve('../apps/teacher/agent/production-worker-handlers.mts'), 'utf8'
  );
  assert(candidateHandlerSource.includes('裸声明\\`port p;\\`不满足')
    && candidateHandlerSource.includes('\\`port p : P;\\`')
    && candidateHandlerSource.includes('新增InterconnectionView不等于替换GeneralView')
    && candidateHandlerSource.includes('TASK_DIRECTIVE_EXECUTION_GUIDANCE,'),
  'Candidate必须把typed port和累计View保留边界写入所有mode的执行提示');
  assert(!runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS.includes('终末回答职责'),
    '面向学生的渲染边界披露职责只能由FinalAnswerWorker承担');
  assert.deepEqual(runtime.intentOrchestratorV2Testing.fastGateResourcePolicy, {
    hardInputTokenBudget: 4096,
    firstOutputTokens: 500,
    reviewOutputTokens: 500,
    maxRetries: 0,
    failureBehavior: 'fail_open'
  });
  assert.equal(runtime.DEFAULT_AGENT_POLICY.scopeGateInitialTimeoutMs, 10000);
  assert.equal(runtime.DEFAULT_AGENT_POLICY.scopeGateReviewTimeoutMs, 18000);
  assert.equal(runtime.DEFAULT_AGENT_POLICY.convergeLeadMs, 90000);
  assert.doesNotThrow(() => runtime.agentPolicySchema.parse({
    ...runtime.DEFAULT_AGENT_POLICY,
    engineeringRevisionValidationRepairReserveMs: 50_000
  }), 'A valid Run-level Validator projection must not be rejected by a retired 60-second phase gate.');
  assert.throws(() => runtime.agentPolicySchema.parse({
    ...runtime.DEFAULT_AGENT_POLICY,
    engineeringRevisionValidationRepairReserveMs: 0
  }), 'The derived Validator projection must remain a positive duration.');
  const repairTimeoutError = agentOutcomeErrorForTests({
    response: { stopReason: 'repair_step_timeout', warnings: [], usage: {} }
  });
  assert.equal(repairTimeoutError.code, 'AI_TEACHER_REPAIR_STEP_TIMEOUT');
  assert.equal(repairTimeoutError.statusCode, 504);
  assert.match(runtime.intentOrchestratorV2Testing.fastGateReviewInstructions,
    /必须只输出一个信号/u);
  assert.match(runtime.intentOrchestratorV2Testing.fastGateReviewInstructions,
    /PASS、RISK_MIXED 或 RISK_FULL/u);
  assert.match(runtime.intentOrchestratorV2Testing.fastGateReviewInstructions,
    /禁止复述问题、展示分析过程、解释理由或回答学生问题/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /不得把它弱化为单个当前值/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /工具、Case或模型声明本身不是证据记录/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /不得提及“Skill”/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /Usage—value—Definition三层/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /Usage value才对应具体对象/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /实际value的身份、属性值与运行态均未知/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /不得遗漏嵌套Usage/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /不要把`:>`统一读成继承或specializes/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /不要写“证据已经充分”/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /不得读取任何模型/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /Worker不得二次判断或读取未选中的当前编辑器/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /last_validated_candidate读取同线程上一轮已验证Candidate/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /不得声称Usage Subsetting“不能添加新features”/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /subsetting adds，redefinition replaces locally/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /不得声称satisfy之后必须由Verification Case/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /ConstraintDefinition可以有零个或多个显式的in参数/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /candidateKnowledgePatterns只是可选的完整知识视角/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /后续同一Tool调用中提交selectedPatternIds/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /不得用“使用实例位置”/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /表达Feature direction，不决定Feature种类/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /正文不得提及.*Worker.*Run.*路由.*handoff/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /必须调用相应最小委派Tool/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /不熟悉、不确定、可能随时间变化/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /当前受审核知识与上下文不足时/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /不得以任何具体领域、产品名称或关键词名单作为触发门禁/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS,
    /必须区分“学生明确要求最小静态结构\/骨架”与一般的“搭建\/生成某系统模型”/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS,
    /至少包含系统边界、主要子系统、一个有类型的接口\/连接链、一个代表性行为或工况/u);
  assert.match(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS,
    /blockingClarificationAllowed=false.*不得重复询问已回答内容/u);
  assert.equal(runtime.intentOrchestratorV2Testing.hasUnexecutedMainActionNarration({
    text: '我应该调用delegate_candidate，mode=refine。',
    toolCalls: [{ toolName: 'inspect_current_model' }],
    steps: [
      { toolCalls: [{ toolName: 'inspect_current_model' }] },
      { toolCalls: [] }
    ]
  }), true, 'an earlier read-only Tool call must not hide a missing structured action in the final Main step');
  assert.equal(runtime.intentOrchestratorV2Testing.hasUnexecutedMainActionNarration({
    text: '将由Candidate Worker生成候选。',
    toolCalls: [{ toolName: 'delegate_candidate' }],
    toolResults: [{
      toolName: 'delegate_candidate',
      output: { accepted: true, action: 'candidate', mode: 'create', subject: 'current_workspace', acceptedToolCallId: 'accepted-candidate' }
    }],
    steps: [{
      toolCalls: [{ toolName: 'delegate_candidate' }],
      toolResults: [{
        toolName: 'delegate_candidate',
        output: { accepted: true, action: 'candidate', mode: 'create', subject: 'current_workspace', acceptedToolCallId: 'accepted-candidate' }
      }]
    }]
  }), false, 'a real final-step Tool call must not be classified as missing');
  assert.equal(runtime.intentOrchestratorV2Testing.mainNarrationFailure({
    text: '我应该调用候选生成工具，模式为创建。',
    toolCalls: [{ toolName: 'inspect_current_model' }],
    steps: [{ toolCalls: [{ toolName: 'inspect_current_model' }] }]
  }), 'structured_tool_call_missing',
  '只读Tool Call不能代替中文同义叙述中要执行的候选生成动作');
  assert.equal(runtime.intentOrchestratorV2Testing.mainNarrationFailure({
    text: '学生说“动力与供电系统，就按这个来”。我认为这里不需要新的委派，我应该确认，我直接确认即可。',
    toolCalls: [],
    steps: [{ toolCalls: [] }]
  }), 'internal_orchestration_narration',
  '无Tool的内部决策链必须记录成独立的Main失败原因');
  assert.equal(runtime.intentOrchestratorV2Testing.mainNarrationFailure({
    text: '当前模型文件存在且无诊断问题。学生确认“动力与供电系统，就按这个来”，即沿用现有模型。模型已经建立并验证，无需新的委派。\n\n直接确认即可。',
    toolCalls: [],
    toolResults: [],
    steps: [{ toolCalls: [], toolResults: [] }]
  }), 'internal_orchestration_narration',
  'Runner6简短内部决策变体必须进入同Run纠正而不是直接交付');
  assert.equal(runtime.intentOrchestratorV2Testing.mainNarrationFailure({
    text: '学生说“动力与供电系统，就按这个来”。这是一个建模请求，我应该委派candidate，mode为refine。',
    toolCalls: [],
    steps: [{ toolCalls: [] }]
  }), 'structured_tool_call_missing',
  'Runner6暴露的中英混写candidate/refine必须识别为未执行的候选动作');
  assert.equal(runtime.intentOrchestratorV2Testing.mainNarrationFailure({
    text: '将由Candidate Worker生成候选。',
    toolCalls: [{ toolName: 'delegate_candidate' }],
    toolResults: [{
      toolName: 'delegate_candidate',
      output: { accepted: true, action: 'candidate', mode: 'create', subject: 'current_workspace', acceptedToolCallId: 'accepted-candidate' }
    }],
    steps: [{
      toolCalls: [{ toolName: 'delegate_candidate' }],
      toolResults: [{
        toolName: 'delegate_candidate',
        output: { accepted: true, action: 'candidate', mode: 'create', subject: 'current_workspace', acceptedToolCallId: 'accepted-candidate' }
      }]
    }]
  }), undefined,
  '真实调用对应动作Tool后不得误判为伪调用并重复委派');
  assert.equal(runtime.intentOrchestratorV2Testing.mainNarrationFailure({
    text: '将由Candidate Worker生成候选。',
    toolCalls: [{ toolName: 'delegate_candidate' }],
    toolResults: [{
      toolName: 'delegate_candidate',
      output: { accepted: false, reason: 'invalid_arguments' }
    }],
    steps: [{
      toolCalls: [{ toolName: 'delegate_candidate' }],
      toolResults: [{
        toolName: 'delegate_candidate',
        output: { accepted: false, reason: 'invalid_arguments' }
      }]
    }]
  }), 'structured_tool_call_missing',
  '同名Tool Call只有accepted Tool Result才能证明动作真实执行');
  assert.doesNotMatch(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /record_task_understanding/u);
  assert.doesNotMatch(runtime.INTENT_ORCHESTRATOR_V2_INSTRUCTIONS, /我这次只能解释/u);
  const adaptive = runtime.intentOrchestratorV2Testing.v2GenerationSettings({
    model: {},
    reasoningMode: 'adaptive',
    providerOptionsName: 'openai-compatible',
    providerCompatibility: 'deepseek-v4-litellm'
  }, false);
  assert.equal(adaptive.reasoning, 'high');
  assert.equal(adaptive.explicitToolChoice, false);
  assert.deepEqual(adaptive.providerOptions['openai-compatible'].thinking,
    { type: 'enabled' });
  const medium = runtime.intentOrchestratorV2Testing.v2GenerationSettings({
    model: {},
    reasoningMode: 'medium',
    providerOptionsName: 'openai-compatible',
    providerCompatibility: 'deepseek-v4-litellm'
  }, false);
  assert.equal(medium.reasoning, 'high', 'DeepSeek maps medium effort to the effective high mode');
  assert.equal(medium.explicitToolChoice, false,
    'DeepSeek thinking+tools must rely on provider-default tool selection');
  assert.deepEqual(medium.providerOptions['openai-compatible'].thinking, { type: 'enabled' },
    'the LiteLLM native DeepSeek thinking route accepts the top-level thinking field');
  assert.equal(Object.hasOwn(medium.providerOptions['openai-compatible'], 'extra_body'), false);
  const glmThinking = runtime.intentOrchestratorV2Testing.v2GenerationSettings({
    model: {},
    reasoningMode: 'adaptive',
    providerOptionsName: 'openai-compatible',
    providerCompatibility: 'deepseek-v4-litellm',
    stageProtocolProfiles: { main: { protocolMode: 'glm-5.2-litellm' } }
  }, false, 'main');
  assert.deepEqual(glmThinking.providerOptions['openai-compatible'], {
    reasoningEffort: 'high',
    extra_body: { thinking: { type: 'enabled', clear_thinking: false } },
    allowed_openai_params: ['reasoning_effort']
  });
  assert.equal(glmThinking.explicitToolChoice, true);
  assert.equal(Object.hasOwn(glmThinking.providerOptions['openai-compatible'], 'parallel_tool_calls'), false,
    'GLM 5.2阶段协议必须覆盖旧全局DeepSeek兼容模式，并且不得发送ZAI不支持的parallel_tool_calls。');
  const glmDisabled = runtime.intentOrchestratorV2Testing.v2GenerationSettings({
    model: {},
    reasoningMode: 'disabled',
    providerOptionsName: 'openai-compatible',
    providerCompatibility: 'deepseek-v4-litellm',
    stageProtocolProfiles: { fastGate: { protocolMode: 'glm-5.2-litellm' } }
  }, true, 'fastGate');
  assert.deepEqual(glmDisabled.providerOptions['openai-compatible'], {
    extra_body: { thinking: { type: 'disabled' } }
  });
  assert.equal(Object.hasOwn(glmDisabled.providerOptions['openai-compatible'], 'parallel_tool_calls'), false);
  const generic = runtime.intentOrchestratorV2Testing.v2GenerationSettings({
    model: {},
    reasoningMode: 'adaptive',
    providerOptionsName: 'openai-compatible',
    providerCompatibility: 'generic-openai'
  }, false);
  assert.deepEqual(generic.providerOptions, {},
    'generic OpenAI-compatible providers must not receive DeepSeek-only fields');
  const direct = runtime.intentOrchestratorV2Testing.v2GenerationSettings({
    model: {},
    reasoningMode: 'adaptive',
    providerOptionsName: 'openai-compatible',
    providerCompatibility: 'deepseek-v4-direct'
  }, false);
  assert.deepEqual(direct.providerOptions['openai-compatible'].thinking, { type: 'enabled' });
  assert.equal(Object.hasOwn(direct.providerOptions['openai-compatible'], 'extra_body'), false);
  for (const reasoningMode of ['disabled', 'adaptive', 'high', 'max']) {
    const repair = runtime.intentOrchestratorV2Testing.v2RepairGenerationSettings({
      model: {},
      reasoningMode,
      providerOptionsName: 'openai-compatible',
      providerCompatibility: 'deepseek-v4-litellm'
    });
    assert.equal(repair.reasoning, 'high', 'Repair must use one fixed Thinking High execution');
    assert.equal(repair.explicitToolChoice, false,
      'DeepSeek V4 Thinking Repair must not serialize tool_choice');
    assert.deepEqual(repair.providerOptions['openai-compatible'], {
      reasoningEffort: 'high',
      thinking: { type: 'enabled' },
      parallel_tool_calls: false
    });
  }
  assert.equal(runtime.intentOrchestratorV2Testing.v2ReasoningRoute({
    model: {}, reasoningMode: 'provider-managed'
  }).selectedMode, 'high');
  assert.equal(runtime.intentOrchestratorV2Testing.v2ReasoningRoute({
    model: {}, reasoningMode: 'medium'
  }).selectedMode, 'high');
  assert.equal(runtime.intentOrchestratorV2Testing.v2ReasoningRoute({
    model: {}, reasoningMode: 'adaptive'
  }).selectedMode, 'high');
  assert.equal(runtime.intentOrchestratorV2Testing.v2ReasoningRoute({
    model: {}, reasoningMode: 'max'
  }).selectedMode, 'max');
  assert(deriveAgentTaskPolicy(normalizedHost(
    '介绍电动汽车电池热管理系统的主要组成。', 'req_domain_capability_allowed_by_policy'
  )).capabilityGrant.includes('search_engineering_domain_evidence'));
  assert(deriveAgentTaskPolicy(normalizedHost(
    '请搜索公开网页并附上来源链接。', 'req_domain_capability_allowed'
  )).capabilityGrant.includes('search_engineering_domain_evidence'));
  testExplicitRunStopCauses(runtime);
  await testValidatorObservationPersistence();
  await testModelCallAuditLedger(runtime);
  await testServerOwnedAdmission();
  await testSimpleZeroSearch(MockLanguageModelV4);
  await testClarificationPauseAndResume(MockLanguageModelV4);
  await testMainAgentIntentUnderstanding(MockLanguageModelV4, runtime);
  await testMainInternalPlanningRecovery(MockLanguageModelV4);
  await testV2CandidateWorkerExecution(MockLanguageModelV4, runtime);
  await testPreviousValidatedCandidateSubjectBinding(MockLanguageModelV4);
  await testCourseTaskHintLoadsLessonAssetsWithoutBlockingDelivery(MockLanguageModelV4);
  await testUnknownCourseHintDoesNotExposeLessonAssets(MockLanguageModelV4);
  await testV2RepairWorkerExecution(MockLanguageModelV4);
  await testRepairBaselinePassCanTruthfullyEndWithoutChange(MockLanguageModelV4);
  await testReviewAdviceCannotControlDelivery(MockLanguageModelV4);
  await testV2FailedRunLifecycle(MockLanguageModelV4);
  await testV2CandidateModeMaterialization(runtime);
  await testBodyMarkerCannotDelegate(MockLanguageModelV4);
  await testVisibleTextCanRequestSafeFinalization(MockLanguageModelV4);
  await testFinalizerTimeoutUsesServerBoundMainDraft(MockLanguageModelV4);
  await testAutonomousKnowledgeSearch(MockLanguageModelV4);
  await testToolOnlyDirectActionReachesFinalAnswerWorker(MockLanguageModelV4);
  await testDirectFinalizerReceivesMainReadOnlyEvidenceAndCannotPromiseAttachment(MockLanguageModelV4);
  await testConfiguredKnowledgeLimitRemovesSearch(MockLanguageModelV4);
  testDomainSearchPromptPolicy(runtime);
  await testDomainSearchToolContinuation(MockLanguageModelV4);
  await testFrozenModelPairAndAudit(MockLanguageModelV4);
  await testGraphEvidenceBinding(MockLanguageModelV4);
  testModelVisibleEvidenceBoundary(runtime);
  await testMainFailureDegradationAndBounds(MockLanguageModelV4, runtime);
  await testMixedScopeBinding(MockLanguageModelV4);
  await testRejectRequiresTwoIndependentCalls(MockLanguageModelV4);
  await testGateFailuresOpen(MockLanguageModelV4);
  await testPublicTraceContract(MockLanguageModelV4);
  await testPublicNarrationProjectionThroughServer(MockLanguageModelV4);
  console.log('teacher intent orchestrator v2 tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
