import type { WorkspaceFile } from './types';

const ON_IMPORT = 'on-import';
const SYSML_NAME_SOURCE = String.raw`'(?:\\.|[^'\\\r\n])+'|[A-Za-z_][\w]*`;
const PACKAGE_PATTERN = new RegExp(String.raw`\bpackage\s+(${SYSML_NAME_SOURCE})\s*\{`, 'g');
const IMPORT_PATTERN = new RegExp(String.raw`\bimport\s+(${SYSML_NAME_SOURCE})`, 'g');
const QUALIFIED_REFERENCE_PATTERN = new RegExp(String.raw`(?:^|[^A-Za-z0-9_'])(${SYSML_NAME_SOURCE})\s*::`, 'g');

export function cloneWorkspaceFiles(workspace?: { files?: WorkspaceFile[] } | null): WorkspaceFile[] {
  return (workspace?.files || []).map((file) => ({
    path: file.path,
    content: file.content || '',
    editable: file.editable !== false,
    source: file.source || (file.editable === false ? 'reference' : 'workspace'),
    loadPolicy: file.loadPolicy || 'always'
  }));
}

export function workspaceTemplateSignature(files: readonly WorkspaceFile[] = [], entryFile = ''): string {
  const normalized = {
    entryFile: entryFile || '',
    files: files
      .map((file) => ({
        path: file.path || '',
        content: file.content || '',
        editable: file.editable !== false,
        loadPolicy: file.loadPolicy || 'always'
      }))
      .sort((left, right) => left.path.localeCompare(right.path))
  };
  let hash = 2166136261;
  const text = JSON.stringify(normalized);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function resolveWorkspaceImportClosure(
  files: readonly WorkspaceFile[] = [],
  entryFile = '',
  includePaths: readonly string[] = []
): WorkspaceFile[] {
  const normalized = files.map((file, index) => ({
    ...file,
    path: String(file.path || `file-${index + 1}.sysml`),
    content: String(file.content || '').replace(/^\uFEFF/, ''),
    loadPolicy: file.loadPolicy === ON_IMPORT ? ON_IMPORT : (file.loadPolicy || 'always')
  }));
  if (!normalized.some((file) => file.loadPolicy === ON_IMPORT)) return normalized;

  const providers = new Map<string, number[]>();
  normalized.forEach((file, index) => {
    if (file.loadPolicy !== ON_IMPORT) return;
    for (const packageName of extractDeclaredRootPackages(file.content)) {
      providers.set(packageName, [...(providers.get(packageName) || []), index]);
    }
  });

  const explicitlyIncluded = new Set([entryFile, ...includePaths].filter(Boolean));
  const included = new Set<number>();
  const queue: number[] = [];
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
    if (currentIndex === undefined) break;
    for (const dependencyRoot of extractDependencyRoots(normalized[currentIndex].content)) {
      for (const providerIndex of providers.get(dependencyRoot) || []) {
        if (included.has(providerIndex)) continue;
        included.add(providerIndex);
        queue.push(providerIndex);
      }
    }
  }
  return normalized.filter((_file, index) => included.has(index));
}

function extractDeclaredRootPackages(content: string): string[] {
  return extractSysmlNames(content, PACKAGE_PATTERN);
}

function extractImportRoots(content: string): string[] {
  return extractSysmlNames(content, IMPORT_PATTERN);
}

function extractQualifiedReferenceRoots(content: string): string[] {
  return extractSysmlNames(content, QUALIFIED_REFERENCE_PATTERN);
}

function extractDependencyRoots(content: string): string[] {
  return [...new Set([...extractImportRoots(content), ...extractQualifiedReferenceRoots(content)])];
}

function extractSysmlNames(content: string, pattern: RegExp): string[] {
  const source = maskCommentsAndDoubleQuotedStrings(content);
  const names: string[] = [];
  pattern.lastIndex = 0;
  let match = pattern.exec(source);
  while (match) {
    names.push(decodeSysmlName(match[1]));
    match = pattern.exec(source);
  }
  return [...new Set(names)];
}

function maskCommentsAndDoubleQuotedStrings(value: string): string {
  const source = String(value || '');
  let output = '';
  let index = 0;
  let state: 'code' | 'line-comment' | 'block-comment' | 'double-string' = 'code';
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'code' && char === '/' && next === '/') {
      output += '  ';
      index += 2;
      state = 'line-comment';
    } else if (state === 'code' && char === '/' && next === '*') {
      output += '  ';
      index += 2;
      state = 'block-comment';
    } else if (state === 'code' && char === '"') {
      output += ' ';
      index += 1;
      state = 'double-string';
    } else if (state === 'line-comment') {
      output += char === '\n' || char === '\r' ? char : ' ';
      index += 1;
      if (char === '\n') state = 'code';
    } else if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 2;
        state = 'code';
      } else {
        output += char === '\n' || char === '\r' ? char : ' ';
        index += 1;
      }
    } else if (state === 'double-string') {
      if (char === '\\' && next !== undefined) {
        output += '  ';
        index += 2;
      } else {
        output += char === '\n' || char === '\r' ? char : ' ';
        index += 1;
        if (char === '"') state = 'code';
      }
    } else {
      output += char;
      index += 1;
    }
  }
  return output;
}

function decodeSysmlName(token: string): string {
  const value = String(token || '');
  if (!value.startsWith("'") || !value.endsWith("'")) return value;
  return value.slice(1, -1).replace(/\\(.)/g, '$1');
}
