'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  EXPECTED_CAPABILITY_UNIT_IDS,
  EXPECTED_CAPABILITY_UNIT_SET_HASH,
  EXPECTED_MODEL_USER_OBJECTIVE_IDS,
  EXPECTED_MODEL_USER_OBJECTIVE_SET_HASH
} = require('./model-user-v005-catalog');

const EVALUATOR_ID = 'sysml-capability-closure/v1';
const REQUIRED_PHASE_IDS = Object.freeze(['P0', 'P1', 'P2', 'P3', 'P4']);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MODEL_USER_REPRESENTATION_IDS = Object.freeze(['natural-language', 'textual', 'graphical']);
const KNOWLEDGE_CLOSED_REPRESENTATION_IDS = Object.freeze(['natural-language', 'textual']);
const CAPABILITY_GLOBAL_GAP_CODES = Object.freeze(new Set([
  'DUPLICATE_CAPABILITY_UNIT',
  'MISSING_PLATFORM_PHASE',
  'UNKNOWN_PLATFORM_PHASE',
  'INVALID_EXPECTED_CAPABILITY_UNIT_IDS',
  'INVALID_EXPECTED_CAPABILITY_UNIT_SET_HASH',
  'CAPABILITY_UNIT_SET_MISMATCH',
  'INVALID_EXPECTED_CAPABILITY_COUNTS'
]));
const OBJECTIVE_GLOBAL_GAP_CODES = Object.freeze(new Set([
  'DUPLICATE_OBJECTIVE_REQUIREMENT',
  'DUPLICATE_OUTLINE_OBJECTIVE',
  'INVALID_EXPECTED_MODEL_USER_OBJECTIVE_IDS',
  'INVALID_EXPECTED_MODEL_USER_OBJECTIVE_SET_HASH',
  'MODEL_USER_OBJECTIVE_REQUIREMENT_SET_MISMATCH',
  'MODEL_USER_OUTLINE_OBJECTIVE_SET_MISMATCH',
  'INVALID_EXPECTED_CAPABILITY_COUNTS'
]));
const CLAIM_EVIDENCE_BINDING_GAP_CODES = Object.freeze(new Set([
  'MISSING_CAPABILITY_CLAIM',
  'MISSING_CAPABILITY_EVIDENCE',
  'MISSING_EVIDENCE_SOURCE',
  'INVALID_SOURCE_ARTIFACT_HASH',
  'SOURCE_ARTIFACT_MISSING',
  'SOURCE_ARTIFACT_HASH_MISMATCH',
  'SOURCE_PATH_OUTSIDE_PROJECT',
  'INVALID_EVIDENCE_LINE_RANGE',
  'EVIDENCE_LINE_RANGE_OUT_OF_BOUNDS',
  'MISSING_EVIDENCE_TEXT',
  'INVALID_EVIDENCE_TEXT_HASH',
  'EVIDENCE_TEXT_HASH_MISMATCH',
  'EVIDENCE_SOURCE_SPAN_MISMATCH',
  'EVIDENCE_TEXT_SOURCE_MISMATCH',
  'EVIDENCE_AUTHORITY_MISMATCH',
  'INSUFFICIENT_CAPABILITY_AUTHORITY'
]));

function evaluateCapabilityClosure({
  outline,
  capabilityScope,
  bundle,
  sourceManifest,
  officialSourceCatalog,
  productionResponsibilities
}) {
  const records = normalizeRecords(bundle);
  const requireMaterializedEvidence = Boolean(bundle?.records || bundle?.['evidence-blocks.jsonl']);
  const capabilityUnits = capabilityScope?.capabilityUnits || [];
  const objectiveRequirements = capabilityScope?.modelUserObjectiveRequirements || [];
  const responsibilities = productionResponsibilities?.responsibilities
    || productionResponsibilities
    || records.productionResponsibilities;
  const claimsById = byId(records.claims, 'claimId');
  const evidenceById = byId(records.evidenceBlocks, 'evidenceId');
  const sourcesById = byId(sourceManifest?.sources || [], 'sourceId');
  const capabilityById = byId(capabilityUnits, 'capabilityUnitId');
  const outlineObjectives = (outline?.domains || []).flatMap((domain) =>
    (domain.objectives || []).map((objective) => ({ ...objective, domainId: domain.domainId }))
  );
  const outlineIds = new Set(outlineObjectives.map((item) => item.objectiveId));
  const objectiveRequirementById = byId(objectiveRequirements, 'objectiveId');
  const responsibilityBindings = groupResponsibilityBindings(responsibilities || []);
  const officialFiles = normalizeOfficialFiles(officialSourceCatalog);
  const globalGaps = [];
  const sourceInspectionCache = new Map();

  validateUnique(capabilityUnits, 'capabilityUnitId', 'DUPLICATE_CAPABILITY_UNIT', globalGaps);
  validateUnique(objectiveRequirements, 'objectiveId', 'DUPLICATE_OBJECTIVE_REQUIREMENT', globalGaps);
  validateUnique(outlineObjectives, 'objectiveId', 'DUPLICATE_OUTLINE_OBJECTIVE', globalGaps);
  validatePhaseInventory(capabilityUnits, globalGaps);
  validateLockedExpectedSets({
    capabilityScope,
    capabilityUnits,
    objectiveRequirements,
    outlineObjectives,
    globalGaps
  });

  const capabilityResults = capabilityUnits.map((capability) => evaluateCapability({
    capability,
    claimsById,
    evidenceById,
    sourcesById,
    outlineIds,
    responsibilityBindings,
    officialFiles,
    sourceInspectionCache,
    requireMaterializedEvidence
  }));
  const capabilityResultById = byId(capabilityResults, 'capabilityUnitId');

  for (const requirement of objectiveRequirements) {
    if (!outlineIds.has(requirement.objectiveId)) {
      globalGaps.push(gap('UNKNOWN_MODEL_USER_OBJECTIVE', { objectiveId: requirement.objectiveId }));
    }
    for (const capabilityUnitId of requirement.requiredCapabilityUnitIds || []) {
      if (!capabilityById.has(capabilityUnitId)) {
        globalGaps.push(gap('UNKNOWN_OBJECTIVE_CAPABILITY', {
          objectiveId: requirement.objectiveId,
          capabilityUnitId
        }));
      }
    }
  }

  const objectiveResults = outlineObjectives.map((objective) => {
    const requirement = objectiveRequirementById.get(objective.objectiveId);
    const mappingGaps = [];
    if (!requirement) {
      mappingGaps.push(gap('MISSING_OBJECTIVE_REQUIREMENT', { objectiveId: objective.objectiveId }));
    }
    const requiredCapabilityUnitIds = requirement?.requiredCapabilityUnitIds || [];
    if (requiredCapabilityUnitIds.length === 0) {
      mappingGaps.push(gap('EMPTY_OBJECTIVE_CAPABILITY_SET', { objectiveId: objective.objectiveId }));
    }
    for (const capabilityUnitId of requiredCapabilityUnitIds) {
      const result = capabilityResultById.get(capabilityUnitId);
      if (!result) {
        mappingGaps.push(gap('OBJECTIVE_CAPABILITY_MISSING', {
          objectiveId: objective.objectiveId,
          capabilityUnitId
        }));
      }
    }
    const requiredRepresentations = requirement?.requiredRepresentations || [];
    if (!sameIdSet(requiredRepresentations, MODEL_USER_REPRESENTATION_IDS)) {
      mappingGaps.push(gap('INVALID_OBJECTIVE_REPRESENTATION_SET', {
        objectiveId: objective.objectiveId,
        expectedIds: [...MODEL_USER_REPRESENTATION_IDS],
        actualIds: sortedUnique(requiredRepresentations)
      }));
    }
    const closedRepresentations = requiredRepresentations
      .filter((representationId) => KNOWLEDGE_CLOSED_REPRESENTATION_IDS.includes(representationId));
    const missingRepresentations = requiredRepresentations
      .filter((representationId) => !KNOWLEDGE_CLOSED_REPRESENTATION_IDS.includes(representationId));
    const mappingStatus = mappingGaps.length === 0 ? 'complete' : 'incomplete';
    const status = mappingStatus === 'incomplete'
      ? 'incomplete'
      : missingRepresentations.length > 0 ? 'partial' : 'complete';
    return {
      objectiveId: objective.objectiveId,
      domainId: objective.domainId,
      topic: objective.topic,
      requiredCapabilityUnitIds,
      requiredRepresentations,
      closedRepresentations,
      missingRepresentations,
      mappingStatus,
      capabilityStatus: requiredCapabilityUnitIds.every((capabilityUnitId) =>
        capabilityResultById.get(capabilityUnitId)?.status === 'complete') ? 'complete' : 'incomplete',
      status,
      gaps: mappingGaps
    };
  });

  const capabilityGaps = capabilityResults.flatMap((item) => item.gaps);
  const objectiveGaps = objectiveResults.flatMap((item) => item.gaps);
  const allGaps = [...globalGaps, ...capabilityGaps, ...objectiveGaps];
  const completeCapabilities = EXPECTED_CAPABILITY_UNIT_IDS.filter((capabilityUnitId) =>
    capabilityResultById.get(capabilityUnitId)?.status === 'complete').length;
  const mappedObjectives = objectiveResults.filter((item) => item.mappingStatus === 'complete').length;
  const completeObjectives = objectiveResults.filter((item) => item.status === 'complete').length;
  const partialObjectives = objectiveResults.filter((item) => item.status === 'partial').length;
  const claimEvidenceFailures = capabilityResults.reduce((total, item) =>
    total + item.gaps.filter((itemGap) => CLAIM_EVIDENCE_BINDING_GAP_CODES.has(itemGap.code)).length, 0);
  const officialBindingFailures = capabilityResults.reduce((total, item) =>
    total + item.gaps.filter((itemGap) => [
      'MISSING_OFFICIAL_EXAMPLE_TOPIC',
      'MISSING_OFFICIAL_LIBRARY_ASSET'
    ].includes(itemGap.code)).length, 0);
  const capabilityGlobalFailure = globalGaps.some((item) => CAPABILITY_GLOBAL_GAP_CODES.has(item.code));
  const objectiveGlobalFailure = globalGaps.some((item) => OBJECTIVE_GLOBAL_GAP_CODES.has(item.code));
  const gates = {
    p0p4CapabilityClosure: gate(
      completeCapabilities,
      EXPECTED_CAPABILITY_UNIT_IDS.length,
      capabilityGlobalFailure
    ),
    modelUserObjectiveMappingCompleteness: gate(
      mappedObjectives,
      EXPECTED_MODEL_USER_OBJECTIVE_IDS.length,
      objectiveGlobalFailure
    ),
    authoritativeClaimEvidenceBindingIntegrity: {
      status: claimEvidenceFailures === 0 ? 'PASS' : 'FAIL',
      failures: claimEvidenceFailures,
      assertionBoundary: 'binding_source_authority_span_text_and_hash_integrity_only_not_semantic_entailment'
    },
    officialSourceExampleBinding: {
      status: officialBindingFailures === 0 ? 'PASS' : 'FAIL',
      failures: officialBindingFailures
    }
  };
  const status = Object.values(gates).every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
  const phaseCounts = Object.fromEntries(REQUIRED_PHASE_IDS.map((phaseId) => [phaseId, {
    total: capabilityResults.filter((item) => item.phaseId === phaseId).length,
    complete: capabilityResults.filter((item) => item.phaseId === phaseId && item.status === 'complete').length
  }]));
  const graphicalCount = graphicalBnfCount(officialSourceCatalog);
  const representationStatus = completeObjectives === EXPECTED_MODEL_USER_OBJECTIVE_IDS.length
    ? 'PASS'
    : 'PARTIAL';
  const report = {
    schemaVersion: 'sysml-capability-closure-report/v1',
    evaluatorId: EVALUATOR_ID,
    status,
    counts: {
      capabilityUnits: capabilityResults.length,
      expectedCapabilityUnits: EXPECTED_CAPABILITY_UNIT_IDS.length,
      completeCapabilities,
      modelUserObjectives: objectiveResults.length,
      expectedModelUserObjectives: EXPECTED_MODEL_USER_OBJECTIVE_IDS.length,
      mappedModelUserObjectives: mappedObjectives,
      completeModelUserObjectives: completeObjectives,
      partialModelUserObjectives: partialObjectives,
      productionResponsibilities: (responsibilities || []).length,
      officialTrainingFiles: officialFiles.training.length,
      officialLibraryFiles: officialFiles.libraries.length,
      phases: phaseCounts,
      gaps: allGaps.length
    },
    gates,
    expectedSets: {
      capabilityUnitIds: [...EXPECTED_CAPABILITY_UNIT_IDS],
      capabilityUnitSetHash: EXPECTED_CAPABILITY_UNIT_SET_HASH,
      modelUserObjectiveIds: [...EXPECTED_MODEL_USER_OBJECTIVE_IDS],
      modelUserObjectiveSetHash: EXPECTED_MODEL_USER_OBJECTIVE_SET_HASH
    },
    modelUserRepresentationClosure: {
      status: representationStatus,
      completeObjectives,
      partialObjectives,
      totalObjectives: EXPECTED_MODEL_USER_OBJECTIVE_IDS.length,
      ratio: completeObjectives / EXPECTED_MODEL_USER_OBJECTIVE_IDS.length,
      publicationGate: false,
      boundary: 'informational_until_graphical_rendering_and_validation_are_closed'
    },
    representationCoverage: {
      status: representationStatus,
      naturalLanguage: 'knowledge_closed',
      textual: 'knowledge_closed',
      graphical: graphicalCount > 0 ? 'official_scope_registered_not_rendering_validator_closed' : 'missing',
      graphicalBnfUniqueProductions: graphicalCount,
      fullyClosedModelUserObjectives: completeObjectives,
      partialModelUserObjectives: partialObjectives,
      totalModelUserObjectives: EXPECTED_MODEL_USER_OBJECTIVE_IDS.length
    },
    claimEvidenceGovernance: {
      status: claimEvidenceFailures === 0 ? 'BINDING_INTEGRITY_PASS' : 'BINDING_INTEGRITY_FAIL',
      semanticEntailment: 'NOT_ASSERTED_REQUIRES_INDEPENDENT_CLAIM_BY_CLAIM_REVIEW',
      authoritySourceOfTruth: 'source_manifest_only'
    },
    capabilities: capabilityResults,
    objectives: objectiveResults,
    gaps: allGaps
  };
  return { ...report, resultHash: hashCanonical(report) };
}

function evaluateCapability({
  capability,
  claimsById,
  evidenceById,
  sourcesById,
  outlineIds,
  responsibilityBindings,
  officialFiles,
  sourceInspectionCache,
  requireMaterializedEvidence
}) {
  const gaps = [];
  const requiredAuthorities = new Set(capability.requiredEvidenceAuthorities || ['A1', 'A2']);
  const claimIds = capability.requiredClaimIds || [];
  if (claimIds.length === 0) {
    gaps.push(gap('EMPTY_CAPABILITY_CLAIM_SET', { capabilityUnitId: capability.capabilityUnitId }));
  }
  for (const claimId of claimIds) {
    const claim = claimsById.get(claimId);
    if (!claim) {
      gaps.push(gap('MISSING_CAPABILITY_CLAIM', { capabilityUnitId: capability.capabilityUnitId, claimId }));
      continue;
    }
    if (!Array.isArray(claim.evidenceIds) || claim.evidenceIds.length === 0) {
      gaps.push(gap('MISSING_CAPABILITY_EVIDENCE', { capabilityUnitId: capability.capabilityUnitId, claimId }));
      continue;
    }
    for (const evidenceId of claim.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) {
        gaps.push(gap('MISSING_CAPABILITY_EVIDENCE', {
          capabilityUnitId: capability.capabilityUnitId,
          claimId,
          evidenceId
        }));
        continue;
      }
      const source = sourcesById.get(evidence.sourceId);
      if (!source) {
        gaps.push(gap('MISSING_EVIDENCE_SOURCE', {
          capabilityUnitId: capability.capabilityUnitId,
          claimId,
          evidenceId,
          sourceId: evidence.sourceId || null
        }));
        continue;
      }
      for (const integrityGap of validateEvidenceBindingIntegrity({
        evidence,
        source,
        sourceInspectionCache,
        requireMaterializedEvidence
      })) {
        gaps.push({
          ...integrityGap,
          capabilityUnitId: capability.capabilityUnitId,
          claimId,
          evidenceId,
          sourceId: source.sourceId
        });
      }
      const authority = source.authorityLevel;
      if (evidence.authorityLevel && evidence.authorityLevel !== authority) {
        gaps.push(gap('EVIDENCE_AUTHORITY_MISMATCH', {
          capabilityUnitId: capability.capabilityUnitId,
          claimId,
          evidenceId,
          sourceId: source.sourceId,
          evidenceAuthority: evidence.authorityLevel,
          sourceAuthority: authority || null
        }));
      }
      if (!requiredAuthorities.has(authority)) {
        gaps.push(gap('INSUFFICIENT_CAPABILITY_AUTHORITY', {
          capabilityUnitId: capability.capabilityUnitId,
          claimId,
          evidenceId,
          authority: authority || null
        }));
      }
    }
  }
  for (const objectiveId of capability.modelUserObjectiveIds || []) {
    if (!outlineIds.has(objectiveId)) {
      gaps.push(gap('UNKNOWN_CAPABILITY_OBJECTIVE', {
        capabilityUnitId: capability.capabilityUnitId,
        objectiveId
      }));
    }
  }
  if (capability.productionBindingRequired !== false
    && !(responsibilityBindings.get(capability.capabilityUnitId) || []).length) {
    gaps.push(gap('MISSING_CAPABILITY_PRODUCTION_BINDING', {
      capabilityUnitId: capability.capabilityUnitId
    }));
  }
  for (const topicId of capability.officialExampleTopicIds || []) {
    if (!officialFiles.training.some((item) => trainingTopic(item.path) === topicId)) {
      gaps.push(gap('MISSING_OFFICIAL_EXAMPLE_TOPIC', {
        capabilityUnitId: capability.capabilityUnitId,
        topicId
      }));
    }
  }
  for (const pattern of capability.officialLibraryGlobs || []) {
    if (!officialFiles.libraries.some((item) => globMatches(pattern, item.path))) {
      gaps.push(gap('MISSING_OFFICIAL_LIBRARY_ASSET', {
        capabilityUnitId: capability.capabilityUnitId,
        pattern
      }));
    }
  }
  return {
    capabilityUnitId: capability.capabilityUnitId,
    phaseId: capability.phaseId,
    title: capability.title,
    requiredClaimIds: claimIds,
    modelUserObjectiveIds: capability.modelUserObjectiveIds || [],
    productionResponsibilityCount: (responsibilityBindings.get(capability.capabilityUnitId) || []).length,
    status: gaps.length === 0 ? 'complete' : 'incomplete',
    gaps
  };
}

function validateLockedExpectedSets({
  capabilityScope,
  capabilityUnits,
  objectiveRequirements,
  outlineObjectives,
  globalGaps
}) {
  validateDeclaredExpectedSet({
    declaredIds: capabilityScope?.expectedCapabilityUnitIds,
    declaredHash: capabilityScope?.expectedCapabilityUnitSetHash,
    lockedIds: EXPECTED_CAPABILITY_UNIT_IDS,
    lockedHash: EXPECTED_CAPABILITY_UNIT_SET_HASH,
    idCode: 'INVALID_EXPECTED_CAPABILITY_UNIT_IDS',
    hashCode: 'INVALID_EXPECTED_CAPABILITY_UNIT_SET_HASH',
    gaps: globalGaps
  });
  validateDeclaredExpectedSet({
    declaredIds: capabilityScope?.expectedModelUserObjectiveIds,
    declaredHash: capabilityScope?.expectedModelUserObjectiveSetHash,
    lockedIds: EXPECTED_MODEL_USER_OBJECTIVE_IDS,
    lockedHash: EXPECTED_MODEL_USER_OBJECTIVE_SET_HASH,
    idCode: 'INVALID_EXPECTED_MODEL_USER_OBJECTIVE_IDS',
    hashCode: 'INVALID_EXPECTED_MODEL_USER_OBJECTIVE_SET_HASH',
    gaps: globalGaps
  });
  validateActualIdSet({
    actualIds: capabilityUnits.map((item) => item.capabilityUnitId),
    expectedIds: EXPECTED_CAPABILITY_UNIT_IDS,
    code: 'CAPABILITY_UNIT_SET_MISMATCH',
    gaps: globalGaps
  });
  validateActualIdSet({
    actualIds: objectiveRequirements.map((item) => item.objectiveId),
    expectedIds: EXPECTED_MODEL_USER_OBJECTIVE_IDS,
    code: 'MODEL_USER_OBJECTIVE_REQUIREMENT_SET_MISMATCH',
    gaps: globalGaps
  });
  validateActualIdSet({
    actualIds: outlineObjectives.map((item) => item.objectiveId),
    expectedIds: EXPECTED_MODEL_USER_OBJECTIVE_IDS,
    code: 'MODEL_USER_OUTLINE_OBJECTIVE_SET_MISMATCH',
    gaps: globalGaps
  });
  if (capabilityScope?.expectedCounts?.capabilityUnits !== EXPECTED_CAPABILITY_UNIT_IDS.length
    || capabilityScope?.expectedCounts?.modelUserObjectives !== EXPECTED_MODEL_USER_OBJECTIVE_IDS.length) {
    globalGaps.push(gap('INVALID_EXPECTED_CAPABILITY_COUNTS', {
      expected: {
        capabilityUnits: EXPECTED_CAPABILITY_UNIT_IDS.length,
        modelUserObjectives: EXPECTED_MODEL_USER_OBJECTIVE_IDS.length
      },
      actual: capabilityScope?.expectedCounts || null
    }));
  }
}

function validateDeclaredExpectedSet({
  declaredIds,
  declaredHash,
  lockedIds,
  lockedHash,
  idCode,
  hashCode,
  gaps
}) {
  if (!sameIdSet(declaredIds, lockedIds)) {
    gaps.push(gap(idCode, idSetDifference(lockedIds, declaredIds)));
  }
  if (declaredHash !== lockedHash || hashIdSet(declaredIds || []) !== lockedHash) {
    gaps.push(gap(hashCode, {
      expectedHash: lockedHash,
      actualHash: declaredHash || null,
      computedHash: hashIdSet(declaredIds || [])
    }));
  }
}

function validateActualIdSet({ actualIds, expectedIds, code, gaps }) {
  if (!sameIdSet(actualIds, expectedIds)) {
    gaps.push(gap(code, idSetDifference(expectedIds, actualIds)));
  }
}

function validateEvidenceBindingIntegrity({
  evidence,
  source,
  sourceInspectionCache,
  requireMaterializedEvidence
}) {
  const gaps = [];
  const inspection = inspectSourceArtifact(source, sourceInspectionCache);
  gaps.push(...inspection.gaps);
  const lineStart = evidence.lineStart;
  const lineEnd = evidence.lineEnd;
  const validLineRange = Number.isInteger(lineStart)
    && Number.isInteger(lineEnd)
    && lineStart >= 1
    && lineEnd >= lineStart;
  if (!validLineRange) {
    gaps.push(gap('INVALID_EVIDENCE_LINE_RANGE', { lineStart: lineStart ?? null, lineEnd: lineEnd ?? null }));
    return gaps;
  }
  if (inspection.lines && lineEnd > inspection.lines.length) {
    gaps.push(gap('EVIDENCE_LINE_RANGE_OUT_OF_BOUNDS', {
      lineStart,
      lineEnd,
      sourceLineCount: inspection.lines.length
    }));
  }

  const hasTextContent = typeof evidence.textContent === 'string';
  const hasTextHash = typeof evidence.textHash === 'string';
  if (hasTextContent || hasTextHash) {
    if (!hasTextContent || !evidence.textContent.trim()) {
      gaps.push(gap('MISSING_EVIDENCE_TEXT'));
    }
    if (!hasTextHash || !isSha256(evidence.textHash)) {
      gaps.push(gap('INVALID_EVIDENCE_TEXT_HASH', { textHash: evidence.textHash || null }));
    } else if (hasTextContent && hashText(evidence.textContent) !== evidence.textHash) {
      gaps.push(gap('EVIDENCE_TEXT_HASH_MISMATCH', {
        expectedHash: evidence.textHash,
        actualHash: hashText(evidence.textContent)
      }));
    }
    if (hasTextContent && inspection.lines && lineEnd <= inspection.lines.length) {
      const expectedText = inspection.lines.slice(lineStart - 1, lineEnd).join('\n').trim();
      if (evidence.textContent !== expectedText) {
        gaps.push(gap('EVIDENCE_SOURCE_SPAN_MISMATCH', {
          expectedHash: hashText(expectedText),
          actualHash: hashText(evidence.textContent)
        }));
      }
    }
    if (hasTextContent && inspection.lines && lineEnd <= inspection.lines.length) {
      const sourceText = inspection.lines.slice(lineStart - 1, lineEnd).join('\n').trim();
      if (sourceText !== evidence.textContent) {
        gaps.push(gap('EVIDENCE_TEXT_SOURCE_MISMATCH', {
          sourceTextHash: hashText(sourceText),
          evidenceTextHash: hashText(evidence.textContent)
        }));
      }
    }
  } else if (requireMaterializedEvidence) {
    gaps.push(gap('MISSING_EVIDENCE_TEXT'));
    gaps.push(gap('INVALID_EVIDENCE_TEXT_HASH', { textHash: null }));
  } else if (inspection.lines && lineEnd <= inspection.lines.length) {
    // Authoring records keep the locked source span only. The Bundle builder materializes textContent/textHash.
    // At this stage verify that both values are deterministically derivable from a non-empty locked span.
    const derivedText = inspection.lines.slice(lineStart - 1, lineEnd).join('\n').trim();
    if (!derivedText.trim() || !isSha256(hashText(derivedText))) {
      gaps.push(gap('MISSING_EVIDENCE_TEXT'));
    }
  }
  return gaps;
}

function inspectSourceArtifact(source, cache) {
  const cacheKey = source?.sourceId || source?.path || JSON.stringify(source || {});
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const gaps = [];
  const artifactHash = source?.artifactHash;
  if (!isSha256(artifactHash)) {
    gaps.push(gap('INVALID_SOURCE_ARTIFACT_HASH', { artifactHash: artifactHash || null }));
  }
  const resolvedPath = path.resolve(PROJECT_ROOT, String(source?.path || ''));
  const relativePath = path.relative(PROJECT_ROOT, resolvedPath);
  if (!source?.path || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    gaps.push(gap('SOURCE_PATH_OUTSIDE_PROJECT', { path: source?.path || null }));
    const result = { gaps, lines: null };
    cache.set(cacheKey, result);
    return result;
  }
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    gaps.push(gap('SOURCE_ARTIFACT_MISSING', { path: source.path }));
    const result = { gaps, lines: null };
    cache.set(cacheKey, result);
    return result;
  }
  const bytes = fs.readFileSync(resolvedPath);
  const actualHash = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  if (isSha256(artifactHash) && artifactHash !== actualHash) {
    gaps.push(gap('SOURCE_ARTIFACT_HASH_MISMATCH', {
      path: source.path,
      expectedHash: artifactHash,
      actualHash
    }));
  }
  const result = {
    gaps,
    lines: bytes.toString('utf8').split(/\r?\n/u)
  };
  cache.set(cacheKey, result);
  return result;
}

function normalizeRecords(bundle) {
  const source = bundle?.records || bundle || {};
  return {
    claims: source['claims.jsonl'] || source.claims || [],
    evidenceBlocks: source['evidence-blocks.jsonl'] || source.evidenceBlocks || [],
    productionResponsibilities: source['production-responsibilities.jsonl'] || source.productionResponsibilities || []
  };
}

function normalizeOfficialFiles(catalog) {
  const imported = catalog?.imported?.files || [];
  const training = catalog?.trainingFiles || catalog?.files?.training || catalog?.training?.files
    || imported.filter((item) => item.kind === 'training-model') || [];
  const libraries = catalog?.standardLibraryFiles || catalog?.libraryFiles
    || catalog?.files?.libraries || catalog?.libraries?.files
    || imported.filter((item) => item.kind === 'standard-library-model') || [];
  return {
    training: normalizeFileRecords(training).map((item) => ({
      ...item,
      path: stripThrough(item.path, '/training/')
    })),
    libraries: normalizeFileRecords(libraries).map((item) => ({
      ...item,
      path: stripThrough(item.path, '/sysml.library/')
    }))
  };
}

function normalizeFileRecords(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    path: normalizePath(typeof item === 'string'
      ? item
      : item?.path || item?.relativePath || item?.outputPath || item?.sourcePath),
    hash: typeof item === 'string' ? null : item?.hash || item?.sha256 || item?.artifactHash || null
  })).filter((item) => item.path);
}

function groupResponsibilityBindings(responsibilities) {
  const result = new Map();
  for (const responsibility of responsibilities || []) {
    for (const capabilityUnitId of responsibility.capabilityUnitIds || []) {
      if (!result.has(capabilityUnitId)) result.set(capabilityUnitId, []);
      result.get(capabilityUnitId).push(responsibility.productionId);
    }
  }
  return result;
}

function validatePhaseInventory(capabilityUnits, gaps) {
  for (const phaseId of REQUIRED_PHASE_IDS) {
    if (!capabilityUnits.some((item) => item.phaseId === phaseId)) {
      gaps.push(gap('MISSING_PLATFORM_PHASE', { phaseId }));
    }
  }
  for (const capability of capabilityUnits) {
    if (!REQUIRED_PHASE_IDS.includes(capability.phaseId)) {
      gaps.push(gap('UNKNOWN_PLATFORM_PHASE', {
        capabilityUnitId: capability.capabilityUnitId,
        phaseId: capability.phaseId || null
      }));
    }
  }
}

function validateUnique(items, field, code, gaps) {
  const counts = new Map();
  for (const item of items || []) {
    const id = String(item?.[field] || '');
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  for (const [id, count] of counts) {
    if (!id || count > 1) gaps.push(gap(code, { [field]: id || null, count }));
  }
}

function trainingTopic(value) {
  return normalizePath(value).split('/')[0] || '';
}

function stripThrough(value, marker) {
  const normalized = normalizePath(value);
  const index = normalized.indexOf(marker);
  return index >= 0 ? normalized.slice(index + marker.length) : normalized;
}

function graphicalBnfCount(catalog) {
  const direct = Number(
    catalog?.bnf?.graphical?.uniqueProductionCount
    || catalog?.bnfCatalog?.graphical?.uniqueProductionCount
    || 0
  );
  if (direct > 0) return direct;
  const sources = catalog?.bnfCatalog?.sources || catalog?.derivedBnfCatalog?.sources || [];
  const graphical = sources.find((item) => /graphical-bnf/iu.test(String(item?.url || '')));
  return Number(graphical?.statistics?.uniqueProductionCount || 0);
}

function globMatches(pattern, value) {
  const normalized = normalizePath(pattern);
  let expression = '';
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized.slice(index, index + 3) === '**/') {
      expression += '(?:.*/)?';
      index += 2;
    } else if (normalized.slice(index, index + 2) === '**') {
      expression += '.*';
      index += 1;
    } else if (normalized[index] === '*') {
      expression += '[^/]*';
    } else {
      expression += normalized[index].replace(/[.+^${}()|[\]\\]/u, '\\$&');
    }
  }
  return new RegExp(`^${expression}$`, 'u').test(normalizePath(value));
}

function normalizePath(value) {
  return String(value || '').replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function gate(numerator, denominator, forcedFailure = false) {
  return {
    numerator,
    denominator,
    ratio: denominator > 0 ? numerator / denominator : null,
    status: !forcedFailure && denominator > 0 && numerator === denominator ? 'PASS' : 'FAIL'
  };
}

function gap(code, details = {}) {
  return { code, ...details };
}

function byId(items, field) {
  return new Map((items || []).map((item) => [item?.[field], item]).filter(([id]) => Boolean(id)));
}

function sameIdSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const leftSorted = [...left].map(String).sort();
  const rightSorted = [...right].map(String).sort();
  return leftSorted.length === rightSorted.length
    && leftSorted.every((value, index) => value === rightSorted[index]);
}

function sortedUnique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String))].sort();
}

function idSetDifference(expectedIds, actualIds) {
  const expected = new Set(Array.isArray(expectedIds) ? expectedIds : []);
  const actual = new Set(Array.isArray(actualIds) ? actualIds : []);
  return {
    missingIds: [...expected].filter((id) => !actual.has(id)).sort(),
    unexpectedIds: [...actual].filter((id) => !expected.has(id)).sort(),
    expectedCount: expected.size,
    actualCount: actual.size
  };
}

function hashIdSet(ids) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify([...(ids || [])].map(String).sort()), 'utf8').digest('hex')}`;
}

function hashText(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function isSha256(value) {
  return /^sha256:[a-f0-9]{64}$/u.test(String(value || ''));
}

function hashCanonical(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

module.exports = {
  EVALUATOR_ID,
  REQUIRED_PHASE_IDS,
  evaluateCapabilityClosure,
  globMatches
};
