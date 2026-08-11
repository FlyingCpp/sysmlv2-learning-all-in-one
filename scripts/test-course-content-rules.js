'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createCourseStore } = require('../apps/api/course-store');
const { evaluateRules } = require('../apps/api/rules');
const { validateWorkspace: analyzeWorkspace } = require('../apps/validator/local-analyzer');

const ROOT = path.resolve(__dirname, '..');
const COURSE_PACK = process.env.COURSE_PACK || 'ev-sysml-v2-foundation';
const store = createCourseStore({
  coursesRoot: path.join(ROOT, 'courses'),
  coursePack: COURSE_PACK
});
const IS_EV_PACK = store.packId === 'ev-sysml-v2-foundation';
const IS_APOLLO_PACK = ['apollo-11-sysml-v2-foundation', 'apollo-11-cosma-engineering'].includes(store.packId);
const IS_APOLLO_WALKTHROUGH_PACK = store.packId === 'apollo-11-cosma-walkthrough';
const ACTIVE_PACK = store.loadPack();
const IS_MODEL_USER_PACK = ACTIVE_PACK.domain === 'sysmlv2-certification'
  || ACTIVE_PACK.id === 'sysmlv2-model-user-cert-prep-v1.2.0';

const failures = [];
let lessonCount = 0;
const visualSignaturesByCourse = new Map();

for (const course of store.loadCourses()) {
  const courseBase = path.posix.dirname(course._path.replaceAll('\\', '/'));
  checkCourseCardAsset(course);
  for (const lessonRef of course.lessons || []) {
    const lessonPath = normalizeLessonPath(courseBase, lessonRef);
    const rawLesson = readCourseJson(lessonPath);
    const lesson = store.loadLesson(rawLesson.id);
    lessonCount += 1;

    checkTodoGuidance({ course, lesson, rawLesson, lessonPath });
    checkRuleRequiredNamesAreVisible({ course, lesson, rawLesson, lessonPath });
    checkLessonMissionContent({ course, rawLesson, lessonPath });
    checkConceptDrawers({ course, rawLesson, lessonPath });
    checkLearnerFacingWording({ course, rawLesson, lessonPath });
    checkReviewedCourseQuality({ course, lesson, rawLesson, lessonPath });
    if (IS_APOLLO_WALKTHROUGH_PACK) {
      checkApolloWalkthroughQuality({ course, lesson, rawLesson, lessonPath });
    }
    if (IS_APOLLO_PACK) {
      checkApolloCourseQuality({ course, lesson, rawLesson, lessonPath });
    }
    if (IS_EV_PACK) {
      checkSyntaxNamingGuidance({ course, lesson, rawLesson, lessonPath });
      checkEarlyItemDefGuidance({ course, lesson, rawLesson, lessonPath });
      checkCourse02ItemUsageAnchors({ course, lesson, rawLesson, lessonPath });
      checkRequirementCourseQuality({ course, lesson, rawLesson, lessonPath });
      checkAnalysisCourseQuality({ course, lesson, rawLesson, lessonPath });
      checkVerificationCourseQuality({ course, lesson, rawLesson, lessonPath });
      checkIntegrationCourseQuality({ course, lesson, rawLesson, lessonPath });
      checkP3CourseQuality({ course, lesson, rawLesson, lessonPath });
    }
    checkViewPresenceAndTeaching({ course, lesson, rawLesson, lessonPath });
  }
}

if (IS_EV_PACK) {
  checkEngineeringParameterConsistency();
  checkEvFinalProjectChallenge();
}
checkCoursePackSysmlViews();
checkCoursePackResourceBoundaries();
if (IS_MODEL_USER_PACK) checkModelUserExamContract();
if (store.packId === 'sysmlv2-gallery-practice') checkGalleryPracticeRuleSpoofResistance();
if (IS_APOLLO_WALKTHROUGH_PACK) checkApolloWalkthroughPackContract();

if (failures.length > 0) {
  console.error('course content rules failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

assert(lessonCount > 0, 'expected at least one lesson to validate');
console.log(`course content rules passed (${lessonCount} lessons)`);

function checkConceptDrawers({ course, rawLesson, lessonPath }) {
  const label = `${course.id}/${rawLesson.id} (${lessonPath})`;
  const blocks = Array.isArray(rawLesson.learningBlocks) ? rawLesson.learningBlocks : [];
  const hintCards = blocks.filter((block) => block.type === 'hint-card' || block.type === 'tip');
  if (hintCards.length > 4) {
    failures.push(`${label}: hint-card concept drawers should be reserved for high-frequency learner questions; found ${hintCards.length}, keep the main explanation readable in plain markdown.`);
  }
  const genericDrawerTitles = new Set([
    '视图定位',
    '读模要点',
    '语法读法',
    '语法拆解',
    '新概念',
    '建模方法',
    '标准写法',
    '标准语义',
    '权威依据',
    '扩展概念',
    '字段清单',
    '固定步骤与路径',
    '固定 bind / flow 路径',
    '状态机基础',
    '设计规则',
    '嵌套状态',
    '模型组织',
    '图形预览说明',
    '中场回顾'
  ]);
  for (const [index, block] of blocks.entries()) {
    if (block.type !== 'markdown') continue;
    const content = String(block.content || block.body || block.markdown || block.text || '').trim();
    if (content.length > 900 && !/^(工程意图|练习步骤)[:：]/.test(content)) {
      failures.push(`${label}: long concept explanations should be hint-card drawers. Block ${index + 1} is ${content.length} chars.`);
    }
  }
  for (const [index, block] of hintCards.entries()) {
    const title = String(block.title || '').trim();
    if (!title) {
      failures.push(`${label}: hint-card ${index + 1} must have a learner-facing drawer title.`);
    }
    if (genericDrawerTitles.has(title)) {
      failures.push(`${label}: hint-card ${index + 1} has generic title "${title}". Use hint-card only for high-frequency questions or misconceptions, not ordinary reading/modeling sections.`);
    }
    if (!String(block.label || block.badge || '').trim()) {
      failures.push(`${label}: hint-card ${index + 1} must have a short label for the right side of the drawer summary.`);
    }
    if (!String(block.content || block.body || block.markdown || block.text || '').trim()) {
      failures.push(`${label}: hint-card ${index + 1} must have explanatory drawer content.`);
    }
  }
}

function checkLessonMissionContent({ course, rawLesson, lessonPath }) {
  const label = `${course.id}/${rawLesson.id} (${lessonPath})`;
  if (Object.prototype.hasOwnProperty.call(rawLesson, 'learningSteps')) {
    failures.push(`${label}: learningSteps is deprecated; put learner guidance into task prompts, hints, scenario text, and learningBlocks instead.`);
    return;
  }
  const tasks = Array.isArray(rawLesson.tasks) ? rawLesson.tasks : [];
  if (!tasks.length) {
    failures.push(`${label}: lesson must define at least one modeling task now that learningSteps has been removed.`);
    return;
  }
  const text = tasks
    .map((task) => `${task.title || ''}\n${task.prompt || ''}\n${task.description || ''}\n${Array.isArray(task.hints) ? task.hints.join('\n') : ''}`)
    .join('\n');
  const firstTaskText = String(tasks[0].prompt || tasks[0].description || '').trim();
  if (firstTaskText.length < 34) {
    failures.push(`${label}: first modeling task prompt is too thin for the fixed task panel; explain the engineering context and modeling deliverable.`);
  }
  if (/先确认这节课要解决什么汽车设计问题，以及/.test(text)) {
    failures.push(`${label}: task guidance must not use the generic "先确认这节课要解决什么汽车设计问题" placeholder; name the concrete engineering problem and deliverable.`);
  }
  const genericGuidancePhrases = [
    '看清工程问题',
    '把模型和实物对上',
    '按任务修改模型',
    '运行检查并修正',
    '复盘可复用做法',
    '对照工程场景、文字导读和代码，找到关键对象在模型里的位置。',
    '回头确认本节模型解决了什么工程问题，并记录可以迁移到真实项目的做法。',
    '按任务提示补全模型，不确定时先保持已有命名和结构，再逐步调整。'
  ];
  for (const phrase of genericGuidancePhrases) {
    if (text.includes(phrase)) {
      failures.push(`${label}: task guidance must be lesson-specific engineering guidance, not a generic template. Found: ${phrase}`);
    }
  }
  if (/预计|分钟|时间建议/.test(text)) {
    failures.push(`${label}: lesson task guidance should not use minute-based time pressure.`);
  }
  const engineeringContextTerms = [
    '工程',
    '场景',
    '评审',
    '安全',
    '责任',
    '证据',
    '需求',
    '目标',
    '系统',
    '车辆',
    '整车',
    '电池',
    '高压',
    'BMS',
    '项目',
    '设计',
    '验证',
    '测试',
    '控制',
    '接口',
    '结构',
    '行为',
    '状态',
    '模型',
    '对象',
    '参数',
    '配置',
    '链',
    '边界',
    '模式',
    '故障',
    '风险',
    '验收',
    '交付',
    '子系统',
    '电驱',
    '充电',
    '续航',
    '质量',
    '绝缘',
    '道路',
    '电机',
    '扭矩',
    '制动',
    '功率',
    '能耗',
    '样车',
    'Apollo',
    'NASA',
    '任务',
    '航天',
    '发射',
    '轨道',
    '登月',
    '月球',
    '飞行',
    '乘员',
    '指令舱',
    '登月舱',
    'Saturn',
    'CSM',
    'LM',
    'TLI',
    'EVA',
    'docking',
    'powered descent',
    'Mission'
  ];
  if (!engineeringContextTerms.some((term) => text.includes(term))) {
    failures.push(`${label}: task guidance lacks engineering context. Add design background, review reason, risk, responsibility, or domain meaning.`);
  }
  if (/把\s+[^，。；;]{2,40}\s+从\s+[^，。；;]{2,40}\s+拆成/.test(firstTaskText)) {
    failures.push(`${label}: first modeling task reads like a modeling operation summary ("把 X 从 A 拆成 B"). Explain why the decomposition matters in the engineering scenario.`);
  }
}

function checkCourseCardAsset(course) {
  const label = `${course.id} (${course._path})`;
  const src = course.thumbnail?.src || course.visual?.src || '';
  if (!src) {
    failures.push(`${label}: course cards must define a course-pack thumbnail image.`);
    return;
  }
  if (!src.startsWith('/api/course-assets/')) {
    failures.push(`${label}: course thumbnail must load through /api/course-assets/, got ${src}.`);
    return;
  }
  const assetPath = src.slice('/api/course-assets/'.length);
  const asset = store.loadAsset(assetPath);
  if (!asset || !asset.content?.length) {
    failures.push(`${label}: course thumbnail asset is missing: ${assetPath}.`);
  }
}

function checkViewPresenceAndTeaching({ course, lesson, rawLesson, lessonPath }) {
  const label = `${course.id}/${lesson.id} (${lessonPath})`;
  const workspaceText = (lesson.workspace?.files || []).map((file) => file.content || '').join('\n');
  if (!/\bview\s+(?!def\b)[A-Za-z_][\w]*\s*:/.test(workspaceText)) {
    failures.push(`${label}: every lesson starter must contain an explicit view usage so learners see model content through a review entry.`);
  }
  if (!/StandardViewDefinitions::/.test(workspaceText)) {
    failures.push(`${label}: lesson starter views must be tied to StandardViewDefinitions so custom names do not hide the standard view type.`);
  }
  if (IS_EV_PACK && course.id === 'course-01' && lesson.id.endsWith('lesson-00')) {
    const lessonText = collectContentText(rawLesson).join('\n');
    requireAll(
      label,
      lessonText,
      ['GeneralView', 'InterconnectionView', 'ActionFlowView', 'StateTransitionView', 'SequenceView', 'GeometryView', 'GridView', 'BrowserView', 'viewer', 'expose'],
      'Course 1 must introduce standard view categories, viewer support limits, and expose semantics.'
    );
  }
}

function checkCoursePackSysmlViews() {
  const sysmlFiles = listFiles(store.packDir)
    .filter((file) => file.endsWith('.sysml'))
    .filter((file) => !path.relative(store.packDir, file).replaceAll('\\', '/').startsWith('references/'));
  for (const file of sysmlFiles) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('：')) {
      failures.push(`${path.relative(ROOT, file)}: SysML starter/example code must use ASCII ':' for type annotations, not full-width Chinese colon '：'.`);
    }
    if (!/\bview\s+(?!def\b)[A-Za-z_][\w]*\s*:/.test(text)) {
      failures.push(`${path.relative(ROOT, file)}: every SysML file in the course pack must include an explicit view usage.`);
    }
    if (IS_APOLLO_PACK) {
      const bannedLegacyNames = [
        /\bMissionContextPackage\b/,
        /\bAnalysisAndExecutionPackage\b/,
        /\bGuidePoweredDescent\b/,
        /\bPerformLOIBurn\b/,
        /\bExecutePoweredDescent\b(?!Burn)/,
        /\bMissionPowerAnalysis\b/,
        /\bEstimatePowerMargin\b/
      ];
      for (const pattern of bannedLegacyNames) {
        if (pattern.test(text)) {
          failures.push(`${path.relative(ROOT, file)}: Apollo SysML content still contains legacy or invented naming ${pattern}; align with the Airbus upstream package/object names.`);
        }
      }
    }
  }
}

function requireNoFixedInterfaceUsageNames({ label, lesson, owner }) {
  const rules = normalizeLessonRules(lesson.validation?.rules);
  const fixedInterfaceNames = rules
    .map((rule) => rule.selector || {})
    .filter((selector) => (selector.parent === owner || selector.parentName === owner) && (selector.kind === 'interface' || selector.childKind === 'interface') && selector.name)
    .map((selector) => selector.name);
  if (fixedInterfaceNames.length > 0) {
    failures.push(`${label}: interface usage names under ${owner} should not be fixed when type and endpoint paths are the learning target. Fixed names: ${fixedInterfaceNames.join(', ')}`);
  }
}

function requireNoFixedTransitionUsageNames({ label, lesson, owner }) {
  const rules = normalizeLessonRules(lesson.validation?.rules);
  const fixedTransitionNames = rules
    .map((rule) => rule.selector || {})
    .filter((selector) => (selector.parent === owner || selector.parentName === owner) && (selector.kind === 'transition' || selector.childKind === 'transition') && selector.name)
    .map((selector) => selector.name);
  if (fixedTransitionNames.length > 0) {
    failures.push(`${label}: transition usage names under ${owner} should not be fixed when source, target, event, and guard are the learning target. Fixed names: ${fixedTransitionNames.join(', ')}`);
  }
}

function checkCoursePackResourceBoundaries() {
  const pack = store.loadPack();
  const label = `${store.packId}/course-pack.json`;
  const bannedManifestFields = ['examples', 'glossary', 'relatedExamples', 'exampleRefs', 'relatedApps', 'appRefs'];
  for (const field of bannedManifestFields) {
    if (Object.prototype.hasOwnProperty.call(pack, field)) {
      failures.push(`${label}: course pack must not declare platform or legacy resource field "${field}".`);
    }
  }
  for (const legacyPath of ['glossary.json', 'examples']) {
    if (fs.existsSync(path.join(store.packDir, legacyPath))) {
      failures.push(`${store.packId}: legacy course-pack resource path must be removed: ${legacyPath}`);
    }
  }
  const jsonFiles = listFiles(store.packDir).filter((file) => file.endsWith('.json'));
  for (const file of jsonFiles) {
    const relativePath = path.relative(ROOT, file).replaceAll('\\', '/');
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('#/examples')) {
      failures.push(`${relativePath}: course content must not link to legacy #/examples routes.`);
    }
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (Object.prototype.hasOwnProperty.call(parsed, 'exampleIds')) {
      failures.push(`${relativePath}: course content must not declare exampleIds after example resources are deprecated.`);
    }
  }
}

function checkEvFinalProjectChallenge() {
  const finalProject = store.loadFinalProject();
  const starterFiles = finalProject.workspace?.files || [];
  const starterText = starterFiles.map((file) => file.content || '').join('\n');
  const starterStrictResult = analyzeWorkspace({ files: starterFiles });
  const starterResult = evaluateRules({
    rules: finalProject.validation?.rules,
    files: starterFiles,
    strictResult: starterStrictResult
  });
  if (!/\bTODO\b/u.test(starterText)) {
    failures.push(`${store.packId}/final-project: starter must contain learner-facing TODO markers.`);
  }
  if (starterResult.coursePassed) {
    failures.push(`${store.packId}/final-project: starter must not satisfy all final-project rules without learner changes.`);
  }

  const completedPath = path.join(store.packDir, 'final-project', 'completed.sysml');
  if (!fs.existsSync(completedPath)) {
    failures.push(`${store.packId}/final-project: completed.sysml must provide the reviewed reference model.`);
    return;
  }
  const completedFiles = [{ path: 'main.sysml', content: fs.readFileSync(completedPath, 'utf8') }];
  const completedStrictResult = analyzeWorkspace({ files: completedFiles });
  const completedResult = evaluateRules({
    rules: finalProject.validation?.rules,
    files: completedFiles,
    strictResult: completedStrictResult
  });
  if (!completedStrictResult.valid || !completedResult.coursePassed) {
    failures.push(`${store.packId}/final-project: completed.sysml must pass local syntax and all final-project rules.`);
  }
}

function checkGalleryPracticeRuleSpoofResistance() {
  const cases = [
    {
      label: 'lesson conceptReviewView',
      entity: store.loadLesson('course-01-lesson-01'),
      viewName: 'conceptReviewView'
    },
    {
      label: 'final project finalReviewView',
      entity: store.loadFinalProject(),
      viewName: 'finalReviewView'
    }
  ];

  for (const testCase of cases) {
    const content = `package Gallery_Practice_Adversarial {
  part def SmartCoffeeMachine;
  part coffeeMachine : SmartCoffeeMachine;
  // view ${testCase.viewName} : StandardViewDefinitions::GeneralView
  view ${testCase.viewName} {
    expose SmartCoffeeMachine;
    expose coffeeMachine;
  }
}`;
    const files = [{ path: 'main.sysml', content }];
    const strictResult = analyzeWorkspace({ files });
    const result = evaluateRules({
      rules: testCase.entity.validation?.rules,
      files,
      strictResult
    });
    if (result.coursePassed) {
      failures.push(`${testCase.label}: a comment must not satisfy the required StandardViewDefinitions::GeneralView typing rule.`);
    }
  }
}

function checkModelUserExamContract() {
  const pack = store.loadPack();
  const label = `${store.packId}/Model User exam contract`;
  const exam = pack.examOverview || {};
  const expectedFormats = ['hotspot', 'matching', 'multiple', 'single'];

  if (pack.version !== '1.3.0') {
    failures.push(`${label}: the rebuilt Clause 7 course must publish as version 1.3.0.`);
  }
  if (exam.questionCount !== 90 || exam.scoredQuestionCount !== 90) {
    failures.push(`${label}: official Model User scale must remain 90 scored questions.`);
  }
  if (!String(exam.passingScore || '').includes('63/90')) {
    failures.push(`${label}: official passing score must be recorded as 63/90.`);
  }
  if (exam.time?.nativeEnglish !== '150 minutes' || exam.time?.otherRegions !== '180 minutes') {
    failures.push(`${label}: official time limits must remain 150/180 minutes.`);
  }
  if (JSON.stringify([...(exam.questionTypes || [])].sort()) !== JSON.stringify(expectedFormats)) {
    failures.push(`${label}: response formats must be single, multiple, hotspot, and matching only.`);
  }

  const expectedWeights = {
    foundations: { weight: 39, lessonCount: 12 },
    behavior: { weight: 33, lessonCount: 10 },
    structure: { weight: 18, lessonCount: 6 },
    'requirements-constraints': { weight: 5, lessonCount: 2 },
    cases: { weight: 3, lessonCount: 1 },
    metadata: { weight: 2, lessonCount: 1 }
  };
  const actualWeights = Object.fromEntries((pack.domainWeighting || []).map((entry) => [entry.id, {
    weight: entry.weight,
    lessonCount: entry.lessonCount
  }]));
  if (!Object.entries(expectedWeights).every(([id, expected]) => (
    actualWeights[id]?.weight === expected.weight
    && actualWeights[id]?.lessonCount === expected.lessonCount
  )) || Object.keys(actualWeights).length !== Object.keys(expectedWeights).length) {
    failures.push(`${label}: domain weights/lesson allocation must be 39/33/18/5/3/2 and 12/10/6/2/1/1.`);
  }

  const scopeText = (pack.scopeNotes || []).join('\n');
  for (const clause of ['7.23', '7.24', '7.26']) {
    if (!scopeText.includes(clause)) {
      failures.push(`${label}: scope notes must explicitly record ${clause} as a syllabus-boundary appendix, not invent a weight for it.`);
    }
  }

  const lessonPrompts = new Set();
  const supportedRuleKinds = new Set([
    'action',
    'actionDef',
    'actor',
    'allocation',
    'assertConstraint',
    'attribute',
    'attributeDef',
    'calc',
    'calculationDef',
    'connection',
    'constraint',
    'constraintDef',
    'dependency',
    'enumDef',
    'flow',
    'in',
    'inout',
    'interface',
    'interfaceDef',
    'item',
    'itemDef',
    'message',
    'metadata',
    'metadataDef',
    'occurrence',
    'occurrenceDef',
    'out',
    'part',
    'partDef',
    'port',
    'portDef',
    'requirement',
    'requirementDef',
    'return',
    'satisfy',
    'snapshot',
    'state',
    'stateDef',
    'succession',
    'transition',
    'useCase',
    'useCaseDef'
  ]);
  const evaluatedStarterLessonIds = new Set();
  let modelUserLessonCount = 0;
  for (const course of store.loadCourses()) {
    const courseBase = path.posix.dirname(course._path.replaceAll('\\', '/'));
    for (const lessonRef of course.lessons || []) {
      const lessonPath = normalizeLessonPath(courseBase, lessonRef);
      const lesson = readCourseJson(lessonPath);
      modelUserLessonCount += 1;
      const task = (lesson.tasks || [])[0] || {};
      const lessonLabel = `${course.id}/${lesson.id}`;
      const hydratedLesson = store.loadLesson(lesson.id);
      const lessonRules = normalizeLessonRules(hydratedLesson.validation?.rules);
      checkModelUserRuleSelectors({
        lessonLabel,
        rules: lessonRules,
        supportedRuleKinds
      });
      evaluatedStarterLessonIds.add(lesson.id);
      const files = hydratedLesson.workspace?.files || [];
      const structure = analyzeWorkspace({ files });
      const courseRuleResult = evaluateRules({
        rules: lessonRules,
        files,
        // 官方语法/语义由 test:course-official 单独把关；这里隔离验证本地规则契约。
        strictResult: { ...structure, syntaxValid: true, semanticValid: true }
      });
      const failedRuleIds = courseRuleResult.lessonResults
        .filter((result) => !result.passed)
        .map((result) => result.id);
      if (failedRuleIds.length > 0) {
        failures.push(`${lessonLabel}: published read-model starter must pass every configured course rule; failed: ${failedRuleIds.join(', ')}.`);
      }
      if (lesson.type !== 'model-reading-lesson') {
        failures.push(`${lessonLabel}: Model User lessons must train model reading, not builder-style TODO completion.`);
      }
      if (!String(lesson.examObjective || '').trim() || !String(lesson.questionFormat || '').trim()) {
        failures.push(`${lessonLabel}: every lesson must declare an examObjective and questionFormat.`);
      }
      if (!expectedFormats.includes(task.type) || lesson.questionFormat !== task.type) {
        failures.push(`${lessonLabel}: task type and questionFormat must agree on one official response format.`);
      }
      if (task.responseMode !== 'offline-review') {
        failures.push(`${lessonLabel}: the current platform boundary must remain explicit as offline-review.`);
      }
      const prompt = String(task.prompt || '').trim();
      if (lessonPrompts.has(prompt)) {
        failures.push(`${lessonLabel}: Model User task prompts must be lesson-specific; duplicate prompt found.`);
      }
      lessonPrompts.add(prompt);
      if (course.id === 'course-01' && lesson.id === 'course-01-lesson-02') {
        requireAll(
          lessonLabel,
          prompt,
          ['一一匹配', 'Battery → part definition', 'batteryA → 被注解的 part usage', 'doc → Battery 拥有的 documentation', 'comment about batteryA → 指向 batteryA 的 annotation relationship'],
          'C01 L02 matching must define one unique role for every model fragment.'
        );
      }
      const workspaceText = (lesson.workspace?.files || []).map((file) => file.content || '').join('\n');
      if (course.id === 'course-06' && lesson.id === 'course-06-lesson-03') {
        const hydratedLesson = store.loadLesson(lesson.id);
        const modelText = (hydratedLesson.workspace?.files || []).map((file) => file.content || '').join('\n');
        const rules = normalizeLessonRules(hydratedLesson.validation?.rules);
        const startActionRule = rules.find((rule) => rule.id === 'action-start-system');
        const firstSuccessionRule = rules.find((rule) => rule.id === 'succession-start-system-check');
        const secondSuccessionRule = rules.find((rule) => rule.id === 'succession-check-enable');
        if (!/action\s+startSystem\s*:\s*StartSystem\s*;/.test(modelText)
            || /action\s+start\s*:\s*StartSystem\s*;/.test(modelText)
            || !/first\s+startSystem\s+then\s+check\s*;/.test(modelText)
            || !/first\s+check\s+then\s+enable\s*;/.test(modelText)) {
          failures.push(`${lessonLabel}: the standard model must use the unambiguous business action startSystem and preserve startSystem -> check -> enable.`);
        }
        if (startActionRule?.type !== 'childElementExists'
            || startActionRule.selector?.parent !== 'StartupProcedure'
            || startActionRule.selector?.name !== 'startSystem') {
          failures.push(`${lessonLabel}: action-start-system must require startSystem directly under StartupProcedure; wildcard parent selectors are not supported.`);
        }
        if (firstSuccessionRule?.type !== 'relationshipExists'
            || firstSuccessionRule.selector?.parent !== 'StartupProcedure'
            || firstSuccessionRule.selector?.sourceName !== 'startSystem'
            || firstSuccessionRule.selector?.targetName !== 'check') {
          failures.push(`${lessonLabel}: succession-start-system-check must constrain owner, source, and target.`);
        }
        if (secondSuccessionRule?.type !== 'relationshipExists'
            || secondSuccessionRule.selector?.parent !== 'StartupProcedure'
            || secondSuccessionRule.selector?.sourceName !== 'check'
            || secondSuccessionRule.selector?.targetName !== 'enable') {
          failures.push(`${lessonLabel}: succession-check-enable must constrain owner, source, and target.`);
        }
      }
      if (course.id === 'course-06' && lesson.id === 'course-06-lesson-00') {
        const flowRule = lessonRules.find((rule) => rule.id === 'flow-pump');
        if (flowRule?.selector?.payloadType !== 'Coolant'
            || flowRule.selector?.sourceName !== 'pump.outlet.coolant'
            || flowRule.selector?.targetName !== 'hx.inlet.coolant') {
          failures.push(`${lessonLabel}: flow-pump must constrain payloadType=Coolant and the complete source/target feature paths.`);
        }
        let mutationApplied = false;
        const withoutPayload = files.map((file) => ({
          ...file,
          content: String(file.content || '').replace('flow of Coolant from', () => {
            mutationApplied = true;
            return 'flow from';
          })
        }));
        if (!mutationApplied) {
          failures.push(`${lessonLabel}: payload negative-test fixture could not remove "of Coolant" from the published starter.`);
        } else {
          const mutatedStructure = analyzeWorkspace({ files: withoutPayload });
          const mutatedResult = evaluateRules({
            rules: lessonRules,
            files: withoutPayload,
            strictResult: { ...mutatedStructure, syntaxValid: true, semanticValid: true }
          });
          const mutatedFlowRule = mutatedResult.lessonResults.find((result) => result.id === 'flow-pump');
          if (!mutatedFlowRule || mutatedFlowRule.passed) {
            failures.push(`${lessonLabel}: removing "of Coolant" must fail flow-pump even when source and target remain unchanged.`);
          }
        }
      }
      if (course.id === 'course-06' && lesson.id === 'course-06-lesson-02') {
        const statusRule = lessonRules.find((rule) => rule.id === 'item-status');
        if (statusRule?.type !== 'childElementExists'
            || statusRule.selector?.parent !== 'ProcessCommand'
            || statusRule.selector?.kind !== 'out'
            || statusRule.selector?.name !== 'status'
            || statusRule.selector?.typeName !== 'Status') {
          failures.push(`${lessonLabel}: item-status must match the project projection out status : Status directly under ProcessCommand.`);
        }
      }
      if (course.id === 'course-07' && lesson.id === 'course-07-lesson-01') {
        const transitionRule = lessonRules.find((rule) => rule.id === 'transition-off');
        if (transitionRule?.type !== 'relationshipExists'
            || transitionRule.selector?.parent !== 'DeviceState'
            || transitionRule.selector?.sourceName !== 'Off'
            || transitionRule.selector?.targetName !== 'On'
            || transitionRule.selector?.triggerName !== 'StartSignal') {
          failures.push(`${lessonLabel}: transition-off must remain a strict relationship rule for DeviceState Off --StartSignal--> On.`);
        }
        let mutationApplied = false;
        const withWrongTrigger = files.map((file) => ({
          ...file,
          content: String(file.content || '').replace('transition first Off accept StartSignal then On;', () => {
            mutationApplied = true;
            return 'transition first Off accept StopSignal then On;';
          })
        }));
        if (!mutationApplied) {
          failures.push(`${lessonLabel}: transition negative-test fixture could not replace StartSignal on Off -> On.`);
        } else {
          const mutatedStructure = analyzeWorkspace({ files: withWrongTrigger });
          const mutatedResult = evaluateRules({
            rules: lessonRules,
            files: withWrongTrigger,
            strictResult: { ...mutatedStructure, syntaxValid: true, semanticValid: true }
          });
          const mutatedTransitionRule = mutatedResult.lessonResults.find((result) => result.id === 'transition-off');
          if (!mutatedTransitionRule || mutatedTransitionRule.passed) {
            failures.push(`${lessonLabel}: changing the Off -> On trigger to StopSignal must fail transition-off.`);
          }
        }
      }
      if (course.id === 'course-08' && lesson.id === 'course-08-lesson-00') {
        const assertedConstraintRule = lessonRules.find((rule) => rule.id === 'constraint-checka');
        const assertedConstraintResult = courseRuleResult.lessonResults.find((result) => result.id === 'constraint-checka');
        if (assertedConstraintRule?.type !== 'elementExists'
            || assertedConstraintRule.selector?.kind !== 'assertConstraint'
            || assertedConstraintRule.selector?.name !== 'checkA'
            || !assertedConstraintResult?.passed) {
          failures.push(`${lessonLabel}: constraint-checka must positively match the published assert constraint checkA projection.`);
        }
      }
      if (course.id === 'course-08' && lesson.id === 'course-08-lesson-03') {
        const metadataRule = lessonRules.find((rule) => rule.id === 'metadata-critical-application');
        if (metadataRule?.selector?.metadataDefinitionName !== 'CriticalMetadata'
            || metadataRule.selector?.metadataKeyword !== 'critical'
            || metadataRule.selector?.annotatedElementName !== 'criticalComponent') {
          failures.push(`${lessonLabel}: metadata-critical-application must bind CriticalMetadata/#critical to criticalComponent.`);
        }
        let mutationApplied = false;
        const withoutMetadataApplication = files.map((file) => ({
          ...file,
          content: String(file.content || '').replace('#critical part criticalComponent', () => {
            mutationApplied = true;
            return 'part criticalComponent';
          })
        }));
        if (!mutationApplied) {
          failures.push(`${lessonLabel}: metadata negative-test fixture could not remove #critical from criticalComponent.`);
        } else {
          const mutatedStructure = analyzeWorkspace({ files: withoutMetadataApplication });
          const mutatedResult = evaluateRules({
            rules: lessonRules,
            files: withoutMetadataApplication,
            strictResult: { ...mutatedStructure, syntaxValid: true, semanticValid: true }
          });
          const mutatedMetadataRule = mutatedResult.lessonResults.find((result) => result.id === 'metadata-critical-application');
          if (!mutatedMetadataRule || mutatedMetadataRule.passed) {
            failures.push(`${lessonLabel}: removing #critical must fail metadata-critical-application.`);
          }
        }
      }
      if (/\bTODO\b/i.test(workspaceText)) {
        failures.push(`${lessonLabel}: read-model lessons must provide a complete model instead of a builder TODO starter.`);
      }
      const lessonText = collectContentText(lesson).join('\n');
      if (/最终[^。\n]*只考|明确不考|never tested/i.test(lessonText)) {
        failures.push(`${lessonLabel}: syllabus discrepancies must be framed as weighted scope notes, not unsupported claims that a normative clause can never be tested.`);
      }
    }
  }
  if (modelUserLessonCount !== 32 || lessonPrompts.size !== 32) {
    failures.push(`${label}: the weighted curriculum must contain 32 lessons with 32 distinct reading tasks.`);
  }
  if (evaluatedStarterLessonIds.size !== 32) {
    failures.push(`${label}: all 32 Model User read-model lessons must execute their published starter rules; evaluated: ${evaluatedStarterLessonIds.size}.`);
  }

  const semanticMetadataFiles = listFiles(store.packDir)
    .filter((file) => file.endsWith('.sysml'))
    .filter((file) => fs.readFileSync(file, 'utf8').includes(':> SemanticMetadata'));
  for (const file of semanticMetadataFiles) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/occurrence\s+criticalUsages\s*\[\*\]\s+nonunique\s*;/.test(text)
        || !/metadata\s+def\s+<critical>\s+CriticalMetadata\s*:>\s*SemanticMetadata\s*\{[\s\S]*?:>>\s*baseType\s*=\s*criticalUsages\s+meta\s+SysML::Usage\s*;[\s\S]*?\}/.test(text)) {
      failures.push(`${path.relative(ROOT, file)}: SemanticMetadata must bind inherited baseType to criticalUsages meta SysML::Usage; specialization alone is incomplete.`);
    }
  }

  const mockPath = path.join(store.packDir, 'mock-questions.json');
  const mock = JSON.parse(fs.readFileSync(mockPath, 'utf8'));
  const questions = Array.isArray(mock.questions) ? mock.questions : [];
  if (questions.length !== 90) {
    failures.push(`${label}: the offline mock must contain exactly 90 original practice questions.`);
    return;
  }

  const expectedDomainCounts = {
    foundations: 35,
    behavior: 30,
    structure: 16,
    'requirements-constraints': 4,
    cases: 3,
    metadata: 2
  };
  const expectedTypeCounts = { single: 57, multiple: 13, matching: 11, hotspot: 9 };
  const domainCounts = {};
  const typeCounts = {};
  const questionIds = new Set();
  const englishPrompts = new Set();
  const englishRationales = new Set();
  const bannedEnglishDistractors = [
    'It automatically creates a verification verdict.',
    'It converts the referenced element into a package.',
    'It is only a graphical layout convention with no model semantics.',
    'It defines physical composition between parts.',
    "It changes the enclosing namespace's import visibility.",
    'It automatically proves a requirement is verified.',
    'It is determined only by the left-to-right diagram layout.',
    'It automatically satisfies every related requirement.',
    'It converts an endpoint into an enumeration literal.',
    'It creates a physical port on the subject.',
    'It is only a numerical calculation with no Boolean meaning.',
    'Check whether the two part names have the same length.'
  ];

  for (const question of questions) {
    const questionLabel = `${label}/${question.id || 'missing-id'}`;
    domainCounts[question.domain] = (domainCounts[question.domain] || 0) + 1;
    typeCounts[question.type] = (typeCounts[question.type] || 0) + 1;
    if (!question.id || questionIds.has(question.id)) {
      failures.push(`${questionLabel}: mock question ids must be present and unique.`);
    }
    questionIds.add(question.id);
    if (!expectedFormats.includes(question.type)) {
      failures.push(`${questionLabel}: unsupported response type ${question.type}.`);
    }
    const englishPrompt = String(question.englishPrompt || '').trim();
    if (!englishPrompt || englishPrompts.has(englishPrompt)) {
      failures.push(`${questionLabel}: every mock item needs a distinct English prompt because the official exam is English-only.`);
    }
    englishPrompts.add(englishPrompt);
    const englishRationale = String(question.englishRationale || '').trim();
    if (!englishRationale) {
      failures.push(`${questionLabel}: every English item needs a review rationale.`);
    } else if (/^Review the Clause 7\./.test(englishRationale) || englishRationales.has(englishRationale)) {
      failures.push(`${questionLabel}: English rationale must explain this item and its trap, not reuse a clause-level template.`);
    }
    englishRationales.add(englishRationale);
    if ((question.englishChoices || []).some((choice) => bannedEnglishDistractors.includes(choice))) {
      failures.push(`${questionLabel}: English distractors must be clause-specific, not reusable generic filler.`);
    }
    if (Array.isArray(question.choices) && question.choices.length !== (question.englishChoices || []).length) {
      failures.push(`${questionLabel}: Chinese and English choice sets must have the same cardinality.`);
    }

    if (question.type === 'single') {
      if (!String(question.englishAnswer || '').trim() || !(question.englishChoices || []).includes(question.englishAnswer)) {
        failures.push(`${questionLabel}: single-choice English answer must exist in englishChoices.`);
      }
    } else if (question.type === 'multiple') {
      if (!Array.isArray(question.englishAnswers) || question.englishAnswers.length !== (question.answers || []).length) {
        failures.push(`${questionLabel}: multiple-choice English answer count must match the source item.`);
      } else if (question.englishAnswers.some((answer) => !(question.englishChoices || []).includes(answer))) {
        failures.push(`${questionLabel}: every multiple-choice English answer must exist in englishChoices.`);
      }
    } else if (question.type === 'matching') {
      if (!Array.isArray(question.englishPairs) || question.englishPairs.length !== (question.pairs || []).length) {
        failures.push(`${questionLabel}: matching English pair count must match the source item.`);
      }
    } else if (question.type === 'hotspot') {
      if (!Array.isArray(question.englishTargets) || question.englishTargets.length !== (question.targets || []).length) {
        failures.push(`${questionLabel}: hotspot English target count must match the source item.`);
      }
    }
  }

  const plainConstraintQuestion = questions.find((question) => question.id === 'MU13-R-001');
  if (plainConstraintQuestion?.answer !== '在给定上下文中可求值为 true 或 false 的 Boolean predicate'
      || plainConstraintQuestion?.englishAnswer !== 'A Boolean predicate that may evaluate to true or false in a given context.'
      || !String(plainConstraintQuestion?.englishRationale || '').includes('assert constraint')) {
    failures.push(`${label}/MU13-R-001: plain constraint must be a Boolean predicate that may be satisfied or violated; only an assert constraint requires a specified truth value.`);
  }
  const satisfyQuestion = questions.find((question) => question.id === 'MU13-R-002');
  if (!String(satisfyQuestion?.answer || '').includes('绑定为 cityRange 的 subject，并断言该需求得到满足')
      || !String(satisfyQuestion?.englishAnswer || '').includes('binds ev as the subject of cityRange, and asserts that the requirement is satisfied')) {
    failures.push(`${label}/MU13-R-002: satisfy must be taught as a requirement-satisfaction assertion with subject binding, not only a design-responsibility label.`);
  }

  if (!Object.entries(expectedDomainCounts).every(([id, count]) => domainCounts[id] === count)
      || Object.keys(domainCounts).length !== Object.keys(expectedDomainCounts).length) {
    failures.push(`${label}: the 90-question mock must round official weights to 35/30/16/4/3/2.`);
  }
  if (!Object.entries(expectedTypeCounts).every(([id, count]) => typeCounts[id] === count)
      || Object.keys(typeCounts).length !== Object.keys(expectedTypeCounts).length) {
    failures.push(`${label}: mock response mix must remain 57/13/11/9 for single/multiple/matching/hotspot.`);
  }
  const englishFormIds = mock.englishForm?.questionIds || [];
  if (englishFormIds.length !== 90 || new Set(englishFormIds).size !== 90 || englishFormIds.some((id) => !questionIds.has(id))) {
    failures.push(`${label}: englishForm must reference each of the 90 mock questions exactly once.`);
  }
}

function checkModelUserRuleSelectors({ lessonLabel, rules, supportedRuleKinds }) {
  if (!rules.length) {
    failures.push(`${lessonLabel}: published read-model lesson must define course rules.`);
    return;
  }
  for (const rule of rules) {
    const selector = rule.selector || {};
    for (const field of ['parent', 'parentName', 'parentAnyOf', 'parentNames']) {
      const values = Array.isArray(selector[field]) ? selector[field] : [selector[field]];
      if (values.includes('*')) {
        failures.push(`${lessonLabel}/${rule.id}: wildcard parent selector ${field}="*" is unsupported; bind the rule to the learner-visible owner.`);
      }
    }
    for (const field of ['kind', 'parentKind', 'childKind', 'childParentKind']) {
      const kind = selector[field];
      if (kind && !supportedRuleKinds.has(kind)) {
        failures.push(`${lessonLabel}/${rule.id}: unknown ${field} alias "${kind}"; use a supported rule-engine or project model-element kind.`);
      }
    }
  }
}

function checkTodoGuidance({ course, lesson, rawLesson, lessonPath }) {
  const workspaceText = (lesson.workspace?.files || []).map((file) => file.content || '').join('\n');
  const lessonText = collectContentText(rawLesson).join('\n');
  const workspaceHasTodo = /\bTODO\b/i.test(workspaceText);
  const lessonMentionsTodo = /\bTODO\b/i.test(lessonText);
  const label = `${course.id}/${lesson.id} (${lessonPath})`;

  if (workspaceHasTodo && !lessonMentionsTodo) {
    failures.push(`${label}: starter contains TODO markers, but lesson text never tells the learner how to use them.`);
  }

  if (lessonMentionsTodo && !workspaceHasTodo) {
    failures.push(`${label}: lesson text mentions TODO, but the starter workspace does not contain TODO markers.`);
  }

  if (workspaceHasTodo || lessonMentionsTodo) {
    const requiredPhrases = ['课程模板', '已恢复草稿', '重置为课程模板'];
    for (const phrase of requiredPhrases) {
      if (!lessonText.includes(phrase)) {
        failures.push(`${label}: TODO guidance must mention "${phrase}" so restored drafts do not make instructions misleading.`);
      }
    }
  }

  const maxTodoLineLength = 92;
  workspaceText.split(/\r?\n/).forEach((line, index) => {
    if (/\bTODO\b/i.test(line) && line.length > maxTodoLineLength) {
      failures.push(`${label}: TODO comments in starter code must stay readable in the editor. Line ${index + 1} is ${line.length} chars; move details to lesson text or shorten it below ${maxTodoLineLength}.`);
    }
    if (/\bTODO\b/i.test(line)) {
      checkTodoLineClarity({ label, line, lineNumber: index + 1 });
    }
  });

  const starterTodoNumbers = extractTodoNumbers(workspaceText);
  const referencedTodoNumbers = extractTodoNumbers(lessonText);
  for (const number of referencedTodoNumbers) {
    if (!starterTodoNumbers.has(number)) {
      failures.push(`${label}: lesson text references TODO ${number}, but starter workspace has no matching TODO ${number}.`);
    }
  }
}

function checkRuleRequiredNamesAreVisible({ course, lesson, rawLesson, lessonPath }) {
  const workspaceText = (lesson.workspace?.files || []).map((file) => file.content || '').join('\n');
  if (!/\bTODO\b/i.test(workspaceText)) return;
  const rules = normalizeLessonRules(lesson.validation?.rules);
  if (rules.length === 0) return;

  const label = `${course.id}/${lesson.id} (${lessonPath})`;
  const lessonText = collectContentText(rawLesson).join('\n');
  const visibleText = `${workspaceText}\n${lessonText}`;
  const requiredNames = new Set();

  for (const rule of rules) {
    const selector = rule.selector || {};
    if (typeof selector.name === 'string' && selector.name) requiredNames.add(selector.name);
    if (typeof selector.targetName === 'string' && selector.targetName) requiredNames.add(selector.targetName);
  }

  const missing = [...requiredNames].filter((name) => !visibleText.includes(name));
  if (missing.length > 0) {
    failures.push(`${label}: course rules require fixed model names that are not visible before validation. Add them to TODOs, lesson text, tasks, or hint cards. Missing: ${missing.join(', ')}`);
  }
}

function checkTodoLineClarity({ label, line, lineNumber }) {
  const todo = String(line || '').trim();
  if (todo.includes(';')) {
    failures.push(`${label}: TODO line ${lineNumber} must not provide a complete copy-paste SysML statement with a semicolon; describe the modeling task and move guidance to lesson text or code cards.`);
  }

  if (/(?:两个|若干|多个|\d+\s*个)\s*out\s*输出|out\s*输出(?:参数)?\s*(?:若干|多个|两个|\d+\s*个)/i.test(todo)) {
    failures.push(`${label}: TODO line ${lineNumber} must list output parameter names and group them by direction instead of saying "两个 out 输出". Line: ${todo}`);
  }

  const checks = [
    {
      when: /参数/.test(todo),
      must: /\battribute\b|\bin\b|\bout\b|\bbind\b|in\/out|绑定|结构参数/i,
      message: 'parameter TODOs must say whether the learner is adding attribute parameters, in/out parameters, or a binding.'
    },
    {
      when: /端口/.test(todo),
      must: /\bport\b|\bref\s+item\b|\binterface\s+connect\b/i,
      message: 'port TODOs must name port usage, ref item, or interface connect instead of only saying "端口".'
    },
    {
      when: /引用.*交换/.test(todo),
      must: /\bref\s+item\b/i,
      message: 'exchange-object reference TODOs must name ref item.'
    },
    {
      when: /流向/.test(todo),
      must: /\bflow\b/i,
      message: 'flow-direction TODOs must name flow.'
    },
    {
      when: /暴露/.test(todo),
      must: /\bexpose\b/i,
      message: 'view exposure TODOs must name expose.'
    },
    {
      when: /满足/.test(todo),
      must: /\bsatisfy\b/i,
      message: 'requirement responsibility TODOs must name satisfy.'
    }
  ];

  for (const check of checks) {
    if (check.when && !check.must.test(todo)) {
      failures.push(`${label}: TODO line ${lineNumber} is underspecified. ${check.message} Line: ${todo}`);
    }
  }
}

function checkReviewedCourseQuality({ course, lesson, rawLesson, lessonPath }) {
  if (!['course-03', 'course-04', 'course-05', 'course-06', 'course-07', 'course-08', 'course-09', 'course-10'].includes(course.id)) return;
  if (rawLesson.type === 'model-reading-lesson') return;
  const label = `${course.id}/${lesson.id} (${lessonPath})`;
  const workspaceText = (lesson.workspace?.files || []).map((file) => file.content || '').join('\n');
  if (!/\bTODO\b/i.test(workspaceText)) {
    failures.push(`${label}: reviewed lessons must use hands-on TODO starter work, not completed read-only examples.`);
  }

  const signature = visualSignature(rawLesson.scenario?.visual);
  if (signature) {
    if (!visualSignaturesByCourse.has(course.id)) visualSignaturesByCourse.set(course.id, new Map());
    const signatures = visualSignaturesByCourse.get(course.id);
    const previous = signatures.get(signature);
    if (previous) {
      failures.push(`${label}: scenario visual duplicates ${previous}; reviewed lessons need lesson-specific visual nodes.`);
    } else {
      signatures.set(signature, lesson.id);
    }
  }
}

function checkApolloWalkthroughQuality({ course, lesson, rawLesson, lessonPath }) {
  const label = `${course.id}/${lesson.id} (${lessonPath})`;
  const files = lesson.workspace?.files || [];
  const workspaceText = files.map((file) => file.content || '').join('\n');
  const lessonText = collectContentText(rawLesson).join('\n');
  const entryFile = lesson.workspace?.entryFile || 'main.sysml';
  const entry = files.find((file) => file.path === entryFile);
  const upstreamDependencies = files.filter((file) => String(file.path || '').startsWith('upstream/'));

  if (rawLesson.type !== 'model-reading-lesson') {
    failures.push(`${label}: Apollo walkthrough lessons must use type model-reading-lesson.`);
  }
  if (files.length < 29 || entry?.editable !== true || files.some((file) => file.path !== entryFile && file.editable !== false)) {
    failures.push(`${label}: Apollo walkthrough workspaces must contain an editable complete main model plus all read-only upstream dependencies; lesson-specific baselines are optional.`);
  }
  if (upstreamDependencies.length !== 28
      || !['upstream/Program/ProgramPackage.sysml', 'upstream/Purpose/MissionPackage.sysml', 'upstream/CoSMA/CoSMAPackage.sysml', 'upstream/Technical/AstronautsPackage.sysml']
        .every((requiredPath) => upstreamDependencies.some((file) => file.path === requiredPath))) {
    failures.push(`${label}: Apollo walkthrough workspace must carry all 28 pinned Airbus SysML resources, including Program, Mission, CoSMA and Astronauts packages.`);
  }
  if (upstreamDependencies.some((file) => file.loadPolicy !== 'on-import')) {
    failures.push(`${label}: every upstream SysML resource must use the generic on-import load policy.`);
  }
  if (/\bTODO\b/i.test(`${workspaceText}\n${lessonText}`)) {
    failures.push(`${label}: Apollo walkthrough lessons must be complete reading models without TODO markers.`);
  }
  if (!/编译|校验/.test(lessonText) || !/视图|view/.test(lessonText)) {
    failures.push(`${label}: Apollo walkthrough tasks must explicitly guide learners to compile/validate and inspect a view.`);
  }
  const codeBlock = (rawLesson.learningBlocks || []).find((block) => block.type === 'code');
  if (codeBlock?.sourceFile !== 'model.sysml') {
    failures.push(`${label}: Apollo walkthrough code blocks must point to the complete model.sysml artifact.`);
  }
  if (rawLesson.id === 'course-00-lesson-01') {
    const rules = lesson.validation?.rules?.rules || lesson.validation?.rules || [];
    if (!files.some((file) => file.path === 'upstream/Apollo11Model.sysml')) {
      failures.push(`${label}: the package template must retain upstream/Apollo11Model.sysml for source integrity.`);
    }
    if (rules.some((rule) => rule.id === 'upstream-root-file'
        || (rule.type === 'fileExists' && rule.path === 'upstream/Apollo11Model.sysml'))) {
      failures.push(`${label}: package-level Apollo11Model.sysml integrity must not be enforced as a runtime learner fileExists rule after on-import closure resolution.`);
    }
  }
}

function checkApolloWalkthroughPackContract() {
  const pack = store.loadPack();
  const finalProject = store.loadFinalProject();
  const finalFiles = finalProject.workspace?.files || [];
  const finalText = finalFiles.map((file) => file.content || '').join('\n');
  const finalEntryFile = finalProject.workspace?.entryFile || 'main.sysml';
  const finalEntry = finalFiles.find((file) => file.path === finalEntryFile);
  const finalUpstreamDependencies = finalFiles.filter((file) => String(file.path || '').startsWith('upstream/'));

  if (lessonCount !== 13) {
    failures.push(`${store.packId}: the guided CoSMA argument must contain one model-atlas lesson plus 12 engineering-review lessons; found ${lessonCount}.`);
  }
  if (pack.sourceBasis?.commit !== '6e9c93fe7d80c5ca3534bb14b10ab374a643ef2d') {
    failures.push(`${store.packId}: sourceBasis must pin the verified Airbus Apollo 11 upstream commit.`);
  }
  if (pack.entryCourseId !== 'course-00'
      || pack.sourceBasis?.integrityManifest !== 'references/upstream-source-integrity.json') {
    failures.push(`${store.packId}: the walkthrough must enter through the model atlas and publish its upstream byte-integrity manifest.`);
  }
  if (finalFiles.length < 31 || finalEntry?.editable !== true
      || finalFiles.some((file) => file.path !== finalEntryFile && file.editable !== false)
      || finalUpstreamDependencies.length !== 28
      || finalUpstreamDependencies.some((file) => file.loadPolicy !== 'on-import')) {
    failures.push(`${store.packId}: the integrated review workspace must contain an editable complete main model plus the read-only pinned upstream dependency closure.`);
  }
  if (/\bTODO\b/i.test(finalText)) {
    failures.push(`${store.packId}: the integrated review model must not contain TODO markers.`);
  }
}

function checkLearnerFacingWording({ course, rawLesson, lessonPath }) {
  const label = `${course.id}/${rawLesson.id} (${lessonPath})`;
  const lessonText = collectContentText(rawLesson).join('\n');
  const implementationTerms = [
    ['regex', 'regular-expression implementation details'],
    ['正则', 'regular-expression implementation details'],
    ['惩罚', 'punitive wording'],
    ['文本 contains', 'text-matching implementation details'],
    ['代码文本片段', 'text-snippet implementation details']
  ];
  for (const [term, message] of implementationTerms) {
    if (lessonText.includes(term)) {
      failures.push(`${label}: learner-facing course text should explain model-structure checks, not ${message}. Found: ${term}`);
    }
  }
}

function checkApolloCourseQuality({ course, lesson, rawLesson, lessonPath }) {
  const label = `${course.id}/${rawLesson.id} (${lessonPath})`;
  const workspaceText = (lesson.workspace?.files || []).map((file) => file.content || '').join('\n');
  const lessonText = collectContentText(rawLesson).join('\n');
  const combinedText = `${workspaceText}\n${lessonText}`;

  const stages = Array.isArray(rawLesson.practiceStages) ? rawLesson.practiceStages : [];
  if (stages.length < 3) {
    failures.push(`${label}: Apollo lessons must use practiceStages staged locking with at least three stages, following the Course10 staged-practice pattern.`);
  }
  for (const [index, stage] of stages.entries()) {
    if (!stage.id || !stage.title || !stage.goal || !Array.isArray(stage.ruleIds) || stage.ruleIds.length === 0) {
      failures.push(`${label}: Apollo practiceStage ${index + 1} must define id, title, goal, and non-empty ruleIds.`);
    }
  }

  const bannedLegacyNames = [
    /\bMissionContextPackage\b/,
    /\bAnalysisAndExecutionPackage\b/,
    /\bGuidePoweredDescent\b/,
    /\bPerformLOIBurn\b/,
    /\bExecutePoweredDescent\b(?!Burn)/,
    /\bMissionPowerAnalysis\b/,
    /\bEstimatePowerMargin\b/
  ];
  for (const pattern of bannedLegacyNames) {
    if (pattern.test(combinedText)) {
      failures.push(`${label}: Apollo course content still contains legacy or invented naming ${pattern}; align with the Airbus upstream package/object names.`);
    }
  }

  const expectedByLesson = {
    'course-00/course-00-lesson-01': ['purposeProgramLandscape', 'functionalLandscape', 'technicalLandscape', 'missionRequirementsLandscape', 'executionLandscape', '::*'],
    'course-01/course-01-lesson-01': ['Mission', 'Operation', 'Function', 'LogicalComponent', 'TechnicalComponent'],
    'course-01/course-01-lesson-02': ['Apollo11MissionSystem', 'Apollo11MissionContext'],
    'course-02/course-02-lesson-01': ['PoweredDescentPhase'],
    'course-02/course-02-lesson-02': ['PoweredDescentPhase', 'ExecutePoweredDescentBurn'],
    'course-03/course-03-lesson-01': ['ExecuteDescentBurn'],
    'course-03/course-03-lesson-02': ['LogicalComponent', 'perform action'],
    'course-04/course-04-lesson-01': ['SA-506', 'CSM-107', 'LM-5'],
    'course-04/course-04-lesson-02': ['DockingInterface'],
    'course-05/course-05-lesson-01': ['HLR-R002', 'subject', 'satisfy'],
    'course-05/course-05-lesson-02': ['HLR-R002', 'FLR-R046', 'CLR-R018', 'subject', 'satisfy'],
    'course-06/course-06-lesson-01': ['deltaVMargin'],
    'course-06/course-06-lesson-02': ['timeslice', 'snapshot', 'verification']
  };
  const expected = expectedByLesson[`${course.id}/${lesson.id}`] || [];
  for (const token of expected) {
    if (!combinedText.includes(token)) {
      failures.push(`${label}: Apollo lesson should retain upstream-aligned term "${token}" in starter or lesson text.`);
    }
  }
}

function checkRequirementCourseQuality({ course, lesson, rawLesson, lessonPath }) {
  if (course.id !== 'course-07') return;
  const label = `${course.id}/${lesson.id} (${lessonPath})`;
  const workspaceText = (lesson.workspace?.files || []).map((file) => file.content || '').join('\n');
  const editableText = (lesson.workspace?.files || [])
    .filter((file) => file.editable !== false)
    .map((file) => file.content || '')
    .join('\n');
  const lessonText = collectContentText(rawLesson).join('\n');

  if (/^\s*requirement\s+def\s+[A-Za-z_]\w*\s*;/m.test(editableText)) {
    failures.push(`${label}: requirement lessons must not teach empty requirement def declarations.`);
  }
  if (/^\s*requirement\s+[A-Za-z_]\w*\s*:\s*[A-Za-z_]\w*\s*;/m.test(editableText)) {
    failures.push(`${label}: requirement lessons must not use empty requirement usage declarations.`);
  }

  if (!workspaceText.includes('package EV_Program_Baseline')) {
    failures.push(`${label}: C07 lessons must reuse the stable EV_Program_Baseline instead of creating another vehicle baseline.`);
  }

  if (lesson.id === 'course-07-lesson-01') {
    requireAll(
      label,
      editableText + '\n' + lessonText,
      ['RangeAcceptanceRequirement', 'doc', 'subject', 'attribute', 'rangeCriterion', 'energyCriterion', 'require constraint', 'satisfy cityRange by evPrototype', '480.0', '16.0', '联合判据', '独立验收点'],
      'C07 L01 must establish one complete, independently reviewable requirement contract on the shared evPrototype.'
    );
    if (/\bcandidateVehicle\b/.test(editableText + '\n' + lessonText)) {
      failures.push(`${label}: C07 L01 must continue the shared evPrototype, not create another candidateVehicle.`);
    }
    if (/#derivation|\bverification\s+def\b/.test(editableText)) {
      failures.push(`${label}: C07 L01 must focus on a good requirement contract; derivation and verification belong to later maturity stages.`);
    }
  }

  if (lesson.id === 'course-07-lesson-02') {
    requireAll(
      label,
      editableText + '\n' + lessonText,
      ['source requirement', 'derived requirement', '#derivation connection', '#original', '#derive', 'vehicleRange', 'usableBatteryEnergy', 'energyConsumption', '480.0', '78.0', '16.0'],
      'C07 L02 must model source/derived requirement lineage with the official RequirementDerivation endpoints.'
    );
    if (/\bverification\s+def\b/.test(editableText)) {
      failures.push(`${label}: C07 L02 must stay on requirement lineage and not repeat a verification skeleton.`);
    }
  }

  if (lesson.id === 'course-07-lesson-03') {
    requireAll(
      label,
      workspaceText + '\n' + lessonText,
      ['EV_Requirement_Baseline', 'assume constraint', 'require constraint', '前提', '边界', '系统责任', 'satisfy fastChargeTime by evPrototype', 'satisfy hvIsolationSafety by evPrototype.hvSystem', 'objective', 'verify fastChargeTime', 'C09 入口预览', 'view', 'expose'],
      'C07 L03 must reuse the prior requirement baseline, separate assumptions from responsibilities, and expose only a prefilled C09 entry preview.'
    );
    if (/TODO\s+\d+:\s+.*(?:verification|objective|verify|VerdictKind|PassIf)/.test(editableText)) {
      failures.push(`${label}: C07 L03 must not ask students to practice verification details that belong to C09; keep verification as a prefilled preview.`);
    }
    const voltageBoundaryRule = normalizeLessonRules(lesson.validation?.rules)
      .find((rule) => rule.id === 'voltage-assumption-expression');
    if (voltageBoundaryRule?.type !== 'regex'
        || !String(voltageBoundaryRule.pattern || '').includes('HighVoltageSafetyRequirement')
        || !String(voltageBoundaryRule.pattern || '').includes('voltageBoundary')
        || !String(voltageBoundaryRule.pattern || '').includes('system\\.nominalVoltageV')
        || !String(voltageBoundaryRule.pattern || '').includes('<=\\s*maxNominalVoltageV')) {
      failures.push(`${label}: C07 L03 rules must scope voltageBoundary to HighVoltageSafetyRequirement and check nominalVoltageV <= maxNominalVoltageV; a constant true assumption must not pass.`);
    }
  }
}

function checkAnalysisCourseQuality({ course, lesson, rawLesson, lessonPath }) {
  if (course.id !== 'course-08') return;
  const label = `${course.id}/${lesson.id} (${lessonPath})`;
  const workspaceText = (lesson.workspace?.files || []).map((file) => file.content || '').join('\n');
  const editableText = (lesson.workspace?.files || [])
    .filter((file) => file.editable !== false)
    .map((file) => file.content || '')
    .join('\n');
  const lessonText = collectContentText(rawLesson).join('\n');

  if (/^\s*calc\s+def\s+[A-Za-z_]\w*\s*;/m.test(editableText)) {
    failures.push(`${label}: analysis lessons must use calc def with in/return structure, not an empty calc def declaration.`);
  }

  if (lesson.id === 'course-08-lesson-01') {
    requireAll(
      label,
      editableText + '\n' + lessonText,
      ['calc def EstimateRange', 'calc candidateRangeEstimate', 'usableEnergyKWh', 'energyPer100Km', 'return rawRangeKm', '78.0', '16.0', '487.5', '490.0', '488.0', '纯计算', '预测', '观测'],
      'C08 L01 must focus on reusable calculation semantics and explicitly separate raw, reported-prediction, and measured values.'
    );
    if (/\banalysis\s+(?:def\s+)?|\bassert\s+constraint\b|\bTradeStudy\b/.test(editableText)) {
      failures.push(`${label}: C08 L01 must teach only calc definition/usage, not repeat an analysis, assertion, or trade-study skeleton.`);
    }
  }

  if (lesson.id === 'course-08-lesson-02') {
    requireAll(
      label,
      workspaceText + '\n' + lessonText,
      ['EV_Range_Calc_Baseline', 'analysis def RangeEvidenceAnalysis', 'subject', 'objective', 'in targetRangeKm', 'reportedPredictionKm', 'calc estimateRange', 'analysis return', 'cityRangeAnalysis', 'evPrototype', '490.0', '488.0', '不替代'],
      'C08 L02 must reuse L01 calculation in a subject/objective/input/return analysis context and preserve the analysis-versus-verification boundary.'
    );
    if (/\bassert\s+constraint\b/.test(editableText)) {
      failures.push(`${label}: C08 L02 must use analysis objective for the decision question, not a generic assert-constraint compliance check.`);
    }
    const objectiveRule = normalizeLessonRules(lesson.validation?.rules).find((rule) => rule.id === 'analysis-objective');
    if (objectiveRule?.type !== 'regex'
        || !String(objectiveRule.pattern || '').includes('reportedPredictionKm')
        || String(objectiveRule.pattern || '').includes('predictedRangeKm')) {
      failures.push(`${label}: C08 L02 objective rule must match the learner-facing reportedPredictionKm input, not a different return name.`);
    }
  }

  if (lesson.id === 'course-08-lesson-03') {
    requireAll(
      label,
      editableText + '\n' + lessonText,
      ['private import TradeStudies::*', 'TradeStudy', 'standardRangePackage', 'longRangePackage', 'alternative', 'evaluationFunction', 'MaximizeObjective', 'selectedAlternative', '490.0', '540.0', '质量', '快充', '不是数值优化器'],
      'C08 L03 must be an official-pattern multi-criterion TradeStudy, not a third single-case analysis skeleton.'
    );
  }
}

function checkVerificationCourseQuality({ course, lesson, rawLesson, lessonPath }) {
  if (course.id !== 'course-09') return;
  const label = `${course.id}/${lesson.id} (${lessonPath})`;
  const workspaceText = (lesson.workspace?.files || []).map((file) => file.content || '').join('\n');
  const editableText = (lesson.workspace?.files || [])
    .filter((file) => file.editable !== false)
    .map((file) => file.content || '')
    .join('\n');
  const lessonText = collectContentText(rawLesson).join('\n');

  if (/^\s*verification\s+def\s+[A-Za-z_]\w*\s*;/m.test(editableText)) {
    failures.push(`${label}: verification lessons must not teach empty verification def declarations.`);
  }
  if (/^\s*verification\s+[A-Za-z_]\w*\s*:\s*[A-Za-z_]\w*\s*;/m.test(editableText)) {
    failures.push(`${label}: verification lessons must not use empty verification usage declarations.`);
  }

  if (/return\s+passed\s*:\s*ScalarValues::Boolean/.test(editableText + '\n' + lessonText)) {
    failures.push(`${label}: verification lessons must use VerificationCases::VerdictKind/PassIf for formal verdicts, not return passed : ScalarValues::Boolean.`);
  }

  if (/measuredRangeKm\s*=\s*(?:cityRangePrediction|[A-Za-z_]\w*Analysis)\.[A-Za-z_]\w*/.test(editableText)) {
    failures.push(`${label}: measuredRangeKm must come from road-test evidence, not directly from an analysis output.`);
  }

  if (lesson.id === 'course-09-lesson-01') {
    requireAll(
      label,
      workspaceText + '\n' + lessonText,
      ['RangeVerificationPlan', 'subject', 'objective', 'verify vehicleRange', 'VerificationMethod', 'test', 'analyze', 'VerdictKind::inconclusive', '480.0', '490.0', '488.0', '尚未', '覆盖'],
      'C09 L01 must build verification planning and coverage before execution, with an honest inconclusive planned verdict.'
    );
    if (/\bmeasuredRangeKm\b|\bPassIf\s*\(/.test(editableText)) {
      failures.push(`${label}: C09 L01 planning must not include measured evidence or a PassIf execution verdict.`);
    }
    const rules = normalizeLessonRules(lesson.validation?.rules);
    const verdictRule = rules.find((rule) => rule.id === 'plan-inconclusive-verdict');
    const noPassIfRule = rules.find((rule) => rule.id === 'plan-must-not-use-passif');
    if (verdictRule?.type !== 'childElementExists'
        || !String(verdictRule.selector?.valueIncludes || '').includes('VerdictKind::inconclusive')) {
      failures.push(`${label}: C09 L01 rules must require the planned verdict to remain VerdictKind::inconclusive.`);
    }
    if (noPassIfRule?.type !== 'notContains' || noPassIfRule.text !== 'PassIf(') {
      failures.push(`${label}: C09 L01 rules must reject PassIf so prediction cannot self-certify a plan.`);
    }
  }

  if (lesson.id === 'course-09-lesson-02') {
    requireAll(
      label,
      workspaceText + '\n' + lessonText,
      ['collectData', 'processData', 'evaluateData', 'VerdictKind', 'PassIf', 'requiredRangeKm', 'predictedRangeKm', 'measuredRangeKm', '490.0', '488.0', 'prediction', 'measurement', '独立'],
      'C09 L02 must execute the official collect/process/evaluate chain and keep prediction separate from independent measurement.'
    );
    if (!/measuredRangeKm\s*=\s*rangeRoadTestEvidence\.measuredRangeKm/.test(editableText)) {
      failures.push(`${label}: C09 L02 measuredRangeKm must be bound to rangeRoadTestEvidence.measuredRangeKm.`);
    }
    if (/PassIf\([^)]*predictedRangeKm/.test(editableText + '\n' + lessonText)) {
      failures.push(`${label}: C09 L02 PassIf must not use predictedRangeKm as verification evidence.`);
    }
    const measurementRule = normalizeLessonRules(lesson.validation?.rules)
      .find((rule) => rule.id === 'execution-measurement-binding');
    if (measurementRule?.type !== 'childElementExists'
        || !String(measurementRule.selector?.valueIncludes || '').includes('rangeRoadTestEvidence.measuredRangeKm')) {
      failures.push(`${label}: C09 L02 rules must bind the executed measuredRangeKm to independent rangeRoadTestEvidence.`);
    }
  }

  if (lesson.id === 'course-09-lesson-03') {
    requireAll(
      label,
      editableText + '\n' + lessonText,
      ['HighVoltageSystem', 'subject system', 'evPrototype.hvSystem', 'IsolationInspection', 'SafeStateDemonstration', 'VerificationMethodKind::inspect', 'VerificationMethodKind::demo', 'VerdictKind::inconclusive', 'configurationRevision', 'specimenNumber', '620.0', '500.0', '方法互补'],
      'C09 L03 must use separate inspection and demonstration evidence with configuration identity and a non-pass lifecycle outcome.'
    );
    const rules = normalizeLessonRules(lesson.validation?.rules);
    const inspectionRule = rules.find((rule) => rule.id === 'inspection-method');
    const demonstrationRule = rules.find((rule) => rule.id === 'demonstration-method');
    if (inspectionRule?.type !== 'regex'
        || !String(inspectionRule.pattern || '').includes('IsolationInspection')
        || !String(inspectionRule.pattern || '').includes('VerificationMethodKind::inspect')) {
      failures.push(`${label}: C09 L03 inspection method rule must be scoped to IsolationInspection.`);
    }
    if (demonstrationRule?.type !== 'regex'
        || !String(demonstrationRule.pattern || '').includes('SafeStateDemonstration')
        || !String(demonstrationRule.pattern || '').includes('VerificationMethodKind::demo')) {
      failures.push(`${label}: C09 L03 demonstration method rule must be scoped to SafeStateDemonstration.`);
    }
  }
}

function checkIntegrationCourseQuality({ course, lesson, rawLesson, lessonPath }) {
  if (course.id !== 'course-10') return;
  const label = `${course.id}/${lesson.id} (${lessonPath})`;
  const workspaceText = (lesson.workspace?.files || []).map((file) => file.content || '').join('\n');
  const lessonText = collectContentText(rawLesson).join('\n');

  if (/^\s*requirement\s+def\s+[A-Za-z_]\w*\s*;/m.test(workspaceText)) {
    failures.push(`${label}: integration lessons must not contain empty requirement def declarations.`);
  }
  if (/^\s*verification\s+def\s+[A-Za-z_]\w*\s*;/m.test(workspaceText)) {
    failures.push(`${label}: integration lessons must not contain empty verification def declarations.`);
  }
  if (/^\s*analysis\s+def\s+[A-Za-z_]\w*\s*;/m.test(workspaceText)) {
    failures.push(`${label}: integration lessons must not contain empty analysis def declarations.`);
  }
  if (/^\s*calc\s+def\s+[A-Za-z_]\w*\s*;/m.test(workspaceText)) {
    failures.push(`${label}: integration lessons must not contain empty calc def declarations.`);
  }
  if (/^\s*constraint\s+[A-Za-z_]\w*\s*;/m.test(workspaceText)) {
    failures.push(`${label}: integration lessons must not contain empty constraint usage declarations.`);
  }

  if (lesson.id.endsWith('lesson-01')) {
    if (/battery\.dcOut\s+to\s+motor\.powerIn/.test(workspaceText + '\n' + lessonText)) {
      failures.push(`${label}: integration L01 must route propulsion power through an inverter, not connect battery.dcOut directly to motor.powerIn.`);
    }

    requireAll(
      label,
      workspaceText + '\n' + lessonText,
      ['Inverter', 'PropulsionPowerInterface', 'battery.dcOut', 'inverter.dcIn', 'inverter.acOut', 'motor.powerIn', 'usage 名称可以自定义', 'interface', 'connect', 'view', 'expose'],
      'integration L01 must deliver a battery-inverter-motor interface chain and a review view.'
    );
    requireNoFixedInterfaceUsageNames({ label, lesson, owner: 'finalVehicle' });
  }

  if (lesson.id.endsWith('lesson-02')) {
    requireAll(
      label,
      workspaceText + '\n' + lessonText,
      ['action def', 'flow', 'state def', 'transition', 'require constraint', 'satisfy', 'view'],
      'integration L02 must connect behavior, state, requirement, satisfaction, and view concepts.'
    );
  }

  if (lesson.id.endsWith('lesson-03')) {
    if (/return\s+passed\s*:\s*ScalarValues::Boolean/.test(workspaceText + '\n' + lessonText)) {
      failures.push(`${label}: final integration verification must use VerificationCases::VerdictKind/PassIf for formal verdicts.`);
    }

    if (/measuredRangeKm\s*=\s*[A-Za-z_]\w*Analysis\.[A-Za-z_]\w*/.test(workspaceText)) {
      failures.push(`${label}: final integration measuredRangeKm must come from road-test evidence, not finalRangeAnalysis output.`);
    }

    requireAll(
      label,
      workspaceText + '\n' + lessonText,
      ['requirement', 'constraint def', 'calc def', 'analysis def', 'verification def', 'return', 'VerdictKind', 'PassIf', 'assert constraint', 'satisfy', 'verify', 'view'],
      'integration L03 must close requirement-analysis-verification evidence chain with a standard VerdictKind verification output.'
    );

    requireAll(
      label,
      lessonText,
      ['C07', 'C08', 'C09'],
      'final integration lesson must explicitly connect back to the requirement, analysis, and verification courses.'
    );
  }
}

function checkP3CourseQuality({ course, lesson, rawLesson, lessonPath }) {
  const label = `${course.id}/${lesson.id} (${lessonPath})`;
  const workspaceText = (lesson.workspace?.files || []).map((file) => file.content || '').join('\n');
  const lessonText = collectContentText(rawLesson).join('\n');

  if (['course-04', 'course-05', 'course-06'].includes(course.id) && lesson.id.endsWith('lesson-01')) {
    const conceptMap = (rawLesson.learningBlocks || []).find((block) => block.type === 'concept-map');
    if (!conceptMap) {
      failures.push(`${label}: P3 L01 lessons must include a JSON-driven concept-map learning block.`);
    } else {
      const items = Array.isArray(conceptMap.items) ? conceptMap.items : [];
      if (items.length < 4) {
        failures.push(`${label}: concept-map must contain at least four engineering-to-SysML mappings.`);
      }
      for (const [index, item] of items.entries()) {
        const missing = ['engineeringQuestion', 'concept', 'analogy', 'code', 'watchOut'].filter((key) => !String(item[key] || '').trim());
        if (missing.length) {
          failures.push(`${label}: concept-map item ${index + 1} is missing ${missing.join(', ')}.`);
        }
      }
    }
  }

  if (course.id === 'course-10') {
    if (!workspaceText.includes('package EV_C10_Baseline') || !workspaceText.includes('private import EV_C10_Baseline::*;')) {
      failures.push(`${label}: Course10 lessons must import a stable EV_C10_Baseline package instead of duplicating an isolated model.`);
    }
    const baselineFile = (lesson.workspace?.files || []).find((file) => file.path === 'ev-c10-baseline.sysml');
    if (!baselineFile) {
      failures.push(`${label}: Course10 workspace must include the read-only ev-c10-baseline.sysml file.`);
    } else if (/\bTODO\b/i.test(baselineFile.content || '')) {
      failures.push(`${label}: shared baseline file must be complete and must not contain TODO markers.`);
    }

    if (lesson.id.endsWith('lesson-02') || lesson.id.endsWith('lesson-03')) {
      const stages = Array.isArray(rawLesson.practiceStages) ? rawLesson.practiceStages : [];
      if (stages.length < 4) {
        failures.push(`${label}: C10 L02/L03 must split TODO work into at least four practiceStages.`);
      }
      const ruleIds = new Set(normalizeLessonRules(lesson.validation?.rules).map((rule) => rule.id));
      for (const stage of stages) {
        if (!stage.title || !stage.todos || !stage.goal || !Array.isArray(stage.ruleIds) || !stage.ruleIds.length) {
          failures.push(`${label}: every practiceStage must define title, todos, goal, and ruleIds.`);
          continue;
        }
        const missingRules = stage.ruleIds.filter((id) => !ruleIds.has(id));
        if (missingRules.length) {
          failures.push(`${label}: practiceStage "${stage.title}" references missing rule ids: ${missingRules.join(', ')}.`);
        }
      }
      if (!lessonText.includes('分阶段练习解锁')) {
        failures.push(`${label}: C10 staged lessons must explicitly tell learners to use the staged unlock guide.`);
      }
    }

    if (lesson.id.endsWith('lesson-03')) {
    requireAll(
      label,
      workspaceText + '\n' + lessonText,
      ['FinalVehicle', 'Inverter', 'PropulsionPowerInterface', 'battery.dcOut', 'inverter.dcIn', 'inverter.acOut', 'motor.powerIn', 'usage 名称只是局部标签', 'EV_C10_Baseline'],
      'final integration must preserve the C03/C04 structural-interface baseline in the final evidence lesson.'
    );
    requireNoFixedInterfaceUsageNames({ label, lesson, owner: 'FinalVehicle' });
  }
  }

  const challengeTargets = new Set(['course-04/course-04-lesson-01', 'course-08/course-08-lesson-02', 'course-09/course-09-lesson-03']);
  if (challengeTargets.has(`${course.id}/${lesson.id}`)) {
    const challenges = Array.isArray(rawLesson.challenges) ? rawLesson.challenges : [];
    if (!challenges.length) {
      failures.push(`${label}: reviewed P3 lesson must include an optional engineering challenge.`);
    }
    for (const challenge of challenges) {
      const missing = ['context', 'task', 'acceptance', 'watchOut'].filter((key) => !String(challenge[key] || '').trim());
      if (missing.length) {
        failures.push(`${label}: optional challenge "${challenge.id || challenge.title || 'unnamed'}" is missing ${missing.join(', ')}.`);
      }
    }
  }
}

function checkEngineeringParameterConsistency() {
  const label = 'engineering-parameter-consistency';
  const packDir = store.packDir;
  const allCourseText = readTextFiles(packDir, ['.sysml', '.json']).join('\n');
  const programBaseline = fs.readFileSync(path.join(packDir, 'shared/ev-program-baseline.sysml'), 'utf8');
  const requirementBaseline = fs.readFileSync(path.join(packDir, 'shared/c07-requirement-baseline.sysml'), 'utf8');
  const calcBaseline = fs.readFileSync(path.join(packDir, 'shared/c08-range-calc-baseline.sysml'), 'utf8');
  const analysisBaseline = fs.readFileSync(path.join(packDir, 'shared/c08-analysis-baseline.sysml'), 'utf8');
  const c09L01Starter = fs.readFileSync(path.join(packDir, 'courses/course-09/lesson-01/starter.sysml'), 'utf8');
  const c09L02Starter = fs.readFileSync(path.join(packDir, 'courses/course-09/lesson-02/starter.sysml'), 'utf8');
  const c09L03Lesson = fs.readFileSync(path.join(packDir, 'courses/course-09/lesson-03/lesson.json'), 'utf8');

  if (/50Ah|17\.76\s*kWh|17760|capacityAh\s*:\s*ScalarValues::Real\s*=\s*50\.0/.test(allCourseText)) {
    failures.push(`${label}: the evidence chain must not regress to the old 50Ah/17.76kWh example.`);
  }
  if (/(targetRangeKm|minRangeKm)\s*:\s*ScalarValues::Real\s*=\s*500\.0|attribute\s*:>>\s*(targetRangeKm|minRangeKm)\s*=\s*500\.0/.test(allCourseText)) {
    failures.push(`${label}: the course-wide range requirement must remain 480.0km.`);
  }
  if (/\bcandidateVehicle\b|\bevCityVehicle\b/.test(
    readTextFiles(path.join(packDir, 'courses/course-07'), ['.sysml', '.json']).join('\n')
  )) {
    failures.push(`${label}: C07 must continue the shared evPrototype instead of creating a lesson-local vehicle.`);
  }

  requireAll(
    label,
    programBaseline,
    [
      'package EV_Program_Baseline',
      'usableEnergyKWh : ScalarValues::Real = 78.0',
      'energyPer100Km : ScalarValues::Real = 16.0',
      'reportedPredictionKm : ScalarValues::Real = 490.0',
      'measuredRangeKm : ScalarValues::Real = 488.0',
      'item def RangeRoadTestEvidence',
      'part evPrototype : ElectricVehicle',
      'item rangeRoadTestEvidence : RangeRoadTestEvidence'
    ],
    'the shared program baseline must own the single vehicle plus distinct design/prediction/measurement objects.'
  );

  requireAll(
    label,
    requirementBaseline,
    [
      'minRangeKm = 480.0',
      'minUsableEnergyKWh = 78.0',
      'maxEnergyPer100Km = 16.0',
      '#derivation connection',
      'end #original ::> vehicleRange',
      'end #derive ::> usableBatteryEnergy',
      'end #derive ::> energyConsumption',
      'satisfy vehicleRange by evPrototype'
    ],
    'the requirement baseline must preserve the 480/78/16 lineage and shared-vehicle responsibility.'
  );

  requireAll(
    label,
    calcBaseline,
    [
      'calc def EstimateRange',
      'usableEnergyKWh * 100.0 / energyPer100Km',
      'evPrototype.battery.usableEnergyKWh',
      'evPrototype.energyPer100Km'
    ],
    'the calculation baseline must derive raw range from the shared 78/16 design inputs.'
  );

  requireAll(
    label,
    analysisBaseline,
    [
      'analysis def RangeEvidenceAnalysis',
      'targetRangeKm = vehicleRange.minRangeKm',
      'reportedPredictionKm = evPrototype.reportedPredictionKm',
      'return predictedRangeKm : ScalarValues::Real = reportedPredictionKm'
    ],
    'the analysis baseline must bind the 480 target and 490 report prediction without introducing measurement.'
  );
  if (/measuredRangeKm/.test(analysisBaseline)) {
    failures.push(`${label}: the C08 analysis baseline must not own or return measuredRangeKm.`);
  }

  requireAll(
    label,
    c09L01Starter,
    [
      'RangeVerificationPlan',
      'VerdictKind::inconclusive',
      'cityRangePrediction.predictedRangeKm'
    ],
    'C09 L01 must plan coverage with prediction but no executed measurement verdict.'
  );
  if (/measuredRangeKm|PassIf\s*\(/.test(c09L01Starter)) {
    failures.push(`${label}: C09 L01 planning must not contain measurement or PassIf execution logic.`);
  }

  requireAll(
    label,
    c09L02Starter,
    [
      'requiredRangeKm = vehicleRange.minRangeKm',
      'predictedRangeKm = cityRangePrediction.predictedRangeKm',
      'measuredRangeKm = rangeRoadTestEvidence.measuredRangeKm',
      'collectData',
      'processData',
      'evaluateData'
    ],
    'C09 L02 must keep required, predicted, and measured values in distinct bindings and execute an evidence pipeline.'
  );
  if (/PassIf\([^)]*predictedRangeKm/.test(c09L02Starter)) {
    failures.push(`${label}: C09 L02 PassIf must never use the 490km prediction as observed evidence.`);
  }

  requireAll(
    label,
    c09L03Lesson,
    ['configurationRevision', 'specimenNumber', 'inspect', 'demo', 'inconclusive', 'error'],
    'C09 L03 must retain configuration identity, multiple methods, and non-pass lifecycle outcomes.'
  );

  for (const courseNumber of ['07', '08', '09']) {
    for (const lessonNumber of ['01', '02', '03']) {
      const lessonPath = path.join(packDir, `courses/course-${courseNumber}/lesson-${lessonNumber}/lesson.json`);
      const lesson = JSON.parse(fs.readFileSync(lessonPath, 'utf8'));
      const baseline = (lesson.workspace?.files || []).find((file) => file.path === 'ev-program-baseline.sysml');
      if (!baseline || baseline.editable !== false || baseline.source !== '../../../shared/ev-program-baseline.sysml') {
        failures.push(`${label}: course-${courseNumber}/lesson-${lessonNumber} must load ev-program-baseline.sysml as a read-only workspace file.`);
      }
    }
  }
}
function checkSyntaxNamingGuidance({ course, lesson, rawLesson, lessonPath }) {
  if (!['course-02', 'course-03', 'course-04', 'course-05'].includes(course.id)) return;
  const label = `${course.id}/${lesson.id} (${lessonPath})`;
  const workspaceText = (lesson.workspace?.files || []).map((file) => file.content || '').join('\n');
  const lessonText = collectContentText(rawLesson).join('\n');

  if (/\bpart\s+cells(?:\[\d+\])?\s*:/.test(workspaceText)) {
    requireAll(label, lessonText, ['关键字', '自定义', 'BatteryCell'], 'part usage guidance must separate keyword, custom name, multiplicity, and type.');
  }

  if (/\battribute\s+diameterM\s*:/.test(workspaceText)) {
    requireAll(label, lessonText, ['attribute', 'ScalarValues::Real', '工程命名约定'], 'attribute guidance must separate keyword, parameter name, type, and value.');
    if (course.id === 'course-03' && lesson.id.endsWith('lesson-01')) {
      requireAll(
        label,
        lessonText,
        ['空格', '不是建模语义', 'import', '完整限定名', '单位', 'ISQ', 'SI', '[kg]', '[m]', '[km]', 'WheelWithUnits', '0.65[m]', '12.0[kg]', '简化', 'ISO / SI 单位体系支持哪些单位？', '代表性但不完整', 'm', 'kg', 's', 'A', 'K', 'mol', 'cd', 'km/h', 'N⋅m', 'W⋅h', '°C', '不能自动检查', '物理量和单位', '维度一致性', 'ISQ::length = 1[kg]'],
        'first attribute parameter lesson must explain spacing is style, ScalarValues qualified names, import tradeoffs, a standard Unit example, the simplified course convention, a separate ISQ/SI unit scope drawer, and the current validator limitation on quantity/unit dimension consistency.'
      );
    }
  }

  if (/\bend\s+source\s*:/.test(workspaceText)) {
    const explainsEndpointName = /source[\s\S]*target/.test(lessonText) && /(不是必须|不是.*保留|不是固定|端点名)/.test(lessonText);
    if (!explainsEndpointName) {
      failures.push(`${label}: interface end guidance must explain that source/target are endpoint names, not mandatory reserved names.`);
    }
  }

  if (/\bport\s+[A-Za-z_][\w]*(?:In|Out)\b/.test(workspaceText)) {
    const explainsPortNaming = /In[\s\S]*Out|Out[\s\S]*In/.test(lessonText) && /命名约定/.test(lessonText);
    if (!explainsPortNaming) {
      failures.push(`${label}: port guidance must explain that In/Out suffixes are engineering naming conventions, not SysML direction syntax.`);
    }
  }

  if (course.id === 'course-04' && lesson.id.endsWith('lesson-02')) {
    requireAll(
      label,
      workspaceText + '\n' + lessonText,
      [
        'voltageV',
        'currentA',
        'maxPowerKW',
        'requestedTorqueNm',
        'timestampMs',
        'priority',
        'flowRateLpm',
        'temperatureC',
        'pressureKPa',
        '400.0',
        '250.0',
        '100.0',
        '180.0',
        '12.0',
        '35.0',
        '不是自由命名练习'
      ],
      'Course04 L02 must expose required attribute names, types, and suggested values before validation rejects custom names.'
    );
  }

  if (course.id === 'course-04' && lesson.id.endsWith('lesson-03')) {
    requireAll(
      label,
      workspaceText + '\n' + lessonText,
      ['BatteryToInverter', 'ControllerToInverter', 'BatteryCoolingInterface', 'battery.dcOut', 'inverter.dcIn', 'controller.commandOut', 'inverter.commandIn', 'cooling.batterySide', 'battery.thermalIn', 'usage 名称可以自定义'],
      'Course04 L03 must specify required interface types and endpoint paths while allowing custom interface usage names.'
    );
    requireNoFixedInterfaceUsageNames({ label, lesson, owner: 'ElectricVehicle' });
    requireAll(
      label,
      lessonText,
      ['Duplicate of other owned member name', '全角冒号', 'ASCII `:`', '中文全角冒号 `：`', '已有同名行时应编辑原行', '不重复的自定义名称', 'Must have at least two related elements'],
      'Course04 L03 must explain duplicate-name and full-width-colon diagnostics for restored-draft interface connect work.'
    );
  }

  if (course.id === 'course-05' && /^\s*(in|out)\s+[A-Za-z_][\w]*\s*:/m.test(workspaceText)) {
    if (!/参数方向关键字/.test(lessonText)) {
      failures.push(`${label}: behavior lessons must explain that leading in/out are parameter direction keywords.`);
    }
    if (['course-05-lesson-01', 'course-05-lesson-03'].includes(lesson.id)) {
      requireAll(
        label,
        workspaceText + '\n' + lessonText,
        ['bind', '不是继承关系', '不会', '自动', '不是赋值', '左右', 'flow'],
        'Course05 action decomposition lessons must explain that outer action parameters and inner action parameters are not inherited or auto-connected; bind is not assignment direction; use bind for boundary parameters and flow between steps.'
      );
      const hasBindRule = normalizeLessonRules(lesson.validation?.rules).some((rule) => {
        const selector = rule.selector || {};
        return rule.type === 'relationshipExists' && selector.kind === 'bind';
      });
      if (!hasBindRule) {
        failures.push(`${label}: Course05 action boundary lessons must structurally check bind relationships, not only flow.`);
      }
    }
  }

  if (course.id === 'course-06') {
    requireAll(
      label,
      lessonText,
      ['state', 'event', 'transition', 'mode'],
      'state lessons must separate state, event, transition, and engineering mode concepts.'
    );

    if (/\btransition\s+\w+\s+first\b/.test(workspaceText) || /\bTODO\b/i.test(workspaceText)) {
      requireAll(
        label,
        lessonText,
        ['first', 'accept', 'if', 'then'],
        'state transition guidance must teach official first/accept/if/then syntax.'
      );
    }

    if (!/SafeState/.test(workspaceText + lessonText)) {
      failures.push(`${label}: state-machine lessons must explicitly model or discuss SafeState.`);
    }

    if (/\b(entry|do|exit)\s+action\b/.test(workspaceText) || /entry\/do\/exit/.test(lessonText)) {
      requireAll(
        label,
        lessonText,
        ['entry', 'do', 'exit', 'action'],
        'state action lessons must explain entry/do/exit action semantics.'
      );
    }
    const hintCardText = (rawLesson.learningBlocks || [])
      .filter((block) => block.type === 'hint-card' || block.type === 'tip')
      .map((block) => collectContentText(block).join('\n'))
      .join('\n');
    const hasAllStateActionConcepts = /entry\s+action/.test(workspaceText + '\n' + lessonText)
      && /do\s+action/.test(workspaceText + '\n' + lessonText)
      && /exit\s+action/.test(workspaceText + '\n' + lessonText);
    if (hasAllStateActionConcepts) {
      requireAll(
        label,
        hintCardText,
        ['entry', 'do', 'exit', '进入', '停留', '离开'],
        'lessons that teach entry/do/exit action together must include a hint-card that explains their differences.'
      );
    }
    const combinedStateActionTodo = workspaceText
      .split(/\r?\n/)
      .find((line) => /\bTODO\b/.test(line) && (
        /entry\/do\/exit/.test(line)
        || /三类状态动作/.test(line)
        || (/entry\s+action/.test(line) && /do\s+action/.test(line) && /exit\s+action/.test(line))
      ));
    if (combinedStateActionTodo) {
      failures.push(`${label}: state action TODOs must not combine entry/do/exit into one task; split them into separate TODOs or provide a clear three-line scaffold.`);
    }

    if (/private import|view\s+\w+/.test(workspaceText)) {
      requireAll(
        label,
        lessonText,
        ['文件', 'package', 'import', 'view'],
        'state organization lessons must distinguish file, package, import, and view.'
      );
    }

    if (lesson.id === 'course-06-lesson-01') {
      requireAll(
        label,
        workspaceText + '\n' + lessonText,
        [
          'entry action emergencyShutdown : EmergencyShutdown',
          'do action',
          'perform action',
          'then action',
          'accept',
          'send',
          '状态激活期间',
          '承担/调用',
          '不是同一件事',
          'usage 名称可以自定义',
          'off_to_standby first Off accept IgnitionOnSignal then Standby',
          '照这个骨架',
          'allFaultsCleared',
          'Boolean',
          'if allFaultsCleared',
          '内联 guard 表达式',
          '必须在当前状态机可见',
          'Signal 与 Guard',
          '信号/事件载荷类型',
          '不是 Boolean',
          '不会',
          '自动推断',
          '====',
          'GeneralView',
          'StateTransitionView',
          '取消注释'
        ],
        'Course06 L01 must make the SafeState entry action, transition naming flexibility, and Boolean guard syntax explicit before course-rule validation.'
      );
      requireNoFixedTransitionUsageNames({ label, lesson, owner: 'VehicleOperatingState' });
    }

    if (lesson.id === 'course-06-lesson-02') {
      const taskHintText = collectContentText(rawLesson.tasks || []).join('\n');
      requireAll(
        label,
        workspaceText + '\n' + lessonText,
        [
          'cc_to_cv first ConstantCurrent accept ChargeTaperSignal',
          '照这个骨架',
          '内联 Boolean 表达式',
          'BatteryState',
          'Signal 与 Guard',
          '不是 Boolean',
          'perform action',
          'entry action',
          'do action',
          'exit action',
          'transition usage 名称可以自定义',
          'StateTransitionView',
          'GeneralView',
          'TODO 3: 添加 entry action openContactors : OpenContactors',
          'TODO 4: 添加 do action sendFaultReport : SendFaultReport',
          'TODO 5: 添加 exit action reenableBattery : ReenableBattery',
          'thermal_to_safe first Active.Charging accept ThermalFaultSignal',
          'first SafeState',
          'then Idle',
          '源状态',
          '目标状态'
        ],
        'Course06 L02 must carry forward C06 L01 guidance for transition examples, guard visibility, signal/guard separation, action-state semantics, view comparison, and flexible transition names.'
      );
      requireAll(
        label,
        taskHintText,
        ['语法骨架', 'entry|do|exit action', 'state SafeState', '动作 usage', 'action def', '进入状态', '停留在状态期间', '离开状态'],
        'Course06 L02 code-line hints must teach the syntax logic and timing semantics of entry/do/exit actions, not only say which TODO to fill.'
      );
      const thermalSafeRule = normalizeLessonRules(lesson.validation?.rules).find((rule) => {
        const selector = rule.selector || {};
        return selector.parent === 'BatteryState'
          && selector.kind === 'transition'
          && selector.sourceName === 'Active.Charging'
          && selector.targetName === 'SafeState'
          && selector.triggerName === 'ThermalFaultSignal';
      });
      if (thermalSafeRule) {
        failures.push(`${label}: thermal_to_safe is a prefilled example, so it must not be reported as a learner completion rule. Keep the rule focus on TODO 6 low SOC and TODO 7 recovery transitions.`);
      }
      for (const owner of ['Charging', 'Active', 'BatteryState']) {
        requireNoFixedTransitionUsageNames({ label, lesson, owner });
      }
    }

    if (lesson.id === 'course-06-lesson-03') {
      const taskHintText = collectContentText(rawLesson.tasks || []).join('\n');
      requireAll(
        label,
        workspaceText + '\n' + lessonText,
        [
          'limit50_to_limp first PowerLimit50 accept MotorTooHotSignal',
          '照这个骨架',
          '内联 Boolean 表达式',
          'PropulsionState',
          '不是 Boolean',
          'perform action',
          'do action',
          'entry action',
          'transition usage 名称可以自定义',
          'StateTransitionView',
          'GeneralView',
          '启用'
        ],
        'Course06 L03 must carry forward C06 L01 guidance for transition examples, guard visibility, signal/guard separation, action-state semantics, view comparison, and flexible transition names.'
      );
      requireAll(
        label,
        taskHintText,
        ['语法骨架', 'do action', 'entry action', '具体 `state` 块', '动作 usage', 'action def', '激活/停留期间', '进入 Fault', 'perform action'],
        'Course06 L03 code-line hints must teach state-action syntax and timing semantics instead of only naming the action keywords.'
      );
      requireAll(
        label,
        workspaceText + '\n' + lessonText + '\n' + taskHintText,
        [
          'TODO 4: 添加 Normal -> Degraded.PowerLimit50',
          'MotorOvertempSignal',
          '条件: motorTempC > 120.0',
          'TODO 5: 添加 Degraded.PowerLimit50 -> Normal',
          'MotorTempNormalSignal',
          '条件: motorTempC < 100.0',
          'TODO 4/5 通过条件关注源/目标状态、事件和 `motorTempC` 守卫'
        ],
        'Course06 L03 must expose the motorTempC guard requirement for normal/degraded transitions before validation, not hide it only in rules.json.'
      );
      for (const owner of ['Degraded', 'Running', 'PropulsionState']) {
        requireNoFixedTransitionUsageNames({ label, lesson, owner });
      }
      const stateViewRule = normalizeLessonRules(lesson.validation?.rules).find((rule) => rule.id === 'state-view');
      const parentAnyOf = stateViewRule?.selector?.parentAnyOf || [];
      if (!parentAnyOf.includes('propulsionStateView') || !parentAnyOf.includes('propulsionStateTransitionView')) {
        failures.push(`${label}: state-view rule must accept either GeneralView or StateTransitionView exposing PropulsionState.`);
      }
    }
  }
}

function checkEarlyItemDefGuidance({ course, lesson, rawLesson, lessonPath }) {
  if (course.id !== 'course-01') return;
  const label = `${course.id}/${lesson.id} (${lessonPath})`;
  const hintCards = (rawLesson.learningBlocks || []).filter((block) => block.type === 'hint-card' || block.type === 'tip');
  const hintText = hintCards.map((block) => collectContentText(block).join('\n')).join('\n');
  const lessonText = collectContentText(rawLesson).join('\n');

  if (lesson.id.endsWith('lesson-00')) {
    const workspaceText = (lesson.workspace?.files || []).map((file) => file.content || '').join('\n');
    if (/\bitem\s+def\b/.test(workspaceText) && !hintCards.length) {
      failures.push(`${label}: first Course 1 exposure to item def must include a clickable hint-card.`);
      return;
    }
    requireAll(
      label,
      hintText,
      ['item def', 'part def', 'port def', '电能', '命令', 'Course 2'],
      'Course 1 overview must explain when to use item def and how it differs from part def and port def.'
    );
  }

  if (lesson.id.endsWith('lesson-01')) {
    requireAll(
      label,
      hintText,
      ['part', 'item', 'Course 2', 'Course 4'],
      'Course 1 first hands-on lesson must bridge learner questions about item def to later part/item and port/interface lessons.'
    );
  }

  if (lesson.id.endsWith('lesson-03')) {
    const workspaceText = (lesson.workspace?.files || []).map((file) => file.content || '').join('\n');
    requireAll(
      label,
      lessonText,
      ['usableRange', '不是 SysML v2 标准关键字', '自定义需求名称', 'VehicleNeed', 'subject', 'satisfy', 'expose'],
      'Course 1 first requirement usage must explain that usableRange is a custom requirement usage name and must stay consistent across satisfy/view references.'
    );
    requireAll(
      label,
      workspaceText + '\n' + lessonText,
      ['subject vehicle : ElectricVehicle', 'subject vehicle = evPrototype', 'satisfy usableRange by evPrototype', 'subject 保持开放', '不要在 `usableRange` 内', '重复绑定', 'PlantUML/SVG', 'GeneralView'],
      'Course 1 first requirement trace lesson must connect requirement and analysis subjects to the vehicle, keep usableRange subject open for satisfy, and explain why the current official view may not draw every semantic edge.'
    );
    if (!/analysis[\s\S]*subject[\s\S]*evPrototype|subject[\s\S]*analysis[\s\S]*evPrototype/.test(lessonText)) {
      failures.push(`${label}: Course 1 first analysis usage must explain how purposeCheck is bound to the vehicle subject.`);
    }
    if (!/分析[\s\S]*(不能替代|不替代)[\s\S]*satisfy|satisfy[\s\S]*(不能替代|不替代)[\s\S]*分析/.test(lessonText)) {
      failures.push(`${label}: Course 1 first trace lesson must explain that analysis supports evidence but does not replace vehicle satisfy responsibility.`);
    }
  }
}

function checkCourse02ItemUsageAnchors({ course, lesson, rawLesson, lessonPath }) {
  if (course.id !== 'course-02') return;
  const label = `${course.id}/${lesson.id} (${lessonPath})`;
  const workspaceText = (lesson.workspace?.files || []).map((file) => file.content || '').join('\n');
  const lessonText = collectContentText(rawLesson).join('\n');

  if (lesson.id.endsWith('lesson-00')) {
    const hintCards = (rawLesson.learningBlocks || []).filter((block) => block.type === 'hint-card' || block.type === 'tip');
    const hintText = hintCards.map((block) => collectContentText(block).join('\n')).join('\n');
    if (!hintCards.length) {
      failures.push(`${label}: Course 02 first numbered lesson must include a clickable hint-card for item usage ownership.`);
    }
    requireAll(
      label,
      hintText,
      ['item def', 'item', 'BatteryPack', 'Controller', 'port def', 'ref item', 'Course04'],
      'Course 02 item usage hint must explain item ownership and bridge to later port/interface lessons.'
    );
    requireAll(
      label,
      workspaceText + '\n' + lessonText,
      ['TODO 1', 'storedEnergy', 'TODO 2', 'driveCommand', 'TODO 3', 'myEV'],
      'Course 02 first numbered lesson must be hands-on, not a read-only overview.'
    );
  }

  if (/^\s{2}item\s+(?:storedEnergy|driveCommand)\s*:/m.test(workspaceText)) {
    failures.push(`${label}: Course 02 item usages must not be package-root floating items; anchor them inside the relevant part def.`);
  }

  if (/storedEnergy\s*:\s*ElectricalEnergy/.test(workspaceText + lessonText)) {
    requireAll(
      label,
      workspaceText + '\n' + lessonText,
      ['BatteryPack', 'storedEnergy', 'ElectricalEnergy'],
      'Course 02 storedEnergy must be taught as an ElectricalEnergy item usage anchored by BatteryPack.'
    );
    if (!/BatteryPack[\s\S]*storedEnergy|storedEnergy[\s\S]*BatteryPack/.test(lessonText)) {
      failures.push(`${label}: Course 02 lesson text must explain that storedEnergy belongs in the BatteryPack context.`);
    }
  }

  if (/driveCommand\s*:\s*TorqueCommand/.test(workspaceText + lessonText)) {
    requireAll(
      label,
      workspaceText + '\n' + lessonText,
      ['Controller', 'driveCommand', 'TorqueCommand'],
      'Course 02 driveCommand must be taught as a TorqueCommand item usage anchored by Controller.'
    );
    if (!/Controller[\s\S]*driveCommand|driveCommand[\s\S]*Controller/.test(lessonText)) {
      failures.push(`${label}: Course 02 lesson text must explain that driveCommand belongs in the Controller context.`);
    }
  }
}

function requireAll(label, text, phrases, message) {
  const missing = phrases.filter((phrase) => !text.includes(phrase));
  if (missing.length > 0) failures.push(`${label}: ${message} Missing: ${missing.join(', ')}`);
}

function normalizeLessonRules(rules) {
  if (!rules) return [];
  if (Array.isArray(rules)) return rules;
  if (Array.isArray(rules.rules)) return rules.rules;
  if (Array.isArray(rules.checks)) return rules.checks;
  return [];
}

function visualSignature(visual) {
  const nodes = visual?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return '';
  return JSON.stringify(nodes.map((node) => ({
    label: node.label || '',
    detail: node.detail || '',
    code: node.code || ''
  })));
}

function collectContentText(value, key = '') {
  if (value === null || value === undefined) return [];
  if (key === 'workspace' || key === 'validation') return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectContentText(item));
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([childKey, childValue]) => collectContentText(childValue, childKey));
  }
  return [];
}

function extractTodoNumbers(text) {
  const numbers = new Set();
  const rangePattern = /\bTODO\s*(\d+)\s*(?:-|–|—|至|到)\s*(\d+)/gi;
  for (const match of text.matchAll(rangePattern)) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    for (let number = low; number <= high; number += 1) numbers.add(number);
  }

  const listPattern = /\bTODO\s*(\d+(?:\s*[\/、,，]\s*\d+)+)/gi;
  for (const match of text.matchAll(listPattern)) {
    for (const part of match[1].split(/[\/、,，]/)) {
      const number = Number(part.trim());
      if (Number.isFinite(number)) numbers.add(number);
    }
  }

  const singlePattern = /\bTODO\s*(\d+)/gi;
  for (const match of text.matchAll(singlePattern)) numbers.add(Number(match[1]));

  return numbers;
}

function normalizeLessonPath(courseBase, lessonRef) {
  const normalizedRef = String(lessonRef).replaceAll('\\', '/');
  if (!courseBase || courseBase === '.') return normalizedRef;
  if (normalizedRef.startsWith(`${courseBase}/`)) return normalizedRef;
  return path.posix.normalize(path.posix.join(courseBase, normalizedRef));
}

function readCourseJson(relativePath) {
  const absolute = path.resolve(store.packDir, relativePath);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

function readTextFiles(root, extensions) {
  const output = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (extensions.includes(path.extname(entry.name))) {
        output.push(fs.readFileSync(absolute, 'utf8'));
      }
    }
  };
  visit(root);
  return output;
}

function listFiles(root) {
  const output = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else output.push(absolute);
    }
  };
  visit(root);
  return output;
}
