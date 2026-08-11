'use strict';

function materializeReviewedKnowledgePatterns(patterns, records) {
  if (!Array.isArray(patterns)) {
    throw new Error('Knowledge patterns must be an explicit array');
  }

  const nodeIds = recordIds(records, 'nodes.jsonl', 'nodeId');
  const edgeIds = recordIds(records, 'edges.jsonl', 'edgeId');
  const claimIds = recordIds(records, 'claims.jsonl', 'claimId');
  const overlayIds = recordIds(records, 'teaching-overlays.jsonl', 'overlayId');
  const patternIds = new Set();

  return patterns.map((pattern) => {
    const patternId = requiredString(pattern?.patternId, 'patternId');
    if (patternIds.has(patternId)) throw new Error(`Duplicate Knowledge Pattern: ${patternId}`);
    patternIds.add(patternId);

    const examObjectiveIds = requiredUniqueStrings(pattern.examObjectiveIds, patternId, 'examObjectiveIds');
    const anchorNodeIds = requiredUniqueStrings(pattern.anchorNodeIds, patternId, 'anchorNodeIds');
    const requiredClaimIds = requiredUniqueStrings(pattern.requiredClaimIds, patternId, 'requiredClaimIds');
    const requiredEdgeIds = requiredUniqueStrings(pattern.requiredEdgeIds, patternId, 'requiredEdgeIds');
    const guardrailIds = requiredUniqueStrings(pattern.guardrailIds, patternId, 'guardrailIds');
    const fixtureIds = requiredUniqueStrings(pattern.fixtureIds, patternId, 'fixtureIds');

    assertReferences(anchorNodeIds, nodeIds, patternId, 'Node');
    assertReferences(requiredClaimIds, claimIds, patternId, 'Claim');
    assertReferences(requiredEdgeIds, edgeIds, patternId, 'Edge');
    assertReferences(guardrailIds, overlayIds, patternId, 'Guardrail');

    return {
      patternId,
      title: requiredString(pattern.title, `${patternId}.title`),
      description: requiredString(pattern.description, `${patternId}.description`),
      examObjectiveIds,
      anchorNodeIds,
      requiredClaimIds,
      requiredEdgeIds,
      guardrailIds,
      fixtureIds,
      reviewStatus: 'reviewed',
      properties: pattern.properties || {}
    };
  });
}

function recordIds(records, fileName, fieldName) {
  const rows = records?.[fileName];
  if (!Array.isArray(rows)) throw new Error(`Knowledge Pattern validation requires ${fileName}`);
  return new Set(rows.map((row) => row?.[fieldName]).filter(Boolean));
}

function requiredString(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`Knowledge Pattern ${label} is required`);
  return normalized;
}

function requiredUniqueStrings(values, patternId, fieldName) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`Knowledge Pattern ${patternId} requires ${fieldName}`);
  }
  const normalized = values.map((value) => requiredString(value, `${patternId}.${fieldName}`));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Knowledge Pattern ${patternId} has duplicate ${fieldName}`);
  }
  return normalized;
}

function assertReferences(values, validIds, patternId, label) {
  for (const value of values) {
    if (!validIds.has(value)) {
      throw new Error(`Knowledge Pattern ${patternId} references unknown ${label} ${value}`);
    }
  }
}

module.exports = {
  materializeReviewedKnowledgePatterns
};
