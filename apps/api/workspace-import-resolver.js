'use strict';

const ON_IMPORT = 'on-import';
const SYSML_NAME_SOURCE = String.raw`'(?:\\.|[^'\\\r\n])+'|[A-Za-z_][\w]*`;
const PACKAGE_PATTERN = new RegExp(String.raw`\bpackage\s+(${SYSML_NAME_SOURCE})\s*\{`, 'g');
const IMPORT_PATTERN = new RegExp(String.raw`\bimport\s+(${SYSML_NAME_SOURCE})`, 'g');
const QUALIFIED_REFERENCE_PATTERN = new RegExp(String.raw`(?:^|[^A-Za-z0-9_'])(${SYSML_NAME_SOURCE})\s*::`, 'g');

/**
 * Resolve the SysML files that form the validation/rendering workspace.
 *
 * Files with loadPolicy="on-import" are course-provided model resources. They
 * are excluded by default and are added only when an already included file
 * imports or explicitly qualifies a root package that they declare. Imports
 * and qualified cross-package references found in newly included resources
 * are followed transitively. Other files remain always loaded for backwards
 * compatibility with existing course packs.
 */
function resolveWorkspaceImportClosure(files, options = {}) {
  const normalized = normalizeWorkspaceFiles(files);
  if (!normalized.some((file) => file.loadPolicy === ON_IMPORT)) return normalized;

  const entryFile = String(options.entryFile || '').trim();
  const providers = buildPackageProviderIndex(normalized);
  const included = new Set();
  const queue = [];
  const explicitlyIncluded = new Set([
    entryFile,
    ...(Array.isArray(options.includePaths) ? options.includePaths : [])
  ].filter(Boolean).map((value) => String(value)));

  normalized.forEach((file, index) => {
    if (file.loadPolicy !== ON_IMPORT || explicitlyIncluded.has(file.path)) {
      included.add(index);
      queue.push(index);
    }
  });

  if (!included.size && normalized.length) {
    const entryIndex = normalized.findIndex((file) => file.path === entryFile);
    const seedIndex = entryIndex >= 0 ? entryIndex : 0;
    included.add(seedIndex);
    queue.push(seedIndex);
  }

  while (queue.length) {
    const currentIndex = queue.shift();
    for (const dependencyRoot of extractDependencyRoots(normalized[currentIndex].content)) {
      for (const providerIndex of providers.get(dependencyRoot) || []) {
        if (included.has(providerIndex)) continue;
        included.add(providerIndex);
        queue.push(providerIndex);
      }
    }
  }

  return normalized.filter((file, index) => included.has(index));
}

function normalizeWorkspaceFiles(files) {
  return (Array.isArray(files) ? files : []).map((file, index) => ({
    ...file,
    path: String(file?.path || `file-${index + 1}.sysml`),
    content: stripUtf8Bom(file?.content),
    loadPolicy: file?.loadPolicy === ON_IMPORT ? ON_IMPORT : (file?.loadPolicy || 'always')
  }));
}

function buildPackageProviderIndex(files) {
  const providers = new Map();
  files.forEach((file, index) => {
    if (file.loadPolicy !== ON_IMPORT) return;
    for (const packageName of extractDeclaredRootPackages(file.content)) {
      const indexes = providers.get(packageName) || [];
      indexes.push(index);
      providers.set(packageName, indexes);
    }
  });
  return providers;
}

function extractDeclaredRootPackages(content) {
  const source = maskCommentsAndDoubleQuotedStrings(content);
  const names = [];
  PACKAGE_PATTERN.lastIndex = 0;
  let match;
  while ((match = PACKAGE_PATTERN.exec(source))) names.push(decodeSysmlName(match[1]));
  return [...new Set(names)];
}

function extractImportRoots(content) {
  const source = maskCommentsAndDoubleQuotedStrings(content);
  const names = [];
  IMPORT_PATTERN.lastIndex = 0;
  let match;
  while ((match = IMPORT_PATTERN.exec(source))) names.push(decodeSysmlName(match[1]));
  return [...new Set(names)];
}

function extractQualifiedReferenceRoots(content) {
  const source = maskCommentsAndDoubleQuotedStrings(content);
  const names = [];
  QUALIFIED_REFERENCE_PATTERN.lastIndex = 0;
  let match;
  while ((match = QUALIFIED_REFERENCE_PATTERN.exec(source))) names.push(decodeSysmlName(match[1]));
  return [...new Set(names)];
}

function extractDependencyRoots(content) {
  return [...new Set([...extractImportRoots(content), ...extractQualifiedReferenceRoots(content)])];
}

function maskCommentsAndDoubleQuotedStrings(value) {
  const source = String(value || '');
  let output = '';
  let index = 0;
  let state = 'code';
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'code' && char === '/' && next === '/') {
      output += '  ';
      index += 2;
      state = 'line-comment';
      continue;
    }
    if (state === 'code' && char === '/' && next === '*') {
      output += '  ';
      index += 2;
      state = 'block-comment';
      continue;
    }
    if (state === 'code' && char === '"') {
      output += ' ';
      index += 1;
      state = 'double-string';
      continue;
    }
    if (state === 'line-comment') {
      output += char === '\n' || char === '\r' ? char : ' ';
      index += 1;
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 2;
        state = 'code';
      } else {
        output += char === '\n' || char === '\r' ? char : ' ';
        index += 1;
      }
      continue;
    }
    if (state === 'double-string') {
      if (char === '\\' && next !== undefined) {
        output += '  ';
        index += 2;
      } else {
        output += char === '\n' || char === '\r' ? char : ' ';
        index += 1;
        if (char === '"') state = 'code';
      }
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function decodeSysmlName(token) {
  const value = String(token || '');
  if (!value.startsWith("'") || !value.endsWith("'")) return value;
  return value.slice(1, -1).replace(/\\(.)/g, '$1');
}

function stripUtf8Bom(value) {
  return String(value || '').replace(/^\uFEFF/, '');
}

module.exports = {
  ON_IMPORT,
  extractDeclaredRootPackages,
  extractDependencyRoots,
  extractImportRoots,
  extractQualifiedReferenceRoots,
  resolveWorkspaceImportClosure
};
