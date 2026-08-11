'use strict';

const fs = require('fs');
const path = require('path');

loadEnv();

const ports = {
  web: process.env.WEB_PORT || '3000',
  api: process.env.API_PORT || '8080',
  teacher: process.env.TEACHER_PORT || '7070',
  validator: process.env.VALIDATOR_PORT || '9090'
};

main().catch((error) => {
  console.error(JSON.stringify({ status: 'BLOCK', error: error.message }, null, 2));
  process.exit(1);
});

async function main() {
  await expectResponse(`http://127.0.0.1:${ports.web}/`, 'Web');
  const api = await expectJson(`http://127.0.0.1:${ports.api}/health`, 'API');
  const providers = await expectJson(`http://127.0.0.1:${ports.api}/api/auth/providers`, 'Better Auth providers');
  const teacher = await expectJson(`http://127.0.0.1:${ports.teacher}/health`, 'AI Teacher');
  const validator = await expectJson(`http://127.0.0.1:${ports.validator}/health`, 'Validator');

  if (!api.coursePackLoaded || api.validator?.ok !== true) throw new Error('API course or Validator dependency is not ready');
  if (!providers.emailPassword || !providers.registration) throw new Error('persistent registration is not enabled');
  if (teacher.provider?.gateway !== 'litellm') throw new Error('AI Teacher is not using LiteLLM');
  if (teacher.ok !== true || teacher.retrieval?.mode !== 'postgres_pgvector') {
    throw new Error('AI Teacher persistent retrieval is not ready');
  }
  if (teacher.knowledgePolicy?.activeBundleRequired === true && teacher.retrieval?.ready !== true) {
    throw new Error('AI Teacher requires an active reviewed knowledge Bundle, but none is ready');
  }
  if (teacher.retrieval?.ready !== true
    && teacher.retrieval?.error !== 'ACTIVE_SYSML_KNOWLEDGE_BUNDLE_REQUIRED') {
    throw new Error('AI Teacher retrieval storage failed for a reason other than an optional inactive Bundle');
  }
  if (validator.ok !== true) throw new Error('official Validator is not ready');

  console.log(JSON.stringify({
    status: 'PASS',
    web: 'ready',
    api: 'ready',
    auth: 'postgres',
    teacherGateway: 'litellm',
    teacherStorage: 'postgres_pgvector',
    reviewedKnowledge: teacher.knowledgePolicy?.reviewedKnowledgeActive ? 'active' : 'not-activated',
    validator: 'official-ready',
    realProviderCompletion: 'RUN_SEPARATELY_AS_DOCUMENTED'
  }, null, 2));
}

async function expectJson(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  try { return text ? JSON.parse(text) : {}; } catch { throw new Error(`${label} returned invalid JSON`); }
}

async function expectResponse(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
}

function loadEnv() {
  const envPath = path.resolve(process.cwd(), process.env.SYNFELD_ENV_FILE || '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const name = trimmed.slice(0, separator).trim();
    if (process.env[name] === undefined) {
      process.env[name] = trimmed.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/u, '$2');
    }
  }
}
