'use strict';

function evaluateRules({ rules, files, strictResult }) {
  const normalizedRules = normalizeRules(rules);
  const diagnostics = [];
  const lessonResults = [];
  const text = (files || []).map((file) => file.content || '').join('\n');
  const fileMap = new Map((files || []).map((file) => [file.path, file]));
  const elements = strictResult.modelElements || [];

  for (const rule of normalizedRules) {
    const result = evaluateRule(rule, { text, fileMap, elements, strictResult });
    lessonResults.push(result);
    if (!result.passed) {
      const location = resolveRuleLocation(rule, { files, text, elements, strictResult });
      diagnostics.push({
        file: location.file,
        line: location.line,
        column: location.column,
        severity: 'error',
        category: 'lesson',
        message: result.message,
        source: 'course-rule',
        ruleId: result.id
      });
    }
  }

  return {
    coursePassed: lessonResults.every((result) => result.passed),
    diagnostics,
    lessonResults
  };
}

function normalizeRules(rules) {
  if (!rules) return [];
  if (Array.isArray(rules)) return rules;
  if (Array.isArray(rules.rules)) return rules.rules;
  if (Array.isArray(rules.checks)) return rules.checks;
  if (Array.isArray(rules.tasks)) return rules.tasks.flatMap((task) => task.rules || []);
  return [];
}

function evaluateRule(rule, ctx) {
  const id = rule.id || `${rule.type}:${rule.name || rule.kind || rule.pattern || ''}`;
  const label = rule.message || rule.description || `规则未通过：${rule.type}`;
  const selector = normalizeSelector(rule);
  let passed = false;

  switch (rule.type) {
    case 'strictValidationPassed':
      passed = Boolean(ctx.strictResult.syntaxValid && ctx.strictResult.semanticValid);
      break;
    case 'elementExists':
      passed = ctx.elements.some((element) => matchElementWithParent(element, selector, ctx.elements));
      break;
    case 'childElementExists':
      passed = childElementExists(ctx.elements, rule);
      break;
    case 'descendantElementExists':
      passed = descendantElementExists(ctx.elements, rule);
      break;
    case 'relationshipExists':
      passed = ctx.elements.some((element) => ['satisfy', 'verify', 'flow', 'message', 'bind', 'connect', 'interface', 'connection', 'succession', 'transition', 'allocation', 'dependency', 'derivation', 'end', 'assert constraint', 'assume constraint', 'require constraint'].includes(element.kind) && matchElementWithParent(element, selector, ctx.elements));
      break;
    case 'minCount':
      passed = ctx.elements.filter((element) => matchElementWithParent(element, selector, ctx.elements)).length >= Number(rule.count ?? rule.min ?? 1);
      break;
    case 'regex':
      passed = new RegExp(rule.pattern, rule.flags || 'm').test(ctx.text);
      break;
    case 'contains':
      passed = ctx.text.includes(rule.text || rule.value || '');
      break;
    case 'notContains':
      passed = !ctx.text.includes(rule.text || rule.value || '');
      break;
    case 'fileExists':
      passed = ctx.fileMap.has(rule.path || rule.file || '');
      break;
    default:
      passed = false;
  }

  return { id, type: rule.type, passed, message: passed ? (rule.passMessage || '通过') : label };
}

function resolveRuleLocation(rule, ctx) {
  const files = Array.isArray(ctx.files) ? ctx.files : [];
  const requestedPath = rule.file || rule.path;
  const file = files.find((item) => requestedPath && item.path === requestedPath) || files[0] || { path: rule.file || 'workspace', content: ctx.text || '' };
  const lines = String(file.content || '').split(/\r?\n/);
  const selector = normalizeSelector(rule);
  const strictDiagnostic = rule.type === 'strictValidationPassed'
    ? (ctx.strictResult?.diagnostics || []).find((diagnostic) => Number(diagnostic.line) > 0)
    : null;
  if (strictDiagnostic) {
    return {
      file: strictDiagnostic.file || file.path || 'workspace',
      line: Number(strictDiagnostic.line) || 1,
      column: Number(strictDiagnostic.column) || 1
    };
  }

  const parentNames = selectorNames(selector, 'parent');
  const parentName = parentNames[0];
  const parentBlock = parentName ? findNamedBlock(lines, parentName, selector.parentKind || selector.parentTypeName) : null;
  const searchRange = parentBlock || { start: 0, end: lines.length - 1 };
  const lineIndex = findBestRuleLine(lines, searchRange, selector, rule)
    ?? (parentBlock ? parentBlock.start : null)
    ?? findAnySelectorLine(lines, selector)
    ?? 0;
  return {
    file: file.path || rule.file || 'workspace',
    line: Math.max(1, lineIndex + 1),
    column: firstNonWhitespaceColumn(lines[lineIndex] || '')
  };
}

function findNamedBlock(lines, name, kindHint) {
  const namePattern = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  const kindPattern = kindHint ? new RegExp(`\\b${escapeRegExp(String(kindHint)).replace(/\\s+/g, '\\s+')}\\b`) : null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripLineComment(lines[index] || '');
    if (!namePattern.test(line)) continue;
    if (kindPattern && !kindPattern.test(line)) continue;
    const range = blockRangeFromLine(lines, index);
    if (range) return range;
    return { start: index, end: index };
  }
  return null;
}

function blockRangeFromLine(lines, start) {
  let depth = 0;
  let seenOpen = false;
  for (let index = start; index < lines.length; index += 1) {
    const line = stripStrings(stripLineComment(lines[index] || ''));
    for (const char of line) {
      if (char === '{') {
        depth += 1;
        seenOpen = true;
      } else if (char === '}') {
        depth -= 1;
        if (seenOpen && depth <= 0) return { start, end: index };
      }
    }
  }
  return seenOpen ? { start, end: lines.length - 1 } : null;
}

function findBestRuleLine(lines, range, selector, rule) {
  const start = Math.max(0, range.start);
  const end = Math.min(lines.length - 1, range.end);
  const tokens = selectorTokens(selector, rule);
  let best = null;
  for (let index = start; index <= end; index += 1) {
    const raw = lines[index] || '';
    const line = raw.trim();
    if (!line) continue;
    const score = lineScore(line, tokens, selector, rule);
    if (score <= 0) continue;
    const weighted = /\bTODO\b/i.test(line) ? score + 8 : score;
    if (!best || weighted > best.score) best = { index, score: weighted };
  }
  return best?.index ?? null;
}

function findAnySelectorLine(lines, selector) {
  const tokens = selectorTokens(selector, {});
  let best = null;
  for (let index = 0; index < lines.length; index += 1) {
    const score = lineScore(lines[index] || '', tokens, selector, {});
    if (score <= 0) continue;
    if (!best || score > best.score) best = { index, score };
  }
  return best?.index ?? null;
}

function selectorTokens(selector, rule) {
  const values = [
    selector.kind,
    selector.childKind,
    selector.name,
    selector.childName,
    selector.sourceName,
    selector.targetName,
    selector.typeName,
    selector.payloadType,
    selector.metadataDefinitionName,
    selector.metadataKeyword,
    selector.annotatedElementName,
    selector.valueIncludes,
    selector.expressionIncludes,
    rule.id
  ];
  return [...new Set(values
    .flatMap((value) => String(value || '').match(/[A-Za-z_][\w:]*/g) || [])
    .filter((value) => value.length > 2 && !['type', 'rule', 'valid'].includes(value.toLowerCase())))];
}

function lineScore(line, tokens, selector, rule) {
  const haystack = normalizeExpression(line);
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(normalizeExpression(token))) score += token.length > 8 ? 4 : 2;
  }
  const kind = selector.childKind || selector.kind;
  if (kind && new RegExp(`\\b${escapeRegExp(String(kind)).replace(/\\s+/g, '\\s+')}\\b`, 'i').test(line)) score += 5;
  if (selector.name && new RegExp(`\\b${escapeRegExp(selector.name)}\\b`).test(line)) score += 6;
  if (selector.childName && new RegExp(`\\b${escapeRegExp(selector.childName)}\\b`).test(line)) score += 6;
  if (selector.valueIncludes && haystack.includes(normalizeExpression(selector.valueIncludes))) score += 8;
  if (selector.sourceName && new RegExp(`\\b${escapeRegExp(selector.sourceName)}\\b`).test(line)) score += 5;
  if (selector.targetName && new RegExp(`\\b${escapeRegExp(selector.targetName)}\\b`).test(line)) score += 5;
  if (rule.id && line.toLowerCase().includes(String(rule.id).split('-').pop().toLowerCase())) score += 2;
  return score;
}

function stripLineComment(line) {
  return String(line || '').replace(/\/\/.*$/, '');
}

function stripStrings(line) {
  return String(line || '').replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
}

function firstNonWhitespaceColumn(line) {
  const match = /\S/.exec(line || '');
  return match ? match.index + 1 : 1;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSelector(rule) {
  const selector = { ...rule, ...(rule.selector || {}) };
  if (selector.kind) selector.kind = normalizeKind(selector.kind);
  if (selector.parentKind) selector.parentKind = normalizeKind(selector.parentKind);
  if (selector.childParentKind) selector.childParentKind = normalizeKind(selector.childParentKind);
  if (selector.childKind) selector.childKind = normalizeKind(selector.childKind);
  return selector;
}

function normalizeKind(kind) {
  const aliases = {
    partDef: 'part def',
    portDef: 'port def',
    itemDef: 'item def',
    interfaceDef: 'interface def',
    connectionDef: 'connection def',
    viewDef: 'view def',
    viewpointDef: 'viewpoint def',
    renderingDef: 'rendering def',
    concernDef: 'concern def',
    actionDef: 'action def',
    stateDef: 'state def',
    useCaseDef: 'use case def',
    useCase: 'use case',
    transition: 'transition',
    calc: 'calc',
    return: 'return',
    subject: 'subject',
    doc: 'doc',
    derivation: 'derivation',
    end: 'end',
    assertConstraint: 'assert constraint',
    assumeConstraint: 'assume constraint',
    requireConstraint: 'require constraint',
    constraintExpression: 'constraint expression',
    requirementDef: 'requirement def',
    calculationDef: 'calculation def',
    analysisDef: 'analysis def',
    verificationDef: 'verification def',
    constraintDef: 'constraint def',
    attributeDef: 'attribute def'
  };
  return aliases[kind] || kind;
}

function matchElement(element, selector) {
  if (selector.kind && element.kind !== selector.kind) return false;
  if (selector.name && element.name !== selector.name) return false;
  if (selector.typeName && element.typeName !== selector.typeName) return false;
  if (selector.payloadType && element.payloadType !== selector.payloadType) return false;
  if (selector.metadataDefinitionName && element.metadataDefinitionName !== selector.metadataDefinitionName) return false;
  if (selector.metadataKeyword && element.metadataKeyword !== selector.metadataKeyword) return false;
  if (selector.annotatedElementName && element.annotatedElementName !== selector.annotatedElementName) return false;
  if (selector.multiplicity && normalizeMultiplicity(element.multiplicity) !== normalizeMultiplicity(selector.multiplicity)) return false;
  if (selector.specializes && element.specializes !== selector.specializes) return false;
  if (selector.isAbstract !== undefined && Boolean(element.isAbstract) !== Boolean(selector.isAbstract)) return false;
  if (selector.isReference !== undefined && Boolean(element.isReference) !== Boolean(selector.isReference)) return false;
  if (selector.isPerform !== undefined && Boolean(element.isPerform) !== Boolean(selector.isPerform)) return false;
  if (selector.isThen !== undefined && Boolean(element.isThen) !== Boolean(selector.isThen)) return false;
  if (selector.kind === 'bind' && selector.sourceName && selector.targetName) {
    const direct = element.sourceName === selector.sourceName && element.targetName === selector.targetName;
    const reversed = element.sourceName === selector.targetName && element.targetName === selector.sourceName;
    if (!direct && !reversed) return false;
  } else {
    if (selector.sourceName && element.sourceName !== selector.sourceName) return false;
    if (selector.targetName && element.targetName !== selector.targetName) return false;
  }
  if (selector.triggerName && element.triggerName !== selector.triggerName) return false;
  if (selector.guardIncludes && !String(element.guard || '').includes(selector.guardIncludes)) return false;
  if (selector.guard && element.guard !== selector.guard) return false;
  if (selector.valueIncludes && !expressionIncludes(element.valueExpression, selector.valueIncludes)) return false;
  if (selector.valueExpression && !expressionEquals(element.valueExpression, selector.valueExpression)) return false;
  if (selector.expressionIncludes && !expressionIncludes(element.expression || element.valueExpression, selector.expressionIncludes)) return false;
  if (selector.expression && !expressionEquals(element.expression || element.valueExpression, selector.expression)) return false;
  if (selector.isEntry !== undefined && Boolean(element.isEntry) !== Boolean(selector.isEntry)) return false;
  if (selector.isDo !== undefined && Boolean(element.isDo) !== Boolean(selector.isDo)) return false;
  if (selector.isExit !== undefined && Boolean(element.isExit) !== Boolean(selector.isExit)) return false;
  if (selector.isInitial !== undefined && Boolean(element.isInitial) !== Boolean(selector.isInitial)) return false;
  if (selector.isRedefinition !== undefined && Boolean(element.isRedefinition) !== Boolean(selector.isRedefinition)) return false;
  return true;
}

function matchElementWithParent(element, selector, elements) {
  if (!matchElement(element, selector)) return false;
  const parentNames = selectorNames(selector, 'parent');
  if (!parentNames.length && !selector.parentKind) return true;
  const parent = elements.find((candidate) => candidate.id === element.parentId);
  if (!parent) return false;
  if (parentNames.length && !parentNames.includes(parent.name)) return false;
  if (selector.parentKind && parent.kind !== selector.parentKind) return false;
  if (selector.parentTypeName && parent.typeName !== selector.parentTypeName) return false;
  return true;
}

function childElementExists(elements, rule) {
  const selector = normalizeSelector(rule);
  const parentNames = selectorNames(selector, 'parent');
  const parents = elements.filter((element) => {
    if (parentNames.length && !parentNames.includes(element.name)) return false;
    if (selector.parentKind && element.kind !== selector.parentKind) return false;
    if (selector.parentTypeName && element.typeName !== selector.parentTypeName) return false;
    return Boolean(parentNames.length || selector.parentKind);
  });
  if (!parents.length) return false;
  const childIds = new Set(parents.flatMap((parent) => parent.children || []));
  return elements.some((element) => childIds.has(element.id) && matchElement(element, {
    kind: normalizeKind(selector.childKind || selector.kind),
    name: selector.childName || selector.name,
    typeName: selector.typeName,
    payloadType: selector.payloadType,
    metadataDefinitionName: selector.metadataDefinitionName,
    metadataKeyword: selector.metadataKeyword,
    annotatedElementName: selector.annotatedElementName,
    multiplicity: selector.multiplicity,
    isReference: selector.isReference,
    isPerform: selector.isPerform,
    isThen: selector.isThen,
    isEntry: selector.isEntry,
    isDo: selector.isDo,
    isExit: selector.isExit,
    isInitial: selector.isInitial,
    isRedefinition: selector.isRedefinition,
    specializes: selector.specializes,
    isAbstract: selector.isAbstract,
    sourceName: selector.sourceName,
    targetName: selector.targetName,
    triggerName: selector.triggerName,
    guard: selector.guard,
    guardIncludes: selector.guardIncludes,
    valueExpression: selector.valueExpression,
    valueIncludes: selector.valueIncludes,
    expression: selector.expression,
    expressionIncludes: selector.expressionIncludes
  }));
}

function descendantElementExists(elements, rule) {
  const selector = normalizeSelector(rule);
  const parentNames = selectorNames(selector, 'parent');
  const roots = elements.filter((element) => {
    if (parentNames.length && !parentNames.includes(element.name)) return false;
    if (selector.parentKind && element.kind !== selector.parentKind) return false;
    if (selector.parentTypeName && element.typeName !== selector.parentTypeName) return false;
    return Boolean(parentNames.length || selector.parentKind);
  });
  if (!roots.length) return false;

  const byId = new Map(elements.map((element) => [element.id, element]));
  const targetSelector = {
    kind: normalizeKind(selector.childKind || selector.kind),
    name: selector.childName || selector.name,
    typeName: selector.typeName,
    payloadType: selector.payloadType,
    metadataDefinitionName: selector.metadataDefinitionName,
    metadataKeyword: selector.metadataKeyword,
    annotatedElementName: selector.annotatedElementName,
    multiplicity: selector.multiplicity,
    isReference: selector.isReference,
    isPerform: selector.isPerform,
    isThen: selector.isThen,
    isEntry: selector.isEntry,
    isDo: selector.isDo,
    isExit: selector.isExit,
    isInitial: selector.isInitial,
    isRedefinition: selector.isRedefinition,
    specializes: selector.specializes,
    isAbstract: selector.isAbstract,
    sourceName: selector.sourceName,
    targetName: selector.targetName,
    triggerName: selector.triggerName,
    guard: selector.guard,
    guardIncludes: selector.guardIncludes,
    valueExpression: selector.valueExpression,
    valueIncludes: selector.valueIncludes,
    expression: selector.expression,
    expressionIncludes: selector.expressionIncludes
  };

  const visit = (element) => {
    for (const childId of element.children || []) {
      const child = byId.get(childId);
      if (!child) continue;
      if (matchElement(child, targetSelector)) {
        if (!selector.childParentKind || element.kind === selector.childParentKind) return true;
      }
      if (visit(child)) return true;
    }
    return false;
  };

  return roots.some(visit);
}

function normalizeMultiplicity(value) {
  return String(value || '').replace(/\s+/g, '');
}

function selectorNames(selector, baseName) {
  const values = [];
  for (const key of [baseName, `${baseName}Name`, `${baseName}AnyOf`, `${baseName}Names`]) {
    const value = selector[key];
    if (Array.isArray(value)) values.push(...value);
    else if (value) values.push(value);
  }
  return [...new Set(values.map((value) => String(value)).filter(Boolean))];
}

function expressionIncludes(actual, expected) {
  return normalizeExpression(actual).includes(normalizeExpression(expected));
}

function expressionEquals(actual, expected) {
  return normalizeExpression(actual) === normalizeExpression(expected);
}

function normalizeExpression(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/(^|[^A-Za-z_])(\d+(?:\.\d+)?)(?![A-Za-z_])/g, (match, prefix, number) => `${prefix}${normalizeNumberLiteral(number)}`);
}

function normalizeNumberLiteral(value) {
  const text = String(value);
  if (!text.includes('.')) return text;
  const trimmed = text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return trimmed || '0';
}

module.exports = { evaluateRules, normalizeRules, normalizeSelector, normalizeKind };
