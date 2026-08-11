'use strict';

const SOURCE = 'local-sysml-structure-extractor';

const DEF_KINDS = new Set([
  'part def',
  'port def',
  'item def',
  'interface def',
  'connection def',
  'flow def',
  'allocation def',
  // occurrenceDef / metadataDef 是项目规则使用的投影名称；
  // languageKind 另行保留 SysML 文本声明名称，避免混同 OMG 元模型名称。
  'occurrenceDef',
  'metadataDef',
  'enumDef',
  'view def',
  'viewpoint def',
  'rendering def',
  'concern def',
  'action def',
  'state def',
  'requirement def',
  'constraint def',
  'calculation def',
  'calc def',
  'analysis def',
  'verification def',
  'use case def',
  'attribute def'
]);

const USAGE_KINDS = new Set([
  'part',
  'port',
  'item',
  'occurrence',
  'timeslice',
  'snapshot',
  'metadata',
  'enum',
  'interface',
  'connection',
  'allocation',
  'calc',
  'end',
  'derivation',
  'flow',
  'message',
  'dependency',
  'connect',
  'succession',
  'view',
  'viewpoint',
  'rendering',
  'concern',
  'expose',
  'in',
  'out',
  'return',
  'subject',
  'assert constraint',
  'assume constraint',
  'require constraint',
  'doc',
  'transition',
  'action',
  'state',
  'requirement',
  'constraint',
  'calculation',
  'analysis',
  'verification',
  'use case',
  'actor',
  'attribute'
]);

const BUILTIN_TYPES = new Set([
  'Real',
  'Integer',
  'Boolean',
  'String',
  'Mass',
  'Power',
  'Energy',
  'Voltage',
  'Current',
  'Distance',
  'Time',
  'ScalarValues::Real',
  'ScalarValues::Integer',
  'ScalarValues::Boolean',
  'ScalarValues::String',
  'VerdictKind',
  'VerificationCases::VerdictKind',
  'SemanticMetadata',
  'Metaobjects::SemanticMetadata',
  'StandardViewDefinitions::GeneralView',
  'StandardViewDefinitions::InterconnectionView',
  'StandardViewDefinitions::ActionFlowView',
  'StandardViewDefinitions::StateTransitionView',
  'StandardViewDefinitions::SequenceView',
  'StandardViewDefinitions::GeometryView',
  'StandardViewDefinitions::GridView',
  'StandardViewDefinitions::BrowserView'
]);

// A single colon is the typing operator, not part of a basic name. Qualified
// names are assembled explicitly with `::` below so compact forms such as
// `payload:Types::Signal` cannot be swallowed as one identifier.
const SYSML_NAME_SOURCE = String.raw`'(?:\\.|[^'\\\r\n])+'|[A-Za-z_]\w*`;
const SYSML_QUALIFIED_NAME_SOURCE = String.raw`(?:${SYSML_NAME_SOURCE})(?:::(?:${SYSML_NAME_SOURCE}))*`;
const MULTIPLICITY_SOURCE = String.raw`(?:[A-Za-z_][\w:.]*|\d+)(?:\s*\.\.\s*(?:[A-Za-z_][\w:.]*|\d+|\*))?`;

function validateWorkspace(input) {
  const files = normalizeFiles(input);
  const diagnostics = [];
  const modelElements = [];
  const definitions = new Set(BUILTIN_TYPES);
  const usages = [];
  const nameByScope = new Map();

  for (const file of files) {
    const clean = stripComments(file.content);
    checkBalancedBraces(file.path, clean, diagnostics);
    parseFile(file, clean, diagnostics, modelElements, definitions, usages, nameByScope);
  }

  resolveMetadataReferences(modelElements);

  const elementNames = new Set(modelElements.map((element) => element.name));
  for (const usage of usages) {
    if (usage.typeName && !definitions.has(usage.typeName) && !definitions.has(lastSegment(usage.typeName))) {
      diagnostics.push(diag(usage.file, usage.line, usage.column, 'error', 'semantic', `未定义的类型引用 "${usage.typeName}"。`));
    }
  }
  for (const relationship of modelElements.filter((element) => element.kind === 'satisfy' || element.kind === 'verify')) {
    for (const [field, label] of [['sourceName', 'source'], ['targetName', 'target']]) {
      const ref = relationship[field];
      if (ref && !elementNames.has(ref) && !elementNames.has(lastSegment(ref))) {
        diagnostics.push(diag(relationship.file, relationship.line, relationship.column, 'error', 'semantic', `${relationship.kind} 关系的 ${label} 引用 "${ref}" 不存在。`));
      }
    }
  }

  const syntaxValid = !diagnostics.some((d) => d.severity === 'error' && d.category === 'syntax');
  const semanticValid = !diagnostics.some((d) => d.severity === 'error' && d.category === 'semantic');

  return {
    source: SOURCE,
    syntaxValid,
    semanticValid,
    valid: syntaxValid && semanticValid,
    diagnostics,
    modelElements
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

function stripUtf8Bom(value) {
  return String(value || '').replace(/^\uFEFF/, '');
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function parseFile(file, clean, diagnostics, modelElements, definitions, usages, nameByScope) {
  const lines = foldTransitionContinuations(
    foldReturnContinuations(expandCompactStatements(clean).split(/\r?\n/))
  );
  const stack = [];
  let pendingBlockElement = null;

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (!line) return;
    const statement = line.replace(/[{}]/g, '').trim();
    const parent = stack.length ? stack[stack.length - 1] : null;
    const nextStartsBlock = lines.slice(index + 1).find((candidate) => candidate.trim())?.trim().startsWith('{') || false;

    if (statement) {
      parseStatement(file.path, lineNo, rawLine, statement, parent, diagnostics, modelElements, definitions, usages, nameByScope, { nextStartsBlock });
      const parsedOnLine = findElementForLine(modelElements, file.path, lineNo);
      if (parsedOnLine) {
        pendingBlockElement = rawLine.includes('{') || nextStartsBlock ? parsedOnLine : null;
      } else if (statement && !line.startsWith('{')) {
        pendingBlockElement = null;
      }
    }

    for (const char of rawLine) {
      if (char === '{') {
        stack.push(findElementForLine(modelElements, file.path, lineNo) || pendingBlockElement || parent);
        pendingBlockElement = null;
      }
      if (char === '}') stack.pop();
    }
  });
}

function expandCompactStatements(text) {
  let output = '';
  let line = 1;
  for (const char of text) {
    if (char === '\n') {
      output += char;
      line += 1;
      continue;
    }
    output += char;
    if (char === '{' || char === '}' || char === ';') {
      output += '\n';
      for (let i = 1; i < line; i += 1) output += '';
    }
  }
  return output;
}

function parseStatement(file, lineNo, rawLine, statement, parent, diagnostics, modelElements, definitions, usages, nameByScope, options = {}) {
  if (statement === ';') return;
  if (/^doc\b/.test(statement)) {
    const element = {
      id: `${file}:${lineNo}:doc:doc_${lineNo}`,
      file,
      line: lineNo,
      column: rawLine.indexOf('doc') + 1 || 1,
      kind: 'doc',
      name: `doc_${lineNo}`,
      parentId: parent?.id || null,
      children: []
    };
    if (parent) parent.children.push(element.id);
    modelElements.push(element);
    return;
  }
  if (/^(import|private import|public import)\b/.test(statement)) {
    if (!statement.endsWith(';')) diagnostics.push(diag(file, lineNo, rawLine.indexOf('import') + 1 || 1, 'error', 'syntax', 'import 语句必须以分号结尾。'));
    return;
  }

  const parsed = parseElementStatement(statement, parent);
  if (parsed) {
    const needsTerminator = !rawLine.includes('{') && !options.nextStartsBlock;
    if (needsTerminator && !statement.endsWith(';')) {
      diagnostics.push(diag(file, lineNo, Math.max(1, rawLine.length), 'error', 'syntax', `"${parsed.kind} ${parsed.name}" 缺少分号或块体。`));
    }

    const cleanName = parsed.name.replace(/;$/, '');
    const scopeKey = `${file}:${parent?.id || 'root'}`;
    const duplicateKey = `${parsed.kind}:${cleanName}`;
    if (!nameByScope.has(scopeKey)) nameByScope.set(scopeKey, new Set());
    if (nameByScope.get(scopeKey).has(duplicateKey)) {
      diagnostics.push(diag(file, lineNo, rawLine.indexOf(cleanName) + 1, 'error', 'semantic', `同一作用域中重复定义 "${cleanName}"。`));
    }
    nameByScope.get(scopeKey).add(duplicateKey);

    const element = {
      id: `${file}:${lineNo}:${parsed.kind}:${cleanName}`,
      file,
      line: lineNo,
      column: rawLine.indexOf(parsed.name) >= 0 ? rawLine.indexOf(parsed.name) + 1 : firstNonWhitespace(rawLine),
      kind: parsed.kind,
      name: cleanName,
      typeName: parsed.typeName || null,
      multiplicity: parsed.multiplicity || null,
      isAbstract: Boolean(parsed.isAbstract),
      isReference: Boolean(parsed.isReference),
      specializes: parsed.specializes || null,
      sourceName: parsed.sourceName || null,
      targetName: parsed.targetName || null,
      sourceEndpoint: parsed.sourceEndpoint || null,
      targetEndpoint: parsed.targetEndpoint || null,
      sourceRootName: parsed.sourceRootName || null,
      targetRootName: parsed.targetRootName || null,
      sourceNames: Array.isArray(parsed.sourceNames) ? [...parsed.sourceNames] : [],
      targetNames: Array.isArray(parsed.targetNames) ? [...parsed.targetNames] : [],
      triggerName: parsed.triggerName || null,
      direction: parsed.direction || null,
      guard: parsed.guard || null,
      valueExpression: parsed.valueExpression || null,
      expression: parsed.expression || null,
      isPerform: Boolean(parsed.isPerform),
      isThen: Boolean(parsed.isThen),
      isEntry: Boolean(parsed.isEntry),
      isDo: Boolean(parsed.isDo),
      isExit: Boolean(parsed.isExit),
      isInitial: Boolean(parsed.isInitial),
      isRedefinition: Boolean(parsed.isRedefinition),
      isInclude: Boolean(parsed.isInclude),
      isIndividual: Boolean(parsed.isIndividual),
      isSuccessionFlow: Boolean(parsed.isSuccessionFlow),
      isMessage: Boolean(parsed.isMessage),
      languageKind: parsed.languageKind || null,
      metaclass: parsed.metaclass || null,
      portionKind: parsed.portionKind || null,
      payloadName: parsed.payloadName || null,
      payloadType: parsed.payloadType || null,
      payloadMultiplicity: parsed.payloadMultiplicity || null,
      metadataKeyword: parsed.metadataKeyword || null,
      metadataKeywords: Array.isArray(parsed.metadataKeywords) ? [...parsed.metadataKeywords] : [],
      metadataDefinitionName: parsed.metadataDefinitionName || null,
      applicationStyle: parsed.applicationStyle || null,
      annotatedElementId: parsed.annotatedElementId || null,
      annotatedElementName: parsed.annotatedElementName || null,
      annotatedElementNames: Array.isArray(parsed.annotatedElementNames) ? [...parsed.annotatedElementNames] : [],
      annotatedElementKind: parsed.annotatedElementKind || null,
      semanticMetadata: Boolean(parsed.semanticMetadata),
      semanticRole: parsed.semanticRole || null,
      specializesList: Array.isArray(parsed.specializesList) ? [...parsed.specializesList] : [],
      baseTypeExpression: parsed.baseTypeExpression || null,
      baseTypeTargetName: parsed.baseTypeTargetName || null,
      baseTypeMetaclass: parsed.baseTypeMetaclass || null,
      underlyingKind: parsed.underlyingKind || null,
      isAuxiliary: Boolean(parsed.isAuxiliary),
      parentId: parent?.id || null,
      children: []
    };
    if (parent) parent.children.push(element.id);
    modelElements.push(element);

    if (DEF_KINDS.has(parsed.kind)) definitions.add(cleanName);
    if (parsed.typeName && !parsed.skipTypeValidation) usages.push({ file, line: lineNo, column: rawLine.indexOf(parsed.typeName) + 1, typeName: parsed.typeName });
    if (parsed.payloadType) usages.push({ file, line: lineNo, column: Math.max(1, rawLine.indexOf(parsed.payloadType) + 1), typeName: parsed.payloadType });
    if (parsed.specializes && !parsed.skipSpecializationTypeValidation && !String(parsed.specializes).startsWith('#')) {
      usages.push({ file, line: lineNo, column: rawLine.indexOf(parsed.specializes) + 1, typeName: parsed.specializes });
    }
    if (parsed.semanticRole === 'baseType' && parent?.kind === 'metadataDef') {
      parent.baseTypeExpression = parsed.valueExpression || null;
      parent.baseTypeTargetName = parsed.targetName || null;
      parent.baseTypeMetaclass = parsed.typeName || null;
      parent.semanticMetadata = true;
    }
    appendPrefixMetadataApplications({
      applications: parsed.metadataApplications,
      annotatedElement: element,
      parent,
      file,
      lineNo,
      rawLine,
      modelElements
    });
    return;
  }

  if (parseRelationshipStatement(statement, file, lineNo, rawLine, diagnostics, modelElements, parent)) return;

  if (parent && isConstraintExpressionContext(parent.kind) && looksLikeExpression(statement)) {
    const name = `${parent.name || 'constraint'}_expr_${lineNo}`;
    const element = {
      id: `${file}:${lineNo}:constraint expression:${name}`,
      file,
      line: lineNo,
      column: firstNonWhitespace(rawLine),
      kind: 'constraint expression',
      name,
      expression: statement.replace(/;$/, '').trim(),
      parentId: parent.id,
      children: []
    };
    parent.children.push(element.id);
    modelElements.push(element);
    return;
  }

  if (/^(ref|end|flow|in|out|return|entry|then|transition|accept|send|perform|assert|assume|require|subject|objective|metadata)\b/.test(statement)) {
    if (!statement.endsWith(';') && !rawLine.includes('{')) {
      diagnostics.push(diag(file, lineNo, Math.max(1, rawLine.length), 'error', 'syntax', '语句必须以分号结尾。'));
    }
    return;
  }

  if (/^[A-Za-z_][\w:]*\s*(=|:|;|\{)/.test(statement)) {
    if (!statement.endsWith(';') && !rawLine.includes('{')) {
      diagnostics.push(diag(file, lineNo, 1, 'error', 'syntax', '语句必须以分号结尾。'));
    }
    return;
  }

  diagnostics.push(diag(file, lineNo, firstNonWhitespace(rawLine), 'error', 'syntax', `未知或不支持的 SysML 教学子集语句："${statement.slice(0, 80)}"。`));
}

function parseElementStatement(statement, parent = null) {
  const prefixedDeclaration = parseMetadataPrefixedDeclaration(statement);
  if (prefixedDeclaration) {
    const declaredElement = parseElementStatement(prefixedDeclaration.declaration, parent);
    if (declaredElement) {
      return {
        ...declaredElement,
        metadataKeywords: prefixedDeclaration.keywords,
        metadataApplications: prefixedDeclaration.keywords.map((keyword) => ({
          keyword,
          metadataDefinitionName: keyword,
          applicationStyle: 'keyword'
        }))
      };
    }
  }

  const metadataDefinition = parseMetadataDefinition(statement);
  if (metadataDefinition) return metadataDefinition;

  const metadataBaseType = parseMetadataBaseTypeRedefinition(statement, parent);
  if (metadataBaseType) return metadataBaseType;

  const metadataApplication = parseMetadataApplication(statement, parent);
  if (metadataApplication) return metadataApplication;

  const enumeration = parseEnumerationStatement(statement, parent);
  if (enumeration) return enumeration;

  const dependency = parseDependencyUsage(statement);
  if (dependency) return dependency;

  const occurrenceDefinition = parseOccurrenceDefinition(statement);
  if (occurrenceDefinition) return occurrenceDefinition;

  const occurrencePortion = parseOccurrencePortion(statement);
  if (occurrencePortion) return occurrencePortion;

  const occurrenceUsage = parseOccurrenceUsage(statement);
  if (occurrenceUsage) return occurrenceUsage;

  const thenAction = statement.match(/^then\s+action\s+([A-Za-z_][\w:]*)(?:\s*\[\s*((?:[A-Za-z_][\w:.]*|\d+)(?:\s*\.\.\s*(?:[A-Za-z_][\w:.]*|\d+|\*))?)\s*\])?(?:\s*:\s*(~?[A-Za-z_][\w:]*))?\s*;?$/);
  if (thenAction) {
    return {
      kind: 'action',
      name: thenAction[1],
      multiplicity: thenAction[2] ? thenAction[2].replace(/\s+/g, '') : null,
      typeName: thenAction[3] ? thenAction[3].replace(/^~/, '') : null,
      isThen: true
    };
  }

  const performAction = statement.match(/^perform\s+(?:action\s+)?([A-Za-z_][\w:]*)(?:\s*\[\s*((?:[A-Za-z_][\w:.]*|\d+)(?:\s*\.\.\s*(?:[A-Za-z_][\w:.]*|\d+|\*))?)\s*\])?\s*:\s*(~?[A-Za-z_][\w:]*)\s*;?$/);
  if (performAction) {
    return {
      kind: 'action',
      name: performAction[1],
      multiplicity: performAction[2] ? performAction[2].replace(/\s+/g, '') : null,
      typeName: performAction[3].replace(/^~/, ''),
      isPerform: true
    };
  }

  const stateAction = statement.match(/^(entry|do|exit)\s+(?:action\s+)?([A-Za-z_][\w:]*)(?:\s*:\s*(~?[A-Za-z_][\w:]*))?\s*;?$/);
  if (stateAction) {
    return {
      kind: 'action',
      name: stateAction[2],
      typeName: stateAction[3] ? stateAction[3].replace(/^~/, '') : null,
      isEntry: stateAction[1] === 'entry',
      isDo: stateAction[1] === 'do',
      isExit: stateAction[1] === 'exit'
    };
  }

  const directedItem = statement.match(new RegExp(String.raw`^(in|out|inout)\s+item\s+(${SYSML_NAME_SOURCE})(?:\s*\[\s*(${MULTIPLICITY_SOURCE}|\*)\s*\])?(?:\s*:\s*(~?${SYSML_QUALIFIED_NAME_SOURCE}))?(?:\s*(?:(:>>|redefines)|(:>|subsets|specializes))\s*(${SYSML_QUALIFIED_NAME_SOURCE}))?(?:\s*=\s*(.+?))?\s*;?$`));
  if (directedItem) {
    const targetName = directedItem[7] ? decodeSysmlQualifiedName(directedItem[7]) : null;
    return {
      kind: 'item',
      direction: directedItem[1],
      name: decodeSysmlNameToken(directedItem[2]),
      multiplicity: directedItem[3] ? directedItem[3].replace(/\s+/g, '') : null,
      typeName: directedItem[4] ? decodeSysmlQualifiedName(directedItem[4].replace(/^~/, '')) : null,
      targetName: directedItem[5] ? targetName : null,
      specializes: directedItem[6] ? targetName : null,
      skipSpecializationTypeValidation: Boolean(directedItem[6]),
      isRedefinition: Boolean(directedItem[5]),
      valueExpression: directedItem[8] ? directedItem[8].trim() : null
    };
  }

  const ioParameter = statement.match(new RegExp(String.raw`^(in|out|inout)\s+(${SYSML_NAME_SOURCE})(?:\s*\[\s*(${MULTIPLICITY_SOURCE}|\*)\s*\])?(?:\s*:\s*(~?${SYSML_QUALIFIED_NAME_SOURCE}))?(?:\s*=\s*(.+?))?\s*;?$`));
  if (ioParameter) {
    return {
      kind: ioParameter[1],
      direction: ioParameter[1],
      name: decodeSysmlNameToken(ioParameter[2]),
      multiplicity: ioParameter[3] ? ioParameter[3].replace(/\s+/g, '') : null,
      typeName: ioParameter[4] ? decodeSysmlQualifiedName(ioParameter[4].replace(/^~/, '')) : null,
      valueExpression: ioParameter[5] ? ioParameter[5].trim() : null
    };
  }

  const returnParameter = statement.match(/^return(?:\s+(?:attribute\s+)?)?([A-Za-z_][\w:]*)(?:\s*:\s*(~?[A-Za-z_][\w:]*))?(?:\s*=\s*(.+?))?\s*;?$/);
  if (returnParameter) {
    return {
      kind: 'return',
      name: returnParameter[1],
      typeName: returnParameter[2] ? returnParameter[2].replace(/^~/, '') : null,
      valueExpression: returnParameter[3] ? returnParameter[3].trim() : null
    };
  }

  const anonymousReturn = statement.match(/^return\s*:\s*(~?[A-Za-z_][\w:]*)(?:\s*=\s*(.+?))?\s*;?$/);
  if (anonymousReturn) {
    return {
      kind: 'return',
      name: 'result',
      typeName: anonymousReturn[1].replace(/^~/, ''),
      valueExpression: anonymousReturn[2] ? anonymousReturn[2].trim() : null
    };
  }

  const redefinedSubject = statement.match(/^subject\s+([A-Za-z_][\w:]*)(?:\s*(?::>|:>>)\s*([A-Za-z_][\w:.]*))\s*;?$/);
  if (redefinedSubject) {
    return {
      kind: 'subject',
      name: redefinedSubject[1],
      targetName: redefinedSubject[2],
      valueExpression: redefinedSubject[2],
      isRedefinition: true
    };
  }

  const subject = statement.match(/^subject\s+([A-Za-z_][\w:]*)(?:\s*:\s*(~?[A-Za-z_][\w:]*))?(?:\s*=\s*([A-Za-z_][\w:.]*))?\s*;?$/);
  if (subject) {
    return {
      kind: 'subject',
      name: subject[1],
      typeName: subject[2] ? subject[2].replace(/^~/, '') : null,
      targetName: subject[3] || null,
      valueExpression: subject[3] || null
    };
  }

  const typedActor = statement.match(new RegExp(String.raw`^actor\s+(${SYSML_NAME_SOURCE})(?:\s*:\s*(~?${SYSML_QUALIFIED_NAME_SOURCE}))?(?:\s*=\s*(${SYSML_QUALIFIED_NAME_SOURCE}))?\s*;?$`));
  if (typedActor) {
    return {
      kind: 'actor',
      name: decodeSysmlNameToken(typedActor[1]),
      typeName: typedActor[2] ? decodeSysmlQualifiedName(typedActor[2].replace(/^~/, '')) : null,
      targetName: typedActor[3] ? decodeSysmlQualifiedName(typedActor[3]) : null,
      valueExpression: typedActor[3] ? decodeSysmlQualifiedName(typedActor[3]) : null
    };
  }

  const redefinedActor = statement.match(new RegExp(String.raw`^actor\s+:>>\s*(${SYSML_QUALIFIED_NAME_SOURCE})\s*;?$`));
  if (redefinedActor) {
    const targetName = decodeSysmlQualifiedName(redefinedActor[1]);
    return {
      kind: 'actor',
      name: lastSegment(targetName),
      targetName,
      valueExpression: targetName,
      isRedefinition: true
    };
  }

  const expose = statement.match(/^expose\s+([A-Za-z_][\w:.*]*)(?:\s+as\s+([A-Za-z_][\w:]*))?\s*;?$/);
  if (expose) {
    return {
      kind: 'expose',
      name: expose[2] || expose[1],
      targetName: expose[1]
    };
  }

  const refItem = statement.match(/^ref\s+(item|part|port|attribute)\s+([A-Za-z_][\w:]*)(?:\s*\[\s*((?:[A-Za-z_][\w:.]*|\d+)(?:\s*\.\.\s*(?:[A-Za-z_][\w:.]*|\d+|\*))?)\s*\])?\s*:\s*(~?[A-Za-z_][\w:]*)(?:\s*=.*)?\s*;?$/);
  if (refItem) {
    return {
      kind: refItem[1],
      name: refItem[2],
      multiplicity: refItem[3] ? refItem[3].replace(/\s+/g, '') : null,
      typeName: refItem[4].replace(/^~/, ''),
      isReference: true
    };
  }

  const end = statement.match(/^end\s+(?:ref\s+)?(?:(port|item|part)\s+)?([A-Za-z_][\w:]*)\s*:\s*(~?[A-Za-z_][\w:]*)(?:\s*\[\s*((?:[A-Za-z_][\w:.]*|\d+)(?:\s*\.\.\s*(?:[A-Za-z_][\w:.]*|\d+|\*))?)\s*\])?\s*;?$/);
  if (end) {
    return {
      kind: 'end',
      name: end[2],
      typeName: end[3].replace(/^~/, ''),
      multiplicity: end[4] ? end[4].replace(/\s+/g, '') : null,
      isReference: true
    };
  }

  const stereotypedEnd = statement.match(/^end\s+#([A-Za-z_][\w:]*)\s*(?:(?:([A-Za-z_][\w:]*)\s*)?:\s*(~?[A-Za-z_][\w:]*))?(?:\s*::>\s*([A-Za-z_][\w:.]*))?\s*;?$/);
  if (stereotypedEnd) {
    const targetName = stereotypedEnd[4] || null;
    return {
      kind: 'end',
      name: stereotypedEnd[2] || (targetName ? `${stereotypedEnd[1]}_${sanitizeName(targetName)}` : stereotypedEnd[1]),
      typeName: stereotypedEnd[3] ? stereotypedEnd[3].replace(/^~/, '') : null,
      targetName,
      specializes: `#${stereotypedEnd[1]}`
    };
  }

  const interfaceConnect = statement.match(/^(interface|connection)\s+([A-Za-z_][\w:]*)(?:\s*:\s*(~?[A-Za-z_][\w:]*))?\s+connect\s+(.+?)\s+to\s+(.+?)\s*;?$/);
  if (interfaceConnect) {
    const sourceName = cleanConnectorEndpoint(interfaceConnect[4]);
    const targetName = cleanConnectorEndpoint(interfaceConnect[5]);
    return {
      kind: interfaceConnect[1],
      name: interfaceConnect[2],
      typeName: interfaceConnect[3] ? interfaceConnect[3].replace(/^~/, '') : null,
      sourceName,
      targetName,
      sourceRootName: connectorRootName(sourceName),
      targetRootName: connectorRootName(targetName)
    };
  }

  const bareConnect = statement.match(/^connect\s+(.+?)\s+to\s+(.+?)\s*;?$/);
  if (bareConnect) {
    const sourceEndpoint = cleanConnectorEndpoint(bareConnect[1]);
    const targetEndpoint = cleanConnectorEndpoint(bareConnect[2]);
    const sourceName = connectorRootName(sourceEndpoint) || sourceEndpoint;
    const targetName = connectorRootName(targetEndpoint) || targetEndpoint;
    return {
      kind: 'connection',
      languageKind: 'connect',
      metaclass: 'ConnectionUsage',
      name: `connection_${sanitizeName(sourceEndpoint)}_to_${sanitizeName(targetEndpoint)}`,
      sourceName,
      targetName,
      sourceEndpoint,
      targetEndpoint,
      sourceRootName: sourceName,
      targetRootName: targetName
    };
  }

  const namedAllocation = statement.match(new RegExp(String.raw`^allocation\s+(${SYSML_NAME_SOURCE})(?:\s*:\s*(~?${SYSML_QUALIFIED_NAME_SOURCE}))?\s+allocate\s+(.+?)\s+to\s+(.+?)\s*;?$`));
  if (namedAllocation) {
    return {
      kind: 'allocation',
      name: decodeSysmlNameToken(namedAllocation[1]),
      typeName: namedAllocation[2] ? decodeSysmlQualifiedName(namedAllocation[2].replace(/^~/, '')) : null,
      sourceName: cleanConnectorEndpoint(namedAllocation[3]),
      targetName: cleanConnectorEndpoint(namedAllocation[4])
    };
  }

  const bareAllocation = statement.match(/^allocate\s+(.+?)\s+to\s+(.+?)\s*;?$/);
  if (bareAllocation) {
    const sourceName = cleanConnectorEndpoint(bareAllocation[1]);
    const targetName = cleanConnectorEndpoint(bareAllocation[2]);
    return {
      kind: 'allocation',
      name: `allocation_${sanitizeName(sourceName)}_to_${sanitizeName(targetName)}`,
      sourceName,
      targetName
    };
  }

  const message = parseMessageUsage(statement);
  if (message) return message;

  const flow = parseFlowUsage(statement);
  if (flow) return flow;

  const binding = statement.match(/^bind\s+(.+?)\s*=\s*(.+?)\s*;?$/);
  if (binding) {
    const sourceName = cleanConnectorEndpoint(binding[1]);
    const targetName = cleanConnectorEndpoint(binding[2]);
    return {
      kind: 'bind',
      name: `bind_${sanitizeName(sourceName)}_to_${sanitizeName(targetName)}`,
      sourceName,
      targetName
    };
  }

  const useCaseDefinition = statement.match(new RegExp(String.raw`^use\s+case\s+def\s+(${SYSML_NAME_SOURCE})(?:\s*(?::>|specializes)\s*(${SYSML_QUALIFIED_NAME_SOURCE}))?\s*;?$`));
  if (useCaseDefinition) {
    return {
      kind: 'use case def',
      name: decodeSysmlNameToken(useCaseDefinition[1]),
      specializes: useCaseDefinition[2] ? decodeSysmlQualifiedName(useCaseDefinition[2]) : null
    };
  }

  const useCaseUsage = statement.match(new RegExp(String.raw`^(include\s+)?use\s+case\s+(${SYSML_NAME_SOURCE})(?:\s*:\s*(~?${SYSML_QUALIFIED_NAME_SOURCE}))?\s*;?$`));
  if (useCaseUsage) {
    return {
      kind: 'use case',
      name: decodeSysmlNameToken(useCaseUsage[2]),
      typeName: useCaseUsage[3] ? decodeSysmlQualifiedName(useCaseUsage[3].replace(/^~/, '')) : null,
      isInclude: Boolean(useCaseUsage[1])
    };
  }

  const individualDefinition = statement.match(new RegExp(String.raw`^individual\s+(part def|port def|item def|action def|state def)\s+(${SYSML_NAME_SOURCE})(?:\s*(?::>|specializes)\s*(${SYSML_QUALIFIED_NAME_SOURCE}))?\s*;?$`));
  if (individualDefinition) {
    return {
      kind: individualDefinition[1],
      languageKind: `individual ${individualDefinition[1]}`,
      name: decodeSysmlNameToken(individualDefinition[2]),
      specializes: individualDefinition[3] ? decodeSysmlQualifiedName(individualDefinition[3]) : null,
      isIndividual: true
    };
  }

  const individualUsage = statement.match(new RegExp(String.raw`^individual\s+(part|port|item|action|state)\s+(${SYSML_NAME_SOURCE})(?:\s*\[\s*(${MULTIPLICITY_SOURCE}|\*)\s*\])?(?:\s*:\s*(~?${SYSML_QUALIFIED_NAME_SOURCE}))?\s*;?$`));
  if (individualUsage) {
    return {
      kind: individualUsage[1],
      languageKind: `individual ${individualUsage[1]}`,
      name: decodeSysmlNameToken(individualUsage[2]),
      multiplicity: individualUsage[3] ? individualUsage[3].replace(/\s+/g, '') : null,
      typeName: individualUsage[4] ? decodeSysmlQualifiedName(individualUsage[4].replace(/^~/, '')) : null,
      isIndividual: true
    };
  }

  const commonDefinition = statement.match(new RegExp(String.raw`^(abstract\s+)?(part def|port def|item def|interface def|connection def|flow def|allocation def|view def|viewpoint def|rendering def|concern def|action def|state def|requirement def|constraint def|calculation def|calc def|analysis def|verification def|attribute def)\s+(${SYSML_NAME_SOURCE})(?:\s*(?::>|specializes)\s*(${SYSML_QUALIFIED_NAME_SOURCE}))?\s*;?$`));
  if (commonDefinition) {
    return {
      kind: commonDefinition[2] === 'calc def' ? 'calculation def' : commonDefinition[2],
      name: decodeSysmlNameToken(commonDefinition[3]),
      isAbstract: Boolean(commonDefinition[1]),
      specializes: commonDefinition[4] ? decodeSysmlQualifiedName(commonDefinition[4]) : null
    };
  }

  const commonUsage = statement.match(new RegExp(String.raw`^(part|port|item|interface|connection|view|viewpoint|rendering|concern|action|state|requirement|constraint|calculation|calc|analysis|verification)\s+(${SYSML_NAME_SOURCE})(?:\s*\[\s*(${MULTIPLICITY_SOURCE})\s*\])?\s*:\s*(~?${SYSML_QUALIFIED_NAME_SOURCE})\s*;?$`));
  if (commonUsage) {
    return {
      kind: commonUsage[1],
      name: decodeSysmlNameToken(commonUsage[2]),
      multiplicity: commonUsage[3] ? commonUsage[3].replace(/\s+/g, '') : null,
      typeName: decodeSysmlQualifiedName(commonUsage[4].replace(/^~/, ''))
    };
  }

  const commonBareUsage = statement.match(new RegExp(String.raw`^(part|port|item|interface|connection|view|viewpoint|rendering|concern|action|state|requirement|constraint|calculation|calc|analysis|verification)\s+(${SYSML_NAME_SOURCE})(?:\s*\[\s*(${MULTIPLICITY_SOURCE})\s*\])?\s*;?$`));
  if (commonBareUsage) {
    return {
      kind: commonBareUsage[1],
      name: decodeSysmlNameToken(commonBareUsage[2]),
      multiplicity: commonBareUsage[3] ? commonBareUsage[3].replace(/\s+/g, '') : null
    };
  }

  const explicitSuccession = statement.match(new RegExp(String.raw`^succession(?:\s+(${SYSML_NAME_SOURCE}))?\s+first\s+([A-Za-z_][\w:.]*|start)\s+then\s+([A-Za-z_][\w:.]*)\s*;?$`));
  if (explicitSuccession) {
    const sourceName = explicitSuccession[2];
    const targetName = explicitSuccession[3];
    return {
      kind: 'succession',
      name: explicitSuccession[1]
        ? decodeSysmlNameToken(explicitSuccession[1])
        : `succession_${sanitizeName(sourceName)}_to_${sanitizeName(targetName)}`,
      sourceName,
      targetName
    };
  }

  const firstThen = statement.match(/^first\s+([A-Za-z_][\w:.]*|start)\s+then\s+([A-Za-z_][\w:.]*)\s*;?$/);
  if (firstThen) {
    const sourceName = firstThen[1];
    const targetName = firstThen[2];
    const isStateContext = parent?.kind === 'state def' || parent?.kind === 'state';
    return {
      kind: 'succession',
      name: `succession_${sanitizeName(sourceName)}_to_${sanitizeName(targetName)}`,
      sourceName,
      targetName,
      isInitial: isStateContext && sourceName === 'start'
    };
  }

  const transition = statement.match(/^transition(?:\s+([A-Za-z_][\w:]*))?\s+first\s+([A-Za-z_][\w:.]*)(?:\s+accept\s+(?:(?:[A-Za-z_][\w:]*)\s*:\s*)?([A-Za-z_][\w:]*)(?:\s+via\s+[A-Za-z_][\w:.]*)?)?(?:\s+if\s+(.+?))?(?:\s+do\s+.+?)?\s+then\s+([A-Za-z_][\w:.]*)\s*;?$/);
  if (transition) {
    const sourceName = transition[2];
    const targetName = transition[5];
    return {
      kind: 'transition',
      name: transition[1] || `transition_${sanitizeName(sourceName)}_to_${sanitizeName(targetName)}`,
      sourceName,
      targetName,
      triggerName: transition[3] || null,
      guard: transition[4] ? transition[4].trim() : null
    };
  }

  const patterns = [
    [/^package\s+([A-Za-z_][\w:]*)\s*;?$/, 'package'],
    [/^block\s+([A-Za-z_][\w:]*)\s*;?$/, 'block'],
    [/^#derivation\s+connection(?:\s+def)?(?:\s+([A-Za-z_][\w:]*))?\s*;?$/, 'derivation'],
    [/^(abstract\s+)?(part def|port def|item def|interface def|connection def|view def|viewpoint def|rendering def|concern def|action def|state def|requirement def|constraint def|calculation def|calc def|analysis def|verification def|attribute def)\s+([A-Za-z_][\w:]*)(?:\s*(?::>|specializes)\s*([A-Za-z_][\w:]*))?\s*;?$/, null],
    [/^(assert|assume|require)\s+constraint(?:\s+([A-Za-z_]\w*))?(?:\s*:\s*(~?[A-Za-z_][\w:]*))?\s*;?$/, 'constraintAssertion'],
    [/^(part|port|item|interface|connection|view|viewpoint|rendering|concern|action|state|requirement|constraint|calculation|calc|analysis|verification)\s+([A-Za-z_][\w:]*)(?:\s*\[\s*((?:[A-Za-z_][\w:.]*|\d+)(?:\s*\.\.\s*(?:[A-Za-z_][\w:.]*|\d+|\*))?)\s*\])?\s*:\s*(~?[A-Za-z_][\w:]*)\s*;?$/, null],
    [/^attribute\s+([A-Za-z_]\w*)(?:\s*\[\s*((?:[A-Za-z_][\w:.]*|\d+)(?:\s*\.\.\s*(?:[A-Za-z_][\w:.]*|\d+|\*))?)\s*\])?\s*:\s*(~?[A-Za-z_][\w:]*)(?:\s*=\s*(.+?))?\s*;?$/, 'attribute'],
    [/^(part|port|item|attribute|action|state|requirement|constraint|calculation|calc|analysis|verification)\s+(?::>>|redefines)\s+([A-Za-z_][\w:.]*)(?:\s*:\s*(~?[A-Za-z_][\w:]*))?(?:\s*=\s*(.+?))?\s*;?$/, 'featureRedefinition'],
    [/^(part|port|item|interface|connection|view|viewpoint|rendering|concern|action|state|requirement|constraint|calculation|calc|analysis|verification)\s+([A-Za-z_][\w:]*)(?:\s*\[\s*((?:[A-Za-z_][\w:.]*|\d+)(?:\s*\.\.\s*(?:[A-Za-z_][\w:.]*|\d+|\*))?)\s*\])?\s*;?$/, null]
  ];

  for (const [pattern, fixedKind] of patterns) {
    const match = statement.match(pattern);
    if (!match) continue;
    if (fixedKind === 'derivation') {
      return { kind: 'derivation', name: match[1] || `derivation_${sanitizeName(statement)}` };
    }
    if (fixedKind === 'constraintAssertion') {
      return {
        kind: `${match[1]} constraint`,
        name: match[2] || `${match[1]}Constraint`,
        typeName: match[3] ? match[3].replace(/^~/, '') : null
      };
    }
    if (fixedKind === 'attribute') {
      return {
        kind: 'attribute',
        name: match[1],
        multiplicity: match[2] ? match[2].replace(/\s+/g, '') : null,
        typeName: match[3] ? match[3].replace(/^~/, '') : null,
        valueExpression: match[4] ? match[4].trim() : null
      };
    }
    if (fixedKind === 'featureRedefinition') {
      return {
        kind: match[1] === 'calc' ? 'calculation' : match[1],
        name: lastSegment(match[2]),
        typeName: match[3] ? match[3].replace(/^~/, '') : null,
        targetName: match[4] || null,
        valueExpression: match[4] ? match[4].trim() : null,
        isRedefinition: true
      };
    }
    if (fixedKind) return { kind: fixedKind, name: match[1] };
    if (match[2]?.endsWith('def')) {
      return {
        kind: match[2] === 'calc def' ? 'calculation def' : match[2],
        name: match[3],
        isAbstract: Boolean(match[1]),
        specializes: match[4] || null
      };
    }
    return {
      kind: match[1] === 'calc def' ? 'calculation def' : match[1],
      name: match[2],
      multiplicity: match[3] ? match[3].replace(/\s+/g, '') : null,
      typeName: match[4] ? match[4].replace(/^~/, '') : null
    };
  }
  return null;
}

function foldReturnContinuations(lines) {
  const output = [...lines];
  for (let index = 0; index < output.length; index += 1) {
    if (!/^\s*return\b.*=\s*$/.test(output[index])) continue;
    let combined = output[index].replace(/\s+$/, '');
    for (let next = index + 1; next < output.length; next += 1) {
      const continuation = output[next].trim();
      if (!continuation) continue;
      if (/^[{}]$/.test(continuation)) break;
      combined += ` ${continuation}`;
      output[next] = '';
      if (continuation.endsWith(';')) break;
    }
    output[index] = combined;
  }
  return output;
}

function foldTransitionContinuations(lines) {
  const output = [...lines];
  const clauseStart = /^(?:first|accept|if|do|then)\b/;
  for (let index = 0; index < output.length; index += 1) {
    const firstLine = output[index].trim();
    if (!/^transition\b/.test(firstLine) || /[;{}]/.test(firstLine)) continue;

    let combined = firstLine;
    let completed = false;
    const consumed = [];
    for (let next = index + 1; next < output.length; next += 1) {
      const continuation = output[next].trim();
      if (!continuation) continue;
      if (/[{}]/.test(continuation) || !clauseStart.test(continuation)) break;
      combined += ` ${continuation}`;
      consumed.push(next);
      if (continuation.endsWith(';')) {
        completed = true;
        break;
      }
    }
    if (!completed) continue;
    output[index] = combined;
    consumed.forEach((consumedIndex) => {
      output[consumedIndex] = '';
    });
  }
  return output;
}

function parseEnumerationStatement(statement, parent) {
  const definition = String(statement || '').match(new RegExp(String.raw`^enum\s+def\s+(${SYSML_NAME_SOURCE})(?:\s*(?::>|specializes)\s*(${SYSML_QUALIFIED_NAME_SOURCE}))?\s*;?$`));
  if (definition) {
    return {
      kind: 'enumDef',
      languageKind: 'enum def',
      metaclass: 'EnumerationDefinition',
      name: decodeSysmlNameToken(definition[1]),
      specializes: definition[2] ? decodeSysmlQualifiedName(definition[2]) : null
    };
  }

  if (parent?.kind !== 'enumDef') return null;
  const value = String(statement || '').match(new RegExp(String.raw`^(?:enum\s+)?(${SYSML_NAME_SOURCE})\s*;?$`));
  if (!value) return null;
  return {
    kind: 'enum',
    languageKind: 'enum value',
    metaclass: 'EnumerationUsage',
    name: decodeSysmlNameToken(value[1]),
    typeName: parent.name,
    skipTypeValidation: true
  };
}

function parseDependencyUsage(statement) {
  const match = String(statement || '').match(/^dependency\s+(?:from\s+)?(.+?)\s+to\s+(.+?)\s*;?$/);
  if (!match) return null;
  const sourceNames = splitRelationshipEndpoints(match[1]);
  const targetNames = splitRelationshipEndpoints(match[2]);
  if (!sourceNames.length || !targetNames.length) return null;
  const sourceName = sourceNames[0];
  const targetName = targetNames[0];
  return {
    kind: 'dependency',
    languageKind: 'dependency',
    metaclass: 'Dependency',
    name: `dependency_${sanitizeName(sourceName)}_to_${sanitizeName(targetName)}`,
    sourceName,
    targetName,
    sourceRootName: connectorRootName(sourceName),
    targetRootName: connectorRootName(targetName),
    sourceNames,
    targetNames
  };
}

function parseMessageUsage(statement) {
  const text = String(statement || '').trim().replace(/;$/, '').trim();
  const prefix = text.match(/^message\b\s*(.*)$/);
  if (!prefix) return null;
  const body = prefix[1].trim();
  const relationship = body.match(/^(.*?)\s*\bfrom\s+(.+?)\s+to\s+(.+)$/);
  if (!relationship) return null;
  const declaration = parseFlowDeclarationAndPayload(relationship[1].trim());
  if (!declaration) return null;
  const sourceEndpoint = cleanConnectorEndpoint(relationship[2]);
  const targetEndpoint = cleanConnectorEndpoint(relationship[3]);
  const sourceName = connectorRootName(sourceEndpoint) || sourceEndpoint;
  const targetName = connectorRootName(targetEndpoint) || targetEndpoint;
  return {
    kind: 'message',
    languageKind: 'message',
    metaclass: 'FlowUsage',
    name: declaration.name || `message_${sanitizeName(sourceEndpoint)}_to_${sanitizeName(targetEndpoint)}`,
    typeName: declaration.typeName,
    payloadName: declaration.payloadName,
    payloadType: declaration.payloadType,
    payloadMultiplicity: declaration.payloadMultiplicity,
    sourceName,
    targetName,
    sourceEndpoint,
    targetEndpoint,
    sourceRootName: sourceName,
    targetRootName: targetName,
    isMessage: true
  };
}

function parseMetadataPrefixedDeclaration(statement) {
  let declaration = String(statement || '').trim();
  const keywords = [];
  const keywordPattern = /^#([A-Za-z_][\w:]*)\s+/;
  let match = declaration.match(keywordPattern);
  while (match) {
    keywords.push(match[1]);
    declaration = declaration.slice(match[0].length).trim();
    match = declaration.match(keywordPattern);
  }
  if (!keywords.length) return null;

  // #derivation connection 等项目既有简写仍走原解析分支。
  // 此处只接收 OMG 记法中可带用户自定义 metadata keyword 的普通类型声明。
  if (!/^(?:(?:abstract|individual)\s+)*(?:part|occurrence|item|port|action|state|requirement|verification|analysis|view)\b/.test(declaration)) {
    return null;
  }
  return { keywords, declaration };
}

function parseMetadataDefinition(statement) {
  const match = String(statement || '').match(new RegExp(String.raw`^(abstract\s+)?metadata\s+def(?:\s+<([^>\r\n]+)>)?\s+(${SYSML_NAME_SOURCE})(?:\s*(?::>|specializes)\s*(.+?))?\s*;?$`));
  if (!match) return null;
  const specializesList = String(match[4] || '')
    .replace(/;$/, '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(decodeSysmlQualifiedName);
  return {
    kind: 'metadataDef',
    languageKind: 'metadata def',
    metaclass: 'MetadataDefinition',
    name: decodeSysmlNameToken(match[3]),
    metadataKeyword: match[2] ? match[2].trim() : null,
    isAbstract: Boolean(match[1]),
    specializes: specializesList[0] || null,
    specializesList,
    semanticMetadata: specializesList.some((name) => lastSegment(name) === 'SemanticMetadata')
  };
}

function parseMetadataBaseTypeRedefinition(statement, parent) {
  if (parent?.kind !== 'metadataDef') return null;
  const match = String(statement || '').match(new RegExp(String.raw`^:>>\s*baseType(?:\s+default)?\s*(?:=\s*)?(.+?)\s+meta\s+(${SYSML_QUALIFIED_NAME_SOURCE})\s*;?$`));
  if (!match) return null;
  const targetName = match[1].trim();
  const metaclassType = decodeSysmlQualifiedName(match[2]);
  return {
    kind: 'metadata base type',
    languageKind: ':>> baseType',
    metaclass: 'Feature',
    name: 'baseType',
    targetName,
    typeName: metaclassType,
    valueExpression: `${targetName} meta ${metaclassType}`,
    isRedefinition: true,
    semanticRole: 'baseType',
    skipTypeValidation: true
  };
}

function parseMetadataApplication(statement, parent) {
  const text = String(statement || '').trim();
  const atApplication = text.match(new RegExp(String.raw`^@(${SYSML_QUALIFIED_NAME_SOURCE})(?:\s+about\s+(.+?))?\s*;?$`));
  if (atApplication) {
    const metadataDefinitionName = decodeSysmlQualifiedName(atApplication[1]);
    return metadataApplicationProjection({
      name: lastSegment(metadataDefinitionName),
      metadataDefinitionName,
      applicationStyle: 'at',
      about: atApplication[2],
      parent
    });
  }

  const keywordApplication = text.match(new RegExp(String.raw`^metadata(?:\s+(${SYSML_NAME_SOURCE}))?(?:\s*:\s*(${SYSML_QUALIFIED_NAME_SOURCE})|\s+(${SYSML_QUALIFIED_NAME_SOURCE}))?(?:\s+about\s+(.+?))?\s*;?$`));
  if (!keywordApplication) return null;
  const explicitName = keywordApplication[1] ? decodeSysmlNameToken(keywordApplication[1]) : null;
  const metadataDefinitionName = keywordApplication[2]
    ? decodeSysmlQualifiedName(keywordApplication[2])
    : keywordApplication[3]
      ? decodeSysmlQualifiedName(keywordApplication[3])
      : explicitName;
  if (!metadataDefinitionName) return null;
  return metadataApplicationProjection({
    name: explicitName || lastSegment(metadataDefinitionName),
    metadataDefinitionName,
    applicationStyle: 'metadata',
    about: keywordApplication[4],
    parent
  });
}

function metadataApplicationProjection({ name, metadataDefinitionName, applicationStyle, about, parent }) {
  const annotatedElementNames = about
    ? String(about).replace(/;$/, '').split(',').map((value) => cleanConnectorEndpoint(value)).filter(Boolean)
    : parent?.name
      ? [parent.name]
      : [];
  return {
    kind: 'metadata',
    languageKind: applicationStyle === 'at' ? '@ metadata application' : 'metadata',
    metaclass: 'MetadataUsage',
    name,
    typeName: metadataDefinitionName,
    metadataDefinitionName,
    applicationStyle,
    annotatedElementId: about ? null : (parent?.id || null),
    annotatedElementName: annotatedElementNames[0] || null,
    annotatedElementNames,
    annotatedElementKind: about ? null : (parent?.kind || null),
    skipTypeValidation: true
  };
}

function parseOccurrenceDefinition(statement) {
  const individualShorthand = String(statement || '').match(new RegExp(String.raw`^individual\s+def\s+(${SYSML_NAME_SOURCE})(?:\s*(?::>|specializes)\s*(${SYSML_QUALIFIED_NAME_SOURCE}))?\s*;?$`));
  if (individualShorthand) {
    return {
      kind: 'occurrenceDef',
      languageKind: 'individual occurrence def',
      metaclass: 'OccurrenceDefinition',
      name: decodeSysmlNameToken(individualShorthand[1]),
      isIndividual: true,
      specializes: individualShorthand[2] ? decodeSysmlQualifiedName(individualShorthand[2]) : null
    };
  }
  const match = String(statement || '').match(new RegExp(String.raw`^(abstract\s+)?(individual\s+)?occurrence\s+def\s+(${SYSML_NAME_SOURCE})(?:\s*(?::>|specializes)\s*(${SYSML_QUALIFIED_NAME_SOURCE}))?\s*;?$`));
  if (!match) return null;
  return {
    kind: 'occurrenceDef',
    languageKind: 'occurrence def',
    metaclass: 'OccurrenceDefinition',
    name: decodeSysmlNameToken(match[3]),
    isAbstract: Boolean(match[1]),
    isIndividual: Boolean(match[2]),
    specializes: match[4] ? decodeSysmlQualifiedName(match[4]) : null
  };
}

function parseOccurrencePortion(statement) {
  const match = String(statement || '').trim().match(/^(then\s+)?(individual\s+)?(timeslice|snapshot)\b\s*(.*)$/);
  if (!match) return null;
  const portionKind = match[3];
  let rest = match[4].trim().replace(/;$/, '').trim();
  let underlyingKind = 'occurrence';
  const underlying = rest.match(/^(occurrence|part|item|port|action|state)\b\s*(.*)$/);
  if (underlying) {
    underlyingKind = underlying[1];
    rest = underlying[2].trim();
  }

  const unnamedRedefinition = rest.match(new RegExp(String.raw`^(?::>>|redefines)\s+(${SYSML_QUALIFIED_NAME_SOURCE})$`));
  if (unnamedRedefinition) {
    const targetName = decodeSysmlQualifiedName(unnamedRedefinition[1]);
    return {
      kind: portionKind,
      languageKind: `${portionKind} ${underlyingKind}`,
      metaclass: 'OccurrenceUsage',
      name: lastSegment(targetName),
      targetName,
      isRedefinition: true,
      isIndividual: Boolean(match[2]),
      isThen: Boolean(match[1]),
      portionKind,
      underlyingKind
    };
  }

  const usage = rest.match(new RegExp(String.raw`^(${SYSML_NAME_SOURCE})(?:\s*\[\s*(\*|${MULTIPLICITY_SOURCE})\s*\])?(?:\s+(?:ordered|nonunique))*(?:\s*:(?!>)\s*(~?${SYSML_QUALIFIED_NAME_SOURCE}))?(?:\s*(?:(:>>|redefines)|(:>|specializes))\s*(${SYSML_QUALIFIED_NAME_SOURCE}))?(?:\s*=\s*(.+?))?$`));
  if (!usage) return null;
  const targetName = usage[6] ? decodeSysmlQualifiedName(usage[6]) : null;
  return {
    kind: portionKind,
    languageKind: `${portionKind} ${underlyingKind}`,
    metaclass: 'OccurrenceUsage',
    name: decodeSysmlNameToken(usage[1]),
    multiplicity: usage[2] ? usage[2].replace(/\s+/g, '') : null,
    typeName: usage[3] ? decodeSysmlQualifiedName(usage[3].replace(/^~/, '')) : null,
    targetName: usage[4] ? targetName : null,
    specializes: usage[5] ? targetName : null,
    valueExpression: usage[7] ? usage[7].trim() : null,
    isRedefinition: Boolean(usage[4]),
    isIndividual: Boolean(match[2]),
    isThen: Boolean(match[1]),
    portionKind,
    underlyingKind
  };
}

function parseOccurrenceUsage(statement) {
  const individualShorthand = String(statement || '').match(new RegExp(String.raw`^individual\s+(${SYSML_NAME_SOURCE})(?:\s*\[\s*(\*|${MULTIPLICITY_SOURCE})\s*\])?\s*:\s*(~?${SYSML_QUALIFIED_NAME_SOURCE})\s*;?$`));
  if (individualShorthand) {
    return {
      kind: 'occurrence',
      languageKind: 'individual occurrence',
      metaclass: 'OccurrenceUsage',
      name: decodeSysmlNameToken(individualShorthand[1]),
      multiplicity: individualShorthand[2] ? individualShorthand[2].replace(/\s+/g, '') : null,
      typeName: decodeSysmlQualifiedName(individualShorthand[3].replace(/^~/, '')),
      isIndividual: true
    };
  }
  const match = String(statement || '').match(new RegExp(String.raw`^(ref\s+)?(individual\s+)?occurrence\s+(${SYSML_NAME_SOURCE})(?:\s*\[\s*(\*|${MULTIPLICITY_SOURCE})\s*\])?(?:\s+(?:ordered|nonunique))*(?:\s*:(?!>)\s*(~?${SYSML_QUALIFIED_NAME_SOURCE}))?(?:\s*(?:(:>>|redefines)|(:>|specializes))\s*(${SYSML_QUALIFIED_NAME_SOURCE}))?(?:\s*=\s*(.+?))?\s*;?$`));
  if (!match) return null;
  const targetName = match[8] ? decodeSysmlQualifiedName(match[8]) : null;
  return {
    kind: 'occurrence',
    languageKind: 'occurrence',
    metaclass: 'OccurrenceUsage',
    name: decodeSysmlNameToken(match[3]),
    multiplicity: match[4] ? match[4].replace(/\s+/g, '') : null,
    typeName: match[5] ? decodeSysmlQualifiedName(match[5].replace(/^~/, '')) : null,
    targetName: match[6] ? targetName : null,
    specializes: match[7] ? targetName : null,
    valueExpression: match[9] ? match[9].trim() : null,
    isRedefinition: Boolean(match[6]),
    isReference: Boolean(match[1]),
    isIndividual: Boolean(match[2])
  };
}

function parseFlowUsage(statement) {
  const text = String(statement || '').trim().replace(/;$/, '').trim();
  const prefix = text.match(/^(succession\s+)?flow\b\s*(.*)$/);
  if (!prefix || /^def\b/.test(prefix[2])) return null;
  const isSuccessionFlow = Boolean(prefix[1]);
  const body = prefix[2].trim();
  let declarationText = '';
  let sourceText = '';
  let targetText = '';

  const withFrom = body.match(/^(.*?)\s*\bfrom\s+(.+?)\s+to\s+(.+)$/);
  if (withFrom) {
    declarationText = withFrom[1].trim();
    sourceText = withFrom[2];
    targetText = withFrom[3];
  } else {
    const withoutFrom = body.match(/^(.+?)\s+to\s+(.+)$/);
    if (!withoutFrom) return null;
    sourceText = withoutFrom[1];
    targetText = withoutFrom[2];
  }

  const declaration = parseFlowDeclarationAndPayload(declarationText);
  if (!declaration) return null;
  const sourceName = cleanConnectorEndpoint(sourceText);
  const targetName = cleanConnectorEndpoint(targetText);
  return {
    kind: 'flow',
    languageKind: isSuccessionFlow ? 'succession flow' : 'flow',
    metaclass: 'FlowUsage',
    name: declaration.name || `flow_${sanitizeName(sourceName)}_to_${sanitizeName(targetName)}`,
    typeName: declaration.typeName,
    payloadName: declaration.payloadName,
    payloadType: declaration.payloadType,
    payloadMultiplicity: declaration.payloadMultiplicity,
    sourceName,
    targetName,
    isSuccessionFlow
  };
}

function parseFlowDeclarationAndPayload(value) {
  const text = String(value || '').trim();
  if (!text) return { name: null, typeName: null, payloadName: null, payloadType: null, payloadMultiplicity: null };
  const ofMatch = text.match(/^(.*?)\s*\bof\s+(.+)$/);
  const declarationText = ofMatch ? ofMatch[1].trim() : text;
  const payloadText = ofMatch ? ofMatch[2].trim() : '';
  const declaration = declarationText ? parseNamedTypedFeature(declarationText, { singleTokenIsName: true }) : {};
  if (declarationText && !declaration) return null;
  const payload = payloadText ? parseNamedTypedFeature(payloadText, { singleTokenIsName: false }) : {};
  if (payloadText && !payload) return null;
  return {
    name: declaration.name || null,
    typeName: declaration.typeName || null,
    payloadName: payload.name || null,
    payloadType: payload.typeName || null,
    payloadMultiplicity: payload.multiplicity || null
  };
}

function parseNamedTypedFeature(value, { singleTokenIsName }) {
  const match = String(value || '').trim().match(new RegExp(String.raw`^(${SYSML_NAME_SOURCE})(?:\s*\[\s*(\*|${MULTIPLICITY_SOURCE})\s*\])?(?:\s*:\s*(~?${SYSML_QUALIFIED_NAME_SOURCE}))?$`));
  if (!match) return null;
  const first = decodeSysmlNameToken(match[1]);
  const explicitType = match[3] ? decodeSysmlQualifiedName(match[3].replace(/^~/, '')) : null;
  return {
    name: explicitType ? first : (singleTokenIsName ? first : null),
    typeName: explicitType || (singleTokenIsName ? null : first),
    multiplicity: match[2] ? match[2].replace(/\s+/g, '') : null
  };
}

function appendPrefixMetadataApplications({ applications, annotatedElement, parent, file, lineNo, rawLine, modelElements }) {
  if (!Array.isArray(applications) || !applications.length) return;
  annotatedElement.metadataApplicationIds = [];
  applications.forEach((application, index) => {
    const keyword = application.keyword;
    const name = `${keyword}@${annotatedElement.name}`;
    const element = {
      id: `${file}:${lineNo}:metadata:${name}:${index + 1}`,
      file,
      line: lineNo,
      column: Math.max(1, rawLine.indexOf(`#${keyword}`) + 1),
      kind: 'metadata',
      languageKind: '# metadata application',
      metaclass: 'MetadataUsage',
      name,
      typeName: application.metadataDefinitionName,
      metadataKeyword: keyword,
      metadataDefinitionName: application.metadataDefinitionName,
      applicationStyle: application.applicationStyle,
      annotatedElementId: annotatedElement.id,
      annotatedElementName: annotatedElement.name,
      annotatedElementKind: annotatedElement.kind,
      parentId: parent?.id || null,
      isAuxiliary: true,
      children: []
    };
    annotatedElement.metadataApplicationIds.push(element.id);
    modelElements.push(element);
  });
}

function resolveMetadataReferences(modelElements) {
  const keywordDefinitions = new Map(modelElements
    .filter((element) => element.kind === 'metadataDef' && element.metadataKeyword)
    .map((element) => [element.metadataKeyword, element.name]));

  for (const element of modelElements) {
    if (Array.isArray(element.metadataKeywords) && element.metadataKeywords.length) {
      element.metadataDefinitionNames = element.metadataKeywords
        .map((keyword) => keywordDefinitions.get(keyword) || null)
        .filter(Boolean);
    }
    if (element.kind !== 'metadata') continue;
    const reference = element.metadataKeyword || element.metadataDefinitionName || element.typeName;
    const resolved = keywordDefinitions.get(reference);
    if (!resolved) continue;
    element.metadataDefinitionName = resolved;
    element.typeName = resolved;
  }
}

function isConstraintExpressionContext(kind) {
  return ['constraint def', 'assert constraint', 'assume constraint', 'require constraint'].includes(kind);
}

function looksLikeExpression(statement) {
  const text = String(statement || '').trim();
  if (!text || /^(in|out|return|attribute|doc|metadata)\b/.test(text)) return false;
  return /(?:==|<=|>=|<|>|\band\b|\bor\b|[+\-*/])/.test(text);
}

function cleanConnectorEndpoint(value) {
  return String(value || '')
    .trim()
    .replace(/^\[\s*\d+(?:\s*\.\.\s*(?:\d+|\*))?\s*\]\s*/, '')
    .replace(/\s*;$/, '')
    .replace(/\s+/g, ' ');
}

function splitRelationshipEndpoints(value) {
  return String(value || '')
    .split(',')
    .map((endpoint) => cleanConnectorEndpoint(endpoint))
    .filter(Boolean);
}

function connectorRootName(value) {
  const match = String(value || '').trim().match(new RegExp(String.raw`^(${SYSML_NAME_SOURCE})`));
  return match ? decodeSysmlNameToken(match[1]) : null;
}

function sanitizeName(value) {
  return String(value || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'endpoint';
}

function decodeSysmlQualifiedName(value) {
  const tokens = Array.from(String(value || '').matchAll(new RegExp(SYSML_NAME_SOURCE, 'g')));
  if (!tokens.length) return String(value || '').trim();
  return tokens.map((token) => decodeSysmlNameToken(token[0])).join('::');
}

function decodeSysmlNameToken(value) {
  const text = String(value || '').trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/\\(['\\])/g, '$1');
  }
  return text;
}

function parseRelationshipStatement(statement, file, lineNo, rawLine, diagnostics, modelElements, parent) {
  const unaryVerify = statement.match(/^verify\s+([A-Za-z_][\w:.]*)\s*;?$/);
  const match = unaryVerify
    ? ['verify', 'verify', unaryVerify[1], null]
    : statement.match(/^(satisfy|verify)\s+(?:requirement\s+)?([A-Za-z_][\w:.]*)(?:\s*:\s*[A-Za-z_][\w:]*)?(?:\s*->\s*|\s+by\s+|\s+)([A-Za-z_][\w:.]*)\s*;?$/);
  if (!match) return false;
  if (!statement.endsWith(';')) {
    diagnostics.push(diag(file, lineNo, Math.max(1, rawLine.length), 'error', 'syntax', `${match[1]} 关系必须以分号结尾。`));
  }
  const name = `${match[1]}_${lineNo}`;
  const element = {
    id: `${file}:${lineNo}:${match[1]}:${name}`,
    file,
    line: lineNo,
    column: rawLine.indexOf(match[1]) + 1,
    kind: match[1],
    name,
    sourceName: unaryVerify ? unaryVerify[1] : (match[2] || null),
    targetName: unaryVerify ? null : (match[3] || null),
    parentId: parent?.id || null,
    children: []
  };
  if (parent) parent.children.push(element.id);
  modelElements.push(element);
  return true;
}

function checkBalancedBraces(file, clean, diagnostics) {
  const stack = [];
  let line = 1;
  let column = 0;
  for (const char of clean) {
    column += 1;
    if (char === '\n') {
      line += 1;
      column = 0;
      continue;
    }
    if (char === '{') stack.push({ line, column });
    if (char === '}') {
      if (!stack.length) diagnostics.push(diag(file, line, column, 'error', 'syntax', '多余的右花括号。'));
      else stack.pop();
    }
  }
  for (const open of stack) {
    diagnostics.push(diag(file, open.line, open.column, 'error', 'syntax', '缺少匹配的右花括号。'));
  }
}

function findElementForLine(elements, file, line) {
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    if (elements[i].file === file && elements[i].line === line && !elements[i].isAuxiliary) return elements[i];
  }
  return null;
}

function diag(file, line, column, severity, category, message) {
  return { file, line, column: Math.max(1, column || 1), severity, category, message, source: SOURCE };
}

function firstNonWhitespace(rawLine) {
  const match = rawLine.match(/\S/);
  return match ? match.index + 1 : 1;
}

function lastSegment(value) {
  return String(value).split(/::|\./).pop();
}

module.exports = { SOURCE, validateWorkspace };
