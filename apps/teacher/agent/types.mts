import { bootstrapAgentPolicy } from "./policy-defaults.mjs";
import { MAX_CANDIDATE_ARTIFACT_BYTES } from "./candidate-content.mjs";
import type { LanguageModel } from "ai";
import { z } from "zod";

import type { RunResources } from "./run-resources.mjs";


export const TOOL_SCHEMA_VERSION = "single-entry-v3";

export const TOOL_NAMES = [
  "inspect_lesson_context",
  "inspect_current_model",
  "search_skill_guidance",
  "search_reviewed_knowledge",
  "search_engineering_domain_evidence",
  "validate_candidate_workspace",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const toolNameSchema = z.enum(TOOL_NAMES);

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const semanticIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const contentHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/);

const modelFileSchema = z
  .object({
    fileId: opaqueIdSchema,
    displayName: z.string().min(1).max(160),
    workspacePath: z.string().min(1).optional(),
    content: z.string().max(MAX_CANDIDATE_ARTIFACT_BYTES * 2),
    contentHash: contentHashSchema,
    editable: z.boolean(),
  })
  .strict();

const diagnosticSchema = z
  .object({
    diagnosticId: z.string().min(1).max(160).optional(),
    fileId: opaqueIdSchema.optional(),
    severity: z.enum(["error", "warning", "info"]),
    code: z.string().min(1).max(80).optional(),
    message: z.string().min(1).max(2_000),
    from: z.number().int().nonnegative().optional(),
    to: z.number().int().nonnegative().optional(),
  })
  .strict();

const courseRuleReferenceSchema = z
  .object({
    id: z.string().min(1).max(160),
    type: z.string().min(1).max(120),
    severity: z.enum(["error", "warning", "info"]),
    message: z.string().min(1).max(2_000),
    selector: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const courseReferenceFileSchema = z
  .object({
    displayName: z.string().min(1).max(240),
    content: z.string().max(MAX_CANDIDATE_ARTIFACT_BYTES * 2),
    contentHash: contentHashSchema,
    editable: z.boolean(),
  })
  .strict();

const courseReferenceModelSchema = z
  .object({
    entryFile: z.string().min(1).max(240),
    files: z.array(courseReferenceFileSchema).max(20),
  })
  .strict();

const selectionSchema = z
  .object({
    fileId: opaqueIdSchema,
    from: z.number().int().nonnegative(),
    to: z.number().int().positive(),
  })
  .strict()
  .refine((selection) => selection.to > selection.from, {
    message: "selection.to must be greater than selection.from",
  });

const cursorSchema = z.discriminatedUnion("zone", [
  z
    .object({
      zone: z.literal("code"),
      fileId: opaqueIdSchema,
      offset: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      zone: z.literal("non_code"),
      surface: z.enum(["lesson", "diagnostics", "navigation", "unknown"]),
    })
    .strict(),
]);

export const teacherAgentContextSchema = z
  .object({
    tenantId: opaqueIdSchema,
    userId: opaqueIdSchema,
    threadId: opaqueIdSchema,
    lesson: z
      .object({
        courseId: opaqueIdSchema,
        lessonId: opaqueIdSchema,
        title: z.string().min(1).max(240),
        objectives: z.array(z.string().min(1).max(1_000)).max(20),
        taskHints: z.array(z.string().min(1).max(1_000)).max(20),
        courseRules: z.array(courseRuleReferenceSchema).max(100).default([]),
        referenceModel: courseReferenceModelSchema.optional(),
      })
      .strict(),
    model: z
      .object({
        files: z.array(modelFileSchema).min(1).max(20),
        entryFileId: opaqueIdSchema.optional(),
        activeFileId: opaqueIdSchema.optional(),
        selection: selectionSchema.optional(),
        cursor: cursorSchema.optional(),
        diagnostics: z.array(diagnosticSchema).max(100).default([]),
        activeDiagnosticId: z.string().min(1).max(160).optional(),
      })
      .strict(),
    conversationSubjects: z
      .object({
        lastValidatedCandidate: z
          .object({
            sourceRunId: opaqueIdSchema,
            candidateWorkspaceHash: contentHashSchema,
            fileId: opaqueIdSchema,
            displayName: z.string().min(1).max(160),
            content: z.string().min(1).max(MAX_CANDIDATE_ARTIFACT_BYTES),
            contentHash: contentHashSchema,
            currentWorkspaceMatches: z.boolean(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((context, issueContext) => {
    const files = new Map(context.model.files.map((file) => [file.fileId, file]));
    if (files.size !== context.model.files.length) {
      issueContext.addIssue({
        code: "custom",
        path: ["model", "files"],
        message: "fileId values must be unique",
      });
    }
    if (context.model.activeFileId && !files.has(context.model.activeFileId)) {
      issueContext.addIssue({
        code: "custom",
        path: ["model", "activeFileId"],
        message: "activeFileId is not authorized",
      });
    }
    if (context.model.entryFileId && !files.has(context.model.entryFileId)) {
      issueContext.addIssue({
        code: "custom",
        path: ["model", "entryFileId"],
        message: "entryFileId is not authorized",
      });
    }
    if (context.model.selection) {
      const file = files.get(context.model.selection.fileId);
      if (!file || context.model.selection.to > file.content.length) {
        issueContext.addIssue({
          code: "custom",
          path: ["model", "selection"],
          message: "selection is outside the authorized file",
        });
      }
    }
    if (context.model.cursor?.zone === "code") {
      const file = files.get(context.model.cursor.fileId);
      if (!file || context.model.cursor.offset > file.content.length) {
        issueContext.addIssue({
          code: "custom",
          path: ["model", "cursor"],
          message: "cursor is outside the authorized file",
        });
      }
    }
  });

export type TeacherAgentContext = z.infer<typeof teacherAgentContextSchema>;

export const editorGroundingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("selection"),
      fileId: opaqueIdSchema,
      displayName: z.string().min(1).max(160),
      from: z.number().int().nonnegative(),
      to: z.number().int().positive(),
      startLine: z.number().int().positive(),
      startColumn: z.number().int().positive(),
      endLine: z.number().int().positive(),
      endColumn: z.number().int().positive(),
      text: z.string().max(MAX_CANDIDATE_ARTIFACT_BYTES * 2),
    })
    .strict(),
  z
    .object({
      kind: z.literal("code_cursor"),
      fileId: opaqueIdSchema,
      displayName: z.string().min(1).max(160),
      offset: z.number().int().nonnegative(),
      line: z.number().int().positive(),
      column: z.number().int().positive(),
      lineText: z.string().max(20_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("non_code_cursor"),
      surface: z.enum(["lesson", "diagnostics", "navigation", "unknown"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("none"),
      reason: z.enum(["no_focus", "active_file_only"]),
      fileId: opaqueIdSchema.optional(),
      displayName: z.string().min(1).max(160).optional(),
    })
    .strict(),
]);

export type EditorGrounding = z.infer<typeof editorGroundingSchema>;

export const scopeScreeningSuggestionSchema = z.object({
  signal: z.enum(["fully_out_of_scope", "mixed_scope_risk"]),
}).strict();

export type ScopeScreeningSuggestion = z.infer<typeof scopeScreeningSuggestionSchema>;

export const scopeRejectConfirmationSchema = z.object({
  confirmed: z.literal(true),
}).strict();

export type ScopeRejectConfirmation = z.infer<typeof scopeRejectConfirmationSchema>;

export const fastGateTextSignalSchema = z.enum([
  "PASS",
  "RISK_MIXED",
  "RISK_FULL",
  "UNKNOWN",
]);

export type FastGateTextSignal = z.infer<typeof fastGateTextSignalSchema>;

export const fastGatePassThroughV2Schema = z.object({
  version: z.literal("fast-gate-pass-through-v2-phase2"),
  outcome: z.enum(["pass", "mixed_scope_risk", "reject"]),
  decisionStatus: z.enum(["completed", "incomplete"]),
  originalQuestionHash: contentHashSchema,
  mixedScopeRisk: z.boolean(),
  firstSignal: fastGateTextSignalSchema,
  reviewSignal: fastGateTextSignalSchema.optional(),
  courseTaskIntentHint: z.enum(["course_task", "general_task", "unknown"]).default("unknown"),
}).strict().superRefine((gate, context) => {
  if ((gate.outcome === "mixed_scope_risk") !== gate.mixedScopeRisk) {
    context.addIssue({
      code: "custom",
      path: ["mixedScopeRisk"],
      message: "mixedScopeRisk must agree with the derived Gate outcome",
    });
  }
});

export type FastGatePassThroughV2 = z.infer<typeof fastGatePassThroughV2Schema>;

export const mainAgentDelegationSchema = z.discriminatedUnion("action", [
  z.object({
    version: z.literal("main-agent-delegation-v1"),
    action: z.literal("candidate"),
    mode: z.enum(["create", "complete", "refine", "milestone"]),
    subject: z.enum([
      "current_workspace",
      "previous_validated_candidate",
      "current_validated_candidate",
      "last_validated_candidate",
      "standalone_model",
    ]),
    questionHash: contentHashSchema,
    taskSummary: z.string().trim().min(1).max(4_000),
    instruction: z.string().trim().min(1).max(4_000),
    status: z.literal("accepted"),
  }).strict(),
  z.object({
    version: z.literal("main-agent-delegation-v1"),
    action: z.literal("repair"),
    scope: z.enum(["active_file", "standalone_model"]),
    questionHash: contentHashSchema,
    status: z.literal("accepted"),
  }).strict(),
]);

export type MainAgentDelegation = z.infer<typeof mainAgentDelegationSchema>;

/** Main Agent的业务终态；委派终态由SDK Tool Result中的已接受调用ID绑定。 */
export type MainAgentOutcome =
  | {
    type: "finalize_requested";
    finalizationRequestId: string;
    requestSource: "tool_call" | "visible_text";
    mainDraft: string;
    finalizerEvidence: Array<{
      toolName: string;
      input?: unknown;
      output: unknown;
    }>;
  }
  | { type: "scope_rejected"; text: string }
  | {
    type: "clarification_requested";
    question: string;
    options?: string[];
    acceptedToolCallId: string;
  }
  | {
    type: "delegate_candidate";
    mode: "create" | "complete" | "refine" | "milestone";
    subject:
      | "current_workspace"
      | "previous_validated_candidate"
      | "current_validated_candidate"
      | "last_validated_candidate"
      | "standalone_model";
    acceptedToolCallId: string;
    taskSummary: string;
    instruction: string;
  }
  | {
    type: "delegate_repair";
    scope: "active_file" | "standalone_model";
    acceptedToolCallId: string;
  }
  | {
    type: "resume_execution";
    action: "validator" | "resolve_validation" | "repair" | "finalizer" | "return_persisted" | "engineering_resume";
    acceptedToolCallId: string;
  };

export const executionCheckpointPhaseSchema = z.enum([
  "candidate_absent",
  "candidate_ready",
  "validation_pending",
  "validation_failed",
  "repair_in_progress",
  "validated_passed",
  "main_review_pending",
  "engineering_assessment_started",
  "engineering_assessment_completed",
  "engineering_improvement_pending",
  "engineering_improvement_admitted",
  "engineering_improvement_skipped",
  "engineering_revision_in_progress",
  "engineering_verification_started",
  "engineering_verification_completed",
  "finalization_pending",
  "completed",
]);

export const executionResumeActionSchema = z.enum([
  "candidate",
  "validator",
  "resolve_validation",
  "repair",
  "finalizer",
  "return_persisted",
  "engineering_resume",
  "replan_or_clarify",
]);

const taskSourceSchema = z.object({
  sourceId: opaqueIdSchema,
  relation: z.enum(["root_user_request", "clarification_user_answer", "engineering_feedback"]),
  text: z.string().trim().min(1).max(20_000),
  sourceHash: contentHashSchema,
  taskAuthorizationRevisionHash: contentHashSchema,
}).strict();

export const executionResumeSchema = z.object({
  version: z.literal("teacher-execution-resume-v1"),
  lineageRootRunId: opaqueIdSchema,
  checkpointId: opaqueIdSchema,
  revision: z.number().int().positive(),
  decision: z.object({
    version: z.literal("teacher-resume-decision-v1"),
    phase: executionCheckpointPhaseSchema,
    allowedActions: z.array(executionResumeActionSchema).min(1).max(3),
    stale: z.boolean(),
    staleReasons: z.array(z.enum([
      "request_revision_changed",
      "task_contract_changed",
      "editor_base_changed",
    ])).max(3),
    candidateArtifactId: opaqueIdSchema.optional(),
    validationArtifactId: opaqueIdSchema.optional(),
    validatorVersion: z.string().trim().max(300).optional(),
    rulesetVersion: z.string().trim().max(300).optional(),
    validationOptionsHash: contentHashSchema.optional(),
    requestRevisionHash: contentHashSchema,
    taskContractHash: contentHashSchema,
    editorBaseHash: contentHashSchema,
    repairRound: z.number().int().nonnegative().max(10_000),
    continuationKind: z.enum(["execution_completion", "engineering_improvement"]).default("execution_completion"),
  }).strict(),
  worker: z.object({
    candidate: z.unknown().optional(),
    validation: z.unknown().optional(),
    repairState: z.unknown().optional(),
  }).strict(),
  continuationKind: z.enum(["execution_completion", "engineering_improvement"]).optional(),
  engineering: z.object({
    status: z.string().trim().max(80).optional(),
    continuationKind: z.enum(["execution_completion", "engineering_improvement"]),
    baselineCandidateArtifactId: z.string().trim().max(200).optional(),
    baselineCandidateArtifactHash: contentHashSchema.optional(),
    baselineValidationArtifactId: z.string().trim().max(200).optional(),
    baselineValidationArtifactHash: contentHashSchema.optional(),
    assessmentCount: z.number().int().nonnegative().max(1),
    mainReentryCount: z.number().int().nonnegative().max(1).optional(),
    revisionCount: z.number().int().nonnegative().max(1),
    verificationCount: z.number().int().nonnegative().max(1),
    selectionCount: z.number().int().nonnegative().max(1).optional(),
    verification: z.enum(["not_run", "resolved", "unresolved", "unavailable"]).optional(),
    revisionDelivered: z.boolean().optional(),
    revisionAdopted: z.boolean().optional(),
    scorecard: z.object({
      userGoalCoverage: z.number().int().min(0).max(40),
      engineeringClosure: z.number().int().min(0).max(25),
      consistencyAndPreservation: z.number().int().min(0).max(20),
      evidenceAndUncertainty: z.number().int().min(0).max(15),
      total: z.number().int().min(0).max(100),
      reviewerRecommendation: z.enum(["deliver", "deliver_with_advisory", "optimize"]),
    }).strict().optional(),
    revisionScorecard: z.object({
      userGoalCoverage: z.number().int().min(0).max(40),
      engineeringClosure: z.number().int().min(0).max(25),
      consistencyAndPreservation: z.number().int().min(0).max(20),
      evidenceAndUncertainty: z.number().int().min(0).max(15),
      total: z.number().int().min(0).max(100),
      reviewerRecommendation: z.enum(["deliver", "deliver_with_advisory", "optimize"]),
    }).strict().optional(),
    openSuggestions: z.array(z.object({
      publicSuggestionId: z.string().trim().min(1).max(200),
      sourceIssueId: z.string().trim().min(1).max(200),
      goalRefId: z.string().trim().min(1).max(200),
      summary: z.string().trim().min(1).max(500),
    }).strict()).max(4).optional(),
    previousSuggestions: z.array(z.object({
      publicSuggestionId: z.string().trim().min(1).max(200),
      summary: z.string().trim().min(1).max(500),
    }).strict()).max(4).optional(),
    taskGoalRefs: z.array(z.unknown()).max(32),
    issueSummaries: z.array(z.unknown()).max(8),
    baselineCandidate: z.unknown().optional(),
    baselineValidation: z.unknown().optional(),
  }).strict().optional(),
  persistedAnswer: z.string().max(MAX_CANDIDATE_ARTIFACT_BYTES * 2).optional(),
}).strict();

const taskContractContextSchema = z.object({
  relation: z.enum(["same_lineage", "prior_dialogue"]),
  contract: z.object({
    contractId: z.string().trim().min(1).max(200),
    revision: z.number().int().nonnegative(),
    status: z.enum([
      "provisional",
      "active",
      "waiting_user",
      "executing",
      "sealed_for_finalization",
      "finalizing",
      "delivery_pending",
      "delivered",
      "cancelled",
      "superseded",
    ]),
    taskProfile: z.enum(["direct_answer", "model_authoring", "model_refinement", "validation_repair", "analysis"]),
    predecessorContractId: z.string().trim().max(200),
    taskRelation: z.enum(["new_task", "contextual_reference", "continue", "amend", "supersede"]),
    objectiveSummary: z.string().trim().max(4_000),
    goals: z.array(z.object({
      goalId: z.string().trim().min(1).max(200),
      statement: z.string().trim().min(1).max(4_000),
      required: z.boolean(),
      status: z.enum(["open", "in_progress", "covered", "blocked", "waived"]),
    }).strict()).min(1).max(64),
    assumptions: z.array(z.string().trim().min(1).max(1_000)).max(32),
    exclusions: z.array(z.string().trim().min(1).max(1_000)).max(32),
    openQuestions: z.array(z.string().trim().min(1).max(1_000)).max(32),
    preservationConstraints: z.array(z.string().trim().min(1).max(1_000)).max(32),
    deliveryStatus: z.enum(["not_started", "sealed", "pending", "delivered", "cancelled", "superseded"]),
    selectedDeliveryKind: z.enum(["direct_answer", "validated_candidate"]).optional(),
  }).strict(),
}).strict();

export const agentRunRequestSchema = z
  .object({
    runId: opaqueIdSchema,
    // 完整Thread历史由Conversation Store保留并在prepareStep按实际模型窗口投影；
    // HTTP请求包络仍由Model Deployment的contextWindowTokens确定性限制。
    question: z.string().trim().min(1),
    currentStudentQuestion: z.string().trim().min(1).max(20_000).optional(),
    conversationMessages: z.array(z.discriminatedUnion("role", [
      z.object({
        role: z.literal("user"),
        content: z.string().trim().min(1),
      }).strict(),
      z.object({
        role: z.literal("assistant"),
        content: z.string().trim().min(1),
      }).strict(),
    ])).default([]),
    taskSources: z.array(taskSourceSchema).default([]),
    taskContractContext: taskContractContextSchema.optional(),
    operation: z.enum(["repair"]).optional(),
    evaluationMode: z.enum(["local_benchmark"]).optional(),
    capabilityGrant: z
      .array(toolNameSchema)
      .max(TOOL_NAMES.length)
      .refine((items) => new Set(items).size === items.length, {
        message: "capabilityGrant values must be unique",
      }),
    resumeContext: z.object({
      sourceRunId: opaqueIdSchema,
      taskSources: z.array(taskSourceSchema).optional(),
      continuationKind: z.enum(["execution_completion", "engineering_improvement"]).optional(),
      continuationBudget: z.object({
        kind: z.enum(["execution_completion", "engineering_improvement"]).optional(),
        effectiveDurationMs: z.number().int().positive().max(1_800_000),
        runMaxDurationMs: z.number().int().positive().max(1_800_000).optional(),
        lineageMaxDurationMs: z.number().int().positive().max(1_800_000).optional(),
        orchestrationReserveMs: z.number().int().nonnegative().max(120_000).optional(),
        minimumCompleteChainMs: z.number().int().positive().max(1_800_000).optional(),
        lineageDeadlineAt: z.string().datetime().optional(),
      }).strict().optional(),
      fastGate: fastGatePassThroughV2Schema,
      sourceStudentQuestion: z.string().trim().min(1).max(20_000).optional(),
      execution: executionResumeSchema.optional(),
      priorToolLedger: z.array(z.object({
        toolCallId: z.string().trim().min(1).max(256),
        toolName: z.enum(["search_reviewed_knowledge", "search_engineering_domain_evidence"]),
        input: z.unknown(),
        output: z.unknown(),
      }).strict()).max(22),
    }).strict().optional(),
    context: teacherAgentContextSchema,
  })
  .strict();

export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>;

export const agentPolicySchema = z
  .object({
    maxSteps: z.number().int().positive(),
    maxDurationMs: z.number().int().positive(),
    terminalReserveMs: z.number().int().positive(),
    convergeLeadMs: z.number().int().positive(),
    toolTimeoutMs: z.number().int().positive(),
    contextWindowTokens: z.number().int().positive(),
    scopeGateEnabled: z.boolean(),
    scopeGateInitialTimeoutMs: z.number().int().positive().max(30_000),
    scopeGateReviewTimeoutMs: z.number().int().positive().max(30_000),
    scopeGateHardInputTokenBudget: z.number().int().positive(),
    scopeGateMaxOutputTokens: z.number().int().positive(),
    inspectLessonContextMaxCallsPerRun: z.number().int().positive(),
    inspectCurrentModelMaxCallsPerRun: z.number().int().positive(),
    skillGuidanceMaxCallsPerRun: z.number().int().positive(),
    reviewedKnowledgeMaxCallsPerRun: z.number().int().positive(),
    domainEvidenceMaxCallsPerRun: z.number().int().nonnegative(),
    readOnlyToolMaxRetriesPerOperation: z.number().int().min(0).max(2),
    readOnlyToolInputMaxBytes: z.number().int().positive(),
    readOnlyToolTimeoutMs: z.number().int().positive(),
    domainEvidenceToolTimeoutMs: z.number().int().positive(),
    candidateRecoveryMaxAttempts: z.number().int().nonnegative(),
    candidateMaxAttemptMs: z.number().int().positive(),
    candidateRepairEnabled: z.boolean(),
    repairPhaseReserveMs: z.number().int().min(30_000).max(300_000),
    repairMaxRounds: z.number().int().nonnegative(),
    candidateMaxArtifactBytes: z.number().int().positive(),
    semanticReviewEnabled: z.boolean(),
    semanticReviewShadowOnly: z.boolean(),
    semanticReviewAssessmentMaxCalls: z.union([z.literal(0), z.literal(1)]),
    semanticReviewAssessmentTimeoutMs: z.number().int().min(5_000).max(120_000),
    semanticReviewMainDecisionTimeoutMs: z.number().int().min(3_000).max(60_000),
    semanticReviewVerificationMaxCalls: z.literal(1),
    semanticReviewVerificationTimeoutMs: z.number().int().min(5_000).max(120_000),
    // 这是Reviewer文本协议的固定安全上限，不是资源策略或评分阈值。
    // Policy v18删除了semanticReview.maxIssues后，缺省值必须在协议边界补齐。
    semanticReviewMaxIssues: z.literal(8).default(8),
    semanticReviewMinimumCompleteChainMs: z.number().int().min(60_000).max(600_000),
    semanticReviewDomainSearchReserveMs: z.number().int().min(0).max(120_000),
    engineeringRevisionMaxCycles: z.literal(1),
    engineeringRevisionMaxDurationMs: z.number().int().min(60_000).max(600_000),
    // 该值由统一 Run 策略中的 Validator 排队、执行与传输余量派生，
    // 这里只校验投影形状，不能再叠加一个独立的阶段最小时间门禁。
    engineeringRevisionValidationRepairReserveMs: z.number().int().positive().max(420_000),
    engineeringImprovementRunMaxDurationMs: z.number().int().min(300_000).max(1_200_000),
    engineeringImprovementApiOuterTimeoutMs: z.number().int().min(330_000).max(1_240_000),
    engineeringImprovementLineageMaxDurationMs: z.number().int().min(900_000).max(2_400_000),
    engineeringImprovementOrchestrationReserveMs: z.number().int().min(5_000).max(60_000),
    engineeringImprovementMinimumCompleteChainMs: z.number().int().positive(),
    validatorToolTimeoutMs: z.number().int().positive(),
    mainContextExecutionReserveTokens: z.number().int().positive(),
    temperature: z.number().min(0).max(2),
  })
  .strict();

export const agentPolicyOverrideSchema = agentPolicySchema.partial().strict();

export type AgentPolicy = z.infer<typeof agentPolicySchema>;

export const DEFAULT_AGENT_POLICY: AgentPolicy = agentPolicySchema.parse(bootstrapAgentPolicy(Object.keys(agentPolicySchema.shape)));

export const inspectLessonContextInputSchema = z
  .object({
    includeObjectives: z.boolean().default(true),
    detail: z.enum(["summary", "rules", "reference_model", "full"]).default("summary"),
  })
  .strict();

export const inspectCurrentModelInputSchema = z
  .object({
    source: z.enum(["current_workspace", "last_validated_candidate"]).default("current_workspace"),
    detail: z.enum(["summary", "selection", "diagnostics", "full"]).default("summary"),
  })
  .strict();

export const searchGuidanceInputSchema = z
  .object({
    query: z.string().trim().min(2).max(500),
    topic: z.string().trim().min(2).max(120).optional(),
    limit: z.number().int().min(1).max(5).default(3),
  })
  .strict();

export const searchReviewedKnowledgeInputSchema = z
  .object({
    query: z.string().trim().min(2).max(500),
    topic: z.string().trim().min(2).max(120).optional(),
    limit: z.number().int().min(0).max(25).default(5),
    selectedPatternIds: z.array(opaqueIdSchema).max(8).default([]),
    offset: z.number().int().nonnegative().optional(),
    exampleIds: z.array(opaqueIdSchema).optional(),
    claimIds: z.array(opaqueIdSchema).optional(),
    evidenceIds: z.array(opaqueIdSchema).optional(),
  })
  .strict();

export const searchDomainEvidenceInputSchema = z
  .object({
    questions: z.array(z.string().trim().min(2).max(500)).min(1).max(3),
  })
  .strict();

const candidateFileSchema = z
  .object({
    fileId: opaqueIdSchema,
    baseHash: contentHashSchema,
    content: z.string().max(MAX_CANDIDATE_ARTIFACT_BYTES * 2),
  })
  .strict();

const candidateEditSchema = z
  .object({
    fileId: opaqueIdSchema,
    baseHash: contentHashSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    replacement: z.string().max(MAX_CANDIDATE_ARTIFACT_BYTES),
  })
  .strict()
  .refine((edit) => edit.endLine >= edit.startLine, {
    message: "edit.endLine must be greater than or equal to edit.startLine",
  });

export const validateCandidateInputSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("standalone_model"),
      fileName: z.string().trim().min(1).max(160),
      content: z.string().min(1).max(MAX_CANDIDATE_ARTIFACT_BYTES),
    })
    .strict(),
  z
    .object({
      mode: z.literal("replace_entry"),
      fileId: opaqueIdSchema,
      baseHash: contentHashSchema,
      content: z.string().max(MAX_CANDIDATE_ARTIFACT_BYTES * 2),
    })
    .strict(),
  z
    .object({
      mode: z.literal("apply_edits"),
      edits: z.array(candidateEditSchema).min(1).max(24),
    })
    .strict(),
  z
    .object({
      mode: z.literal("workspace_files"),
      files: z.array(candidateFileSchema).min(1).max(20),
    })
    .strict(),
]);

/** 服务端构造并在同一Run内直接传递的真实候选对象。 */
export type CandidateArtifact = z.infer<typeof validateCandidateInputSchema>;

// Validator 工具注册仍要求顶层 `type: object`；discriminated union 会序列化为
// 顶层 `anyOf`。该 envelope 只服务内部工具边界，不再作为 Candidate Worker
// 的输出协议；validateCandidateInputSchema 仍是 fail-closed 内部契约。
export const validateCandidateToolInputSchema = z
  .object({
    mode: z.enum(["standalone_model", "replace_entry", "apply_edits", "workspace_files"]),
    fileName: z.string().trim().min(1).max(160).optional(),
    fileId: opaqueIdSchema.optional(),
    baseHash: contentHashSchema.optional(),
    content: z.string().max(MAX_CANDIDATE_ARTIFACT_BYTES * 2).optional(),
    edits: z.array(candidateEditSchema).min(1).max(24).optional(),
    files: z.array(candidateFileSchema).min(1).max(20).optional(),
  })
  .strict();

export type InspectLessonContextInput = z.infer<typeof inspectLessonContextInputSchema>;
export type InspectCurrentModelInput = z.infer<typeof inspectCurrentModelInputSchema>;
export type SearchGuidanceInput = z.infer<typeof searchGuidanceInputSchema>;
export type SearchReviewedKnowledgeInput = z.infer<typeof searchReviewedKnowledgeInputSchema>;
export type SearchDomainEvidenceInput = z.infer<typeof searchDomainEvidenceInputSchema>;
export type ValidateCandidateInput = z.infer<typeof validateCandidateInputSchema>;

export const lessonContextOutputSchema = z
  .object({
    courseId: opaqueIdSchema,
    lessonId: opaqueIdSchema,
    title: z.string().min(1).max(240),
    objectives: z.array(z.string().min(1).max(1_000)).max(20),
    taskHints: z.array(z.string().min(1).max(1_000)).max(20),
    courseRules: z.array(courseRuleReferenceSchema).max(100).optional(),
    referenceModel: courseReferenceModelSchema.optional(),
  })
  .strict();

const modelSummarySchema = z
  .object({
    fileId: opaqueIdSchema,
    displayName: z.string().min(1).max(160),
    contentHash: contentHashSchema,
    editable: z.boolean(),
    characterCount: z.number().int().nonnegative(),
    content: z.string().max(MAX_CANDIDATE_ARTIFACT_BYTES * 2).optional(),
  })
  .strict();

export const currentModelOutputSchema = z
  .object({
    source: z.enum(["current_workspace", "last_validated_candidate"]).default("current_workspace"),
    files: z.array(modelSummarySchema).min(1).max(20),
    activeFileId: opaqueIdSchema.optional(),
    focus: editorGroundingSchema,
    diagnostics: z.array(diagnosticSchema).max(100),
    activeDiagnosticId: z.string().min(1).max(160).optional(),
  })
  .strict();

const skillGuidanceItemSchema = z
  .object({
    sourceId: opaqueIdSchema,
    title: z.string().min(1).max(240),
    excerpt: z.string().min(1).max(4_000),
    authority: z.enum(["official", "project_skill", "reference"]),
    version: z.string().min(1).max(120),
    contentHash: contentHashSchema,
  })
  .strict();

export const skillGuidanceOutputSchema = z
  .object({
    query: z.string().min(2).max(500),
    items: z.array(skillGuidanceItemSchema).max(5),
  })
  .strict();

const domainEvidenceSourceSchema = z
  .object({
    sourceId: opaqueIdSchema,
    title: z.string().min(1).max(300),
    url: z.string().url().refine(
      (value) => value.startsWith("https://") || value.startsWith("http://"),
      { message: "Domain evidence URL must use HTTP or HTTPS" },
    ),
    pageAge: z.string().min(1).max(120).optional(),
  })
  .strict();

export const domainEvidenceOutputSchema = z
  .object({
    version: z.literal("domain-search-result-v3"),
    status: z.enum(["complete", "partial", "unavailable"]),
    provider: z.literal("deepseek-native-web-search"),
    questions: z.array(z.string().min(2).max(500)).min(1).max(3),
    summary: z.string().max(4_000),
    sources: z.array(domainEvidenceSourceSchema).max(10),
    searchRequestCount: z.number().int().min(0).max(2),
    warnings: z.array(z.string().min(1).max(160)).max(12),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === "complete" && (
      result.searchRequestCount === 0
      || result.sources.length === 0
      || !result.summary.trim()
    )) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Complete domain evidence requires a search, a summary, and a traceable source",
      });
    }
    if (result.status === "unavailable" && result.searchRequestCount > 0) {
      context.addIssue({
        code: "custom",
        path: ["searchRequestCount"],
        message: "Unavailable domain evidence must not claim completed search requests",
      });
    }
  });

export type DomainEvidenceOutput = z.infer<typeof domainEvidenceOutputSchema>;

const reviewedKnowledgeItemSchema = z
  .object({
    cardId: opaqueIdSchema,
    title: z.string().min(1).max(240),
    excerpt: z.string().min(1).max(4_000),
    reviewed: z.literal(true),
    evidenceLevel: z.enum(["official", "reviewed_project", "reviewed_reference"]),
    version: z.string().min(1).max(120),
    contentHash: contentHashSchema,
  })
  .strict();

const reviewedKnowledgeClaimSchema = z
  .object({
    claimId: opaqueIdSchema,
    claimText: z.string().min(1),
    authorityLevel: z.enum(["A1", "A2"]),
    operators: z.array(z.string().min(1).max(16)).max(16).default([]),
    astContextIds: z.array(semanticIdSchema).max(16).default([]),
    evidenceIds: z.array(opaqueIdSchema).min(1),
    selectionRole: z.enum(["required", "supporting", "additional_supporting"]),
  })
  .strict();

const reviewedKnowledgeEvidenceSchema = z
  .object({
    evidenceId: opaqueIdSchema,
    sourceId: opaqueIdSchema,
    sectionPath: z.string().min(1).max(500),
    excerpt: z.string().min(1),
    textHash: contentHashSchema,
    authorityLevel: z.enum(["A1", "A2"]),
  })
  .strict();

const knowledgeOperatorOccurrenceSchema = z
  .object({
    sourceType: z.enum([
      "model_request",
      "trusted_question",
      "trusted_selection",
      "trusted_active_model",
    ]),
    fileId: opaqueIdSchema.optional(),
    contentHash: contentHashSchema,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    token: z.string().min(1).max(32),
    observedAstContextId: semanticIdSchema.optional(),
    expandedAstContextIds: z.array(semanticIdSchema).max(16).default([]),
  })
  .strict()
  .refine((occurrence) => occurrence.end > occurrence.start, {
    message: "operator occurrence end must be greater than start",
  });

const reviewedKnowledgeGuardrailSchema = z
  .object({
    guardrailId: opaqueIdSchema,
    authorityClass: z.literal("engineering_guardrail"),
    description: z.string().min(1).max(2_000),
    patternSpec: z
      .array(z.object({
        kind: z.enum(["regex", "substring"]),
        value: z.string().min(1).max(2_000),
        flags: z.string().max(16).optional(),
      }).strict())
      .min(1)
      .max(32),
    patternHash: contentHashSchema,
    supportedByClaimIds: z.array(opaqueIdSchema).min(1).max(25),
    counterexampleIds: z.array(opaqueIdSchema).max(32).default([]),
  })
  .strict();

const reviewedKnowledgePatternCandidateSchema = z
  .object({
    patternId: opaqueIdSchema,
    title: z.string().min(1).max(240),
    description: z.string().min(1).max(2_000),
    matchedAnchorNodeIds: z.array(semanticIdSchema).max(16).default([]),
    matchedClaimIds: z.array(opaqueIdSchema).max(25).default([]),
    closureDimensions: z.array(z.string().min(1).max(120)).max(16).default([]),
  })
  .strict();

const reviewedKnowledgeExampleSchema = z
  .object({
    exampleId: opaqueIdSchema,
    title: z.string().min(1).max(240),
    intentText: z.string().min(1).max(2_000),
    modelText: z.string().min(1),
    relatedClaimIds: z.array(opaqueIdSchema).optional(),
    source: z.unknown().optional(),
    properties: z.unknown().optional(),
    constructTags: z.array(z.string().min(1).max(64)).max(32),
    exampleAuthority: z.enum(["official-example", "community-example"]),
    languageVersionTrack: z.string().min(1).max(64),
    validatorPassed: z.literal(true),
    truncated: z.boolean().optional(),
  })
  .strict();

export const reviewedKnowledgeOutputSchema = z
  .object({
    requestedQuery: z.string().min(2).max(500),
    effectiveQuery: z.string().min(2).max(2_000),
    requestedQueryHash: contentHashSchema,
    effectiveQueryHash: contentHashSchema,
    closureProfileId: opaqueIdSchema,
    closureProfileHash: contentHashSchema,
    closureRequirement: z.enum(["not_applicable", "required"]).optional(),
    closureStatus: z.enum(["not_applicable", "complete", "incomplete"]).optional(),
    intentMode: z.enum(["compare_operator_semantics", "explain_occurrence", "general_semantic_search"]),
    operatorOccurrences: z.array(knowledgeOperatorOccurrenceSchema).max(128).default([]),
    queryExpansion: z.object({
      addedOperators: z.array(z.string().min(1).max(32)).max(32).default([]),
      sources: z.array(z.enum([
        "trusted_question",
        "trusted_selection",
        "trusted_active_model",
      ])).max(3).default([]),
    }).strict(),
    coverage: z.enum(["COMPLETE", "PARTIAL", "NONE"]).default("NONE"),
    no_new_evidence: z.boolean().default(false),
    bundleId: opaqueIdSchema.optional(),
    baselineId: opaqueIdSchema.optional(),
    bundleVersion: z.string().min(1).max(120).optional(),
    sourceRegistryHash: contentHashSchema.optional(),
    bundleContentHash: contentHashSchema.optional(),
    resultHash: contentHashSchema,
    candidateKnowledgePatterns: z.array(reviewedKnowledgePatternCandidateSchema).max(16).default([]),
    selectedKnowledgePatternIds: z.array(opaqueIdSchema).max(8).default([]),
    selectedPatternClosureClaimIds: z.array(opaqueIdSchema).default([]),
    patternSelectionWarnings: z.array(z.string().min(1).max(240)).max(16).default([]),
    closureGaps: z.array(z.string().min(1).max(240)).max(32).default([]),
    closureClaimIds: z.array(opaqueIdSchema).default([]),
    knowledgeAnswerRequiredClaimIds: z.array(opaqueIdSchema).default([]),
    knowledgeSupportingClaimIds: z.array(opaqueIdSchema).default([]),
    mandatorySupportingCount: z.number().int().min(0),
    additionalSupportingClaimIds: z.array(opaqueIdSchema).default([]),
    missingClosureClaimIds: z.array(opaqueIdSchema).default([]),
    requestedLimit: z.number().int().min(0),
    additionalSupportingBudget: z.number().int().min(0),
    selectionLimit: z.number().int().min(0),
    returnedClaimCount: z.number().int().min(0),
    resourceLimit: z.number().int().nonnegative(),
    claims: z.array(reviewedKnowledgeClaimSchema).default([]),
    evidenceBlocks: z.array(reviewedKnowledgeEvidenceSchema).default([]),
    guardrails: z.array(reviewedKnowledgeGuardrailSchema).max(64).default([]),
    examples: z.array(reviewedKnowledgeExampleSchema).optional(),
    nextOffset: z.number().int().nonnegative().optional(),
    hasMore: z.boolean().optional(),
    conflicts: z.array(opaqueIdSchema).default([]),
    excludedCandidates: z.object({
      count: z.number().int().min(0),
      claimIds: z.array(opaqueIdSchema),
    }).strict(),
    items: z.array(reviewedKnowledgeItemSchema).max(8),
  })
  .strict()
  .superRefine((result, issueContext) => {
    const inferredRequirement = result.closureClaimIds.length > 0
      || result.missingClosureClaimIds.length > 0
      || result.closureGaps.length > 0 ? "required" : "not_applicable";
    const closureRequirement = result.closureRequirement ?? inferredRequirement;
    const hasClosureGaps = result.missingClosureClaimIds.length > 0 || result.closureGaps.length > 0;
    const inferredStatus = closureRequirement === "not_applicable"
      ? "not_applicable"
      : hasClosureGaps ? "incomplete" : "complete";
    const closureStatus = result.closureStatus ?? inferredStatus;
    const closureRequired = closureRequirement === "required";
    if ((!closureRequired && closureStatus !== "not_applicable")
      || (closureRequired && closureStatus === "not_applicable")
      || (closureStatus === "complete" && hasClosureGaps)
      || (closureStatus === "incomplete" && !hasClosureGaps)) {
      issueContext.addIssue({
        code: "custom",
        path: ["closureStatus"],
        message: "closureRequirement and closureStatus must describe the actual mandatory Claim closure",
      });
    }
    const unique = (values: readonly string[]) => new Set(values).size === values.length;
    for (const [field, values] of [
      ["closureClaimIds", result.closureClaimIds],
      ["knowledgeAnswerRequiredClaimIds", result.knowledgeAnswerRequiredClaimIds],
      ["knowledgeSupportingClaimIds", result.knowledgeSupportingClaimIds],
      ["additionalSupportingClaimIds", result.additionalSupportingClaimIds],
      ["selectedKnowledgePatternIds", result.selectedKnowledgePatternIds],
      ["selectedPatternClosureClaimIds", result.selectedPatternClosureClaimIds],
      ["patternSelectionWarnings", result.patternSelectionWarnings],
      ["closureGaps", result.closureGaps],
    ] as const) {
      if (!unique(values)) {
        issueContext.addIssue({ code: "custom", path: [field], message: `${field} values must be unique` });
      }
    }
    const mandatory = [
      ...result.knowledgeAnswerRequiredClaimIds,
      ...result.knowledgeSupportingClaimIds,
    ];
    if (result.mandatorySupportingCount !== result.knowledgeSupportingClaimIds.length) {
      issueContext.addIssue({
        code: "custom",
        path: ["mandatorySupportingCount"],
        message: "mandatorySupportingCount must equal knowledgeSupportingClaimIds.length",
      });
    }
    if (new Set(mandatory).size !== mandatory.length
      || mandatory.length !== result.closureClaimIds.length
      || mandatory.some((claimId) => !result.closureClaimIds.includes(claimId))) {
      issueContext.addIssue({
        code: "custom",
        path: ["closureClaimIds"],
        message: "closureClaimIds must equal the disjoint answer-required and supporting Claim union",
      });
    }
    if (result.additionalSupportingClaimIds.some((claimId) => result.closureClaimIds.includes(claimId))) {
      issueContext.addIssue({
        code: "custom",
        path: ["additionalSupportingClaimIds"],
        message: "additional supporting Claims must be outside the mandatory closure",
      });
    }
    if (result.excludedCandidates.count < result.excludedCandidates.claimIds.length
      || !unique(result.excludedCandidates.claimIds)
      || result.excludedCandidates.claimIds.some((claimId) => (
        result.closureClaimIds.includes(claimId)
        || result.additionalSupportingClaimIds.includes(claimId)
      ))) {
      issueContext.addIssue({
        code: "custom",
        path: ["excludedCandidates"],
        message: "excludedCandidates must contain unique IDs outside the returned Claim set and a valid total count",
      });
    }
    if (result.selectionLimit !== result.closureClaimIds.length + result.additionalSupportingBudget) {
      issueContext.addIssue({
        code: "custom",
        path: ["selectionLimit"],
        message: "selectionLimit must equal closure size plus the bounded additional supporting budget",
      });
    }
    if (result.returnedClaimCount !== result.claims.length || result.claims.length > result.selectionLimit) {
      issueContext.addIssue({
        code: "custom",
        path: ["returnedClaimCount"],
        message: "returnedClaimCount must equal claims.length within selectionLimit",
      });
    }
    const candidatePatternIds = result.candidateKnowledgePatterns.map((pattern) => pattern.patternId);
    if (!unique(candidatePatternIds)
      || result.selectedKnowledgePatternIds.some((patternId) => !candidatePatternIds.includes(patternId))) {
      issueContext.addIssue({
        code: "custom",
        path: ["selectedKnowledgePatternIds"],
        message: "selectedKnowledgePatternIds must be unique IDs from candidateKnowledgePatterns",
      });
    }
    if (result.selectedPatternClosureClaimIds.some((claimId) => !result.closureClaimIds.includes(claimId))) {
      issueContext.addIssue({
        code: "custom",
        path: ["selectedPatternClosureClaimIds"],
        message: "selected Pattern closure Claims must be members of the active closure",
      });
    }
    if ((result.selectedKnowledgePatternIds.length > 0) !== (result.selectedPatternClosureClaimIds.length > 0)) {
      issueContext.addIssue({
        code: "custom",
        path: ["selectedPatternClosureClaimIds"],
        message: "selected Patterns and their supporting closure Claims must be present together",
      });
    }
    if (result.coverage !== "COMPLETE") return;
    const requiredFields = [
      "bundleId",
      "baselineId",
      "bundleVersion",
      "sourceRegistryHash",
      "bundleContentHash",
      "resultHash",
    ] as const;
    for (const field of requiredFields) {
      if (!result[field]) {
        issueContext.addIssue({
          code: "custom",
          path: [field],
          message: `COMPLETE knowledge coverage requires ${field}`,
        });
      }
    }
    if (result.claims.length === 0 || result.evidenceBlocks.length === 0) {
      issueContext.addIssue({
        code: "custom",
        path: ["claims"],
        message: "COMPLETE knowledge coverage requires evidence-bound claims",
      });
    }
    if (result.missingClosureClaimIds.length > 0) {
      issueContext.addIssue({
        code: "custom",
        path: ["missingClosureClaimIds"],
        message: "COMPLETE knowledge coverage requires the full mandatory Claim closure",
      });
    }
    if (result.closureGaps.length > 0) {
      issueContext.addIssue({
        code: "custom",
        path: ["closureGaps"],
        message: "COMPLETE knowledge coverage cannot contain unresolved closure gaps",
      });
    }
    const claimsById = new Map(result.claims.map((claim) => [claim.claimId, claim]));
    for (const claimId of result.closureClaimIds) {
      if (!claimsById.has(claimId)) {
        issueContext.addIssue({
          code: "custom",
          path: ["claims"],
          message: `COMPLETE knowledge coverage is missing closure Claim: ${claimId}`,
        });
      }
    }
    for (const claimId of result.knowledgeAnswerRequiredClaimIds) {
      if (claimsById.get(claimId)?.selectionRole !== "required") {
        issueContext.addIssue({ code: "custom", path: ["claims"], message: `Claim role mismatch: ${claimId}` });
      }
    }
    for (const claimId of result.knowledgeSupportingClaimIds) {
      if (claimsById.get(claimId)?.selectionRole !== "supporting") {
        issueContext.addIssue({ code: "custom", path: ["claims"], message: `Claim role mismatch: ${claimId}` });
      }
    }
    for (const claimId of result.additionalSupportingClaimIds) {
      if (claimsById.get(claimId)?.selectionRole !== "additional_supporting") {
        issueContext.addIssue({ code: "custom", path: ["claims"], message: `Claim role mismatch: ${claimId}` });
      }
    }
    const additionalRoleIds = result.claims
      .filter((claim) => claim.selectionRole === "additional_supporting")
      .map((claim) => claim.claimId);
    if (additionalRoleIds.length !== result.additionalSupportingClaimIds.length
      || additionalRoleIds.some((claimId) => !result.additionalSupportingClaimIds.includes(claimId))) {
      issueContext.addIssue({
        code: "custom",
        path: ["additionalSupportingClaimIds"],
        message: "additionalSupportingClaimIds must exactly match additional_supporting Claim roles",
      });
    }
    const evidenceIds = new Set(result.evidenceBlocks.map((item) => item.evidenceId));
    for (const [index, claim] of result.claims.entries()) {
      for (const evidenceId of claim.evidenceIds) {
        if (!evidenceIds.has(evidenceId)) {
          issueContext.addIssue({
            code: "custom",
            path: ["claims", index, "evidenceIds"],
            message: `Claim evidence is not present in the result: ${evidenceId}`,
          });
        }
      }
    }
    for (const [index, guardrail] of result.guardrails.entries()) {
      for (const claimId of guardrail.supportedByClaimIds) {
        if (!claimsById.has(claimId)) {
          issueContext.addIssue({
            code: "custom",
            path: ["guardrails", index, "supportedByClaimIds"],
            message: `Guardrail Claim is not present in the result: ${claimId}`,
          });
        }
      }
    }
  })
  .transform((result) => {
    const closureRequirement = result.closureRequirement
      ?? (result.closureClaimIds.length > 0
        || result.missingClosureClaimIds.length > 0
        || result.closureGaps.length > 0
        ? "required"
        : "not_applicable");
    const closureStatus = result.closureStatus
      ?? (closureRequirement === "not_applicable"
        ? "not_applicable"
        : result.missingClosureClaimIds.length > 0 || result.closureGaps.length > 0 ? "incomplete" : "complete");
    return { ...result, closureRequirement, closureStatus };
  });

const validatorDiagnosticSchema = z
  .object({
    severity: z.enum(["error", "warning", "info"]),
    code: z.string().min(1).max(120).optional(),
    message: z.string().min(1).max(4_000),
    fileId: opaqueIdSchema.optional(),
    from: z.number().int().nonnegative().optional(),
    to: z.number().int().nonnegative().optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    lineText: z.string().max(20_000).optional(),
  })
  .strict();

const validatedPatchSchema = z
  .object({
    fileId: opaqueIdSchema,
    baseHash: contentHashSchema,
    candidateHash: contentHashSchema,
    kind: z.enum(["replace_entry", "apply_edits", "workspace_files"]),
  })
  .strict();

export const candidateStructureEvidenceSchema = z
  .object({
    source: z.enum(["official_semantic_outline", "local_structure_analyzer", "none"]),
    authority: z.enum(["authoritative", "advisory", "none"]),
    status: z.enum(["available", "partial", "invalid", "unavailable"]),
    contentHash: contentHashSchema.optional(),
    nodes: z.array(z.object({
      kind: z.string().min(1).max(160),
      name: z.string().min(1).max(240).optional(),
      qualifiedName: z.string().min(1).max(500).optional(),
      ownerPath: z.array(z.string().min(1).max(240)).max(20).optional(),
      fileId: opaqueIdSchema.optional(),
      line: z.number().int().positive().optional(),
    }).strict()).max(200),
    diagnostics: z.array(z.object({
      severity: z.enum(["error", "warning", "info"]),
      category: z.string().min(1).max(120).optional(),
      source: z.string().min(1).max(160).optional(),
      message: z.string().min(1).max(4_000),
    }).strict()).max(100),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((evidence, issueContext) => {
    if (evidence.source === "official_semantic_outline"
      && (evidence.authority !== "authoritative" || evidence.status !== "available" || !evidence.contentHash)) {
      issueContext.addIssue({
        code: "custom",
        path: ["source"],
        message: "official semantic outline evidence must be authoritative, available, and content-bound",
      });
    }
    if (evidence.source === "local_structure_analyzer"
      && (evidence.authority !== "advisory" || evidence.status !== "partial" || evidence.contentHash)) {
      issueContext.addIssue({
        code: "custom",
        path: ["source"],
        message: "local structure evidence must remain advisory and partial without an official content hash",
      });
    }
    if (evidence.source === "none"
      && (evidence.authority !== "none" || evidence.nodes.length > 0 || evidence.contentHash)) {
      issueContext.addIssue({
        code: "custom",
        path: ["source"],
        message: "missing structure evidence cannot claim authority, nodes, or a content hash",
      });
    }
  });

const validationDiagnosticSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    included: z.number().int().nonnegative().max(200),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((summary, issueContext) => {
    if (summary.included > summary.total) {
      issueContext.addIssue({
        code: "custom",
        path: ["included"],
        message: "included diagnostics cannot exceed total diagnostics",
      });
    }
    if (summary.truncated !== (summary.total > summary.included)) {
      issueContext.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "diagnostic truncation flag must match total and included counts",
      });
    }
  });

export const validationOutputSchema = z
  .object({
    validator: z
      .object({
        authority: z.literal("official-sysml-v2-validator"),
        version: z.string().min(1).max(120),
        evidenceHash: contentHashSchema,
      })
      .strict(),
    official: z
      .object({
        syntax: z.enum(["passed", "failed", "unavailable"]),
        semantic: z.enum(["passed", "failed", "not_run", "unavailable"]),
        diagnostics: z.array(validatorDiagnosticSchema).max(200),
      })
      .strict(),
    courseRules: z
      .object({
        status: z.enum(["passed", "failed", "not_run"]),
        diagnostics: z.array(validatorDiagnosticSchema).max(200),
      })
      .strict()
      .optional(),
    courseRuleApplicability: z
      .enum(["applicable", "not_applicable", "unknown"])
      .default("unknown"),
    completeness: z.enum(["complete", "partial"]),
    diagnosticSummary: validationDiagnosticSummarySchema.optional(),
    structureEvidence: candidateStructureEvidenceSchema.optional(),
    candidateWorkspaceHash: contentHashSchema.optional(),
    patches: z.array(validatedPatchSchema).max(20).default([]),
  })
  .strict()
  .superRefine((result, issueContext) => {
    const officialPassed =
      result.official.syntax === "passed" && result.official.semantic === "passed";
    if (!officialPassed && result.courseRules) {
      issueContext.addIssue({
        code: "custom",
        path: ["courseRules"],
        message: "courseRules must not run before official validation passes",
      });
    }
    if (result.patches.length > 0 && !result.candidateWorkspaceHash) {
      issueContext.addIssue({
        code: "custom",
        path: ["candidateWorkspaceHash"],
        message: "validated patches require candidateWorkspaceHash",
      });
    }
    if (officialPassed
      && result.courseRuleApplicability === "applicable"
      && !result.courseRules) {
      issueContext.addIssue({
        code: "custom",
        path: ["courseRules"],
        message: "applicable course rules require an explicit result",
      });
    }
    if (result.courseRuleApplicability !== "applicable" && result.courseRules) {
      issueContext.addIssue({
        code: "custom",
        path: ["courseRules"],
        message: "courseRules are only allowed when course rules are applicable",
      });
    }
    if (result.diagnosticSummary) {
      const includedDiagnostics = result.official.diagnostics.length
        + (result.courseRules?.diagnostics.length ?? 0);
      if (result.diagnosticSummary.included !== includedDiagnostics) {
        issueContext.addIssue({
          code: "custom",
          path: ["diagnosticSummary", "included"],
          message: "diagnostic summary must match the diagnostics carried by the protocol",
        });
      }
    }
  });

export type LessonContextOutput = z.infer<typeof lessonContextOutputSchema>;
export type CurrentModelOutput = z.infer<typeof currentModelOutputSchema>;
export type SkillGuidanceOutput = z.infer<typeof skillGuidanceOutputSchema>;
export type ReviewedKnowledgeOutput = z.infer<typeof reviewedKnowledgeOutputSchema>;
export type ValidationOutput = z.infer<typeof validationOutputSchema>;
export type CandidateStructureEvidence = z.infer<typeof candidateStructureEvidenceSchema>;

export type AgentLifecycleEvent =
  | {
      type: "run_started";
      runId: string;
      callId: string;
      provider: string;
      modelId: string;
      maxRetries: number;
    }
  | {
      type: "run_finished";
      runId: string;
      stepCount: number;
      finishReason: string;
      modelCalls?: TrustedTeacherResponse["modelCalls"];
    };

export interface AgentRepairProgress {
  phase: "started" | "validation_failed" | "validation_passed" | "stopped";
  round: number;
  maxRounds: number;
  diagnosticCount?: number;
}

export interface AgentDependencies {
  inspectLessonContext(args: {
    context: TeacherAgentContext;
    input: InspectLessonContextInput;
    abortSignal?: AbortSignal;
  }): Promise<unknown>;
  inspectCurrentModel(args: {
    context: TeacherAgentContext;
    input: InspectCurrentModelInput;
    grounding: EditorGrounding;
    abortSignal?: AbortSignal;
  }): Promise<unknown>;
  searchSkillGuidance(args: {
    context: TeacherAgentContext;
    input: SearchGuidanceInput;
    abortSignal?: AbortSignal;
  }): Promise<unknown>;
  searchReviewedKnowledge(args: {
    context: TeacherAgentContext;
    input: SearchReviewedKnowledgeInput;
    abortSignal?: AbortSignal;
  }): Promise<unknown>;
  listActiveExampleCatalog?(args: {
    abortSignal?: AbortSignal;
  }): Promise<readonly {
    exampleId: string;
    title: string;
    topicPath: string;
    constructTags: readonly string[];
    exampleAuthority: "official-example" | "community-example";
  }[]>;
  searchReviewedKnowledgeExamples?(args: {
    query: string;
    constructTags: readonly string[];
    exampleLimit: number;
    abortSignal?: AbortSignal;
  }): Promise<unknown>;
  searchDomainEvidence(args: {
    context: TeacherAgentContext;
    input: SearchDomainEvidenceInput;
    abortSignal?: AbortSignal;
  }): Promise<unknown>;
  validateCandidateWorkspace(args: {
    context: TeacherAgentContext;
    input: ValidateCandidateInput;
    abortSignal?: AbortSignal;
  }): Promise<unknown>;
  /** 服务端投影公开Repair状态；不得携带Candidate正文、Prompt或reasoning。 */
  reportRepairProgress?(progress: AgentRepairProgress): Promise<void> | void;
  persistExecutionCheckpoint?(boundary: {
    phase: z.infer<typeof executionCheckpointPhaseSchema>;
    candidate?: CandidateArtifact;
    validation?: ValidationOutput;
    candidateArtifactId?: string;
    validationArtifactId?: string;
    validatorVersion?: string;
    rulesetVersion?: string;
    validationOptionsHash?: string;
    repairRound?: number;
    repairState?: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  findReusableValidationArtifact?(input: {
    candidateWorkspaceHash: string;
    validatorVersion: string;
    rulesetVersion: string;
    validationOptionsHash: string;
  }): Promise<unknown>;
  loadLatestExecutionCheckpoint?(): Promise<unknown>;
  ensureTaskLifecycleContract?(input: {
    taskProfile: "direct_answer" | "model_authoring" | "model_refinement" | "validation_repair" | "analysis";
    objectiveSummary?: string;
    preservationConstraints?: readonly string[];
  }): Promise<unknown>;
  loadTaskLifecycleContract?(): Promise<unknown>;
  appendTaskLifecycleContractEvent?(input: {
    expectedRevision: number;
    eventType: string;
    payload?: Record<string, unknown>;
    actor?: { type: "server" | "main" | "candidate" | "finalizer" | "user" | "operator"; id?: string };
  }): Promise<unknown>;
  listTaskLifecycleContractEvents?(): Promise<unknown>;
  onLifecycleEvent?(event: AgentLifecycleEvent): Promise<void> | void;
}

export type LedgerStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export type RunStopCause =
  | "caller_cancelled"
  | "work_deadline_reached"
  | "hard_deadline_reached";

export interface ValidatorObservation {
  attempt: number;
  admissionOutcome:
    | "admitted"
    | "queue_full"
    | "queue_timeout"
    | "aborted_before_start"
    | "aborted_after_start"
    | "execution_timeout"
    | "backend_unavailable";
  queueWaitMs: number;
  executionMs: number;
  retryableBeforeStart: boolean;
  abortedAfterStart: boolean;
}

export interface ToolLedgerEntry {
  sequence: number;
  toolCallId: string;
  toolName: ToolName;
  canonicalArgs: string;
  argsHash: string;
  status: LedgerStatus;
  replayCount: number;
  /** 只有越过服务端Guard并实际开始调用后端依赖时才为true。 */
  backendExecuted: boolean;
  replayedFromRunId?: string;
  executionContext?: Readonly<{
    participant: "main" | "candidate" | "repair";
    taskId?: string;
    taskRevision?: number;
    roundEpoch?: number;
  }>;
  startedAt: string;
  finishedAt?: string;
  output?: unknown;
  error?: { name: string; message: string };
  validatorObservations?: readonly Readonly<ValidatorObservation>[];
}

export type TrustedValidatorStatus =
  | "validated_passed"
  | "validated_failed"
  | "not_validated";

export interface TrustedEvidence {
  sourceType: "skill" | "knowledge" | "validator";
  sourceId: string;
  authority: string;
  version: string;
  contentHash: string;
}

export interface TrustedPatch {
  fileId: string;
  baseHash: string;
  candidateHash: string;
  kind: "replace_entry" | "apply_edits" | "workspace_files";
  applicable: boolean;
}

export interface TrustedTeacherResponse {
  answer: string;
  answerMode: AgentAnswerMode;
  runtimeUsed: "ai-sdk";
  workflowVersion?: "intent-orchestrator-v2";
  toolSchemaVersion: string;
  validatorStatus: TrustedValidatorStatus;
  validation?: ValidationOutput;
  evidence: TrustedEvidence[];
  patches: TrustedPatch[];
  candidateWorkspaceHash?: string;
  toolTrace: Array<{
    toolCallId: string;
    toolName: ToolName;
    argsHash: string;
    status: LedgerStatus;
    replayCount: number;
  }>;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
  stepCount: number;
  fastGatePassThroughV2?: FastGatePassThroughV2;
  intentV2Trace?: {
    status: "completed" | "rejected" | "failed";
    scopeHintCount: number;
    refusedHintCount: number;
    gateCallCount: number;
    gateOutcome: "pass" | "mixed_scope_risk" | "reject";
    gateDecisionStatus: "completed" | "incomplete";
    gateFallbackReason?: string;
  };
  mainAgentDelegation?: MainAgentDelegation;
  clarificationRequest?: {
    question: string;
    options?: string[];
    acceptedToolCallId: string;
  };
  mainAgentScopeResolution?: {
    status: "not_applicable" | "confirmed_partial" | "dismissed" | "unresolved" | "forwarded_to_main";
    mixedScopeRisk: boolean;
    declinedPartIds: string[];
  };
  engineeringReview?: {
    assessmentStatus: "not_assessed_policy" | "not_assessed_budget" | "review_unavailable" | "completed";
    recommendation: "no_change" | "revise_candidate" | "advice_only";
    verification: "not_run" | "resolved" | "unresolved" | "unavailable";
    executionPlacement: "not_assessed" | "shadow_same_run" | "same_run" | "child_run_pending";
    engineeringCompletionStatus: "not_assessed" | "no_change" | "improved" | "unresolved_advice" | "review_unavailable";
    revisionDelivered: boolean;
    revisionAdopted: boolean;
    engineeringResolution: "resolved" | "unresolved" | "unknown" | "not_assessed";
    openSuggestions: Array<{
      publicSuggestionId: string;
      summary: string;
    }>;
    previousVersion?: {
      available: boolean;
      files: Array<{
        filePath: string;
        content: string;
      }>;
    };
    canContinue: boolean;
    pendingImprovement: boolean;
    scorecard?: {
      userGoalCoverage: number;
      engineeringClosure: number;
      consistencyAndPreservation: number;
      evidenceAndUncertainty: number;
      total: number;
      reviewerRecommendation: "deliver" | "deliver_with_advisory" | "optimize";
    };
    revisionScorecard?: {
      userGoalCoverage: number;
      engineeringClosure: number;
      consistencyAndPreservation: number;
      evidenceAndUncertainty: number;
      total: number;
      reviewerRecommendation: "deliver" | "deliver_with_advisory" | "optimize";
    };
    assessmentCallCount: 0 | 1;
    mainReentryCallCount: 0 | 1;
    revisionCycleCount: 0 | 1;
    verificationCallCount: 0 | 1;
    selectionCallCount: 0 | 1;
  };
  answerCompletionStatus?: "complete" | "incomplete" | "insufficient_evidence" | "unverified" | "not_required" | "waiting_for_clarification";
  reasoningRoute?: {
    configuredMode: "adaptive" | "provider-managed" | "max" | "high" | "medium" | "disabled";
    selectedMode: "provider-managed" | "max" | "high" | "medium" | "disabled";
    reasons: string[];
    escalated: boolean;
  };
  phaseTimings?: Array<{
    phase: "scope_gate" | "main_agent_orchestration" | "candidate_generation" | "candidate_repair" | "validator_execution" | "answer_generation" | "total";
    durationMs: number;
    timeToFirstOutputMs?: number;
    occurrences: number;
  }>;
  modelCalls?: Array<{
    phase: string;
    stepNumber?: number;
    provider: string;
    modelId: string;
    durationMs: number;
    status: "succeeded" | "failed";
    finishReason: string;
    errorCategory?: string;
    requestedOutputTokens?: number;
    remainingMsAtStart?: number;
    visibleOutputTokens?: number;
    usage: {
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      totalTokens: number;
    };
  }>;
  stopReason:
    | "completed"
    | "step_limit"
    | "cancelled"
    | "timeout"
    | "hard_timeout"
    | "repair_step_timeout"
    | "validator_queue_full"
    | "validator_queue_timeout"
    | "validator_execution_timeout"
    | "validator_unavailable"
    | "provider_error"
    | "policy_violation";
  stopCause?: RunStopCause;
  confidenceCap: "high" | "medium" | "low";
  warnings: string[];
}

export type AgentAnswerMode = "result_bound_v2";

export interface AgentRunOutcome {
  ok: boolean;
  response: TrustedTeacherResponse;
  ledger: ToolLedgerEntry[];
  mainAgentOutcome?: MainAgentOutcome;
  /** 同Run已验证候选交付对象；只在进程内传递，不进入公共协议。 */
  validatedCandidateDelivery?: import("./validated-candidate-delivery.mjs").ValidatedCandidateDelivery;
}

export type AgentStageId = "fastGate" | "main" | "candidate" | "repair" | "semanticReview" | "finalizer";
export type AgentStageProtocolMode = "gateway-chat-v1" | "generic-openai" | "deepseek-v4-litellm" | "glm-5.2-litellm";
export interface AgentProtocolReasoningBranch {
  supported: boolean;
  sdkReasoning: "none" | "medium" | "high" | "xhigh";
  providerOptions: Readonly<Record<string, unknown>>;
}
export interface AgentProtocolExecutionPolicy {
  gatewayContract: "gateway-chat.v1";
  reasoning: {
    defaultMode: "enabled" | "disabled";
    enabled: AgentProtocolReasoningBranch;
    disabled: AgentProtocolReasoningBranch;
  };
  toolChoice: {
    nonThinking: "auto" | "omit" | "unsupported";
    thinking: "auto" | "omit" | "unsupported";
  };
  continuation: Readonly<Record<string, unknown>>;
}
export interface AgentStageProtocolProfile {
  protocolMode: AgentStageProtocolMode;
  adapterProfileId?: string;
  adapterProfileRevision?: number;
  modelProtocolProfileId?: string;
  modelProtocolProfileRevision?: number;
  executionPolicy?: AgentProtocolExecutionPolicy;
}

export interface RunTeacherAgentOptions {
  model: LanguageModel;
  modelId?: string;
  fastGateModel?: LanguageModel;
  fastGateModelId?: string;
  mainModel?: LanguageModel;
  mainModelId?: string;
  candidateModel?: LanguageModel;
  candidateModelId?: string;
  repairModel?: LanguageModel;
  repairModelId?: string;
  semanticReviewModel?: LanguageModel;
  semanticReviewModelId?: string;
  finalizerModel?: LanguageModel;
  finalizerModelId?: string;
  nonThinkingModel?: LanguageModel;
  nonThinkingModelId?: string;
  thinkingModel?: LanguageModel;
  thinkingModelId?: string;
  reasoningMode?: "adaptive" | "provider-managed" | "max" | "high" | "medium" | "disabled";
  /** 发布策略冻结的阶段级推理模式；内部非思考调用不得覆盖 Provider 的强制思考能力。 */
  stageReasoningModes?: Partial<Record<AgentStageId, "adaptive" | "provider-managed" | "max" | "high" | "medium" | "disabled">>;
  /** V2一次请求内唯一的服务端共享工作台；不得进入Provider请求或公共响应。 */
  runResources?: RunResources;
  providerOptionsName?: string;
  providerCompatibility?: "generic-openai" | "deepseek-v4-direct" | "deepseek-v4-litellm";
  /** 由API从当前已发布Alias -> Deployment -> Adapter/Profile解析，并冻结到本Run。 */
  stageProtocolProfiles?: Partial<Record<AgentStageId, AgentStageProtocolProfile>>;
  finalizeVisibleAnswer?: (input: {
    response: TrustedTeacherResponse;
    ledger: readonly ToolLedgerEntry[];
    /** 续跑没有新的Main delegation；服务端终态用于保留原候选交付义务。 */
    mainAgentOutcome?: MainAgentOutcome;
    validatedCandidateDelivery?: import("./validated-candidate-delivery.mjs").ValidatedCandidateDelivery;
  }) => Promise<{ answer: string; warnings?: string[] }> | { answer: string; warnings?: string[] };
  request: unknown;
  dependencies: AgentDependencies;
  policy?: unknown;
  abortSignal?: AbortSignal;
}
