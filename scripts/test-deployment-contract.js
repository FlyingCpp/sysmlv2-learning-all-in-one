'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const core = read('docker-compose.yml');
const full = read('docker-compose.full.yml');
const env = read('.env.example');
const liteLlm = read('config/litellm/config.example.yaml');
const deployment = read('DEPLOYMENT.md', false);

assert(core.includes('api_data:/app/data'), 'Core must persist learner data');
assert(core.includes('AI_TEACHER_ENABLED: "false"'), 'Core must explicitly disable AI Teacher');
assert(!core.includes('AI_TEACHER_PROVIDER: mock'), 'Core must not advertise a Mock Teacher');
for (const service of ['auth-db:', 'teacher-db:', 'litellm-db:', 'litellm:', 'teacher:']) {
  assert(full.includes(service), `Full must define ${service}`);
}
assert(full.includes('condition: service_healthy'), 'Full dependencies must use health conditions');
assert(full.includes('AI_TEACHER_REQUIRE_ACTIVE_BUNDLE'), 'Full must declare the reviewed-knowledge policy');
assert(full.includes('@sha256:'), 'Full infrastructure images must be pinned by digest');
assert(full.includes('profiles: ["full"]'), 'Full services must use the full profile');
for (const name of ['AUTH_DB_PASSWORD', 'TEACHER_DB_PASSWORD', 'LITELLM_DB_PASSWORD', 'BETTER_AUTH_SECRET', 'LITELLM_MASTER_KEY', 'PROVIDER_API_KEY', 'AI_TEACHER_REQUIRE_ACTIVE_BUNDLE']) {
  assert(env.includes(`${name}=`), `.env.example must declare ${name}`);
}
assert(liteLlm.includes('model_name: ai-teacher-fast'));
assert(liteLlm.includes('api_key: os.environ/PROVIDER_API_KEY'));
assert(liteLlm.includes('turn_off_message_logging: true'));
assert(!/\bsk-[A-Za-z0-9_-]{20,}\b/u.test(`${core}\n${full}\n${env}\n${liteLlm}`), 'deployment assets must not contain provider secrets');
if (deployment) assert(deployment.includes('docker-compose.full.yml'), 'deployment guide must document the Full override');

console.log('public deployment contract tests passed');

function read(relative, required = true) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`Missing deployment file: ${relative}`);
    return '';
  }
  return fs.readFileSync(file, 'utf8');
}
