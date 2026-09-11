'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { compileOfficialValidator } = require('./compile-official-validator');
const { SysmlPlantUmlService } = require('../packages/sysml-plantuml-service/service');

// 预期端点来自 fixture 的声明路径，不能只相信投影自己的关系计数。
function pathsFromSource(source) {
  const stack = [], names = new Map();
  for (const line of source.split('\n')) {
    const match = line.match(/"([^"\n]*)"\s+as (E\d+)\b/);
    if (match) {
      const name = match[1].trim().replace(/^\^/, '').split(':')[0].trim();
      const full = [...stack, name].join('/');
      names.set(match[2], full);
      if (line.trimEnd().endsWith('{')) stack.push(name);
    } else if (line.trim() === '}') stack.pop();
  }
  return names;
}

async function main() {
  const output = path.resolve(process.env.RELATION_EVIDENCE || '.tmp/relation-repair-20260906/relations');
  fs.mkdirSync(output, { recursive: true });
  const url = process.env.LAYOUT_VALIDATOR_URL;
  const service = url ? null : new SysmlPlantUmlService(compileOfficialValidator());
  const render = input => url ? fetch(`${url}/plantuml`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }).then(r => r.json()) : service.render(input);
  try {
    const content = fs.readFileSync(path.join(__dirname, 'fixtures/plantuml-view-regressions/connection-binding-values.sysml'), 'utf8');
    const result = await render({ content, viewName: 'overview' });
    fs.writeFileSync(path.join(output, 'relations.json'), JSON.stringify(result, null, 2));
    if (result.svg) fs.writeFileSync(path.join(output, 'relations.svg'), result.svg);
    if (result.plantuml) fs.writeFileSync(path.join(output, 'relations.puml'), result.plantuml);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    const names = pathsFromSource(result.plantuml);
    const actual = (result.relationProjection || []).map(r => {
      assert(['added', 'present'].includes(r.status), JSON.stringify(r));
      assert(result.svg.includes(`link_${r.source}_${r.target}`) || result.svg.includes(`link_${r.target}_${r.source}`), '关系必须形成 SVG 连线');
      return `${names.get(r.source)}|${names.get(r.target)}|${r.kind}`;
    }).sort();
    const expected = [
      'system/left/output|system/right/input|connection',
      'system/left|system/right|connection',
      'system/left/output/value|system/right/input/value|binding',
      'system/left/output/value|system/right/input/value|binding',
      'system/left/compute/received|system/left/input/value|value-binding',
      'system/left/compute/sent|system/left/output/value|value-binding',
      'system/right/compute/received|system/right/input/value|value-binding',
      'system/right/compute/sent|system/right/output/value|value-binding',
      'system/fixedValue|system/constantValue|value-binding'
    ].sort();
    assert.deepEqual(actual, expected);
    const edges = result.plantuml.split('\n').filter(l => /^E\d+\s+.*\s+E\d+\b/.test(l));
    assert.equal(edges.length, expected.length, '不能丢失关系、误去重或将初值/默认值/计算式添加为二元绑定');
    const portResult = await render({ content, viewName: 'portOverview' });
    fs.writeFileSync(path.join(output, 'port-values.json'), JSON.stringify(portResult, null, 2));
    assert.equal(portResult.ok, true);
    assert.equal(portResult.projectionFallbackReason, 'FEATURE_VALUE_REQUIRES_NATIVE_PROJECTION');
    const portNames = pathsFromSource(portResult.plantuml);
    assert.deepEqual(portResult.relationProjection.map(r => `${portNames.get(r.source)}|${portNames.get(r.target)}|${r.kind}`),
      ['portValues/boundPort|portValues/sourcePort|value-binding']);
    const invalid = await render({ content: content.replace('right.input;', 'missing.input;'), viewName: 'overview' });
    fs.writeFileSync(path.join(output, 'invalid-endpoint.json'), JSON.stringify(invalid, null, 2));
    assert.equal(invalid.ok, false, '无效模型不能作为生成成功返回');
    console.log('PASS: 9 contextual relations, port value fallback, distinct bindings, initialization/default exclusion, invalid endpoint');
  } finally { service?.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
