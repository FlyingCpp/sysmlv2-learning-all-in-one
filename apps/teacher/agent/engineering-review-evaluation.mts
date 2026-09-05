import type { LanguageModel } from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";

import {
  runEngineeringSemanticAdvisory,
  type EngineeringAdvisoryResult,
  type EngineeringReviewIssue,
} from "./engineering-semantic-advisory.mjs";
import {
  createProductionWorkerHandlers,
  runResumedProductionExecution,
} from "./production-worker-handlers.mjs";
import { createRunResources } from "./run-resources.mjs";
import { createCurrentValidatedCandidateBinding } from "./task-working-state.mjs";
import {
  agentPolicySchema,
  agentRunRequestSchema,
  type AgentDependencies,
  type AgentPolicy,
  type AgentRunRequest,
  type CandidateArtifact,
} from "./types.mjs";
import {
  dispatchResumedWorker,
  dispatchWorker,
} from "./worker-dispatcher.mjs";
import type { WorkerResult } from "./worker-contracts.mjs";

export interface EngineeringReviewEvaluationOptions {
  readonly request: AgentRunRequest;
  readonly policy: AgentPolicy;
  readonly baselineCandidate: CandidateArtifact;
  readonly assessmentModel: LanguageModel;
  readonly assessmentModelId: string;
  readonly mainModel: LanguageModel;
  readonly mainModelId: string;
  readonly candidateModel: LanguageModel;
  readonly candidateModelId: string;
  readonly repairModel: LanguageModel;
  readonly repairModelId: string;
  readonly assessmentProviderOptions?: SharedV4ProviderOptions;
  readonly verificationProviderOptions?: SharedV4ProviderOptions;
  readonly mainProviderOptions?: SharedV4ProviderOptions;
  readonly candidateProviderOptions?: SharedV4ProviderOptions;
  readonly repairProviderOptions?: SharedV4ProviderOptions;
  readonly candidateReasoning?: "none" | "medium" | "high" | "xhigh";
  readonly repairReasoning?: "none" | "medium" | "high" | "xhigh";
  readonly repairExplicitToolChoice?: boolean;
  readonly dependencies: AgentDependencies;
  readonly abortSignal?: AbortSignal;
}

export interface EngineeringReviewEvaluationResult {
  readonly evaluationMode: "engineering-review-core-vertical";
  readonly runId: string;
  readonly maxDurationMs: number;
  readonly baselineWorkerResult: Extract<WorkerResult, { status: "validated_passed" }>;
  readonly selectedWorkerResult: Extract<WorkerResult, { status: "validated_passed" }>;
  readonly advisory: EngineeringAdvisoryResult;
  readonly revisionWorkerResult?: WorkerResult;
  readonly ledger: ReturnType<ReturnType<typeof createRunResources>["ledger"]["snapshot"]>;
  readonly budget: ReturnType<ReturnType<typeof createRunResources>["budget"]["view"]>;
}

/**
 * 评测控制面的Agent核心纵向入口：隔离Primary Candidate，但不替换任何生产Worker、Tool或门禁。
 * 不覆盖HTTP、Conversation Store或自动续跑的端到端行为。
 */
export async function runEngineeringReviewEvaluation(
  rawOptions: EngineeringReviewEvaluationOptions,
): Promise<EngineeringReviewEvaluationResult> {
  const request = agentRunRequestSchema.parse(rawOptions.request);
  const basePolicy = agentPolicySchema.parse(rawOptions.policy);
  const policy = agentPolicySchema.parse({
    ...basePolicy,
    maxDurationMs: basePolicy.engineeringImprovementRunMaxDurationMs,
  });
  if (!policy.semanticReviewEnabled || policy.semanticReviewShadowOnly) {
    throw new Error("Engineering Review evaluation requires enabled, non-shadow semantic review.");
  }
  const startedAtMs = Date.now();
  const resources = createRunResources({
    request,
    policy,
    startedAtMs,
    deadlineAtMs: startedAtMs + policy.maxDurationMs,
  });
  const deadlineSignal = AbortSignal.timeout(policy.maxDurationMs);
  const abortSignal = rawOptions.abortSignal
    ? AbortSignal.any([rawOptions.abortSignal, deadlineSignal])
    : deadlineSignal;
  const baselineOutcome = {
    type: "delegate_candidate" as const,
    mode: rawOptions.baselineCandidate.mode === "standalone_model" ? "create" as const : "refine" as const,
    subject: rawOptions.baselineCandidate.mode === "standalone_model"
      ? "standalone_model" as const
      : "current_workspace" as const,
    taskSummary: "评估用户目标与候选基线。",
    instruction: "形成与输入验证绑定的完整候选。",
    acceptedToolCallId: `${request.runId}:engineering-evaluation-baseline`,
  };
  const baselineTask = resources.tasks.materialize({
    questionHash: resources.input.questionHash,
    outcome: baselineOutcome,
    context: request.context,
  });
  const productionOptions = {
    resources,
    request,
    policy,
    model: rawOptions.candidateModel,
    repairModel: rawOptions.repairModel,
    dependencies: rawOptions.dependencies,
    candidateProviderOptions: rawOptions.candidateProviderOptions,
    candidateReasoning: rawOptions.candidateReasoning,
    repairProviderOptions: rawOptions.repairProviderOptions,
    repairReasoning: rawOptions.repairReasoning,
    repairExplicitToolChoice: rawOptions.repairExplicitToolChoice,
  };
  const baselineDispatch = await dispatchResumedWorker({
    resources,
    taskId: baselineTask.taskId,
    expectedRevision: baselineTask.revision,
    abortSignal,
    execute: async (task) => await runResumedProductionExecution({
      options: { ...productionOptions, policy: { ...policy, candidateRepairEnabled: false } },
      task,
      action: "validator",
      candidate: rawOptions.baselineCandidate,
      abortSignal,
    }),
  });
  if (baselineDispatch.type !== "completed" || baselineDispatch.result.status !== "validated_passed") {
    const resultStatus = baselineDispatch.type === "completed"
      ? baselineDispatch.result.status
      : baselineDispatch.type;
    const resultReason = baselineDispatch.type === "completed" && "reason" in baselineDispatch.result
      ? `:${baselineDispatch.result.reason}`
      : "";
    throw new Error(`Frozen evaluation baseline did not pass Official Validator: ${resultStatus}${resultReason}`);
  }
  const baselineWorkerResult = baselineDispatch.result;
  let revisionWorkerResult: WorkerResult | undefined;
  const advisory = await runEngineeringSemanticAdvisory({
    resources,
    baselineWorkerResult,
    taskSources: request.taskSources,
    assessmentModel: rawOptions.assessmentModel,
    assessmentModelId: rawOptions.assessmentModelId,
    mainModel: rawOptions.mainModel,
    mainModelId: rawOptions.mainModelId,
    assessmentProviderOptions: rawOptions.assessmentProviderOptions,
    verificationProviderOptions: rawOptions.verificationProviderOptions,
    mainProviderOptions: rawOptions.mainProviderOptions,
    abortSignal,
    policy: {
      enabled: true,
      shadowOnly: false,
      assessmentMaxCalls: 1, // 离线旧链评测固定一次；生产0/1策略由只读路径处理。
      assessmentTimeoutMs: policy.semanticReviewAssessmentTimeoutMs,
      mainDecisionTimeoutMs: policy.semanticReviewMainDecisionTimeoutMs,
      verificationMaxCalls: policy.semanticReviewVerificationMaxCalls,
      verificationTimeoutMs: policy.semanticReviewVerificationTimeoutMs,
      maxIssues: policy.semanticReviewMaxIssues,
      minimumCompleteChainMs: policy.semanticReviewMinimumCompleteChainMs,
      domainSearchReserveMs: policy.semanticReviewDomainSearchReserveMs,
    },
    reviseCandidate: async (issues: readonly EngineeringReviewIssue[]) => {
      const revisionOutcome = {
        type: "delegate_candidate" as const,
        mode: baselineWorkerResult.candidate.mode === "standalone_model" ? "milestone" as const : "refine" as const,
        subject: "current_validated_candidate" as const,
        taskSummary: request.taskSources.map((source) => source.text).join("\n"),
        instruction: issues.map((issue) => `${issue.issue}：${issue.suggestion}`).join("\n"),
        acceptedToolCallId: `${baselineTask.acceptedToolCallId}:engineering-revision`,
      };
      const revisionTask = resources.tasks.materialize({
        questionHash: resources.input.questionHash,
        outcome: revisionOutcome,
        context: request.context,
        currentValidatedCandidateBinding: createCurrentValidatedCandidateBinding({
          runId: resources.runId,
          candidate: baselineWorkerResult.candidate,
          validation: baselineWorkerResult.validation,
          baselineModel: request.context.model,
        }),
      });
      const dispatch = await dispatchWorker({
        resources,
        taskId: revisionTask.taskId,
        expectedRevision: revisionTask.revision,
        abortSignal,
        workers: createProductionWorkerHandlers({
          ...productionOptions,
          engineeringRevision: {
            baselineCandidateContent: candidateText(baselineWorkerResult.candidate),
            issues: issues.map((item) => ({
              issueId: item.issueId,
              goalRefId: item.goalRef.goalRefId,
              sourceId: item.goalRef.sourceId,
              goalQuote: item.goalRef.quote,
              sourceHash: item.goalRef.sourceHash,
              taskAuthorizationRevisionHash: item.goalRef.taskAuthorizationRevisionHash,
              start: item.goalRef.start,
              end: item.goalRef.end,
              issue: item.issue,
              suggestion: item.suggestion,
            })),
          },
        }),
      });
      revisionWorkerResult = dispatch.type === "completed" ? dispatch.result : undefined;
      if (dispatch.type !== "completed") {
        throw new Error(`Engineering Revision dispatch failed: ${dispatch.reason}`);
      }
      return dispatch.result;
    },
    onCheckpoint: async (boundary) => await rawOptions.dependencies.persistExecutionCheckpoint?.(boundary),
  });
  return Object.freeze({
    evaluationMode: "engineering-review-core-vertical",
    runId: request.runId,
    maxDurationMs: policy.maxDurationMs,
    baselineWorkerResult,
    selectedWorkerResult: advisory.selectedWorkerResult,
    advisory,
    ...(revisionWorkerResult ? { revisionWorkerResult } : {}),
    ledger: resources.ledger.snapshot(),
    budget: resources.budget.view(),
  });
}

function candidateText(candidate: CandidateArtifact): string {
  if (candidate.mode === "standalone_model" || candidate.mode === "replace_entry") return candidate.content;
  if (candidate.mode === "workspace_files") {
    return candidate.files.map((file) => `// ${file.fileId}\n${file.content}`).join("\n\n");
  }
  return candidate.edits.map((edit) => edit.replacement).join("\n\n");
}
