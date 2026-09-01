'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { compileOfficialValidator, resolveOfficialPaths } = require('./compile-official-validator');
const { improveInterconnectionSvg, countNonOrthogonalConnectors } = require('../apps/validator/interconnection-svg-layout');

const fixtureRoot = path.join(__dirname, 'fixtures', 'plantuml-view-regressions');
const simpleContent = fs.readFileSync(path.join(fixtureRoot, 'electric-vehicle-charging-interconnection.sysml'), 'utf8');
const complexContent = fs.readFileSync(path.join(fixtureRoot, 'electric-vehicle-charging-complex-interconnection.sysml'), 'utf8');
const viewName = 'ElectricVehicleCharging::vehicleInterconnection';

function svgNumberAttr(tag, name) {
  return Number.parseFloat(String(tag || '').match(new RegExp(`\\b${name}=["'](-?\\d+(?:\\.\\d+)?)["']`, 'i'))?.[1] || 'NaN');
}

function clusterRectGeometry(svg) {
  const geometry = [];
  const clusterPattern = /<g\b[^>]*\bid=["']cluster_(E\d+)["'][^>]*>[\s\S]*?<\/g>/gi;
  for (const match of String(svg || '').matchAll(clusterPattern)) {
    const rect = match[0].match(new RegExp(`<rect\\b[^>]*\\bid=["']${match[1]}["'][^>]*>`, 'i'))?.[0] || '';
    geometry.push([
      match[1],
      svgNumberAttr(rect, 'x'),
      svgNumberAttr(rect, 'y'),
      svgNumberAttr(rect, 'width'),
      svgNumberAttr(rect, 'height')
    ].join(':'));
  }
  return geometry.sort();
}

async function assertOfficialValidation(validateWorkspace, content, label) {
  const result = await validateWorkspace({ content });
  assert.strictEqual(result.syntaxValid, true, `${label} syntax failed: ${JSON.stringify(result.diagnostics, null, 2)}`);
  assert.strictEqual(result.semanticValid, true, `${label} semantics failed: ${JSON.stringify(result.diagnostics, null, 2)}`);
}

function resolveGraphvizDot() {
  if (process.env.GRAPHVIZ_DOT && fs.existsSync(process.env.GRAPHVIZ_DOT)) return process.env.GRAPHVIZ_DOT;
  if (process.platform === 'win32') {
    const candidates = childProcess.execFileSync('where.exe', ['dot'], { encoding: 'utf8' })
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean);
    const resolved = candidates.find((candidate) => fs.existsSync(candidate));
    if (resolved) return resolved;
  }
  return '/usr/bin/dot';
}

async function main() {
  const paths = resolveOfficialPaths();
  assert(fs.existsSync(paths.jarPath), `official SysML kernel is missing: ${paths.jarPath}`);
  assert(fs.existsSync(paths.libraryPath), `official SysML library is missing: ${paths.libraryPath}`);

  compileOfficialValidator();
  process.env.SYSML_OFFICIAL_JAR = paths.jarPath;
  process.env.SYSML_LIBRARY_PATH = paths.libraryPath;
  process.env.SYSML_WRAPPER_CLASSES = paths.classesPath;
  process.env.OFFICIAL_VALIDATOR_ENABLED = 'true';
  process.env.OFFICIAL_VALIDATOR_FALLBACK = 'false';
  process.env.OFFICIAL_VALIDATOR_TIMEOUT_MS = process.env.OFFICIAL_VALIDATOR_TIMEOUT_MS || '300000';
  process.env.OFFICIAL_PLANTUML_ENABLED = 'true';
  process.env.OFFICIAL_PLANTUML_TIMEOUT_MS = process.env.OFFICIAL_PLANTUML_TIMEOUT_MS || '300000';
  process.env.GRAPHVIZ_DOT = resolveGraphvizDot();
  assert(fs.existsSync(process.env.GRAPHVIZ_DOT), `Graphviz dot is missing: ${process.env.GRAPHVIZ_DOT}`);

  const { validateWorkspace, generatePlantUml, backend, outlineBackend, plantUmlBackend } = require('../apps/validator/validator');

  try {

  await assertOfficialValidation(validateWorkspace, simpleContent, 'simple interconnection fixture');
  const simple = await generatePlantUml({ content: simpleContent, viewName });
  assert.strictEqual(simple.ok, true, JSON.stringify(simple, null, 2));
  assert.strictEqual(simple.resolvedRenderMode, 'INTERCONNECTION');
  assert.strictEqual(simple.interconnectionLayout?.applied, true, JSON.stringify(simple.interconnectionLayout, null, 2));
  assert.strictEqual(simple.interconnectionLayout.metrics.layoutMode, 'ibd-single-context');
  assert.strictEqual(simple.interconnectionLayout.metrics.connectorCount, 5);
  assert.strictEqual(simple.interconnectionLayout.metrics.unresolvedConnectorCount, 0);
  assert.strictEqual(simple.interconnectionLayout.metrics.partOverlapCount, 0);
  assert.strictEqual(simple.interconnectionLayout.metrics.nonOrthogonalConnectorCount, 0);
  for (const expectedText of ['chargePort: ChargingPort', 'obc: OnBoardCharger', 'bms: BatteryManagementSystem', 'tms: ThermalManagementSystem', 'battery: BatteryPack']) {
    assert(String(simple.svg).includes(expectedText), `simple SVG is missing ${expectedText}`);
  }

  await assertOfficialValidation(validateWorkspace, complexContent, 'complex interconnection fixture');
  const raw = await generatePlantUml({ content: complexContent, viewName, layoutOptimization: { mode: 'off' } });
  const optimized = await generatePlantUml({ content: complexContent, viewName });
  assert.strictEqual(raw.ok, true, JSON.stringify(raw, null, 2));
  assert.strictEqual(optimized.ok, true, JSON.stringify(optimized, null, 2));
  assert.strictEqual(optimized.resolvedRenderMode, 'INTERCONNECTION');
  assert.strictEqual(optimized.interconnectionLayout?.applied, true, JSON.stringify(optimized.interconnectionLayout, null, 2));
  assert.strictEqual(optimized.interconnectionLayout.metrics.layoutMode, 'route-only-multi-context');
  assert(optimized.interconnectionLayout.metrics.compositeContextCount >= 3, JSON.stringify(optimized.interconnectionLayout.metrics, null, 2));
  assert.strictEqual(optimized.interconnectionLayout.metrics.movedClusterCount, 0);
  assert.strictEqual(optimized.interconnectionLayout.metrics.connectorCount, 29);
  assert.strictEqual(optimized.interconnectionLayout.metrics.unresolvedConnectorCount, 0);
  assert.strictEqual(optimized.interconnectionLayout.metrics.nonOrthogonalConnectorCount, 0);
  assert.strictEqual(countNonOrthogonalConnectors(optimized.svg), 0);

  const direct = improveInterconnectionSvg(raw.svg);
  assert.strictEqual(direct.metrics.connectorCount, 29);
  assert.strictEqual(direct.metrics.unresolvedConnectorCount, 0);
  const rawGeometry = clusterRectGeometry(raw.svg);
  assert.strictEqual(rawGeometry.length, 23, 'complex fixture must retain all 23 context and part clusters');
  assert.deepStrictEqual(clusterRectGeometry(direct.svg), rawGeometry, 'multi-context optimization must preserve official cluster geometry');
  for (const expectedText of ['ElectricVehicle', 'BatteryPack', 'BatteryModule', 'CellGroup', 'PackSensor']) {
    assert(String(optimized.svg).includes(expectedText), `complex SVG is missing ${expectedText}`);
  }

    console.log('official PlantUML interconnection tests passed');
  } finally {
    backend.restart();
    outlineBackend.restart();
    await plantUmlBackend.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
