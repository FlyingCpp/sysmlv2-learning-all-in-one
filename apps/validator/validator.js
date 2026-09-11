'use strict';

const { validateWorkspace: analyzeWorkspace, SOURCE: LOCAL_ANALYZER_SOURCE } = require('./local-analyzer');
const { OfficialValidatorBackend, OFFICIAL_SOURCE, RELEASE_TAG, KERNEL_VERSION } = require('./official-backend');
const { OfficialOutlineBackend } = require('./official-outline-backend');
const {
  OfficialPlantUmlBackend,
  SysmlPlantUmlService,
  selectEntryFileViewName: selectExtractedPlantUmlViewName,
  preparePlantUmlSource: prepareExtractedPlantUmlSource
} = require('../../packages/sysml-plantuml-service');
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
const plantUmlService = new SysmlPlantUmlService({
  backend: plantUmlBackend,
  source: OFFICIAL_SOURCE,
  releaseTag: RELEASE_TAG,
  kernelVersion: KERNEL_VERSION,
  attestation: () => backend.artifactAttestation()
});
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
  return plantUmlService.render(input);
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
  _selectEntryFileViewName: selectExtractedPlantUmlViewName,
  _preparePlantUmlSource: prepareExtractedPlantUmlSource
};
