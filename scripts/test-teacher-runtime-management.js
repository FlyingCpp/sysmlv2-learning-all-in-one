'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tests = [
  'test-public-resource-policy-integration',
  'test-teacher-resource-policy-runtime',
  'test-ai-teacher-student-question-limit',
  'test-teacher-provider-resilience',
  'test-teacher-structured-output-boundaries',
  'test-teacher-agent-response-sanitizer',
  'test-teacher-agent-tools',
  'test-teacher-validated-candidate-delivery',
  'test-teacher-repair-convergence',
  'test-ai-teacher-task-lifecycle-contract',
  'test-teacher-run-resources',
  'test-teacher-worker-dispatcher',
  'test-teacher-candidate-worker',
  'test-teacher-intent-orchestrator-v2',
  'test-web-search-probe-policy',
  'test-ai-teacher-token-policy',
  'test-ai-teacher-automatic-continuation',
  'test-ai-teacher-engineering-improvement-continuation',
  'test-teacher-engineering-semantic-advisory',
  'test-ai-teacher-thread-lifecycle',
  'test-ai-teacher-execution-checkpoint'
];

for (const test of tests) {
  const result = spawnSync(process.execPath, [path.join('scripts', `${test}.js`)], {
    cwd: root,
    stdio: 'inherit',
    timeout: 120000,
    env: {
      ...process.env,
      DATA_DIR: path.join(root, '.tmp', 'runtime-management-data'),
      AI_TEACHER_INTERNAL_TOKEN: 'test-teacher-internal-token',
      AI_TEACHER_TOOL_TOKEN: 'test-teacher-validator-tool-token'
    }
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`teacher runtime and management: ${tests.length} test scripts passed`);
