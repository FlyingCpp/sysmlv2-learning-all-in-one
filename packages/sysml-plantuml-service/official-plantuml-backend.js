'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { OFFICIAL_SOURCE, RELEASE_TAG, KERNEL_VERSION } = require('./runtime-metadata');

class OfficialPlantUmlBackend {
  constructor(options = {}) {
    this.jarPath = options.jarPath || process.env.SYSML_OFFICIAL_JAR || null;
    this.libraryPath = options.libraryPath || process.env.SYSML_LIBRARY_PATH || null;
    this.classesPath = options.classesPath || process.env.SYSML_PLANTUML_WRAPPER_CLASSES || process.env.SYSML_WRAPPER_CLASSES || path.join(__dirname, 'official', 'classes');
    this.dotPath = options.dotPath || process.env.GRAPHVIZ_DOT || (process.platform === 'win32' ? '' : '/usr/bin/dot');
    this.javaBin = options.javaBin || process.env.JAVA_BIN || 'java';
    this.timeoutMs = Number(options.timeoutMs || process.env.OFFICIAL_PLANTUML_TIMEOUT_MS || 120000);
    this.enabled = options.enabled ?? process.env.OFFICIAL_PLANTUML_ENABLED !== 'false';
    this.isolateRequests = options.isolateRequests
      ?? process.env.OFFICIAL_PLANTUML_ISOLATE_REQUESTS !== 'false';
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
      backend: 'official-sysml-v2-pilot-plantuml',
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
      graphVizDot: this.dotPath,
      graphVizAvailable: Boolean(this.dotPath && fs.existsSync(this.dotPath)),
      requestIsolation: this.isolateRequests ? 'fresh-jvm' : 'shared-jvm',
      lastError: this.lastError,
      stderrTail: this.stderrTail || null,
      timeoutMs: this.timeoutMs
    };
  }

  async generate({ content, viewName = '', renderMode = '', styles = [], projectLayout = false, command = '', timeoutMs = this.timeoutMs } = {}) {
    const budgetMs = Math.min(this.timeoutMs, timeoutMs);
    if (budgetMs <= 0) throw Object.assign(new Error('本次渲染预算已用尽。'), { code: 'OFFICIAL_PLANTUML_TIMEOUT' });
    if (!this.isAvailable()) {
      const missing = [];
      if (!this.jarPath || !fs.existsSync(this.jarPath)) missing.push(`jar: ${this.jarPath || '<unset>'}`);
      if (!this.libraryPath || !fs.existsSync(this.libraryPath)) missing.push(`library: ${this.libraryPath || '<unset>'}`);
      if (!fs.existsSync(this.classesPath)) missing.push(`wrapper classes: ${this.classesPath}`);
      const error = new Error(`Official SysML v2 PlantUML renderer is not available (${missing.join(', ')})`);
      error.code = 'OFFICIAL_PLANTUML_UNAVAILABLE';
      throw error;
    }

    const requestLine = this.requestLine({ content, viewName, renderMode, styles, projectLayout, command });
    if (this.isolateRequests) return this.generateIsolated(requestLine, budgetMs);

    this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Official SysML v2 PlantUML renderer timed out after ${this.timeoutMs} ms`);
        error.code = 'OFFICIAL_PLANTUML_TIMEOUT';
        reject(error);
        this.restart();
      }, budgetMs);

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

      this.child.stdin.write(requestLine, 'utf8', (error) => {
        if (error) {
          const pending = this.pending.pop();
          if (pending) pending.reject(error);
        }
      });
    });
  }

  generateIsolated(requestLine, budgetMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.javaBin, this.commandArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdoutBuffer = '';
      let stderrTail = '';
      let settled = false;
      this.startedAt = new Date().toISOString();
      this.lastError = null;

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.stderrTail = stderrTail;
        callback(value);
      };
      const timer = setTimeout(() => {
        const error = new Error(`Official SysML v2 PlantUML renderer timed out after ${this.timeoutMs} ms`);
        error.code = 'OFFICIAL_PLANTUML_TIMEOUT';
        this.lastError = error.message;
        child.kill();
        finish(reject, error);
      }, budgetMs);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk;
        const newlineIndex = stdoutBuffer.indexOf('\n');
        if (newlineIndex < 0) return;
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        if (!line) return;
        try {
          finish(resolve, JSON.parse(line));
        } catch (error) {
          error.message = `Invalid official PlantUML response: ${error.message}. Response: ${line.slice(0, 500)}`;
          this.lastError = error.message;
          finish(reject, error);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-4000);
      });
      child.on('error', (error) => {
        this.lastError = error.message;
        finish(reject, error);
      });
      child.on('exit', (code, signal) => {
        if (settled) return;
        const error = new Error(
          `Official SysML v2 PlantUML renderer exited with code ${code}, signal ${signal}`
        );
        this.lastError = error.message;
        finish(reject, error);
      });
      child.stdin.end(requestLine, 'utf8');
    });
  }

  renderScene(scene, timeoutMs) {
    return this.generate({ content: JSON.stringify(scene), command: 'DRAW_SCENE', timeoutMs });
  }

  requestLine({ content = '', viewName = '', renderMode = '', styles = [], projectLayout = false, command = '' } = {}) {
    const fields = [
      content,
      viewName,
      renderMode,
      Array.isArray(styles) ? styles.join(',') : String(styles || ''),
      String(projectLayout),
      command
    ].map((value) => Buffer.from(String(value), 'utf8').toString('base64'));
    return `${fields.join('\t')}\n`;
  }

  commandArgs() {
    const javaOptions = splitArgs(process.env.OFFICIAL_PLANTUML_JAVA_OPTS || process.env.OFFICIAL_VALIDATOR_JAVA_OPTS || '-Xmx2g');
    const classPath = [this.jarPath, this.classesPath].join(path.delimiter);
    const args = [
      ...javaOptions,
      '-cp',
      classPath,
      'org.sysmlv2.learning.validator.OfficialPlantUmlCli',
      '--library',
      this.libraryPath
    ];
    if (this.dotPath) args.push('--dot', this.dotPath);
    return args;
  }

  start() {
    if (this.child) return;

    this.child = spawn(this.javaBin, this.commandArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
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
        const error = new Error(`Official SysML v2 PlantUML renderer exited with code ${code}, signal ${signal}`);
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
      error.message = `Invalid official PlantUML response: ${error.message}. Response: ${line.slice(0, 500)}`;
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

module.exports = { OfficialPlantUmlBackend };
