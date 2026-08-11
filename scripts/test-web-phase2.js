'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'apps', 'web', 'dist');
const assetsDir = path.join(distDir, 'react-assets');

runNpmScript('typecheck:web');
runNpmScript('build:web');

const jsAsset = readAssets('js');
const cssAsset = readAssets('css');
const routerSource = fs.readFileSync(path.join(root, 'apps', 'web', 'src', 'app', 'router.tsx'), 'utf8');
const shellSource = fs.readFileSync(path.join(root, 'apps', 'web', 'src', 'app', 'AppShell.tsx'), 'utf8');

assert(jsAsset.includes('React Phase 2 Low-Risk Pages'), 'React asset must expose the Phase 2 shell marker');
assert(jsAsset.includes('data-course-list-page'), 'React asset must include the migrated course list page anchor');
assert(jsAsset.includes('data-course-detail-page'), 'React asset must include the migrated course detail page anchor');
assert(!jsAsset.includes('data-examples-page'), 'React asset must not include the removed examples page anchor');
assert(!jsAsset.includes('data-example-detail-page'), 'React asset must not include the removed example detail page anchor');
assert(jsAsset.includes('data-glossary-page'), 'React asset must include the migrated glossary page anchor');
assert(jsAsset.includes('data-metamodel-graph'), 'React asset must include the platform glossary graph anchor');
assert(jsAsset.includes('data-login-form'), 'React asset must include the migrated login form anchor');
assert(jsAsset.includes('/api/courses'), 'React asset must call the courses API');
assert(!jsAsset.includes('/api/examples'), 'React asset must not call the removed examples API');
assert(jsAsset.includes('/api/glossary'), 'React asset must call the glossary API');
assert(jsAsset.includes('/api/platform/glossaries/sysml-v2-core/graph'), 'React asset must call the platform glossary graph API');
assert(cssAsset.includes('phase2Shell'), 'React CSS must include Phase 2 shell styles');
assert(cssAsset.includes('courseGrid'), 'React CSS must include course grid styles');
assert(cssAsset.includes('glossaryLayout'), 'React CSS must include glossary layout styles');
assert(cssAsset.includes('networkNode') && cssAsset.includes('networkLink') && cssAsset.includes('generalizationPath'), 'React CSS must include glossary network graph styles');
assert(routerSource.includes('<HomePage />'), 'router must use the React home page');
assert(routerSource.includes('<CourseListPage />'), 'router must use the React course list page');
assert(routerSource.includes('<CourseDetailPage'), 'router must use the React course detail page');
assert(!routerSource.includes('ExamplesPage') && !routerSource.includes("path: 'examples'"), 'router must not register removed examples routes');
assert(routerSource.includes('<GlossaryPage />'), 'router must use the React glossary page');
assert(shellSource.includes('data-react-phase2-root'), 'AppShell must expose a Phase 2 root anchor');

console.log('web phase2 tests passed');

function runNpmScript(script) {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', `npm run ${script}`]
    : ['run', script];
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_cache: path.join(root, '.npm-cache')
    }
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

function readAssets(extension) {
  const files = fs.readdirSync(assetsDir).filter((name) => name.endsWith(`.${extension}`));
  assert(files.length > 0, `React ${extension} asset must exist in dist/react-assets`);
  return files.map((file) => fs.readFileSync(path.join(assetsDir, file), 'utf8')).join('\n');
}
