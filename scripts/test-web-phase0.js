'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
runNpmScript('typecheck:web');
runNpmScript('build:web');
runNodeScript('scripts/test-web-static-routing.js');

console.log('web phase0 tests passed');

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

function runNodeScript(script) {
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    stdio: 'inherit'
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}
