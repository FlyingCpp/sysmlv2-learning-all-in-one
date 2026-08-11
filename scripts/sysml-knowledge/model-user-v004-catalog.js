'use strict';

function knowledgePatternEvidenceBlocks() {
  return [
    {
      evidenceId: 'ev-mu-send-actions',
      sourceId: 'sysml20-part1-formal-text',
      sectionPath: '7.17.7 Send Action Usages',
      lineStart: 6605,
      lineEnd: 6618,
      blockType: 'semantic_rule',
      operators: [],
      conceptIds: ['sysml20:SendActionUsage'],
      astContextIds: ['sysml20:SendActionUsage']
    }
  ];
}

function knowledgePatternClaims() {
  return [
    claim({
      claimId: 'claim-mu-requirement-reference-boundary',
      subjectNodeId: 'sysml20:RequirementUsage',
      predicate: 'DISTINGUISHES_DECLARATION_AND_REFERENCE',
      objectNodeId: 'kerml10:ReferenceSubsetting',
      claimText: '在 `satisfy qualifiedName` 与 `verify qualifiedName` 的简写中，限定名或 feature chain 通过 reference subsetting 指向已有 RequirementUsage；这不同于带 requirement 关键字的完整 requirement usage declaration，不能把 Requirement Definition 本身当作简写所引用的具体 Usage。',
      evidenceIds: ['ev-mu-satisfy', 'ev-mu-verification-cases'],
      examObjectiveIds: ['MU-FND-7.6', 'MU-REQ-7.21', 'MU-CASE-7.24.2'],
      knownPointIds: ['KP-02', 'KP-13', 'KP-14'],
      searchTerms: ['satisfy shorthand', 'verify shorthand', 'Requirement Definition Usage', 'reference subsetting']
    }),
    claim({
      claimId: 'claim-mu-send-action',
      subjectNodeId: 'sysml20:SendActionUsage',
      predicate: 'TRANSFERS_PAYLOAD_FROM_SENDER_TO_RECEIVER',
      claimText: 'SendAction具有payload、sender和receiver三个输入参数，其行为是把payload从sender传送到receiver。',
      evidenceIds: ['ev-mu-send-actions'],
      examObjectiveIds: ['MU-BEH-7.17'],
      knownPointIds: ['KP-09'],
      searchTerms: ['SendAction', 'send payload sender receiver']
    }),
    claim({
      claimId: 'claim-mu-message-realization-boundary',
      subjectNodeId: 'sysml20:FlowUsage',
      predicate: 'HAS_ALTERNATIVE_DETAILED_REALIZATIONS',
      objectNodeId: 'sysml20:SendActionUsage',
      claimText: '抽象Message可在更详细模型中用streaming flow、succession flow或send-to-accept transfer实现；因此出现Send/Accept并不必然要求再存在一个显式FlowUsage。',
      evidenceIds: ['ev-mu-flows'],
      examObjectiveIds: ['MU-BEH-7.16', 'MU-BEH-7.17'],
      knownPointIds: ['KP-07', 'KP-09'],
      searchTerms: ['Message realization', 'Send Accept Flow', 'explicit FlowUsage']
    }),
    claim({
      claimId: 'claim-mu-calculation-purity-boundary',
      subjectNodeId: 'sysml20:CalculationDefinition',
      predicate: 'SHOULD_BE_PURE_WHEN_MATHEMATICAL_FUNCTION',
      claimText: 'CalculationDefinition常用于定义数学函数；在这种用途下，计算应保持同输入同结果且无外部副作用，其子计算、子动作和最终表达式也应保持纯性。规范没有把所有Calculation无条件定义为天然纯函数。',
      evidenceIds: ['ev-mu-calculations'],
      examObjectiveIds: ['MU-BEH-7.19'],
      knownPointIds: ['KP-12'],
      searchTerms: ['Calculation purity', 'pure calculation', 'side effect']
    })
  ];
}

function knowledgePatternGuardrails() {
  return [
    guardrail({
      overlayId: 'guardrail-mu-requirement-definition-is-not-usage',
      description: '禁止把Requirement Definition本身当作satisfy或verify简写引用的具体Requirement Usage。',
      forbiddenText: 'Requirement Definition可以直接作为satisfy或verify简写的引用目标',
      supportedByClaimIds: ['claim-mu-requirement-reference-boundary'],
      counterexampleIds: ['fixture-mu-requirement-forbidden-inference']
    }),
    guardrail({
      overlayId: 'guardrail-mu-send-accept-not-explicit-flow',
      description: '禁止把Send/Accept无条件等同为一个显式FlowUsage。',
      forbiddenText: 'Send和Accept必然实现一个显式Flow',
      supportedByClaimIds: ['claim-mu-message-realization-boundary'],
      counterexampleIds: ['fixture-mu-flow-forbidden-inference']
    }),
    guardrail({
      overlayId: 'guardrail-mu-transition-order',
      description: '禁止把目标entry放在源exit之前。',
      forbiddenText: '进入目标状态后再执行源状态exit',
      supportedByClaimIds: ['claim-mu-transition'],
      counterexampleIds: ['fixture-mu-state-forbidden-inference']
    }),
    guardrail({
      overlayId: 'guardrail-mu-calculation-purity-is-conditional',
      description: '禁止把条件性的pure calculation建议绝对化为所有Calculation的定义语义。',
      forbiddenText: '所有Calculation都天然是纯函数',
      supportedByClaimIds: ['claim-mu-calculation-purity-boundary'],
      counterexampleIds: ['fixture-mu-calc-forbidden-inference']
    }),
    guardrail({
      overlayId: 'guardrail-mu-feature-value-is-not-default',
      description: '禁止把没有default前缀的固定bound FeatureValue解释成默认值。',
      forbiddenText: '`= 100`表示默认值',
      supportedByClaimIds: ['claim-feature-value-fixed-vs-initial', 'claim-feature-value-default'],
      counterexampleIds: ['fixture-mu-time-forbidden-inference']
    })
  ];
}

function knowledgePatterns() {
  return [
    pattern({
      patternId: 'pattern-mu-requirement-usage-satisfy-verify',
      title: 'Requirement Usage、satisfy与verify边界',
      description: '回答Requirement Definition/Usage及satisfy、verify引用边界所需的最小证据子图。',
      examObjectiveIds: ['MU-FND-7.6', 'MU-REQ-7.21', 'MU-CASE-7.24.2'],
      anchorNodeIds: ['sysml20:RequirementDefinition', 'sysml20:RequirementUsage', 'sysml20:SatisfyRequirementUsage', 'sysml20:RequirementVerificationMembership'],
      requiredClaimIds: ['claim-mu-requirement', 'claim-mu-requirement-assume-require', 'claim-mu-satisfy', 'claim-mu-verification-case', 'claim-mu-requirement-reference-boundary'],
      requiredEdgeIds: ['edge-mu-sysml20-requirementusage-typed-by-sysml20-requirementdefinition', 'edge-mu-sysml20-satisfyrequirementusage-specializes-sysml20-requirementusage', 'edge-language-c3234db6d4b79068318c708d', 'edge-language-8790a97f0137845ff7cb4b80'],
      guardrailIds: ['guardrail-mu-requirement-definition-is-not-usage'],
      fixtureIds: ['fixture-mu-requirement-complete', 'fixture-mu-requirement-missing-boundary', 'fixture-mu-requirement-forbidden-inference']
    }),
    pattern({
      patternId: 'pattern-mu-flow-message-send-accept',
      title: 'Flow、Message与Send/Accept边界',
      description: '回答抽象Message、显式Flow和Send/Accept transfer之间关系所需的最小证据子图。',
      examObjectiveIds: ['MU-BEH-7.16', 'MU-BEH-7.17'],
      anchorNodeIds: ['sysml20:FlowUsage', 'sysml20:SendActionUsage', 'sysml20:AcceptActionUsage'],
      requiredClaimIds: ['claim-mu-flow', 'claim-mu-message', 'claim-mu-send-action', 'claim-mu-accept-action', 'claim-mu-message-realization-boundary'],
      requiredEdgeIds: ['edge-mu-sysml20-flowusage-typed-by-sysml20-flowdefinition', 'edge-mu-sysml20-acceptactionusage-specializes-sysml20-actionusage', 'edge-language-5e2ea1c920fa3983fd5a9d6d', 'edge-language-cb4ee1e177f878587bb48ee1'],
      guardrailIds: ['guardrail-mu-send-accept-not-explicit-flow'],
      fixtureIds: ['fixture-mu-flow-complete', 'fixture-mu-flow-missing-boundary', 'fixture-mu-flow-forbidden-inference']
    }),
    pattern({
      patternId: 'pattern-mu-state-transition-sequencing',
      title: 'State Transition触发与执行顺序',
      description: '回答guard/accepter准入及Transition触发后五步执行顺序所需的最小证据子图。',
      examObjectiveIds: ['MU-BEH-7.18'],
      anchorNodeIds: ['sysml20:StateUsage', 'sysml20:TransitionUsage'],
      requiredClaimIds: ['claim-mu-state', 'claim-mu-transition'],
      requiredEdgeIds: ['edge-mu-sysml20-stateusage-typed-by-sysml20-statedefinition', 'edge-mu-sysml20-transitionusage-specializes-sysml20-actionusage'],
      guardrailIds: ['guardrail-mu-transition-order'],
      fixtureIds: ['fixture-mu-state-complete', 'fixture-mu-state-missing-boundary', 'fixture-mu-state-forbidden-inference']
    }),
    pattern({
      patternId: 'pattern-mu-calculation-constraint-boundary',
      title: 'Calculation与Constraint边界',
      description: '回答Calculation结果、Constraint Boolean predicate及条件性纯计算边界所需的最小证据子图。',
      examObjectiveIds: ['MU-BEH-7.19', 'MU-REQ-7.20'],
      anchorNodeIds: ['sysml20:CalculationDefinition', 'sysml20:ConstraintDefinition'],
      requiredClaimIds: ['claim-mu-calculation', 'claim-mu-constraint', 'claim-mu-calculation-purity-boundary'],
      requiredEdgeIds: ['edge-mu-sysml20-calculationusage-typed-by-sysml20-calculationdefinition', 'edge-mu-sysml20-constraintusage-typed-by-sysml20-constraintdefinition', 'edge-language-61766a6c226021af12fe6350', 'edge-language-b1e4c407f61fadee7d80d7ff'],
      guardrailIds: ['guardrail-mu-calculation-purity-is-conditional'],
      fixtureIds: ['fixture-mu-calc-complete', 'fixture-mu-calc-missing-boundary', 'fixture-mu-calc-forbidden-inference']
    }),
    pattern({
      patternId: 'pattern-mu-attribute-occurrence-time-boundary',
      title: 'Attribute、Occurrence与时间边界',
      description: '回答数据值无时间性、Occurrence拥有的Attribute Usage跨时间变化及Feature Value边界所需的最小证据子图。',
      examObjectiveIds: ['MU-FND-7.7', 'MU-FND-7.9'],
      anchorNodeIds: ['sysml20:AttributeUsage', 'sysml20:OccurrenceUsage', 'sysml20:TimeSliceUsage', 'sysml20:SnapshotUsage'],
      requiredClaimIds: ['claim-mu-attribute', 'claim-mu-occurrence-varying-features', 'claim-mu-timeslice-snapshot', 'claim-feature-value-fixed-vs-initial', 'claim-feature-value-default'],
      requiredEdgeIds: ['edge-mu-sysml20-attributeusage-typed-by-sysml20-attributedefinition', 'edge-mu-sysml20-occurrenceusage-typed-by-sysml20-occurrencedefinition', 'edge-mu-sysml20-timesliceusage-specializes-sysml20-occurrenceusage', 'edge-mu-sysml20-snapshotusage-specializes-sysml20-occurrenceusage'],
      guardrailIds: ['guardrail-mu-feature-value-is-not-default'],
      fixtureIds: ['fixture-mu-time-complete', 'fixture-mu-time-missing-boundary', 'fixture-mu-time-forbidden-inference']
    })
  ];
}

function claim({ claimId, subjectNodeId, predicate, objectNodeId, claimText, evidenceIds, examObjectiveIds, knownPointIds, searchTerms }) {
  return {
    claimId,
    claimType: 'normative',
    subjectNodeId,
    predicate,
    ...(objectNodeId ? { objectNodeId } : {}),
    operators: [],
    astContextIds: [subjectNodeId],
    claimText,
    evidenceIds,
    properties: {
      phase: 6,
      examObjectiveIds,
      knownPointIds,
      searchTerms
    }
  };
}

function guardrail({ overlayId, description, forbiddenText, supportedByClaimIds, counterexampleIds }) {
  return {
    overlayId,
    overlayType: 'answer_guardrail',
    authorityClass: 'engineering_guardrail',
    description,
    patternSpec: [{ kind: 'substring', value: forbiddenText }],
    counterexampleSpec: { counterexampleIds },
    supportedByClaimIds,
    reviewStatus: 'reviewed',
    properties: { scope: 'model_user_semantic_answer' }
  };
}

function pattern(value) {
  return {
    ...value,
    reviewStatus: 'reviewed',
    properties: { closureDimensions: ['definition', 'relation', 'boundary', 'counterexample'] }
  };
}

module.exports = {
  knowledgePatternClaims,
  knowledgePatternEvidenceBlocks,
  knowledgePatternGuardrails,
  knowledgePatterns
};
