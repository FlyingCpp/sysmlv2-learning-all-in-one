'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function usage(input = 10, output = 5) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 }
  };
}

function generatedText(text, finishReason = 'stop') {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: finishReason, raw: finishReason },
    usage: usage(),
    warnings: []
  };
}

function generatedToolCalls(calls) {
  return {
    content: calls,
    finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
    usage: usage(),
    warnings: []
  };
}

function toolCall(toolCallId, toolName, input) {
  return { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) };
}

function request(runId, options = {}) {
  const question = options.question || '生成一个最小车辆模型。';
  return {
    runId,
    question,
    currentStudentQuestion: question,
    conversationMessages: options.conversationMessages || [{ role: 'user', content: question }],
    taskSources: options.taskSources || [],
    capabilityGrant: ['validate_candidate_workspace'],
    context: {
      tenantId: 'tenant-candidate',
      userId: 'user-candidate',
      threadId: 'thread-candidate',
      lesson: {
        courseId: 'course-candidate', lessonId: 'lesson-candidate', title: 'Candidate Worker',
        objectives: [], taskHints: []
      },
      model: {
        files: [{
          fileId: 'file-candidate', displayName: 'model.sysml', content: 'package Demo {}',
          contentHash: hash('package Demo {}'), editable: true
        }],
        entryFileId: 'file-candidate', activeFileId: 'file-candidate', diagnostics: []
      }
    }
  };
}

function setup(runtime, runId, mode = 'create', requestOptions = {}) {
  const parsed = runtime.agentRunRequestSchema.parse(request(runId, requestOptions));
  const resources = runtime.createRunResources({
    request: parsed,
    policy: runtime.DEFAULT_AGENT_POLICY,
    deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
  });
  const delegated = resources.tasks.materialize({
    questionHash: resources.input.questionHash,
    outcome: { type: 'delegate_candidate', mode, subject: 'current_workspace', acceptedToolCallId: `${runId}-delegate` },
    context: parsed.context
  });
  const running = resources.tasks.transition(delegated.taskId, delegated.revision, { type: 'worker_started' });
  return { resources, task: runtime.projectWorkerTaskView(resources, running) };
}

function c05TaskSources() {
  const definitions = [
    ['source-c05-root', 'root_user_request', '由发动机和电源组成'],
    ['source-c05-scope', 'clarification_user_answer', '暂时不考虑接口等'],
    ['source-c05-start', 'clarification_user_answer', '是的，开始建模把'],
    ['source-c05-name', 'clarification_user_answer', '动力与供电系统，就按这个来']
  ];
  const taskAuthorizationRevisionHash = hash(JSON.stringify(definitions));
  return definitions.map(([sourceId, relation, text]) => ({
    sourceId,
    relation,
    text,
    sourceHash: hash(text),
    taskAuthorizationRevisionHash
  }));
}

function validation(content, passed, task) {
  return {
    passed,
    retryable: !passed,
    candidate: {
      mode: 'replace_entry',
      fileId: task.target.fileId,
      baseHash: task.target.baseHash,
      content
    },
    validation: {
      validator: {
        authority: 'official-sysml-v2-validator', version: 'test', evidenceHash: hash(`validator:${passed}:${content}`)
      },
      official: {
        syntax: passed ? 'passed' : 'failed',
        semantic: passed ? 'passed' : 'not_run',
        diagnostics: passed ? [] : [{ severity: 'error', message: 'invalid candidate' }]
      },
      courseRuleApplicability: 'not_applicable',
      completeness: 'complete',
      candidateWorkspaceHash: hash(`${task.model.files[0].displayName}\n${hash(content)}`),
      patches: []
    },
    reason: passed ? 'validator_passed' : 'validator_failed'
  };
}

async function main() {
  const runtime = await import('../apps/teacher/dist/agent/index.mjs');
  const { projectConversationModelMessages } = await import('../apps/teacher/dist/agent/model-message-projection.mjs');
  const { MockLanguageModelV4 } = await import('ai/test');
  const { tool } = await import('ai');
  const { z } = await import('zod');

  assert.deepEqual(
    runtime.extractCandidateContent({ text: '```sysml\npackage Demo {}\n```', finishReason: 'stop' }),
    { success: true, content: 'package Demo {}' }
  );
  assert.deepEqual(
    runtime.extractCandidateContent({ text: '```\npackage Demo {}\n```', finishReason: 'stop' }),
    { success: true, content: 'package Demo {}' },
    '唯一、闭合、无语言标签的代码围栏必须作为完整候选提取'
  );
  assert.deepEqual(
    runtime.extractCandidateContent({ text: '```json\n{"package":"Demo"}\n```', finishReason: 'stop' }),
    { success: false, reason: 'ambiguous' },
    '其他语言标签不得被误当作SysML候选'
  );
  assert.deepEqual(
    runtime.extractCandidateContent({
      text: '```\npackage One {}\n```\n```\npackage Two {}\n```', finishReason: 'stop'
    }),
    { success: false, reason: 'ambiguous' },
    '多个无标签围栏仍必须拒绝，避免候选选择不确定'
  );
  assert.deepEqual(
    runtime.extractCandidateContent({ text: '```sysml\npackage Demo {}', finishReason: 'stop' }),
    { success: false, reason: 'truncated' }
  );

  const first = setup(runtime, 'run_slice_c_candidate_pass');
  const model = new MockLanguageModelV4({
    doGenerate: [generatedText('```sysml\npackage Demo { part def Vehicle; }\n```')]
  });
  let validatedContent;
  const passed = await runtime.runCandidateWorker({
    resources: first.resources,
    task: first.task,
    model,
    abortSignal: new AbortController().signal,
    instructions: '只输出完整SysML v2候选。',
    maxOutputTokens: 2_000,
    timeoutMs: 10_000,
    validateCandidate: async ({ content }) => {
      validatedContent = content;
      return validation(content, true, first.task);
    }
  });
  assert.equal(validatedContent, 'package Demo { part def Vehicle; }');
  assert.equal(passed.status, 'validated_passed');
  assert.equal(passed.attemptCount, 1);
  assert.equal(first.resources.budget.view().modelTotalTokens, 15);
  assert(!JSON.stringify(model.doGenerateCalls).includes(first.resources.scopeKey));

  const modeIntents = new Map([
    ['create', '建立新的独立模型'],
    ['complete', '补齐授权基线中的TODO'],
    ['refine', '执行单点增补、联动修改、新模式引入或有界重构'],
    ['milestone', '整合为一个完整里程碑候选']
  ]);
  for (const [mode, intentText] of modeIntents) {
    const modeCase = setup(runtime, `run_candidate_generation_control_${mode}`, mode);
    const modeModel = new MockLanguageModelV4({
      doGenerate: [generatedText(`package ${mode}Mode { part def System; }`)]
    });
    const modeResult = await runtime.runCandidateWorker({
      resources: modeCase.resources,
      task: modeCase.task,
      model: modeModel,
      abortSignal: new AbortController().signal,
      instructions: '只输出完整SysML v2候选。',
      timeoutMs: 10_000,
      validateCandidate: async ({ content }) => validation(content, true, modeCase.task)
    });
    assert.equal(modeResult.status, 'validated_passed');
    const providerInput = JSON.stringify(modeModel.doGenerateCalls);
    assert(providerInput.includes('candidateGenerationControl'));
    assert(providerInput.includes(`\\\"deliveryMode\\\":\\\"${mode}\\\"`));
    assert(providerInput.includes(intentText));
    assert(providerInput.includes('direct_generate'));
    assert(providerInput.includes('reviewed_knowledge_then_generate'));
    assert(!providerInput.includes('engineeringQualityScore'));
    assert(!providerInput.includes('goalCoverageScore'));
  }

  const productionHandlerSource = fs.readFileSync(
    path.join(__dirname, '..', 'apps', 'teacher', 'agent', 'production-worker-handlers.mts'),
    'utf8'
  );
  assert(productionHandlerSource.includes('CANDIDATE_ADAPTIVE_GENERATION_GUIDANCE'));
  assert(productionHandlerSource.includes('精通SysML v2建模规范和建模实践的专家'));
  assert(productionHandlerSource.includes('不得套用Java、Python或其他编程语言'));
  assert(productionHandlerSource.includes('SYSML_V2_LANGUAGE_BOUNDARY_GUIDANCE'));
  assert(productionHandlerSource.includes('不得混入SysML 1.x、UML图关键字、MATLAB/Simulink'));
  assert(productionHandlerSource.includes('named transition必须使用first <source> then <target>'));
  assert(!productionHandlerSource.includes('remainingGoals、gapRefs和acceptanceNotes'));
  assert(!productionHandlerSource.includes('后续独立Engineering Review能力负责工程语义完善'));
  assert(productionHandlerSource.includes('SYSML_INCREMENTAL_EDIT_GUIDANCE'));
  const incrementalEditGuidanceSource = fs.readFileSync(
    path.join(__dirname, '..', 'apps', 'teacher', 'agent', 'sysml-model-edit-guidance.mts'),
    'utf8'
  );
  assert(incrementalEditGuidanceSource.includes('扩展已有元素时修改其原声明'));
  assert(!productionHandlerSource.includes('question.includes("requirement")'),
    'Candidate工作形态判读不得退化为Requirement关键词硬编码');

  const c05Sources = c05TaskSources();
  const c05ConversationMessages = c05Sources.map((source) => ({ role: 'user', content: source.text }));
  const c05 = setup(runtime, 'run_candidate_c05_confirmed_task_sources', 'create', {
    question: '动力与供电系统，就按这个来',
    conversationMessages: c05ConversationMessages,
    // 模拟真实C05在中间Run意外succeeded后Clarification授权链断开：
    // 当前授权TaskSourceSet只有本轮，早期用户事实必须从Main同源会话视图进入Worker。
    taskSources: [c05Sources.at(-1)]
  });
  assert(Object.isFrozen(c05.resources.input.taskSources));
  assert(c05.resources.input.taskSources.every(Object.isFrozen));
  assert(Object.is(c05.task.taskSources, c05.resources.input.taskSources),
    'Candidate WorkerTaskView必须复用Run Snapshot中的不可变TaskSourceSet');
  assert.deepEqual(c05.task.conversationMessages, c05ConversationMessages);
  const c05Model = new MockLanguageModelV4({
    doGenerate: [generatedText('package PowerSystem { part def Engine; part def PowerSupply; }')]
  });
  const c05Result = await runtime.runCandidateWorker({
    resources: c05.resources,
    task: c05.task,
    model: c05Model,
    abortSignal: new AbortController().signal,
    instructions: '只输出完整SysML v2候选。',
    timeoutMs: 10_000,
    validateCandidate: async ({ content }) => validation(content, true, c05.task)
  });
  assert.equal(c05Result.status, 'validated_passed');
  const c05ProviderInput = JSON.stringify(c05Model.doGenerateCalls);
  const c05ProviderMessages = c05Model.doGenerateCalls.flatMap((call) => call.prompt || []);
  const c05SystemInput = JSON.stringify(c05ProviderMessages.filter((message) => message.role === 'system'));
  const c05UserInput = JSON.stringify(c05ProviderMessages.filter((message) => message.role === 'user'));
  for (const source of c05Sources) {
    assert(c05UserInput.includes(source.text), `Candidate user消息必须保留已确认用户事实：${source.text}`);
    assert(!c05SystemInput.includes(source.text), '学生原文不得重复进入服务端可信system投影');
    assert(!c05ProviderInput.includes(source.sourceId), 'Provider输入不得暴露服务端TaskSource ID');
    assert(!c05ProviderInput.includes(source.sourceHash), 'Provider输入不得暴露服务端TaskSource Hash');
  }
  assert(!c05SystemInput.includes('confirmedTaskSources'));
  assert(!c05ProviderInput.includes('conversationContext'));

  const recoveredOrder = projectConversationModelMessages(
    [{ role: 'user', content: c05Sources[1].text }],
    c05Sources.slice(0, 2),
  );
  assert.deepEqual(
    recoveredOrder.filter((message) => message.role === 'user').map((message) => message.content),
    [c05Sources[0].text, c05Sources[1].text],
    '公开历史缺root但含answer时，补入的TaskSource仍必须保持root→answer顺序',
  );

  const currentQuestion = '给我描述这个模型';
  const currentRequestOrder = projectConversationModelMessages(
    [
      { role: 'user', content: '请补全汽车模型并增加连接。' },
      { role: 'assistant', content: '上一轮未完成。' },
      { role: 'user', content: currentQuestion }
    ],
    [
      { relation: 'root_user_request', text: '请补全汽车模型并增加连接。' },
      { relation: 'clarification_user_answer', text: '保留原有顺序图。' }
    ],
    currentQuestion
  );
  const currentUserMessages = currentRequestOrder
    .filter((message) => message.role === 'user')
    .map((message) => message.content);
  assert.equal(currentUserMessages.at(-1), currentQuestion,
    '当前请求必须是Provider看到的最后一条user消息，旧TaskSource不得排到它后面');
  assert.equal(currentUserMessages.filter((text) => text === currentQuestion).length, 1,
    '当前请求在历史与fallback同时存在时只投影一次');
  assert(currentUserMessages.indexOf('保留原有顺序图。') < currentUserMessages.indexOf(currentQuestion),
    '缺失的历史TaskSource必须补在当前请求之前');

  const revisionQuestion = '只在user消息出现的工程完善任务-REVISION-ROLE-BOUNDARY';
  const revision = setup(runtime, 'run_candidate_engineering_revision_role', 'refine', {
    question: revisionQuestion,
    conversationMessages: [{ role: 'user', content: revisionQuestion }],
  });
  const revisionModel = new MockLanguageModelV4({
    doGenerate: [generatedText('package Revision { part def Updated; }')]
  });
  await runtime.runCandidateWorker({
    resources: revision.resources,
    task: revision.task,
    model: revisionModel,
    abortSignal: new AbortController().signal,
    instructions: '只输出完整SysML v2候选。',
    prompt: '执行服务端已绑定的工程完善；保留基线并闭合有效Issue。',
    timeoutMs: 10_000,
    validateCandidate: async ({ content }) => validation(content, true, revision.task)
  });
  const revisionMessages = revisionModel.doGenerateCalls.flatMap((call) => call.prompt || []);
  assert(JSON.stringify(revisionMessages.filter((message) => message.role === 'user')).includes(revisionQuestion));
  assert(!JSON.stringify(revisionMessages.filter((message) => message.role === 'system')).includes(revisionQuestion),
    'Engineering Revision不得把学生任务重复提升为system Instructions');

  const uncapped = setup(runtime, 'run_candidate_create_without_output_cap');
  const uncappedModel = new MockLanguageModelV4({
    doGenerate: [generatedText('package Demo { part def Mouse; }')]
  });
  const uncappedResult = await runtime.runCandidateWorker({
    resources: uncapped.resources,
    task: uncapped.task,
    model: uncappedModel,
    abortSignal: new AbortController().signal,
    instructions: '只输出完整SysML v2候选。',
    timeoutMs: 10_000,
    validateCandidate: async ({ content }) => validation(content, true, uncapped.task)
  });
  assert.equal(uncappedResult.status, 'validated_passed');
  assert.equal(uncappedModel.doGenerateCalls[0].maxOutputTokens, undefined,
    'create候选未配置应用层输出Token上限时传给Provider Adapter的值必须为undefined');

  const withSearch = setup(runtime, 'run_slice_e_candidate_search');
  let candidateSearchCalls = 0;
  const searchModel = new MockLanguageModelV4({
    doGenerate: [
      generatedToolCalls([toolCall('candidate-search-1', 'search_reviewed_knowledge', {
        query: 'SysML v2 requirement usage subject satisfy size import official example', limit: 5
      })]),
      generatedText('```sysml\npackage Demo { part def Vehicle; }\n```')
    ]
  });
  const searchTool = tool({
    description: 'Search reviewed knowledge.',
    inputSchema: z.object({ query: z.string(), limit: z.number().int() }).strict(),
    execute: async (input) => {
      withSearch.resources.assertNewReviewedKnowledgeQueryAllowed(input);
      withSearch.resources.budget.reserve("knowledge_backend");
      candidateSearchCalls += 1;
      const output = {
        claims: [{
          claimId: 'claim-requirement-pattern',
          claimText: 'Create a requirement usage before satisfying it by an existing part usage.',
          authorityLevel: 'A1'
        }],
        evidenceBlocks: [{
          evidenceId: 'official-requirement-example',
          sectionPath: 'Official Requirements Example',
          excerpt: 'requirement fourMotorRequirement : FourMotorRequirement; satisfy fourMotorRequirement by propulsionSystem;',
          authorityLevel: 'A1'
        }]
      };
      withSearch.resources.knowledge.observeToolResult('search_reviewed_knowledge', input, output);
      await withSearch.resources.ledger.recordObservation({ toolCallId: 'candidate-query-fixture', toolName: 'search_reviewed_knowledge', input, output });
      return output;
    }
  });
  const searched = await runtime.runCandidateWorker({
    resources: withSearch.resources,
    task: withSearch.task,
    model: searchModel,
    tools: { search_reviewed_knowledge: searchTool },
    maxSteps: 3,
    abortSignal: new AbortController().signal,
    instructions: '需要时查询知识，然后只输出完整SysML v2候选。',
    maxOutputTokens: 2_000,
    timeoutMs: 10_000,
    toolTimeoutMs: 1_234,
    validateCandidate: async ({ content }) => validation(content, true, withSearch.task)
  });
  assert.equal(searched.status, 'validated_passed');
  assert.equal(candidateSearchCalls, 1);
  assert.equal((searchModel.doGenerateCalls[1].tools || []).some((entry) => (
    (entry.name || entry.toolName) === 'search_reviewed_knowledge'
  )), true, '互补缺口和后续页仍可查询；总工具预算统一控制');
  assert(!JSON.stringify(searchModel.doGenerateCalls[0]).includes('maxNewQueriesPerGenerationAttempt'));
  assert.equal(searchModel.doGenerateCalls[0].abortSignal instanceof AbortSignal, true,
    'Candidate AI SDK ToolLoop必须把SDK统一AbortSignal传入Provider调用');
  assert(JSON.stringify(searchModel.doGenerateCalls).includes('Create a requirement usage before satisfying it'),
    'AI SDK必须把完整Requirement模式Tool Result传入Candidate下一步');
  assert.deepEqual(
    withSearch.resources.toolLifecycleSnapshot().map(({ participant, taskId, status }) => ({ participant, taskId, status })),
    [
      { participant: 'candidate', taskId: withSearch.task.taskId, status: 'started' },
      { participant: 'candidate', taskId: withSearch.task.taskId, status: 'succeeded' }
    ]
  );

  const sharedEvidence = setup(runtime, 'run_slice_e_candidate_shared_evidence');
  await sharedEvidence.resources.ledger.recordObservation({
    toolCallId: 'main-shared-search',
    toolName: 'search_reviewed_knowledge',
    input: { query: 'part usage typing', limit: 5 },
    output: {
      claims: [{
        claimId: 'claim-shared-part',
        claimText: 'A part usage can be typed by a part definition.',
        authorityLevel: 'A1',
        evidenceIds: ['evidence-shared-part']
      }],
      evidenceBlocks: [{
        evidenceId: 'evidence-shared-part',
        sectionPath: 'Parts',
        excerpt: 'The colon typing operator binds the usage to its definition.',
        authorityLevel: 'A1'
      }]
    }
  });
  const currentSharedTask = sharedEvidence.resources.tasks.get(sharedEvidence.task.taskId);
  const sharedTask = Object.freeze({
    ...sharedEvidence.task,
    knowledge: runtime.projectWorkerEvidenceView(sharedEvidence.resources, currentSharedTask)
  });
  const sharedModel = new MockLanguageModelV4({
    doGenerate: [generatedText('```sysml\npackage Demo { part def Vehicle; }\n```')]
  });
  for (let index = 0; index < sharedEvidence.resources.resourcePolicy.operationLimits.knowledge_backend; index += 1) {
    sharedEvidence.resources.budget.reserve("knowledge_backend");
    sharedEvidence.resources.assertNewReviewedKnowledgeQueryAllowed({
      query: `prior participant query ${index + 1}`,
      limit: 5
    });
  }
  let closedSearchCalls = 0;
  const closedSearchTool = tool({
    description: 'This tool must be hidden after the shared Run budget is exhausted.',
    inputSchema: z.object({ query: z.string(), limit: z.number().int() }).strict(),
    execute: async () => {
      closedSearchCalls += 1;
      throw new Error('closed Search must not execute');
    }
  });
  const sharedResult = await runtime.runCandidateWorker({
    resources: sharedEvidence.resources,
    task: sharedTask,
    model: sharedModel,
    tools: { search_reviewed_knowledge: closedSearchTool },
    maxSteps: 2,
    abortSignal: new AbortController().signal,
    instructions: 'Use disclosed reviewed evidence and output one complete candidate.',
    maxOutputTokens: 2_000,
    timeoutMs: 10_000,
    validateCandidate: async ({ content }) => validation(content, true, sharedTask)
  });
  assert.equal(sharedResult.status, 'validated_passed');
  assert.equal(closedSearchCalls, 0);
  assert.equal((sharedModel.doGenerateCalls[0].tools || []).some((entry) => (
    (entry.name || entry.toolName) === 'search_reviewed_knowledge'
  )), false, 'Candidate必须复用Main耗尽的共享Run额度，并在下一步撤下Search Schema');
  const sharedPrompt = JSON.stringify(sharedModel.doGenerateCalls);
  assert(sharedPrompt.includes('A part usage can be typed by a part definition.'));
  assert(sharedPrompt.includes('The colon typing operator binds the usage to its definition.'));

  const recoverySearch = setup(runtime, 'run_candidate_recovery_complementary_search');
  let recoverySearchBackendCalls = 0;
  const recoverySearchModel = new MockLanguageModelV4({
    doGenerate: [
      generatedToolCalls([toolCall('recovery-search-first', 'search_reviewed_knowledge', {
        query: 'part usage typing', limit: 5
      })]),
      generatedText(''),
      generatedToolCalls([toolCall('recovery-search-replay', 'search_reviewed_knowledge', {
        query: 'part usage typing', limit: 5
      })]),
      generatedToolCalls([toolCall('recovery-search-second', 'search_reviewed_knowledge', {
        query: 'part definition ownership boundary', limit: 5
      })]),
      generatedText('```sysml\npackage Demo { part def Vehicle; }\n```')
    ]
  });
  const recoverySearchTool = tool({
    description: 'Search reviewed knowledge with the shared Run query budget.',
    inputSchema: z.object({ query: z.string(), limit: z.number().int() }).strict(),
    execute: async (input, options) => await recoverySearch.resources.ledger.execute({
      toolCallId: options.toolCallId,
      toolName: 'search_reviewed_knowledge',
      input,
      abortSignal: options.abortSignal,
      operation: async () => {
        recoverySearch.resources.assertNewReviewedKnowledgeQueryAllowed(input);
        recoverySearch.resources.budget.reserve("knowledge_backend");
        recoverySearchBackendCalls += 1;
        const firstQuery = input.query === 'part usage typing';
        const output = {
          requestedQuery: input.query,
          effectiveQuery: input.query,
          coverage: firstQuery ? 'PARTIAL' : 'COMPLETE',
          no_new_evidence: false,
          claims: [{
            claimId: firstQuery ? 'claim-recovery-typing' : 'claim-recovery-ownership',
            claimText: firstQuery
              ? 'A part usage can be typed by a part definition.'
              : 'Nested parts remain owned by the enclosing definition.',
            authorityLevel: 'A1',
            evidenceIds: [firstQuery ? 'evidence-recovery-typing' : 'evidence-recovery-ownership']
          }],
          evidenceBlocks: [{
            evidenceId: firstQuery ? 'evidence-recovery-typing' : 'evidence-recovery-ownership',
            sectionPath: firstQuery ? 'Typing' : 'Ownership',
            excerpt: firstQuery
              ? 'The colon operator types a usage.'
              : 'Nested feature ownership stays within the definition.',
            authorityLevel: 'A1'
          }],
          closureGaps: firstQuery ? ['missing_dimension:ownership_boundary'] : []
        };
        recoverySearch.resources.knowledge.observeToolResult('search_reviewed_knowledge', input, output);
        return output;
      }
    })
  });
  const recoverySearchResult = await runtime.runCandidateWorker({
    resources: recoverySearch.resources,
    task: recoverySearch.task,
    model: recoverySearchModel,
    tools: { search_reviewed_knowledge: recoverySearchTool },
    maxSteps: 3,
    abortSignal: new AbortController().signal,
    instructions: 'Use at most two complementary reviewed-knowledge queries, then output one complete candidate.',
    maxOutputTokens: 2_000,
    timeoutMs: 10_000,
    validateCandidate: async ({ content }) => validation(content, true, recoverySearch.task)
  });
  assert.equal(recoverySearchResult.status, 'validated_passed');
  assert.equal(recoverySearchResult.attemptCount, 2);
  assert.equal(recoverySearchBackendCalls, 2,
    '内容恢复必须与首次生成共享Run额度，并可在只检索过一次时提出第二个互补查询');
  assert.equal((recoverySearchModel.doGenerateCalls[1].tools || []).some((entry) => (
    (entry.name || entry.toolName) === 'search_reviewed_knowledge'
  )), true, '查询后仍允许读取互补缺口和后续页');
  assert(recoverySearch.resources.ledger.snapshot().some((entry) => entry.replayCount > 0),
    '内容恢复重复首次查询时必须由同一Ledger精确回放，不得扩张后端或上下文');
  assert.deepEqual(recoverySearch.resources.knowledge.reviewedKnowledgeQueryBudget(), {
    maxNewQueries: recoverySearch.resources.resourcePolicy.operationLimits.knowledge_backend,
    admittedNewQueries: 2,
    remainingNewQueries: recoverySearch.resources.resourcePolicy.operationLimits.knowledge_backend - 2,
    noNewEvidenceObserved: false
  });
  const recoverySecondPrompt = JSON.stringify(recoverySearchModel.doGenerateCalls[2]);
  assert(recoverySecondPrompt.includes('claim-recovery-typing'),
    '内容恢复提示必须包含首次检索的Claim');
  assert(recoverySecondPrompt.includes('missing_dimension:ownership_boundary'),
    '内容恢复提示必须包含首次检索暴露的缺失维度');
  assert.match(recoverySecondPrompt, /remainingNewQueries\\?":11/u,
    '内容恢复提示必须暴露共享Run中剩余的查询额度');

  const recover = setup(runtime, 'run_slice_c_candidate_recover', 'refine');
  const recoveryModel = new MockLanguageModelV4({
    doGenerate: [generatedText('package Demo { part def Broken; }')]
  });
  let recoveryCalled = 0;
  const recovered = await runtime.runCandidateWorker({
    resources: recover.resources,
    task: recover.task,
    model: recoveryModel,
    abortSignal: new AbortController().signal,
    instructions: '只输出完整SysML v2候选。',
    maxOutputTokens: 2_000,
    timeoutMs: 10_000,
    validateCandidate: async ({ content }) => validation(content, false, recover.task),
    recoverValidationFailure: async ({ content }) => {
      recoveryCalled += 1;
      return validation(content.replace('Broken', 'Vehicle'), true, recover.task);
    }
  });
  assert.equal(recoveryCalled, 1);
  assert.equal(recovered.status, 'validated_passed');
  assert.equal(recovered.attemptCount, 2);

  const recoveryQueueFull = setup(runtime, 'run_slice_a_candidate_recovery_queue_full', 'refine');
  const recoveryQueueFullModel = new MockLanguageModelV4({
    doGenerate: [generatedText('package Demo { part def Broken; }')]
  });
  const recoveryQueueFullResult = await runtime.runCandidateWorker({
    resources: recoveryQueueFull.resources,
    task: recoveryQueueFull.task,
    model: recoveryQueueFullModel,
    abortSignal: new AbortController().signal,
    instructions: '只输出完整SysML v2候选。',
    maxOutputTokens: 2_000,
    timeoutMs: 10_000,
    validateCandidate: async ({ content }) => validation(content, false, recoveryQueueFull.task),
    recoverValidationFailure: async () => { throw new Error('validator_queue_full'); }
  });
  assert.equal(recoveryQueueFullResult.status, 'exhausted');
  assert.equal(recoveryQueueFullResult.reason, 'validator_queue_full',
    'Candidate内部Repair的资源终态不得退化成初始validated_failed');

  const invalid = setup(runtime, 'run_slice_c_candidate_invalid');
  const invalidModel = new MockLanguageModelV4({
    doGenerate: [generatedText('```sysml\npackage Demo {}', 'length')]
  });
  let validationCalls = 0;
  const invalidResult = await runtime.runCandidateWorker({
    resources: invalid.resources,
    task: invalid.task,
    model: invalidModel,
    abortSignal: new AbortController().signal,
    instructions: '只输出完整SysML v2候选。',
    maxOutputTokens: 2_000,
    timeoutMs: 10_000,
    allowContentRecovery: false,
    validateCandidate: async () => {
      validationCalls += 1;
      throw new Error('must not validate incomplete candidate');
    }
  });
  assert.equal(validationCalls, 0);
  assert.equal(invalidResult.status, 'exhausted');
  assert.equal(invalidResult.reason, 'candidate_content_truncated');

  const queueFull = setup(runtime, 'run_slice_a_candidate_validator_queue_full');
  const queueFullModel = new MockLanguageModelV4({
    doGenerate: [generatedText('package Demo { part def Vehicle; }')]
  });
  const queueFullResult = await runtime.runCandidateWorker({
    resources: queueFull.resources,
    task: queueFull.task,
    model: queueFullModel,
    abortSignal: new AbortController().signal,
    instructions: '只输出完整SysML v2候选。',
    maxOutputTokens: 2_000,
    timeoutMs: 10_000,
    validateCandidate: async () => {
      const error = new Error('Candidate Validator tool rejected the request.');
      error.code = 'VALIDATOR_QUEUE_FULL';
      throw error;
    }
  });
  assert.equal(queueFullResult.status, 'worker_error');
  assert.match(queueFullResult.reason, /^VALIDATOR_QUEUE_FULL:/u,
    'Validator容量拒绝必须跨Worker边界保留可分类错误码');

  const noOpRequest = runtime.agentRunRequestSchema.parse(request('run_candidate_noop_reuse'));
  const noOpResources = runtime.createRunResources({
    request: noOpRequest,
    policy: runtime.DEFAULT_AGENT_POLICY,
    deadlineAtMs: Date.now() + runtime.DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000
  });
  const noOpContent = 'package LunarProbe {}';
  const noOpCandidate = { mode: 'standalone_model', fileName: 'lunar-probe.sysml', content: noOpContent };
  const noOpValidation = {
    validator: { authority: 'official-sysml-v2-validator', version: 'test', evidenceHash: hash('noop-validator') },
    official: { syntax: 'passed', semantic: 'passed', diagnostics: [] },
    courseRuleApplicability: 'not_applicable',
    completeness: 'complete',
    candidateWorkspaceHash: hash(`standalone/${noOpCandidate.fileName}\n${hash(noOpContent)}`),
    patches: []
  };
  const validatedBinding = runtime.createCurrentValidatedCandidateBinding({
    runId: noOpRequest.runId,
    candidate: noOpCandidate,
    validation: noOpValidation,
    baselineModel: noOpRequest.context.model
  });
  const noOpDelegated = noOpResources.tasks.materialize({
    questionHash: noOpResources.input.questionHash,
    outcome: {
      type: 'delegate_candidate', mode: 'refine', subject: 'current_validated_candidate',
      remainingGoals: ['补齐剩余热控连接。'], gapRefs: ['user:root'], acceptanceNotes: [],
      acceptedToolCallId: 'delegate-noop'
    },
    context: noOpRequest.context,
    currentValidatedCandidateBinding: validatedBinding,
    iterationDirective: {
      directiveId: 'directive-noop', contractId: 'task-contract-noop', contractRevision: 3,
      mode: 'refine', subject: 'current_validated_candidate', goalIds: ['goal-thermal'],
      remainingGoals: ['补齐剩余热控连接。'], gapRefs: ['user:root'], acceptanceNotes: []
    }
  });
  const noOpRunning = noOpResources.tasks.transition(
    noOpDelegated.taskId,
    noOpDelegated.revision,
    { type: 'worker_started' }
  );
  const noOpTask = runtime.projectWorkerTaskView(noOpResources, noOpRunning);
  const noOpModel = new MockLanguageModelV4({ doGenerate: [generatedText(noOpContent)] });
  let noOpValidatorCalls = 0;
  const noOpResult = await runtime.runCandidateWorker({
    resources: noOpResources,
    task: noOpTask,
    model: noOpModel,
    abortSignal: new AbortController().signal,
    instructions: '只输出完整SysML v2候选。',
    timeoutMs: 10_000,
    validateCandidate: async () => {
      noOpValidatorCalls += 1;
      throw new Error('no-op candidate must reuse prior Validator PASS');
    }
  });
  assert.equal(noOpValidatorCalls, 0);
  assert.equal(noOpResult.status, 'validated_passed');
  assert.equal(noOpResult.workPerformed, 'none');
  assert.equal(noOpResult.validatorSubject, 'baseline');
  assert.equal(noOpTask.iterationDirective.remainingGoals[0], '补齐剩余热控连接。');

  console.log('teacher candidate worker tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
