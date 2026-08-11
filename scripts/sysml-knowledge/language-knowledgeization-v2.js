'use strict';

const crypto = require('node:crypto');

const EVALUATOR_ID = 'sysml-language-knowledgeization/v2';
const RESPONSIBILITY_SCHEMA_VERSION = 'sysml-production-responsibilities/v2';

const CAPABILITY_AREAS = Object.freeze({
  P0: Object.freeze({ areaId: 'P0', name: 'Foundations and language infrastructure' }),
  P1: Object.freeze({ areaId: 'P1', name: 'Structure' }),
  P2: Object.freeze({ areaId: 'P2', name: 'Behavior' }),
  P3: Object.freeze({ areaId: 'P3', name: 'Analysis, requirements, constraints, and cases' }),
  P4: Object.freeze({ areaId: 'P4', name: 'Supporting concepts and model libraries' })
});

const RESPONSIBILITY_KINDS = Object.freeze([
  'semantic_construct',
  'grammar_composition',
  'keyword_dispatch',
  'enum_alternative',
  'lexer_terminal',
  'expression_infrastructure'
]);

const CAPABILITY_PROFILES = Object.freeze([
  Object.freeze({
    areaId: 'P1',
    pattern: /(?:item|part|port|connection|connector|binding|interface|flow|message|allocation)/iu
  }),
  Object.freeze({
    areaId: 'P2',
    pattern: /(?:action|behavior|state|transition|succession|perform|accept|send|control|fork|join|merge|decide|terminate|assign|trigger)/iu
  }),
  Object.freeze({
    areaId: 'P3',
    pattern: /(?:calculation|calc|constraint|requirement|satisfy|verification|analysiscase|usecase|case|objective|verdict)/iu
  }),
  Object.freeze({
    areaId: 'P4',
    pattern: /(?:viewpoint|view|rendering|expose|metadata|documentation|comment|textualrepresentation|library|quantity|unit|isq|variation|variant)/iu
  })
]);

function deriveProductionResponsibilities(inventory, options = {}) {
  const productions = requireArray(inventory?.productions, 'inventory productions');
  const effectiveRuleById = new Map(
    requireArray(inventory?.grammar?.effectiveRules, 'inventory effective rules')
      .map((rule) => [String(rule?.id || ''), rule])
  );
  const semanticTypeById = new Map(
    requireArray(inventory?.semanticTypes, 'inventory semantic types')
      .map((item) => [String(item?.semanticTypeId || ''), item])
  );
  const classifier = typeof options.capabilityClassifier === 'function'
    ? options.capabilityClassifier
    : classifyCapabilityAreas;

  return productions.map((production) => {
    const productionId = String(production?.productionId || '');
    const effectiveRule = effectiveRuleById.get(productionId);
    if (!productionId || !effectiveRule) {
      throw new Error(`Inventory production has no matching effective rule: ${productionId}`);
    }
    const semanticType = semanticTypeById.get(production.semanticTypeId) || null;
    const capabilityAreaIds = uniqueStrings(classifier({
      production,
      semanticType,
      effectiveRule,
      inventory
    }));
    if (capabilityAreaIds.length === 0) capabilityAreaIds.push('P0');
    const responsibilityKind = classifyResponsibilityKind(production);
    const directLiterals = uniqueStrings(production.directLiterals || []);
    const referencedProductionIds = uniqueStrings(production.referencedProductionIds || []);

    return {
      responsibilityId: `language-responsibility:${productionId}`,
      productionId,
      responsibilityKind,
      reviewStatus: 'derived',
      capabilityAreaIds,
      sourceBinding: {
        sourceId: String(production.sourceId || ''),
        sourcePath: normalizePath(production.sourcePath),
        lineStart: production.lineStart,
        lineEnd: production.lineEnd,
        bodyHash: String(effectiveRule.bodyHash || ''),
        sourceSha256: String(effectiveRule.source?.sha256 || ''),
        normalizedSourceSha256: String(effectiveRule.source?.normalizedSha256 || '')
      },
      grammarBinding: {
        grammarKind: String(production.kind || ''),
        directLiterals,
        referencedProductionIds
      },
      semanticBinding: {
        semanticTypeId: production.semanticTypeId || null,
        semanticTypeName: semanticType?.name || null,
        returnType: production.returnType || null
      },
      knowledgeStatement: {
        statementType: 'official_reference_implementation_fact',
        authorityLevel: 'C1',
        text: buildKnowledgeStatement({
          production,
          semanticType,
          responsibilityKind,
          directLiterals,
          referencedProductionIds
        })
      },
      properties: {
        evaluatorId: EVALUATOR_ID,
        mappingMethod: 'deterministic-inventory-classification-v2',
        normativeClaimAssignment: 'not_derived_capability_level_review_required',
        semanticReviewRequired: true
      }
    };
  });
}

function createProductionResponsibilityManifest(inventory, options = {}) {
  const responsibilities = deriveProductionResponsibilities(inventory, options);
  const manifest = {
    schemaVersion: RESPONSIBILITY_SCHEMA_VERSION,
    evaluatorId: EVALUATOR_ID,
    inventoryId: String(inventory?.inventoryId || ''),
    inventoryContentHash: String(inventory?.contentHash || ''),
    productionSetHash: productionSetHash(inventory?.productions || []),
    generationStatus: 'DERIVED_REQUIRES_SEMANTIC_REVIEW',
    capabilityAreas: Object.values(CAPABILITY_AREAS),
    responsibilities
  };
  return { ...manifest, responsibilitySetHash: hashCanonical(responsibilities) };
}

function evaluateLanguageKnowledgeization({ inventory, responsibilityManifest, projection }) {
  const productions = requireArray(inventory?.productions, 'inventory productions');
  const semanticTypes = requireArray(inventory?.semanticTypes, 'inventory semantic types');
  const lexemes = requireArray(inventory?.lexemes, 'inventory lexemes');
  const responsibilities = requireArray(
    responsibilityManifest?.responsibilities || responsibilityManifest,
    'production responsibilities'
  );
  const records = normalizeProjection(projection);
  const gaps = [];
  const productionById = new Map(productions.map((item) => [String(item.productionId || ''), item]));
  const effectiveRuleById = new Map(
    requireArray(inventory?.grammar?.effectiveRules, 'inventory effective rules')
      .map((item) => [String(item?.id || ''), item])
  );
  const semanticTypeById = new Map(semanticTypes.map((item) => [String(item.semanticTypeId || ''), item]));
  const nodeById = new Map(records.nodes.map((item) => [String(item.nodeId || ''), item]));
  const edgeKeys = new Set(records.edges.map(edgeKey));
  const returnEdgesByProduction = groupBy(
    records.edges.filter((edge) => edge.predicate === 'RETURNS_TYPE'),
    (edge) => edge.sourceNodeId
  );
  const referenceEdgesByProduction = groupBy(
    records.edges.filter((edge) => edge.predicate === 'REFERENCES_PRODUCTION'),
    (edge) => edge.sourceNodeId
  );
  const lexemesByValue = groupBy(lexemes, (item) => item.value);
  const responsibilityGroups = groupBy(responsibilities, (item) => item?.productionId);
  const responsibilityIdCounts = countBy(responsibilities, (item) => item?.responsibilityId);
  const capabilityAreaIds = new Set(Object.keys(CAPABILITY_AREAS));
  const concreteKnowledgeBindingRequired = !Array.isArray(responsibilityManifest)
    && responsibilityManifest?.generationStatus === 'DERIVED_KNOWLEDGEIZED_REVIEW_REQUIRED';

  let responsibilityPassed = 0;
  let projectionPassed = 0;
  let sourcePassed = 0;
  let capabilityPassed = 0;

  const manifestGapCount = gaps.length;
  if (!Array.isArray(responsibilityManifest)) {
    if (responsibilityManifest?.schemaVersion !== RESPONSIBILITY_SCHEMA_VERSION) {
      addGap(gaps, null, 'RESPONSIBILITY_SCHEMA_MISMATCH');
    }
    if (responsibilityManifest?.evaluatorId !== EVALUATOR_ID) {
      addGap(gaps, null, 'RESPONSIBILITY_EVALUATOR_MISMATCH');
    }
    if (responsibilityManifest?.inventoryId !== inventory?.inventoryId) {
      addGap(gaps, null, 'RESPONSIBILITY_INVENTORY_MISMATCH');
    }
    if (responsibilityManifest?.inventoryContentHash !== inventory?.contentHash) {
      addGap(gaps, null, 'RESPONSIBILITY_INVENTORY_HASH_MISMATCH');
    }
    if (responsibilityManifest?.productionSetHash !== productionSetHash(productions)) {
      addGap(gaps, null, 'RESPONSIBILITY_PRODUCTION_SET_HASH_MISMATCH');
    }
    if (responsibilityManifest?.responsibilitySetHash !== hashCanonical(responsibilities)) {
      addGap(gaps, null, 'RESPONSIBILITY_SET_HASH_MISMATCH');
    }
  }
  const manifestValid = gaps.length === manifestGapCount;

  const responsibilityCollectionGapCount = gaps.length;
  for (const responsibility of responsibilities) {
    const productionId = String(responsibility?.productionId || '');
    if (!productionById.has(productionId)) {
      addGap(gaps, productionId || null, 'UNKNOWN_RESPONSIBILITY_PRODUCTION');
    }
    if (!String(responsibility?.responsibilityId || '')) {
      addGap(gaps, productionId || null, 'MISSING_RESPONSIBILITY_ID');
    } else if (responsibilityIdCounts.get(responsibility.responsibilityId) > 1) {
      addGap(gaps, productionId || null, 'DUPLICATE_RESPONSIBILITY_ID', {
        responsibilityId: responsibility.responsibilityId
      });
    }
  }
  const responsibilityCollectionValid = gaps.length === responsibilityCollectionGapCount;

  for (const production of productions) {
    const productionId = production.productionId;
    const groupedResponsibilities = responsibilityGroups.get(productionId) || [];
    const responsibility = groupedResponsibilities[0] || null;

    const responsibilityGapCount = gaps.length;
    if (groupedResponsibilities.length === 0) {
      addGap(gaps, productionId, 'MISSING_RESPONSIBILITY');
    } else if (groupedResponsibilities.length > 1) {
      addGap(gaps, productionId, 'DUPLICATE_PRODUCTION_RESPONSIBILITY', {
        count: groupedResponsibilities.length
      });
    }
    if (responsibility) {
      if (responsibilityIdCounts.get(responsibility.responsibilityId) > 1) {
        addGap(gaps, productionId, 'DUPLICATE_RESPONSIBILITY_ID', {
          responsibilityId: responsibility.responsibilityId
        });
      }
      if (!RESPONSIBILITY_KINDS.includes(responsibility.responsibilityKind)) {
        addGap(gaps, productionId, 'INVALID_RESPONSIBILITY_KIND', {
          responsibilityKind: responsibility.responsibilityKind || null
        });
      }
      if (!['derived', 'reviewed'].includes(responsibility.reviewStatus)) {
        addGap(gaps, productionId, 'INVALID_RESPONSIBILITY_REVIEW_STATUS');
      }
    }
    if (gaps.length === responsibilityGapCount) responsibilityPassed += 1;

    const sourceGapCount = gaps.length;
    validateSourceBinding({
      gaps,
      production,
      responsibility,
      effectiveRule: effectiveRuleById.get(productionId)
    });
    if (gaps.length === sourceGapCount) sourcePassed += 1;

    const capabilityGapCount = gaps.length;
    if (!responsibility || !Array.isArray(responsibility.capabilityAreaIds)
      || responsibility.capabilityAreaIds.length === 0) {
      addGap(gaps, productionId, 'MISSING_CAPABILITY_BINDING');
    } else {
      const uniqueAreas = uniqueStrings(responsibility.capabilityAreaIds);
      if (uniqueAreas.length !== responsibility.capabilityAreaIds.length
        || uniqueAreas.some((areaId) => !capabilityAreaIds.has(areaId))) {
        addGap(gaps, productionId, 'INVALID_CAPABILITY_BINDING', {
          capabilityAreaIds: responsibility.capabilityAreaIds
        });
      }
      if (responsibility.knowledgeStatement?.authorityLevel !== 'C1'
        || responsibility.knowledgeStatement?.statementType !== 'official_reference_implementation_fact'
        || !String(responsibility.knowledgeStatement?.text || '').trim()) {
        addGap(gaps, productionId, 'INVALID_IMPLEMENTATION_KNOWLEDGE_STATEMENT');
      }
      if (concreteKnowledgeBindingRequired) {
        if (!nonEmptyUniqueStringArray(responsibility.capabilityUnitIds)) {
          addGap(gaps, productionId, 'INVALID_CAPABILITY_UNIT_BINDING');
        }
        if (!nonEmptyUniqueStringArray(responsibility.normativeClaimIds)) {
          addGap(gaps, productionId, 'INVALID_NORMATIVE_CLAIM_BINDING');
        }
        if (!Array.isArray(responsibility.modelUserObjectiveIds)
          || uniqueStrings(responsibility.modelUserObjectiveIds).length !== responsibility.modelUserObjectiveIds.length) {
          addGap(gaps, productionId, 'INVALID_MODEL_USER_OBJECTIVE_BINDING');
        }
      }
      if (responsibility.reviewStatus === 'derived'
        && responsibility.properties?.semanticReviewRequired !== true) {
        addGap(gaps, productionId, 'DERIVED_RESPONSIBILITY_MISSING_REVIEW_REQUIREMENT');
      }
    }
    if (gaps.length === capabilityGapCount) capabilityPassed += 1;

    const projectionGapCount = gaps.length;
    validateProjection({
      gaps,
      production,
      responsibility,
      inventoryId: inventory.inventoryId,
      semanticTypeById,
      lexemesByValue,
      nodeById,
      edgeKeys,
      returnEdgesByProduction,
      referenceEdgesByProduction
    });
    if (gaps.length === projectionGapCount) projectionPassed += 1;
  }

  const denominator = productions.length;
  const manifestFailure = !manifestValid;
  const gates = {
    productionResponsibilityCompleteness: gate(
      responsibilityPassed,
      denominator,
      manifestFailure || !responsibilityCollectionValid
    ),
    productionProjectionIntegrity: gate(projectionPassed, denominator),
    productionSourceBinding: gate(sourcePassed, denominator),
    productionCapabilityBinding: gate(capabilityPassed, denominator)
  };
  const status = Object.values(gates).every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
  const capabilityCounts = Object.fromEntries(Object.keys(CAPABILITY_AREAS).map((areaId) => [
    areaId,
    responsibilities.filter((item) => (item.capabilityAreaIds || []).includes(areaId)).length
  ]));
  const result = {
    schemaVersion: 'sysml-language-knowledgeization-report/v2',
    evaluatorId: EVALUATOR_ID,
    status,
    inventoryId: inventory?.inventoryId || null,
    counts: {
      productions: denominator,
      responsibilities: responsibilities.length,
      responsibilityKinds: countObject(responsibilities, (item) => item.responsibilityKind),
      capabilityAreas: capabilityCounts,
      gaps: gaps.length
    },
    gates,
    gaps,
    responsibilitySetHash: hashCanonical(responsibilities),
    productionSetHash: productionSetHash(productions)
  };
  return { ...result, resultHash: hashCanonical(result) };
}

function validateSourceBinding({ gaps, production, responsibility, effectiveRule }) {
  const productionId = production.productionId;
  if (!responsibility || !effectiveRule) {
    addGap(gaps, productionId, 'MISSING_SOURCE_BINDING');
    return;
  }
  const binding = responsibility.sourceBinding || {};
  const expected = {
    sourceId: String(production.sourceId || ''),
    sourcePath: normalizePath(production.sourcePath),
    lineStart: production.lineStart,
    lineEnd: production.lineEnd,
    bodyHash: String(effectiveRule.bodyHash || ''),
    sourceSha256: String(effectiveRule.source?.sha256 || ''),
    normalizedSourceSha256: String(effectiveRule.source?.normalizedSha256 || '')
  };
  if (!expected.bodyHash || !expected.sourceSha256 || !expected.normalizedSourceSha256) {
    addGap(gaps, productionId, 'INVENTORY_SOURCE_BINDING_INCOMPLETE');
    return;
  }
  for (const [field, value] of Object.entries(expected)) {
    const actual = field === 'sourcePath' ? normalizePath(binding[field]) : binding[field];
    if (actual !== value) {
      addGap(gaps, productionId, 'SOURCE_BINDING_MISMATCH', {
        field,
        expected: value,
        actual: actual ?? null
      });
    }
  }
}

function validateProjection({
  gaps,
  production,
  responsibility,
  inventoryId,
  semanticTypeById,
  lexemesByValue,
  nodeById,
  edgeKeys,
  returnEdgesByProduction,
  referenceEdgesByProduction
}) {
  const productionId = production.productionId;
  const projectionNodeId = String(responsibility?.projectionNodeId || productionId);
  const projectionPrefix = projectionNodeId.endsWith(productionId)
    ? projectionNodeId.slice(0, projectionNodeId.length - productionId.length)
    : '';
  const projectNodeId = (nodeId) => `${projectionPrefix}${nodeId}`;
  const node = nodeById.get(projectionNodeId);
  if (!node || node.nodeKind !== 'grammar_production') {
    addGap(gaps, productionId, 'MISSING_PRODUCTION_NODE');
  } else {
    const properties = node.properties || {};
    const nodeBinding = {
      name: node.name,
      sourcePath: normalizePath(properties.sourcePath),
      lineStart: properties.lineStart,
      lineEnd: properties.lineEnd,
      grammarKind: properties.grammarKind,
      provenanceKind: properties.provenanceKind,
      languageInventoryId: properties.languageInventoryId
    };
    const expected = {
      name: production.name,
      sourcePath: normalizePath(production.sourcePath),
      lineStart: production.lineStart,
      lineEnd: production.lineEnd,
      grammarKind: production.kind,
      provenanceKind: production.provenanceKind,
      languageInventoryId: inventoryId
    };
    if (canonicalJson(nodeBinding) !== canonicalJson(expected)) {
      addGap(gaps, productionId, 'PRODUCTION_NODE_BINDING_MISMATCH');
    }
    const registeredSourceId = responsibility?.sourceBinding?.registeredSourceId;
    if (registeredSourceId && node.sourceId !== registeredSourceId) {
      addGap(gaps, productionId, 'PRODUCTION_NODE_SOURCE_MISMATCH', {
        expectedSourceId: registeredSourceId,
        actualSourceId: node.sourceId || null
      });
    } else if (!String(node.sourceId || '').trim()) {
      addGap(gaps, productionId, 'MISSING_PRODUCTION_NODE_SOURCE');
    }
  }

  const expectedReferenceTargetIds = uniqueStrings(production.referencedProductionIds || [])
    .map(projectNodeId)
    .sort();
  const actualReferenceTargetIds = uniqueStrings(
    (referenceEdgesByProduction.get(projectionNodeId) || []).map((edge) => edge.targetNodeId)
  ).sort();
  if (canonicalJson(actualReferenceTargetIds) !== canonicalJson(expectedReferenceTargetIds)) {
    addGap(gaps, productionId, 'PRODUCTION_REFERENCE_SET_MISMATCH', {
      expectedTargetProductionIds: expectedReferenceTargetIds,
      actualTargetProductionIds: actualReferenceTargetIds
    });
  }
  for (const targetId of uniqueStrings(production.referencedProductionIds || [])) {
    if (!edgeKeys.has(edgeKey({
      sourceNodeId: projectionNodeId,
      predicate: 'REFERENCES_PRODUCTION',
      targetNodeId: projectNodeId(targetId)
    }))) {
      addGap(gaps, productionId, 'MISSING_PRODUCTION_REFERENCE_EDGE', { targetProductionId: targetId });
    }
  }

  for (const value of uniqueStrings(production.directLiterals || [])) {
    const matchingLexemes = (lexemesByValue.get(value) || [])
      .filter((lexeme) => (lexeme.productionIds || []).includes(productionId));
    if (matchingLexemes.length === 0) {
      addGap(gaps, productionId, 'MISSING_INVENTORY_LEXEME', { value });
      continue;
    }
    for (const lexeme of matchingLexemes) {
      const lexemeNodeId = projectNodeId(lexeme.lexemeId);
      if (!nodeById.has(lexemeNodeId)) {
        addGap(gaps, productionId, 'MISSING_LEXEME_NODE', { lexemeId: lexeme.lexemeId, value });
      }
      if (!edgeKeys.has(edgeKey({
        sourceNodeId: lexemeNodeId,
        predicate: 'OCCURS_IN',
        targetNodeId: projectionNodeId
      }))) {
        addGap(gaps, productionId, 'MISSING_LEXEME_OCCURRENCE_EDGE', {
          lexemeId: lexeme.lexemeId,
          value
        });
      }
    }
  }

  if (production.semanticTypeId) {
    const semanticType = semanticTypeById.get(production.semanticTypeId);
    const returnEdges = returnEdgesByProduction.get(projectionNodeId) || [];
    const matchingReturn = returnEdges.find((edge) => {
      const target = nodeById.get(edge.targetNodeId);
      return target && (target.properties?.semanticTypeId === production.semanticTypeId
        || target.name === semanticType?.name);
    });
    if (!semanticType || !matchingReturn) {
      addGap(gaps, productionId, 'MISSING_SEMANTIC_RETURN_PROJECTION', {
        semanticTypeId: production.semanticTypeId
      });
    }
  }
}

function classifyResponsibilityKind(production) {
  const kind = String(production?.kind || '');
  const name = String(production?.name || '');
  const sourceId = String(production?.sourceId || '');
  if (kind === 'terminal') return 'lexer_terminal';
  if (kind === 'enum') return 'enum_alternative';
  if (/expressions?/iu.test(sourceId)
    || /(?:expression|operator|operand|literal|qualifiedname|^name$)/iu.test(name)) {
    return 'expression_infrastructure';
  }
  if (production?.semanticTypeId) return 'semantic_construct';
  if (/keyword$/iu.test(name)
    || (production?.directLiterals || []).length > 0
    || (production?.referencedProductionIds || []).some((item) => /keyword$/iu.test(String(item)))) {
    return 'keyword_dispatch';
  }
  return 'grammar_composition';
}

function classifyCapabilityAreas({ production, semanticType }) {
  const primary = [
    production?.name,
    production?.returnType,
    semanticType?.name,
    ...(production?.directLiterals || [])
  ].filter(Boolean).join(' ');
  const primaryMatches = CAPABILITY_PROFILES
    .filter((profile) => profile.pattern.test(primary))
    .map((profile) => profile.areaId);
  if (primaryMatches.length > 0) return uniqueStrings(primaryMatches);

  const references = (production?.referencedProductionIds || [])
    .map((value) => String(value).replace(/^.*:/u, ''))
    .join(' ');
  const referenceMatches = CAPABILITY_PROFILES
    .filter((profile) => profile.pattern.test(references))
    .map((profile) => profile.areaId);
  return referenceMatches.length > 0 ? uniqueStrings(referenceMatches) : ['P0'];
}

function buildKnowledgeStatement({
  production,
  semanticType,
  responsibilityKind,
  directLiterals,
  referencedProductionIds
}) {
  const facts = [
    `${production.name} 是一条 ${production.kind} grammar production`,
    semanticType ? `参考实现返回目标为 ${semanticType.name}` : '没有显式 semantic return 目标',
    directLiterals.length > 0 ? `直接字面量为 ${directLiterals.map((item) => JSON.stringify(item)).join(', ')}` : '没有直接字面量',
    referencedProductionIds.length > 0 ? `引用 ${referencedProductionIds.length} 条其他 production` : '不引用其他 production'
  ];
  return `${facts.join('；')}。责任类型为 ${responsibilityKind}；这是 C1 级官方参考实现事实，不等同于 A1/A2 规范语义 Claim。`;
}

function normalizeProjection(projection) {
  const source = projection?.records || projection || {};
  return {
    nodes: source['nodes.jsonl'] || source.nodes || [],
    edges: source['edges.jsonl'] || source.edges || []
  };
}

function productionSetHash(productions) {
  return hashCanonical(requireArray(productions, 'inventory productions')
    .map((item) => typeof item === 'string' ? item : item?.productionId)
    .map((item) => String(item || ''))
    .sort());
}

function gate(numerator, denominator, forcedFailure = false) {
  const safeDenominator = Number(denominator) || 0;
  const safeNumerator = Math.max(0, Math.min(Number(numerator) || 0, safeDenominator));
  return {
    numerator: safeNumerator,
    denominator: safeDenominator,
    ratio: safeDenominator > 0 ? safeNumerator / safeDenominator : null,
    status: !forcedFailure && safeDenominator > 0 && safeNumerator === safeDenominator ? 'PASS' : 'FAIL'
  };
}

function addGap(gaps, productionId, code, details = {}) {
  gaps.push({ productionId, code, ...details });
}

function groupBy(items, selector) {
  const result = new Map();
  for (const item of items || []) {
    const key = selector(item);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(item);
  }
  return result;
}

function countBy(items, selector) {
  const result = new Map();
  for (const item of items || []) {
    const key = selector(item);
    result.set(key, (result.get(key) || 0) + 1);
  }
  return result;
}

function countObject(items, selector) {
  const counts = {};
  for (const item of items || []) {
    const key = String(selector(item) || 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right, 'en')));
}

function edgeKey(edge) {
  return `${edge?.sourceNodeId || ''}\u0000${edge?.predicate || ''}\u0000${edge?.targetNodeId || ''}`;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((item) => String(item || '')).filter(Boolean))];
}

function nonEmptyUniqueStringArray(values) {
  return Array.isArray(values)
    && values.length > 0
    && uniqueStrings(values).length === values.length;
}

function normalizePath(value) {
  return String(value || '').replace(/\\/gu, '/');
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashCanonical(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

module.exports = {
  CAPABILITY_AREAS,
  EVALUATOR_ID,
  RESPONSIBILITY_KINDS,
  RESPONSIBILITY_SCHEMA_VERSION,
  canonicalJson,
  classifyCapabilityAreas,
  classifyResponsibilityKind,
  createProductionResponsibilityManifest,
  deriveProductionResponsibilities,
  evaluateLanguageKnowledgeization,
  hashCanonical,
  productionSetHash
};
