'use strict';

const assert = require('node:assert/strict');
const {
  BOOTSTRAP_VALUES,
  checksumPolicyValues,
  validatePolicyValues
} = require('../packages/agent-resource-policy');
const { createAccountStore, agentResourcePolicyStoreTesting } = require('../apps/api/account-store');

const MIGRATION_NOW = '2026-08-24T00:00:00.000Z';

async function main() {
  const emptyMemory = createAccountStore({ agentResourcePolicyVersions: [] });
  const [seed] = await emptyMemory.listAgentResourcePolicyVersions();
  assert.equal(seed.versionId, 'arp_bootstrap_v7');
  assert.equal(validatePolicyValues(seed.values).ok, true);

  const source = v6Version();
  const memoryStore = createAccountStore({ agentResourcePolicyVersions: [source] });
  const memoryVersions = await memoryStore.listAgentResourcePolicyVersions();
  assertMigrated(memoryVersions, source);
  assert.equal(source.status, 'active', '迁移不能修改调用方持有的源对象。');

  const idempotent = agentResourcePolicyStoreTesting.migrateMemoryAgentResourcePolicyVersions(
    memoryVersions,
    { now: MIGRATION_NOW }
  );
  assert.equal(idempotent.length, 2);
  assertMigrated(idempotent, source);

  const emptyPostgres = createFakePolicyPool([]);
  await agentResourcePolicyStoreTesting.migratePostgresAgentResourcePolicyVersions(
    emptyPostgres,
    { now: MIGRATION_NOW }
  );
  assert.equal(publicRow(emptyPostgres.rows[0]).versionId, 'arp_bootstrap_v7');

  const postgres = createFakePolicyPool([databaseRow(source)]);
  await agentResourcePolicyStoreTesting.migratePostgresAgentResourcePolicyVersions(postgres, { now: MIGRATION_NOW });
  await agentResourcePolicyStoreTesting.migratePostgresAgentResourcePolicyVersions(postgres, { now: MIGRATION_NOW });
  assert.equal(postgres.rows.length, 2);
  assertMigrated(postgres.rows.map(publicRow), source);

  const invalid = v6Version();
  invalid.values['unknown.resource.gate'] = 1;
  invalid.checksum = checksumPolicyValues(invalid.values);
  assert.throws(
    () => agentResourcePolicyStoreTesting.migrateMemoryAgentResourcePolicyVersions([invalid]),
    (error) => error?.code === 'AGENT_RESOURCE_POLICY_SCHEMA_MIGRATION_INVALID'
      && error?.reason === 'unsupported_source_values'
  );
  const invalidPostgres = createFakePolicyPool([databaseRow(invalid)]);
  await assert.rejects(
    agentResourcePolicyStoreTesting.migratePostgresAgentResourcePolicyVersions(invalidPostgres, { now: MIGRATION_NOW }),
    (error) => error?.code === 'AGENT_RESOURCE_POLICY_SCHEMA_MIGRATION_INVALID'
  );
  assert.equal(invalidPostgres.rows[0].status, 'active');

  const invalidDeprecated = v6Version();
  invalidDeprecated.values['repair.maxOutputTokens'] = '32000';
  assert.throws(
    () => agentResourcePolicyStoreTesting.migrateMemoryAgentResourcePolicyVersions([invalidDeprecated]),
    (error) => error?.reason === 'invalid_deprecated_source_values'
  );

  const duplicateActive = [v6Version(), { ...v6Version(), versionId: 'arp_legacy_v6_duplicate', sequence: 7 }];
  assert.throws(
    () => agentResourcePolicyStoreTesting.migrateMemoryAgentResourcePolicyVersions(duplicateActive),
    (error) => error?.reason === 'multiple_active_versions'
  );

  console.log('Agent resource policy v6 to v7 migration tests passed.');
}

function v6Version() {
  const values = { ...BOOTSTRAP_VALUES };
  delete values['repair.maxRounds'];
  delete values['candidate.maxArtifactBytes'];
  values['knowledge.reviewedMaxNewQueriesPerRun'] = 2;
  values['candidate.maxValidatorCallsPerWorker'] = 12;
  values['repair.maxOutputTokens'] = 32_000;
  return {
    versionId: 'arp_legacy_v6',
    sequence: 6,
    status: 'active',
    values,
    checksum: checksumPolicyValues(values),
    validation: { ok: true, errors: [], warnings: [] },
    sourceVersionId: '',
    notes: 'public v6 fixture',
    createdBy: 'test',
    validatedAt: MIGRATION_NOW,
    publishedBy: 'test',
    createdAt: MIGRATION_NOW,
    publishedAt: MIGRATION_NOW
  };
}

function assertMigrated(versions, source) {
  const old = versions.find((item) => item.versionId === source.versionId);
  const active = versions.find((item) => item.status === 'active');
  assert(old && active);
  assert.equal(old.status, 'retired');
  assert.deepEqual(old.values, source.values);
  assert.match(active.versionId, /^arp_schema_v7_[a-f0-9]{24}$/u);
  assert.equal(active.sourceVersionId, source.versionId);
  assert.equal(active.values['knowledge.reviewedMaxNewQueriesPerRun'], 2);
  assert.equal(active.values['repair.maxRounds'], 3);
  assert.equal(active.values['candidate.maxArtifactBytes'], 262_144);
  assert.equal(Object.hasOwn(active.values, 'repair.maxOutputTokens'), false);
  assert.equal(Object.hasOwn(active.values, 'candidate.maxValidatorCallsPerWorker'), false);
  assert.equal(validatePolicyValues(active.values).ok, true);
  assert.equal(active.checksum, checksumPolicyValues(active.values));
}

function createFakePolicyPool(initialRows) {
  const state = { rows: initialRows.map((row) => ({ ...row })) };
  const client = {
    query: async (sql, params = []) => {
      const normalized = sql.trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(normalized)
        || normalized.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
      if (normalized.includes('from ai_teacher_agent_policy_versions')
        && normalized.includes("where status = 'active'")) {
        const row = state.rows
          .filter((item) => item.status === 'active')
          .sort((left, right) => Number(right.sequence || 0) - Number(left.sequence || 0))[0];
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (normalized.startsWith('update ai_teacher_agent_policy_versions')
        && normalized.includes("set status = 'retired'")) {
        const row = state.rows.find((item) => item.version_id === params[0] && item.status === 'active');
        if (row) row.status = 'retired';
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      if (normalized.startsWith('insert into ai_teacher_agent_policy_versions')) {
        state.rows.push({
          version_id: params[0],
          sequence: Math.max(0, ...state.rows.map((item) => Number(item.sequence || 0))) + 1,
          status: 'active',
          values_json: params[1],
          checksum: params[2],
          validation_json: params[3],
          source_version_id: params[4],
          notes: params[5],
          created_by: params[6],
          validated_at: params[7],
          published_by: params[6],
          created_at: params[7],
          published_at: params[7]
        });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {}
  };
  return { get rows() { return state.rows; }, connect: async () => client };
}

function databaseRow(version) {
  return {
    version_id: version.versionId,
    sequence: version.sequence,
    status: version.status,
    values_json: JSON.stringify(version.values),
    checksum: version.checksum,
    validation_json: JSON.stringify(version.validation),
    source_version_id: version.sourceVersionId,
    notes: version.notes,
    created_by: version.createdBy,
    validated_at: version.validatedAt,
    published_by: version.publishedBy,
    created_at: version.createdAt,
    published_at: version.publishedAt
  };
}

function publicRow(row) {
  return {
    versionId: row.version_id,
    sequence: row.sequence,
    status: row.status,
    values: JSON.parse(row.values_json),
    checksum: row.checksum,
    validation: JSON.parse(row.validation_json),
    sourceVersionId: row.source_version_id || '',
    notes: row.notes,
    createdBy: row.created_by,
    validatedAt: row.validated_at,
    publishedBy: row.published_by,
    createdAt: row.created_at,
    publishedAt: row.published_at
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
