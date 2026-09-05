'use strict';

const { validateWorkspace: analyzeWorkspace, SOURCE: LOCAL_ANALYZER_SOURCE } = require('./local-analyzer');
const { OfficialValidatorBackend, OFFICIAL_SOURCE, RELEASE_TAG, KERNEL_VERSION } = require('./official-backend');
const { OfficialOutlineBackend } = require('./official-outline-backend');
const { OfficialPlantUmlBackend } = require('./official-plantuml-backend');
const { optimizePlantUmlLayout } = require('./plantuml-layout-optimizer');
const { ValidatorAdmissionQueue } = require('./admission-queue');
const {
  BOOTSTRAP_VALUES: AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES,
  runtimeProjection: agentResourcePolicyRuntimeProjection
} = require('../../packages/agent-resource-policy');

const validatorBootstrap = agentResourcePolicyRuntimeProjection(
  AGENT_RESOURCE_POLICY_BOOTSTRAP_VALUES
).validator;

const backend = new OfficialValidatorBackend();
const outlineBackend = new OfficialOutlineBackend();
const plantUmlBackend = new OfficialPlantUmlBackend();
const validatorAdmission = new ValidatorAdmissionQueue({
  queueLimit: validatorBootstrap.queueLimit,
  queueWaitMs: validatorBootstrap.queueWaitMs
});
let activeResourcePolicy = Object.freeze({
  versionId: 'validator_bootstrap',
  checksum: '',
  queueLimit: validatorBootstrap.queueLimit,
  queueWaitMs: validatorBootstrap.queueWaitMs,
  executionTimeoutMs: validatorBootstrap.executionTimeoutMs,
  appliedAt: new Date(0).toISOString()
});
const FALLBACK_ALLOWED = process.env.OFFICIAL_VALIDATOR_FALLBACK === 'true';
const SYSML_NAME_SOURCE = String.raw`'(?:\\.|[^'\\\r\n])+'|[A-Za-z_][\w]*`;
const SYSML_QUALIFIED_NAME_SOURCE = String.raw`(?:${SYSML_NAME_SOURCE})(?:::(?:${SYSML_NAME_SOURCE}))*`;

async function validateWorkspace(input, options = {}) {
  const files = normalizeFiles(input);
  const structure = analyzeWorkspace({ files });
  const content = combineFiles(files);

  if (backend.isConfigured()) {
    let validatorObservation;
    try {
      const official = await validatorAdmission.run(
        () => backend.validate(content),
        {
          signal: options.signal,
          onObservation: (value) => { validatorObservation = value; }
        }
      );
      const semanticOutline = official.syntaxValid && official.semanticValid
        ? await buildOfficialSemanticOutline(content)
        : invalidSemanticOutline(content, official.diagnostics || []);
      return {
        ...official,
        source: official.source || OFFICIAL_SOURCE,
        backend: 'official-sysml-v2-pilot',
        releaseTag: RELEASE_TAG,
        kernelVersion: KERNEL_VERSION,
        validatorAttestation: backend.artifactAttestation(),
        validationCompleteness: 'official',
        fallbackActive: false,
        semanticOutline,
        modelElements: structure.modelElements || [],
        structureDiagnostics: structure.diagnostics || [],
        validatorObservation
      };
    } catch (error) {
      if (error?.name === 'ValidatorAdmissionError') throw error;
      if (!FALLBACK_ALLOWED) {
        return {
          ...unavailableResult(error, structure, content),
          validatorObservation: error?.validatorObservation || validatorObservation
        };
      }
      const fallback = fallbackResult(structure, content);
      fallback.officialError = error.message;
      fallback.validatorObservation = error?.validatorObservation || validatorObservation;
      return fallback;
    }
  }

  return {
    ...fallbackResult(structure, content),
    validatorObservation: {
      attempt: 1,
      admissionOutcome: 'backend_unavailable',
      queueWaitMs: 0,
      executionMs: 0,
      retryableBeforeStart: false,
      abortedAfterStart: false
    }
  };
}

function validatorHealth() {
  return {
    ok: true,
    activeBackend: backend.isConfigured() ? 'official-sysml-v2-pilot' : 'local-structure-fallback',
    official: backend.health(),
    admission: validatorAdmission.snapshot(),
    semanticOutline: outlineBackend.health(),
    plantuml: plantUmlBackend.health(),
    fallbackAllowed: FALLBACK_ALLOWED,
    fallbackActive: !backend.isConfigured(),
    localAnalyzerSource: LOCAL_ANALYZER_SOURCE,
    resourcePolicy: validatorResourcePolicyState()
  };
}

function applyValidatorResourcePolicy(input = {}) {
  const next = validateValidatorResourcePolicy(input);
  validatorAdmission.updateSettings(next);
  backend.updateTimeoutMs(next.executionTimeoutMs);
  activeResourcePolicy = Object.freeze({
    ...next,
    appliedAt: new Date().toISOString()
  });
  return validatorResourcePolicyState();
}

function validatorResourcePolicyState() {
  const admission = validatorAdmission.snapshot();
  return {
    status: 'applied',
    versionId: activeResourcePolicy.versionId,
    checksum: activeResourcePolicy.checksum,
    queueLimit: admission.queueLimit,
    queueWaitMs: admission.queueWaitMs,
    executionTimeoutMs: backend.timeoutMs,
    appliedAt: activeResourcePolicy.appliedAt
  };
}

function validateValidatorResourcePolicy(input = {}) {
  const versionId = String(input.versionId || '').trim();
  const checksum = String(input.checksum || '').trim();
  if (!/^arp_[A-Za-z0-9._:-]{1,160}$/.test(versionId)) {
    throw resourcePolicyError('VALIDATOR_RESOURCE_POLICY_VERSION_INVALID', 'Validator resource policy version is invalid.');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(checksum)) {
    throw resourcePolicyError('VALIDATOR_RESOURCE_POLICY_CHECKSUM_INVALID', 'Validator resource policy checksum is invalid.');
  }
  return {
    versionId,
    checksum,
    queueLimit: strictPolicyInteger(input.queueLimit, 0, 64, 'queueLimit'),
    queueWaitMs: strictPolicyInteger(input.queueWaitMs, 1000, 120000, 'queueWaitMs'),
    executionTimeoutMs: strictPolicyInteger(input.executionTimeoutMs, 5000, 120000, 'executionTimeoutMs')
  };
}

function strictPolicyInteger(value, minimum, maximum, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw resourcePolicyError('VALIDATOR_RESOURCE_POLICY_VALUE_INVALID', `${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

function resourcePolicyError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

async function generatePlantUml(input) {
  const files = normalizeFiles(input);
  const requestedViewName = input?.viewName || selectEntryFileViewName(files, input?.entryFile);
  const prepared = preparePlantUmlSource(files, {
    entryFile: input?.entryFile,
    requestedViewName
  });
  const content = prepared.content;
  const viewName = requestedViewName || prepared.viewName;
  const renderMode = input?.renderMode || '';
  const requestedStyles = Array.isArray(input?.styles) ? input.styles : [];
  const optimizationMode = input?.layoutOptimization?.mode === 'off' ? 'off' : 'auto';
  const result = optimizationMode === 'off'
    ? await plantUmlBackend.generate({
      content,
      viewName,
      renderMode,
      styles: requestedStyles
    })
    : await optimizePlantUmlLayout({
      content,
      viewName,
      renderMode,
      renderCandidate: (styles) => plantUmlBackend.generate({
        content,
        viewName,
        renderMode,
        styles
      })
    });
  return {
    ...result,
    source: result.source || OFFICIAL_SOURCE,
    backend: 'official-sysml-v2-pilot-plantuml',
    releaseTag: RELEASE_TAG,
    kernelVersion: KERNEL_VERSION,
    validatorAttestation: backend.artifactAttestation(),
    generatedView: prepared.generatedView || null,
    viewPolicy: {
      usedGeneratedView: Boolean(prepared.generatedView),
      reason: prepared.generatedView
        ? 'No explicit SysML view usage was found; a temporary GeneralView was generated for PlantUML rendering only.'
        : 'Explicit SysML view usage or requested view was used.',
      renderMode: {
        requested: result.requestedRenderMode || '',
        resolved: result.resolvedRenderMode || result.renderMode || '',
        source: result.renderModeSource || 'unknown',
        standardViewDefinition: result.standardViewDefinition || null
      }
    }
  };
}

async function buildOfficialSemanticOutline(content) {
  try {
    return await outlineBackend.outline(content);
  } catch (error) {
    return unavailableSemanticOutline(content, error.message);
  }
}

function fallbackResult(structure, content = '') {
  return {
    ...structure,
    source: LOCAL_ANALYZER_SOURCE,
    backend: 'local-structure-fallback',
    validationCompleteness: 'partial',
    fallbackActive: true,
    officialAvailable: backend.isAvailable(),
    semanticOutline: unavailableSemanticOutline(content, '官方 SysML v2 Pilot validator 未配置，无法生成官方语义树。'),
    diagnostics: [
      warningDiag('当前未配置官方 SysML v2 Pilot Implementation validator；本结果只来自本地教学结构提取器，不能作为完整 SysML v2 语法/语义通过依据。'),
      ...(structure.diagnostics || [])
    ]
  };
}

function unavailableResult(error, structure, content = '') {
  return {
    source: OFFICIAL_SOURCE,
    backend: 'official-sysml-v2-pilot',
    releaseTag: RELEASE_TAG,
    kernelVersion: KERNEL_VERSION,
    validatorAttestation: backend.artifactAttestation(),
    syntaxValid: false,
    semanticValid: false,
    valid: false,
    validationCompleteness: 'official-unavailable',
    fallbackActive: false,
    diagnostics: [{
      file: 'main.sysml',
      line: 1,
      column: 1,
      severity: 'error',
      category: 'infrastructure',
      code: String(error?.code || 'OFFICIAL_VALIDATOR_UNAVAILABLE'),
      message: '官方 SysML v2 Validator 当前不可用；未返回语法或语义通过结论。',
      source: OFFICIAL_SOURCE
    }],
    semanticOutline: unavailableSemanticOutline(content, '官方 SysML v2 Validator 当前不可用。'),
    modelElements: structure.modelElements || [],
    structureDiagnostics: structure.diagnostics || []
  };
}

function invalidSemanticOutline(content, diagnostics = []) {
  return {
    source: OFFICIAL_SOURCE,
    status: 'invalid',
    generatedAt: new Date().toISOString(),
    contentHash: contentHash(content),
    roots: [],
    diagnostics
  };
}

function unavailableSemanticOutline(content, message) {
  return {
    source: OFFICIAL_SOURCE,
    status: 'unavailable',
    generatedAt: new Date().toISOString(),
    contentHash: contentHash(content),
    roots: [],
    diagnostics: [{
      file: 'workspace',
      line: 1,
      column: 1,
      severity: 'warning',
      category: 'infrastructure',
      message: message || '官方语义树不可用。',
      source: OFFICIAL_SOURCE
    }]
  };
}

function contentHash(content) {
  return `sha256:${require('crypto').createHash('sha256').update(String(content || ''), 'utf8').digest('hex')}`;
}

function warningDiag(message) {
  return {
    file: 'workspace',
    line: 1,
    column: 1,
    severity: 'warning',
    category: 'infrastructure',
    message,
    source: LOCAL_ANALYZER_SOURCE
  };
}

function normalizeFiles(input) {
  if (Array.isArray(input?.files) && input.files.length > 0) {
    return input.files.map((file, index) => ({
      path: file.path || `file-${index + 1}.sysml`,
      content: stripUtf8Bom(file.content)
    }));
  }
  return [{ path: input?.path || 'main.sysml', content: stripUtf8Bom(input?.content) }];
}

function combineFiles(files) {
  return files.map((file) => `// file: ${file.path}\n${file.content}`).join('\n\n');
}

function stripUtf8Bom(value) {
  return String(value || '').replace(/^\uFEFF/, '');
}

function selectEntryFileViewName(files, entryFile) {
  const entry = String(entryFile || '').trim();
  const file = files.find((candidate) => candidate.path === entry) || files[0];
  const content = maskSysmlCommentsAndStrings(String(file?.content || ''));
  const packageOpenings = new Map();
  const packagePattern = new RegExp(String.raw`\bpackage\s+(${SYSML_NAME_SOURCE})\s*\{`, 'g');
  for (const match of content.matchAll(packagePattern)) {
    packageOpenings.set(match.index + match[0].lastIndexOf('{'), match[1]);
  }
  const viewsByOffset = new Map();
  const viewPattern = new RegExp(String.raw`(?:^|[;{}\r\n])\s*view\s+(?!def\b)(${SYSML_NAME_SOURCE})\s*:`, 'gm');
  for (const match of content.matchAll(viewPattern)) {
    const offset = match.index + match[0].lastIndexOf('view');
    viewsByOffset.set(offset, [...(viewsByOffset.get(offset) || []), match[1]]);
  }
  const views = [];
  let depth = 0;
  const packageScopes = [];
  for (let offset = 0; offset < content.length; offset += 1) {
    for (const viewToken of viewsByOffset.get(offset) || []) {
      const packageName = packageScopes.map((scope) => scope.token).join('::');
      views.push({
        name: decodeSysmlNameToken(viewToken),
        qualifiedName: packageName ? `${packageName}::${viewToken}` : viewToken
      });
    }
    if (content[offset] === '{') {
      depth += 1;
      const packageToken = packageOpenings.get(offset);
      if (packageToken) packageScopes.push({ token: packageToken, depth });
    } else if (content[offset] === '}') {
      while (packageScopes.at(-1)?.depth === depth) packageScopes.pop();
      depth = Math.max(0, depth - 1);
    }
  }
  if (!views.length) return '';
  views.sort((left, right) => viewNameScore(right.name) - viewNameScore(left.name));
  return views[0].qualifiedName;
}

function viewNameScore(name) {
  const text = String(name || '').toLowerCase();
  let score = 0;
  if (text.includes('evidence')) score += 90;
  if (text.includes('requirement')) score += 85;
  if (text.includes('behavior')) score += 80;
  if (text.includes('structure') || text.includes('interface')) score += 75;
  if (text.includes('product') || text.includes('variant')) score += 70;
  if (text.includes('context') || text.includes('system')) score += 65;
  if (text.includes('overview') || text.includes('review')) score += 55;
  if (text.includes('flow')) score -= 30;
  if (text.includes('browser') || text.includes('tree')) score -= 40;
  return score;
}

function preparePlantUmlSource(files, { entryFile = '', requestedViewName = '' } = {}) {
  const originalContent = combineFiles(files);
  const entryViewName = requestedViewName || selectEntryFileViewName(files, entryFile);
  if (entryViewName) {
    return { content: originalContent, viewName: entryViewName, generatedView: null };
  }

  const generatedView = buildGeneratedPlantUmlView(files, entryFile);
  if (!generatedView) {
    return { content: originalContent, viewName: '', generatedView: null };
  }

  return {
    content: `${originalContent}\n\n${generatedView.source}\n`,
    viewName: generatedView.name,
    generatedView
  };
}

function buildGeneratedPlantUmlView(files, entryFile = '') {
  const entry = files.find((file) => file.path === entryFile) || files[0];
  const entryElements = entry ? collectRenderableElements([entry]) : [];
  const elements = entryElements.length ? entryElements : collectRenderableElements(files);
  if (!elements.length) return null;

  const selected = selectGeneratedViewExposes(elements);
  if (!selected.length) return null;

  const content = combineFiles(files);
  const name = uniqueGeneratedViewName(content);
  const exposeLines = selected.map((element) => `  expose ${element.qualifiedName};`);
  return {
    name,
    type: 'StandardViewDefinitions::GeneralView',
    exposes: selected.map((element) => ({
      name: element.name,
      qualifiedName: element.qualifiedName,
      kind: element.kind,
      typeName: element.typeName || null
    })),
    entryFile: entryFile || files[0]?.path || 'main.sysml',
    source: [
      `view ${name} : StandardViewDefinitions::GeneralView {`,
      ...exposeLines,
      '}'
    ].join('\n')
  };
}

function collectRenderableElements(files) {
  const out = [];
  for (const file of files) {
    const content = stripSysmlComments(String(file.content || ''));
    const packages = extractPackageBodies(content);
    if (packages.length) {
      for (const pkg of packages) {
        out.push(...collectTopLevelDeclarations(pkg.body, pkg.name, file.path, pkg.nameRef));
      }
    } else {
      out.push(...collectTopLevelDeclarations(content, '', file.path));
    }
  }
  return dedupeElements(out);
}

function extractPackageBodies(content) {
  const packages = [];
  const regex = new RegExp(String.raw`\bpackage\s+(${SYSML_NAME_SOURCE})\s*\{`, 'g');
  let match;
  while ((match = regex.exec(content))) {
    const openIndex = content.indexOf('{', match.index);
    const closeIndex = findMatchingBrace(content, openIndex);
    if (closeIndex < 0) continue;
    packages.push({
      name: decodeSysmlNameToken(match[1]),
      nameRef: sysmlNameReference(match[1]),
      body: content.slice(openIndex + 1, closeIndex)
    });
    regex.lastIndex = closeIndex + 1;
  }
  return packages;
}

function findMatchingBrace(content, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function collectTopLevelDeclarations(content, packageName, filePath, packageNameRef = '') {
  const statements = topLevelStatements(content);
  const declarations = [];
  for (const statement of statements) {
    const parsed = parseRenderableDeclaration(statement);
    if (!parsed) continue;
    declarations.push({
      ...parsed,
      file: filePath,
      packageName,
      qualifiedName: packageName ? `${packageNameRef || packageName}::${parsed.nameRef || parsed.name}` : (parsed.nameRef || parsed.name)
    });
  }
  return declarations;
}

function topLevelStatements(content) {
  const statements = [];
  let depth = 0;
  let current = '';
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === '{') {
      if (depth === 0 && current.trim()) statements.push(current.trim());
      current = '';
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) current = '';
      continue;
    }
    if (depth !== 0) continue;
    current += char;
    if (char === ';') {
      statements.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function parseRenderableDeclaration(statement) {
  const text = String(statement || '').replace(/\s+/g, ' ').trim();
  const def = text.match(new RegExp(String.raw`^(?:abstract\s+)?(part|item|port|interface|connection|action|state|requirement|constraint|calculation|calc|analysis|verification|attribute)\s+def\s+(${SYSML_NAME_SOURCE})(?:\s*(?::>|specializes)\s*(${SYSML_QUALIFIED_NAME_SOURCE}))?`));
  if (def) {
    return {
      kind: `${def[1] === 'calc' ? 'calculation' : def[1]} def`,
      name: decodeSysmlNameToken(def[2]),
      nameRef: sysmlNameReference(def[2]),
      typeName: null,
      specializes: def[3] ? decodeSysmlQualifiedName(def[3]) : null,
      isDefinition: true
    };
  }

  const usage = text.match(new RegExp(String.raw`^(part|item|port|interface|connection|action|state|requirement|constraint|calculation|calc|analysis|verification)\s+(${SYSML_NAME_SOURCE})(?:\s*\[[^\]]+\])?\s*(?::\s*(~?${SYSML_QUALIFIED_NAME_SOURCE}))?`));
  if (usage && usage[2] !== 'def') {
    return {
      kind: usage[1] === 'calc' ? 'calculation' : usage[1],
      name: decodeSysmlNameToken(usage[2]),
      nameRef: sysmlNameReference(usage[2]),
      typeName: usage[3] ? decodeSysmlQualifiedName(usage[3].replace(/^~/, '')) : null,
      specializes: null,
      isDefinition: false
    };
  }

  return null;
}

function selectGeneratedViewExposes(elements) {
  const definitions = elements.filter((element) => element.isDefinition);
  const usages = elements.filter((element) => !element.isDefinition);
  const selectedUsages = usages
    .sort((left, right) => elementRank(right) - elementRank(left))
    .slice(0, 4);
  const selected = [];

  for (const usage of selectedUsages) {
    const definition = findDefinitionForUsage(usage, definitions);
    if (definition) selected.push(definition);
    selected.push(usage);
  }

  if (!selected.length) {
    selected.push(...definitions.sort((left, right) => elementRank(right) - elementRank(left)).slice(0, 8));
  }

  return dedupeElements(selected).slice(0, 10);
}

function findDefinitionForUsage(usage, definitions) {
  if (!usage.typeName) return null;
  const typeName = lastSegment(usage.typeName);
  return definitions.find((definition) => definition.packageName === usage.packageName && definition.name === typeName)
    || definitions.find((definition) => definition.name === typeName)
    || null;
}

function elementRank(element) {
  const name = String(element.name || '').toLowerCase();
  let score = 0;
  if (element.kind === 'part') score += 100;
  if (element.kind === 'item') score += 90;
  if (element.kind === 'part def') score += 80;
  if (element.kind === 'item def') score += 70;
  if (/system|vehicle|suv|ev|model|product|architecture|context|main|primary|hybrid/.test(name)) score += 30;
  if (/test|tmp|temp|example/.test(name)) score -= 10;
  return score;
}

function uniqueGeneratedViewName(content) {
  let name = 'autoPlantUMLView';
  let suffix = 2;
  while (new RegExp(`\\b${name}\\b`).test(content)) {
    name = `autoPlantUMLView${suffix}`;
    suffix += 1;
  }
  return name;
}

function dedupeElements(elements) {
  const seen = new Set();
  const out = [];
  for (const element of elements) {
    const key = element.qualifiedName || `${element.packageName || ''}::${element.name}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(element);
  }
  return out;
}

function stripSysmlComments(value) {
  return String(value || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function maskSysmlCommentsAndStrings(value) {
  const content = String(value || '');
  let output = '';
  let state = 'code';
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (state === 'code' && char === '/' && next === '/') {
      output += '  ';
      index += 1;
      state = 'line-comment';
    } else if (state === 'code' && char === '/' && next === '*') {
      output += '  ';
      index += 1;
      state = 'block-comment';
    } else if (state === 'code' && char === '"') {
      output += ' ';
      state = 'double-string';
    } else if (state === 'line-comment') {
      output += char === '\n' || char === '\r' ? char : ' ';
      if (char === '\n') state = 'code';
    } else if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 1;
        state = 'code';
      } else {
        output += char === '\n' || char === '\r' ? char : ' ';
      }
    } else if (state === 'double-string') {
      if (char === '\\' && next !== undefined) {
        output += '  ';
        index += 1;
      } else {
        output += char === '\n' || char === '\r' ? char : ' ';
        if (char === '"') state = 'code';
      }
    } else {
      output += char;
    }
  }
  return output;
}

function lastSegment(value) {
  const parts = String(value || '').split('::');
  return parts[parts.length - 1] || '';
}

function decodeSysmlQualifiedName(value) {
  const tokens = Array.from(String(value || '').matchAll(new RegExp(SYSML_NAME_SOURCE, 'g')));
  if (!tokens.length) return String(value || '').trim();
  return tokens.map((token) => decodeSysmlNameToken(token[0])).join('::');
}

function decodeSysmlNameToken(value) {
  const text = String(value || '').trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/\\(['\\])/g, '$1');
  }
  return text;
}

function sysmlNameReference(value) {
  return String(value || '').trim();
}

module.exports = {
  applyValidatorResourcePolicy,
  validatorResourcePolicyState,
  validateWorkspace,
  generatePlantUml,
  validatorHealth,
  SOURCE: OFFICIAL_SOURCE,
  OFFICIAL_SOURCE,
  LOCAL_ANALYZER_SOURCE,
  backend,
  validatorAdmission,
  outlineBackend,
  plantUmlBackend,
  _selectEntryFileViewName: selectEntryFileViewName,
  _preparePlantUmlSource: preparePlantUmlSource
};
