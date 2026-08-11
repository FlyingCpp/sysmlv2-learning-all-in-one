'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  buildF0KnowledgeBundle,
  hashFile
} = require('./build-f0-bundle');
const {
  createInventoryFromFiles,
  diagnosticCount
} = require('./extract-language-inventory');
const { canonicalStringify } = require('./language-inventory');
const { materializeLanguageProjection } = require('./language-bundle-projection');
const { evaluateLanguageClosure } = require('./language-closure');
const {
  evaluateDiagnosticAnchors,
  normalizeDiagnostics
} = require('./run-language-fixtures');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const V002_AUTHORING_PATH = projectPath('resources/sysml-knowledge/authoring/sysml20-model-user-v002.json');
const V002_SOURCE_MANIFEST_PATH = projectPath('resources/sysml-knowledge/sources/manifests/sysml-2.0-model-user-v002.json');
const V002_BUNDLE_MANIFEST_PATH = projectPath('resources/sysml-knowledge/bundles/sysml20-model-user-v002/manifest.json');
const INVENTORY_PATH = projectPath('resources/sysml-knowledge/language/baselines/sysml-2.0-pilot-2026-04-inventory.json');
const SCOPE_PATH = projectPath('resources/sysml-knowledge/language/scopes/model-user-textual-closure-v1.json');
const FIXTURE_DIRECTORY = projectPath('resources/sysml-knowledge/language/fixtures/model-user-textual-closure-v1');
const FIXTURE_CATALOG_PATH = path.join(FIXTURE_DIRECTORY, 'catalog.json');
const VALIDATOR_REPORT_PATH = projectPath('resources/sysml-knowledge/language/validator-runs/model-user-textual-closure-v1-official.json');
const COVERAGE_REPORT_PATH = projectPath('resources/sysml-knowledge/eval/sysml20-model-user-v003-language-closure.json');
const SPEC_PATH = projectPath('docs/sysml-knowledge-language-inventory-closure-v003-spec-2026-07-26.md');
const REVIEW_PATH = projectPath('docs/sysml20-model-user-v003-language-closure-authoring-review-2026-07-26.md');
const AUTHORING_PATH = projectPath('resources/sysml-knowledge/authoring/sysml20-model-user-v003.json');
const SOURCE_MANIFEST_PATH = projectPath('resources/sysml-knowledge/sources/manifests/sysml-2.0-model-user-v003.json');
const BUNDLE_DIR = projectPath('resources/sysml-knowledge/bundles/sysml20-model-user-v003');
const LANGUAGE_GOVERNANCE_EVALUATOR_ID = 'sysml-language-closure/v1';
const REQUIRED_LANGUAGE_GATES = Object.freeze([
  'languageInventory',
  'scopeCompleteness',
  'semanticClosure',
  'fixtureCoverage'
]);

const SOURCE_ID_MAP = Object.freeze({
  SysML: 'pilot-sysml-xtext-2026-04',
  KerML: 'pilot-kerml-xtext-2026-04',
  KerMLExpressions: 'pilot-kerml-expressions-xtext-2026-04',
  'SysML.ecore': 'pilot-sysml-ecore-2026-04',
  'kerml.ecore': 'pilot-kerml-ecore-2026-04'
});

function buildModelUserV003Bundle(options = {}) {
  const inventoryPath = resolveOutput(options.inventoryPath || INVENTORY_PATH);
  const coverageReportPath = resolveOutput(options.coverageReportPath || COVERAGE_REPORT_PATH);
  const authoringPath = resolveOutput(options.authoringPath || AUTHORING_PATH);
  const sourceManifestPath = resolveOutput(options.sourceManifestPath || SOURCE_MANIFEST_PATH);
  const bundleDir = resolveOutput(options.bundleDir || BUNDLE_DIR);

  const baseAuthoring = readJson(V002_AUTHORING_PATH);
  const baseSourceManifest = readJson(V002_SOURCE_MANIFEST_PATH);
  const parentManifest = readJson(V002_BUNDLE_MANIFEST_PATH);
  const scopeManifest = readJson(SCOPE_PATH);
  const fixtureCatalog = readJson(FIXTURE_CATALOG_PATH);
  const validatorReport = readJson(VALIDATOR_REPORT_PATH);

  const inventory = createInventoryFromFiles();
  if (diagnosticCount(inventory) !== 0) {
    throw new Error(`Language inventory contains ${diagnosticCount(inventory)} unresolved diagnostic item(s)`);
  }
  writeInventory(inventoryPath, inventory);
  validateFixtureEvidence({ fixtureCatalog, validatorReport, validatorLock: baseSourceManifest.validator });

  const projection = materializeLanguageProjection({
    inventory,
    scopeManifest,
    baseNodes: baseAuthoring.nodes,
    sourceIdMap: SOURCE_ID_MAP
  });
  const authoring = buildAuthoring({
    baseAuthoring,
    parentManifest,
    inventory,
    scopeManifest,
    fixtureCatalog,
    projection,
    inventoryPath,
    coverageReportPath
  });
  writeJson(authoringPath, authoring);

  const evaluation = evaluateLanguageClosure({
    inventory,
    scopeManifest,
    bundle: authoring,
    fixtureCatalog,
    validatorReport
  });
  if (evaluation.status !== 'PASS') {
    throw new Error(`Language closure evaluation failed: ${JSON.stringify(evaluation.gaps.slice(0, 12))}`);
  }

  const coverageReport = buildCoverageReport({
    evaluation,
    inventory,
    scopeManifest,
    fixtureCatalog,
    validatorReport,
    authoringPath
  });
  writeJson(coverageReportPath, coverageReport);

  const sourceManifest = buildSourceManifest({
    baseSourceManifest,
    inventoryPath,
    coverageReportPath,
    fixtureCatalog
  });
  writeJson(sourceManifestPath, sourceManifest);

  const built = buildF0KnowledgeBundle({ sourceManifestPath, authoringPath, bundleDir });
  const manifest = addLanguageGovernanceToManifest({
    manifest: built.manifest,
    evaluation,
    inventory,
    inventoryPath,
    coverageReportPath,
    scopeManifest,
    fixtureCatalog,
    validatorReport
  });
  writeJson(built.manifestPath, manifest);

  return {
    ...built,
    manifest,
    evaluation,
    inventory,
    coverageReport,
    authoring,
    sourceManifest
  };
}

function buildAuthoring({
  baseAuthoring,
  parentManifest,
  inventory,
  scopeManifest,
  fixtureCatalog,
  projection,
  inventoryPath,
  coverageReportPath
}) {
  if (parentManifest.bundleId !== 'sysml20-model-user-v002') {
    throw new Error(`Unexpected parent Bundle: ${parentManifest.bundleId || ''}`);
  }
  const evidenceBlocks = languageEvidenceBlocks();
  const claims = languageClaims();
  const syntaxMappings = languageSyntaxMappings({
    resolvedScope: projection.resolvedScope,
    fixtureCatalog,
    inventoryId: inventory.inventoryId
  });

  return {
    schemaVersion: '1.2.0',
    bundleId: 'sysml20-model-user-v003',
    baselineId: baseAuthoring.baselineId,
    version: '2026.07.26-mu.3',
    parentBundleId: parentManifest.bundleId,
    parentContentHash: parentManifest.contentHash,
    review: {
      status: 'PASS',
      reviewedBy: 'main-agent-plus-independent-language-closure-audit',
      reviewedAt: '2026-07-26T18:00:00.000+08:00',
      reviewSourceId: 'sysml20-model-user-v003-language-closure-review'
    },
    languageGovernance: {
      required: true,
      evaluatorId: LANGUAGE_GOVERNANCE_EVALUATOR_ID,
      requiredGates: [...REQUIRED_LANGUAGE_GATES],
      paths: {
        inventory: relative(inventoryPath),
        scopeManifest: relative(SCOPE_PATH),
        fixtureCatalog: relative(FIXTURE_CATALOG_PATH),
        validatorReport: relative(VALIDATOR_REPORT_PATH),
        coverageReport: relative(coverageReportPath)
      }
    },
    nodes: projection.nodes,
    edges: mergeEdgesByTriple(baseAuthoring.edges, projection.languageEdges),
    evidenceBlocks: mergeById(baseAuthoring.evidenceBlocks, evidenceBlocks, 'evidenceId'),
    claims: mergeById(baseAuthoring.claims, claims, 'claimId'),
    syntaxMappings: mergeById(baseAuthoring.syntaxMappings, syntaxMappings, 'syntaxMappingId'),
    teachingOverlays: []
  };
}

function languageEvidenceBlocks() {
  return [
    evidence('ev-language-documentation-grammar', '8.2.2.4.2 Documentation', 10105, 10108, 'grammar_rule', {
      operators: ['doc'],
      conceptIds: ['sysml20:Documentation'],
      astContextIds: ['sysml20:Documentation']
    }),
    evidence('ev-language-documentation-semantics', '7.4.2 Comments and Documentation', 2011, 2013, 'semantic_rule', {
      conceptIds: ['sysml20:Documentation', 'sysml20:Comment'],
      astContextIds: ['sysml20:Documentation']
    }),
    evidence('ev-language-requirement-informal-documentation', '7.21.2 Requirements', 8261, 8263, 'semantic_rule', {
      conceptIds: ['sysml20:RequirementUsage', 'sysml20:Documentation'],
      astContextIds: ['sysml20:RequirementUsage']
    }),
    evidence('ev-language-membership-import-grammar', '8.2.2.4.4 Imports', 10165, 10180, 'grammar_rule', {
      operators: ['import'],
      conceptIds: ['sysml20:MembershipImport'],
      astContextIds: ['sysml20:MembershipImport']
    }),
    evidence('ev-language-specialization-context-grammar', '8.2.2.6.5 Specialization', 10449, 10488, 'grammar_rule', {
      operators: [':>'],
      conceptIds: ['kerml10:Subclassification', 'kerml10:Subsetting'],
      astContextIds: ['sysml20:Definition', 'sysml20:Usage']
    }),
    evidence('ev-language-multiplicity-range-grammar', '8.2.2.6.6 Multiplicity', 10531, 10548, 'grammar_rule', {
      operators: ['[', '..', ']'],
      conceptIds: ['sysml20:MultiplicityRange'],
      astContextIds: ['sysml20:MultiplicityRange']
    }),
    evidence('ev-language-allocation-grammar', '8.2.2.15 Allocations Textual Notation', 10852, 10865, 'grammar_rule', {
      operators: ['allocate'],
      conceptIds: ['sysml20:AllocationUsage'],
      astContextIds: ['sysml20:AllocationUsage']
    }),
    evidence('ev-language-perform-action-grammar', '8.2.2.17.2 Action Usages', 11021, 11038, 'grammar_rule', {
      operators: ['perform'],
      conceptIds: ['sysml20:PerformActionUsage'],
      astContextIds: ['sysml20:PerformActionUsage']
    }),
    evidence('ev-language-requirement-verification-grammar', '8.2.2.24 Verification Cases Textual Notation', 11658, 11678, 'grammar_rule', {
      operators: ['verify'],
      conceptIds: ['sysml20:RequirementVerificationMembership'],
      astContextIds: ['sysml20:RequirementVerificationMembership']
    })
  ];
}

function languageClaims() {
  return [
    claim({
      claimId: 'claim-grammar-documentation',
      subjectNodeId: 'sysml20:Documentation',
      objectNodeId: 'grammar-production:Documentation',
      operators: ['doc'],
      astContextIds: ['sysml20:Documentation'],
      claimText: 'Documentation 的文本记法由 doc 引入，正文由 REGULAR_COMMENT 承载；Documentation 是面向其 owning element 的 distinguished Comment。',
      evidenceIds: ['ev-language-documentation-grammar', 'ev-language-documentation-semantics'],
      coverageUnitIds: ['cu-documentation']
    }),
    claim({
      claimId: 'claim-documentation-requirement-informal-text',
      subjectNodeId: 'sysml20:RequirementUsage',
      predicate: 'HAS_INFORMAL_TEXT_FROM',
      objectNodeId: 'sysml20:Documentation',
      operators: ['doc'],
      astContextIds: ['sysml20:RequirementUsage'],
      claimText: 'Requirement definition 或 usage 的 informal text 来自其 body 中的 Documentation comments；普通 Comment 不能据此被当作等价的 requirement informal text。',
      evidenceIds: ['ev-language-requirement-informal-documentation', 'ev-language-documentation-semantics'],
      coverageUnitIds: ['cu-documentation']
    }),
    claim({
      claimId: 'claim-grammar-membership-import',
      subjectNodeId: 'sysml20:MembershipImport',
      objectNodeId: 'grammar-production:MembershipImport',
      operators: ['import'],
      astContextIds: ['sysml20:MembershipImport'],
      claimText: 'MembershipImport 是 ImportDeclaration 的一种分支，并通过 import 前缀导入一个 qualified membership。',
      evidenceIds: ['ev-language-membership-import-grammar'],
      coverageUnitIds: ['cu-membership-import']
    }),
    claim({
      claimId: 'claim-grammar-multiplicity-range',
      subjectNodeId: 'sysml20:MultiplicityRange',
      objectNodeId: 'grammar-production:MultiplicityRange',
      operators: ['[', '..', ']'],
      astContextIds: ['sysml20:MultiplicityRange'],
      claimText: 'MultiplicityRange 使用方括号界定范围，并可用 .. 分隔上下界表达式；这些标点是 lexeme，不是独立 metaclass。',
      evidenceIds: ['ev-language-multiplicity-range-grammar'],
      coverageUnitIds: ['cu-multiplicity-range']
    }),
    claim({
      claimId: 'claim-grammar-subclassification-context',
      subjectNodeId: 'kerml10:Subclassification',
      objectNodeId: 'grammar-production:SubclassificationPart',
      operators: [':>'],
      astContextIds: ['sysml20:Definition'],
      claimText: '在 Definition/Classifier 的 SubclassificationPart 上下文中，specialization 关系构造为 Subclassification；该上下文不能与 Usage 的 Subsetting 合并。',
      evidenceIds: ['ev-language-specialization-context-grammar'],
      coverageUnitIds: ['cu-subclassification']
    }),
    claim({
      claimId: 'claim-grammar-subsetting-context',
      subjectNodeId: 'kerml10:Subsetting',
      objectNodeId: 'grammar-production:Subsettings',
      operators: [':>'],
      astContextIds: ['sysml20:Usage'],
      claimText: '在 Usage/Feature 的 Subsettings 上下文中，specialization 关系构造为 Subsetting；相同 :> lexeme 必须结合 grammar production 与 AST context 解释。',
      evidenceIds: ['ev-language-specialization-context-grammar'],
      coverageUnitIds: ['cu-subsetting']
    }),
    claim({
      claimId: 'claim-grammar-perform-action',
      subjectNodeId: 'sysml20:PerformActionUsage',
      objectNodeId: 'grammar-production:PerformActionUsage',
      operators: ['perform'],
      astContextIds: ['sysml20:PerformActionUsage'],
      claimText: 'PerformActionUsage 由 perform textual production 引入，并由 PerformActionUsageDeclaration 与 ActionBody 完成。',
      evidenceIds: ['ev-language-perform-action-grammar'],
      coverageUnitIds: ['cu-perform-action']
    }),
    claim({
      claimId: 'claim-grammar-allocation',
      subjectNodeId: 'sysml20:AllocationUsage',
      objectNodeId: 'grammar-production:AllocationUsage',
      operators: ['allocate'],
      astContextIds: ['sysml20:AllocationUsage'],
      claimText: 'AllocationUsage 的 textual production 可通过 allocation usage declaration 或 allocate connector part 表达。',
      evidenceIds: ['ev-language-allocation-grammar'],
      coverageUnitIds: ['cu-allocation']
    }),
    claim({
      claimId: 'claim-grammar-requirement-verification',
      subjectNodeId: 'sysml20:RequirementVerificationMembership',
      objectNodeId: 'grammar-production:RequirementVerificationMember',
      operators: ['verify'],
      astContextIds: ['sysml20:RequirementVerificationMembership'],
      claimText: 'RequirementVerificationMember 以 verify requirement kind 引入 RequirementVerificationUsage，并构造 RequirementVerificationMembership。',
      evidenceIds: ['ev-language-requirement-verification-grammar'],
      coverageUnitIds: ['cu-requirement-verification']
    })
  ];
}

function languageSyntaxMappings({ resolvedScope, fixtureCatalog, inventoryId }) {
  const positiveFixtureByUnit = new Map();
  for (const fixture of fixtureCatalog.fixtures) {
    if (fixture.kind !== 'positive') continue;
    for (const coverageUnitId of fixture.coverageUnitIds || []) {
      if (!positiveFixtureByUnit.has(coverageUnitId)) {
        positiveFixtureByUnit.set(coverageUnitId, fixture.fixtureId);
      }
    }
  }
  const mappings = [];
  for (const scoped of resolvedScope.filter((item) => item.disposition === 'covered')) {
    for (const unit of scoped.coverageUnits) {
      const parserFixtureId = positiveFixtureByUnit.get(unit.coverageUnitId);
      if (!parserFixtureId) throw new Error(`Coverage unit has no positive fixture: ${unit.coverageUnitId}`);
      for (const assertion of unit.lexemeAssertions) {
        const grammarProductionId = assertion.mappingProductionId || unit.grammarProductionId;
        const identity = [
          assertion.value,
          grammarProductionId,
          unit.astContextId,
          unit.semanticNodeId
        ].join('\u0000');
        mappings.push({
          syntaxMappingId: `syntax-language-${sha256(identity).slice(0, 24)}`,
          token: assertion.value,
          grammarProductionId,
          astContextId: unit.astContextId,
          semanticNodeId: unit.semanticNodeId,
          mappingType: 'CONSTRUCTS_IN_CONTEXT',
          parserFixtureId,
          properties: {
            languageInventoryId: inventoryId,
            coverageUnitId: unit.coverageUnitId,
            alternativePath: unit.alternativePath
          }
        });
      }
    }
  }
  return mappings;
}

function buildCoverageReport({
  evaluation,
  inventory,
  scopeManifest,
  fixtureCatalog,
  validatorReport,
  authoringPath,
  bundleId = 'sysml20-model-user-v003'
}) {
  const dispositionCounts = {};
  for (const item of evaluation.resolvedScope) {
    dispositionCounts[item.disposition] = (dispositionCounts[item.disposition] || 0) + 1;
  }
  return {
    schemaVersion: 'sysml-language-closure-report/v1',
    bundleId,
    status: evaluation.status,
    inventoryId: inventory.inventoryId,
    scopeId: scopeManifest.scopeId,
    fixtureSetId: fixtureCatalog.fixtureSetId,
    validatorRunId: validatorReport.validatorRunId,
    inputs: {
      inventoryHash: inventory.contentHash,
      scopeManifestHash: hashFile(SCOPE_PATH),
      fixtureCatalogHash: hashFile(FIXTURE_CATALOG_PATH),
      validatorReportHash: hashFile(VALIDATOR_REPORT_PATH),
      authoringHash: hashFile(authoringPath)
    },
    counts: evaluation.counts,
    dispositionCounts,
    gates: evaluation.gates,
    gaps: evaluation.gaps,
    coverageUnits: evaluation.coverageUnits,
    resultHash: evaluation.resultHash
  };
}

function buildSourceManifest({
  baseSourceManifest,
  inventoryPath,
  coverageReportPath,
  fixtureCatalog
}) {
  const addedSources = [
    pilotSource({
      sourceId: 'pilot-sysml-xtext-2026-04',
      sourceType: 'official_reference_implementation_grammar',
      documentName: 'SysML v2 Pilot Implementation SysML.xtext',
      relativePath: 'resources/sysml-knowledge/sources/grammar/pilot-2026-04/org/omg/sysml/xtext/SysML.xtext',
      jarEntry: 'org/omg/sysml/xtext/SysML.xtext'
    }),
    pilotSource({
      sourceId: 'pilot-kerml-xtext-2026-04',
      sourceType: 'official_reference_implementation_grammar',
      documentName: 'SysML v2 Pilot Implementation KerML.xtext',
      relativePath: 'resources/sysml-knowledge/sources/grammar/pilot-2026-04/org/omg/kerml/xtext/KerML.xtext',
      jarEntry: 'org/omg/kerml/xtext/KerML.xtext'
    }),
    pilotSource({
      sourceId: 'pilot-kerml-expressions-xtext-2026-04',
      sourceType: 'official_reference_implementation_grammar',
      documentName: 'SysML v2 Pilot Implementation KerMLExpressions.xtext',
      relativePath: 'resources/sysml-knowledge/sources/grammar/pilot-2026-04/org/omg/kerml/expressions/xtext/KerMLExpressions.xtext',
      jarEntry: 'org/omg/kerml/expressions/xtext/KerMLExpressions.xtext'
    }),
    pilotSource({
      sourceId: 'pilot-sysml-ecore-2026-04',
      sourceType: 'official_reference_implementation_metamodel',
      documentName: 'SysML v2 Pilot Implementation SysML.ecore',
      relativePath: 'resources/sysml-knowledge/sources/grammar/pilot-2026-04/model/SysML.ecore',
      jarEntry: 'model/SysML.ecore'
    }),
    pilotSource({
      sourceId: 'pilot-kerml-ecore-2026-04',
      sourceType: 'official_reference_implementation_metamodel',
      documentName: 'SysML v2 Pilot Implementation kerml.ecore',
      relativePath: 'resources/sysml-knowledge/sources/grammar/pilot-2026-04/model/kerml.ecore',
      jarEntry: 'model/kerml.ecore'
    }),
    localSource({
      sourceId: 'sysml-language-inventory-pilot-2026-04',
      sourceType: 'derived_language_inventory',
      authorityLevel: 'C1',
      documentName: 'SysML 2.0 Pilot 2026-04 language inventory',
      documentVersion: '1.0.0',
      filePath: inventoryPath,
      metadata: { derivation: 'deterministic Xtext and Ecore extraction' }
    }),
    localSource({
      sourceId: 'sysml-language-scope-model-user-textual-closure-v1',
      sourceType: 'language_scope_policy',
      authorityLevel: 'C2',
      documentName: 'Model User textual language closure scope',
      documentVersion: '1.0.0',
      filePath: SCOPE_PATH
    }),
    localSource({
      sourceId: 'sysml-language-fixture-catalog-model-user-textual-closure-v1',
      sourceType: 'validator_fixture_catalog',
      authorityLevel: 'C2',
      documentName: 'Model User textual language closure fixture catalog',
      documentVersion: '1.0.0',
      filePath: FIXTURE_CATALOG_PATH
    }),
    ...fixtureCatalog.fixtures.map((fixture) => localSource({
      sourceId: `sysml-language-${fixture.fixtureId}`,
      sourceType: 'validator_fixture_model',
      authorityLevel: 'C2',
      documentName: fixture.fixtureId,
      documentVersion: '1.0.0',
      filePath: path.join(FIXTURE_DIRECTORY, fixture.path),
      metadata: {
        fixtureKind: fixture.kind,
        coverageUnitIds: fixture.coverageUnitIds
      }
    })),
    localSource({
      sourceId: 'sysml-language-validator-run-model-user-textual-closure-v1',
      sourceType: 'official_validator_run_report',
      authorityLevel: 'C1',
      documentName: 'Official Pilot validator report for language closure fixtures',
      documentVersion: '2026-04 / kernel 0.59.0',
      filePath: VALIDATOR_REPORT_PATH
    }),
    localSource({
      sourceId: 'sysml-language-closure-report-model-user-v003',
      sourceType: 'derived_coverage_report',
      authorityLevel: 'C2',
      documentName: 'sysml20-model-user-v003 language closure report',
      documentVersion: '2026-07-26',
      filePath: coverageReportPath
    }),
    localSource({
      sourceId: 'sysml-language-inventory-closure-v003-spec',
      sourceType: 'governance_specification',
      authorityLevel: 'C2',
      documentName: 'SysML language inventory and closure v003 specification',
      documentVersion: '2026-07-26',
      filePath: SPEC_PATH
    }),
    localSource({
      sourceId: 'sysml20-model-user-v003-language-closure-review',
      sourceType: 'review_report',
      authorityLevel: 'C2',
      documentName: 'sysml20-model-user-v003 language closure authoring review',
      documentVersion: '2026-07-26',
      filePath: REVIEW_PATH
    })
  ];
  const addedIds = new Set(addedSources.map((source) => source.sourceId));
  const retained = baseSourceManifest.sources.filter((source) => !addedIds.has(source.sourceId));
  return {
    ...baseSourceManifest,
    schemaVersion: '1.1.0',
    sources: [...retained, ...addedSources]
  };
}

function addLanguageGovernanceToManifest({
  manifest,
  evaluation,
  inventory,
  inventoryPath,
  coverageReportPath,
  scopeManifest,
  fixtureCatalog,
  validatorReport
}) {
  const inventoryHash = hashFile(inventoryPath);
  const scopeManifestHash = hashFile(SCOPE_PATH);
  const fixtureCatalogHash = hashFile(FIXTURE_CATALOG_PATH);
  const validatorReportHash = hashFile(VALIDATOR_REPORT_PATH);
  const coverageReportHash = hashFile(coverageReportPath);
  return {
    ...manifest,
    schemaVersion: '1.1.0',
    gates: {
      ...manifest.gates,
      languageInventory: evaluation.gates.languageInventory.status,
      scopeCompleteness: evaluation.gates.scopeCompleteness.status,
      semanticClosure: evaluation.gates.semanticClosure.status,
      fixtureCoverage: evaluation.gates.fixtureCoverage.status
    },
    languageInventoryHash: inventory.contentHash,
    languageInventoryArtifactHash: inventoryHash,
    scopeManifestHash,
    fixtureCatalogHash,
    validatorReportHash,
    coverageReportHash,
    languageGovernance: {
      evaluatorId: LANGUAGE_GOVERNANCE_EVALUATOR_ID,
      requiredGates: [...REQUIRED_LANGUAGE_GATES],
      inventoryId: inventory.inventoryId,
      scopeId: scopeManifest.scopeId,
      fixtureSetId: fixtureCatalog.fixtureSetId,
      validatorRunId: validatorReport.validatorRunId,
      resultHash: evaluation.resultHash,
      status: evaluation.status,
      hashes: {
        inventoryContent: inventory.contentHash,
        inventoryArtifact: inventoryHash,
        scopeManifest: scopeManifestHash,
        fixtureCatalog: fixtureCatalogHash,
        validatorReport: validatorReportHash,
        coverageReport: coverageReportHash
      },
      paths: {
        inventory: relative(inventoryPath),
        scopeManifest: relative(SCOPE_PATH),
        fixtureCatalog: relative(FIXTURE_CATALOG_PATH),
        validatorReport: relative(VALIDATOR_REPORT_PATH),
        coverageReport: relative(coverageReportPath)
      },
      counts: {
        productions: inventory.productions.length,
        lexemes: inventory.lexemes.length,
        semanticTypes: inventory.semanticTypes.length,
        coveredUnits: evaluation.counts.coveredUnits,
        fixtures: fixtureCatalog.fixtures.length
      }
    }
  };
}

function validateFixtureEvidence({ fixtureCatalog, validatorReport, validatorLock }) {
  if (fixtureCatalog.fixtureSetId !== validatorReport.fixtureSetId) {
    throw new Error('Fixture catalog and validator report fixtureSetId do not match');
  }
  if (validatorReport.status !== 'PASS') throw new Error('Validator fixture report did not pass');
  const expectedArtifactHash = validatorLock?.aggregateArtifactSha256;
  for (const lock of [fixtureCatalog.validatorLock, validatorReport.validator]) {
    if (lock?.releaseTag !== validatorLock?.releaseTag
      || lock?.kernelVersion !== validatorLock?.kernelVersion
      || lock?.artifactHash !== expectedArtifactHash) {
      throw new Error('Fixture evidence does not match the locked official Validator');
    }
  }

  const resultsById = uniqueMap(validatorReport.results, 'fixtureId', 'validator result');
  const fixturesById = uniqueMap(fixtureCatalog.fixtures, 'fixtureId', 'fixture');
  if (resultsById.size !== fixturesById.size) {
    throw new Error('Validator report must contain exactly one result for every fixture');
  }
  for (const fixture of fixtureCatalog.fixtures) {
    const fixturePath = path.resolve(FIXTURE_DIRECTORY, fixture.path);
    ensureWithin(FIXTURE_DIRECTORY, fixturePath);
    const result = resultsById.get(fixture.fixtureId);
    if (!result || result.fixtureKind !== fixture.kind || result.status !== 'PASS') {
      throw new Error(`Fixture result is missing or failed: ${fixture.fixtureId}`);
    }
    if (result.contentHash !== hashFile(fixturePath)) {
      throw new Error(`Fixture result hash does not match model bytes: ${fixture.fixtureId}`);
    }
    if (canonicalStringify(result.coverageUnitIds) !== canonicalStringify(fixture.coverageUnitIds)) {
      throw new Error(`Fixture coverage units do not match: ${fixture.fixtureId}`);
    }
    if (fixture.kind === 'positive'
      && !(result.validator?.syntaxValid === true && result.validator?.semanticValid === true)) {
      throw new Error(`Positive fixture is not Validator-valid: ${fixture.fixtureId}`);
    }
    if (fixture.kind === 'syntax_negative' && result.validator?.syntaxValid !== false) {
      throw new Error(`Syntax-negative fixture did not fail syntax validation: ${fixture.fixtureId}`);
    }
    const diagnostics = result.validator?.diagnostics;
    if (!Array.isArray(diagnostics)) {
      throw new Error(`Fixture result does not contain normalized diagnostics: ${fixture.fixtureId}`);
    }
    const normalizedDiagnostics = normalizeDiagnostics(diagnostics);
    if (canonicalStringify(diagnostics) !== canonicalStringify(normalizedDiagnostics)) {
      throw new Error(`Fixture diagnostics are not normalized: ${fixture.fixtureId}`);
    }
    const expectedDiagnosticChecks = evaluateDiagnosticAnchors(
      normalizedDiagnostics,
      fixture.diagnosticAnchors,
      { required: fixture.kind === 'syntax_negative' }
    );
    if (!expectedDiagnosticChecks.allMatched
      || canonicalStringify(result.diagnosticChecks) !== canonicalStringify(expectedDiagnosticChecks)) {
      throw new Error(`Fixture diagnostics do not match catalog anchors: ${fixture.fixtureId}`);
    }
    if (fixture.kind === 'semantic_negative'
      && !(result.validator?.syntaxValid === true && result.validator?.semanticValid === false)) {
      throw new Error(`Semantic-negative fixture has the wrong Validator outcome: ${fixture.fixtureId}`);
    }
    if (fixture.kind === 'confusion'
      && !(result.validator?.syntaxValid === true
        && result.validator?.semanticValid === true
        && result.oracle?.expectedPass === false
        && result.oracle?.pass === false)) {
      throw new Error(`Confusion fixture did not prove the expected semantic mismatch: ${fixture.fixtureId}`);
    }
  }
  for (const fixtureId of resultsById.keys()) {
    if (!fixturesById.has(fixtureId)) throw new Error(`Validator report contains an unknown fixture: ${fixtureId}`);
  }
}

function evidence(evidenceId, sectionPath, lineStart, lineEnd, blockType, extra = {}) {
  return {
    evidenceId,
    sourceId: 'sysml20-part1-formal-text',
    sectionPath,
    lineStart,
    lineEnd,
    blockType,
    ...extra
  };
}

function claim({
  claimId,
  subjectNodeId,
  predicate = 'PARSED_BY',
  objectNodeId,
  operators,
  astContextIds,
  claimText,
  evidenceIds,
  coverageUnitIds
}) {
  return {
    claimId,
    claimType: 'normative',
    subjectNodeId,
    predicate,
    objectNodeId,
    operators,
    astContextIds,
    claimText,
    evidenceIds,
    properties: {
      phase: 0,
      coverageUnitIds,
      searchTerms: identifierTerms(claimId, subjectNodeId, objectNodeId, predicate, ...operators)
    }
  };
}

function pilotSource({ sourceId, sourceType, documentName, relativePath, jarEntry }) {
  const filePath = projectPath(relativePath);
  return {
    sourceId,
    sourceType,
    authorityLevel: 'C1',
    documentName,
    documentVersion: '2026-04 / kernel 0.59.0',
    repositoryUrl: 'https://github.com/Systems-Modeling/SysML-v2-Pilot-Implementation',
    repositoryCommit: '20897e3122f2c2f8b29389745f0caaaeb7c6e21a',
    path: relative(filePath),
    artifactHash: hashFile(filePath),
    metadata: {
      extractionSource: 'sysml-jupyter-kernel-0.59.0-all.jar',
      jarEntry,
      extractionArtifactSha256: 'sha256:7d6f1f2d555ddde2538a2b4f726709ba261567aa6c7eb172ad7db762d01efbaf',
      validatorAggregateArtifactSha256: 'sha256:778ab7022cdcabd4247265f3e223e4fe5966009a360032f1116f1d667390a840',
      role: 'enumeration-and-executable-mapping-not-normative-semantic-claim'
    }
  };
}

function localSource({
  sourceId,
  sourceType,
  authorityLevel,
  documentName,
  documentVersion,
  filePath,
  metadata = {}
}) {
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

function mergeById(first, second, idField) {
  const merged = first.map(clone);
  const seen = new Set(merged.map((item) => item[idField]));
  for (const item of second) {
    if (!item[idField] || seen.has(item[idField])) {
      throw new Error(`Duplicate or missing ${idField}: ${item[idField] || ''}`);
    }
    seen.add(item[idField]);
    merged.push(clone(item));
  }
  return merged;
}

function mergeEdgesByTriple(baseEdges, projectionEdges) {
  const merged = baseEdges.map(clone);
  const edgeIds = new Set(merged.map((edge) => edge.edgeId));
  const triples = new Set(merged.map(edgeTriple));
  for (const edge of projectionEdges) {
    const triple = edgeTriple(edge);
    if (triples.has(triple)) continue;
    if (!edge.edgeId || edgeIds.has(edge.edgeId)) throw new Error(`Duplicate or missing edgeId: ${edge.edgeId || ''}`);
    triples.add(triple);
    edgeIds.add(edge.edgeId);
    merged.push(clone(edge));
  }
  return merged;
}

function edgeTriple(edge) {
  const contextKey = edge.properties?.mappingKind === 'reviewed_context_projection'
    ? `\u0000${edge.properties.coverageUnitId || ''}\u0000${edge.properties.astContextId || ''}`
    : '';
  return `${edge.sourceNodeId}\u0000${edge.predicate}\u0000${edge.targetNodeId}${contextKey}`;
}

function uniqueMap(items, idField, label) {
  if (!Array.isArray(items)) throw new Error(`${label} collection must be an array`);
  const result = new Map();
  for (const item of items) {
    const id = String(item?.[idField] || '');
    if (!id || result.has(id)) throw new Error(`Duplicate or missing ${label} ID: ${id}`);
    result.set(id, item);
  }
  return result;
}

function identifierTerms(...values) {
  return [...new Set(values.filter(Boolean).flatMap((value) => {
    const local = String(value).replace(/^.*:/u, '');
    return [
      local,
      local.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[_-]+/gu, ' '),
      local.replace(/(Definition|Usage|Relationship|Membership|Production)$/u, '')
    ];
  }).filter(Boolean))];
}

function writeInventory(filePath, inventory) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const serialized = `${canonicalStringify(inventory, 2)}\n`;
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === serialized) return;
  fs.writeFileSync(filePath, serialized, 'utf8');
  const parsed = readJson(filePath);
  if (parsed.contentHash !== inventory.contentHash) throw new Error('Written language inventory failed hash self-check');
}

function readJson(filePath) {
  ensureWithin(PROJECT_ROOT, filePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  ensureWithin(PROJECT_ROOT, filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function projectPath(value) {
  const resolved = path.resolve(PROJECT_ROOT, value);
  ensureWithin(PROJECT_ROOT, resolved);
  return resolved;
}

function resolveOutput(value) {
  const resolved = path.resolve(value);
  ensureWithin(PROJECT_ROOT, resolved);
  return resolved;
}

function ensureWithin(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes allowed root: ${target}`);
  }
}

function relative(value) {
  return path.relative(PROJECT_ROOT, value).replace(/\\/gu, '/');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

if (require.main === module) {
  try {
    const result = buildModelUserV003Bundle();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      bundleId: result.manifest.bundleId,
      contentHash: result.manifest.contentHash,
      counts: result.manifest.counts,
      languageGovernance: result.manifest.languageGovernance,
      gates: result.manifest.gates,
      bundleDir: result.bundleDir
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  addLanguageGovernanceToManifest,
  buildAuthoring,
  buildCoverageReport,
  buildModelUserV003Bundle,
  buildSourceManifest,
  languageClaims,
  languageEvidenceBlocks,
  languageSyntaxMappings,
  validateFixtureEvidence
};
