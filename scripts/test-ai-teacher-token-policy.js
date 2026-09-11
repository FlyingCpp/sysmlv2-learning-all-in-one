'use strict';

const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'test';
process.env.AI_TEACHER_INTERNAL_TOKEN = 'test-teacher-internal-token';
delete process.env.AUTH_DATABASE_URL;
delete process.env.BETTER_AUTH_DATABASE_URL;

const { createAccountStore } = require('../apps/api/account-store');

async function main() {
  const teacherRequests = [];
  const teacherServer = createMockTeacherServer(teacherRequests);
  await listen(teacherServer, 0);
  process.env.TEACHER_URL = `http://127.0.0.1:${teacherServer.address().port}`;

  const { createServer } = require('../apps/api/server');
  const accountStore = createAccountStore({
    aiTeacherTierPolicies: {
      plus: { enabled: true, dailyTokenLimit: 20000, weeklyTokenLimit: 7000, monthlyTokenLimit: 1000 }
    }
  });
  const authService = createStubAuthService(accountStore);
  const apiServer = createServer({
    courseStore: createStubCourseStore(),
    authService,
    aiTeacherEnabled: true
  });
  await listen(apiServer, 0);
  const base = `http://127.0.0.1:${apiServer.address().port}`;

  const guestDenied = await postJsonExpectStatus(`${base}/api/teacher/answer`, teacherBody('guest-deny'), 403, userHeaders('guest'));
  assert.strictEqual(guestDenied.code, 'PERMISSION_DENIED');
  assert.strictEqual(teacherRequests.length, 0, 'guest deny must not call Teacher sidecar');

  const freeAnswer = await postJson(`${base}/api/teacher/answer`, teacherBody('free-within'), userHeaders('free'));
  assert.strictEqual(freeAnswer.requestId, 'free-within');
  assert.strictEqual(teacherRequests.length, 1, 'registered free user within quota should call Teacher once');
  const freeSummary = await getJson(`${base}/api/account/usage/ai`, userHeaders('free'));
  assert.strictEqual(freeSummary.tokenQuota.enabled, true);
  assert.strictEqual(freeSummary.tokenQuota.dailyTokenLimit, 20000);
  assert.strictEqual(freeSummary.tokenQuota.weeklyTokenLimit, 80000);

  await accountStore.recordAiExchange({
    userId: 'free-daily',
    tenantId: 'local-dev',
    capability: 'answer',
    prompt: 'seed',
    reply: 'seed',
    tokenUsage: { promptTokens: 9995, completionTokens: 10000, totalTokens: 19995 },
    usageSource: 'provider'
  });
  const beforeFreeOverage = teacherRequests.length;
  await postJson(
    `${base}/api/teacher/answer`,
    teacherBody('free-daily-overage', '请解释 SysML v2 requirement verification and validation context'),
    userHeaders('free-daily')
  );
  assert.strictEqual(teacherRequests.length, beforeFreeOverage + 1,
    'non-zero balance must admit the whole conversation even when actual usage exceeds the limit');
  const freeOverageSummary = await getJson(`${base}/api/account/usage/ai`, userHeaders('free-daily'));
  assert.strictEqual(freeOverageSummary.tokenQuota.dailyRemainingTokens, 0,
    'an over-limit completed conversation must clamp the remaining balance to zero');
  const beforeFreeQuotaDeny = teacherRequests.length;
  const freeQuotaDenied = await postJsonExpectStatus(
    `${base}/api/teacher/answer`,
    teacherBody('free-daily-deny-after-overage', '下一轮应在开始前被拒绝'),
    429,
    userHeaders('free-daily')
  );
  assert.strictEqual(freeQuotaDenied.code, 'AI_TEACHER_QUOTA_EXCEEDED');
  assert.strictEqual(teacherRequests.length, beforeFreeQuotaDeny,
    'zero balance must deny the next conversation before Teacher sidecar');

  const plusAnswer = await postJson(`${base}/api/teacher/answer`, teacherBody('plus-within'), userHeaders('plus-ok'));
  assert.strictEqual(plusAnswer.requestId, 'plus-within');
  assert(!JSON.stringify(plusAnswer).includes('tokenUsage'), 'public response must not expose token usage fields');
  assert.strictEqual(teacherRequests.length, 3, 'plus user within quota should call Teacher once');

  const beforeAutomaticContinuation = teacherRequests.length;
  const automaticContinuation = await postJson(
    `${base}/api/teacher/answer`,
    teacherBody('plus-auto'),
    userHeaders('plus-auto')
  );
  assert.strictEqual(automaticContinuation.continuation?.autoContinuationUsed, true, JSON.stringify(automaticContinuation));
  assert.strictEqual(automaticContinuation.continuation?.status, 'user_confirmation_required');
  assert.strictEqual(automaticContinuation.continuation?.canContinue, true);
  assert(automaticContinuation.continuation?.completedItems?.length > 0);
  assert(automaticContinuation.continuation?.remainingItems?.length > 0);
  const automaticRequests = teacherRequests.slice(beforeAutomaticContinuation);
  assert.strictEqual(automaticRequests.length, 2, 'deadline partial must create exactly one automatic continuation request');
  assert.strictEqual(automaticRequests[1].body.requestId, 'plus-auto:auto-1');
  assert.strictEqual(automaticRequests[1].body.automaticContinuationSourceRunId, 'run_automatic-source-1234');

  const beforeAutomaticStream = teacherRequests.length;
  const automaticStream = await postNdjson(
    `${base}/api/teacher/answer-stream`,
    teacherBody('plus-auto-stream'),
    userHeaders('plus-auto-stream')
  );
  assert.strictEqual(automaticStream.status, 200);
  assert.strictEqual(automaticStream.events.filter((event) => event.type === 'continuation_started').length, 1);
  const automaticStreamFinal = automaticStream.events.findLast((event) => event.type === 'final');
  assert.strictEqual(automaticStreamFinal?.continuation?.autoContinuationUsed, true);
  assert.strictEqual(automaticStreamFinal?.continuation?.status, 'user_confirmation_required');
  assert.strictEqual(teacherRequests.slice(beforeAutomaticStream).length, 2,
    'streaming deadline partial must also create exactly one automatic continuation request');

  const automaticStreamRecovered = await postNdjson(
    `${base}/api/teacher/answer-stream`,
    {
      ...teacherBody('plus-auto-stream-recover'),
      threadId: 'thread_recover-12345678'
    },
    userHeaders('plus-auto-stream-recover')
  );
  assert.strictEqual(automaticStreamRecovered.status, 200);
  assert.strictEqual(automaticStreamRecovered.events.filter((event) => event.type === 'continuation_started').length, 1);
  const recoveredFinal = automaticStreamRecovered.events.findLast((event) => event.type === 'final');
  assert.strictEqual(recoveredFinal?.directAnswer, '持久化的自动续跑终态。');
  assert.strictEqual(recoveredFinal?.continuation?.sourceRunId, 'run_recover-child-12345678');
  assert.strictEqual(recoveredFinal?.continuation?.status, 'user_confirmation_required');

  await accountStore.recordAiExchange({
    userId: 'free-auto-overage',
    tenantId: 'local-dev',
    capability: 'answer',
    prompt: 'seed',
    reply: 'seed',
    tokenUsage: { promptTokens: 9990, completionTokens: 10000, totalTokens: 19990 },
    usageSource: 'provider'
  });
  const beforeOverageContinuation = teacherRequests.length;
  const overageContinuation = await postJson(
    `${base}/api/teacher/answer`,
    teacherBody('free-auto-overage'),
    userHeaders('free-auto-overage')
  );
  assert.strictEqual(overageContinuation.continuation?.autoContinuationUsed, true);
  assert.strictEqual(teacherRequests.slice(beforeOverageContinuation).length, 2,
    'the unique automatic continuation belongs to the admitted conversation and must not recheck a zero balance');
  const overageContinuationSummary = await getJson(
    `${base}/api/account/usage/ai`,
    userHeaders('free-auto-overage')
  );
  assert.strictEqual(overageContinuationSummary.tokenQuota.dailyRemainingTokens, 0);

  const plusSummary = await getJson(`${base}/api/account/usage/ai`, userHeaders('plus-ok'));
  assert.strictEqual(plusSummary.totalTokens, 24, 'ledger must use Teacher tokenUsage instead of directAnswer character estimate');
  assert.strictEqual(plusSummary.dailyTokens, 24);
  assert.strictEqual(plusSummary.weeklyTokens, 24);
  assert.strictEqual(plusSummary.monthlyTokens, 24);
  assert.strictEqual(plusSummary.tokenQuota.dailyTokenLimit, 20000);
  assert.strictEqual(plusSummary.tokenQuota.weeklyTokenLimit, 7000);
  assert.strictEqual(plusSummary.tokenQuota.dailyRemainingTokens, 19976);

  const concurrentReservations = await Promise.all([
    accountStore.reserveAiTeacherBudget({
      user: { id: 'plus-concurrent', tier: 'plus' },
      tenantId: 'local-dev',
      requestId: 'concurrent-a',
      capability: 'answer',
      estimatedTokens: 4000
    }),
    accountStore.reserveAiTeacherBudget({
      user: { id: 'plus-concurrent', tier: 'plus' },
      tenantId: 'local-dev',
      requestId: 'concurrent-b',
      capability: 'answer',
      estimatedTokens: 4000
    })
  ]);
  const admittedReservations = concurrentReservations.filter((decision) => decision.allowed);
  assert.strictEqual(admittedReservations.length, 2,
    'conversation admission does not predict or pre-deduct concurrent run usage while the observed balance is non-zero');
  const heldSummary = await accountStore.getAiUsageSummary('plus-concurrent', { user: { id: 'plus-concurrent', tier: 'plus' } });
  assert.strictEqual(heldSummary.reservedDailyTokens, 0);
  assert.strictEqual(heldSummary.reservedWeeklyTokens, 0);
  assert.strictEqual(heldSummary.tokenQuota.weeklyRemainingTokens, 7000);
  await accountStore.recordAiExchange({
    userId: 'plus-concurrent',
    tenantId: 'local-dev',
    requestId: admittedReservations[0].reservationId === concurrentReservations[0].reservationId ? 'concurrent-a' : 'concurrent-b',
    capability: 'answer',
    prompt: '并发预算结算',
    reply: '完成',
    tokenUsage: { promptTokens: 10, completionTokens: 14, totalTokens: 24 },
    usageSource: 'provider',
    budgetReservationId: admittedReservations[0].reservationId
  });
  const settledSummary = await accountStore.getAiUsageSummary('plus-concurrent', { user: { id: 'plus-concurrent', tier: 'plus' } });
  assert.strictEqual(settledSummary.weeklyTokens, 24, 'settlement must record actual metered usage without a predicted hold');
  assert.strictEqual(settledSummary.reservedWeeklyTokens, 0);
  assert.strictEqual(settledSummary.tokenQuota.weeklyRemainingTokens, 6976);
  await accountStore.releaseAiTeacherBudget({
    reservationId: admittedReservations[1].reservationId,
    userId: 'plus-concurrent',
    reason: 'test_cleanup'
  });

  const releasedReservation = await accountStore.reserveAiTeacherBudget({
    user: { id: 'plus-release', tier: 'plus' },
    tenantId: 'local-dev',
    requestId: 'release-a',
    capability: 'answer',
    estimatedTokens: 6000
  });
  assert.strictEqual(releasedReservation.allowed, true);
  await accountStore.releaseAiTeacherBudget({
    reservationId: releasedReservation.reservationId,
    userId: 'plus-release',
    tenantId: 'local-dev',
    requestId: 'release-a',
    capability: 'answer',
    reason: 'test_run_failed'
  });
  const releasedSummary = await accountStore.getAiUsageSummary('plus-release', { user: { id: 'plus-release', tier: 'plus' } });
  assert.strictEqual(releasedSummary.reservedWeeklyTokens, 0, 'released runs must not leave a zombie budget hold');
  const retryAfterRelease = await accountStore.reserveAiTeacherBudget({
    user: { id: 'plus-release', tier: 'plus' },
    tenantId: 'local-dev',
    requestId: 'release-a',
    capability: 'answer',
    estimatedTokens: 6000
  });
  assert.strictEqual(retryAfterRelease.allowed, true, 'a request ID may retry after its failed reservation was released');
  await accountStore.releaseAiTeacherBudget({
    reservationId: retryAfterRelease.reservationId,
    userId: 'plus-release',
    reason: 'test_cleanup'
  });

  await postJsonExpectStatus(`${base}/api/teacher/answer`, teacherBody('plus-failure-release'), 503, userHeaders('plus-failure'));
  const failedRunSummary = await getJson(`${base}/api/account/usage/ai`, userHeaders('plus-failure'));
  assert.strictEqual(failedRunSummary.reservedWeeklyTokens, 0, 'API failure paths must release their budget reservation');

  await accountStore.recordAiExchange({
    userId: 'plus-daily',
    tenantId: 'local-dev',
    capability: 'answer',
    prompt: 'seed',
    reply: 'seed',
    tokenUsage: { promptTokens: 10000, completionTokens: 10000, totalTokens: 20000 },
    usageSource: 'provider'
  });
  const beforeDailyDeny = teacherRequests.length;
  const dailyDenied = await postJsonExpectStatus(`${base}/api/teacher/answer`, teacherBody('daily-deny', '请解释 SysML v2 package and part usage with enough context'), 429, userHeaders('plus-daily'));
  assert.strictEqual(dailyDenied.code, 'AI_TEACHER_QUOTA_EXCEEDED');
  assert.strictEqual(dailyDenied.error, '今日 AI Teacher tokens 已用完，明日重置后可继续使用。');
  assert.strictEqual(teacherRequests.length, beforeDailyDeny, 'daily quota deny must happen before Teacher sidecar');

  await accountStore.recordAiExchange({
    userId: 'plus-weekly',
    tenantId: 'local-dev',
    capability: 'answer',
    prompt: 'seed',
    reply: 'seed',
    tokenUsage: { promptTokens: 3495, completionTokens: 3500, totalTokens: 6995 },
    usageSource: 'provider'
  });
  const beforeWeeklyOverage = teacherRequests.length;
  await postJson(
    `${base}/api/teacher/answer`,
    teacherBody('weekly-overage', '请解释 SysML v2 port flow allocation'),
    userHeaders('plus-weekly')
  );
  assert.strictEqual(teacherRequests.length, beforeWeeklyOverage + 1,
    'a positive weekly balance must admit the conversation without predicted-token rejection');
  const weeklyOverageSummary = await getJson(`${base}/api/account/usage/ai`, userHeaders('plus-weekly'));
  assert.strictEqual(weeklyOverageSummary.tokenQuota.weeklyRemainingTokens, 0);
  const beforeWeeklyDeny = teacherRequests.length;
  const weeklyDenied = await postJsonExpectStatus(`${base}/api/teacher/answer`, teacherBody('weekly-deny', '请解释 SysML v2 port flow allocation'), 429, userHeaders('plus-weekly'));
  assert.strictEqual(weeklyDenied.code, 'AI_TEACHER_QUOTA_EXCEEDED');
  assert.strictEqual(weeklyDenied.error, '本周 AI Teacher tokens 已用完，下周重置后可继续使用。');
  assert.strictEqual(teacherRequests.length, beforeWeeklyDeny, 'weekly quota deny must happen before Teacher sidecar');

  await accountStore.recordAiExchange({
    userId: 'free-stream',
    tenantId: 'local-dev',
    capability: 'answer',
    prompt: 'seed',
    reply: 'seed',
    tokenUsage: { promptTokens: 9995, completionTokens: 10000, totalTokens: 19995 },
    usageSource: 'provider'
  });
  const beforeStreamOverage = teacherRequests.length;
  const streamOverage = await postNdjson(
    `${base}/api/teacher/answer-stream`,
    teacherBody('stream-overage', '请解释 SysML v2 requirement verification and validation context'),
    userHeaders('free-stream')
  );
  assert.strictEqual(streamOverage.status, 200);
  assert.strictEqual(teacherRequests.length, beforeStreamOverage + 1);
  const streamOverageSummary = await getJson(`${base}/api/account/usage/ai`, userHeaders('free-stream'));
  assert.strictEqual(streamOverageSummary.tokenQuota.dailyRemainingTokens, 0);
  const beforeStreamDeny = teacherRequests.length;
  const streamDenied = await postNdjson(`${base}/api/teacher/answer-stream`, teacherBody('stream-deny', '下一轮应拒绝'), userHeaders('free-stream'));
  assert.strictEqual(streamDenied.status, 429);
  assert(streamDenied.events.some((event) => event.code === 'AI_TEACHER_QUOTA_EXCEEDED'));
  assert(streamDenied.events.some((event) => event.message === '今日 AI Teacher tokens 已用完，明日重置后可继续使用。'));
  assert.strictEqual(teacherRequests.length, beforeStreamDeny, 'stream quota preflight deny must not open Teacher stream');

  const quotaEvents = await accountStore.listAiQuotaEvents({ limit: 100 });
  const plusReservationEvent = quotaEvents.find((event) => event.userId === 'plus-ok' && event.decision === 'reserve');
  assert.strictEqual(plusReservationEvent?.metadata?.admissionMode, 'balance_nonzero');
  assert.strictEqual(plusReservationEvent?.metadata?.estimationUsedForAdmission, false,
    'account admission must not predict the current conversation token usage');
  assert(/^arp_/.test(plusReservationEvent.metadata.resourcePolicyVersion),
    'budget reservation audit must bind the Agent resource policy version reused by the run');
  assert(quotaEvents.some((event) => event.userId === 'plus-daily' && event.reason === 'daily_quota_exceeded'), 'daily deny should be recorded in quota events');
  assert(quotaEvents.some((event) => event.userId === 'plus-weekly' && event.reason === 'weekly_quota_exceeded'), 'weekly deny should be recorded in quota events');
  assert(quotaEvents.some((event) => event.userId === 'free-stream' && event.reason === 'daily_quota_exceeded'), 'stream deny should be recorded in quota events');

  await close(apiServer);
  await close(teacherServer);
  console.log('ai teacher token policy tests passed');
}

function createMockTeacherServer(requests) {
  return http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    const parsed = body ? JSON.parse(body) : {};
    const teacherUrl = new URL(req.url, 'http://teacher.local');
    if (req.method === 'GET' && req.url === '/v1/capabilities') {
      return sendJson(res, 200, {
        supportedRuntimes: ['ai-sdk'],
        runtimeReadiness: { 'ai-sdk': true },
        agentRuntime: { ready: true, answerMode: 'result_bound_v2' },
        toolSchemaVersion: 'single-entry-v3',
        buildVersion: 'test-agent-build',
        retrieval: {
          mode: 'postgres_pgvector',
          ready: true,
          activeBundle: {
            bundleId: 'sysml20-model-user-v002',
            sourceRegistryHash: `sha256:${'1'.repeat(64)}`,
            contentHash: `sha256:${'2'.repeat(64)}`
          }
        }
      });
    }
    if (req.method === 'GET'
      && teacherUrl.pathname === '/v1/teacher/threads/thread_recover-12345678/messages') {
      const recoveryRequest = [...requests].reverse()
        .find((item) => item.body?.requestId === 'plus-auto-stream-recover:auto-1')?.body || {};
      return sendJson(res, 200, {
        threadId: 'thread_recover-12345678',
        messages: [{
          messageId: 'msg_recover-child-12345678',
          threadId: 'thread_recover-12345678',
          runId: 'run_recover-child-12345678',
          automaticContinuationSourceRunId: 'run_recover-source-12345678',
          requestId: 'plus-auto-stream-recover:auto-1',
          role: 'assistant',
          status: 'succeeded',
          content: '持久化的自动续跑终态。',
          response: {
            ...mockRuntimeAttestation(recoveryRequest),
            contractVersion: '1.0',
            responseId: 'resp_recover-child-12345678',
            requestId: 'plus-auto-stream-recover:auto-1',
            answerType: 'agentic_answer',
            title: 'Recovered continuation answer',
            confidence: 'medium',
            directAnswer: '持久化的自动续跑终态。',
            answerCompletionStatus: 'incomplete',
            sections: [], patches: [], evidence: [], warnings: [], learningEvents: [],
            validatorStatus: 'not_applicable',
            continuation: {
              kind: 'execution_completion',
              status: 'user_confirmation_required',
              sourceRunId: 'run_recover-child-12345678',
              autoContinuationUsed: true,
              canContinue: true,
              completedItems: [{ title: '已形成阶段性回答', status: 'completed' }],
              remainingItems: [{ title: '完成剩余任务', status: 'remaining' }]
            },
            tokenUsage: { promptTokens: 10, completionTokens: 15, totalTokens: 25 }
          }
        }]
      });
    }
    if (req.method === 'POST' && req.url === '/v1/teacher/answer') {
      requests.push({ method: req.method, path: req.url, body: parsed });
      if (parsed.requestId === 'plus-failure-release') {
        return sendJson(res, 503, { code: 'TEACHER_PROVIDER_UNAVAILABLE', message: 'mock provider unavailable' });
      }
      if (parsed.requestId === 'plus-auto' || parsed.requestId === 'free-auto-overage') {
        return sendJson(res, 200, {
          ...mockRuntimeAttestation(parsed),
          contractVersion: '1.0',
          responseId: 'resp_plus_auto_source',
          requestId: parsed.requestId,
          answerType: 'agentic_answer',
          title: 'Mock partial answer',
          confidence: 'medium',
          directAnswer: '第一轮已经形成阶段性回答。',
          answerCompletionStatus: 'incomplete',
          sections: [], patches: [], evidence: [], warnings: [], learningEvents: [],
          validatorStatus: 'not_applicable',
          continuation: {
            status: 'automatic_pending',
            sourceRunId: 'run_automatic-source-1234',
            autoContinuationUsed: false,
            canContinue: false,
            completedItems: [{ title: '已形成阶段性回答', status: 'completed' }],
            remainingItems: [{ title: '完成剩余任务', status: 'remaining' }]
          },
          tokenUsage: { promptTokens: 12, completionTokens: 18, totalTokens: 30 }
        });
      }
      if (parsed.requestId === 'plus-auto:auto-1' || parsed.requestId === 'free-auto-overage:auto-1') {
        return sendJson(res, 200, {
          ...mockRuntimeAttestation(parsed),
          contractVersion: '1.0',
          responseId: 'resp_plus_auto_final',
          requestId: parsed.requestId,
          answerType: 'agentic_answer',
          title: 'Mock continuation answer',
          confidence: 'medium',
          directAnswer: '第二轮已经结束，仍有部分工作未完成。',
          answerCompletionStatus: 'incomplete',
          sections: [], patches: [], evidence: [], warnings: [], learningEvents: [],
          validatorStatus: 'not_applicable',
          continuation: {
            status: 'user_confirmation_required',
            sourceRunId: 'run_automatic-source-1234',
            autoContinuationUsed: true,
            canContinue: true,
            completedItems: [{ title: '已形成阶段性回答', status: 'completed' }],
            remainingItems: [{ title: '完成剩余任务', detail: '自动续跑达到执行上限。', status: 'remaining' }]
          },
          tokenUsage: { promptTokens: 14, completionTokens: 21, totalTokens: 35 }
        });
      }
      return sendJson(res, 200, {
        ...mockRuntimeAttestation(parsed),
        contractVersion: '1.0',
        responseId: `resp_${parsed.requestId || 'mock'}`,
        requestId: parsed.requestId || '',
        answerType: 'free_question',
        title: 'Mock answer',
        confidence: 'medium',
        directAnswer: 'This intentionally long public answer should not be used as the authoritative metered token count for account quota.',
        sections: [],
        patches: [],
        evidence: [],
        validatorStatus: 'not_applicable',
        warnings: [],
        learningEvents: [],
        tokenUsage: { promptTokens: 10, completionTokens: 14, totalTokens: 24 }
      });
    }
    if (req.method === 'POST' && req.url === '/v1/teacher/answer-stream') {
      requests.push({ method: req.method, path: req.url, body: parsed });
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
      if (parsed.requestId === 'plus-auto-stream-recover') {
        res.write(`${JSON.stringify({
          type: 'start',
          ...mockRuntimeAttestation(parsed),
          threadId: 'thread_recover-12345678',
          runId: 'run_recover-source-12345678'
        })}\n`);
        res.end(`${JSON.stringify({
          type: 'final',
          ...mockRuntimeAttestation(parsed),
          threadId: 'thread_recover-12345678',
          runId: 'run_recover-source-12345678',
          contractVersion: '1.0',
          responseId: 'resp_recover-source-12345678',
          requestId: parsed.requestId,
          answerType: 'agentic_answer',
          title: 'Mock stream partial',
          confidence: 'medium',
          directAnswer: '流式首轮达到执行时限。',
          answerCompletionStatus: 'incomplete',
          sections: [], patches: [], evidence: [], warnings: [], learningEvents: [],
          validatorStatus: 'not_applicable',
          continuation: {
            kind: 'execution_completion',
            status: 'automatic_pending',
            sourceRunId: 'run_recover-source-12345678',
            autoContinuationUsed: false,
            canContinue: false,
            completedItems: [{ title: '已形成阶段性回答', status: 'completed' }],
            remainingItems: [{ title: '完成剩余任务', status: 'remaining' }]
          },
          tokenUsage: { promptTokens: 10, completionTokens: 15, totalTokens: 25 }
        })}\n`);
        return;
      }
      if (parsed.requestId === 'plus-auto-stream-recover:auto-1') {
        res.write(`${JSON.stringify({
          type: 'start',
          ...mockRuntimeAttestation(parsed),
          threadId: 'thread_recover-12345678',
          runId: 'run_recover-child-12345678'
        })}\n`);
        setImmediate(() => res.destroy(new Error('mock child stream transport failure')));
        return;
      }
      if (parsed.requestId === 'plus-auto-stream' || parsed.requestId === 'plus-auto-stream:auto-1') {
        res.write(`${JSON.stringify({ type: 'start', ...mockRuntimeAttestation(parsed) })}\n`);
        const automatic = parsed.requestId.endsWith(':auto-1');
        res.end(`${JSON.stringify({
          type: 'final',
          ...mockRuntimeAttestation(parsed),
          contractVersion: '1.0',
          responseId: automatic ? 'resp_plus_auto_stream_final' : 'resp_plus_auto_stream_source',
          requestId: parsed.requestId,
          answerType: 'agentic_answer',
          title: automatic ? 'Mock stream continuation' : 'Mock stream partial',
          confidence: 'medium',
          directAnswer: automatic ? '流式自动续跑已经结束。' : '流式首轮达到执行时限。',
          answerCompletionStatus: 'incomplete',
          sections: [], patches: [], evidence: [], warnings: [], learningEvents: [],
          validatorStatus: 'not_applicable',
          continuation: {
            status: automatic ? 'user_confirmation_required' : 'automatic_pending',
            sourceRunId: 'run_automatic-stream-1234',
            autoContinuationUsed: automatic,
            canContinue: automatic,
            completedItems: [{ title: '已形成阶段性回答', status: 'completed' }],
            remainingItems: [{ title: '完成剩余任务', status: 'remaining' }]
          },
          tokenUsage: { promptTokens: 10, completionTokens: 15, totalTokens: 25 }
        })}\n`);
        return;
      }
      res.write(`${JSON.stringify({ type: 'delta', text: 'stream' })}\n`);
      res.end(`${JSON.stringify({
        type: 'final',
        ...mockRuntimeAttestation(parsed),
        contractVersion: '1.0',
        responseId: `resp_${parsed.requestId || 'stream'}`,
        requestId: parsed.requestId || '',
        answerType: 'free_question',
        title: 'Mock stream answer',
        confidence: 'medium',
        directAnswer: 'stream',
        sections: [], patches: [], evidence: [], warnings: [], learningEvents: [],
        validatorStatus: 'not_applicable',
        tokenUsage: { promptTokens: 10, completionTokens: 14, totalTokens: 24 }
      })}\n`);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  });
}

function mockRuntimeAttestation(payload) {
  return {
    runtimeUsed: 'ai-sdk',
    runtimeAssignmentId: payload?.runtimeAssignment?.runtimeAssignmentId || '',
    workflowVersion: payload?.runtimeAssignment?.workflowVersion || 'intent-orchestrator-v2',
    toolSchemaVersion: payload?.runtimeAssignment?.toolSchemaVersion || 'single-entry-v3',
    buildVersion: payload?.runtimeAssignment?.buildVersion || 'test-agent-build',
    resourcePolicyVersion: payload?.runtimeAssignment?.resourcePolicySnapshot?.versionId || 'arp_bootstrap_v4',
    resourcePolicyChecksum: payload?.runtimeAssignment?.resourcePolicySnapshot?.checksum || '',
    promptVersion: 'test-feedback-prompt',
    promptHash: `sha256:${'3'.repeat(64)}`,
    temperature: 0,
    reasoningMode: 'provider-managed',
    answerMode: 'result_bound_v2',
    agentTrace: {
      workflowVersion: 'intent-orchestrator-v2',
      status: 'completed',
      workerType: 'main',
      candidateValidated: false,
      stepCount: 1,
      stopReason: 'completed',
      scopeHintCount: 0,
      refusedHintCount: 0,
      gateCallCount: 1,
      gateOutcome: 'pass',
      phaseTimings: []
    },
    knowledgeGrounding: { used: false, uniqueClaimCount: 0, uniqueEvidenceCount: 0 },
    codeBlockValidations: []
  };
}

function createStubAuthService(accountStore) {
  const users = {
    guest: { id: 'guest', tier: 'guest', permissions: ['course.read', 'draft.write'], entitlements: entitlementRecords(['course.read', 'draft.write']) },
    free: freeUser('free'),
    'free-daily': freeUser('free-daily'),
    'free-auto-overage': freeUser('free-auto-overage'),
    'free-stream': freeUser('free-stream'),
    'plus-ok': plusUser('plus-ok'),
    'plus-auto': plusUser('plus-auto'),
    'plus-auto-stream': plusUser('plus-auto-stream'),
    'plus-auto-stream-recover': plusUser('plus-auto-stream-recover'),
    'plus-failure': plusUser('plus-failure'),
    'plus-daily': plusUser('plus-daily'),
    'plus-weekly': plusUser('plus-weekly'),
    'plus-stream': plusUser('plus-stream')
  };
  async function currentUser(req) {
    return users[String(req.headers['x-test-user'] || '')] || null;
  }
  async function requireUser(req) {
    const user = await currentUser(req);
    if (user) return user;
    const error = new Error('请先登录。');
    error.statusCode = 401;
    error.code = 'AUTH_REQUIRED';
    throw error;
  }
  return {
    currentUser,
    requireUser,
    hasEntitlement: (user, code) => Array.isArray(user?.permissions) && user.permissions.includes(code),
    betterAuth: { accountStore }
  };
}

function freeUser(id) {
  return {
    id,
    tier: 'free',
    permissions: ['course.read', 'draft.write', 'progress.write', 'ai.teacher.use'],
    entitlements: entitlementRecords(['course.read', 'draft.write', 'progress.write', 'ai.teacher.use'])
  };
}

function plusUser(id) {
  return {
    id,
    tier: 'plus',
    permissions: ['course.read', 'draft.write', 'progress.write', 'ai.teacher.use'],
    entitlements: entitlementRecords(['course.read', 'draft.write', 'progress.write', 'ai.teacher.use'])
  };
}

function entitlementRecords(codes) {
  return codes.map((code) => ({ code, scope: 'global', scopeRef: '*', source: 'test' }));
}

function createStubCourseStore() {
  return {
    packId: 'test-pack',
    loadPack: () => ({ id: 'test-pack' }),
    loadLesson: (lessonId) => lessonId === 'lesson-01'
      ? {
          id: 'lesson-01',
          courseId: 'course-01',
          title: 'Lesson 1',
          learningGoals: ['Understand part usages.'],
          workspace: {
            entryFile: 'main.sysml',
            files: [{ path: 'main.sysml', content: 'package EV { part def ElectricVehicle; }', editable: true }]
          },
          courseReferences: [],
          courseConceptExplanations: []
        }
      : null
  };
}

function teacherBody(requestId, text = '解释当前 SysML v2 模型') {
  return {
    requestId,
    course: { lessonId: 'lesson-01' },
    editor: {
      entryFile: 'main.sysml',
      activeFilePath: 'main.sysml',
      files: [{ path: 'main.sysml', content: 'package EV { part def ElectricVehicle; }', editable: true }]
    },
    question: { text, intent: 'free_question', hintLevel: 'explain' }
  };
}

function userHeaders(userId) {
  return { 'x-test-user': userId };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!response.ok) assert.fail(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function postJsonExpectStatus(url, body, status, headers = {}) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  assert.strictEqual(response.status, status, `${url} should return ${status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function postNdjson(url, body, headers = {}) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson', ...headers }, body: JSON.stringify(body) });
  const text = await response.text();
  const events = text.trim()
    ? text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { status: response.status, events, text };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
