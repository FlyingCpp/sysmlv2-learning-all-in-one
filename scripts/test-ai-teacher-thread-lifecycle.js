'use strict';

const assert = require('assert');
const { createMemoryConversationStore } = require('../apps/teacher/conversation-store');
const { createServer } = require('../apps/teacher/server');

async function main() {
  const store = createMemoryConversationStore();
  const owner = context('user-a');
  const other = context('user-b');

  const first = await store.createThread(owner);
  assert(/^thread_/.test(first.threadId), 'thread ids must be assigned by the server store');
  store.state.messages.set(first.threadId, [
    {
      messageId: 'message-first-question',
      threadId: first.threadId,
      role: 'user',
      status: 'succeeded',
      content: '解释一个很长的 SysML v2 模型问题'
    },
    {
      messageId: 'message-first-answer',
      threadId: first.threadId,
      role: 'assistant',
      status: 'succeeded',
      content: '答'.repeat(40_000)
    }
  ]);

  const second = await store.createThread(owner);
  assert.notStrictEqual(second.threadId, first.threadId, 'new conversation must not reuse the previous thread');

  const threads = await store.listThreads(owner, { scope: 'current', contextLimitTokens: 16_000 });
  const firstSummary = threads.find((thread) => thread.threadId === first.threadId);
  assert.strictEqual(firstSummary.title, '解释一个很长的 SysML v2 模型问题');
  assert.strictEqual(firstSummary.contextUsage.state, 'critical', 'long histories must surface a context warning state');
  assert.strictEqual(firstSummary.contextUsage.limitTokens, 16_000);

  const foreignDelete = await store.deleteThread(other, first.threadId);
  assert.deepStrictEqual(foreignDelete, { deleted: false, reason: 'not_found' }, 'thread deletion must be owner scoped');

  store.state.runs.set('run-active', { runId: 'run-active', threadId: first.threadId, status: 'running' });
  const activeDelete = await store.deleteThread(owner, first.threadId);
  assert.deepStrictEqual(activeDelete, { deleted: false, reason: 'active_run' }, 'active threads must not be deleted');

  store.state.runs.get('run-active').status = 'succeeded';
  const deleted = await store.deleteThread(owner, first.threadId);
  assert.deepStrictEqual(deleted, { deleted: true, threadId: first.threadId });
  assert(!store.state.threads.has(first.threadId), 'deleted thread must be removed');
  assert(!store.state.messages.has(first.threadId), 'deleted thread messages must be removed');
  assert(store.state.threads.has(second.threadId), 'other history threads must be preserved');

  await verifyTeacherHttpLifecycle();

  console.log('AI Teacher thread lifecycle tests passed.');
}

async function verifyTeacherHttpLifecycle() {
  const conversation = createMemoryConversationStore();
  const server = createServer({
    conversation,
    knowledge: {},
    internalToken: 'thread-lifecycle-test-token',
    providerEnabled: false,
    allowCors: false
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {
    'content-type': 'application/json',
    'x-ai-teacher-token': 'thread-lifecycle-test-token'
  };
  try {
    const createdResponse = await fetch(`${base}/v1/teacher/threads`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ context: context('http-user') })
    });
    assert.strictEqual(createdResponse.status, 201);
    const created = await createdResponse.json();

    const query = new URLSearchParams({
      tenantId: 'tenant-a',
      userId: 'http-user',
      coursePackId: 'pack-a',
      courseId: 'course-a',
      lessonId: '',
      scope: 'current'
    });
    const listResponse = await fetch(`${base}/v1/teacher/threads?${query}`, { headers });
    assert.strictEqual(listResponse.status, 200);
    const list = await listResponse.json();
    assert(list.threads.some((thread) => thread.threadId === created.threadId));

    const deleteResponse = await fetch(`${base}/v1/teacher/threads/${encodeURIComponent(created.threadId)}?${query}`, {
      method: 'DELETE',
      headers
    });
    assert.strictEqual(deleteResponse.status, 200);
    const deleted = await deleteResponse.json();
    assert.strictEqual(deleted.deleted, true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function context(userId) {
  return {
    requestId: `request-${userId}`,
    tenant: { tenantId: 'tenant-a', userId },
    course: { coursePackId: 'pack-a', courseId: 'course-a', lessonId: '' }
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
