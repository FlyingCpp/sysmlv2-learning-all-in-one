'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const baseUrl = String(process.env.VALIDATOR_TEST_BASE_URL || 'http://localhost:9090').replace(/\/$/, '');
const fixtureRoot = path.join(__dirname, 'fixtures', 'plantuml-view-regressions');
const cases = [
  {
    label: 'simple',
    content: fs.readFileSync(path.join(fixtureRoot, 'electric-vehicle-charging-interconnection.sysml'), 'utf8'),
    expectedCounts: [12, 20, 10]
  },
  {
    label: 'complex',
    content: fs.readFileSync(path.join(fixtureRoot, 'electric-vehicle-charging-complex-interconnection.sysml'), 'utf8'),
    expectedCounts: [79, 235, 162]
  }
];

async function post(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  assert.strictEqual(response.status, 200, `${route} returned HTTP ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function main() {
  const healthResponse = await fetch(`${baseUrl}/health`);
  assert.strictEqual(healthResponse.status, 200, `health returned HTTP ${healthResponse.status}`);
  const health = await healthResponse.json();
  assert.strictEqual(health.official?.officialAvailable, true, JSON.stringify(health, null, 2));
  assert.strictEqual(health.plantuml?.officialAvailable, true, JSON.stringify(health, null, 2));

  for (const testCase of cases) {
    const validation = await post('/validate', { content: testCase.content });
    assert.strictEqual(validation.syntaxValid, true, `${testCase.label} syntax failed: ${JSON.stringify(validation.diagnostics, null, 2)}`);
    assert.strictEqual(validation.semanticValid, true, `${testCase.label} semantics failed: ${JSON.stringify(validation.diagnostics, null, 2)}`);

    const rendered = await post('/plantuml', {
      content: testCase.content,
      viewName: 'ElectricVehicleCharging::vehicleInterconnection'
    });
    assert.strictEqual(rendered.ok, true, JSON.stringify(rendered, null, 2));
    assert.strictEqual(rendered.source, 'official-sysml-v2-model-local-layout');
    assert.strictEqual(rendered.resolvedRenderMode, 'INTERCONNECTION');
    assert.strictEqual(rendered.renderer, 'local-layout');
    assert.deepStrictEqual([rendered.layoutScene.nodes.length, rendered.layoutScene.ports.length, rendered.layoutScene.edges.length], testCase.expectedCounts);
    assert.deepStrictEqual(require('../packages/sysml-plantuml-service/diagram-layout').inspectScene(rendered.diagramDocument, rendered.layoutScene).issues, []);
  }

  console.log('real PlantUML service runtime tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
