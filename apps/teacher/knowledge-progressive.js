'use strict';

const {
  KNOWLEDGE_RELATION_PROFILE_HASH,
  KNOWLEDGE_RELATION_PROFILE_ID,
  canonicalJson,
  hashText
} = require('./knowledge-relations');
const { queryActiveSysmlKnowledge } = require('./sysml-knowledge-store');
const { orderEvidenceForRequestedClaims } = require('./knowledge-ranking');

const PROGRESSIVE_SCHEMA_VERSION = 'sysml-knowledge-progressive/v1';
const ANCHOR_PROFILE_ID = 'sysml-anchor-summary-v1';
const DEFAULT_ANCHOR_LIMIT = 4;
const MAX_ANCHOR_LIMIT = 6;
const MAX_EXPAND_CLAIMS = 6;
const RANKING_CANDIDATE_POOL_LIMIT = 25;
const ANCHOR_PROFILE_HASH = hashText(canonicalJson({
  schemaVersion: PROGRESSIVE_SCHEMA_VERSION,
  profileId: ANCHOR_PROFILE_ID,
  defaultLimit: DEFAULT_ANCHOR_LIMIT,
  maxLimit: MAX_ANCHOR_LIMIT,
  disclosure: 'claim_summary_without_evidence_text'
}));

async function searchActiveKnowledgeAnchors(pool, query, context = {}, options = {}) {
  const identity = sessionIdentity(context, options);
  const limit = normalizeLimit(options.limit, DEFAULT_ANCHOR_LIMIT, MAX_ANCHOR_LIMIT);
  const noveltyStore = options.noveltyStore || createPostgresKnowledgeNoveltyStore(pool);
  const graph = await queryActiveSysmlKnowledge(pool, query, context, {
    limit: RANKING_CANDIDATE_POOL_LIMIT,
    baselineId: options.baselineId,
    queryPlan: options.queryPlan,
    rankingMode: options.rankingMode,
    selectedPatternIds: options.selectedPatternIds
  });
  if (!graph.bundleId) {
    return hashResult({
      schemaVersion: PROGRESSIVE_SCHEMA_VERSION,
      action: 'anchors',
      status: 'no_active_bundle',
      anchorProfileId: ANCHOR_PROFILE_ID,
      anchorProfileHash: ANCHOR_PROFILE_HASH,
      requestedQuery: graph.requestedQuery,
      requestedQueryHash: graph.requestedQueryHash,
      anchors: [],
      novelty: noveltySummary(identity, [], []),
      warnings: ['ACTIVE_SYSML_KNOWLEDGE_BUNDLE_REQUIRED']
    });
  }

  const candidates = (graph.claims || []).slice(0, limit);
  const newClaimIds = await noveltyStore.claimItems({
    ...identity,
    bundleId: graph.bundleId,
    itemKind: 'claim',
    itemIds: candidates.map((claim) => claim.claimId)
  });
  const newClaimIdSet = new Set(newClaimIds);
  const anchors = candidates.filter((claim) => newClaimIdSet.has(claim.claimId)).map((claim) => ({
    claimId: claim.claimId,
    summary: claim.claimText,
    authorityLevel: claim.authorityLevel,
    predicate: claim.predicate,
    ...(claim.subjectNodeId ? { subjectNodeId: claim.subjectNodeId } : {}),
    ...(claim.objectNodeId ? { objectNodeId: claim.objectNodeId } : {}),
    operators: claim.operators,
    astContextIds: claim.astContextIds,
    selectionRole: claim.selectionRole,
    evidenceIds: claim.evidenceIds,
    availableEvidenceCount: claim.evidenceIds.length
  }));
  return hashResult({
    schemaVersion: PROGRESSIVE_SCHEMA_VERSION,
    action: 'anchors',
    status: anchors.length > 0 ? 'ok' : 'no_new_evidence',
    anchorProfileId: ANCHOR_PROFILE_ID,
    anchorProfileHash: ANCHOR_PROFILE_HASH,
    requestedQuery: graph.requestedQuery,
    requestedQueryHash: graph.requestedQueryHash,
    effectiveQueryHash: graph.effectiveQueryHash,
    bundle: bundleAttestation(graph),
    anchors,
    closure: {
      closureProfileId: graph.closureProfileId,
      closureProfileHash: graph.closureProfileHash,
      candidateKnowledgePatterns: graph.candidateKnowledgePatterns || [],
      selectedKnowledgePatternIds: graph.selectedKnowledgePatternIds || [],
      selectedPatternClosureClaimIds: graph.selectedPatternClosureClaimIds || [],
      patternSelectionWarnings: graph.patternSelectionWarnings || [],
      closureGaps: graph.closureGaps || [],
      closureClaimIds: graph.closureClaimIds || [],
      knowledgeAnswerRequiredClaimIds: graph.knowledgeAnswerRequiredClaimIds || [],
      knowledgeSupportingClaimIds: graph.knowledgeSupportingClaimIds || [],
      missingClosureClaimIds: graph.missingClosureClaimIds || [],
      guardrails: graph.guardrails || []
    },
    novelty: noveltySummary(identity, newClaimIds, []),
    retrieval: {
      candidateClaimCount: (graph.claims || []).length,
      disclosedClaimCount: anchors.length,
      excludedCandidateCount: graph.excludedCandidates?.count || 0,
      evidenceTextDisclosed: false,
      ...(graph.ranking ? { ranking: graph.ranking } : {})
    },
    warnings: anchors.length > 0 ? [] : ['NO_NEW_REVIEWED_CLAIMS']
  });
}

async function expandActiveKnowledgeClaims(pool, claimIds, context = {}, options = {}) {
  const identity = sessionIdentity(context, options);
  const requestedClaimIds = normalizeClaimIds(claimIds);
  const noveltyStore = options.noveltyStore || createPostgresKnowledgeNoveltyStore(pool);
  const baselineId = String(options.baselineId || 'sysml-2.0-formal');
  const active = await pool.query(`
    select bundle_id, baseline_id, version, source_registry_hash, content_hash
    from knowledge_bundles
    where baseline_id = $1 and status = 'ACTIVE'
    limit 1
  `, [baselineId]);
  const bundle = active.rows[0];
  if (!bundle) {
    return hashResult({
      schemaVersion: PROGRESSIVE_SCHEMA_VERSION,
      action: 'expand_claims',
      status: 'no_active_bundle',
      relationProfileId: KNOWLEDGE_RELATION_PROFILE_ID,
      relationProfileHash: KNOWLEDGE_RELATION_PROFILE_HASH,
      requestedClaimIds,
      claims: [],
      evidenceBlocks: [],
      relations: [],
      neighbors: [],
      novelty: noveltySummary(identity, [], []),
      warnings: ['ACTIVE_SYSML_KNOWLEDGE_BUNDLE_REQUIRED']
    });
  }

  const claimsResult = await pool.query(`
    select claim_id, claim_type, subject_node_id, predicate, object_node_id, operators,
           ast_context_ids, polarity, modality, authority_level, review_status, claim_text,
           evidence_ids, properties
    from normative_claims
    where bundle_id = $1 and claim_id = any($2::text[])
      and review_status = 'reviewed' and authority_level in ('A1', 'A2')
    order by array_position($2::text[], claim_id)
  `, [bundle.bundle_id, requestedClaimIds]);
  const returnedClaimIds = new Set(claimsResult.rows.map((row) => row.claim_id));
  const missingClaimIds = requestedClaimIds.filter((claimId) => !returnedClaimIds.has(claimId));
  if (missingClaimIds.length > 0) {
    throw new Error(`Claim is not reviewed in the current Active Bundle: ${missingClaimIds.join(',')}`);
  }
  const evidenceIds = uniqueStrings(claimsResult.rows.flatMap((row) => row.evidence_ids || []));
  const newRequestedClaimIds = await noveltyStore.claimItems({
    ...identity,
    bundleId: bundle.bundle_id,
    itemKind: 'claim',
    itemIds: requestedClaimIds
  });
  const evidenceResult = evidenceIds.length > 0 ? await pool.query(`
    select evidence_id, source_id, section_path, block_type, line_start, line_end, text_content,
           text_hash, authority_level, review_status, operators, concept_ids, ast_context_ids
    from evidence_blocks
    where bundle_id = $1 and evidence_id = any($2::text[])
      and review_status = 'reviewed' and authority_level in ('A1', 'A2')
    order by evidence_id
  `, [bundle.bundle_id, evidenceIds]) : { rows: [] };
  const relationsResult = await pool.query(`
    select relation_id, relation_hash, relation_layer, predicate, source_kind, source_id,
           target_kind, target_id, authority_level, review_status, conditions, evidence_ids,
           fixture_ids, basis_claim_ids, provenance, properties
    from knowledge_relations
    where bundle_id = $1
      and review_status in ('reviewed', 'derived')
      and ((source_kind = 'claim' and source_id = any($2::text[]))
        or (target_kind = 'claim' and target_id = any($2::text[])))
    order by relation_layer, predicate, relation_id
  `, [bundle.bundle_id, requestedClaimIds]);
  const neighborClaimIds = uniqueStrings(relationsResult.rows.flatMap((row) => [
    row.source_kind === 'claim' && !requestedClaimIds.includes(row.source_id) ? row.source_id : '',
    row.target_kind === 'claim' && !requestedClaimIds.includes(row.target_id) ? row.target_id : ''
  ]));
  const newEvidenceIds = await noveltyStore.claimItems({
    ...identity,
    bundleId: bundle.bundle_id,
    itemKind: 'evidence',
    itemIds: evidenceIds
  });
  const newNeighborClaimIds = await noveltyStore.claimItems({
    ...identity,
    bundleId: bundle.bundle_id,
    itemKind: 'claim',
    itemIds: neighborClaimIds
  });
  const newEvidenceSet = new Set(newEvidenceIds);
  const newNeighborSet = new Set(newNeighborClaimIds);
  const orderedEvidenceRows = orderEvidenceForRequestedClaims(evidenceResult.rows, claimsResult.rows);
  const evidenceBlocks = orderedEvidenceRows.filter((row) => newEvidenceSet.has(row.evidence_id)).map(rowToEvidence);
  const neighborsResult = newNeighborClaimIds.length > 0 ? await pool.query(`
    select claim_id, predicate, subject_node_id, object_node_id, claim_text, operators, ast_context_ids
    from normative_claims
    where bundle_id = $1 and claim_id = any($2::text[])
      and review_status = 'reviewed' and authority_level in ('A1', 'A2')
    order by claim_id
  `, [bundle.bundle_id, newNeighborClaimIds]) : { rows: [] };
  const newRequestedSet = new Set(newRequestedClaimIds);
  const disclosedClaims = claimsResult.rows.filter((row) => newRequestedSet.has(row.claim_id)).map(rowToClaimSummary);
  const allNewClaimIds = uniqueStrings([...newRequestedClaimIds, ...newNeighborClaimIds]);
  const hasNewDisclosure = disclosedClaims.length > 0 || evidenceBlocks.length > 0 || neighborsResult.rows.length > 0;
  const relations = hasNewDisclosure ? relationsResult.rows
    .filter((row) => row.source_kind !== 'claim' || requestedClaimIds.includes(row.source_id) || newNeighborSet.has(row.source_id))
    .filter((row) => row.target_kind !== 'claim' || requestedClaimIds.includes(row.target_id) || newNeighborSet.has(row.target_id))
    .map(rowToRelation) : [];

  return hashResult({
    schemaVersion: PROGRESSIVE_SCHEMA_VERSION,
    action: 'expand_claims',
    status: hasNewDisclosure ? 'ok' : 'no_new_evidence',
    relationProfileId: KNOWLEDGE_RELATION_PROFILE_ID,
    relationProfileHash: KNOWLEDGE_RELATION_PROFILE_HASH,
    requestedClaimIds,
    bundle: {
      bundleId: bundle.bundle_id,
      baselineId: bundle.baseline_id,
      bundleVersion: bundle.version,
      sourceRegistryHash: bundle.source_registry_hash,
      bundleContentHash: bundle.content_hash
    },
    claims: disclosedClaims,
    evidenceBlocks,
    relations,
    neighbors: neighborsResult.rows.map(rowToNeighbor),
    novelty: noveltySummary(identity, allNewClaimIds, newEvidenceIds),
    warnings: hasNewDisclosure ? [] : ['NO_NEW_EVIDENCE_OR_CLAIM_NEIGHBORS']
  });
}

function createPostgresKnowledgeNoveltyStore(pool) {
  return {
    async claimItems(input) {
      if (!input.itemIds.length) return [];
      await pool.query(`
        insert into knowledge_retrieval_sessions (tenant_id, session_id, bundle_id, expires_at)
        values ($1, $2, $3, now() + interval '24 hours')
        on conflict (tenant_id, session_id, bundle_id)
        do update set updated_at = now(), expires_at = excluded.expires_at
      `, [input.tenantId, input.sessionId, input.bundleId]);
      const result = await pool.query(`
        with input_items as (
          select item_id, ordinal
          from unnest($5::text[]) with ordinality as supplied(item_id, ordinal)
        ), inserted as (
          insert into knowledge_retrieval_seen_items (
            tenant_id, session_id, bundle_id, item_kind, item_id
          )
          select $1, $2, $3, $4, input_items.item_id
          from input_items
          on conflict do nothing
          returning item_id
        )
        select input_items.item_id
        from input_items join inserted using (item_id)
        order by input_items.ordinal
      `, [input.tenantId, input.sessionId, input.bundleId, input.itemKind, input.itemIds]);
      return result.rows.map((row) => row.item_id);
    }
  };
}

function createMemoryKnowledgeNoveltyStore() {
  const seen = new Set();
  return {
    async claimItems(input) {
      const fresh = [];
      for (const itemId of input.itemIds) {
        const key = [input.tenantId, input.sessionId, input.bundleId, input.itemKind, itemId].join('\u001f');
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push(itemId);
      }
      return fresh;
    }
  };
}

function sessionIdentity(context, options) {
  const tenantId = String(options.tenantId || context?.tenant?.tenantId || context?.tenantId || '').trim();
  const sessionId = String(options.sessionId || context?.threadId || context?.sessionId || '').trim();
  if (!tenantId || tenantId.length > 160) throw new Error('Server-bound tenantId is required for progressive knowledge retrieval');
  if (!sessionId || sessionId.length > 200) throw new Error('Server-bound sessionId is required for progressive knowledge retrieval');
  return { tenantId, sessionId };
}

function normalizeClaimIds(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_EXPAND_CLAIMS) {
    throw new Error(`expandClaims requires 1..${MAX_EXPAND_CLAIMS} Claim IDs`);
  }
  const normalized = values.map((value) => String(value || '').trim());
  if (normalized.some((value) => !value || value.length > 200)) throw new Error('expandClaims contains an invalid Claim ID');
  if (new Set(normalized).size !== normalized.length) throw new Error('expandClaims Claim IDs must be unique');
  return normalized;
}

function normalizeLimit(value, fallback, maximum) {
  const numeric = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > maximum) throw new Error(`Anchor limit must be 1..${maximum}`);
  return numeric;
}

function bundleAttestation(graph) {
  return {
    bundleId: graph.bundleId,
    baselineId: graph.baselineId,
    bundleVersion: graph.bundleVersion,
    sourceRegistryHash: graph.sourceRegistryHash,
    bundleContentHash: graph.bundleContentHash
  };
}

function noveltySummary(identity, newClaimIds, newEvidenceIds) {
  return {
    scope: 'tenant_session_bundle',
    tenantIdHash: hashText(identity.tenantId),
    sessionIdHash: hashText(identity.sessionId),
    newClaimIds,
    newEvidenceIds
  };
}

function rowToClaimSummary(row) {
  return {
    claimId: row.claim_id,
    summary: row.claim_text,
    predicate: row.predicate,
    ...(row.subject_node_id ? { subjectNodeId: row.subject_node_id } : {}),
    ...(row.object_node_id ? { objectNodeId: row.object_node_id } : {}),
    operators: row.operators || [],
    astContextIds: row.ast_context_ids || [],
    evidenceCount: (row.evidence_ids || []).length
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

function rowToRelation(row) {
  return {
    relationId: row.relation_id,
    relationHash: row.relation_hash,
    relationLayer: row.relation_layer,
    predicate: row.predicate,
    source: { kind: row.source_kind, id: row.source_id },
    target: { kind: row.target_kind, id: row.target_id },
    authorityLevel: row.authority_level,
    reviewStatus: row.review_status,
    conditions: row.conditions || [],
    evidenceIds: row.evidence_ids || [],
    fixtureIds: row.fixture_ids || [],
    basisClaimIds: row.basis_claim_ids || [],
    provenance: row.provenance || {},
    properties: row.properties || {}
  };
}

function rowToNeighbor(row) {
  return {
    claimId: row.claim_id,
    summary: row.claim_text,
    predicate: row.predicate,
    ...(row.subject_node_id ? { subjectNodeId: row.subject_node_id } : {}),
    ...(row.object_node_id ? { objectNodeId: row.object_node_id } : {}),
    operators: row.operators || [],
    astContextIds: row.ast_context_ids || []
  };
}

function hashResult(result) {
  return { ...result, resultHash: hashText(canonicalJson(result)) };
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

module.exports = {
  ANCHOR_PROFILE_HASH,
  ANCHOR_PROFILE_ID,
  DEFAULT_ANCHOR_LIMIT,
  MAX_ANCHOR_LIMIT,
  MAX_EXPAND_CLAIMS,
  RANKING_CANDIDATE_POOL_LIMIT,
  PROGRESSIVE_SCHEMA_VERSION,
  createMemoryKnowledgeNoveltyStore,
  createPostgresKnowledgeNoveltyStore,
  expandActiveKnowledgeClaims,
  searchActiveKnowledgeAnchors
};
