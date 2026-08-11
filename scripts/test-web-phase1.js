'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const outRoot = path.join(root, '.tmp', 'web-phase1');

cleanOutputDir(outRoot);
runTsc();

const { shouldScopeCoursePack, scopeCoursePackPath } = requireModule('lib/api/course-pack-scope.js');
const { createApiClient } = requireModule('lib/api/client.js');
const { normalizeApiErrorPayload, normalizeApiError, WebApiError } = requireModule('lib/api/errors.js');
const {
  createMemoryStorage,
  readVersionedStorage,
  writeVersionedStorage,
  updateVersionedStorage
} = requireModule('lib/storage/versioned-storage.js');
const { workspaceTemplateSignature, cloneWorkspaceFiles } = requireModule('lib/course/workspace.js');
const {
  buildSysmlNavigationIndex,
  findSysmlDefinition,
  findSysmlReferences,
  renameSysmlSymbolInCode
} = requireModule('lib/sysml/navigation-index.js');
const {
  scanSysmlPunctuationIssues,
  normalizeSysmlPunctuation,
  sysmlCodeOnlyText
} = requireModule('lib/sysml/text.js');
const {
  buildFocusTerms,
  focusTermMap,
  normalizeFocusTerm
} = requireModule('lib/sysml/focus-terms.js');
const {
  teachingLaneForNode,
  teachingLegendItems,
  teachingLoopSummary,
  teachingDisplayName
} = requireModule('lib/sysml/teaching-view.js');

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  testCoursePackScoping();
  testApiErrors();
  await testApiClient();
  testVersionedStorage();
  testWorkspaceSignature();
  testSysmlTextAndNavigation();
  testFocusTerms();
  testTeachingView();
  console.log('web phase1 tests passed');
}

function requireModule(relativePath) {
  return require(path.join(outRoot, relativePath));
}

function runTsc() {
  const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tscBin, '-p', 'apps/web/tsconfig.phase1.json'], {
    cwd: root,
    stdio: 'inherit'
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

function cleanOutputDir(dir) {
  const resolved = path.resolve(dir);
  const allowedRoot = path.resolve(root, '.tmp');
  if (!resolved.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new Error(`Refusing to remove unexpected test output directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function testCoursePackScoping() {
  assert.strictEqual(shouldScopeCoursePack('/api/courses'), true);
  assert.strictEqual(shouldScopeCoursePack('/api/auth/me'), false);
  assert.strictEqual(shouldScopeCoursePack('/api/course-packs'), false);
  assert.strictEqual(shouldScopeCoursePack('/api/admin/course-packs'), false);
  assert.strictEqual(shouldScopeCoursePack('/api/ai-teacher/runs'), false);
  assert.strictEqual(shouldScopeCoursePack('/api/glossary'), false);
  assert.strictEqual(shouldScopeCoursePack('/api/glossary?coursePackId=pack-b'), false);
  assert.strictEqual(shouldScopeCoursePack('/config.json'), false);
  assert.strictEqual(
    scopeCoursePackPath('/api/courses?view=list', 'pack-a'),
    '/api/courses?view=list&coursePackId=pack-a'
  );
  assert.strictEqual(
    scopeCoursePackPath('/api/courses?coursePackId=existing', 'pack-a'),
    '/api/courses?coursePackId=existing'
  );
  assert.strictEqual(
    scopeCoursePackPath('/api/glossary', 'pack-a'),
    '/api/glossary'
  );
}

function testApiErrors() {
  assert.deepStrictEqual(
    normalizeApiErrorPayload(
      { error: { message: 'provider unavailable', code: 'AI_TEACHER_DISABLED', status: 503 } },
      { status: 500, statusText: 'Internal Server Error' }
    ),
    { status: 503, code: 'AI_TEACHER_DISABLED', message: 'provider unavailable' }
  );
  const error = new Error('[object Object]');
  error.payload = { error: { message: 'bad request', code: 'BAD_REQUEST', status: 400 } };
  error.status = 400;
  assert.deepStrictEqual(normalizeApiError(error), { status: 400, code: 'BAD_REQUEST', message: 'bad request' });
}

async function testApiClient() {
  const calls = [];
  const client = createApiClient({
    baseUrl: 'http://localhost:8080/',
    activeCoursePackId: () => 'pack-a',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ ok: true, path: String(url) });
    }
  });

  const payload = await client.request('/api/courses?view=list', {
    method: 'POST',
    body: { active: true }
  });
  assert.strictEqual(payload.ok, true);
  assert.strictEqual(calls[0].url, 'http://localhost:8080/api/courses?view=list&coursePackId=pack-a');
  assert.strictEqual(calls[0].init.method, 'POST');
  assert.strictEqual(calls[0].init.credentials, 'include');
  assert.strictEqual(calls[0].init.headers.has('authorization'), false);
  assert.strictEqual(calls[0].init.headers.get('content-type'), 'application/json');
  assert.strictEqual(calls[0].init.body, JSON.stringify({ active: true }));

  let unauthorized = false;
  const failingClient = createApiClient({
    fetchImpl: async () => jsonResponse({ error: { message: 'expired', code: 'AUTH_EXPIRED', status: 401 } }, 401),
    onUnauthorized: () => {
      unauthorized = true;
    }
  });
  await assert.rejects(
    () => failingClient.request('/api/courses'),
    (error) => error instanceof WebApiError && error.status === 401 && error.code === 'AUTH_EXPIRED'
  );
  assert.strictEqual(unauthorized, true);
}

function testVersionedStorage() {
  const storage = createMemoryStorage();
  const options = { key: 'sysml.test', version: 2, storage, fallback: () => ({ items: [] }) };
  assert.deepStrictEqual(readVersionedStorage(options), { items: [] });
  writeVersionedStorage(options, { items: ['a'] });
  assert.deepStrictEqual(readVersionedStorage(options), { items: ['a'] });
  const next = updateVersionedStorage(options, (current) => ({ items: [...current.items, 'b'] }));
  assert.deepStrictEqual(next, { items: ['a', 'b'] });
  assert.deepStrictEqual(readVersionedStorage({ ...options, version: 3 }), { items: [] });
  assert.deepStrictEqual(
    readVersionedStorage({
      ...options,
      version: 3,
      migrate: (data, fromVersion) => ({ items: [...data.items, `migrated-${fromVersion}`] })
    }),
    { items: ['a', 'b', 'migrated-2'] }
  );
}

function testWorkspaceSignature() {
  const files = [
    { path: 'b.sysml', content: 'part def B {}', editable: false },
    { path: 'a.sysml', content: 'part def A {}', editable: true }
  ];
  const reversed = [files[1], files[0]];
  assert.strictEqual(workspaceTemplateSignature(files, 'a.sysml'), workspaceTemplateSignature(reversed, 'a.sysml'));
  assert.notStrictEqual(
    workspaceTemplateSignature(files, 'a.sysml'),
    workspaceTemplateSignature([{ ...files[0], content: 'part def Changed {}' }, files[1]], 'a.sysml')
  );
  assert.notStrictEqual(
    workspaceTemplateSignature(files, 'a.sysml'),
    workspaceTemplateSignature([{ ...files[0], loadPolicy: 'on-import' }, files[1]], 'a.sysml')
  );
  assert.deepStrictEqual(
    cloneWorkspaceFiles({ files: [{ path: 'ref.sysml', content: 'x', editable: false }] }),
    [{ path: 'ref.sysml', content: 'x', editable: false, source: 'reference', loadPolicy: 'always' }]
  );
}

function testSysmlTextAndNavigation() {
  const source = [
    'package Thermal {',
    '  // part def IgnoredComment {}',
    '  part def BatteryPack {}',
    '  part vehicle : BatteryPack {',
    '    port coolingPort : CoolantPort;',
    '  }',
    '  view thermalView {',
    '    expose vehicle;',
    '  }',
    '  doc "part def IgnoredString {}"',
    '}'
  ].join('\n');
  const codeOnly = sysmlCodeOnlyText(source);
  assert(!codeOnly.includes('IgnoredComment'));
  assert(!codeOnly.includes('IgnoredString'));

  const index = buildSysmlNavigationIndex(source);
  assert(findSysmlDefinition(index, 'Thermal'));
  assert(findSysmlDefinition(index, 'BatteryPack'));
  assert(findSysmlDefinition(index, 'vehicle'));
  assert.strictEqual(findSysmlDefinition(index, 'IgnoredComment'), null);
  assert(findSysmlReferences(index, 'BatteryPack').some((reference) => reference.kind === 'type reference'));
  assert(findSysmlReferences(index, 'vehicle').some((reference) => reference.kind === 'expose'));

  const quotedNameSource = [
    'package Sandbox {',
    '  part def aircraft;',
    "  part 'C_919' : aircraft;",
    '}'
  ].join('\n');
  const quotedCodeOnly = sysmlCodeOnlyText(quotedNameSource);
  assert(quotedCodeOnly.includes("part 'C_919' : aircraft;"), 'unrestricted SysML names must stay visible to code navigation');
  const quotedIndex = buildSysmlNavigationIndex(quotedNameSource);
  const quotedUsage = findSysmlDefinition(quotedIndex, 'C_919');
  assert(quotedUsage && quotedUsage.kind === 'part', 'outline should find quoted part usage names');
  assert.strictEqual(quotedUsage.typeName, 'aircraft');
  assert(findSysmlReferences(quotedIndex, 'aircraft').some((reference) => reference.kind === 'type reference'));

  const punctuationSource = 'part vehicle ： BatteryPack;\n// ： ignored\nattribute label = "："';
  const issues = scanSysmlPunctuationIssues(punctuationSource);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].replacement, ':');
  assert.deepStrictEqual(normalizeSysmlPunctuation(punctuationSource), {
    content: 'part vehicle : BatteryPack;\n// ： ignored\nattribute label = "："',
    count: 1
  });

  const renamed = renameSysmlSymbolInCode('part vehicle : BatteryPack;\n// vehicle\nattribute label = "vehicle"', 'vehicle', 'thermalVehicle');
  assert.strictEqual(renamed.count, 1);
  assert.strictEqual(renamed.content, 'part thermalVehicle : BatteryPack;\n// vehicle\nattribute label = "vehicle"');
}

function testFocusTerms() {
  const files = [{ path: 'main.sysml', content: 'part def BatteryPack {}\nport coolingPort : CoolantPort;' }];
  const lesson = {
    scenario: { body: '建模 `BatteryPack`，不要显示 `MissingName`。' },
    learningBlocks: [{ content: '检查 `coolingPort`。' }],
    tasks: [{ prompt: '补全 `CoolantPort`。' }],
    validation: { rules: [{ selector: { name: 'coolingPort', typeName: 'CoolantPort' } }] }
  };
  const terms = buildFocusTerms(lesson, files);
  assert.deepStrictEqual(terms.map((term) => term.text), ['BatteryPack', 'coolingPort', 'CoolantPort']);
  assert.strictEqual(focusTermMap(terms).get('BatteryPack').source, 'text');
  assert.strictEqual(normalizeFocusTerm('  BatteryPack  '), 'BatteryPack');

  const fallbackTerms = buildFocusTerms({ id: 'l1', title: 'L1', validation: { rules: [{ name: 'coolingPort' }] } }, files);
  assert.strictEqual(fallbackTerms[0].text, 'coolingPort');
  assert.strictEqual(fallbackTerms[0].source, 'rule');
}

function testTeachingView() {
  assert.strictEqual(teachingLaneForNode({ name: 'archController', kind: 'part' }), 'control');
  assert.strictEqual(teachingLaneForNode({ name: 'BatteryCoolingRequirement', kind: 'requirement' }), 'evidence');
  assert.strictEqual(teachingDisplayName('archBattery'), '电池热域 / Battery');
  assert.deepStrictEqual(
    teachingLegendItems([{ category: 'coolant' }, { category: 'verify' }]).map((item) => item.kind),
    ['coolant', 'verify']
  );
  assert.deepStrictEqual(
    teachingLoopSummary([{ label: 'coolant', source: 'Battery', target: 'Radiator', typeLabel: '冷却液' }]),
    ['电池冷却回路', '散热器与环境换热回路']
  );
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
