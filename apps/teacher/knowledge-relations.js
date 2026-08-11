'use strict';

const crypto = require('crypto');

const KNOWLEDGE_RELATION_PROFILE_ID = 'knowledge-relations-v1';
const KNOWLEDGE_RELATION_SCHEMA_VERSION = 'sysml-knowledge-relation/v1';

const RELATION_RULES = Object.freeze({
  normative_semantic: Object.freeze({
    SPECIALIZES: ['semantic_node', 'semantic_node'],
    TYPED_BY: ['semantic_node', 'semantic_node'],
    MEMBER_OF: ['semantic_node', 'semantic_node'],
    OWNED_BY: ['semantic_node', 'semantic_node'],
    USES_RELATIONSHIP: ['semantic_node', 'semantic_node']
  }),
  derived_semantic: Object.freeze({
    ABOUT: ['claim', 'semantic_node'],
    USES_OPERATOR: ['claim', 'operator'],
    APPLIES_IN_AST_CONTEXT: ['claim', 'ast_context'],
    EVIDENCED_BY: ['claim', 'evidence'],
    COVERS_KNOWN_POINT: ['claim', 'known_point'],
    COVERS_EXAM_OBJECTIVE: ['claim', 'exam_objective']
  }),
  pedagogical: Object.freeze({
    PREREQUISITE: ['claim', 'claim'],
    REFINES: ['claim', 'claim'],
    CONTRASTS: ['claim', 'claim']
  }),
  diagnostic: Object.freeze({
    DIAGNOSES_WITH: ['diagnostic_concept', 'claim'],
    DISAMBIGUATES_WITH: ['diagnostic_concept', 'claim']
  }),
  repair: Object.freeze({
    APPLIES_TO_DIAGNOSTIC: ['repair_overlay', 'diagnostic_concept'],
    SUPPORTED_BY_CLAIM: ['repair_overlay', 'claim']
  })
});

const EXPLICIT_LAYERS = new Set(['pedagogical', 'diagnostic', 'repair']);
const EXPLICIT_REVIEW_STATUSES = new Set(['candidate', 'reviewed', 'rejected']);

const KNOWLEDGE_RELATION_PROFILE_HASH = hashText(canonicalJson({
  schemaVersion: KNOWLEDGE_RELATION_SCHEMA_VERSION,
  profileId: KNOWLEDGE_RELATION_PROFILE_ID,
  rules: RELATION_RULES
}));

function deriveKnowledgeRelations(records = {}) {
  const edges = records['edges.jsonl'] || records.edges || [];
  const claims = records['claims.jsonl'] || records.claims || [];
  const relations = [];

  for (const edge of edges) {
    if (!RELATION_RULES.normative_semantic[edge.predicate]) continue;
    relations.push(materializeRelation({
      relationLayer: 'normative_semantic',
      predicate: edge.predicate,
      sourceKind: 'semantic_node',
      sourceId: edge.sourceNodeId,
      targetKind: 'semantic_node',
      targetId: edge.targetNodeId,
      authorityLevel: edge.authorityLevel,
      reviewStatus: 'reviewed',
      conditions: [],
      evidenceIds: [],
      fixtureIds: [],
      basisClaimIds: [],
      provenance: {
        method: 'semantic_edge_projection',
        profileId: KNOWLEDGE_RELATION_PROFILE_ID,
        sourceRecordId: edge.edgeId,
        sourceId: edge.sourceId || undefined,
        sourceLocator: edge.sourceLocator || undefined
      },
      properties: edge.properties || {}
    }));
  }

  for (const claim of claims) {
    const common = {
      relationLayer: 'derived_semantic',
      sourceKind: 'claim',
      sourceId: claim.claimId,
      authorityLevel: claim.authorityLevel,
      reviewStatus: 'derived',
      conditions: [],
      evidenceIds: uniqueStrings(claim.evidenceIds),
      fixtureIds: [],
      basisClaimIds: [claim.claimId],
      provenance: {
        method: 'deterministic_bundle_projection',
        profileId: KNOWLEDGE_RELATION_PROFILE_ID,
        profileHash: KNOWLEDGE_RELATION_PROFILE_HASH
      },
      properties: {}
    };
    for (const nodeId of uniqueStrings([claim.subjectNodeId, claim.objectNodeId])) {
      relations.push(materializeRelation({
        ...common,
        predicate: 'ABOUT',
        targetKind: 'semantic_node',
        targetId: nodeId
      }));
    }
    for (const operator of uniqueStrings(claim.operators)) {
      relations.push(materializeRelation({
        ...common,
        predicate: 'USES_OPERATOR',
        targetKind: 'operator',
        targetId: operator
      }));
    }
    for (const astContextId of uniqueStrings(claim.astContextIds)) {
      relations.push(materializeRelation({
        ...common,
        predicate: 'APPLIES_IN_AST_CONTEXT',
        targetKind: 'ast_context',
        targetId: astContextId
      }));
    }
    for (const evidenceId of uniqueStrings(claim.evidenceIds)) {
      relations.push(materializeRelation({
        ...common,
        predicate: 'EVIDENCED_BY',
        targetKind: 'evidence',
        targetId: evidenceId
      }));
    }
    for (const knownPointId of uniqueStrings(claim.properties?.knownPointIds)) {
      relations.push(materializeRelation({
        ...common,
        predicate: 'COVERS_KNOWN_POINT',
        targetKind: 'known_point',
        targetId: knownPointId
      }));
    }
    for (const examObjectiveId of uniqueStrings(claim.properties?.examObjectiveIds)) {
      relations.push(materializeRelation({
        ...common,
        predicate: 'COVERS_EXAM_OBJECTIVE',
        targetKind: 'exam_objective',
        targetId: examObjectiveId
      }));
    }
  }
  return sortRelations(relations);
}

function materializeKnowledgeRelationCandidate(proposal, trusted = {}) {
  const relationLayer = String(proposal?.relationLayer || '');
  if (!EXPLICIT_LAYERS.has(relationLayer)) {
    throw new Error('Relation candidates are limited to pedagogical, diagnostic, or repair layers');
  }
  const relation = materializeRelation({
    relationLayer,
    predicate: proposal.predicate,
    sourceKind: proposal.sourceKind,
    sourceId: proposal.sourceId,
    targetKind: proposal.targetKind,
    targetId: proposal.targetId,
    authorityLevel: 'C2',
    reviewStatus: 'candidate',
    conditions: proposal.conditions,
    evidenceIds: proposal.evidenceIds,
    fixtureIds: proposal.fixtureIds,
    basisClaimIds: proposal.basisClaimIds,
    provenance: {
      method: 'server_materialized_candidate',
      profileId: KNOWLEDGE_RELATION_PROFILE_ID,
      proposedBy: String(trusted.proposedBy || 'unknown'),
      proposalHash: hashText(canonicalJson(proposal || {}))
    },
    properties: {
      rationale: String(proposal.rationale || '').trim()
    }
  });
  assertRelationShape(relation);
  assertExplicitProof(relation);
  return relation;
}

function materializeReviewedKnowledgeRelations(authoringRelations, records = {}, options = {}) {
  const relations = (authoringRelations || []).map((relation) => materializeRelation({
    ...relation,
    reviewStatus: relation.reviewStatus || 'reviewed',
    provenance: {
      ...(relation.provenance || {}),
      method: 'reviewed_authoring',
      profileId: KNOWLEDGE_RELATION_PROFILE_ID
    }
  }, { verifySuppliedIdentity: true }));
  validateKnowledgeRelationSet(relations, records, { ...options, allowCandidates: false });
  return sortRelations(relations);
}

function validateKnowledgeRelationSet(relations, records = {}, options = {}) {
  const claimIds = new Set((records['claims.jsonl'] || records.claims || []).map((item) => item.claimId));
  const nodeIds = new Set((records['nodes.jsonl'] || records.nodes || []).map((item) => item.nodeId));
  const evidenceIds = new Set((records['evidence-blocks.jsonl'] || records.evidenceBlocks || []).map((item) => item.evidenceId));
  const diagnosticConceptIds = new Set(options.diagnosticConceptIds || []);
  const repairOverlayIds = new Set(options.repairOverlayIds || []);
  const fixtureIds = new Set(options.fixtureIds || []);
  const relationIds = new Set();

  for (const relation of relations || []) {
    assertRelationShape(relation);
    if (relationIds.has(relation.relationId)) throw new Error(`Duplicate relationId: ${relation.relationId}`);
    relationIds.add(relation.relationId);
    if (!options.allowCandidates && relation.reviewStatus === 'candidate') {
      throw new Error(`Candidate relation cannot enter a validated Bundle: ${relation.relationId}`);
    }
    assertEndpointExists(relation.sourceKind, relation.sourceId, { claimIds, nodeIds, evidenceIds, diagnosticConceptIds, repairOverlayIds });
    assertEndpointExists(relation.targetKind, relation.targetId, { claimIds, nodeIds, evidenceIds, diagnosticConceptIds, repairOverlayIds });
    for (const evidenceId of relation.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) throw new Error(`Relation ${relation.relationId} references unknown Evidence ${evidenceId}`);
    }
    for (const claimId of relation.basisClaimIds) {
      if (!claimIds.has(claimId)) throw new Error(`Relation ${relation.relationId} references unknown basis Claim ${claimId}`);
    }
    if (fixtureIds.size > 0) {
      for (const fixtureId of relation.fixtureIds) {
        if (!fixtureIds.has(fixtureId)) throw new Error(`Relation ${relation.relationId} references unknown fixture ${fixtureId}`);
      }
    }
    if (EXPLICIT_LAYERS.has(relation.relationLayer)) assertExplicitProof(relation);
  }
  assertPrerequisiteAcyclic(relations || []);
  assertContrastsSymmetric(relations || []);
  return true;
}

function materializeRelation(input, options = {}) {
  const normalized = {
    schemaVersion: KNOWLEDGE_RELATION_SCHEMA_VERSION,
    relationLayer: String(input?.relationLayer || ''),
    predicate: String(input?.predicate || ''),
    sourceKind: String(input?.sourceKind || ''),
    sourceId: String(input?.sourceId || ''),
    targetKind: String(input?.targetKind || ''),
    targetId: String(input?.targetId || ''),
    authorityLevel: String(input?.authorityLevel || ''),
    reviewStatus: String(input?.reviewStatus || ''),
    conditions: uniqueStrings(input?.conditions),
    evidenceIds: uniqueStrings(input?.evidenceIds),
    fixtureIds: uniqueStrings(input?.fixtureIds),
    basisClaimIds: uniqueStrings(input?.basisClaimIds),
    provenance: normalizeObject(input?.provenance),
    properties: normalizeObject(input?.properties)
  };
  const relationHash = hashText(canonicalJson(normalized));
  const relationId = `rel-${relationHash.slice('sha256:'.length, 'sha256:'.length + 24)}`;
  if (options.verifySuppliedIdentity) {
    if (input.relationId && input.relationId !== relationId) throw new Error(`Relation ID mismatch: ${input.relationId}`);
    if (input.relationHash && input.relationHash !== relationHash) throw new Error(`Relation hash mismatch: ${input.relationId || relationId}`);
  }
  return { relationId, relationHash, ...normalized };
}

function assertRelationShape(relation) {
  const endpoints = RELATION_RULES[relation.relationLayer]?.[relation.predicate];
  if (!endpoints) throw new Error(`Unsupported relation layer/predicate: ${relation.relationLayer}/${relation.predicate}`);
  if (relation.sourceKind !== endpoints[0] || relation.targetKind !== endpoints[1]) {
    throw new Error(`Invalid endpoints for ${relation.relationLayer}/${relation.predicate}: ${relation.sourceKind}->${relation.targetKind}`);
  }
  if (!relation.sourceId || !relation.targetId) throw new Error('Knowledge relation endpoints are required');
  if (relation.sourceId === relation.targetId && relation.sourceKind === relation.targetKind) {
    throw new Error(`Knowledge relation self-loop is not allowed: ${relation.relationId}`);
  }
  const expected = materializeRelation(relation);
  if (expected.relationId !== relation.relationId || expected.relationHash !== relation.relationHash) {
    throw new Error(`Knowledge relation identity/hash is invalid: ${relation.relationId || ''}`);
  }
  if (EXPLICIT_LAYERS.has(relation.relationLayer) && !EXPLICIT_REVIEW_STATUSES.has(relation.reviewStatus)) {
    throw new Error(`Explicit relation has an invalid review status: ${relation.reviewStatus}`);
  }
  if (relation.relationLayer === 'derived_semantic' && relation.reviewStatus !== 'derived') {
    throw new Error('Derived semantic relations must use reviewStatus=derived');
  }
  if (relation.relationLayer === 'normative_semantic' && relation.reviewStatus !== 'reviewed') {
    throw new Error('Normative semantic projections must be reviewed');
  }
}

function assertExplicitProof(relation) {
  if (relation.conditions.length === 0) throw new Error(`Explicit relation requires conditions: ${relation.relationId}`);
  if (relation.evidenceIds.length + relation.fixtureIds.length + relation.basisClaimIds.length === 0) {
    throw new Error(`Explicit relation requires Evidence, fixture, or basis Claim: ${relation.relationId}`);
  }
  if (['diagnostic', 'repair'].includes(relation.relationLayer) && relation.fixtureIds.length === 0) {
    throw new Error(`${relation.relationLayer} relation requires a Validator fixture: ${relation.relationId}`);
  }
  if (relation.relationLayer === 'repair' && relation.basisClaimIds.length === 0) {
    throw new Error(`Repair relation requires a supporting Claim: ${relation.relationId}`);
  }
}

function assertEndpointExists(kind, id, sets) {
  if (kind === 'claim' && !sets.claimIds.has(id)) throw new Error(`Unknown Claim endpoint: ${id}`);
  if (kind === 'semantic_node' && !sets.nodeIds.has(id)) throw new Error(`Unknown SemanticNode endpoint: ${id}`);
  if (kind === 'evidence' && !sets.evidenceIds.has(id)) throw new Error(`Unknown Evidence endpoint: ${id}`);
  if (kind === 'diagnostic_concept' && sets.diagnosticConceptIds.size > 0 && !sets.diagnosticConceptIds.has(id)) {
    throw new Error(`Unknown DiagnosticConcept endpoint: ${id}`);
  }
  if (kind === 'repair_overlay' && sets.repairOverlayIds.size > 0 && !sets.repairOverlayIds.has(id)) {
    throw new Error(`Unknown RepairOverlay endpoint: ${id}`);
  }
}

function assertPrerequisiteAcyclic(relations) {
  const graph = new Map();
  for (const relation of relations.filter((item) => item.relationLayer === 'pedagogical' && item.predicate === 'PREREQUISITE')) {
    graph.set(relation.sourceId, [...(graph.get(relation.sourceId) || []), relation.targetId]);
  }
  const active = new Set();
  const visited = new Set();
  const visit = (nodeId) => {
    if (active.has(nodeId)) throw new Error(`PREREQUISITE cycle detected at ${nodeId}`);
    if (visited.has(nodeId)) return;
    active.add(nodeId);
    for (const targetId of graph.get(nodeId) || []) visit(targetId);
    active.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of graph.keys()) visit(nodeId);
}

function assertContrastsSymmetric(relations) {
  const contrasts = relations.filter((item) => item.relationLayer === 'pedagogical' && item.predicate === 'CONTRASTS');
  for (const relation of contrasts) {
    const reverse = contrasts.find((item) => item.sourceId === relation.targetId && item.targetId === relation.sourceId);
    if (!reverse) throw new Error(`CONTRASTS relation requires a reverse relation: ${relation.relationId}`);
    if (proofFingerprint(reverse) !== proofFingerprint(relation)) {
      throw new Error(`CONTRASTS reverse proof mismatch: ${relation.relationId}`);
    }
  }
}

function proofFingerprint(relation) {
  return hashText(canonicalJson({
    authorityLevel: relation.authorityLevel,
    reviewStatus: relation.reviewStatus,
    conditions: relation.conditions,
    evidenceIds: relation.evidenceIds,
    fixtureIds: relation.fixtureIds,
    basisClaimIds: relation.basisClaimIds,
    properties: relation.properties
  }));
}

function relationRow(relation, bundleId) {
  return [
    relation.relationId,
    bundleId,
    relation.relationHash,
    relation.relationLayer,
    relation.predicate,
    relation.sourceKind,
    relation.sourceId,
    relation.targetKind,
    relation.targetId,
    relation.authorityLevel,
    relation.reviewStatus,
    relation.conditions,
    relation.evidenceIds,
    relation.fixtureIds,
    relation.basisClaimIds,
    JSON.stringify(relation.provenance),
    JSON.stringify(relation.properties)
  ];
}

function sortRelations(relations) {
  return [...relations].sort((left, right) => left.relationId.localeCompare(right.relationId));
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))].sort();
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : {};
}

function hashText(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

module.exports = {
  KNOWLEDGE_RELATION_PROFILE_HASH,
  KNOWLEDGE_RELATION_PROFILE_ID,
  KNOWLEDGE_RELATION_SCHEMA_VERSION,
  RELATION_RULES,
  canonicalJson,
  deriveKnowledgeRelations,
  hashText,
  materializeKnowledgeRelationCandidate,
  materializeRelation,
  materializeReviewedKnowledgeRelations,
  relationRow,
  validateKnowledgeRelationSet
};
