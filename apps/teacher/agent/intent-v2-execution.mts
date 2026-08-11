import { createHash } from "node:crypto";

import { assembleTrustedResponse } from "./agent-response.mjs";
import { deriveEditorGrounding } from "./agent-policy.mjs";
import {
  runEngineeringSemanticAdvisory,
  type EngineeringReviewIssue,
} from "./engineering-semantic-advisory.mjs";
import { finalizeDelegatedAnswer } from "./main-finalizer.mjs";
import {
  createProductionWorkerHandlers,
  runResumedProductionExecution,
  type ProductionWorkerHandlerOptions,
} from "./production-worker-handlers.mjs";
import { bindFinalAnswer, bindWorkerResult } from "./result-binding.mjs";
import { createRunResources } from "./run-resources.mjs";
import {
  runIntentOrchestratorV2,
  v2GenerationSettings,
  v2RepairGenerationSettings,
} from "./intent-orchestrator-v2.mjs";
import type {
  AgentLifecycleEvent,
  AgentPolicy,
  AgentRunOutcome,
  AgentRunRequest,
  MainAgentOutcome,
  RunStopCause,
  RunTeacherAgentOptions,
  TrustedTeacherResponse,
} from "./types.mjs";
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

  if (mainOutcome?.type === "direct_answer") {
    const obligation = resources.obligations.freeze({ outcome: mainOutcome });
    outcome = await projectVisibleAnswer(options, {
      ...preflight,
      mainAgentOutcome: { type: "direct_answer", text: preflight.response.answer },
    });
    bindFinalAnswer({
      obligation,
      finalAnswer: outcome.response.answer,
      finalization: "direct_main_answer",
    });
    outcome.mainAgentOutcome = { type: "direct_answer", text: outcome.response.answer };
  } else if (mainOutcome?.type === "delegate_candidate"
    || mainOutcome?.type === "delegate_repair"
    || mainOutcome?.type === "resume_execution") {
    const candidateGeneration = v2GenerationSettings(options, false);
    const repairGeneration = v2RepairGenerationSettings(options);
    const taskOutcome = mainOutcome.type === "resume_execution"
      ? resumedTaskOutcome(mainOutcome, request)
      : mainOutcome;
    const task = resources.tasks.materialize({
      questionHash: resources.input.questionHash,
      outcome: taskOutcome,
      context: request.context,
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
    let selectedTask = task;
    let selectedTaskOutcome = taskOutcome;
    let advisoryWarnings: string[] = [];
    let finalizerAdvisory: Parameters<typeof finalizeDelegatedAnswer>[0]["advisory"];
    let engineeringReviewProjection: TrustedTeacherResponse["engineeringReview"];
    if (workerResult.status === "validated_passed"
      && (taskOutcome.type === "delegate_candidate" || engineeringContinuation)
      && (mainOutcome.type !== "resume_execution"
        || mainOutcome.action === "engineering_resume"
        || engineeringContinuation)) {
      const baselineWorkerResult = workerResult;
      const assessmentGeneration = v2GenerationSettings(options, false);
      const verificationGeneration = v2GenerationSettings(options, true);
      const mainDecisionGeneration = v2GenerationSettings(options, true);
      let revisionTask: typeof task | undefined;
      let revisionOutcome: Extract<MainAgentOutcome, { type: "delegate_candidate" }> | undefined;
      const advisory = await runEngineeringSemanticAdvisory({
        resources,
        baselineWorkerResult,
        taskSources: engineeringTaskSources(request),
        priorSuggestions: request.resumeContext?.execution?.engineering?.previousSuggestions,
        assessmentModel: options.semanticReviewModel ?? options.thinkingModel ?? options.model,
        assessmentModelId: options.semanticReviewModelId ?? options.thinkingModelId ?? options.modelId ?? "",
        mainModel: options.mainModel ?? options.model,
        mainModelId: options.mainModelId ?? options.modelId ?? "",
        assessmentProviderOptions: assessmentGeneration.providerOptions,
        verificationProviderOptions: verificationGeneration.providerOptions,
        mainProviderOptions: mainDecisionGeneration.providerOptions,
        abortSignal: workSignal,
        policy: {
          enabled: policy.semanticReviewEnabled && Boolean(options.semanticReviewModel),
          shadowOnly: policy.semanticReviewShadowOnly,
          assessmentMaxCalls: policy.semanticReviewAssessmentMaxCalls,
          assessmentTimeoutMs: policy.semanticReviewAssessmentTimeoutMs,
          mainDecisionTimeoutMs: policy.semanticReviewMainDecisionTimeoutMs,
          verificationMaxCalls: policy.semanticReviewVerificationMaxCalls,
          verificationTimeoutMs: policy.semanticReviewVerificationTimeoutMs,
          maxOutputTokens: policy.semanticReviewMaxOutputTokens,
          maxIssues: policy.semanticReviewMaxIssues,
          minimumCompleteChainMs: policy.semanticReviewMinimumCompleteChainMs,
          domainSearchReserveMs: policy.semanticReviewDomainSearchReserveMs,
        },
        reviseCandidate: async (issues: readonly EngineeringReviewIssue[]) => {
          const baselineContent = workerCandidateContent(baselineWorkerResult);
          const candidateMode = baselineWorkerResult.candidate.mode === "standalone_model"
            ? "milestone" as const
            : "refine" as const;
          revisionOutcome = {
            type: "delegate_candidate",
            mode: candidateMode,
            acceptedToolCallId: `${task.acceptedToolCallId}:engineering-revision`,
          };
          revisionTask = resources.tasks.materialize({
            questionHash: resources.input.questionHash,
            outcome: revisionOutcome,
            context: request.context,
          });
          const revisionDispatch = await dispatchWorker({
            resources,
            taskId: revisionTask.taskId,
            expectedRevision: revisionTask.revision,
            abortSignal: workSignal,
            workers: createProductionWorkerHandlers({
              ...workerOptions,
              engineeringRevision: {
                baselineCandidateContent: baselineContent,
                issues: issues.map((issue) => ({
                  issueId: issue.issueId,
                  goalRefId: issue.goalRef.goalRefId,
                  sourceId: issue.goalRef.sourceId,
                  goalQuote: issue.goalRef.quote,
                  sourceHash: issue.goalRef.sourceHash,
                  taskAuthorizationRevisionHash: issue.goalRef.taskAuthorizationRevisionHash,
                  start: issue.goalRef.start,
                  end: issue.goalRef.end,
                  issue: issue.issue,
                  suggestion: issue.suggestion,
                })),
              },
            }),
          });
          return revisionDispatch.type === "completed"
            ? revisionDispatch.result
            : settleRejectedDispatch(resources, revisionTask.taskId, revisionDispatch.reason);
        },
        onCheckpoint: async ({ phase, candidate, validation, metadata }) => await persistRunCheckpoint(
          resources,
          stageDependencies,
          { phase, candidate, validation, metadata },
        ),
      });
      workerResult = advisory.selectedWorkerResult;
      advisoryWarnings = [...advisory.warnings];
      finalizerAdvisory = {
        recommendation: advisory.recommendation,
        verification: advisory.verification,
        revisionDelivered: advisory.revisionDelivered,
        revisionAdopted: advisory.revisionAdopted,
        engineeringResolution: advisory.engineeringResolution,
        openSuggestions: advisory.openSuggestions.map((item) => ({ summary: item.summary })),
        issues: advisory.issues.map((issue) => ({
          goalQuote: issue.goalRef.quote,
          issue: issue.issue,
          suggestion: issue.suggestion,
        })),
      };
      engineeringReviewProjection = {
        assessmentStatus: advisory.assessmentStatus,
        recommendation: advisory.recommendation,
        verification: advisory.verification,
        executionPlacement: advisory.executionPlacement,
        engineeringCompletionStatus: advisory.engineeringCompletionStatus,
        revisionDelivered: advisory.revisionDelivered,
        revisionAdopted: advisory.revisionAdopted,
        engineeringResolution: advisory.engineeringResolution,
        openSuggestions: advisory.openSuggestions.map((item) => ({
          publicSuggestionId: item.publicSuggestionId,
          summary: item.summary,
        })),
        ...(advisory.revisionDelivered ? {
          previousVersion: projectPreviousCandidateVersion(
            baselineWorkerResult.candidate,
            request.context.model.files,
          ),
        } : {}),
        canContinue: workerResult.status === "validated_passed",
        pendingImprovement: advisory.pendingImprovement,
        assessmentCallCount: advisory.assessmentCallCount,
        mainReentryCallCount: advisory.mainReentryCallCount,
        revisionCycleCount: advisory.revisionCycleCount,
        verificationCallCount: advisory.verificationCallCount,
      };
      if (advisory.revisionDelivered && revisionTask && revisionOutcome) {
        selectedTask = revisionTask;
        selectedTaskOutcome = revisionOutcome;
      }
    }
    const obligation = resources.obligations.freeze({
      outcome: selectedTaskOutcome,
      task: selectedTask,
    });
    const workerBinding = bindWorkerResult(obligation, workerResult);
    if (workerResult.status === "validated_passed") {
      await persistRunCheckpoint(resources, stageDependencies, {
        phase: "finalization_pending",
        candidate: workerResult.candidate,
        validation: workerResult.validation,
        repairRound: repairRoundFromWorkerResult(
          workerResult,
          request.resumeContext?.execution?.decision.repairRound ?? 0,
        ),
        repairState: projectRepairCheckpointState(workerResult),
      });
    }
    const finalizerGeneration = v2GenerationSettings(options, true);
    const finalizer = await finalizeDelegatedAnswer({
      resources,
      binding: workerBinding,
      model: options.finalizerModel ?? options.nonThinkingModel ?? options.model,
      abortSignal: finalizationSignal,
      timeoutMs: Math.max(1, Math.min(
        policy.terminalReserveMs,
        resources.budget.view().hardRemainingMs,
      )),
      maxOutputTokens: policy.mediumAnswerMaxOutputTokens,
      reasoning: finalizerGeneration.reasoning,
      providerOptions: finalizerGeneration.providerOptions,
      ...(finalizerAdvisory ? { advisory: finalizerAdvisory } : {}),
    });
    const budget = resources.budget.view();
    const stopReason = workerStopReason(workerResult, {
      externalSignal: options.abortSignal,
      workDeadlineSignal,
      hardDeadlineSignal,
      workRemainingMs: budget.workRemainingMs,
    });
    const stopCause = runStopCauseFromSignals({
      externalSignal: options.abortSignal,
      workDeadlineSignal,
      hardDeadlineSignal,
    }) ?? (budget.workRemainingMs <= 0 ? "work_deadline_reached" : undefined);
    const assembled = assembleTrustedResponse({
      modelText: finalizer.answer,
      workflowVersion: "intent-orchestrator-v2",
      finishReason: finalizer.finishReason,
      stepCount: preflight.response.stepCount + workerResult.attemptCount + 1,
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
        ...advisoryWarnings,
        ...resources.operationalWarnings(),
        ...(finalizer.finalization === "deterministic_fallback"
          ? [`main_finalizer_fallback:${finalizer.finishReason}`]
          : []),
      ],
      ...(stopCause ? { stopCause } : {}),
    }, resources.ledger.snapshot(), {
      grounding: deriveEditorGrounding(request.context),
      suppressGroundingDisclosure: true,
      stripInternalProcessNarration: true,
    });
    const response: TrustedTeacherResponse = {
      ...preflight.response,
      ...assembled,
      mainAgentDelegation: preflight.response.mainAgentDelegation,
      answerCompletionStatus: workerResult.status === "validated_passed" ? "complete" : "incomplete",
      phaseTimings: preflight.response.phaseTimings,
      modelCalls: preflight.response.modelCalls,
      warnings: [...new Set([...preflight.response.warnings, ...assembled.warnings])],
      ...(engineeringReviewProjection ? { engineeringReview: engineeringReviewProjection } : {}),
    };
    outcome = await projectVisibleAnswer(options, {
      // Worker失败只关闭候选发布能力，不关闭已经形成的教学响应。
      // 唯一例外是调用方主动取消：此时不得把迟到的降级文本当作本轮交付。
      ok: isDeliverableWorkerTerminal(workerResult, stopReason),
      response,
      ledger: resources.ledger.snapshot(),
      mainAgentOutcome: mainOutcome,
    });
    bindFinalAnswer({
      obligation,
      workerResult,
      finalAnswer: outcome.response.answer,
      finalization: finalizer.finalization,
    });
  } else if (isInternalDeadlineOutcome(preflight, options.abortSignal, workDeadlineSignal, hardDeadlineSignal)) {
    outcome = await projectVisibleAnswer(options, {
      ...preflight,
      ok: true,
      response: {
        ...preflight.response,
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
): Promise<void> {
  if (!dependencies.persistExecutionCheckpoint) return;
  try {
    await dependencies.persistExecutionCheckpoint(boundary);
  } catch {
    resources.recordOperationalWarning("execution_checkpoint_persistence_failed");
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
  if (outcome.response.stopReason !== "timeout") return false;
  if (externalSignal?.aborted && !workDeadlineSignal.aborted && !hardDeadlineSignal.aborted) return false;
  return true;
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
  workerStopReason,
  workerFailureWarnings,
  runStopCauseFromSignals,
});
