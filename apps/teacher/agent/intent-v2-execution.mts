import { createHash } from "node:crypto";

import { assembleTrustedResponse, stripInternalSourceMarkers } from "./agent-response.mjs";
import { deriveEditorGrounding } from "./agent-policy.mjs";
import { runReadOnlyEngineeringAdvice } from "./engineering-semantic-advisory.mjs";
import {
  createProductionFinalAnswerWorker,
  dispatchFinalAnswerWorker,
  type FinalAnswerEngineeringAdvisory,
} from "./final-answer-worker.mjs";
import {
  createProductionWorkerHandlers,
  runResumedProductionExecution,
  type ProductionWorkerHandlerOptions,
} from "./production-worker-handlers.mjs";
import { bindFinalAnswer, bindWorkerResult } from "./result-binding.mjs";
import { createRunResources } from "./run-resources.mjs";
import {
  runIntentOrchestratorV2,
  type MainWorkerObservation,
  v2GenerationSettings,
  v2RepairGenerationSettings,
} from "./intent-orchestrator-v2.mjs";
import type {
  AgentLifecycleEvent,
  AgentPolicy,
  AgentRunOutcome,
  AgentRunRequest,
  MainAgentDelegation,
  MainAgentOutcome,
  RunStopCause,
  RunTeacherAgentOptions,
  TrustedTeacherResponse,
} from "./types.mjs";
import {
  createCurrentValidatedCandidateBinding,
  type TaskIterationDirectiveBinding,
  type TaskWorkingState,
} from "./task-working-state.mjs";
import {
  bindValidatedCandidateTaskContract,
  loadTaskFinalizationDecision,
  markTaskContractDeliveryPending,
  prepareCandidateTaskContract,
  prepareClarificationTaskContract,
  sealCandidateTaskContract,
  sealDirectTaskContract,
} from "./task-contract-runtime.mjs";
import {
  validateCandidateInputSchema,
  validationOutputSchema,
  type CandidateArtifact,
  type ValidationOutput,
} from "./types.mjs";
import {
  dispatchWorker,
  dispatchResumedWorker,
  projectWorkerTaskView,
} from "./worker-dispatcher.mjs";
import type { WorkerResult } from "./worker-contracts.mjs";
import {
  computeCandidateWorkspaceHash,
  createValidatedPassedResult,
  createWorkerFailureResult,
  validationPassed,
} from "./worker-result.mjs";
import { projectRepairTelemetryCheckpointState } from "./validator-repair-worker.mjs";
import { createValidatedCandidateDelivery } from "./validated-candidate-delivery.mjs";

export async function runIntentV2Execution(input: {
  options: RunTeacherAgentOptions;
  request: AgentRunRequest;
  policy: AgentPolicy;
}): Promise<AgentRunOutcome> {
  const { options, request } = input;
  const engineeringContinuation = request.resumeContext?.execution?.decision.continuationKind === "engineering_improvement";
  const engineeringContinuationDurationMs = Math.min(
    input.policy.engineeringImprovementRunMaxDurationMs,
    request.resumeContext?.continuationBudget?.effectiveDurationMs
      ?? input.policy.engineeringImprovementRunMaxDurationMs,
  );
  const policy: AgentPolicy = engineeringContinuation
    ? {
      ...input.policy,
      maxDurationMs: engineeringContinuationDurationMs,
      candidateMaxAttemptMs: input.policy.engineeringRevisionMaxDurationMs,
      repairPhaseReserveMs: input.policy.engineeringRevisionValidationRepairReserveMs,
    }
    : input.policy;
  const startedAtMs = Date.now();
  const deadlineAtMs = startedAtMs + policy.maxDurationMs;
  const resources = createRunResources({ request, policy, deadlineAtMs, startedAtMs });
  if (!request.resumeContext?.execution) {
    await persistRunCheckpoint(resources, options.dependencies, { phase: "candidate_absent" });
  }
  const workDeadlineSignal = createRunDeadlineSignal(
    resources.workDeadlineAtMs,
    "work_deadline_reached",
  );
  const hardDeadlineSignal = createRunDeadlineSignal(
    resources.hardDeadlineAtMs,
    "hard_deadline_reached",
  );
  const workSignal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, workDeadlineSignal, hardDeadlineSignal])
    : AbortSignal.any([workDeadlineSignal, hardDeadlineSignal]);
  const finalizationSignal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, hardDeadlineSignal])
    : hardDeadlineSignal;
  const lifecycleWarnings: string[] = [];
  const emitLifecycle = async (event: AgentLifecycleEvent): Promise<void> => {
    const emitted = await emitLifecycleWithinSignal(
      options.dependencies.onLifecycleEvent,
      event,
      finalizationSignal,
    );
    if (!emitted) lifecycleWarnings.push(`lifecycle_callback_failed:${event.type}`);
  };
  const stageDependencies = {
    ...options.dependencies,
    onLifecycleEvent: options.dependencies.onLifecycleEvent
      ? async (event: AgentLifecycleEvent) => {
        if (event.type !== "run_started" && event.type !== "run_finished") {
          await options.dependencies.onLifecycleEvent?.(event);
        }
      }
      : undefined,
  };

  await emitLifecycle({
    type: "run_started",
    runId: request.runId,
    callId: `${request.runId}-intent-orchestrator-v2`,
    provider: options.providerOptionsName ?? "",
    modelId: options.mainModelId ?? options.modelId ?? "",
    maxRetries: 0,
  });

  const preflight = await runIntentOrchestratorV2({
    ...options,
    request,
    policy,
    abortSignal: workSignal,
    finalizeVisibleAnswer: undefined,
    dependencies: stageDependencies,
    runResources: resources,
  });
  let outcome = preflight;
  const mainOutcome = preflight.mainAgentOutcome;

  if (mainOutcome?.type === "finalize_requested") {
    const obligation = resources.obligations.freeze({ outcome: mainOutcome });
    const sealedTaskContract = await sealDirectTaskContract({
      dependencies: stageDependencies,
      finalizationRequestId: mainOutcome.finalizationRequestId,
      answerSource: stripInternalSourceMarkers(preflight.response.answer).trim() ? "main_draft" : "finalizer",
      taskContractContext: request.taskContractContext,
    });
    sealedTaskContract.warnings.forEach((warning) => resources.recordOperationalWarning(warning));
    const finalAnswerGeneration = v2GenerationSettings(options, true, "finalizer");
    const finalAnswerStartedAt = Date.now();
    const serverBoundMainDraftCandidate = stripInternalSourceMarkers(preflight.response.answer).trim();
    const finalAnswerBudget = finalAnswerTimeoutBudget({
      terminalReserveMs: policy.terminalReserveMs,
      hardRemainingMs: resources.budget.view().hardRemainingMs,
      hasSafeFallback: Boolean(serverBoundMainDraftCandidate),
    });
    const finalAnswer = await dispatchFinalAnswerWorker({
      resources,
      obligation,
      source: {
        kind: "direct_answer",
        mainDraft: mainOutcome.mainDraft,
        evidence: mainOutcome.finalizerEvidence,
      },
      ...(sealedTaskContract.view ? { taskContract: sealedTaskContract.view } : {}),
      abortSignal: finalizationSignal,
      worker: createProductionFinalAnswerWorker({
        model: options.finalizerModel ?? options.nonThinkingModel ?? options.model,
        timeoutMs: finalAnswerBudget.totalMs,
        reasoning: finalAnswerGeneration.reasoning,
        providerOptions: finalAnswerGeneration.providerOptions,
      }),
    });
    const budget = resources.budget.view();
    const callerCancelled = Boolean(options.abortSignal?.aborted);
    const serverBoundMainDraft = !callerCancelled
      && finalAnswer.finalization === "deterministic_fallback"
      && isFinalAnswerTimeout(finalAnswer.finishReason)
      ? serverBoundMainDraftCandidate
      : "";
    const effectiveFinalization = serverBoundMainDraft
      ? "server_bound_main_draft" as const
      : finalAnswer.finalization;
    const finalAnswerCompleted = effectiveFinalization === "final_answer_worker"
      || effectiveFinalization === "server_bound_main_draft";
    const directResponse: TrustedTeacherResponse = {
      ...preflight.response,
      answer: serverBoundMainDraft || stripInternalSourceMarkers(finalAnswer.answer),
      stepCount: preflight.response.stepCount + finalAnswer.workerResult.attemptCount,
      stopReason: callerCancelled
        ? "cancelled"
        : finalAnswerCompleted
          ? preflight.response.stopReason
          : classifyFinalAnswerFailureStopReason(finalAnswer.finishReason, hardDeadlineSignal),
      answerCompletionStatus: finalAnswerCompleted ? "complete" : "incomplete",
      phaseTimings: appendFinalAnswerTiming(
        preflight.response.phaseTimings,
        Date.now() - finalAnswerStartedAt,
        finalAnswer.workerResult.attemptCount,
      ),
      modelCalls: appendFinalAnswerModelCall(
        preflight.response.modelCalls,
        finalAnswer.workerResult,
      ),
      usage: {
        inputTokens: budget.modelInputTokens,
        outputTokens: budget.modelOutputTokens,
        reasoningTokens: budget.modelReasoningTokens,
        totalTokens: budget.modelTotalTokens,
      },
      warnings: [...new Set([
        ...preflight.response.warnings,
        ...resources.operationalWarnings(),
        ...(finalAnswer.finalization === "deterministic_fallback"
          ? [`final_answer_worker_fallback:${finalAnswer.finishReason}`]
          : []),
        ...(serverBoundMainDraft
          ? ["final_answer_worker_timeout_server_bound_main_draft_used"]
          : []),
        ...(finalAnswerBudget.borrowed
          ? ["final_answer_worker_borrowed_run_budget"]
          : []),
      ])],
    };
    outcome = await projectVisibleAnswer(options, {
      ...preflight,
      ok: !callerCancelled,
      response: directResponse,
      mainAgentOutcome: mainOutcome,
    });
    if (!callerCancelled) {
      bindFinalAnswer({
        obligation,
        finalAnswerWorkerResult: finalAnswer.workerResult,
        finalAnswer: outcome.response.answer,
        finalization: effectiveFinalization,
      });
    }
    if (!finalAnswerCompleted || callerCancelled) {
      const pendingWarnings = await markTaskContractDeliveryPending({ dependencies: stageDependencies });
      pendingWarnings.forEach((warning) => resources.recordOperationalWarning(warning));
    }
    outcome.mainAgentOutcome = mainOutcome;
  } else if (mainOutcome?.type === "delegate_candidate"
    || mainOutcome?.type === "delegate_repair"
    || mainOutcome?.type === "resume_execution") {
    const candidateGeneration = v2GenerationSettings(options, false, "candidate");
    const repairGeneration = v2RepairGenerationSettings(options);
    const taskOutcome = mainOutcome.type === "resume_execution"
      ? resumedTaskOutcome(mainOutcome, request)
      : mainOutcome;
    const initialTaskContract = taskOutcome.type === "delegate_candidate"
      ? await prepareCandidateTaskContract({
        dependencies: stageDependencies,
        runId: request.runId,
        outcome: taskOutcome,
        taskContractContext: request.taskContractContext,
      })
      : undefined;
    initialTaskContract?.warnings.forEach((warning) => resources.recordOperationalWarning(warning));
    const task = resources.tasks.materialize({
      questionHash: resources.input.questionHash,
      outcome: taskOutcome,
      context: request.context,
      ...(initialTaskContract ? { iterationDirective: initialTaskContract.directive } : {}),
    });
    const projectedTask = projectWorkerTaskView(resources, task);
    const parsedEngineeringBaseline = engineeringContinuation
      ? restoreEngineeringBaselineFromResume(request)
      : undefined;
    const resumedEngineeringBaseline = parsedEngineeringBaseline
      && parsedEngineeringBaseline.validation.candidateWorkspaceHash
        === computeCandidateWorkspaceHash(projectedTask, parsedEngineeringBaseline.candidate)
      ? parsedEngineeringBaseline
      : undefined;
    const resumedEngineeringRevision = engineeringContinuation && resumedEngineeringBaseline
      ? restoreEngineeringRevisionFromResume(request, resumedEngineeringBaseline.candidate)
      : undefined;
    const workerOptions = {
        resources,
        request,
        policy,
        model: options.candidateModel ?? options.thinkingModel ?? options.model,
        repairModel: options.repairModel ?? options.thinkingModel ?? options.model,
        candidateProviderOptions: candidateGeneration.providerOptions,
        candidateReasoning: candidateGeneration.reasoning,
        repairProviderOptions: repairGeneration.providerOptions,
        repairReasoning: repairGeneration.reasoning,
        repairExplicitToolChoice: repairGeneration.explicitToolChoice,
        dependencies: stageDependencies,
        ...(resumedEngineeringRevision ? { engineeringRevision: resumedEngineeringRevision } : {}),
      };
    let workerResult: WorkerResult;
    if (mainOutcome.type === "resume_execution"
      && engineeringContinuation
      && engineeringRevisionContextRequired(request)
      && !resumedEngineeringRevision) {
      if (resumedEngineeringBaseline) {
        resources.recordOperationalWarning("engineering_resume_context_invalid_baseline_retained");
        await resources.ledger.recordObservation({
          toolCallId: `${resources.runId}:engineering-baseline-fallback`,
          toolName: "validate_candidate_workspace",
          input: resumedEngineeringBaseline.candidate,
          output: resumedEngineeringBaseline.validation,
          replayedFromRunId: resources.resumeExecution?.lineageRootRunId,
        });
        workerResult = createValidatedPassedResult({
          task: projectedTask,
          candidate: resumedEngineeringBaseline.candidate,
          validation: resumedEngineeringBaseline.validation,
          attemptCount: 0,
        });
      } else {
        workerResult = createWorkerFailureResult({
          task: projectedTask,
          status: "worker_error",
          reason: "engineering_resume_baseline_invalid",
          attemptCount: 0,
        });
      }
    } else if (mainOutcome.type === "resume_execution") {
      const execution = request.resumeContext?.execution;
      if (!execution?.worker.candidate) {
        throw new Error("Checkpoint resume requires a persisted Candidate artifact");
      }
      const dispatch = await dispatchResumedWorker({
        resources,
        taskId: task.taskId,
        expectedRevision: task.revision,
        abortSignal: workSignal,
        execute: async (taskView) => await runResumedProductionExecution({
          options: workerOptions,
          task: taskView,
          action: mainOutcome.action,
          candidate: execution.worker.candidate,
          validation: execution.worker.validation,
          validatorVersion: execution.decision.validatorVersion,
          rulesetVersion: execution.decision.rulesetVersion,
          validationOptionsHash: execution.decision.validationOptionsHash,
          repairRound: execution.decision.repairRound,
          abortSignal: workSignal,
        }),
      });
      workerResult = dispatch.type === "completed"
        ? dispatch.result
        : settleRejectedDispatch(resources, task.taskId, dispatch.reason);
    } else {
      const dispatch = await dispatchWorker({
        resources,
        taskId: task.taskId,
        expectedRevision: task.revision,
        abortSignal: workSignal,
        workers: createProductionWorkerHandlers(workerOptions),
      });
      workerResult = dispatch.type === "completed"
        ? dispatch.result
        : settleRejectedDispatch(resources, task.taskId, dispatch.reason);
    }
    const selectedTask = task;
    const selectedTaskOutcome = taskOutcome;
    const resumingFinalization = mainOutcome.type === "resume_execution"
      && ["finalizer", "return_persisted"].includes(mainOutcome.action);
    const restoredDecision = resumingFinalization
      ? await loadTaskFinalizationDecision(stageDependencies, workerResult.validation?.candidateWorkspaceHash ?? "")
      : undefined;
    let resultBindingCompleted = restoredDecision?.completed ?? false;
    let restoredLimitations = restoredDecision?.limitations ?? "";
    if (!resumingFinalization && workerResult.status === "validated_passed") {
      const checkpoint = await persistRunCheckpoint(resources, stageDependencies, {
        phase: "main_review_pending", candidate: workerResult.candidate, validation: workerResult.validation,
        repairRound: repairRoundFromWorkerResult(workerResult, request.resumeContext?.execution?.decision.repairRound ?? 0),
        repairState: projectRepairCheckpointState(workerResult),
      });
      const binding = await bindValidatedCandidateTaskContract({
        dependencies: stageDependencies, checkpoint,
        candidateWorkspaceHash: workerResult.validation.candidateWorkspaceHash ?? "",
        candidateContent: workerCandidateContent(workerResult),
      });
      binding.warnings.forEach((warning) => resources.recordOperationalWarning(warning));
      // Validator与交付绑定由服务端完成；普通任务直接进入一次终末解释。
      resultBindingCompleted = true;
    }
    // 只有既有工程改进续跑显式启用的只读评议保留独立调用；普通代码与评估问题由 Finalizer 一次解释。
    let engineeringAdvisory: FinalAnswerEngineeringAdvisory | undefined;
    if (engineeringContinuation && policy.semanticReviewEnabled
      && policy.semanticReviewAssessmentMaxCalls > 0 && workerResult.status === "validated_passed") {
      const generation = v2GenerationSettings(options, false, "semanticReview");
      const advice = await runReadOnlyEngineeringAdvice({
        resources, baseline: workerResult, taskSummary: request.question,
        candidateText: workerCandidateContent(workerResult),
        model: options.semanticReviewModel ?? options.thinkingModel ?? options.model,
        providerOptions: generation.providerOptions,
        timeoutMs: policy.semanticReviewAssessmentTimeoutMs, abortSignal: workSignal,
      });
      if (advice.status !== "completed") resources.recordOperationalWarning("engineering_review_unavailable");
      if (!policy.semanticReviewShadowOnly) engineeringAdvisory = {
        candidateWorkspaceHash: advice.candidateWorkspaceHash,
        appliesToSelectedCandidate: advice.candidateWorkspaceHash === workerResult.validation.candidateWorkspaceHash,
        recommendation: "advice_only", verification: "not_run", revisionDelivered: false, revisionAdopted: false,
        engineeringResolution: "unknown", openSuggestions: [{ summary: advice.text }], issues: [],
      };
    }
    const obligation = resources.obligations.freeze({
      outcome: selectedTaskOutcome,
      task: selectedTask,
      taskRevision: workerResult.taskRevision,
    });
    const deliveryTaskView = Object.freeze({
      ...projectWorkerTaskView(resources, selectedTask),
      taskRevision: workerResult.taskRevision,
    });
    const deliveryResult = createValidatedCandidateDelivery({
      workerResult,
      task: deliveryTaskView,
    });
    const validatedCandidateDelivery = deliveryResult.ok ? deliveryResult.delivery : undefined;
    bindWorkerResult(obligation, workerResult, validatedCandidateDelivery);
    let finalizationContractFailed = false;
    let sealedCandidateTaskContract: Awaited<ReturnType<typeof sealCandidateTaskContract>> | undefined;
    if (!options.abortSignal?.aborted && workerResult.status === "validated_passed") {
      const finalizationCheckpoint = await persistRunCheckpoint(resources, stageDependencies, {
        phase: "finalization_pending",
        candidate: workerResult.candidate,
        validation: workerResult.validation,
        repairRound: repairRoundFromWorkerResult(
          workerResult,
          request.resumeContext?.execution?.decision.repairRound ?? 0,
        ),
        repairState: projectRepairCheckpointState(workerResult),
      });
      sealedCandidateTaskContract = await sealCandidateTaskContract({
        dependencies: stageDependencies,
        checkpoint: finalizationCheckpoint,
        candidateWorkspaceHash: workerResult.validation.candidateWorkspaceHash ?? "",
        candidateContent: workerCandidateContent(workerResult),
        finalizationRequestId: `${selectedTask.acceptedToolCallId}:main-finalization`,
        resultCheckCompleted: resultBindingCompleted,
        limitations: restoredLimitations,
        ...(engineeringAdvisory ? { advisory: engineeringAdvisory } : {}),
      });
      sealedCandidateTaskContract.warnings.forEach((warning) => resources.recordOperationalWarning(warning));
      if (!sealedCandidateTaskContract.view
        && !sealedCandidateTaskContract.warnings.includes("task_contract_store_unavailable")) {
        finalizationContractFailed = true;
      }
    }
    const finalizerGeneration = v2GenerationSettings(options, true, "finalizer");
    const finalAnswerStartedAt = Date.now();
    const finalAnswerBudget = finalAnswerTimeoutBudget({
      terminalReserveMs: policy.terminalReserveMs,
      hardRemainingMs: resources.budget.view().hardRemainingMs,
      // 已验证Candidate或确定性非PASS说明已经是服务端安全兜底，
      // 不应为了教学润色继续占用Run工作预算。
      hasSafeFallback: true,
    });
    const finalizer = await dispatchFinalAnswerWorker({
      resources,
      obligation,
      source: {
        kind: "worker_terminal",
        workerResult,
        limitations: restoredLimitations,
      },
      ...(sealedCandidateTaskContract?.view ? { taskContract: sealedCandidateTaskContract.view } : {}),
      abortSignal: finalizationSignal,
      worker: createProductionFinalAnswerWorker({
        model: options.finalizerModel ?? options.nonThinkingModel ?? options.model,
        timeoutMs: finalAnswerBudget.totalMs,
        reasoning: finalizerGeneration.reasoning,
        providerOptions: finalizerGeneration.providerOptions,
      }),
    });
    const budget = resources.budget.view();
    const workerTerminalStopReason = workerStopReason(workerResult, {
      externalSignal: options.abortSignal,
      workDeadlineSignal,
      hardDeadlineSignal,
      workRemainingMs: budget.workRemainingMs,
    });
    // Review只提供建议；它失败、缺失或提出扩展都不改变实际交付结果。
    const stopReason = workerResult.status === "validated_passed"
      ? finalizer.workerResult.status === "completed"
        ? options.abortSignal?.aborted ? "cancelled" as const : "completed" as const
        : classifyFinalAnswerFailureStopReason(finalizer.finishReason, hardDeadlineSignal)
      : workerTerminalStopReason;
    const stopCause = runStopCauseFromSignals({
      externalSignal: options.abortSignal,
      workDeadlineSignal,
      hardDeadlineSignal,
    }) ?? (budget.workRemainingMs <= 0 ? "work_deadline_reached" : undefined);
    const deliveryLimitations = workerResult.status === "validated_passed" && finalizer.workerResult.status !== "completed"
      ? "本轮模型解释尚未完成，以下保留通过验证的候选。" : "";
    const assembled = assembleTrustedResponse({
      modelText: deliveryLimitations ? `${deliveryLimitations}\n\n${finalizer.answer}` : finalizer.answer,
      workflowVersion: "intent-orchestrator-v2",
      finishReason: finalizer.finishReason,
      stepCount: preflight.response.stepCount
        + workerResult.attemptCount
        + finalizer.workerResult.attemptCount,
      invalidToolCallCount: 0,
      stopReason,
      usage: {
        inputTokens: budget.modelInputTokens,
        outputTokens: budget.modelOutputTokens,
        reasoningTokens: budget.modelReasoningTokens,
        totalTokens: budget.modelTotalTokens,
      },
      warnings: [
        ...preflight.response.warnings,
        ...workerFailureWarnings(workerResult),
        ...resources.operationalWarnings(),
        ...(finalizer.finalization === "deterministic_fallback"
          ? [`final_answer_worker_fallback:${finalizer.finishReason}`]
          : []),
      ],
      ...(stopCause ? { stopCause } : {}),
    }, resources.ledger.snapshot(), {
      grounding: deriveEditorGrounding(request.context),
      suppressGroundingDisclosure: true,
      stripInternalProcessNarration: false,
      ...(validatedCandidateDelivery ? { validatedCandidateDelivery } : {}),
    });
    const response: TrustedTeacherResponse = {
      ...preflight.response,
      ...assembled,
      mainAgentDelegation: projectMainAgentDelegation(selectedTaskOutcome, resources.input.questionHash),
      answerCompletionStatus: !finalizationContractFailed && Boolean(validatedCandidateDelivery)
        && finalizer.workerResult.status === "completed" && workerResult.status === "validated_passed"
        ? "complete"
        : "incomplete",
      phaseTimings: appendFinalAnswerTiming(
        preflight.response.phaseTimings,
        Date.now() - finalAnswerStartedAt,
        finalizer.workerResult.attemptCount,
      ),
      modelCalls: appendFinalAnswerModelCall(
        preflight.response.modelCalls ?? [],
        finalizer.workerResult,
      ),
      warnings: [...new Set([...preflight.response.warnings, ...assembled.warnings])],
    };
    outcome = await projectVisibleAnswer(options, {
      // Worker失败只关闭候选发布能力，不关闭已经形成的教学响应。
      // 唯一例外是调用方主动取消：此时不得把迟到的降级文本当作本轮交付。
      ok: !options.abortSignal?.aborted && isDeliverableWorkerTerminal(workerResult, stopReason),
      response,
      ledger: resources.ledger.snapshot(),
      mainAgentOutcome: selectedTaskOutcome,
      ...(validatedCandidateDelivery ? { validatedCandidateDelivery } : {}),
    });
    if (!options.abortSignal?.aborted) {
      bindFinalAnswer({
        obligation,
        workerResult,
        ...(validatedCandidateDelivery ? { validatedCandidateDelivery } : {}),
        finalAnswerWorkerResult: finalizer.workerResult,
        finalAnswer: outcome.response.answer,
        finalization: finalizer.finalization,
      });
    }
    if (sealedCandidateTaskContract?.view
      && (options.abortSignal?.aborted || finalizer.workerResult.status !== "completed")) {
      const pendingWarnings = await markTaskContractDeliveryPending({ dependencies: stageDependencies });
      pendingWarnings.forEach((warning) => resources.recordOperationalWarning(warning));
    }
  } else if (mainOutcome?.type === "clarification_requested") {
    const contractWarnings = await prepareClarificationTaskContract({
      dependencies: stageDependencies,
      clarificationQuestion: mainOutcome.question,
      acceptedToolCallId: mainOutcome.acceptedToolCallId,
      taskContractContext: request.taskContractContext,
    });
    contractWarnings.forEach((warning) => resources.recordOperationalWarning(warning));
    outcome.response.warnings = [...new Set([...outcome.response.warnings, ...contractWarnings])];
  } else if (isInternalDeadlineOutcome(preflight, options.abortSignal, workDeadlineSignal, hardDeadlineSignal)) {
    outcome = await projectVisibleAnswer(options, {
      ...preflight,
      ok: true,
      response: {
        ...preflight.response,
        stopReason: hardDeadlineSignal.aborted ? "hard_timeout" : "timeout",
        answerCompletionStatus: "incomplete",
      },
    });
  }

  outcome.response.warnings = [...new Set([
    ...outcome.response.warnings,
    ...lifecycleWarnings,
  ])];
  outcome.response.stopCause ??= runStopCauseFromSignals({
    externalSignal: options.abortSignal,
    workDeadlineSignal,
    hardDeadlineSignal,
  });
  if (outcome.ok) {
    await emitLifecycle({
      type: "run_finished",
      runId: request.runId,
      stepCount: outcome.response.stepCount,
      finishReason: outcome.response.stopReason,
      modelCalls: outcome.response.modelCalls,
    });
  }
  outcome.response.warnings = [...new Set([
    ...outcome.response.warnings,
    ...lifecycleWarnings,
  ])];
  return outcome;
}

function isFinalAnswerTimeout(reason: string): boolean {
  return /(?:timeout|timed out|aborted due to timeout)/iu.test(reason);
}

/**
 * terminalReserveMs是Finalizer保证可用的软预算。只有Direct tool-only没有安全公开草稿时，
 * 才允许同一次FinalAnswerWorker使用仍未消耗的Run hard budget；最终只受Run hard deadline约束。
 * 这里不能再叠加独立的120秒上限，否则会在Run仍有充足余额时提前制造用户可见失败。
 */
function finalAnswerTimeoutBudget(input: {
  terminalReserveMs: number;
  hardRemainingMs: number;
  hasSafeFallback: boolean;
}): { softMs: number; totalMs: number; borrowed: boolean } {
  const hardRemainingMs = Math.max(1, Math.floor(input.hardRemainingMs));
  const softMs = Math.max(1, Math.min(Math.floor(input.terminalReserveMs), hardRemainingMs));
  if (input.hasSafeFallback) {
    return Object.freeze({ softMs, totalMs: softMs, borrowed: false });
  }
  const totalMs = hardRemainingMs;
  return Object.freeze({ softMs, totalMs, borrowed: totalMs > softMs });
}

async function projectVisibleAnswer(
  options: RunTeacherAgentOptions,
  outcome: AgentRunOutcome,
): Promise<AgentRunOutcome> {
  if (!options.finalizeVisibleAnswer) return outcome;
  const finalized = await options.finalizeVisibleAnswer(outcome);
  return {
    ...outcome,
    response: {
      ...outcome.response,
      answer: finalized.answer,
      warnings: [...new Set([
        ...outcome.response.warnings,
        ...(finalized.warnings ?? []),
      ])],
    },
  };
}

function appendFinalAnswerTiming(
  phaseTimings: TrustedTeacherResponse["phaseTimings"],
  durationMs: number,
  occurrenceCount: 0 | 1,
): NonNullable<TrustedTeacherResponse["phaseTimings"]> {
  const existing = phaseTimings ?? [];
  if (occurrenceCount === 0) return existing;
  const withoutTotal = existing.filter((item) => item.phase !== "total");
  const total = existing.findLast((item) => item.phase === "total");
  const answerTiming = {
    phase: "answer_generation" as const,
    durationMs: Math.max(0, durationMs),
    occurrences: occurrenceCount,
  };
  return [
    ...withoutTotal,
    answerTiming,
    ...(total ? [{ ...total, durationMs: total.durationMs + answerTiming.durationMs }] : []),
  ];
}

function appendFinalAnswerModelCall(
  modelCalls: TrustedTeacherResponse["modelCalls"],
  workerResult: import("./final-answer-worker.mjs").FinalAnswerWorkerResult,
): NonNullable<TrustedTeacherResponse["modelCalls"]> {
  const existing = modelCalls ?? [];
  return workerResult.modelCall ? [...existing, workerResult.modelCall] : existing;
}

function projectMainWorkerObservation(
  resources: ReturnType<typeof createRunResources>,
  task: TaskWorkingState,
  result: WorkerResult,
): MainWorkerObservation {
  const validation = result.validation;
  const unavailable = validation
    ? validation.official.syntax === "unavailable" || validation.official.semantic === "unavailable"
    : false;
  const validatorStatus: MainWorkerObservation["validator"]["status"] = !validation
    ? "not_run"
    : unavailable
      ? "unavailable"
      : validationPassed(validation)
        ? "passed"
        : "failed";
  const budget = resources.budget.view();
  return Object.freeze({
    version: "main-worker-observation-v1",
    action: Object.freeze({
      workerType: result.workerType,
      modeOrScope: result.workerType === "candidate" ? result.mode : result.scope,
      ...(task.workerType === "candidate" ? { subject: task.subject } : {}),
      ...(task.workerType === "candidate" && task.iterationDirective ? {
        directive: Object.freeze({
          contractId: task.iterationDirective.contractId,
          contractRevision: task.iterationDirective.contractRevision,
          taskSummary: task.iterationDirective.taskSummary,
          instruction: task.iterationDirective.instruction,
        }),
      } : {}),
    }),
    worker: Object.freeze({
      status: result.status,
      attemptCount: result.attemptCount,
      workPerformed: result.workPerformed,
    }),
    validator: Object.freeze({
      subject: result.validatorSubject,
      status: validatorStatus,
      diagnostics: Object.freeze((validation?.official.diagnostics ?? []).slice(0, 20).map((item) => Object.freeze({
        code: String(item.code ?? "").slice(0, 160),
        severity: String(item.severity ?? "").slice(0, 40),
        message: String(item.message ?? "").slice(0, 1_000),
      }))),
    }),
    ...(result.status === "validated_passed" ? {
      candidate: Object.freeze({
        changedFromBaseline: candidateChangedFromTaskBaseline(task, result.candidate),
        content: createCurrentValidatedCandidateBinding({
          runId: resources.runId, candidate: result.candidate, validation: result.validation,
          baselineModel: projectWorkerTaskView(resources, task).model,
        }).model.files.map((file) => `// ${file.displayName}\n${file.content}`).join("\n\n"),
      }),
    } : {}),
    budget: Object.freeze({
      phase: budget.phase,
      workRemainingMs: budget.workRemainingMs,
      remainingOperations: Object.freeze({ ...budget.remainingOperations }),
    }),
  });
}

function candidateChangedFromTaskBaseline(
  task: TaskWorkingState,
  candidate: CandidateArtifact,
): boolean {
  if (candidate.mode === "replace_entry") {
    return contentHash(candidate.content) !== candidate.baseHash;
  }
  if (candidate.mode === "standalone_model") return candidate.content.trim().length > 0;
  if (candidate.mode === "workspace_files") {
    const baseline = new Map(task.baseline.files.map((file) => [file.fileId, file.contentHash]));
    return candidate.files.some((file) => baseline.get(file.fileId) !== contentHash(file.content));
  }
  return candidate.edits.length > 0;
}

function projectMainAgentDelegation(
  outcome: Extract<MainAgentOutcome, { type: "delegate_candidate" | "delegate_repair" }>,
  questionHash: string,
): MainAgentDelegation {
  return outcome.type === "delegate_candidate"
    ? {
      version: "main-agent-delegation-v1",
      action: "candidate",
      mode: outcome.mode,
      subject: outcome.subject,
      taskSummary: outcome.taskSummary,
      instruction: outcome.instruction,
      questionHash,
      status: "accepted",
    }
    : {
      version: "main-agent-delegation-v1",
      action: "repair",
      scope: outcome.scope,
      questionHash,
      status: "accepted",
    };
}

function contentHash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function projectPreviousCandidateVersion(
  candidate: CandidateArtifact,
  modelFiles: AgentRunRequest["context"]["model"]["files"],
): NonNullable<NonNullable<TrustedTeacherResponse["engineeringReview"]>["previousVersion"]> {
  const displayNames = new Map(modelFiles.map((file) => [file.fileId, file.displayName]));
  if (candidate.mode === "standalone_model") {
    return {
      available: true,
      files: [{ filePath: candidate.fileName, content: candidate.content }],
    };
  }
  if (candidate.mode === "replace_entry") {
    const filePath = displayNames.get(candidate.fileId);
    return filePath
      ? { available: true, files: [{ filePath, content: candidate.content }] }
      : { available: false, files: [] };
  }
  if (candidate.mode === "workspace_files") {
    const files = candidate.files.flatMap((file) => {
      const filePath = displayNames.get(file.fileId);
      return filePath ? [{ filePath, content: file.content }] : [];
    });
    return files.length === candidate.files.length
      ? { available: true, files }
      : { available: false, files: [] };
  }
  // apply_edits 不是完整版本快照，不能安全地反向推导改进前工作区。
  return { available: false, files: [] };
}

function resumedTaskOutcome(
  outcome: Extract<MainAgentOutcome, { type: "resume_execution" }>,
  request: AgentRunRequest,
): Extract<MainAgentOutcome, { type: "delegate_candidate" | "delegate_repair" }> {
  const candidate = request.resumeContext?.execution?.worker.candidate;
  const standalone = Boolean(candidate && typeof candidate === "object"
    && !Array.isArray(candidate)
    && (candidate as { mode?: unknown }).mode === "standalone_model");
  if (outcome.action === "repair") {
    return {
      type: "delegate_repair",
      scope: standalone ? "standalone_model" : "active_file",
      acceptedToolCallId: outcome.acceptedToolCallId,
    };
  }
  return {
    type: "delegate_candidate",
    mode: standalone ? "create" : "refine",
    subject: standalone ? "standalone_model" : "current_workspace",
    taskSummary: request.taskContractContext?.contract.objectiveSummary || request.question,
    instruction: "复用服务端已持久化的候选和验证事实，继续当前任务；不重建已完成阶段。",
    acceptedToolCallId: outcome.acceptedToolCallId,
  };
}

function engineeringTaskSources(
  request: AgentRunRequest,
): AgentRunRequest["taskSources"] {
  return request.taskSources.map((source) => ({ ...source }));
}

function engineeringRevisionContextRequired(request: AgentRunRequest): boolean {
  const phase = request.resumeContext?.execution?.decision.phase;
  return phase === "candidate_ready"
    || phase === "validation_pending"
    || phase === "validation_failed"
    || phase === "repair_in_progress";
}

/** 只从Teacher服务端投影恢复Engineering Revision，不接受Main/客户端自报Issue。 */
function restoreEngineeringRevisionFromResume(
  request: AgentRunRequest,
  baselineCandidate: CandidateArtifact,
): ProductionWorkerHandlerOptions["engineeringRevision"] | undefined {
  const execution = request.resumeContext?.execution;
  const engineering = execution?.engineering;
  if (!execution
    || execution.decision.continuationKind !== "engineering_improvement"
    || engineering?.continuationKind !== "engineering_improvement") return undefined;

  const sources = request.taskSources;
  const authorizationHashes = new Set(sources.map((source) => source.taskAuthorizationRevisionHash));
  if (sources.length === 0
    || authorizationHashes.size !== 1
    || sources.some((source) => source.sourceHash !== resumeContentHash(source.text))) return undefined;

  const seenIssueIds = new Set<string>();
  const issues: NonNullable<ProductionWorkerHandlerOptions["engineeringRevision"]>["issues"][number][] = [];
  for (const raw of engineering.issueSummaries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const item = raw as Record<string, unknown>;
    const rawGoalRef = item.goalRef;
    if (!rawGoalRef || typeof rawGoalRef !== "object" || Array.isArray(rawGoalRef)) return undefined;
    const goalRef = rawGoalRef as Record<string, unknown>;
    const issueId = boundedResumeString(item.issueId, 200);
    const goalRefId = boundedResumeString(goalRef.goalRefId, 200);
    const sourceId = boundedResumeString(goalRef.sourceId, 200);
    const quote = boundedResumeString(goalRef.quote, 2_000);
    const sourceHash = boundedResumeString(goalRef.sourceHash, 80);
    const taskAuthorizationRevisionHash = boundedResumeString(goalRef.taskAuthorizationRevisionHash, 80);
    const issue = boundedResumeString(item.issue, 500);
    const suggestion = boundedResumeString(item.suggestion, 500);
    const start = goalRef.start;
    const end = goalRef.end;
    const source = sources.find((candidate) => candidate.sourceId === sourceId);
    if (!issueId || !goalRefId || !source || !quote || !issue || !suggestion
      || !Number.isInteger(start) || !Number.isInteger(end)
      || Number(start) < 0 || Number(end) <= Number(start) || Number(end) > source.text.length
      || source.text.slice(Number(start), Number(end)) !== quote
      || sourceHash !== source.sourceHash
      || taskAuthorizationRevisionHash !== source.taskAuthorizationRevisionHash
      || goalRefId !== resumeStableId("goal", `${sourceId}\n${sourceHash}\n${start}\n${end}`)
      || issueId !== resumeStableId("eri", `${goalRefId}\n${issue}\n${suggestion}`)
      || seenIssueIds.has(issueId)) return undefined;
    seenIssueIds.add(issueId);
    issues.push(Object.freeze({
      issueId,
      goalRefId,
      sourceId,
      goalQuote: quote,
      sourceHash,
      taskAuthorizationRevisionHash,
      start: Number(start),
      end: Number(end),
      issue,
      suggestion,
    }));
  }
  if (issues.length === 0) return undefined;
  return Object.freeze({
    baselineCandidateContent: projectedCandidateContent(baselineCandidate),
    issues: Object.freeze(issues),
  });
}

function restoreEngineeringBaselineFromResume(
  request: AgentRunRequest,
): Readonly<{ candidate: CandidateArtifact; validation: ValidationOutput }> | undefined {
  const engineering = request.resumeContext?.execution?.engineering;
  if (engineering?.continuationKind !== "engineering_improvement") return undefined;
  const candidate = validateCandidateInputSchema.safeParse(engineering.baselineCandidate);
  const validation = validationOutputSchema.safeParse(engineering.baselineValidation);
  if (!candidate.success || !validation.success || !validationPassed(validation.data)) return undefined;
  return Object.freeze({ candidate: candidate.data, validation: validation.data });
}

function projectedCandidateContent(candidate: CandidateArtifact): string {
  if (candidate.mode === "standalone_model" || candidate.mode === "replace_entry") return candidate.content;
  if (candidate.mode === "workspace_files") {
    return candidate.files.map((file) => `// ${file.fileId}\n${file.content}`).join("\n\n");
  }
  return candidate.edits.map((edit) => edit.replacement).join("\n\n");
}

function boundedResumeString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) return "";
  return value;
}

function resumeContentHash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function resumeStableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24)}`;
}

function workerCandidateContent(
  result: Extract<WorkerResult, { status: "validated_passed" }>,
): string {
  const candidate = result.candidate;
  if (candidate.mode === "standalone_model" || candidate.mode === "replace_entry") {
    return candidate.content;
  }
  if (candidate.mode === "workspace_files") {
    return candidate.files.map((file) => `// ${file.fileId}\n${file.content}`).join("\n\n");
  }
  return candidate.edits.map((edit) => edit.replacement).join("\n\n");
}

function repairRoundFromWorkerResult(result: WorkerResult, fallback: number): number {
  const rounds = result.repairTelemetry?.convergenceTrace.rounds ?? [];
  return rounds.reduce((maximum, round) => Math.max(maximum, round.round), fallback);
}

/** Checkpoint只记录收敛事实与上下文指标，不保存消息历史、reasoning或Candidate正文。 */
function projectRepairCheckpointState(result: WorkerResult): unknown {
  const telemetry = result.repairTelemetry;
  if (!telemetry) return undefined;
  return projectRepairTelemetryCheckpointState({
    contextAdmissions: telemetry.contextAdmissions,
    convergenceTrace: telemetry.convergenceTrace,
    noProgress: result.status === "exhausted" && result.reason === "repair_no_progress",
  });
}

async function persistRunCheckpoint(
  resources: ReturnType<typeof createRunResources>,
  dependencies: RunTeacherAgentOptions["dependencies"],
  boundary: Parameters<NonNullable<RunTeacherAgentOptions["dependencies"]["persistExecutionCheckpoint"]>>[0],
): Promise<unknown | undefined> {
  if (!dependencies.persistExecutionCheckpoint) return undefined;
  try {
    return await dependencies.persistExecutionCheckpoint(boundary);
  } catch {
    resources.recordOperationalWarning("execution_checkpoint_persistence_failed");
    return undefined;
  }
}

function settleRejectedDispatch(
  resources: ReturnType<typeof createRunResources>,
  taskId: string,
  reason: string,
): WorkerResult {
  const task = resources.tasks.get(taskId);
  if (!task) throw new Error("Rejected delegated Task disappeared from Run resources");
  const view = projectWorkerTaskView(resources, task);
  const status = reason === "cancelled" || reason === "deadline_exceeded"
    ? "cancelled" as const
    : reason === "budget_exhausted"
      ? "exhausted" as const
      : "worker_error" as const;
  const result = view.workerType === "candidate"
    ? createWorkerFailureResult({ task: view, status, reason, attemptCount: 0 })
    : createWorkerFailureResult({ task: view, status, reason, attemptCount: 0 });
  const current = resources.tasks.get(taskId);
  if (current && !["worker_completed", "worker_failed", "cancelled"].includes(current.status)) {
    resources.tasks.transition(taskId, current.revision, status === "cancelled"
      ? { type: "cancelled", reason }
      : { type: "worker_failed", reason });
  }
  return result;
}

function workerStopReason(
  result: WorkerResult,
  signals: {
    externalSignal?: AbortSignal;
    workDeadlineSignal: AbortSignal;
    hardDeadlineSignal: AbortSignal;
    workRemainingMs?: number;
  },
): TrustedTeacherResponse["stopReason"] {
  if (signals.externalSignal?.aborted) return "cancelled";
  if (signals.hardDeadlineSignal.aborted) return "hard_timeout";
  // SDK totalMs与Work Deadline使用同一时刻，SDK回调可能先于全局Timer几个毫秒返回。
  // 余额已经归零时必须按内部工作截止形成可信Partial，不能误归为Provider故障。
  if (signals.workDeadlineSignal.aborted || signals.workRemainingMs === 0) return "timeout";
  if (result.status === "validated_passed") return "completed";
  if (result.status === "cancelled") {
    if (signals.externalSignal?.aborted
      && !signals.workDeadlineSignal.aborted
      && !signals.hardDeadlineSignal.aborted) return "cancelled";
    return "timeout";
  }
  if (result.status === "worker_error" && result.reason === "repair_step_timeout") {
    return "repair_step_timeout";
  }
  if (result.reason === "validator_queue_full" || result.reason.includes("VALIDATOR_QUEUE_FULL")) return "validator_queue_full";
  if (result.reason === "validator_queue_timeout" || result.reason.includes("VALIDATOR_QUEUE_TIMEOUT")) return "validator_queue_timeout";
  if (result.reason === "validator_execution_timeout" || result.reason.includes("OFFICIAL_VALIDATOR_TIMEOUT")) return "validator_execution_timeout";
  if (result.reason.includes("is not allowed in")) return "timeout";
  if (result.reason === "validator_unavailable" || result.reason.startsWith("validator_unavailable:")) return "validator_unavailable";
  if (result.reason.startsWith("CANDIDATE_TARGET_READ_ONLY:")) return "policy_violation";
  if (result.status === "exhausted") return "step_limit";
  if (result.status === "worker_error") return "provider_error";
  return "completed";
}

function workerFailureWarnings(result: WorkerResult): string[] {
  if (result.status !== "worker_error") return [];
  if (result.reason.startsWith("CANDIDATE_TARGET_READ_ONLY:")) {
    return ["workflow_fail_closed:candidate_read_only_target"];
  }
  return [];
}

function isDeliverableInternalStop(reason: TrustedTeacherResponse["stopReason"]): boolean {
  return reason === "timeout"
    || reason === "hard_timeout"
    || reason === "step_limit"
    || reason === "repair_step_timeout"
    || reason === "validator_queue_full"
    || reason === "validator_queue_timeout"
    || reason === "validator_execution_timeout"
    || reason === "validator_unavailable";
}

function isDeliverableWorkerTerminal(
  result: WorkerResult,
  reason: TrustedTeacherResponse["stopReason"],
): boolean {
  return result.status !== "cancelled" || reason !== "cancelled";
}

export class RunDeadlineReachedError extends Error {
  readonly causeCode: RunStopCause;

  constructor(causeCode: Extract<RunStopCause, "work_deadline_reached" | "hard_deadline_reached">) {
    super(causeCode);
    this.name = "RunDeadlineReachedError";
    this.causeCode = causeCode;
  }
}

export function createRunDeadlineSignal(
  deadlineAtMs: number,
  cause: Extract<RunStopCause, "work_deadline_reached" | "hard_deadline_reached">,
): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new RunDeadlineReachedError(cause)),
    Math.max(1, deadlineAtMs - Date.now()),
  );
  timer.unref?.();
  return controller.signal;
}

function runStopCauseFromSignals(signals: {
  externalSignal?: AbortSignal;
  workDeadlineSignal: AbortSignal;
  hardDeadlineSignal: AbortSignal;
}): RunStopCause | undefined {
  if (signals.externalSignal?.aborted) return "caller_cancelled";
  if (signals.hardDeadlineSignal.aborted) return "hard_deadline_reached";
  if (signals.workDeadlineSignal.aborted) return "work_deadline_reached";
  return undefined;
}

function isInternalDeadlineOutcome(
  outcome: AgentRunOutcome,
  externalSignal: AbortSignal | undefined,
  workDeadlineSignal: AbortSignal,
  hardDeadlineSignal: AbortSignal,
): boolean {
  if (outcome.response.stopReason !== "timeout" && outcome.response.stopReason !== "cancelled") return false;
  // Caller取消始终不可交付。Provider/阶段自己的timeout可能比Run deadline计时器
  // 先一个event-loop tick返回；此时仍应走安全的incomplete投影，不能把元数据留成not_required。
  if (externalSignal?.aborted) return false;
  if (outcome.response.stopReason === "timeout") return true;
  return workDeadlineSignal.aborted || hardDeadlineSignal.aborted;
}

function classifyFinalAnswerFailureStopReason(
  finishReason: string,
  hardDeadlineSignal: AbortSignal,
): TrustedTeacherResponse["stopReason"] {
  if (hardDeadlineSignal.aborted) return "hard_timeout";
  const normalized = finishReason.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out")) return "timeout";
  if (normalized.includes("cancel")) return "cancelled";
  return "provider_error";
}

async function emitLifecycleWithinSignal(
  callback: RunTeacherAgentOptions["dependencies"]["onLifecycleEvent"] | undefined,
  event: AgentLifecycleEvent,
  abortSignal: AbortSignal,
): Promise<boolean> {
  if (!callback || abortSignal.aborted) return callback === undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(abortSignal.reason);
      abortSignal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(callback(event)).then(
        () => {
          abortSignal.removeEventListener("abort", onAbort);
          resolve();
        },
        (error) => {
          abortSignal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
    return true;
  } catch {
    return false;
  }
}

export const intentV2ExecutionTesting = Object.freeze({
  isDeliverableInternalStop,
  isDeliverableWorkerTerminal,
  isInternalDeadlineOutcome,
  classifyFinalAnswerFailureStopReason,
  finalAnswerTimeoutBudget,
  projectMainWorkerObservation,
  workerStopReason,
  workerFailureWarnings,
  runStopCauseFromSignals,
});
