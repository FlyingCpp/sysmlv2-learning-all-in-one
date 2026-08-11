'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  materializeReviewedKnowledgeRelations
} = require('../../apps/teacher/knowledge-relations');
const {
  materializeReviewedKnowledgePatterns
} = require('../../apps/teacher/knowledge-patterns');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SOURCE_MANIFEST = path.join(
  PROJECT_ROOT,
  'resources',
  'sysml-knowledge',
  'sources',
  'manifests',
  'sysml-2.0-formal-f0.json'
);
const DEFAULT_AUTHORING_FILE = path.join(
  PROJECT_ROOT,
  'resources',
  'sysml-knowledge',
  'authoring',
  'f0-definition-usage.json'
);

function buildF0KnowledgeBundle(options = {}) {
  const sourceManifestPath = path.resolve(options.sourceManifestPath || DEFAULT_SOURCE_MANIFEST);
  const authoringPath = path.resolve(options.authoringPath || DEFAULT_AUTHORING_FILE);
  const sourceManifest = readJson(sourceManifestPath);
  const authoring = readJson(authoringPath);
  validateSourceManifest(sourceManifest, sourceManifestPath);
  validateAuthoring(authoring, sourceManifest);

  const sourcesById = new Map(sourceManifest.sources.map((source) => [source.sourceId, source]));
  const evidenceBlocks = authoring.evidenceBlocks.map((evidence) => {
    const source = sourcesById.get(evidence.sourceId);
    if (!source) throw new Error(`Unknown evidence source: ${evidence.sourceId}`);
    const textContent = extractLineSpan(source.path, evidence.lineStart, evidence.lineEnd);
    return {
      evidenceId: evidence.evidenceId,
      baselineId: authoring.baselineId,
      sourceId: evidence.sourceId,
      sectionPath: evidence.sectionPath,
      blockType: evidence.blockType,
      lineStart: evidence.lineStart,
      lineEnd: evidence.lineEnd,
      textContent,
      textHash: hashText(textContent),
      authorityLevel: source.authorityLevel,
      reviewStatus: 'reviewed',
      operators: evidence.operators || [],
      conceptIds: evidence.conceptIds || [],
      astContextIds: evidence.astContextIds || []
    };
  });
  const evidenceById = new Map(evidenceBlocks.map((evidence) => [evidence.evidenceId, evidence]));
  const claims = authoring.claims.map((claim) => {
    if (!Array.isArray(claim.evidenceIds) || claim.evidenceIds.length === 0) {
      throw new Error(`Claim ${claim.claimId} requires reviewed A1/A2 evidence`);
    }
    for (const evidenceId of claim.evidenceIds || []) {
      if (!evidenceById.has(evidenceId)) throw new Error(`Claim ${claim.claimId} references unknown evidence ${evidenceId}`);
    }
    const evidence = claim.evidenceIds.map((evidenceId) => evidenceById.get(evidenceId));
    if (evidence.some((item) => !['A1', 'A2'].includes(item.authorityLevel))) {
      throw new Error(`Claim ${claim.claimId} references evidence below A2 authority`);
    }
    return {
      ...claim,
      baselineId: authoring.baselineId,
      polarity: 'positive',
      modality: 'normative',
      authorityLevel: evidence.some((item) => item.authorityLevel === 'A2') ? 'A2' : 'A1',
      reviewStatus: 'reviewed'
    };
  });
  const evidenceLinks = claims.flatMap((claim) => claim.evidenceIds.map((evidenceId) => ({
    evidenceLinkId: `link-${claim.claimId}-${evidenceId}`,
    evidenceId,
    targetType: 'claim',
    targetId: claim.claimId,
    relationType: 'EVIDENCES',
    linkMethod: 'reviewed_authoring',
    confidence: 1,
    reviewStatus: 'reviewed'
  })));
  const nodes = authoring.nodes.map((node) => ({
    ...node,
    baselineId: node.baselineId || authoring.baselineId,
    status: 'ACTIVE',
    properties: node.properties || {}
  }));
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  const edges = authoring.edges.map((edge) => {
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
      throw new Error(`Edge ${edge.edgeId} references an unknown node`);
    }
    return {
      ...edge,
      baselineId: edge.baselineId || authoring.baselineId,
      authorityLevel: edge.authorityLevel || 'A1',
      sourceId: edge.sourceId || 'sysml20-part1-formal-text',
      reviewStatus: edge.reviewStatus || 'reviewed',
      properties: edge.properties || {}
    };
  });
  const syntaxMappings = authoring.syntaxMappings.map((mapping) => {
    if (!nodeIds.has(mapping.semanticNodeId)) throw new Error(`Syntax mapping ${mapping.syntaxMappingId} references an unknown node`);
    return {
      ...mapping,
      baselineId: authoring.baselineId,
      grammarProductionId: mapping.grammarProductionId || 'sysml20:8.2.2.6.5',
      parserFixtureId: mapping.parserFixtureId || `f01-${mapping.syntaxMappingId}`,
      reviewStatus: 'reviewed'
    };
  });
  const claimIds = new Set(claims.map((claim) => claim.claimId));
  const teachingOverlays = (authoring.teachingOverlays || []).map((overlay) => {
    if (overlay.overlayType !== 'answer_guardrail') {
      throw new Error(`Unsupported teaching overlay type: ${overlay.overlayType || ''}`);
    }
    if (overlay.authorityClass !== 'engineering_guardrail') {
      throw new Error(`Teaching overlay ${overlay.overlayId || ''} must use engineering_guardrail authority`);
    }
    if (!Array.isArray(overlay.patternSpec) || overlay.patternSpec.length === 0) {
      throw new Error(`Teaching overlay ${overlay.overlayId || ''} requires patternSpec`);
    }
    for (const pattern of overlay.patternSpec) {
      if (!['regex', 'substring'].includes(pattern.kind) || !String(pattern.value || '')) {
        throw new Error(`Teaching overlay ${overlay.overlayId || ''} has an invalid pattern`);
      }
    }
    if (!Array.isArray(overlay.supportedByClaimIds) || overlay.supportedByClaimIds.length === 0) {
      throw new Error(`Teaching overlay ${overlay.overlayId || ''} requires supportedByClaimIds`);
    }
    for (const claimId of overlay.supportedByClaimIds) {
      if (!claimIds.has(claimId)) throw new Error(`Teaching overlay ${overlay.overlayId} references unknown Claim ${claimId}`);
    }
    return {
      overlayId: overlay.overlayId,
      overlayType: overlay.overlayType,
      authorityClass: overlay.authorityClass,
      description: overlay.description,
      patternSpec: overlay.patternSpec,
      patternHash: hashText(canonicalJson(overlay.patternSpec)),
      counterexampleSpec: overlay.counterexampleSpec || { counterexampleIds: [] },
      supportedByClaimIds: overlay.supportedByClaimIds,
      reviewStatus: overlay.reviewStatus || 'reviewed',
      properties: overlay.properties || {}
    };
  });
  const sourceDocuments = sourceManifest.sources.map((source) => ({
    sourceId: source.sourceId,
    sourceType: source.sourceType,
    authorityLevel: source.authorityLevel,
    documentName: source.documentName,
    documentVersion: source.documentVersion,
    omgFileId: source.omgFileId || null,
    repositoryCommit: source.repositoryCommit || null,
    artifactHash: source.artifactHash,
    metadata: source.metadata || {}
  }));
  const knowledgeRelations = Array.isArray(authoring.knowledgeRelations)
    ? materializeReviewedKnowledgeRelations(authoring.knowledgeRelations, {
      nodes,
      claims,
      evidenceBlocks
    }, {
      diagnosticConceptIds: authoring.knowledgeRelationContext?.diagnosticConceptIds || [],
      repairOverlayIds: authoring.knowledgeRelationContext?.repairOverlayIds || [],
      fixtureIds: authoring.knowledgeRelationContext?.fixtureIds || []
    })
    : null;
  const knowledgePatterns = Array.isArray(authoring.knowledgePatterns)
    ? materializeReviewedKnowledgePatterns(authoring.knowledgePatterns, {
      'nodes.jsonl': nodes,
      'edges.jsonl': edges,
      'claims.jsonl': claims,
      'teaching-overlays.jsonl': teachingOverlays
    })
    : null;
  const productionResponsibilities = Array.isArray(authoring.productionResponsibilities)
    ? authoring.productionResponsibilities.map(clone)
    : null;
  const capabilityUnits = Array.isArray(authoring.capabilityUnits)
    ? authoring.capabilityUnits.map(clone)
    : null;
  const modelUserObjectives = Array.isArray(authoring.modelUserObjectives)
    ? authoring.modelUserObjectives.map(clone)
    : null;
  validateProductionKnowledgeArtifacts({
    productionResponsibilities,
    capabilityUnits,
    modelUserObjectives,
    nodes,
    claims
  });
  const sourceManifestHash = hashPortableTextFile(sourceManifestPath);
  const glossaryCompat = buildGlossaryCompat({
    authoring,
    nodes,
    edges,
    claims,
    evidenceBlocks,
    sourceManifest,
    sourceManifestHash
  });

  const bundleDir = path.resolve(
    options.bundleDir || path.join(PROJECT_ROOT, 'resources', 'sysml-knowledge', 'bundles', authoring.bundleId)
  );
  ensureWithinProject(bundleDir);
  fs.mkdirSync(bundleDir, { recursive: true });
  const artifacts = {
    'source-documents.jsonl': sourceDocuments,
    'nodes.jsonl': nodes,
    'edges.jsonl': edges,
    'claims.jsonl': claims,
    'evidence-blocks.jsonl': evidenceBlocks,
    'evidence-links.jsonl': evidenceLinks,
    'syntax-mappings.jsonl': syntaxMappings,
    'teaching-overlays.jsonl': teachingOverlays,
    'glossary-compat.json': [glossaryCompat]
  };
  if (knowledgeRelations) artifacts['knowledge-relations.jsonl'] = knowledgeRelations;
  if (knowledgePatterns) artifacts['knowledge-patterns.jsonl'] = knowledgePatterns;
  if (productionResponsibilities) artifacts['production-responsibilities.jsonl'] = productionResponsibilities;
  if (capabilityUnits) artifacts['capability-units.jsonl'] = capabilityUnits;
  if (modelUserObjectives) artifacts['model-user-objectives.jsonl'] = modelUserObjectives;
  const artifactHashes = {};
  for (const [fileName, records] of Object.entries(artifacts)) {
    const filePath = path.join(bundleDir, fileName);
    const content = records.length ? `${records.map(canonicalJson).join('\n')}\n` : '';
    fs.writeFileSync(filePath, content, 'utf8');
    artifactHashes[fileName] = hashFile(filePath);
  }
  const authoringHash = hashPortableTextFile(authoringPath);
  const contentHash = hashText(canonicalJson({ artifactHashes, sourceManifestHash, authoringHash }));
  const reviewSource = sourcesById.get(authoring.review.reviewSourceId);
  if (!reviewSource || reviewSource.sourceType !== 'review_report') {
    throw new Error(`Bundle review source is missing or invalid: ${authoring.review.reviewSourceId || ''}`);
  }
  const manifest = {
    schemaVersion: '1.0.0',
    bundleId: authoring.bundleId,
    baselineId: authoring.baselineId,
    version: authoring.version,
    ...(authoring.parentBundleId ? {
      parentBundleId: authoring.parentBundleId,
      parentContentHash: authoring.parentContentHash,
      teachingOverlaysHash: artifactHashes['teaching-overlays.jsonl']
    } : {}),
    status: 'CANDIDATE',
    sourceRegistry: {
      path: normalizePath(path.relative(PROJECT_ROOT, sourceManifestPath)),
      hash: sourceManifestHash,
      status: sourceManifest.sourceLockStatus
    },
    authoring: {
      path: normalizePath(path.relative(PROJECT_ROOT, authoringPath)),
      hash: authoringHash
    },
    counts: {
      sourceDocuments: sourceDocuments.length,
      nodes: nodes.length,
      edges: edges.length,
      claims: claims.length,
      evidenceBlocks: evidenceBlocks.length,
      evidenceLinks: evidenceLinks.length,
      syntaxMappings: syntaxMappings.length,
      teachingOverlays: teachingOverlays.length,
      ...(knowledgeRelations ? { knowledgeRelations: knowledgeRelations.length } : {}),
      ...(knowledgePatterns ? { knowledgePatterns: knowledgePatterns.length } : {}),
      ...(productionResponsibilities ? { productionResponsibilities: productionResponsibilities.length } : {}),
      ...(capabilityUnits ? { capabilityUnits: capabilityUnits.length } : {}),
      ...(modelUserObjectives ? { modelUserObjectives: modelUserObjectives.length } : {})
    },
    artifactHashes,
    gates: {
      sourceLocked: 'PASS',
      formalEvidenceExtraction: 'PASS',
      graphIntegrity: 'PASS',
      syntaxMappings: 'PASS',
      claimEvidenceCoverage: 'PASS',
      bundleReview: authoring.review.status
    },
    review: {
      status: authoring.review.status,
      reviewedAt: authoring.review.reviewedAt,
      reviewedBy: authoring.review.reviewedBy,
      reportHash: reviewSource.artifactHash
    },
    validator: sourceManifest.validator,
    contentHash
  };
  const manifestPath = path.join(bundleDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { bundleDir, manifestPath, manifest };
}

function buildGlossaryCompat({ authoring, nodes, edges, claims, evidenceBlocks, sourceManifest, sourceManifestHash }) {
  const sourceAwareAuthority = authoring.productionKnowledgeGovernance?.required === true;
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const evidenceById = new Map(evidenceBlocks.map((item) => [item.evidenceId, item]));
  const sourceById = new Map((sourceManifest.sources || []).map((source) => [source.sourceId, source]));
  const superTypesByNode = new Map();
  for (const edge of edges.filter((item) => item.predicate === 'SPECIALIZES')) {
    const superType = nodeById.get(edge.targetNodeId)?.name || edge.targetNodeId;
    superTypesByNode.set(edge.sourceNodeId, [...(superTypesByNode.get(edge.sourceNodeId) || []), superType]);
  }
  return {
    schemaVersion: 'sysml-glossary-compat/v1',
    bundleId: authoring.bundleId,
    baselineId: authoring.baselineId,
    bundleVersion: authoring.version,
    sourceRegistryHash: sourceManifestHash,
    generatedAt: authoring.review.reviewedAt,
    terms: nodes.map((node) => {
      const nodeClaims = claims.filter((claim) => claim.subjectNodeId === node.nodeId || claim.objectNodeId === node.nodeId);
      const evidenceIds = [...new Set(nodeClaims.flatMap((claim) => claim.evidenceIds))];
      const source = sourceById.get(node.sourceId);
      const nodeReviewStatus = node.properties?.reviewStatus
        || node.properties?.productionKnowledge?.reviewStatus
        || 'reviewed';
      const claimAuthorityLevels = [...new Set(evidenceIds
        .map((id) => evidenceById.get(id)?.authorityLevel)
        .filter(Boolean))];
      return {
        id: node.nodeId,
        term: node.name,
        aliases: [],
        kind: sourceAwareAuthority
          ? source?.authorityLevel === 'A1'
            ? 'SysML v2 authoritative concept'
            : nodeReviewStatus === 'derived'
              ? 'SysML v2 derived implementation node'
              : 'SysML v2 reviewed knowledge node'
          : 'SysML v2 authoritative concept',
        metamodelType: node.nodeKind,
        superTypes: superTypesByNode.get(node.nodeId) || [],
        source: sourceAwareAuthority
          ? source?.documentName || node.sourceId || 'locked Bundle source'
          : 'OMG SysML v2.0 Part 1',
        sourceLevel: sourceAwareAuthority ? source?.authorityLevel || null : 'A1',
        ...(sourceAwareAuthority ? { claimAuthorityLevels } : {}),
        section: evidenceIds.map((id) => evidenceById.get(id)?.sectionPath).filter(Boolean).join('; '),
        definition: nodeClaims.map((claim) => claim.claimText).join('\n'),
        claimIds: nodeClaims.map((claim) => claim.claimId),
        evidenceIds,
        relationships: edges
          .filter((edge) => edge.sourceNodeId === node.nodeId || edge.targetNodeId === node.nodeId)
          .map((edge) => ({
            predicate: edge.predicate,
            source: edge.sourceNodeId,
            target: edge.targetNodeId
          })),
        provenance: {
          bundleId: authoring.bundleId,
          baselineId: node.baselineId || authoring.baselineId,
          sourceRegistryHash: sourceManifestHash,
          reviewStatus: sourceAwareAuthority ? nodeReviewStatus : 'reviewed'
        }
      };
    })
  };
}

function validateSourceManifest(manifest, manifestPath) {
  if (manifest.sourceLockStatus !== 'SOURCE_LOCKED') throw new Error('Source manifest is not SOURCE_LOCKED');
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) throw new Error('Source manifest requires sources');
  if (!/^[a-f0-9]{40}$/.test(String(manifest.referenceRelease?.commitSha || ''))) {
    throw new Error('Reference release must resolve to an immutable commit');
  }
  if (!/^[a-f0-9]{40}$/.test(String(manifest.validator?.commitSha || ''))) {
    throw new Error('Pilot validator release must resolve to an immutable commit');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(manifest.validator?.aggregateArtifactSha256 || ''))) {
    throw new Error('Pilot validator aggregate artifact hash is invalid');
  }
  const ids = new Set();
  for (const source of manifest.sources) {
    if (!source.sourceId || ids.has(source.sourceId)) throw new Error(`Duplicate or missing sourceId: ${source.sourceId || ''}`);
    ids.add(source.sourceId);
    if (!/^sha256:[a-f0-9]{64}$/.test(String(source.artifactHash || ''))) {
      throw new Error(`Source ${source.sourceId} has an invalid artifact hash`);
    }
    const sourcePath = projectPath(source.path);
    if (!fs.existsSync(sourcePath)) throw new Error(`Source file is missing: ${source.path}`);
    const actualHashes = hashFileCandidates(sourcePath);
    if (!actualHashes.includes(source.artifactHash)) {
      throw new Error(`Source hash mismatch for ${source.sourceId}: expected ${source.artifactHash}, got ${actualHashes.join(' or ')}`);
    }
    if (source.repositoryUrl && !/^[a-f0-9]{40}$/.test(String(source.repositoryCommit || ''))) {
      throw new Error(`GitHub source ${source.sourceId} requires an immutable repository commit`);
    }
  }
  ensureWithinProject(manifestPath);
}

function validateAuthoring(authoring, sourceManifest) {
  if (!authoring.bundleId || !authoring.baselineId) throw new Error('Authoring bundleId and baselineId are required');
  if (authoring.review?.status !== 'PASS') throw new Error('Bundle authoring review gate must pass');
  if (!String(authoring.review?.reviewedBy || '').trim()) throw new Error('Bundle authoring reviewedBy is required');
  if (!Number.isFinite(Date.parse(String(authoring.review?.reviewedAt || '')))) throw new Error('Bundle authoring reviewedAt is invalid');
  const reviewSource = (sourceManifest?.sources || []).find((source) => source.sourceId === authoring.review?.reviewSourceId);
  if (!reviewSource || reviewSource.sourceType !== 'review_report') {
    throw new Error(`Bundle authoring reviewSourceId is not a locked review report: ${authoring.review?.reviewSourceId || ''}`);
  }
  for (const field of ['nodes', 'edges', 'claims', 'evidenceBlocks', 'syntaxMappings']) {
    if (!Array.isArray(authoring[field]) || authoring[field].length === 0) throw new Error(`Authoring ${field} must not be empty`);
  }
  if (authoring.knowledgeRelations !== undefined && !Array.isArray(authoring.knowledgeRelations)) {
    throw new Error('Authoring knowledgeRelations must be an explicit array when provided');
  }
  if (authoring.knowledgePatterns !== undefined && !Array.isArray(authoring.knowledgePatterns)) {
    throw new Error('Authoring knowledgePatterns must be an explicit array when provided');
  }
  for (const field of ['productionResponsibilities', 'capabilityUnits', 'modelUserObjectives']) {
    if (authoring[field] !== undefined && !Array.isArray(authoring[field])) {
      throw new Error(`Authoring ${field} must be an explicit array when provided`);
    }
  }
  if (authoring.parentBundleId) {
    if (!/^sha256:[a-f0-9]{64}$/.test(String(authoring.parentContentHash || ''))) {
      throw new Error('Versioned authoring with parentBundleId requires parentContentHash');
    }
    if (!Array.isArray(authoring.teachingOverlays)) {
      throw new Error('Versioned authoring requires an explicit teachingOverlays array');
    }
    const parentManifestPath = path.join(
      PROJECT_ROOT,
      'resources',
      'sysml-knowledge',
      'bundles',
      authoring.parentBundleId,
      'manifest.json'
    );
    if (!fs.existsSync(parentManifestPath)) throw new Error(`Parent Bundle manifest is missing: ${authoring.parentBundleId}`);
    const parentManifest = readJson(parentManifestPath);
    if (parentManifest.bundleId !== authoring.parentBundleId
      || parentManifest.contentHash !== authoring.parentContentHash) {
      throw new Error(`Parent Bundle lineage hash mismatch: ${authoring.parentBundleId}`);
    }
  }
}

function validateProductionKnowledgeArtifacts({
  productionResponsibilities,
  capabilityUnits,
  modelUserObjectives,
  nodes,
  claims
}) {
  const present = [productionResponsibilities, capabilityUnits, modelUserObjectives]
    .filter((value) => value !== null);
  if (present.length === 0) return;
  if (present.length !== 3) {
    throw new Error('Production knowledge artifacts must provide responsibilities, capability units, and Model User objectives together');
  }
  const nodeIds = new Set(nodes.map((item) => item.nodeId));
  const claimIds = new Set(claims.map((item) => item.claimId));
  const capabilityIds = uniqueIds(capabilityUnits, 'capabilityUnitId');
  const objectiveIds = uniqueIds(modelUserObjectives, 'objectiveId');
  const responsibilityIds = uniqueIds(productionResponsibilities, 'responsibilityId');
  const productionIds = new Set();
  for (const responsibility of productionResponsibilities) {
    const projectionNodeId = responsibility.projectionNodeId || responsibility.productionId;
    if (!responsibilityIds.has(responsibility.responsibilityId)
      || !nodeIds.has(projectionNodeId)
      || productionIds.has(responsibility.productionId)) {
      throw new Error(`Invalid or duplicate production responsibility: ${responsibility.responsibilityId || ''}`);
    }
    productionIds.add(responsibility.productionId);
    if (!['derived', 'reviewed'].includes(responsibility.reviewStatus)
      || responsibility.knowledgeStatement?.statementType !== 'official_reference_implementation_fact'
      || responsibility.knowledgeStatement?.authorityLevel !== 'C1'
      || !String(responsibility.knowledgeStatement?.text || '').trim()) {
      throw new Error(`Production responsibility is not a governed C1 implementation fact: ${responsibility.responsibilityId || ''}`);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(String(responsibility.sourceBinding?.bodyHash || ''))
      || !String(responsibility.sourceBinding?.sourceId || '')
      || !String(responsibility.sourceBinding?.sourcePath || '')) {
      throw new Error(`Production responsibility source binding is incomplete: ${responsibility.responsibilityId || ''}`);
    }
    if (!Array.isArray(responsibility.capabilityUnitIds)
      || responsibility.capabilityUnitIds.length === 0
      || responsibility.capabilityUnitIds.some((id) => !capabilityIds.has(id))) {
      throw new Error(`Production responsibility has an invalid capability binding: ${responsibility.responsibilityId || ''}`);
    }
    if (!Array.isArray(responsibility.normativeClaimIds)
      || responsibility.normativeClaimIds.length === 0
      || responsibility.normativeClaimIds.some((id) => !claimIds.has(id))) {
      throw new Error(`Production responsibility has an invalid normative Claim binding: ${responsibility.responsibilityId || ''}`);
    }
    if (!Array.isArray(responsibility.modelUserObjectiveIds)
      || responsibility.modelUserObjectiveIds.some((id) => !objectiveIds.has(id))) {
      throw new Error(`Production responsibility has an invalid Model User objective binding: ${responsibility.responsibilityId || ''}`);
    }
  }
  for (const capability of capabilityUnits) {
    if (!['P0', 'P1', 'P2', 'P3', 'P4'].includes(capability.phaseId)
      || !Array.isArray(capability.requiredClaimIds)
      || capability.requiredClaimIds.length === 0
      || capability.requiredClaimIds.some((id) => !claimIds.has(id))) {
      throw new Error(`Capability unit is incomplete: ${capability.capabilityUnitId || ''}`);
    }
  }
  for (const objective of modelUserObjectives) {
    if (!Array.isArray(objective.requiredCapabilityUnitIds)
      || objective.requiredCapabilityUnitIds.length === 0
      || objective.requiredCapabilityUnitIds.some((id) => !capabilityIds.has(id))) {
      throw new Error(`Model User objective has an invalid capability closure: ${objective.objectiveId || ''}`);
    }
  }
  if (objectiveIds.size !== modelUserObjectives.length) {
    throw new Error('Model User objective IDs must be unique');
  }
}

function uniqueIds(items, field) {
  const ids = new Set();
  for (const item of items || []) {
    const id = String(item?.[field] || '');
    if (!id || ids.has(id)) throw new Error(`Duplicate or missing ${field}: ${id}`);
    ids.add(id);
  }
  return ids;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function extractLineSpan(relativePath, lineStart, lineEnd) {
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart) {
    throw new Error(`Invalid evidence line span ${lineStart}-${lineEnd}`);
  }
  const filePath = projectPath(relativePath);
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r\n|\r|\n/);
  if (lineEnd > lines.length) throw new Error(`Evidence line span exceeds ${relativePath}`);
  return lines.slice(lineStart - 1, lineEnd).join('\n').trim();
}

function readJson(filePath) {
  ensureWithinProject(filePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function projectPath(relativePath) {
  const resolved = path.resolve(PROJECT_ROOT, String(relativePath || ''));
  ensureWithinProject(resolved);
  return resolved;
}

function ensureWithinProject(filePath) {
  const resolved = path.resolve(filePath);
  if (resolved !== PROJECT_ROOT && !resolved.startsWith(`${PROJECT_ROOT}${path.sep}`)) {
    throw new Error(`Path escapes project root: ${filePath}`);
  }
}

function hashFile(filePath) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function hashPortableTextFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n');
  return `sha256:${crypto.createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function hashFileCandidates(filePath) {
  const raw = hashFile(filePath);
  const extension = path.extname(String(filePath || '')).toLowerCase();
  if (!['.json', '.jsonl', '.md', '.txt', '.kerml', '.sysml', '.yaml', '.yml'].includes(extension)) return [raw];
  const canonical = hashPortableTextFile(filePath);
  return canonical === raw ? [raw] : [raw, canonical];
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

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

if (require.main === module) {
  try {
    const result = buildF0KnowledgeBundle();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      bundleId: result.manifest.bundleId,
      contentHash: result.manifest.contentHash,
      bundleDir: result.bundleDir,
      counts: result.manifest.counts
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildF0KnowledgeBundle,
  canonicalJson,
  hashFile,
  hashText
};
