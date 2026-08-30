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
    expectedMode: 'ibd-single-context',
    expectedConnectors: 5
  },
  {
    label: 'complex',
    content: fs.readFileSync(path.join(fixtureRoot, 'electric-vehicle-charging-complex-interconnection.sysml'), 'utf8'),
    expectedMode: 'route-only-multi-context',
    expectedConnectors: 29
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
    assert.strictEqual(rendered.source, 'official-sysml-v2-pilot-2026-04');
    assert.strictEqual(rendered.resolvedRenderMode, 'INTERCONNECTION');
    assert.strictEqual(rendered.interconnectionLayout?.applied, true, JSON.stringify(rendered.interconnectionLayout, null, 2));
    assert.strictEqual(rendered.interconnectionLayout.metrics.layoutMode, testCase.expectedMode);
    assert.strictEqual(rendered.interconnectionLayout.metrics.connectorCount, testCase.expectedConnectors);
    assert.strictEqual(rendered.interconnectionLayout.metrics.unresolvedConnectorCount, 0);
    assert.strictEqual(rendered.interconnectionLayout.metrics.partOverlapCount, 0);
    assert.strictEqual(rendered.interconnectionLayout.metrics.nonOrthogonalConnectorCount, 0);
    if (testCase.label === 'complex') assert.strictEqual(rendered.interconnectionLayout.metrics.movedClusterCount, 0);
  }

  console.log('real PlantUML service runtime tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
