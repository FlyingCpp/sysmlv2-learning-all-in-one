'use strict';

const crypto = require('node:crypto');

const DEFAULT_INVENTORY_ID = 'sysml-2.0-pilot-2026-04';

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

function normalizeSourcePath(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en', {
    sensitivity: 'variant',
    numeric: true,
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort(compareText)
      .reduce((result, key) => {
        if (value[key] !== undefined) {
          result[key] = canonicalize(value[key]);
        }
        return result;
      }, {});
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('Canonical JSON does not support non-finite numbers.');
  }
  return value;
}

function canonicalStringify(value, spacing = 0) {
  return JSON.stringify(canonicalize(value), null, spacing);
}

function createLineLocator(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }

  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle] <= offset) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return high + 1;
  };
}

function maskComments(text) {
  const output = [...text];
  let state = 'normal';

  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];

    if (state === 'line-comment') {
      if (current === '\n') {
        state = 'normal';
      } else {
        output[index] = ' ';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        output[index] = ' ';
        output[index + 1] = ' ';
        index += 1;
        state = 'normal';
      } else if (current !== '\n') {
        output[index] = ' ';
      }
      continue;
    }

    if (state === 'single-quote' || state === 'double-quote') {
      const quote = state === 'single-quote' ? "'" : '"';
      if (current === '\\') {
        index += 1;
      } else if (current === quote) {
        state = 'normal';
      }
      continue;
    }

    if (current === '/' && next === '/') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      state = 'line-comment';
    } else if (current === '/' && next === '*') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      state = 'block-comment';
    } else if (current === "'") {
      state = 'single-quote';
    } else if (current === '"') {
      state = 'double-quote';
    }
  }

  return output.join('');
}

function findRuleTerminator(text, startOffset) {
  let state = 'normal';
  for (let index = startOffset; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];

    if (state === 'line-comment') {
      if (current === '\n') {
        state = 'normal';
      }
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        index += 1;
        state = 'normal';
      }
      continue;
    }
    if (state === 'single-quote' || state === 'double-quote') {
      const quote = state === 'single-quote' ? "'" : '"';
      if (current === '\\') {
        index += 1;
      } else if (current === quote) {
        state = 'normal';
      }
      continue;
    }

    if (current === '/' && next === '/') {
      index += 1;
      state = 'line-comment';
    } else if (current === '/' && next === '*') {
      index += 1;
      state = 'block-comment';
    } else if (current === "'") {
      state = 'single-quote';
    } else if (current === '"') {
      state = 'double-quote';
    } else if (current === ';') {
      return index;
    }
  }
  return -1;
}

function decodeXtextLiteral(rawValue) {
  let decoded = '';
  for (let index = 0; index < rawValue.length; index += 1) {
    const current = rawValue[index];
    if (current !== '\\' || index + 1 >= rawValue.length) {
      decoded += current;
      continue;
    }

    const escaped = rawValue[index + 1];
    const simpleEscapes = {
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      "'": "'",
      '"': '"',
      '\\': '\\',
    };
    if (Object.prototype.hasOwnProperty.call(simpleEscapes, escaped)) {
      decoded += simpleEscapes[escaped];
      index += 1;
      continue;
    }
    if (escaped === 'u') {
      const digits = rawValue.slice(index + 2, index + 6);
      if (/^[0-9a-fA-F]{4}$/.test(digits)) {
        decoded += String.fromCharCode(Number.parseInt(digits, 16));
        index += 5;
        continue;
      }
    }
    decoded += escaped;
    index += 1;
  }
  return decoded;
}

function extractXtextLiterals(body) {
  const literals = [];
  let state = 'normal';
  let literalStart = -1;

  for (let index = 0; index < body.length; index += 1) {
    const current = body[index];
    const next = body[index + 1];

    if (state === 'line-comment') {
      if (current === '\n') {
        state = 'normal';
      }
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        index += 1;
        state = 'normal';
      }
      continue;
    }
    if (state === 'single-quote') {
      if (current === '\\') {
        index += 1;
      } else if (current === "'") {
        const raw = body.slice(literalStart, index + 1);
        literals.push({
          offset: literalStart,
          raw,
          value: decodeXtextLiteral(raw.slice(1, -1)),
        });
        state = 'normal';
      }
      continue;
    }
    if (state === 'double-quote') {
      if (current === '\\') {
        index += 1;
      } else if (current === '"') {
        state = 'normal';
      }
      continue;
    }

    if (current === '/' && next === '/') {
      index += 1;
      state = 'line-comment';
    } else if (current === '/' && next === '*') {
      index += 1;
      state = 'block-comment';
    } else if (current === "'") {
      literalStart = index;
      state = 'single-quote';
    } else if (current === '"') {
      state = 'double-quote';
    }
  }

  return literals;
}

function extractRuleReferenceNames(body, knownRuleNames) {
  let masked = maskComments(body);
  masked = masked.replace(/'(?:\\.|[^'\\])*'/g, (match) => ' '.repeat(match.length));
  masked = masked.replace(/"(?:\\.|[^"\\])*"/g, (match) => ' '.repeat(match.length));
  masked = masked.replace(/\b[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*\b/g, (match) =>
    ' '.repeat(match.length),
  );
  masked = masked.replace(/\b[A-Za-z_][A-Za-z0-9_]*(?=\s*(?:\?=|\+=|=))/g, (match) =>
    ' '.repeat(match.length),
  );

  const references = new Set();
  const identifierPattern = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
  for (const match of masked.matchAll(identifierPattern)) {
    if (knownRuleNames.has(match[0])) {
      references.add(match[0]);
    }
  }
  return [...references].sort(compareText);
}

function sourceDescriptor(source, sourceHash, normalizedSourceHash) {
  return {
    id: String(source.id || source.grammarId || source.modelId || 'unknown'),
    normalizedSha256: `sha256:${normalizedSourceHash || sourceHash}`,
    path: normalizeSourcePath(source.path || source.sourcePath || ''),
    precedence: Number(source.precedence || 0),
    sha256: `sha256:${sourceHash}`,
  };
}

function parseXtextGrammar(input, source = {}) {
  const rawText = String(input ?? '');
  const text = normalizeText(rawText);
  const masked = maskComments(text);
  const lineAt = createLineLocator(text);
  const descriptor = sourceDescriptor(source, sha256(rawText), sha256(text));
  const grammarHeader = masked.match(
    /^\s*grammar\s+([A-Za-z_][A-Za-z0-9_.]*)(?:\s+with\s+([A-Za-z_][A-Za-z0-9_.]*))?/m,
  );
  const rulePattern = /^[ \t]*(?:(fragment|terminal|enum)[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:returns[ \t]+([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?))?[ \t]*:/gm;
  const rules = [];
  const diagnostics = [];
  let previousEnd = 0;

  for (const match of masked.matchAll(rulePattern)) {
    const leadingWhitespace = match[0].match(/^[ \t]*/)?.[0].length || 0;
    const startOffset = match.index + leadingWhitespace;
    const colonOffset = match.index + match[0].lastIndexOf(':');
    const endOffset = findRuleTerminator(text, colonOffset + 1);
    if (endOffset < 0) {
      diagnostics.push({
        code: 'UNTERMINATED_RULE',
        line: lineAt(startOffset),
        ruleName: match[2],
        sourceId: descriptor.id,
      });
      continue;
    }

    const kind = match[1] || 'parser';
    const body = text.slice(colonOffset + 1, endOffset).trim();
    const prefix = masked.slice(previousEnd, startOffset);
    const annotations = [...prefix.matchAll(/^[ \t]*@([A-Za-z_][A-Za-z0-9_]*)[ \t]*$/gm)]
      .map((annotation) => annotation[1])
      .sort(compareText);
    const literalOccurrences = extractXtextLiterals(body).map((literal) => literal.value);
    const ruleName = match[2];

    rules.push({
      annotations,
      body,
      bodyHash: `sha256:${sha256(body)}`,
      directLiterals: literalOccurrences,
      endOffset,
      id: `grammar-rule-origin:${descriptor.id}:${ruleName}`,
      kind,
      lineSpan: {
        end: lineAt(endOffset),
        start: lineAt(startOffset),
      },
      name: ruleName,
      returnType: match[3] || null,
      source: descriptor,
      startOffset,
    });
    previousEnd = endOffset + 1;
    rulePattern.lastIndex = endOffset + 1;
  }

  const duplicateNames = [...new Set(rules.map((rule) => rule.name).filter((name, index, names) =>
    names.indexOf(name) !== index,
  ))].sort(compareText);
  for (const ruleName of duplicateNames) {
    diagnostics.push({
      code: 'DUPLICATE_RULE_IN_SOURCE',
      ruleName,
      sourceId: descriptor.id,
    });
  }

  return {
    diagnostics,
    grammarName: grammarHeader?.[1] || null,
    inheritedGrammarName: grammarHeader?.[2] || null,
    rules,
    source: descriptor,
  };
}

function decodeXml(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#([0-9]+);/g, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseXmlAttributes(fragment) {
  const attributes = {};
  const attributePattern = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*("(?:[^"&]|&(?:#x?[0-9a-fA-F]+|[A-Za-z]+);)*"|'(?:[^'&]|&(?:#x?[0-9a-fA-F]+|[A-Za-z]+);)*')/g;
  for (const match of fragment.matchAll(attributePattern)) {
    attributes[match[1]] = decodeXml(match[2].slice(1, -1));
  }
  return attributes;
}

function parseEcoreModel(input, source = {}) {
  const rawText = String(input ?? '');
  const text = normalizeText(rawText);
  const withoutComments = text.replace(/<!--[^]*?-->/g, (match) =>
    match.replace(/[^\n]/g, ' '),
  );
  const lineAt = createLineLocator(text);
  const descriptor = sourceDescriptor(source, sha256(rawText), sha256(text));
  const packageMatch = withoutComments.match(/<ecore:EPackage\b([^>]*)>/);
  const packageAttributes = packageMatch ? parseXmlAttributes(packageMatch[1]) : {};
  const packageInfo = {
    name: packageAttributes.name || null,
    nsPrefix: packageAttributes.nsPrefix || null,
    nsURI: packageAttributes.nsURI || null,
  };
  const classifiers = [];
  const diagnostics = [];
  const classifierPattern = /<eClassifiers\b([^>]*)>/g;

  for (const match of withoutComments.matchAll(classifierPattern)) {
    const fullStartTag = match[0];
    const attributes = parseXmlAttributes(match[1]);
    const typeName = attributes['xsi:type'] || '';
    if (typeName !== 'ecore:EClass' && typeName !== 'ecore:EEnum') {
      continue;
    }
    if (!attributes.name) {
      diagnostics.push({
        code: 'CLASSIFIER_WITHOUT_NAME',
        line: lineAt(match.index),
        sourceId: descriptor.id,
      });
      continue;
    }

    const selfClosing = /\/\s*>$/.test(fullStartTag);
    let endOffset = match.index + fullStartTag.length - 1;
    let classifierXml = fullStartTag;
    if (!selfClosing) {
      const closingTag = '</eClassifiers>';
      const closingOffset = withoutComments.indexOf(closingTag, match.index + fullStartTag.length);
      if (closingOffset < 0) {
        diagnostics.push({
          classifierName: attributes.name,
          code: 'UNTERMINATED_CLASSIFIER',
          line: lineAt(match.index),
          sourceId: descriptor.id,
        });
        continue;
      }
      endOffset = closingOffset + closingTag.length - 1;
      classifierXml = text.slice(match.index, endOffset + 1);
      classifierPattern.lastIndex = endOffset + 1;
    }

    const enumLiterals = [];
    if (typeName === 'ecore:EEnum') {
      const literalPattern = /<eLiterals\b([^>]*)\/?\s*>/g;
      for (const literalMatch of classifierXml.matchAll(literalPattern)) {
        const literalAttributes = parseXmlAttributes(literalMatch[1]);
        if (literalAttributes.name) {
          enumLiterals.push({
            literal: literalAttributes.literal || literalAttributes.name,
            name: literalAttributes.name,
            value: literalAttributes.value == null ? null : Number.parseInt(literalAttributes.value, 10),
          });
        }
      }
    }

    const classifierName = attributes.name;
    classifiers.push({
      abstract: attributes.abstract === 'true',
      enumLiterals: enumLiterals.sort((left, right) => compareText(left.name, right.name)),
      id: `ecore-classifier-origin:${descriptor.id}:${classifierName}`,
      kind: typeName.slice('ecore:'.length),
      lineSpan: {
        end: lineAt(endOffset),
        start: lineAt(match.index),
      },
      name: classifierName,
      packageName: packageInfo.name,
      superTypeRefs: String(attributes.eSuperTypes || '')
        .split(/\s+/)
        .filter(Boolean),
      source: descriptor,
    });
  }

  if (!packageMatch) {
    diagnostics.push({ code: 'MISSING_EPACKAGE', sourceId: descriptor.id });
  }

  return {
    classifiers,
    diagnostics,
    package: packageInfo,
    source: descriptor,
  };
}

function compactRuleOrigin(rule, referenceNames) {
  return {
    annotations: [...rule.annotations],
    bodyHash: rule.bodyHash,
    directLiterals: [...rule.directLiterals],
    id: rule.id,
    kind: rule.kind,
    lineSpan: { ...rule.lineSpan },
    name: rule.name,
    references: [...referenceNames],
    returnType: rule.returnType,
    source: { ...rule.source },
  };
}

function compactClassifierOrigin(classifier) {
  return {
    abstract: classifier.abstract,
    enumLiterals: classifier.enumLiterals.map((literal) => ({ ...literal })),
    id: classifier.id,
    kind: classifier.kind,
    lineSpan: { ...classifier.lineSpan },
    name: classifier.name,
    packageName: classifier.packageName,
    source: { ...classifier.source },
    superTypeRefs: [...classifier.superTypeRefs],
  };
}

function precedenceOrder(left, right) {
  return (
    right.source.precedence - left.source.precedence ||
    compareText(left.source.id, right.source.id) ||
    left.lineSpan.start - right.lineSpan.start ||
    compareText(left.id, right.id)
  );
}

function referenceTargetName(reference) {
  const marker = reference.lastIndexOf('#//');
  if (marker >= 0) {
    return reference.slice(marker + 3).split('/')[0] || null;
  }
  const qNameParts = reference.split('::');
  return qNameParts[qNameParts.length - 1] || null;
}

function buildEffectiveSemanticTypes(parsedEcores) {
  const allOrigins = parsedEcores.flatMap((model) => model.classifiers);
  const grouped = new Map();
  for (const origin of allOrigins) {
    const candidates = grouped.get(origin.name) || [];
    candidates.push(origin);
    grouped.set(origin.name, candidates);
  }

  const selectedByName = new Map();
  for (const [name, candidates] of grouped) {
    const ordered = [...candidates].sort(precedenceOrder);
    selectedByName.set(name, ordered[0]);
  }

  const unresolvedSuperTypes = [];
  const effectiveTypes = [...selectedByName.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, selected]) => {
      const ordered = [...grouped.get(name)].sort(precedenceOrder);
      const semanticTypeId = `semantic-type:SysML::${name}`;
      const superTypes = selected.superTypeRefs.map((reference) => {
        const targetName = referenceTargetName(reference);
        const target = targetName ? selectedByName.get(targetName) : null;
        if (!target) {
          unresolvedSuperTypes.push({
            reference,
            semanticTypeId,
            sourceId: selected.source.id,
          });
        }
        return {
          id: target ? `semantic-type:SysML::${targetName}` : null,
          name: targetName,
          reference,
          status: target ? 'resolved' : 'unresolved',
        };
      });
      return {
        abstract: selected.abstract,
        declaredPackageName: selected.packageName,
        enumLiterals: selected.enumLiterals.map((literal) => ({ ...literal })),
        id: semanticTypeId,
        kind: selected.kind,
        lineSpan: { ...selected.lineSpan },
        name,
        qualifiedName: `SysML::${name}`,
        selectedOriginId: selected.id,
        shadowedOrigins: ordered.slice(1).map((origin) => ({
          bodyKind: origin.kind,
          id: origin.id,
          lineSpan: { ...origin.lineSpan },
          packageName: origin.packageName,
          source: { ...origin.source },
        })),
        source: { ...selected.source },
        superTypes,
      };
    });

  return {
    effectiveTypes,
    origins: allOrigins
      .map(compactClassifierOrigin)
      .sort((left, right) => compareText(left.name, right.name) || precedenceOrder(left, right)),
    selectedByName,
    unresolvedSuperTypes: unresolvedSuperTypes.sort((left, right) =>
      compareText(left.semanticTypeId, right.semanticTypeId) || compareText(left.reference, right.reference),
    ),
  };
}

function resolveReturnType(returnType, semanticTypeByName) {
  if (!returnType) {
    return { semanticTypeId: null, status: 'implicit' };
  }
  const [alias, typeName] = returnType.includes('::')
    ? returnType.split('::', 2)
    : [null, returnType];
  if (alias === 'Ecore') {
    return { semanticTypeId: null, status: 'builtin' };
  }
  if (semanticTypeByName.has(typeName)) {
    return {
      semanticTypeId: `semantic-type:SysML::${typeName}`,
      status: 'resolved',
    };
  }
  return { semanticTypeId: null, status: 'unresolved' };
}

function activeGrammarSources(parsedGrammars, targetGrammarId) {
  const byGrammarName = new Map(
    parsedGrammars
      .filter((grammar) => grammar.grammarName)
      .map((grammar) => [grammar.grammarName, grammar]),
  );
  const requestedTarget = targetGrammarId
    ? parsedGrammars.find((grammar) => grammar.source.id === targetGrammarId)
    : null;
  if (targetGrammarId && !requestedTarget) {
    throw new Error(`Unknown target grammar source ID: ${targetGrammarId}`);
  }
  const target = requestedTarget || [...parsedGrammars].sort((left, right) =>
    right.source.precedence - left.source.precedence ||
    compareText(left.source.id, right.source.id),
  )[0];
  const activeSourceIds = new Set();
  const pending = target ? [target] : [];

  while (pending.length > 0) {
    const grammar = pending.pop();
    if (activeSourceIds.has(grammar.source.id)) {
      continue;
    }
    activeSourceIds.add(grammar.source.id);
    if (grammar.inheritedGrammarName) {
      const inherited = byGrammarName.get(grammar.inheritedGrammarName);
      if (inherited) {
        pending.push(inherited);
      }
    }
  }

  return {
    activeSourceIds,
    targetGrammarId: target?.source.id || null,
  };
}

function buildEffectiveRules(parsedGrammars, semanticTypeByName, targetGrammarId) {
  const allRuleOrigins = parsedGrammars.flatMap((grammar) => grammar.rules);
  const allRuleNames = new Set(allRuleOrigins.map((rule) => rule.name));
  const allGrouped = new Map();

  for (const rule of allRuleOrigins) {
    const references = extractRuleReferenceNames(rule.body, allRuleNames);
    const enriched = { ...rule, references };
    const candidates = allGrouped.get(rule.name) || [];
    candidates.push(enriched);
    allGrouped.set(rule.name, candidates);
  }

  const active = activeGrammarSources(parsedGrammars, targetGrammarId);
  const grouped = new Map();
  for (const [name, candidates] of allGrouped) {
    const activeCandidates = candidates.filter((candidate) =>
      active.activeSourceIds.has(candidate.source.id),
    );
    if (activeCandidates.length > 0) {
      grouped.set(name, activeCandidates);
    }
  }

  const effectiveRuleIds = new Map(
    [...grouped.keys()].map((name) => [name, `grammar-production:${name}`]),
  );
  const unresolvedReferences = [];
  const unresolvedReturnTypes = [];
  const effectiveRules = [...grouped.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, candidates]) => {
      const ordered = [...candidates].sort(precedenceOrder);
      const selected = ordered[0];
      const allOriginsForName = [...allGrouped.get(name)].sort(precedenceOrder);
      const returnResolution = resolveReturnType(selected.returnType, semanticTypeByName);
      if (returnResolution.status === 'unresolved') {
        unresolvedReturnTypes.push({
          productionId: `grammar-production:${name}`,
          returnType: selected.returnType,
          sourceId: selected.source.id,
        });
      }
      const references = selected.references.map((referenceName) => {
        const targetId = effectiveRuleIds.get(referenceName) || null;
        if (!targetId) {
          unresolvedReferences.push({
            productionId: `grammar-production:${name}`,
            referenceName,
            sourceId: selected.source.id,
          });
        }
        return {
          name: referenceName,
          productionId: targetId,
          status: targetId ? 'resolved' : 'unresolved',
        };
      });

      return {
        annotations: [...selected.annotations],
        bodyHash: selected.bodyHash,
        directLiterals: [...selected.directLiterals],
        id: `grammar-production:${name}`,
        kind: selected.kind,
        lineSpan: { ...selected.lineSpan },
        name,
        references,
        returnResolution,
        returnType: selected.returnType,
        selectedOriginId: selected.id,
        shadowedOrigins: allOriginsForName.filter((origin) => origin.id !== selected.id).map((origin) => ({
          bodyHash: origin.bodyHash,
          id: origin.id,
          kind: origin.kind,
          lineSpan: { ...origin.lineSpan },
          returnType: origin.returnType,
          source: { ...origin.source },
        })),
        source: { ...selected.source },
      };
    });

  return {
    activeSourceIds: [...active.activeSourceIds].sort(compareText),
    effectiveRules,
    nonEffectiveOrigins: [...allGrouped.entries()]
      .filter(([name]) => !grouped.has(name))
      .flatMap(([, origins]) => origins)
      .map((origin) => compactRuleOrigin(origin, origin.references))
      .sort((left, right) => compareText(left.name, right.name) || precedenceOrder(left, right)),
    origins: [...allGrouped.values()]
      .flat()
      .map((origin) => compactRuleOrigin(origin, origin.references))
      .sort((left, right) => compareText(left.name, right.name) || precedenceOrder(left, right)),
    targetGrammarId: active.targetGrammarId,
    unresolvedReferences: unresolvedReferences.sort((left, right) =>
      compareText(left.productionId, right.productionId) ||
      compareText(left.referenceName, right.referenceName),
    ),
    unresolvedReturnTypes: unresolvedReturnTypes.sort((left, right) =>
      compareText(left.productionId, right.productionId),
    ),
  };
}

function buildLexemes(effectiveRules) {
  const byValue = new Map();
  for (const rule of effectiveRules) {
    for (const value of rule.directLiterals) {
      const record = byValue.get(value) || {
        occurrenceCount: 0,
        productionCounts: new Map(),
        value,
      };
      record.occurrenceCount += 1;
      record.productionCounts.set(rule.id, (record.productionCounts.get(rule.id) || 0) + 1);
      byValue.set(value, record);
    }
  }

  return [...byValue.values()]
    .sort((left, right) => compareText(left.value, right.value))
    .map((record) => ({
      id: `lexeme:xtext:${sha256(record.value)}`,
      occurrenceCount: record.occurrenceCount,
      productions: [...record.productionCounts.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([productionId, occurrenceCount]) => ({ occurrenceCount, productionId })),
      value: record.value,
    }));
}

function buildLanguageInventory({
  ecoreSources,
  grammarSources,
  inventoryId = DEFAULT_INVENTORY_ID,
  targetGrammarId,
} = {}) {
  if (!Array.isArray(grammarSources) || grammarSources.length === 0) {
    throw new TypeError('grammarSources must be a non-empty array.');
  }
  if (!Array.isArray(ecoreSources) || ecoreSources.length === 0) {
    throw new TypeError('ecoreSources must be a non-empty array.');
  }

  const parsedGrammars = grammarSources.map((source) =>
    source.rules ? source : parseXtextGrammar(source.content, source),
  );
  const parsedEcores = ecoreSources.map((source) =>
    source.classifiers ? source : parseEcoreModel(source.content, source),
  );
  const semantic = buildEffectiveSemanticTypes(parsedEcores);
  const grammar = buildEffectiveRules(parsedGrammars, semantic.selectedByName, targetGrammarId);
  const lexemes = buildLexemes(grammar.effectiveRules);
  const grammarDiagnostics = parsedGrammars.flatMap((source) => source.diagnostics);
  const ecoreDiagnostics = parsedEcores.flatMap((source) => source.diagnostics);
  const literalOccurrenceCount = grammar.effectiveRules.reduce(
    (total, rule) => total + rule.directLiterals.length,
    0,
  );
  const returnTypes = new Set(
    grammar.effectiveRules.map((rule) => rule.returnType).filter(Boolean),
  );
  const productions = grammar.effectiveRules.map((rule) => ({
    directLiterals: [...rule.directLiterals],
    kind: rule.kind,
    lineEnd: rule.lineSpan.end,
    lineStart: rule.lineSpan.start,
    name: rule.name,
    productionId: rule.id,
    provenanceKind: 'official_reference_implementation',
    referencedProductionIds: rule.references
      .map((reference) => reference.productionId)
      .filter(Boolean),
    returnType: rule.returnType,
    semanticTypeId: rule.returnResolution.semanticTypeId,
    sourceId: rule.source.id,
    sourcePath: rule.source.path,
  }));
  const evaluatorLexemes = lexemes.map((lexeme) => ({
    lexemeId: lexeme.id,
    productionIds: lexeme.productions.map((production) => production.productionId),
    value: lexeme.value,
  }));
  const semanticTypes = semantic.effectiveTypes.map((semanticType) => ({
    kind: semanticType.kind,
    name: semanticType.name,
    semanticTypeId: semanticType.id,
    superTypeIds: semanticType.superTypes
      .map((superType) => superType.id)
      .filter(Boolean),
  }));
  const payload = {
    diagnostics: {
      ecore: ecoreDiagnostics,
      grammar: grammarDiagnostics,
      unresolvedReturnTypes: grammar.unresolvedReturnTypes,
      unresolvedRuleReferences: grammar.unresolvedReferences,
      unresolvedSuperTypes: semantic.unresolvedSuperTypes,
    },
    grammar: {
      activeSourceIds: grammar.activeSourceIds,
      effectiveRules: grammar.effectiveRules,
      lexemes,
      nonEffectiveOrigins: grammar.nonEffectiveOrigins,
      ruleOrigins: grammar.origins,
      targetGrammarId: grammar.targetGrammarId,
    },
    integrity: {
      unresolvedRuleReferences: grammar.unresolvedReferences,
      unresolvedSemanticReturns: grammar.unresolvedReturnTypes,
    },
    inventoryId,
    lexemes: evaluatorLexemes,
    productions,
    schemaVersion: '1.0.0',
    semanticModel: {
      classifierOrigins: semantic.origins,
      effectiveTypes: semantic.effectiveTypes,
    },
    semanticTypes,
    sources: {
      ecores: parsedEcores
        .map((model) => ({ package: model.package, ...model.source }))
        .sort((left, right) => right.precedence - left.precedence || compareText(left.id, right.id)),
      grammars: parsedGrammars
        .map((grammarSource) => ({
          grammarName: grammarSource.grammarName,
          inheritedGrammarName: grammarSource.inheritedGrammarName,
          ...grammarSource.source,
        }))
        .sort((left, right) => right.precedence - left.precedence || compareText(left.id, right.id)),
    },
    summary: {
      classifierOriginCount: semantic.origins.length,
      effectiveRuleCount: grammar.effectiveRules.length,
      effectiveSemanticTypeCount: semantic.effectiveTypes.length,
      ecoreDiagnosticCount: ecoreDiagnostics.length,
      grammarDiagnosticCount: grammarDiagnostics.length,
      lexemeCount: lexemes.length,
      literalOccurrenceCount,
      nonEffectiveRuleOriginCount: grammar.nonEffectiveOrigins.length,
      ruleOriginCount: grammar.origins.length,
      shadowedClassifierOriginCount: semantic.effectiveTypes.reduce(
        (total, type) => total + type.shadowedOrigins.length,
        0,
      ),
      shadowedRuleOriginCount: grammar.effectiveRules.reduce(
        (total, rule) => total + rule.shadowedOrigins.length,
        0,
      ),
      uniqueReturnTypeCount: returnTypes.size,
      unresolvedReturnTypeCount: grammar.unresolvedReturnTypes.length,
      unresolvedRuleReferenceCount: grammar.unresolvedReferences.length,
      unresolvedSuperTypeCount: semantic.unresolvedSuperTypes.length,
    },
  };
  const contentHash = `sha256:${sha256(canonicalStringify(payload))}`;
  return canonicalize({ ...payload, contentHash });
}

module.exports = {
  DEFAULT_INVENTORY_ID,
  buildLanguageInventory,
  canonicalStringify,
  canonicalize,
  decodeXtextLiteral,
  extractRuleReferenceNames,
  extractXtextLiterals,
  maskComments,
  normalizeText,
  parseEcoreModel,
  parseXtextGrammar,
  sha256,
};
