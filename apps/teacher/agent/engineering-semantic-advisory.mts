import { createHash } from "node:crypto";

import type { LanguageModel } from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";

import { generateObservedText } from "./observed-generation.mjs";
import { createRunExecutionView, type RunResources } from "./run-resources.mjs";
import { validateCandidateInputSchema, validationOutputSchema } from "./types.mjs";
import type { WorkerResult } from "./worker-contracts.mjs";

export interface TaskGoalRef {
  readonly goalRefId: string;
  readonly sourceId: string;
  readonly quote: string;
  readonly start: number;
  readonly end: number;
  readonly sourceHash: string;
  readonly taskAuthorizationRevisionHash: string;
}

export interface EngineeringReviewIssue {
  readonly issueId: string;
  readonly goalRef: TaskGoalRef;
  readonly issue: string;
  readonly suggestion: string;
}

export interface EngineeringOpenSuggestion {
  readonly publicSuggestionId: string;
  readonly sourceIssueId: string;
  readonly goalRefId: string;
  readonly summary: string;
}

export interface EngineeringAdvisoryPolicy {
  readonly enabled: boolean;
  readonly shadowOnly: boolean;
  readonly assessmentMaxCalls: 1;
  readonly assessmentTimeoutMs: number;
  readonly mainDecisionTimeoutMs: number;
  readonly verificationMaxCalls: 1;
  readonly verificationTimeoutMs: number;
  readonly maxOutputTokens: number;
  readonly maxIssues: number;
  readonly minimumCompleteChainMs: number;
  readonly domainSearchReserveMs: number;
}

export type EngineeringAdvisoryCheckpointPhase =
  | "engineering_assessment_started"
  | "engineering_assessment_completed"
  | "engineering_improvement_pending"
  | "engineering_improvement_admitted"
  | "engineering_improvement_skipped"
  | "engineering_revision_in_progress"
  | "engineering_verification_started"
  | "engineering_verification_completed";

export interface EngineeringAdvisoryResumePlan {
  readonly action: "fresh_assessment" | "continue_main" | "continue_revision" | "continue_verification" | "return_revision" | "return_baseline";
  readonly reason: string;
  readonly assessmentCount: 0 | 1;
  readonly mainReentryCount: 0 | 1;
  readonly revisionCount: 0 | 1;
  readonly verificationCount: 0 | 1;
  readonly issues: readonly EngineeringReviewIssue[];
  readonly verification: "not_run" | "resolved" | "unresolved" | "unavailable";
  readonly revisionDelivered: boolean;
  readonly openSuggestions: readonly EngineeringOpenSuggestion[];
}

export interface EngineeringAdvisoryResult {
  readonly selectedWorkerResult: Extract<WorkerResult, { status: "validated_passed" }>;
  readonly baselineWorkerResult: Extract<WorkerResult, { status: "validated_passed" }>;
  readonly assessmentStatus: "not_assessed_policy" | "not_assessed_budget" | "review_unavailable" | "completed";
  readonly recommendation: "no_change" | "revise_candidate" | "advice_only";
  readonly revisionAttempted: boolean;
  readonly revisionDelivered: boolean;
  /** @deprecated Use revisionDelivered. */
  readonly revisionAdopted: boolean;
  readonly engineeringResolution: "resolved" | "unresolved" | "unknown" | "not_assessed";
  readonly verification: "not_run" | "resolved" | "unresolved" | "unavailable";
  readonly executionPlacement: "not_assessed" | "shadow_same_run" | "same_run" | "child_run_pending";
  readonly engineeringCompletionStatus: "not_assessed" | "no_change" | "improved" | "unresolved_advice" | "review_unavailable";
  readonly assessmentCallCount: 0 | 1;
  readonly mainReentryCallCount: 0 | 1;
  readonly revisionCycleCount: 0 | 1;
  readonly verificationCallCount: 0 | 1;
  readonly pendingImprovement: boolean;
  readonly issues: readonly EngineeringReviewIssue[];
  readonly openSuggestions: readonly EngineeringOpenSuggestion[];
  readonly warnings: readonly string[];
}

export interface EngineeringAdvisoryOptions {
  readonly resources: RunResources;
  readonly baselineWorkerResult: Extract<WorkerResult, { status: "validated_passed" }>;
  readonly priorSuggestions?: readonly Readonly<{ publicSuggestionId: string; summary: string }>[];
  readonly taskSources: readonly {
    sourceId: string;
    relation: "root_user_request" | "clarification_user_answer" | "engineering_feedback";
    text: string;
    sourceHash: string;
    taskAuthorizationRevisionHash: string;
  }[];
  readonly assessmentModel: LanguageModel;
  readonly assessmentModelId: string;
  readonly mainModel: LanguageModel;
  readonly mainModelId: string;
  readonly assessmentProviderOptions?: SharedV4ProviderOptions;
  readonly verificationProviderOptions?: SharedV4ProviderOptions;
  readonly mainProviderOptions?: SharedV4ProviderOptions;
  readonly abortSignal: AbortSignal;
  readonly policy: EngineeringAdvisoryPolicy;
  readonly reviseCandidate: (
    issues: readonly EngineeringReviewIssue[],
  ) => Promise<WorkerResult>;
  readonly onCheckpoint?: (input: {
    phase: EngineeringAdvisoryCheckpointPhase;
    candidate: Extract<WorkerResult, { status: "validated_passed" }>["candidate"];
    validation: Extract<WorkerResult, { status: "validated_passed" }>["validation"];
    metadata: Readonly<Record<string, unknown>>;
  }) => Promise<unknown>;
}

const ASSESSMENT_INSTRUCTIONS = `你是工程语义只读评议者。比较用户授权任务原文与已通过Official Validator的SysML v2 Candidate，识别工程目标遗漏、对象或关系只有名字但未形成合理闭环、任务偏离、正确内容回归、以及外部事实证据不足。
Official Validator PASS只证明其检查范围内的语言合法性，不证明工程完整性。不得修改Candidate，不得声明Validator状态，不得把建议当成阻断门。
先在内部逐项核对授权原文明确要求的工程对象、功能、接口/关系和场景是否在Candidate中以真实模型元素及关系形成闭合；名称、注释、孤立对象或仅存在相关部件不等于目标或场景完成。被强调的场景必须能够追溯到显式的行为、控制、工况或其它适合该目标语义的模型元素，并与受影响对象形成关系，不能只由静态拓扑暗示。不得输出该内部核对过程。
需要完善时，优先把同一授权片段中的相关遗漏合并成一次可以闭合的目标簇；用户用列举、并列、条件或强调语气提出多个要求时，必须逐项检查，任何未满足项和被强调场景都必须进入某个Issue。SUGGESTION必须完整列出该簇仍未满足的对象、关系和场景，不能因为maxIssues上限而静默丢弃同一原文片段里的剩余要求。maxIssues是上限而非配额。
优先立即输出判读结果，不进行长篇防御性思考。没有实质工程问题时只输出NO_CHANGE。需要完善时首行输出REVISE，随后每个问题严格输出三行：GOAL_QUOTE: 用户原文中的连续精确引用；ISSUE: 问题；SUGGESTION: 最小但完整的闭合建议。SUGGESTION只描述需要建立的工程对象、关系、控制或工况闭合；除非用户明确要求，不指定图类型或复杂语言构造，避免把工程建议扩大成高语法风险的全局重建。GOAL_QUOTE必须直接逐字复制TASK_SOURCES中某个text的连续片段，不得改写、概括、增删标点或添加引号；单一遗漏取最短唯一片段，合并目标簇则取能够覆盖该簇全部未满足列举项和强调场景的最短连续片段。不得超过服务端在本轮输入中给出的maxIssues。不得输出JSON、Markdown或分析过程。`;

const MAIN_DECISION_INSTRUCTIONS = `你是Main的单次工程建议判读步骤。输入中的Issue都已经由服务端绑定到用户授权原文。只判断这些Issue是否值得让Candidate Worker做一次工程完善。
需要完善只输出REVISE；不需要改Candidate、只需在最终解释披露，输出ADVICE_ONLY；没有有效改动输出NO_CHANGE。不得输出其他字符，不得生成SysML代码。`;

const VERIFICATION_INSTRUCTIONS = `你是一次性只读工程确认者。比较用户授权目标、Assessment Issue、原PASS基线与新PASS Candidate。
输出前必须在内部对每个goalQuote、Issue和Suggestion逐项提取其明确对象、功能、关系与场景，并在新Candidate中核对对应的真实模型元素和关系；名称、注释、孤立对象或只解决部分子项都不能判为已解决。还要确认原PASS基线中与Issue无关的正确内容没有明显回归。不得输出内部核对过程。
只有每个Issue的全部显式子要求均已解决且无明显工程回归时，才只输出RESOLVED。存在任何未解决、只有名字没有关系、证据不足或无法确定的子项时，首行输出UNRESOLVED，后续用不超过4行指出具体缺口。不得修改Candidate，不得要求再次Review或再次Revision，不得声称Official Validator之外的保证。`;

export async function runEngineeringSemanticAdvisory(
  options: EngineeringAdvisoryOptions,
): Promise<EngineeringAdvisoryResult> {
  const currentWorkerResult = options.baselineWorkerResult;
  const resumePlan = deriveEngineeringAdvisoryResumePlan(options.resources.resumeExecution);
  const baseline = restoredEngineeringBaseline(currentWorkerResult, options.resources.resumeExecution);
  const fallback = (
    assessmentStatus: EngineeringAdvisoryResult["assessmentStatus"],
    warnings: readonly string[],
    overrides: Partial<EngineeringAdvisoryResult> = {},
  ): EngineeringAdvisoryResult => Object.freeze({
    selectedWorkerResult: baseline,
    baselineWorkerResult: baseline,
    assessmentStatus,
    recommendation: "no_change",
    revisionAttempted: false,
    revisionDelivered: false,
    revisionAdopted: false,
    engineeringResolution: "not_assessed",
    verification: "not_run",
    executionPlacement: "not_assessed",
    engineeringCompletionStatus: assessmentStatus === "review_unavailable"
      ? "review_unavailable"
      : "not_assessed",
    assessmentCallCount: 0,
    mainReentryCallCount: 0,
    revisionCycleCount: 0,
    verificationCallCount: 0,
    pendingImprovement: false,
    issues: Object.freeze([]),
    openSuggestions: Object.freeze([]),
    warnings: Object.freeze([...warnings]),
    ...overrides,
  });

  if (!options.policy.enabled) return fallback("not_assessed_policy", []);
  if (resumePlan.action === "return_revision") {
    return Object.freeze({
      ...fallback("completed", []),
      selectedWorkerResult: currentWorkerResult,
      assessmentStatus: "completed",
      recommendation: "revise_candidate",
      revisionAttempted: true,
      revisionDelivered: true,
      revisionAdopted: true,
      engineeringResolution: resumePlan.verification === "resolved"
        ? "resolved"
        : resumePlan.verification === "unresolved" ? "unresolved" : "unknown",
      verification: resumePlan.verification,
      executionPlacement: "same_run",
      engineeringCompletionStatus: "improved",
      assessmentCallCount: resumePlan.assessmentCount,
      mainReentryCallCount: resumePlan.mainReentryCount,
      revisionCycleCount: resumePlan.revisionCount,
      verificationCallCount: resumePlan.verificationCount,
      issues: resumePlan.issues,
      openSuggestions: resumePlan.openSuggestions,
    });
  }
  if (resumePlan.action === "return_baseline") {
    return fallback("review_unavailable", [`engineering_resume_${resumePlan.reason}`], {
      engineeringCompletionStatus: "review_unavailable",
      assessmentCallCount: resumePlan.assessmentCount,
      mainReentryCallCount: resumePlan.mainReentryCount,
      revisionCycleCount: resumePlan.revisionCount,
      verificationCallCount: resumePlan.verificationCount,
      issues: resumePlan.issues,
    });
  }
  if (resumePlan.action === "continue_verification") {
    if (sameCandidate(currentWorkerResult.candidate, baseline.candidate)) {
      return fallback("review_unavailable", ["engineering_resume_revision_result_unavailable"], {
        engineeringCompletionStatus: "review_unavailable",
        assessmentCallCount: resumePlan.assessmentCount,
        mainReentryCallCount: resumePlan.mainReentryCount,
        revisionCycleCount: resumePlan.revisionCount,
        issues: resumePlan.issues,
      });
    }
    return await verifyEngineeringRevision(options, {
      baseline,
      revised: currentWorkerResult,
      issues: resumePlan.issues,
      assessmentCount: resumePlan.assessmentCount,
      mainReentryCount: resumePlan.mainReentryCount,
      revisionCount: resumePlan.revisionCount,
    });
  }
  const requiredInitialWorkMs = options.policy.shadowOnly
    ? options.policy.assessmentTimeoutMs
    : Math.max(
      options.policy.minimumCompleteChainMs,
      options.policy.assessmentTimeoutMs
        + options.policy.mainDecisionTimeoutMs
        + options.policy.domainSearchReserveMs
        + options.resources.candidateMaxAttemptMs
        + options.resources.validatorToolTimeoutMs
        + options.resources.repairPhaseReserveMs
        + options.policy.verificationTimeoutMs,
    );
  if (resumePlan.action === "fresh_assessment" && (
    options.abortSignal.aborted
      || options.resources.budget.view().workRemainingMs < requiredInitialWorkMs
  )) {
    await checkpointFailSoft(options, "engineering_improvement_pending", baseline, {
      continuationKind: "engineering_improvement",
      assessmentCount: 0,
      revisionCycleCount: 0,
      verificationCount: 0,
      reason: "same_run_budget_unavailable",
    });
    return fallback("not_assessed_budget", ["engineering_review_not_assessed_budget"], {
      executionPlacement: "child_run_pending",
      pendingImprovement: true,
    });
  }

  let advice: { status: "no_change" | "revise"; issues: readonly EngineeringReviewIssue[] };
  if (resumePlan.action === "fresh_assessment") {
    await checkpointFailSoft(options, "engineering_assessment_started", baseline, {
      continuationKind: "engineering_improvement",
      assessmentCount: 0,
      revisionCycleCount: 0,
      verificationCount: 0,
    });
    let assessmentText: string;
    try {
      assessmentText = await observedCall(options, {
      phase: "engineering_assessment",
      callId: "engineering-assessment",
      model: options.assessmentModel,
      modelId: options.assessmentModelId,
      instructions: ASSESSMENT_INSTRUCTIONS,
      prompt: JSON.stringify({
        maxIssues: options.policy.maxIssues,
        taskSources: options.taskSources.map((source) => ({
          sourceId: source.sourceId,
          text: source.text.slice(0, 8_000),
        })),
        validatedCandidate: candidateContent(baseline).slice(0, 80_000),
        priorOpenSuggestions: (options.priorSuggestions || []).slice(0, 4).map((item) => ({
          publicSuggestionId: item.publicSuggestionId,
          summary: item.summary.slice(0, 500),
        })),
      }),
      timeoutMs: options.policy.assessmentTimeoutMs,
      maxOutputTokens: options.policy.maxOutputTokens,
      providerOptions: options.assessmentProviderOptions,
      reasoning: "high",
      });
    } catch {
      await checkpointFailSoft(options, "engineering_improvement_skipped", baseline, {
        continuationKind: "engineering_improvement",
        assessmentCount: 1,
        reason: "assessment_unavailable",
      });
      return fallback("review_unavailable", ["engineering_review_unavailable"], {
        assessmentCallCount: 1,
        engineeringCompletionStatus: "review_unavailable",
      });
    }

    advice = bindAssessmentAdvice(assessmentText, options.taskSources, options.policy.maxIssues);
    await checkpointFailSoft(options, "engineering_assessment_completed", baseline, {
      continuationKind: "engineering_improvement",
      assessmentCount: 1,
      revisionCycleCount: 0,
      verificationCount: 0,
      adviceStatus: advice.status,
      issues: checkpointIssues(advice.issues),
    });
  } else {
    advice = Object.freeze({ status: "revise", issues: resumePlan.issues });
  }
  if (advice.status === "no_change") {
    return Object.freeze({
      ...fallback("completed", []),
      assessmentStatus: "completed",
      executionPlacement: options.policy.shadowOnly ? "shadow_same_run" : "same_run",
      engineeringCompletionStatus: "no_change",
      assessmentCallCount: 1,
    });
  }
  if (advice.issues.length === 0) {
    return fallback("review_unavailable", ["engineering_review_unbound_advice"], {
      assessmentCallCount: 1,
      engineeringCompletionStatus: "review_unavailable",
    });
  }
  if (options.policy.shadowOnly) {
    return fallback("completed", ["engineering_review_shadow_only"], {
      assessmentStatus: "completed",
      recommendation: "advice_only",
      executionPlacement: "shadow_same_run",
      engineeringCompletionStatus: "unresolved_advice",
      assessmentCallCount: 1,
      issues: advice.issues,
    });
  }

  let decision: "REVISE" | "ADVICE_ONLY" | "NO_CHANGE";
  if (resumePlan.action === "continue_revision") {
    decision = "REVISE";
  } else try {
    const decisionText = await observedCall(options, {
      phase: "engineering_main_decision",
      callId: "engineering-main-decision",
      model: options.mainModel,
      modelId: options.mainModelId,
      instructions: MAIN_DECISION_INSTRUCTIONS,
      prompt: JSON.stringify({
        issues: advice.issues.map((item) => ({
          goalQuote: item.goalRef.quote,
          issue: item.issue,
          suggestion: item.suggestion,
        })),
        allowedActions: ["REVISE", "ADVICE_ONLY", "NO_CHANGE"],
      }),
      timeoutMs: options.policy.mainDecisionTimeoutMs,
      maxOutputTokens: 64,
      providerOptions: options.mainProviderOptions,
      reasoning: "none",
    });
    decision = parseDecision(decisionText);
  } catch {
    return Object.freeze({
      ...fallback("completed", ["engineering_main_decision_unavailable"]),
      assessmentStatus: "completed",
      recommendation: "advice_only",
      executionPlacement: "same_run",
      engineeringCompletionStatus: "unresolved_advice",
      assessmentCallCount: 1,
      mainReentryCallCount: 1,
      issues: advice.issues,
    });
  }

  if (decision !== "REVISE") {
    return Object.freeze({
      ...fallback("completed", decision === "ADVICE_ONLY" ? ["engineering_advice_only"] : []),
      assessmentStatus: "completed",
      recommendation: decision === "ADVICE_ONLY" ? "advice_only" : "no_change",
      executionPlacement: "same_run",
      engineeringCompletionStatus: decision === "ADVICE_ONLY" ? "unresolved_advice" : "no_change",
      assessmentCallCount: 1,
      mainReentryCallCount: 1,
      issues: advice.issues,
    });
  }

  const requiredRevisionWorkMs = options.policy.domainSearchReserveMs
    + options.resources.candidateMaxAttemptMs
    + options.resources.validatorToolTimeoutMs
    + options.resources.repairPhaseReserveMs
    + options.policy.verificationTimeoutMs;
  if (options.resources.budget.view().workRemainingMs < requiredRevisionWorkMs) {
    const childAlreadyRunning = options.resources.resumeExecution?.decision.continuationKind === "engineering_improvement";
    if (!childAlreadyRunning) {
      await checkpointFailSoft(options, "engineering_improvement_pending", baseline, {
        continuationKind: "engineering_improvement",
        assessmentCount: 1,
        mainReentryCount: 1,
        revisionCycleCount: 0,
        verificationCount: 0,
        reason: "revision_chain_budget_unavailable",
        issues: checkpointIssues(advice.issues),
      });
    }
    return Object.freeze({
      ...fallback("completed", [childAlreadyRunning
        ? "engineering_revision_not_admitted_budget"
        : "engineering_review_not_assessed_budget"]),
      assessmentStatus: "completed",
      recommendation: "advice_only",
      executionPlacement: childAlreadyRunning ? "same_run" : "child_run_pending",
      engineeringCompletionStatus: "unresolved_advice",
      assessmentCallCount: 1,
      mainReentryCallCount: 1,
      pendingImprovement: !childAlreadyRunning,
      issues: advice.issues,
    });
  }

  await checkpointFailSoft(options, "engineering_improvement_admitted", baseline, {
    continuationKind: "engineering_improvement",
    assessmentCount: 1,
    mainReentryCount: 1,
    revisionCycleCount: 0,
    verificationCount: 0,
    mainDecision: "REVISE",
    issues: checkpointIssues(advice.issues),
  });
  await checkpointFailSoft(options, "engineering_revision_in_progress", baseline, {
    continuationKind: "engineering_improvement",
    assessmentCount: 1,
    mainReentryCount: 1,
    revisionCycleCount: 1,
    verificationCount: 0,
    issues: checkpointIssues(advice.issues),
  });
  let revised: WorkerResult;
  try {
    revised = await options.reviseCandidate(advice.issues);
  } catch {
    return Object.freeze({
      ...fallback("completed", ["engineering_revision_failed_baseline_retained"]),
      assessmentStatus: "completed",
      recommendation: "revise_candidate",
      revisionAttempted: true,
      executionPlacement: "same_run",
      engineeringCompletionStatus: "unresolved_advice",
      assessmentCallCount: 1,
      mainReentryCallCount: 1,
      revisionCycleCount: 1,
      issues: advice.issues,
    });
  }
  if (revised.status !== "validated_passed") {
    return Object.freeze({
      ...fallback("completed", ["engineering_revision_not_validated_baseline_retained"]),
      assessmentStatus: "completed",
      recommendation: "revise_candidate",
      revisionAttempted: true,
      executionPlacement: "same_run",
      engineeringCompletionStatus: "unresolved_advice",
      assessmentCallCount: 1,
      mainReentryCallCount: 1,
      revisionCycleCount: 1,
      issues: advice.issues,
    });
  }

  return await verifyEngineeringRevision(options, {
    baseline,
    revised,
    issues: advice.issues,
    assessmentCount: 1,
    mainReentryCount: 1,
    revisionCount: 1,
  });
}

export function deriveEngineeringAdvisoryResumePlan(
  execution: RunResources["resumeExecution"],
): EngineeringAdvisoryResumePlan {
  const empty = (action: EngineeringAdvisoryResumePlan["action"], reason: string) => Object.freeze({
    action,
    reason,
    assessmentCount: 0 as const,
    mainReentryCount: 0 as const,
    revisionCount: 0 as const,
    verificationCount: 0 as const,
    issues: Object.freeze([]) as readonly EngineeringReviewIssue[],
    verification: "not_run" as const,
    revisionDelivered: false,
    openSuggestions: Object.freeze([]) as readonly EngineeringOpenSuggestion[],
  });
  if (!execution || execution.decision.continuationKind !== "engineering_improvement") {
    return empty("fresh_assessment", "no_engineering_checkpoint");
  }
  const engineering = execution.engineering;
  if (!engineering) return empty("return_baseline", "projection_unavailable");
  const assessmentCount = boundedBinary(engineering.assessmentCount);
  const mainReentryCount = boundedBinary(engineering.mainReentryCount);
  const revisionCount = boundedBinary(engineering.revisionCount);
  const verificationCount = boundedBinary(engineering.verificationCount);
  const issues = parseCheckpointIssues(engineering.issueSummaries);
  const plan = (
    action: EngineeringAdvisoryResumePlan["action"],
    reason: string,
  ): EngineeringAdvisoryResumePlan => Object.freeze({
    action,
    reason,
    assessmentCount,
    mainReentryCount,
    revisionCount,
    verificationCount,
    issues,
    verification: engineering?.verification ?? "not_run",
    revisionDelivered: engineering?.revisionDelivered === true || engineering?.revisionAdopted === true,
    openSuggestions: parseCheckpointSuggestions(engineering?.openSuggestions),
  });
  const phase = engineering.status || execution.decision.phase;
  if (phase === "engineering_assessment_started") {
    return plan("return_baseline", "assessment_result_unknown");
  }
  if (phase === "engineering_assessment_completed") {
    return issues.length > 0
      ? plan("continue_main", "assessment_recovered")
      : plan("return_baseline", "assessment_issues_unavailable");
  }
  if (phase === "engineering_improvement_pending") {
    if (assessmentCount === 0) return plan("fresh_assessment", "pending_before_assessment");
    if (issues.length === 0) return plan("return_baseline", "pending_issues_unavailable");
    if (mainReentryCount === 0) return plan("continue_main", "pending_before_main");
    if (revisionCount === 0) return plan("continue_revision", "pending_before_revision");
    return plan("continue_verification", "pending_after_revision");
  }
  if (phase === "engineering_improvement_admitted") {
    return issues.length > 0
      ? plan("continue_revision", "revision_admitted")
      : plan("return_baseline", "revision_issues_unavailable");
  }
  if (phase === "engineering_revision_in_progress") {
    return issues.length > 0
      ? plan("continue_verification", "revision_validated")
      : plan("return_baseline", "verification_issues_unavailable");
  }
  if (phase === "engineering_verification_started") {
    return plan("return_revision", "verification_result_unknown");
  }
  if (phase === "engineering_verification_completed") {
    return engineering.revisionDelivered === true || engineering.revisionAdopted === true
      ? plan("return_revision", "verified_revision_recovered")
      : plan("return_baseline", "engineering_chain_terminal");
  }
  if (phase === "engineering_improvement_skipped") {
    return plan("return_baseline", "engineering_chain_terminal");
  }
  return plan("return_baseline", "unsupported_checkpoint_phase");
}

function restoredEngineeringBaseline(
  current: Extract<WorkerResult, { status: "validated_passed" }>,
  execution: RunResources["resumeExecution"],
): Extract<WorkerResult, { status: "validated_passed" }> {
  const candidate = validateCandidateInputSchema.safeParse(execution?.engineering?.baselineCandidate);
  const validation = validationOutputSchema.safeParse(execution?.engineering?.baselineValidation);
  if (!candidate.success || !validation.success || !isCompleteValidationPass(validation.data)) return current;
  return Object.freeze({ ...current, candidate: candidate.data, validation: validation.data });
}

function isCompleteValidationPass(validation: ReturnType<typeof validationOutputSchema.parse>): boolean {
  return validation.completeness === "complete"
    && Boolean(validation.candidateWorkspaceHash)
    && validation.official.syntax === "passed"
    && validation.official.semantic === "passed"
    && (validation.courseRuleApplicability !== "applicable"
      || validation.courseRules?.status === "passed");
}

function sameCandidate(
  left: Extract<WorkerResult, { status: "validated_passed" }>["candidate"],
  right: Extract<WorkerResult, { status: "validated_passed" }>["candidate"],
): boolean {
  return contentHash(JSON.stringify(left)) === contentHash(JSON.stringify(right));
}

function boundedBinary(value: unknown): 0 | 1 {
  return Number(value) >= 1 ? 1 : 0;
}

function parseCheckpointIssues(values: readonly unknown[]): readonly EngineeringReviewIssue[] {
  const parsed: EngineeringReviewIssue[] = [];
  for (const value of values.slice(0, 8)) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    const goal = item.goalRef;
    if (!goal || typeof goal !== "object") continue;
    const goalRef = goal as Record<string, unknown>;
    if (typeof item.issueId !== "string"
      || typeof item.issue !== "string"
      || typeof item.suggestion !== "string"
      || typeof goalRef.goalRefId !== "string"
      || typeof goalRef.sourceId !== "string"
      || typeof goalRef.quote !== "string"
      || typeof goalRef.start !== "number"
      || typeof goalRef.end !== "number"
      || typeof goalRef.sourceHash !== "string"
      || typeof goalRef.taskAuthorizationRevisionHash !== "string") continue;
    parsed.push(Object.freeze({
      issueId: item.issueId,
      goalRef: Object.freeze({
        goalRefId: goalRef.goalRefId,
        sourceId: goalRef.sourceId,
        quote: goalRef.quote,
        start: goalRef.start,
        end: goalRef.end,
        sourceHash: goalRef.sourceHash,
        taskAuthorizationRevisionHash: goalRef.taskAuthorizationRevisionHash,
      }),
      issue: item.issue.slice(0, 500),
      suggestion: item.suggestion.slice(0, 500),
    }));
  }
  return Object.freeze(parsed);
}

async function verifyEngineeringRevision(
  options: EngineeringAdvisoryOptions,
  input: {
    baseline: Extract<WorkerResult, { status: "validated_passed" }>;
    revised: Extract<WorkerResult, { status: "validated_passed" }>;
    issues: readonly EngineeringReviewIssue[];
    assessmentCount: 0 | 1;
    mainReentryCount: 0 | 1;
    revisionCount: 0 | 1;
  },
): Promise<EngineeringAdvisoryResult> {
  let verification: EngineeringAdvisoryResult["verification"] = "unavailable";
  let openSuggestions: readonly EngineeringOpenSuggestion[] = Object.freeze([]);
  const warnings: string[] = [];
  await checkpointFailSoft(options, "engineering_verification_started", input.revised, {
    continuationKind: "engineering_improvement",
    assessmentCount: input.assessmentCount,
    mainReentryCount: input.mainReentryCount,
    revisionCycleCount: input.revisionCount,
    verificationCount: 0,
    issues: checkpointIssues(input.issues),
  });
  try {
    const verificationText = await observedCall(options, {
      phase: "engineering_verification",
      callId: "engineering-verification",
      model: options.assessmentModel,
      modelId: options.assessmentModelId,
      instructions: VERIFICATION_INSTRUCTIONS,
      prompt: JSON.stringify({
        taskSources: options.taskSources,
        issues: input.issues.map((item) => ({
          goalQuote: item.goalRef.quote,
          issue: item.issue,
          suggestion: item.suggestion,
        })),
        baselineCandidate: candidateContent(input.baseline).slice(0, 60_000),
        revisedCandidate: candidateContent(input.revised).slice(0, 60_000),
      }),
      timeoutMs: options.policy.verificationTimeoutMs,
      maxOutputTokens: options.policy.maxOutputTokens,
      providerOptions: options.verificationProviderOptions,
      reasoning: "none",
    });
    const parsedReview = parseVerificationDecision(verificationText, input.issues, input.revised);
    verification = parsedReview.verification;
    openSuggestions = parsedReview.openSuggestions;
    if (verification === "unresolved") warnings.push("engineering_advice_unresolved");
  } catch {
    warnings.push("engineering_verification_unavailable");
  }
  await checkpointFailSoft(options, "engineering_verification_completed", input.revised, {
    continuationKind: "engineering_improvement",
    assessmentCount: input.assessmentCount,
    mainReentryCount: input.mainReentryCount,
    revisionCycleCount: input.revisionCount,
    verificationCount: 1,
    verification,
    revisionDelivered: true,
    revisionAdopted: true,
    openSuggestions,
    issues: checkpointIssues(input.issues),
  });
  return Object.freeze({
    selectedWorkerResult: input.revised,
    baselineWorkerResult: input.baseline,
    assessmentStatus: "completed",
    recommendation: "revise_candidate",
    revisionAttempted: true,
    revisionDelivered: true,
    revisionAdopted: true,
    engineeringResolution: verification === "resolved"
      ? "resolved"
      : verification === "unresolved" ? "unresolved" : "unknown",
    verification,
    executionPlacement: "same_run",
    engineeringCompletionStatus: verification === "resolved" ? "improved" : "unresolved_advice",
    assessmentCallCount: input.assessmentCount,
    mainReentryCallCount: input.mainReentryCount,
    revisionCycleCount: input.revisionCount,
    verificationCallCount: 1,
    pendingImprovement: false,
    issues: input.issues,
    openSuggestions,
    warnings: Object.freeze(warnings),
  });
}

function parseVerificationDecision(
  text: string,
  issues: readonly EngineeringReviewIssue[],
  revised: Extract<WorkerResult, { status: "validated_passed" }>,
): Readonly<{
  verification: "resolved" | "unresolved" | "unavailable";
  openSuggestions: readonly EngineeringOpenSuggestion[];
}> {
  const lines = String(text || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines[0] === "RESOLVED") {
    return Object.freeze({ verification: "resolved", openSuggestions: Object.freeze([]) });
  }
  if (lines[0] !== "UNRESOLVED") {
    return Object.freeze({ verification: "unavailable", openSuggestions: Object.freeze([]) });
  }
  const candidateHash = contentHash(candidateContent(revised));
  const suggestions = lines.slice(1, 5).flatMap((line, index) => {
    const summary = line.replace(/^[-*•\d.)\s]+/u, "").trim().slice(0, 500);
    const issue = issues[index] ?? issues[0];
    if (!summary || !issue) return [];
    return [Object.freeze({
      publicSuggestionId: stableId("suggestion", `${candidateHash}\n${issue.issueId}\n${summary}`),
      sourceIssueId: issue.issueId,
      goalRefId: issue.goalRef.goalRefId,
      summary,
    })];
  });
  return Object.freeze({
    verification: "unresolved",
    openSuggestions: Object.freeze(suggestions),
  });
}

export function bindAssessmentAdvice(
  text: string,
  taskSources: EngineeringAdvisoryOptions["taskSources"],
  maxIssues = 8,
): { status: "no_change" | "revise"; issues: readonly EngineeringReviewIssue[] } {
  const lines = String(text || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1 && lines[0] === "NO_CHANGE") {
    return Object.freeze({ status: "no_change", issues: Object.freeze([]) });
  }
  if (lines[0] !== "REVISE") return Object.freeze({ status: "revise", issues: Object.freeze([]) });
  const issues: EngineeringReviewIssue[] = [];
  for (let index = 1; index + 2 < lines.length && issues.length < Math.max(1, Math.min(8, maxIssues)); index += 3) {
    const quote = prefixedValue(lines[index], "GOAL_QUOTE:");
    const issue = prefixedValue(lines[index + 1], "ISSUE:");
    const suggestion = prefixedValue(lines[index + 2], "SUGGESTION:");
    if (!quote || !issue || !suggestion) continue;
    const goalRef = bindUniqueGoalQuote(quote, taskSources);
    if (!goalRef) continue;
    issues.push(Object.freeze({
      issueId: stableId("eri", `${goalRef.goalRefId}\n${issue}\n${suggestion}`),
      goalRef,
      issue: issue.slice(0, 500),
      suggestion: suggestion.slice(0, 500),
    }));
  }
  return Object.freeze({ status: "revise", issues: Object.freeze(issues) });
}

export function bindUniqueGoalQuote(
  quote: string,
  taskSources: EngineeringAdvisoryOptions["taskSources"],
): TaskGoalRef | undefined {
  const normalizedQuote = quote.normalize("NFKC").trim();
  if (!normalizedQuote) return undefined;
  const matches = taskSources.flatMap((source) => normalizedOccurrences(source.text, normalizedQuote)
    .map(({ start, end }) => ({ source, start, end })));
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  const exactQuote = match.source.text.slice(match.start, match.end);
  const sourceHash = contentHash(match.source.text);
  return Object.freeze({
    goalRefId: stableId("goal", `${match.source.sourceId}\n${sourceHash}\n${match.start}\n${match.end}`),
    sourceId: match.source.sourceId,
    quote: exactQuote,
    start: match.start,
    end: match.end,
    sourceHash,
    taskAuthorizationRevisionHash: match.source.taskAuthorizationRevisionHash,
  });
}

function normalizedOccurrences(source: string, normalizedQuote: string): Array<{ start: number; end: number }> {
  const normalizedParts: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let originalOffset = 0;
  for (const character of source) {
    const normalized = character.normalize("NFKC");
    for (const normalizedCharacter of normalized) {
      normalizedParts.push(normalizedCharacter);
      starts.push(originalOffset);
      ends.push(originalOffset + character.length);
    }
    originalOffset += character.length;
  }
  const normalizedSource = normalizedParts.join("");
  const occurrences: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (from <= normalizedSource.length) {
    const index = normalizedSource.indexOf(normalizedQuote, from);
    if (index < 0) break;
    const last = index + normalizedQuote.length - 1;
    const start = starts[index];
    const end = ends[last];
    if (start !== undefined && end !== undefined) occurrences.push({ start, end });
    from = index + 1;
  }
  return occurrences;
}

async function observedCall(
  options: EngineeringAdvisoryOptions,
  input: {
    phase: string;
    callId: string;
    model: LanguageModel;
    modelId: string;
    instructions: string;
    prompt: string;
    timeoutMs: number;
    maxOutputTokens: number;
    providerOptions?: SharedV4ProviderOptions;
    reasoning: "none" | "high";
  },
): Promise<string> {
  const generated = await generateObservedText({
    model: input.model,
    phase: input.phase,
    instructions: input.instructions,
    prompt: input.prompt,
    maxRetries: 0,
    maxOutputTokens: input.maxOutputTokens,
    temperature: 0,
    reasoning: input.reasoning,
    providerOptions: input.providerOptions,
    abortSignal: options.abortSignal,
    timeout: {
      totalMs: Math.max(1, Math.min(input.timeoutMs, options.resources.budget.view().workRemainingMs)),
    },
    runtimeContext: createRunExecutionView(options.resources, "main"),
  });
  options.resources.budget.settleModelCall({
    callId: `${options.resources.runId}:${input.callId}:${input.modelId}`,
    usage: generated.usage,
  });
  return generated.text.trim();
}

function parseDecision(text: string): "REVISE" | "ADVICE_ONLY" | "NO_CHANGE" {
  const value = text.trim();
  if (value === "REVISE" || value === "ADVICE_ONLY" || value === "NO_CHANGE") return value;
  throw new Error("engineering_main_decision_invalid");
}

function candidateContent(result: Extract<WorkerResult, { status: "validated_passed" }>): string {
  const candidate = result.candidate;
  if (candidate.mode === "standalone_model" || candidate.mode === "replace_entry") return candidate.content;
  if (candidate.mode === "workspace_files") {
    return candidate.files.map((file) => `// ${file.fileId}\n${file.content}`).join("\n\n");
  }
  return candidate.edits.map((edit) => edit.replacement).join("\n\n");
}

function prefixedValue(value: string | undefined, prefix: string): string {
  if (!value?.startsWith(prefix)) return "";
  return value.slice(prefix.length).trim().slice(0, 2_000);
}

function contentHash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24)}`;
}

function checkpointIssues(issues: readonly EngineeringReviewIssue[]): readonly Record<string, unknown>[] {
  return Object.freeze(issues.slice(0, 8).map((item) => Object.freeze({
    issueId: item.issueId,
    goalRef: Object.freeze({ ...item.goalRef }),
    issue: item.issue.slice(0, 500),
    suggestion: item.suggestion.slice(0, 500),
  })));
}

function parseCheckpointSuggestions(values: readonly unknown[] | undefined): readonly EngineeringOpenSuggestion[] {
  if (!Array.isArray(values)) return Object.freeze([]);
  return Object.freeze(values.slice(0, 4).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const publicSuggestionId = String(item.publicSuggestionId || "").slice(0, 200);
    const sourceIssueId = String(item.sourceIssueId || "").slice(0, 200);
    const goalRefId = String(item.goalRefId || "").slice(0, 200);
    const summary = String(item.summary || "").trim().slice(0, 500);
    return publicSuggestionId && sourceIssueId && goalRefId && summary
      ? [Object.freeze({ publicSuggestionId, sourceIssueId, goalRefId, summary })]
      : [];
  }));
}

async function checkpointFailSoft(
  options: EngineeringAdvisoryOptions,
  phase: EngineeringAdvisoryCheckpointPhase,
  result: Extract<WorkerResult, { status: "validated_passed" }>,
  metadata: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (!options.onCheckpoint) return;
  try {
    await options.onCheckpoint({
      phase,
      candidate: result.candidate,
      validation: result.validation,
      metadata: Object.freeze({
        engineering: Object.freeze({
          ...metadata,
          taskSources: Object.freeze(options.taskSources.slice(0, 2).map((source) => Object.freeze({
            ...source,
            text: source.text.slice(0, 12_000),
          }))),
        }),
      }),
    });
  } catch {
    options.resources.recordOperationalWarning("engineering_checkpoint_persistence_failed");
  }
}
