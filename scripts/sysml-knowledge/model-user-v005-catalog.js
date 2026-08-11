'use strict';

const crypto = require('node:crypto');

// 这是 v1 能力范围的固定分母，不由当前记录数量反推。这样即使误删一个 capability/objective，
// 评估器也不会把缩小后的集合当成新的 100%。ID 集合按字典序锁定，hash 是该数组 JSON 的 SHA-256。
const EXPECTED_CAPABILITY_UNIT_IDS = Object.freeze([
  'P0-ANNOTATION',
  'P0-DEFINITION-USAGE',
  'P0-DEPENDENCY',
  'P0-ELEMENTS-RELATIONSHIPS',
  'P0-ENUMERATION',
  'P0-EXPRESSION-INFRASTRUCTURE',
  'P0-FEATURE-TYPING',
  'P0-MEMBERSHIP',
  'P0-MULTIPLICITY-COMPOSITION',
  'P0-NAMESPACE-IMPORT',
  'P0-OCCURRENCE-TIME',
  'P0-REDEFINITION',
  'P0-REFERENCE-SUBSETTING',
  'P0-SUBCLASSIFICATION',
  'P0-SUBSETTING',
  'P1-ALLOCATION',
  'P1-ATTRIBUTE',
  'P1-CONNECTION-BINDING',
  'P1-FLOW-MESSAGE',
  'P1-INTERFACE',
  'P1-ITEM',
  'P1-PART',
  'P1-PORT',
  'P2-ACTION-CONTROL',
  'P2-ASSIGN-TERMINATE',
  'P2-PERFORM',
  'P2-SEND-ACCEPT',
  'P2-STATE',
  'P2-SUCCESSION',
  'P2-TRANSITION',
  'P3-ANALYSIS-CASE',
  'P3-CALCULATION',
  'P3-CONSTRAINT',
  'P3-REQUIREMENT',
  'P3-SATISFY',
  'P3-USE-CASE',
  'P3-VERIFICATION',
  'P4-DOCUMENTATION',
  'P4-METADATA',
  'P4-QUANTITY-UNIT',
  'P4-STANDARD-LIBRARY',
  'P4-VARIATION',
  'P4-VIEW-VIEWPOINT'
]);
const EXPECTED_MODEL_USER_OBJECTIVE_IDS = Object.freeze([
  'MU-BEH-7.16',
  'MU-BEH-7.17',
  'MU-BEH-7.18',
  'MU-BEH-7.19',
  'MU-CASE-7.23.2',
  'MU-CASE-7.24.2',
  'MU-CASE-7.25',
  'MU-FND-7.2',
  'MU-FND-7.3',
  'MU-FND-7.4',
  'MU-FND-7.5',
  'MU-FND-7.6',
  'MU-FND-7.7',
  'MU-FND-7.8',
  'MU-FND-7.9',
  'MU-REQ-7.20',
  'MU-REQ-7.21',
  'MU-STR-7.10',
  'MU-STR-7.11',
  'MU-STR-7.12',
  'MU-STR-7.13',
  'MU-STR-7.14',
  'MU-STR-7.15',
  'MU-SUP-7.27',
  'MU-SUP-9.8.2'
]);
const EXPECTED_CAPABILITY_UNIT_SET_HASH = 'sha256:e658cf6ce737d043dd276507e1b0802c212876f31abdcda23e2d348e638f47fd';
const EXPECTED_MODEL_USER_OBJECTIVE_SET_HASH = 'sha256:a8255c76ddf77a86948d6af91172ccf2acb5031a8238827d6170200fb422e165';

// P0-P4 是平台迭代分期，examDomainId 是 OMG Model User 官方考纲域。
// 两个轴故意分开：例如 Flow 位于平台 P1，但属于考试 Behavior；Calculation 位于平台 P3，也属于考试 Behavior。
const CAPABILITY_UNITS = Object.freeze([
  unit('P0-ELEMENTS-RELATIONSHIPS', 'P0', '元素与关系', ['claim-mu-elements-relationships'], ['MU-FND-7.2'], ['01. Packages'], /(?:element|relationship|membership|member)/iu),
  unit('P0-DEPENDENCY', 'P0', '依赖关系', ['claim-mu-dependency'], ['MU-FND-7.3'], ['37. Dependencies'], /dependency/iu),
  unit('P0-ANNOTATION', 'P0', '注释与文本表示', ['claim-mu-annotation', 'claim-mu-comment-documentation', 'claim-mu-textual-representation'], ['MU-FND-7.4'], ['01. Packages'], /(?:annotation|annotating|comment|textualrepresentation)/iu),
  unit('P0-DEFINITION-USAGE', 'P0', 'Definition 与 Usage', ['claim-mu-definition-usage-foundation', 'claim-typed-usage-inherits-features'], ['MU-FND-7.6'], ['02. Part Definitions', '07. Parts'], /(?:definition|usage|definitionbody|usagebody)/iu),
  unit('P0-FEATURE-TYPING', 'P0', 'Feature Typing', ['claim-colon-feature-typing', 'claim-typed-usage-inherits-features'], ['MU-FND-7.6'], ['02. Part Definitions'], /(?:featuretyping|typedby|typefeaturing)/iu),
  unit('P0-SUBCLASSIFICATION', 'P0', 'Subclassification', ['claim-colon-gt-subclassification', 'claim-mu-definition-subclassification'], ['MU-FND-7.6'], ['03. Generalization'], /subclassification/iu),
  unit('P0-SUBSETTING', 'P0', 'Subsetting', ['claim-colon-gt-subsetting', 'claim-mu-usage-specializations'], ['MU-FND-7.6'], ['04. Subsetting'], /(?<!reference)subsetting|subsettings/iu),
  unit('P0-REDEFINITION', 'P0', 'Redefinition', ['claim-redefinition'], ['MU-FND-7.6'], ['05. Redefinition'], /redefinition|redefines/iu),
  unit('P0-REFERENCE-SUBSETTING', 'P0', 'Reference Subsetting', ['claim-reference-subsetting', 'claim-reference-subsetting-specializes-subsetting', 'claim-mu-reference-usage', 'claim-mu-feature-chain'], ['MU-FND-7.6'], ['09. Connections'], /(?:referencesubsetting|ownedreferencesubsetting|featurechain)/iu),
  unit('P0-MEMBERSHIP', 'P0', 'Membership', ['claim-mu-namespace-membership'], ['MU-FND-7.5'], ['01. Packages'], /membership|member/iu),
  unit('P0-NAMESPACE-IMPORT', 'P0', 'Namespace、Package 与 Import', ['claim-mu-namespace-membership', 'claim-mu-package-alias', 'claim-mu-import-kinds', 'claim-mu-import-membership', 'claim-mu-import-namespace', 'claim-mu-import-filter'], ['MU-FND-7.5'], ['01. Packages', '40. Filtering'], /(?:namespace|package|import|alias|filter)/iu),
  unit('P0-MULTIPLICITY-COMPOSITION', 'P0', 'Multiplicity、Composition 与 Reference', ['claim-mu-multiplicity', 'claim-mu-composite-referential'], ['MU-FND-7.6'], ['07. Parts'], /(?:multiplicity|ordered|nonunique|composite|referential)/iu),
  unit('P0-ENUMERATION', 'P0', 'Enumeration', ['claim-mu-enumeration'], ['MU-FND-7.8'], ['06. Enumeration Definitions'], /enumeration|enum/iu),
  unit('P0-OCCURRENCE-TIME', 'P0', 'Occurrence、Individual、TimeSlice 与 Snapshot', ['claim-mu-occurrence-lifetime', 'claim-mu-occurrence-varying-features', 'claim-mu-timeslice-snapshot', 'claim-mu-individual'], ['MU-FND-7.9'], ['27. Occurrences', '28. Individuals'], /(?:occurrence|individual|timeslice|snapshot|eventoccurrence)/iu),
  unit('P0-EXPRESSION-INFRASTRUCTURE', 'P0', '名称、表达式与通用语法基础设施', ['claim-mu-feature-chain'], [], ['29. Expressions'], /(?:expression|operator|operand|literal|argument|qualifiedname|identification|name|prefix|declaration|body|terminator)/iu),

  unit('P1-ATTRIBUTE', 'P1', 'Attribute', ['claim-mu-attribute', 'claim-feature-value-fixed-vs-initial', 'claim-feature-value-default'], ['MU-FND-7.7'], ['29. Expressions'], /attribute|featurevalue/iu),
  unit('P1-PART', 'P1', 'Part', ['claim-mu-part'], ['MU-STR-7.11'], ['07. Parts'], /part/iu),
  unit('P1-ITEM', 'P1', 'Item', ['claim-mu-item'], ['MU-STR-7.10'], ['08. Items'], /item/iu),
  unit('P1-PORT', 'P1', 'Port 与 Conjugation', ['claim-mu-port', 'claim-mu-conjugated-port'], ['MU-STR-7.12'], ['10. Ports'], /port|conjugat/iu),
  unit('P1-CONNECTION-BINDING', 'P1', 'Connection 与 Binding', ['claim-mu-connection', 'claim-mu-binding', 'claim-reference-subsetting'], ['MU-STR-7.13'], ['09. Connections', '12. Binding Connectors'], /(?:connection|connector|binding)/iu),
  unit('P1-INTERFACE', 'P1', 'Interface', ['claim-mu-interface'], ['MU-STR-7.14'], ['11. Interfaces'], /interface/iu),
  unit('P1-FLOW-MESSAGE', 'P1', 'Flow 与 Message', ['claim-mu-flow', 'claim-mu-message', 'claim-mu-message-realization-boundary'], ['MU-BEH-7.16'], ['13. Flows', '21. Asynchronous Messaging'], /(?:flow|message|payload|transfer)/iu),
  unit('P1-ALLOCATION', 'P1', 'Allocation', ['claim-mu-allocation', 'claim-mu-allocation-usage'], ['MU-STR-7.15'], ['38. Allocation'], /allocation|allocate/iu),

  unit('P2-ACTION-CONTROL', 'P2', 'Action、参数与控制节点', ['claim-mu-action', 'claim-mu-action-declaration', 'claim-mu-control-node'], ['MU-BEH-7.17'], ['14. Action Definitions', '15. Actions', '17. Control'], /(?:action|controlnode|decision|merge|fork|join|parameter)/iu),
  unit('P2-PERFORM', 'P2', 'Perform', ['claim-mu-perform-action'], ['MU-BEH-7.17'], ['18. Action Performance'], /perform/iu),
  unit('P2-SEND-ACCEPT', 'P2', 'Send 与 Accept', ['claim-mu-send-action', 'claim-mu-accept-action', 'claim-mu-send-realization-boundary', 'claim-mu-accept-realization-boundary'], ['MU-BEH-7.17'], ['21. Asynchronous Messaging'], /(?:send|accept|receiver|sender)/iu),
  unit('P2-STATE', 'P2', 'State', ['claim-mu-state'], ['MU-BEH-7.18'], ['23. State Definitions', '24. States', '26. State Exhibition'], /state|exhibit/iu),
  unit('P2-TRANSITION', 'P2', 'Transition', ['claim-mu-transition'], ['MU-BEH-7.18'], ['25. Transitions'], /transition|trigger|guard|effect/iu),
  unit('P2-SUCCESSION', 'P2', 'Succession', ['claim-mu-succession', 'claim-mu-conditional-succession'], ['MU-BEH-7.17'], ['14. Action Definitions', '16. Conditional Succession'], /succession|then/iu),
  unit('P2-ASSIGN-TERMINATE', 'P2', 'Assignment 与 Terminate', ['claim-mu-assignment-action', 'claim-mu-terminate-action'], ['MU-BEH-7.17'], ['19. Terminate Actions', '20. Assignment Actions'], /(?:assignment|assign|terminate)/iu),

  unit('P3-CALCULATION', 'P3', 'Calculation', ['claim-mu-calculation', 'claim-mu-calculation-purity-boundary'], ['MU-BEH-7.19'], ['30. Calculations'], /calculation|calc/iu),
  unit('P3-CONSTRAINT', 'P3', 'Constraint', ['claim-mu-constraint'], ['MU-REQ-7.20'], ['31. Constraints'], /constraint|assert/iu),
  unit('P3-REQUIREMENT', 'P3', 'Requirement、Assume 与 Require', ['claim-mu-requirement', 'claim-mu-requirement-assume-require'], ['MU-REQ-7.21'], ['32. Requirements'], /requirement|assume|requireconstraint/iu),
  unit('P3-SATISFY', 'P3', 'Satisfy', ['claim-mu-satisfy', 'claim-mu-requirement-reference-boundary'], ['MU-REQ-7.21'], ['32. Requirements'], /satisfy/iu),
  unit('P3-ANALYSIS-CASE', 'P3', 'Analysis Case', ['claim-mu-analysis-case'], ['MU-CASE-7.23.2'], ['33. Analysis'], /analysiscase/iu),
  unit('P3-VERIFICATION', 'P3', 'Verification、Verify 与 Verdict', ['claim-mu-verification-case', 'claim-mu-requirement-reference-boundary'], ['MU-CASE-7.24.2'], ['34. Verification'], /verification|verify|verdict/iu),
  unit('P3-USE-CASE', 'P3', 'Use Case', ['claim-mu-use-case'], ['MU-CASE-7.25'], ['35. Use Cases'], /usecase/iu),

  unit('P4-VIEW-VIEWPOINT', 'P4', 'View、Viewpoint、Rendering 与 Expose', ['claim-mu-view-viewpoint', 'claim-mu-view-definition', 'claim-mu-view-usage', 'claim-mu-viewpoint-definition', 'claim-mu-viewpoint-usage'], [], ['42. Views'], /(?:viewpoint|view|rendering|expose)/iu),
  unit('P4-METADATA', 'P4', 'Metadata', ['claim-mu-metadata', 'claim-mu-metadata-declaration'], ['MU-SUP-7.27'], ['39. Metadata', '41. Language Extension'], /metadata|metaclass/iu),
  unit('P4-DOCUMENTATION', 'P4', 'Documentation', ['claim-mu-comment-documentation', 'claim-grammar-documentation', 'claim-documentation-requirement-informal-text'], ['MU-FND-7.4'], ['01. Packages'], /documentation|comment|textualrepresentation/iu),
  unit('P4-STANDARD-LIBRARY', 'P4', '标准库与 Model Library', ['claim-mu-model-library-boundary', 'claim-mu-scalar-values'], [], ['41. Language Extension'], /library/iu, ['Kernel Libraries/**/*.kerml', 'Systems Library/**/*.sysml']),
  unit('P4-QUANTITY-UNIT', 'P4', 'Quantity、Unit 与 ISQ', ['claim-mu-quantities', 'claim-mu-isq', 'claim-mu-scalar-values'], ['MU-SUP-9.8.2'], [], /(?:quantity|unit|measurement|scalar|isq)/iu, ['Domain Libraries/Quantities and Units/**/*.sysml', 'Kernel Libraries/Kernel Data Type Library/ScalarValues.kerml'], false),
  unit('P4-VARIATION', 'P4', 'Variation 与 Variant', ['claim-mu-variation'], [], ['36. Variability'], /variation|variant/iu)
]);

const MODEL_USER_OBJECTIVE_REQUIREMENTS = Object.freeze([
  objective('MU-FND-7.2', ['P0-ELEMENTS-RELATIONSHIPS']),
  objective('MU-FND-7.3', ['P0-DEPENDENCY']),
  objective('MU-FND-7.4', ['P0-ANNOTATION', 'P4-DOCUMENTATION']),
  objective('MU-FND-7.5', ['P0-MEMBERSHIP', 'P0-NAMESPACE-IMPORT']),
  objective('MU-FND-7.6', ['P0-DEFINITION-USAGE', 'P0-FEATURE-TYPING', 'P0-SUBCLASSIFICATION', 'P0-SUBSETTING', 'P0-REDEFINITION', 'P0-REFERENCE-SUBSETTING', 'P0-MULTIPLICITY-COMPOSITION']),
  objective('MU-FND-7.7', ['P1-ATTRIBUTE']),
  objective('MU-FND-7.8', ['P0-ENUMERATION']),
  objective('MU-FND-7.9', ['P0-OCCURRENCE-TIME']),
  objective('MU-BEH-7.16', ['P1-FLOW-MESSAGE']),
  objective('MU-BEH-7.17', ['P2-ACTION-CONTROL', 'P2-PERFORM', 'P2-SEND-ACCEPT', 'P2-SUCCESSION', 'P2-ASSIGN-TERMINATE']),
  objective('MU-BEH-7.18', ['P2-STATE', 'P2-TRANSITION']),
  objective('MU-BEH-7.19', ['P3-CALCULATION']),
  objective('MU-STR-7.10', ['P1-ITEM']),
  objective('MU-STR-7.11', ['P1-PART']),
  objective('MU-STR-7.12', ['P1-PORT']),
  objective('MU-STR-7.13', ['P1-CONNECTION-BINDING']),
  objective('MU-STR-7.14', ['P1-INTERFACE']),
  objective('MU-STR-7.15', ['P1-ALLOCATION']),
  objective('MU-REQ-7.20', ['P3-CONSTRAINT']),
  objective('MU-REQ-7.21', ['P3-REQUIREMENT', 'P3-SATISFY']),
  objective('MU-CASE-7.23.2', ['P3-ANALYSIS-CASE']),
  objective('MU-CASE-7.24.2', ['P3-VERIFICATION']),
  objective('MU-CASE-7.25', ['P3-USE-CASE']),
  objective('MU-SUP-7.27', ['P4-METADATA']),
  objective('MU-SUP-9.8.2', ['P4-QUANTITY-UNIT'])
]);

function classifyProductionCapabilityUnitIds({ production, semanticType, effectiveRule }) {
  const directText = [
    production?.name,
    production?.returnType,
    semanticType?.name,
    ...(production?.directLiterals || [])
  ].filter(Boolean).join(' ');
  const directMatches = matchingCapabilityUnitIds(directText).slice(0, 4);
  if (directMatches.length > 0) return directMatches;

  // 聚合 production 往往引用很多下游规则。引用只能作为无直接命中时的兜底，并按命中次数排序后
  // 最多保留三个能力，避免 DefinitionElement 一类入口被扩散成几十个无区分绑定。
  const referenceNames = unique([
    ...(production?.referencedProductionIds || []).map(stripProductionId),
    ...(effectiveRule?.references || []).map((item) => item?.name)
  ].filter(Boolean));
  const scores = new Map();
  for (const referenceName of referenceNames) {
    for (const capabilityUnitId of matchingCapabilityUnitIds(referenceName)) {
      scores.set(capabilityUnitId, (scores.get(capabilityUnitId) || 0) + 1);
    }
  }
  const referenceMatches = [...scores.entries()]
    .sort((left, right) => right[1] - left[1]
      || capabilityOrder(left[0]) - capabilityOrder(right[0])
      || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([capabilityUnitId]) => capabilityUnitId);
  return referenceMatches.length > 0 ? referenceMatches : ['P0-EXPRESSION-INFRASTRUCTURE'];
}

function serializableCapabilityScope() {
  return {
    schemaVersion: 'sysml-official-capabilities-p0-p4/v1',
    scopeId: 'sysml-official-capabilities-p0-p4-v1',
    platformPhaseSemantics: 'implementation_sequence_not_exam_domain',
    expectedCapabilityUnitIds: [...EXPECTED_CAPABILITY_UNIT_IDS],
    expectedCapabilityUnitSetHash: EXPECTED_CAPABILITY_UNIT_SET_HASH,
    expectedModelUserObjectiveIds: [...EXPECTED_MODEL_USER_OBJECTIVE_IDS],
    expectedModelUserObjectiveSetHash: EXPECTED_MODEL_USER_OBJECTIVE_SET_HASH,
    expectedCounts: {
      capabilityUnits: EXPECTED_CAPABILITY_UNIT_IDS.length,
      modelUserObjectives: EXPECTED_MODEL_USER_OBJECTIVE_IDS.length
    },
    capabilityUnits: CAPABILITY_UNITS.map(({ productionPattern, ...item }) => ({ ...item })),
    modelUserObjectiveRequirements: MODEL_USER_OBJECTIVE_REQUIREMENTS.map((item) => ({ ...item })),
    representationBoundary: {
      objectiveKnowledgeClosure: ['natural-language', 'textual'],
      graphicalBnf: 'registered_as_official_scope_not_claimed_as_rendering_validator_closure'
    }
  };
}

function unit(capabilityUnitId, phaseId, title, requiredClaimIds, modelUserObjectiveIds, officialExampleTopicIds, productionPattern, officialLibraryGlobs = [], productionBindingRequired = true) {
  return Object.freeze({
    capabilityUnitId,
    phaseId,
    title,
    requiredClaimIds: Object.freeze([...requiredClaimIds]),
    requiredEvidenceAuthorities: Object.freeze(['A1', 'A2']),
    modelUserObjectiveIds: Object.freeze([...modelUserObjectiveIds]),
    officialExampleTopicIds: Object.freeze([...officialExampleTopicIds]),
    officialLibraryGlobs: Object.freeze([...officialLibraryGlobs]),
    productionBindingRequired,
    productionPattern
  });
}

function objective(objectiveId, requiredCapabilityUnitIds) {
  return Object.freeze({
    objectiveId,
    requiredCapabilityUnitIds: Object.freeze([...requiredCapabilityUnitIds]),
    requiredRepresentations: Object.freeze(['natural-language', 'textual', 'graphical'])
  });
}

function unique(values) {
  return [...new Set(values)];
}

function matchingCapabilityUnitIds(text) {
  return CAPABILITY_UNITS
    .filter((item) => item.productionPattern.test(String(text || '')))
    .map((item) => item.capabilityUnitId);
}

function stripProductionId(value) {
  return String(value || '').replace(/^grammar-production:/u, '');
}

function capabilityOrder(capabilityUnitId) {
  return CAPABILITY_UNITS.findIndex((item) => item.capabilityUnitId === capabilityUnitId);
}

function hashIdSet(ids) {
  const sorted = [...ids].sort();
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex')}`;
}

function assertLockedCatalogContract() {
  const actualCapabilities = CAPABILITY_UNITS.map((item) => item.capabilityUnitId).sort();
  const actualObjectives = MODEL_USER_OBJECTIVE_REQUIREMENTS.map((item) => item.objectiveId).sort();
  if (JSON.stringify(actualCapabilities) !== JSON.stringify(EXPECTED_CAPABILITY_UNIT_IDS)
    || hashIdSet(actualCapabilities) !== EXPECTED_CAPABILITY_UNIT_SET_HASH) {
    throw new Error('P0-P4 capability catalog no longer matches the locked 43-ID v1 denominator');
  }
  if (JSON.stringify(actualObjectives) !== JSON.stringify(EXPECTED_MODEL_USER_OBJECTIVE_IDS)
    || hashIdSet(actualObjectives) !== EXPECTED_MODEL_USER_OBJECTIVE_SET_HASH) {
    throw new Error('Model User objective requirements no longer match the locked 25-ID official denominator');
  }
}

assertLockedCatalogContract();

module.exports = {
  CAPABILITY_UNITS,
  MODEL_USER_OBJECTIVE_REQUIREMENTS,
  EXPECTED_CAPABILITY_UNIT_IDS,
  EXPECTED_CAPABILITY_UNIT_SET_HASH,
  EXPECTED_MODEL_USER_OBJECTIVE_IDS,
  EXPECTED_MODEL_USER_OBJECTIVE_SET_HASH,
  classifyProductionCapabilityUnitIds,
  serializableCapabilityScope
};
