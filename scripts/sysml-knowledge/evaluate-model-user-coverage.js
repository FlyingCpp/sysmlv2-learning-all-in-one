'use strict';

const fs = require('fs');
const path = require('path');
const { loadAndVerifyBundle } = require('../../apps/teacher/sysml-knowledge-store');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_BUNDLE_DIR = path.join(PROJECT_ROOT, 'resources', 'sysml-knowledge', 'bundles', 'sysml20-model-user-v002');
const OUTLINE_PATH = path.join(PROJECT_ROOT, 'resources', 'sysml-knowledge', 'eval', 'sysmlv2-model-user-outline-2026.json');
const REPORT_JSON_PATH = path.join(PROJECT_ROOT, 'resources', 'sysml-knowledge', 'eval', 'sysml20-model-user-v002-coverage.json');
const REPORT_MD_PATH = path.join(PROJECT_ROOT, 'docs', 'sysml20-model-user-v002-exam-coverage-report-2026-07-18.md');

function evaluateCoverage(options = {}) {
  const bundleDir = path.resolve(options.bundleDir || DEFAULT_BUNDLE_DIR);
  const bundle = loadAndVerifyBundle(bundleDir);
  const outline = JSON.parse(fs.readFileSync(options.outlinePath || OUTLINE_PATH, 'utf8'));
  const claims = bundle.records['claims.jsonl'];
  const evidence = bundle.records['evidence-blocks.jsonl'];
  const nodes = bundle.records['nodes.jsonl'];
  const claimIds = new Set(claims.map((claim) => claim.claimId));
  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));

  const objectiveCoverage = outline.domains.flatMap((domain) => domain.objectives.map((objective) => {
    const mappedClaims = claims.filter((claim) => claim.properties?.examObjectiveIds?.includes(objective.objectiveId));
    return {
      domainId: domain.domainId,
      domainWeightPercent: domain.weightPercent,
      objectiveId: objective.objectiveId,
      clauses: objective.clauses,
      topic: objective.topic,
      status: mappedClaims.length > 0 ? 'PASS' : 'FAIL',
      claimIds: mappedClaims.map((claim) => claim.claimId)
    };
  }));
  const domainCoverage = outline.domains.map((domain) => {
    const objectives = objectiveCoverage.filter((item) => item.domainId === domain.domainId);
    const covered = objectives.filter((item) => item.status === 'PASS').length;
    return {
      domainId: domain.domainId,
      name: domain.name,
      weightPercent: domain.weightPercent,
      coveredObjectives: covered,
      totalObjectives: objectives.length,
      coveragePercent: percent(covered, objectives.length),
      weightedCoveragePercent: domain.weightPercent * (covered / objectives.length)
    };
  });
  const knownPointCoverage = outline.knownPublicPoints.map((point) => {
    const mappedClaims = claims.filter((claim) => claim.properties?.knownPointIds?.includes(point.pointId));
    return {
      ...point,
      status: mappedClaims.length > 0 ? 'PASS' : 'FAIL',
      claimIds: mappedClaims.map((claim) => claim.claimId)
    };
  });
  const phaseCoverage = [1, 2, 3, 4, 5, 6].map((phase) => ({
    phase,
    nodeCount: nodes.filter((node) => node.properties?.phase === phase).length,
    claimCount: claims.filter((claim) => claim.properties?.phase === phase).length
  }));
  const claimsWithoutEvidence = claims.filter((claim) => !claim.evidenceIds?.length
    || claim.evidenceIds.some((evidenceId) => !evidenceById.has(evidenceId)));
  const claimsUsingExamOutlineAsEvidence = claims.filter((claim) => claim.evidenceIds?.some((id) =>
    evidenceById.get(id)?.sourceId === 'sysml20-model-user-exam-outline'
  ));
  const expectedF01ClaimIds = [
    'claim-colon-feature-typing',
    'claim-typed-usage-inherits-features',
    'claim-colon-gt-subclassification',
    'claim-colon-gt-subsetting',
    'claim-redefinition',
    'claim-reference-subsetting',
    'claim-reference-subsetting-specializes-subsetting',
    'claim-feature-value-fixed-vs-initial',
    'claim-feature-value-default'
  ];
  const missingF01ClaimIds = expectedF01ClaimIds.filter((claimId) => !claimIds.has(claimId));
  const weightedCoveragePercent = domainCoverage.reduce((sum, item) => sum + item.weightedCoveragePercent, 0);
  const status = objectiveCoverage.every((item) => item.status === 'PASS')
    && knownPointCoverage.every((item) => item.status === 'PASS')
    && phaseCoverage.every((item) => item.nodeCount > 0 && item.claimCount > 0)
    && claimsWithoutEvidence.length === 0
    && claimsUsingExamOutlineAsEvidence.length === 0
    && missingF01ClaimIds.length === 0
    && bundle.manifest.counts.teachingOverlays === 0
    ? 'PASS'
    : 'FAIL';
  return {
    schemaVersion: '1.0.0',
    evaluatedAt: '2026-07-18',
    bundle: {
      bundleId: bundle.manifest.bundleId,
      version: bundle.manifest.version,
      contentHash: bundle.manifest.contentHash,
      counts: bundle.manifest.counts
    },
    exam: outline.exam,
    status,
    weightedCoveragePercent: round(weightedCoveragePercent),
    objectiveCoverage,
    domainCoverage: domainCoverage.map((item) => ({
      ...item,
      weightedCoveragePercent: round(item.weightedCoveragePercent)
    })),
    knownPointCoverage,
    phaseCoverage,
    integrity: {
      claimsWithoutEvidence: claimsWithoutEvidence.map((claim) => claim.claimId),
      claimsUsingExamOutlineAsEvidence: claimsUsingExamOutlineAsEvidence.map((claim) => claim.claimId),
      missingF01ClaimIds,
      teachingOverlayCount: bundle.manifest.counts.teachingOverlays
    },
    scopeNote: '100% means coverage of the public Model User outline and the listed public/spec-derived points, not every SysML v2 clause or every possible natural-language question.'
  };
}

function writeCoverageReport(result, options = {}) {
  const jsonPath = path.resolve(options.jsonPath || REPORT_JSON_PATH);
  const markdownPath = path.resolve(options.markdownPath || REPORT_MD_PATH);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownPath, renderMarkdown(result), 'utf8');
  return { jsonPath, markdownPath };
}

function renderMarkdown(result) {
  const domainRows = result.domainCoverage.map((item) =>
    `| ${item.name} | ${item.weightPercent}% | ${item.coveredObjectives}/${item.totalObjectives} | ${item.coveragePercent}% | ${item.weightedCoveragePercent}% |`
  ).join('\n');
  const phaseRows = result.phaseCoverage.map((item) =>
    `| ${item.phase} | ${item.nodeCount} | ${item.claimCount} | ${item.nodeCount > 0 && item.claimCount > 0 ? 'PASS' : 'FAIL'} |`
  ).join('\n');
  const objectiveRows = result.objectiveCoverage.map((item) =>
    `| ${item.objectiveId} | ${item.topic} | ${item.status} | ${item.claimIds.join(', ')} |`
  ).join('\n');
  const pointRows = result.knownPointCoverage.map((item) =>
    `| ${item.pointId} | ${item.topic} | ${item.status} | ${item.claimIds.join(', ')} |`
  ).join('\n');
  return `# sysml20-model-user-v002 考试覆盖报告\n\n`
    + `日期：${result.evaluatedAt}  \n`
    + `结论：**${result.status}**  \n`
    + `Bundle：\`${result.bundle.bundleId}\`  \n`
    + `Content hash：\`${result.bundle.contentHash}\`\n\n`
    + `公开 Model User 大纲加权覆盖率：**${result.weightedCoveragePercent}%**。\n\n`
    + `> ${result.scopeNote}\n\n`
    + `## 大纲领域覆盖\n\n| 领域 | 考试权重 | 已覆盖目标 | 目标覆盖率 | 加权覆盖 |\n|---|---:|---:|---:|---:|\n${domainRows}\n\n`
    + `## 六阶段构建覆盖\n\n| 阶段 | 节点数 | Claim 数 | 状态 |\n|---:|---:|---:|---|\n${phaseRows}\n\n`
    + `## 逐目标覆盖\n\n| 目标 | 主题 | 状态 | Claim |\n|---|---|---|---|\n${objectiveRows}\n\n`
    + `## 公开/规范派生考点\n\n| 考点 | 主题 | 状态 | Claim |\n|---|---|---|---|\n${pointRows}\n\n`
    + `## 完整性\n\n`
    + `- Claims：${result.bundle.counts.claims}\n`
    + `- EvidenceBlocks：${result.bundle.counts.evidenceBlocks}\n`
    + `- Semantic nodes：${result.bundle.counts.nodes}\n`
    + `- Semantic edges：${result.bundle.counts.edges}\n`
    + `- Teaching overlays：${result.integrity.teachingOverlayCount}\n`
    + `- 无证据 Claim：${result.integrity.claimsWithoutEvidence.length}\n`
    + `- 将考试大纲误作语义证据的 Claim：${result.integrity.claimsUsingExamOutlineAsEvidence.length}\n`
    + `- 缺失 F01 Claim：${result.integrity.missingF01ClaimIds.length}\n`;
}

function percent(numerator, denominator) {
  return denominator === 0 ? 0 : round((numerator / denominator) * 100);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

if (require.main === module) {
  try {
    const result = evaluateCoverage();
    const paths = writeCoverageReport(result);
    process.stdout.write(`${JSON.stringify({ status: result.status, weightedCoveragePercent: result.weightedCoveragePercent, ...paths }, null, 2)}\n`);
    if (result.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { evaluateCoverage, writeCoverageReport };
