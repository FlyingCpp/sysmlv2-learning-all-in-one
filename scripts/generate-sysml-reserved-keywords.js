'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createInventoryFromFiles } = require('./sysml-knowledge/extract-language-inventory');

// 使用当前 Validator 固定语法的有效规则，排除 ID、转义字符等词法终结规则。
function createKeywordAsset() {
  const sourceDirectory = path.resolve(__dirname, 'fixtures/sysml-grammar/pilot-2026-04');
  const provenance = JSON.parse(fs.readFileSync(path.join(sourceDirectory, 'provenance.json'), 'utf8'));
  const runtime = require('../packages/teacher-contract/official-validator-runtime-artifacts.json');
  assert.equal(provenance.jarHash, runtime.components.jarHash, '词表语法必须匹配 Validator 内核版本');
  for (const file of provenance.files) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceDirectory, file.path))).digest('hex');
    assert.equal(actual, file.sha256, `官方语法文件已改变：${file.path}`);
  }
  const inventory = createInventoryFromFiles({
    sourceDirectory
  });
  const keywords = [...new Set(inventory.grammar.effectiveRules
    .filter((rule) => rule.kind !== 'terminal')
    .flatMap((rule) => rule.directLiterals)
    .filter((value) => /^[A-Za-z][A-Za-z0-9_]*$/.test(value)))].sort();
  return {
    baseline: inventory.inventoryId,
    source: 'Systems-Modeling/SysML-v2-Pilot 2026-04: SysML.xtext + inherited KerMLExpressions.xtext',
    keywords
  };
}

const output = path.resolve(__dirname, '../packages/teacher-contract/sysml-reserved-keywords.json');
// 前端独立 tsc 测试会改变输出目录，生成包内镜像，避免依赖仓库外层相对路径。
const webOutput = path.resolve(__dirname, '../apps/web/src/lib/sysml/reserved-keywords.json');
if (require.main === module) {
  const asset = createKeywordAsset();
  for (const file of [output, webOutput]) {
    if (process.argv.includes('--check')) {
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), asset, '保留字资产与固定官方语法不一致，请重新生成');
    } else {
      fs.writeFileSync(file, `${JSON.stringify(asset, null, 2)}\n`, 'utf8');
    }
  }
  console.log(`SysML reserved keywords: ${asset.keywords.length}; ${process.argv.includes('--check') ? 'PASS' : 'generated'}`);
}
module.exports = { createKeywordAsset };
