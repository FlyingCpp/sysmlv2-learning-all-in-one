'use strict';

const crypto = require('crypto');
const path = require('path');

/** Homologous to apps/teacher/agent/repair-convergence.mts DECLARATION_PATTERN. */
const DECLARATION_PATTERN = /^\s*(?:abstract\s+)?(part\s+def|port\s+def|interface\s+def|connection\s+def|action\s+def|state\s+def|requirement\s+def|attribute\s+def|item\s+def|calc\s+def|constraint\s+def|viewpoint\s+def|view\s+def|metadata\s+def|enum\s+def|part|port|interface|connection|connect|action|state|requirement|attribute|item|calc|constraint|view|expose|allocation|flow|transition|occurrence|individual|package|use\s+case|analysis|enum|variability|verification)\b/iu;

const CONSTRUCT_TAG_MAP = Object.freeze({
  'part def': 'part-def',
  part: 'part-usage',
  'port def': 'port-def',
  port: 'port-def',
  'interface def': 'interface',
  interface: 'interface',
  connect: 'connect',
  connection: 'connect',
  'connection def': 'connect',
  'action def': 'action-def',
  action: 'action-def',
  'state def': 'state-def',
  state: 'state-def',
  'requirement def': 'requirement',
  requirement: 'requirement',
  'attribute def': 'attribute',
  attribute: 'attribute',
  'item def': 'item',
  item: 'item',
  'calc def': 'calc',
  calc: 'calc',
  'constraint def': 'constraint',
  constraint: 'constraint',
  'view def': 'view',
  view: 'view',
  expose: 'view',
  'viewpoint def': 'view',
  'enum def': 'enum',
  enum: 'enum',
  'metadata def': 'metadata',
  allocation: 'allocation',
  variability: 'variability',
  verification: 'verification',
  'use case': 'use-case',
  analysis: 'analysis',
  flow: 'flow',
  transition: 'transition',
  occurrence: 'occurrence',
  individual: 'individual',
  package: 'package'
});

const CONSTRUCT_TAG_VOCABULARY = Object.freeze([
  'part-def', 'part-usage', 'port-def', 'interface', 'connect', 'action-def',
  'state-def', 'requirement', 'attribute', 'item', 'calc', 'constraint', 'view',
  'enum', 'allocation', 'metadata', 'variability', 'verification', 'use-case',
  'analysis', 'flow', 'transition', 'occurrence', 'individual', 'expression',
  'package'
]);

function sha256Text(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function deriveExampleId({ exampleAuthority, sourcePath }) {
  const authority = exampleAuthority === 'community-example' ? 'community' : 'official';
  const stem = String(sourcePath || '')
    .replace(/\\/g, '/')
    .replace(/^.*\/training\//u, '')
    .replace(/^.*\/models\//u, '')
    .replace(/\.sysml$/iu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  return `ex-${authority}-training-${stem || 'unnamed'}`;
}

function extractTopicPath(sourcePath) {
  const normalized = String(sourcePath || '').replace(/\\/g, '/');
  const match = normalized.match(/(?:training|models)\/([^/]+)\//u);
  return match ? match[1] : 'generic';
}

function extractLeadingDocComment(modelText) {
  const text = String(modelText || '');
  const docMatch = text.match(/\/\*\*([\s\S]*?)\*\//u)
    || text.match(/\/\*([\s\S]*?)\*\//u)
    || text.match(/^\s*\/\/\s*(.+)$/mu);
  if (!docMatch) return '';
  return String(docMatch[1] || '')
    .replace(/^\s*\*\s?/gmu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 300);
}

function deriveIntentText({ topicPath, sourcePath, modelText }) {
  const fileName = path.basename(String(sourcePath || ''), '.sysml');
  const topic = String(topicPath || extractTopicPath(sourcePath) || 'generic').trim();
  const doc = extractLeadingDocComment(modelText);
  return uniqueStrings([topic, fileName, doc]).join(' — ').slice(0, 800);
}

function extractConstructTags(modelText) {
  const tags = [];
  for (const line of String(modelText || '').split(/\r?\n/u)) {
    const match = DECLARATION_PATTERN.exec(line);
    if (!match?.[1]) continue;
    const key = String(match[1]).toLowerCase().replace(/\s+/gu, ' ');
    const tag = CONSTRUCT_TAG_MAP[key];
    if (tag) tags.push(tag);
  }
  if (/\bexpression\b/iu.test(String(modelText || ''))) tags.push('expression');
  return uniqueStrings(tags).filter((tag) => CONSTRUCT_TAG_VOCABULARY.includes(tag));
}

function deriveTitle({ topicPath, sourcePath }) {
  const fileName = path.basename(String(sourcePath || ''), '.sysml');
  const topic = String(topicPath || extractTopicPath(sourcePath) || '').trim();
  return topic ? `${topic} — ${fileName}` : fileName;
}

const TRAINING_STDLIB_PACKAGES = Object.freeze([
  'ScalarValues', 'ISQ', 'SI', 'USCustomaryUnits', 'SequenceFunctions', 'Quantities',
  'ControlFunctions', 'Views', 'Metaobjects', 'Time', 'NumericalFunctions',
  'TradeStudies', 'VerificationCases', 'AnalysisTooling', 'RiskMetadata'
]);

function extractPackageNames(modelText) {
  return uniqueStrings([...String(modelText || '').matchAll(/^\s*(?:library\s+)?package\s+(?:'([^']+)'|([A-Za-z_][\w.-]*))/gmu)]
    .map((match) => match[1] || match[2]));
}

function extractTrainingImports(modelText) {
  const stdlib = new Set(TRAINING_STDLIB_PACKAGES);
  return uniqueStrings([...String(modelText || '').matchAll(/^\s*(?:private|public)?\s*import\s+(?:'([^']+)'|([A-Za-z_][\w.-]*))/gmu)]
    .map((match) => match[1] || match[2])
    .filter((name) => name && !stdlib.has(name)));
}

function mergeTrainingDependencyClosure(seedRel, recordsByRel, recordsByPackage) {
  const ordered = [];
  const seen = new Set();
  const missing = [];
  const visit = (record) => {
    if (!record || seen.has(record.rel)) return;
    seen.add(record.rel);
    for (const depName of record.imports || []) {
      const dep = recordsByPackage.get(depName);
      if (!dep) missing.push(depName);
      else visit(dep);
    }
    ordered.push(record);
  };
  visit(recordsByRel.get(seedRel));
  return {
    ordered,
    missing: uniqueStrings(missing),
    mergedText: ordered.map((record) => String(record.text || '').trimEnd()).join('\n\n')
  };
}

function buildExampleAsset({
  exampleAuthority = 'official-example',
  languageVersionTrack = '2.1-beta-forward',
  domainTags = ['generic'],
  source,
  modelText,
  validatorAttestation,
  relatedClaimIds = [],
  properties = {}
}) {
  const topicPath = extractTopicPath(source.sourcePath || source.outputPath);
  const exampleId = deriveExampleId({
    exampleAuthority,
    sourcePath: source.sourcePath || source.outputPath
  });
  const constructTags = extractConstructTags(modelText);
  const intentText = deriveIntentText({
    topicPath,
    sourcePath: source.sourcePath || source.outputPath,
    modelText
  });
  const modelTextHash = sha256Text(modelText);
  return {
    exampleId,
    title: deriveTitle({ topicPath, sourcePath: source.sourcePath || source.outputPath }),
    intentText,
    modelText: String(modelText),
    modelTextHash,
    constructTags,
    domainTags: uniqueStrings(domainTags),
    topicPath,
    languageVersionTrack,
    exampleAuthority,
    source: {
      repository: source.repository,
      commit: source.commit,
      sourcePath: source.sourcePath,
      sha256: source.sha256 || source.hash?.sha256,
      gitBlobSha1: source.gitBlobSha1 || source.hash?.gitBlobSha1,
      spdxLicense: source.spdxLicense
    },
    validatorAttestation,
    reviewStatus: 'machine_validated',
    sizeChars: String(modelText).length,
    relatedClaimIds: uniqueStrings(relatedClaimIds),
    properties: properties && typeof properties === 'object' ? properties : {}
  };
}

function assertExampleAsset(example) {
  if (!example?.exampleId) throw new Error('exampleId is required');
  if (!example.intentText) throw new Error(`intentText missing for ${example.exampleId}`);
  if (!example.modelText) throw new Error(`modelText missing for ${example.exampleId}`);
  if (!/^sha256:[a-f0-9]{64}$/.test(String(example.modelTextHash || ''))) {
    throw new Error(`modelTextHash invalid for ${example.exampleId}`);
  }
  if (example.reviewStatus !== 'machine_validated') {
    throw new Error(`reviewStatus must be machine_validated for ${example.exampleId}`);
  }
  const attestation = example.validatorAttestation || {};
  if (attestation.syntax !== 'passed' || attestation.semantic !== 'passed') {
    throw new Error(`validatorAttestation incomplete for ${example.exampleId}`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(attestation.evidenceHash || ''))) {
    throw new Error(`validator evidenceHash missing for ${example.exampleId}`);
  }
  if (!example.source?.spdxLicense || !example.source?.commit || !example.source?.sha256) {
    throw new Error(`source lock incomplete for ${example.exampleId}`);
  }
}

function evaluateExampleValidatorAttestation(examples = []) {
  const list = Array.isArray(examples) ? examples : [];
  const incomplete = list.filter((example) => {
    try {
      assertExampleAsset(example);
      return false;
    } catch {
      return true;
    }
  });
  return {
    status: incomplete.length === 0 && list.length >= 0 ? 'PASS' : 'PENDING',
    total: list.length,
    incomplete: incomplete.length,
    incompleteExampleIds: incomplete.map((item) => item.exampleId).filter(Boolean)
  };
}

module.exports = {
  CONSTRUCT_TAG_VOCABULARY,
  DECLARATION_PATTERN,
  TRAINING_STDLIB_PACKAGES,
  assertExampleAsset,
  buildExampleAsset,
  canonicalJson,
  deriveExampleId,
  deriveIntentText,
  evaluateExampleValidatorAttestation,
  extractConstructTags,
  extractPackageNames,
  extractTrainingImports,
  extractTopicPath,
  mergeTrainingDependencyClosure,
  sha256Text,
  uniqueStrings
};
