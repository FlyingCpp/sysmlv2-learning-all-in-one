'use strict';

const fs = require('fs');
const path = require('path');
const { buildF0KnowledgeBundle, hashFile } = require('./build-f0-bundle');
const catalog = require('./model-user-catalog');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const BASE_AUTHORING_PATH = projectPath('resources/sysml-knowledge/authoring/f0-definition-usage-v002.json');
const BASE_SOURCE_MANIFEST_PATH = projectPath('resources/sysml-knowledge/sources/manifests/sysml-2.0-formal-f0-v002.json');
const BASE_BUNDLE_MANIFEST_PATH = projectPath('resources/sysml-knowledge/bundles/sysml20-model-user-v001/manifest.json');
const AUTHORING_PATH = projectPath('resources/sysml-knowledge/authoring/sysml20-model-user-v002.json');
const SOURCE_MANIFEST_PATH = projectPath('resources/sysml-knowledge/sources/manifests/sysml-2.0-model-user-v002.json');
const BUNDLE_DIR = projectPath('resources/sysml-knowledge/bundles/sysml20-model-user-v002');
const EXAM_OUTLINE_PATH = projectPath('resources/sysml-knowledge/eval/sysmlv2-model-user-outline-2026.json');
const REVIEW_PATH = projectPath('docs/sysml20-model-user-v002-authoring-review-2026-07-18.md');
const SCALAR_VALUES_PATH = projectPath('resources/sysml-knowledge/sources/extracts/scalar-values-2026-04.kerml');

function buildModelUserKnowledgeBundle(options = {}) {
  const baseAuthoring = readJson(BASE_AUTHORING_PATH);
  const baseSourceManifest = readJson(BASE_SOURCE_MANIFEST_PATH);
  const baseBundleManifest = readJson(BASE_BUNDLE_MANIFEST_PATH);
  const sourceManifestPath = path.resolve(options.sourceManifestPath || SOURCE_MANIFEST_PATH);
  const authoringPath = path.resolve(options.authoringPath || AUTHORING_PATH);
  const bundleDir = path.resolve(options.bundleDir || BUNDLE_DIR);

  const sourceManifest = buildSourceManifest(baseSourceManifest);
  const authoring = buildAuthoring(baseAuthoring, baseBundleManifest);
  writeJson(sourceManifestPath, sourceManifest);
  writeJson(authoringPath, authoring);
  return buildF0KnowledgeBundle({ sourceManifestPath, authoringPath, bundleDir });
}

function buildSourceManifest(base) {
  const retained = base.sources.filter((source) => ![
    'sysml20-model-user-exam-outline',
    'sysml20-model-user-v002-review',
    'sysml20-scalar-values-2026-04'
  ].includes(source.sourceId));
  return {
    ...base,
    sources: [
      ...retained,
      {
        sourceId: 'sysml20-model-user-exam-outline',
        sourceType: 'official_certification_exam_outline',
        authorityLevel: 'C1',
        documentName: 'OMG SysML v2 Model User Certification Exam Information',
        documentVersion: '2026 public outline',
        path: relative(EXAM_OUTLINE_PATH),
        artifactHash: hashFile(EXAM_OUTLINE_PATH),
        metadata: {
          sourceUrl: 'https://www.omg.org/certification/sysml2/SysMLv2-MU.pdf',
          role: 'coverage-target-only-not-semantic-evidence'
        }
      },
      {
        sourceId: 'sysml20-model-user-v002-review',
        sourceType: 'review_report',
        authorityLevel: 'C2',
        documentName: 'sysml20-model-user-v002 authoring review',
        documentVersion: '2026-07-18',
        path: relative(REVIEW_PATH),
        artifactHash: hashFile(REVIEW_PATH)
      },
      {
        sourceId: 'sysml20-scalar-values-2026-04',
        sourceType: 'formal_model_reviewed_extract',
        authorityLevel: 'A2',
        documentName: 'ScalarValues normative model library reviewed minimal extract',
        documentVersion: '2026-04',
        repositoryUrl: 'https://github.com/Systems-Modeling/SysML-v2-Release',
        repositoryCommit: '9baca5908ca28b53da085de69336fde48420ea8f',
        repositoryPath: 'sysml.library/Kernel Libraries/Kernel Data Type Library/ScalarValues.kerml',
        path: relative(SCALAR_VALUES_PATH),
        artifactHash: hashFile(SCALAR_VALUES_PATH),
        metadata: {
          artifactRole: 'reviewed-minimal-formal-model-extract',
          license: 'EPL-2.0',
          releaseBoundary: '2026-04'
        }
      }
    ]
  };
}

function buildAuthoring(base, parentManifest) {
  const baseClaimProperties = {
    phase: 1,
    examObjectiveIds: ['MU-FND-7.6'],
    knownPointIds: ['KP-01', 'KP-02']
  };
  const inheritedClaims = base.claims.map((claim) => ({
    ...claim,
    properties: {
      ...baseClaimProperties,
      ...(claim.claimId.includes('feature-value') ? {
        examObjectiveIds: ['MU-STR-7.13'],
        knownPointIds: ['KP-01', 'KP-10']
      } : {}),
      ...(claim.claimId.includes('reference-subsetting') ? {
        phase: 2,
        examObjectiveIds: ['MU-STR-7.13'],
        knownPointIds: ['KP-01', 'KP-07']
      } : {}),
      searchTerms: identifierTerms(claim.claimId, claim.subjectNodeId, claim.objectNodeId, claim.predicate),
      ...(claim.properties || {})
    }
  }));
  return {
    schemaVersion: '1.1.0',
    bundleId: 'sysml20-model-user-v002',
    baselineId: 'sysml-2.0-formal',
    version: '2026.07.18-mu.2',
    parentBundleId: parentManifest.bundleId,
    parentContentHash: parentManifest.contentHash,
    review: {
      status: 'PASS',
      reviewedBy: 'main-agent-authoritative-source-review',
      reviewedAt: '2026-07-18T23:30:00.000+08:00',
      reviewSourceId: 'sysml20-model-user-v002-review'
    },
    nodes: mergeBy(base.nodes, catalog.nodes, 'nodeId'),
    edges: mergeBy(base.edges, catalog.edges, 'edgeId'),
    evidenceBlocks: mergeBy(base.evidenceBlocks, catalog.evidenceBlocks, 'evidenceId'),
    claims: mergeBy(inheritedClaims, catalog.claims, 'claimId'),
    syntaxMappings: mergeBy(base.syntaxMappings, catalog.syntaxMappings, 'syntaxMappingId'),
    teachingOverlays: []
  };
}

function identifierTerms(...values) {
  return [...new Set(values.filter(Boolean).flatMap((value) => {
    const local = String(value).replace(/^.*:/, '');
    return [
      local,
      local.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' '),
      local.replace(/(Definition|Usage|Relationship)$/u, '')
    ];
  }).filter(Boolean))];
}

function mergeBy(first, second, key) {
  const records = new Map();
  for (const record of [...first, ...second]) {
    if (records.has(record[key])) throw new Error(`Duplicate ${key}: ${record[key]}`);
    records.set(record[key], record);
  }
  return [...records.values()];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function projectPath(value) {
  return path.resolve(PROJECT_ROOT, value);
}

function relative(value) {
  return path.relative(PROJECT_ROOT, value).replace(/\\/g, '/');
}

if (require.main === module) {
  try {
    const result = buildModelUserKnowledgeBundle();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      bundleId: result.manifest.bundleId,
      contentHash: result.manifest.contentHash,
      counts: result.manifest.counts,
      bundleDir: result.bundleDir
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildModelUserKnowledgeBundle };
