'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

function hash(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function generatedText(text) {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 }
    },
    warnings: []
  };
}

function request(runId) {
  const question = '构建Ａ系统，并包含热泵回路。';
  const sourceHash = hash(question);
  const taskAuthorizationRevisionHash = hash(`authorization:${question}`);
  return {
    runId,
    question,
    currentStudentQuestion: question,
    taskSources: [{
      sourceId: 'tasksource_root_review',
      relation: 'root_user_request',
      text: question,
      sourceHash,
      taskAuthorizationRevisionHash
    }],
    capabilityGrant: [],
    context: {
      tenantId: 'tenant-review',
      userId: 'user-review',
      threadId: 'thread-review',
      lesson: {
        courseId: 'course-review', lessonId: 'lesson-review', title: 'Engineering Review',
        objectives: [], taskHints: []
      },
      model: {
        files: [{
          fileId: 'file-review', displayName: 'model.sysml', content: 'package Thermal {}',
          contentHash: hash('package Thermal {}'), editable: true
        }],
        entryFileId: 'file-review', activeFileId: 'file-review', diagnostics: []
      }
    }
  };
}

function passedResult(runId, taskId, content) {
  return {
    version: 'worker-result-v2',
    runId,
    taskId,
    taskRevision: 1,
    attemptCount: 1,
    workerType: 'candidate',
    mode: 'milestone',
    status: 'validated_passed',
    candidate: { mode: 'standalone_model', fileName: 'model.sysml', content },
    validation: {
      validator: {
        authority: 'official-sysml-v2-validator', version: 'test', evidenceHash: hash(content)
      },
      official: { syntax: 'passed', semantic: 'passed', diagnostics: [] },
      courseRuleApplicability: 'not_applicable',
      completeness: 'complete',
      candidateWorkspaceHash: hash(content),
      patches: []
    }
  };
}

function advisoryOptions(runtime, MockLanguageModelV4, overrides = {}) {
  const parsedBase = runtime.agentRunRequestSchema.parse(request(overrides.runId || 'run_engineering_review_1'));
  const parsed = overrides.resumeExecution
    ? { ...parsedBase, resumeContext: { priorToolLedger: [], execution: overrides.resumeExecution } }
    : parsedBase;
  const resources = runtime.createRunResources({
    request: parsed,
    policy: {
      ...runtime.DEFAULT_AGENT_POLICY,
      maxDurationMs: 900_000,
      candidateMaxAttemptMs: 330_000,
      repairPhaseReserveMs: 300_000
    },
    deadlineAtMs: Date.now() + (overrides.remainingMs || 900_000)
  });
  const baseline = passedResult(parsed.runId, 'task_baseline', 'package Thermal { part def Baseline; }');
  const revised = passedResult(parsed.runId, 'task_revision', 'package Thermal { part def Baseline; part def HeatPump; }');
  const assessmentModel = overrides.assessmentModel || new MockLanguageModelV4({
    doGenerate: [
      generatedText(overrides.assessmentText || 'SCORE_USER_GOAL: 18\nSCORE_ENGINEERING_CLOSURE: 10\nSCORE_CONSISTENCY: 12\nSCORE_EVIDENCE: 5\nTOTAL_SCORE: 45\nRECOMMENDATION: OPTIMIZE\nGOAL_QUOTE: 热泵回路\nISSUE: 基线未形成热泵回路对象和关系。\nSUGGESTION: 在保留基线的前提下补充对应对象与关系。'),
      generatedText(overrides.verificationText || 'SCORE_USER_GOAL: 39\nSCORE_ENGINEERING_CLOSURE: 23\nSCORE_CONSISTENCY: 19\nSCORE_EVIDENCE: 13\nTOTAL_SCORE: 94\nRECOMMENDATION: DELIVER\nCOMPARISON: IMPROVED\nVERIFICATION: RESOLVED')
    ]
  });
  const mainModel = overrides.mainModel || new MockLanguageModelV4({
    doGenerate: [
      generatedText(overrides.mainDecision || 'OPTIMIZE'),
      generatedText(overrides.mainSelection || 'ADOPT_REVISION')
    ]
  });
  let revisionCalls = 0;
  const checkpoints = [];
  return {
    assessmentModel,
    mainModel,
    revised,
    get revisionCalls() { return revisionCalls; },
    checkpoints,
    options: {
      resources,
      baselineWorkerResult: baseline,
      taskSources: parsed.taskSources,
      assessmentModel,
      assessmentModelId: 'review-pro',
      assessmentProviderOptions: { test: { thinking: { type: 'enabled' } } },
      verificationProviderOptions: { test: { thinking: { type: 'disabled' } } },
      mainModel,
      mainModelId: 'main-flash',
      abortSignal: new AbortController().signal,
      policy: {
        enabled: true,
        assessmentTimeoutMs: 45_000,
        mainDecisionTimeoutMs: 20_000,
        verificationTimeoutMs: 45_000,
        maxOutputTokens: 3_000,
        maxIssues: 5,
        minimumCompleteChainMs: 180_000,
        domainSearchReserveMs: 0,
        shadowOnly: false,
        assessmentMaxCalls: 1,
        verificationMaxCalls: 1
      },
      reviseCandidate: async () => {
        revisionCalls += 1;
        return overrides.revisionResult || revised;
      },
      onCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); }
    }
  };
}

async function main() {
  const runtime = await import('../apps/teacher/dist/agent/index.mjs');
  const advisoryRuntime = await import('../apps/teacher/dist/agent/engineering-semantic-advisory.mjs');
  const productionRuntime = await import('../apps/teacher/dist/agent/production-worker-handlers.mjs');
  const { MockLanguageModelV4 } = await import('ai/test');

  const bound = runtime.bindUniqueGoalQuote('A系统', [
    {
      sourceId: 'tasksource_root_review', relation: 'root_user_request',
      text: '构建Ａ系统，并包含热泵回路。',
      sourceHash: hash('构建Ａ系统，并包含热泵回路。'),
      taskAuthorizationRevisionHash: hash('authorization:构建Ａ系统，并包含热泵回路。')
    }
  ]);
  assert(bound, 'NFKC等价引用必须绑定到真实用户原文');
  assert.equal(bound.quote, 'Ａ系统');
  assert.equal(runtime.bindUniqueGoalQuote('热泵', [
    {
      sourceId: 'tasksource_root_review', relation: 'root_user_request',
      text: '热泵连接热泵控制器。', sourceHash: hash('热泵连接热泵控制器。'),
      taskAuthorizationRevisionHash: hash('authorization:热泵连接热泵控制器。')
    }
  ]), undefined, '重复引用不得静默选择第一个命中');

  const success = advisoryOptions(runtime, MockLanguageModelV4);
  success.options.baselineWorkerResult.validation.courseRuleApplicability = 'applicable';
  success.options.baselineWorkerResult.validation.courseRules = {
    status: 'failed',
    diagnostics: [{ severity: 'error', code: 'COURSE_REVIEW', message: '课程目标尚未形成闭环。' }]
  };
  const successResult = await runtime.runEngineeringSemanticAdvisory(success.options);
  assert.equal(successResult.assessmentStatus, 'completed');
  assert.equal(successResult.revisionAttempted, true);
  assert.equal(successResult.revisionAdopted, true);
  assert.equal(successResult.selectedWorkerResult.taskId, 'task_revision');
  assert.equal(successResult.baselineScorecard.total, 45);
  assert.equal(successResult.baselineScorecard.reviewerRecommendation, 'optimize');
  assert.equal(success.revisionCalls, 1);
  assert.equal(success.assessmentModel.doGenerateCalls.length, 2, 'Assessment和Verification各调用一次');
  assert.equal(success.assessmentModel.doGenerateCalls[0].reasoning, 'high',
    'Assessment必须允许Pro进行有界工程推理');
  assert.equal(success.assessmentModel.doGenerateCalls[1].reasoning, 'none',
    'Verification必须保持非思考模式');
  assert.equal(success.assessmentModel.doGenerateCalls[0].providerOptions.test.thinking.type, 'enabled');
  assert.equal(success.assessmentModel.doGenerateCalls[1].providerOptions.test.thinking.type, 'disabled');
  assert.equal(success.mainModel.doGenerateCalls.length, 2, 'Main分别执行优化准入和双PASS Candidate终末选择');
  assert.equal(successResult.revisionScorecard.total, 94);
  assert.equal(successResult.selectionCallCount, 1);
  assert(!JSON.stringify(success.assessmentModel.doGenerateCalls).includes('reasoning_content'));
  assert(JSON.stringify(success.assessmentModel.doGenerateCalls[0]).includes('maxIssues'));
  const assessmentRequest = JSON.stringify(success.assessmentModel.doGenerateCalls[0]);
  assert(assessmentRequest.includes('逐项核对授权原文明确要求的工程对象、功能、接口/关系和场景'));
  assert(assessmentRequest.includes('maxIssues是上限而非配额'));
  assert(assessmentRequest.includes('任何未满足项和被强调场景都必须进入某个Issue'));
  assert(assessmentRequest.includes('覆盖该簇全部未满足列举项和强调场景'));
  assert(assessmentRequest.includes('不能只由静态拓扑暗示'));
  assert(assessmentRequest.includes('不指定图类型或复杂语言构造'));
  assert(assessmentRequest.includes('course-rule-advisory'));
  assert(assessmentRequest.includes('\\"blocking\\":false'));
  assert(assessmentRequest.includes('课程目标尚未形成闭环'));
  const verificationRequest = JSON.stringify(success.assessmentModel.doGenerateCalls[1]);
  assert(verificationRequest.includes('名称、注释、孤立对象或只解决部分子项都不能判为已解决'));
  assert(JSON.stringify(success.assessmentModel.doGenerateCalls[0]).includes('单一遗漏取最短唯一片段'));

  const unresolved = advisoryOptions(runtime, MockLanguageModelV4, {
    runId: 'run_engineering_review_unresolved',
    verificationText: 'SCORE_USER_GOAL: 32\nSCORE_ENGINEERING_CLOSURE: 18\nSCORE_CONSISTENCY: 18\nSCORE_EVIDENCE: 12\nTOTAL_SCORE: 80\nRECOMMENDATION: DELIVER_WITH_ADVISORY\nCOMPARISON: IMPROVED\nVERIFICATION: UNRESOLVED\nGAP: 仍缺少关系闭环。'
  });
  const unresolvedResult = await runtime.runEngineeringSemanticAdvisory(unresolved.options);
  assert.equal(unresolvedResult.revisionDelivered, true);
  assert.equal(unresolvedResult.revisionAdopted, true);
  assert.equal(unresolvedResult.engineeringResolution, 'unresolved');
  assert.equal(unresolvedResult.selectedWorkerResult.taskId, 'task_revision',
    'Post-Review仍有建议时必须交付Official Validator PASS Revision');
  assert.equal(unresolvedResult.openSuggestions.length, 1);
  assert.match(unresolvedResult.openSuggestions[0].publicSuggestionId, /^suggestion_/u);
  assert.equal(unresolved.revisionCalls, 1);

  const misleadingResolved = advisoryOptions(runtime, MockLanguageModelV4, {
    runId: 'run_engineering_review_misleading_resolved',
    verificationText: 'RESOLVED but the requested loop is still 未解决'
  });
  const misleadingResolvedResult = await runtime.runEngineeringSemanticAdvisory(misleadingResolved.options);
  assert.equal(misleadingResolvedResult.revisionDelivered, false,
    'Post-Review格式无效时必须保留Official Validator PASS基线');
  assert.equal(misleadingResolvedResult.engineeringResolution, 'unknown');
  assert.equal(misleadingResolvedResult.openSuggestions.length, 0);
  assert.equal(misleadingResolvedResult.selectedWorkerResult.taskId, 'task_baseline');

  const regressed = advisoryOptions(runtime, MockLanguageModelV4, {
    runId: 'run_engineering_review_regressed',
    verificationText: 'SCORE_USER_GOAL: 16\nSCORE_ENGINEERING_CLOSURE: 8\nSCORE_CONSISTENCY: 6\nSCORE_EVIDENCE: 5\nTOTAL_SCORE: 35\nRECOMMENDATION: OPTIMIZE\nCOMPARISON: REGRESSED\nVERIFICATION: UNRESOLVED\nGAP: Revision删除了基线中的正确内容。',
    mainSelection: 'RETAIN_BASELINE'
  });
  const regressedResult = await runtime.runEngineeringSemanticAdvisory(regressed.options);
  assert.equal(regressedResult.revisionAttempted, true);
  assert.equal(regressedResult.revisionDelivered, false);
  assert.equal(regressedResult.selectedWorkerResult.taskId, 'task_baseline');

  const malformed = advisoryOptions(runtime, MockLanguageModelV4, {
    runId: 'run_engineering_review_malformed',
    assessmentModel: new MockLanguageModelV4({ doGenerate: [generatedText('{"outcome":"REVISE"}')] })
  });
  const malformedResult = await runtime.runEngineeringSemanticAdvisory(malformed.options);
  assert.equal(malformedResult.assessmentStatus, 'review_unavailable');
  assert.equal(malformedResult.selectedWorkerResult.taskId, 'task_baseline');
  assert.equal(malformed.revisionCalls, 0, '无有效GoalRef时不得派工');

  const adviceOnly = advisoryOptions(runtime, MockLanguageModelV4, {
    runId: 'run_engineering_review_advice_only', mainDecision: 'DELIVER_WITH_ADVISORY'
  });
  const adviceOnlyResult = await runtime.runEngineeringSemanticAdvisory(adviceOnly.options);
  assert.equal(adviceOnlyResult.recommendation, 'advice_only');
  assert.equal(adviceOnlyResult.revisionAttempted, false);
  assert.equal(adviceOnly.revisionCalls, 0);

  const highScore = advisoryOptions(runtime, MockLanguageModelV4, {
    runId: 'run_engineering_review_high_score',
    assessmentText: 'SCORE_USER_GOAL: 39\nSCORE_ENGINEERING_CLOSURE: 24\nSCORE_CONSISTENCY: 19\nSCORE_EVIDENCE: 13\nTOTAL_SCORE: 95\nRECOMMENDATION: DELIVER',
    mainDecision: 'DELIVER'
  });
  const highScoreResult = await runtime.runEngineeringSemanticAdvisory(highScore.options);
  assert.equal(highScoreResult.baselineScorecard.total, 95);
  assert.equal(highScoreResult.revisionAttempted, false);
  assert.equal(highScoreResult.recommendation, 'no_change');
  assert.equal(highScoreResult.selectedWorkerResult.taskId, 'task_baseline');

  const bounded = advisoryOptions(runtime, MockLanguageModelV4, {
    runId: 'run_engineering_review_bounded', remainingMs: 260_000
  });
  const boundedResult = await runtime.runEngineeringSemanticAdvisory(bounded.options);
  assert.equal(boundedResult.pendingImprovement, true,
    'Assessment可完成但Revision完整链预算不足时必须进入child pending');
  assert.equal(bounded.assessmentModel.doGenerateCalls.length, 1,
    'Reviewer评分本身可达时应先形成建议，不应被Revision最坏预算提前阻断');
  assert.equal(bounded.mainModel.doGenerateCalls.length, 1,
    'Main必须先结合评分和当前资源决定是否请求优化');
  assert.equal(bounded.revisionCalls, 0, '完整链预算不足时不得启动Revision');
  assert(boundedResult.warnings.includes('engineering_revision_deferred_budget'));
  assert.equal(bounded.checkpoints.at(-1)?.phase, 'engineering_improvement_pending');

  const fullBudgetChild = advisoryOptions(runtime, MockLanguageModelV4, {
    runId: 'run_engineering_resume_full_budget_child',
    resumeExecution: engineeringResume('engineering_improvement_pending', {
      assessmentCount: 0, revisionCount: 0, verificationCount: 0
    })
  });
  const fullBudgetChildResult = await runtime.runEngineeringSemanticAdvisory(fullBudgetChild.options);
  assert.equal(fullBudgetChild.assessmentModel.doGenerateCalls.length, 2,
    'child完整链预算充足时才允许执行Assessment与最终Verification');
  assert.equal(fullBudgetChild.mainModel.doGenerateCalls.length, 2);
  assert.equal(fullBudgetChild.revisionCalls, 1,
    'child完整链预算充足时允许一次Engineering Revision');
  assert.equal(fullBudgetChildResult.revisionAdopted, true);
  assert.equal(fullBudgetChildResult.baselineScorecard.total, 45);

  const fullBudgetHighScoreChild = advisoryOptions(runtime, MockLanguageModelV4, {
    runId: 'run_engineering_resume_high_score_child',
    assessmentText: 'SCORE_USER_GOAL: 38\nSCORE_ENGINEERING_CLOSURE: 23\nSCORE_CONSISTENCY: 19\nSCORE_EVIDENCE: 14\nTOTAL_SCORE: 94\nRECOMMENDATION: DELIVER',
    mainDecision: 'DELIVER',
    resumeExecution: engineeringResume('engineering_improvement_pending', {
      assessmentCount: 0, revisionCount: 0, verificationCount: 0
    })
  });
  const fullBudgetHighScoreChildResult = await runtime.runEngineeringSemanticAdvisory(
    fullBudgetHighScoreChild.options
  );
  assert.equal(fullBudgetHighScoreChildResult.baselineScorecard.total, 94);
  assert.equal(fullBudgetHighScoreChildResult.revisionAttempted, false);
  assert.equal(fullBudgetHighScoreChildResult.selectedWorkerResult.taskId, 'task_baseline');
  assert.equal(fullBudgetHighScoreChild.mainModel.doGenerateCalls.length, 1);

  const assessmentStarted = advisoryOptions(runtime, MockLanguageModelV4, {
    runId: 'run_engineering_resume_assessment_started',
    resumeExecution: engineeringResume('engineering_assessment_started', {
      assessmentCount: 0, revisionCount: 0, verificationCount: 0
    })
  });
  const assessmentStartedResult = await runtime.runEngineeringSemanticAdvisory(assessmentStarted.options);
  assert.equal(assessmentStarted.assessmentModel.doGenerateCalls.length, 0,
    'assessment_started结果未知时不得盲重试Assessment');
  assert.equal(assessmentStarted.revisionCalls, 0);
  assert.equal(assessmentStartedResult.engineeringCompletionStatus, 'review_unavailable');

  const assessmentCompleted = advisoryOptions(runtime, MockLanguageModelV4, {
    runId: 'run_engineering_resume_assessment_completed',
    assessmentModel: new MockLanguageModelV4({ doGenerate: [generatedText('SCORE_USER_GOAL: 39\nSCORE_ENGINEERING_CLOSURE: 23\nSCORE_CONSISTENCY: 19\nSCORE_EVIDENCE: 13\nTOTAL_SCORE: 94\nRECOMMENDATION: DELIVER\nCOMPARISON: IMPROVED\nVERIFICATION: RESOLVED')] }),
    resumeExecution: engineeringResume('engineering_assessment_completed', {
      assessmentCount: 1, revisionCount: 0, verificationCount: 0,
      scorecard: lowScorecard(),
      issueSummaries: [checkpointIssue()]
    })
  });
  const assessmentCompletedResult = await runtime.runEngineeringSemanticAdvisory(assessmentCompleted.options);
  assert.equal(assessmentCompleted.assessmentModel.doGenerateCalls.length, 1,
    'assessment_completed只允许后续Verification使用assessment模型，不得重跑Assessment');
  assert.equal(assessmentCompleted.mainModel.doGenerateCalls.length, 2,
    'assessment_completed从Main继续优化准入，并在Revision复评后选择一次');
  assert.equal(assessmentCompleted.revisionCalls, 1);
  assert.equal(assessmentCompletedResult.revisionAdopted, true);

  const revisionValidated = advisoryOptions(runtime, MockLanguageModelV4, {
    runId: 'run_engineering_resume_revision_validated',
    assessmentModel: new MockLanguageModelV4({ doGenerate: [generatedText('SCORE_USER_GOAL: 39\nSCORE_ENGINEERING_CLOSURE: 23\nSCORE_CONSISTENCY: 19\nSCORE_EVIDENCE: 13\nTOTAL_SCORE: 94\nRECOMMENDATION: DELIVER\nCOMPARISON: IMPROVED\nVERIFICATION: RESOLVED')] }),
    mainModel: new MockLanguageModelV4({ doGenerate: [generatedText('ADOPT_REVISION')] }),
    resumeExecution: engineeringResume('validated_passed', {
      status: 'engineering_revision_in_progress', assessmentCount: 1,
      mainReentryCount: 1, revisionCount: 1, verificationCount: 0,
      issueSummaries: [checkpointIssue()],
      baselineCandidate: {
        mode: 'standalone_model', fileName: 'model.sysml',
        content: 'package Thermal { part def Baseline; }'
      },
      baselineValidation: passedResult('run_baseline_projection', 'task_baseline_projection', 'package Thermal { part def Baseline; }').validation
    })
  });
  revisionValidated.options.baselineWorkerResult = revisionValidated.revised;
  const revisionValidatedResult = await runtime.runEngineeringSemanticAdvisory(revisionValidated.options);
  assert.equal(revisionValidated.assessmentModel.doGenerateCalls.length, 1,
    'Revision通用Validator/Repair PASS恢复后只调用一次Verification');
  assert.equal(revisionValidated.mainModel.doGenerateCalls.length, 1,
    '恢复Revision PASS后只执行一次终末Candidate选择');
  assert.equal(revisionValidated.revisionCalls, 0);
  assert.equal(revisionValidatedResult.revisionAdopted, true);
  assert.match(revisionValidatedResult.baselineWorkerResult.candidate.content, /Baseline/u);

  const verificationStarted = advisoryOptions(runtime, MockLanguageModelV4, {
    runId: 'run_engineering_resume_verification_started',
    resumeExecution: engineeringResume('engineering_verification_started', {
      status: 'engineering_verification_started', assessmentCount: 1,
      mainReentryCount: 1, revisionCount: 1, verificationCount: 0,
      issueSummaries: [checkpointIssue()]
    })
  });
  const verificationStartedResult = await runtime.runEngineeringSemanticAdvisory(verificationStarted.options);
  assert.equal(verificationStarted.assessmentModel.doGenerateCalls.length, 0,
    'verification_started结果未知时不得重跑Verification');
  assert.equal(verificationStarted.mainModel.doGenerateCalls.length, 0);
  assert.equal(verificationStarted.revisionCalls, 0);
  assert.equal(verificationStartedResult.revisionDelivered, false,
    'Verification结果未知时不得盲选Revision，必须保留已通过Validator的基线');
  assert.equal(verificationStartedResult.engineeringResolution, 'not_assessed');

  const verificationCompleted = advisoryOptions(runtime, MockLanguageModelV4, {
    runId: 'run_engineering_resume_verification_completed',
    resumeExecution: engineeringResume('engineering_verification_completed', {
      status: 'engineering_verification_completed', assessmentCount: 1,
      mainReentryCount: 1, revisionCount: 1, verificationCount: 1,
      verification: 'resolved', revisionAdopted: true,
      issueSummaries: [checkpointIssue()],
      baselineCandidate: {
        mode: 'standalone_model', fileName: 'model.sysml',
        content: 'package Thermal { part def Baseline; }'
      },
      baselineValidation: passedResult('run_terminal_baseline', 'task_terminal_baseline', 'package Thermal { part def Baseline; }').validation
    })
  });
  verificationCompleted.options.baselineWorkerResult = verificationCompleted.revised;
  const verificationCompletedResult = await runtime.runEngineeringSemanticAdvisory(verificationCompleted.options);
  assert.equal(verificationCompletedResult.revisionAdopted, true,
    'verification_completed恢复必须复用服务端已确认的Revision采用结论');
  assert.equal(verificationCompletedResult.selectedWorkerResult.taskId, 'task_revision');
  assert.equal(verificationCompleted.assessmentModel.doGenerateCalls.length, 0);
  assert.equal(verificationCompleted.mainModel.doGenerateCalls.length, 0);
  assert.equal(verificationCompleted.revisionCalls, 0);

  assert.equal(
    advisoryRuntime.deriveEngineeringAdvisoryResumePlan(
      engineeringResume('engineering_assessment_completed', {
        assessmentCount: 1, revisionCount: 0, verificationCount: 0,
        issueSummaries: [checkpointIssue()]
      })
    ).action,
    'continue_main'
  );
  const repairContext = productionRuntime.engineeringRevisionRepairContext({
    baselineCandidateContent: 'package Thermal {\n part def Baseline;\n}',
    issues: [{
      issueId: 'eri_test', goalRefId: 'goal_test', sourceId: 'tasksource_root_review',
      goalQuote: '热泵回路', sourceHash: hash('构建Ａ系统，并包含热泵回路。'),
      taskAuthorizationRevisionHash: hash('authorization:构建Ａ系统，并包含热泵回路。'),
      start: 10, end: 14, issue: '未形成对象和关系', suggestion: '补充最小闭环'
    }]
  }, 'package Thermal {\n part def Baseline;\n part def HeatPump;\n}');
  assert.equal(repairContext.goalRefs[0].goalRefId, 'goal_test');
  assert.equal(repairContext.issues[0].issueId, 'eri_test');
  assert(repairContext.baselinePreservation.retainedNonBlankLineRatio > 0,
    'Engineering Validation Repair必须收到服务端派生的baseline preservation摘要');

  console.log('AI Teacher engineering semantic advisory tests passed.');
}

function checkpointIssue() {
  const quote = '热泵回路';
  const source = '构建Ａ系统，并包含热泵回路。';
  return {
    issueId: 'eri_resume_test',
    goalRef: {
      goalRefId: 'goal_resume_test', sourceId: 'tasksource_root_review', quote,
      start: source.indexOf(quote), end: source.indexOf(quote) + quote.length,
      sourceHash: hash(source), taskAuthorizationRevisionHash: hash(`authorization:${source}`)
    },
    issue: '基线未形成热泵回路对象和关系。',
    suggestion: '补充对应对象与关系。'
  };
}

function engineeringResume(phase, engineering) {
  return {
    version: 'teacher-execution-resume-v1',
    lineageRootRunId: 'run_engineering_resume_root',
    checkpointId: `checkpoint_${phase}`,
    revision: 1,
    decision: {
      version: 'teacher-resume-decision-v1', phase,
      allowedActions: ['engineering_resume'], stale: false, staleReasons: [],
      requestRevisionHash: hash('request'), taskContractHash: hash('task'),
      editorBaseHash: hash('editor'), repairRound: 0,
      continuationKind: 'engineering_improvement'
    },
    worker: {},
    continuationKind: 'engineering_improvement',
    engineering: {
      status: engineering.status || phase,
      continuationKind: 'engineering_improvement',
      assessmentCount: engineering.assessmentCount || 0,
      mainReentryCount: engineering.mainReentryCount || 0,
      revisionCount: engineering.revisionCount || 0,
      verificationCount: engineering.verificationCount || 0,
      verification: engineering.verification || 'not_run',
      revisionAdopted: engineering.revisionAdopted === true,
      scorecard: engineering.scorecard,
      taskGoalRefs: engineering.taskGoalRefs || [],
      issueSummaries: engineering.issueSummaries || [],
      baselineCandidate: engineering.baselineCandidate,
      baselineValidation: engineering.baselineValidation
    }
  };
}

function lowScorecard() {
  return {
    userGoalCoverage: 18,
    engineeringClosure: 10,
    consistencyAndPreservation: 12,
    evidenceAndUncertainty: 5,
    total: 45,
    reviewerRecommendation: 'optimize'
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
