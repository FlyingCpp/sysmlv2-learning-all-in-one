'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.OFFICIAL_VALIDATOR_ENABLED = 'false';
process.env.AI_TEACHER_INTERNAL_TOKEN = 'public-policy-test-internal';
delete process.env.AUTH_DATABASE_URL;
delete process.env.BETTER_AUTH_DATABASE_URL;

async function main() {
  const { server: validator } = require('../apps/validator/server');
  await listen(validator);
  process.env.VALIDATOR_URL = address(validator);
  const { createServer: createTeacher } = require('../apps/teacher/server');
  const { runtimeProjection, BOOTSTRAP_VALUES } = require('../packages/agent-resource-policy');
  let providerSettings = runtimeProjection(BOOTSTRAP_VALUES).provider;
  let failNextApply = false;
  const teacher = createTeacher({
    providerMode: 'mock', providerEnabled: false,
    internalToken: process.env.AI_TEACHER_INTERNAL_TOKEN,
    toolToken: 'public-policy-test-tool',
    activeBundleRequired: false,
    knowledge: { async debug() { return {}; } },
    skillSource: { async retrieve() { return []; } },
    conversation: { async close() {} },
    providerGateway: {
      get settings() { return providerSettings; },
      updateSettings(settings) {
        if (failNextApply) {
          failNextApply = false;
          throw Object.assign(new Error('Synthetic Owner failure'), { code: 'TEST_OWNER_FAILURE' });
        }
        providerSettings = settings;
      }
    }
  });
  await listen(teacher);
  process.env.TEACHER_URL = address(teacher);
  const { createAccountStore } = require('../apps/api/account-store');
  const accountStore = createAccountStore();
  const authService = {
    betterAuth: { accountStore },
    async requireEntitlement(req, code) {
      if (req.headers['x-test-role'] !== 'admin' || code !== 'admin.console.access') {
        throw Object.assign(new Error('Denied'), { statusCode: 403, code: 'PERMISSION_DENIED' });
      }
      return { id: 'public-policy-admin' };
    }
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synfeld-policy-'));
  const { createServer: createApi } = require('../apps/api/server');
  const api = createApi({
    authService, dataDir, aiTeacherEnabled: true,
    providerStatusMonitor: { start() {}, stop() {} }
  });
  await listen(api);
  const base = address(api);
  const route = '/api/admin/ai-teacher/resource-policy';
  const ownerHeaders = { 'x-ai-teacher-token': process.env.AI_TEACHER_INTERNAL_TOKEN };
  try {
    await request(address(validator) + '/internal/resource-policy', {}, 401);
    await request(base + route + '/active', {}, 403);
    const initial = await request(base + route + '/active', admin());
    const values = { ...initial.desired.values, 'validator.queueLimit': 5, 'provider.queueLimit': 9 };
    const draft = await request(base + route + '/versions', admin('POST', { values }), 201);
    const published = await request(base + route + `/versions/${draft.version.versionId}/publish`, admin('POST', {}));
    assert.equal(published.inSync, true);
    assert.equal(published.desired.versionId, draft.version.versionId);
    const validatorState = await request(address(validator) + '/internal/resource-policy', { headers: ownerHeaders });
    assert.equal(validatorState.versionId, draft.version.versionId);
    assert.equal(validatorState.queueLimit, 5);
    await request(address(validator) + '/internal/resource-policy', {
      method: 'PUT', headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ ...validatorState, executionTimeoutMs: 0 })
    }, 400);
    const unchanged = await request(address(validator) + '/internal/resource-policy', { headers: ownerHeaders });
    assert.equal(unchanged.executionTimeoutMs, validatorState.executionTimeoutMs);

    const failing = await request(base + route + '/versions', admin('POST', {
      values: { ...values, 'provider.queueLimit': 10 }
    }), 201);
    failNextApply = true;
    await request(base + route + `/versions/${failing.version.versionId}/publish`, admin('POST', {}), 503);
    const recovered = await request(base + route + '/active', admin());
    assert.equal(recovered.desired.versionId, draft.version.versionId);
    assert.equal(recovered.inSync, true, '失败补偿必须恢复实际 Owner，不能只保留数据库 Active');
    assert.equal(providerSettings.queueLimit, 9);
    console.log('public resource policy integration passed: authorization, publish, readback, invalid input, compensation');
  } finally {
    await Promise.all([api, teacher, validator].map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); }
function address(server) { return `http://127.0.0.1:${server.address().port}`; }
function admin(method = 'GET', body) {
  return { method, headers: { 'x-test-role': 'admin', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}
async function request(url, init, expected = 200) {
  const response = await fetch(url, init);
  const body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body));
  return body;
}
main().catch(error => { console.error(error); process.exit(1); });
