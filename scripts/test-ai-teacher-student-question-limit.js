'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const {
  createConfigForEvaluation,
  createServer,
  studentQuestionAdmissionForTests
} = require('../apps/teacher/server');
const { conversationStoreTesting } = require('../apps/teacher/conversation-store');

const root = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'ai-teacher-student-question-limit.json'),
  'utf8'
));
const hostFixture = JSON.parse(fs.readFileSync(
  path.join(root, 'packages', 'teacher-contract', 'fixtures', 'host-context-basic.json'),
  'utf8'
));

async function main() {
  const { agentRunRequestSchema } = await import('../apps/teacher/dist/agent/index.mjs');
  assert.equal(Buffer.from(fixture.prefix, 'utf8').toString('utf8'), fixture.prefix);
  const accepted = exactLength(fixture.prefix, fixture.acceptedCharacters);
  const atBoundary = exactLength(fixture.prefix, fixture.policyBoundaryCharacters);
  const rejected = exactLength(fixture.prefix, fixture.rejectedCharacters);
  const config = createConfigForEvaluation({
    providerMode: 'mock',
    providerEnabled: true,
    internalToken: 'student-question-limit-internal-token',
    toolToken: 'student-question-limit-tool-token',
    knowledge: { async debug() { return {}; } },
    skillSource: { async retrieve() { return []; } },
    conversation: { async close() {} }
  });

  const acceptedContext = contextWithQuestion(accepted);
  assert.doesNotThrow(() => (
    studentQuestionAdmissionForTests.assertStudentQuestionWithinPolicy(acceptedContext, config)
  ));
  assert.doesNotThrow(() => (
    studentQuestionAdmissionForTests.assertStudentQuestionWithinPolicy(contextWithQuestion(atBoundary), config)
  ));
  assert.throws(
    () => studentQuestionAdmissionForTests.assertStudentQuestionWithinPolicy(contextWithQuestion(rejected), config),
    (error) => error?.code === 'STUDENT_QUESTION_TOO_LONG' && error?.statusCode === 400
  );

  const resumed = conversationStoreTesting.boundedResumeQuestion(accepted);
  assert.equal(resumed.length, fixture.acceptedCharacters);
  assert.equal(hash(resumed), hash(accepted), '8101字符运行环境复测原文不得在续跑边界被截为8000字符。');

  const parsed = agentRunRequestSchema.parse({
    runId: 'run_student_question_limit_01',
    question: accepted,
    currentStudentQuestion: accepted,
    taskSources: [],
    capabilityGrant: [],
    resumeContext: {
      sourceRunId: 'run_student_question_source_01',
      fastGate: {
        version: 'fast-gate-pass-through-v2-phase2',
        outcome: 'pass',
        firstSignal: 'PASS',
        mixedScopeRisk: false,
        decisionStatus: 'completed',
        originalQuestionHash: `sha256:${'1'.repeat(64)}`
      },
      sourceStudentQuestion: accepted,
      priorToolLedger: []
    },
    context: agentContext()
  });
  assert.equal(hash(parsed.currentStudentQuestion), hash(accepted));
  assert.equal(hash(parsed.resumeContext.sourceStudentQuestion), hash(accepted));

  await assertHttpAdmissionRejectsBeforePersistence(rejected);
  console.log(JSON.stringify({
    fixtureSetId: fixture.fixtureSetId,
    acceptedCharacters: accepted.length,
    policyBoundaryCharacters: atBoundary.length,
    rejectedCharacters: rejected.length,
    acceptedHash: hash(accepted),
    resumeHashMatch: hash(resumed) === hash(accepted),
    overLimitHttpStatus: 400,
    threadCreated: false,
    runCreated: false
  }));
}

async function assertHttpAdmissionRejectsBeforePersistence(question) {
  const calls = { ensureThread: 0, createRun: 0 };
  const conversation = {
    async ensureThread() { calls.ensureThread += 1; return { threadId: 'thread_should_not_exist' }; },
    async createRun() { calls.createRun += 1; return { runId: 'run_should_not_exist' }; },
    async close() {}
  };
  const server = createServer({
    providerMode: 'mock',
    providerEnabled: true,
    internalToken: 'student-question-limit-internal-token',
    toolToken: 'student-question-limit-tool-token',
    knowledge: { async debug() { return {}; } },
    skillSource: { async retrieve() { return []; } },
    conversation
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/teacher/answer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ai-teacher-token': 'student-question-limit-internal-token'
      },
      body: JSON.stringify(contextWithQuestion(question))
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error?.code, 'STUDENT_QUESTION_TOO_LONG');
    assert.deepEqual(calls, { ensureThread: 0, createRun: 0 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function contextWithQuestion(question) {
  const context = structuredClone(hostFixture);
  context.requestId = `req_student_question_${question.length}`;
  context.threadId = `thread_student_question_${question.length}`;
  context.question = { ...context.question, text: question };
  return context;
}

function agentContext() {
  return {
    tenantId: 'tenant-limit-test',
    userId: 'user-limit-test',
    threadId: 'thread-limit-test',
    lesson: {
      courseId: 'course-limit-test',
      lessonId: 'lesson-limit-test',
      title: '字符上限复测',
      objectives: [],
      taskHints: [],
      courseRules: []
    },
    model: {
      files: [{
        fileId: 'file-limit-test',
        displayName: 'main.sysml',
        content: 'package LimitTest {}',
        contentHash: `sha256:${'2'.repeat(64)}`,
        editable: true
      }],
      diagnostics: []
    }
  };
}

function exactLength(prefix, target) {
  assert(target >= prefix.length);
  return `${prefix}${'测'.repeat(target - prefix.length)}`;
}

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
