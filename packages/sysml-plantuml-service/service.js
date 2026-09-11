'use strict';

const { OfficialPlantUmlBackend } = require('./official-plantuml-backend');
const { optimizePlantUmlLayout, checkRenderResult } = require('./plantuml-layout-optimizer');
const { normalizeFiles, preparePlantUmlSource, selectEntryFileViewName } = require('./source');
const { OFFICIAL_SOURCE, RELEASE_TAG, KERNEL_VERSION } = require('./runtime-metadata');

class SysmlPlantUmlService {
  constructor(options = {}) {
    this.backend = options.backend || new OfficialPlantUmlBackend(options);
    this.metadata = {
      source: options.source || OFFICIAL_SOURCE,
      releaseTag: options.releaseTag || RELEASE_TAG,
      kernelVersion: options.kernelVersion || KERNEL_VERSION
    };
    this.attestation = typeof options.attestation === 'function' ? options.attestation : null;
  }

  health() {
    return this.backend.health();
  }

  async render(input = {}) {
    const files = normalizeFiles(input);
    const requestedViewName = String(input.viewName || '').trim()
      || selectEntryFileViewName(files, input.entryFile);
    const prepared = preparePlantUmlSource(files, {
      entryFile: input.entryFile,
      requestedViewName
    });
    const content = prepared.content;
    const viewName = requestedViewName || prepared.viewName;
    const renderMode = input.renderMode || '';
    const requestedStyles = Array.isArray(input.styles) ? input.styles : [];
    const optimizationMode = input.layoutOptimization?.mode === 'off' ? 'off' : 'auto';
    const result = checkRenderResult(optimizationMode === 'off'
      ? await this.backend.generate({ content, viewName, renderMode, styles: requestedStyles.length ? requestedStyles : ['DEFAULT'] })
      : await optimizePlantUmlLayout({
        content,
        viewName,
        renderMode,
        deadlineAt: Date.now() + (this.backend.timeoutMs || 120000),
        renderScene: (scene, timeoutMs) => this.backend.renderScene(scene, timeoutMs),
        renderCandidate: (styles) => this.backend.generate({ content, viewName, renderMode, styles, projectLayout: true })
      }));
    return {
      ...result,
      source: result.source || this.metadata.source,
      backend: result.backend || 'official-sysml-v2-pilot-plantuml',
      releaseTag: this.metadata.releaseTag,
      kernelVersion: this.metadata.kernelVersion,
      ...(this.attestation ? { validatorAttestation: this.attestation() } : {}),
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

  stop() {
    return this.backend.stop();
  }
}

module.exports = { SysmlPlantUmlService };
