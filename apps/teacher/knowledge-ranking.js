'use strict';

const crypto = require('crypto');
const MiniSearch = require('minisearch');

const KNOWLEDGE_RANKING_PROFILE_ID = 'code-evidence-v1';
const KNOWLEDGE_RANKING_MODES = Object.freeze([
  'legacy',
  'shadow_code_evidence_v1',
  'code_evidence_v1'
]);
const SELECTION_ROLE_ORDER = Object.freeze({
  required: 0,
  supporting: 1,
  additional_supporting: 2
});
const KNOWLEDGE_RANKING_PROFILE = Object.freeze({
  schemaVersion: 'ai-teacher-knowledge-ranking/v1',
  profileId: KNOWLEDGE_RANKING_PROFILE_ID,
  algorithm: 'minisearch-bm25-plus',
  fusionStrategy: 'single_source',
  termExpansionVersion: 'sysml-code-operators-v1',
  candidateKind: 'claim',
  candidatePoolLimit: 25,
  options: {
    combineWith: 'OR',
    prefix: true,
    fuzzy: 0.1
  },
  keys: [
    { name: 'operatorsText', weight: 4 },
    { name: 'astContextText', weight: 3 },
    { name: 'semanticNodeText', weight: 3 },
    { name: 'searchTermsText', weight: 3 },
    { name: 'predicateText', weight: 2.5 },
    { name: 'claimText', weight: 2.5 },
    { name: 'sectionPathText', weight: 2 },
    { name: 'evidenceText', weight: 1 }
  ],
  tieBreak: ['selectionRole', 'bm25Score', 'legacyRank', 'claimId']
});
const KNOWLEDGE_RANKING_PROFILE_HASH = hashJson(KNOWLEDGE_RANKING_PROFILE);

function resolveKnowledgeRankingMode(value = process.env.AI_TEACHER_KNOWLEDGE_RANKING_MODE) {
  const normalized = String(value || 'legacy').trim().toLowerCase();
  if (!KNOWLEDGE_RANKING_MODES.includes(normalized)) {
    throw new Error(`Unsupported AI Teacher knowledge ranking mode: ${normalized || '(empty)'}`);
  }
  return normalized;
}

function rankKnowledgeClaims(input = {}) {
  const mode = resolveKnowledgeRankingMode(input.mode);
  const claims = Array.isArray(input.claims) ? input.claims : [];
  const evidenceBlocks = Array.isArray(input.evidenceBlocks) ? input.evidenceBlocks : [];
  const query = String(input.query || '').trim();
  const legacyClaims = claims.slice();
  if (claims.length < 2 || !query || mode === 'legacy') {
    return {
      claims: legacyClaims,
      audit: buildRankingAudit({ mode, query, legacyClaims, rankedClaims: legacyClaims, details: [] })
    };
  }

  const evidenceById = new Map(evidenceBlocks.map((item) => [item.evidenceId, item]));
  const rankedClaims = [];
  const details = [];
  for (const role of Object.keys(SELECTION_ROLE_ORDER)) {
    const tierClaims = legacyClaims.filter((claim) => normalizedSelectionRole(claim.selectionRole) === role);
    const tier = rankClaimTier(tierClaims, evidenceById, query, legacyClaims);
    rankedClaims.push(...tier.claims);
    details.push(...tier.details);
  }
  const knownIds = new Set(rankedClaims.map((claim) => claim.claimId));
  rankedClaims.push(...legacyClaims.filter((claim) => !knownIds.has(claim.claimId)));

  const proposedClaims = stableRankedClaims(rankedClaims, legacyClaims, details);
  const appliedClaims = mode === 'code_evidence_v1' ? proposedClaims : legacyClaims;
  return {
    claims: appliedClaims,
    audit: buildRankingAudit({ mode, query, legacyClaims, rankedClaims: proposedClaims, details })
  };
}

function rankClaimTier(claims, evidenceById, query, allLegacyClaims) {
  if (claims.length < 2) {
    return {
      claims: claims.slice(),
      details: claims.map((claim) => rankingDetail(claim, allLegacyClaims, undefined, []))
    };
  }
  const documents = claims.map((claim) => claimSearchDocument(claim, evidenceById));
  const fields = KNOWLEDGE_RANKING_PROFILE.keys.map((key) => key.name);
  const boost = Object.fromEntries(KNOWLEDGE_RANKING_PROFILE.keys.map((key) => [key.name, key.weight]));
  const miniSearch = new MiniSearch({
    idField: 'claimId',
    fields,
    storeFields: ['claimId'],
    searchOptions: { ...KNOWLEDGE_RANKING_PROFILE.options, boost }
  });
  miniSearch.addAll(documents);
  const results = miniSearch.search(expandCodeTerms(query));
  const resultById = new Map(results.map((result) => [result.claimId, result]));
  const rankedResults = results
    .slice()
    .sort((left, right) => compareSearchResults(left, right, allLegacyClaims));
  const fusedCandidates = fuseRankedCandidateSources([{
    sourceId: 'minisearch-bm25-plus',
    candidateIds: rankedResults.map((result) => result.claimId)
  }]);
  const ranked = fusedCandidates
    .map((candidate) => claims.find((claim) => claim.claimId === candidate.candidateId))
    .filter(Boolean);
  const rankedIds = new Set(ranked.map((claim) => claim.claimId));
  ranked.push(...claims.filter((claim) => !rankedIds.has(claim.claimId)));
  return {
    claims: ranked,
    details: ranked.map((claim) => {
      const result = resultById.get(claim.claimId);
      const matchedFields = uniqueStrings(Object.values(result?.match || {}).flat());
      return rankingDetail(claim, allLegacyClaims, result?.score, matchedFields);
    })
  };
}

function stableRankedClaims(rankedClaims, legacyClaims, details) {
  const detailById = new Map(details.map((item) => [item.claimId, item]));
  return rankedClaims.slice().sort((left, right) => {
    const roleDelta = selectionRoleRank(left.selectionRole) - selectionRoleRank(right.selectionRole);
    if (roleDelta !== 0) return roleDelta;
    const leftDetail = detailById.get(left.claimId);
    const rightDetail = detailById.get(right.claimId);
    const leftMatched = Number.isFinite(leftDetail?.bm25Score);
    const rightMatched = Number.isFinite(rightDetail?.bm25Score);
    if (leftMatched !== rightMatched) return leftMatched ? -1 : 1;
    if (leftMatched && leftDetail.bm25Score !== rightDetail.bm25Score) {
      return rightDetail.bm25Score - leftDetail.bm25Score;
    }
    const legacyDelta = legacyRank(legacyClaims, left.claimId) - legacyRank(legacyClaims, right.claimId);
    if (legacyDelta !== 0) return legacyDelta;
    return String(left.claimId).localeCompare(String(right.claimId), 'en');
  });
}

function orderEvidenceForRequestedClaims(evidenceRows, claimRows) {
  const rows = Array.isArray(evidenceRows) ? evidenceRows : [];
  const claims = Array.isArray(claimRows) ? claimRows : [];
  const order = new Map();
  claims.forEach((claim, claimIndex) => {
    (claim.evidence_ids || claim.evidenceIds || []).forEach((evidenceId, evidenceIndex) => {
      const key = String(evidenceId || '');
      if (!key || order.has(key)) return;
      order.set(key, { claimIndex, evidenceIndex });
    });
  });
  return rows.slice().sort((left, right) => {
    const leftId = String(left.evidence_id || left.evidenceId || '');
    const rightId = String(right.evidence_id || right.evidenceId || '');
    const leftOrder = order.get(leftId) || { claimIndex: Number.MAX_SAFE_INTEGER, evidenceIndex: Number.MAX_SAFE_INTEGER };
    const rightOrder = order.get(rightId) || { claimIndex: Number.MAX_SAFE_INTEGER, evidenceIndex: Number.MAX_SAFE_INTEGER };
    return leftOrder.claimIndex - rightOrder.claimIndex
      || leftOrder.evidenceIndex - rightOrder.evidenceIndex
      || leftId.localeCompare(rightId, 'en');
  });
}

function fuseRankedCandidateSources(sources, options = {}) {
  const normalizedSources = (Array.isArray(sources) ? sources : []).map((source, sourceIndex) => ({
    sourceId: String(source?.sourceId || `source-${sourceIndex + 1}`),
    weight: Number.isFinite(source?.weight) && source.weight > 0 ? source.weight : 1,
    candidateIds: uniqueStrings(source?.candidateIds)
  }));
  const strategy = String(options.strategy || 'single_source');
  if (strategy === 'single_source') {
    if (normalizedSources.length > 1) {
      throw new Error('single_source fusion accepts exactly one candidate source');
    }
    return (normalizedSources[0]?.candidateIds || []).map((candidateId, index) => ({
      candidateId,
      rank: index + 1,
      sourceRanks: { [normalizedSources[0].sourceId]: index + 1 }
    }));
  }
  if (strategy !== 'reciprocal_rank_fusion') {
    throw new Error(`Unsupported knowledge rank fusion strategy: ${strategy}`);
  }

  const k = Number.isFinite(options.k) && options.k >= 1 ? options.k : 60;
  const candidates = new Map();
  normalizedSources.forEach((source, sourceIndex) => {
    source.candidateIds.forEach((candidateId, index) => {
      const rank = index + 1;
      const current = candidates.get(candidateId) || {
        candidateId,
        fusedScore: 0,
        firstSourceIndex: sourceIndex,
        firstSourceRank: rank,
        sourceRanks: {}
      };
      current.fusedScore += source.weight / (k + rank);
      current.firstSourceIndex = Math.min(current.firstSourceIndex, sourceIndex);
      current.firstSourceRank = Math.min(current.firstSourceRank, rank);
      current.sourceRanks[source.sourceId] = rank;
      candidates.set(candidateId, current);
    });
  });
  return [...candidates.values()]
    .sort((left, right) => right.fusedScore - left.fusedScore
      || left.firstSourceIndex - right.firstSourceIndex
      || left.firstSourceRank - right.firstSourceRank
      || left.candidateId.localeCompare(right.candidateId, 'en'))
    .map(({ firstSourceIndex, firstSourceRank, ...candidate }, index) => ({
      ...candidate,
      rank: index + 1
    }));
}

function claimSearchDocument(claim, evidenceById) {
  const evidence = (claim.evidenceIds || []).map((id) => evidenceById.get(id)).filter(Boolean);
  const properties = claim.properties && typeof claim.properties === 'object' ? claim.properties : {};
  return {
    claimId: claim.claimId,
    operatorsText: expandCodeTerms(joinValues(claim.operators)),
    astContextText: joinValues(claim.astContextIds),
    semanticNodeText: joinValues([claim.subjectNodeId, claim.objectNodeId]),
    searchTermsText: joinValues(properties.searchTerms),
    predicateText: joinValues(claim.predicate),
    claimText: String(claim.claimText || ''),
    sectionPathText: joinValues(evidence.map((item) => item.sectionPath)),
    evidenceText: joinValues(evidence.map((item) => item.textContent))
  };
}

function compareSearchResults(left, right, legacyClaims) {
  const leftScore = Number.isFinite(left.score) ? left.score : Number.NEGATIVE_INFINITY;
  const rightScore = Number.isFinite(right.score) ? right.score : Number.NEGATIVE_INFINITY;
  return rightScore - leftScore
    || legacyRank(legacyClaims, left.claimId) - legacyRank(legacyClaims, right.claimId)
    || String(left.claimId).localeCompare(String(right.claimId), 'en');
}

function rankingDetail(claim, legacyClaims, bm25Score, matchedFields) {
  return {
    claimId: claim.claimId,
    selectionRole: normalizedSelectionRole(claim.selectionRole),
    legacyRank: legacyRank(legacyClaims, claim.claimId),
    ...(Number.isFinite(bm25Score) ? { bm25Score } : {}),
    matchedFields: uniqueStrings(matchedFields),
    reasonCodes: [
      `selection_role:${normalizedSelectionRole(claim.selectionRole)}`,
      ...uniqueStrings(matchedFields).map((field) => `bm25_match:${field}`)
    ]
  };
}

function buildRankingAudit({ mode, query, legacyClaims, rankedClaims, details }) {
  const detailById = new Map(details.map((item) => [item.claimId, item]));
  const proposedRankById = new Map(rankedClaims.map((claim, index) => [claim.claimId, index + 1]));
  return {
    schemaVersion: KNOWLEDGE_RANKING_PROFILE.schemaVersion,
    mode,
    profileId: KNOWLEDGE_RANKING_PROFILE_ID,
    profileHash: KNOWLEDGE_RANKING_PROFILE_HASH,
    applied: mode === 'code_evidence_v1',
    shadow: mode === 'shadow_code_evidence_v1',
    queryHash: hashText(query),
    candidateCount: legacyClaims.length,
    legacyClaimIds: legacyClaims.map((claim) => claim.claimId),
    proposedClaimIds: rankedClaims.map((claim) => claim.claimId),
    appliedClaimIds: (mode === 'code_evidence_v1' ? rankedClaims : legacyClaims).map((claim) => claim.claimId),
    candidates: legacyClaims.map((claim, index) => ({
      claimId: claim.claimId,
      selectionRole: normalizedSelectionRole(claim.selectionRole),
      legacyRank: index + 1,
      proposedRank: proposedRankById.get(claim.claimId) || index + 1,
      ...(Number.isFinite(detailById.get(claim.claimId)?.bm25Score)
        ? { bm25Score: detailById.get(claim.claimId).bm25Score }
        : {}),
      matchedFields: detailById.get(claim.claimId)?.matchedFields || [],
      reasonCodes: detailById.get(claim.claimId)?.reasonCodes || []
    }))
  };
}

function normalizedSelectionRole(value) {
  return Object.hasOwn(SELECTION_ROLE_ORDER, value) ? value : 'additional_supporting';
}

function selectionRoleRank(value) {
  return SELECTION_ROLE_ORDER[normalizedSelectionRole(value)];
}

function legacyRank(claims, claimId) {
  const index = claims.findIndex((claim) => claim.claimId === claimId);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index + 1;
}

function joinValues(values) {
  return (Array.isArray(values) ? values : [values])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
}

function expandCodeTerms(value) {
  const text = String(value || '');
  const aliases = [];
  if (text.includes(':=') || /\binitial\b/i.test(text)) aliases.push('operator_initial_value');
  if (containsStandaloneBoundOperator(text) || /\bbound\b/i.test(text)) aliases.push('operator_bound_value');
  if (text.includes(':>>')) aliases.push('operator_redefinition');
  if (text.includes('::>')) aliases.push('operator_reference_subsetting');
  if (text.includes(':>') && !text.includes(':>>') && !text.includes('::>')) aliases.push('operator_specialization');
  return [text, ...aliases].join(' ');
}

function containsStandaloneBoundOperator(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '=') continue;
    const previous = text[index - 1] || '';
    const next = text[index + 1] || '';
    if (!['<', '>', '!', '=', ':'].includes(previous) && !['=', '>'].includes(next)) return true;
  }
  return false;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function hashText(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}

function hashJson(value) {
  return hashText(JSON.stringify(value));
}

module.exports = {
  KNOWLEDGE_RANKING_MODES,
  KNOWLEDGE_RANKING_PROFILE,
  KNOWLEDGE_RANKING_PROFILE_HASH,
  KNOWLEDGE_RANKING_PROFILE_ID,
  expandCodeTerms,
  fuseRankedCandidateSources,
  orderEvidenceForRequestedClaims,
  rankKnowledgeClaims,
  resolveKnowledgeRankingMode
};
