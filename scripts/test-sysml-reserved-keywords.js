'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createKeywordAsset } = require('./generate-sysml-reserved-keywords');
const root = path.resolve(__dirname, '..');

async function main() {
  const expected = createKeywordAsset();
  for (const file of ['packages/teacher-contract/sysml-reserved-keywords.json', 'apps/web/src/lib/sysml/reserved-keywords.json']) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')), expected, file);
  }
  for (const word of ['frame', 'references', 'first', 'assign', 'import', 'constant']) assert(expected.keywords.includes(word));
  for (const word of ['a', 'Z', '0', 'Frame', 'framePart', 'readonly']) assert(!expected.keywords.includes(word));
  const { SYSML_RESERVED_KEYWORD_GUIDANCE: guidance } = await import(pathToFileURL(path.join(root, 'apps/teacher/dist/agent/sysml-reserved-keywords.mjs')).href);
  assert(guidance.includes(`保留字：${expected.keywords.join(' ')}`));
  assert(guidance.includes("drone.'frame'") && guidance.includes('双引号表示字符串'));
  assert(Buffer.byteLength(guidance, 'utf8') < 4000, '基础知识应保持紧凑');
  const source = fs.readFileSync(path.join(root, 'apps/teacher/agent/production-worker-handlers.mts'), 'utf8');
  assert.match(source, /const REPAIR_INSTRUCTIONS = \[[\s\S]*?SYSML_RESERVED_KEYWORD_GUIDANCE[\s\S]*?\]\.join/);
  assert.match(source, /function candidateInstructions\(\): string \{[\s\S]*?SYSML_RESERVED_KEYWORD_GUIDANCE/);
  console.log(`reserved keyword tests PASS: ${expected.keywords.length} keywords, ${Buffer.byteLength(guidance, 'utf8')} prompt bytes`);
  if (process.argv.includes('--official')) {
    const cases = [
      { name: 'all-quoted-keywords', valid: true, code: `package KeywordProbe { part def Unit; ${expected.keywords.map((word) => `part '${word}' : Unit;`).join('\n')} }` },
      { name: 'quoted-reference', valid: true, code: "package KeywordReference { part def Frame; part def Drone { part 'frame' : Frame; } part drone : Drone; ref part chassis : Frame = drone.'frame'; }" },
      ...['frame', 'references', 'first'].map((word) => ({ name: `unquoted-${word}`, valid: false, code: `package KeywordNegative { part def Unit; part ${word} : Unit; }` }))
    ];
    for (const fixture of cases) {
      const baseUrl = (process.env.VALIDATOR_URL || process.env.LAYOUT_VALIDATOR_URL || 'http://localhost:9090').replace(/\/+$/, '');
      const response = await fetch(`${baseUrl}/validate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: [{ path: 'main.sysml', content: fixture.code }] }), signal: AbortSignal.timeout(30000)
      });
      const result = await response.json();
      assert(response.ok && result.valid === fixture.valid && !result.fallbackActive, `${fixture.name}: ${JSON.stringify(result.diagnostics || [])}`);
      console.log(`Official Validator PASS: ${fixture.name}; valid=${result.valid}`);
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
