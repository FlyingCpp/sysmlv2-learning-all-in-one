'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  deriveKnowledgeRelations,
  materializeReviewedKnowledgeRelations,
  relationRow,
  validateKnowledgeRelationSet
} = require('./knowledge-relations');
const { materializeReviewedKnowledgePatterns } = require('./knowledge-patterns');
const { rankKnowledgeClaims, resolveKnowledgeRankingMode } = require('./knowledge-ranking');
const {
  ACTIVATION_READINESS_SCHEMA_VERSION,
  evaluateActivationReadiness
} = require('../../scripts/sysml-knowledge/activation-readiness-v1');

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
const PATTERN_ANCHOR_LIMIT = 4;
const AUTHORITATIVE_CLAIM_CLOSURE_RULES = Object.freeze([
  { operator: ':', astContextIds: ['sysml20:Usage'], claimIds: ['claim-colon-feature-typing', 'claim-typed-usage-inherits-features'] },
  { operator: ':>', astContextIds: ['sysml20:Definition'], claimIds: ['claim-colon-gt-subclassification'] },
  { operator: ':>', astContextIds: ['sysml20:Usage', 'kerml10:Feature'], claimIds: ['claim-colon-gt-subsetting'] },
  { operator: ':>>', claimIds: ['claim-redefinition'] },
  { operator: '::>', claimIds: ['claim-reference-subsetting', 'claim-reference-subsetting-specializes-subsetting'] },
  { operators: ['=', ':='], claimIds: ['claim-feature-value-fixed-vs-initial'] },
  { operators: ['default =', 'default :='], claimIds: ['claim-feature-value-default'] }
]);
const PROTECTIVE_SUPPORTING_CLAIM_CLOSURE_RULES = Object.freeze([
  { operator: '=', claimIds: ['claim-feature-value-fixed-vs-initial', 'claim-feature-value-default'] }
]);
const SYSML_ANSWER_CLOSURE_PROFILE_ID = 'sysml-answer-closure-v3';
const SYSML_ANSWER_CLOSURE_PROFILE = Object.freeze({
  schemaVersion: 'sysml-answer-closure-profile/v3',
  closureProfileId: SYSML_ANSWER_CLOSURE_PROFILE_ID,
  answerRequiredRules: AUTHORITATIVE_CLAIM_CLOSURE_RULES,
  protectiveSupportingRules: PROTECTIVE_SUPPORTING_CLAIM_CLOSURE_RULES,
  reviewedPatternClosure: {
    enabledWhen: 'active_bundle_declares_knowledge_patterns',
    anchorLimit: PATTERN_ANCHOR_LIMIT,
    matchKeys: ['anchorNodeIds', 'requiredClaimIds'],
    activation: 'llm_explicit_selection',
    runtimeClaimRole: 'supporting',
    requiredDimensions: ['claims', 'edges', 'guardrails', 'evidence'],
    unselectedCandidateEffect: 'none'
  },
  resourceLimit: MAX_LIMIT
});
const SYSML_ANSWER_CLOSURE_PROFILE_HASH = hashText(canonicalJson(SYSML_ANSWER_CLOSURE_PROFILE));
const BUNDLE_ARTIFACTS = [
  'source-documents.jsonl',
  'nodes.jsonl',
  'edges.jsonl',
  'claims.jsonl',
  'evidence-blocks.jsonl',
  'evidence-links.jsonl',
  'syntax-mappings.jsonl',
  'teaching-overlays.jsonl',
  'glossary-compat.json'
];
const OPTIONAL_BUNDLE_ARTIFACTS = [
  'knowledge-relations.jsonl',
  'knowledge-patterns.jsonl',
  'production-responsibilities.jsonl',
  'capability-units.jsonl',
  'model-user-objectives.jsonl'
];
const LANGUAGE_GOVERNANCE_EVALUATOR_ID = 'sysml-language-closure/v1';
const KNOWLEDGE_PATTERN_GOVERNANCE_EVALUATOR_ID = 'model-user-knowledge-pattern-closure/v1';
const PRODUCTION_KNOWLEDGE_EVALUATOR_ID = 'sysml-language-knowledgeization/v2';
const CAPABILITY_CLOSURE_EVALUATOR_ID = 'sysml-capability-closure/v1';
const PRODUCTION_KNOWLEDGE_GATE_NAMES = Object.freeze([
  'productionResponsibilityCompleteness',
  'productionProjectionIntegrity',
  'productionSourceBinding',
  'productionCapabilityBinding',
  'p0p4CapabilityClosure',
  'modelUserObjectiveMappingCompleteness',
  'authoritativeClaimEvidenceBindingIntegrity',
  'officialSourceExampleBinding',
  'exactRetrievalBindingIntegrity'
]);
const KNOWLEDGE_PATTERN_GATE_MAP = Object.freeze({
  modelUserScope: 'scopeCompleteness',
  knowledgePatternClosure: 'patternClosure',
  semanticFixtureCoverage: 'semanticFixtures'
});

function createKnowledgePool(options = {}) {
  const connectionString = options.connectionString || process.env.AI_TEACHER_DB_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('AI_TEACHER_DB_URL or DATABASE_URL is required for SysML knowledge storage');
  const { Pool } = require('pg');
  return new Pool({
    connectionString,
    max: Number(options.maxPoolSize || process.env.AI_TEACHER_DB_POOL_MAX || 5),
    connectionTimeoutMillis: Number(options.connectionTimeoutMillis || process.env.AI_TEACHER_DB_CONNECT_TIMEOUT_MS || 5000)
  });
}

async function migrateSysmlKnowledgeStore(options = {}) {
  const pool = options.pool || createKnowledgePool(options);
  try {
    await pool.query(`
      create table if not exists knowledge_bundles (
        bundle_id text primary key,
        baseline_id text not null,
        version text not null,
        status text not null check (status in ('CANDIDATE', 'VALIDATED', 'ACTIVE', 'RETIRED', 'FAILED')),
        manifest jsonb not null,
        source_registry_hash text not null,
        content_hash text not null,
        created_at timestamptz not null default now(),
        reviewed_at timestamptz,
        reviewed_by text,
        review_report_hash text,
        activated_at timestamptz
      )
    `);
    await pool.query(`create unique index if not exists knowledge_bundles_one_active_per_baseline_idx on knowledge_bundles (baseline_id) where status = 'ACTIVE'`);
    await pool.query(`create unique index if not exists knowledge_bundles_baseline_version_idx on knowledge_bundles (baseline_id, version)`);
    await pool.query(`
      create or replace function enforce_knowledge_bundle_lifecycle()
      returns trigger language plpgsql as $$
      begin
        if TG_OP = 'DELETE' then
          raise exception 'Knowledge Bundle rows are immutable: %', old.bundle_id;
        end if;
        if new.bundle_id is distinct from old.bundle_id
          or new.baseline_id is distinct from old.baseline_id
          or new.version is distinct from old.version
          or new.manifest is distinct from old.manifest
          or new.source_registry_hash is distinct from old.source_registry_hash
          or new.content_hash is distinct from old.content_hash
          or new.created_at is distinct from old.created_at
          or new.reviewed_at is distinct from old.reviewed_at
          or new.reviewed_by is distinct from old.reviewed_by
          or new.review_report_hash is distinct from old.review_report_hash then
          raise exception 'Knowledge Bundle identity and review columns are immutable: %', old.bundle_id;
        end if;
        if new.status is distinct from old.status and not (
          (old.status = 'CANDIDATE' and new.status in ('VALIDATED', 'FAILED'))
          or (old.status = 'VALIDATED' and new.status in ('ACTIVE', 'FAILED'))
          or (old.status = 'ACTIVE' and new.status = 'RETIRED')
          or (old.status = 'RETIRED' and new.status = 'ACTIVE')
        ) then
          raise exception 'Illegal Knowledge Bundle lifecycle transition: % -> %', old.status, new.status;
        end if;
        if new.activated_at is distinct from old.activated_at and new.status <> 'ACTIVE' then
          raise exception 'Knowledge Bundle activated_at may change only when entering ACTIVE: %', old.bundle_id;
        end if;
        return new;
      end;
      $$
    `);
    await pool.query('drop trigger if exists knowledge_bundles_lifecycle_guard on knowledge_bundles');
    await pool.query(`
      create trigger knowledge_bundles_lifecycle_guard
      before update or delete on knowledge_bundles
      for each row execute function enforce_knowledge_bundle_lifecycle()
    `);
    await pool.query(`
      create table if not exists source_documents (
        source_id text not null,
        bundle_id text not null references knowledge_bundles(bundle_id) on delete restrict,
        source_type text not null,
        authority_level text not null,
        document_name text not null,
        document_version text not null,
        omg_file_id text,
        repository_commit text,
        artifact_hash text not null,
        metadata jsonb not null default '{}'::jsonb,
        primary key (bundle_id, source_id)
      )
    `);
    await pool.query(`
      create table if not exists semantic_nodes (
        node_id text not null,
        bundle_id text not null references knowledge_bundles(bundle_id) on delete restrict,
        baseline_id text not null,
        node_kind text not null,
        name text not null,
        qualified_name text,
        source_id text,
        source_locator jsonb,
        properties jsonb not null default '{}'::jsonb,
        status text not null default 'ACTIVE',
        primary key (bundle_id, node_id),
        foreign key (bundle_id, source_id) references source_documents(bundle_id, source_id)
      )
    `);
    await pool.query(`
      create table if not exists semantic_edges (
        edge_id text not null,
        bundle_id text not null references knowledge_bundles(bundle_id) on delete restrict,
        baseline_id text not null,
        source_node_id text not null,
        predicate text not null,
        target_node_id text not null,
        authority_level text not null,
        source_id text,
        source_locator jsonb,
        review_status text not null,
        properties jsonb not null default '{}'::jsonb,
        primary key (bundle_id, edge_id),
        foreign key (bundle_id, source_node_id) references semantic_nodes(bundle_id, node_id),
        foreign key (bundle_id, target_node_id) references semantic_nodes(bundle_id, node_id),
        foreign key (bundle_id, source_id) references source_documents(bundle_id, source_id)
      )
    `);
    await pool.query(`
      create table if not exists normative_claims (
        claim_id text not null,
        bundle_id text not null references knowledge_bundles(bundle_id) on delete restrict,
        baseline_id text not null,
        claim_type text not null,
        subject_node_id text,
        predicate text not null,
        object_node_id text,
        operators text[] not null default '{}',
        syntax_context_ids text[] not null default '{}',
        ast_context_ids text[] not null default '{}',
        polarity text not null,
        modality text not null,
        authority_level text not null,
        review_status text not null,
        claim_text text not null,
        evidence_ids text[] not null default '{}',
        properties jsonb not null default '{}'::jsonb,
        search_vector tsvector not null default ''::tsvector,
        primary key (bundle_id, claim_id),
        foreign key (bundle_id, subject_node_id) references semantic_nodes(bundle_id, node_id),
        foreign key (bundle_id, object_node_id) references semantic_nodes(bundle_id, node_id)
      )
    `);
    await pool.query(`
      create table if not exists evidence_blocks (
        evidence_id text not null,
        bundle_id text not null references knowledge_bundles(bundle_id) on delete restrict,
        baseline_id text not null,
        source_id text not null,
        section_path text,
        block_type text not null,
        line_start integer,
        line_end integer,
        text_content text not null,
        text_hash text not null,
        authority_level text not null,
        review_status text not null,
        operators text[] not null default '{}',
        concept_ids text[] not null default '{}',
        ast_context_ids text[] not null default '{}',
        search_vector tsvector not null default ''::tsvector,
        primary key (bundle_id, evidence_id),
        foreign key (bundle_id, source_id) references source_documents(bundle_id, source_id)
      )
    `);
    await pool.query(`
      create table if not exists evidence_links (
        evidence_link_id text not null,
        bundle_id text not null references knowledge_bundles(bundle_id) on delete restrict,
        evidence_id text not null,
        target_type text not null,
        target_id text not null,
        relation_type text not null,
        link_method text not null,
        confidence numeric,
        review_status text not null,
        primary key (bundle_id, evidence_link_id),
        foreign key (bundle_id, evidence_id) references evidence_blocks(bundle_id, evidence_id),
        foreign key (bundle_id, target_id) references normative_claims(bundle_id, claim_id),
        check (target_type = 'claim')
      )
    `);
    await pool.query(`
      create table if not exists syntax_mappings (
        syntax_mapping_id text not null,
        bundle_id text not null references knowledge_bundles(bundle_id) on delete restrict,
        baseline_id text not null,
        token text not null,
        grammar_production_id text,
        ast_context_id text,
        semantic_node_id text,
        mapping_type text not null,
        parser_fixture_id text,
        review_status text not null,
        primary key (bundle_id, syntax_mapping_id),
        foreign key (bundle_id, semantic_node_id) references semantic_nodes(bundle_id, node_id)
      )
    `);
    await pool.query(`
      create table if not exists teaching_overlays (
        bundle_id text not null references knowledge_bundles(bundle_id) on delete restrict,
        overlay_id text not null,
        overlay_type text not null,
        authority_class text not null check (authority_class = 'engineering_guardrail'),
        description text not null,
        pattern_spec jsonb not null,
        pattern_hash text not null,
        counterexample_spec jsonb not null default '{}'::jsonb,
        review_status text not null,
        properties jsonb not null default '{}'::jsonb,
        primary key (bundle_id, overlay_id)
      )
    `);
    await pool.query(`
      create table if not exists teaching_overlay_claim_links (
        bundle_id text not null,
        overlay_id text not null,
        claim_id text not null,
        primary key (bundle_id, overlay_id, claim_id),
        foreign key (bundle_id, overlay_id) references teaching_overlays(bundle_id, overlay_id) on delete restrict,
        foreign key (bundle_id, claim_id) references normative_claims(bundle_id, claim_id) on delete restrict
      )
    `);
    await pool.query(`
      create table if not exists knowledge_patterns (
        bundle_id text not null references knowledge_bundles(bundle_id) on delete restrict,
        pattern_id text not null,
        title text not null,
        description text not null,
        exam_objective_ids text[] not null,
        anchor_node_ids text[] not null,
        required_claim_ids text[] not null,
        required_edge_ids text[] not null,
        guardrail_ids text[] not null,
        fixture_ids text[] not null,
        review_status text not null check (review_status = 'reviewed'),
        properties jsonb not null default '{}'::jsonb,
        primary key (bundle_id, pattern_id)
      )
    `);
    await pool.query(`
      create table if not exists knowledge_relations (
        relation_id text not null,
        bundle_id text not null references knowledge_bundles(bundle_id) on delete restrict,
        relation_hash text not null check (relation_hash ~ '^sha256:[a-f0-9]{64}$'),
        relation_layer text not null check (relation_layer in (
          'normative_semantic', 'derived_semantic', 'pedagogical', 'diagnostic', 'repair'
        )),
        predicate text not null,
        source_kind text not null,
        source_id text not null,
        target_kind text not null,
        target_id text not null,
        authority_level text not null,
        review_status text not null check (review_status in ('derived', 'candidate', 'reviewed', 'rejected')),
        conditions text[] not null default '{}',
        evidence_ids text[] not null default '{}',
        fixture_ids text[] not null default '{}',
        basis_claim_ids text[] not null default '{}',
        provenance jsonb not null default '{}'::jsonb,
        properties jsonb not null default '{}'::jsonb,
        primary key (bundle_id, relation_id),
        check (source_id <> target_id or source_kind <> target_kind),
        check (
          (relation_layer = 'normative_semantic' and predicate in (
            'SPECIALIZES', 'TYPED_BY', 'MEMBER_OF', 'OWNED_BY', 'USES_RELATIONSHIP'
          ) and source_kind = 'semantic_node' and target_kind = 'semantic_node' and review_status = 'reviewed')
          or (relation_layer = 'derived_semantic' and (
            (predicate = 'ABOUT' and source_kind = 'claim' and target_kind = 'semantic_node')
            or (predicate = 'USES_OPERATOR' and source_kind = 'claim' and target_kind = 'operator')
            or (predicate = 'APPLIES_IN_AST_CONTEXT' and source_kind = 'claim' and target_kind = 'ast_context')
            or (predicate = 'EVIDENCED_BY' and source_kind = 'claim' and target_kind = 'evidence')
            or (predicate = 'COVERS_KNOWN_POINT' and source_kind = 'claim' and target_kind = 'known_point')
            or (predicate = 'COVERS_EXAM_OBJECTIVE' and source_kind = 'claim' and target_kind = 'exam_objective')
          ) and review_status = 'derived')
          or (relation_layer = 'pedagogical' and predicate in ('PREREQUISITE', 'REFINES', 'CONTRASTS')
            and source_kind = 'claim' and target_kind = 'claim' and review_status in ('candidate', 'reviewed', 'rejected'))
          or (relation_layer = 'diagnostic' and predicate in ('DIAGNOSES_WITH', 'DISAMBIGUATES_WITH')
            and source_kind = 'diagnostic_concept' and target_kind = 'claim' and review_status in ('candidate', 'reviewed', 'rejected'))
          or (relation_layer = 'repair' and (
            (predicate = 'APPLIES_TO_DIAGNOSTIC' and source_kind = 'repair_overlay' and target_kind = 'diagnostic_concept')
            or (predicate = 'SUPPORTED_BY_CLAIM' and source_kind = 'repair_overlay' and target_kind = 'claim')
          ) and review_status in ('candidate', 'reviewed', 'rejected'))
        )
      )
    `);
    await pool.query(`
      create table if not exists knowledge_retrieval_sessions (
        tenant_id text not null,
        session_id text not null,
        bundle_id text not null references knowledge_bundles(bundle_id) on delete restrict,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        expires_at timestamptz not null,
        primary key (tenant_id, session_id, bundle_id)
      )
    `);
    await pool.query(`
      create table if not exists knowledge_retrieval_seen_items (
        tenant_id text not null,
        session_id text not null,
        bundle_id text not null,
        item_kind text not null check (item_kind in ('claim', 'evidence')),
        item_id text not null,
        first_seen_at timestamptz not null default now(),
        primary key (tenant_id, session_id, bundle_id, item_kind, item_id),
        foreign key (tenant_id, session_id, bundle_id)
          references knowledge_retrieval_sessions(tenant_id, session_id, bundle_id) on delete cascade
      )
    `);
    await pool.query(`
      do $$
      begin
        if not exists (select 1 from pg_constraint where conname = 'evidence_links_claim_target_fk') then
          alter table evidence_links
          add constraint evidence_links_claim_target_fk
          foreign key (bundle_id, target_id) references normative_claims(bundle_id, claim_id);
        end if;
        if not exists (select 1 from pg_constraint where conname = 'evidence_links_claim_target_type_check') then
          alter table evidence_links
          add constraint evidence_links_claim_target_type_check check (target_type = 'claim');
        end if;
      end
      $$
    `);
    await pool.query(`create index if not exists semantic_edges_source_predicate_idx on semantic_edges (bundle_id, source_node_id, predicate)`);
    await pool.query(`create index if not exists semantic_edges_target_predicate_idx on semantic_edges (bundle_id, target_node_id, predicate)`);
    await pool.query(`create index if not exists normative_claims_operators_idx on normative_claims using gin (operators)`);
    await pool.query(`create index if not exists normative_claims_search_idx on normative_claims using gin (search_vector)`);
    await pool.query(`create index if not exists evidence_blocks_operators_idx on evidence_blocks using gin (operators)`);
    await pool.query(`create index if not exists evidence_blocks_concepts_idx on evidence_blocks using gin (concept_ids)`);
    await pool.query(`create index if not exists evidence_blocks_search_idx on evidence_blocks using gin (search_vector)`);
    await pool.query(`create index if not exists syntax_mappings_token_idx on syntax_mappings (bundle_id, token, ast_context_id)`);
    await pool.query(`create index if not exists teaching_overlay_claim_links_claim_idx on teaching_overlay_claim_links (bundle_id, claim_id)`);
    await pool.query(`create index if not exists knowledge_relations_source_idx on knowledge_relations (bundle_id, source_kind, source_id, relation_layer)`);
    await pool.query(`create index if not exists knowledge_relations_target_idx on knowledge_relations (bundle_id, target_kind, target_id, relation_layer)`);
    await pool.query(`create index if not exists knowledge_retrieval_sessions_expiry_idx on knowledge_retrieval_sessions (expires_at)`);
    // 旧 Active Bundle 没有关系 artifact；迁移时只按冻结 profile 回填确定性投影。
    // 临时移除关系表自身 guard，避免已 ACTIVE Bundle 阻断幂等 backfill；其他 artifact guard 不受影响。
    await pool.query('drop trigger if exists knowledge_relations_immutable_guard on knowledge_relations');
    await backfillDerivedKnowledgeRelations(pool);
    await pool.query(`
      create or replace function reject_immutable_bundle_artifact_change()
      returns trigger language plpgsql as $$
      declare
        bundle_status text;
        target_bundle_id text;
      begin
        if TG_OP = 'UPDATE' then
          select status into bundle_status
          from knowledge_bundles
          where bundle_id = old.bundle_id;
          if bundle_status <> 'CANDIDATE' then
            raise exception 'Bundle artifacts are immutable after validation: %', old.bundle_id;
          end if;
        end if;
        target_bundle_id := case when TG_OP = 'DELETE' then old.bundle_id else new.bundle_id end;
        select status into bundle_status
        from knowledge_bundles
        where bundle_id = target_bundle_id;
        if bundle_status <> 'CANDIDATE' then
          raise exception 'Bundle artifacts are immutable after validation: %', target_bundle_id;
        end if;
        if TG_OP = 'DELETE' then
          return old;
        end if;
        return new;
      end;
      $$
    `);
    for (const tableName of [
      'source_documents',
      'semantic_nodes',
      'semantic_edges',
      'normative_claims',
      'evidence_blocks',
      'evidence_links',
      'syntax_mappings',
      'teaching_overlays',
      'teaching_overlay_claim_links',
      'knowledge_patterns',
      'knowledge_relations'
    ]) {
      await pool.query(`drop trigger if exists ${tableName}_immutable_guard on ${tableName}`);
      await pool.query(`
        create trigger ${tableName}_immutable_guard
        before insert or update or delete on ${tableName}
        for each row execute function reject_immutable_bundle_artifact_change()
      `);
    }
  } finally {
    if (!options.pool) await pool.end();
  }
}

async function importSysmlKnowledgeBundle(options = {}) {
  const pool = options.pool || createKnowledgePool(options);
  const bundleDir = path.resolve(String(options.bundleDir || process.env.AI_TEACHER_SYSML_BUNDLE_DIR || ''));
  if (!bundleDir || !fs.existsSync(bundleDir)) throw new Error('A valid SysML knowledge bundle directory is required');
  const bundle = loadAndVerifyBundle(bundleDir);
  // 迁移必须在独占事务连接前完成；小连接池（尤其 max=1）否则会等待第二条连接而死锁。
  await migrateSysmlKnowledgeStore({ pool });
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  try {
    await client.query('begin');
    await assertParentBundleAvailable(client, bundle.manifest);
    const existing = await client.query('select content_hash from knowledge_bundles where bundle_id = $1', [bundle.manifest.bundleId]);
    if (existing.rows[0]) {
      if (existing.rows[0].content_hash !== bundle.manifest.contentHash) {
        throw new Error(`Immutable bundle ID collision: ${bundle.manifest.bundleId}`);
      }
      await client.query('rollback');
      return { ok: true, imported: false, bundleId: bundle.manifest.bundleId, contentHash: bundle.manifest.contentHash };
    }
    await client.query(`
      insert into knowledge_bundles (
        bundle_id, baseline_id, version, status, manifest, source_registry_hash, content_hash,
        reviewed_at, reviewed_by, review_report_hash
      ) values ($1, $2, $3, 'CANDIDATE', $4::jsonb, $5, $6, $7, $8, $9)
    `, [
      bundle.manifest.bundleId,
      bundle.manifest.baselineId,
      bundle.manifest.version,
      JSON.stringify(bundle.manifest),
      bundle.manifest.sourceRegistry.hash,
      bundle.manifest.contentHash,
      bundle.manifest.review.reviewedAt,
      bundle.manifest.review.reviewedBy,
      bundle.manifest.review.reportHash
    ]);
    await insertBundleRecords(client, bundle);
    const activationReady = isManifestActivationReady(bundle.manifest);
    if (activationReady) {
      await client.query(`update knowledge_bundles set status = 'VALIDATED' where bundle_id = $1`, [bundle.manifest.bundleId]);
    }
    await client.query('commit');
    return {
      ok: true,
      imported: true,
      bundleId: bundle.manifest.bundleId,
      contentHash: bundle.manifest.contentHash,
      status: activationReady ? 'VALIDATED' : 'CANDIDATE',
      activationReady
    };
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally {
    if (client !== pool && typeof client.release === 'function') client.release();
    if (!options.pool) await pool.end();
  }
}

async function activateSysmlKnowledgeBundle(options = {}) {
  const pool = options.pool || createKnowledgePool(options);
  const bundleId = String(options.bundleId || '').trim();
  if (!bundleId) throw new Error('bundleId is required');
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  try {
    await client.query('begin');
    const targetResult = await client.query(`select * from knowledge_bundles where bundle_id = $1 for update`, [bundleId]);
    const target = targetResult.rows[0];
    if (!target) throw new Error(`Knowledge bundle not found: ${bundleId}`);
    if (!['VALIDATED', 'RETIRED', 'ACTIVE'].includes(target.status)) throw new Error(`Knowledge bundle is not activatable: ${target.status}`);
    assertManifestActivationReady(target.manifest);
    await assertParentBundleAvailable(client, target.manifest);
    const unreviewedRelations = await client.query(`
      select count(*)::int as count
      from knowledge_relations
      where bundle_id = $1 and review_status not in ('reviewed', 'derived')
    `, [bundleId]);
    if (Number(unreviewedRelations.rows[0]?.count || 0) > 0) {
      throw new Error(`Knowledge bundle contains unreviewed relations: ${bundleId}`);
    }
    if (target.status !== 'ACTIVE') {
      await client.query(`
        update knowledge_bundles
        set status = 'RETIRED'
        where baseline_id = $1 and status = 'ACTIVE' and bundle_id <> $2
      `, [target.baseline_id, bundleId]);
      await client.query(`
        update knowledge_bundles
        set status = 'ACTIVE', activated_at = now()
        where bundle_id = $1
      `, [bundleId]);
    }
    await client.query('commit');
    return { ok: true, bundleId, baselineId: target.baseline_id, contentHash: target.content_hash };
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally {
    if (client !== pool && typeof client.release === 'function') client.release();
    if (!options.pool) await pool.end();
  }
}

async function queryActiveSysmlKnowledge(pool, query, context = {}, options = {}) {
  const rankingMode = resolveKnowledgeRankingMode(options.rankingMode);
  const queryPlan = buildSysmlKnowledgeQueryPlan(query, context, options);
  const requestedLimit = queryPlan.requestedLimit;
  const baselineId = String(options.baselineId || 'sysml-2.0-formal');
  const active = await pool.query(`
    select bundle_id, baseline_id, version, source_registry_hash, content_hash, manifest
    from knowledge_bundles
    where baseline_id = $1 and status = 'ACTIVE'
    limit 1
  `, [baselineId]);
  const bundle = active.rows[0];
  if (!bundle) return emptyQueryResult(queryPlan, baselineId);
  const answerRequiredAstContextIds = occurrenceContexts(queryPlan, queryPlan.answerRequiredOperators);
  const supportingAstContextIds = occurrenceContexts(queryPlan, queryPlan.supportingOperators);
  let knowledgeAnswerRequiredClaimIds = requiredClaimIdsForQuery(
    queryPlan.answerRequiredOperators,
    answerRequiredAstContextIds
  );
  let knowledgeSupportingClaimIds = supportingClaimIdsForQuery(
    queryPlan.supportingOperators,
    supportingAstContextIds
  ).filter((claimId) => !knowledgeAnswerRequiredClaimIds.includes(claimId));
  let closureClaimIds = [...knowledgeAnswerRequiredClaimIds, ...knowledgeSupportingClaimIds];
  if (closureClaimIds.length > MAX_LIMIT) {
    throw new Error(`Required Claim closure exceeds the ${MAX_LIMIT}-Claim resource limit`);
  }
  // 模型 limit 只约束闭包之外的候选，不得截断由可信问题/模型上下文推导出的 Claim 闭包。
  let additionalSupportingBudget = Math.min(requestedLimit, MAX_LIMIT - closureClaimIds.length);
  let selectionLimit = closureClaimIds.length + additionalSupportingBudget;
  const operators = uniqueStrings([...queryPlan.answerRequiredOperators, ...queryPlan.supportingOperators]);
  const astContextIds = uniqueStrings([...answerRequiredAstContextIds, ...supportingAstContextIds]);
  const queryText = normalizeSearchText(queryPlan.effectiveQuery);
  const searchTsQuery = buildDisjunctiveSearchTsQuery(queryText);
  const claimsResult = await pool.query(`
    with candidates as (
      select claim_id, claim_type, subject_node_id, predicate, object_node_id, operators,
             ast_context_ids, polarity, modality, authority_level, review_status, claim_text,
             evidence_ids, properties,
             row_number() over (order by
               case when claim_id = any($5::text[]) then 0 else 1 end,
               array_position($5::text[], claim_id) nulls last,
               case when cardinality($2::text[]) > 0 and operators && $2::text[] then 0 else 1 end,
               case when length($4) > 0 then ts_rank_cd(search_vector, to_tsquery('simple', $4)) else 0 end desc,
               claim_id
             ) as candidate_rank
      from normative_claims
      where bundle_id = $1
        and review_status = 'reviewed'
        and authority_level in ('A1', 'A2')
        and (
          claim_id = any($5::text[])
          or
          (
            cardinality($2::text[]) > 0
            and operators && $2::text[]
            and (cardinality($3::text[]) = 0 or ast_context_ids && $3::text[])
          )
          or (
            ($8::boolean or cardinality($2::text[]) = 0)
            and length($4) > 0
            and search_vector @@ to_tsquery('simple', $4)
            and (
              $8::boolean
              or cardinality($3::text[]) = 0
              or ast_context_ids && $3::text[]
            )
          )
        )
    ), diagnostics as (
      select count(*)::int as total_candidate_count,
             coalesce(
               array_agg(claim_id order by candidate_rank)
                 filter (where candidate_rank > $6 and candidate_rank <= $6 + $7),
               array[]::text[]
             ) as excluded_candidate_ids
      from candidates
    )
    select candidates.*, diagnostics.total_candidate_count, diagnostics.excluded_candidate_ids
    from candidates cross join diagnostics
    where candidates.candidate_rank <= $6
    order by candidates.candidate_rank
  `, [
    bundle.bundle_id,
    operators,
    astContextIds,
    searchTsQuery,
    closureClaimIds,
    selectionLimit,
    MAX_LIMIT,
    rankingMode !== 'legacy'
  ]);
  const initialClaims = claimsResult.rows.map(rowToClaim);
  const expectedPatternCount = Number(bundle.manifest?.counts?.knowledgePatterns || 0);
  const patternAware = expectedPatternCount > 0;
  const patternRows = patternAware
    ? await pool.query(`
        select pattern_id, title, description, exam_objective_ids, anchor_node_ids,
               required_claim_ids, required_edge_ids, guardrail_ids, fixture_ids,
               review_status, properties
        from knowledge_patterns
        where bundle_id = $1 and review_status = 'reviewed'
        order by pattern_id
      `, [bundle.bundle_id])
    : { rows: [] };
  const availablePatterns = patternRows.rows.map(rowToKnowledgePattern);
  const candidateMatches = findKnowledgePatternCandidates({
    patterns: availablePatterns,
    // 与渐进检索的默认Anchor窗口一致；宽召回候选不能全部参与Pattern匹配，
    // 否则Definition/Usage等泛词会把低排名的无关知识误识别为回答义务。
    anchorClaims: initialClaims.slice(0, PATTERN_ANCHOR_LIMIT)
  });
  const candidateKnowledgePatterns = candidateMatches.map(({ pattern, matchedAnchorNodeIds, matchedClaimIds }) => ({
    patternId: pattern.patternId,
    title: pattern.title,
    description: pattern.description,
    matchedAnchorNodeIds,
    matchedClaimIds,
    closureDimensions: uniqueStrings(pattern.properties?.closureDimensions || [])
  }));
  const requestedSelectedPatternIds = uniqueStrings(options.selectedPatternIds || []).slice(0, 8);
  const candidateById = new Map(candidateMatches.map((item) => [item.pattern.patternId, item.pattern]));
  const selectablePatterns = requestedSelectedPatternIds.map((patternId) => candidateById.get(patternId)).filter(Boolean);
  const patternSelection = activateSelectedKnowledgePatterns({
    patterns: selectablePatterns,
    existingClosureClaimIds: closureClaimIds,
    resourceLimit: MAX_LIMIT
  });
  const selectedPatterns = patternSelection.patterns;
  const selectedKnowledgePatternIds = selectedPatterns.map((pattern) => pattern.patternId);
  const selectedPatternClosureClaimIds = uniqueStrings(selectedPatterns.flatMap((pattern) => pattern.requiredClaimIds));
  const patternSelectionWarnings = requestedSelectedPatternIds
    .filter((patternId) => !candidateById.has(patternId))
    .map((patternId) => `selected_pattern_not_candidate:${patternId}`);
  const patternClosureGaps = [];
  if (patternAware && availablePatterns.length !== expectedPatternCount) {
    patternSelectionWarnings.push('pattern_catalog_incomplete');
  }
  for (const patternId of patternSelection.resourceLimitedPatternIds) {
    patternSelectionWarnings.push(`pattern_resource_limit:${patternId}`);
  }

  knowledgeSupportingClaimIds = uniqueStrings([
    ...knowledgeSupportingClaimIds,
    ...selectedPatternClosureClaimIds
  ]);
  knowledgeSupportingClaimIds = knowledgeSupportingClaimIds
    .filter((claimId) => !knowledgeAnswerRequiredClaimIds.includes(claimId));
  closureClaimIds = [...knowledgeAnswerRequiredClaimIds, ...knowledgeSupportingClaimIds];
  additionalSupportingBudget = Math.min(requestedLimit, MAX_LIMIT - closureClaimIds.length);
  selectionLimit = closureClaimIds.length + additionalSupportingBudget;

  const initialClaimsById = new Map(initialClaims.map((claim) => [claim.claimId, claim]));
  const missingPatternClaimIds = selectedPatternClosureClaimIds.filter((claimId) => !initialClaimsById.has(claimId));
  const patternClaimsResult = missingPatternClaimIds.length > 0
    ? await pool.query(`
        select claim_id, claim_type, subject_node_id, predicate, object_node_id, operators,
               ast_context_ids, polarity, modality, authority_level, review_status, claim_text,
               evidence_ids, properties
        from normative_claims
        where bundle_id = $1 and claim_id = any($2::text[])
          and review_status = 'reviewed' and authority_level in ('A1', 'A2')
        order by array_position($2::text[], claim_id)
      `, [bundle.bundle_id, missingPatternClaimIds])
    : { rows: [] };
  for (const claim of patternClaimsResult.rows.map(rowToClaim)) initialClaimsById.set(claim.claimId, claim);

  const roleByClaimId = new Map([
    ...knowledgeAnswerRequiredClaimIds.map((claimId) => [claimId, 'required']),
    ...knowledgeSupportingClaimIds.map((claimId) => [claimId, 'supporting'])
  ]);
  const closureClaims = closureClaimIds
    .map((claimId) => initialClaimsById.get(claimId))
    .filter(Boolean);
  const additionalClaims = initialClaims
    .filter((claim) => !roleByClaimId.has(claim.claimId))
    .slice(0, additionalSupportingBudget);
  const legacyClaims = [...closureClaims, ...additionalClaims].map((claim) => ({
    ...claim,
    selectionRole: roleByClaimId.get(claim.claimId) || 'additional_supporting'
  }));
  const returnedClaimIds = new Set(legacyClaims.map((claim) => claim.claimId));
  const missingClosureClaimIds = closureClaimIds.filter((claimId) => !returnedClaimIds.has(claimId));
  const totalCandidateCount = Number(claimsResult.rows[0]?.total_candidate_count ?? initialClaims.length);
  const excludedCandidates = {
    count: Math.max(0, totalCandidateCount - legacyClaims.length),
    claimIds: (claimsResult.rows[0]?.excluded_candidate_ids || [])
      .map((claimId) => String(claimId))
      .filter((claimId) => claimId && !returnedClaimIds.has(claimId))
  };
  const evidenceIds = [...new Set(legacyClaims.flatMap((claim) => claim.evidenceIds))];
  const evidenceResult = evidenceIds.length
    ? await pool.query(`
        select evidence_id, source_id, section_path, block_type, line_start, line_end, text_content,
               text_hash, authority_level, review_status, operators, concept_ids, ast_context_ids
        from evidence_blocks
        where bundle_id = $1 and evidence_id = any($2::text[])
          and review_status = 'reviewed' and authority_level in ('A1', 'A2')
        order by evidence_id
      `, [bundle.bundle_id, evidenceIds])
    : { rows: [] };
  const mappingsResult = operators.length
    ? await pool.query(`
        select syntax_mapping_id, token, grammar_production_id, ast_context_id, semantic_node_id,
               mapping_type, parser_fixture_id, review_status
        from syntax_mappings
        where bundle_id = $1 and token = any($2::text[]) and review_status = 'reviewed'
        order by token, ast_context_id
      `, [bundle.bundle_id, operators])
    : { rows: [] };
  const requiredPatternEdgeIds = uniqueStrings(selectedPatterns.flatMap((pattern) => pattern.requiredEdgeIds));
  const edgesResult = requiredPatternEdgeIds.length
    ? await pool.query(`
        select edge_id
        from semantic_edges
        where bundle_id = $1 and edge_id = any($2::text[])
          and review_status = 'reviewed'
        order by edge_id
      `, [bundle.bundle_id, requiredPatternEdgeIds])
    : { rows: [] };
  const returnedEdgeIds = new Set(edgesResult.rows.map((row) => String(row.edge_id || '')).filter(Boolean));
  const missingPatternEdgeIds = requiredPatternEdgeIds.filter((edgeId) => !returnedEdgeIds.has(edgeId));
  const requiredPatternGuardrailIds = uniqueStrings(selectedPatterns.flatMap((pattern) => pattern.guardrailIds));
  const overlaysResult = closureClaimIds.length || requiredPatternGuardrailIds.length
    ? await pool.query(`
        select overlays.overlay_id, overlays.overlay_type, overlays.authority_class,
               overlays.description, overlays.pattern_spec, overlays.pattern_hash,
               overlays.counterexample_spec, overlays.review_status, overlays.properties,
               array(
                 select links.claim_id
                 from teaching_overlay_claim_links links
                 where links.bundle_id = overlays.bundle_id and links.overlay_id = overlays.overlay_id
                 order by links.claim_id
               ) as supported_by_claim_ids
        from teaching_overlays overlays
        where overlays.bundle_id = $1
          and overlays.review_status = 'reviewed'
          and (
            overlays.overlay_id = any($3::text[])
            or exists (
              select 1 from teaching_overlay_claim_links links
              where links.bundle_id = overlays.bundle_id
                and links.overlay_id = overlays.overlay_id
                and links.claim_id = any($2::text[])
            )
          )
        order by overlays.overlay_id
      `, [bundle.bundle_id, closureClaimIds, requiredPatternGuardrailIds])
    : { rows: [] };
  const evidenceBlocks = evidenceResult.rows.map(rowToEvidence);
  const ranking = rankKnowledgeClaims({
    mode: rankingMode,
    query: queryPlan.effectiveQuery,
    claims: legacyClaims,
    evidenceBlocks
  });
  const claims = ranking.claims;
  const additionalSupportingClaimIds = claims
    .filter((claim) => claim.selectionRole === 'additional_supporting')
    .map((claim) => claim.claimId);
  const syntaxMappings = mappingsResult.rows.map(rowToSyntaxMapping);
  const closureClaimIdSet = new Set(closureClaimIds);
  const guardrails = overlaysResult.rows
    .map(rowToGuardrail)
    .filter((guardrail) => guardrail.supportedByClaimIds.every((claimId) => closureClaimIdSet.has(claimId)));
  const returnedGuardrailIds = new Set(guardrails.map((guardrail) => guardrail.guardrailId));
  const missingPatternGuardrailIds = requiredPatternGuardrailIds
    .filter((guardrailId) => !returnedGuardrailIds.has(guardrailId));
  const returnedEvidenceIds = new Set(evidenceBlocks.map((item) => item.evidenceId));
  const claimsHaveEvidence = claims.every((claim) =>
    claim.evidenceIds.length > 0 && claim.evidenceIds.every((evidenceId) => returnedEvidenceIds.has(evidenceId))
  );
  const missingEvidenceClaimIds = claims
    .filter((claim) => closureClaimIdSet.has(claim.claimId))
    .filter((claim) => claim.evidenceIds.length === 0
      || claim.evidenceIds.some((evidenceId) => !returnedEvidenceIds.has(evidenceId)))
    .map((claim) => claim.claimId);
  const coveredOperators = new Set(claims.flatMap((claim) => claim.operators));
  const operatorsCovered = operators.every((operator) => coveredOperators.has(operator));
  for (const claimId of missingClosureClaimIds) patternClosureGaps.push(`missing_claim:${claimId}`);
  for (const edgeId of missingPatternEdgeIds) patternClosureGaps.push(`missing_edge:${edgeId}`);
  for (const guardrailId of missingPatternGuardrailIds) patternClosureGaps.push(`missing_guardrail:${guardrailId}`);
  for (const claimId of missingEvidenceClaimIds) patternClosureGaps.push(`missing_evidence:${claimId}`);
  const closureGaps = uniqueStrings(patternClosureGaps);
  const closureRequirement = closureClaimIds.length > 0 || closureGaps.length > 0 ? 'required' : 'not_applicable';
  const closureStatus = closureRequirement === 'not_applicable'
    ? 'not_applicable'
    : closureGaps.length === 0 ? 'complete' : 'incomplete';
  const coverage = claims.length === 0
    ? 'NONE'
    : claimsHaveEvidence && operatorsCovered && closureGaps.length === 0 ? 'COMPLETE' : 'PARTIAL';
  const result = {
    coverage,
    bundleId: bundle.bundle_id,
    baselineId: bundle.baseline_id,
    bundleVersion: bundle.version,
    sourceRegistryHash: bundle.source_registry_hash,
    bundleContentHash: bundle.content_hash,
    requestedQuery: queryPlan.requestedQuery,
    effectiveQuery: queryPlan.effectiveQuery,
    requestedQueryHash: queryPlan.requestedQueryHash,
    effectiveQueryHash: queryPlan.effectiveQueryHash,
    closureProfileId: queryPlan.closureProfileId,
    closureProfileHash: queryPlan.closureProfileHash,
    closureRequirement,
    closureStatus,
    intentMode: queryPlan.intentMode,
    operatorOccurrences: queryPlan.operatorOccurrences,
    queryExpansion: queryPlan.queryExpansion,
    candidateKnowledgePatterns,
    selectedKnowledgePatternIds,
    selectedPatternClosureClaimIds,
    patternSelectionWarnings: uniqueStrings(patternSelectionWarnings),
    closureGaps,
    closureClaimIds,
    knowledgeAnswerRequiredClaimIds,
    knowledgeSupportingClaimIds,
    mandatorySupportingCount: knowledgeSupportingClaimIds.length,
    additionalSupportingClaimIds,
    missingClosureClaimIds,
    requestedLimit,
    additionalSupportingBudget,
    selectionLimit,
    returnedClaimCount: claims.length,
    resourceLimit: MAX_LIMIT,
    claims,
    evidenceBlocks,
    syntaxMappings,
    guardrails,
    conflicts: [],
    excludedCandidates,
    ...(ranking.audit.mode === 'legacy' ? {} : { ranking: ranking.audit })
  };
  return { ...result, resultHash: hashText(canonicalJson(result)) };
}

function sysmlKnowledgeResultToHits(result) {
  if (!result || result.coverage === 'NONE') return [];
  const evidenceById = new Map((result.evidenceBlocks || []).map((evidence) => [evidence.evidenceId, evidence]));
  return (result.claims || []).map((claim, index) => {
    const evidence = claim.evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean);
    const excerpt = [claim.claimText, ...evidence.slice(0, 2).map((item) => `${item.sectionPath}: ${item.textContent}`)].join('\n\n');
    return {
      card: {
        id: claim.claimId,
        title: claimTitle(claim),
        summary: claim.claimText,
        content: excerpt,
        keywords: [...claim.operators, ...claim.astContextIds],
        concepts: [claim.subjectNodeId, claim.objectNodeId].filter(Boolean),
        tags: ['sysml-knowledge-graph', 'normative-claim'],
        sourceType: 'sysml_authoritative_bundle',
        sourceTitle: 'OMG SysML v2.0 Part 1 evidence-bound claim',
        sourceUrl: '',
        sourceVersion: result.bundleVersion,
        authorityLevel: claim.authorityLevel,
        reviewStatus: 'reviewed',
        scope: {},
        metadata: {
          bundleId: result.bundleId,
          baselineId: result.baselineId,
          sourceRegistryHash: result.sourceRegistryHash,
          bundleContentHash: result.bundleContentHash,
          requestedQueryHash: result.requestedQueryHash,
          effectiveQueryHash: result.effectiveQueryHash,
          closureProfileId: result.closureProfileId,
          closureProfileHash: result.closureProfileHash,
          resultHash: result.resultHash,
          evidenceIds: claim.evidenceIds,
          evidenceHashes: evidence.map((item) => item.textHash),
          operators: claim.operators,
          astContextIds: claim.astContextIds,
          coverage: result.coverage,
          selectionRole: claim.selectionRole
        },
        priority: 100 - index,
        filePath: ''
      },
      score: 100 - index,
      matchedTerms: [...claim.operators, ...claim.astContextIds],
      graph: result
    };
  });
}

async function insertBundleRecords(client, bundle) {
  const nodesById = new Map(bundle.records['nodes.jsonl'].map((node) => [node.nodeId, node]));
  for (const source of bundle.records['source-documents.jsonl']) {
    await client.query(`
      insert into source_documents (
        source_id, bundle_id, source_type, authority_level, document_name, document_version,
        omg_file_id, repository_commit, artifact_hash, metadata
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    `, [source.sourceId, bundle.manifest.bundleId, source.sourceType, source.authorityLevel, source.documentName,
      source.documentVersion, source.omgFileId, source.repositoryCommit, source.artifactHash, JSON.stringify(source.metadata || {})]);
  }
  for (const node of bundle.records['nodes.jsonl']) {
    await client.query(`
      insert into semantic_nodes (
        node_id, bundle_id, baseline_id, node_kind, name, qualified_name, source_id,
        source_locator, properties, status
      ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
    `, [node.nodeId, bundle.manifest.bundleId, node.baselineId, node.nodeKind, node.name, node.qualifiedName || null,
      node.sourceId || null, JSON.stringify(node.sourceLocator || null), JSON.stringify(node.properties || {}), node.status || 'ACTIVE']);
  }
  for (const edge of bundle.records['edges.jsonl']) {
    await client.query(`
      insert into semantic_edges (
        edge_id, bundle_id, baseline_id, source_node_id, predicate, target_node_id,
        authority_level, source_id, source_locator, review_status, properties
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb)
    `, [edge.edgeId, bundle.manifest.bundleId, edge.baselineId, edge.sourceNodeId, edge.predicate, edge.targetNodeId,
      edge.authorityLevel, edge.sourceId || null, JSON.stringify(edge.sourceLocator || null), edge.reviewStatus,
      JSON.stringify(edge.properties || {})]);
  }
  for (const claim of bundle.records['claims.jsonl']) {
    const searchText = buildClaimSearchText(claim, nodesById);
    await client.query(`
      insert into normative_claims (
        claim_id, bundle_id, baseline_id, claim_type, subject_node_id, predicate, object_node_id,
        operators, syntax_context_ids, ast_context_ids, polarity, modality, authority_level,
        review_status, claim_text, evidence_ids, properties, search_vector
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,
        setweight(to_tsvector('simple', $15), 'A')
        || setweight(to_tsvector('simple', array_to_string($8::text[], ' ')), 'A')
        || setweight(to_tsvector('simple', $18), 'B'))
    `, [claim.claimId, bundle.manifest.bundleId, claim.baselineId, claim.claimType, claim.subjectNodeId || null,
      claim.predicate, claim.objectNodeId || null, claim.operators || [], claim.syntaxContextIds || [], claim.astContextIds || [],
      claim.polarity, claim.modality, claim.authorityLevel, claim.reviewStatus, claim.claimText, claim.evidenceIds || [],
      JSON.stringify(claim.properties || {}), searchText]);
  }
  for (const evidence of bundle.records['evidence-blocks.jsonl']) {
    await client.query(`
      insert into evidence_blocks (
        evidence_id, bundle_id, baseline_id, source_id, section_path, block_type, line_start,
        line_end, text_content, text_hash, authority_level, review_status, operators,
        concept_ids, ast_context_ids, search_vector
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
        setweight(to_tsvector('simple', $9), 'B') || setweight(to_tsvector('simple', array_to_string($13::text[], ' ')), 'A'))
    `, [evidence.evidenceId, bundle.manifest.bundleId, evidence.baselineId, evidence.sourceId, evidence.sectionPath,
      evidence.blockType, evidence.lineStart || null, evidence.lineEnd || null, evidence.textContent, evidence.textHash,
      evidence.authorityLevel, evidence.reviewStatus, evidence.operators || [], evidence.conceptIds || [], evidence.astContextIds || []]);
  }
  for (const link of bundle.records['evidence-links.jsonl']) {
    await client.query(`
      insert into evidence_links (
        evidence_link_id, bundle_id, evidence_id, target_type, target_id, relation_type,
        link_method, confidence, review_status
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [link.evidenceLinkId, bundle.manifest.bundleId, link.evidenceId, link.targetType, link.targetId,
      link.relationType, link.linkMethod, link.confidence, link.reviewStatus]);
  }
  for (const mapping of bundle.records['syntax-mappings.jsonl']) {
    await client.query(`
      insert into syntax_mappings (
        syntax_mapping_id, bundle_id, baseline_id, token, grammar_production_id, ast_context_id,
        semantic_node_id, mapping_type, parser_fixture_id, review_status
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [mapping.syntaxMappingId, bundle.manifest.bundleId, mapping.baselineId, mapping.token,
      mapping.grammarProductionId || null, mapping.astContextId || null, mapping.semanticNodeId || null,
      mapping.mappingType, mapping.parserFixtureId || null, mapping.reviewStatus]);
  }
  for (const overlay of bundle.records['teaching-overlays.jsonl']) {
    const expectedPatternHash = hashText(canonicalJson(overlay.patternSpec));
    if (overlay.patternHash !== expectedPatternHash) {
      throw new Error(`Teaching overlay pattern hash mismatch: ${overlay.overlayId}`);
    }
    await client.query(`
      insert into teaching_overlays (
        bundle_id, overlay_id, overlay_type, authority_class, description, pattern_spec,
        pattern_hash, counterexample_spec, review_status, properties
      ) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10::jsonb)
    `, [bundle.manifest.bundleId, overlay.overlayId, overlay.overlayType, overlay.authorityClass,
      overlay.description, JSON.stringify(overlay.patternSpec), overlay.patternHash,
      JSON.stringify(overlay.counterexampleSpec || {}), overlay.reviewStatus, JSON.stringify(overlay.properties || {})]);
    for (const claimId of overlay.supportedByClaimIds || []) {
      await client.query(`
        insert into teaching_overlay_claim_links (bundle_id, overlay_id, claim_id)
        values ($1,$2,$3)
      `, [bundle.manifest.bundleId, overlay.overlayId, claimId]);
    }
  }
  for (const pattern of bundle.records['knowledge-patterns.jsonl'] || []) {
    await client.query(`
      insert into knowledge_patterns (
        bundle_id, pattern_id, title, description, exam_objective_ids, anchor_node_ids,
        required_claim_ids, required_edge_ids, guardrail_ids, fixture_ids, review_status, properties
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
    `, [bundle.manifest.bundleId, pattern.patternId, pattern.title, pattern.description,
      pattern.examObjectiveIds, pattern.anchorNodeIds, pattern.requiredClaimIds, pattern.requiredEdgeIds,
      pattern.guardrailIds, pattern.fixtureIds, pattern.reviewStatus, JSON.stringify(pattern.properties || {})]);
  }
  const derivedRelations = deriveKnowledgeRelations(bundle.records);
  const explicitRelations = bundle.records['knowledge-relations.jsonl'] || [];
  validateKnowledgeRelationSet([...derivedRelations, ...explicitRelations], bundle.records);
  for (const relation of [...derivedRelations, ...explicitRelations]) {
    await insertKnowledgeRelation(client, relation, bundle.manifest.bundleId);
  }
}

async function insertKnowledgeRelation(client, relation, bundleId, options = {}) {
  const values = relationRow(relation, bundleId);
  await client.query(`
    insert into knowledge_relations (
      relation_id, bundle_id, relation_hash, relation_layer, predicate, source_kind,
      source_id, target_kind, target_id, authority_level, review_status, conditions,
      evidence_ids, fixture_ids, basis_claim_ids, provenance, properties
    ) values (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb
    )
    ${options.ignoreConflict ? 'on conflict (bundle_id, relation_id) do nothing' : ''}
  `, values);
}

async function backfillDerivedKnowledgeRelations(pool) {
  const bundles = await pool.query('select bundle_id from knowledge_bundles order by bundle_id');
  for (const bundle of bundles.rows || []) {
    const edgesResult = await pool.query(`
      select edge_id, source_node_id, predicate, target_node_id, authority_level,
             source_id, source_locator, review_status, properties
      from semantic_edges where bundle_id = $1 order by edge_id
    `, [bundle.bundle_id]);
    const claimsResult = await pool.query(`
      select claim_id, subject_node_id, object_node_id, operators, ast_context_ids,
             authority_level, evidence_ids, properties
      from normative_claims where bundle_id = $1 order by claim_id
    `, [bundle.bundle_id]);
    const records = {
      edges: (edgesResult.rows || []).map((row) => ({
        edgeId: row.edge_id,
        sourceNodeId: row.source_node_id,
        predicate: row.predicate,
        targetNodeId: row.target_node_id,
        authorityLevel: row.authority_level,
        sourceId: row.source_id,
        sourceLocator: row.source_locator,
        reviewStatus: row.review_status,
        properties: row.properties
      })),
      claims: (claimsResult.rows || []).map((row) => ({
        claimId: row.claim_id,
        subjectNodeId: row.subject_node_id,
        objectNodeId: row.object_node_id,
        operators: row.operators,
        astContextIds: row.ast_context_ids,
        authorityLevel: row.authority_level,
        evidenceIds: row.evidence_ids,
        properties: row.properties
      }))
    };
    for (const relation of deriveKnowledgeRelations(records)) {
      await insertKnowledgeRelation(pool, relation, bundle.bundle_id, { ignoreConflict: true });
    }
  }
}

function buildClaimSearchText(claim, nodesById) {
  const subject = nodesById.get(claim.subjectNodeId);
  const object = nodesById.get(claim.objectNodeId);
  return uniqueStrings([
    claim.subjectNodeId,
    claim.objectNodeId,
    claim.predicate,
    subject?.name,
    subject?.qualifiedName,
    object?.name,
    object?.qualifiedName,
    ...(claim.properties?.searchTerms || [])
  ]).join(' ');
}

function loadAndVerifyBundle(bundleDir) {
  const manifestPath = path.join(bundleDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assertManifestCandidateReady(manifest);
  const records = {};
  for (const fileName of BUNDLE_ARTIFACTS) {
    const filePath = path.join(bundleDir, fileName);
    const expectedHash = manifest.artifactHashes?.[fileName];
    if (!expectedHash || hashFile(filePath) !== expectedHash) throw new Error(`Bundle artifact hash mismatch: ${fileName}`);
    records[fileName] = fileName.endsWith('.jsonl')
      ? readJsonLines(filePath)
      : [JSON.parse(fs.readFileSync(filePath, 'utf8'))];
  }
  for (const fileName of OPTIONAL_BUNDLE_ARTIFACTS) {
    const expectedHash = manifest.artifactHashes?.[fileName];
    if (!expectedHash) continue;
    const filePath = path.join(bundleDir, fileName);
    if (hashFile(filePath) !== expectedHash) throw new Error(`Bundle artifact hash mismatch: ${fileName}`);
    records[fileName] = readJsonLines(filePath);
  }
  if (manifest.counts?.knowledgeRelations !== undefined && !records['knowledge-relations.jsonl']) {
    throw new Error('Bundle knowledgeRelations count requires a hashed knowledge-relations.jsonl artifact');
  }
  if (manifest.counts?.knowledgePatterns !== undefined && !records['knowledge-patterns.jsonl']) {
    throw new Error('Bundle knowledgePatterns count requires a hashed knowledge-patterns.jsonl artifact');
  }
  for (const [countName, fileName] of [
    ['productionResponsibilities', 'production-responsibilities.jsonl'],
    ['capabilityUnits', 'capability-units.jsonl'],
    ['modelUserObjectives', 'model-user-objectives.jsonl']
  ]) {
    if (manifest.counts?.[countName] !== undefined && !records[fileName]) {
      throw new Error(`Bundle ${countName} count requires a hashed ${fileName} artifact`);
    }
  }
  const sourceRegistryPath = path.resolve(process.cwd(), manifest.sourceRegistry.path);
  const authoringPath = path.resolve(process.cwd(), manifest.authoring.path);
  if (!fs.existsSync(sourceRegistryPath) || hashFile(sourceRegistryPath) !== manifest.sourceRegistry.hash) {
    throw new Error('Bundle source registry hash mismatch');
  }
  if (!fs.existsSync(authoringPath) || hashFile(authoringPath) !== manifest.authoring.hash) {
    throw new Error('Bundle authoring hash mismatch');
  }
  const sourceRegistry = JSON.parse(fs.readFileSync(sourceRegistryPath, 'utf8'));
  const authoring = JSON.parse(fs.readFileSync(authoringPath, 'utf8'));
  assertManifestMatchesLockedInputs(manifest, sourceRegistry, authoring);
  const computedContentHash = hashText(canonicalJson({
    artifactHashes: manifest.artifactHashes,
    sourceManifestHash: manifest.sourceRegistry.hash,
    authoringHash: manifest.authoring.hash
  }));
  if (computedContentHash !== manifest.contentHash) {
    throw new Error('Bundle content hash mismatch');
  }
  assertRecordCounts(manifest.counts, records);
  const claimIds = new Set(records['claims.jsonl'].map((claim) => claim.claimId));
  for (const overlay of records['teaching-overlays.jsonl']) {
    if (overlay.authorityClass !== 'engineering_guardrail'
      || overlay.patternHash !== hashText(canonicalJson(overlay.patternSpec || []))) {
      throw new Error(`Bundle teaching overlay is invalid: ${overlay.overlayId || ''}`);
    }
    if (!(overlay.supportedByClaimIds || []).every((claimId) => claimIds.has(claimId))) {
      throw new Error(`Bundle teaching overlay has an unknown Claim link: ${overlay.overlayId || ''}`);
    }
  }
  if (records['knowledge-relations.jsonl']) {
    const relationContext = {
      diagnosticConceptIds: authoring.knowledgeRelationContext?.diagnosticConceptIds || [],
      repairOverlayIds: authoring.knowledgeRelationContext?.repairOverlayIds || [],
      fixtureIds: authoring.knowledgeRelationContext?.fixtureIds || []
    };
    const artifactRelations = materializeReviewedKnowledgeRelations(
      records['knowledge-relations.jsonl'],
      records,
      relationContext
    );
    const authoringRelations = materializeReviewedKnowledgeRelations(
      authoring.knowledgeRelations || [],
      records,
      relationContext
    );
    if (canonicalJson(artifactRelations) !== canonicalJson(authoringRelations)) {
      throw new Error('Bundle knowledge relation artifact does not match locked authoring');
    }
    records['knowledge-relations.jsonl'] = artifactRelations;
  } else if (Array.isArray(authoring.knowledgeRelations)) {
    throw new Error('Locked authoring knowledgeRelations requires a hashed Bundle artifact');
  }
  if (records['knowledge-patterns.jsonl']) {
    const artifactPatterns = materializeReviewedKnowledgePatterns(
      records['knowledge-patterns.jsonl'],
      records
    );
    const authoringPatterns = materializeReviewedKnowledgePatterns(
      authoring.knowledgePatterns || [],
      records
    );
    if (canonicalJson(artifactPatterns) !== canonicalJson(authoringPatterns)) {
      throw new Error('Bundle knowledge pattern artifact does not match locked authoring');
    }
    records['knowledge-patterns.jsonl'] = artifactPatterns;
  } else if (Array.isArray(authoring.knowledgePatterns)) {
    throw new Error('Locked authoring knowledgePatterns requires a hashed Bundle artifact');
  }
  assertProductionKnowledgeArtifactsMatchAuthoring({ records, authoring });
  assertLanguageGovernanceAttestation({ manifest, records, sourceRegistry, authoring });
  assertKnowledgePatternGovernanceAttestation({ manifest, records, sourceRegistry, authoring });
  assertProductionKnowledgeGovernanceAttestation({ manifest, records, sourceRegistry, authoring });
  return { manifest, records };
}

function assertLanguageGovernanceAttestation({ manifest, records, sourceRegistry, authoring }) {
  const contract = authoring?.languageGovernance;
  if (!contract) {
    if (manifest.languageGovernance) {
      throw new Error('Bundle language governance is not required by locked authoring');
    }
    return;
  }
  if (contract.required !== true || contract.evaluatorId !== LANGUAGE_GOVERNANCE_EVALUATOR_ID) {
    throw new Error('Locked authoring language governance contract is invalid');
  }
  const requiredGates = uniqueStrings(contract.requiredGates || []);
  if (requiredGates.length === 0 || requiredGates.length !== (contract.requiredGates || []).length) {
    throw new Error('Locked authoring language governance gates are invalid');
  }
  const governance = manifest.languageGovernance;
  if (!governance
    || governance.evaluatorId !== contract.evaluatorId
    || canonicalJson(governance.requiredGates || {}) !== canonicalJson(contract.requiredGates)
    || governance.status !== 'PASS') {
    throw new Error('Bundle language governance attestation is missing or invalid');
  }
  for (const gateName of requiredGates) {
    if (manifest.gates?.[gateName] !== 'PASS') {
      throw new Error(`Bundle required language gate ${gateName} did not pass`);
    }
  }

  const pathKeys = ['inventory', 'scopeManifest', 'fixtureCatalog', 'validatorReport', 'coverageReport'];
  if (canonicalJson(governance.paths || {}) !== canonicalJson(contract.paths || {})) {
    throw new Error('Bundle language governance paths do not match locked authoring');
  }
  const lockedSourcesByPath = new Map();
  for (const source of sourceRegistry.sources || []) {
    const sourcePath = normalizeLockedRelativePath(source?.path);
    if (!sourcePath || lockedSourcesByPath.has(sourcePath)) continue;
    lockedSourcesByPath.set(sourcePath, source);
  }
  const assets = {};
  const artifactHashes = {};
  for (const pathKey of pathKeys) {
    const relativePath = contract.paths?.[pathKey];
    const filePath = resolveLockedProjectPath(relativePath, `language governance ${pathKey}`);
    if (!fs.existsSync(filePath)) throw new Error(`Bundle language governance asset is missing: ${pathKey}`);
    const artifactHash = hashFile(filePath);
    const source = lockedSourcesByPath.get(normalizeLockedRelativePath(relativePath));
    if (!source || source.artifactHash !== artifactHash) {
      throw new Error(`Bundle language governance asset is not source-locked: ${pathKey}`);
    }
    assets[pathKey] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    artifactHashes[pathKey] = artifactHash;
  }

  const expectedHashFields = {
    inventory: ['inventoryArtifact', 'languageInventoryArtifactHash'],
    scopeManifest: ['scopeManifest', 'scopeManifestHash'],
    fixtureCatalog: ['fixtureCatalog', 'fixtureCatalogHash'],
    validatorReport: ['validatorReport', 'validatorReportHash'],
    coverageReport: ['coverageReport', 'coverageReportHash']
  };
  for (const [pathKey, [governanceHashKey, manifestHashKey]] of Object.entries(expectedHashFields)) {
    if (governance.hashes?.[governanceHashKey] !== artifactHashes[pathKey]
      || manifest[manifestHashKey] !== artifactHashes[pathKey]) {
      throw new Error(`Bundle language governance hash mismatch: ${pathKey}`);
    }
  }
  if (assets.inventory.contentHash !== governance.hashes?.inventoryContent
    || assets.inventory.contentHash !== manifest.languageInventoryHash) {
    throw new Error('Bundle language inventory content hash mismatch');
  }

  const { evaluateLanguageClosure } = require('../../scripts/sysml-knowledge/language-closure');
  const evaluation = evaluateLanguageClosure({
    inventory: assets.inventory,
    scopeManifest: assets.scopeManifest,
    bundle: { records },
    fixtureCatalog: assets.fixtureCatalog,
    validatorReport: assets.validatorReport
  });
  if (evaluation.status !== 'PASS') {
    throw new Error('Bundle language governance runtime evaluation failed');
  }
  if (evaluation.resultHash !== governance.resultHash
    || evaluation.resultHash !== assets.coverageReport.resultHash) {
    throw new Error('Bundle language governance result hash mismatch');
  }
  for (const gateName of requiredGates) {
    if (evaluation.gates?.[gateName]?.status !== 'PASS'
      || assets.coverageReport.gates?.[gateName]?.status !== 'PASS') {
      throw new Error(`Bundle language governance evaluation gate mismatch: ${gateName}`);
    }
  }
  const expectedCoverageInputs = {
    inventoryHash: assets.inventory.contentHash,
    scopeManifestHash: artifactHashes.scopeManifest,
    fixtureCatalogHash: artifactHashes.fixtureCatalog,
    validatorReportHash: artifactHashes.validatorReport,
    authoringHash: manifest.authoring.hash
  };
  if (canonicalJson(assets.coverageReport.inputs || {}) !== canonicalJson(expectedCoverageInputs)
    || assets.coverageReport.status !== evaluation.status
    || assets.coverageReport.inventoryId !== evaluation.inventoryId
    || assets.coverageReport.scopeId !== evaluation.scopeId
    || assets.coverageReport.fixtureSetId !== evaluation.fixtureSetId
    || assets.coverageReport.validatorRunId !== evaluation.validatorRunId
    || canonicalJson(assets.coverageReport.gates) !== canonicalJson(evaluation.gates)
    || canonicalJson(assets.coverageReport.gaps) !== canonicalJson(evaluation.gaps)
    || canonicalJson(assets.coverageReport.coverageUnits) !== canonicalJson(evaluation.coverageUnits)) {
    throw new Error('Bundle language governance coverage report does not match runtime evaluation');
  }
  const expectedCounts = {
    productions: evaluation.counts.productions,
    lexemes: evaluation.counts.lexemes,
    semanticTypes: evaluation.counts.semanticTypes,
    coveredUnits: evaluation.counts.coveredUnits,
    fixtures: assets.fixtureCatalog.fixtures.length
  };
  if (canonicalJson(governance.counts || {}) !== canonicalJson(expectedCounts)) {
    throw new Error('Bundle language governance counts do not match runtime evaluation');
  }
}

function assertKnowledgePatternGovernanceAttestation({ manifest, records, sourceRegistry, authoring }) {
  const contract = authoring?.knowledgePatternGovernance;
  if (!contract) {
    if (manifest.knowledgePatternGovernance) {
      throw new Error('Bundle knowledge pattern governance is not required by locked authoring');
    }
    return;
  }
  if (contract.required !== true || contract.evaluatorId !== KNOWLEDGE_PATTERN_GOVERNANCE_EVALUATOR_ID) {
    throw new Error('Locked authoring knowledge pattern governance contract is invalid');
  }
  const requiredGates = uniqueStrings(contract.requiredGates || []);
  if (requiredGates.length !== Object.keys(KNOWLEDGE_PATTERN_GATE_MAP).length
    || requiredGates.some((gateName) => !KNOWLEDGE_PATTERN_GATE_MAP[gateName])) {
    throw new Error('Locked authoring knowledge pattern governance gates are invalid');
  }
  const governance = manifest.knowledgePatternGovernance;
  if (!governance
    || governance.evaluatorId !== contract.evaluatorId
    || governance.status !== 'PASS'
    || canonicalJson(governance.requiredGates || []) !== canonicalJson(contract.requiredGates || [])
    || canonicalJson(governance.paths || {}) !== canonicalJson(contract.paths || {})) {
    throw new Error('Bundle knowledge pattern governance attestation is missing or invalid');
  }
  for (const gateName of requiredGates) {
    if (manifest.gates?.[gateName] !== 'PASS') {
      throw new Error(`Bundle required knowledge pattern gate ${gateName} did not pass`);
    }
  }

  const sourceByPath = new Map((sourceRegistry.sources || []).map((source) => [
    normalizeLockedRelativePath(source.path),
    source
  ]));
  const assets = {};
  const hashes = {};
  for (const pathKey of ['outline', 'scope', 'fixtureCatalog', 'coverageReport']) {
    const relativePath = contract.paths?.[pathKey];
    const filePath = resolveLockedProjectPath(relativePath, `knowledge pattern governance ${pathKey}`);
    if (!fs.existsSync(filePath)) throw new Error(`Bundle knowledge pattern governance asset is missing: ${pathKey}`);
    const artifactHash = hashFile(filePath);
    if (sourceByPath.get(normalizeLockedRelativePath(relativePath))?.artifactHash !== artifactHash) {
      throw new Error(`Bundle knowledge pattern governance asset is not source-locked: ${pathKey}`);
    }
    assets[pathKey] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    hashes[pathKey] = artifactHash;
  }
  if (canonicalJson(governance.hashes || {}) !== canonicalJson({
    outline: hashes.outline,
    scope: hashes.scope,
    fixtureCatalog: hashes.fixtureCatalog,
    coverageReport: hashes.coverageReport
  })) {
    throw new Error('Bundle knowledge pattern governance hash mismatch');
  }

  const { evaluateKnowledgePatternClosure } = require('../../scripts/sysml-knowledge/knowledge-pattern-closure');
  const evaluation = evaluateKnowledgePatternClosure({
    outline: assets.outline,
    scope: assets.scope,
    bundle: { records },
    fixtureCatalog: assets.fixtureCatalog,
    sourceManifest: sourceRegistry
  });
  if (evaluation.status !== 'PASS' || evaluation.resultHash !== governance.resultHash) {
    throw new Error('Bundle knowledge pattern governance runtime evaluation failed');
  }
  for (const [manifestGate, evaluationGate] of Object.entries(KNOWLEDGE_PATTERN_GATE_MAP)) {
    if (evaluation.gates?.[evaluationGate]?.status !== 'PASS'
      || assets.coverageReport.gates?.[evaluationGate]?.status !== 'PASS') {
      throw new Error(`Bundle knowledge pattern governance evaluation gate mismatch: ${manifestGate}`);
    }
  }
  const expectedInputs = {
    outlineHash: hashes.outline,
    scopeHash: hashes.scope,
    fixtureCatalogHash: hashes.fixtureCatalog,
    authoringHash: manifest.authoring.hash
  };
  if (canonicalJson(assets.coverageReport.inputs || {}) !== canonicalJson(expectedInputs)
    || assets.coverageReport.status !== evaluation.status
    || assets.coverageReport.resultHash !== evaluation.resultHash
    || canonicalJson(assets.coverageReport.counts || {}) !== canonicalJson(evaluation.counts)
    || canonicalJson(governance.counts || {}) !== canonicalJson(evaluation.counts)) {
    throw new Error('Bundle knowledge pattern governance coverage report does not match runtime evaluation');
  }
}

function assertProductionKnowledgeArtifactsMatchAuthoring({ records, authoring }) {
  const bindings = [
    ['production-responsibilities.jsonl', 'productionResponsibilities'],
    ['capability-units.jsonl', 'capabilityUnits'],
    ['model-user-objectives.jsonl', 'modelUserObjectives']
  ];
  const artifactCount = bindings.filter(([fileName]) => Array.isArray(records[fileName])).length;
  const authoringCount = bindings.filter(([, field]) => Array.isArray(authoring[field])).length;
  if (artifactCount === 0 && authoringCount === 0) return;
  if (artifactCount !== bindings.length || authoringCount !== bindings.length) {
    throw new Error('Bundle production knowledge artifacts must be supplied as one complete set');
  }
  for (const [fileName, field] of bindings) {
    if (canonicalJson(records[fileName]) !== canonicalJson(authoring[field])) {
      throw new Error(`Bundle ${fileName} does not match locked authoring`);
    }
  }
}

function assertProductionKnowledgeGovernanceAttestation({ manifest, records, sourceRegistry, authoring }) {
  const contract = authoring?.productionKnowledgeGovernance;
  if (!contract) {
    if (manifest.productionKnowledgeGovernance) {
      throw new Error('Bundle production knowledge governance is not required by locked authoring');
    }
    return;
  }
  if (contract.required !== true
    || contract.evaluatorId !== PRODUCTION_KNOWLEDGE_EVALUATOR_ID
    || contract.capabilityEvaluatorId !== CAPABILITY_CLOSURE_EVALUATOR_ID) {
    throw new Error('Locked authoring production knowledge governance contract is invalid');
  }
  const governance = manifest.productionKnowledgeGovernance;
  if (!governance
    || governance.evaluatorId !== contract.evaluatorId
    || governance.capabilityEvaluatorId !== contract.capabilityEvaluatorId
    || governance.status !== 'PASS'
    || canonicalJson(governance.paths || {}) !== canonicalJson(contract.paths || {})) {
    throw new Error('Bundle production knowledge governance attestation is missing or invalid');
  }
  for (const gateName of PRODUCTION_KNOWLEDGE_GATE_NAMES) {
    if (manifest.gates?.[gateName] !== 'PASS') {
      throw new Error(`Bundle required production knowledge gate ${gateName} did not pass`);
    }
  }

  const sourceByPath = new Map((sourceRegistry.sources || []).map((source) => [
    normalizeLockedRelativePath(source.path),
    source
  ]));
  const pathKeys = [
    'latestInventory',
    'responsibilityManifest',
    'capabilityScope',
    'outline',
    'officialRegistry',
    'bnfCatalog',
    'productionCoverageReport',
    'capabilityCoverageReport',
    'deltaReport'
  ];
  const assets = {};
  const hashes = {};
  for (const pathKey of pathKeys) {
    const relativePath = contract.paths?.[pathKey];
    const filePath = resolveLockedProjectPath(relativePath, `production knowledge governance ${pathKey}`);
    if (!fs.existsSync(filePath)) throw new Error(`Bundle production knowledge governance asset is missing: ${pathKey}`);
    const artifactHash = hashFile(filePath);
    if (sourceByPath.get(normalizeLockedRelativePath(relativePath))?.artifactHash !== artifactHash) {
      throw new Error(`Bundle production knowledge governance asset is not source-locked: ${pathKey}`);
    }
    assets[pathKey] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    hashes[pathKey] = artifactHash;
  }
  if (canonicalJson(governance.hashes || {}) !== canonicalJson(hashes)) {
    throw new Error('Bundle production knowledge governance hash mismatch');
  }
  if (canonicalJson(assets.responsibilityManifest.responsibilities || [])
      !== canonicalJson(records['production-responsibilities.jsonl'] || [])
    || canonicalJson((assets.capabilityScope.capabilityUnits || []).map((item) => ({ ...item, reviewStatus: 'reviewed' })))
      !== canonicalJson(records['capability-units.jsonl'] || [])
    || canonicalJson((assets.capabilityScope.modelUserObjectiveRequirements || []).map((item) => ({ ...item, reviewStatus: 'reviewed' })))
      !== canonicalJson(records['model-user-objectives.jsonl'] || [])) {
    throw new Error('Bundle production knowledge governance assets do not match Bundle records');
  }

  const { evaluateLanguageKnowledgeization } = require('../../scripts/sysml-knowledge/language-knowledgeization-v2');
  const productionEvaluation = evaluateLanguageKnowledgeization({
    inventory: assets.latestInventory,
    responsibilityManifest: assets.responsibilityManifest,
    projection: { records }
  });
  const { evaluateCapabilityClosure } = require('../../scripts/sysml-knowledge/capability-closure-v1');
  const capabilityEvaluation = evaluateCapabilityClosure({
    outline: assets.outline,
    capabilityScope: assets.capabilityScope,
    bundle: { records },
    sourceManifest: sourceRegistry,
    officialSourceCatalog: { ...assets.officialRegistry, bnfCatalog: assets.bnfCatalog },
    productionResponsibilities: assets.responsibilityManifest
  });
  const { validateExactRetrievalBindings } = require('../../scripts/sysml-knowledge/build-model-user-v005');
  const exactRetrieval = validateExactRetrievalBindings(authoring, assets.latestInventory);
  if (productionEvaluation.status !== 'PASS'
    || capabilityEvaluation.status !== 'PASS'
    || exactRetrieval.status !== 'PASS'
    || productionEvaluation.resultHash !== governance.resultHash
    || capabilityEvaluation.resultHash !== governance.capabilityResultHash
    || assets.responsibilityManifest.responsibilitySetHash !== governance.responsibilitySetHash) {
    throw new Error('Bundle production knowledge governance runtime evaluation failed');
  }
  const expectedActivationReadiness = evaluateActivationReadiness({
    productionResponsibilities: records['production-responsibilities.jsonl'],
    capabilityEvaluation
  });
  if (canonicalJson(manifest.activationReadiness || {}) !== canonicalJson(expectedActivationReadiness)) {
    throw new Error('Bundle activation readiness does not match source-locked governance evidence');
  }

  for (const [gateName, result] of [
    ...Object.entries(productionEvaluation.gates),
    ...Object.entries(capabilityEvaluation.gates)
  ]) {
    if (result?.status !== 'PASS' || manifest.gates?.[gateName] !== 'PASS') {
      throw new Error(`Bundle production knowledge governance evaluation gate mismatch: ${gateName}`);
    }
  }
  if (manifest.gates?.exactRetrievalBindingIntegrity !== exactRetrieval.status) {
    throw new Error('Bundle exact retrieval binding gate mismatch');
  }
  if (assets.productionCoverageReport.status !== productionEvaluation.status
    || assets.productionCoverageReport.resultHash !== productionEvaluation.resultHash
    || canonicalJson(assets.productionCoverageReport.gates || {}) !== canonicalJson(productionEvaluation.gates)
    || canonicalJson(assets.productionCoverageReport.counts || {}) !== canonicalJson(productionEvaluation.counts)
    || assets.capabilityCoverageReport.status !== capabilityEvaluation.status
    || assets.capabilityCoverageReport.resultHash !== capabilityEvaluation.resultHash
    || canonicalJson(assets.capabilityCoverageReport.gates || {}) !== canonicalJson(capabilityEvaluation.gates)
    || canonicalJson(assets.capabilityCoverageReport.counts || {}) !== canonicalJson(capabilityEvaluation.counts)) {
    throw new Error('Bundle production knowledge coverage reports do not match runtime evaluation');
  }
  const expectedCounts = {
    ...productionEvaluation.counts,
    capabilityUnits: assets.capabilityScope.capabilityUnits.length,
    completeCapabilities: capabilityEvaluation.counts.completeCapabilities,
    modelUserObjectives: capabilityEvaluation.counts.modelUserObjectives,
    mappedModelUserObjectives: capabilityEvaluation.counts.mappedModelUserObjectives,
    completeModelUserObjectives: capabilityEvaluation.counts.completeModelUserObjectives,
    partialModelUserObjectives: capabilityEvaluation.counts.partialModelUserObjectives,
    exactRetrievalMappings: exactRetrieval.exactMappings,
    syntaxMappingClaimLinks: exactRetrieval.claimBindings
  };
  if (canonicalJson(governance.counts || {}) !== canonicalJson(expectedCounts)) {
    throw new Error('Bundle production knowledge governance counts do not match runtime evaluation');
  }
}

function resolveLockedProjectPath(relativePath, label) {
  if (!String(relativePath || '').trim() || path.isAbsolute(relativePath)) {
    throw new Error(`Bundle ${label} path must be project-relative`);
  }
  const projectRoot = path.resolve(process.cwd());
  const resolved = path.resolve(projectRoot, relativePath);
  if (resolved !== projectRoot && !resolved.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error(`Bundle ${label} path escapes the project root`);
  }
  return resolved;
}

function normalizeLockedRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//u, '');
  return normalized || null;
}

function assertRecordCounts(counts, records) {
  const expected = {
    sourceDocuments: records['source-documents.jsonl'].length,
    nodes: records['nodes.jsonl'].length,
    edges: records['edges.jsonl'].length,
    claims: records['claims.jsonl'].length,
    evidenceBlocks: records['evidence-blocks.jsonl'].length,
    evidenceLinks: records['evidence-links.jsonl'].length,
    syntaxMappings: records['syntax-mappings.jsonl'].length,
    teachingOverlays: records['teaching-overlays.jsonl'].length
  };
  if (records['knowledge-relations.jsonl']) {
    expected.knowledgeRelations = records['knowledge-relations.jsonl'].length;
  }
  if (records['knowledge-patterns.jsonl']) {
    expected.knowledgePatterns = records['knowledge-patterns.jsonl'].length;
  }
  if (records['production-responsibilities.jsonl']) {
    expected.productionResponsibilities = records['production-responsibilities.jsonl'].length;
  }
  if (records['capability-units.jsonl']) {
    expected.capabilityUnits = records['capability-units.jsonl'].length;
  }
  if (records['model-user-objectives.jsonl']) {
    expected.modelUserObjectives = records['model-user-objectives.jsonl'].length;
  }
  for (const [name, count] of Object.entries(expected)) {
    if (Number(counts?.[name]) !== count) throw new Error(`Bundle record count mismatch: ${name}`);
  }
}

function assertManifestCandidateReady(manifest) {
  if (!manifest || manifest.status !== 'CANDIDATE') throw new Error('Bundle manifest must describe an immutable CANDIDATE');
  if (manifest.sourceRegistry?.status !== 'SOURCE_LOCKED') throw new Error('Bundle source registry is not locked');
  if (manifest.review?.status !== 'PASS') throw new Error('Bundle review gate did not pass');
  if (!String(manifest.review?.reviewedBy || '').trim()
    || !Number.isFinite(Date.parse(String(manifest.review?.reviewedAt || '')))
    || !/^sha256:[a-f0-9]{64}$/.test(String(manifest.review?.reportHash || ''))) {
    throw new Error('Bundle review attestation is incomplete');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(manifest.contentHash || ''))) throw new Error('Bundle content hash is invalid');
  if (manifest.parentBundleId) {
    if (manifest.parentBundleId === manifest.bundleId
      || !/^sha256:[a-f0-9]{64}$/.test(String(manifest.parentContentHash || ''))) {
      throw new Error('Bundle parent lineage is invalid');
    }
    if (manifest.teachingOverlaysHash !== manifest.artifactHashes?.['teaching-overlays.jsonl']) {
      throw new Error('Bundle teaching overlay hash is invalid');
    }
  }
  for (const [gate, status] of Object.entries(manifest.gates || {})) {
    if (status !== 'PASS') throw new Error(`Bundle gate ${gate} did not pass`);
  }
}

function assertManifestActivationReady(manifest) {
  assertManifestCandidateReady(manifest);
  if (isManifestActivationReady(manifest)) return;
  const blockerCodes = (manifest.activationReadiness?.blockers || [])
    .map((item) => item?.code)
    .filter(Boolean)
    .join(',');
  throw new Error(`Knowledge bundle activation is blocked: ${blockerCodes || 'ACTIVATION_READINESS_NOT_READY'}`);
}

function isManifestActivationReady(manifest) {
  if (!manifest?.productionKnowledgeGovernance) return true;
  const readiness = manifest.activationReadiness;
  return readiness?.schemaVersion === ACTIVATION_READINESS_SCHEMA_VERSION
    && readiness.status === 'READY'
    && readiness.activationAllowed === true
    && Array.isArray(readiness.blockers)
    && readiness.blockers.length === 0
    && Object.values(readiness.checks || {}).every((check) => check?.status === 'PASS');
}

function assertManifestMatchesLockedInputs(manifest, sourceRegistry, authoring) {
  for (const field of ['bundleId', 'baselineId', 'version']) {
    if (manifest[field] !== authoring[field]) throw new Error(`Bundle manifest ${field} does not match locked authoring`);
  }
  if ((manifest.parentBundleId || null) !== (authoring.parentBundleId || null)
    || (manifest.parentContentHash || null) !== (authoring.parentContentHash || null)) {
    throw new Error('Bundle manifest lineage does not match locked authoring');
  }
  if (manifest.baselineId !== sourceRegistry.baselineId
    || manifest.sourceRegistry.status !== sourceRegistry.sourceLockStatus) {
    throw new Error('Bundle manifest source registry identity mismatch');
  }
  const reviewSource = (sourceRegistry.sources || []).find((source) => source.sourceId === authoring.review?.reviewSourceId);
  if (!reviewSource || reviewSource.sourceType !== 'review_report'
    || manifest.review.reviewedBy !== authoring.review.reviewedBy
    || manifest.review.reviewedAt !== authoring.review.reviewedAt
    || manifest.review.reportHash !== reviewSource.artifactHash) {
    throw new Error('Bundle manifest review attestation does not match locked inputs');
  }
}

async function assertParentBundleAvailable(client, manifest) {
  if (!manifest.parentBundleId) return;
  const parent = await client.query(`
    select baseline_id, content_hash
    from knowledge_bundles
    where bundle_id = $1
  `, [manifest.parentBundleId]);
  const row = parent.rows[0];
  if (!row || row.baseline_id !== manifest.baselineId || row.content_hash !== manifest.parentContentHash) {
    throw new Error(`Knowledge Bundle parent is missing or hash-mismatched: ${manifest.parentBundleId}`);
  }
}

function readJsonLines(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').trim();
  return text ? text.split(/\r\n|\r|\n/).map((line) => JSON.parse(line)) : [];
}

function extractOperators(value) {
  const text = String(value || '');
  const found = [];
  const multi = ['default :=', 'default =', '::>', ':>>', ':=', ':>', '=>'];
  for (let index = 0; index < text.length;) {
    const operator = multi.find((candidate) => text.startsWith(candidate, index));
    if (operator) {
      found.push(operator);
      index += operator.length;
      continue;
    }
    const current = text[index];
    const previous = text[index - 1] || '';
    const next = text[index + 1] || '';
    if (current === ':' && previous !== ':' && next !== ':' && next !== '/' && next !== '\\') found.push(':');
    if (current === '=' && !['<', '>', '!', '=', ':'].includes(previous) && !['=', '>'].includes(next)) found.push('=');
    index += 1;
  }
  return [...new Set(found)];
}

function inferAstContexts(value) {
  const text = String(value || '');
  const contexts = [];
  const definitionDeclaration = /\b(?:part|item|attribute|port|action|state|requirement)\s+def\b/iu;
  const usageDeclaration = /\busage\b|\b(?:part|item|attribute|port|action|state|requirement)\b(?!\s+def\b)/iu;
  if (usageDeclaration.test(text)) contexts.push('sysml20:Usage');
  if (definitionDeclaration.test(text) || /\bdefinition\b|定义/iu.test(text)) contexts.push('sysml20:Definition');
  if (/\b(?:end|connect|connection)\b/iu.test(text) || text.includes('::>')) contexts.push('sysml20:ConnectionUsage');
  if (usageDeclaration.test(text) || /\b(?:feature|end)\b|特征|用法/iu.test(text)) contexts.push('kerml10:Feature');
  const operators = extractOperators(text);
  if (operators.length > 1) {
    if (operators.includes(':')) contexts.push('sysml20:Usage');
    if (operators.includes(':>')) contexts.push('sysml20:Definition', 'sysml20:Usage', 'kerml10:Feature');
    if (operators.includes(':>>')) contexts.push('sysml20:Usage', 'kerml10:Feature');
    if (operators.includes('::>')) contexts.push('sysml20:ConnectionUsage', 'kerml10:Feature');
  }
  return [...new Set(contexts)];
}

function buildSysmlKnowledgeQueryPlan(query, context = {}, options = {}) {
  const supplied = options.queryPlan && typeof options.queryPlan === 'object' ? options.queryPlan : {};
  if (supplied.closureProfileId && supplied.closureProfileId !== SYSML_ANSWER_CLOSURE_PROFILE_ID) {
    throw new Error(`Unsupported SysML Claim closure profile: ${supplied.closureProfileId}`);
  }
  if (supplied.closureProfileHash && supplied.closureProfileHash !== SYSML_ANSWER_CLOSURE_PROFILE_HASH) {
    throw new Error('SysML Claim closure profile hash mismatch');
  }
  const requestedQuery = String(supplied.requestedQuery ?? query ?? '');
  const requestedLimit = normalizeRequestedLimit(supplied.requestedLimit ?? options.limit);
  const trustedQuestionText = String(context?.question?.text || '');
  const requestedOperators = extractOperators(requestedQuery);
  const trustedQuestionOperators = extractOperators(trustedQuestionText);
  const intentMode = ['compare_operator_semantics', 'explain_occurrence', 'general_semantic_search'].includes(supplied.intentMode)
    ? supplied.intentMode
    : inferIntentMode(trustedQuestionText || requestedQuery);
  const derivedOccurrences = supplied.operatorOccurrences
    ? normalizeOperatorOccurrences(supplied.operatorOccurrences)
    : deriveOperatorOccurrences(requestedQuery, trustedQuestionText, context, intentMode);
  const answerRequiredOperators = uniqueStrings(
    Array.isArray(supplied.answerRequiredOperators)
      ? supplied.answerRequiredOperators
      : trustedQuestionOperators
  );
  for (const token of answerRequiredOperators) {
    if (!derivedOccurrences.some((item) => item.token === token && item.sourceType === 'trusted_question')) {
      throw new Error(`Answer-required SysML operator lacks a trusted-question occurrence: ${token}`);
    }
  }
  const supportingContextOperators = uniqueStrings(derivedOccurrences
    .filter((item) => [
      'trusted_selection',
      'trusted_active_model',
      'current_model'
    ].includes(item.sourceType))
    .map((item) => item.token)
    .filter((token) => !answerRequiredOperators.includes(token)));
  const supportingOperators = uniqueStrings(
    Array.isArray(supplied.supportingOperators) ? supplied.supportingOperators : supportingContextOperators
  ).filter((token) => !answerRequiredOperators.includes(token));
  const addedOperators = uniqueStrings([...answerRequiredOperators, ...supportingOperators])
    .filter((token) => !requestedOperators.includes(token));
  const effectiveQuery = String(supplied.effectiveQuery ?? [requestedQuery, addedOperators.join(' ')]
    .filter((item) => item.trim()).join('\n'));
  const effectiveOperators = extractOperators(effectiveQuery);
  for (const operator of requestedOperators) {
    if (!effectiveOperators.includes(operator)) {
      throw new Error(`Effective SysML knowledge query removed requested operator: ${operator}`);
    }
  }
  const operatorOccurrences = derivedOccurrences;
  for (const token of uniqueStrings([...answerRequiredOperators, ...supportingOperators])) {
    if (!operatorOccurrences.some((item) => item.token === token)) {
      throw new Error(`SysML knowledge query operator lacks a trusted occurrence: ${token}`);
    }
  }
  const expansionSources = uniqueStrings(operatorOccurrences
    .filter((item) => addedOperators.includes(item.token) && item.sourceType !== 'model_request')
    .map((item) => item.sourceType))
    .filter((sourceType) => ['trusted_question', 'trusted_selection', 'trusted_active_model'].includes(sourceType));
  return {
    requestedQuery,
    effectiveQuery,
    requestedQueryHash: hashText(requestedQuery),
    effectiveQueryHash: hashText(effectiveQuery),
    closureProfileId: SYSML_ANSWER_CLOSURE_PROFILE_ID,
    closureProfileHash: SYSML_ANSWER_CLOSURE_PROFILE_HASH,
    intentMode,
    operatorOccurrences,
    queryExpansion: { addedOperators, sources: expansionSources },
    answerRequiredOperators,
    supportingOperators,
    requestedLimit,
    resourceLimit: MAX_LIMIT
  };
}

function normalizeRequestedLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_LIMIT;
  return Math.max(0, Math.min(Math.floor(numeric), MAX_LIMIT));
}

function inferIntentMode(value) {
  const text = String(value || '');
  const operators = extractOperators(text);
  if (operators.length === 0) return 'general_semantic_search';
  return operators.length > 1 || /比较|区别|分别|都(?:是|表示)|compare|difference|versus|\bvs\.?\b/iu.test(text)
    ? 'compare_operator_semantics'
    : 'explain_occurrence';
}

function deriveOperatorOccurrences(requestedQuery, trustedQuestionText, context, intentMode) {
  const occurrences = [];
  if (requestedQuery) {
    occurrences.push(...operatorOccurrencesInText(requestedQuery).map((item) => ({
      sourceType: 'model_request',
      contentHash: hashText(requestedQuery),
      start: item.start,
      end: item.end,
      token: item.token,
      expandedAstContextIds: expandedQuestionContextsForToken(item.token, intentMode, requestedQuery)
    })));
  }
  if (trustedQuestionText) {
    occurrences.push(...operatorOccurrencesInText(trustedQuestionText).map((item) => ({
      sourceType: 'trusted_question',
      contentHash: hashText(trustedQuestionText),
      start: item.start,
      end: item.end,
      token: item.token,
      expandedAstContextIds: expandedQuestionContextsForToken(item.token, intentMode, trustedQuestionText)
    })));
  }
  const selection = trustedSelectionSource(context);
  if (selection) {
    occurrences.push(...operatorOccurrencesInText(selection.text).map((item) => {
      const start = selection.baseOffset + item.start;
      const observedAstContextId = observedAstContextForToken(selection.fileContent, start, item.token);
      const occurrence = {
        sourceType: 'trusted_selection',
        fileId: selection.fileId,
        contentHash: hashText(selection.fileContent),
        start,
        end: start + item.token.length,
        token: item.token,
        expandedAstContextIds: expandedContextsForToken(item.token, intentMode, observedAstContextId)
      };
      if (observedAstContextId) occurrence.observedAstContextId = observedAstContextId;
      return occurrence;
    }));
  }
  const activeModel = trustedActiveModelSource(context, trustedQuestionText, selection);
  if (activeModel) {
    occurrences.push(...operatorOccurrencesInText(activeModel.fileContent).map((item) => {
      const observedAstContextId = observedAstContextForToken(activeModel.fileContent, item.start, item.token);
      const occurrence = {
        sourceType: 'trusted_active_model',
        fileId: activeModel.fileId,
        contentHash: hashText(activeModel.fileContent),
        start: item.start,
        end: item.end,
        token: item.token,
        expandedAstContextIds: expandedContextsForToken(item.token, intentMode, observedAstContextId)
      };
      if (observedAstContextId) occurrence.observedAstContextId = observedAstContextId;
      return occurrence;
    }));
  }
  return deduplicateOccurrences(occurrences);
}

function trustedSelectionSource(context) {
  const editor = context?.editor || {};
  const state = editor.contextState || {};
  if (['stale_document', 'default_context'].includes(String(state.degradedReason || ''))) return null;
  if (state.selectionOrigin === 'last-known') return null;
  const text = String(editor.selection?.text || '');
  if (!text) return null;
  const active = (editor.files || []).find((file) => file.fileId === editor.activeFileId);
  if (!active || typeof active.content !== 'string') return null;
  const declaredStart = Number(editor.selection?.from);
  const baseOffset = Number.isInteger(declaredStart)
    && active.content.slice(declaredStart, declaredStart + text.length) === text
    ? declaredStart
    : active.content.indexOf(text);
  if (baseOffset < 0) return null;
  return { text, baseOffset, fileId: active.fileId, fileContent: active.content };
}

function trustedActiveModelSource(context, trustedQuestionText, selection) {
  const question = String(trustedQuestionText || '');
  const selectionHasOperators = extractOperators(selection?.text || '').length > 0;
  const needsActiveModel = selection
    ? !selectionHasOperators && /截断|完整标识符|完整元素名|truncat|full\s+(?:identifier|name)/iu.test(question)
    : /当前(?:模型|代码)|活动文件|current\s+(?:model|code)|active\s+file/iu.test(question);
  if (!needsActiveModel) return null;
  const editor = context?.editor || {};
  const state = editor.contextState || {};
  if (['stale_document', 'default_context'].includes(String(state.degradedReason || ''))) return null;
  const active = (editor.files || []).find((file) => file.fileId === editor.activeFileId);
  return active && typeof active.content === 'string'
    ? { fileId: active.fileId, fileContent: active.content }
    : null;
}

function normalizeOperatorOccurrences(value) {
  if (!Array.isArray(value)) throw new Error('operatorOccurrences must be an array');
  return deduplicateOccurrences(value.map((item) => {
    const token = String(item?.token || '');
    const start = Number(item?.start);
    const end = Number(item?.end);
    if (!extractOperators(token).includes(token) || !Number.isInteger(start) || !Number.isInteger(end) || end - start !== token.length) {
      throw new Error('Invalid SysML operator occurrence');
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(String(item?.contentHash || ''))) {
      throw new Error('SysML operator occurrence content hash is invalid');
    }
    const normalized = {
      sourceType: String(item.sourceType || ''),
      contentHash: String(item.contentHash),
      start,
      end,
      token,
      expandedAstContextIds: normalizeExpandedAstContextIds(item.expandedAstContextIds || [])
    };
    if (item.fileId) normalized.fileId = String(item.fileId);
    if (item.observedAstContextId != null) normalized.observedAstContextId = String(item.observedAstContextId);
    return normalized;
  }));
}

function normalizeExpandedAstContextIds(values) {
  const aliases = {
    'ast-feature-typing': ['sysml20:Usage'],
    'ast-subclassification': ['sysml20:Definition'],
    'ast-subsetting': ['sysml20:Usage', 'kerml10:Feature'],
    'ast-redefinition': ['sysml20:Usage', 'kerml10:Feature'],
    'ast-reference-subsetting': ['sysml20:ConnectionUsage', 'kerml10:Feature'],
    'ast-fixed-bound-feature-value': ['sysml20:Usage'],
    'ast-initial-feature-value': ['sysml20:Usage'],
    'ast-default-bound-feature-value': ['sysml20:Usage'],
    'ast-default-initial-feature-value': ['sysml20:Usage']
  };
  return uniqueStrings((Array.isArray(values) ? values : []).flatMap((value) => aliases[value] || [value]));
}

function operatorOccurrencesInText(value) {
  const text = String(value || '');
  const occurrences = [];
  const multi = ['default :=', 'default =', '::>', ':>>', ':=', ':>', '=>'];
  for (let index = 0; index < text.length;) {
    const token = multi.find((candidate) => text.startsWith(candidate, index));
    if (token) {
      occurrences.push({ token, start: index, end: index + token.length });
      index += token.length;
      continue;
    }
    const current = text[index];
    const previous = text[index - 1] || '';
    const next = text[index + 1] || '';
    if (current === ':' && previous !== ':' && next !== ':' && next !== '/' && next !== '\\') {
      occurrences.push({ token: ':', start: index, end: index + 1 });
    }
    if (current === '=' && !['<', '>', '!', '=', ':'].includes(previous) && !['=', '>'].includes(next)) {
      occurrences.push({ token: '=', start: index, end: index + 1 });
    }
    index += 1;
  }
  return occurrences;
}

function observedAstContextForToken(text, start, token) {
  if (token === '::>') return 'sysml20:ConnectionUsage';
  if (token === ':>>') return 'kerml10:Feature';
  if (token === ':' || token === '=' || token === ':=' || token.startsWith('default ')) return 'sysml20:Usage';
  if (token === ':>') {
    const lineStart = Math.max(0, String(text || '').lastIndexOf('\n', start) + 1);
    const lineEndIndex = String(text || '').indexOf('\n', start);
    const line = String(text || '').slice(lineStart, lineEndIndex < 0 ? undefined : lineEndIndex);
    return /\b(?:part|item|attribute|port|action|state|requirement)\s+def\b/iu.test(line)
      ? 'sysml20:Definition'
      : 'sysml20:Usage';
  }
  return null;
}

function expandedContextsForToken(token, intentMode, observedAstContextId) {
  if (intentMode === 'explain_occurrence' && observedAstContextId) return [observedAstContextId];
  if (token === ':') return ['sysml20:Usage'];
  if (token === ':>') return ['sysml20:Definition', 'sysml20:Usage', 'kerml10:Feature'];
  if (token === ':>>') return ['sysml20:Usage', 'kerml10:Feature'];
  if (token === '::>') return ['sysml20:ConnectionUsage', 'kerml10:Feature'];
  if (['=', ':=', 'default =', 'default :='].includes(token)) return ['sysml20:Usage'];
  return observedAstContextId ? [observedAstContextId] : [];
}

function expandedQuestionContextsForToken(token, intentMode, text) {
  if (token !== ':>' || intentMode === 'compare_operator_semantics') {
    return expandedContextsForToken(token, intentMode, null);
  }
  const value = String(text || '');
  const mentionsDefinition = /\bdefinition\b|定义/iu.test(value);
  const mentionsUsageOrFeature = /\busage\b|\bfeature\b|用法|特征/iu.test(value);
  if (mentionsDefinition && !mentionsUsageOrFeature) return ['sysml20:Definition'];
  if (mentionsUsageOrFeature && !mentionsDefinition) return ['sysml20:Usage', 'kerml10:Feature'];
  return expandedContextsForToken(token, intentMode, null);
}

function deduplicateOccurrences(occurrences) {
  const seen = new Set();
  return occurrences.filter((item) => {
    const key = [item.sourceType, item.fileId || '', item.contentHash, item.start, item.end, item.token].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function occurrenceContexts(queryPlan, operators) {
  // AST 上下文用于消歧同一操作符的不同语义。通用概念检索没有操作符时，
  // 不能把概念词（如 Requirement）误判成 Usage 声明并过滤掉 Definition Claim。
  if (!Array.isArray(operators) || operators.length === 0) return [];
  const contexts = [];
  for (const operator of operators || []) {
    const matching = (queryPlan.operatorOccurrences || []).filter((item) => item.token === operator);
    const trustedQuestion = matching.filter((item) => item.sourceType === 'trusted_question');
    const observedModelOccurrences = matching.filter((item) =>
      ['trusted_selection', 'trusted_active_model'].includes(item.sourceType) && item.observedAstContextId
    );
    if (queryPlan.intentMode === 'explain_occurrence' && observedModelOccurrences.length > 0) {
      const observedContexts = uniqueStrings(observedModelOccurrences.map((item) => item.observedAstContextId));
      if (trustedQuestion.length > 0) {
        const questionContexts = new Set(trustedQuestion.flatMap((item) => item.expandedAstContextIds || []));
        const compatibleContexts = observedContexts.filter((contextId) => questionContexts.has(contextId));
        if (compatibleContexts.length === 0) {
          throw new Error(`Trusted question and observed model contexts conflict for SysML operator ${operator}`);
        }
        contexts.push(...compatibleContexts);
      } else {
        contexts.push(...observedContexts);
      }
      continue;
    }
    contexts.push(...(trustedQuestion.length > 0 ? trustedQuestion : matching)
      .flatMap((item) => item.expandedAstContextIds || []));
  }
  return uniqueStrings(contexts.length > 0 ? contexts : inferAstContexts(queryPlan.effectiveQuery));
}

function requiredClaimIdsForQuery(operators, astContextIds) {
  const operatorSet = new Set(Array.isArray(operators) ? operators : []);
  const contextSet = new Set(Array.isArray(astContextIds) ? astContextIds : []);
  const required = [];
  for (const rule of AUTHORITATIVE_CLAIM_CLOSURE_RULES) {
    const ruleOperators = rule.operators || [rule.operator];
    if (!ruleOperators.some((operator) => operatorSet.has(operator))) continue;
    if (rule.astContextIds && !rule.astContextIds.some((contextId) => contextSet.has(contextId))) continue;
    for (const claimId of rule.claimIds) {
      if (!required.includes(claimId)) required.push(claimId);
    }
  }
  return required;
}

function supportingClaimIdsForQuery(operators, astContextIds) {
  const required = requiredClaimIdsForQuery(operators, astContextIds);
  const protective = claimIdsForRules(PROTECTIVE_SUPPORTING_CLAIM_CLOSURE_RULES, operators, astContextIds);
  return uniqueStrings([...required, ...protective]);
}

function claimIdsForRules(rules, operators, astContextIds) {
  const operatorSet = new Set(Array.isArray(operators) ? operators : []);
  const contextSet = new Set(Array.isArray(astContextIds) ? astContextIds : []);
  const claimIds = [];
  for (const rule of rules) {
    const ruleOperators = rule.operators || [rule.operator];
    if (!ruleOperators.some((operator) => operatorSet.has(operator))) continue;
    if (rule.astContextIds && !rule.astContextIds.some((contextId) => contextSet.has(contextId))) continue;
    claimIds.push(...rule.claimIds);
  }
  return uniqueStrings(claimIds);
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '')).filter(Boolean))];
}

function trustedEditorText(context) {
  const editor = context?.editor || {};
  const state = editor.contextState || {};
  const stale = ['stale_document', 'default_context'].includes(String(state.degradedReason || ''));
  if (stale) return '';
  const selection = state.selectionOrigin === 'last-known' ? '' : editor.selection?.text;
  const active = (editor.files || []).find((file) => file.fileId === editor.activeFileId);
  return [selection, active?.content].filter(Boolean).join(' ');
}

function normalizeSearchText(value) {
  return [...new Set(String(value || '').toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/iu)
    .map((token) => token.trim()).filter((token) => token.length >= 2))].join(' ');
}

function buildDisjunctiveSearchTsQuery(normalizedSearchText) {
  return uniqueStrings(String(normalizedSearchText || '').split(/\s+/u))
    .map((token) => token.replace(/[':&|!()]/gu, ''))
    .filter(Boolean)
    .join(' | ');
}

function rowToClaim(row) {
  return {
    claimId: row.claim_id,
    claimType: row.claim_type,
    subjectNodeId: row.subject_node_id,
    predicate: row.predicate,
    objectNodeId: row.object_node_id,
    operators: row.operators || [],
    astContextIds: row.ast_context_ids || [],
    polarity: row.polarity,
    modality: row.modality,
    authorityLevel: row.authority_level,
    reviewStatus: row.review_status,
    claimText: row.claim_text,
    evidenceIds: row.evidence_ids || [],
    properties: row.properties || {}
  };
}

function rowToEvidence(row) {
  return {
    evidenceId: row.evidence_id,
    sourceId: row.source_id,
    sectionPath: row.section_path,
    blockType: row.block_type,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    textContent: row.text_content,
    textHash: row.text_hash,
    authorityLevel: row.authority_level,
    reviewStatus: row.review_status,
    operators: row.operators || [],
    conceptIds: row.concept_ids || [],
    astContextIds: row.ast_context_ids || []
  };
}

function rowToSyntaxMapping(row) {
  return {
    syntaxMappingId: row.syntax_mapping_id,
    token: row.token,
    grammarProductionId: row.grammar_production_id,
    astContextId: row.ast_context_id,
    semanticNodeId: row.semantic_node_id,
    mappingType: row.mapping_type,
    parserFixtureId: row.parser_fixture_id,
    reviewStatus: row.review_status
  };
}

function rowToKnowledgePattern(row) {
  return {
    patternId: String(row.pattern_id || ''),
    title: String(row.title || ''),
    description: String(row.description || ''),
    examObjectiveIds: uniqueStrings(row.exam_objective_ids || []),
    anchorNodeIds: uniqueStrings(row.anchor_node_ids || []),
    requiredClaimIds: uniqueStrings(row.required_claim_ids || []),
    requiredEdgeIds: uniqueStrings(row.required_edge_ids || []),
    guardrailIds: uniqueStrings(row.guardrail_ids || []),
    fixtureIds: uniqueStrings(row.fixture_ids || []),
    reviewStatus: String(row.review_status || ''),
    properties: row.properties && typeof row.properties === 'object' ? row.properties : {}
  };
}

function findKnowledgePatternCandidates({ patterns, anchorClaims }) {
  const candidateClaimIds = new Set(anchorClaims.map((claim) => claim.claimId));
  const candidateNodeIds = new Set(anchorClaims.flatMap((claim) => [
    claim.subjectNodeId,
    claim.objectNodeId
  ]).filter(Boolean));
  const ranked = patterns.map((pattern) => {
    const matchedAnchorNodeIds = pattern.anchorNodeIds.filter((nodeId) => candidateNodeIds.has(nodeId));
    const matchedClaimIds = pattern.requiredClaimIds.filter((claimId) => candidateClaimIds.has(claimId));
    return {
      pattern,
      matchedAnchorNodeIds,
      matchedClaimIds,
      score: matchedAnchorNodeIds.length * 2 + matchedClaimIds.length
    };
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.pattern.patternId.localeCompare(right.pattern.patternId));
  return ranked;
}

function activateSelectedKnowledgePatterns({ patterns, existingClosureClaimIds, resourceLimit }) {
  const closureClaimIds = new Set(existingClosureClaimIds);
  const selected = [];
  const resourceLimitedPatternIds = [];
  for (const pattern of patterns) {
    const expanded = new Set([...closureClaimIds, ...pattern.requiredClaimIds]);
    if (expanded.size > resourceLimit) {
      resourceLimitedPatternIds.push(pattern.patternId);
      continue;
    }
    selected.push(pattern);
    for (const claimId of pattern.requiredClaimIds) closureClaimIds.add(claimId);
  }
  return { patterns: selected, resourceLimitedPatternIds };
}

function rowToGuardrail(row) {
  const patternSpec = Array.isArray(row.pattern_spec) ? row.pattern_spec : [];
  const patternHash = String(row.pattern_hash || '');
  if (patternHash !== hashText(canonicalJson(patternSpec))) {
    throw new Error(`Teaching overlay pattern hash mismatch: ${row.overlay_id || ''}`);
  }
  const counterexampleSpec = row.counterexample_spec && typeof row.counterexample_spec === 'object'
    ? row.counterexample_spec
    : {};
  return {
    guardrailId: row.overlay_id,
    authorityClass: row.authority_class,
    description: row.description,
    patternSpec,
    patternHash,
    supportedByClaimIds: uniqueStrings(row.supported_by_claim_ids || []),
    counterexampleIds: uniqueStrings(counterexampleSpec.counterexampleIds || [])
  };
}

function emptyQueryResult(queryPlan, baselineId) {
  const result = {
    coverage: 'NONE',
    bundleId: '',
    baselineId,
    bundleVersion: '',
    sourceRegistryHash: '',
    bundleContentHash: '',
    requestedQuery: queryPlan.requestedQuery,
    effectiveQuery: queryPlan.effectiveQuery,
    requestedQueryHash: queryPlan.requestedQueryHash,
    effectiveQueryHash: queryPlan.effectiveQueryHash,
    closureProfileId: queryPlan.closureProfileId,
    closureProfileHash: queryPlan.closureProfileHash,
    closureRequirement: 'not_applicable',
    closureStatus: 'not_applicable',
    intentMode: queryPlan.intentMode,
    operatorOccurrences: queryPlan.operatorOccurrences,
    queryExpansion: queryPlan.queryExpansion,
    candidateKnowledgePatterns: [],
    selectedKnowledgePatternIds: [],
    selectedPatternClosureClaimIds: [],
    patternSelectionWarnings: [],
    closureGaps: [],
    closureClaimIds: [],
    knowledgeAnswerRequiredClaimIds: [],
    knowledgeSupportingClaimIds: [],
    mandatorySupportingCount: 0,
    additionalSupportingClaimIds: [],
    missingClosureClaimIds: [],
    requestedLimit: queryPlan.requestedLimit,
    additionalSupportingBudget: queryPlan.requestedLimit,
    selectionLimit: queryPlan.requestedLimit,
    returnedClaimCount: 0,
    resourceLimit: MAX_LIMIT,
    claims: [],
    evidenceBlocks: [],
    syntaxMappings: [],
    guardrails: [],
    conflicts: [],
    excludedCandidates: { count: 0, claimIds: [] }
  };
  return { ...result, resultHash: hashText(canonicalJson(result)) };
}

function claimTitle(claim) {
  return `${claim.subjectNodeId || 'SysML'} ${claim.predicate}`.slice(0, 240);
}

function hashFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  const content = isCanonicalTextArtifact(filePath)
    ? Buffer.from(bytes.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8')
    : bytes;
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function isCanonicalTextArtifact(filePath) {
  return ['.json', '.jsonl', '.md', '.txt', '.kerml', '.sysml', '.yaml', '.yml']
    .includes(path.extname(String(filePath || '')).toLowerCase());
}

function hashText(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

module.exports = {
  activateSysmlKnowledgeBundle,
  buildSysmlKnowledgeQueryPlan,
  createKnowledgePool,
  extractOperators,
  importSysmlKnowledgeBundle,
  inferAstContexts,
  loadAndVerifyBundle,
  migrateSysmlKnowledgeStore,
  queryActiveSysmlKnowledge,
  requiredClaimIdsForQuery,
  SYSML_ANSWER_CLOSURE_PROFILE_HASH,
  SYSML_ANSWER_CLOSURE_PROFILE_ID,
  sysmlKnowledgeResultToHits
};
