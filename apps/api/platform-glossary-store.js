'use strict';

const fs = require('fs');
const path = require('path');

function createPlatformGlossaryStore(options = {}) {
  const root = options.resourcesRoot || process.env.RESOURCES_ROOT || path.resolve(process.cwd(), 'resources');
  const glossaryId = options.platformGlossaryId || process.env.PLATFORM_GLOSSARY_ID || 'sysml-v2-core';
  const glossaryDir = path.join(root, 'glossaries', glossaryId);

  function readJson(relativePath) {
    const absolute = safeJoin(glossaryDir, relativePath);
    return JSON.parse(stripUtf8Bom(fs.readFileSync(absolute, 'utf8')));
  }

  function loadPack() {
    return readJson('glossary-pack.json');
  }

  function loadGlossary() {
    const pack = loadPack();
    return readJson(pack.terms || 'terms.json');
  }

  function loadTerms() {
    const glossary = loadGlossary();
    return Array.isArray(glossary) ? glossary : glossary.terms || [];
  }

  function loadSummary() {
    const pack = loadPack();
    const terms = loadTerms();
    const graph = buildGlossaryGraph(terms, glossaryId);
    return {
      ...pack,
      id: pack.id || glossaryId,
      glossaryId,
      termCount: terms.length,
      relationshipCount: graph.edges.length,
      categories: graph.categories
    };
  }

  function loadTerm(termId) {
    const lookup = createTermLookup(loadTerms());
    const key = normalizeKey(termId);
    return lookup.get(key) || null;
  }

  function loadGraph() {
    return buildGlossaryGraph(loadTerms(), glossaryId);
  }

  return {
    root,
    glossaryId,
    glossaryDir,
    loadPack,
    loadGlossary,
    loadTerms,
    loadSummary,
    loadTerm,
    loadGraph
  };
}

const GLOSSARY_CATEGORY_RULES = [
  { id: 'core', label: 'Core', match: /^(Element|Relationship|Namespace|Package|Membership|OwningMembership|Import|Dependency|Comment|AnnotatingElement)$/ },
  { id: 'structure', label: 'Structure', match: /(Definition|Usage|Type|Classifier|Feature|Structure|Part|Item|Attribute)/ },
  { id: 'interface', label: 'Interface', match: /(Port|Interface|Connection|Flow|BindingConnector)/ },
  { id: 'behavior', label: 'Behavior', match: /(Behavior|Step|Action|State|Transition|Succession|Occurrence|Event|Trigger|Perform)/ },
  { id: 'requirements', label: 'Requirements', match: /(Requirement|Satisfy|Verification|Objective|Concern|Case)/ },
  { id: 'analysis', label: 'Analysis', match: /(Constraint|Assert|Calculation|Analysis|Expression|Predicate)/ },
  { id: 'view', label: 'View & Metadata', match: /(View|Viewpoint|Rendering|Metadata|Documentation|Textual)/ }
];

function buildGlossaryGraph(terms, glossaryId) {
  const termLookup = createTermLookup(terms);
  const nodeById = new Map();
  const edgeById = new Map();

  for (const term of terms) {
    const node = createNodeFromTerm(term, true);
    if (!node) continue;
    nodeById.set(node.id, node);
  }

  for (const term of terms) {
    const childId = termId(term);
    if (!childId) continue;
    for (const parentName of term.superTypes || []) {
      const parentTerm = termLookup.get(normalizeKey(parentName));
      const parentNode = parentTerm
        ? createNodeFromTerm(parentTerm, true)
        : createPlaceholderNode(parentName);
      if (!parentNode) continue;
      if (!nodeById.has(parentNode.id)) nodeById.set(parentNode.id, parentNode);
      const edgeId = `${parentNode.id}->${childId}:generalization`;
      if (!edgeById.has(edgeId)) {
        edgeById.set(edgeId, {
          id: edgeId,
          source: parentNode.id,
          target: childId,
          type: 'generalization',
          label: 'superType'
        });
      }
    }
  }

  const nodes = Array.from(nodeById.values()).sort((left, right) => left.label.localeCompare(right.label));
  const edges = Array.from(edgeById.values()).sort((left, right) => left.id.localeCompare(right.id));
  return {
    glossaryId,
    generatedAt: new Date(0).toISOString(),
    termCount: terms.length,
    relationshipCount: edges.length,
    categories: summarizeCategories(nodes),
    nodes,
    edges
  };
}

function createTermLookup(terms) {
  const lookup = new Map();
  for (const term of terms) {
    const keys = [term.id, term.term, term.name, ...(term.aliases || [])];
    for (const key of keys) {
      const normalized = normalizeKey(key);
      if (normalized && !lookup.has(normalized)) lookup.set(normalized, term);
    }
  }
  return lookup;
}

function createNodeFromTerm(term, platformTerm) {
  const id = termId(term);
  if (!id) return null;
  const label = term.term || term.name || id;
  return {
    id,
    label,
    termId: id,
    category: categoryForTerm(label),
    kind: term.kind || 'SysML metamodel',
    metamodelType: term.metamodelType || '',
    isPlatformTerm: Boolean(platformTerm),
    aliases: term.aliases || [],
    superTypes: term.superTypes || []
  };
}

function createPlaceholderNode(name) {
  const id = String(name || '').trim();
  if (!id) return null;
  return {
    id,
    label: id,
    termId: id,
    category: categoryForTerm(id),
    kind: 'SysML metamodel',
    metamodelType: 'superType',
    isPlatformTerm: false,
    aliases: [],
    superTypes: []
  };
}

function summarizeCategories(nodes) {
  const summary = new Map(GLOSSARY_CATEGORY_RULES.map((rule) => [rule.id, { id: rule.id, label: rule.label, count: 0 }]));
  summary.set('other', { id: 'other', label: 'Other', count: 0 });
  for (const node of nodes) {
    const current = summary.get(node.category) || summary.get('other');
    current.count += 1;
  }
  return Array.from(summary.values()).filter((category) => category.count > 0);
}

function categoryForTerm(name) {
  const value = String(name || '');
  const rule = GLOSSARY_CATEGORY_RULES.find((candidate) => candidate.match.test(value));
  return rule ? rule.id : 'other';
}

function termId(term) {
  return String(term?.id || term?.term || term?.name || '').trim();
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function safeJoin(root, relativePath) {
  const target = path.resolve(root, relativePath);
  const resolvedRoot = path.resolve(root);
  if (!target.startsWith(resolvedRoot)) throw new Error(`Unsafe glossary path: ${relativePath}`);
  return target;
}

function stripUtf8Bom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

module.exports = { createPlatformGlossaryStore };
