'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const outRoot = path.join(root, '.tmp', 'web-phase4');

cleanOutputDir(outRoot);
runCommand(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'apps/web/tsconfig.phase1.json', '--outDir', outRoot], 'compile web lib helpers');
runCommand('cmd', ['/c', 'npm run typecheck:web'], 'typecheck React web');
runCommand('cmd', ['/c', 'npm run build:web'], 'build React web');

const {
  aiTeacherDiagnosticId,
  buildAiTeacherEnvelope,
  documentRevisionForText,
  sanitizeTeacherUiText
} = requireModule('lib/ai-teacher/envelope.js');
const {
  applySingleLinePatchToContent,
  isAiTeacherPatchApplyReady,
  lineColumnOffset
} = requireModule('lib/ai-teacher/patch.js');
const { latestRecoverableTeacherRun, orderTeacherConversationMessages } = requireModule('lib/ai-teacher/conversation.js');
const {
  friendlyPlantUmlError,
  plantUmlMetadataNotes,
  plantUmlRequestBody,
  plantUmlViewportFit,
  plantUmlViewOptions
} = requireModule('lib/view/plantuml.js');
const {
  friendlySysONError,
  sysonEmbedUrl,
  sysonViewLabel,
  sysonViewRequestBody
} = requireModule('lib/view/syson.js');

(async () => {
  await testAiTeacherContracts();
  await testViewContracts();
  testReactPhase4Contracts();
  console.log('web phase4 tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function testAiTeacherContracts() {
  const restoredConversation = orderTeacherConversationMessages([
    { messageId: 'a2', runId: 'run-2', role: 'assistant', createdAt: '2026-07-20T02:00:00.000Z' },
    { messageId: 'u2', runId: 'run-2', role: 'user', createdAt: '2026-07-20T02:00:00.000Z' },
    { messageId: 'a1', runId: 'run-1', role: 'assistant', createdAt: '2026-07-20T01:00:00.000Z' },
    { messageId: 'u1', runId: 'run-1', role: 'user', createdAt: '2026-07-20T01:00:00.000Z' }
  ]);
  assert.deepStrictEqual(
    restoredConversation.map((message) => message.messageId),
    ['u1', 'a1', 'u2', 'a2'],
    'restored AI Teacher turns must place each user question before its matching answer'
  );
  const recoverableRun = latestRecoverableTeacherRun([
    { messageId: 'u-failed', runId: 'run-failed', role: 'user', status: 'failed', createdAt: '2026-07-20T02:00:00.000Z' },
    { messageId: 'u-running', runId: 'run-running', role: 'user', status: 'received', createdAt: '2026-07-20T03:00:00.000Z' }
  ]);
  assert.strictEqual(recoverableRun?.runId, 'run-running',
    'refresh recovery must resume only the latest submitted question whose backend run is still active');
  const workspace = {
    entryFile: 'main.sysml',
    activeFilePath: 'main.sysml',
    files: [{
      path: 'main.sysml',
      content: 'package EV {\n  // TODO: expose vehicle in view\n  part vehicle : Vehicle;\n}',
      editable: true,
      source: 'workspace'
    }]
  };
  const clickedDiagnostic = { source: 'course-rule', ruleId: 'missing-expose', message: 'missing expose', line: 2 };
  const otherDiagnostic = { source: 'official-sysml-v2-pilot-2026-04', code: 'SYNTAX_001', message: 'unexpected token', line: 3, column: 3 };
  const activeDiagnosticId = aiTeacherDiagnosticId(clickedDiagnostic);
  const envelope = buildAiTeacherEnvelope({
    questionText: '解释第一条错误',
    threadId: 'thread_1',
    coursePackId: 'sysmlv2-core',
    lesson: { id: 'course-01-lesson-00', title: 'Overview', courseId: 'course-01', tasks: [{ prompt: 'read model' }] },
    workspace,
    validation: {
      syntaxValid: false,
      semanticValid: false,
      coursePassed: false,
      diagnostics: [otherDiagnostic, clickedDiagnostic]
    },
    activeDiagnosticId,
    editorState: 'editing',
    editorContext: {
      cursor: { offset: 18, line: 2, column: 6 },
      selection: {
        from: { offset: 15, line: 2, column: 3 },
        to: { offset: 46, line: 2, column: 34 },
        text: '// TODO: expose vehicle in view',
        empty: false
      },
      symbolName: 'TODO:',
      contextState: {
        focus: 'focused',
        interactionTarget: 'code',
        capturedAt: '2026-07-15T00:00:00.000Z',
        documentRevision: documentRevisionForText(workspace.files[0].content),
        cursorOrigin: 'current'
      }
    }
  });
  assert.strictEqual(envelope.contractVersion, '1.1');
  assert.deepStrictEqual(envelope.question, { text: '解释第一条错误' });
  const manualContinuationEnvelope = buildAiTeacherEnvelope({
    questionText: '解释第一条错误',
    threadId: 'thread_1',
    manualContinuationSourceRunId: 'run_12345678',
    manualContinuationKind: 'engineering_feedback',
    coursePackId: 'sysmlv2-core',
    lesson: { id: 'course-01-lesson-00', title: 'Overview', courseId: 'course-01' },
    workspace
  });
  assert.strictEqual(manualContinuationEnvelope.manualContinuationSourceRunId, 'run_12345678');
  assert.strictEqual(manualContinuationEnvelope.manualContinuationKind, 'engineering_feedback');
  assert.deepStrictEqual(manualContinuationEnvelope.question, { text: '解释第一条错误' },
    'manual continuation must keep the original task text unchanged');
  assert.strictEqual(envelope.editor.files[0].path, 'main.sysml');
  assert.strictEqual(envelope.editor.cursor.line, 2);
  assert.strictEqual(envelope.editor.cursor.offset, 18);
  assert.strictEqual(envelope.editor.selection.text, '// TODO: expose vehicle in view');
  assert.strictEqual(envelope.editor.selection.startOffset, 15);
  assert.strictEqual(envelope.editor.selection.endOffset, 46);
  assert.strictEqual(envelope.editor.selection.empty, false);
  assert.strictEqual(envelope.editor.symbolName, 'TODO:');
  assert.strictEqual(envelope.editor.contextState.cursorOrigin, 'current');
  assert.strictEqual(envelope.editor.contextState.selectionOrigin, 'current');
  const resourceEnvelope = buildAiTeacherEnvelope({
    questionText: 'explain active resource',
    workspace: {
      entryFile: 'main.sysml',
      activeFilePath: 'unused.sysml',
      files: [
        { path: 'main.sysml', content: 'package Main { private import Used::*; }', editable: true },
        { path: 'used.sysml', content: 'package Used {}', editable: false, loadPolicy: 'on-import' },
        { path: 'unused.sysml', content: 'package Unused {}', editable: false, loadPolicy: 'on-import' },
        { path: 'other.sysml', content: 'package Other {}', editable: false, loadPolicy: 'on-import' }
      ]
    }
  });
  assert.deepStrictEqual(
    resourceEnvelope.editor.files.map((file) => file.path),
    ['main.sysml', 'used.sysml', 'unused.sysml'],
    'AI Teacher context must include the import closure and the explicitly opened resource only.'
  );
  assert.strictEqual(envelope.editor.contextState.degradedReason, '');
  assert.strictEqual(envelope.diagnostics.courseRules.length, 1);
  assert.strictEqual(envelope.diagnostics.officialValidator.length, 1);
  assert.strictEqual(envelope.diagnostics.activeDiagnosticId, activeDiagnosticId);
  assert.strictEqual(envelope.diagnostics.courseRules[0].diagnosticId, activeDiagnosticId);
  assert.strictEqual(sanitizeTeacherUiText('Authorization: Bearer secret-token'), 'Authorization=[redacted]');

  const nonCodeEnvelope = buildAiTeacherEnvelope({
    questionText: '这里是什么意思？',
    workspace,
    activeFilePath: 'main.sysml',
    editorContext: {
      ...envelopeEditorContext(envelope.editor),
      contextState: {
        ...envelope.editor.contextState,
        focus: 'blurred',
        interactionTarget: 'course-content',
        cursorOrigin: 'current'
      }
    }
  });
  assert.strictEqual(nonCodeEnvelope.editor.contextState.cursorOrigin, 'last-known');
  assert.strictEqual(nonCodeEnvelope.editor.contextState.selectionOrigin, 'last-known');
  assert.strictEqual(nonCodeEnvelope.editor.contextState.degradedReason, 'non_code_interaction');

  const frozenSelectionEnvelope = buildAiTeacherEnvelope({
    questionText: '解释我刚才明确选中的代码。',
    workspace,
    activeFilePath: 'main.sysml',
    editorContext: {
      ...envelopeEditorContext(envelope.editor),
      contextState: {
        ...envelope.editor.contextState,
        focus: 'blurred',
        interactionTarget: 'ai-panel',
        cursorOrigin: 'frozen-explicit',
        selectionOrigin: 'frozen-explicit'
      }
    }
  });
  assert.strictEqual(frozenSelectionEnvelope.editor.contextState.cursorOrigin, 'frozen-explicit');
  assert.strictEqual(frozenSelectionEnvelope.editor.contextState.selectionOrigin, 'frozen-explicit');
  assert.strictEqual(frozenSelectionEnvelope.editor.contextState.degradedReason, 'explicit_context_frozen');

  const frozenFreeAnswerEnvelope = buildAiTeacherEnvelope({
    questionText: '我自由提问时，这段选区为什么这样写？',
    workspace,
    activeFilePath: 'main.sysml',
    editorContext: {
      ...envelopeEditorContext(envelope.editor),
      contextState: {
        ...envelope.editor.contextState,
        focus: 'blurred',
        interactionTarget: 'ai-panel',
        cursorOrigin: 'frozen-explicit',
        selectionOrigin: 'frozen-explicit'
      }
    }
  });
  assert.deepStrictEqual(frozenFreeAnswerEnvelope.question, { text: '我自由提问时，这段选区为什么这样写？' });
  assert.strictEqual(frozenFreeAnswerEnvelope.editor.selection.text, '// TODO: expose vehicle in view');
  assert.strictEqual(frozenFreeAnswerEnvelope.editor.contextState.cursorOrigin, 'frozen-explicit');
  assert.strictEqual(frozenFreeAnswerEnvelope.editor.contextState.selectionOrigin, 'frozen-explicit');

  const forgedActiveDiagnosticEnvelope = buildAiTeacherEnvelope({
    questionText: '解释被伪造选择的诊断。',
    workspace,
    validation: { diagnostics: [otherDiagnostic, clickedDiagnostic] },
    activeDiagnosticId: 'diag-00000000'
  });
  assert.strictEqual(forgedActiveDiagnosticEnvelope.diagnostics.activeDiagnosticId, null);

  const staleEnvelope = buildAiTeacherEnvelope({
    questionText: '光标附近是什么？',
    workspace,
    activeFilePath: 'main.sysml',
    editorContext: {
      ...envelopeEditorContext(envelope.editor),
      contextState: {
        ...envelope.editor.contextState,
        documentRevision: 'fnv1a32:00000000:74',
        cursorOrigin: 'current'
      }
    }
  });
  assert.strictEqual(staleEnvelope.editor.contextState.cursorOrigin, 'last-known');
  assert.strictEqual(staleEnvelope.editor.contextState.degradedReason, 'stale_document');

  const defaultEnvelope = buildAiTeacherEnvelope({
    questionText: '请先看整个模型。',
    workspace,
    activeFilePath: 'main.sysml'
  });
  assert.strictEqual(defaultEnvelope.editor.contextState.cursorOrigin, 'default');
  assert.strictEqual(defaultEnvelope.editor.contextState.selectionOrigin, 'none');
  assert.strictEqual(defaultEnvelope.editor.contextState.degradedReason, 'default_context');
  assert.strictEqual(defaultEnvelope.editor.selection.empty, true);
  assert.strictEqual(defaultEnvelope.editor.symbolName, '');

  const patch = {
    patchId: 'patch_1',
    title: 'replace line',
    baseFilePath: 'main.sysml',
    baseContentHash: await sha256(workspace.files[0].content),
    previewText: 'part car : Vehicle;',
    validatorStatus: 'validated_passed',
    applyPolicy: 'user_confirm_required',
    validationDiagnostics: [],
    operations: [{
      op: 'replaceRange',
      filePath: 'main.sysml',
      startLine: 3,
      startColumn: 3,
      endLine: 3,
      endColumn: 25,
      replacement: 'part car : Vehicle;'
    }]
  };
  assert.strictEqual(isAiTeacherPatchApplyReady(patch), true);
  assert.strictEqual(lineColumnOffset(workspace.files[0].content, 3, 3), workspace.files[0].content.indexOf('part vehicle'));
  const applied = await applySingleLinePatchToContent(workspace.files[0].content, patch);
  assert.strictEqual(applied.ok, true);
  assert(applied.content.includes('part car : Vehicle;'), 'patch should replace the requested line range');
  const stale = await applySingleLinePatchToContent(`${workspace.files[0].content}\n`, patch);
  assert.strictEqual(stale.ok, false, 'stale baseContentHash should reject direct apply');
}

async function testViewContracts() {
  const workspace = {
    entryFile: 'main.sysml',
    files: [{
      path: 'main.sysml',
      content: `package EV {
  // view ignored : StandardViewDefinitions::GeneralView;
  view outbound : StandardViewDefinitions::StateTransitionView { }
  view lunarOps : StandardViewDefinitions::StateTransitionView { }
  view returnTrip : StandardViewDefinitions::StateTransitionView { }
}`
    }, {
      path: 'baseline.sysml',
      content: 'package InternalBaseline { view hiddenBaseline : StandardViewDefinitions::GeneralView { } }',
      loadPolicy: 'on-import'
    }]
  };
  const plantBody = plantUmlRequestBody(workspace);
  assert.deepStrictEqual(plantBody.layoutOptimization, { mode: 'auto' });
  assert.strictEqual(plantBody.entryFile, 'main.sysml');
  assert.strictEqual(plantBody.viewName, undefined, 'automatic PlantUML selection must omit viewName');
  assert.strictEqual(plantBody.files[1].loadPolicy, 'on-import', 'PlantUML requests must preserve course resource load policy');
  const explicitViews = plantUmlViewOptions(workspace);
  assert.deepStrictEqual(
    explicitViews.map((view) => view.qualifiedName),
    ['EV::outbound', 'EV::lunarOps', 'EV::returnTrip'],
    'PlantUML selector must discover entry-file view usages in source order and ignore comments and dependency views'
  );
  const appendedViewPackageOptions = plantUmlViewOptions({
    entryFile: 'Purpose/StakeholderPackage.sysml',
    files: [{
      path: 'Purpose/StakeholderPackage.sysml',
      content: `package Apollo11::Purpose {
  part def Stakeholder;
}

package Apollo11_CompleteSource_Purpose_StakeholderPackage_Views {
  view fileOverview : StandardViewDefinitions::GeneralView { }
  view memberSlice01 : StandardViewDefinitions::GeneralView { }
}`
    }]
  });
  assert.deepStrictEqual(
    appendedViewPackageOptions.map((view) => view.qualifiedName),
    [
      'Apollo11_CompleteSource_Purpose_StakeholderPackage_Views::fileOverview',
      'Apollo11_CompleteSource_Purpose_StakeholderPackage_Views::memberSlice01'
    ],
    'PlantUML selector must qualify appended course views with their containing package instead of the first package in the file'
  );
  const selectedPlantBody = plantUmlRequestBody(workspace, explicitViews[1].qualifiedName);
  assert.strictEqual(selectedPlantBody.viewName, 'EV::lunarOps', 'PlantUML request must forward the selected qualified view name');
  assert(friendlyPlantUmlError(new Error('PlantUML renderer returned 503')).includes('暂不可用'));
  assert(friendlyPlantUmlError(new Error("RuntimeException: ERROR:Couldn't resolve reference to Element 'Namespace'")).includes('命名空间'));
  const plantNotes = plantUmlMetadataNotes({
    generatedView: { name: 'autoPlantUMLView', exposes: [{ qualifiedName: 'EV::vehicle' }] },
    viewPolicy: { usedGeneratedView: true },
    styles: ['LR', 'ORTHOLINE']
  });
  assert(plantNotes.some((note) => note.includes('临时生成的 PlantUML view') && note.includes('未写入你的 SysML 代码')), 'PlantUML metadata should disclose generated temporary views');
  const officialNotes = plantUmlMetadataNotes({
    styles: [],
    layoutOptimization: {
      mode: 'official-first',
      selected: 'OFFICIAL_DEFAULT',
      attempted: 1,
      switched: false,
      reason: 'official default'
    }
  });
  assert(officialNotes.some((note) => note.includes('官方 Pilot 默认布局')), 'official default metadata must not be misreported as OFFICIAL + DEFAULT styles');
  assert(officialNotes.some((note) => note.includes('共渲染 1 次')), 'official-first metadata must disclose its bounded render count');

  const tallFit = plantUmlViewportFit({
    viewportWidth: 1200,
    viewportHeight: 600,
    svgWidth: 300,
    svgHeight: 1800,
    maximumScale: 1
  });
  assert.strictEqual(tallFit.mode, 'width', 'tall SVG should fit its width rather than shrink the complete height into the viewport');
  assert.strictEqual(tallFit.y, 12);
  assert.strictEqual(tallFit.scale, 1, 'automatic fit must not upscale a small SVG beyond its intrinsic 100% size');
  assert(1800 * tallFit.scale > 600, 'tall fit must intentionally leave vertical content available through panning');
  const wideFit = plantUmlViewportFit({
    viewportWidth: 1200,
    viewportHeight: 600,
    svgWidth: 1800,
    svgHeight: 300
  });
  assert.strictEqual(wideFit.mode, 'contain', 'non-tall SVG should retain whole-view fit');
  assert(1800 * wideFit.scale <= 1200 && 300 * wideFit.scale <= 600);

  const sysonBody = sysonViewRequestBody(workspace, 'phase4-test');
  assert.strictEqual(sysonBody.projectName, 'phase4-test');
  assert.strictEqual(sysonBody.autoGenerateView, true);
  assert.strictEqual(sysonEmbedUrl({ iframe: { src: '/syson/view/embed.html?url=x' } }), '/syson/view/embed.html?url=x');
  assert.strictEqual(sysonViewLabel({ generatedView: { name: 'generated' } }), 'generated');
  assert(friendlySysONError(new Error('not configured'), '').includes('未配置'));
  assert(friendlySysONError(new Error('SysON view proxy failed'), '/syson/view').includes('无法连接 SysON view service'));
}

function testReactPhase4Contracts() {
  const routerTsx = read('apps/web/src/app/router.tsx');
  const shellTsx = read('apps/web/src/app/AppShell.tsx');
  const workbenchTsx = read('apps/web/src/features/workbench/WorkbenchPage.tsx');
  const codeMirrorTsx = read('apps/web/src/features/workbench/SysmlCodeMirror.tsx');
  const envelopeTs = read('apps/web/src/lib/ai-teacher/envelope.ts');
  const viewPaneTsx = read('apps/web/src/features/workbench/ViewPane.tsx');
  const teacherPanelTsx = read('apps/web/src/features/ai-teacher/AiTeacherPanel.tsx');
  const teacherPageTsx = read('apps/web/src/features/ai-teacher/AiTeacherPage.tsx');
  const viteConfigTs = read('apps/web/vite.config.ts');
  const unsupportedMermaidTs = read('apps/web/src/lib/markdown/unsupported-mermaid-diagram.ts');
  const adminPageTsx = read('apps/web/src/features/admin/AdminPage.tsx');
  const resourcePolicyTsx = read('apps/web/src/features/admin/AgentResourcePolicyTab.tsx');
  const executionObservabilityTsx = read('apps/web/src/features/admin/AgentExecutionObservabilityPanel.tsx');
  const appCss = read('apps/web/src/styles/app.css');
  const tokensCss = read('apps/web/src/styles/tokens.css');
  const distJs = readDistText('.js');
  const distCss = readDistText('.css');

  assert(
    tokensCss.includes('--text-body: 13px')
      && tokensCss.includes('--text-title: 22px')
      && tokensCss.includes('--control-height: 30px')
      && tokensCss.includes('--density-editor-font-size: 12.5px')
      && tokensCss.includes('--density-ai-dock-width: 380px')
      && tokensCss.includes('@media (max-width: 720px)')
      && tokensCss.includes('--control-height-lg: 44px'),
    'desktop compact density tokens and readable mobile overrides must stay explicit'
  );
  assert(
    appCss.includes('Default desktop density: compact at browser 100% without scaling the application.')
      && appCss.includes('@media (min-width: 721px)')
      && appCss.includes('font-size: var(--density-editor-font-size)')
      && appCss.includes('width: var(--ai-teacher-dock-width, var(--density-ai-dock-width))')
      && !appCss.includes('zoom: 0.8')
      && !appCss.includes('scale(0.8)'),
    'desktop density must use component tokens instead of whole-application scaling'
  );

  assert(routerTsx.includes("path: 'ai-teacher'"), 'React router must own AI teacher route');
  assert(
    shellTsx.includes('data-ai-teacher-nav-trigger')
    && shellTsx.includes('requestPersistentAiTeacherPanel')
    && shellTsx.includes('data-primary-nav="modeling"')
    && shellTsx.includes("t('navigation.modeling')"),
    'top nav must expose the compact modeling entry and request the AI dock to open'
  );
  assert(workbenchTsx.includes('data-phase4-workbench'), 'workbench must expose Phase4 marker');
  assert(workbenchTsx.includes('workbenchAiDockLayout') && workbenchTsx.includes('<ViewPane') && workbenchTsx.includes('<AiTeacherPanel'), 'workbench must mount Phase4 view and AI assistant dock panels');
  assert(
    workbenchTsx.includes('onPointerDownCapture')
    && workbenchTsx.includes('interactionTargetFromElement')
    && workbenchTsx.includes('groundEditorContextForInteraction'),
    'workbench must downgrade editor grounding after non-code interaction'
  );
  assert(
    workbenchTsx.includes('data-diagnostic-id')
    && workbenchTsx.includes('setActiveDiagnosticId(diagnosticId)')
    && teacherPanelTsx.includes('activeDiagnosticId'),
    'a clicked diagnostic must enter the AI teacher envelope as an explicit active diagnostic id'
  );
  assert(
    codeMirrorTsx.includes('EditorView.domEventHandlers')
    && codeMirrorTsx.includes('documentRevisionForText')
    && codeMirrorTsx.includes("cursorOrigin: originOverride || (focused ? 'current' : 'last-known')"),
    'CodeMirror must capture focus-aware cursor origin and document revision'
  );
  assert(
    envelopeTs.includes("contractVersion: '1.1'")
    && envelopeTs.includes('startOffset: editorContext.selection.from.offset')
    && envelopeTs.includes('contextState: editorContext.contextState'),
    'AI teacher envelope must preserve strict editor offsets, empty state, symbol, and grounding metadata'
  );
  assert(viewPaneTsx.includes("data-view-tab=\"plantuml\"") && viewPaneTsx.includes("data-view-tab=\"syson\""), 'ViewPane must preserve PlantUML/SysON tab anchors');
  assert(viewPaneTsx.includes('/api/plantuml') && viewPaneTsx.includes('/api/analyze') && viewPaneTsx.includes('/api/render'), 'ViewPane must call PlantUML and SysON render APIs');
  assert(
    viewPaneTsx.includes('data-plantuml-view-select')
    && viewPaneTsx.includes('data-plantuml-view-count')
    && viewPaneTsx.includes('viewToolbar plantUmlViewSelectorToolbar')
    && viewPaneTsx.includes('plantUmlViewOptions(workspace)')
    && viewPaneTsx.includes('plantUmlRequestBody(workspace, requestedViewName)'),
    'ViewPane must discover multiple explicit views, expose a selector, and forward the selected viewName'
  );
  assert(
    viewPaneTsx.includes('preferredPlantUmlViewName')
    && viewPaneTsx.includes('preferredPlantUmlView?.qualifiedName')
    && workbenchTsx.includes('preferredPlantUmlViewName={preferredPlantUmlViewName(entity)}'),
    'lesson viewPresentation.primaryView must become the default PlantUML selection before auto-render'
  );
  assert(
    workbenchTsx.includes('const officialValidationPassed = Boolean(validation?.syntaxValid && validation?.semanticValid)')
    && workbenchTsx.includes('if (officialPassed) {')
    && workbenchTsx.includes('setAutoViewRenderRequestId((current) => current + 1)')
    && workbenchTsx.includes('validationPassed={officialValidationPassed}')
    && viewPaneTsx.includes('课程规则只决定任务是否完成'),
    'official syntax/semantic success must allow view rendering even when course rules remain incomplete'
  );
  assert(
    viewPaneTsx.includes('plantUmlCacheRef')
    && viewPaneTsx.includes('workspaceTemplateSignature')
    && viewPaneTsx.includes('视图缓存即时切换')
    && viewPaneTsx.includes('首次按需渲染，已查看视图即时切换')
    && viewPaneTsx.includes('displayedPlantUmlViewRef')
    && viewPaneTsx.includes('data-plantuml-switching'),
    'PlantUML view switching must reuse cache and retain the current canvas while an uncached view renders'
  );
  assert(
    viewPaneTsx.includes('onActiveTabChange?: (target: ViewTab) => void')
    && viewPaneTsx.includes("onActiveTabChange?.('plantuml')")
    && viewPaneTsx.includes("onActiveTabChange?.('syson')")
    && viewPaneTsx.includes("autoRenderTarget === 'syson'")
    && workbenchTsx.includes("const runValidation = async (renderTarget: 'plantuml' | 'syson' = 'plantuml'): Promise<boolean>")
    && workbenchTsx.includes('data-validate')
    && workbenchTsx.includes('data-render-view')
    && workbenchTsx.includes('runValidation(selectedViewTarget)')
    && workbenchTsx.includes('onActiveTabChange={setSelectedViewTarget}')
    && workbenchTsx.includes('autoRenderTarget={autoViewRenderTarget}'),
    'the single editor action must run official validation first and then auto-render the selected PlantUML or SysON target'
  );
  assert(
    viewPaneTsx.includes('data-plantuml-interactive-viewport')
    && viewPaneTsx.includes('data-plantuml-view-toolbar')
    && viewPaneTsx.includes('handleWheel')
    && viewPaneTsx.includes('handlePointerMove')
    && viewPaneTsx.includes('event.preventDefault()')
    && viewPaneTsx.includes('fitView')
    && viewPaneTsx.includes('plantUmlViewportFit')
    && viewPaneTsx.includes('const AUTO_FIT_MAX_SCALE = 1')
    && viewPaneTsx.includes('maximumScale: AUTO_FIT_MAX_SCALE')
    && viewPaneTsx.includes('data-plantuml-fit-mode={fitMode}')
    && viewPaneTsx.includes('intrinsicSize.width * transform.scale')
    && !viewPaneTsx.includes('translate3d(')
    && appCss.includes('.plantUmlSvgCanvas')
    && appCss.includes('pointer-events: none'),
    'PlantUML view must expose pointer pan over the SVG body, wheel zoom, tall-diagram width fit, and vector-preserving controls'
  );
  assert(
    !viewPaneTsx.includes('data-view-meta')
    && !viewPaneTsx.includes('plantUmlMetadataNotes')
    && !viewPaneTsx.includes('SysON 原生视图用于官方工具追溯和语义核对')
    && !viewPaneTsx.includes('PlantUML/SVG 由官方 SysML v2 Pilot Implementation 生成'),
    'ViewPane must not expose renderer implementation metadata to learners'
  );
  assert(teacherPanelTsx.includes('/api/teacher/answer-stream') && teacherPanelTsx.includes('/api/teacher/validate-patch'), 'AI teacher panel must use stream and patch validation routes');
  assert(
    teacherPanelTsx.includes('const DEFAULT_DOCK_WIDTH = 380')
      && teacherPanelTsx.includes('dockWidth: DEFAULT_DOCK_WIDTH'),
    'AI teacher dock must use the compact desktop default width while retaining user resize controls'
  );
  assert(
    teacherPanelTsx.includes('data-feedback-outcome="resolved"')
      && teacherPanelTsx.includes('data-feedback-outcome="unresolved"')
      && teacherPanelTsx.includes('aria-label="有帮助，问题已解决"')
      && teacherPanelTsx.includes('aria-label="没帮助，问题还没解决"')
      && teacherPanelTsx.includes('aria-pressed={feedbackState === \'resolved\'}')
      && teacherPanelTsx.includes('aria-pressed={feedbackState === \'unresolved\'}')
      && teacherPanelTsx.includes('<ThumbsUp aria-hidden="true"')
      && teacherPanelTsx.includes('<ThumbsDown aria-hidden="true"')
      && !teacherPanelTsx.includes('<span>这次解决了吗？</span>')
      && appCss.includes('.aiTeacherTurnFeedback button[data-selected="true"] svg')
      && appCss.includes('width: 30px')
      && appCss.includes('height: 30px'),
    'AI teacher answer feedback must use compact accessible thumbs controls while preserving resolved and unresolved outcomes'
  );
  assert(
    teacherPanelTsx.includes('data-ai-teacher-plantuml-action')
    && teacherPanelTsx.includes('data-ai-teacher-plantuml-dialog')
    && teacherPanelTsx.includes("api.request<PlantUmlRenderResult>('/api/plantuml'")
    && teacherPanelTsx.includes("createPortal(")
    && teacherPanelTsx.includes("event.key === 'Escape'")
    && teacherPanelTsx.includes("document.body.style.overflow = 'hidden'")
    && teacherPanelTsx.includes("document.documentElement.style.overflow = 'hidden'")
    && teacherPanelTsx.includes('document.body.style.overflow = previousBodyOverflow')
    && teacherPanelTsx.includes('document.documentElement.style.overflow = previousRootOverflow')
    && teacherPanelTsx.includes("aria-label={isRenderMaximized ? '还原模型视图' : '最大化模型视图'}")
    && teacherPanelTsx.includes('data-maximized={isRenderMaximized}')
    && teacherPanelTsx.includes('<PlantUmlViewport svgMarkup={renderResult.svg} />')
    && viewPaneTsx.includes('export function PlantUmlViewport')
    && appCss.includes('.aiTeacherPlantUmlDialog')
    && appCss.includes(".aiTeacherPlantUmlDialog[data-maximized='true']")
    && appCss.includes('.aiTeacherPlantUmlCanvas .plantUmlSvgFrame'),
    'AI Teacher SysML code blocks must render through the existing PlantUML API into an accessible, maximizable popup with the shared interactive viewport'
  );
  assert(
    teacherPanelTsx.includes('manualContinuationQuestion(messages, message.id)')
    && teacherPanelTsx.includes('manualContinuationQuestion(messages, sourceMessage.id)')
    && teacherPanelTsx.includes('message.response?.continuation?.sourceRunId')
    && teacherPanelTsx.includes('manualContinuationSourceRunId: effectiveManualSourceRunId || undefined')
    && teacherPanelTsx.includes('text !== MANUAL_CONTINUATION_DISPLAY_TEXT')
    && teacherPanelTsx.includes('for (let index = searchEnd - 1; index >= 0; index -= 1)')
    && !teacherPanelTsx.includes('buildManualContinuationPrompt')
    && !teacherPanelTsx.includes('原始任务要求（继续执行时不得丢失）'),
    'manual continuation must carry an explicit source Run while keeping the original task unchanged'
  );
  assert(
    teacherPanelTsx.includes("kind: 'engineering_feedback'")
      && teacherPanelTsx.includes("manualContinuationKind: effectiveManualKind")
      && teacherPanelTsx.includes('data-ai-teacher-composer-context')
      && teacherPanelTsx.includes('正在基于上一版 Validator-PASS 模型继续改进')
      && teacherPanelTsx.includes('data-ai-teacher-engineering-review')
      && teacherPanelTsx.includes('data-ai-teacher-question-card')
      && teacherPanelTsx.includes('data-ai-teacher-version-dialog')
      && teacherPanelTsx.includes('查看改进前版本')
      && teacherPanelTsx.includes('确认恢复')
      && appCss.includes('.aiTeacherComposerContext')
      && appCss.includes('.aiTeacherEngineeringReviewCard')
      && appCss.includes('.aiTeacherQuestionCard')
      && appCss.includes('.aiTeacherVersionDialog'),
    'engineering feedback and clarification choices must reuse the main composer and inline cards, with an explicit previous-version dialog'
  );
  assert(
    teacherPanelTsx.includes('subscribeAiTeacherSession')
      && teacherPanelTsx.includes('BroadcastChannel')
      && teacherPanelTsx.includes('terminalEventConsumed'),
    'all displays of one AI teacher session must share reactive state and wait for the final event before showing completion'
  );
  assert(
    teacherPanelTsx.includes('orderTeacherConversationMessages(messages)')
      && teacherPanelTsx.includes('runId: message.runId')
      && teacherPanelTsx.includes('latestRecoverableTeacherRun')
      && teacherPanelTsx.includes('正在恢复后台回答')
      && teacherPanelTsx.includes('attempt < 12'),
    'cross-page AI Teacher history must restore causal question-answer order and preserve run correlation'
  );
  assert(
    !/function responseToText[\s\S]*?response\.warnings[\s\S]*?function appendStreamText/u.test(teacherPanelTsx)
      && teacherPanelTsx.includes("label.includes('agentic teaching process')"),
    'internal warnings and Agent governance sections must stay out of the student-visible answer'
  );
  assert(!teacherPanelTsx.includes("const fallbackRoute") && !teacherPanelTsx.includes("/api/teacher/answer'"), 'AI teacher panel must not retry failed streams through a second non-streaming LLM request');
  assert(
    teacherPanelTsx.includes('data-ai-teacher-patch-action')
    && !teacherPanelTsx.includes('data-ai-teacher-action=\"todo-skeleton\"')
    && !teacherPanelTsx.includes('data-ai-teacher-action=\"todo-hint\"'),
    'AI teacher patches must remain while local TODO hint/skeleton UI is removed'
  );
  assert(
    teacherPanelTsx.includes('onKeyDown')
      && teacherPanelTsx.includes('void runTeacher()')
      && teacherPanelTsx.includes('data-ai-teacher-ask')
      && !teacherPanelTsx.includes('data-ai-teacher-action='),
    'AI teacher must expose one natural-language submit entry with Enter support and no task-mode buttons'
  );
  assert(
    teacherPanelTsx.includes('notifyTeacherBusy')
      && teacherPanelTsx.includes('data-ai-teacher-busy-tip')
      && teacherPanelTsx.includes('data-ai-teacher-running={running}')
      && teacherPanelTsx.includes("running ? stopTeacher() : void runTeacher()")
      && teacherPanelTsx.indexOf('aiTeacherRunControllers.get(runSessionKey)?.abort()') < teacherPanelTsx.indexOf('`/api/teacher/runs/${encodeURIComponent(runId)}/cancel?${teacherContextQuery(lesson)}`'),
    'the single submit control must expose busy state and stop the active run instead of starting concurrent work'
  );
  assert(teacherPanelTsx.includes('今日 AI Teacher tokens 已用完，明日重置后可继续使用。') && teacherPanelTsx.includes('本周 AI Teacher tokens 已用完，下周重置后可继续使用。'), 'AI teacher panel must localize daily and weekly quota errors');
  assert(
    teacherPanelTsx.includes("state.user?.id || 'signed-out'")
      && teacherPanelTsx.includes('purgeAiTeacherSessionsForOtherUsers(currentUserId)')
      && teacherPanelTsx.includes('AI_TEACHER_THREAD_OWNER_MISMATCH')
      && teacherPanelTsx.includes('clearAiTeacherSessionThreadReference(runSessionKey')
      && !teacherPanelTsx.includes('THREAD_STORAGE_KEY'),
    'AI teacher sessions must isolate thread references by Better Auth user and remove the legacy global fallback'
  );
  assert(
    teacherPanelTsx.includes('function teacherContextQuery(')
      && teacherPanelTsx.includes("courseId: lesson?.courseId || ''")
      && teacherPanelTsx.includes("teacherContextQuery(lesson, { scope: 'current', limit: 50 })")
      && teacherPanelTsx.includes('threadsRequestController.current?.abort()')
      && teacherPanelTsx.includes('requestSequence !== threadsRequestSequence.current')
      && teacherPanelTsx.includes('activeScopeSessionKey.current !== requestScopeSessionKey'),
    'AI teacher thread history must keep full course identity and ignore stale list responses during authentication changes'
  );
  assert(
    teacherPanelTsx.includes('isActionableValidationFailure')
      && teacherPanelTsx.includes('isQuotaTeacherError(error) || actionableValidationFailure')
      && teacherPanelTsx.includes('!actionableValidationFailure) removeMessages([userId]'),
    'exhausted candidate validation must preserve the student question and show actionable diagnostics instead of a generic service outage'
  );
  assert(teacherPanelTsx.includes('conversationRef') && teacherPanelTsx.includes('scrollConversationToBottom') && teacherPanelTsx.includes('requestAnimationFrame'), 'AI teacher conversation must auto-scroll on new and streaming messages');
  assert(
    teacherPanelTsx.includes('let assistantId = appendMessage({')
      && teacherPanelTsx.includes('activeAssistantMessageId: assistantId')
      && teacherPanelTsx.includes('const totalSeconds = isWorking ? elapsedSeconds + 1 : elapsedSeconds')
      && teacherPanelTsx.includes('window.setInterval(() => setNowMs(Date.now()), 1_000)'),
    'AI teacher must create the answer timer at submission, start at second 1, and refresh every second while running'
  );
  assert(
    teacherPanelTsx.includes("import ReactMarkdown, { type Components } from 'react-markdown'")
      && teacherPanelTsx.includes("import remarkGfm from 'remark-gfm'")
      && teacherPanelTsx.includes('remarkPlugins={[remarkGfm]}')
      && teacherPanelTsx.includes('className="aiTeacherTableScroll"')
      && teacherPanelTsx.includes('const components = useMemo<Components>')
      && !teacherPanelTsx.includes('function renderInlineMarkdown'),
    'AI teacher answers must use a stable maintained CommonMark/GFM pipeline instead of the line-oriented custom parser'
  );
  assert(
    teacherPanelTsx.includes("const { default: mermaid } = await import('mermaid')")
      && teacherPanelTsx.includes("securityLevel: 'strict'")
      && teacherPanelTsx.includes("secure: ['securityLevel', 'secure', 'startOnLoad', 'maxTextSize', 'flowchart']")
      && teacherPanelTsx.includes('sandbox=""')
      && teacherPanelTsx.includes("default-src 'none'")
      && teacherPanelTsx.includes('data-ai-teacher-mermaid'),
    'AI teacher Mermaid diagrams must lazy-load the maintained renderer and stay inside the strict CSP sandbox'
  );
  assert(
    teacherPanelTsx.includes('data-ai-teacher-mermaid-expand')
      && teacherPanelTsx.includes('data-ai-teacher-mermaid-dialog')
      && teacherPanelTsx.includes('aria-modal="true"')
      && teacherPanelTsx.includes("event.key !== 'Escape'")
      && teacherPanelTsx.includes('createPortal('),
    'AI teacher Mermaid diagrams must provide a keyboard-accessible full-screen viewer'
  );
  assert(
    teacherPanelTsx.includes("当前轻量渲染器不支持 mindmap，请改用 flowchart")
      && viteConfigTs.includes('mindmap-definition-')
      && viteConfigTs.includes('flowchart-elk-definition-')
      && unsupportedMermaidTs.includes('export const diagram = {}'),
    'optional oversized Mermaid diagram engines must fail clearly instead of bypassing the Web chunk budget'
  );
  assert(teacherPanelTsx.includes('TeacherCodeBlock') && teacherPanelTsx.includes('aria-label="复制代码块"') && teacherPanelTsx.includes('copyText(code)'), 'AI teacher markdown code blocks must expose one-click copy');
  assert(teacherPanelTsx.includes('data-code-validation-status') && teacherPanelTsx.includes('aiTeacherCodeValidationLights') && teacherPanelTsx.includes('验证未通过 · 需人工复查'), 'AI teacher SysML code blocks must show validator traffic-light status and human-review warning text');
  assert(teacherPanelTsx.includes('panelRef') && teacherPanelTsx.includes("event.key === 'Escape'"), 'AI teacher panel must focus on open and close on Escape');
  assert(
    teacherPanelTsx.includes('aiTeacherResizeHandle')
      && teacherPanelTsx.includes('--ai-teacher-dock-width')
      && teacherPanelTsx.includes('左右拖动调整 AI 教师宽度')
      && teacherPanelTsx.includes("event.key === 'ArrowLeft'")
      && teacherPanelTsx.includes("event.key === 'ArrowRight'"),
    'AI teacher dock must expose pointer and keyboard width resizing in docked mode'
  );
  assert(
    teacherPanelTsx.includes('data-ai-teacher-launcher')
    && teacherPanelTsx.includes("launcherMode === 'docked' || open")
    && workbenchTsx.includes("const modelNavigationInTeacher = mode === 'lesson' || mode === 'bench'")
    && workbenchTsx.includes("launcherMode={modelNavigationInTeacher ? 'docked' : 'none'}")
    && workbenchTsx.includes('defaultOpen={modelNavigationInTeacher}')
    && workbenchTsx.includes('modelNavigation={modelNavigationInTeacher ? modelNavigationPanel : undefined}'),
    'lesson and bench pages must share the contextual AI teacher dock with embedded model navigation'
  );
  assert(teacherPageTsx.includes('data-ai-teacher-page'), 'AI teacher page marker must exist');
  assert(
    adminPageTsx.includes("data-ai-teacher-admin-tab=\"resources\"")
      && adminPageTsx.includes('<AgentResourcePolicyTab')
      && adminPageTsx.includes("activeTab === 'resources'"),
    'admin page must expose a focused Agent resource policy workspace'
  );
  assert(
    adminPageTsx.includes('data-ai-teacher-admin-hero')
      && !adminPageTsx.includes("activeTab !== 'resources' ? <div className=\"phase4Hero\""),
    'AI Teacher admin hero must remain visible in the Agent resource policy workspace'
  );
  assert(
    resourcePolicyTsx.includes('/api/admin/ai-teacher/resource-policy/catalog')
      && resourcePolicyTsx.includes('/api/admin/ai-teacher/resource-policy/versions')
      && resourcePolicyTsx.includes('/api/admin/ai-teacher/resource-policy/active')
      && resourcePolicyTsx.includes('/validate')
      && resourcePolicyTsx.includes('/publish')
      && resourcePolicyTsx.includes('/rollback')
      && resourcePolicyTsx.includes('data-policy-key='),
    'resource policy workspace must cover catalog, version, deterministic validation, publication, rollback, and field-level anchors'
  );
  assert(
    resourcePolicyTsx.includes('不可配置硬门')
      && resourcePolicyTsx.includes('当前差异')
      && resourcePolicyTsx.includes('新 Run 生效')
      && resourcePolicyTsx.includes('确认发布当前策略'),
    'resource policy workspace must make invariants, diff, activation mode, and destructive confirmation visible'
  );
  assert(
    resourcePolicyTsx.includes("valueType: 'integer' | 'boolean' | 'model-ref'")
      && resourcePolicyTsx.includes("definition.valueType === 'model-ref'")
      && resourcePolicyTsx.includes('modelRegistry.profiles')
      && resourcePolicyTsx.includes('<select')
      && resourcePolicyTsx.includes('已注册模型 Alias')
      && resourcePolicyTsx.includes('data-alias-status=')
      && resourcePolicyTsx.includes('未注册，需要迁移')
      && resourcePolicyTsx.includes('data-unregistered-model-references='),
    'stage model routes must use registered LiteLLM aliases from the model registry instead of arbitrary text input'
  );
  assert(
    resourcePolicyTsx.includes('<AgentExecutionObservabilityPanel')
      && executionObservabilityTsx.includes('/api/admin/ai-teacher/execution-checkpoints?runId=')
      && executionObservabilityTsx.includes('data-agent-execution-observability')
      && executionObservabilityTsx.includes('运行诊断与恢复证据'),
    'resource policy workspace must embed the read-only Run checkpoint diagnostics query'
  );
  assert(
    executionObservabilityTsx.includes('正常长任务')
      && executionObservabilityTsx.includes('无进展 Repair')
      && executionObservabilityTsx.includes('Provider 超时')
      && executionObservabilityTsx.includes('Checkpoint 失败')
      && executionObservabilityTsx.includes('上下文膨胀')
      && executionObservabilityTsx.includes('前端结果：')
      && executionObservabilityTsx.includes('错误分类：'),
    'Run diagnostics must distinguish long work, stalled Repair, provider timeout, checkpoint failure, context bloat, and frontend degradation evidence'
  );
  assert(
    executionObservabilityTsx.includes('METRIC_FIELDS')
      && executionObservabilityTsx.includes('safeDiagnosticText')
      && !executionObservabilityTsx.includes('candidateContent')
      && !executionObservabilityTsx.includes('reasoningContent')
      && !executionObservabilityTsx.includes('JSON.stringify'),
    'Run diagnostics must render only allowlisted metadata and never raw Candidate, reasoning, or response JSON'
  );
  assert(appCss.includes('.phase4ViewPane') && appCss.includes('.phase4AiTeacher'), 'Phase4 CSS must include view and AI teacher styles');
  assert(
    appCss.includes('.agentResourcePolicyLayout')
      && appCss.includes('.agentResourcePolicyHeader')
      && appCss.includes('position: sticky')
      && /\.agentResourcePolicyHeader\s*\{[^}]*top:\s*0;/.test(appCss)
      && appCss.includes('.agentResourcePolicyField'),
    'resource policy CSS must pin its sticky action surface to the viewport edge without a content passthrough gap'
  );
  assert(
    appCss.includes('.agentExecutionObservability')
      && appCss.includes('.agentExecutionTimeline')
      && appCss.includes('.agentExecutionCheckpointStatus')
      && appCss.includes("[data-diagnostic-kind='checkpoint-failed']"),
    'Run diagnostics must provide responsive timeline and anomaly status styling'
  );
  assert(appCss.includes('.aiTeacherPanelReact[hidden]') && appCss.includes('display: none'), 'AI teacher panel hidden state must not be overridden by grid display');
  assert(appCss.includes('height: calc(100dvh - var(--guide-sticky-top) - var(--ai-dock-top-offset) - 32px)') && !appCss.includes('min(720px, 68vh'), 'AI teacher dock must fill the available desktop viewport height without an artificial 720px or 68vh cap');
  assert(appCss.includes('.primary[data-ai-teacher-running="true"]') && appCss.includes('fill: currentColor'), 'AI teacher submit control must expose a visually distinct stop state');
  assert(appCss.includes('.workbenchAiDockLayout') && appCss.includes('grid-template-columns: minmax(0, 1fr) auto'), 'AI teacher must use an independent dock column');
  assert(
    appCss.includes('.aiTeacherResizeHandle')
      && appCss.includes('cursor: col-resize')
      && appCss.includes('width: var(--ai-teacher-dock-width, 420px)')
      && appCss.includes('grid-template-columns: minmax(0, 1fr) auto'),
    'AI teacher dock must support width resizing without a fixed 390px dock column'
  );
  assert(
    appCss.includes('.phase4AiTeacher[data-ai-teacher-launcher-mode="docked"][data-ai-teacher-open="true"]')
      && appCss.includes('min-width: 0')
      && appCss.includes('max-width: none'),
    'AI teacher dock must release desktop resize bounds at responsive single-column widths'
  );
  assert(appCss.includes('background: var(--surface)') && appCss.includes('box-shadow: var(--shadow)'), 'AI teacher dock must use the white system surface styling');
  assert(appCss.includes('--ai-dock-top-offset') && appCss.includes('margin-top: var(--ai-dock-top-offset)') && appCss.includes('top: var(--guide-sticky-top)'), 'AI teacher dock must keep its initial lesson baseline and share the model-navigation sticky top while floating');
  assert(appCss.includes('grid-row: 2 / 4') && appCss.includes('.lockedFeature + .aiTeacherBody'), 'AI teacher body must fill the dock height with or without the locked banner');
  assert(appCss.includes('.aiTeacherConversationEmpty') && appCss.includes('min-height: 100%'), 'AI teacher empty state must occupy the full conversation viewport');
  assert(appCss.includes('.aiTeacherConversation') && appCss.includes('overflow-anchor: none'), 'AI teacher conversation must disable scroll anchoring so auto-scroll can reach new answers');
  assert(appCss.includes('.aiTeacherBusyTip') && appCss.includes('button[aria-disabled="true"]'), 'AI teacher busy hint and disabled action state must be styled');
  assert(
    appCss.includes('.aiTeacherTableScroll')
      && appCss.includes('width: max-content')
      && appCss.includes('overscroll-behavior-inline: contain')
      && appCss.includes('.aiTeacherMermaidFrame')
      && appCss.includes('.aiTeacherMermaidDialogFrame')
      && appCss.includes('.aiTeacherMermaidError'),
    'AI teacher GFM tables must have a meaningful local scroll range and Mermaid must style inline/full-screen states'
  );
  assert(appCss.includes('.aiTeacherCodeValidation[data-status="passed"]') && appCss.includes('.aiTeacherCodeLight-red') && appCss.includes('.aiTeacherCodeLight-green'), 'AI teacher code block validation lights must style pass/fail states');
  assert(distJs.includes('data-phase4-workbench') && distJs.includes('data-ai-teacher-panel') && distJs.includes('data-view-tab'), 'built bundle must include Phase4 markers');
  assert(distJs.includes('/api/teacher/answer-stream') && distJs.includes('/api/plantuml') && distJs.includes('/api/render'), 'built bundle must include Phase4 API paths');
  assert(distJs.includes('今日 AI Teacher tokens 已用完') && distJs.includes('本周 AI Teacher tokens 已用完'), 'built bundle must include localized quota errors');
  assert(distCss.includes('phase4ViewPane') && distCss.includes('phase4AiTeacher'), 'built CSS must include Phase4 styles');
  assert(distCss.includes('aiTeacherCodeBlock') && distCss.includes('background:#fff'), 'built CSS must keep AI teacher code blocks on a white background');
  assert(distCss.includes('aiTeacherTableScroll') && distCss.includes('aiTeacherMermaidFrame'), 'built CSS must include AI teacher table and Mermaid rendering styles');
}

function envelopeEditorContext(editor) {
  return {
    cursor: editor.cursor,
    selection: {
      from: {
        offset: editor.selection.startOffset,
        line: editor.selection.startLine,
        column: editor.selection.startColumn
      },
      to: {
        offset: editor.selection.endOffset,
        line: editor.selection.endLine,
        column: editor.selection.endColumn
      },
      text: editor.selection.text,
      empty: editor.selection.empty
    },
    symbolName: editor.symbolName
  };
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
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
