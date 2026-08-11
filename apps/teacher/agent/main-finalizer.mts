import type { LanguageModel } from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";

import { generateObservedText } from "./observed-generation.mjs";
import { createRunExecutionView, type RunResources } from "./run-resources.mjs";
import type { WorkerTerminalBinding } from "./result-binding.mjs";
import type { WorkerResult } from "./worker-contracts.mjs";
import type { ValidationOutput } from "./types.mjs";

export interface MainFinalizerResult {
  readonly answer: string;
  readonly finalization: "main_model" | "deterministic_fallback";
  readonly finishReason: string;
}

export interface MainFinalizerOptions {
  readonly resources: RunResources;
  readonly binding: WorkerTerminalBinding;
  readonly model: LanguageModel;
  readonly abortSignal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly providerOptions?: SharedV4ProviderOptions;
  readonly reasoning?: "none" | "medium" | "high" | "xhigh";
  readonly advisory?: Readonly<{
    recommendation: "no_change" | "revise_candidate" | "advice_only";
    verification: "not_run" | "resolved" | "unresolved" | "unavailable";
    revisionDelivered: boolean;
    engineeringResolution: "resolved" | "unresolved" | "unknown" | "not_assessed";
    openSuggestions: readonly Readonly<{ summary: string }>[];
    /** @deprecated Use revisionDelivered. */
    revisionAdopted: boolean;
    issues: readonly Readonly<{
      goalQuote: string;
      issue: string;
      suggestion: string;
    }>[];
  }>;
}

const FINALIZER_INSTRUCTIONS = `你是SysML v2教学助手的最终说明器。根据服务端提供的不可变任务义务、Worker终态和Validator事实，只生成一次面向学生的简洁说明。
不得声称未发生的验证、发布、文件应用或工程正确性；不得暴露Agent、Worker、Tool、Ledger、hash、taskId或内部编排。验证成功时说明官方语法/语义验证的有限边界；验证失败、不可用、耗尽或取消时明确说明没有形成可作为验证成功交付的候选，且不要输出未验证代码。若engineeringAdvisory.revisionDelivered为true，当前validatedCandidate就是已经选择交付的改进版本；即使engineeringResolution为unresolved或unknown，也不得把它说成回退基线，只需简洁披露剩余建议或Review状态未知。`;

/** 委派链只调用一次SDK文本生成；失败或空文本直接确定性降级。 */
export async function finalizeDelegatedAnswer(
  options: MainFinalizerOptions,
): Promise<MainFinalizerResult> {
  // 失败、耗尽、取消和Worker错误是服务端已知终态。让模型重新表述这些
  // 状态会重新引入“FAIL被说成PASS”的语义越权，因此直接使用可信降级。
  if (options.binding.workerResult.status !== "validated_passed") {
    return fallback(
      options.binding.workerResult,
      `terminal_${options.binding.workerResult.status}`,
    );
  }
  if (options.abortSignal.aborted || !options.resources.isAllowed("finalize_answer")) {
    return fallback(options.binding.workerResult, "finalizer_not_admitted");
  }
  try {
    const generated = await generateObservedText({
      model: options.model,
      phase: "answer_generation",
      instructions: FINALIZER_INSTRUCTIONS,
      prompt: JSON.stringify(finalizerProjection(options)),
      maxRetries: 0,
      maxOutputTokens: options.maxOutputTokens,
      temperature: 0,
      reasoning: options.reasoning,
      providerOptions: options.providerOptions,
      abortSignal: options.abortSignal,
      timeout: {
        totalMs: Math.min(options.timeoutMs, options.resources.budget.view().hardRemainingMs),
      },
      runtimeContext: createRunExecutionView(options.resources, "main"),
    });
    options.resources.budget.settleModelCall({
      callId: `${options.resources.runId}:${options.binding.workerResult.taskId}:finalizer`,
      usage: generated.usage,
    });
    const answer = generated.text.trim();
    if (!answer) return fallback(options.binding.workerResult, "finalizer_empty");
    return Object.freeze({
      answer,
      finalization: "main_model",
      finishReason: generated.finishReason || "stop",
    });
  } catch (error) {
    return fallback(
      options.binding.workerResult,
      options.abortSignal.aborted ? "finalizer_cancelled" : boundedReason(error),
    );
  }
}

export function deterministicFinalizerFallback(workerResult: WorkerResult): string {
  if (workerResult.status === "validated_passed") {
    return "已形成候选，并通过官方 SysML v2 Validator 的语法与语义检查。该结果只证明终末候选在本次验证范围内通过，不自动证明工程事实正确、设计完整或文件已经发布/应用。";
  }
  if (workerResult.status === "cancelled") {
    return "本轮处理已取消，没有把迟到结果作为本轮交付，也没有形成可作为验证成功交付的候选。";
  }
  if (workerResult.status === "exhausted") {
    return "本轮在时间或尝试预算内未形成通过验证的候选，因此不提供未验证代码作为成功交付。";
  }
  if (workerResult.reason.startsWith("CANDIDATE_TARGET_READ_ONLY:")) {
    return "当前课程资源保持只读，原文件没有被修改。本轮未发布候选模型；可继续查看课程内容，或在可编辑草稿中再次生成。";
  }
  if (workerResult.validation?.official.syntax === "unavailable"
    || workerResult.validation?.official.semantic === "unavailable") {
    return "官方 SysML v2 Validator 本轮不可用，无法确认候选有效，因此没有把候选描述为验证通过。";
  }
  return "本轮候选未通过完整验证，没有形成可作为验证成功交付的模型；请依据诊断修正后重新验证。";
}

function finalizerProjection(options: MainFinalizerOptions): unknown {
  const result = options.binding.workerResult;
  return {
    studentQuestion: options.resources.input.question.slice(0, 8_000),
    obligation: {
      outcomeType: options.binding.obligation.outcomeType,
      deliverableType: options.binding.obligation.deliverableType,
      ...(options.binding.obligation.outcomeType === "candidate"
        ? { candidateMode: options.binding.obligation.candidateMode }
        : { repairScope: options.binding.obligation.repairScope }),
    },
    workerStatus: result.status,
    ...(result.status === "validated_passed" ? {
      validator: validationProjection(result.validation),
      validatedCandidate: candidateContent(result).slice(0, 40_000),
    } : {
      reason: result.reason,
      ...(result.validation ? { validator: validationProjection(result.validation) } : {}),
    }),
    ...(options.advisory ? {
      engineeringAdvisory: {
        recommendation: options.advisory.recommendation,
        verification: options.advisory.verification,
        revisionDelivered: options.advisory.revisionDelivered,
        revisionAdopted: options.advisory.revisionAdopted,
        engineeringResolution: options.advisory.engineeringResolution,
        openSuggestions: options.advisory.openSuggestions.slice(0, 4).map((item) => ({
          summary: item.summary.slice(0, 500),
        })),
        issues: options.advisory.issues.slice(0, 8).map((issue) => ({
          goalQuote: issue.goalQuote.slice(0, 500),
          issue: issue.issue.slice(0, 500),
          suggestion: issue.suggestion.slice(0, 500),
        })),
      },
    } : {}),
  };
}

function validationProjection(validation: ValidationOutput): unknown {
  const diagnostics = [
    ...validation.official.diagnostics,
    ...(validation.courseRules?.diagnostics ?? []),
  ].slice(0, 20).map((item: { code?: string; message: string; severity: string }) => ({
    ...(item.code ? { code: item.code } : {}),
    message: item.message.slice(0, 500),
    severity: item.severity,
  }));
  return {
    official: {
      syntax: validation.official.syntax,
      semantic: validation.official.semantic,
    },
    courseRules: validation.courseRules?.status ?? "not_applicable",
    completeness: validation.completeness,
    diagnostics,
  };
}

function candidateContent(result: Extract<WorkerResult, { status: "validated_passed" }>): string {
  const candidate = result.candidate;
  if (candidate.mode === "standalone_model" || candidate.mode === "replace_entry") {
    return candidate.content;
  }
  if (candidate.mode === "workspace_files") {
    return candidate.files.map((file) => `// ${file.fileId}\n${file.content}`).join("\n\n");
  }
  return candidate.edits.map((edit) => edit.replacement).join("\n\n");
}

function fallback(workerResult: WorkerResult, finishReason: string): MainFinalizerResult {
  return Object.freeze({
    answer: deterministicFinalizerFallback(workerResult),
    finalization: "deterministic_fallback",
    finishReason,
  });
}

function boundedReason(value: unknown): string {
  const reason = value instanceof Error ? value.message : String(value || "finalizer_failed");
  return reason.trim().slice(0, 160) || "finalizer_failed";
}
