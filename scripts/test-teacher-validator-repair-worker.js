'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

function usage(input = 20, output = 10) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 }
  };
}

function toolStep(toolCallId, toolName, input) {
  return toolCallsStep([{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) }]);
}

function toolCallsStep(content) {
  return {
    content,
    finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
    usage: usage(),
    warnings: []
  };
}

function hash(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, output));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectStrings(item, output));
  }
  return output;
}

function countOccurrences(value, search) {
  return search ? value.split(search).length - 1 : 0;
}

function repairTaskMessages(content = '修复当前模型。') {
  return [{ role: 'user', content }];
}

function validation(status, message = 'validation result') {
  const passed = status === 'passed';
  return {
    validator: {
      authority: 'official-sysml-v2-validator',
      version: '2026-04/0.59.0/test',
      evidenceHash: hash(`${status}:${message}`)
    },
    official: {
      syntax: passed ? 'passed' : 'failed',
      semantic: passed ? 'passed' : 'not_run',
      diagnostics: passed ? [] : [{ severity: 'error', message, line: 2, column: 3 }]
    },
    courseRuleApplicability: 'not_applicable',
    completeness: 'complete',
    diagnosticSummary: { total: passed ? 0 : 1, included: passed ? 0 : 1, truncated: false },
    structureEvidence: {
      source: passed ? 'official_semantic_outline' : 'local_structure_analyzer',
      authority: passed ? 'authoritative' : 'advisory',
      status: passed ? 'available' : 'partial',
      ...(passed ? { contentHash: hash(`outline:${message}`) } : {}),
      nodes: [{ kind: 'part def', name: 'Vehicle', line: 2 }],
      diagnostics: [],
      truncated: false
    },
    candidateWorkspaceHash: hash(`workspace:${status}:${message}`),
    patches: []
  };
}

function semanticValidation(message = 'semantic validation result') {
  const output = validation('failed', message);
  output.official.syntax = 'passed';
  output.official.semantic = 'failed';
  return output;
}

async function main() {
  const { MockLanguageModelV4 } = await import('ai/test');
  const {
    projectRepairTelemetryCheckpointState,
    runValidatorRepairWorker
  } = await import('../apps/teacher/dist/agent/validator-repair-worker.mjs');
  const runtime = await import('../apps/teacher/dist/agent/index.mjs');

  const original = 'package Demo { part def Broken; }';
  const failedCandidate = 'package Demo { part def Vehicle { part missing : MissingType; } }';
  const passedCandidate = 'package Demo { part def MissingType; part def Vehicle { part fixed : MissingType; } }';
  const largeIssueMarker = 'RUN05_LARGE_DIAGNOSTIC_CANDIDATE_BODY_MUST_NOT_PERSIST';
  const largeIssues = Array.from({ length: 200 }, (_, index) => ({
    issueId: hash(`large-issue-${index}`),
    category: 'semantic',
    priority: 2,
    severity: 'error',
    code: `LARGE_${index}`,
    message: `${largeIssueMarker}:${index}:${'diagnostic-body-'.repeat(100)}`,
    fileId: 'file_main',
    line: index + 1,
    column: 1
  }));
  const largeIssueSet = {
    protocolVersion: 'repair-issue-set-v1',
    candidateHash: hash('large-candidate'),
    validatorEvidenceHash: hash('large-validator-evidence'),
    issueCount: largeIssues.length,
    categoryCounts: { syntax: 0, semantic: 200, course: 0 },
    issues: largeIssues,
    clusters: Array.from({ length: 20 }, (_, index) => ({
      clusterId: hash(`large-cluster-${index}`),
      category: 'semantic',
      priority: 2,
      fileId: 'file_main',
      issueCount: 10,
      issues: largeIssues.slice(index * 10, index * 10 + 10)
    })),
    activeCluster: {
      clusterId: hash('large-active-cluster'),
      category: 'semantic',
      priority: 2,
      fileId: 'file_main',
      issueCount: largeIssues.length,
      issues: largeIssues
    }
  };
  const largeCheckpointState = projectRepairTelemetryCheckpointState({
    contextAdmissions: Array.from({ length: 24 }, (_, index) => ({
      stepNumber: index,
      roundEpoch: index + 1,
      estimatedInputTokensBeforePrune: 20_000 + index,
      estimatedInputTokens: 8_000 + index,
      prunedInputTokens: 12_000,
      messageCountBeforePrune: 20,
      messageCountAfterSdkPrune: 2,
      messageCountAfterPrune: 1,
      latestCandidateOccurrences: 1,
      visibleOutputReserveTokens: 2_000,
      projectedTokens: 10_000,
      remainingTokens: 54_000,
      knowledgeQueriesThisRound: 1,
      candidateAttempts: index
    })),
    convergenceTrace: {
      initialIssueSet: largeIssueSet,
      latestIssueSet: largeIssueSet,
      latestDiagnosticDelta: {
        protocolVersion: 'repair-diagnostic-delta-v1',
        resolved: largeIssues,
        unchanged: largeIssues,
        introduced: largeIssues,
        regressed: largeIssues,
        counts: { resolved: 200, unchanged: 200, introduced: 200, regressed: 200 }
      },
      rounds: Array.from({ length: 20 }, (_, index) => ({
        round: index + 1,
        candidateHash: hash(`round-candidate-${index}`),
        validatorEvidenceHash: hash(`round-evidence-${index}`),
        issueCount: 200 - index,
        activeClusterId: hash('large-active-cluster'),
        activeCategory: 'semantic',
        diagnosticDelta: { resolved: index, unchanged: 200 - index, introduced: 1, regressed: 0 },
        changedLineCount: index,
        changedDeclarationKinds: Array.from({ length: 40 }, (_, kind) => `kind-${kind}`),
        changedStructureNodeCount: index,
        outOfClusterChange: false
      }))
    },
    noProgress: false
  });
  const largeCheckpointText = JSON.stringify(largeCheckpointState);
  assert(Buffer.byteLength(largeCheckpointText, 'utf8') < 64 * 1024,
    '200 diagnostics must stay below the existing 64KB execution-state limit');
  assert.equal(largeCheckpointState.convergenceTrace.latestIssueSet.issueCount, 200);
  assert.equal(largeCheckpointState.convergenceTrace.latestIssueSet.categoryCounts.semantic, 200);
  assert.equal(largeCheckpointState.convergenceTrace.latestIssueSet.activeCluster.issues.length, 8);
  assert.equal(largeCheckpointState.convergenceTrace.latestIssueSet.clusters.length, 12);
  assert(largeCheckpointState.convergenceTrace.latestIssueSet.activeCluster.issues.every((issue) => issue.messageHash));
  assert(!largeCheckpointText.includes(largeIssueMarker),
    'checkpoint issue samples must hash diagnostic text instead of persisting Candidate-like content');
  assert(!largeCheckpointText.includes('reasoning'), 'checkpoint projection must not contain reasoning');
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCallsStep([
        { type: 'tool-call', toolCallId: 'knowledge-1', toolName: 'search_reviewed_knowledge', input: JSON.stringify({ query: 'SysML v2 part usage type resolution' }) },
        { type: 'tool-call', toolCallId: 'knowledge-2', toolName: 'search_reviewed_knowledge', input: JSON.stringify({ query: 'SysML v2 missing type definition' }) },
        { type: 'tool-call', toolCallId: 'knowledge-3', toolName: 'search_reviewed_knowledge', input: JSON.stringify({ query: 'SysML v2 definition and usage' }) },
        { type: 'tool-call', toolCallId: 'knowledge-over-budget', toolName: 'search_reviewed_knowledge', input: JSON.stringify({ query: 'must not execute in round one' }) }
      ]),
      toolStep('candidate-1', 'submit_candidate_for_validation', { content: failedCandidate }),
      toolCallsStep([
        { type: 'tool-call', toolCallId: 'knowledge-4', toolName: 'search_reviewed_knowledge', input: JSON.stringify({ query: 'SysML v2 cascading type errors' }) },
        { type: 'tool-call', toolCallId: 'knowledge-5', toolName: 'search_reviewed_knowledge', input: JSON.stringify({ query: 'SysML v2 type closure' }) },
        { type: 'tool-call', toolCallId: 'knowledge-6', toolName: 'search_reviewed_knowledge', input: JSON.stringify({ query: 'SysML v2 repair validation' }) }
      ]),
      toolCallsStep([
        { type: 'text', text: '正文中的另一个模型和修复说明必须被忽略。```sysml\npackage Wrong {}\n```' },
        { type: 'tool-call', toolCallId: 'candidate-2', toolName: 'submit_candidate_for_validation', input: JSON.stringify({ content: passedCandidate }) }
      ])
    ]
  });
  const validated = [];
  const searched = [];
  const result = await runValidatorRepairWorker({
    model,
    instructions: 'Use tools to repair the model.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 6,
    maxValidatorCalls: 8,
    initialValidatorCalls: 1,
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: true,
    searchReviewedKnowledge: async (input) => {
      searched.push(input);
      return {
        coverage: 'COMPLETE',
        closureStatus: 'complete',
        resultHash: hash(`knowledge:${input.query}`),
        claims: Array.from({ length: 8 }, (_, index) => ({
          claimId: `claim-${index}`,
          claimText: `claim-${index}-${'K'.repeat(1_000)}`,
          authorityLevel: 'A1',
          evidenceIds: [`evidence-${index}`]
        })),
        evidenceBlocks: Array.from({ length: 8 }, (_, index) => ({
          evidenceId: `evidence-${index}`,
          sectionPath: `Section ${index}`,
          excerpt: `evidence-${index}-${'E'.repeat(1_000)}`,
          authorityLevel: 'A1'
        }))
      };
    },
    validateCandidate: async (input) => {
      validated.push(input);
      return {
        candidate: { content: input.content, contentHash: input.contentHash },
        validation: validation(input.content === passedCandidate ? 'passed' : 'failed', input.contentHash)
      };
    },
    validationPassed: (output) => output.official.syntax === 'passed' && output.official.semantic === 'passed',
    validationRetryable: (output) => output.official.syntax !== 'unavailable'
  });

  assert.equal(result.terminalStopReason, 'validator_passed');
  assert.equal(result.accepted?.content, passedCandidate, 'accepted content must come from the successful Tool call verbatim');
  assert.equal(result.accepted?.candidate.content, passedCandidate);
  assert.equal(result.validatorCalls, 3, 'initial baseline and two actual candidate validations must be counted');
  assert.equal(result.candidateAttempts, 2);
  assert.equal(result.candidateSubmissionCalls, 2);
  assert.equal(result.convergenceTrace.rounds.length, 2);
  assert.equal(result.convergenceTrace.rounds[0].diagnosticDelta.introduced, 1);
  assert.equal(result.convergenceTrace.rounds[1].diagnosticDelta.resolved, 1);
  assert.equal(result.convergenceTrace.latestIssueSet.issueCount, 0);
  assert.equal(result.convergenceTrace.latestCandidateChangeSummary.toCandidateHash, hash(passedCandidate));
  assert.equal(result.knowledgeQueries, 2,
    'each new active cluster may use one issue-directed query before its candidate submission');
  assert.equal(result.knowledgeBackendCalls, 2);
  assert.equal(result.knowledgeNoNewEvidenceCount, 0);
  assert.deepEqual(result.knowledgeQueriesByRound, [{ round: 1, queries: 1 }, { round: 2, queries: 1 }]);
  assert.equal(searched.length, 2,
    'concurrent synonymous searches must not pass the first in-flight backend query of each round');
  assert.deepEqual([...new Set(searched.map((item) => item.roundEpoch))], [1, 2]);
  assert.deepEqual(searched[0].alreadyProvidedClaimIds, []);
  assert(searched.slice(1).some((item) => item.alreadyProvidedClaimIds.includes('claim-0')));
  assert.deepEqual(validated.map((item) => item.content), [failedCandidate, passedCandidate]);
  assert.equal(result.attempts[1].inputContentHash, hash(passedCandidate));
  assert.equal(result.attempts[1].validatorEvidenceHash, result.accepted.validation.validator.evidenceHash);
  assert.equal(result.attempts[1].structureEvidenceSource, 'official_semantic_outline');
  assert.equal(result.attempts[0].diagnosticTotal, 1);
  assert.equal(result.attempts[0].diagnosticIncluded, 1);
  assert.equal(result.attempts[0].diagnosticTruncated, false);
  assert.equal(result.attempts[0].structureEvidenceTruncated, false);
  const serializedCalls = JSON.stringify(model.doGenerateCalls);
  const modelCallText = collectStrings(model.doGenerateCalls).join('\n');
  assert(modelCallText.includes('"protocolVersion":"repair-knowledge-progressive-v1"'));
  assert(modelCallText.includes('"totalClaims":8'));
  assert(modelCallText.includes('"includedClaims":8'));
  assert(modelCallText.includes('"modelViewTokenBudget":3000'));
  for (const match of modelCallText.matchAll(/"estimatedModelViewTokens":(\d+)/gu)) {
    assert(Number(match[1]) <= 3000, 'knowledge must be bounded by the total model-view token budget');
  }
  assert(modelCallText.includes('"coverage":"COMPLETE"'));
  assert(modelCallText.includes('"truncated":true'));
  assert(modelCallText.includes('K'.repeat(1_000)), 'a Claim that fits the total budget must not be cut at a fixed character limit');
  assert(modelCallText.includes('E'.repeat(1_000)), 'an Evidence span that fits the total budget must remain complete');
  assert(model.doGenerateCalls.every((call) => call.responseFormat === undefined), 'Repair Worker must not use Output.object/JSON response format');
  assert(model.doGenerateCalls.every((call) => call.maxOutputTokens === undefined),
    'Repair开放式生成必须省略Provider输出硬帽');
  assert(model.doGenerateCalls.every((call) => call.toolChoice?.type === 'required' || call.toolChoice?.type === 'tool'));
  assert(result.contextAdmissions.length >= 4);
  assert(result.contextAdmissions.every((item) => Number.isInteger(item.projectedTokens)));
  assert(result.contextAdmissions.every((item) => item.visibleOutputReserveTokens > 0));
  assert.equal(result.evaluationTrace, undefined, 'production mode must not retain query text or failed candidate content');

  const directSubmitModel = new MockLanguageModelV4({
    doGenerate: [toolStep('direct-submit', 'submit_candidate_for_validation', { content: passedCandidate })]
  });
  let directSearchCalls = 0;
  const directSubmit = await runValidatorRepairWorker({
    model: directSubmitModel,
    instructions: 'Submit immediately when Validator evidence is sufficient.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 6,
    maxValidatorCalls: 8,
    initialValidatorCalls: 1,
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: true,
    searchReviewedKnowledge: async () => {
      directSearchCalls += 1;
      return {};
    },
    validateCandidate: async (input) => ({
      candidate: { content: input.content },
      validation: validation('passed')
    }),
    validationPassed: (output) => output.official.syntax === 'passed' && output.official.semantic === 'passed',
    validationRetryable: () => true
  });
  assert.equal(directSubmit.terminalStopReason, 'validator_passed');
  assert.equal(directSubmit.knowledgeQueries, 0, 'three searches are a maximum, not a quota');
  assert.equal(directSearchCalls, 0);
  assert.equal(directSubmit.candidateSubmissionCalls, 1);
  assert.equal(directSubmit.knowledgeQueriesBeforeFirstCandidateSubmission, 0);
  assert(Number.isInteger(directSubmit.timeToFirstCandidateSubmissionMs));

  const semanticDirectModel = new MockLanguageModelV4({
    doGenerate: [
      toolStep('semantic-direct-1', 'submit_candidate_for_validation', { content: failedCandidate }),
      toolStep('semantic-direct-2', 'submit_candidate_for_validation', { content: passedCandidate })
    ]
  });
  let semanticDirectSearchCalls = 0;
  let semanticDirectValidationCalls = 0;
  const semanticDirect = await runValidatorRepairWorker({
    model: semanticDirectModel,
    instructions: 'Prefer actionable Official Validator diagnostics; search only after a no-progress submission.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 6,
    maxValidatorCalls: 8,
    initialValidatorCalls: 1,
    initialValidation: semanticValidation('missing semantic binding'),
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: true,
    searchReviewedKnowledge: async () => {
      semanticDirectSearchCalls += 1;
      return {};
    },
    validateCandidate: async (input) => {
      semanticDirectValidationCalls += 1;
      return {
        candidate: { content: input.content },
        validation: semanticDirectValidationCalls === 1
          ? semanticValidation('different semantic binding')
          : validation('passed')
      };
    },
    validationPassed: (output) => output.official.syntax === 'passed' && output.official.semantic === 'passed',
    validationRetryable: () => true
  });
  assert.equal(semanticDirect.terminalStopReason, 'validator_passed');
  assert.equal(semanticDirectSearchCalls, 0,
    'an obvious error may still skip the available search lane because the query ceiling is not a quota');
  assert(semanticDirect.contextAdmissions.every((item) =>
    item.activeTools.includes('search_reviewed_knowledge')
      && item.activeTools.includes('submit_candidate_for_validation')),
  'an active semantic cluster must keep executable-evidence search available until a hard budget/result gate closes it');

  const semanticNoProgressModel = new MockLanguageModelV4({
    doGenerate: [
      toolStep('semantic-stalled-1', 'submit_candidate_for_validation', { content: failedCandidate }),
      toolStep('semantic-stalled-search', 'search_reviewed_knowledge', { query: 'semantic binding evidence' }),
      toolStep('semantic-stalled-2', 'submit_candidate_for_validation', { content: passedCandidate })
    ]
  });
  let semanticNoProgressSearchCalls = 0;
  let semanticNoProgressValidationCalls = 0;
  const semanticNoProgress = await runValidatorRepairWorker({
    model: semanticNoProgressModel,
    instructions: 'Search after one direct submission leaves trusted diagnostics unchanged.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 6,
    maxValidatorCalls: 8,
    initialValidatorCalls: 1,
    initialValidation: semanticValidation('unchanged semantic binding'),
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: true,
    searchReviewedKnowledge: async () => {
      semanticNoProgressSearchCalls += 1;
      return { coverage: 'COMPLETE', claims: [], evidenceBlocks: [] };
    },
    validateCandidate: async (input) => {
      semanticNoProgressValidationCalls += 1;
      return {
        candidate: { content: input.content },
        validation: semanticNoProgressValidationCalls === 1
          ? semanticValidation('unchanged semantic binding')
          : validation('passed')
      };
    },
    validationPassed: (output) => output.official.syntax === 'passed' && output.official.semantic === 'passed',
    validationRetryable: () => true
  });
  assert.equal(semanticNoProgress.terminalStopReason, 'validator_passed');
  assert.equal(semanticNoProgressSearchCalls, 1,
    'one direct submission with an unchanged trusted diagnostic must reopen the knowledge lane');
  assert.deepEqual(semanticNoProgress.contextAdmissions[0].activeTools,
    ['search_reviewed_knowledge', 'submit_candidate_for_validation']);
  assert.deepEqual(semanticNoProgress.contextAdmissions[1].activeTools,
    ['search_reviewed_knowledge', 'submit_candidate_for_validation']);

  const sharedEvidenceModel = new MockLanguageModelV4({
    doGenerate: [toolStep('shared-evidence-submit', 'submit_candidate_for_validation', { content: passedCandidate })]
  });
  const unrelatedSharedClaimBody = `RUN05_UNRELATED_SHARED_CLAIM_BODY_${'C'.repeat(12_000)}`;
  const unrelatedSharedEvidenceBody = `RUN05_UNRELATED_SHARED_EVIDENCE_BODY_${'E'.repeat(12_000)}`;
  const unrelatedDomainBody = `RUN05_UNRELATED_DOMAIN_BODY_${'D'.repeat(12_000)}`;
  let sharedEvidenceSearchCalls = 0;
  const sharedEvidenceResult = await runValidatorRepairWorker({
    model: sharedEvidenceModel,
    instructions: 'Use the actionable Validator diagnostics and already shared reviewed evidence before searching.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 6,
    maxValidatorCalls: 8,
    initialValidatorCalls: 1,
    initialValidation: validation('failed', 'actionable diagnostic'),
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: true,
    initialKnowledge: {
      bundleRef: 'bundle-run05-shared',
      sourceRegistryHash: hash('run05-source-registry'),
      claimIds: ['shared-claim'], evidenceIds: ['shared-evidence'], evidenceSpanIds: [], domainSourceIds: ['domain-source-run05'],
      claims: [{ claimId: 'shared-claim', claimText: unrelatedSharedClaimBody, authorityLevel: 'A1', evidenceIds: ['shared-evidence'] }],
      evidenceBlocks: [{ evidenceId: 'shared-evidence', sectionPath: 'Unrelated domain section', excerpt: unrelatedSharedEvidenceBody, authorityLevel: 'A1' }],
      disclosedClaimIds: ['shared-claim'], disclosedEvidenceIds: ['shared-evidence'], disclosedEvidenceSpanIds: [],
      sourceToolCallIds: ['candidate-search'],
      domainEvidence: {
        trust: 'untrusted_external_domain_evidence',
        researches: [{
          sourceToolCallId: 'domain-search-run05',
          questions: [unrelatedDomainBody],
          summary: unrelatedDomainBody,
          sources: [{
            sourceId: 'domain-source-run05',
            title: unrelatedDomainBody,
            url: 'https://example.com/run05-domain-source'
          }]
        }],
        disclosedSourceIds: ['domain-source-run05'],
        truncated: false
      },
      truncated: false
    },
    searchReviewedKnowledge: async () => {
      sharedEvidenceSearchCalls += 1;
      return {};
    },
    validateCandidate: async (input) => ({ candidate: { content: input.content }, validation: validation('passed') }),
    validationPassed: (output) => output.official.syntax === 'passed' && output.official.semantic === 'passed',
    validationRetryable: () => true
  });
  assert.equal(sharedEvidenceResult.knowledgeQueries, 0);
  assert.equal(sharedEvidenceSearchCalls, 0);
  assert.deepEqual(sharedEvidenceModel.doGenerateCalls[0].tools.map((item) => item.name),
    ['search_reviewed_knowledge', 'submit_candidate_for_validation'],
    'unrelated shared evidence must not hide issue-directed executable-evidence search from Repair');
  const sharedEvidencePrompt = collectStrings(sharedEvidenceModel.doGenerateCalls).join('\n');
  assert(!sharedEvidencePrompt.includes('RUN05_UNRELATED_SHARED_CLAIM_BODY_'));
  assert(!sharedEvidencePrompt.includes('RUN05_UNRELATED_SHARED_EVIDENCE_BODY_'));
  assert(!sharedEvidencePrompt.includes('RUN05_UNRELATED_DOMAIN_BODY_'),
    'a syntax/Validator-local Repair must not replay Domain Search bodies');
  assert(sharedEvidencePrompt.includes('shared-claim')
    && sharedEvidencePrompt.includes('shared-evidence')
    && sharedEvidencePrompt.includes('domain-source-run05'),
  'Repair must retain knowledge references even when unrelated bodies are not admitted');
  assert.equal(countOccurrences(sharedEvidencePrompt, original), 1,
    'the latest Candidate must remain the only Candidate copy after evidence admission');
  assert(sharedEvidenceResult.contextAdmissions[0].estimatedInputTokens < 5_000,
    'syntax-local WorkerResumeView must stay compact despite long prior knowledge and Domain Search bodies');

  const progressiveModel = new MockLanguageModelV4({
    doGenerate: [
      toolStep('progressive-legacy', 'search_reviewed_knowledge', { query: 'type resolution' }),
      toolStep('progressive-duplicate', 'search_reviewed_knowledge', { query: '  TYPE   resolution ' }),
      toolStep('progressive-new', 'search_reviewed_knowledge', { query: 'evidence expansion' }),
      toolStep('progressive-submit', 'submit_candidate_for_validation', { content: passedCandidate })
    ]
  });
  const progressiveInputs = [];
  const progressiveAudit = [];
  const progressiveModelAudit = [];
  let progressiveBackendCalls = 0;
  const progressiveObserved = await runtime.withModelCallAuditContext({
    runId: 'run_progressive_per_provider_step_audit',
    promptVersion: 'repair-progressive-audit-test-v1',
    record: async (entry) => { progressiveModelAudit.push(entry); }
  }, async () => await runValidatorRepairWorker({
    model: progressiveModel,
    instructions: 'Use progressive knowledge, then submit.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 6,
    maxValidatorCalls: 8,
    initialValidatorCalls: 1,
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: true,
    evaluationMode: 'local_benchmark',
    searchReviewedKnowledge: async (input) => {
      progressiveBackendCalls += 1;
      progressiveInputs.push(input);
      if (input.query === 'type resolution') {
        return {
          coverage: 'PARTIAL',
          claims: [{ claimId: 'claim-type', claimText: 'A usage is typed by a definition.', authorityLevel: 'A1', evidenceIds: ['evidence-type'] }],
          evidenceBlocks: [{
            evidenceId: 'evidence-type',
            excerpt: 'Introductory definition paragraph.\n\nType resolution binds a usage to a definition.\n\n```sysml\nrequirement def R { doc /* complete code block */ }\n```',
            sectionPath: 'Types',
            authorityLevel: 'A1'
          }]
        };
      }
      return {
        coverage: 'COMPLETE',
        newClaims: [],
        newEvidenceBlocks: [{ evidenceId: 'evidence-expanded', excerpt: 'Expanded evidence.', sectionPath: 'Types', authorityLevel: 'A1' }],
        alreadyProvidedClaimIds: ['claim-type'],
        no_new_evidence: false
      };
    },
    recordKnowledgeQueryAudit: async (entry) => progressiveAudit.push(entry),
    validateCandidate: async (input) => ({ candidate: { content: input.content }, validation: validation('passed') }),
    validationPassed: (output) => output.official.syntax === 'passed' && output.official.semantic === 'passed',
    validationRetryable: () => true
  }));
  const progressive = progressiveObserved.value;
  assert.equal(progressive.terminalStopReason, 'validator_passed');
  assert.equal(progressive.knowledgeQueries, 3);
  assert.equal(progressive.knowledgeBackendCalls, 2, 'an exact normalized duplicate must consume the action budget without hitting the backend');
  assert.equal(progressiveBackendCalls, 2);
  assert.deepEqual(progressiveAudit.map((item) => item.status), ['duplicate_query']);
  assert(progressiveInputs[1].alreadyProvidedClaimIds.includes('claim-type'));
  assert.equal(progressive.knowledgeNoNewEvidenceCount, 0, 'cached adjacent spans are new model evidence even when the backend query is deduplicated');
  assert.deepEqual(progressive.evaluationTrace.knowledgeQueries.map((item) => item.status), ['ok', 'ok', 'ok']);
  const progressiveHistory = collectStrings(progressiveModel.doGenerateCalls).join('\n');
  assert(progressiveHistory.includes('Type resolution binds a usage to a definition.'));
  assert(progressiveHistory.includes('Introductory definition paragraph.'));
  assert(progressiveHistory.includes('```sysml\\nrequirement def R { doc /* complete code block */ }\\n```'));
  assert.equal(progressive.evaluationTrace.failedCandidates.length, 0);
  assert.equal(progressiveModelAudit.length, 4);
  assert(progressiveModelAudit.every((entry) => entry.callId && entry.startedAt && entry.completedAt));
  assert(Date.parse(progressiveModelAudit[1].startedAt) >= Date.parse(progressiveModelAudit[0].completedAt),
    'each Provider step must retain its own start/end interval instead of sharing the whole ToolLoop duration');

  const seenButUndisclosedModel = new MockLanguageModelV4({
    doGenerate: [
      toolStep('seen-but-undisclosed-search', 'search_reviewed_knowledge', { query: 'connection syntax' }),
      toolStep('seen-but-undisclosed-submit', 'submit_candidate_for_validation', { content: passedCandidate })
    ]
  });
  const seenButUndisclosed = await runValidatorRepairWorker({
    model: seenButUndisclosedModel,
    instructions: 'Search when needed, then submit.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 6,
    maxValidatorCalls: 8,
    initialValidatorCalls: 1,
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: true,
    initialKnowledge: {
      claimIds: ['claim-seen-only'],
      evidenceIds: [],
      evidenceSpanIds: [],
      claims: [],
      evidenceBlocks: [],
      disclosedClaimIds: [],
      disclosedEvidenceIds: [],
      disclosedEvidenceSpanIds: [],
      sourceToolCallIds: [],
      truncated: false
    },
    searchReviewedKnowledge: async () => ({
      coverage: 'COMPLETE',
      claims: [{
        claimId: 'claim-seen-only',
        claimText: 'A connection usage binds compatible connector ends.',
        authorityLevel: 'A1',
        evidenceIds: ['evidence-connection']
      }],
      evidenceBlocks: []
    }),
    validateCandidate: async (input) => ({
      candidate: { content: input.content },
      validation: validation('passed')
    }),
    validationPassed: (output) => output.official.syntax === 'passed' && output.official.semantic === 'passed',
    validationRetryable: () => true
  });
  assert.equal(seenButUndisclosed.terminalStopReason, 'validator_passed');
  assert(
    JSON.stringify(seenButUndisclosedModel.doGenerateCalls).includes('A connection usage binds compatible connector ends.'),
    'Seen ID不得冒充已经披露给Repair模型的证据内容'
  );

  const repeatedModel = new MockLanguageModelV4({
    doGenerate: [
      toolStep('repeat-original', 'submit_candidate_for_validation', { content: original }),
      toolStep('new-candidate', 'submit_candidate_for_validation', { content: passedCandidate })
    ]
  });
  let repeatedValidationCalls = 0;
  const repeated = await runValidatorRepairWorker({
    model: repeatedModel,
    instructions: 'Use the validation submission tool.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 6,
    maxValidatorCalls: 8,
    initialValidatorCalls: 1,
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: false,
    searchReviewedKnowledge: async () => { throw new Error('search must remain disabled'); },
    validateCandidate: async (input) => {
      repeatedValidationCalls += 1;
      return { candidate: { content: input.content }, validation: validation('passed') };
    },
    validationPassed: (output) => output.official.syntax === 'passed' && output.official.semantic === 'passed',
    validationRetryable: () => true
  });
  assert.equal(repeated.candidateSubmissionCalls, 2);
  assert.equal(repeated.candidateRepeatedCount, 1);
  assert.equal(repeated.candidateAttempts, 1, 'duplicate candidates must not consume candidate attempts');
  assert.equal(repeated.validatorCalls, 2, 'duplicate candidates must not call Validator');
  assert.equal(repeatedValidationCalls, 1);

  const invalidToolModel = new MockLanguageModelV4({
    doGenerate: [
      toolStep('invalid-candidate-input', 'submit_candidate_for_validation', { explanation: 'missing content' }),
      toolStep('valid-after-input-error', 'submit_candidate_for_validation', { content: passedCandidate })
    ]
  });
  let validationAfterInvalidCalls = 0;
  const invalidThenValid = await runValidatorRepairWorker({
    model: invalidToolModel,
    instructions: 'Use the validation submission tool.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 6,
    maxValidatorCalls: 8,
    initialValidatorCalls: 1,
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: false,
    searchReviewedKnowledge: async () => ({}),
    validateCandidate: async (input) => {
      validationAfterInvalidCalls += 1;
      return { candidate: { content: input.content }, validation: validation('passed') };
    },
    validationPassed: (output) => output.official.syntax === 'passed' && output.official.semantic === 'passed',
    validationRetryable: () => true
  });
  assert.equal(invalidThenValid.terminalStopReason, 'validator_passed');
  assert.equal(invalidThenValid.toolInputInvalidCount, 1);
  assert.equal(invalidThenValid.candidateSubmissionCalls, 1, 'schema-invalid tool calls must not reach the executor');
  assert.equal(invalidThenValid.candidateAttempts, 1);
  assert.equal(validationAfterInvalidCalls, 1);

  const evalFailureModel = new MockLanguageModelV4({
    doGenerate: [
      toolStep('eval-failed-candidate', 'submit_candidate_for_validation', { content: failedCandidate }),
      toolStep('eval-passed-candidate', 'submit_candidate_for_validation', { content: passedCandidate })
    ]
  });
  const evalFailure = await runValidatorRepairWorker({
    model: evalFailureModel,
    instructions: 'Submit candidates.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 6,
    maxValidatorCalls: 8,
    initialValidatorCalls: 1,
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: false,
    evaluationMode: 'local_benchmark',
    searchReviewedKnowledge: async () => ({}),
    validateCandidate: async (input) => ({
      candidate: { content: input.content },
      validation: validation(input.content === passedCandidate ? 'passed' : 'failed')
    }),
    validationPassed: (output) => output.official.syntax === 'passed' && output.official.semantic === 'passed',
    validationRetryable: () => true
  });
  assert.equal(evalFailure.evaluationTrace.failedCandidates.length, 1);
  assert.equal(evalFailure.evaluationTrace.failedCandidates[0].content, failedCandidate);
  assert.equal(evalFailure.evaluationTrace.failedCandidates[0].contentHash, hash(failedCandidate));

  const validatorUnavailableModel = new MockLanguageModelV4({
    doGenerate: [toolStep('validator-unavailable', 'submit_candidate_for_validation', { content: passedCandidate })]
  });
  const validatorUnavailable = await runValidatorRepairWorker({
    model: validatorUnavailableModel,
    instructions: 'Submit.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 6,
    maxValidatorCalls: 8,
    initialValidatorCalls: 1,
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: false,
    searchReviewedKnowledge: async () => ({}),
    validateCandidate: async () => { throw new Error('validator offline'); },
    validationPassed: () => false,
    validationRetryable: () => true
  });
  assert.equal(validatorUnavailable.terminalStopReason, 'validator_unavailable');
  assert.equal(validatorUnavailable.accepted, undefined, 'Validator unavailable must fail closed');

  const validatorQueueFullModel = new MockLanguageModelV4({
    doGenerate: [toolStep('validator-queue-full', 'submit_candidate_for_validation', { content: passedCandidate })]
  });
  const validatorQueueFull = await runValidatorRepairWorker({
    model: validatorQueueFullModel,
    instructions: 'Submit.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 6,
    maxValidatorCalls: 8,
    initialValidatorCalls: 1,
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: false,
    searchReviewedKnowledge: async () => ({}),
    validateCandidate: async () => {
      const error = new Error('Candidate Validator tool rejected the request.');
      error.code = 'VALIDATOR_QUEUE_FULL';
      throw error;
    },
    validationPassed: () => false,
    validationRetryable: () => true
  });
  assert.equal(validatorQueueFull.terminalStopReason, 'validator_queue_full');
  assert.equal(validatorQueueFull.accepted, undefined, 'Validator queue full must fail closed');

  const timedOutModel = new MockLanguageModelV4({
    doGenerate: [toolStep('time-budget-candidate', 'submit_candidate_for_validation', { content: passedCandidate })]
  });
  let timedOutValidatorCalls = 0;
  const timedOut = await runValidatorRepairWorker({
    model: timedOutModel,
    instructions: 'Submit.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 500,
    toolTimeoutMs: 500,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 6,
    maxValidatorCalls: 8,
    initialValidatorCalls: 1,
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: false,
    searchReviewedKnowledge: async () => ({}),
    validateCandidate: async () => {
      timedOutValidatorCalls += 1;
      return { candidate: {}, validation: validation('passed') };
    },
    validationPassed: () => true,
    validationRetryable: () => true
  });
  assert.equal(timedOut.terminalStopReason, 'validator_passed');
  assert.equal(timedOutValidatorCalls, 1, 'remaining Run work time must be usable when the operation completes within it');

  const stepTimeoutAudit = [];
  const stepTimeoutModel = new MockLanguageModelV4({
    doGenerate: async (options) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500);
        options.abortSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(options.abortSignal.reason || new DOMException('Timed out', 'TimeoutError'));
        }, { once: true });
      });
      return toolStep('step-timeout-unreachable', 'submit_candidate_for_validation', { content: passedCandidate });
    }
  });
  const noStepCutoff = await runtime.withModelCallAuditContext({
      runId: 'run_repair_step_timeout',
      promptVersion: 'repair-shared-window-test-v1',
      record: async (entry) => { stepTimeoutAudit.push(entry); }
    }, async () => await runValidatorRepairWorker({
      model: stepTimeoutModel,
      instructions: 'Submit.',
      taskMessages: repairTaskMessages(),
      abortSignal: new AbortController().signal,
      timeoutMs: 2_000,
      toolTimeoutMs: 10,
      contextWindowTokens: 64_000,
      maxCandidateAttempts: 6,
      maxValidatorCalls: 8,
      initialValidatorCalls: 1,
      initialCandidateContent: original,
      targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
      knowledgeSearchEnabled: false,
      searchReviewedKnowledge: async () => ({}),
      validateCandidate: async () => ({ candidate: {}, validation: validation('passed') }),
      validationPassed: () => true,
      validationRetryable: () => true
    }));
  assert.equal(noStepCutoff.value.terminalStopReason, 'validator_passed');
  assert.equal(stepTimeoutAudit.length, 1, 'the shared work window must produce one real Provider audit row');

  const timeoutProgress = [];
  const hardTimeoutModel = new MockLanguageModelV4({
    doGenerate: async () => {
      const error = new Error('Step timeout of 10ms exceeded.');
      error.name = 'StepTimeoutError';
      throw error;
    }
  });
  await assert.rejects(
    () => runValidatorRepairWorker({
      model: hardTimeoutModel,
      instructions: 'Submit without exposing internal reasoning.',
      taskMessages: repairTaskMessages('RUN05_TIMEOUT_CANDIDATE_BODY_MUST_NOT_PERSIST'),
      abortSignal: new AbortController().signal,
      timeoutMs: 2_000,
      toolTimeoutMs: 10,
      contextWindowTokens: 64_000,
      maxCandidateAttempts: 6,
      maxValidatorCalls: 8,
      initialValidatorCalls: 1,
      initialCandidateContent: `${original}\n// RUN05_TIMEOUT_CANDIDATE_BODY_MUST_NOT_PERSIST`,
      targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
      knowledgeSearchEnabled: false,
      searchReviewedKnowledge: async () => ({}),
      validateCandidate: async () => ({ candidate: {}, validation: validation('passed') }),
      validationPassed: () => true,
      validationRetryable: () => true,
      onCheckpointProgress: async (progress) => { timeoutProgress.push(progress); }
    }),
    (error) => error?.name === 'RepairStepTimeoutError' && error?.message === 'repair_step_timeout'
  );
  assert(timeoutProgress.some((progress) => progress.boundary === 'terminal'),
    'Provider step timeout must publish a terminal Repair checkpoint projection before throwing');
  const timeoutState = timeoutProgress.at(-1)?.repairState;
  assert(timeoutState?.contextAdmissions?.length > 0,
    'timeout checkpoint projection must preserve at least one context admission');
  assert(timeoutState.metrics.maxInputBeforePrune > 0);
  assert(timeoutState.metrics.maxInputAfterPrune > 0);
  const timeoutProjectionText = JSON.stringify(timeoutProgress);
  assert(!timeoutProjectionText.includes('RUN05_TIMEOUT_CANDIDATE_BODY_MUST_NOT_PERSIST'),
    'Repair checkpoint projection must not contain Candidate body or prompt text');
  assert(!timeoutProjectionText.includes('reasoning') && !timeoutProjectionText.includes('messages'),
    'Repair checkpoint projection must not contain reasoning or message history');
  assert.equal(stepTimeoutAudit[0].status, 'succeeded');
  assert(Date.parse(stepTimeoutAudit[0].completedAt) >= Date.parse(stepTimeoutAudit[0].startedAt));
  assert.equal(runtime.intentV2ExecutionTesting.workerStopReason({
    version: 'worker-result-v2', runId: 'run-validator-queue', taskId: 'task-validator-queue', taskRevision: 1,
    workerType: 'candidate', mode: 'complete', status: 'validated_failed', reason: 'validator_unavailable:VALIDATOR_QUEUE_TIMEOUT', attemptCount: 1
  }, {
    workDeadlineSignal: new AbortController().signal,
    hardDeadlineSignal: new AbortController().signal,
  }), 'validator_queue_timeout');

  const concurrentCandidate = 'package Demo { part def Other; }';
  const concurrentModel = new MockLanguageModelV4({
    doGenerate: [
      toolCallsStep([
        { type: 'tool-call', toolCallId: 'concurrent-first', toolName: 'submit_candidate_for_validation', input: JSON.stringify({ content: failedCandidate }) },
        { type: 'tool-call', toolCallId: 'concurrent-second', toolName: 'submit_candidate_for_validation', input: JSON.stringify({ content: concurrentCandidate }) }
      ]),
      toolStep('concurrent-final', 'submit_candidate_for_validation', { content: passedCandidate })
    ]
  });
  const concurrentValidated = [];
  const concurrent = await runValidatorRepairWorker({
    model: concurrentModel,
    instructions: 'Submit one candidate at a time.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 6,
    maxValidatorCalls: 8,
    initialValidatorCalls: 1,
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: false,
    searchReviewedKnowledge: async () => ({}),
    validateCandidate: async (input) => {
      concurrentValidated.push(input.content);
      if (input.content === failedCandidate) await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        candidate: { content: input.content },
        validation: validation(input.content === passedCandidate ? 'passed' : 'failed')
      };
    },
    validationPassed: (output) => output.official.syntax === 'passed' && output.official.semantic === 'passed',
    validationRetryable: () => true
  });
  assert.equal(concurrent.terminalStopReason, 'validator_passed');
  assert.deepEqual(concurrentValidated, [failedCandidate, passedCandidate]);
  assert.equal(concurrent.candidateSubmissionCalls, 3);
  assert.equal(concurrent.candidateAttempts, 2, 'in-flight concurrent submission must not consume a candidate attempt');

  const staleModel = new MockLanguageModelV4({
    doGenerate: [
      toolCallsStep([
        { type: 'tool-call', toolCallId: 'stale-search', toolName: 'search_reviewed_knowledge', input: JSON.stringify({ query: 'delayed prior round query' }) },
        { type: 'tool-call', toolCallId: 'stale-candidate', toolName: 'submit_candidate_for_validation', input: JSON.stringify({ content: failedCandidate }) }
      ]),
      toolStep('stale-final', 'submit_candidate_for_validation', { content: passedCandidate })
    ]
  });
  const stale = await runValidatorRepairWorker({
    model: staleModel,
    instructions: 'Keep round epochs isolated.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 6,
    maxValidatorCalls: 8,
    initialValidatorCalls: 1,
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: true,
    evaluationMode: 'local_benchmark',
    searchReviewedKnowledge: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { claims: [], evidenceBlocks: [], no_new_evidence: true };
    },
    validateCandidate: async (input) => ({
      candidate: { content: input.content },
      validation: validation(input.content === passedCandidate ? 'passed' : 'failed')
    }),
    validationPassed: (output) => output.official.syntax === 'passed' && output.official.semantic === 'passed',
    validationRetryable: () => true
  });
  assert.equal(stale.terminalStopReason, 'validator_passed');
  assert.equal(stale.evaluationTrace.knowledgeQueries[0].status, 'completed_for_prior_round');
  assert.deepEqual(stale.knowledgeQueriesByRound, [{ round: 1, queries: 1 }, { round: 2, queries: 0 }]);
  const largeFailedCandidate = `package Demo {\n${' '.repeat(4_900)}part def Broken;\n}`;
  const contextStopModel = new MockLanguageModelV4({
    doGenerate: [
      toolCallsStep([
        { type: 'tool-call', toolCallId: 'context-search-1', toolName: 'search_reviewed_knowledge', input: JSON.stringify({ query: 'context query 1' }) },
        { type: 'tool-call', toolCallId: 'context-search-2', toolName: 'search_reviewed_knowledge', input: JSON.stringify({ query: 'context query 2' }) },
        { type: 'tool-call', toolCallId: 'context-search-3', toolName: 'search_reviewed_knowledge', input: JSON.stringify({ query: 'context query 3' }) }
      ]),
      toolStep('context-failed-candidate', 'submit_candidate_for_validation', { content: largeFailedCandidate }),
      toolStep('context-search-4', 'search_reviewed_knowledge', { query: 'context query 4' }),
      toolStep('context-search-5', 'search_reviewed_knowledge', { query: 'context query 5' }),
      toolStep('context-search-6', 'search_reviewed_knowledge', { query: 'context query 6' }),
      toolStep('context-final', 'submit_candidate_for_validation', { content: passedCandidate }),
      toolCallsStep([{ type: 'text', text: 'done' }])
    ]
  });
  const contextStop = await runValidatorRepairWorker({
    model: contextStopModel,
    instructions: 'Repair.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 16_000,
    maxCandidateAttempts: 6,
    maxValidatorCalls: 8,
    initialValidatorCalls: 1,
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: true,
    searchReviewedKnowledge: async ({ query }) => ({
      coverage: 'PARTIAL',
      claims: Array.from({ length: 6 }, (_, index) => ({
        claimId: `${query.replace(/\s+/g, '-')}-claim-${index}`,
        claimText: `${query}-${index}-${'K'.repeat(600)}`,
        authorityLevel: 'A1',
        evidenceIds: [`${query.replace(/\s+/g, '-')}-evidence-${index}`]
      })),
      evidenceBlocks: Array.from({ length: 6 }, (_, index) => ({
        evidenceId: `${query.replace(/\s+/g, '-')}-evidence-${index}`,
        excerpt: `${query}-${index}-${'E'.repeat(600)}`,
        sectionPath: 'Large context evidence',
        authorityLevel: 'A1'
      }))
    }),
    validateCandidate: async (input) => ({ candidate: {}, validation: validation(input.content === passedCandidate ? 'passed' : 'failed') }),
    validationPassed: (output) => output.official.syntax === 'passed' && output.official.semantic === 'passed',
    validationRetryable: () => true
  });
  assert.equal(contextStop.terminalStopReason, 'validator_passed');
  assert.equal(contextStop.candidateAttempts, 2, 'bounded resume context must reach the next complete candidate');
  assert(contextStopModel.doGenerateCalls.length >= 2);
  assert(contextStop.contextAdmissions.every((item) => item.remainingTokens >= 0));
  assert(contextStop.contextAdmissions.every((item) => item.messageCountAfterPrune === 2),
    'Repair每一步必须保留一条固定任务消息和一条唯一最新ResumeView');
  assert.deepEqual(
    [...new Set(contextStop.contextAdmissions.map((item) => item.latestCandidateOccurrences))],
    [1],
    'each WorkerResumeView must carry exactly one latest candidate copy'
  );
  assert(contextStop.contextAdmissions.some((item) => item.prunedInputTokens > 0),
    'old reasoning/tool history must be pruned after at least one Tool step');
  assert(contextStop.contextAdmissions.some((item) => item.messageCountAfterSdkPrune < item.messageCountBeforePrune),
    'AI SDK pruneMessages must remove old tool-only history before the bounded snapshot replaces it');
  assert(contextStop.contextAdmissions.every((item) => item.estimatedInputTokens <= 16_000 - 2_000),
    'each bounded WorkerResumeView must stay below the context window with output reserve');
  const contextResumeText = collectStrings(contextStopModel.doGenerateCalls).join('\n');
  const visibleReserveTokens = [...contextResumeText.matchAll(
    /"requiredVisibleOutputReserveTokens":(\d+)/gu
  )].map((match) => Number(match[1]));
  assert(visibleReserveTokens.length >= 2,
    'each Repair WorkerResumeView must include a visible-result reserve advisory');
  assert(new Set(visibleReserveTokens).size >= 2,
    'visible-result reserve must change with the latest Candidate size');
  assert(contextResumeText.includes('"advisoryOnly":true')
    && contextResumeText.includes('submit_candidate_for_validation'),
  'result-priority guidance must be explicit while remaining advisory rather than a Provider guarantee');
  assert(!/(?:特斯拉|汽车|热管理)/u.test(contextResumeText),
    'dynamic result-priority guidance must not hardcode a product or engineering domain');
  assert.equal(
    countOccurrences(collectStrings(contextStopModel.doGenerateCalls.slice(2)).join('\n'), original),
    0,
    'the initial candidate must disappear after the latest failed candidate becomes the resume source'
  );
  assert.equal(contextStop.convergenceTrace.rounds.length, 2);
  assert.equal(contextStop.convergenceTrace.rounds.at(-1).candidateHash, hash(passedCandidate));

  const oversizedOriginal = 'x'.repeat(50_000);
  const notAdmittedModel = new MockLanguageModelV4({ doGenerate: [] });
  const notAdmitted = await runValidatorRepairWorker({
    model: notAdmittedModel,
    instructions: 'Repair.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 16_000,
    maxCandidateAttempts: 6,
    maxValidatorCalls: 8,
    initialValidatorCalls: 1,
    initialCandidateContent: oversizedOriginal,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(oversizedOriginal) },
    knowledgeSearchEnabled: false,
    searchReviewedKnowledge: async () => ({}),
    validateCandidate: async () => { throw new Error('Validator must not run'); },
    validationPassed: () => false,
    validationRetryable: () => true
  });
  assert.equal(notAdmitted.terminalStopReason, 'repair_context_not_admitted');
  assert.equal(notAdmittedModel.doGenerateCalls.length, 0, 'oversized input must fail before an LLM call, without truncation');
  assert.deepEqual(notAdmitted.contextAdmissions, []);

  const sharedQuestion = '修复当前模型。';
  const sharedRequest = runtime.agentRunRequestSchema.parse({
    runId: 'run_slice_c_repair_context',
    question: sharedQuestion,
    currentStudentQuestion: sharedQuestion,
    operation: 'repair',
    capabilityGrant: ['search_reviewed_knowledge', 'validate_candidate_workspace'],
    context: {
      tenantId: 'tenant-slice-c-repair',
      userId: 'user-slice-c-repair',
      threadId: 'thread-slice-c-repair',
      lesson: {
        courseId: 'course-slice-c-repair', lessonId: 'lesson-slice-c-repair', title: 'Slice C Repair',
        objectives: [], taskHints: []
      },
      model: {
        files: [{
          fileId: 'file_main', displayName: 'model.sysml', content: original,
          contentHash: hash(original), editable: true
        }],
        entryFileId: 'file_main', activeFileId: 'file_main', diagnostics: []
      }
    }
  });
  const sharedResources = runtime.createRunResources({
    request: sharedRequest,
    policy: runtime.DEFAULT_AGENT_POLICY,
    deadlineAtMs: Date.now() + 60_000
  });
  sharedResources.knowledge.observeToolResult('search_reviewed_knowledge', { query: 'part definition' }, {
    coverage: 'COMPLETE', claims: [{ claimId: 'shared-claim' }],
    evidenceBlocks: [{ evidenceId: 'shared-evidence' }]
  });
  for (let index = 0; index < 4; index += 1) {
    sharedResources.assertNewReviewedKnowledgeQueryAllowed({ query: `prior shared query ${index + 1}`, limit: 5 });
  }
  const sharedDelegated = sharedResources.tasks.materialize({
    questionHash: sharedResources.input.questionHash,
    outcome: { type: 'delegate_repair', scope: 'active_file', acceptedToolCallId: 'delegate-shared-repair' },
    context: sharedRequest.context
  });
  const sharedRunning = sharedResources.tasks.transition(
    sharedDelegated.taskId,
    sharedDelegated.revision,
    { type: 'worker_started' }
  );
  const sharedView = runtime.projectWorkerTaskView(sharedResources, sharedRunning);
  const sharedPassedCandidate = 'package Demo { part def Vehicle; }';
  const sharedModel = new MockLanguageModelV4({
    doGenerate: [toolStep('shared-candidate', 'submit_candidate_for_validation', { content: sharedPassedCandidate })]
  });
  const sharedResult = await runtime.runRepairWorker({
    resources: sharedResources,
    task: sharedView,
    model: sharedModel,
    instructions: 'Repair with the provided tools.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 3,
    maxValidatorCalls: 4,
    initialValidatorCalls: 1,
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: true,
    searchReviewedKnowledge: async () => { throw new Error('existing evidence is sufficient'); },
    validateCandidate: async (input) => {
      const validationResult = validation('passed', input.contentHash);
      validationResult.candidateWorkspaceHash = hash(`model.sysml\n${hash(input.content)}`);
      return {
        candidate: {
          mode: 'replace_entry',
          fileId: 'file_main',
          baseHash: hash(original),
          content: input.content
        },
        validation: validationResult
      };
    },
    validationPassed: (output) => output.official.syntax === 'passed' && output.official.semantic === 'passed',
    validationRetryable: () => true
  });
  assert.equal(sharedResult.status, 'validated_passed');
  assert.equal(sharedResult.candidate.content, sharedPassedCandidate);
  assert.equal(sharedResult.validation.validator.authority, 'official-sysml-v2-validator');
  assert.deepEqual(sharedModel.doGenerateCalls[0].tools.map((item) => item.name),
    ['submit_candidate_for_validation'],
    'Repair必须复用同一Run已耗尽的知识额度，并在模型请求中撤下Search Schema');
  assert(!Object.hasOwn(sharedResult, 'terminalCandidateRef'));
  assert(!Object.hasOwn(sharedResult, 'validatorResultRef'));
  assert.equal(sharedResources.budget.view().modelTotalTokens, 30);
  assert.deepEqual(
    sharedResources.toolLifecycleSnapshot().map((event) => `${event.participant}:${event.status}`),
    ['repair:started', 'repair:succeeded']
  );
  assert(!JSON.stringify(sharedModel.doGenerateCalls).includes(sharedResources.scopeKey));

  const compoundQuestion = '修复同一份模型中的A、B、C、D四处独立错误。';
  const compoundRequest = runtime.agentRunRequestSchema.parse({
    ...sharedRequest,
    runId: 'run_compound_four_independent_errors',
    question: compoundQuestion,
    currentStudentQuestion: compoundQuestion,
    context: {
      ...sharedRequest.context,
      threadId: 'thread-compound-four-errors'
    }
  });
  const compoundResources = runtime.createRunResources({
    request: compoundRequest,
    policy: { ...runtime.DEFAULT_AGENT_POLICY, repairMaxRounds: 4 },
    deadlineAtMs: Date.now() + 60_000
  });
  const compoundDelegated = compoundResources.tasks.materialize({
    questionHash: compoundResources.input.questionHash,
    outcome: { type: 'delegate_repair', scope: 'active_file', acceptedToolCallId: 'delegate-compound-repair' },
    context: compoundRequest.context
  });
  const compoundRunning = compoundResources.tasks.transition(
    compoundDelegated.taskId,
    compoundDelegated.revision,
    { type: 'worker_started' }
  );
  const compoundView = runtime.projectWorkerTaskView(compoundResources, compoundRunning);
  const compoundInitialValidation = validation('failed', 'errors:A,B,C,D');
  const initialValidatorPermit = compoundResources.budget.reserve('validator');
  await compoundResources.ledger.execute({
    toolCallId: 'compound-validator-initial',
    toolName: 'validate_candidate_workspace',
    input: { content: original },
    operation: async () => compoundInitialValidation
  });
  compoundResources.budget.settle(initialValidatorPermit, 'succeeded');

  const compoundCandidates = [
    'package Demo { part def FixedA; part def BrokenB; part def BrokenC; part def BrokenD; }',
    'package Demo { part def FixedA; part def FixedB; part def BrokenC; part def BrokenD; }',
    'package Demo { part def FixedA; part def FixedB; part def FixedC; part def BrokenD; }',
    'package Demo { part def FixedA; part def FixedB; part def FixedC; part def FixedD; }'
  ];
  const compoundModel = new MockLanguageModelV4({
    doGenerate: compoundCandidates.map((content, index) => toolStep(
      `compound-candidate-${index + 1}`,
      'submit_candidate_for_validation',
      { content }
    ))
  });
  let compoundValidationIndex = 0;
  const compoundResult = await runtime.runRepairWorker({
    resources: compoundResources,
    task: compoundView,
    model: compoundModel,
    instructions: 'Fix A, B, C and D sequentially while submitting one complete model each round.',
    taskMessages: repairTaskMessages('修复A、B、C、D四处独立错误。'),
    abortSignal: new AbortController().signal,
    timeoutMs: compoundResources.budget.view().workRemainingMs,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: compoundResources.resourcePolicy.maxUniqueCandidateValidationsPerWorker - 1,
    maxValidatorCalls: compoundResources.resourcePolicy.maxUniqueCandidateValidationsPerWorker,
    initialValidatorCalls: 1,
    initialValidation: compoundInitialValidation,
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: false,
    searchReviewedKnowledge: async () => { throw new Error('compound fixture does not need retrieval'); },
    validateCandidate: async (input) => {
      compoundValidationIndex += 1;
      const permit = compoundResources.budget.reserve('validator');
      try {
        return await compoundResources.ledger.execute({
          toolCallId: input.toolCallId,
          toolName: 'validate_candidate_workspace',
          input: { content: input.content, contentHash: input.contentHash },
          operation: async () => {
            const passed = compoundValidationIndex === compoundCandidates.length;
            const validationResult = validation(
              passed ? 'passed' : 'failed',
              passed ? 'all-fixed' : `remaining-errors:${compoundCandidates.length - compoundValidationIndex}`
            );
            validationResult.candidateWorkspaceHash = hash(`model.sysml\n${hash(input.content)}`);
            return {
              candidate: {
                mode: 'replace_entry',
                fileId: 'file_main',
                baseHash: hash(original),
                content: input.content
              },
              validation: validationResult
            };
          }
        });
      } finally {
        compoundResources.budget.settle(permit, 'succeeded');
      }
    },
    validationPassed: (output) => output.official.syntax === 'passed' && output.official.semantic === 'passed',
    validationRetryable: () => true
  });
  assert.equal(compoundResult.status, 'validated_passed');
  assert.equal(compoundResult.candidate.content, compoundCandidates.at(-1));
  assert.equal(compoundValidationIndex, 4, '四处独立错误应在同一串行Repair中逐轮修复');
  assert.equal(
    compoundResources.ledger.snapshot().filter((entry) => entry.toolName === 'validate_candidate_workspace').length,
    5,
    '初始验证加四轮修复必须允许执行到第5次Validator'
  );
  assert.equal(compoundResources.budget.view().remainingOperations.validator, 0);
  assert.equal(compoundResources.tasks.snapshot().length, 1, '复合错误仍然只创建一个Task');

  const noProgressValidation = validation('failed', 'same-errors:A,B,C,D');
  const noProgressModel = new MockLanguageModelV4({
    doGenerate: [
      toolStep('no-progress-1', 'submit_candidate_for_validation', { content: `${compoundCandidates[0]} // round 1` }),
      toolStep('no-progress-2', 'submit_candidate_for_validation', { content: `${compoundCandidates[0]} // round 2` }),
      toolStep('no-progress-must-not-run', 'submit_candidate_for_validation', { content: `${compoundCandidates[0]} // round 3` })
    ]
  });
  let noProgressValidatorCalls = 0;
  const noProgressResult = await runValidatorRepairWorker({
    model: noProgressModel,
    instructions: 'Stop when trusted diagnostics do not change.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 11,
    maxValidatorCalls: 12,
    initialValidatorCalls: 1,
    initialValidation: noProgressValidation,
    initialCandidateContent: original,
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash(original) },
    knowledgeSearchEnabled: false,
    searchReviewedKnowledge: async () => ({}),
    validateCandidate: async (input) => {
      noProgressValidatorCalls += 1;
      return { candidate: { content: input.content }, validation: noProgressValidation };
    },
    validationPassed: () => false,
    validationRetryable: () => true
  });
  assert.equal(noProgressResult.terminalStopReason, 'repair_no_progress');
  assert.equal(noProgressResult.consecutiveNoProgress, 2);
  assert.equal(noProgressValidatorCalls, 2, '连续两轮无进展后不得继续调用Validator');

  let zeroRoundValidatorCalls = 0;
  const zeroRoundResult = await runValidatorRepairWorker({
    model,
    instructions: 'No repair round is available.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 0,
    maxRepairRounds: 0,
    maxValidatorCalls: 1,
    initialValidatorCalls: 1,
    initialCandidateContent: 'a',
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash('a') },
    knowledgeSearchEnabled: false,
    searchReviewedKnowledge: async () => ({}),
    validateCandidate: async () => {
      zeroRoundValidatorCalls += 1;
      return { candidate: { content: 'unreachable' }, validation: validation('passed') };
    },
    validationPassed: () => true,
    validationRetryable: () => true
  });
  assert.equal(zeroRoundResult.terminalStopReason, 'candidate_budget_exhausted');
  assert.equal(zeroRoundValidatorCalls, 0, '零轮预算不得调用模型或Validator');

  const utf8ByteLimitModel = new MockLanguageModelV4({
    doGenerate: [
      toolStep('utf8-too-large', 'submit_candidate_for_validation', { content: '中' }),
      toolStep('utf8-valid', 'submit_candidate_for_validation', { content: 'b' })
    ]
  });
  let utf8ByteLimitValidatorCalls = 0;
  const utf8ByteLimitResult = await runValidatorRepairWorker({
    model: utf8ByteLimitModel,
    instructions: 'Respect the UTF-8 byte limit.',
    taskMessages: repairTaskMessages(),
    abortSignal: new AbortController().signal,
    timeoutMs: 30_000,
    toolTimeoutMs: 5_000,
    contextWindowTokens: 64_000,
    maxCandidateAttempts: 1,
    maxRepairRounds: 1,
    maxValidatorCalls: 2,
    maxCandidateArtifactBytes: 2,
    initialValidatorCalls: 1,
    initialCandidateContent: 'a',
    targetBinding: { mode: 'replace_entry', fileId: 'file_main', baseHash: hash('a') },
    knowledgeSearchEnabled: false,
    searchReviewedKnowledge: async () => ({}),
    validateCandidate: async (input) => {
      utf8ByteLimitValidatorCalls += 1;
      return { candidate: { content: input.content }, validation: validation('passed', 'utf8-byte-limit') };
    },
    validationPassed: (output) => output.official.syntax === 'passed' && output.official.semantic === 'passed',
    validationRetryable: () => true
  });
  assert.equal(utf8ByteLimitResult.terminalStopReason, 'validator_passed');
  assert.equal(utf8ByteLimitResult.accepted.content, 'b');
  assert.equal(utf8ByteLimitValidatorCalls, 1);
  assert(utf8ByteLimitResult.attempts.some((attempt) => attempt.rejectionReason === 'candidate_artifact_too_large'),
    '多字节候选必须按UTF-8字节数拒绝，并且不得调用Validator');

  function textStep(text) {
    return {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: usage(),
      warnings: []
    };
  }

  console.log('Teacher Validator Repair Worker tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
