'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compileOfficialValidator } = require('./compile-official-validator');
const { SysmlPlantUmlService } = require('../packages/sysml-plantuml-service/service');

async function main() {
  const url = process.env.BROWSER_VALIDATOR_URL;
  const service = url ? null : new SysmlPlantUmlService(compileOfficialValidator());
  const render = input => url ? fetch(`${url}/plantuml`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
  }).then(r => r.json()) : service.render(input);
  const source = fs.readFileSync(path.join(__dirname, 'fixtures/plantuml-view-regressions/drone-browser.sysml'), 'utf8');
  try {
    const result = await render({ content: source, viewName: 'modelBrowserView' });
    if (process.env.BROWSER_EVIDENCE) {
      fs.mkdirSync(process.env.BROWSER_EVIDENCE, { recursive: true });
      fs.writeFileSync(path.join(process.env.BROWSER_EVIDENCE, 'drone-browser.json'), JSON.stringify(result, null, 2));
      fs.writeFileSync(path.join(process.env.BROWSER_EVIDENCE, 'drone-browser.svg'), result.svg || '');
    }
    if (process.env.BROWSER_BASELINE === '1') {
      console.log(JSON.stringify({ baseline: true, ok: result.ok, mode: result.resolvedRenderMode, renderer: result.renderer,
        fallback: result.projectionFallbackReason, svgSize: result.svg?.match(/viewBox="([^"]+)"/)?.[1] }));
      return;
    }
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.resolvedRenderMode, 'DEFAULT');
    assert.equal(result.standardViewDefinition, 'StandardViewDefinitions::BrowserView');
    assert.equal(result.browserTree.profile, 'browser-membership');
    const nodes = result.browserTree.nodes;
    assert.equal(new Set(nodes.map(n => n.sourceElementId)).size, nodes.length, 'recursive expose must not duplicate members');
    const roots = nodes.filter(n => !n.parentId);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].name, 'DJI风格四旋翼无人机架构模型');
    assert.deepEqual(nodes.filter(n => n.parentId === roots[0].id).map(n => n.name), ['Requirements', 'Structure', 'Behavior', 'Views']);
    const controller = nodes.find(n => n.name === 'FlightController');
    assert(controller);
    assert(nodes.some(n => n.parentId === controller.id && n.kind === 'ConnectionUsage' && n.name.includes('connect')));
    const usage = nodes.find(n => n.name === 'flightController' && n.typeName === 'FlightController');
    assert(usage);
    assert(!nodes.some(n => n.parentId === usage.id), 'typing must not duplicate definition members under a usage');
    assert(!nodes.some(n => n.name.includes('StandardViewDefinitions::BrowserView') && n.kind === 'ViewDefinition'), 'do not import library definitions');
    assert.match(result.svg, /<svg\b/);
    assert.match(result.plantuml, /#253247/);
    assert(!result.plantuml.includes(' -down- '), 'membership rows must not become a graph of cross relations');
    // 单根、多个根和自定义 BrowserView 特化均从官方类型及成员 API 解析。
    const sample = 'package Browse { part def A { part child; } part def B; view def Custom specializes StandardViewDefinitions::BrowserView; view v : Custom { expose A; expose B; } }';
    const custom = await render({ content: sample, viewName: 'v' });
    assert.equal(custom.ok, true, JSON.stringify(custom.diagnostics));
    assert.equal(custom.resolvedRenderMode, 'DEFAULT');
    assert.deepEqual(custom.browserTree.nodes.map(n => n.name), ['A', 'child', 'B']);
    const invalid = await render({ content: 'package Broken { part def', viewName: 'v' });
    assert.equal(invalid.ok, false, 'invalid syntax must not produce a successful browser tree');
    assert(!invalid.browserTree);
    console.log(JSON.stringify({ status: 'PASS', nodeCount: nodes.length, roots: roots.map(n => n.name), cases: ['drone', 'custom-multiple-roots', 'invalid-syntax'] }));
  } finally {
    if (service) await service.stop();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
