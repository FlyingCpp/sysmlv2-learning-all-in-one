'use strict';

const assert = require('node:assert/strict');
const { createMemoryConversationStore } = require('../apps/teacher/conversation-store');
const {
  authorizedTaskSourcesForTests,
  projectConversationMessagesForAgentForTests
} = require('../apps/teacher/agent-adapter');

function context(question, requestId) {
  return {
    tenantId: 'tenant-message-test',
    userId: 'user-message-test',
    requestId,
    question: { text: question },
    course: { coursePackId: 'pack-message-test', courseId: 'course-message-test' }
  };
}

async function main() {
  const rootQuestion = '创建混合动力 SUV 架构模型。';
  const clarificationQuestion = '请补充动力源和接口范围。';
  const clarificationAnswer = '使用发动机和电池，不考虑接口。';
  const store = createMemoryConversationStore();
  const rootContext = context(rootQuestion, 'request-message-root');
  const { threadId } = await store.createThread(rootContext);
  const sourceRun = await store.createRun({
    threadId,
    context: rootContext,
    intent: 'single_entry',
    route: 'agent'
  });
  const checkpointId = 'checkpoint_message_continuity';
  await store.pauseRunForClarification({
    runId: sourceRun.runId,
    context: rootContext,
    response: {
      directAnswer: clarificationQuestion,
      answerCompletionStatus: 'waiting_for_clarification'
    },
    providerMeta: {
      agent: {
        fastGatePassThroughV2: {
          version: 'fast-gate-v2',
          outcome: 'pass',
          mixedScopeRisk: false,
          originalQuestionHash: `sha256:${'1'.repeat(64)}`,
          decisionStatus: 'completed'
        }
      }
    },
    checkpoint: {
      checkpointId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      includeSourceStudentQuestion: true
    }
  });

  const resumedContext = context(clarificationAnswer, 'request-message-resume');
  const resumed = await store.createResumedRun({
    threadId,
    context: resumedContext,
    intent: 'single_entry',
    route: 'agent',
    checkpointId
  });
  assert.equal(resumed.reused, false);
  assert.deepEqual(
    resumed.workflowResume.taskSources.map((source) => [source.relation, source.text]),
    [
      ['root_user_request', rootQuestion],
      ['clarification_user_answer', clarificationAnswer]
    ],
    '澄清恢复必须从新Run回溯，不能丢失当前回答'
  );
  assert.equal(
    new Set(resumed.workflowResume.taskSources.map((source) => source.taskAuthorizationRevisionHash)).size,
    1,
    '同一TaskSourceSet必须共享服务端授权修订Hash'
  );

  const transcript = await store.listSuccessfulMessages(threadId, 8);
  assert.deepEqual(
    transcript.map((message) => [message.role, message.content]),
    [
      ['user', rootQuestion],
      ['assistant', clarificationQuestion],
      ['user', clarificationAnswer]
    ],
    'Provider Transcript必须保留user/assistant真实角色和当前澄清回答'
  );

  const hostContext = {
    ...resumedContext,
    threadId,
    conversation: { recentMessages: transcript }
  };
  const conversationMessages = projectConversationMessagesForAgentForTests(
    hostContext,
    rootQuestion
  );
  assert.deepEqual(
    conversationMessages.map((message) => message.role),
    ['user', 'assistant', 'user'],
    'Adapter不得再把多轮历史压成单个user字符串'
  );
  const taskSources = authorizedTaskSourcesForTests(hostContext, resumed.workflowResume);
  assert.deepEqual(
    taskSources.map((source) => source.text),
    [rootQuestion, clarificationAnswer],
    'Adapter必须保留持久化TaskSourceSet'
  );

  const runtime = await import('../apps/teacher/dist/agent/index.mjs');
  const providerMessages = runtime.projectConversationModelMessages(
    conversationMessages,
    taskSources,
    rootQuestion
  );
  const providerWire = JSON.stringify(providerMessages);
  assert(providerWire.includes(rootQuestion));
  assert(providerWire.includes(clarificationQuestion));
  assert(providerWire.includes(clarificationAnswer));
  for (const source of taskSources) {
    assert(!providerWire.includes(source.sourceId));
    assert(!providerWire.includes(source.sourceHash));
    assert(!providerWire.includes(source.taskAuthorizationRevisionHash));
  }

  const request = runtime.agentRunRequestSchema.parse({
    runId: 'run_message_snapshot',
    question: rootQuestion,
    currentStudentQuestion: rootQuestion,
    conversationMessages,
    taskSources,
    capabilityGrant: [],
    context: {
      tenantId: 'tenant-message-test',
      userId: 'user-message-test',
      threadId,
      lesson: {
        courseId: 'course-message-test',
        lessonId: 'lesson-message-test',
        title: '消息连续性',
        objectives: [],
        taskHints: []
      },
      model: {
        files: [{
          fileId: 'file_main',
          displayName: 'main.sysml',
          content: '',
          contentHash: `sha256:${'0'.repeat(64)}`,
          editable: true
        }],
        entryFileId: 'file_main',
        activeFileId: 'file_main',
        diagnostics: []
      }
    }
  });
  const resources = runtime.createRunResources({
    request,
    policy: runtime.DEFAULT_AGENT_POLICY,
    deadlineAtMs: Date.now() + 60_000
  });
  const delegated = resources.tasks.materialize({
    questionHash: resources.input.questionHash,
    outcome: {
      type: 'delegate_candidate',
      subject: 'standalone_model',
      acceptedToolCallId: 'delegate-message-test'
    },
    context: request.context
  });
  const workerView = runtime.projectWorkerTaskView(resources, delegated);
  assert.deepEqual(workerView.conversationMessages, resources.input.conversationMessages);
  assert.deepEqual(workerView.taskSources, resources.input.taskSources);
  assert(Object.isFrozen(resources.input.conversationMessages));
  assert(Object.isFrozen(resources.input.taskSources));

  console.log(JSON.stringify({
    conversationRoles: 'PASS',
    clarificationTaskSources: 'PASS',
    snapshotAndWorkerProjection: 'PASS',
    providerMetadataIsolation: 'PASS'
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
