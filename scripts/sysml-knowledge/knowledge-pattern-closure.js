'use strict';

const crypto = require('crypto');

const REQUIRED_FIXTURE_KINDS = Object.freeze(['complete', 'missing_boundary', 'forbidden_inference']);

function evaluateKnowledgePatternClosure({ outline, scope, bundle, fixtureCatalog, sourceManifest }) {
  const records = normalizeRecords(bundle);
  const nodesById = byId(records.nodes, 'nodeId');
  const edgesById = byId(records.edges, 'edgeId');
  const claimsById = byId(records.claims, 'claimId');
  const evidenceById = byId(records.evidenceBlocks, 'evidenceId');
  const overlaysById = byId(records.teachingOverlays, 'overlayId');
  const patternsById = byId(records.knowledgePatterns, 'patternId');
  const fixturesById = byId(fixtureCatalog?.fixtures || [], 'fixtureId');
  const sourcesById = byId(sourceManifest?.sources || [], 'sourceId');

  const outlineObjectives = (outline?.domains || []).flatMap((domain) =>
    (domain.objectives || []).map((objective) => ({ ...objective, domainId: domain.domainId }))
  );
  const scopeObjectives = scope?.objectives || [];
  const outlineIds = new Set(outlineObjectives.map((objective) => objective.objectiveId));
  const scopeIds = new Set(scopeObjectives.map((objective) => objective.objectiveId));
  const scopeGaps = [];

  if (outlineIds.size !== outlineObjectives.length) scopeGaps.push(gap('DUPLICATE_OUTLINE_OBJECTIVE'));
  if (scopeIds.size !== scopeObjectives.length) scopeGaps.push(gap('DUPLICATE_SCOPE_OBJECTIVE'));
  for (const objectiveId of outlineIds) {
    if (!scopeIds.has(objectiveId)) scopeGaps.push(gap('MISSING_SCOPE_OBJECTIVE', { objectiveId }));
  }
  for (const objective of scopeObjectives) {
    if (!outlineIds.has(objective.objectiveId)) scopeGaps.push(gap('UNKNOWN_SCOPE_OBJECTIVE', { objectiveId: objective.objectiveId }));
    for (const nodeId of objective.anchorNodeIds || []) {
      if (!nodesById.has(nodeId)) scopeGaps.push(gap('UNKNOWN_SCOPE_ANCHOR', { objectiveId: objective.objectiveId, nodeId }));
    }
  }

  const patternResults = records.knowledgePatterns.map((pattern) => evaluatePattern({
    pattern,
    outlineIds,
    nodesById,
    edgesById,
    claimsById,
    evidenceById,
    overlaysById,
    fixturesById,
    sourcesById
  }));
  const patternResultsById = byId(patternResults, 'patternId');

  const fixtureResults = (fixtureCatalog?.fixtures || []).map((fixture) => evaluateFixture({
    fixture,
    pattern: patternsById.get(fixture.patternId),
    patternResult: patternResultsById.get(fixture.patternId),
    outlineIds,
    nodesById,
    edgesById,
    claimsById,
    evidenceById,
    overlaysById,
    fixturesById,
    sourcesById
  }));
  const objectiveResults = outlineObjectives.map((objective) => {
    const scopeEntry = scopeObjectives.find((item) => item.objectiveId === objective.objectiveId);
    const claims = records.claims.filter((claim) => (claim.properties?.examObjectiveIds || []).includes(objective.objectiveId));
    const evidenceIds = [...new Set(claims.flatMap((claim) => claim.evidenceIds || []))];
    const patterns = records.knowledgePatterns.filter((pattern) => pattern.examObjectiveIds.includes(objective.objectiveId));
    const status = claims.length === 0 || evidenceIds.length === 0
      ? 'missing'
      : 'partial';
    return {
      objectiveId: objective.objectiveId,
      domainId: objective.domainId,
      topic: objective.topic,
      studentCapability: scopeEntry?.studentCapability || null,
      anchorNodeIds: scopeEntry?.anchorNodeIds || [],
      claimIds: claims.map((claim) => claim.claimId),
      evidenceIds,
      patternIds: patterns.map((pattern) => pattern.patternId),
      status
    };
  });

  const gates = {
    scopeCompleteness: gateResult(scopeGaps, outlineObjectives.length),
    patternClosure: gateResult(patternResults.flatMap((result) => result.gaps), patternResults.length),
    semanticFixtures: gateResult(fixtureResults.flatMap((result) => result.gaps), fixtureResults.length)
  };
  const gaps = [
    ...scopeGaps,
    ...patternResults.flatMap((result) => result.gaps),
    ...fixtureResults.flatMap((result) => result.gaps)
  ];
  const result = {
    schemaVersion: 'model-user-knowledge-pattern-closure/v1',
    scopeId: scope?.scopeId || null,
    fixtureSetId: fixtureCatalog?.fixtureSetId || null,
    status: gaps.length === 0 ? 'PASS' : 'FAIL',
    counts: {
      objectives: outlineObjectives.length,
      completeObjectives: objectiveResults.filter((item) => item.status === 'complete').length,
      partialObjectives: objectiveResults.filter((item) => item.status === 'partial').length,
      missingObjectives: objectiveResults.filter((item) => item.status === 'missing').length,
      patterns: patternResults.length,
      closedPatterns: patternResults.filter((item) => item.status === 'PASS').length,
      fixtures: fixtureResults.length,
      passingFixtures: fixtureResults.filter((item) => item.status === 'PASS').length
    },
    gates,
    gaps,
    objectives: objectiveResults,
    patterns: patternResults,
    fixtures: fixtureResults
  };
  return { ...result, resultHash: hashText(canonicalJson(result)) };
}

function evaluatePattern({ pattern, outlineIds, nodesById, edgesById, claimsById, evidenceById, overlaysById, fixturesById, sourcesById }) {
  const gaps = [];
  if (!pattern) return { patternId: null, status: 'FAIL', gaps: [gap('MISSING_PATTERN')] };
  for (const objectiveId of pattern.examObjectiveIds || []) {
    if (!outlineIds.has(objectiveId)) {
      gaps.push(gap('UNKNOWN_PATTERN_OBJECTIVE', { patternId: pattern.patternId, objectiveId }));
    }
  }
  for (const nodeId of pattern.anchorNodeIds || []) {
    if (!nodesById.has(nodeId)) gaps.push(gap('MISSING_PATTERN_NODE', { patternId: pattern.patternId, nodeId }));
  }
  for (const edgeId of pattern.requiredEdgeIds || []) {
    if (!edgesById.has(edgeId)) gaps.push(gap('MISSING_PATTERN_EDGE', { patternId: pattern.patternId, edgeId }));
  }
  for (const claimId of pattern.requiredClaimIds || []) {
    const claim = claimsById.get(claimId);
    if (!claim) {
      gaps.push(gap('MISSING_PATTERN_CLAIM', { patternId: pattern.patternId, claimId }));
      continue;
    }
    for (const evidenceId of claim.evidenceIds || []) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) {
        gaps.push(gap('MISSING_PATTERN_EVIDENCE', { patternId: pattern.patternId, claimId, evidenceId }));
        continue;
      }
      const authority = evidence.authorityLevel || sourcesById.get(evidence.sourceId)?.authorityLevel;
      if (!['A1', 'A2'].includes(authority)) {
        gaps.push(gap('INSUFFICIENT_PATTERN_AUTHORITY', { patternId: pattern.patternId, claimId, evidenceId }));
      }
    }
  }
  for (const guardrailId of pattern.guardrailIds || []) {
    if (!overlaysById.has(guardrailId)) gaps.push(gap('MISSING_PATTERN_GUARDRAIL', { patternId: pattern.patternId, guardrailId }));
  }
  const fixtureKinds = new Set();
  for (const fixtureId of pattern.fixtureIds || []) {
    const fixture = fixturesById.get(fixtureId);
    if (!fixture || fixture.patternId !== pattern.patternId) {
      gaps.push(gap('MISSING_PATTERN_FIXTURE', { patternId: pattern.patternId, fixtureId }));
    } else {
      fixtureKinds.add(fixture.kind);
    }
  }
  for (const kind of REQUIRED_FIXTURE_KINDS) {
    if (!fixtureKinds.has(kind)) gaps.push(gap('MISSING_PATTERN_FIXTURE_KIND', { patternId: pattern.patternId, kind }));
  }
  return { patternId: pattern.patternId, status: gaps.length === 0 ? 'PASS' : 'FAIL', gaps };
}

function evaluateFixture({ fixture, pattern, patternResult, outlineIds, nodesById, edgesById, claimsById, evidenceById, overlaysById, fixturesById, sourcesById }) {
  const gaps = [];
  if (!pattern) {
    gaps.push(gap('FIXTURE_UNKNOWN_PATTERN', { fixtureId: fixture.fixtureId, patternId: fixture.patternId }));
  } else if (fixture.kind === 'complete') {
    if (patternResult?.status !== 'PASS' || fixture.expectedOutcome !== 'COMPLETE') {
      gaps.push(gap('COMPLETE_FIXTURE_FAILED', { fixtureId: fixture.fixtureId, patternId: fixture.patternId }));
    }
  } else if (fixture.kind === 'missing_boundary') {
    const omitted = new Set([
      ...(fixture.omitClaimIds || []),
      ...(fixture.omitEdgeIds || []),
      ...(fixture.omitGuardrailIds || [])
    ]);
    const removedRequiredAsset = omitted.size > 0 && [...omitted].every((id) =>
      (pattern.requiredClaimIds || []).includes(id)
      || (pattern.requiredEdgeIds || []).includes(id)
      || (pattern.guardrailIds || []).includes(id)
    );
    const availableClaims = new Map(claimsById);
    const availableEdges = new Map(edgesById);
    const availableOverlays = new Map(overlaysById);
    for (const id of fixture.omitClaimIds || []) availableClaims.delete(id);
    for (const id of fixture.omitEdgeIds || []) availableEdges.delete(id);
    for (const id of fixture.omitGuardrailIds || []) availableOverlays.delete(id);
    const reduced = evaluatePattern({
      pattern,
      outlineIds,
      nodesById,
      edgesById: availableEdges,
      claimsById: availableClaims,
      evidenceById,
      overlaysById: availableOverlays,
      fixturesById,
      sourcesById
    });
    if (patternResult?.status !== 'PASS' || !removedRequiredAsset || reduced.status !== 'FAIL'
      || fixture.expectedOutcome !== 'PARTIAL') {
      gaps.push(gap('MISSING_BOUNDARY_FIXTURE_FAILED', { fixtureId: fixture.fixtureId, patternId: fixture.patternId }));
    }
  } else if (fixture.kind === 'forbidden_inference') {
    const matched = (pattern.guardrailIds || []).filter((guardrailId) => {
      const overlay = overlaysById.get(guardrailId);
      return (overlay?.patternSpec || []).some((spec) => patternMatches(spec, fixture.answerText));
    });
    const expected = fixture.expectedGuardrailIds || [];
    if (fixture.expectedOutcome !== 'GUARDED' || canonicalJson(matched) !== canonicalJson(expected)) {
      gaps.push(gap('FORBIDDEN_INFERENCE_FIXTURE_FAILED', { fixtureId: fixture.fixtureId, patternId: fixture.patternId, matched, expected }));
    }
  } else {
    gaps.push(gap('UNKNOWN_FIXTURE_KIND', { fixtureId: fixture.fixtureId, kind: fixture.kind }));
  }
  return { fixtureId: fixture.fixtureId, patternId: fixture.patternId, kind: fixture.kind, status: gaps.length === 0 ? 'PASS' : 'FAIL', gaps };
}

function patternMatches(spec, text) {
  const value = String(spec?.value || '');
  const candidate = String(text || '');
  if (spec?.kind === 'substring') return candidate.includes(value);
  if (spec?.kind === 'regex') return new RegExp(value, 'u').test(candidate);
  return false;
}

function normalizeRecords(bundle) {
  const source = bundle?.records || bundle || {};
  return {
    nodes: source['nodes.jsonl'] || source.nodes || [],
    edges: source['edges.jsonl'] || source.edges || [],
    claims: source['claims.jsonl'] || source.claims || [],
    evidenceBlocks: source['evidence-blocks.jsonl'] || source.evidenceBlocks || [],
    teachingOverlays: source['teaching-overlays.jsonl'] || source.teachingOverlays || [],
    knowledgePatterns: source['knowledge-patterns.jsonl'] || source.knowledgePatterns || []
  };
}

function byId(items, field) {
  return new Map((items || []).map((item) => [item?.[field], item]).filter(([id]) => Boolean(id)));
}

function gateResult(gaps, denominator) {
  return { status: gaps.length === 0 ? 'PASS' : 'FAIL', denominator, failures: gaps.length };
}

function gap(code, details = {}) {
  return { code, ...details };
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
  REQUIRED_FIXTURE_KINDS,
  evaluateKnowledgePatternClosure
};
