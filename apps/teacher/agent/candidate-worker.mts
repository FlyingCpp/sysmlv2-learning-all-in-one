import { stepCountIs, type Instructions, type LanguageModel, type ToolSet } from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";

import { generateObservedText, generateObservedToolLoopText } from "./observed-generation.mjs";
import {
  projectConversationModelMessages,
  systemInstructions,
} from "./model-message-projection.mjs";
import {
  createRunExecutionView,
  createRunToolsContext,
  projectWorkerEvidenceView,
  type RunResources,
} from "./run-resources.mjs";
import type {
  CandidateTaskView,
  CandidateValidationOutcome,
  CandidateWorkerResult,
} from "./worker-contracts.mjs";
import {
  createValidatedPassedResult,
  createWorkerFailureResult,
} from "./worker-result.mjs";

export type CandidateContentFailure = "empty" | "truncated" | "ambiguous";

export type CandidateContentExtraction =
  | { success: true; content: string }
  | { success: false; reason: CandidateContentFailure };

export interface CandidateWorkerOptions {
  readonly resources: RunResources;
  readonly task: CandidateTaskView;
  readonly model: LanguageModel;
  readonly abortSignal: AbortSignal;
  readonly instructions: string;
  readonly prompt?: string;
  /** undefined表示不设置应用层输出Token上限，仍受Run时间、上下文窗口和Provider边界约束。 */
  readonly maxOutputTokens?: number;
  readonly timeoutMs: number;
  readonly toolTimeoutMs?: number;
  readonly temperature?: number;
  readonly reasoning?: "none" | "medium" | "high" | "xhigh";
  readonly providerOptions?: SharedV4ProviderOptions;
  /** 直接复用服务端注册的AI SDK Tool；不在Candidate内复制Schema或执行器。 */
  readonly tools?: ToolSet;
  readonly maxSteps?: number;
  readonly allowContentRecovery?: boolean;
  readonly validateCandidate: (input: {
    content: string;
    attempt: number;
    task: CandidateTaskView;
    abortSignal: AbortSignal;
  }) => Promise<CandidateValidationOutcome>;
  /** Validator失败后的多轮查询—修订由既有ToolLoopAgent适配器实现。 */
  readonly recoverValidationFailure?: (input: {
    content: string;
    validation: CandidateValidationOutcome;
    task: CandidateTaskView;
    abortSignal: AbortSignal;
  }) => Promise<CandidateValidationOutcome | undefined>;
}

/**
 * Candidate首次生成使用AI SDK原生Tool Loop；服务端回调负责Artifact、hash和Validator。
 * 这里没有自定义循环：SDK传递Tool Result并执行stopWhen，业务层只提供工具、预算和生命周期投影。
 */
export async function runCandidateWorker(
  options: CandidateWorkerOptions,
): Promise<CandidateWorkerResult> {
  assertCandidateTaskBinding(options.resources, options.task);
  if (options.abortSignal.aborted) return terminalResult(options.task, "cancelled", "caller_cancelled", 0);
  if (options.resources.budget.view().workRemainingMs <= 0) {
    return terminalResult(options.task, "exhausted", "run_deadline_exceeded", 0);
  }

  let attempts = 0;
  let content: string | undefined;
  let extractionFailure: CandidateContentFailure | undefined;

  try {
    const first = await generateCandidate(options, 1, false);
    attempts = 1;
    const extracted = extractCandidateContent(first);
    if (extracted.success) {
      content = extracted.content;
    } else {
      extractionFailure = extracted.reason;
    }

    if (!content && options.allowContentRecovery !== false && !options.abortSignal.aborted) {
      const recovered = await generateCandidate(options, 2, true, extractionFailure);
      attempts = 2;
      const extracted = extractCandidateContent(recovered);
      if (extracted.success) {
        content = extracted.content;
        extractionFailure = undefined;
      } else {
        extractionFailure = extracted.reason;
      }
    }
  } catch (error) {
    if (options.abortSignal.aborted) {
      return terminalResult(options.task, "cancelled", "caller_cancelled", attempts);
    }
    const reason = error instanceof Error ? error.message : "candidate_generation_failed";
    return terminalResult(
      options.task,
      reason.includes("Run budget exceeded") ? "exhausted" : "worker_error",
      boundedReason(reason),
      attempts,
    );
  }

  if (!content) {
    return terminalResult(
      options.task,
      extractionFailure === "truncated" ? "exhausted" : "worker_error",
      `candidate_content_${extractionFailure ?? "empty"}`,
      attempts,
    );
  }

  let validation: CandidateValidationOutcome;
  try {
    validation = await options.validateCandidate({
      content,
      attempt: attempts,
      task: options.task,
      abortSignal: options.abortSignal,
    });
  } catch (error) {
    return terminalResult(
      options.task,
      options.abortSignal.aborted ? "cancelled" : "worker_error",
      options.abortSignal.aborted ? "caller_cancelled" : boundedReason(error),
      attempts,
    );
  }

  if (validation.passed) return resultFromValidation(options.task, validation, attempts);

  if (validation.retryable && options.recoverValidationFailure && !options.abortSignal.aborted) {
    try {
      const recovered = await options.recoverValidationFailure({
        content,
        validation,
        task: options.task,
        abortSignal: options.abortSignal,
      });
      attempts += 1;
      if (recovered) return resultFromValidation(options.task, recovered, attempts);
    } catch (error) {
      return terminalResult(
        options.task,
        options.abortSignal.aborted
          ? "cancelled"
          : error instanceof Error && isResourceExhaustionReason(error.message)
            ? "exhausted"
            : "worker_error",
        options.abortSignal.aborted ? "caller_cancelled" : boundedReason(error),
        attempts,
      );
    }
  }

  return resultFromValidation(options.task, validation, attempts);
}

export function extractCandidateContent(result: {
  text: string;
  finishReason?: string;
}): CandidateContentExtraction {
  const rawText = String(result.text || "");
  const text = rawText.trim();
  if (String(result.finishReason || "").toLowerCase() === "length") {
    return { success: false, reason: "truncated" };
  }
  if (!text) return { success: false, reason: "empty" };

  const supportedFences = [...text.matchAll(
    /```(?:sysml|sysmlv2)[ \t]*\r?\n([\s\S]*?)\r?\n```/giu,
  )];
  const unlabeledFences = [...text.matchAll(
    /```[ \t]*\r?\n([\s\S]*?)\r?\n```/gu,
  )];
  const supportedOpenings = [...text.matchAll(
    /(?:^|\r?\n)[ \t]*```(?:sysml|sysmlv2)(?:[ \t]*\r?\n|\s*$)/giu,
  )];
  const fenceLines = [...text.matchAll(/(?:^|\r?\n)[ \t]*```/gu)];
  if (supportedFences.length === 1 && supportedOpenings.length === 1) {
    const content = String(supportedFences[0]?.[1] || "").trim();
    return content
      ? { success: true, content }
      : { success: false, reason: "empty" };
  }
  if (unlabeledFences.length === 1 && supportedFences.length === 0 && fenceLines.length === 2) {
    const content = String(unlabeledFences[0]?.[1] || "").trim();
    return content
      ? { success: true, content }
      : { success: false, reason: "empty" };
  }
  if (fenceLines.length > 0) {
    return {
      success: false,
      reason: (supportedOpenings.length === 1 && supportedFences.length === 0)
        || (supportedOpenings.length === 0 && fenceLines.length === 1)
        ? "truncated"
        : "ambiguous",
    };
  }
  return { success: true, content: rawText };
}

async function generateCandidate(
  options: CandidateWorkerOptions,
  attempt: number,
  recovery: boolean,
  priorFailure?: CandidateContentFailure,
) {
  const permit = options.resources.budget.reserve("candidate_generation");
  try {
    const candidateInput = candidateModelInput(options.task, options.resources, options.prompt);
    const commonOptions = {
      model: options.model,
      phase: recovery ? "candidate_content_recovery" : "candidate_generation",
      instructions: candidateInstructions(
        options.instructions,
        candidateInput.projection,
        recovery ? priorFailure ?? "invalid" : undefined,
      ),
      messages: candidateInput.messages,
      maxRetries: 0,
      ...(options.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.maxOutputTokens }),
      temperature: options.temperature ?? 0,
      reasoning: options.reasoning,
      providerOptions: options.providerOptions,
      abortSignal: options.abortSignal,
      timeout: {
        totalMs: Math.min(options.timeoutMs, options.resources.budget.view().workRemainingMs),
        ...(options.toolTimeoutMs ? { toolMs: options.toolTimeoutMs } : {}),
      },
      runtimeContext: createRunExecutionView(options.resources, "candidate"),
    };
    const toolNames = Object.keys(options.tools ?? {});
    const generated = toolNames.length > 0 && options.tools
      ? await generateObservedToolLoopText({
        ...commonOptions,
        tools: options.tools,
        toolsContext: createRunToolsContext(options.resources, "candidate", toolNames),
        stopWhen: stepCountIs(Math.max(1, options.maxSteps ?? 4)),
        onToolExecutionStart: (event) => options.resources.recordToolLifecycle({
          toolCallId: event.toolCall.toolCallId,
          toolName: event.toolCall.toolName,
          participant: "candidate",
          taskId: options.task.taskId,
          taskRevision: options.task.taskRevision,
          status: "started",
        }),
        onToolExecutionEnd: (event) => options.resources.recordToolLifecycle({
          toolCallId: event.toolCall.toolCallId,
          toolName: event.toolCall.toolName,
          participant: "candidate",
          taskId: options.task.taskId,
          taskRevision: options.task.taskRevision,
          status: event.toolOutput.type === "tool-result" ? "succeeded" : "failed",
        }),
      })
      : await generateObservedText(commonOptions);
    options.resources.budget.settleModelCall({
      callId: `${options.resources.runId}:${options.task.taskId}:candidate:${attempt}`,
      usage: generated.usage,
    });
    options.resources.budget.settle(permit, "succeeded");
    return generated;
  } catch (error) {
    options.resources.budget.settle(permit, options.abortSignal.aborted ? "cancelled" : "failed");
    throw error;
  }
}

function candidateModelInput(
  task: CandidateTaskView,
  resources: RunResources,
  overridePrompt?: string,
): Readonly<{
  messages: ReturnType<typeof projectConversationModelMessages>;
  projection: unknown;
}> {
  const currentTask = resources.tasks.get(task.taskId);
  const knowledgeEvidence = currentTask
    ? projectWorkerEvidenceView(resources, currentTask)
    : task.knowledge;
  const projection = overridePrompt ? { specializedTask: overridePrompt } : {
    candidateMode: task.mode,
    target: task.target.kind,
    preservationPolicy: task.preservationPolicyRef,
    knowledgeEvidence,
    reviewedKnowledgeSearchState: {
      budget: resources.knowledge.reviewedKnowledgeQueryBudget(),
      results: reviewedKnowledgeSearchResults(resources),
    },
    visibleFiles: task.model.files.map((file) => ({
      displayName: file.displayName,
      content: file.content,
      editable: file.editable,
    })),
  };
  return Object.freeze({
    messages: projectConversationModelMessages(
      task.conversationMessages,
      task.taskSources,
      task.question,
    ),
    projection,
  });
}

function candidateInstructions(
  base: string,
  projection: unknown,
  recoveryFailure?: CandidateContentFailure | "invalid",
): Instructions {
  const instructions = recoveryFailure
    ? `${base}\n\n上一次未形成唯一、完整的候选（${recoveryFailure}）。本次只输出一份完整SysML v2候选，不要解释。`
    : base;
  return systemInstructions(instructions, "服务端可信Candidate执行投影", projection);
}

function reviewedKnowledgeSearchResults(resources: RunResources): readonly unknown[] {
  const entries = [
    ...resources.priorKnowledgeEntries.map((entry) => ({ output: entry.output })),
    ...resources.ledger.snapshot(),
  ];
  return Object.freeze(entries.flatMap((entry) => {
    const output = entry.output;
    if (!output || typeof output !== "object" || Array.isArray(output)) return [];
    const result = output as Record<string, unknown>;
    const requestedQuery = typeof result.requestedQuery === "string" ? result.requestedQuery : "";
    if (!requestedQuery) return [];
    const claims = Array.isArray(result.claims) ? result.claims : [];
    const closureGaps = Array.isArray(result.closureGaps)
      ? result.closureGaps.filter((item): item is string => typeof item === "string")
      : [];
    const missingClosureClaimIds = Array.isArray(result.missingClosureClaimIds)
      ? result.missingClosureClaimIds.filter((item): item is string => typeof item === "string")
      : [];
    const patternDimensions = (Array.isArray(result.candidateKnowledgePatterns)
      ? result.candidateKnowledgePatterns
      : []).flatMap((pattern) => {
        if (!pattern || typeof pattern !== "object" || Array.isArray(pattern)) return [];
        const dimensions = (pattern as Record<string, unknown>).closureDimensions;
        return Array.isArray(dimensions)
          ? dimensions.filter((item): item is string => typeof item === "string")
          : [];
      });
    return [Object.freeze({
      requestedQuery,
      coverage: typeof result.coverage === "string" ? result.coverage : "NONE",
      claimIds: Object.freeze(claims.flatMap((claim) => (
        claim && typeof claim === "object" && !Array.isArray(claim)
          && typeof (claim as Record<string, unknown>).claimId === "string"
          ? [(claim as Record<string, unknown>).claimId as string]
          : []
      ))),
      missingDimensions: Object.freeze([...new Set([
        ...closureGaps,
        ...missingClosureClaimIds.map((claimId) => `missing_claim:${claimId}`),
        ...patternDimensions,
      ])]),
      noNewEvidence: result.no_new_evidence === true,
    })];
  }));
}

function assertCandidateTaskBinding(resources: RunResources, task: CandidateTaskView): void {
  if (task.runId !== resources.runId || task.questionHash !== resources.input.questionHash) {
    throw new Error("Candidate task does not belong to the bound Run");
  }
  const current = resources.tasks.get(task.taskId);
  if (!current || current.workerType !== "candidate" || current.revision !== task.taskRevision) {
    throw new Error("Candidate task is stale or missing");
  }
}

function resultFromValidation(
  task: CandidateTaskView,
  validation: CandidateValidationOutcome,
  attempts: number,
): CandidateWorkerResult {
  return validation.passed
    ? createValidatedPassedResult({
      task,
      candidate: validation.candidate,
      validation: validation.validation,
      attemptCount: attempts,
    })
    : createWorkerFailureResult({
      task,
      status: "validated_failed",
      validation: validation.validation,
      reason: validation.reason,
      attemptCount: attempts,
    });
}

function terminalResult(
  task: CandidateTaskView,
  status: CandidateWorkerResult["status"],
  reason: string,
  attempts: number,
): CandidateWorkerResult {
  if (status === "validated_passed") {
    throw new Error("terminalResult cannot create validated_passed without real objects");
  }
  return createWorkerFailureResult({ task, status, reason, attemptCount: attempts });
}

function boundedReason(value: unknown): string {
  const reason = value instanceof Error ? value.message : String(value || "worker_error");
  const code = value && typeof value === "object"
    && typeof (value as { code?: unknown }).code === "string"
    && /^(?:VALIDATOR|CANDIDATE)_[A-Z0-9_]+$/u.test((value as { code: string }).code)
    ? (value as { code: string }).code
    : "";
  const bounded = reason.trim().slice(0, 500) || "worker_error";
  return code && !bounded.includes(code) ? `${code}:${bounded}`.slice(0, 500) : bounded;
}

function isResourceExhaustionReason(reason: string): boolean {
  return reason.includes("Run budget exceeded") || [
    "candidate_budget_exhausted",
    "validator_budget_exhausted",
    "repair_context_budget_exhausted",
    "repair_time_budget_exhausted",
    "repair_no_progress",
    "step_budget_exhausted",
    "validator_queue_full",
    "validator_queue_timeout",
    "validator_execution_timeout",
  ].includes(reason);
}
