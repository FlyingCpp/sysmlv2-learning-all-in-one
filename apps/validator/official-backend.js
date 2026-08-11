'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OFFICIAL_SOURCE = 'official-sysml-v2-pilot-2026-04';
const RELEASE_TAG = process.env.SYSML_RELEASE_TAG || '2026-04';
const KERNEL_VERSION = process.env.SYSML_KERNEL_VERSION || '0.59.0';
const DEFAULT_ARTIFACT_MANIFEST_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'packages',
  'teacher-contract',
  'official-validator-runtime-artifacts.json'
);

class OfficialValidatorBackend {
  constructor(options = {}) {
    this.jarPath = options.jarPath || process.env.SYSML_OFFICIAL_JAR || null;
    this.libraryPath = options.libraryPath || process.env.SYSML_LIBRARY_PATH || null;
    this.classesPath = options.classesPath || process.env.SYSML_WRAPPER_CLASSES || path.join(__dirname, 'official', 'classes');
    this.javaBin = options.javaBin || process.env.JAVA_BIN || 'java';
    this.timeoutMs = strictPositiveInteger(
      options.timeoutMs
      ?? process.env.AI_TEACHER_VALIDATOR_EXECUTION_TIMEOUT_MS
      ?? process.env.OFFICIAL_VALIDATOR_TIMEOUT_MS
      ?? 25000,
      'AI_TEACHER_VALIDATOR_EXECUTION_TIMEOUT_MS'
    );
    this.enabled = options.enabled ?? process.env.OFFICIAL_VALIDATOR_ENABLED !== 'false';
    this.manifestPath = options.manifestPath || DEFAULT_ARTIFACT_MANIFEST_PATH;
    this.child = null;
    this.pending = [];
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.lastError = null;
    this.startedAt = null;
    this.stopping = false;
    this.artifactAttestationCache = null;
    this.artifactTrustCache = null;
  }

  isConfigured() {
    return Boolean(this.enabled && this.jarPath && this.libraryPath);
  }

  isAvailable() {
    return Boolean(
      this.isConfigured()
      && fs.existsSync(this.jarPath)
      && fs.existsSync(this.libraryPath)
      && fs.existsSync(this.classesPath)
      && this.artifactTrust().ok
    );
  }

  health() {
    const trust = this.artifactTrust();
    return {
      backend: 'official-sysml-v2-pilot',
      source: OFFICIAL_SOURCE,
      releaseTag: RELEASE_TAG,
      kernelVersion: KERNEL_VERSION,
      enabled: this.enabled,
      configured: this.isConfigured(),
      officialAvailable: this.isAvailable(),
      processStarted: Boolean(this.child),
      artifacts: this.artifactAttestation(),
      artifactTrusted: trust.ok,
      artifactTrustErrors: trust.errors,
      lastError: this.lastError ? 'official-validator-process-error' : null,
      timeoutMs: this.timeoutMs
    };
  }

  artifactAttestation() {
    if (this.artifactAttestationCache) return this.artifactAttestationCache;
    const attestation = {
      source: OFFICIAL_SOURCE,
      releaseTag: RELEASE_TAG,
      kernelVersion: KERNEL_VERSION,
      jarHash: hashPathSync(this.jarPath),
      libraryHash: hashPathSync(this.libraryPath),
      wrapperHash: hashPathSync(this.classesPath)
    };
    attestation.artifactHash = sha256(JSON.stringify(attestation));
    this.artifactAttestationCache = attestation;
    return attestation;
  }

  artifactTrust() {
    if (this.artifactTrustCache) return this.artifactTrustCache;
    const observed = this.artifactAttestation();
    let manifest;
    try {
      manifest = loadArtifactManifest(this.manifestPath);
    } catch {
      this.artifactTrustCache = {
        ok: false,
        attestation: observed,
        errors: ['trusted_manifest_unavailable']
      };
      return this.artifactTrustCache;
    }
    this.artifactTrustCache = verifyArtifactAttestation(observed, manifest);
    return this.artifactTrustCache;
  }

  async validate(content) {
    if (!this.isAvailable()) {
      const missing = [];
      if (!this.jarPath || !fs.existsSync(this.jarPath)) missing.push(`jar: ${this.jarPath || '<unset>'}`);
      if (!this.libraryPath || !fs.existsSync(this.libraryPath)) missing.push(`library: ${this.libraryPath || '<unset>'}`);
      if (!fs.existsSync(this.classesPath)) missing.push(`wrapper classes: ${this.classesPath}`);
      if (!this.artifactTrust().ok) missing.push('artifact trust verification failed');
      const error = new Error(`Official SysML v2 validator is not available (${missing.join(', ')})`);
      error.code = 'OFFICIAL_VALIDATOR_UNAVAILABLE';
      throw error;
    }

    this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Official SysML v2 validator timed out after ${this.timeoutMs} ms`);
        error.code = 'OFFICIAL_VALIDATOR_TIMEOUT';
        reject(error);
        this.restart();
      }, this.timeoutMs);

      this.pending.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });

      this.child.stdin.write(`${Buffer.from(content, 'utf8').toString('base64')}\n`, 'utf8', (error) => {
        if (error) {
          const pending = this.pending.pop();
          if (pending) pending.reject(error);
        }
      });
    });
  }

  start() {
    if (this.child) return;

    const javaOptions = splitArgs(process.env.OFFICIAL_VALIDATOR_JAVA_OPTS || '-Xmx2g');
    const classPath = [this.jarPath, this.classesPath].join(path.delimiter);
    const args = [
      ...javaOptions,
      '-cp',
      classPath,
      'org.sysmlv2.learning.validator.OfficialValidatorCli',
      '--library',
      this.libraryPath
    ];

    const child = spawn(this.javaBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.startedAt = new Date().toISOString();
    this.lastError = null;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
    });
    child.stdin.on('error', (error) => {
      this.lastError = error.message;
      this.rejectAll(error);
      if (this.child === child) {
        this.child = null;
        child.kill();
      }
    });
    child.on('error', (error) => {
      this.lastError = error.message;
      this.rejectAll(error);
      if (this.child === child) this.child = null;
    });
    child.on('exit', (code, signal) => {
      if (!this.stopping) {
        const error = new Error(`Official SysML v2 validator exited with code ${code}, signal ${signal}`);
        this.lastError = error.message;
        this.rejectAll(error);
      }
      if (this.child === child) this.child = null;
    });
  }

  restart() {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  stop() {
    if (!this.child) return Promise.resolve();
    const child = this.child;
    this.stopping = true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.child === child) child.kill();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        this.stopping = false;
        resolve();
      });
      child.stdin.end();
    });
  }

  onStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.resolveLine(line);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  resolveLine(line) {
    const pending = this.pending.shift();
    if (!pending) return;
    try {
      const result = JSON.parse(line);
      pending.resolve(result);
    } catch (error) {
      error.message = `Invalid official validator response: ${error.message}. Response: ${line.slice(0, 500)}`;
      pending.reject(error);
    }
  }

  rejectAll(error) {
    while (this.pending.length) {
      this.pending.shift().reject(error);
    }
  }
}

function loadArtifactManifest(manifestPath = DEFAULT_ARTIFACT_MANIFEST_PATH) {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Official Validator artifact manifest must be an object.');
  }
  return parsed;
}

function manifestAttestation(manifest) {
  return {
    source: manifest.source,
    releaseTag: manifest.releaseTag,
    kernelVersion: manifest.kernelVersion,
    jarHash: manifest.components?.jarHash,
    libraryHash: manifest.components?.libraryHash,
    wrapperHash: manifest.components?.wrapperHash
  };
}

function verifyArtifactAttestation(observed, manifest) {
  const errors = [];
  if (manifest.schemaVersion !== 'official-validator-artifact-manifest/v1') {
    errors.push('trusted_manifest_schema_mismatch');
  }
  const expected = manifestAttestation(manifest);
  for (const field of ['jarHash', 'libraryHash', 'wrapperHash']) {
    if (!/^sha256:[a-f0-9]{64}$/.test(String(expected[field] || ''))) {
      errors.push(`trusted_manifest_${field}_invalid`);
    }
  }
  const expectedArtifactHash = sha256(JSON.stringify(expected));
  if (manifest.artifactHash !== expectedArtifactHash) {
    errors.push('trusted_manifest_artifact_hash_mismatch');
  }
  for (const field of ['source', 'releaseTag', 'kernelVersion', 'jarHash', 'libraryHash', 'wrapperHash']) {
    if (observed[field] !== expected[field]) errors.push(`observed_${field}_mismatch`);
  }
  if (observed.artifactHash !== manifest.artifactHash) {
    errors.push('observed_artifact_hash_mismatch');
  }
  return {
    ok: errors.length === 0,
    attestation: observed,
    errors
  };
}

function hashPathSync(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return '';
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return hashFileSync(targetPath);
  if (!stat.isDirectory()) return '';
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  visit(targetPath);
  const manifest = files.sort().map((file) => ({
    path: path.relative(targetPath, file).replace(/\\/g, '/'),
    hash: hashFileSync(file)
  }));
  return sha256(JSON.stringify(manifest));
}

function hashFileSync(filePath) {
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) digest.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${digest.digest('hex')}`;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
}

function splitArgs(value) {
  return String(value || '').match(/(?:[^\s"]+|"[^"]*")+/g)?.map((arg) => arg.replace(/^"|"$/g, '')) || [];
}

function strictPositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > 300000) {
    throw new RangeError(`${name} must be an integer between 1 and 300000.`);
  }
  return number;
}

module.exports = {
  OfficialValidatorBackend,
  OFFICIAL_SOURCE,
  RELEASE_TAG,
  KERNEL_VERSION,
  DEFAULT_ARTIFACT_MANIFEST_PATH,
  hashFileSync,
  hashPathSync,
  loadArtifactManifest,
  manifestAttestation,
  verifyArtifactAttestation
};
