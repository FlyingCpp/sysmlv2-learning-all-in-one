'use strict';

const crypto = require('crypto');
const { resolveScope } = require('./language-closure');

function materializeLanguageProjection({
  inventory,
  scopeManifest,
  baseNodes = [],
  sourceIdMap = {},
  semanticNodePrefix = 'sysml20:'
}) {
  const nodes = baseNodes.map(clone);
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const nodeIdsByName = groupIdsByName(nodes);
  const semanticNodeIdByInventoryId = new Map();
  const effectiveSemanticById = new Map(
    (inventory.semanticModel?.effectiveTypes || []).map((item) => [item.id, item])
  );

  for (const semanticType of inventory.semanticTypes) {
    const matchingIds = nodeIdsByName.get(semanticType.name) || [];
    const nodeId = matchingIds.length === 1
      ? matchingIds[0]
      : `${semanticNodePrefix}${semanticType.name}`;
    semanticNodeIdByInventoryId.set(semanticType.semanticTypeId, nodeId);
    if (!nodeById.has(nodeId)) {
      const effective = effectiveSemanticById.get(semanticType.semanticTypeId);
      addNode(nodes, nodeById, {
        nodeId,
        nodeKind: semanticType.kind === 'EEnum' ? 'enum' : 'metaclass',
        name: semanticType.name,
        sourceId: sourceIdMap[effective?.source?.id] || effective?.source?.id || 'language-inventory',
        properties: {
          phase: 0,
          languageInventoryId: inventory.inventoryId,
          semanticTypeId: semanticType.semanticTypeId,
          sourcePath: effective?.source?.path || null,
          lineStart: effective?.lineSpan?.start || null,
          lineEnd: effective?.lineSpan?.end || null
        }
      });
      addNameIndex(nodeIdsByName, semanticType.name, nodeId);
    }
  }

  for (const production of inventory.productions) {
    addNode(nodes, nodeById, {
      nodeId: production.productionId,
      nodeKind: 'grammar_production',
      name: production.name,
      sourceId: sourceIdMap[production.sourceId] || production.sourceId,
      properties: {
        phase: 0,
        languageInventoryId: inventory.inventoryId,
        grammarKind: production.kind,
        returnType: production.returnType || null,
        semanticTypeId: production.semanticTypeId || null,
        sourcePath: production.sourcePath,
        lineStart: production.lineStart,
        lineEnd: production.lineEnd,
        provenanceKind: production.provenanceKind
      }
    });
  }

  for (const lexeme of inventory.lexemes) {
    addNode(nodes, nodeById, {
      nodeId: lexeme.lexemeId,
      nodeKind: 'lexeme',
      name: lexeme.value,
      properties: {
        phase: 0,
        languageInventoryId: inventory.inventoryId,
        lexical: true,
        value: lexeme.value
      }
    });
  }

  const edges = [];
  const edgeKeys = new Set();
  const addProjectionEdge = ({ sourceNodeId, targetNodeId, predicate, sourceId, properties = {} }) => {
    const contextKey = properties.mappingKind === 'reviewed_context_projection'
      ? `\u0000${properties.coverageUnitId || ''}\u0000${properties.astContextId || ''}`
      : '';
    const key = `${sourceNodeId}\u0000${predicate}\u0000${targetNodeId}${contextKey}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({
      edgeId: `edge-language-${sha256(key).slice(0, 24)}`,
      sourceNodeId,
      predicate,
      targetNodeId,
      authorityLevel: 'C1',
      sourceId,
      properties: {
        languageInventoryId: inventory.inventoryId,
        ...properties
      }
    });
  };

  for (const lexeme of inventory.lexemes) {
    for (const productionId of lexeme.productionIds) {
      const production = inventory.productions.find((item) => item.productionId === productionId);
      addProjectionEdge({
        sourceNodeId: lexeme.lexemeId,
        targetNodeId: productionId,
        predicate: 'OCCURS_IN',
        sourceId: sourceIdMap[production?.sourceId] || production?.sourceId || 'language-inventory'
      });
    }
  }

  for (const production of inventory.productions) {
    const productionSourceId = sourceIdMap[production.sourceId] || production.sourceId;
    for (const referencedProductionId of production.referencedProductionIds) {
      addProjectionEdge({
        sourceNodeId: production.productionId,
        targetNodeId: referencedProductionId,
        predicate: 'REFERENCES_PRODUCTION',
        sourceId: productionSourceId
      });
    }
    const semanticNodeId = semanticNodeIdByInventoryId.get(production.semanticTypeId);
    if (semanticNodeId) {
      addProjectionEdge({
        sourceNodeId: production.productionId,
        targetNodeId: semanticNodeId,
        predicate: 'RETURNS_TYPE',
        sourceId: productionSourceId,
        properties: { mappingKind: 'xtext_return' }
      });
    }
  }

  for (const semanticType of inventory.semanticTypes) {
    const sourceNodeId = semanticNodeIdByInventoryId.get(semanticType.semanticTypeId);
    const effective = effectiveSemanticById.get(semanticType.semanticTypeId);
    const sourceId = sourceIdMap[effective?.source?.id] || effective?.source?.id || 'language-inventory';
    for (const superTypeId of semanticType.superTypeIds) {
      const targetNodeId = semanticNodeIdByInventoryId.get(superTypeId);
      if (!targetNodeId || targetNodeId === sourceNodeId) continue;
      addProjectionEdge({
        sourceNodeId,
        targetNodeId,
        predicate: 'SPECIALIZES',
        sourceId,
        properties: { mappingKind: 'ecore_supertype' }
      });
    }
  }

  const resolvedScope = resolveScope(inventory, scopeManifest);
  for (const item of resolvedScope.filter((entry) => entry.disposition === 'covered')) {
    const production = inventory.productions.find((candidate) => candidate.productionId === item.productionId);
    for (const unit of item.coverageUnits) {
      addProjectionEdge({
        sourceNodeId: unit.grammarProductionId,
        targetNodeId: unit.semanticNodeId,
        predicate: 'CONSTRUCTS',
        sourceId: sourceIdMap[production?.sourceId] || production?.sourceId || 'language-inventory',
        properties: {
          mappingKind: 'reviewed_context_projection',
          coverageUnitId: unit.coverageUnitId,
          alternativePath: unit.alternativePath,
          astContextId: unit.astContextId,
          operators: [...new Set(unit.lexemeAssertions.map((assertion) => assertion.value))]
        }
      });
    }
  }

  return {
    nodes,
    languageEdges: edges,
    semanticNodeIdByInventoryId: Object.fromEntries(semanticNodeIdByInventoryId),
    resolvedScope
  };
}

function addNode(nodes, nodeById, node) {
  if (nodeById.has(node.nodeId)) return;
  const copy = clone(node);
  nodes.push(copy);
  nodeById.set(copy.nodeId, copy);
}

function groupIdsByName(nodes) {
  const result = new Map();
  for (const node of nodes) addNameIndex(result, node.name, node.nodeId);
  return result;
}

function addNameIndex(index, name, nodeId) {
  if (!String(name || '')) return;
  if (!index.has(name)) index.set(name, []);
  if (!index.get(name).includes(nodeId)) index.get(name).push(nodeId);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

module.exports = { materializeLanguageProjection };
