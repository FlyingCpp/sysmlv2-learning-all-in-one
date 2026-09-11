'use strict';

const SYSML_NAME_SOURCE = String.raw`'(?:\\.|[^'\\\r\n])+'|[A-Za-z_][\w]*`;
const SYSML_QUALIFIED_NAME_SOURCE = String.raw`(?:${SYSML_NAME_SOURCE})(?:::(?:${SYSML_NAME_SOURCE}))*`;
const SYSML_SHORT_NAME_SOURCE = String.raw`[A-Za-z_][\w]*`;
const SYSML_IDENTIFICATION_SOURCE = String.raw`(?:<(${SYSML_SHORT_NAME_SOURCE})>(?:\s*(${SYSML_NAME_SOURCE}))?|(${SYSML_NAME_SOURCE}))`;

function normalizeFiles(input) {
  if (Array.isArray(input?.files) && input.files.length > 0) {
    return input.files.map((file, index) => ({
      path: String(file?.path || `file-${index + 1}.sysml`),
      content: stripUtf8Bom(file?.content),
      loadPolicy: file?.loadPolicy || 'always'
    }));
  }
  return [{
    path: String(input?.path || 'main.sysml'),
    content: stripUtf8Bom(input?.content),
    loadPolicy: 'always'
  }];
}

function combineFiles(files) {
  return files.map((file) => `// file: ${file.path}\n${file.content}`).join('\n\n');
}

function discoverViews(input) {
  const files = normalizeFiles(input);
  const views = [];
  for (const file of files) {
    const content = maskSysmlCommentsAndStrings(file.content);
    const packageOpenings = new Map();
    const packagePattern = new RegExp(String.raw`\bpackage\s+${SYSML_IDENTIFICATION_SOURCE}\s*\{`, 'g');
    for (const match of content.matchAll(packagePattern)) {
      packageOpenings.set(
        match.index + match[0].lastIndexOf('{'),
        identificationReference(match[1], match[2], match[3], { preferShort: true })
      );
    }
    const viewsByOffset = new Map();
    const viewPattern = new RegExp(String.raw`(?:^|[;{}\r\n])\s*view\s+(?!def\b)${SYSML_IDENTIFICATION_SOURCE}\s*(?::[^;{\r\n]+)?\s*(?:\{|;)`, 'gm');
    for (const match of content.matchAll(viewPattern)) {
      const offset = match.index + match[0].lastIndexOf('view');
      const viewReference = identificationReference(match[1], match[2], match[3]);
      viewsByOffset.set(offset, [...(viewsByOffset.get(offset) || []), viewReference]);
    }
    let depth = 0;
    const packageScopes = [];
    for (let offset = 0; offset < content.length; offset += 1) {
      for (const viewToken of viewsByOffset.get(offset) || []) {
        const packageName = packageScopes.map((scope) => scope.token).join('::');
        views.push({
          name: decodeSysmlNameToken(viewToken),
          qualifiedName: packageName ? `${packageName}::${viewToken}` : viewToken,
          sourcePath: file.path,
          offset
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
  }
  const seen = new Set();
  return views.filter((view) => {
    const key = `${view.sourcePath}\0${view.qualifiedName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectEntryFileViewName(files, entryFile) {
  const normalized = normalizeFiles({ files });
  const entry = String(entryFile || '').trim();
  const file = normalized.find((candidate) => candidate.path === entry) || normalized[0];
  const views = discoverViews({ files: file ? [file] : normalized });
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
  const normalized = normalizeFiles({ files });
  const originalContent = combineFiles(normalized);
  const entryViewName = requestedViewName || selectEntryFileViewName(normalized, entryFile);
  if (entryViewName) {
    return { content: originalContent, viewName: entryViewName, generatedView: null };
  }
  const generatedView = buildGeneratedPlantUmlView(normalized, entryFile);
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
  const normalized = normalizeFiles({ files });
  const entry = normalized.find((file) => file.path === entryFile) || normalized[0];
  const entryElements = entry ? collectRenderableElements([entry]) : [];
  const elements = entryElements.length ? entryElements : collectRenderableElements(normalized);
  const selected = selectGeneratedViewExposes(elements);
  if (!selected.length) return null;
  const content = combineFiles(normalized);
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
    entryFile: entryFile || normalized[0]?.path || 'main.sysml',
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
    const content = stripSysmlComments(file.content);
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
  const regex = new RegExp(String.raw`\bpackage\s+${SYSML_IDENTIFICATION_SOURCE}\s*\{`, 'g');
  let match;
  while ((match = regex.exec(content))) {
    const openIndex = content.indexOf('{', match.index);
    const closeIndex = findMatchingBrace(content, openIndex);
    if (closeIndex < 0) continue;
    const packageReference = identificationReference(match[1], match[2], match[3], { preferShort: true });
    packages.push({
      name: decodeSysmlNameToken(packageReference),
      nameRef: sysmlNameReference(packageReference),
      body: content.slice(openIndex + 1, closeIndex)
    });
    regex.lastIndex = closeIndex + 1;
  }
  return packages;
}

function findMatchingBrace(content, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < content.length; index += 1) {
    if (content[index] === '{') depth += 1;
    if (content[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function collectTopLevelDeclarations(content, packageName, filePath, packageNameRef = '') {
  const declarations = [];
  for (const statement of topLevelStatements(content)) {
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
  for (const char of content) {
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
  if (!usage || usage[2] === 'def') return null;
  return {
    kind: usage[1] === 'calc' ? 'calculation' : usage[1],
    name: decodeSysmlNameToken(usage[2]),
    nameRef: sysmlNameReference(usage[2]),
    typeName: usage[3] ? decodeSysmlQualifiedName(usage[3].replace(/^~/, '')) : null,
    specializes: null,
    isDefinition: false
  };
}

function selectGeneratedViewExposes(elements) {
  const definitions = elements.filter((element) => element.isDefinition);
  const usages = elements.filter((element) => !element.isDefinition)
    .sort((left, right) => elementRank(right) - elementRank(left))
    .slice(0, 4);
  const selected = [];
  for (const usage of usages) {
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
  return elements.filter((element) => {
    const key = element.qualifiedName || `${element.packageName || ''}::${element.name}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stripUtf8Bom(value) {
  return String(value || '').replace(/^\uFEFF/, '');
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
  return String(value || '').split('::').at(-1) || '';
}

function decodeSysmlQualifiedName(value) {
  const tokens = Array.from(String(value || '').matchAll(new RegExp(SYSML_NAME_SOURCE, 'g')));
  return tokens.length
    ? tokens.map((token) => decodeSysmlNameToken(token[0])).join('::')
    : String(value || '').trim();
}

function decodeSysmlNameToken(value) {
  const text = String(value || '').trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/\\(['\\])/g, '$1');
  }
  return text;
}

function identificationReference(shortToken, longToken, plainToken, { preferShort = false } = {}) {
  if (preferShort && shortToken) return shortToken;
  return longToken || plainToken || shortToken || '';
}

function sysmlNameReference(value) {
  return String(value || '').trim();
}

module.exports = {
  buildGeneratedPlantUmlView,
  combineFiles,
  discoverViews,
  normalizeFiles,
  preparePlantUmlSource,
  selectEntryFileViewName
};
