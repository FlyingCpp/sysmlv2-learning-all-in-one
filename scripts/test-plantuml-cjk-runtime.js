'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const endpoint = process.env.PLANTUML_TEST_ENDPOINT || 'http://localhost:9090/plantuml';
const fixturePath = path.join(__dirname, 'fixtures', 'plantuml-cjk-layout.sysml');

function attributeNumber(attributes, name) {
  const match = String(attributes).match(new RegExp(`\\b${name}=["'](-?\\d+(?:\\.\\d+)?)["']`, 'i'));
  return match ? Number(match[1]) : NaN;
}

function cjkMetricRatios(svg) {
  const ratios = [];
  const textPattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  for (const match of String(svg || '').matchAll(textPattern)) {
    const cjkCount = Array.from(match[2]).filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint >= 0x3400 && codePoint <= 0x9fff;
    }).length;
    if (!cjkCount) continue;
    const fontSize = attributeNumber(match[1], 'font-size');
    const textLength = attributeNumber(match[1], 'textLength');
    if (!Number.isFinite(fontSize) || !Number.isFinite(textLength)) continue;
    ratios.push(textLength / (cjkCount * fontSize));
  }
  return ratios;
}

async function main() {
  const content = fs.readFileSync(fixturePath, 'utf8');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content,
      viewName: 'CjkLayout::cjkRequirementView'
    })
  });
  assert.strictEqual(response.status, 200, `PlantUML endpoint returned HTTP ${response.status}`);
  const result = await response.json();
  assert.strictEqual(result.ok, true, result.diagnostics?.[0]?.message || 'PlantUML CJK fixture did not render');
  assert.strictEqual(result.kind, 'SVG');

  const ratios = cjkMetricRatios(result.svg);
  assert(ratios.length >= 2, 'PlantUML SVG must contain the fixture Chinese documentation text');
  assert(
    ratios.every((ratio) => ratio >= 0.9),
    `PlantUML compressed Chinese glyph metrics below 0.9em: ${ratios.map((ratio) => ratio.toFixed(3)).join(', ')}`
  );
  console.log(`PlantUML CJK runtime passed (${ratios.length} labels, minimum width ${Math.min(...ratios).toFixed(3)}em per Han glyph)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
