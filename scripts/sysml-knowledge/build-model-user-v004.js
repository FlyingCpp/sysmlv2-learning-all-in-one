'use strict';

const fs = require('fs');
const path = require('path');

const { buildF0KnowledgeBundle, hashFile } = require('./build-f0-bundle');
const {
  addLanguageGovernanceToManifest,
  buildCoverageReport: buildLanguageCoverageReport
} = require('./build-model-user-v003');
const { evaluateLanguageClosure } = require('./language-closure');
const { evaluateKnowledgePatternClosure } = require('./knowledge-pattern-closure');
const {
  knowledgePatternClaims,
  knowledgePatternEvidenceBlocks,
  knowledgePatternGuardrails,
  knowledgePatterns
} = require('./model-user-v004-catalog');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const V003_AUTHORING_PATH = projectPath('resources/sysml-knowledge/authoring/sysml20-model-user-v003.json');
const V003_SOURCE_MANIFEST_PATH = projectPath('resources/sysml-knowledge/sources/manifests/sysml-2.0-model-user-v003.json');
const V003_BUNDLE_MANIFEST_PATH = projectPath('resources/sysml-knowledge/bundles/sysml20-model-user-v003/manifest.json');
const OUTLINE_PATH = projectPath('resources/sysml-knowledge/eval/sysmlv2-model-user-outline-2026.json');
const KNOWLEDGE_SCOPE_PATH = projectPath('resources/sysml-knowledge/language/scopes/model-user-knowledge-patterns-v1.json');
const KNOWLEDGE_FIXTURE_PATH = projectPath('resources/sysml-knowledge/eval/model-user-knowledge-pattern-fixtures-v1.json');
const KNOWLEDGE_COVERAGE_PATH = projectPath('resources/sysml-knowledge/eval/sysml20-model-user-v004-knowledge-coverage.json');
const LANGUAGE_INVENTORY_PATH = projectPath('resources/sysml-knowledge/language/baselines/sysml-2.0-pilot-2026-04-inventory.json');
const LANGUAGE_SCOPE_PATH = projectPath('resources/sysml-knowledge/language/scopes/model-user-textual-closure-v1.json');
const LANGUAGE_FIXTURE_PATH = projectPath('resources/sysml-knowledge/language/fixtures/model-user-textual-closure-v1/catalog.json');
const LANGUAGE_VALIDATOR_REPORT_PATH = projectPath('resources/sysml-knowledge/language/validator-runs/model-user-textual-closure-v1-official.json');
const LANGUAGE_COVERAGE_PATH = projectPath('resources/sysml-knowledge/eval/sysml20-model-user-v004-language-closure.json');
const REVIEW_PATH = projectPath('docs/sysml20-model-user-v004-knowledge-pattern-review-2026-07-30.md');
const AUTHORING_PATH = projectPath('resources/sysml-knowledge/authoring/sysml20-model-user-v004.json');
const SOURCE_MANIFEST_PATH = projectPath('resources/sysml-knowledge/sources/manifests/sysml-2.0-model-user-v004.json');
const BUNDLE_DIR = projectPath('resources/sysml-knowledge/bundles/sysml20-model-user-v004');
const KNOWLEDGE_PATTERN_EVALUATOR_ID = 'model-user-knowledge-pattern-closure/v1';
const REQUIRED_PATTERN_GATES = Object.freeze([
  'modelUserScope',
  'knowledgePatternClosure',
  'semanticFixtureCoverage'
]);

function buildModelUserV004Bundle(options = {}) {
  const authoringPath = resolveOutput(options.authoringPath || AUTHORING_PATH);
  const sourceManifestPath = resolveOutput(options.sourceManifestPath || SOURCE_MANIFEST_PATH);
  const bundleDir = resolveOutput(options.bundleDir || BUNDLE_DIR);
  const knowledgeCoveragePath = resolveOutput(options.knowledgeCoveragePath || KNOWLEDGE_COVERAGE_PATH);
  const languageCoveragePath = resolveOutput(options.languageCoveragePath || LANGUAGE_COVERAGE_PATH);

  const baseAuthoring = readJson(V003_AUTHORING_PATH);
  const baseSourceManifest = readJson(V003_SOURCE_MANIFEST_PATH);
  const parentManifest = readJson(V003_BUNDLE_MANIFEST_PATH);
  const outline = readJson(OUTLINE_PATH);
  const knowledgeScope = readJson(KNOWLEDGE_SCOPE_PATH);
  const knowledgeFixtures = readJson(KNOWLEDGE_FIXTURE_PATH);
  const languageInventory = readJson(LANGUAGE_INVENTORY_PATH);
  const languageScope = readJson(LANGUAGE_SCOPE_PATH);
  const languageFixtures = readJson(LANGUAGE_FIXTURE_PATH);
  const languageValidatorReport = readJson(LANGUAGE_VALIDATOR_REPORT_PATH);

  const authoring = buildV004Authoring({
    baseAuthoring,
    parentManifest,
    knowledgeCoveragePath,
    languageCoveragePath
  });
  writeJson(authoringPath, authoring);

  const languageEvaluation = evaluateLanguageClosure({
    inventory: languageInventory,
    scopeManifest: languageScope,
    bundle: authoring,
    fixtureCatalog: languageFixtures,
    validatorReport: languageValidatorReport
  });
  if (languageEvaluation.status !== 'PASS') {
    throw new Error(`v004 language closure failed: ${JSON.stringify(languageEvaluation.gaps.slice(0, 12))}`);
  }
  const languageCoverage = buildLanguageCoverageReport({
    evaluation: languageEvaluation,
    inventory: languageInventory,
    scopeManifest: languageScope,
    fixtureCatalog: languageFixtures,
    validatorReport: languageValidatorReport,
    authoringPath,
    bundleId: authoring.bundleId
  });
  writeJson(languageCoveragePath, languageCoverage);

  const knowledgeEvaluation = evaluateKnowledgePatternClosure({
    outline,
    scope: knowledgeScope,
    bundle: authoring,
    fixtureCatalog: knowledgeFixtures,
    sourceManifest: baseSourceManifest
  });
  if (knowledgeEvaluation.status !== 'PASS') {
    throw new Error(`v004 knowledge pattern closure failed: ${JSON.stringify(knowledgeEvaluation.gaps.slice(0, 12))}`);
  }
  const knowledgeCoverage = buildKnowledgeCoverageReport({
    evaluation: knowledgeEvaluation,
    authoringPath,
    outlinePath: OUTLINE_PATH,
    scopePath: KNOWLEDGE_SCOPE_PATH,
    fixturePath: KNOWLEDGE_FIXTURE_PATH
  });
  writeJson(knowledgeCoveragePath, knowledgeCoverage);

  const sourceManifest = buildV004SourceManifest({
    baseSourceManifest,
    knowledgeCoveragePath,
    languageCoveragePath
  });
  writeJson(sourceManifestPath, sourceManifest);

  const built = buildF0KnowledgeBundle({ sourceManifestPath, authoringPath, bundleDir });
  const languageManifest = addLanguageGovernanceToManifest({
    manifest: built.manifest,
    evaluation: languageEvaluation,
    inventory: languageInventory,
    inventoryPath: LANGUAGE_INVENTORY_PATH,
    coverageReportPath: languageCoveragePath,
    scopeManifest: languageScope,
    fixtureCatalog: languageFixtures,
    validatorReport: languageValidatorReport
  });
  const manifest = addKnowledgePatternGovernanceToManifest({
    manifest: languageManifest,
    evaluation: knowledgeEvaluation,
    coveragePath: knowledgeCoveragePath
  });
  writeJson(built.manifestPath, manifest);

  return {
    ...built,
    manifest,
    authoring,
    sourceManifest,
    languageEvaluation,
    languageCoverage,
    knowledgeEvaluation,
    knowledgeCoverage
  };
}

function buildV004Authoring({ baseAuthoring, parentManifest, knowledgeCoveragePath, languageCoveragePath }) {
  if (parentManifest.bundleId !== 'sysml20-model-user-v003') {
    throw new Error(`Unexpected v004 parent Bundle: ${parentManifest.bundleId || ''}`);
  }

  const evidenceBlocks = clone(baseAuthoring.evidenceBlocks);
  const transitionEvidence = requireById(evidenceBlocks, 'evidenceId', 'ev-mu-state-transitions');
  transitionEvidence.lineEnd = 7602;
  transitionEvidence.sectionPath = '7.18.3 Transition Usages - trigger conditions and execution order';
  mergeById(evidenceBlocks, knowledgePatternEvidenceBlocks(), 'evidenceId');

  const claims = clone(baseAuthoring.claims);
  const transitionClaim = requireById(claims, 'claimId', 'claim-mu-transition');
  transitionClaim.claimText = 'TransitionUsage只能在source执行期间触发；若有guard，guard须为true；若有accepter，还须能够接受incoming transfer。触发后，若相应动作存在，依次中断仍在执行的源do、执行源exit、transition effect、目标entry和目标do。';
  const occurrenceClaim = requireById(claims, 'claimId', 'claim-mu-occurrence-varying-features');
  occurrenceClaim.claimText = 'Attribute数据值本身不随时间改变；但当AttributeUsage由Occurrence Definition或Usage拥有时，该Usage可在Occurrence生命周期的不同时间点取不同数据值，从而反映Occurrence状态变化。';
  occurrenceClaim.evidenceIds = ['ev-mu-attributes', 'ev-mu-occurrence-usages'];
  mergeById(claims, knowledgePatternClaims(), 'claimId');

  return {
    ...clone(baseAuthoring),
    schemaVersion: '1.3.0',
    bundleId: 'sysml20-model-user-v004',
    version: '2026.07.30-mu.4',
    parentBundleId: parentManifest.bundleId,
    parentContentHash: parentManifest.contentHash,
    review: {
      status: 'PASS',
      reviewedBy: 'main-agent-plus-independent-model-user-semantic-audit',
      reviewedAt: '2026-07-30T18:00:00.000+08:00',
      reviewSourceId: 'sysml20-model-user-v004-knowledge-pattern-review'
    },
    languageGovernance: {
      ...clone(baseAuthoring.languageGovernance),
      paths: {
        ...clone(baseAuthoring.languageGovernance.paths),
        coverageReport: relative(languageCoveragePath)
      }
    },
    knowledgePatternGovernance: {
      required: true,
      evaluatorId: KNOWLEDGE_PATTERN_EVALUATOR_ID,
      requiredGates: [...REQUIRED_PATTERN_GATES],
      paths: {
        outline: relative(OUTLINE_PATH),
        scope: relative(KNOWLEDGE_SCOPE_PATH),
        fixtureCatalog: relative(KNOWLEDGE_FIXTURE_PATH),
        coverageReport: relative(knowledgeCoveragePath)
      }
    },
    evidenceBlocks,
    claims,
    teachingOverlays: [...clone(baseAuthoring.teachingOverlays || []), ...knowledgePatternGuardrails()],
    knowledgePatterns: knowledgePatterns()
  };
}

function buildKnowledgeCoverageReport({ evaluation, authoringPath, outlinePath, scopePath, fixturePath }) {
  return {
    schemaVersion: 'model-user-knowledge-coverage-report/v1',
    bundleId: 'sysml20-model-user-v004',
    status: evaluation.status,
    evaluatorId: KNOWLEDGE_PATTERN_EVALUATOR_ID,
    inputs: {
      outlineHash: hashFile(outlinePath),
      scopeHash: hashFile(scopePath),
      fixtureCatalogHash: hashFile(fixturePath),
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

function buildV004SourceManifest({ baseSourceManifest, knowledgeCoveragePath, languageCoveragePath }) {
  const addedSources = [
    localSource({
      sourceId: 'sysml-model-user-knowledge-scope-v1',
      sourceType: 'knowledge_scope_policy',
      authorityLevel: 'C2',
      documentName: 'OMG Model User knowledge pattern scope',
      documentVersion: '1.0.0',
      filePath: KNOWLEDGE_SCOPE_PATH
    }),
    localSource({
      sourceId: 'sysml-model-user-knowledge-pattern-fixtures-v1',
      sourceType: 'semantic_fixture_catalog',
      authorityLevel: 'C2',
      documentName: 'Model User high-risk semantic closure fixtures',
      documentVersion: '1.0.0',
      filePath: KNOWLEDGE_FIXTURE_PATH
    }),
    localSource({
      sourceId: 'sysml-model-user-v004-knowledge-coverage',
      sourceType: 'derived_coverage_report',
      authorityLevel: 'C2',
      documentName: 'sysml20-model-user-v004 knowledge pattern coverage report',
      documentVersion: '2026-07-30',
      filePath: knowledgeCoveragePath
    }),
    localSource({
      sourceId: 'sysml-language-closure-report-model-user-v004',
      sourceType: 'derived_coverage_report',
      authorityLevel: 'C2',
      documentName: 'sysml20-model-user-v004 language closure report',
      documentVersion: '2026-07-30',
      filePath: languageCoveragePath
    }),
    localSource({
      sourceId: 'sysml20-model-user-v004-knowledge-pattern-review',
      sourceType: 'review_report',
      authorityLevel: 'C2',
      documentName: 'sysml20-model-user-v004 knowledge pattern review',
      documentVersion: '2026-07-30',
      filePath: REVIEW_PATH
    })
  ];
  const addedIds = new Set(addedSources.map((source) => source.sourceId));
  return {
    ...clone(baseSourceManifest),
    schemaVersion: '1.2.0',
    sources: [
      ...baseSourceManifest.sources.filter((source) => !addedIds.has(source.sourceId)),
      ...addedSources
    ]
  };
}

function addKnowledgePatternGovernanceToManifest({ manifest, evaluation, coveragePath }) {
  const outlineHash = hashFile(OUTLINE_PATH);
  const scopeHash = hashFile(KNOWLEDGE_SCOPE_PATH);
  const fixtureCatalogHash = hashFile(KNOWLEDGE_FIXTURE_PATH);
  const coverageReportHash = hashFile(coveragePath);
  return {
    ...manifest,
    schemaVersion: '1.2.0',
    gates: {
      ...manifest.gates,
      modelUserScope: evaluation.gates.scopeCompleteness.status,
      knowledgePatternClosure: evaluation.gates.patternClosure.status,
      semanticFixtureCoverage: evaluation.gates.semanticFixtures.status
    },
    knowledgePatternGovernance: {
      evaluatorId: KNOWLEDGE_PATTERN_EVALUATOR_ID,
      requiredGates: [...REQUIRED_PATTERN_GATES],
      resultHash: evaluation.resultHash,
      status: evaluation.status,
      hashes: {
        outline: outlineHash,
        scope: scopeHash,
        fixtureCatalog: fixtureCatalogHash,
        coverageReport: coverageReportHash
      },
      paths: {
        outline: relative(OUTLINE_PATH),
        scope: relative(KNOWLEDGE_SCOPE_PATH),
        fixtureCatalog: relative(KNOWLEDGE_FIXTURE_PATH),
        coverageReport: relative(coveragePath)
      },
      counts: evaluation.counts
    }
  };
}

function localSource({ sourceId, sourceType, authorityLevel, documentName, documentVersion, filePath }) {
  return {
    sourceId,
    sourceType,
    authorityLevel,
    documentName,
    documentVersion,
    path: relative(filePath),
    artifactHash: hashFile(filePath),
    metadata: {}
  };
}

function requireById(items, fieldName, value) {
  const item = items.find((candidate) => candidate?.[fieldName] === value);
  if (!item) throw new Error(`Required ${fieldName} is missing: ${value}`);
  return item;
}

function mergeById(target, additions, fieldName) {
  const index = new Map(target.map((item, position) => [item[fieldName], position]));
  for (const addition of additions) {
    const position = index.get(addition[fieldName]);
    if (position === undefined) {
      index.set(addition[fieldName], target.length);
      target.push(addition);
    } else {
      target[position] = addition;
    }
  }
  return target;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function resolveOutput(value) {
  const resolved = path.resolve(value);
  if (resolved !== PROJECT_ROOT && !resolved.startsWith(`${PROJECT_ROOT}${path.sep}`)
    && !resolved.startsWith(`${path.resolve(process.env.TEMP || process.env.TMP || '')}${path.sep}`)) {
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
    const result = buildModelUserV004Bundle();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      bundleId: result.manifest.bundleId,
      contentHash: result.manifest.contentHash,
      counts: result.manifest.counts,
      knowledgePatternGovernance: result.manifest.knowledgePatternGovernance,
      gates: result.manifest.gates,
      bundleDir: result.bundleDir
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  addKnowledgePatternGovernanceToManifest,
  buildKnowledgeCoverageReport,
  buildModelUserV004Bundle,
  buildV004Authoring,
  buildV004SourceManifest
};
