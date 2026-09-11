'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inspectScene } = require('../packages/sysml-plantuml-service/diagram-layout');
const { compileOfficialValidator } = require('./compile-official-validator');
const { SysmlPlantUmlService } = require('../packages/sysml-plantuml-service/service');

async function main() {
  const base = path.join(__dirname, 'fixtures/plantuml-view-regressions/multiroot');
  const catalog = JSON.parse(fs.readFileSync(path.join(base, 'catalog.json'), 'utf8'));
  const samples = catalog.cases.filter(c => ['GeneralView', 'InterconnectionView'].includes(c.viewKind)
    && c.expectedSyntaxValid && c.expectedSemanticValid);
  samples.push({ id: 'ComplexNineRoots', file: '../electric-vehicle-charging-complex-interconnection.sysml',
    viewName: 'ElectricVehicleCharging::vehicleInterconnection', viewKind: 'InterconnectionView', expectedDisplayRoots: 9 });
  samples.push({ id: 'ProjectionBudget201', viewName: 'Budget::target', expectedError: 'PROJECTION_LIMIT_OR_RECURSION',
    content: 'package Budget { ' + Array.from({ length: 201 }, (_, i) => `part a${i};`).join(' ')
      + ' view target : StandardViewDefinitions::GeneralView { '
      + Array.from({ length: 201 }, (_, i) => `expose a${i};`).join(' ') + ' } }' });
  const report = [];
  const url = process.env.LAYOUT_VALIDATOR_URL;
  const service = url ? null : new SysmlPlantUmlService(compileOfficialValidator());
  const render = input => url ? fetch(`${url}/plantuml`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }).then(r => r.json()) : service.render(input);
  try {
  for (const sample of samples) {
    try {
      const result = await render({ content: sample.content || fs.readFileSync(path.join(base, sample.file), 'utf8'), viewName: sample.viewName });
      if (sample.expectedError) {
        assert.equal(result.ok, false);
        assert(JSON.stringify(result.diagnostics).includes(sample.expectedError));
        assert(!result.svg, 'budget failure must not fall back to a huge SVG');
        report.push({ id: sample.id, status: 'PASS', errorBoundary: sample.expectedError });
        console.log(JSON.stringify(report.at(-1)));
        continue;
      }
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert(result.diagramDocument, `missing projection: ${result.projectionFallbackReason}`);
      const document = result.diagramDocument;
      assert.equal(result.renderer, 'local-layout');
      assert.deepEqual(inspectScene(document, result.layoutScene).issues, []);
      const roots = document.nodes.filter(n => !n.parentId);
      assert.equal(roots.length, sample.expectedDisplayRoots);
      if (sample.expectedRootNames) assert.deepEqual(roots.map(n => n.name).sort(), [...sample.expectedRootNames].sort());
      if (sample.viewKind === 'InterconnectionView') {
        assert.equal(result.renderer, 'local-layout');
        assert.deepEqual(inspectScene(document, result.layoutScene).issues, []);
        if (sample.id.startsWith('InterconnectionView-')) assert.equal(document.edges.length, sample.expectedDisplayRoots);
      }
      if (sample.id === 'CrossRootConnection') {
        assert.equal(document.presentation.exposedElementCount, 3);
        assert.equal(document.edges.length, 1);
        const endpoints = [document.edges[0].source, document.edges[0].target].map(id => {
          const port = document.ports.find(p => p.id === id);
          return `${document.nodes.find(n => n.id === port.ownerId).name}.${port.name}`;
        });
        assert.deepEqual(endpoints, ['a.p', 'b.p']);
      }
      if (sample.id === 'MixedRequirements') {
        assert.deepEqual(document.nodes.filter(n => !n.parentId).map(n => n.role).sort(), ['part', 'part', 'requirement']);
        assert.equal(document.edges.filter(e => e.kind === 'feature-typing').length, 1);
      }
      if (sample.id === 'ComplexNineRoots') {
        // 声明 oracle：模块 8 条、包 16 + 4*8 条、整车 5 + 48 条；叶定义无内部连接。
        const expected = { ElectricVehicle: 53, ev: 53, BatteryPack: 48, BatteryModule: 8,
          CellGroup: 0, Contactor: 0, CoolingPlate: 0, PackSensor: 0, ModuleSensor: 0 };
        for (const root of roots) {
          const children = new Set([root.id]);
          for (const node of document.nodes) if (children.has(node.parentId)) children.add(node.id);
          assert.equal(document.edges.filter(e => children.has(e.contextId)).length, expected[root.name]);
        }
        assert.equal(document.edges.length, 162);
      }
      report.push({ id: sample.id, status: 'PASS', roots: roots.length, edges: document.edges.length });
    } catch (error) {
      report.push({ id: sample.id, status: 'BLOCK', error: error.message });
    }
    console.log(JSON.stringify(report.at(-1)));
    if (process.env.MULTIROOT_RENDER_EVIDENCE) fs.writeFileSync(process.env.MULTIROOT_RENDER_EVIDENCE, JSON.stringify(report, null, 2));
  }
  if (process.env.MULTIROOT_RENDER_EVIDENCE) fs.writeFileSync(process.env.MULTIROOT_RENDER_EVIDENCE, JSON.stringify(report, null, 2));
  assert(report.every(r => r.status === 'PASS'), 'multi-root rendering gate failed');
  } finally { if (service) await service.stop(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
