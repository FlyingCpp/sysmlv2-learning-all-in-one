'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { compileOfficialValidator } = require('./compile-official-validator');
const { SysmlPlantUmlService } = require('../packages/sysml-plantuml-service/service');
const { inspectScene } = require('../packages/sysml-plantuml-service/diagram-layout');

const output = path.resolve(process.env.ENGINEERING_VIEWS_EVIDENCE || '.tmp/engineering-views-20260906');
const content = fs.readFileSync(path.join(__dirname, 'fixtures/plantuml-view-regressions/ev-thermal-management-detailed.sysml'), 'utf8');

function endpoint(scene, id) {
  const port = scene.ports.find(p => p.id === id);
  const names = [port.name];
  let owner = scene.nodes.find(n => n.id === port.ownerId);
  while (owner.parentId) {
    names.unshift(owner.name);
    owner = scene.nodes.find(n => n.id === owner.parentId);
  }
  return names.join('.');
}

// 独立预期来自用户十三条内部 connect，不根据投影结果构造关系正确答案。
const batteryConnections = [
  ['coolantInlet', 'module1.coolantInlet'],
  ['module1.coolantOutlet', 'module2.coolantInlet'],
  ['module2.coolantOutlet', 'module3.coolantInlet'],
  ['module3.coolantOutlet', 'module4.coolantInlet'],
  ['module4.coolantOutlet', 'coolantOutlet'],
  ...[1, 2, 3, 4].flatMap(i => [
    [`module${i}.coolantInlet`, `module${i}.coolingChannel.channelInlet`],
    [`module${i}.coolingChannel.channelOutlet`, `module${i}.coolantOutlet`]
  ])
];

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const examples = (await import(pathToFileURL(path.join(__dirname, '../apps/teacher/dist/agent/sysml-view-guidance.mjs')))).SYSML_STANDARD_VIEW_EXAMPLES;
  const cases = [
    { id: 'general', viewName: 'systemOverview', content, mode: 'DEFAULT' },
    { id: 'requirements', viewName: 'requirementsOverview', mode: 'DEFAULT',
      content: fs.readFileSync(path.join(__dirname, 'fixtures/plantuml-view-regressions/requirement-hierarchy.sysml'), 'utf8'),
      provenance: 'requirement-hierarchy-regression' },
    { id: 'interconnection', viewName: 'thermalConnections', content, mode: 'INTERCONNECTION', counts: [21, 35, 23] },
    { id: 'battery', viewName: 'batteryPackInternal', content, mode: 'INTERCONNECTION', counts: [13, 18, 13] },
    { id: 'action', viewName: 'winterHeatingFlow', content, mode: 'ACTION', counts: [5, 0, 3] },
    ...examples.filter(e => ['STATE', 'SEQUENCE'].includes(e.renderMode)).map(e => ({
      id: e.renderMode.toLowerCase(), content: e.content || e.code, viewName: e.viewName, mode: e.renderMode,
      provenance: 'existing-standard-example'
    }))
  ];
  const url = process.env.LAYOUT_VALIDATOR_URL;
  const service = url ? null : new SysmlPlantUmlService(compileOfficialValidator());
  const render = input => url ? fetch(`${url}/plantuml`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input) }).then(r => r.json()) : service.render(input);
  const report = [];
  try {
    for (const sample of cases) {
      assert(sample.content, `${sample.id}: missing fixture`);
      const result = await render({ content: sample.content, viewName: sample.viewName });
      fs.writeFileSync(path.join(output, `${sample.id}.json`), JSON.stringify(result, null, 2));
      assert.equal(result.ok, true, `${sample.id}: ${JSON.stringify(result.diagnostics)}`);
      assert.equal(result.resolvedRenderMode, sample.mode);
      assert.match(result.svg, /<svg\b/);
      assert.match(result.svg, /(?:xlink:)?href="psysml:/);
      assert.equal(result.layoutOptimization.attempted, 1);
      if (sample.counts) {
        const scene = result.layoutScene;
        assert.deepEqual(['nodes', 'ports', 'edges'].map(k => scene[k].length), sample.counts);
        assert.deepEqual(inspectScene(result.diagramDocument, scene).issues, []);
        assert.equal(result.drawingBackend, 'plantuml-ugraphic');
        for (const edge of scene.edges) assert(result.svg.includes(`id="${edge.id}"`));
        if (sample.id !== 'action') {
          const prefix = sample.id === 'battery' ? '' : 'batteryPack.';
          const actual = scene.edges.map(e => [endpoint(scene, e.source), endpoint(scene, e.target)])
            .filter(([a, b]) => sample.id === 'battery' || (a.startsWith(prefix) && b.startsWith(prefix)));
          assert.deepEqual(actual, batteryConnections.map(pair => pair.map(name => prefix + name)));
          const groups = scene.nodes.filter(n => n.name === 'cellGroup');
          assert.equal(groups.length, 4);
          assert(groups.every(n => n.multiplicity === '[24]'));
          assert.equal(new Set(groups.map(n => n.parentId)).size, 4);
          // 根据用户模型定义的十条内部引出逐项检查，覆盖每层容器内外端口。
          const inward = scene.edges.flatMap(e => [e.source, e.target].map(id => ({ e, p: scene.ports.find(p => p.id === id) })))
            .filter(({ e, p }) => p.ownerId === e.contextId);
          assert.equal(inward.length, 10);
          const wrong = structuredClone(scene);
          const item = inward[0];
          const bad = wrong.edges.find(e => e.id === item.e.id);
          const end = bad.source === item.p.id ? bad.points[0] : bad.points.at(-1);
          end.x = item.p.anchor.x;
          assert(inspectScene(result.diagramDocument, wrong).issues.some(i => i.endsWith(':detached')));
          const wrongBoundary = structuredClone(scene);
          wrongBoundary.ports[0].x += 20;
          assert(inspectScene(result.diagramDocument, wrongBoundary).issues.some(i => i.endsWith(':wrong-boundary')));
        }
      } else {
        const general = ['general', 'requirements'].includes(sample.id);
        assert.equal(result.renderer, general ? 'local-layout' : 'engineering-native');
        if (general) assert.deepEqual(inspectScene(result.diagramDocument, result.layoutScene).issues, []);
        else assert.match(result.plantuml, /#253247/);
        if (sample.id === 'general') {
          assert.equal(result.diagramDocument.nodes.length, 21);
          assert.equal(result.diagramDocument.edges.length, 20);
          assert.equal(result.layoutScene.nodes.length, 21);
          assert.equal(result.layoutScene.edges.length, 20);
          assert(result.layoutScene.nodes.every(n => n.layoutParentId === ''));
          for (const port of result.diagramDocument.ports) {
            const block = result.layoutScene.nodes.find(n => n.id === port.ownerId);
            assert(block.cardRows.some(row => row.sourceElementId === port.sourceElementId), `${port.id}: port in wrong card`);
          }
        }
        if (sample.id === 'requirements') {
          const doc = result.diagramDocument;
          assert.equal(doc.profile, 'requirement-hierarchy', result.projectionFallbackReason);
          assert.deepEqual(doc.nodes.map(n => n.reqId), ['REQ-000', 'REQ-100', 'REQ-110', 'REQ-120', 'REQ-200']);
          const name = id => doc.nodes.find(n => n.id === id).name;
          assert.deepEqual(doc.edges.map(e => [name(e.source), name(e.target)]), [
            ['ThermalRequirements', 'batteryManagement'], ['batteryManagement', 'temperatureMonitoring'],
            ['batteryManagement', 'coolantRouting'], ['ThermalRequirements', 'cabinManagement']
          ]);
          assert(doc.nodes.every(n => n.role === 'requirement'));
          assert.equal(result.layoutScene.edges.length, 4);
          const rows = result.layoutScene.nodes.flatMap(n => n.cardRows.map(row => row.text));
          assert(rows.includes('assume') && rows.includes('require') && rows.includes('subject'));
        }
        if (sample.id === 'sequence') {
          assert(result.svg.includes('request') && result.svg.includes('response'));
          assert(result.plantuml.indexOf('<style>') < result.plantuml.indexOf('participant '));
        }
      }
      fs.writeFileSync(path.join(output, `${sample.id}.svg`), result.svg);
      if (result.plantuml) fs.writeFileSync(path.join(output, `${sample.id}.puml`), result.plantuml);
      fs.writeFileSync(path.join(output, `${sample.id}.sysml`), sample.content);
      report.push({ id: sample.id, viewName: result.viewName, mode: sample.mode, provenance: sample.provenance || 'user-detailed-thermal-model',
        renderer: result.renderer, counts: sample.counts, status: 'PASS' });
      console.log(`${sample.id}: PASS (${result.renderer})`);
    }
    // 类型继承展开不丢子需求；require 外部引用不得伪造为嵌套需求。
    for (const viewName of ['installedOverview', 'referenceOverview']) {
      const result = await render({ content: cases.find(c => c.id === 'requirements').content, viewName });
      fs.writeFileSync(path.join(output, `${viewName}.json`), JSON.stringify(result, null, 2));
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(result.diagramDocument?.profile, 'requirement-hierarchy', result.projectionFallbackReason);
      if (viewName === 'installedOverview') {
        assert.equal(result.diagramDocument.nodes.length, 5);
        assert.equal(result.diagramDocument.edges.length, 4);
        assert.equal(result.diagramDocument.nodes[0].reqId, 'REQ-INSTANCE');
      } else {
        assert.equal(result.diagramDocument.nodes.length, 1);
        assert.equal(result.diagramDocument.edges.length, 0);
        const text = result.layoutScene.nodes.flatMap(n => n.cardRows.map(row => row.text)).join('\n');
        assert(text.includes('require') && text.includes('referencedRequirement'));
      }
      console.log(`${viewName}: PASS`);
    }
    const invalid = await render({ content: 'part def Broken { port ;', viewName: 'missing' });
    fs.writeFileSync(path.join(output, 'invalid.json'), JSON.stringify(invalid, null, 2));
    assert.equal(invalid.ok, false);
    assert(!invalid.svg);
    report.push({ id: 'invalid-syntax', status: 'PASS' });
  } finally {
    service?.stop();
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(report, null, 2));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
