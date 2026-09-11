'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compileOfficialValidator } = require('./compile-official-validator');
const { SysmlPlantUmlService } = require('../packages/sysml-plantuml-service/service');
const { inspectScene } = require('../packages/sysml-plantuml-service/diagram-layout');
const { createGeneralGraph, generalScene, repairGeneral } = require('../packages/sysml-plantuml-service/general-layout');
const ELK = require('elkjs');

// 独立声明路径 oracle；不得从投影结果生成预期边集合。
const branches = {
  'flightSafety.sensing': ['accuracy:QualityCriterion', 'latency:TimingCriterion'],
  'flightSafety.faultDetection': ['coverage:SafetyCriterion', 'latency:TimingCriterion'],
  'flightSafety.recovery': ['safeTransition:SafetyCriterion', 'latency:TimingCriterion'],
  'energyManagement.estimation': ['accuracy:QualityCriterion', 'latency:TimingCriterion'],
  'energyManagement.reserve': ['available:SafetyCriterion', 'prediction:QualityCriterion'],
  'energyManagement.protection': ['isolation:SafetyCriterion', 'latency:TimingCriterion'],
  'communication.command': ['integrity:QualityCriterion', 'latency:TimingCriterion'],
  'communication.telemetry': ['accuracy:QualityCriterion', 'freshness:TimingCriterion'],
  'communication.linkRecovery': ['reconnectTransition:SafetyCriterion', 'latency:TimingCriterion'],
  'missionExecution.takeoff': ['readiness:SafetyCriterion', 'latency:TimingCriterion'],
  'missionExecution.routeTracking': ['accuracy:QualityCriterion', 'continuity:QualityCriterion'],
  'missionExecution.landing': ['stability:SafetyCriterion', 'latency:TimingCriterion']
};
const references = [
  ['flightSafety.recovery', 'energyManagement.reserve.available'],
  ['energyManagement.protection', 'flightSafety.faultDetection.coverage'],
  ['communication.linkRecovery', 'flightSafety.recovery.safeTransition'],
  ['missionExecution.takeoff', 'energyManagement.reserve.available'],
  ['missionExecution.routeTracking', 'communication.command.integrity'],
  ['missionExecution.landing', 'flightSafety.sensing.accuracy']
];
const edgeKey = (source, target, kind) => `${source}|${target}|${kind}`;

function oracle(contexts, templates) {
  const expected = new Set();
  for (const context of contexts) {
    for (const [branch, leaves] of Object.entries(branches)) {
      const domain = branch.split('.')[0];
      expected.add(edgeKey(context, `${context}.${domain}`, 'required-requirement'));
      expected.add(edgeKey(`${context}.${domain}`, `${context}.${branch}`, 'required-requirement'));
      for (const leaf of leaves) {
        const [name, type] = leaf.split(':');
        expected.add(edgeKey(`${context}.${branch}`, `${context}.${branch}.${name}`, 'required-requirement'));
        if (templates) expected.add(edgeKey(`${context}.${branch}.${name}`, type, 'feature-typing'));
      }
    }
    for (const [source, target] of references) expected.add(edgeKey(`${context}.${source}`, `${context}.${target}`, 'required-reference'));
    if (templates) for (const [name, kind] of [['nominalWeather', 'assumed-reference'],
      ['trainedOperator', 'assumed-reference'], ['controlledAirspace', 'required-reference']]) expected.add(edgeKey(context, name, kind));
  }
  if (templates) for (const type of ['SafetyCriterion', 'TimingCriterion', 'QualityCriterion']) expected.add(edgeKey(type, 'Criterion', 'subclassification'));
  if (contexts.includes('baseline')) expected.add(edgeKey('baseline', 'MissionRequirements', 'feature-typing'));
  return [...expected].sort();
}

async function main() {
  const content = fs.readFileSync(path.join(__dirname, 'fixtures/plantuml-view-regressions/complex-requirements.sysml'), 'utf8');
  const output = process.env.REQUIREMENT_LAYOUT_EVIDENCE || '.tmp/complex-requirements-final';
  fs.mkdirSync(output, { recursive: true });
  const url = process.env.LAYOUT_VALIDATOR_URL;
  const service = url ? null : new SysmlPlantUmlService(compileOfficialValidator());
  const render = input => url ? fetch(`${url}/plantuml`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input) }).then(r => r.json()) : service.render(input);
  const summary = [];
  try {
    if (url) {
      const validation = await fetch(`${url}/validate`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }) }).then(r => r.json());
      fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(validation, null, 2));
      assert.equal(validation.syntaxValid, true, JSON.stringify(validation.diagnostics));
      assert.equal(validation.semanticValid, true, JSON.stringify(validation.diagnostics));
      assert.equal(validation.fallbackActive, false);
      assert.deepEqual(validation.diagnostics, [], '测试模型必须无错误且无重复成员警告');
    }
    for (const [viewName, count, contexts, templates] of [
      ['hierarchyView', 41, ['MissionRequirements'], false],
      ['requireView', 48, ['MissionRequirements'], true],
      ['definitionAndUsageView', 89, ['MissionRequirements', 'baseline'], true],
      ['focusedSafetyView', 16, [], true]
    ]) {
      const result = await render({ content, viewName });
      fs.writeFileSync(path.join(output, `${viewName}.json`), JSON.stringify(result));
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(result.renderer, 'local-layout');
      const document = result.diagramDocument, scene = result.layoutScene;
      assert.equal(document.profile, 'requirement-hierarchy');
      assert.equal(document.nodes.length, count);
      assert.equal(document.ports.length, 0);
      assert.deepEqual(inspectScene(document, scene).issues, []);
      const nodes = new Map(document.nodes.map(n => [n.id, n]));
      const displayPath = id => { const node = nodes.get(id); return node.parentId ? `${displayPath(node.parentId)}.${node.name}` : node.name; };
      const actual = document.edges.map(e => edgeKey(displayPath(e.source), displayPath(e.target), e.kind)).sort();
      if (contexts.length) assert.deepEqual(actual, oracle(contexts, templates));
      else {
        assert.equal(actual.length, 20);
        assert.deepEqual(document.edges.filter(e => e.kind === 'required-reference').map(e =>
          edgeKey(displayPath(e.source), displayPath(e.target), e.kind)), ['flightSafety.recovery|reserve.available|required-reference']);
      }
      assert(document.nodes.every(n => n.reqId && scene.nodes.find(s => s.id === n.id).cardRows.some(r => r.text === `id = ${n.reqId}`)));
      assert.equal(Math.max(...document.nodes.map(n => displayPath(n.id).split('.').length)), 4 - (contexts.length ? 0 : 1));
      if (viewName === 'definitionAndUsageView') {
        // 真实 ELK 失败复现：不允许放松检查，修补必须保持卡片和标签的位置。
        const raw = generalScene(document, await new ELK().layout(createGeneralGraph(document).graph), 'test');
        assert(inspectScene(document, raw).issues.some(i => i.endsWith('crosses-obstacle')));
        const nodeBefore = JSON.stringify(raw.nodes), labelsBefore = JSON.stringify(raw.edges.map(e => e.labels));
        repairGeneral(raw, Date.now() + 10000);
        assert.deepEqual(inspectScene(document, raw).issues, []);
        assert.equal(JSON.stringify(raw.nodes), nodeBefore);
        assert.equal(JSON.stringify(raw.edges.map(e => e.labels)), labelsBefore);
        assert(raw.repairedEdges.length > 0);
      }
      fs.writeFileSync(path.join(output, `${viewName}.svg`), result.svg);
      summary.push({ viewName, status: 'PASS', nodes: count, edges: actual.length,
        roots: document.nodes.filter(n => !n.parentId).length, repaired: scene.repairedEdges || [], width: scene.width, height: scene.height });
      console.log(JSON.stringify(summary.at(-1)));
    }
    const invalid = await render({ content: content.replace('require energyManagement.reserve.available;', 'require missingRequirement;'), viewName: 'requireView' });
    fs.writeFileSync(path.join(output, 'invalid-reference.json'), JSON.stringify(invalid));
    assert.equal(invalid.ok, false);
    assert(!invalid.svg);
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
    // 可直接用浏览器打开的验收产物；只展示真实返回的 SVG，不另造布局或改动工作台草稿。
    const preview = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
      <title>复杂分层需求 · ELK 验收</title><style>
      body{margin:0;font:16px system-ui;color:#24384b;background:#f8fafc}header{padding:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
      select,button{font:inherit;padding:6px}main{height:calc(100vh - 125px);overflow:auto;background:white;border-top:1px solid #d8e1eb}
      img{display:block;max-width:none}p{margin:0;padding:0 16px 16px;font-size:14px}</style>
      <header><strong>复杂分层需求 · 真实 SVG 验收</strong><select aria-label="选择需求视图">${summary.map(s =>
        `<option value="${s.viewName}">${s.viewName} · ${s.nodes} 节点 / ${s.edges} 关系</option>`).join('')}</select>
      <button id="fit">适配宽度</button><button id="actual">100% 字号</button></header>
      <p>四层需求；实线为嵌套需求，虚线保留类型及 require/assume 引用。此页面展示 Validator 返回的原始 SVG。</p>
      <main><img alt="复杂需求 ELK 视图"></main><script>
      const select=document.querySelector('select'),img=document.querySelector('img');
      const fit=()=>{img.style.width='100%'};
      select.onchange=()=>{img.src=select.value+'.svg';fit()};
      document.querySelector('#fit').onclick=fit;document.querySelector('#actual').onclick=()=>{img.style.width='auto'};
      select.onchange();</script></html>`;
    fs.writeFileSync(path.join(output, 'preview.js'), preview.match(/<script>([\s\S]*)<\/script>/)[1]);
    fs.writeFileSync(path.join(output, 'index.html'), preview.replace(/<script>[\s\S]*<\/script>/, '<script src="preview.js"></script>'));
  } finally { if (service) await service.stop(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
