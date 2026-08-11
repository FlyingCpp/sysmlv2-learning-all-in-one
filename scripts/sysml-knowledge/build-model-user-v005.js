'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { buildF0KnowledgeBundle, hashFile } = require('./build-f0-bundle');
const {
  addLanguageGovernanceToManifest,
  buildCoverageReport: buildLanguageCoverageReport
} = require('./build-model-user-v003');
const { createInventoryFromFiles, diagnosticCount } = require('./extract-language-inventory');
const { canonicalStringify } = require('./language-inventory');
const { materializeLanguageProjection } = require('./language-bundle-projection');
const { evaluateLanguageClosure, productionSetHash } = require('./language-closure');
const { evaluateKnowledgePatternClosure } = require('./knowledge-pattern-closure');
const {
  createProductionResponsibilityManifest,
  evaluateLanguageKnowledgeization,
  hashCanonical
} = require('./language-knowledgeization-v2');
const {
  CAPABILITY_UNITS,
  MODEL_USER_OBJECTIVE_REQUIREMENTS,
  classifyProductionCapabilityUnitIds,
  serializableCapabilityScope
} = require('./model-user-v005-catalog');
const { evaluateCapabilityClosure } = require('./capability-closure-v1');
const { evaluateActivationReadiness } = require('./activation-readiness-v1');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const BASE_AUTHORING_PATH = projectPath('resources/sysml-knowledge/authoring/sysml20-model-user-v004.json');
const BASE_SOURCE_MANIFEST_PATH = projectPath('resources/sysml-knowledge/sources/manifests/sysml-2.0-model-user-v004.json');
const BASE_BUNDLE_MANIFEST_PATH = projectPath('resources/sysml-knowledge/bundles/sysml20-model-user-v004/manifest.json');
const FORMAL_INVENTORY_PATH = projectPath('resources/sysml-knowledge/language/baselines/sysml-2.0-pilot-2026-04-inventory.json');
const FORMAL_SCOPE_PATH = projectPath('resources/sysml-knowledge/language/scopes/model-user-textual-closure-v1.json');
const FORMAL_FIXTURE_PATH = projectPath('resources/sysml-knowledge/language/fixtures/model-user-textual-closure-v1/catalog.json');
const FORMAL_VALIDATOR_REPORT_PATH = projectPath('resources/sysml-knowledge/language/validator-runs/model-user-textual-closure-v1-official.json');
const KNOWLEDGE_PATTERN_SCOPE_PATH = projectPath('resources/sysml-knowledge/language/scopes/model-user-knowledge-patterns-v1.json');
const KNOWLEDGE_PATTERN_FIXTURE_PATH = projectPath('resources/sysml-knowledge/eval/model-user-knowledge-pattern-fixtures-v1.json');
const OUTLINE_PATH = projectPath('resources/sysml-knowledge/eval/sysmlv2-model-user-outline-2026-08-02.json');
const OFFICIAL_SOURCE_ROOT = projectPath('resources/sysml-knowledge/sources/official/sysml-2026-05');
const OFFICIAL_REGISTRY_PATH = path.join(OFFICIAL_SOURCE_ROOT, 'source-registry.json');
const OFFICIAL_BNF_CATALOG_PATH = path.join(OFFICIAL_SOURCE_ROOT, 'derived', 'bnf-production-catalog.json');
const PILOT_SOURCE_ROOT = path.join(OFFICIAL_SOURCE_ROOT, 'sources', 'pilot-2026-05');
const LATEST_INVENTORY_PATH = projectPath('resources/sysml-knowledge/language/baselines/sysml-2.1-beta1-pilot-2026-05-inventory.json');
const RESPONSIBILITY_PATH = projectPath('resources/sysml-knowledge/language/scopes/sysml-official-production-responsibilities-2026-05-v2.json');
const CAPABILITY_SCOPE_PATH = projectPath('resources/sysml-knowledge/language/scopes/sysml-official-capabilities-p0-p4-v1.json');
const PRODUCTION_COVERAGE_PATH = projectPath('resources/sysml-knowledge/eval/sysml20-model-user-v005-production-knowledgeization.json');
const CAPABILITY_COVERAGE_PATH = projectPath('resources/sysml-knowledge/eval/sysml20-model-user-v005-capability-coverage.json');
const FORMAL_COVERAGE_PATH = projectPath('resources/sysml-knowledge/eval/sysml20-model-user-v005-language-closure.json');
const KNOWLEDGE_PATTERN_COVERAGE_PATH = projectPath('resources/sysml-knowledge/eval/sysml20-model-user-v005-knowledge-pattern-coverage.json');
const DELTA_REPORT_PATH = projectPath('resources/sysml-knowledge/eval/sysml20-v20-v21-beta1-grammar-delta.json');
const REVIEW_PATH = projectPath('docs/sysml20-model-user-v005-official-knowledge-review-2026-08-02.md');
const AUTHORING_PATH = projectPath('resources/sysml-knowledge/authoring/sysml20-model-user-v005.json');
const SOURCE_MANIFEST_PATH = projectPath('resources/sysml-knowledge/sources/manifests/sysml-2.0-model-user-v005.json');
const BUNDLE_DIR = projectPath('resources/sysml-knowledge/bundles/sysml20-model-user-v005');

const LATEST_ECORE_FILES = Object.freeze([
  Object.freeze({ id: 'SysML.ecore', path: 'model/SysML.ecore', filePath: 'org.omg.sysml.model/src/main/resources/model/SysML.ecore', precedence: 200 }),
  Object.freeze({ id: 'kerml.ecore', path: 'model/kerml.ecore', filePath: 'org.omg.sysml/model/kerml.ecore', precedence: 100 })
]);
const LATEST_GRAMMAR_FILES = Object.freeze([
  Object.freeze({ id: 'SysML', path: 'org/omg/sysml/xtext/SysML.xtext', filePath: 'org.omg.sysml.xtext/src/org/omg/sysml/xtext/SysML.xtext', precedence: 300 }),
  Object.freeze({ id: 'KerML', path: 'org/omg/kerml/xtext/KerML.xtext', filePath: 'org.omg.kerml.xtext/src/org/omg/kerml/xtext/KerML.xtext', precedence: 200 }),
  Object.freeze({ id: 'KerMLExpressions', path: 'org/omg/kerml/expressions/xtext/KerMLExpressions.xtext', filePath: 'org.omg.kerml.expressions.xtext/src/org/omg/kerml/expressions/xtext/KerMLExpressions.xtext', precedence: 100 })
]);
const LATEST_SOURCE_ID_MAP = Object.freeze({
  SysML: 'pilot-sysml-xtext-2026-05',
  KerML: 'pilot-kerml-xtext-2026-05',
  KerMLExpressions: 'pilot-kerml-expressions-xtext-2026-05',
  'SysML.ecore': 'pilot-sysml-ecore-2026-05',
  'kerml.ecore': 'pilot-kerml-ecore-2026-05'
});
const PRODUCTION_EVALUATOR_ID = 'sysml-language-knowledgeization/v2';
const CAPABILITY_EVALUATOR_ID = 'sysml-capability-closure/v1';
const KNOWLEDGE_PATTERN_EVALUATOR_ID = 'model-user-knowledge-pattern-closure/v1';
const BETA21_PROJECTION_PREFIX = 'sysml21beta1:';

function buildModelUserV005Bundle(options = {}) {
  const output = resolveOutputs(options);
  const baseAuthoring = readJson(BASE_AUTHORING_PATH);
  const baseSourceManifest = readJson(BASE_SOURCE_MANIFEST_PATH);
  const parentManifest = readJson(BASE_BUNDLE_MANIFEST_PATH);
  const formalInventory = readJson(FORMAL_INVENTORY_PATH);
  const formalScope = readJson(FORMAL_SCOPE_PATH);
  const formalFixtures = readJson(FORMAL_FIXTURE_PATH);
  const formalValidatorReport = readJson(FORMAL_VALIDATOR_REPORT_PATH);
  const outline = readJson(OUTLINE_PATH);
  const knowledgePatternScope = readJson(KNOWLEDGE_PATTERN_SCOPE_PATH);
  const knowledgePatternFixtures = readJson(KNOWLEDGE_PATTERN_FIXTURE_PATH);
  const officialRegistry = readJson(OFFICIAL_REGISTRY_PATH);
  const bnfCatalog = readJson(OFFICIAL_BNF_CATALOG_PATH);
  const officialCatalog = { ...officialRegistry, bnfCatalog };

  const latestInventory = createInventoryFromFiles({
    sourceDirectory: PILOT_SOURCE_ROOT,
    ecoreFiles: LATEST_ECORE_FILES,
    grammarFiles: LATEST_GRAMMAR_FILES,
    inventoryId: 'sysml-2.1-beta1-pilot-2026-05'
  });
  if (diagnosticCount(latestInventory) !== 0) {
    throw new Error(`Latest Pilot inventory contains ${diagnosticCount(latestInventory)} diagnostic item(s)`);
  }
  writeCanonicalJson(output.latestInventoryPath, latestInventory);

  const capabilityScope = serializableCapabilityScope();
  writeJson(output.capabilityScopePath, capabilityScope);
  const responsibilityManifest = reviewedResponsibilities(latestInventory);
  writeJson(output.responsibilityPath, responsibilityManifest);
  const latestProjectionScope = rebindScopeToInventory(formalScope, latestInventory);

  const rawLatestProjection = materializeLanguageProjection({
    inventory: latestInventory,
    scopeManifest: latestProjectionScope,
    baseNodes: [],
    sourceIdMap: LATEST_SOURCE_ID_MAP,
    semanticNodePrefix: BETA21_PROJECTION_PREFIX
  });
  const latestProjection = namespaceLanguageProjection(rawLatestProjection, BETA21_PROJECTION_PREFIX);
  const authoring = buildV005Authoring({
    baseAuthoring,
    parentManifest,
    latestInventory,
    latestProjection,
    responsibilityManifest,
    capabilityScope,
    output
  });
  writeJson(output.authoringPath, authoring);

  const formalEvaluation = evaluateLanguageClosure({
    inventory: formalInventory,
    scopeManifest: formalScope,
    bundle: authoring,
    fixtureCatalog: formalFixtures,
    validatorReport: formalValidatorReport
  });
  requirePass('formal 2.0 language closure', formalEvaluation);
  const formalCoverage = buildLanguageCoverageReport({
    evaluation: formalEvaluation,
    inventory: formalInventory,
    scopeManifest: formalScope,
    fixtureCatalog: formalFixtures,
    validatorReport: formalValidatorReport,
    authoringPath: output.authoringPath,
    bundleId: authoring.bundleId
  });
  writeJson(output.formalCoveragePath, formalCoverage);

  const patternEvaluation = evaluateKnowledgePatternClosure({
    outline,
    scope: knowledgePatternScope,
    bundle: authoring,
    fixtureCatalog: knowledgePatternFixtures,
    sourceManifest: baseSourceManifest
  });
  requirePass('knowledge pattern closure', patternEvaluation);
  const patternCoverage = buildKnowledgePatternCoverageReport({
    evaluation: patternEvaluation,
    authoringPath: output.authoringPath,
    coveragePath: output.knowledgePatternCoveragePath
  });
  writeJson(output.knowledgePatternCoveragePath, patternCoverage);

  const productionEvaluation = evaluateLanguageKnowledgeization({
    inventory: latestInventory,
    responsibilityManifest,
    projection: authoring
  });
  requirePass('549-production knowledgeization', productionEvaluation);
  const productionCoverage = {
    ...productionEvaluation,
    bundleId: authoring.bundleId,
    inputs: {
      inventoryHash: hashFile(output.latestInventoryPath),
      responsibilityManifestHash: hashFile(output.responsibilityPath),
      authoringHash: hashFile(output.authoringPath)
    }
  };
  writeJson(output.productionCoveragePath, productionCoverage);

  const capabilityEvaluation = evaluateCapabilityClosure({
    outline,
    capabilityScope,
    bundle: authoring,
    sourceManifest: baseSourceManifest,
    officialSourceCatalog: officialCatalog,
    productionResponsibilities: responsibilityManifest
  });
  requirePass('P0-P4 capability closure', capabilityEvaluation);
  const capabilityCoverage = {
    ...capabilityEvaluation,
    bundleId: authoring.bundleId,
    inputs: {
      outlineHash: hashFile(OUTLINE_PATH),
      capabilityScopeHash: hashFile(output.capabilityScopePath),
      responsibilityManifestHash: hashFile(output.responsibilityPath),
      officialRegistryHash: hashFile(OFFICIAL_REGISTRY_PATH),
      bnfCatalogHash: hashFile(OFFICIAL_BNF_CATALOG_PATH),
      authoringHash: hashFile(output.authoringPath)
    }
  };
  writeJson(output.capabilityCoveragePath, capabilityCoverage);

  const deltaReport = buildGrammarDeltaReport(formalInventory, latestInventory);
  writeJson(output.deltaReportPath, deltaReport);

  const sourceManifest = buildV005SourceManifest({
    baseSourceManifest,
    output
  });
  writeJson(output.sourceManifestPath, sourceManifest);

  const built = buildF0KnowledgeBundle({
    sourceManifestPath: output.sourceManifestPath,
    authoringPath: output.authoringPath,
    bundleDir: output.bundleDir
  });
  let manifest = addLanguageGovernanceToManifest({
    manifest: built.manifest,
    evaluation: formalEvaluation,
    inventory: formalInventory,
    inventoryPath: FORMAL_INVENTORY_PATH,
    coverageReportPath: output.formalCoveragePath,
    scopeManifest: formalScope,
    fixtureCatalog: formalFixtures,
    validatorReport: formalValidatorReport
  });
  manifest = addKnowledgePatternGovernance({
    manifest,
    evaluation: patternEvaluation,
    coveragePath: output.knowledgePatternCoveragePath
  });
  manifest = addV005Governance({
    manifest,
    productionEvaluation,
    capabilityEvaluation,
    responsibilityManifest,
    capabilityScope,
    output,
    exactRetrieval: validateExactRetrievalBindings(authoring, latestInventory)
  });
  writeJson(built.manifestPath, manifest);

  return {
    ...built,
    manifest,
    authoring,
    sourceManifest,
    latestInventory,
    responsibilityManifest,
    capabilityScope,
    formalEvaluation,
    patternEvaluation,
    productionEvaluation,
    capabilityEvaluation,
    deltaReport
  };
}

function rebindScopeToInventory(scopeManifest, inventory) {
  return {
    ...clone(scopeManifest),
    scopeId: `${scopeManifest.scopeId}-projection-${inventory.inventoryId}`,
    inventoryId: inventory.inventoryId,
    defaultDisposition: {
      ...clone(scopeManifest.defaultDisposition),
      inventoryContentHash: inventory.contentHash,
      productionSetHash: productionSetHash(inventory.productions)
    }
  };
}

function buildV005Authoring({
  baseAuthoring,
  parentManifest,
  latestInventory,
  latestProjection,
  responsibilityManifest,
  capabilityScope,
  output
}) {
  if (parentManifest.bundleId !== 'sysml20-model-user-v004') {
    throw new Error(`Unexpected v005 parent Bundle: ${parentManifest.bundleId || ''}`);
  }
  const responsibilityByProjectionNode = new Map(
    responsibilityManifest.responsibilities.map((item) => [item.projectionNodeId, item])
  );
  const nodes = [...clone(baseAuthoring.nodes), ...latestProjection.nodes.map((node) => {
    const responsibility = responsibilityByProjectionNode.get(node.nodeId);
    if (!responsibility) return clone(node);
    return {
      ...clone(node),
      properties: {
        ...clone(node.properties || {}),
        productionKnowledge: {
          responsibilityId: responsibility.responsibilityId,
          appliesTo: responsibility.appliesTo,
          responsibilityKind: responsibility.responsibilityKind,
          capabilityAreaIds: responsibility.capabilityAreaIds,
          capabilityUnitIds: responsibility.capabilityUnitIds,
          bodyHash: responsibility.sourceBinding.bodyHash,
          reviewStatus: responsibility.reviewStatus
        }
      }
    };
  })];
  return {
    ...clone(baseAuthoring),
    schemaVersion: '1.4.0',
    bundleId: 'sysml20-model-user-v005',
    version: '2026.08.02-mu.5',
    parentBundleId: parentManifest.bundleId,
    parentContentHash: parentManifest.contentHash,
    review: {
      status: 'PASS',
      reviewedBy: 'main-agent-plus-independent-adversarial-governance-audit',
      reviewedAt: '2026-08-02T18:00:00.000+08:00',
      reviewSourceId: 'sysml20-model-user-v005-official-knowledge-review'
    },
    languageGovernance: {
      ...clone(baseAuthoring.languageGovernance),
      paths: {
        ...clone(baseAuthoring.languageGovernance.paths),
        coverageReport: relative(output.formalCoveragePath)
      }
    },
    knowledgePatternGovernance: {
      ...clone(baseAuthoring.knowledgePatternGovernance),
      paths: {
        outline: relative(OUTLINE_PATH),
        scope: relative(KNOWLEDGE_PATTERN_SCOPE_PATH),
        fixtureCatalog: relative(KNOWLEDGE_PATTERN_FIXTURE_PATH),
        coverageReport: relative(output.knowledgePatternCoveragePath)
      }
    },
    productionKnowledgeGovernance: {
      required: true,
      evaluatorId: PRODUCTION_EVALUATOR_ID,
      capabilityEvaluatorId: CAPABILITY_EVALUATOR_ID,
      paths: {
        latestInventory: relative(output.latestInventoryPath),
        responsibilityManifest: relative(output.responsibilityPath),
        capabilityScope: relative(output.capabilityScopePath),
        outline: relative(OUTLINE_PATH),
        officialRegistry: relative(OFFICIAL_REGISTRY_PATH),
        bnfCatalog: relative(OFFICIAL_BNF_CATALOG_PATH),
        productionCoverageReport: relative(output.productionCoveragePath),
        capabilityCoverageReport: relative(output.capabilityCoveragePath),
        deltaReport: relative(output.deltaReportPath)
      }
    },
    nodes,
    edges: mergeEdgesByTriple(baseAuthoring.edges, latestProjection.languageEdges),
    claims: augmentClaims(baseAuthoring.claims),
    evidenceBlocks: augmentEvidenceBlocks(baseAuthoring.evidenceBlocks),
    syntaxMappings: augmentSyntaxMappings(baseAuthoring.syntaxMappings),
    productionResponsibilities: responsibilityManifest.responsibilities,
    capabilityUnits: capabilityScope.capabilityUnits.map((item) => ({ ...item, reviewStatus: 'reviewed' })),
    modelUserObjectives: capabilityScope.modelUserObjectiveRequirements.map((item) => ({ ...item, reviewStatus: 'reviewed' }))
  };
}

function augmentClaims(baseClaims) {
  const claims = clone(baseClaims || []);
  for (const claim of claims) {
    if (['claim-feature-value-default', 'claim-feature-value-fixed-vs-initial'].includes(claim.claimId)) {
      claim.astContextIds = uniqueStrings([...(claim.astContextIds || []), 'sysml20:FeatureValue']);
    }
    if (claim.claimId === 'claim-mu-multiplicity') {
      claim.claimText = 'Usage multiplicity用上下界约束每个featuring instance可具有的values数量；上界可为*表示无界。';
    }
    if (claim.claimId === 'claim-mu-composite-referential') {
      claim.claimText = 'Referential Usage表示引用；Composite Usage表示值是owning occurrence结构中不可分割的部分，所有者被销毁时其composite实例也被销毁。';
      claim.evidenceIds = uniqueStrings([...(claim.evidenceIds || []), 'ev-mu-occurrences']);
    }
    if (claim.claimId === 'claim-mu-succession') {
      claim.claimText = 'Succession用于规定action usage的先后顺序；在Action body中可用first标记source、then标记target的简写。';
    }
    if (claim.claimId === 'claim-mu-quantities') {
      claim.claimText = 'Quantities package定义Tensor、Vector和Scalar quantity value层次；quantity value由数值序列与measurement reference组成，measurement reference通常是unit或scale。';
    }
    if (claim.claimId === 'claim-mu-isq') {
      claim.claimText = 'ISQ package按International System of Quantities提供预定义quantity types，并提供定义具体measurement reference、unit和scale所需的特化。';
    }
  }
  return mergeById(claims, [
    atomicClaim(
      'claim-mu-import-membership',
      'kerml10:Import',
      'IMPORTS_MEMBERSHIP',
      'kerml10:Membership',
      ['sysml20:MembershipImport'],
      'MembershipImport导入一个可见membership；它与NamespaceImport是官方语法中两条不同的Import分支。',
      ['ev-mu-imports'],
      ['MU-FND-7.5'],
      0
    ),
    atomicClaim(
      'claim-mu-import-namespace',
      'kerml10:Import',
      'IMPORTS_NAMESPACE_MEMBERS',
      'kerml10:Namespace',
      ['sysml20:NamespaceImport'],
      'NamespaceImport通过::*或::**导入Namespace成员，其语法分支和MembershipImport分开。',
      ['ev-mu-imports'],
      ['MU-FND-7.5'],
      0
    ),
    atomicClaim(
      'claim-mu-allocation-usage',
      'sysml20:AllocationUsage',
      'IS_TYPED_BY',
      'sysml20:AllocationDefinition',
      ['sysml20:AllocationUsage'],
      'AllocationUsage是AllocationDefinition的usage，用于表达具体source到target的分配关系；它不等同于perform行为。',
      ['ev-mu-allocations'],
      ['MU-STR-7.15'],
      1
    ),
    atomicClaim(
      'claim-mu-send-realization-boundary',
      'sysml20:SendActionUsage',
      'CAN_REALIZE_MESSAGE_TRANSFER',
      'sysml20:FlowUsage',
      ['sysml20:SendActionUsage'],
      'SendActionUsage可作为Message transfer的详细实现；出现send不意味必须再建立一个显式FlowUsage。',
      ['ev-mu-flows', 'ev-mu-send-actions'],
      ['MU-BEH-7.17'],
      2
    ),
    atomicClaim(
      'claim-mu-accept-realization-boundary',
      'sysml20:AcceptActionUsage',
      'CAN_REALIZE_MESSAGE_TRANSFER',
      'sysml20:FlowUsage',
      ['sysml20:AcceptActionUsage'],
      'AcceptActionUsage可作为Message transfer的详细实现；出现accept不意味必须再建立一个显式FlowUsage。',
      ['ev-mu-flows', 'ev-mu-accept-actions'],
      ['MU-BEH-7.17'],
      2
    ),
    atomicClaim(
      'claim-mu-view-definition',
      'sysml20:ViewDefinition',
      'DEFINES_VIEW_PRESENTATION',
      null,
      ['sysml20:ViewDefinition'],
      'ViewDefinition定义要呈现的模型信息和适用的rendering结构。',
      ['ev-mu-views'],
      [],
      4
    ),
    atomicClaim(
      'claim-mu-view-usage',
      'sysml20:ViewUsage',
      'IS_TYPED_BY',
      'sysml20:ViewDefinition',
      ['sysml20:ViewUsage'],
      'ViewUsage是ViewDefinition的usage，用来选择并呈现具体模型信息。',
      ['ev-mu-views'],
      [],
      4
    ),
    atomicClaim(
      'claim-mu-viewpoint-definition',
      'sysml20:ViewpointDefinition',
      'FRAMES_CONCERNS_FOR',
      'sysml20:ViewDefinition',
      ['sysml20:ViewpointDefinition'],
      'ViewpointDefinition使用stakeholder concerns约束ViewDefinition所表达的信息。',
      ['ev-mu-views'],
      [],
      4
    ),
    atomicClaim(
      'claim-mu-viewpoint-usage',
      'sysml20:ViewpointUsage',
      'IS_TYPED_BY',
      'sysml20:ViewpointDefinition',
      ['sysml20:ViewpointUsage'],
      'ViewpointUsage是ViewpointDefinition的usage，用于在具体上下文中应用stakeholder concern约束。',
      ['ev-mu-views'],
      [],
      4
    )
  ], 'claimId');
}

function augmentEvidenceBlocks(baseEvidenceBlocks) {
  return clone(baseEvidenceBlocks || []).map((evidence) => {
    if (evidence.evidenceId === 'ev-mu-accept-actions') {
      return { ...evidence, lineEnd: 6793 };
    }
    if (evidence.evidenceId === 'ev-mu-requirements') {
      return { ...evidence, lineStart: 8032 };
    }
    if (evidence.evidenceId === 'ev-mu-namespaces') {
      return { ...evidence, lineStart: 2205 };
    }
    if (evidence.evidenceId === 'ev-mu-ports') {
      return { ...evidence, lineStart: 4278 };
    }
    if (evidence.evidenceId === 'ev-mu-actions') {
      return { ...evidence, lineStart: 5647 };
    }
    if (evidence.evidenceId === 'ev-mu-metadata') {
      return { ...evidence, lineStart: 9584 };
    }
    if (evidence.evidenceId === 'ev-mu-requirement-declarations') {
      return { ...evidence, lineEnd: 8338 };
    }
    return evidence;
  });
}

function atomicClaim(claimId, subjectNodeId, predicate, objectNodeId, astContextIds, claimText, evidenceIds, examObjectiveIds, phase) {
  return {
    claimId,
    claimType: 'normative',
    subjectNodeId,
    predicate,
    ...(objectNodeId ? { objectNodeId } : {}),
    operators: [],
    astContextIds,
    claimText,
    evidenceIds,
    properties: {
      phase,
      examObjectiveIds,
      knownPointIds: [],
      searchTerms: uniqueStrings([claimId, subjectNodeId, objectNodeId, predicate])
    }
  };
}

function reviewedResponsibilities(inventory) {
  const manifest = createProductionResponsibilityManifest(inventory);
  const semanticTypeById = new Map(inventory.semanticTypes.map((item) => [item.semanticTypeId, item]));
  const effectiveRuleById = new Map(inventory.grammar.effectiveRules.map((item) => [item.id, item]));
  const unitById = new Map(CAPABILITY_UNITS.map((item) => [item.capabilityUnitId, item]));
  const responsibilities = manifest.responsibilities.map((item) => {
    const production = inventory.productions.find((candidate) => candidate.productionId === item.productionId);
    const capabilityUnitIds = classifyProductionCapabilityUnitIds({
      production,
      semanticType: semanticTypeById.get(production.semanticTypeId),
      effectiveRule: effectiveRuleById.get(production.productionId)
    });
    const normativeClaimIds = uniqueStrings(capabilityUnitIds.flatMap((id) => unitById.get(id)?.requiredClaimIds || []));
    const modelUserObjectiveIds = uniqueStrings(capabilityUnitIds.flatMap((id) => unitById.get(id)?.modelUserObjectiveIds || []));
    return {
      ...item,
      reviewStatus: 'derived',
      appliesTo: 'sysml-2.1-beta1/pilot-2026-05',
      projectionNodeId: `${BETA21_PROJECTION_PREFIX}${item.productionId}`,
      projectionNodePrefix: BETA21_PROJECTION_PREFIX,
      capabilityUnitIds,
      normativeClaimIds,
      modelUserObjectiveIds,
      sourceBinding: {
        ...item.sourceBinding,
        registeredSourceId: LATEST_SOURCE_ID_MAP[item.sourceBinding.sourceId] || item.sourceBinding.sourceId
      },
      properties: {
        ...item.properties,
        semanticReviewRequired: true,
        reviewBasis: 'deterministic-official-grammar-source-and-projection-binding',
        normativeBoundary: 'C1 implementation fact; normative semantics remain on SysML 2.0 A1/A2 Claims'
      }
    };
  });
  return {
    ...manifest,
    generationStatus: 'DERIVED_KNOWLEDGEIZED_REVIEW_REQUIRED',
    responsibilities,
    responsibilitySetHash: hashCanonical(responsibilities)
  };
}

function namespaceLanguageProjection(projection, prefix) {
  const nodeIdMap = new Map((projection.nodes || []).map((node) => [
    node.nodeId,
    node.nodeId.startsWith(prefix) ? node.nodeId : `${prefix}${node.nodeId}`
  ]));
  const nodes = (projection.nodes || []).map((node) => ({
    ...clone(node),
    nodeId: nodeIdMap.get(node.nodeId),
    baselineId: 'sysml-2.1-beta1-pilot-2026-05',
    sourceId: node.sourceId || 'sysml-language-inventory-pilot-2026-05',
    properties: {
      ...clone(node.properties || {}),
      projectionTrack: 'forwardCompatibility21Beta',
      reviewStatus: 'derived'
    }
  }));
  const languageEdges = (projection.languageEdges || [])
    .filter((edge) => edge.properties?.mappingKind !== 'reviewed_context_projection')
    .map((edge) => {
      const sourceNodeId = nodeIdMap.get(edge.sourceNodeId) || edge.sourceNodeId;
      const targetNodeId = nodeIdMap.get(edge.targetNodeId) || edge.targetNodeId;
      const identity = {
        sourceNodeId,
        predicate: edge.predicate,
        targetNodeId,
        properties: edge.properties || {}
      };
      return {
        ...clone(edge),
        edgeId: `edge-language-beta21-${hashCanonical(identity).slice(7, 31)}`,
        baselineId: 'sysml-2.1-beta1-pilot-2026-05',
        sourceNodeId,
        targetNodeId,
        reviewStatus: 'derived',
        properties: {
          ...clone(edge.properties || {}),
          projectionTrack: 'forwardCompatibility21Beta'
        }
      };
    });
  return {
    ...projection,
    nodes,
    languageEdges,
    semanticNodeIdByInventoryId: Object.fromEntries(
      Object.entries(projection.semanticNodeIdByInventoryId || {}).map(([id, nodeId]) => [
        id,
        nodeIdMap.get(nodeId) || nodeId
      ])
    )
  };
}

function buildGrammarDeltaReport(formalInventory, latestInventory) {
  const formalById = new Map(formalInventory.grammar.effectiveRules.map((item) => [item.id, item]));
  const latestById = new Map(latestInventory.grammar.effectiveRules.map((item) => [item.id, item]));
  const added = [...latestById.keys()].filter((id) => !formalById.has(id)).sort();
  const removed = [...formalById.keys()].filter((id) => !latestById.has(id)).sort();
  const changed = [...latestById.keys()].filter((id) =>
    formalById.has(id) && formalById.get(id).bodyHash !== latestById.get(id).bodyHash
  ).sort().map((productionId) => ({
    productionId,
    formal20: compactRule(formalById.get(productionId)),
    beta21: compactRule(latestById.get(productionId))
  }));
  return {
    schemaVersion: 'sysml-grammar-release-delta/v1',
    status: 'REVIEWED',
    authorityBoundary: 'forward-compatibility-only; does not override SysML 2.0 formal Claims',
    formalBaseline: {
      inventoryId: formalInventory.inventoryId,
      contentHash: formalInventory.contentHash,
      releaseTag: '2026-04'
    },
    latestImplementation: {
      inventoryId: latestInventory.inventoryId,
      contentHash: latestInventory.contentHash,
      releaseTag: '2026-05'
    },
    counts: {
      formalProductions: formalById.size,
      latestProductions: latestById.size,
      added: added.length,
      removed: removed.length,
      changed: changed.length
    },
    addedProductionIds: added,
    removedProductionIds: removed,
    changedProductions: changed
  };
}

function compactRule(rule) {
  return {
    bodyHash: rule.bodyHash,
    directLiterals: rule.directLiterals,
    returnType: rule.returnType,
    referencedProductionIds: (rule.references || []).map((item) => item.productionId).filter(Boolean).sort()
  };
}

function buildV005SourceManifest({ baseSourceManifest, output }) {
  const addedSources = [
    source('sysml20-model-user-exam-outline', 'official_certification_exam_outline', 'C1', 'OMG SysML v2 Model User public exam outline metadata', '2026-08-02', OUTLINE_PATH, {
      sourceUrl: 'https://www.omg.org/certification/sysml2/SysMLv2-MU.pdf',
      upstreamArtifactHash: 'sha256:76196aa48a89a93bb14b54a7475a50133cb2ef4266bd5e8be50c702d51a436ab',
      redistribution: 'locator_only'
    }),
    source('sysml-official-source-registry-2026-05', 'official_source_registry', 'C1', 'SysML official dual-track source registry', '2026-05', OFFICIAL_REGISTRY_PATH),
    source('sysml-official-bnf-derived-catalog-2026-05', 'derived_official_bnf_catalog', 'C1', 'Derived official textual and graphical BNF production catalog', '2026-05', OFFICIAL_BNF_CATALOG_PATH, {
      licenseReviewRequired: true,
      rawBnfCopied: false
    }),
    source('sysml-language-inventory-pilot-2026-05', 'derived_language_inventory', 'C1', 'SysML 2.1 Beta 1 Pilot 2026-05 language inventory', '2026-05', output.latestInventoryPath),
    source('sysml-production-responsibilities-2026-05-v2', 'production_knowledge_responsibility_manifest', 'C1', 'All-production implementation knowledge responsibilities', '2.0.0', output.responsibilityPath),
    source('sysml-capabilities-p0-p4-v1', 'language_capability_scope', 'C2', 'SysML P0-P4 capability scope', '1.0.0', output.capabilityScopePath),
    source('sysml-v005-production-knowledgeization-report', 'derived_coverage_report', 'C2', 'v005 all-production knowledgeization report', '2026-08-02', output.productionCoveragePath),
    source('sysml-v005-capability-coverage-report', 'derived_coverage_report', 'C2', 'v005 P0-P4 and Model User capability coverage report', '2026-08-02', output.capabilityCoveragePath),
    source('sysml-v005-formal-language-closure-report', 'derived_coverage_report', 'C2', 'v005 formal 2.0 language closure report', '2026-08-02', output.formalCoveragePath),
    source('sysml-v005-knowledge-pattern-coverage-report', 'derived_coverage_report', 'C2', 'v005 high-risk knowledge pattern coverage report', '2026-08-02', output.knowledgePatternCoveragePath),
    source('sysml-v20-v21-beta1-grammar-delta', 'reviewed_release_delta', 'C2', 'SysML 2.0 to 2.1 Beta 1 grammar delta', '2026-05', output.deltaReportPath),
    source('sysml20-model-user-v005-official-knowledge-review', 'review_report', 'C2', 'sysml20-model-user-v005 official knowledge review', '2026-08-02', REVIEW_PATH),
    latestPilotSource('pilot-sysml-xtext-2026-05', 'official_reference_implementation_grammar', 'SysML.xtext', LATEST_GRAMMAR_FILES[0].filePath),
    latestPilotSource('pilot-kerml-xtext-2026-05', 'official_reference_implementation_grammar', 'KerML.xtext', LATEST_GRAMMAR_FILES[1].filePath),
    latestPilotSource('pilot-kerml-expressions-xtext-2026-05', 'official_reference_implementation_grammar', 'KerMLExpressions.xtext', LATEST_GRAMMAR_FILES[2].filePath),
    latestPilotSource('pilot-sysml-ecore-2026-05', 'official_reference_implementation_metamodel', 'SysML.ecore', LATEST_ECORE_FILES[0].filePath),
    latestPilotSource('pilot-kerml-ecore-2026-05', 'official_reference_implementation_metamodel', 'kerml.ecore', LATEST_ECORE_FILES[1].filePath)
  ];
  const replaced = new Set(addedSources.map((item) => item.sourceId));
  return {
    ...clone(baseSourceManifest),
    schemaVersion: '1.3.0',
    forwardCompatibilityRelease: {
      repository: 'https://github.com/Systems-Modeling/SysML-v2-Release',
      releaseTag: '2026-05',
      commitSha: 'de1070ae8e79c21532b8004fc663d47b35d0e9fa',
      languageVersion: 'SysML 2.1 / KerML 1.1 Beta 1',
      normative: false
    },
    forwardCompatibilityPilot: {
      repository: 'https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation',
      releaseTag: '2026-05',
      commitSha: 'fa709f28dfd49dfdb7ee83e4e19da2f57e0eb3aa',
      kernelVersion: '0.60.1',
      normative: false
    },
    sources: [
      ...baseSourceManifest.sources.filter((item) => !replaced.has(item.sourceId)),
      ...addedSources
    ]
  };
}

function source(sourceId, sourceType, authorityLevel, documentName, documentVersion, filePath, metadata = {}) {
  return {
    sourceId,
    sourceType,
    authorityLevel,
    documentName,
    documentVersion,
    path: relative(filePath),
    artifactHash: hashFile(filePath),
    metadata
  };
}

function latestPilotSource(sourceId, sourceType, documentName, repositoryPath) {
  return {
    ...source(sourceId, sourceType, 'C1', documentName, '2026-05 / Beta 1', path.join(PILOT_SOURCE_ROOT, ...repositoryPath.split('/')), {
      appliesTo: 'sysml-2.1-beta1',
      normative: false
    }),
    repositoryUrl: 'https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation',
    repositoryCommit: 'fa709f28dfd49dfdb7ee83e4e19da2f57e0eb3aa',
    repositoryPath
  };
}

function buildKnowledgePatternCoverageReport({ evaluation, authoringPath }) {
  return {
    schemaVersion: 'model-user-knowledge-coverage-report/v1',
    bundleId: 'sysml20-model-user-v005',
    status: evaluation.status,
    evaluatorId: KNOWLEDGE_PATTERN_EVALUATOR_ID,
    inputs: {
      outlineHash: hashFile(OUTLINE_PATH),
      scopeHash: hashFile(KNOWLEDGE_PATTERN_SCOPE_PATH),
      fixtureCatalogHash: hashFile(KNOWLEDGE_PATTERN_FIXTURE_PATH),
      authoringHash: hashFile(authoringPath)
    },
    counts: evaluation.counts,
    gates: evaluation.gates,
    gaps: evaluation.gaps,
    objectives: evaluation.objectives,
    patterns: evaluation.patterns,
    fixtures: evaluation.fixtures,
    resultHash: evaluation.resultHash
  };
}

function addKnowledgePatternGovernance({ manifest, evaluation, coveragePath }) {
  return {
    ...manifest,
    gates: {
      ...manifest.gates,
      modelUserScope: evaluation.gates.scopeCompleteness.status,
      knowledgePatternClosure: evaluation.gates.patternClosure.status,
      semanticFixtureCoverage: evaluation.gates.semanticFixtures.status
    },
    knowledgePatternGovernance: {
      evaluatorId: KNOWLEDGE_PATTERN_EVALUATOR_ID,
      requiredGates: ['modelUserScope', 'knowledgePatternClosure', 'semanticFixtureCoverage'],
      resultHash: evaluation.resultHash,
      status: evaluation.status,
      hashes: {
        outline: hashFile(OUTLINE_PATH),
        scope: hashFile(KNOWLEDGE_PATTERN_SCOPE_PATH),
        fixtureCatalog: hashFile(KNOWLEDGE_PATTERN_FIXTURE_PATH),
        coverageReport: hashFile(coveragePath)
      },
      paths: {
        outline: relative(OUTLINE_PATH),
        scope: relative(KNOWLEDGE_PATTERN_SCOPE_PATH),
        fixtureCatalog: relative(KNOWLEDGE_PATTERN_FIXTURE_PATH),
        coverageReport: relative(coveragePath)
      },
      counts: evaluation.counts
    }
  };
}

function addV005Governance({
  manifest,
  productionEvaluation,
  capabilityEvaluation,
  responsibilityManifest,
  capabilityScope,
  output,
  exactRetrieval
}) {
  const activationReadiness = evaluateActivationReadiness({
    productionResponsibilities: responsibilityManifest.responsibilities,
    capabilityEvaluation
  });
  return {
    ...manifest,
    schemaVersion: '1.3.0',
    gates: {
      ...manifest.gates,
      productionResponsibilityCompleteness: productionEvaluation.gates.productionResponsibilityCompleteness.status,
      productionProjectionIntegrity: productionEvaluation.gates.productionProjectionIntegrity.status,
      productionSourceBinding: productionEvaluation.gates.productionSourceBinding.status,
      productionCapabilityBinding: productionEvaluation.gates.productionCapabilityBinding.status,
      p0p4CapabilityClosure: capabilityEvaluation.gates.p0p4CapabilityClosure.status,
      modelUserObjectiveMappingCompleteness: capabilityEvaluation.gates.modelUserObjectiveMappingCompleteness.status,
      authoritativeClaimEvidenceBindingIntegrity: capabilityEvaluation.gates.authoritativeClaimEvidenceBindingIntegrity.status,
      officialSourceExampleBinding: capabilityEvaluation.gates.officialSourceExampleBinding.status,
      exactRetrievalBindingIntegrity: exactRetrieval.status
    },
    productionKnowledgeGovernance: {
      evaluatorId: PRODUCTION_EVALUATOR_ID,
      capabilityEvaluatorId: CAPABILITY_EVALUATOR_ID,
      status: productionEvaluation.status,
      resultHash: productionEvaluation.resultHash,
      capabilityResultHash: capabilityEvaluation.resultHash,
      responsibilitySetHash: responsibilityManifest.responsibilitySetHash,
      counts: {
        ...productionEvaluation.counts,
        capabilityUnits: capabilityScope.capabilityUnits.length,
        completeCapabilities: capabilityEvaluation.counts.completeCapabilities,
        modelUserObjectives: capabilityEvaluation.counts.modelUserObjectives,
        mappedModelUserObjectives: capabilityEvaluation.counts.mappedModelUserObjectives,
        completeModelUserObjectives: capabilityEvaluation.counts.completeModelUserObjectives,
        partialModelUserObjectives: capabilityEvaluation.counts.partialModelUserObjectives,
        exactRetrievalMappings: exactRetrieval.exactMappings,
        syntaxMappingClaimLinks: exactRetrieval.claimBindings
      },
      hashes: {
        latestInventory: hashFile(output.latestInventoryPath),
        responsibilityManifest: hashFile(output.responsibilityPath),
        capabilityScope: hashFile(output.capabilityScopePath),
        outline: hashFile(OUTLINE_PATH),
        officialRegistry: hashFile(OFFICIAL_REGISTRY_PATH),
        bnfCatalog: hashFile(OFFICIAL_BNF_CATALOG_PATH),
        productionCoverageReport: hashFile(output.productionCoveragePath),
        capabilityCoverageReport: hashFile(output.capabilityCoveragePath),
        deltaReport: hashFile(output.deltaReportPath)
      },
      paths: {
        latestInventory: relative(output.latestInventoryPath),
        responsibilityManifest: relative(output.responsibilityPath),
        capabilityScope: relative(output.capabilityScopePath),
        outline: relative(OUTLINE_PATH),
        officialRegistry: relative(OFFICIAL_REGISTRY_PATH),
        bnfCatalog: relative(OFFICIAL_BNF_CATALOG_PATH),
        productionCoverageReport: relative(output.productionCoveragePath),
        capabilityCoverageReport: relative(output.capabilityCoveragePath),
        deltaReport: relative(output.deltaReportPath)
      },
      representationCoverage: capabilityEvaluation.representationCoverage,
      runtimeStatus: 'bundle_data_and_resolver_core_ready_not_activated'
    },
    activationReadiness
  };
}

function augmentSyntaxMappings(baseMappings) {
  const specs = exactSyntaxSpecs();
  const additions = additionalSyntaxMappings();
  const all = mergeById(baseMappings, additions, 'syntaxMappingId');
  return all.map((mapping) => {
    const spec = specs[mapping.syntaxMappingId];
    if (!spec) {
      return {
        ...clone(mapping),
        retrievalMode: 'candidate_only',
        contextRequired: false,
        claimBindings: []
      };
    }
    const grammarProductionId = spec.semanticGrammarProductionId
      || mapping.grammarProductionId
      || spec.grammarProductionId;
    return {
      ...clone(mapping),
      grammarProductionId,
      retrievalGrammarProductionId: spec.grammarProductionId,
      ...(spec.astContextId ? { astContextId: spec.astContextId } : {}),
      ...(spec.semanticNodeId ? { semanticNodeId: spec.semanticNodeId } : {}),
      retrievalMode: 'exact_closure',
      contextRequired: spec.contextRequired === true,
      claimBindings: spec.claimBindings.map((item, index) => ({
        claimId: item.claimId,
        role: item.role,
        ordinal: index + 1,
        reviewStatus: 'reviewed',
        authorityLevel: 'A1'
      })),
      properties: {
        ...clone(mapping.properties || {}),
        appliesTo: 'sysml-2.0-formal',
        retrievalBasis: 'reviewed official grammar mapping plus A1/A2 Claim closure',
        ...(spec.compositeTokenParts ? { compositeTokenParts: spec.compositeTokenParts } : {}),
        ...(spec.alternativePath ? { alternativePath: spec.alternativePath } : {})
      }
    };
  });
}

function exactSyntaxSpecs() {
  const primary = (claimId) => ({ claimId, role: 'primary' });
  const protective = (claimId) => ({ claimId, role: 'protective' });
  return {
    'syntax-colon-usage': spec('grammar-production:DefinedByKeyword', true, [primary('claim-colon-feature-typing'), protective('claim-typed-usage-inherits-features')]),
    'syntax-colon-gt-definition': spec('grammar-production:SpecializesKeyword', true, [primary('claim-colon-gt-subclassification')]),
    'syntax-colon-gt-usage': spec('grammar-production:SubsetsKeyword', true, [primary('claim-colon-gt-subsetting')]),
    'syntax-language-dfe5ec4feb439316f3352d9b': spec('grammar-production:SpecializesKeyword', true, [primary('claim-colon-gt-subclassification')]),
    'syntax-language-7c2db7eb7ecc864be3223af5': spec('grammar-production:SubsetsKeyword', true, [primary('claim-colon-gt-subsetting')]),
    'syntax-colon-gt-feature': spec('grammar-production:SubsetsKeyword', true, [primary('claim-colon-gt-subsetting')]),
    'syntax-colon-gt-gt': spec('grammar-production:RedefinesKeyword', true, [primary('claim-redefinition')]),
    'syntax-colon-colon-gt': spec('grammar-production:ReferencesKeyword', true, [primary('claim-reference-subsetting'), protective('claim-reference-subsetting-specializes-subsetting')]),
    'syntax-equals': spec('grammar-production:FeatureValue', true, [primary('claim-feature-value-fixed-vs-initial'), protective('claim-feature-value-default')]),
    'syntax-colon-equals': spec('grammar-production:FeatureValue', true, [primary('claim-feature-value-fixed-vs-initial')]),
    'syntax-mu-assign-colon-equals': spec('grammar-production:AssignmentNodeDeclaration', true, [primary('claim-mu-assignment-action'), protective('claim-feature-value-fixed-vs-initial')]),
    'syntax-language-44923355ad06411a38717238': spec('grammar-production:Documentation', false, [primary('claim-grammar-documentation'), protective('claim-mu-comment-documentation')]),
    'syntax-language-6d14d87b7c06ff16fca486ce': spec('grammar-production:ImportPrefix', true, [primary('claim-mu-import-membership'), protective('claim-mu-import-filter')]),
    'syntax-mu-import': spec('grammar-production:ImportPrefix', true, [primary('claim-mu-import-namespace'), protective('claim-mu-import-filter')], null, {
      semanticGrammarProductionId: 'grammar-production:NamespaceImport',
      astContextId: 'sysml20:NamespaceImport',
      semanticNodeId: 'kerml10:Import',
      alternativePath: 'Import/NamespaceImport/ImportPrefix'
    }),
    'syntax-language-dc001269a31f2b4a1880cc38': spec('grammar-production:MultiplicityRange', true, [primary('claim-mu-multiplicity')]),
    'syntax-language-44230eda074259ee65098bbf': spec('grammar-production:MultiplicityRange', true, [primary('claim-mu-multiplicity')]),
    'syntax-language-7ffa2d49a1d6f1f3e58d0867': spec('grammar-production:MultiplicityRange', true, [primary('claim-mu-multiplicity')]),
    'syntax-language-5493f35ebaf6653150cfca2a': spec('grammar-production:PerformActionUsage', false, [primary('claim-mu-perform-action')]),
    'syntax-language-e06723fb66296990104470dd': spec('grammar-production:AllocateKeyword', true, [primary('claim-mu-allocation-usage'), protective('claim-mu-allocation')]),
    'syntax-mu-allocate': spec('grammar-production:AllocateKeyword', true, [primary('claim-mu-allocation-usage'), protective('claim-mu-allocation')], null, {
      semanticGrammarProductionId: 'grammar-production:AllocationUsage',
      astContextId: 'sysml20:AllocationUsage',
      semanticNodeId: 'sysml20:AllocationUsage'
    }),
    'syntax-language-ac679d806f92a7f9d540097a': spec('grammar-production:RequirementVerificationKind', false, [primary('claim-mu-verification-case'), protective('claim-mu-requirement-reference-boundary')]),
    'syntax-mu-package': spec('grammar-production:PackageDeclaration', false, [primary('claim-mu-package-alias'), protective('claim-mu-namespace-membership')]),
    'syntax-mu-item': spec('grammar-production:ItemKeyword', false, [primary('claim-mu-item')]),
    'syntax-mu-part': spec('grammar-production:PartKeyword', false, [primary('claim-mu-part')]),
    'syntax-mu-port': spec('grammar-production:PortKeyword', false, [primary('claim-mu-port'), protective('claim-mu-conjugated-port')]),
    'syntax-mu-connect': spec('grammar-production:ConnectorKeyword', false, [primary('claim-mu-connection'), protective('claim-reference-subsetting')]),
    'syntax-mu-bind': spec('grammar-production:BindingConnectorAsUsage', false, [primary('claim-mu-binding'), protective('claim-feature-value-fixed-vs-initial')]),
    'syntax-mu-flow': spec('grammar-production:FlowKeyword', false, [primary('claim-mu-flow'), protective('claim-mu-message')]),
    'syntax-mu-action': spec('grammar-production:ActionKeyword', false, [primary('claim-mu-action'), protective('claim-mu-action-declaration')]),
    'syntax-mu-assign': spec('grammar-production:AssignmentNodeDeclaration', false, [primary('claim-mu-assignment-action')]),
    'syntax-mu-state': spec('grammar-production:StateKeyword', false, [primary('claim-mu-state')]),
    'syntax-mu-transition': spec('grammar-production:TransitionUsageKeyword', false, [primary('claim-mu-transition')]),
    'syntax-mu-calc': spec('grammar-production:CalculationKeyword', false, [primary('claim-mu-calculation'), protective('claim-mu-calculation-purity-boundary')]),
    'syntax-mu-constraint': spec('grammar-production:ConstraintKeyword', false, [primary('claim-mu-constraint')]),
    'syntax-mu-requirement': spec('grammar-production:RequirementKeyword', false, [primary('claim-mu-requirement'), protective('claim-mu-requirement-assume-require')]),
    'syntax-mu-satisfy': spec('grammar-production:SatisfyRequirementUsage', false, [primary('claim-mu-satisfy'), protective('claim-mu-requirement-reference-boundary')]),
    'syntax-mu-metadata': spec('grammar-production:MetadataUsageKeyword', true, [primary('claim-mu-metadata'), protective('claim-mu-metadata-declaration')]),
    'syntax-mu-variation': spec('grammar-production:BasicDefinitionPrefix', false, [primary('claim-mu-variation')]),
    'syntax-mu-snapshot': spec('grammar-production:PortionKind', false, [primary('claim-mu-timeslice-snapshot')]),
    'syntax-mu-send': spec('grammar-production:SendNodeDeclaration', false, [primary('claim-mu-send-action'), protective('claim-mu-send-realization-boundary')]),
    'syntax-mu-accept': spec('grammar-production:AcceptNodeDeclaration', false, [primary('claim-mu-accept-action'), protective('claim-mu-accept-realization-boundary')]),
    'syntax-mu-view': spec('grammar-production:ViewKeyword', true, [primary('claim-mu-view-usage'), protective('claim-mu-view-viewpoint')], null, {
      semanticGrammarProductionId: 'grammar-production:ViewUsage'
    }),
    'syntax-mu-view-definition': spec('grammar-production:ViewKeyword', true, [primary('claim-mu-view-definition'), protective('claim-mu-viewpoint-definition')], null, {
      semanticGrammarProductionId: 'grammar-production:ViewDefinition'
    }),
    'syntax-mu-viewpoint': spec('grammar-production:ViewpointKeyword', true, [primary('claim-mu-viewpoint-usage'), protective('claim-mu-viewpoint-definition')], null, {
      semanticGrammarProductionId: 'grammar-production:ViewpointUsage'
    }),
    'syntax-mu-viewpoint-definition': spec('grammar-production:ViewpointKeyword', true, [primary('claim-mu-viewpoint-definition')], null, {
      semanticGrammarProductionId: 'grammar-production:ViewpointDefinition'
    }),
    'syntax-reference-subsetting-feature': spec('grammar-production:ReferencesKeyword', true, [primary('claim-reference-subsetting'), protective('claim-reference-subsetting-specializes-subsetting')], null, {
      semanticGrammarProductionId: 'grammar-production:References'
    }),
    'syntax-mu-assume': spec('grammar-production:RequirementConstraintKind', false, [primary('claim-mu-requirement-assume-require')]),
    'syntax-mu-require': spec('grammar-production:RequirementConstraintKind', false, [primary('claim-mu-requirement-assume-require')]),
    'syntax-default-equals': spec('grammar-production:FeatureValue', true, [primary('claim-feature-value-default'), protective('claim-feature-value-fixed-vs-initial')], ['default', '=']),
    'syntax-default-colon-equals': spec('grammar-production:FeatureValue', true, [primary('claim-feature-value-default'), protective('claim-feature-value-fixed-vs-initial')], ['default', ':='])
  };
}

function additionalSyntaxMappings() {
  return [
    mapping('syntax-mu-send', 'send', 'sysml20:SendActionUsage', 'sysml20:SendActionUsage'),
    mapping('syntax-mu-accept', 'accept', 'sysml20:AcceptActionUsage', 'sysml20:AcceptActionUsage'),
    mapping('syntax-mu-view', 'view', 'sysml20:ViewUsage', 'sysml20:ViewUsage'),
    mapping('syntax-mu-view-definition', 'view', 'sysml20:ViewDefinition', 'sysml20:ViewDefinition'),
    mapping('syntax-mu-viewpoint', 'viewpoint', 'sysml20:ViewpointUsage', 'sysml20:ViewpointUsage'),
    mapping('syntax-mu-viewpoint-definition', 'viewpoint', 'sysml20:ViewpointDefinition', 'sysml20:ViewpointDefinition'),
    mapping('syntax-reference-subsetting-feature', '::>', 'kerml10:Feature', 'kerml10:ReferenceSubsetting'),
    mapping('syntax-mu-assume', 'assume', 'sysml20:RequirementUsage', 'sysml20:RequirementUsage'),
    mapping('syntax-mu-require', 'require', 'sysml20:RequirementUsage', 'sysml20:RequirementUsage'),
    mapping('syntax-default-equals', 'default =', 'sysml20:FeatureValue', 'sysml20:FeatureValue'),
    mapping('syntax-default-colon-equals', 'default :=', 'sysml20:FeatureValue', 'sysml20:FeatureValue')
  ];
}

function mapping(syntaxMappingId, token, astContextId, semanticNodeId) {
  return { syntaxMappingId, token, astContextId, semanticNodeId, mappingType: 'DENOTES' };
}

function spec(grammarProductionId, contextRequired, claimBindings, compositeTokenParts = null, options = {}) {
  return { grammarProductionId, contextRequired, claimBindings, compositeTokenParts, ...options };
}

function validateExactRetrievalBindings(authoring, inventory) {
  const claimIds = new Set(authoring.claims.map((item) => item.claimId));
  const productionById = new Map(inventory.productions.map((item) => [item.productionId, item]));
  let exactMappings = 0;
  let claimBindings = 0;
  for (const mapping of authoring.syntaxMappings) {
    if (mapping.retrievalMode !== 'exact_closure') continue;
    exactMappings += 1;
    const bindings = mapping.claimBindings || [];
    claimBindings += bindings.length;
    if (!bindings.some((item) => item.role === 'primary')) {
      throw new Error(`Exact syntax mapping lacks a primary Claim binding: ${mapping.syntaxMappingId}`);
    }
    if (bindings.some((item) => !claimIds.has(item.claimId) || !['primary', 'protective'].includes(item.role))) {
      throw new Error(`Exact syntax mapping has an invalid Claim binding: ${mapping.syntaxMappingId}`);
    }
    const productionId = mapping.retrievalGrammarProductionId || mapping.grammarProductionId;
    const production = productionById.get(productionId);
    if (!production) throw new Error(`Exact syntax mapping has an unknown production: ${mapping.syntaxMappingId}`);
    const tokenParts = mapping.properties?.compositeTokenParts || [mapping.token];
    if (!tokenParts.every((token) => production.directLiterals.includes(token))) {
      throw new Error(`Exact syntax mapping token is not bound by its official grammar production: ${mapping.syntaxMappingId}`);
    }
  }
  if (exactMappings === 0 || claimBindings === 0) throw new Error('v005 requires exact retrieval bindings');
  return { status: 'PASS', exactMappings, claimBindings };
}

function resolveOutputs(options) {
  const values = {
    latestInventoryPath: options.latestInventoryPath || LATEST_INVENTORY_PATH,
    responsibilityPath: options.responsibilityPath || RESPONSIBILITY_PATH,
    capabilityScopePath: options.capabilityScopePath || CAPABILITY_SCOPE_PATH,
    productionCoveragePath: options.productionCoveragePath || PRODUCTION_COVERAGE_PATH,
    capabilityCoveragePath: options.capabilityCoveragePath || CAPABILITY_COVERAGE_PATH,
    formalCoveragePath: options.formalCoveragePath || FORMAL_COVERAGE_PATH,
    knowledgePatternCoveragePath: options.knowledgePatternCoveragePath || KNOWLEDGE_PATTERN_COVERAGE_PATH,
    deltaReportPath: options.deltaReportPath || DELTA_REPORT_PATH,
    authoringPath: options.authoringPath || AUTHORING_PATH,
    sourceManifestPath: options.sourceManifestPath || SOURCE_MANIFEST_PATH,
    bundleDir: options.bundleDir || BUNDLE_DIR
  };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, resolveOutput(value)]));
}

function requirePass(label, evaluation) {
  if (evaluation.status !== 'PASS') {
    throw new Error(`${label} failed: ${JSON.stringify((evaluation.gaps || []).slice(0, 12))}`);
  }
}

function mergeEdgesByTriple(base, additions) {
  const result = clone(base || []);
  const keys = new Set(result.map((item) => `${item.sourceNodeId}\u0000${item.predicate}\u0000${item.targetNodeId}`));
  for (const edge of additions || []) {
    const key = `${edge.sourceNodeId}\u0000${edge.predicate}\u0000${edge.targetNodeId}`;
    if (!keys.has(key)) {
      keys.add(key);
      result.push(clone(edge));
    }
  }
  return result;
}

function mergeById(base, additions, field) {
  const result = clone(base || []);
  const index = new Map(result.map((item, position) => [item[field], position]));
  for (const item of additions || []) {
    const position = index.get(item[field]);
    if (position === undefined) {
      index.set(item[field], result.length);
      result.push(clone(item));
    } else {
      result[position] = clone(item);
    }
  }
  return result;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((item) => String(item || '')).filter(Boolean))];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeCanonicalJson(filePath, value) {
  ensureOutputDirectory(filePath);
  fs.writeFileSync(filePath, `${canonicalStringify(value, 2)}\n`, 'utf8');
}

function writeJson(filePath, value) {
  ensureOutputDirectory(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function ensureOutputDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function resolveOutput(value) {
  const resolved = path.resolve(value);
  const temp = path.resolve(process.env.TEMP || process.env.TMP || '');
  if (resolved !== PROJECT_ROOT && !resolved.startsWith(`${PROJECT_ROOT}${path.sep}`)
    && resolved !== temp && !resolved.startsWith(`${temp}${path.sep}`)) {
    throw new Error(`Output path is outside the project or temporary directory: ${value}`);
  }
  return resolved;
}

function projectPath(relativePath) {
  return path.resolve(PROJECT_ROOT, relativePath);
}

function relative(value) {
  return path.relative(PROJECT_ROOT, value).replace(/\\/gu, '/');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

if (require.main === module) {
  try {
    const result = buildModelUserV005Bundle();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      bundleId: result.manifest.bundleId,
      contentHash: result.manifest.contentHash,
      counts: result.manifest.counts,
      productionKnowledgeGovernance: result.manifest.productionKnowledgeGovernance,
      gates: result.manifest.gates,
      bundleDir: result.bundleDir
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  augmentSyntaxMappings,
  buildGrammarDeltaReport,
  buildModelUserV005Bundle,
  buildV005Authoring,
  reviewedResponsibilities,
  validateExactRetrievalBindings
};
