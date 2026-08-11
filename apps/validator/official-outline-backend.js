'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { OFFICIAL_SOURCE, RELEASE_TAG, KERNEL_VERSION } = require('./official-backend');

class OfficialOutlineBackend {
  constructor(options = {}) {
    this.jarPath = options.jarPath || process.env.SYSML_OFFICIAL_JAR || null;
    this.libraryPath = options.libraryPath || process.env.SYSML_LIBRARY_PATH || null;
    this.classesPath = options.classesPath || process.env.SYSML_WRAPPER_CLASSES || path.join(__dirname, 'official', 'classes');
    this.javaBin = options.javaBin || process.env.JAVA_BIN || 'java';
    this.timeoutMs = Number(options.timeoutMs || process.env.OFFICIAL_VALIDATOR_TIMEOUT_MS || 300000);
    this.enabled = options.enabled ?? process.env.OFFICIAL_VALIDATOR_ENABLED !== 'false';
    this.child = null;
    this.pending = [];
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.lastError = null;
    this.startedAt = null;
    this.stopping = false;
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
    );
  }

  health() {
    return {
      backend: 'official-sysml-v2-pilot-outline',
      source: OFFICIAL_SOURCE,
      releaseTag: RELEASE_TAG,
      kernelVersion: KERNEL_VERSION,
      enabled: this.enabled,
      configured: this.isConfigured(),
      officialAvailable: this.isAvailable(),
      processStarted: Boolean(this.child),
      jarPath: this.jarPath,
      libraryPath: this.libraryPath,
      wrapperClassesPath: this.classesPath,
      lastError: this.lastError,
      stderrTail: this.stderrTail || null,
      timeoutMs: this.timeoutMs
    };
  }

  async outline(content) {
    if (!this.isAvailable()) {
      const missing = [];
      if (!this.jarPath || !fs.existsSync(this.jarPath)) missing.push(`jar: ${this.jarPath || '<unset>'}`);
      if (!this.libraryPath || !fs.existsSync(this.libraryPath)) missing.push(`library: ${this.libraryPath || '<unset>'}`);
      if (!fs.existsSync(this.classesPath)) missing.push(`wrapper classes: ${this.classesPath}`);
      const error = new Error(`Official SysML v2 semantic outline is not available (${missing.join(', ')})`);
      error.code = 'OFFICIAL_OUTLINE_UNAVAILABLE';
      throw error;
    }

    this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Official SysML v2 semantic outline timed out after ${this.timeoutMs} ms`);
        error.code = 'OFFICIAL_OUTLINE_TIMEOUT';
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
      'org.sysmlv2.learning.validator.OfficialOutlineCli',
      '--library',
      this.libraryPath
    ];

    this.child = spawn(this.javaBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.startedAt = new Date().toISOString();
    this.lastError = null;

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
    });
    this.child.on('error', (error) => {
      this.lastError = error.message;
      this.rejectAll(error);
      this.child = null;
    });
    this.child.on('exit', (code, signal) => {
      if (!this.stopping) {
        const error = new Error(`Official SysML v2 semantic outline exited with code ${code}, signal ${signal}`);
        this.lastError = error.message;
        this.rejectAll(error);
      }
      this.child = null;
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
      error.message = `Invalid official outline response: ${error.message}. Response: ${line.slice(0, 500)}`;
      pending.reject(error);
    }
  }

  rejectAll(error) {
    while (this.pending.length) {
      this.pending.shift().reject(error);
    }
  }
}

function splitArgs(value) {
  return String(value || '').match(/(?:[^\s"]+|"[^"]*")+/g)?.map((arg) => arg.replace(/^"|"$/g, '')) || [];
}

module.exports = {
  OfficialOutlineBackend
};
