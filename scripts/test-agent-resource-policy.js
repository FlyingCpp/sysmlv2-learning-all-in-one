'use strict';

const assert = require('node:assert/strict');
const {
  SCHEMA_VERSION,
  BOOTSTRAP_VALUES,
  DEPRECATED_KEYS,
  catalog,
  validatePolicyValues,
  createPolicySnapshot,
  runtimeProjection,
  migratePolicyValues
} = require('../packages/agent-resource-policy');

const currentCatalog = catalog();
const valid = validatePolicyValues(BOOTSTRAP_VALUES);
assert.equal(valid.ok, true, JSON.stringify(valid.errors));
assert.equal(SCHEMA_VERSION, 7);
assert.equal(currentCatalog.schemaVersion, 7);
assert.equal(currentCatalog.definitions.length, Object.keys(BOOTSTRAP_VALUES).length);
assert.equal(BOOTSTRAP_VALUES['repair.maxRounds'], 3);
assert.equal(BOOTSTRAP_VALUES['candidate.maxArtifactBytes'], 262_144);
assert.equal(BOOTSTRAP_VALUES['knowledge.reviewedMaxNewQueriesPerRun'], 4);
assert.equal(Object.hasOwn(BOOTSTRAP_VALUES, 'repair.maxOutputTokens'), false);
assert.equal(Object.hasOwn(BOOTSTRAP_VALUES, 'candidate.maxValidatorCallsPerWorker'), false);
assert.equal(DEPRECATED_KEYS['repair.maxOutputTokens'].replacement, 'removed:repair-output-is-provider-managed');

for (const rounds of [0, 3, 12]) {
  const values = { ...BOOTSTRAP_VALUES, 'repair.maxRounds': rounds };
  const projection = runtimeProjection(values);
  assert.equal(projection.teacher.agentRepairMaxRounds, rounds);
  assert.equal(projection.teacher.agentMaxUniqueCandidateValidationsPerWorker, 1 + rounds);
  assert.equal(projection.teacher.agentCandidateMaxArtifactBytes, 262_144);
  assert.equal(Object.hasOwn(projection.teacher, 'agentRepairMaxOutputTokens'), false);
}

const snapshot = createPolicySnapshot({ versionId: 'arp_public_v7_test', values: BOOTSTRAP_VALUES });
assert.equal(snapshot.schemaVersion, 7);
assert.match(snapshot.checksum, /^sha256:[a-f0-9]{64}$/u);

const unknown = validatePolicyValues({ ...BOOTSTRAP_VALUES, 'unknown.resource.gate': 1 });
assert.equal(unknown.ok, false);
assert(unknown.errors.some((item) => item.code === 'POLICY_FIELD_UNKNOWN'));

const invalidRounds = validatePolicyValues({ ...BOOTSTRAP_VALUES, 'repair.maxRounds': 13 });
assert.equal(invalidRounds.ok, false);
const invalidBytes = validatePolicyValues({ ...BOOTSTRAP_VALUES, 'candidate.maxArtifactBytes': 1024 });
assert.equal(invalidBytes.ok, false);

const v6Values = publicV6Values();
const migrated = migratePolicyValues(v6Values);
assert.equal(migrated.values['knowledge.reviewedMaxNewQueriesPerRun'], 2,
  '迁移必须保留已发布的共享知识查询 ceiling。');
assert.equal(migrated.values['repair.maxRounds'], 3,
  '宽松的旧 Validator 上限必须安全收缩到 v7 默认 Repair 轮次。');
assert.equal(migrated.values['candidate.maxArtifactBytes'], 262_144);
assert.deepEqual(new Set(migrated.deprecatedKeys), new Set([
  'candidate.maxValidatorCallsPerWorker',
  'repair.maxOutputTokens'
]));
assert.deepEqual(migrated.unknownKeys, []);

const stricter = migratePolicyValues({
  ...v6Values,
  'candidate.maxValidatorCallsPerWorker': 2
});
assert.equal(stricter.values['repair.maxRounds'], 1,
  '旧配置更严格时不得被迁移扩大。');

assert.throws(() => migratePolicyValues({
  ...v6Values,
  'repair.maxOutputTokens': 'invalid'
}), (error) => error?.code === 'AGENT_RESOURCE_POLICY_SCHEMA_MIGRATION_INVALID');

console.log('Agent resource policy v7 tests passed.');

function publicV6Values() {
  const values = { ...BOOTSTRAP_VALUES };
  delete values['repair.maxRounds'];
  delete values['candidate.maxArtifactBytes'];
  values['knowledge.reviewedMaxNewQueriesPerRun'] = 2;
  values['candidate.maxValidatorCallsPerWorker'] = 12;
  values['repair.maxOutputTokens'] = 32_000;
  return values;
}
