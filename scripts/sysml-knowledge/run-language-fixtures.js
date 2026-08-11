'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CATALOG = path.join(
  PROJECT_ROOT,
  'resources',
  'sysml-knowledge',
  'language',
  'fixtures',
  'model-user-textual-closure-v1',
  'catalog.json'
);
const DEFAULT_OUTPUT = path.join(
  PROJECT_ROOT,
  'resources',
  'sysml-knowledge',
  'language',
  'validator-runs',
  'model-user-textual-closure-v1-official.json'
);

async function runLanguageFixtures(options = {}) {
  const catalogPath = path.resolve(options.catalogPath || DEFAULT_CATALOG);
  const outputPath = path.resolve(options.outputPath || DEFAULT_OUTPUT);
  const validatorUrl = String(options.validatorUrl || process.env.VALIDATOR_BASE_URL || 'http://localhost:9090')
    .replace(/\/$/, '');
  ensureWithinProject(catalogPath);
  ensureWithinProject(outputPath);
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const lock = catalog.validatorLock || {};
  const health = await getJson(`${validatorUrl}/health`);
  assertOfficialHealth(health, lock);

  const results = [];
  for (const fixture of catalog.fixtures || []) {
    const fixturePath = path.resolve(path.dirname(catalogPath), fixture.path);
    ensureWithin(path.dirname(catalogPath), fixturePath);
    const content = fs.readFileSync(fixturePath, 'utf8');
    const validation = await postJson(`${validatorUrl}/validate`, {
      fileName: path.basename(fixturePath),
      content
    });
    results.push(evaluateFixture({ fixture, content, validation, lock }));
  }

  const core = {
    schemaVersion: '1.1.0',
    fixtureSetId: catalog.fixtureSetId,
    validator: {
      source: lock.source,
      releaseTag: lock.releaseTag,
      kernelVersion: lock.kernelVersion,
      artifactHash: lock.artifactHash
    },
    results
  };
  const report = {
    ...core,
    validatorRunId: `validator-run:${sha256(canonicalJson(core)).slice(0, 24)}`,
    status: results.length > 0 && results.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL'
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { report, outputPath };
}

function evaluateFixture({ fixture, content, validation, lock }) {
  const diagnostics = normalizeDiagnostics(validation.diagnostics);
  const outlineMetaclasses = flattenSemanticOutline(validation.semanticOutline)
    .map((node) => String(node.metaclass || ''))
    .filter(Boolean)
    .sort();
  const uniqueMetaclasses = [...new Set(outlineMetaclasses)];
  const expected = fixture.expectedValidator || {};
  const validatorChecks = {
    source: validation.source === lock.source,
    validationCompleteness: validation.validationCompleteness === 'official',
    fallbackInactive: validation.fallbackActive === false,
    syntaxValid: expected.syntaxValid === undefined || validation.syntaxValid === expected.syntaxValid,
    semanticValid: expected.semanticValid === undefined || validation.semanticValid === expected.semanticValid
  };
  const oracleResult = fixture.oracle ? evaluateOracle(uniqueMetaclasses, fixture.oracle) : null;
  const expectedOraclePass = fixture.oracle?.expectedPass;
  const oracleCheck = !fixture.oracle
    || (typeof expectedOraclePass === 'boolean' && oracleResult.pass === expectedOraclePass);
  const confusionHasOracle = fixture.kind !== 'confusion' || Boolean(fixture.oracle);
  const diagnosticChecks = evaluateDiagnosticAnchors(
    diagnostics,
    fixture.diagnosticAnchors,
    { required: fixture.kind === 'syntax_negative' }
  );
  const status = Object.values(validatorChecks).every(Boolean)
    && oracleCheck
    && confusionHasOracle
    && diagnosticChecks.allMatched
    ? 'PASS'
    : 'FAIL';
  return {
    fixtureId: fixture.fixtureId,
    fixtureKind: fixture.kind,
    coverageUnitIds: [...(fixture.coverageUnitIds || [])],
    contentHash: `sha256:${sha256(content)}`,
    validator: {
      source: validation.source,
      validationCompleteness: validation.validationCompleteness,
      fallbackActive: validation.fallbackActive,
      syntaxValid: validation.syntaxValid,
      semanticValid: validation.semanticValid,
      outlineStatus: validation.semanticOutline?.status || 'missing',
      outlineMetaclasses: uniqueMetaclasses,
      diagnostics
    },
    validatorChecks,
    diagnosticChecks,
    oracle: oracleResult ? {
      ...oracleResult,
      expectedPass: expectedOraclePass
    } : null,
    status
  };
}

function evaluateDiagnosticAnchors(diagnostics, diagnosticAnchors, options = {}) {
  const normalizedDiagnostics = normalizeDiagnostics(diagnostics);
  const required = options.required === true;
  const anchors = (diagnosticAnchors || []).map((anchor, index) => {
    const normalizedAnchor = normalizeDiagnosticAnchor(anchor, index);
    return {
      ...normalizedAnchor,
      matched: normalizedDiagnostics.some((diagnostic) => matchesDiagnosticAnchor(diagnostic, normalizedAnchor))
    };
  });
  const matchedCount = anchors.filter((anchor) => anchor.matched).length;
  return {
    required,
    anchorCount: anchors.length,
    matchedCount,
    allMatched: (!required || anchors.length > 0) && matchedCount === anchors.length,
    anchors
  };
}

function matchesDiagnosticAnchor(diagnostic, anchor) {
  return diagnostic.category === anchor.category
    && diagnostic.code === anchor.code
    && diagnostic.line === anchor.line
    && diagnostic.column === anchor.column
    && diagnostic.message.includes(anchor.messageIncludes);
}

function normalizeDiagnosticAnchor(anchor, index) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) {
    throw new Error(`diagnosticAnchors[${index}] must be an object`);
  }
  for (const field of ['category', 'code', 'messageIncludes']) {
    if (typeof anchor[field] !== 'string' || anchor[field].length === 0) {
      throw new Error(`diagnosticAnchors[${index}].${field} must be a non-empty string`);
    }
  }
  for (const field of ['line', 'column']) {
    if (!Number.isInteger(anchor[field]) || anchor[field] < 1) {
      throw new Error(`diagnosticAnchors[${index}].${field} must be a positive integer`);
    }
  }
  return {
    category: anchor.category,
    code: anchor.code,
    line: anchor.line,
    column: anchor.column,
    messageIncludes: anchor.messageIncludes
  };
}

function normalizeDiagnostics(diagnostics) {
  return (diagnostics || []).map((diagnostic) => ({
    source: String(diagnostic.source || ''),
    severity: String(diagnostic.severity || ''),
    category: String(diagnostic.category || ''),
    code: String(diagnostic.code || ''),
    line: toDiagnosticPosition(diagnostic.line),
    column: toDiagnosticPosition(diagnostic.column),
    message: String(diagnostic.message || '')
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), 'en'));
}

function toDiagnosticPosition(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? number : null;
}

function evaluateOracle(outlineMetaclasses, oracle) {
  if (oracle.type !== 'semantic_outline_metaclass') {
    throw new Error(`Unsupported fixture oracle type: ${oracle.type || ''}`);
  }
  const actual = new Set(outlineMetaclasses);
  const requiredMetaclasses = [...(oracle.requiredMetaclasses || [])];
  const forbiddenMetaclasses = [...(oracle.forbiddenMetaclasses || [])];
  const missingRequired = requiredMetaclasses.filter((item) => !actual.has(item));
  const presentForbidden = forbiddenMetaclasses.filter((item) => actual.has(item));
  return {
    type: oracle.type,
    pass: missingRequired.length === 0 && presentForbidden.length === 0,
    missingRequired,
    presentForbidden
  };
}

function flattenSemanticOutline(outline) {
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    for (const child of node.children || []) visit(child);
  };
  for (const root of outline?.roots || []) visit(root);
  return nodes;
}

function assertOfficialHealth(health, lock) {
  const official = health?.official || {};
  if (health?.ok !== true
    || official.officialAvailable !== true
    || official.artifactTrusted !== true
    || official.source !== lock.source
    || official.releaseTag !== lock.releaseTag
    || official.kernelVersion !== lock.kernelVersion
    || official.artifacts?.artifactHash !== lock.artifactHash
    || health.fallbackActive !== false) {
    throw new Error(`Official Validator does not match fixture lock: ${JSON.stringify(health)}`);
  }
}

async function getJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function ensureWithinProject(filePath) {
  ensureWithin(PROJECT_ROOT, filePath);
}

function ensureWithin(parentPath, filePath) {
  const parent = path.resolve(parentPath);
  const resolved = path.resolve(filePath);
  if (resolved !== parent && !resolved.startsWith(`${parent}${path.sep}`)) {
    throw new Error(`Path escapes allowed root: ${filePath}`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--catalog') options.catalogPath = value;
    else if (key === '--output') options.outputPath = value;
    else if (key === '--validator-url') options.validatorUrl = value;
    else throw new Error(`Unknown argument: ${key}`);
    index += 1;
  }
  return options;
}

if (require.main === module) {
  runLanguageFixtures(parseArgs(process.argv.slice(2)))
    .then(({ report, outputPath }) => {
      process.stdout.write(`${JSON.stringify({
        ok: report.status === 'PASS',
        validatorRunId: report.validatorRunId,
        fixtureSetId: report.fixtureSetId,
        fixtureCount: report.results.length,
        status: report.status,
        outputPath
      }, null, 2)}\n`);
      if (report.status !== 'PASS') process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  evaluateDiagnosticAnchors,
  evaluateFixture,
  evaluateOracle,
  flattenSemanticOutline,
  matchesDiagnosticAnchor,
  normalizeDiagnostics,
  runLanguageFixtures
};
