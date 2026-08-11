'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.OFFICIAL_VALIDATOR_ENABLED = 'false';

const { createServer } = require('../apps/api/server');

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synfeld-api-public-'));
  const providerStatusMonitor = {
    start() {},
    stop() {},
    getSnapshot() { return { status: 'disabled', providers: [] }; }
  };
  const server = createServer({
    coursesRoot: path.resolve('courses'),
    knowledgePacksRoot: path.resolve('knowledge-packs'),
    dataDir,
    coursePack: 'ev-sysml-v2-foundation-c2',
    providerStatusMonitor,
    apiRateLimitEnabled: false,
    aiTeacherEnabled: false
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const health = await getJson(`${baseUrl}/health`);
    assert.strictEqual(health.coursePack, 'ev-sysml-v2-foundation-c2');
    assert.strictEqual(health.coursePackLoaded, true);

    const coursePacks = await getJson(`${baseUrl}/api/course-packs`);
    assert.strictEqual(coursePacks.packs.length, 1);
    assert.strictEqual(coursePacks.packs[0].title, 'SysML v2 电动汽车建模基础');
    assert.strictEqual(coursePacks.packs[0].version, '2.2.0');

    const knowledgePacks = await getJson(`${baseUrl}/api/knowledge-packs`);
    assert.strictEqual(knowledgePacks.packs.length, 1);
    assert.strictEqual(knowledgePacks.packs[0].title, 'SysML v2 工程扫盲与导读');
    assert.strictEqual(knowledgePacks.packs[0].version, '1.1.0');

    const knowledge = await getJson(`${baseUrl}/api/knowledge-packs/system-modeling-foundations`);
    assert.strictEqual(knowledge.entryTopicId, 'why-models-are-not-one-diagram');
    console.log('public API tests passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  assert.strictEqual(response.status, 200, `${url} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
