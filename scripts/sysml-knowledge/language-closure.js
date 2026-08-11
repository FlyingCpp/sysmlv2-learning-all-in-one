'use strict';

const crypto = require('crypto');

const DISPOSITIONS = Object.freeze([
  'covered',
  'out_of_scope',
  'lexer_only',
  'helper_production',
  'deferred_with_reason',
  'implementation_only'
]);

const REASON_REQUIRED = new Set([
  'out_of_scope',
  'deferred_with_reason',
  'implementation_only'
]);
const FIXTURE_KINDS = new Set([
  'positive',
  'syntax_negative',
  'semantic_negative',
  'confusion'
]);

function resolveScope(inventory, scopeManifest) {
  if (scopeManifest?.inventoryId && scopeManifest.inventoryId !== inventory?.inventoryId) {
    throw new Error(`Scope inventoryId does not match inventory: ${scopeManifest.inventoryId}`);
  }
  const productions = requireArray(inventory?.productions, 'inventory productions');
  const productionById = uniqueMap(productions, 'productionId', 'inventory production');
  validateDefaultDispositionLock(inventory, scopeManifest, productions);
  const entries = requireArray(scopeManifest?.entries, 'scope entries');
  const explicitById = new Map();

  for (const entry of entries) {
    const productionId = String(entry?.productionId || '');
    if (!productionById.has(productionId)) {
      throw new Error(`Scope references unknown inventory production: ${productionId}`);
    }
    if (explicitById.has(productionId)) {
      throw new Error(`Scope has duplicate disposition for production: ${productionId}`);
    }
    explicitById.set(productionId, entry);
  }

  const defaultDisposition = scopeManifest?.defaultDisposition;
  const resolved = productions.map((production) => {
    const selected = explicitById.get(production.productionId) || defaultDisposition;
    if (!selected) {
      throw new Error(`Scope has missing disposition for production: ${production.productionId}`);
    }
    const item = {
      productionId: production.productionId,
      disposition: selected.disposition,
      reason: selected.reason || '',
      coverageUnits: clone(selected.coverageUnits || []),
      sourceLocator: {
        sourceId: production.sourceId,
        sourcePath: production.sourcePath,
        lineStart: production.lineStart,
        lineEnd: production.lineEnd
      },
      explicit: explicitById.has(production.productionId)
    };
    validateDisposition(item, production);
    return item;
  });

  const coverageUnitIds = new Set();
  for (const item of resolved) {
    for (const unit of item.coverageUnits) {
      if (!String(unit?.coverageUnitId || '').trim()) {
        throw new Error(`Covered production ${item.productionId} has a coverage unit without coverageUnitId`);
      }
      if (coverageUnitIds.has(unit.coverageUnitId)) {
        throw new Error(`Duplicate coverageUnitId: ${unit.coverageUnitId}`);
      }
      coverageUnitIds.add(unit.coverageUnitId);
      if (unit.grammarProductionId !== item.productionId) {
        throw new Error(`Coverage unit ${unit.coverageUnitId} must bind to its scoped grammarProductionId`);
      }
      if (!String(unit.semanticNodeId || '').trim()) {
        throw new Error(`Coverage unit ${unit.coverageUnitId} requires semanticNodeId`);
      }
      if (!Array.isArray(unit.lexemeAssertions) || unit.lexemeAssertions.length === 0) {
        throw new Error(`Coverage unit ${unit.coverageUnitId} requires lexemeAssertions`);
      }
      if (!Array.isArray(unit.claimIds) || unit.claimIds.length === 0) {
        throw new Error(`Coverage unit ${unit.coverageUnitId} requires claimIds`);
      }
      if (unit.requiredFixtureKinds !== undefined) {
        if (!Array.isArray(unit.requiredFixtureKinds) || unit.requiredFixtureKinds.length === 0) {
          throw new Error(`Coverage unit ${unit.coverageUnitId} requiredFixtureKinds must be a non-empty array`);
        }
        const uniqueKinds = new Set(unit.requiredFixtureKinds);
        if (uniqueKinds.size !== unit.requiredFixtureKinds.length
          || unit.requiredFixtureKinds.some((kind) => !FIXTURE_KINDS.has(kind))) {
          throw new Error(`Coverage unit ${unit.coverageUnitId} has invalid or duplicate requiredFixtureKinds`);
        }
      }
    }
  }

  return resolved;
}

function validateDisposition(item, production) {
  if (!DISPOSITIONS.includes(item.disposition)) {
    throw new Error(`Invalid scope disposition for ${item.productionId}: ${item.disposition || ''}`);
  }
  if (REASON_REQUIRED.has(item.disposition) && !String(item.reason || '').trim()) {
    throw new Error(`Scope disposition ${item.disposition} requires a reason for ${item.productionId}`);
  }
  if (item.disposition === 'covered' && item.coverageUnits.length === 0) {
    throw new Error(`Covered production requires coverageUnits: ${item.productionId}`);
  }
  if (item.disposition !== 'covered' && item.coverageUnits.length > 0) {
    throw new Error(`Only covered productions may declare coverageUnits: ${item.productionId}`);
  }
  if (item.disposition === 'lexer_only' && production.kind !== 'terminal') {
    throw new Error(`lexer_only disposition requires a terminal production: ${item.productionId}`);
  }
  if (item.disposition === 'helper_production' && production.semanticTypeId) {
    throw new Error(`helper_production cannot have a semantic return target: ${item.productionId}`);
  }
  if (item.disposition === 'implementation_only'
    && production.provenanceKind !== 'official_reference_implementation') {
    throw new Error(`implementation_only requires implementation provenance: ${item.productionId}`);
  }
}

function validateDefaultDispositionLock(inventory, scopeManifest, productions) {
  const defaultDisposition = scopeManifest?.defaultDisposition;
  if (!defaultDisposition) return;

  const expectedInventoryHash = String(defaultDisposition.inventoryContentHash || '');
  const expectedProductionSetHash = String(defaultDisposition.productionSetHash || '');
  if (!expectedInventoryHash || !expectedProductionSetHash) {
    throw new Error('defaultDisposition requires inventoryContentHash and productionSetHash locks');
  }
  const declaredInventoryHash = String(inventory?.contentHash || '');
  if (!declaredInventoryHash) {
    throw new Error('Inventory contentHash is required when defaultDisposition is used');
  }
  const inventoryPayload = { ...inventory };
  delete inventoryPayload.contentHash;
  const actualInventoryHash = hashCanonical(inventoryPayload);
  if (declaredInventoryHash !== actualInventoryHash) {
    throw new Error(`Inventory contentHash does not match inventory content: ${declaredInventoryHash}`);
  }
  if (expectedInventoryHash !== actualInventoryHash) {
    throw new Error(`defaultDisposition inventoryContentHash lock mismatch: ${expectedInventoryHash}`);
  }
  const actualProductionSetHash = productionSetHash(productions);
  if (expectedProductionSetHash !== actualProductionSetHash) {
    throw new Error(`defaultDisposition productionSetHash lock mismatch: ${expectedProductionSetHash}`);
  }
}

function productionSetHash(productions) {
  const productionIds = requireArray(productions, 'inventory productions')
    .map((production) => typeof production === 'string' ? production : production?.productionId)
    .map((productionId) => String(productionId || ''))
    .sort();
  return hashCanonical(productionIds);
}

function evaluateLanguageClosure({ inventory, scopeManifest, bundle, fixtureCatalog, validatorReport }) {
  const resolvedScope = resolveScope(inventory, scopeManifest);
  const coverageUnits = resolvedScope
    .filter((item) => item.disposition === 'covered')
    .flatMap((item) => item.coverageUnits.map((unit) => ({ ...unit, scopeProductionId: item.productionId })));
  const normalized = normalizeBundle(bundle);
  const gaps = [];
  const inventoryErrors = validateInventory(inventory);
  const productionById = new Map(inventory.productions.map((item) => [item.productionId, item]));
  const lexemeById = new Map(inventory.lexemes.map((item) => [item.lexemeId, item]));
  const lexemesByValue = groupBy(inventory.lexemes, (item) => item.value);
  const nodeById = new Map(normalized.nodes.map((item) => [item.nodeId, item]));
  const claimById = new Map(normalized.claims.map((item) => [item.claimId, item]));
  const evidenceById = new Map(normalized.evidenceBlocks.map((item) => [item.evidenceId, item]));
  const fixtureById = uniqueMap(
    requireArray(fixtureCatalog?.fixtures, 'fixture catalog fixtures'),
    'fixtureId',
    'fixture'
  );
  const runByFixtureId = uniqueMap(
    requireArray(validatorReport?.results, 'validator report results'),
    'fixtureId',
    'validator result'
  );

  const semanticPassed = new Set();
  const fixturePassed = new Set();

  for (const unit of coverageUnits) {
    const semanticGapCount = gaps.length;
    const parserFixtureIds = new Set();
    let parserFixtureMappingMissing = false;
    const production = productionById.get(unit.grammarProductionId);
    if (!production) {
      addGap(gaps, unit, 'MISSING_PRODUCTION', { grammarProductionId: unit.grammarProductionId });
    }
    if (!nodeById.has(unit.grammarProductionId)) {
      addGap(gaps, unit, 'MISSING_GRAMMAR_NODE', { grammarProductionId: unit.grammarProductionId });
    }
    if (!nodeById.has(unit.semanticNodeId)) {
      addGap(gaps, unit, 'MISSING_SEMANTIC_NODE', { semanticNodeId: unit.semanticNodeId });
    }
    if (!hasReviewedContextEdge(normalized.edges, unit)) {
      addGap(gaps, unit, 'MISSING_PRODUCTION_SEMANTIC_EDGE', {
        grammarProductionId: unit.grammarProductionId,
        semanticNodeId: unit.semanticNodeId,
        reviewedContextProjection: false
      });
    }

    for (const assertion of unit.lexemeAssertions) {
      const holders = resolveLexemeHolders({
        assertion,
        production,
        productionById,
        lexemeById,
        lexemesByValue
      });
      if (holders.length === 0) {
        addGap(gaps, unit, 'MISSING_LEXEME_OCCURRENCE', { token: assertion.value });
      } else if (!holders.some((holder) => hasEdge(
        normalized.edges,
        holder.lexemeId,
        holder.productionId,
        'OCCURS_IN'
      ))) {
        addGap(gaps, unit, 'MISSING_LEXEME_OCCURRENCE', {
          token: assertion.value,
          projected: false
        });
      }

      const mappingProductionId = assertion.mappingProductionId || unit.grammarProductionId;
      const mapping = normalized.syntaxMappings.find((item) => item.token === assertion.value
        && item.grammarProductionId === mappingProductionId
        && item.astContextId === unit.astContextId
        && item.semanticNodeId === unit.semanticNodeId
        && item.mappingType === 'CONSTRUCTS_IN_CONTEXT'
        && item.properties?.coverageUnitId === unit.coverageUnitId
        && item.properties?.alternativePath === unit.alternativePath);
      if (!mapping) {
        addGap(gaps, unit, 'MISSING_CONTEXT_MAPPING', {
          token: assertion.value,
          grammarProductionId: mappingProductionId,
          astContextId: unit.astContextId,
          semanticNodeId: unit.semanticNodeId
        });
        parserFixtureMappingMissing = true;
      } else if (!String(mapping.parserFixtureId || '').trim()) {
        parserFixtureMappingMissing = true;
      } else {
        parserFixtureIds.add(mapping.parserFixtureId);
      }
    }

    for (const claimId of unit.claimIds) {
      const claim = claimById.get(claimId);
      if (!claim) {
        addGap(gaps, unit, 'MISSING_CLAIM', { claimId });
        continue;
      }
      if (claim.subjectNodeId !== unit.semanticNodeId) {
        addGap(gaps, unit, 'CLAIM_SUBJECT_MISMATCH', {
          claimId,
          expectedSubjectNodeId: unit.semanticNodeId,
          actualSubjectNodeId: claim.subjectNodeId || null
        });
      }
      if (claim.predicate !== 'PARSED_BY') {
        addGap(gaps, unit, 'CLAIM_PREDICATE_MISMATCH', {
          claimId,
          expectedPredicate: 'PARSED_BY',
          actualPredicate: claim.predicate || null
        });
      }
      if (claim.objectNodeId !== unit.grammarProductionId) {
        addGap(gaps, unit, 'CLAIM_OBJECT_MISMATCH', {
          claimId,
          expectedObjectNodeId: unit.grammarProductionId,
          actualObjectNodeId: claim.objectNodeId || null
        });
      }
      const claimCoverageUnitIds = claim.properties?.coverageUnitIds || claim.coverageUnitIds || [];
      if (!claimCoverageUnitIds.includes(unit.coverageUnitId)) {
        addGap(gaps, unit, 'CLAIM_COVERAGE_UNIT_MISMATCH', { claimId });
      }
      if (!(claim.astContextIds || []).includes(unit.astContextId)) {
        addGap(gaps, unit, 'CLAIM_CONTEXT_MISMATCH', {
          claimId,
          expectedAstContextId: unit.astContextId
        });
      }
      const requiredOperators = coverageUnitOperators(unit);
      if (!includesAll(claim.operators, requiredOperators)) {
        addGap(gaps, unit, 'CLAIM_OPERATOR_MISMATCH', {
          claimId,
          expectedOperators: requiredOperators
        });
      }
      const evidenceIds = [...new Set(claim.evidenceIds || [])];
      if (evidenceIds.length === 0) {
        addGap(gaps, unit, 'MISSING_EVIDENCE', { claimId });
      }
      const existingEvidence = [];
      for (const evidenceId of evidenceIds) {
        const evidence = evidenceById.get(evidenceId);
        if (!evidence) {
          addGap(gaps, unit, 'MISSING_EVIDENCE', { claimId, evidenceId });
        } else {
          existingEvidence.push(evidence);
        }
      }
      if (existingEvidence.length > 0
        && !existingEvidence.some((evidence) => evidenceCoversUnit(evidence, unit))) {
        addGap(gaps, unit, 'EVIDENCE_NOT_BOUND_TO_COVERAGE_UNIT', {
          claimId,
          evidenceIds: existingEvidence.map((evidence) => evidence.evidenceId),
          requiredOperators
        });
      }
    }

    if (gaps.length === semanticGapCount) semanticPassed.add(unit.coverageUnitId);

    const fixtureGapCount = gaps.length;
    const linkedFixtures = [...fixtureById.values()]
      .filter((item) => (item.coverageUnitIds || []).includes(unit.coverageUnitId));
    if (parserFixtureMappingMissing || parserFixtureIds.size === 0) {
      addGap(gaps, unit, 'MISSING_PARSER_FIXTURE', {
        reason: 'context mapping has no parserFixtureId'
      });
    }
    for (const parserFixtureId of parserFixtureIds) {
      const parserFixture = fixtureById.get(parserFixtureId);
      if (!parserFixture
        || parserFixture.kind !== 'positive'
        || !(parserFixture.coverageUnitIds || []).includes(unit.coverageUnitId)) {
        addGap(gaps, unit, 'INVALID_PARSER_FIXTURE', {
          parserFixtureId,
          fixtureKind: parserFixture?.kind || null
        });
        continue;
      }
      const parserRun = runByFixtureId.get(parserFixtureId);
      if (!parserRun
        || parserRun.status !== 'PASS'
        || parserRun.fixtureKind !== 'positive'
        || !(parserRun.coverageUnitIds || []).includes(unit.coverageUnitId)
        || parserRun.validator?.syntaxValid !== true
        || parserRun.validator?.semanticValid !== true) {
        addGap(gaps, unit, 'PARSER_FIXTURE_VALIDATION_FAILED', {
          parserFixtureId,
          runStatus: parserRun?.status || null
        });
      }
    }
    const requiredFixtureKinds = Array.isArray(unit.requiredFixtureKinds)
      ? unit.requiredFixtureKinds
      : ['positive', 'negative_or_confusion'];
    for (const requiredKind of requiredFixtureKinds) {
      const matches = requiredKind === 'negative_or_confusion'
        ? linkedFixtures.filter((item) => ['syntax_negative', 'semantic_negative', 'confusion'].includes(item.kind))
        : linkedFixtures.filter((item) => item.kind === requiredKind);
      if (matches.length === 0) {
        addGap(gaps, unit, fixtureGapCode(requiredKind), { requiredFixtureKind: requiredKind });
      }
    }
    for (const fixture of linkedFixtures) {
      const run = runByFixtureId.get(fixture.fixtureId);
      if (!run) {
        addGap(gaps, unit, 'MISSING_VALIDATOR_RUN', { fixtureId: fixture.fixtureId });
      } else if (run.status !== 'PASS') {
        addGap(gaps, unit, 'ORACLE_MISMATCH', { fixtureId: fixture.fixtureId, runStatus: run.status });
      }
      if (fixture.kind === 'confusion' && !fixture.oracle) {
        addGap(gaps, unit, 'ORACLE_MISMATCH', { fixtureId: fixture.fixtureId, reason: 'confusion fixture has no oracle' });
      }
    }
    if (gaps.length === fixtureGapCount) fixturePassed.add(unit.coverageUnitId);
  }

  const productionCount = inventory.productions.length;
  const inventoryItemCount = productionCount + inventory.lexemes.length + inventory.semanticTypes.length;
  const gates = {
    languageInventory: gate(inventoryItemCount - inventoryErrors.length, inventoryItemCount),
    scopeCompleteness: gate(resolvedScope.length, productionCount),
    semanticClosure: gate(semanticPassed.size, coverageUnits.length),
    fixtureCoverage: gate(fixturePassed.size, coverageUnits.length)
  };
  for (const error of inventoryErrors) gaps.push({ coverageUnitId: null, ...error });
  const status = Object.values(gates).every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';

  return {
    schemaVersion: '1.0.0',
    status,
    inventoryId: inventory.inventoryId,
    scopeId: scopeManifest.scopeId,
    fixtureSetId: fixtureCatalog.fixtureSetId,
    validatorRunId: validatorReport.validatorRunId,
    counts: {
      productions: productionCount,
      lexemes: inventory.lexemes.length,
      semanticTypes: inventory.semanticTypes.length,
      resolvedScopeItems: resolvedScope.length,
      coveredUnits: coverageUnits.length,
      gaps: gaps.length
    },
    gates,
    gaps,
    resolvedScope,
    coverageUnits,
    resultHash: hashCanonical({ gates, gaps, resolvedScope, coverageUnits })
  };
}

function fixtureGapCode(kind) {
  if (kind === 'positive') return 'MISSING_POSITIVE_FIXTURE';
  if (kind === 'syntax_negative') return 'MISSING_SYNTAX_NEGATIVE_FIXTURE';
  if (kind === 'semantic_negative') return 'MISSING_SEMANTIC_NEGATIVE_FIXTURE';
  if (kind === 'confusion') return 'MISSING_CONFUSION_FIXTURE';
  return 'MISSING_NEGATIVE_OR_CONFUSION_FIXTURE';
}

function validateInventory(inventory) {
  const errors = [];
  for (const [items, idField, label] of [
    [inventory?.productions, 'productionId', 'production'],
    [inventory?.lexemes, 'lexemeId', 'lexeme'],
    [inventory?.semanticTypes, 'semanticTypeId', 'semantic type']
  ]) {
    if (!Array.isArray(items) || items.length === 0) {
      errors.push({ code: 'EMPTY_INVENTORY_SECTION', section: label });
      continue;
    }
    const seen = new Set();
    for (const item of items) {
      if (!String(item?.[idField] || '').trim() || seen.has(item[idField])) {
        errors.push({ code: 'DUPLICATE_OR_MISSING_INVENTORY_ID', section: label, id: item?.[idField] || '' });
      }
      seen.add(item[idField]);
    }
  }
  for (const unresolved of inventory?.integrity?.unresolvedRuleReferences || []) {
    if (!unresolved.allowedExternal) errors.push({ code: 'UNRESOLVED_RULE_REFERENCE', ...unresolved });
  }
  for (const unresolved of inventory?.integrity?.unresolvedSemanticReturns || []) {
    if (!unresolved.allowedExternal) errors.push({ code: 'UNRESOLVED_SEMANTIC_RETURN', ...unresolved });
  }
  return errors;
}

function resolveLexemeHolders({ assertion, production, productionById, lexemeById, lexemesByValue }) {
  const matchingLexemes = lexemesByValue.get(assertion.value) || [];
  if (matchingLexemes.length === 0) return [];
  const startId = assertion.occurrenceProductionId || production?.productionId;
  if (!startId) return [];
  const allowedProductionIds = assertion.occurrenceProductionId
    ? new Set([assertion.occurrenceProductionId])
    : reachableProductionIds(startId, productionById);
  const holders = [];
  for (const lexeme of matchingLexemes) {
    for (const productionId of lexeme.productionIds || []) {
      if (allowedProductionIds.has(productionId) && lexemeById.has(lexeme.lexemeId)) {
        holders.push({ lexemeId: lexeme.lexemeId, productionId });
      }
    }
  }
  return holders;
}

function reachableProductionIds(startId, productionById) {
  const visited = new Set();
  const queue = [startId];
  while (queue.length > 0) {
    const productionId = queue.shift();
    if (visited.has(productionId)) continue;
    visited.add(productionId);
    const production = productionById.get(productionId);
    for (const referencedId of production?.referencedProductionIds || []) {
      if (!visited.has(referencedId)) queue.push(referencedId);
    }
  }
  return visited;
}

function normalizeBundle(bundle) {
  const records = bundle?.records || {};
  return {
    nodes: bundle?.nodes || records['nodes.jsonl'] || [],
    edges: bundle?.edges || records['edges.jsonl'] || [],
    claims: bundle?.claims || records['claims.jsonl'] || [],
    evidenceBlocks: bundle?.evidenceBlocks || records['evidence-blocks.jsonl'] || [],
    syntaxMappings: bundle?.syntaxMappings || records['syntax-mappings.jsonl'] || []
  };
}

function coverageUnitOperators(unit) {
  return [...new Set((unit.lexemeAssertions || [])
    .map((assertion) => String(assertion?.value || ''))
    .filter(Boolean))];
}

function includesAll(actual, expected) {
  const actualValues = new Set(Array.isArray(actual) ? actual : []);
  return expected.every((value) => actualValues.has(value));
}

function hasReviewedContextEdge(edges, unit) {
  const requiredOperators = coverageUnitOperators(unit);
  return edges.some((edge) => edge.sourceNodeId === unit.grammarProductionId
    && edge.targetNodeId === unit.semanticNodeId
    && edge.predicate === 'CONSTRUCTS'
    && edge.properties?.mappingKind === 'reviewed_context_projection'
    && edge.properties?.coverageUnitId === unit.coverageUnitId
    && edge.properties?.astContextId === unit.astContextId
    && edge.properties?.alternativePath === unit.alternativePath
    && includesAll(edge.properties?.operators, requiredOperators));
}

function evidenceCoversUnit(evidence, unit) {
  return (evidence.conceptIds || []).includes(unit.semanticNodeId)
    && (evidence.astContextIds || []).includes(unit.astContextId)
    && includesAll(evidence.operators, coverageUnitOperators(unit));
}

function hasEdge(edges, sourceNodeId, targetNodeId, predicate) {
  return edges.some((edge) => edge.sourceNodeId === sourceNodeId
    && edge.targetNodeId === targetNodeId
    && edge.predicate === predicate);
}

function addGap(gaps, unit, code, details = {}) {
  gaps.push({
    coverageUnitId: unit.coverageUnitId,
    code,
    grammarProductionId: unit.grammarProductionId,
    astContextId: unit.astContextId || null,
    semanticNodeId: unit.semanticNodeId,
    ...details
  });
}

function gate(numerator, denominator) {
  const safeDenominator = Number(denominator) || 0;
  const safeNumerator = Math.max(0, Math.min(Number(numerator) || 0, safeDenominator));
  return {
    numerator: safeNumerator,
    denominator: safeDenominator,
    ratio: safeDenominator > 0 ? safeNumerator / safeDenominator : null,
    status: safeDenominator > 0 && safeNumerator === safeDenominator ? 'PASS' : 'FAIL'
  };
}

function uniqueMap(items, idField, label) {
  const result = new Map();
  for (const item of items) {
    const id = String(item?.[idField] || '');
    if (!id || result.has(id)) throw new Error(`Duplicate or missing ${label} ID: ${id}`);
    result.set(id, item);
  }
  return result;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
  DISPOSITIONS,
  canonicalJson,
  evaluateLanguageClosure,
  gate,
  hashCanonical,
  productionSetHash,
  resolveScope,
  validateInventory
};
