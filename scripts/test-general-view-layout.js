'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { layoutDiagram, inspectScene } = require('../packages/sysml-plantuml-service/diagram-layout');
const { compileOfficialValidator } = require('./compile-official-validator');
const { SysmlPlantUmlService } = require('../packages/sysml-plantuml-service/service');

async function main() {
  const url = process.env.LAYOUT_VALIDATOR_URL;
  const service = url ? null : new SysmlPlantUmlService(compileOfficialValidator());
  const output = process.env.GENERAL_LAYOUT_EVIDENCE || '.tmp/general-layout-regression';
  fs.mkdirSync(output, { recursive: true });
  const render = input => url ? fetch(`${url}/plantuml`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }).then(r => r.json()) : service.render(input);
  try {
    const results = [];
    for (const [file, viewName] of [['drone-interfaces.sysml', 'architectureView'],
      ['requirement-definition-relations.sysml', 'requirementOverview']]) {
      const content = fs.readFileSync(path.join(__dirname, 'fixtures/plantuml-view-regressions', file), 'utf8');
      const result = await render({ content, viewName });
      fs.writeFileSync(path.join(output, `${viewName}.json`), JSON.stringify(result));
      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(result.renderer, 'local-layout');
      assert.deepEqual(inspectScene(result.diagramDocument, result.layoutScene).issues, []);
      fs.writeFileSync(path.join(output, `${viewName}.svg`), result.svg);
      results.push(result);
    }
    const { diagramDocument: document, layoutScene: scene } = results[0];
    // 独立声明 oracle：12 根 + Drone/drone 各 14 个成员 + FlightController 定义内 4 个成员。
    assert.deepEqual([document.nodes.length, document.ports.length, document.edges.length], [44, 87, 53]);
    assert.equal(document.nodes.filter(n => !n.parentId).length, 12);
    assert.equal(document.edges.filter(e => e.kind === 'part-membership').length, 32);
    assert.equal(document.edges.filter(e => e.kind === 'feature-typing').length, 21);
    const byId = new Map(document.nodes.map(n => [n.id, n]));
    for (const edge of document.edges) {
      if (edge.kind === 'part-membership') assert.equal(byId.get(edge.target).parentId, edge.source);
      if (edge.kind === 'feature-typing') assert.equal(byId.get(edge.source).typeName, byId.get(edge.target).name);
    }
    for (const port of document.ports) {
      assert(scene.nodes.find(n => n.id === port.ownerId).cardRows.some(r => r.sourceElementId === port.sourceElementId));
      assert(results[0].svg.includes(`psysml:${port.sourceElementId}`));
    }
    const requirements = results[1].diagramDocument;
    const reqById = new Map(requirements.nodes.map(n => [n.id, n.name]));
    assert.deepEqual(requirements.edges.map(e => `${reqById.get(e.source)}|${reqById.get(e.target)}|${e.kind}`).sort(), [
      'SystemRequirements|cooling|required-requirement', 'SystemRequirements|heating|required-requirement',
      'Cooling|Capability|subclassification', 'cooling|Cooling|feature-typing', 'heating|Heating|feature-typing',
      'referenceHolder|externalRequirement|required-reference', 'referenceHolder|operatingAssumption|assumed-reference'
    ].sort());
    const corruptions = [
      s => { s.nodes.pop(); },
      s => { s.nodes[0].cardRows.pop(); },
      s => { s.nodes[0].cardRows[0].text = 'lost content'; },
      s => { s.nodes[0].x = s.nodes[1].x; s.nodes[0].y = s.nodes[1].y; },
      s => { s.ports[0].ownerId = 'wrong'; },
      s => { s.edges[0].points[1].x += 5; s.edges[0].points[1].y += 7; },
      s => { s.edges[0].sourceAnchor.ownerId = 'wrong'; },
      s => { s.edges[0].points = []; },
      s => { s.edges.find(e => e.kind === 'feature-typing').dashed = false; },
      s => { s.edges.find(e => e.kind === 'feature-typing').marker = 'none'; },
      s => { s.edges.find(e => e.labels.length).labels[0].x = s.nodes[0].x + 1;
        s.edges.find(e => e.labels.length).labels[0].y = s.nodes[0].y + 1; }
    ];
    for (const corrupt of corruptions) {
      const broken = structuredClone(scene); corrupt(broken);
      assert.equal(inspectScene(document, broken).status, 'failed');
    }
    await assert.rejects(layoutDiagram(document, { timeoutMs: 0 }), { code: 'LAYOUT_BUDGET_EXCEEDED' });
    await assert.rejects(layoutDiagram(document, { timeoutMs: 1 }), { code: 'LAYOUT_BUDGET_EXCEEDED' });
    await assert.rejects(layoutDiagram(document, { signal: AbortSignal.abort() }), { code: 'LAYOUT_CANCELLED' });
    const controller = new AbortController();
    const jobs = [layoutDiagram(document, { signal: controller.signal }), layoutDiagram(document, { signal: controller.signal })];
    const settled = Promise.allSettled(jobs);
    await assert.rejects(layoutDiagram(document), { code: 'LAYOUT_BUSY' });
    controller.abort();
    for (const result of await settled) assert.equal(result.reason.code, 'LAYOUT_CANCELLED');
    const recovered = await layoutDiagram(document);
    assert.equal(recovered.quality.status, 'ready', '取消后必须释放 Worker 名额');
    assert.deepEqual(recovered.scene.edges.map(e => e.points), scene.edges.map(e => e.points), '相同输入必须保持路由稳定');
    await assert.rejects(layoutDiagram({ ...document, nodes: Array(201).fill(document.nodes[0]) }), { code: 'INVALID_DOCUMENT' });
    console.log('PASS: General drone 44/87/53, requirement relations 7, content and geometry faults 11, worker budget/cancel/concurrency');
  } finally { if (service) await service.stop(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
