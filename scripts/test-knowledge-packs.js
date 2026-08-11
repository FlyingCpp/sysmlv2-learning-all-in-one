'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.AI_TEACHER_INTERNAL_TOKEN ||= 'test-teacher-internal-token';
process.env.AI_TEACHER_TOOL_TOKEN ||= 'test-teacher-tool-token';
const { createKnowledgePackRegistry } = require('../apps/api/knowledge-pack-registry');
const { createDataStore } = require('../apps/api/data-store');
const { createServer } = require('../apps/api/server');

async function main() {
  const knowledgePageSource = fs.readFileSync(path.resolve('apps/web/src/features/knowledge/KnowledgePage.tsx'), 'utf8');
  const knowledgeMediaSource = fs.readFileSync(path.resolve('apps/web/src/features/knowledge/KnowledgeMediaBlocks.tsx'), 'utf8');
  const knowledgeRegistrySource = fs.readFileSync(path.resolve('apps/api/knowledge-pack-registry.js'), 'utf8');
  const apiServerSource = fs.readFileSync(path.resolve('apps/api/server.js'), 'utf8');
  const webStyles = fs.readFileSync(path.resolve('apps/web/src/styles/app.css'), 'utf8');
  assert.match(knowledgePageSource, /data-knowledge-scroll-region/);
  assert.match(knowledgePageSource, /placeholderData: keepPreviousData/);
  assert.match(knowledgePageSource, /topicQuery\.isPending && !topicQuery\.data/);
  assert.match(knowledgePageSource, /root: scroller/);
  assert.match(knowledgePageSource, /scroller\.addEventListener\('scroll'/);
  assert.doesNotMatch(knowledgePageSource, /window\.addEventListener\('scroll'/);
  assert.match(knowledgePageSource, /className="workbenchAiDockLayout knowledgeContentDockLayout"/);
  assert.match(knowledgePageSource, /launcherMode="floating"/);
  assert.doesNotMatch(knowledgePageSource, /knowledgeTeacherTrigger/);
  assert.match(webStyles, /body:has\(\.knowledgeReader\) \{\s*overflow: hidden;/);
  assert.match(webStyles, /\.phase0Shell:has\(\.knowledgeReader\)[\s\S]*?height: 100dvh;[\s\S]*?overflow: hidden;/);
  assert.match(webStyles, /\.knowledgeReadingColumn \{[\s\S]*?width: 100%;[\s\S]*?overflow-y: auto;/);
  assert.match(knowledgePageSource, /className="knowledgeProgressBar"[\s\S]*?className="knowledgeReadingBody"/);
  assert.match(webStyles, /\.knowledgeProgressBar \{[\s\S]*?position: sticky;[\s\S]*?top: 0;/);
  assert.doesNotMatch(webStyles, /\.knowledgeProgressBar \{[^}]*position: fixed;/);
  assert.match(webStyles, /\.knowledgeReadingBody \{[\s\S]*?padding: 22px 48px 92px;/);
  assert.match(knowledgePageSource, /knowledgeFigure isWide/);
  assert.match(knowledgePageSource, /查看原图/);
  assert.match(knowledgePageSource, /放大阅读/);
  assert.match(knowledgePageSource, /aria-pressed=\{expanded\}/);
  assert.match(knowledgePageSource, /useEffect\(\(\) => setExpanded\(false\), \[assetUrl\]\)/);
  assert.doesNotMatch(knowledgePageSource, /block\.id === 'model-chain'/);
  assert.match(webStyles, /\.knowledgeFigure img \{[^}]*width: 100%;[^}]*height: auto;/);
  assert.match(webStyles, /\.knowledgeFigureViewport \{[^}]*overflow-x: auto;/);
  assert.match(webStyles, /\.knowledgeFigure\.isExpanded img \{[^}]*width: auto;[^}]*min-width: 100%;[^}]*max-width: none;/);
  assert.match(knowledgePageSource, /knowledgeReferenceKey/);
  assert.match(knowledgePageSource, /knowledgeInlineCode/);
  assert.match(webStyles, /\.knowledgeArticle \{[^}]*font-family: var\(--font-sans\);/);
  assert.match(webStyles, /\.knowledgeMarkdown \{[^}]*font-family: var\(--font-sans\);[^}]*font-size: var\(--text-body\);/);
  assert.match(webStyles, /\.knowledgeMarkdown \.knowledgeInlineCode \{[^}]*font-family: var\(--font-mono\);/);
  assert.match(webStyles, /\.knowledgeMarkdown \.knowledgeReferenceKey \{[^}]*font-family: var\(--font-sans\);/);
  assert.doesNotMatch(webStyles, /\.knowledgeMarkdown \{[^}]*font-size: (?:15|16)px;/);
  assert.match(webStyles, /\.knowledgeContentDockLayout > \.phase4AiTeacher \{ top: 0; height: 100%;/);
  assert.match(webStyles, /\.knowledgeContentDockLayout > \.phase4AiTeacher \.aiTeacherPanelReact \{ height: 100%; max-height: none;/);
  assert.doesNotMatch(webStyles, /\.knowledgeContentDockLayout > \.phase4AiTeacher \{[^}]*position: fixed;/);
  assert.match(knowledgePageSource, /KnowledgeCodeBlockView/);
  assert.match(knowledgePageSource, /KnowledgePdfBlockView/);
  assert.match(knowledgePageSource, /KnowledgeVideoBlockView/);
  assert.match(knowledgeMediaSource, /api\.request<ValidationResult>\('\/api\/validate'/);
  assert.match(knowledgeMediaSource, /youtube-nocookie\.com\/embed/);
  assert.match(knowledgeMediaSource, /player\.bilibili\.com\/player\.html/);
  assert.match(knowledgeMediaSource, /按需加载外部视频/);
  assert.match(knowledgeRegistrySource, /SUPPORTED_BLOCK_TYPES[\s\S]*?'code'[\s\S]*?'pdf'[\s\S]*?'video'/);
  assert.match(knowledgeRegistrySource, /视频块不能提供任意 URL 或本地视频资源/);
  assert.match(apiServerSource, /'\.pdf': 'application\/pdf'/);
  assert.match(webStyles, /\.knowledgeCodeViewport \{[^}]*overflow: auto;/);
  assert.match(knowledgeMediaSource, /interactive \? '锁定滚动' : '操作 PDF'/);
  assert.match(webStyles, /\.knowledgePdfViewport iframe \{[^}]*height: 560px;[^}]*pointer-events: none;/);
  assert.match(webStyles, /\.knowledgePdfViewport\.isInteractive iframe \{ pointer-events: auto;/);
  assert.match(webStyles, /\.knowledgeVideoFrame \{[^}]*aspect-ratio: 16 \/ 9;/);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-foundations-test-'));
  try {
    const knowledgeRegistry = createKnowledgePackRegistry({ knowledgePacksRoot: path.resolve('knowledge-packs'), dataDir });
    const packs = knowledgeRegistry.listPacks();
    assert.equal(packs.length, 1);
    assert.equal(packs[0].id, 'system-modeling-foundations');
    const pack = knowledgeRegistry.loadPack(packs[0].id);
    assert.equal(pack.domains.length, 3);
    assert.equal(pack.domains.flatMap((domain) => domain.topics).length, 7);
    const topic = knowledgeRegistry.loadTopic(pack.id, pack.entryTopicId);
    assert.match(topic.blocks[0].content, /现实系统/);
    assert.equal(topic.blocks.some((block) => block.type === 'image'), true);
    assert.equal(topic.blocks.some((block) => block.type === 'code'), true);
    assert.equal(topic.blocks.some((block) => block.type === 'pdf'), true);
    assert.equal(topic.blocks.some((block) => block.type === 'video'), true);
    const codeBlock = topic.blocks.find((block) => block.type === 'code');
    assert.match(codeBlock.content, /part def Vehicle;/);
    assert.match(codeBlock.content, /part exampleVehicle : Vehicle;/);
    const videoBlock = topic.blocks.find((block) => block.type === 'video');
    assert.equal(videoBlock.provider, 'youtube');
    assert.equal(videoBlock.embedUrl, undefined, 'content packs must not supply iframe URLs');
    assert.throws(() => knowledgeRegistry.resolveAsset(pack.id, pack.contentVersionId, '../package.json'), /路径越界/);
    const pdfPath = knowledgeRegistry.resolveAsset(pack.id, pack.contentVersionId, 'assets/knowledge-media-blocks-fixture.pdf');
    assert.equal(fs.readFileSync(pdfPath).subarray(0, 4).toString(), '%PDF');

    const unsafeRoot = path.join(dataDir, 'unsafe-pack-root');
    fs.mkdirSync(path.join(unsafeRoot, 'unsafe-pack', 'topics'), { recursive: true });
    fs.writeFileSync(path.join(unsafeRoot, 'unsafe-pack', 'knowledge-pack.json'), JSON.stringify({
      schemaVersion: '1.0', id: 'unsafe-pack', title: 'Unsafe', version: '1.0.0', entryTopicId: 'unsafe-topic',
      domains: [{ id: 'unsafe-domain', title: 'Unsafe', topics: ['topics/topic.json'] }]
    }));
    fs.writeFileSync(path.join(unsafeRoot, 'unsafe-pack', 'topics', 'topic.json'), JSON.stringify({
      id: 'unsafe-topic', title: 'Unsafe topic', blocks: [{ id: 'unsafe-video', type: 'video', provider: 'youtube', videoId: 'abcdefghi', embedUrl: 'https://example.invalid/embed' }]
    }));
    const unsafeRegistry = createKnowledgePackRegistry({ knowledgePacksRoot: unsafeRoot, dataDir: path.join(dataDir, 'unsafe-data') });
    assert.throws(() => unsafeRegistry.loadTopic('unsafe-pack', 'unsafe-topic'), /不能提供任意 URL/);

    const dataStore = createDataStore(dataDir);
    const user = { id: 'knowledge-learner' };
    const saved = dataStore.writeKnowledgeProgress(pack.id, { topicProgress: { [topic.id]: { percent: 42, completed: false } } }, user);
    assert.equal(saved.topicProgress[topic.id].percent, 42);
    assert.equal(dataStore.readKnowledgeProgress(pack.id, user).topicProgress[topic.id].percent, 42);

    const server = createServer({
      dataDir,
      knowledgeRegistry,
      courseRegistry: { listPacks: () => [], resolvePack: () => ({ id: 'unused', path: path.resolve('courses/ev-sysml-v2-foundation-c2') }), defaultPackId: '' },
      authService: {
        betterAuth: { accountStore: {} },
        currentUser: async () => user,
        requireUser: async () => user,
        requireEntitlement: async () => user,
        requirePermission: async () => user
      },
      providerStatusMonitor: { start() {}, stop() {} },
      aiTeacherEnabled: false,
      apiRateLimitEnabled: false
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const listResponse = await fetch(`${baseUrl}/api/knowledge-packs`);
      assert.equal(listResponse.status, 200);
      const listPayload = await listResponse.json();
      assert.equal(listPayload.packs[0].path, undefined, 'API must not expose server filesystem paths');
      const topicResponse = await fetch(`${baseUrl}/api/knowledge-packs/${pack.id}/topics/${topic.id}`);
      assert.equal(topicResponse.status, 200);
      const topicPayload = await topicResponse.json();
      assert.equal(topicPayload.pack.path, undefined);
      assert.equal(topicPayload.blocks.length, 8);
      const assetResponse = await fetch(`${baseUrl}/api/knowledge-assets/${pack.id}/${pack.contentVersionId}/assets/requirement.png`);
      assert.equal(assetResponse.status, 200);
      assert.match(assetResponse.headers.get('content-type'), /image\/png/);
      const pdfResponse = await fetch(`${baseUrl}/api/knowledge-assets/${pack.id}/${pack.contentVersionId}/assets/knowledge-media-blocks-fixture.pdf`);
      assert.equal(pdfResponse.status, 200);
      assert.match(pdfResponse.headers.get('content-type'), /application\/pdf/);
      const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
      assert.equal(pdfBytes.subarray(0, 4).toString(), '%PDF');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log('knowledge pack tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
