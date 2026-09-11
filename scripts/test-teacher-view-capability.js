'use strict';

const assert = require('node:assert/strict');

async function main() {
  const { projectFinalAnswerTaskView, deterministicFinalAnswerFallback } =
    await import('../apps/teacher/dist/agent/final-answer-worker.mjs');
  function task(question, code) {
    const binding = { runId: 'view-probe', taskId: 'candidate', taskRevision: 1 };
    return projectFinalAnswerTaskView({
      resources: { runId: binding.runId, input: { question, conversationSubjects: {} } },
      obligation: { ...binding, outcomeType: code ? 'candidate' : 'direct_answer' },
      source: code ? {
        kind: 'worker_terminal',
        workerResult: { ...binding, status: 'validated_passed', workPerformed: 'candidate_produced',
          candidate: { mode: 'standalone_model', content: code } }
      } : { kind: 'direct_answer', mainDraft: '', evidence: [] }
    });
  }
  for (const projected of [
    task('展示 BrowserView'),
    task('解释层级浏览视图'),
    task('修复当前模型', "package P { part 'frame'; view v : StandardViewDefinitions::BrowserView { expose 'frame'; } }")
  ]) {
    assert.deepEqual(projected.viewCapability.relevantStandardViews, ['BrowserView']);
    assert.deepEqual(projected.viewCapability.withoutDedicatedPlantUmlRendering, []);
    const fallback = deterministicFinalAnswerFallback(projected);
    assert(fallback.includes('BrowserView支持模型成员层级浏览'));
    assert(fallback.includes('展开、折叠'));
    assert(!fallback.includes('当前平台不能按其专用语义完成PlantUML渲染'));
  }
  const mixed = task('比较 BrowserView、GeometryView 和 GridView');
  assert.deepEqual(mixed.viewCapability.withoutDedicatedPlantUmlRendering, ['GeometryView', 'GridView']);
  const disclosure = deterministicFinalAnswerFallback(mixed);
  assert(disclosure.includes('BrowserView支持模型成员层级浏览'));
  assert(disclosure.includes('GeometryView、GridView属于SysML v2标准库View，但当前平台不能'));
  assert(!deterministicFinalAnswerFallback(task('GeometryView')).includes('BrowserView支持'));
  assert.equal(task('解释 GeneralView').viewCapability, undefined);
  assert.equal(task('解释 part 和 port').viewCapability, undefined);
  console.log('Teacher view capability PASS: requested/produced Browser, Chinese alias, mixed unsupported views, fallback and unrelated context');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
