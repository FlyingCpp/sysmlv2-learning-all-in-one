const assert = require("node:assert/strict");
const crypto = require("node:crypto");

function hash(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}

function createContext(overrides = {}) {
  const content = "package P {\n  part def A;\n  part a : A;\n}\n";
  const file = {
    fileId: "entry",
    displayName: "P.sysml",
    content,
    contentHash: hash(content),
    editable: true,
  };
  return {
    tenantId: "tenant-test",
    userId: "student-test",
    threadId: "thread-tools",
    lesson: {
      courseId: "course-test",
      lessonId: "lesson-test",
      title: "Test lesson",
      objectives: ["Read definitions and usages"],
      taskHints: [],
      courseRules: [{
        id: "required-car",
        type: "elementExists",
        severity: "error",
        message: "课程要求保留Car。",
        selector: { kind: "partDef", name: "Car" },
      }],
      referenceModel: {
        entryFile: "main.sysml",
        files: [{
          displayName: "main.sysml",
          content: file.content,
          contentHash: file.contentHash,
          editable: true,
        }],
      },
    },
    model: {
      files: [file],
      activeFileId: file.fileId,
      diagnostics: [],
      ...overrides,
    },
  };
}

function emptyDependencies() {
  return {
    async inspectLessonContext({ context, input }) {
      return {
        courseId: context.lesson.courseId,
        lessonId: context.lesson.lessonId,
        title: context.lesson.title,
        objectives: context.lesson.objectives,
        taskHints: context.lesson.taskHints,
        ...(input.detail === "rules" || input.detail === "full"
          ? { courseRules: context.lesson.courseRules }
          : {}),
        ...(input.detail === "reference_model" || input.detail === "full"
          ? { referenceModel: context.lesson.referenceModel }
          : {}),
      };
    },
    async inspectCurrentModel({ context, grounding }) {
      return {
        files: context.model.files.map((file) => ({
          fileId: file.fileId,
          displayName: file.displayName,
          contentHash: file.contentHash,
          editable: file.editable,
          characterCount: file.content.length,
        })),
        activeFileId: context.model.activeFileId,
        focus: grounding,
        diagnostics: context.model.diagnostics,
      };
    },
    async searchSkillGuidance({ input }) {
      return { query: input.query, items: [] };
    },
    async searchReviewedKnowledge({ input }) {
      return {
        requestedQuery: input.query,
        effectiveQuery: input.query,
        requestedQueryHash: hash(input.query),
        effectiveQueryHash: hash(input.query),
        closureProfileId: "sysml-general-search-v1",
        closureProfileHash: hash("sysml-general-search-v1"),
        intentMode: "general_semantic_search",
        operatorOccurrences: [],
        queryExpansion: { addedOperators: [], sources: [] },
        coverage: "NONE",
        resultHash: hash("empty-reviewed-knowledge"),
        closureClaimIds: [],
        knowledgeAnswerRequiredClaimIds: [],
        knowledgeSupportingClaimIds: [],
        mandatorySupportingCount: 0,
        additionalSupportingClaimIds: [],
        missingClosureClaimIds: [],
        requestedLimit: input.limit,
        additionalSupportingBudget: input.limit,
        selectionLimit: input.limit,
        returnedClaimCount: 0,
        resourceLimit: 25,
        claims: [],
        evidenceBlocks: [],
        guardrails: [],
        conflicts: [],
        excludedCandidates: { count: 0, claimIds: [] },
        items: [],
      };
    },
    async searchDomainEvidence({ input }) {
      return {
        version: "domain-search-result-v3",
        status: "unavailable",
        provider: "deepseek-native-web-search",
        questions: input.questions,
        summary: "",
        sources: [],
        searchRequestCount: 0,
        warnings: ["domain_web_search_disabled"],
      };
    },
    async validateCandidateWorkspace() {
      throw new Error("not configured");
    },
  };
}

async function main() {
  const { callValidatorToolForTests, ledgerProjectionForTests } = require('../apps/teacher/agent-adapter');
  const { latestValidatedCandidateSubject } = require('../apps/teacher/server')
    .engineeringImprovementServerForTests;
  const { z } = await import("zod");
  const {
    ToolCallConflictError,
    ToolBudgetExceededError,
    ToolExecutionLedger,
    RunBudgetAccount,
    ReviewedKnowledgeQueryRejectedError,
    assembleTrustedResponse,
    agentRunRequestSchema,
    createRunResources,
    createReadOnlyTools,
    deriveEditorGrounding,
    hashCanonicalValue,
    domainEvidenceOutputSchema,
    reviewedKnowledgeOutputSchema,
    searchDomainEvidenceInputSchema,
    searchReviewedKnowledgeInputSchema,
    validateCandidateInputSchema,
    validateCandidateToolInputSchema,
    validationOutputSchema,
    DEFAULT_AGENT_POLICY,
  } = await import("../apps/teacher/dist/agent/index.mjs");

  assert.equal(searchReviewedKnowledgeInputSchema.safeParse({ query: "definition usage", limit: 25 }).success, true);
  assert.equal(searchReviewedKnowledgeInputSchema.safeParse({ query: "definition usage", limit: 26 }).success, false);
  assert.equal(searchDomainEvidenceInputSchema.safeParse({ questions: ["咖啡机的典型水路是什么？"] }).success, true);
  assert.equal(searchDomainEvidenceInputSchema.safeParse({ questions: [] }).success, false);
  assert.equal(searchDomainEvidenceInputSchema.safeParse({ questions: ["a", "b", "c", "d"] }).success, false);
  assert.equal(domainEvidenceOutputSchema.safeParse({
    version: "domain-search-result-v3",
    status: "complete",
    provider: "deepseek-native-web-search",
    questions: ["咖啡机的典型水路是什么？"],
    summary: "水箱、水泵、加热器和冲煮单元形成典型水路。",
    sources: [{
      sourceId: "domain_0123456789abcdef0123",
      title: "Coffee machine engineering reference",
      url: "https://example.edu/coffee-machine",
      pageAge: "2026-07-28",
    }],
    searchRequestCount: 1,
    warnings: [],
  }).success, true);
  assert(ReviewedKnowledgeQueryRejectedError.prototype instanceof Error);

  {
    const candidateContent = "package PreviousCandidate {\n  part def Vehicle;\n}";
    const contentHash = hash(candidateContent);
    const workspaceHash = hash("previous-candidate-workspace");
    const response = {
      validatorStatus: "validated_passed",
      candidateDeliveryStatus: "changed_delivered",
      candidateWorkspaceHash: workspaceHash,
      directAnswer: `已完成。\n\n文件：previous.sysml\n\n\`\`\`sysml\n${candidateContent}\n\`\`\``,
      candidateAttestation: {
        validatorStatus: "validated_passed",
        validatorSource: "official-sysml-v2-pilot-2026-04",
        validatorVersion: "pinned-test",
        validationCompleteness: "official",
        fallbackActive: false,
        candidateWorkspaceHash: workspaceHash,
        codeBlockContentHashes: [contentHash],
      },
      codeBlockValidations: [{
        index: 0,
        status: "validated_passed",
        source: "official-sysml-v2-pilot-2026-04",
        validationCompleteness: "official",
        fallbackActive: false,
        syntaxValid: true,
        semanticValid: true,
        candidateWorkspaceHash: workspaceHash,
        boundFileId: "previous-candidate-file",
        contentHash,
      }],
    };
    const subject = latestValidatedCandidateSubject([{
      role: "assistant",
      runId: "run-validated-previous",
      content: response.directAnswer,
      response,
    }]);
    assert.equal(subject.content, candidateContent);
    assert.equal(subject.contentHash, contentHash);
    assert.equal(subject.displayName, "previous.sysml");
    assert.equal(subject.fileId, "previous-candidate-file");
    assert.equal(latestValidatedCandidateSubject([{
      role: "assistant",
      runId: "run-tampered-previous",
      content: response.directAnswer,
      response: { ...response, directAnswer: response.directAnswer.replace("Vehicle", "Changed") },
    }]), undefined, "正文Hash不匹配的历史回答不得恢复为可信工作对象");
  }

  {
    const context = createContext();
    const boundedRequest = agentRunRequestSchema.parse({
      runId: "run-reviewed-knowledge-query-boundary",
      question: "生成一个受审核证据支持的示例。",
      currentStudentQuestion: "生成一个受审核证据支持的示例。",
      capabilityGrant: ["search_reviewed_knowledge"],
      context,
    });
    const resources = createRunResources({
      request: boundedRequest,
      policy: DEFAULT_AGENT_POLICY,
      deadlineAtMs: Date.now() + DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000,
    });
    let backendCalls = 0;
    const dependencies = emptyDependencies();
    const emptySearch = dependencies.searchReviewedKnowledge;
    dependencies.searchReviewedKnowledge = async (input) => {
      backendCalls += 1;
      return {
        ...(await emptySearch(input)),
        coverage: "PARTIAL",
        no_new_evidence: false,
        closureGaps: ["missing_dimension:complementary_semantics"],
      };
    };
    const tools = createReadOnlyTools({
      context,
      dependencies,
      capabilityGrant: new Set(["search_reviewed_knowledge"]),
      ledger: resources.ledger,
      runResources: resources,
    });
    const execute = async (toolCallId, input) => await tools.search_reviewed_knowledge.execute(input, {
      toolCallId,
      messages: [],
      context: undefined,
      abortSignal: new AbortController().signal,
    });
    const firstInput = { query: "part usage typing", limit: 5, selectedPatternIds: [] };
    await execute("bounded-first", firstInput);
    await execute("bounded-first-replay", firstInput);
    assert.equal(backendCalls, 1, "完全相同的本地知识查询必须从Run Ledger回放");
    await assert.rejects(
      execute("bounded-format-duplicate", {
        query: "  PART   usage typing!!!  ", limit: 8, selectedPatternIds: [],
      }),
      (error) => error?.code === "reviewed_knowledge_duplicate_normalized_query",
      "只改变格式或limit的重复查询必须在访问后端前拒绝",
    );
    assert.equal(backendCalls, 1);
    await execute("bounded-complement", {
      query: "part definition ownership and nested feature boundary",
      limit: 5,
      selectedPatternIds: [],
    });
    assert.equal(backendCalls, 2);
    assert.deepEqual(resources.knowledge.reviewedKnowledgeQueryBudget(), {
      maxNewQueries: resources.resourcePolicy.operationLimits.knowledge_backend,
      admittedNewQueries: 2,
      remainingNewQueries: resources.resourcePolicy.operationLimits.knowledge_backend - 2,
      noNewEvidenceObserved: false,
    });
    await execute("bounded-third-new", {
      query: "third independent knowledge gap", limit: 5, selectedPatternIds: [],
    });
    await execute("bounded-fourth-new", {
      query: "fourth independent knowledge gap", limit: 5, selectedPatternIds: [],
    });
    await execute("bounded-fifth-new", { query: "fifth unrelated knowledge query", limit: 5, selectedPatternIds: [] });
    await execute("bounded-replay-after-limit", firstInput);
    assert.equal(backendCalls, 5, "互补查询继续执行，精确回放不重复调用后端");
    const boundedLedger = resources.ledger.snapshot();
    assert.equal(boundedLedger.find((entry) => entry.toolCallId === "bounded-first")?.backendExecuted, true,
      "只有实际越过Guard的首次查询才能记录backendExecuted=true");
    assert.equal(boundedLedger.find((entry) => entry.toolCallId === "bounded-first-replay")?.backendExecuted, false,
      "相同Query/Hash的Ledger回放不得计为后端执行");
    assert.equal(boundedLedger.find((entry) => entry.toolCallId === "bounded-fifth-new")?.backendExecuted, true,
      "第五次新查询不再被历史知识专属门禁阻断");

    const noNewRequest = agentRunRequestSchema.parse({
      ...boundedRequest,
      runId: "run-reviewed-knowledge-no-new-evidence",
    });
    const noNewResources = createRunResources({
      request: noNewRequest,
      policy: DEFAULT_AGENT_POLICY,
      deadlineAtMs: Date.now() + DEFAULT_AGENT_POLICY.terminalReserveMs + 60_000,
    });
    let noNewBackendCalls = 0;
    const noNewDependencies = emptyDependencies();
    const noNewEmptySearch = noNewDependencies.searchReviewedKnowledge;
    noNewDependencies.searchReviewedKnowledge = async (input) => {
      noNewBackendCalls += 1;
      return {
        ...(await noNewEmptySearch(input)),
        no_new_evidence: true,
      };
    };
    const noNewTools = createReadOnlyTools({
      context,
      dependencies: noNewDependencies,
      capabilityGrant: new Set(["search_reviewed_knowledge"]),
      ledger: noNewResources.ledger,
      runResources: noNewResources,
    });
    const noNewInput = { query: "unknown semantic edge", limit: 5, selectedPatternIds: [] };
    const noNewExecution = (toolCallId, input) => noNewTools.search_reviewed_knowledge.execute(input, {
      toolCallId,
      messages: [],
      context: undefined,
      abortSignal: new AbortController().signal,
    });
    await noNewExecution("no-new-first", noNewInput);
    assert.equal(noNewResources.knowledge.reviewedKnowledgeQueryBudget().noNewEvidenceObserved, true);
    await noNewExecution("no-new-second", { query: "different query after no evidence", limit: 5, selectedPatternIds: [] });
    await noNewExecution("no-new-replay", noNewInput);
    assert.equal(noNewBackendCalls, 2, "空查询后仍可互补查询，精确回放不重复调用");
    assert.equal(noNewResources.isNewReviewedKnowledgeQueryAllowed(), true,
      "单次空结果不能关闭整个Run的Search");
  }

  {
    const originalFetch = global.fetch;
    let attempts = 0;
    global.fetch = async () => {
      attempts += 1;
      return new Response(JSON.stringify({
        code: 'VALIDATOR_QUEUE_TIMEOUT',
        retryableBeforeStart: true,
      }), { status: 503, headers: { 'content-type': 'application/json' } });
    };
    try {
      const validatorObservations = [];
      const result = await callValidatorToolForTests({
        input: { mode: 'standalone_model', fileName: 'P.sysml', content: 'package P;' },
        hostContext: { course: { coursePackId: 'course-test' } },
        fileMap: new Map(),
        config: {
          platformApiUrl: 'http://platform.test',
          toolToken: 'test-tool-token',
          agentToolTimeoutMs: 5_000,
        },
        validatorObservations,
      });
      assert.strictEqual(attempts, 1, 'Validator Tool每次业务调用只执行一次，不在Teacher侧重复排队重试');
      assert.deepStrictEqual(validatorObservations.map((item) => ({
        attempt: item.attempt,
        admissionOutcome: item.admissionOutcome,
        executionMs: item.executionMs,
        retryableBeforeStart: item.retryableBeforeStart
      })), [
        { attempt: 1, admissionOutcome: 'queue_timeout', executionMs: 0, retryableBeforeStart: true }
      ]);
      assert.strictEqual(result.official.syntax, 'unavailable');
      assert.strictEqual(result.official.diagnostics[0].code, 'VALIDATOR_QUEUE_TIMEOUT');
    } finally {
      global.fetch = originalFetch;
    }
  }

  {
    const originalFetch = global.fetch;
    let attempts = 0;
    global.fetch = async () => {
      attempts += 1;
      return new Response(JSON.stringify({ code: 'VALIDATOR_TOOL_HTTP_503' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    };
    try {
      await callValidatorToolForTests({
        input: { mode: 'standalone_model', fileName: 'P.sysml', content: 'package P;' },
        hostContext: { course: { coursePackId: 'course-test' } },
        fileMap: new Map(),
        config: {
          platformApiUrl: 'http://platform.test',
          toolToken: 'test-tool-token',
          agentToolTimeoutMs: 5_000,
        },
      });
      assert.strictEqual(attempts, 1, 'unknown or post-start failures must not retry');
    } finally {
      global.fetch = originalFetch;
    }
  }

  {
    const ledger = new ToolExecutionLedger();
    let executions = 0;
    const operation = async () => {
      executions += 1;
      return { value: 42 };
    };
    const first = await ledger.execute({
      toolCallId: "same-call",
      toolName: "inspect_lesson_context",
      input: { includeObjectives: true },
      operation,
    });
    const replay = await ledger.execute({
      toolCallId: "same-call",
      toolName: "inspect_lesson_context",
      input: { includeObjectives: true },
      operation,
    });
    assert.deepEqual(first, replay);
    assert.equal(executions, 1);
    assert.equal(ledger.snapshot()[0].replayCount, 1);
    assert.equal(
      ledger.snapshot()[0].argsHash,
      await hashCanonicalValue({ includeObjectives: true }),
    );
  }

  {
    const ledger = new ToolExecutionLedger({ maxExecutions: 2 });
    let executions = 0;
    const operation = async () => {
      executions += 1;
      return { value: 7 };
    };
    await ledger.execute({
      toolCallId: "semantic-original",
      toolName: "inspect_lesson_context",
      input: { includeObjectives: true },
      operation,
    });
    await ledger.execute({
      toolCallId: "semantic-retry-with-new-id",
      toolName: "inspect_lesson_context",
      input: { includeObjectives: true },
      operation,
    });
    assert.equal(executions, 1, "same tool and canonical arguments must execute at most once");
    assert.equal(ledger.snapshot().length, 2, "each accepted Tool Call must have its own audit record");
    assert.equal(ledger.snapshot()[0].replayCount, 1);
    assert.equal(ledger.snapshot()[1].replayCount, 1);
    assert.deepEqual(ledger.snapshot()[1].output, { value: 7 });
  }

  {
    const ledger = new ToolExecutionLedger({ maxExecutions: 2 });
    let executions = 0;
    const operation = async () => {
      executions += 1;
      throw new Error("transient validation setup failure");
    };
    const input = {
      mode: "standalone_model",
      fileName: "汽车热管理架构.sysml",
      content: "package P;",
    };
    await assert.rejects(ledger.execute({
      toolCallId: "failed-semantic-original",
      toolName: "validate_candidate_workspace",
      input,
      operation,
    }), /transient validation setup failure/u);
    await assert.rejects(ledger.execute({
      toolCallId: "failed-semantic-retry",
      toolName: "validate_candidate_workspace",
      input,
      operation,
    }), /transient validation setup failure/u);
    assert.equal(executions, 2, "failed read-only calls must be retryable under a new toolCallId");
    assert.equal(ledger.snapshot().length, 2);
  }

  {
    const ledger = new ToolExecutionLedger({
      maxExecutions: 1,
      maxExecutionsPerTool: { inspect_lesson_context: 1 },
    });
    await ledger.execute({
      toolCallId: "budget-first",
      toolName: "inspect_lesson_context",
      input: { includeObjectives: true },
      operation: async () => ({ ok: true }),
    });
    await assert.rejects(
      ledger.execute({
        toolCallId: "budget-second",
        toolName: "inspect_lesson_context",
        input: { includeObjectives: false },
        operation: async () => ({ ok: true }),
      }),
      ToolBudgetExceededError,
    );
    assert.equal(ledger.snapshot().length, 1);
  }

  {
    const ledger = new ToolExecutionLedger();
    await ledger.execute({
      toolCallId: "conflict-call",
      toolName: "inspect_lesson_context",
      input: { includeObjectives: true },
      operation: async () => ({ ok: true }),
    });
    await assert.rejects(
      ledger.execute({
        toolCallId: "conflict-call",
        toolName: "inspect_lesson_context",
        input: { includeObjectives: false },
        operation: async () => ({ ok: false }),
      }),
      ToolCallConflictError,
    );
  }

  {
    const ledger = new ToolExecutionLedger();
    const signal = AbortSignal.timeout(10);
    await assert.rejects(
      ledger.execute({
        toolCallId: "timeout-call",
        toolName: "inspect_lesson_context",
        input: { includeObjectives: true },
        abortSignal: signal,
        operation: async () =>
          await new Promise((resolve) => setTimeout(() => resolve({ late: true }), 50)),
      }),
      /timeout|aborted/i,
    );
    assert.equal(ledger.snapshot()[0].status, "timed_out");
  }

  {
    const content = createContext().model.files[0].content;
    const selected = "part def A;";
    const from = content.indexOf(selected);
    const context = createContext({
      selection: { fileId: "entry", from, to: from + selected.length },
      cursor: { zone: "code", fileId: "entry", offset: content.indexOf("part a") },
    });
    const grounding = deriveEditorGrounding(context);
    assert.equal(grounding.kind, "selection");
    assert.equal(grounding.text, selected);
  }

  {
    const content = createContext().model.files[0].content;
    const context = createContext({
      cursor: { zone: "code", fileId: "entry", offset: content.indexOf("part a") },
    });
    const grounding = deriveEditorGrounding(context);
    assert.equal(grounding.kind, "code_cursor");
    assert.match(grounding.lineText, /part a : A/);
  }

  {
    const context = createContext({ cursor: { zone: "non_code", surface: "lesson" } });
    const grounding = deriveEditorGrounding(context);
    assert.deepEqual(grounding, { kind: "non_code_cursor", surface: "lesson" });
  }

  {
    const context = createContext();
    const previousContent = "package PreviousCandidate {\n  part def Vehicle;\n}\n";
    context.conversationSubjects = {
      lastValidatedCandidate: {
        sourceRunId: "run-previous-candidate",
        candidateWorkspaceHash: hash("previous-workspace"),
        fileId: "previous-candidate",
        displayName: "generated_architecture.sysml",
        content: previousContent,
        contentHash: hash(previousContent),
        currentWorkspaceMatches: false,
      },
    };
    const dependencies = emptyDependencies();
    dependencies.inspectCurrentModel = async ({ context: boundContext, input }) => {
      assert.equal(input.source, "last_validated_candidate");
      const candidate = boundContext.conversationSubjects.lastValidatedCandidate;
      return {
        source: input.source,
        files: [{
          fileId: candidate.fileId,
          displayName: candidate.displayName,
          contentHash: candidate.contentHash,
          editable: true,
          characterCount: candidate.content.length,
          content: candidate.content,
        }],
        activeFileId: candidate.fileId,
        focus: { kind: "none", reason: "active_file_only", fileId: candidate.fileId },
        diagnostics: [],
      };
    };
    const ledger = new ToolExecutionLedger();
    const tools = createReadOnlyTools({
      context,
      dependencies,
      capabilityGrant: new Set(["inspect_current_model"]),
      ledger,
    });
    const output = await tools.inspect_current_model.execute({
      source: "last_validated_candidate",
      detail: "full",
    }, {
      toolCallId: "inspect-previous-candidate",
      messages: [],
      context: undefined,
      abortSignal: new AbortController().signal,
    });
    assert.equal(output.source, "last_validated_candidate");
    assert.equal(output.files[0].content, previousContent);
    assert(!JSON.stringify(output).includes(context.model.files[0].content),
      "读取上一轮Candidate时不得混入当前编辑器正文");
    assert.equal(ledger.snapshot()[0].status, "succeeded");
  }

  {
    const providerSchema = z.toJSONSchema(validateCandidateToolInputSchema);
    assert.equal(providerSchema.type, "object");
    assert.equal(providerSchema.anyOf, undefined);
    assert.ok(providerSchema.properties.mode);
  }

  {
    const invalid = validateCandidateInputSchema.safeParse({
      mode: "replace_entry",
      fileId: "entry",
      baseHash: createContext().model.files[0].contentHash,
      content: "package P {}",
      url: "https://example.com/model.sysml",
    });
    assert.equal(invalid.success, false);
  }

  {
    const invalidOfficialFirstResult = validationOutputSchema.safeParse({
      validator: {
        authority: "official-sysml-v2-validator",
        version: `2026-04/0.59.0/${hash("validator-artifact")}`,
        evidenceHash: hash("validator"),
      },
      official: {
        syntax: "failed",
        semantic: "not_run",
        diagnostics: [{ severity: "error", message: "syntax error" }],
      },
      courseRuleApplicability: "applicable",
      courseRules: { status: "passed", diagnostics: [] },
      completeness: "complete",
      patches: [],
    });
    assert.equal(invalidOfficialFirstResult.success, false);
  }

  {
    const context = createContext();
    const ledger = new ToolExecutionLedger();
    let dependencyCalls = 0;
    const dependencies = emptyDependencies();
    dependencies.searchSkillGuidance = async ({ input }) => {
      dependencyCalls += 1;
      return { query: input.query, items: [] };
    };
    const tools = createReadOnlyTools({
      context,
      dependencies,
      capabilityGrant: new Set(["inspect_lesson_context"]),
      ledger,
    });
    await assert.rejects(
      tools.search_skill_guidance.execute(
        { query: "definition usage", limit: 2 },
        {
          toolCallId: "denied-call",
          messages: [],
          context: undefined,
        },
      ),
      /capability denied/i,
    );
    assert.equal(dependencyCalls, 0);
    assert.equal(ledger.snapshot()[0].status, "failed");
  }

  {
    const context = createContext();
    const ledger = new ToolExecutionLedger();
    const budget = new RunBudgetAccount({
      convergeAtMs: 1,
      workDeadlineAtMs: 2,
      hardDeadlineAtMs: 3
    });
    const runResources = {
      budget,
      assertAdmitted: (action) => budget.assertAdmitted(action),
      isAllowed: (action) => budget.isAllowed(action),
      findPriorKnowledgeResult: () => undefined
    };
    let knowledgeBackendCalls = 0;
    let validatorBackendCalls = 0;
    const dependencies = emptyDependencies();
    dependencies.inspectLessonContext = async () => {
      knowledgeBackendCalls += 1;
      return {};
    };
    dependencies.validateCandidateWorkspace = async () => {
      validatorBackendCalls += 1;
      return {};
    };
    const tools = createReadOnlyTools({
      context,
      dependencies,
      capabilityGrant: new Set(["inspect_lesson_context", "validate_candidate_workspace"]),
      ledger,
      runResources
    });
    await assert.rejects(
      tools.inspect_lesson_context.execute({ includeObjectives: true }, {
        toolCallId: 'expired-knowledge-call', messages: [], context: undefined
      }),
      (error) => error?.code === 'RUN_PHASE_ACTION_NOT_ALLOWED'
    );
    await assert.rejects(
      tools.validate_candidate_workspace.execute({
        mode: 'standalone_model',
        fileName: 'Expired.sysml',
        content: 'package Expired;'
      }, {
        toolCallId: 'expired-validator-call', messages: [], context: undefined
      }),
      (error) => error?.code === 'RUN_PHASE_ACTION_NOT_ALLOWED'
    );
    assert.equal(knowledgeBackendCalls, 0, 'Finalize/Expired阶段不得调用知识后端');
    assert.equal(validatorBackendCalls, 0, 'Finalize/Expired阶段不得调用Validator后端');
  }

  {
    const context = createContext();
    const ledger = new ToolExecutionLedger();
    const dependencies = emptyDependencies();
    let lessonCalls = 0;
    const original = dependencies.inspectLessonContext;
    dependencies.inspectLessonContext = async (args) => {
      lessonCalls += 1;
      return await original(args);
    };
    const tools = createReadOnlyTools({
      context,
      dependencies,
      capabilityGrant: new Set(["inspect_lesson_context"]),
      ledger,
    });
    const execution = {
      toolCallId: "tool-replay",
      messages: [],
      context: undefined,
    };
    const full = await tools.inspect_lesson_context.execute({ includeObjectives: true, detail: "full" }, execution);
    await tools.inspect_lesson_context.execute({ includeObjectives: true, detail: "full" }, execution);
    assert.equal(full.courseRules[0].id, "required-car");
    assert.equal(full.referenceModel.files[0].content, context.model.files[0].content);
    assert.equal(lessonCalls, 1);
    assert.equal(ledger.snapshot()[0].replayCount, 1);
  }

  {
    const context = createContext();
    context.model.entryFileId = context.model.files[0].fileId;
    context.model.files[0].editable = false;
    const ledger = new ToolExecutionLedger();
    const dependencies = emptyDependencies();
    let validationCalls = 0;
    dependencies.validateCandidateWorkspace = async () => {
      validationCalls += 1;
      const validation = {
        validator: {
          authority: "official-sysml-v2-validator",
          version: `2026-04/0.59.0/${hash("read-only-validator-artifact")}`,
          evidenceHash: hash("read-only-validator"),
        },
        official: { syntax: "passed", semantic: "passed", diagnostics: [] },
        courseRuleApplicability: "applicable",
        courseRules: { status: "passed", diagnostics: [] },
        completeness: "complete",
        candidateWorkspaceHash: hash(context.model.files[0].content),
        patches: [],
      };
      return {
        validation,
        validatorObservations: [{
          attempt: 1,
          admissionOutcome: 'admitted',
          queueWaitMs: 2,
          executionMs: 9,
          retryableBeforeStart: false,
          abortedAfterStart: false
        }]
      };
    };
    const tools = createReadOnlyTools({
      context,
      dependencies,
      capabilityGrant: new Set(["validate_candidate_workspace"]),
      ledger,
    });
    const exact = {
      mode: "workspace_files",
      files: [{
        fileId: context.model.files[0].fileId,
        baseHash: context.model.files[0].contentHash,
        content: context.model.files[0].content,
      }],
    };
    await tools.validate_candidate_workspace.execute(exact, {
      toolCallId: "readonly-exact",
      messages: [],
      context: undefined,
    });
    assert.equal(validationCalls, 1);
    assert.deepStrictEqual(ledger.snapshot()[0].validatorObservations, [{
      attempt: 1,
      admissionOutcome: 'admitted',
      queueWaitMs: 2,
      executionMs: 9,
      retryableBeforeStart: false,
      abortedAfterStart: false
    }]);
    assert.deepStrictEqual(ledgerProjectionForTests(ledger.snapshot()[0]).validatorObservations, [{
      attempt: 1,
      admissionOutcome: 'admitted',
      queueWaitMs: 2,
      executionMs: 9,
      retryableBeforeStart: false,
      abortedAfterStart: false
    }]);
    await assert.rejects(
      tools.validate_candidate_workspace.execute({
        ...exact,
        files: [{ ...exact.files[0], content: `${exact.files[0].content}\n// changed` }],
      }, {
        toolCallId: "readonly-mutated",
        messages: [],
        context: undefined,
      }),
      (error) => {
        assert.match(error.message, /read-only candidate/i);
        assert.equal(error.code, "CANDIDATE_TARGET_READ_ONLY");
        return true;
      },
    );
    assert.equal(validationCalls, 1);
  }

  {
    const graphQuery = "解释 part a : A";
    const graphResult = {
      requestedQuery: graphQuery,
      effectiveQuery: graphQuery,
      requestedQueryHash: hash(graphQuery),
      effectiveQueryHash: hash(graphQuery),
      closureProfileId: "sysml-answer-closure-v3",
      closureProfileHash: hash("sysml-answer-closure-v3"),
      intentMode: "explain_occurrence",
      operatorOccurrences: [{
        sourceType: "model_request",
        contentHash: hash(graphQuery),
        start: graphQuery.indexOf(":"),
        end: graphQuery.indexOf(":") + 1,
        token: ":",
        expandedAstContextIds: ["sysml20:Usage"],
      }],
      queryExpansion: { addedOperators: [], sources: [] },
      coverage: "COMPLETE",
      bundleId: "sysml20-f0-v001",
      baselineId: "sysml-2.0-formal",
      bundleVersion: "2026.07.17-f0.1",
      sourceRegistryHash: hash("source-registry"),
      bundleContentHash: hash("bundle"),
      resultHash: hash("result"),
      candidateKnowledgePatterns: [{
        patternId: "pattern-mu-example",
        title: "Example Pattern",
        description: "A reviewed optional Pattern candidate.",
        matchedAnchorNodeIds: ["sysml20:Usage"],
        matchedClaimIds: ["claim-colon-feature-typing"],
        closureDimensions: ["definition", "relation"],
      }],
      selectedKnowledgePatternIds: [],
      selectedPatternClosureClaimIds: [],
      patternSelectionWarnings: [],
      closureGaps: [],
      closureClaimIds: ["claim-colon-feature-typing"],
      knowledgeAnswerRequiredClaimIds: ["claim-colon-feature-typing"],
      knowledgeSupportingClaimIds: [],
      mandatorySupportingCount: 0,
      additionalSupportingClaimIds: [],
      missingClosureClaimIds: [],
      requestedLimit: 8,
      additionalSupportingBudget: 8,
      selectionLimit: 9,
      returnedClaimCount: 1,
      resourceLimit: 25,
      claims: [{
        claimId: "claim-colon-feature-typing",
        claimText: "冒号建立 FeatureTyping。",
        authorityLevel: "A1",
        operators: [":"],
        astContextIds: ["sysml20:Usage"],
        evidenceIds: ["ev-usage-declaration"],
        selectionRole: "required",
      }],
      evidenceBlocks: [{
        evidenceId: "ev-usage-declaration",
        sourceId: "sysml20-part1-formal-text",
        sectionPath: "7.6.3 Usage declaration",
        excerpt: "A usage declaration may identify a definition using defined by (:).",
        textHash: hash("formal-evidence"),
        authorityLevel: "A1",
      }],
      guardrails: [],
      conflicts: [],
      excludedCandidates: { count: 0, claimIds: [] },
      items: [{
        cardId: "knowledge_colon_claim",
        title: "Usage typing",
        excerpt: "冒号建立 FeatureTyping。",
        reviewed: true,
        evidenceLevel: "official",
        version: "2026.07.17-f0.1",
        contentHash: hash("bundle"),
      }],
    };
    assert.equal(reviewedKnowledgeOutputSchema.safeParse(graphResult).success, true);
    const unofferedSelection = structuredClone(graphResult);
    unofferedSelection.selectedKnowledgePatternIds = ["pattern-mu-not-offered"];
    assert.equal(reviewedKnowledgeOutputSchema.safeParse(unofferedSelection).success, false);
    const leakedInternalRankingAudit = structuredClone(graphResult);
    leakedInternalRankingAudit.rankingAudit = {
      profileId: "code-evidence-v1",
      queryHash: hash(graphQuery),
      candidates: [{ claimId: "claim-colon-feature-typing", bm25Score: 12.5 }],
    };
    assert.equal(
      reviewedKnowledgeOutputSchema.safeParse(leakedInternalRankingAudit).success,
      false,
      "internal ranking audit must be rejected by the strict public Tool output contract",
    );
    const missingEvidence = structuredClone(graphResult);
    missingEvidence.evidenceBlocks = [];
    assert.equal(reviewedKnowledgeOutputSchema.safeParse(missingEvidence).success, false);
    const missingRequiredClaim = structuredClone(graphResult);
    missingRequiredClaim.missingClosureClaimIds = ["claim-typed-usage-inherits-features"];
    assert.equal(reviewedKnowledgeOutputSchema.safeParse(missingRequiredClaim).success, false);
    const partialPatternGap = structuredClone(graphResult);
    partialPatternGap.coverage = "PARTIAL";
    partialPatternGap.closureStatus = "incomplete";
    partialPatternGap.closureGaps = ["missing_edge:edge-mu-example"];
    assert.equal(reviewedKnowledgeOutputSchema.safeParse(partialPatternGap).success, true);
    const completePatternGap = structuredClone(partialPatternGap);
    completePatternGap.coverage = "COMPLETE";
    assert.equal(reviewedKnowledgeOutputSchema.safeParse(completePatternGap).success, false);

    const activatedPatternResult = structuredClone(graphResult);
    activatedPatternResult.selectedKnowledgePatternIds = ["pattern-mu-example"];
    activatedPatternResult.selectedPatternClosureClaimIds = ["claim-pattern-boundary"];
    activatedPatternResult.closureClaimIds.push("claim-pattern-boundary");
    activatedPatternResult.knowledgeSupportingClaimIds = ["claim-pattern-boundary"];
    activatedPatternResult.mandatorySupportingCount = 1;
    activatedPatternResult.selectionLimit = 10;
    activatedPatternResult.returnedClaimCount = 2;
    activatedPatternResult.claims.push({
      claimId: "claim-pattern-boundary",
      claimText: "所选Pattern的边界Claim必须作为supporting closure整体考虑。",
      authorityLevel: "A1",
      operators: [],
      astContextIds: ["sysml20:Usage"],
      evidenceIds: ["ev-pattern-boundary"],
      selectionRole: "supporting",
    });
    activatedPatternResult.evidenceBlocks.push({
      evidenceId: "ev-pattern-boundary",
      sourceId: "sysml20-part1-formal-text",
      sectionPath: "Pattern boundary",
      excerpt: "A selected Pattern carries a complete supporting closure.",
      textHash: hash("pattern-boundary-evidence"),
      authorityLevel: "A1",
    });
    assert.equal(reviewedKnowledgeOutputSchema.safeParse(activatedPatternResult).success, true);

    const unrequestedDependencies = emptyDependencies();
    unrequestedDependencies.searchReviewedKnowledge = async () => activatedPatternResult;
    const unrequestedTools = createReadOnlyTools({
      context: createContext(),
      dependencies: unrequestedDependencies,
      capabilityGrant: new Set(["search_reviewed_knowledge"]),
      ledger: new ToolExecutionLedger(),
    });
    await assert.rejects(
      unrequestedTools.search_reviewed_knowledge.execute({
        query: graphResult.requestedQuery,
        limit: 8,
        selectedPatternIds: [],
      }, {
        toolCallId: "unrequested-pattern",
        messages: [],
        context: undefined,
      }),
      /unrequested Pattern/u,
    );

    const context = createContext();
    const ledger = new ToolExecutionLedger();
    const dependencies = emptyDependencies();
    dependencies.searchReviewedKnowledge = async () => graphResult;
    const tools = createReadOnlyTools({
      context,
      dependencies,
      capabilityGrant: new Set(["search_reviewed_knowledge"]),
      ledger,
    });
    const output = await tools.search_reviewed_knowledge.execute({
      query: graphResult.requestedQuery,
      limit: 8,
      selectedPatternIds: [],
    }, {
      toolCallId: "graph-knowledge",
      messages: [],
      context: undefined,
    });
    assert.equal(output.bundleId, graphResult.bundleId);
    assert.deepEqual(output.claims[0].evidenceIds, ["ev-usage-declaration"]);
    assert.equal(ledger.snapshot()[0].status, "succeeded");
  }

  {
    const response = assembleTrustedResponse(
      {
        modelText: "结论：The validator passed；验证器已通过，validatorStatus=validated_passed。",
        finishReason: "stop",
        stepCount: 1,
        invalidToolCallCount: 0,
        stopReason: "completed",
        usage: {},
      },
      [],
    );
    assert.equal(response.validatorStatus, "not_validated");
    assert.equal(response.patches.length, 0);
    assert.match(response.answer, /validatorStatus=validated_passed/);
    assert.match(response.answer, /validator passed/i);
    assert.match(response.answer, /验证器已通过/);
    assert.ok(!response.warnings.includes("unverified_validation_claim_removed"));
  }

  {
    const skillEntry = {
      sequence: 0,
      toolCallId: "skill-citation",
      toolName: "search_skill_guidance",
      canonicalArgs: JSON.stringify({ query: "definition usage", limit: 1 }),
      argsHash: hash("skill-citation-args"),
      status: "succeeded",
      output: {
        query: "definition usage",
        items: [{
          sourceId: "skill-cited-source",
          title: "Definition and usage",
          excerpt: "A usage is typed by a definition.",
          authority: "project_skill",
          version: "v1",
          contentHash: hash("skill-cited-excerpt"),
        }],
      },
      replayCount: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    const uncited = assembleTrustedResponse({
      modelText: "definition 与 usage 不同。",
      finishReason: "stop",
      stepCount: 2,
      invalidToolCallCount: 0,
      stopReason: "completed",
      usage: {},
    }, [skillEntry]);
    assert.equal(
      uncited.evidence.length,
      1,
      "one unique schema-valid trusted retrieval may be recovered deterministically",
    );
    assert.ok(uncited.warnings.includes("source_marker_recovered_from_single_trusted_tool"));
    const cited = assembleTrustedResponse({
      modelText: "definition 与 usage 不同。[source:skill-cited-source]",
      finishReason: "stop",
      stepCount: 2,
      invalidToolCallCount: 0,
      stopReason: "completed",
      usage: {},
    }, [skillEntry]);
    assert.equal(cited.evidence.length, 1);
    assert.doesNotMatch(cited.answer, /\[source:/);
  }

  {
    const passedValidation = {
      validator: {
        authority: "official-sysml-v2-validator",
        version: `2026-04/0.59.0/${hash("terminal-validator-artifact")}`,
        evidenceHash: hash("terminal-validator"),
      },
      official: { syntax: "passed", semantic: "passed", diagnostics: [] },
      courseRuleApplicability: "applicable",
      courseRules: { status: "passed", diagnostics: [] },
      completeness: "complete",
      candidateWorkspaceHash: hash("candidate-a"),
      patches: [],
    };
    const baseEntry = {
      canonicalArgs: "{}",
      argsHash: hash("args"),
      replayCount: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    const forgedScope = assembleTrustedResponse(
      {
        modelText: "你当前原模型已通过官方 Validator。上述修复已由校验器确认无误。校验结果是成功的。The current model is valid according to the validator. Validator 也证明上述概念结论。",
        finishReason: "stop",
        stepCount: 2,
        invalidToolCallCount: 0,
        stopReason: "completed",
        usage: {},
      },
      [{
        ...baseEntry,
        sequence: 0,
        toolCallId: "validator-forged-scope",
        toolName: "validate_candidate_workspace",
        status: "succeeded",
        output: passedValidation,
      }],
    );
    assert.equal(forgedScope.validatorStatus, "validated_passed");
    assert.match(forgedScope.answer, /原模型已通过官方 Validator/);
    assert.match(forgedScope.answer, /Validator 也证明/);
    assert.match(forgedScope.answer, /确认无误|校验结果是成功|model is valid/iu);
    assert.match(forgedScope.answer, /不证明原始草稿、自然语言概念结论/u);
    assert.ok(!forgedScope.warnings.includes("unverified_validation_claim_removed"));

    const response = assembleTrustedResponse(
      {
        modelText: "候选 B 已完成。",
        finishReason: "stop",
        stepCount: 3,
        invalidToolCallCount: 0,
        stopReason: "completed",
        usage: {},
      },
      [
        {
          ...baseEntry,
          sequence: 0,
          toolCallId: "validator-a",
          toolName: "validate_candidate_workspace",
          status: "succeeded",
          output: passedValidation,
        },
        {
          ...baseEntry,
          sequence: 1,
          toolCallId: "validator-b",
          toolName: "validate_candidate_workspace",
          status: "timed_out",
          error: { name: "TimeoutError", message: "timeout" },
        },
      ],
    );
    assert.equal(response.validatorStatus, "not_validated");
    assert.equal(response.patches.length, 0);
    assert.ok(response.warnings.includes("terminal_validation_attempt_unusable"));
  }

  {
    const adapter = require("../apps/teacher/agent-adapter.js");
    const queryPlan = {
      requestedQuery: "ports connect",
      effectiveQuery: "ports connect",
      requestedQueryHash: hash("ports connect"),
      effectiveQueryHash: hash("ports connect"),
      intentMode: "general_semantic_search",
      operatorOccurrences: [],
      queryExpansion: { addedOperators: [], sources: [] },
    };
    const baseGraph = {
      coverage: "PARTIAL",
      no_new_evidence: false,
      bundleId: "bundle-example-governance",
      baselineId: "baseline-example-governance",
      bundleVersion: "v-test",
      closureProfileId: "sysml-general-search-v1",
      closureProfileHash: hash("sysml-general-search-v1"),
      closureRequirement: "not_applicable",
      closureStatus: "not_applicable",
      intentMode: "general_semantic_search",
      operatorOccurrences: [],
      queryExpansion: { addedOperators: [], sources: [] },
      claims: [{
        claimId: "claim-example-governance",
        claimText: "A port usage is typed by a port definition.",
        authorityLevel: "A1",
        operators: [],
        astContextIds: [],
        evidenceIds: ["evidence-example-governance"],
        selectionRole: "additional_supporting",
      }],
      evidenceBlocks: [{
        evidenceId: "evidence-example-governance",
        sourceId: "source-example-governance",
        sectionPath: "Ports",
        excerpt: "Ports may be connected through interfaces.",
        textHash: hash("ports-evidence"),
        authorityLevel: "A1",
      }],
      examples: [{
        exampleId: "ex-official-ports-01",
        title: "Ports Example",
        intentText: "Define directed ports and connect them.",
        modelText: "package PortsExample {\n  port def P;\n}",
        constructTags: ["port-def", "connect"],
        exampleAuthority: "community-example",
        languageVersionTrack: "community",
        reviewStatus: "machine_validated",
        validatorAttestation: { syntax: "passed", semantic: "passed" },
      }, {
        exampleId: "ex-official-ports-02",
        title: "Official Ports",
        intentText: "Official ports sample.",
        modelText: "package OfficialPorts {\n  port def Q;\n}",
        constructTags: ["port-def"],
        exampleAuthority: "official-example",
        languageVersionTrack: "2.1-beta-forward",
        reviewStatus: "machine_validated",
        validatorAttestation: { syntax: "passed", semantic: "passed" },
      }],
    };

    const adapted = adapter.adaptReviewedKnowledgeResultForTests({
      graph: baseGraph,
      items: [],
      input: { limit: 5, exampleLimit: 2 },
      queryPlan,
      exampleMaxPerQuery: 2,
    });
    assert.equal(adapted.claims.length, 1);
    assert.equal(adapted.evidenceBlocks.length, 1);
    assert.equal(adapted.examples?.length, 2);
    assert.equal(adapted.examples[0].exampleAuthority, "community-example");
    assert.equal(adapted.examples[0].validatorPassed, true);
    assert.equal(reviewedKnowledgeOutputSchema.safeParse(adapted).success, true);

    const disabled = adapter.adaptReviewedKnowledgeResultForTests({
      graph: baseGraph,
      items: [],
      input: { limit: 5, exampleLimit: 0 },
      queryPlan,
      exampleMaxPerQuery: 0,
    });
    assert.equal(disabled.claims.length, 1);
    assert.equal(disabled.evidenceBlocks.length, 1);
    assert.equal(disabled.examples.length, 2);

    const emptyExamples = adapter.adaptReviewedKnowledgeResultForTests({
      graph: { ...baseGraph, examples: [] },
      items: [],
      input: { limit: 5 },
      queryPlan,
      exampleMaxPerQuery: 2,
    });
    assert.equal(emptyExamples.claims.length, 1);
    assert.equal(emptyExamples.evidenceBlocks.length, 1);
    assert.equal(Object.hasOwn(emptyExamples, "examples"), false);

    const explodingExamples = [{
      exampleId: "ex-boom",
      title: "Boom",
      intentText: "Boom",
      get modelText() {
        throw new Error("examples assembly failure");
      },
      constructTags: ["port-def"],
      exampleAuthority: "official-example",
      languageVersionTrack: "2.0-formal",
      reviewStatus: "machine_validated",
    }];
    const failedOpen = adapter.adaptReviewedKnowledgeResultForTests({
      graph: { ...baseGraph, examples: explodingExamples },
      items: [],
      input: { limit: 5 },
      queryPlan,
      exampleMaxPerQuery: 2,
    });
    assert.equal(failedOpen.claims.length, 1);
    assert.equal(failedOpen.evidenceBlocks.length, 1);
    assert.equal(Object.hasOwn(failedOpen, "examples"), false);
  }

  console.log("teacher agent tool and trust tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
