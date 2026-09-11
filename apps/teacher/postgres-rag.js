'use strict';

const crypto = require('crypto');
const {
  migrateSysmlKnowledgeStore,
  queryActiveSysmlKnowledge,
  listActiveExampleCatalog,
  sysmlKnowledgeResultToHits
} = require('./sysml-knowledge-store');
const {
  expandActiveKnowledgeClaims,
  searchActiveKnowledgeAnchors
} = require('./knowledge-progressive');
const { resolveKnowledgeRankingMode } = require('./knowledge-ranking');

const DEFAULT_TENANT_ID = 'local-dev';
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;

function createPostgresKnowledgeRetriever(options = {}) {
  const pool = options.pool || createPool(options);
  const tenantId = options.tenantId || process.env.AI_TEACHER_RAG_TENANT_ID || DEFAULT_TENANT_ID;
  const rankingMode = resolveKnowledgeRankingMode(options.rankingMode);

  return {
    mode: 'postgres_pgvector',
    cards: [],
    async status(context = {}) {
      const requestTenantId = tenantIdForContext(context, tenantId);
      try {
        const bundleResult = await pool.query(`
          select kb.bundle_id, kb.baseline_id, kb.version, kb.source_registry_hash, kb.content_hash,
                 count(nc.claim_id)::int as claim_count
          from knowledge_bundles kb
          left join normative_claims nc on nc.bundle_id = kb.bundle_id
          where kb.status = 'ACTIVE'
          group by kb.bundle_id, kb.baseline_id, kb.version, kb.source_registry_hash, kb.content_hash, kb.activated_at
          order by kb.activated_at desc
          limit 1
        `);
        const activeBundle = bundleResult.rows[0] || null;
        return {
          mode: 'postgres_pgvector',
          enabled: true,
          ready: Boolean(activeBundle),
          tenantId: requestTenantId,
          cardCount: activeBundle?.claim_count || 0,
          error: activeBundle ? undefined : 'ACTIVE_SYSML_KNOWLEDGE_BUNDLE_REQUIRED',
          activeBundle: activeBundle ? {
            bundleId: activeBundle.bundle_id,
            baselineId: activeBundle.baseline_id,
            version: activeBundle.version,
            sourceRegistryHash: activeBundle.source_registry_hash,
            contentHash: activeBundle.content_hash
          } : null
        };
      } catch (error) {
        return {
          mode: 'postgres_pgvector',
          enabled: true,
          ready: false,
          tenantId: requestTenantId,
          cardCount: 0,
          error: error.message
        };
      }
    },
    async search(query, context = {}, searchOptions = {}) {
      const requestTenantId = tenantIdForContext(context, tenantId);
      return searchPostgresKnowledge(pool, query, context, {
        ...searchOptions,
        tenantId: requestTenantId,
        rankingMode: searchOptions.rankingMode || rankingMode
      });
    },
    async searchExamples(query, context = {}, searchOptions = {}) {
      return queryActiveSysmlKnowledge(pool, query, context, {
        ...searchOptions,
        limit: Math.max(1, Number(searchOptions.limit) || 8),
        exampleLimit: searchOptions.exampleLimit,
        constructTags: searchOptions.constructTags || [],
        queryPlan: searchOptions.queryPlan,
        rankingMode: searchOptions.rankingMode || rankingMode
      });
    },
    async listExampleCatalog(context = {}, options = {}) {
      return listActiveExampleCatalog(pool, options);
    },
    async searchAnchors(query, context = {}, searchOptions = {}) {
      const requestTenantId = tenantIdForContext(context, tenantId);
      const result = await searchActiveKnowledgeAnchors(pool, query, context, {
        ...searchOptions,
        tenantId: requestTenantId,
        sessionId: sessionIdForContext(context, searchOptions),
        rankingMode: searchOptions.rankingMode || rankingMode
      });
      await recordRetrievalEvent(pool, requestTenantId, context, query, result.anchors || [], result.retrieval?.ranking);
      return result;
    },
    async expandClaims(claimIds, context = {}, expandOptions = {}) {
      const requestTenantId = tenantIdForContext(context, tenantId);
      return expandActiveKnowledgeClaims(pool, claimIds, context, {
        ...expandOptions,
        tenantId: requestTenantId,
        sessionId: sessionIdForContext(context, expandOptions)
      });
    },
    async debug(query, context = {}, searchOptions = {}) {
      const requestTenantId = tenantIdForContext(context, tenantId);
      const status = await this.status(context);
      const hits = status.ready
        ? await searchPostgresKnowledge(pool, query, context, { ...searchOptions, tenantId: requestTenantId })
        : [];
      return {
        ok: status.ready,
        cardCount: status.cardCount,
        query: String(query || ''),
        backend: 'postgres_pgvector',
        tenantId: requestTenantId,
        error: status.error,
        hits
      };
    },
    async close() {
      if (!options.pool) await pool.end();
    }
  };
}

function tenantIdForContext(context, fallbackTenantId) {
  const requestTenantId = String(context?.tenant?.tenantId || context?.tenantId || '').trim();
  return requestTenantId || fallbackTenantId;
}

function sessionIdForContext(context, options = {}) {
  const sessionId = String(options.sessionId || context?.threadId || context?.sessionId || '').trim();
  if (!sessionId) throw new Error('Progressive knowledge retrieval requires a server-bound thread/session ID');
  return sessionId;
}

function createPool(options = {}) {
  return require('./database-pool-policy').createTeacherDatabasePool(options, 'postgres_pgvector retrieval');
}

async function migratePostgresKnowledgeStore(options = {}) {
  const pool = options.pool || createPool(options);
  try {
    await pool.query(`create extension if not exists vector`);
    await pool.query(`
      create table if not exists ai_teacher_retrieval_events (
        event_id bigserial primary key,
        tenant_id text not null,
        request_id text not null default '',
        query_hash text not null default '',
        backend text not null default 'postgres_pgvector',
        hit_card_ids text[] not null default '{}',
        ranking_mode text not null default 'legacy',
        ranking_profile_id text not null default '',
        ranking_profile_hash text not null default '',
        candidate_claim_ids text[] not null default '{}',
        ranking_audit jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      )
    `);
    await pool.query(`alter table ai_teacher_retrieval_events add column if not exists ranking_mode text not null default 'legacy'`);
    await pool.query(`alter table ai_teacher_retrieval_events add column if not exists ranking_profile_id text not null default ''`);
    await pool.query(`alter table ai_teacher_retrieval_events add column if not exists ranking_profile_hash text not null default ''`);
    await pool.query(`alter table ai_teacher_retrieval_events add column if not exists candidate_claim_ids text[] not null default '{}'`);
    await pool.query(`alter table ai_teacher_retrieval_events add column if not exists ranking_audit jsonb not null default '{}'::jsonb`);
    await pool.query(`create index if not exists ai_teacher_retrieval_events_tenant_created_idx on ai_teacher_retrieval_events (tenant_id, created_at desc)`);
    await migrateSysmlKnowledgeStore({ pool });
  } finally {
    if (!options.pool) await pool.end();
  }
}

async function searchPostgresKnowledge(pool, query, context = {}, options = {}) {
  const tenantId = options.tenantId || DEFAULT_TENANT_ID;
  const requestedLimit = options.limit === undefined ? DEFAULT_LIMIT : Number(options.limit);
  const limit = Math.max(0, Math.min(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : DEFAULT_LIMIT, MAX_LIMIT));
  const queryText = queryTextWithContext(query, context);
  const graphResult = await queryActiveSysmlKnowledge(pool, query, context, {
    offset: options.offset,
    exampleIds: options.exampleIds,
    claimIds: options.claimIds,
    evidenceIds: options.evidenceIds,
    limit,
    queryPlan: options.queryPlan,
    rankingMode: options.rankingMode,
    selectedPatternIds: options.selectedPatternIds,
    exampleLimit: options.exampleLimit,
    constructTags: options.constructTags
  });
  const graphHits = sysmlKnowledgeResultToHits(graphResult);
  // 兼容卡片数组只用于旧展示；无 Claim 的案例页也必须保留完整图结果和续页信息。
  Object.defineProperty(graphHits, 'graph', { value: graphResult, enumerable: false });
  await recordRetrievalEvent(pool, tenantId, context, queryText, graphHits, graphResult.ranking);
  return graphHits;
}

async function recordRetrievalEvent(pool, tenantId, context, query, hits, ranking = undefined) {
  const requestId = context?.requestId || '';
  if (!requestId && process.env.AI_TEACHER_RAG_AUDIT_ALL !== 'true') return;
  const queryHash = crypto.createHash('sha256').update(String(query || '')).digest('hex');
  await pool.query(
    `insert into ai_teacher_retrieval_events (
      tenant_id, request_id, query_hash, hit_card_ids, ranking_mode,
      ranking_profile_id, ranking_profile_hash, candidate_claim_ids, ranking_audit
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      tenantId,
      requestId,
      queryHash,
      hits.map((hit) => hit.card?.id || hit.claimId).filter(Boolean),
      ranking?.mode || 'legacy',
      ranking?.profileId || '',
      ranking?.profileHash || '',
      ranking?.legacyClaimIds || [],
      JSON.stringify(ranking || {})
    ]
  );
}

function queryTextWithContext(query, context) {
  return [
    query,
    context?.question?.text,
    context?.course?.lessonTitle,
    ...(context?.course?.learningGoals || []),
    ...(context?.courseContext?.focusTerms || []).flatMap((item) => [item.text, item.label]),
    ...(context?.courseContext?.todoItems || []).map((item) => item.text),
    ...(context?.diagnostics?.officialValidator || []).map((item) => item.message),
    ...(context?.diagnostics?.courseRules || []).map((item) => item.message)
  ].filter(Boolean).join(' ');
}

module.exports = {
  DEFAULT_TENANT_ID,
  createPostgresKnowledgeRetriever,
  migratePostgresKnowledgeStore,
  searchPostgresKnowledge,
  sessionIdForContext
};
