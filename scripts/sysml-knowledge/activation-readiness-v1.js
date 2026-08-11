'use strict';

const ACTIVATION_READINESS_SCHEMA_VERSION = 'sysml-knowledge-activation-readiness/v1';

function evaluateActivationReadiness({ productionResponsibilities = [], capabilityEvaluation = {} } = {}) {
  const responsibilities = Array.isArray(productionResponsibilities) ? productionResponsibilities : [];
  const pendingProductionSemanticReviews = responsibilities.filter((item) => (
    item?.reviewStatus !== 'reviewed' || item?.properties?.semanticReviewRequired !== false
  )).length;
  const claimEvidenceSemanticEntailment = String(
    capabilityEvaluation?.claimEvidenceGovernance?.semanticEntailment || 'NOT_ASSERTED'
  );
  const representation = capabilityEvaluation?.modelUserRepresentationClosure || {};
  const completeObjectives = Number(representation.completeObjectives || 0);
  const totalObjectives = Number(representation.totalObjectives || 0);
  const representationClosed = representation.status === 'COMPLETE'
    && representation.publicationGate === true
    && totalObjectives > 0
    && completeObjectives === totalObjectives;

  const checks = {
    productionSemanticReview: {
      status: pendingProductionSemanticReviews === 0 ? 'PASS' : 'PENDING',
      reviewed: responsibilities.length - pendingProductionSemanticReviews,
      pending: pendingProductionSemanticReviews,
      total: responsibilities.length
    },
    claimEvidenceSemanticEntailment: {
      status: claimEvidenceSemanticEntailment === 'PASS' ? 'PASS' : 'PENDING',
      result: claimEvidenceSemanticEntailment
    },
    modelUserRepresentationClosure: {
      status: representationClosed ? 'PASS' : 'PENDING',
      completeObjectives,
      totalObjectives,
      result: String(representation.status || 'NOT_ASSERTED')
    }
  };
  const blockers = [];
  if (checks.productionSemanticReview.status !== 'PASS') {
    blockers.push({
      code: 'PRODUCTION_SEMANTIC_REVIEW_PENDING',
      count: pendingProductionSemanticReviews
    });
  }
  if (checks.claimEvidenceSemanticEntailment.status !== 'PASS') {
    blockers.push({
      code: 'CLAIM_EVIDENCE_SEMANTIC_ENTAILMENT_PENDING',
      result: claimEvidenceSemanticEntailment
    });
  }
  if (checks.modelUserRepresentationClosure.status !== 'PASS') {
    blockers.push({
      code: 'MODEL_USER_REPRESENTATION_CLOSURE_PENDING',
      completeObjectives,
      totalObjectives
    });
  }

  return {
    schemaVersion: ACTIVATION_READINESS_SCHEMA_VERSION,
    status: blockers.length === 0 ? 'READY' : 'BLOCKED',
    activationAllowed: blockers.length === 0,
    checks,
    blockers
  };
}

module.exports = {
  ACTIVATION_READINESS_SCHEMA_VERSION,
  evaluateActivationReadiness
};
