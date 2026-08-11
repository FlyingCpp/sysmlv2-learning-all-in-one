'use strict';

const crypto = require('crypto');

const EXACT_RETRIEVAL_SCHEMA_VERSION = 'sysml-exact-retrieval/v1';
const EXACT_RETRIEVAL_PROFILE_ID = 'sysml-exact-retrieval-v1';
const DEFAULT_RESOURCE_LIMIT = 25;

const SOURCE_ROLE = Object.freeze({
  trusted_question: 'answer',
  trusted_selection: 'supporting',
  trusted_active_model: 'supporting',
  trusted_parser: 'supporting',
  trusted_validator: 'supporting'
});

const SOURCE_ORDER = Object.freeze({
  trusted_question: 0,
  trusted_selection: 1,
  trusted_active_model: 2,
  trusted_parser: 3,
  trusted_validator: 4
});

const EXACT_RETRIEVAL_PROFILE = Object.freeze({
  schemaVersion: EXACT_RETRIEVAL_SCHEMA_VERSION,
  profileId: EXACT_RETRIEVAL_PROFILE_ID,
  trustedSources: SOURCE_ROLE,
  mappingReviewStatus: 'reviewed',
  bindingRoles: ['primary', 'protective'],
  outputRoles: ['required', 'supporting'],
  rolePolicy: {
    answer: { primary: 'required', protective: 'supporting' },
    supporting: { primary: 'supporting', protective: 'supporting' }
  },
  ambiguityPolicy: 'partial_without_context_guessing',
  resourceLimitPolicy: 'stable_truncation_with_incomplete_closure'
});

const EXACT_RETRIEVAL_PROFILE_HASH = hashText(canonicalJson(EXACT_RETRIEVAL_PROFILE));

/**
 * 解析由可信语法出现、Reviewed Syntax Mapping 和 Claim Binding 共同确定的精确闭包。
 * 调用方应传入当前 Active Bundle 的 Mapping；如能取得 Reviewed A1/A2 Claim 集合，
 * 应同时传 reviewedClaimIds，使本函数对绑定进行第二次服务端复核。
 */
function resolveExactRetrievalClosure(input = {}) {
  const intentMode = normalizeIntentMode(input.intentMode);
  const resourceLimit = normalizeResourceLimit(input.resourceLimit);
  const reviewedClaimIds = normalizeOptionalStringSet(input.reviewedClaimIds);
  const normalizedMappings = normalizeMappings(input.mappings);
  const mappingSetHash = normalizeHash(input.mappingSetHash)
    || hashText(canonicalJson(normalizedMappings.map(mappingForHash)));
  const normalizedOccurrences = normalizeOccurrences(input.occurrences, normalizedMappings);
  const trustedOccurrences = normalizedOccurrences.filter((item) => item.sourceRole);
  const ignoredOccurrenceCount = normalizedOccurrences.length - trustedOccurrences.length;

  if (trustedOccurrences.length === 0) {
    return hashResult({
      schemaVersion: EXACT_RETRIEVAL_SCHEMA_VERSION,
      profileId: EXACT_RETRIEVAL_PROFILE_ID,
      profileHash: EXACT_RETRIEVAL_PROFILE_HASH,
      mappingSetHash,
      coverage: 'NONE',
      closureRequirement: 'not_applicable',
      closureStatus: 'not_applicable',
      completeEligible: false,
      trustedOccurrenceCount: 0,
      ignoredOccurrenceCount,
      matchedSyntaxMappingIds: [],
      requiredClaimIds: [],
      supportingClaimIds: [],
      closureClaimIds: [],
      truncatedClaimIds: [],
      closureGaps: [],
      matches: []
    });
  }

  const mappingsByToken = groupMappingsByToken(normalizedMappings);
  const closureGaps = [];
  const selections = [];
  const matchedSyntaxMappingIds = [];
  const matches = [];

  trustedOccurrences.forEach((occurrence, occurrenceRank) => {
    const tokenMappings = mappingsByToken.get(occurrence.token) || [];
    if (tokenMappings.length === 0) {
      addGap(closureGaps, `missing_mapping:${gapPart(occurrence.token)}`);
      matches.push(occurrenceMatchAudit(occurrence, [], 'missing_mapping'));
      return;
    }

    const matchedMappings = matchMappingsForOccurrence(tokenMappings, occurrence);
    if (matchedMappings.length === 0) {
      addGap(closureGaps, `missing_mapping:${gapPart(occurrence.token)}:${contextGapPart(occurrence)}`);
      matches.push(occurrenceMatchAudit(occurrence, [], 'context_not_mapped'));
      return;
    }

    if (isAmbiguousOccurrence(occurrence, matchedMappings, intentMode)) {
      addGap(closureGaps, `ambiguous_ast_context:${gapPart(occurrence.token)}`);
    }

    const matchedForAudit = [];
    matchedMappings.forEach((mapping, mappingRank) => {
      pushUnique(matchedSyntaxMappingIds, mapping.syntaxMappingId);
      const acceptedBindings = [];
      const exactBindings = mapping.retrievalMode === 'candidate_only' ? [] : mapping.claimBindings;
      if (mapping.retrievalMode === 'candidate_only') {
        addGap(closureGaps, `missing_primary_binding:${gapPart(mapping.syntaxMappingId)}`);
      }

      for (const binding of exactBindings) {
        const reviewGap = bindingReviewGap(mapping, binding, reviewedClaimIds);
        if (reviewGap) {
          addGap(closureGaps, reviewGap);
          continue;
        }
        acceptedBindings.push(binding);
      }

      if (!acceptedBindings.some((binding) => binding.role === 'primary')) {
        addGap(closureGaps, `missing_primary_binding:${gapPart(mapping.syntaxMappingId)}`);
      }

      for (const binding of acceptedBindings) {
        const selectionRole = selectionRoleFor(occurrence.sourceRole, binding.role);
        selections.push({
          claimId: binding.claimId,
          selectionRole,
          bindingRole: binding.role,
          occurrenceRank,
          mappingRank,
          ordinal: binding.ordinal,
          syntaxMappingId: mapping.syntaxMappingId
        });
      }
      matchedForAudit.push({
        syntaxMappingId: mapping.syntaxMappingId,
        astContextId: mapping.astContextId,
        retrievalMode: mapping.retrievalMode,
        acceptedClaimIds: acceptedBindings.map((binding) => binding.claimId)
      });
    });
    matches.push(occurrenceMatchAudit(occurrence, matchedForAudit, 'matched'));
  });

  const deduplicated = deduplicateSelections(selections);
  const required = deduplicated.filter((item) => item.selectionRole === 'required');
  const supporting = deduplicated.filter((item) => item.selectionRole === 'supporting');
  const unbounded = [...required, ...supporting];
  const bounded = unbounded.slice(0, resourceLimit);
  const truncated = unbounded.slice(resourceLimit);
  if (truncated.length > 0) {
    addGap(closureGaps, `closure_resource_limit:${unbounded.length}:${resourceLimit}`);
  }

  const requiredClaimIds = bounded
    .filter((item) => item.selectionRole === 'required')
    .map((item) => item.claimId);
  const supportingClaimIds = bounded
    .filter((item) => item.selectionRole === 'supporting')
    .map((item) => item.claimId);
  const closureClaimIds = [...requiredClaimIds, ...supportingClaimIds];
  const completeEligible = closureGaps.length === 0 && closureClaimIds.length > 0;

  return hashResult({
    schemaVersion: EXACT_RETRIEVAL_SCHEMA_VERSION,
    profileId: EXACT_RETRIEVAL_PROFILE_ID,
    profileHash: EXACT_RETRIEVAL_PROFILE_HASH,
    mappingSetHash,
    coverage: completeEligible ? 'COMPLETE' : 'PARTIAL',
    closureRequirement: 'required',
    closureStatus: completeEligible ? 'complete' : 'incomplete',
    completeEligible,
    trustedOccurrenceCount: trustedOccurrences.length,
    ignoredOccurrenceCount,
    matchedSyntaxMappingIds,
    requiredClaimIds,
    supportingClaimIds,
    closureClaimIds,
    truncatedClaimIds: truncated.map((item) => item.claimId),
    closureGaps,
    matches
  });
}

function normalizeMappings(values) {
  return (Array.isArray(values) ? values : [])
    .map((value, index) => normalizeMapping(value, index))
    .filter((mapping) => mapping.syntaxMappingId && mapping.token && mapping.reviewStatus === 'reviewed')
    .sort(compareMappings);
}

function normalizeMapping(value, sourceIndex) {
  const retrieval = value?.retrieval && typeof value.retrieval === 'object' ? value.retrieval : {};
  const suppliedBindings = Array.isArray(value?.claimBindings)
    ? value.claimBindings
    : Array.isArray(retrieval.claimBindings) ? retrieval.claimBindings : [];
  const claimBindings = suppliedBindings.map((binding, index) => normalizeBinding(binding, index));
  addArrayBindings(claimBindings, value?.primaryClaimIds || retrieval.primaryClaimIds, 'primary');
  addArrayBindings(claimBindings, value?.protectiveClaimIds || retrieval.protectiveClaimIds, 'protective');
  return {
    syntaxMappingId: String(value?.syntaxMappingId || value?.syntax_mapping_id || '').trim(),
    token: String(value?.token || '').trim(),
    grammarProductionId: optionalString(value?.grammarProductionId || value?.grammar_production_id),
    retrievalGrammarProductionId: optionalString(
      value?.retrievalGrammarProductionId
      || value?.retrieval_grammar_production_id
      || retrieval.grammarProductionId
    ),
    astContextId: optionalString(value?.astContextId || value?.ast_context_id),
    semanticNodeId: optionalString(value?.semanticNodeId || value?.semantic_node_id),
    semanticFamilyId: optionalString(value?.semanticFamilyId || value?.semantic_family_id || retrieval.semanticFamilyId),
    alternativePath: optionalString(
      value?.alternativePath
      || value?.alternative_path
      || value?.properties?.alternativePath
      || retrieval.alternativePath
    ),
    compositeTokenParts: uniqueStrings(
      value?.compositeTokenParts
      || value?.properties?.compositeTokenParts
      || retrieval.compositeTokenParts
      || []
    ),
    retrievalMode: normalizeRetrievalMode(value?.retrievalMode || value?.retrieval_mode || retrieval.mode, claimBindings),
    contextRequired: value?.contextRequired === true || value?.context_required === true || retrieval.contextRequired === true,
    reviewStatus: String(value?.reviewStatus || value?.review_status || '').trim(),
    claimBindings: deduplicateBindings(claimBindings),
    sourceIndex
  };
}

function normalizeBinding(value, sourceIndex) {
  return {
    claimId: String(value?.claimId || value?.claim_id || '').trim(),
    role: String(value?.role || value?.bindingRole || value?.binding_role || '').trim(),
    ordinal: normalizeOrdinal(value?.ordinal, sourceIndex + 1),
    reviewStatus: optionalString(value?.reviewStatus || value?.review_status || value?.claimReviewStatus),
    authorityLevel: optionalString(value?.authorityLevel || value?.authority_level || value?.claimAuthorityLevel)
  };
}

function addArrayBindings(target, values, role) {
  for (const [index, claimId] of (Array.isArray(values) ? values : []).entries()) {
    target.push(normalizeBinding({ claimId, role, ordinal: index + 1 }, target.length));
  }
}

function deduplicateBindings(bindings) {
  const byClaimId = new Map();
  for (const binding of bindings) {
    if (!binding.claimId || !['primary', 'protective'].includes(binding.role)) continue;
    const current = byClaimId.get(binding.claimId);
    if (!current || compareBindings(binding, current) < 0) byClaimId.set(binding.claimId, binding);
  }
  return [...byClaimId.values()].sort(compareBindings);
}

function normalizeOccurrences(values, mappings = []) {
  const raw = (Array.isArray(values) ? values : [])
    .map((value, sourceIndex) => normalizeOccurrence(value, sourceIndex))
    .filter((item) => item.token);
  const normalized = combineCompositeOccurrences(raw, mappings);
  const seen = new Set();
  return normalized
    .sort(compareOccurrences)
    .filter((item) => {
      const key = canonicalJson([
        item.sourceType,
        item.fileId,
        item.contentHash,
        item.start,
        item.end,
        item.token,
        item.adjacentToPrevious,
        item.observedAstContextId,
        item.astContextIds
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function combineCompositeOccurrences(occurrences, mappings) {
  const compositeMappings = (mappings || [])
    .filter((mapping) => mapping.compositeTokenParts.length > 1)
    .sort((left, right) => right.compositeTokenParts.length - left.compositeTokenParts.length
      || compareMappings(left, right));
  if (compositeMappings.length === 0) return occurrences;
  const ordered = occurrences.slice().sort((left, right) => left.sourceIndex - right.sourceIndex);
  const consumed = new Set();
  const combined = [];
  for (let index = 0; index < ordered.length; index += 1) {
    if (consumed.has(index)) continue;
    const mapping = compositeMappings.find((candidate) => {
      const segment = ordered.slice(index, index + candidate.compositeTokenParts.length);
      return segment.length === candidate.compositeTokenParts.length
        && segment.every((item, offset) => item.token === candidate.compositeTokenParts[offset])
        && segment.every((item) => sameOccurrenceStream(item, segment[0]))
        && segment.every((item, offset) => offset === 0
          || item.sourceIndex === segment[offset - 1].sourceIndex + 1)
        && hasTrustedCompositeAdjacency(segment);
    });
    if (!mapping) {
      combined.push(ordered[index]);
      continue;
    }
    const segment = ordered.slice(index, index + mapping.compositeTokenParts.length);
    segment.forEach((_, offset) => consumed.add(index + offset));
    const observedContexts = uniqueStrings(segment.map((item) => item.observedAstContextId));
    combined.push({
      ...segment[0],
      token: mapping.token,
      end: segment[segment.length - 1].end,
      observedAstContextId: observedContexts.length === 1 ? observedContexts[0] : null,
      astContextIds: uniqueStrings(segment.flatMap((item) => item.astContextIds)),
      sourceIndex: segment[0].sourceIndex
    });
  }
  return combined;
}

function hasTrustedCompositeAdjacency(segment) {
  return segment.every((item, offset) => {
    if (offset === 0) return true;
    const previous = segment[offset - 1];
    if (item.adjacentToPrevious !== true) return false;
    if (!Number.isInteger(previous.end) || !Number.isInteger(item.start)) return false;
    const gap = item.start - previous.end;
    return gap === 0 || gap === 1;
  });
}

function sameOccurrenceStream(left, right) {
  return left.sourceType === right.sourceType
    && left.fileId === right.fileId
    && left.contentHash === right.contentHash;
}

function normalizeOccurrence(value, sourceIndex) {
  const sourceType = String(value?.sourceType || value?.source_type || '').trim();
  const observedAstContextId = optionalString(value?.observedAstContextId || value?.observed_ast_context_id);
  // 官方解析或可信编辑器已经观察到唯一上下文时，不再把问题级宽扩展混入该出现。
  const astContextIds = observedAstContextId
    ? [observedAstContextId]
    : uniqueStrings([
        ...(Array.isArray(value?.astContextIds) ? value.astContextIds : []),
        ...(Array.isArray(value?.expandedAstContextIds) ? value.expandedAstContextIds : [])
      ]);
  return {
    token: String(value?.token || '').trim(),
    sourceType,
    sourceRole: SOURCE_ROLE[sourceType] || '',
    fileId: optionalString(value?.fileId || value?.file_id),
    contentHash: optionalString(value?.contentHash || value?.content_hash),
    start: normalizePosition(value?.start),
    end: normalizePosition(value?.end),
    adjacentToPrevious: value?.adjacentToPrevious === true,
    observedAstContextId,
    astContextIds,
    ambiguous: value?.ambiguous === true,
    sourceIndex
  };
}

function groupMappingsByToken(mappings) {
  const grouped = new Map();
  for (const mapping of mappings) {
    if (!grouped.has(mapping.token)) grouped.set(mapping.token, []);
    grouped.get(mapping.token).push(mapping);
  }
  return grouped;
}

function matchMappingsForOccurrence(mappings, occurrence) {
  const contexts = new Set(occurrence.astContextIds);
  const matched = contexts.size === 0 ? mappings.slice() : mappings
    .filter((mapping) => !mapping.astContextId || contexts.has(mapping.astContextId))
  return suppressSemanticallySupersededCandidates(matched)
    .sort((left, right) => mappingContextRank(left, occurrence) - mappingContextRank(right, occurrence)
      || compareMappings(left, right));
}

function suppressSemanticallySupersededCandidates(mappings) {
  const exactSignatures = new Set(mappings
    .filter((mapping) => mapping.retrievalMode === 'exact_closure')
    .map(mappingSemanticSignature));
  return mappings.filter((mapping) => mapping.retrievalMode !== 'candidate_only'
    || !exactSignatures.has(mappingSemanticSignature(mapping)));
}

function isAmbiguousOccurrence(occurrence, mappings, intentMode) {
  if (intentMode === 'compare_operator_semantics') return false;
  if (occurrence.ambiguous) return true;
  const semanticSignatures = uniqueStrings(mappings.map(mappingSemanticSignature));
  if (!occurrence.observedAstContextId && semanticSignatures.length > 1) return true;
  if (occurrence.astContextIds.length === 0 && mappings.some((mapping) => mapping.contextRequired)) return true;
  return false;
}

function mappingSemanticSignature(mapping) {
  const primaryClaimIds = mapping.claimBindings
    .filter((binding) => binding.role === 'primary')
    .map((binding) => binding.claimId)
    .sort();
  return canonicalJson([
    mapping.semanticFamilyId || mapping.semanticNodeId || '',
    primaryClaimIds
  ]);
}

function bindingReviewGap(mapping, binding, reviewedClaimIds) {
  if (binding.reviewStatus && binding.reviewStatus !== 'reviewed') {
    return `unreviewed_claim_binding:${gapPart(mapping.syntaxMappingId)}:${gapPart(binding.claimId)}`;
  }
  if (binding.authorityLevel && !['A1', 'A2'].includes(binding.authorityLevel)) {
    return `unreviewed_claim_binding:${gapPart(mapping.syntaxMappingId)}:${gapPart(binding.claimId)}`;
  }
  if (reviewedClaimIds && !reviewedClaimIds.has(binding.claimId)) {
    return `unreviewed_claim_binding:${gapPart(mapping.syntaxMappingId)}:${gapPart(binding.claimId)}`;
  }
  return '';
}

function selectionRoleFor(sourceRole, bindingRole) {
  return sourceRole === 'answer' && bindingRole === 'primary' ? 'required' : 'supporting';
}

function deduplicateSelections(selections) {
  const byClaimId = new Map();
  for (const selection of selections.slice().sort(compareSelections)) {
    const current = byClaimId.get(selection.claimId);
    if (!current || compareSelections(selection, current) < 0) byClaimId.set(selection.claimId, selection);
  }
  return [...byClaimId.values()].sort(compareSelections);
}

function compareSelections(left, right) {
  return selectionRoleRank(left.selectionRole) - selectionRoleRank(right.selectionRole)
    || left.occurrenceRank - right.occurrenceRank
    || left.mappingRank - right.mappingRank
    || left.ordinal - right.ordinal
    || left.syntaxMappingId.localeCompare(right.syntaxMappingId, 'en')
    || left.claimId.localeCompare(right.claimId, 'en');
}

function compareMappings(left, right) {
  return left.token.localeCompare(right.token, 'en')
    || String(left.astContextId || '').localeCompare(String(right.astContextId || ''), 'en')
    || left.syntaxMappingId.localeCompare(right.syntaxMappingId, 'en')
    || left.sourceIndex - right.sourceIndex;
}

function compareBindings(left, right) {
  return bindingRoleRank(left.role) - bindingRoleRank(right.role)
    || left.ordinal - right.ordinal
    || left.claimId.localeCompare(right.claimId, 'en');
}

function compareOccurrences(left, right) {
  return sourceRank(left.sourceType) - sourceRank(right.sourceType)
    || String(left.contentHash || '').localeCompare(String(right.contentHash || ''), 'en')
    || String(left.fileId || '').localeCompare(String(right.fileId || ''), 'en')
    || left.start - right.start
    || left.end - right.end
    || left.token.localeCompare(right.token, 'en')
    || left.sourceIndex - right.sourceIndex;
}

function mappingContextRank(mapping, occurrence) {
  if (occurrence.observedAstContextId && mapping.astContextId === occurrence.observedAstContextId) return 0;
  if (mapping.astContextId && occurrence.astContextIds.includes(mapping.astContextId)) return 1;
  return 2;
}

function occurrenceMatchAudit(occurrence, mappings, status) {
  return {
    token: occurrence.token,
    sourceType: occurrence.sourceType,
    sourceRole: occurrence.sourceRole,
    observedAstContextId: occurrence.observedAstContextId,
    astContextIds: occurrence.astContextIds,
    status,
    mappings
  };
}

function mappingForHash(mapping) {
  return {
    syntaxMappingId: mapping.syntaxMappingId,
    token: mapping.token,
    grammarProductionId: mapping.grammarProductionId,
    retrievalGrammarProductionId: mapping.retrievalGrammarProductionId,
    astContextId: mapping.astContextId,
    semanticNodeId: mapping.semanticNodeId,
    semanticFamilyId: mapping.semanticFamilyId,
    alternativePath: mapping.alternativePath,
    compositeTokenParts: mapping.compositeTokenParts,
    retrievalMode: mapping.retrievalMode,
    contextRequired: mapping.contextRequired,
    reviewStatus: mapping.reviewStatus,
    claimBindings: mapping.claimBindings
  };
}

function normalizeRetrievalMode(value, claimBindings) {
  const normalized = String(value || '').trim();
  if (['exact_closure', 'candidate_only'].includes(normalized)) return normalized;
  return claimBindings.length > 0 ? 'exact_closure' : 'legacy';
}

function normalizeIntentMode(value) {
  const normalized = String(value || '').trim();
  return ['compare_operator_semantics', 'explain_occurrence', 'general_semantic_search'].includes(normalized)
    ? normalized
    : 'general_semantic_search';
}

function normalizeResourceLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_RESOURCE_LIMIT;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 100) {
    throw new Error('SysML exact retrieval resourceLimit must be an integer from 1 to 100');
  }
  return numeric;
}

function normalizeOrdinal(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizePosition(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : Number.MAX_SAFE_INTEGER;
}

function normalizeOptionalStringSet(values) {
  if (values === undefined || values === null) return null;
  return new Set(uniqueStrings(values instanceof Set ? [...values] : values));
}

function normalizeHash(value) {
  const text = String(value || '').trim();
  return /^sha256:[a-f0-9]{64}$/u.test(text) ? text : '';
}

function optionalString(value) {
  const text = String(value || '').trim();
  return text || null;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function sourceRank(sourceType) {
  return Object.hasOwn(SOURCE_ORDER, sourceType) ? SOURCE_ORDER[sourceType] : 99;
}

function selectionRoleRank(value) {
  return value === 'required' ? 0 : 1;
}

function bindingRoleRank(value) {
  return value === 'primary' ? 0 : 1;
}

function addGap(gaps, value) {
  if (!gaps.includes(value)) gaps.push(value);
}

function pushUnique(values, value) {
  if (!values.includes(value)) values.push(value);
}

function gapPart(value) {
  return encodeURIComponent(String(value || 'unknown'));
}

function contextGapPart(occurrence) {
  return gapPart(occurrence.astContextIds.length > 0 ? occurrence.astContextIds.join(',') : 'unresolved');
}

function hashResult(result) {
  return { ...result, resultHash: hashText(canonicalJson(result)) };
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
  DEFAULT_RESOURCE_LIMIT,
  EXACT_RETRIEVAL_PROFILE,
  EXACT_RETRIEVAL_PROFILE_HASH,
  EXACT_RETRIEVAL_PROFILE_ID,
  EXACT_RETRIEVAL_SCHEMA_VERSION,
  resolveExactRetrievalClosure
};
