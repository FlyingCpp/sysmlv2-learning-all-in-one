'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildKnowledgeQueryPlan,
  createAgentContext,
  runAgentCapability
} = require('../../apps/teacher/agent-adapter');
const { createTeacherRetriever } = require('../../apps/teacher/retriever');
const { createSkillSourceAdapter } = require('../../apps/teacher/skill-source');
const { createMemoryConversationStore } = require('../../apps/teacher/conversation-store');
const baseFixture = require('../../packages/teacher-contract/fixtures/host-context-basic.json');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE_MANIFEST_PATH = path.join(
  PROJECT_ROOT,
  'resources',
  'sysml-knowledge',
  'bundles',
  'sysml20-model-user-v003',
  'manifest.json'
);
const F01_MODEL_PATH = path.join(
  PROJECT_ROOT,
  'apps',
  'teacher',
  'eval',
  'engineering-cases',
  'models',
  'F01-source.sysml'
);

const CASES = Object.freeze([
  {
    id: 'domain-1-foundations',
    phase: 1,
    question: '解释 Namespace、Import、Definition、Usage、Typing、Specialization、Subsetting、Redefinition 和 FeatureValue 的职责边界。'
  },
  {
    id: 'domain-2-structure',
    phase: 2,
    question: '比较 Part、Item、Port、Connection、Interface、Flow 和 Allocation 的职责边界。'
  },
  {
    id: 'domain-3-behavior',
    phase: 3,
    question: '解释 Action、Succession、Control Node、Assign、State 和 Transition 的关系。'
  },
  {
    id: 'domain-4-analysis-verification',
    phase: 4,
    question: '比较 Calculation、Constraint、Requirement、Satisfy、Verification、Use Case 和 View。'
  },
  {
    id: 'domain-5-advanced-semantics',
    phase: 5,
    question: '解释 Metadata、Variation、Individual、Snapshot、TimeSlice 和 occurrence lifetime。'
  },
  {
    id: 'domain-6-standard-libraries',
    phase: 6,
    question: '解释 Quantities、ISQ、Unit、QuantityKind 与 ScalarValues 的关系及 2026-04 版本边界。'
  },
  {
    id: 'f01-operator-context',
    phase: 1,
    question: '这些 :、:>、:>>、::> 都是继承吗？请结合选中代码解释。',
    requestedLimit: 5,
    f01: true
  }
]);

async function main() {
  const manifest = JSON.parse(fs.readFileSync(BUNDLE_MANIFEST_PATH, 'utf8'));
  const expectedBundleId = process.env.AI_TEACHER_EXPECTED_BUNDLE_ID || manifest.bundleId;
  const expectedContentHash = process.env.AI_TEACHER_EXPECTED_BUNDLE_CONTENT_HASH || manifest.contentHash;
  const outputPath = path.resolve(
    process.env.AI_TEACHER_RUNTIME_RETRIEVAL_REPORT
      || path.join(PROJECT_ROOT, 'artifacts', 'ai-teacher-runtime-retrieval.json')
  );
  const knowledge = createTeacherRetriever({
    backend: 'postgres',
    connectionString: process.env.AI_TEACHER_DB_URL,
    tenantId: process.env.AI_TEACHER_RAG_TENANT_ID || 'local-dev',
    allowLegacyFallback: false
  });
  const skillSource = createSkillSourceAdapter();
  const status = await knowledge.status();
  assert.equal(status.mode, 'postgres_pgvector');
  assert.equal(status.ready, true, JSON.stringify(status));
  assert.equal(status.activeBundle?.bundleId, expectedBundleId);
  assert.equal(status.activeBundle?.contentHash, expectedContentHash);

  const { MockLanguageModelV4 } = await import('ai/test');
  const { buildFinalAnswerFeedback } = await import('../../apps/teacher/dist/agent/index.mjs');
  const results = [];
  for (const definition of CASES) {
    const hostContext = contextForCase(definition);
    const { context: agentContext } = createAgentContext(hostContext);
    const requestedLimit = definition.requestedLimit || 25;
    const queryPlan = buildKnowledgeQueryPlan({
      requestedQuery: definition.question,
      hostContext,
      agentContext,
      requestedLimit
    });
    const directHits = await knowledge.search(queryPlan.effectiveQuery, hostContext, {
      limit: requestedLimit,
      queryPlan
    });
    let graph = directHits.find((hit) => hit?.graph)?.graph;
    assert(graph, `${definition.id}: PostgreSQL retrieval did not return graph data`);
    assert.equal(graph.bundleId, expectedBundleId, `${definition.id}: bundle mismatch`);
    assert.equal(graph.bundleContentHash, expectedContentHash, `${definition.id}: content hash mismatch`);
    assert.equal(graph.coverage, 'COMPLETE', `${definition.id}: incomplete graph coverage`);
    assert.equal(graph.resourceLimit, 25, `${definition.id}: resource limit must be 25`);
    assert(graph.claims.length > 0, `${definition.id}: no Claims returned`);
    assert(graph.claims.length <= 25, `${definition.id}: Claim resource limit exceeded`);
    assert.deepEqual(graph.missingClosureClaimIds, [], `${definition.id}: Claim closure incomplete`);
    assert.equal(graph.conflicts.length, 0, `${definition.id}: unresolved conflicts returned`);
    const evidenceIds = new Set(graph.evidenceBlocks.map((item) => item.evidenceId));
    for (const claim of graph.claims) {
      assert(
        claim.evidenceIds.every((evidenceId) => evidenceIds.has(evidenceId)),
        `${definition.id}: Claim ${claim.claimId} has an unreturned Evidence reference`
      );
    }
    if (definition.f01) {
      const claimIds = new Set(graph.claims.map((claim) => claim.claimId));
      assert(graph.closureClaimIds.length > requestedLimit, 'F01 closure must exceed the model limit=5');
      assert(graph.closureClaimIds.every((claimId) => claimIds.has(claimId)), 'F01 closure was truncated');
      assert(graph.knowledgeAnswerRequiredClaimIds.length > 0, 'F01 answer-required closure missing');
      assert(graph.knowledgeSupportingClaimIds.length > 0, 'F01 supporting closure missing');
    }

    let agentGraph;
    const instrumentedKnowledge = {
      ...knowledge,
      async search(...args) {
        const hits = await knowledge.search(...args);
        agentGraph = hits.find((hit) => hit?.graph)?.graph;
        return hits;
      }
    };
    const model = new MockLanguageModelV4({
      doGenerate: agentWorkflow(definition.question, requestedLimit)
    });
    const conversation = createMemoryConversationStore();
    const runId = `run_runtime_retrieval_${definition.id}`;
    const response = await runAgentCapability(hostContext, {
      llm: { providerMode: 'mock', model: 'runtime-retrieval-verifier' },
      agentModel: model,
      conversation,
      runId,
      knowledge: instrumentedKnowledge,
      skillSource,
      agentAnswerMode: 'result_bound_v2',
      feedbackFinalAnswer: async (request) => buildFinalAnswerFeedback({
        output: { issues: [] },
        request,
        modelId: 'runtime-retrieval-feedback-verifier'
      })
    });
    const toolCalls = response.__internal?.agent?.toolTrace || [];
    const auditEntries = await conversation.listToolLedgerEntries(runId, { toolName: 'search_reviewed_knowledge' });
    assert(agentGraph, `${definition.id}: Agent knowledge tool did not return graph data`);
    graph = agentGraph;
    assert.deepEqual(
      toolCalls.map((entry) => entry.toolName),
      ['inspect_current_model', 'search_reviewed_knowledge', 'search_skill_guidance'],
      `${definition.id}: unexpected Tool Ledger order`
    );
    assert(toolCalls.every((entry) => entry.status === 'succeeded'), `${definition.id}: Tool Ledger failure`);
    assert.equal(response.knowledgeAttestations, undefined);
    assert.equal(response.agentTrace?.toolCalls, undefined);
    assert.equal(auditEntries.length, 1, `${definition.id}: internal knowledge audit missing`);
    const audited = auditEntries[0].resultPayload;
    assert.equal(audited.bundleContentHash, expectedContentHash);
    assert.equal(audited.requestedQueryHash, graph.requestedQueryHash, `${definition.id}: requested query hash mismatch`);
    assert.equal(audited.effectiveQueryHash, graph.effectiveQueryHash, `${definition.id}: effective query hash mismatch`);
    assert.match(audited.resultHash, /^sha256:[a-f0-9]{64}$/u, `${definition.id}: adapted Tool result hash missing`);
    assert.deepEqual(new Set(audited.claims.map((claim) => claim.claimId)), new Set(graph.claims.map((claim) => claim.claimId)));
    assert.deepEqual(new Set(audited.evidenceBlocks.map((item) => item.evidenceId)), evidenceIds);
    assert.equal(response.feedbackEvaluation?.version, 'teacher-answer-feedback-v1');
    assert.equal(response.feedbackEvaluation?.revisionApplied, false);
    assert.equal(response.judgeEvaluation, undefined);

    results.push({
      id: definition.id,
      phase: definition.phase,
      requestedLimit,
      requestedQueryHash: graph.requestedQueryHash,
      effectiveQueryHash: graph.effectiveQueryHash,
      graphResultHash: graph.resultHash,
      toolResultHash: audited.resultHash,
      ledgerResultHash: auditEntries[0].resultHash,
      coverage: graph.coverage,
      resourceLimit: graph.resourceLimit,
      selectionLimit: graph.selectionLimit,
      closureClaimIds: graph.closureClaimIds,
      missingClosureClaimIds: graph.missingClosureClaimIds,
      claimCount: graph.claims.length,
      evidenceCount: graph.evidenceBlocks.length,
      claims: graph.claims.map((claim) => ({
        claimId: claim.claimId,
        selectionRole: claim.selectionRole,
        authorityLevel: claim.authorityLevel,
        claimText: claim.claimText,
        evidenceIds: claim.evidenceIds
      })),
      evidence: graph.evidenceBlocks.map((item) => ({
        evidenceId: item.evidenceId,
        sourceId: item.sourceId,
        sectionPath: item.sectionPath,
        authorityLevel: item.authorityLevel,
        textHash: item.textHash
      })),
      toolLedger: toolCalls,
      publicToolTrace: publicToolCalls,
      feedback: response.feedbackEvaluation
    });
  }

  const report = {
    schemaVersion: '1.0.0',
    verifiedAt: new Date().toISOString(),
    retrievalMode: status.mode,
    bundleId: expectedBundleId,
    bundleContentHash: expectedContentHash,
    resourceLimit: 25,
    cases: results
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    outputPath,
    retrievalMode: report.retrievalMode,
    bundleId: report.bundleId,
    bundleContentHash: report.bundleContentHash,
    cases: results.map((item) => ({
      id: item.id,
      claimCount: item.claimCount,
      evidenceCount: item.evidenceCount,
      coverage: item.coverage,
      toolCalls: item.toolLedger.length
    }))
  }, null, 2));
}

function contextForCase(definition) {
  const context = structuredClone(baseFixture);
  context.requestId = `req_runtime_retrieval_${definition.id}`;
  context.threadId = `thread_runtime_retrieval_${definition.id}`;
  context.tenant.tenantId = process.env.AI_TEACHER_RAG_TENANT_ID || 'local-dev';
  context.tenant.dataPolicy.allowLLM = true;
  context.question.text = definition.question;
  context.question.intent = 'free_answer';
  context.question.hintLevel = 'explain';
  if (definition.f01) {
    const content = fs.readFileSync(F01_MODEL_PATH, 'utf8');
    context.editor.files = [{
      path: 'main.sysml',
      content,
      editable: true,
      source: 'evaluation-fixture'
    }];
    context.editor.activeFilePath = 'main.sysml';
    context.editor.selection = {
      empty: false,
      startOffset: 0,
      endOffset: content.length,
      text: content
    };
    context.editor.cursor = { offset: 0 };
    context.editor.contextState = {
      focus: 'focused',
      interactionTarget: 'code',
      cursorOrigin: 'current',
      selectionOrigin: 'current',
      degradedReason: ''
    };
  }
  return context;
}

function agentWorkflow(query, knowledgeLimit) {
  return [
    generated([toolCall('context', 'inspect_current_model', { detail: 'full' })], 'tool-calls'),
    generated([toolCall('knowledge', 'search_reviewed_knowledge', { query, limit: knowledgeLimit })], 'tool-calls'),
    generated([toolCall('skill', 'search_skill_guidance', { query, limit: 5 })], 'tool-calls'),
    generated([{ type: 'text', text: '检索接线验证完成。本回答仅用于验证 Tool Ledger，不参与语义质量评分。' }])
  ];
}

function toolCall(toolCallId, toolName, input) {
  return { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) };
}

function generated(content, finishReason = 'stop') {
  return {
    content,
    finishReason: { unified: finishReason, raw: finishReason },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 }
    },
    warnings: []
  };
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
