'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const outRoot = path.join(root, '.tmp', 'web-phase3');

cleanOutputDir(outRoot);
runCommand(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'apps/web/tsconfig.phase1.json', '--outDir', outRoot], 'compile web lib helpers');
runCommand('cmd', ['/c', 'npm run typecheck:web'], 'typecheck React web');
runCommand('cmd', ['/c', 'npm run build:web'], 'build React web');

const {
  buildSysmlNavigationIndex,
  findSysmlDefinition,
  findSysmlReferences,
  renameSysmlSymbolInCode
} = requireModule('lib/sysml/navigation-index.js');
const {
  bestSysmlCompletion,
  sysmlCompletionCandidates,
  sysmlCompletionOptions,
  sysmlContextualCompletionCandidates,
  sysmlMemberCompletionOptions
} = requireModule('lib/sysml/completion.js');

testCompletionCoverage();
testModelNavigationCoverage();
testReactWorkbenchContracts();

console.log('web phase3 tests passed');

function testCompletionCoverage() {
  const source = [
    'package EV {',
    '  port def PowerPort;',
    '  part def BatteryPack {',
    '    port dcOut : PowerPort;',
    '    attribute massKg : ScalarValues::Real;',
    '  }',
    '  part vehicle : BatteryPack;',
    '  view vehicleView {',
    '    expose vehicle;',
    '  }',
    '}'
  ].join('\n');

  assert.strictEqual(
    bestSysmlCompletion('part d', sysmlCompletionCandidates({ content: 'package EV {\n  part d' })),
    'part def',
    'Tab-style best completion should complete "part d" to "part def"'
  );
  assert.strictEqual(
    bestSysmlCompletion('exp', sysmlCompletionCandidates({ content: 'package EV {\n  view v {\n    exp' })),
    'expose',
    'view context should offer expose'
  );
  assert(
    sysmlContextualCompletionCandidates(source, 'package EV {\n  part vehicle : Bat', buildSysmlNavigationIndex(source)).includes('BatteryPack'),
    'type position should offer model definitions'
  );
  const typeReferenceCursor = source.indexOf(': BatteryPack') + ': Bat'.length;
  assert(
    sysmlCompletionOptions({ content: source, cursor: typeReferenceCursor, explicit: true })
      .some((option) => option.label === 'BatteryPack'),
    'completion options should include model symbols'
  );
  assert(
    sysmlMemberCompletionOptions(source, 'BatteryPack').some((member) => member.name === 'dcOut'),
    'member completion should expose owned port members'
  );
  assert(
    sysmlMemberCompletionOptions(source, 'vehicle').some((member) => member.name === 'massKg'),
    'member completion should follow usage type to definition members'
  );
}

function testModelNavigationCoverage() {
  const source = [
    'package Thermal {',
    '  part def BatteryPack {',
    '    port coolantOut : CoolantPort;',
    '  }',
    '  part vehicle : BatteryPack;',
    '  view thermalView {',
    '    expose vehicle;',
    '  }',
    '  // vehicle should not be renamed here',
    '  doc "vehicle should not be renamed here"',
    '}'
  ].join('\n');
  const index = buildSysmlNavigationIndex(source);
  const battery = findSysmlDefinition(index, 'BatteryPack');
  const vehicle = findSysmlDefinition(index, 'vehicle');
  assert(battery && battery.from < battery.to, 'outline should find BatteryPack definition range');
  assert(vehicle && vehicle.line === 5, 'outline should find vehicle usage line');
  assert(findSysmlReferences(index, 'BatteryPack').some((reference) => reference.kind === 'type reference'));
  assert(findSysmlReferences(index, 'vehicle').some((reference) => reference.kind === 'expose'));

  const renamed = renameSysmlSymbolInCode(source, 'vehicle', 'thermalVehicle');
  assert(renamed.content.includes('part thermalVehicle : BatteryPack;'));
  assert(renamed.content.includes('expose thermalVehicle;'));
  assert(renamed.content.includes('// vehicle should not be renamed here'));
  assert(renamed.content.includes('"vehicle should not be renamed here"'));
}

function testReactWorkbenchContracts() {
  const routerTsx = read('apps/web/src/app/router.tsx');
  const workbenchTsx = read('apps/web/src/features/workbench/WorkbenchPage.tsx');
  const muiTreeTsx = read('apps/web/src/features/workbench/MuiModelOutlineTree.tsx');
  const codeMirrorTsx = read('apps/web/src/features/workbench/SysmlCodeMirror.tsx');
  const appCss = read('apps/web/src/styles/app.css');
  const distHtml = read('apps/web/dist/index.html');
  const distJs = readDistText('.js');
  const distCss = readDistText('.css');

  assert(routerTsx.includes("path: 'lesson/$lessonId'"), 'React router must own lesson workbench route');
  assert(routerTsx.includes("path: 'final-project'"), 'React router must own final project workbench route');
  assert(workbenchTsx.includes('data-phase3-workbench'), 'workbench must expose Phase3 root marker');
  assert(workbenchTsx.includes('data-editor') && workbenchTsx.includes('data-tree'), 'workbench must expose editor and model tree contracts');
  assert(
    workbenchTsx.includes('data-model-nav-tab="resource-tree"')
    && workbenchTsx.includes('data-model-nav-tab="overview"')
    && workbenchTsx.includes('data-model-nav-tab="references"')
    && workbenchTsx.includes('模型资源树')
    && workbenchTsx.includes('模型概览')
    && workbenchTsx.includes('引用速查'),
    'model tree must expose resource tree, overview, and reference tabs'
  );
  assert(workbenchTsx.includes('data-goto-definition') && workbenchTsx.includes('data-find-references') && workbenchTsx.includes('data-symbol-rename'), 'workbench must expose symbol navigation tools');
  assert(workbenchTsx.includes('data-context-rename-symbol') && workbenchTsx.includes('renameFromContextMenu') && workbenchTsx.includes('renameSysmlSymbolInCode'), 'editor context menu must expose safe symbol renaming backed by SysML-aware replacement');
  assert(workbenchTsx.includes("lazy(() => import('./MuiModelOutlineTree')"), 'MUI tree must be lazy-loaded from the workbench route');
  assert(muiTreeTsx.includes("@mui/x-tree-view/RichTreeView") && muiTreeTsx.includes('data-mui-rich-tree'), 'model outline must be rendered through MUI X RichTreeView');
  assert(muiTreeTsx.includes('items={items}') && muiTreeTsx.includes('defaultExpandedItems') && muiTreeTsx.includes('onItemClick'), 'MUI tree must keep Basic usage items, expansion and click contracts');
  assert(muiTreeTsx.includes('lucide-react') && muiTreeTsx.includes('modelOutlineNodeIcon') && muiTreeTsx.includes('modelOutlineNodeKind'), 'MUI tree must render a typed icon and secondary kind label instead of text glyphs');
  assert(workbenchTsx.includes('/api/model-outline') && workbenchTsx.includes('AUTO_SEMANTIC_OUTLINE_DEBOUNCE_MS') && workbenchTsx.includes('AUTO_SEMANTIC_OUTLINE_TIMEOUT_MS') && workbenchTsx.includes('semanticOutlineCompletedRequestKeyRef') && workbenchTsx.includes('requestTimedOut') && workbenchTsx.includes('AbortController'), 'official semantic outline must refresh automatically with debounce, terminal-state deduplication, timeout handling and stale request cancellation');
  const outlineEffect = workbenchTsx.slice(
    workbenchTsx.indexOf("const attemptKey = `${currentWorkspaceSignature}:${semanticOutlineRefreshNonce}`"),
    workbenchTsx.indexOf("if (!files.length) return <ErrorState")
  );
  assert(outlineEffect && !outlineEffect.includes('\n    files,') && !outlineEffect.includes('\n    activePath,') && !workbenchTsx.includes('semanticOutlineAttemptKeyRef'), 'official outline effect must depend on the stable workspace signature and must not deduplicate an aborted debounce attempt');
  assert(!workbenchTsx.includes('@dhtmlx/tree') && !workbenchTsx.includes('data-dhtmlx-tree'), 'DHTMLX Tree must not remain in the React workbench');
  assert(codeMirrorTsx.includes('@codemirror/autocomplete') && codeMirrorTsx.includes('runTabCompletion'), 'CodeMirror wrapper must enable completion and Tab handling');
  assert(appCss.includes('.phase3CodeMirror') && appCss.includes('.modelOutlineTreeMui') && appCss.includes('.MuiTreeItem-content'), 'Phase3 editor and MUI outline styling must be present');
  assert(appCss.includes('overscroll-behavior: auto'), 'model navigation should allow wheel scroll chaining back to the page');
  assert(!appCss.includes('modelOutlineTreeDhtmlx') && !appCss.includes('dhx_tree-list-item'), 'DHTMLX outline styling must be removed');
  assert(distHtml.includes('/react-assets/'), 'React dist must keep static routing contract');
  assert(distJs.includes('data-phase3-workbench') && distJs.includes('data-code-editor-ready'), 'built React bundle must include Phase3 workbench markers');
  assert(distJs.includes('data-context-rename-symbol'), 'built React bundle must include editor context rename action');
  assert(distJs.includes('data-mui-rich-tree'), 'built React bundle must include MUI tree marker');
  assert(!distJs.includes('@dhtmlx/tree'), 'built React bundle must not include DHTMLX Tree');
  assert(distCss.includes('phase3CodeMirror') && distCss.includes('modelOutlineTreeMui'), 'built CSS must include Phase3 editor and MUI tree styles');
}

function requireModule(relativePath) {
  return require(path.join(outRoot, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readDistText(extension) {
  const dir = path.join(root, 'apps', 'web', 'dist', 'react-assets');
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith(extension))
    .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'))
    .join('\n');
}

function runCommand(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${label} failed`);
    process.exit(result.status || 1);
  }
}

function cleanOutputDir(dir) {
  const resolved = path.resolve(dir);
  const allowedRoot = path.resolve(root, '.tmp');
  if (!resolved.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new Error(`Refusing to remove unexpected test output directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
