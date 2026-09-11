'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const { compileOfficialValidator, resolveOfficialPaths } = require('./compile-official-validator');

function diagramTestRuntime() {
  const url = process.env.LAYOUT_VALIDATOR_URL;
  if (url) {
    const post = async (route, input) => {
      const response = await fetch(`${url.replace(/\/$/, '')}${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
      });
      assert.equal(response.status, 200, `${route}: HTTP ${response.status}`);
      return response.json();
    };
    return { validateWorkspace: input => post('/validate', input), generatePlantUml: input => post('/plantuml', input),
      backend: { restart() {} }, outlineBackend: { restart() {} }, plantUmlBackend: { async stop() {} } };
  }
  const paths = resolveOfficialPaths();
  assert(fs.existsSync(paths.jarPath) && fs.existsSync(paths.libraryPath),
    '请先运行 npm run setup:official-validator 或指定 LAYOUT_VALIDATOR_URL；不能跳过官方验证。');
  compileOfficialValidator();
  process.env.SYSML_OFFICIAL_JAR = paths.jarPath;
  process.env.SYSML_LIBRARY_PATH = paths.libraryPath;
  process.env.SYSML_WRAPPER_CLASSES = paths.classesPath;
  process.env.OFFICIAL_PLANTUML_ENABLED = 'true';
  if (process.platform === 'win32' && !process.env.GRAPHVIZ_DOT) {
    const candidates = require('node:child_process').execFileSync('where.exe', ['dot'], { encoding: 'utf8' }).trim().split(/\r?\n/);
    process.env.GRAPHVIZ_DOT = candidates.find(file => fs.existsSync(file));
  }
  return require('../apps/validator/validator');
}

module.exports = { diagramTestRuntime };
