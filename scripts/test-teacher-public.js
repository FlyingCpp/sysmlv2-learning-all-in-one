'use strict';

const assert = require('assert');
const {
  createMemoryKnowledgeRetriever,
  createTeacherRetriever,
  retrieverStatus
} = require('../apps/teacher/retriever');

async function main() {
  const direct = createMemoryKnowledgeRetriever();
  await assertMemoryRetriever(direct);

  const configured = createTeacherRetriever({ backend: 'memory' });
  await assertMemoryRetriever(configured);

  const previousBackend = process.env.AI_TEACHER_RAG_BACKEND;
  try {
    process.env.AI_TEACHER_RAG_BACKEND = 'memory';
    const fromEnvironment = createTeacherRetriever();
    await assertMemoryRetriever(fromEnvironment);
  } finally {
    if (previousBackend === undefined) delete process.env.AI_TEACHER_RAG_BACKEND;
    else process.env.AI_TEACHER_RAG_BACKEND = previousBackend;
  }

  assert.throws(
    () => createTeacherRetriever({ backend: 'unsupported' }),
    /Unsupported AI Teacher retrieval backend/u
  );

  console.log('public Teacher retrieval tests passed');
}

async function assertMemoryRetriever(retriever) {
  assert.strictEqual(retriever.mode, 'memory');
  assert.deepStrictEqual(await retriever.search('part def'), []);

  const anchors = await retriever.searchAnchors('part def');
  assert.deepStrictEqual(anchors.anchors, []);
  assert.deepStrictEqual(anchors.closure.closureClaimIds, []);

  const expansion = await retriever.expandClaims(['claim-1']);
  assert.deepStrictEqual(expansion.claims, []);

  const debug = await retriever.debug('part def');
  assert.strictEqual(debug.ok, true);
  assert.strictEqual(debug.backend, 'memory');
  assert.deepStrictEqual(debug.hits, []);

  const status = await retrieverStatus(retriever);
  assert.strictEqual(status.mode, 'memory');
  assert.strictEqual(status.enabled, false);
  assert.strictEqual(status.ready, true);
  assert.strictEqual(status.cardCount, 0);
  assert.strictEqual(status.activeBundle, null);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
