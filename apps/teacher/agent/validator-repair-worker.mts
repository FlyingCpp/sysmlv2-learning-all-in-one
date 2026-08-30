import { createHash } from "node:crypto";

import {
  pruneMessages,
  ToolLoopAgent,
  stepCountIs,
  tool,
  type LanguageModel,
  type LanguageModelCallStartEvent,
  type LanguageModelUsage,
  type ModelMessage,
} from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import { z } from "zod";

import {
  searchReviewedKnowledgeInputSchema,
  type CandidateStructureEvidence,
  type ValidationOutput,
} from "./types.mjs";
import { recordModelGeneration } from "./model-call-audit.mjs";
import {
  createRunExecutionView,
  type KnowledgeView,
  type RunExecutionView,
  type RunResources,
} from "./run-resources.mjs";
import type { WorkerTaskView } from "./worker-contracts.mjs";
import type { TaskWorkingState } from "./task-working-state.mjs";
import {
  computeDiagnosticDelta,
  createInitialDiagnosticDelta,
  createRepairIssueSet,
  summarizeCandidateChanges,
  toRepairRoundTrace,
  type CandidateChangeSummary,
  type DiagnosticDelta,
  type RepairIssueSet,
  type RepairRoundTrace,
} from "./repair-convergence.mjs";

const KNOWLEDGE_MODEL_VIEW_TOKEN_BUDGET = 3_000;
const CONTEXT_SAFETY_TOKENS = 4_000;
const REPAIR_RESUME_VIEW_RESERVE_TOKENS = 8_000;
const CHECKPOINT_ISSUE_SAMPLE_LIMIT = 8;
const CHECKPOINT_CLUSTER_SUMMARY_LIMIT = 12;
const CHECKPOINT_CHANGE_SAMPLE_LIMIT = 8;
const CHECKPOINT_ROUND_LIMIT = 12;

export type RepairWorkerTerminalStopReason =
  | "validator_passed"
  | "candidate_budget_exhausted"
  | "validator_budget_exhausted"
  | "repair_context_budget_exhausted"
  | "repair_context_not_admitted"
  | "repair_time_budget_exhausted"
  | "repair_no_progress"
  | "validator_queue_full"
  | "validator_queue_timeout"
  | "validator_execution_timeout"
  | "validator_unavailable"
  | "model_terminated_without_candidate"
  | "step_budget_exhausted";

export interface ValidatorRepairWorkerOptions<CANDIDATE> {
  model: LanguageModel;
  instructions: string;
  taskMessages: readonly ModelMessage[];
  taskContext?: unknown;
  abortSignal: AbortSignal;
  timeoutMs: number;
  toolTimeoutMs: number;
  contextWindowTokens: number;
  maxCandidateAttempts: number;
  maxRepairRounds?: number;
  maxKnowledgeQueries?: number;
  maxCandidateArtifactBytes?: number;
  maxValidatorCalls: number;
  initialValidatorCalls: number;
  initialValidation?: ValidationOutput;
  initialCandidateContent: string;
  targetBinding: {
    mode: "standalone_model" | "replace_entry";
    fileId?: string;
    baseHash?: string;
  };
  knowledgeSearchEnabled: boolean;
  evaluationMode?: "production" | "local_benchmark";
  temperature?: number;
  reasoning?: "none" | "medium" | "high" | "xhigh";
  providerOptions?: SharedV4ProviderOptions;
  /** Provider是否支持显式tool_choice；DeepSeek V4 Thinking必须为false。 */
  explicitToolChoice?: boolean;
  /** 来自同一Run工作台的只读证据索引；不复制完整Tool输出。 */
  initialKnowledge?: KnowledgeView;
  runtimeContext?: RunExecutionView;
  /** Slice C新链绑定；兼容旧Runtime时两者均省略。 */
  runResources?: RunResources;
  taskView?: WorkerTaskView;
  searchReviewedKnowledge: (input: {
    query: string;
    toolCallId: string;
    roundEpoch: number;
    queryOrdinalThisRound: number;
    maxQueriesThisRound: number;
    alreadyProvidedClaimIds: string[];
    alreadyProvidedEvidenceIds: string[];
    abortSignal?: AbortSignal;
  }) => Promise<unknown>;
  recordKnowledgeQueryAudit?: (input: {
    query: string;
    toolCallId: string;
    roundEpoch: number;
    status: "duplicate_query";
  }) => Promise<void>;
  validateCandidate: (input: {
    content: string;
    contentHash: string;
    toolCallId: string;
    roundEpoch: number;
    abortSignal?: AbortSignal;
  }) => Promise<RepairWorkerValidation<CANDIDATE>>;
  validationPassed: (validation: ValidationOutput) => boolean;
  validationRetryable: (validation: ValidationOutput) => boolean;
  /**
   * 将已完成的Repair进度投影给服务端Checkpoint。投影只含收敛事实和计数，
   * 不含Candidate正文、消息历史或reasoning；持久化失败不得改变Repair业务结果。
   */
  onCheckpointProgress?: (progress: RepairWorkerCheckpointProgress) => Promise<void> | void;
}

export interface RepairWorkerValidation<CANDIDATE> {
  candidate: CANDIDATE;
  validation: ValidationOutput;
}

export interface ValidatorRepairWorkerResult<CANDIDATE> {
  accepted?: RepairWorkerValidation<CANDIDATE> & {
    content: string;
    contentHash: string;
    toolCallId: string;
  };
  usage: LanguageModelUsage;
  finishReason: string;
  steps: readonly unknown[];
  candidateCharLimit: number;
  terminalStopReason: RepairWorkerTerminalStopReason;
  validatorCalls: number;
  candidateAttempts: number;
  candidateSubmissionCalls: number;
  timeToFirstCandidateSubmissionMs?: number;
  knowledgeQueriesBeforeFirstCandidateSubmission: number;
  candidateRepeatedCount: number;
  consecutiveNoProgress: number;
  toolInputInvalidCount: number;
  knowledgeQueries: number;
  knowledgeBackendCalls: number;
  knowledgeNoNewEvidenceCount: number;
  knowledgeQueriesByRound: Array<{ round: number; queries: number }>;
  contextAdmissions: Array<{
    stepNumber: number;
    roundEpoch: number;
    estimatedInputTokensBeforePrune: number;
    estimatedInputTokens: number;
    prunedInputTokens: number;
    messageCountBeforePrune: number;
    messageCountAfterSdkPrune: number;
    messageCountAfterPrune: number;
    latestCandidateOccurrences: number;
    visibleOutputReserveTokens: number;
    projectedTokens: number;
    remainingTokens: number;
    knowledgeQueriesThisRound: number;
    candidateAttempts: number;
    activeTools: Array<"search_reviewed_knowledge" | "submit_candidate_for_validation">;
    stopReason?: RepairWorkerTerminalStopReason;
  }>;
  convergenceTrace: {
    initialIssueSet?: RepairIssueSet;
    latestIssueSet?: RepairIssueSet;
    latestDiagnosticDelta?: DiagnosticDelta;
    latestCandidateChangeSummary?: CandidateChangeSummary;
    rounds: RepairRoundTrace[];
  };
  evaluationTrace?: {
    knowledgeQueries: Array<{
      round: number;
      query: string;
      backendExecuted: boolean;
      status: "ok" | "no_new_evidence" | "knowledge_unavailable" | "completed_for_prior_round";
      newClaimIds: string[];
      newEvidenceIds: string[];
    }>;
    failedCandidates: Array<{
      round: number;
      content: string;
      contentHash: string;
      toolCallId: string;
      validatorEvidenceHash?: string;
      diagnostics: Array<{ code?: string; message: string; severity: string }>;
    }>;
  };
  attempts: Array<{
    round: number;
    status: "rejected" | "validated_failed" | "validated_passed";
    candidateHash?: string;
    rejectionReason?: string;
    toolCallId?: string;
    targetMode?: "standalone_model" | "replace_entry";
    targetFileId?: string;
    baseHash?: string;
    inputContentHash?: string;
    candidateWorkspaceHash?: string;
    validatorEvidenceHash?: string;
    structureEvidenceSource?: CandidateStructureEvidence["source"];
    structureEvidenceStatus?: CandidateStructureEvidence["status"];
    structureEvidenceContentHash?: string;
    structureEvidenceTruncated?: boolean;
    diagnosticTotal?: number;
    diagnosticIncluded?: number;
    diagnosticTruncated?: boolean;
  }>;
}

export type RepairCheckpointState = ReturnType<typeof projectRepairTelemetryCheckpointState>;

export interface RepairWorkerCheckpointProgress {
  boundary: "context_admission" | "validator_completed" | "terminal";
  repairState: RepairCheckpointState;
}

class RepairWorkerControlledStop extends Error {
  constructor(readonly reason: RepairWorkerTerminalStopReason) {
    super(reason);
    this.name = "RepairWorkerControlledStop";
  }
}

/**
 * Repair内部唯一的Agent loop。LLM只提交完整候选文本；目标、hash、Validator和发布仍由服务端回调控制。
 */
export async function runValidatorRepairWorker<CANDIDATE>(
  options: ValidatorRepairWorkerOptions<CANDIDATE>,
): Promise<ValidatorRepairWorkerResult<CANDIDATE>> {
  const taskMessages = [...options.taskMessages];
  const sharedTask = resolveSharedRepairTask(options);
  const initialKnowledge = options.initialKnowledge
    ?? options.taskView?.knowledge;
  const runtimeContext = options.runtimeContext
    ?? (sharedTask && options.runResources
      ? createRunExecutionView(options.runResources, "repair")
      : undefined);
  const startedAt = Date.now();
  const stageDeadlineAtMs = startedAt + options.timeoutMs;
  const maxRepairRounds = Math.max(0, options.maxRepairRounds ?? options.maxCandidateAttempts);
  const maxKnowledgeQueries = Math.max(0, options.maxKnowledgeQueries ?? options.maxValidatorCalls);
  const maxCandidateArtifactBytes = Math.max(1, options.maxCandidateArtifactBytes ?? Number.MAX_SAFE_INTEGER);
  const maxToolLoopSteps = options.maxValidatorCalls + maxKnowledgeQueries + 1;
  const candidateCharLimit = deriveRepairCandidateCharLimit(options, maxCandidateArtifactBytes);
  if (maxRepairRounds < 1 || options.maxCandidateAttempts < 1) {
    return emptyResult(options, candidateCharLimit, "candidate_budget_exhausted");
  }
  if (candidateCharLimit < 1
    || options.initialCandidateContent.length > candidateCharLimit
    || Buffer.byteLength(options.initialCandidateContent, "utf8") > maxCandidateArtifactBytes) {
    return emptyResult(options, candidateCharLimit, "repair_context_not_admitted");
  }
  const initialCandidateHash = hashContent(options.initialCandidateContent);
  const initialIssueSet = options.initialValidation
    ? createRepairIssueSet(options.initialValidation, initialCandidateHash)
    : undefined;
  const initialDiagnosticDelta = initialIssueSet
    ? createInitialDiagnosticDelta(initialIssueSet)
    : undefined;
  const initialSharedKnowledgeBodiesAdmitted = !initialIssueSet?.activeCluster;

  const session = {
    accepted: undefined as ValidatorRepairWorkerResult<CANDIDATE>["accepted"],
    terminalStopReason: undefined as RepairWorkerTerminalStopReason | undefined,
    validatorCalls: options.initialValidatorCalls,
    maxValidatorCalls: options.maxValidatorCalls,
    maxKnowledgeQueries,
    candidateAttempts: 0,
    candidateSubmissionCalls: 0,
    timeToFirstCandidateSubmissionMs: undefined as number | undefined,
    knowledgeQueriesBeforeFirstCandidateSubmission: 0,
    candidateRepeatedCount: 0,
    consecutiveNoProgress: 0,
    toolInputInvalidCount: 0,
    knowledgeQueries: 0,
    knowledgeBackendCalls: 0,
    knowledgeNoNewEvidenceCount: 0,
    roundEpoch: 1,
    activeStepEpoch: 1,
    validationInFlight: false,
    searchInFlightByEpoch: new Set<number>(),
    queriesByEpoch: new Map<number, number>([[1, 0]]),
    queryHashesByEpoch: new Map<number, Set<string>>([[1, new Set<string>()]]),
    searchClosedByEpoch: new Set<number>(
      hasActionableValidationDiagnostics(options.initialValidation)
        && shouldCloseRepairSearch(initialIssueSet, initialKnowledge, 0)
        ? [1]
        : [],
    ),
    providedClaimIds: new Set<string>(
      initialSharedKnowledgeBodiesAdmitted ? initialKnowledge?.disclosedClaimIds ?? [] : [],
    ),
    providedEvidenceIds: new Set<string>(
      initialSharedKnowledgeBodiesAdmitted ? initialKnowledge?.disclosedEvidenceIds ?? [] : [],
    ),
    providedEvidenceSpanIds: new Set<string>(
      initialSharedKnowledgeBodiesAdmitted ? initialKnowledge?.disclosedEvidenceSpanIds ?? [] : [],
    ),
    evidenceCache: new Map<string, CachedEvidence>(),
    contextAdmissions: [] as ValidatorRepairWorkerResult<CANDIDATE>["contextAdmissions"],
    evaluationKnowledgeQueries: [] as NonNullable<ValidatorRepairWorkerResult<CANDIDATE>["evaluationTrace"]>["knowledgeQueries"],
    evaluationFailedCandidates: [] as NonNullable<ValidatorRepairWorkerResult<CANDIDATE>["evaluationTrace"]>["failedCandidates"],
    candidateHashes: new Set<string>([initialCandidateHash]),
    latestCandidateContent: options.initialCandidateContent,
    latestCandidateHash: initialCandidateHash,
    latestIssueSet: initialIssueSet,
    latestDiagnosticDelta: initialDiagnosticDelta,
    latestCandidateChangeSummary: undefined as CandidateChangeSummary | undefined,
    latestStructureEvidence: options.initialValidation
      ? structureEvidenceForModel(options.initialValidation)
      : undefined as CandidateStructureEvidence | undefined,
    resolvedIssueIds: new Set<string>(),
    convergenceRounds: [] as RepairRoundTrace[],
    resumeKnowledgeEvidence: [] as unknown[],
    lastFailedValidationSignature: options.initialValidation
      ? validationFailureSignature(options.initialValidation)
      : undefined as string | undefined,
    attempts: [] as ValidatorRepairWorkerResult<CANDIDATE>["attempts"],
  };

  const repairCheckpointState = (): RepairCheckpointState => projectRepairTelemetryCheckpointState({
    contextAdmissions: session.contextAdmissions,
    convergenceTrace: {
      ...(initialIssueSet ? { initialIssueSet } : {}),
      ...(session.latestIssueSet ? { latestIssueSet: session.latestIssueSet } : {}),
      ...(session.latestDiagnosticDelta
        ? { latestDiagnosticDelta: session.latestDiagnosticDelta }
        : {}),
      ...(session.latestCandidateChangeSummary
        ? { latestCandidateChangeSummary: session.latestCandidateChangeSummary }
        : {}),
      rounds: session.convergenceRounds,
    },
    noProgress: session.terminalStopReason === "repair_no_progress",
  });
  const emitCheckpointProgress = async (
    boundary: RepairWorkerCheckpointProgress["boundary"],
  ): Promise<void> => {
    if (!options.onCheckpointProgress) return;
    try {
      await options.onCheckpointProgress({ boundary, repairState: repairCheckpointState() });
    } catch {
      options.runResources?.recordOperationalWarning("execution_checkpoint_persistence_failed");
    }
  };

  // 生产路径只读取单一Run Resource Controller的Work Deadline；独立调用保留
  // options.timeoutMs作为没有Run资源对象时的边界。
  const remainingMs = () => options.runResources
    ? options.runResources.budget.view().workRemainingMs
    : stageDeadlineAtMs - Date.now();
  const stopForTime = (): boolean => {
    if (remainingMs() > 0) return false;
    session.terminalStopReason = "repair_time_budget_exhausted";
    return true;
  };

  const searchReviewedKnowledge = tool({
    description: "查询受审核SysML v2知识。仅在当前模型和Validator诊断不足以确定修复语义时调用；所有Repair轮次共享Run知识预算。",
    strict: true,
    inputSchema: searchReviewedKnowledgeInputSchema,
    execute: async (input, execution) => {
      options.runResources?.assertAdmitted("knowledge_search");
      const callEpoch = session.activeStepEpoch;
      const used = session.queriesByEpoch.get(callEpoch) ?? 0;
      if (callEpoch !== session.roundEpoch) {
        return { status: "stale_round", roundEpoch: callEpoch };
      }
      if (session.validationInFlight) {
        return { status: "validation_in_flight", roundEpoch: callEpoch };
      }
      if (!options.runResources && session.knowledgeQueries >= maxKnowledgeQueries) {
        return { status: "budget_exhausted", roundEpoch: callEpoch };
      }
      if (session.searchClosedByEpoch.has(callEpoch)) {
        return { status: "evidence_sufficient", roundEpoch: callEpoch };
      }
      if (session.searchInFlightByEpoch.has(callEpoch)) {
        return { status: "search_in_flight", roundEpoch: callEpoch };
      }
      if (stopForTime()) {
        return { status: "time_budget_exhausted", roundEpoch: callEpoch };
      }
      session.searchInFlightByEpoch.add(callEpoch);
      try {
      session.queriesByEpoch.set(callEpoch, used + 1);
      session.knowledgeQueries += 1;
      const queryOrdinalThisRound = used + 1;
      const normalizedQueryHash = hashContent(normalizeKnowledgeQuery(input.query));
      const roundQueryHashes = session.queryHashesByEpoch.get(callEpoch) ?? new Set<string>();
      session.queryHashesByEpoch.set(callEpoch, roundQueryHashes);
      const duplicateQuery = roundQueryHashes.has(normalizedQueryHash);
      roundQueryHashes.add(normalizedQueryHash);

      let projection: ReturnType<typeof knowledgeResultForModel>;
      let backendExecuted = false;
      let status: "ok" | "no_new_evidence" | "knowledge_unavailable" | "completed_for_prior_round";
      if (duplicateQuery) {
        await options.recordKnowledgeQueryAudit?.({
          query: input.query,
          toolCallId: execution.toolCallId,
          roundEpoch: callEpoch,
          status: "duplicate_query",
        });
        projection = knowledgeResultForModel(
          { no_new_evidence: true },
          input.query,
          session.providedClaimIds,
          session.providedEvidenceIds,
          session.evidenceCache,
          session.providedEvidenceSpanIds,
        );
        status = projection.modelResult.no_new_evidence ? "no_new_evidence" : "ok";
      } else {
        try {
          backendExecuted = true;
          session.knowledgeBackendCalls += 1;
          const result = await options.searchReviewedKnowledge({
            query: input.query,
            toolCallId: execution.toolCallId,
            roundEpoch: callEpoch,
            queryOrdinalThisRound,
            maxQueriesThisRound: maxKnowledgeQueries,
            alreadyProvidedClaimIds: [...session.providedClaimIds],
            alreadyProvidedEvidenceIds: [...session.providedEvidenceIds],
            abortSignal: execution.abortSignal,
          });
          projection = knowledgeResultForModel(
            result,
            input.query,
            session.providedClaimIds,
            session.providedEvidenceIds,
            session.evidenceCache,
            session.providedEvidenceSpanIds,
          );
          status = callEpoch === session.roundEpoch
            ? (projection.modelResult.no_new_evidence ? "no_new_evidence" : "ok")
            : "completed_for_prior_round";
        } catch {
          projection = knowledgeResultForModel(
            { no_new_evidence: true },
            input.query,
            session.providedClaimIds,
            session.providedEvidenceIds,
            session.evidenceCache,
            session.providedEvidenceSpanIds,
          );
          status = "knowledge_unavailable";
        }
      }
      for (const claimId of projection.newClaimIds) session.providedClaimIds.add(claimId);
      for (const evidenceId of projection.newEvidenceIds) session.providedEvidenceIds.add(evidenceId);
      for (const spanId of projection.newEvidenceSpanIds) session.providedEvidenceSpanIds.add(spanId);
      if (projection.newClaimIds.length > 0 || projection.newEvidenceSpanIds.length > 0) {
        // prepareStep会清理旧Tool消息；只把最新一次、已经按Token预算投影的证据带入续跑视图。
        session.resumeKnowledgeEvidence.splice(0, session.resumeKnowledgeEvidence.length, projection.modelResult);
      }
      if (projection.modelResult.no_new_evidence) session.knowledgeNoNewEvidenceCount += 1;
      if (projection.modelResult.no_new_evidence || projection.modelResult.coverage === "COMPLETE") {
        session.searchClosedByEpoch.add(callEpoch);
      }
      if (options.evaluationMode === "local_benchmark") {
        session.evaluationKnowledgeQueries.push({
          round: callEpoch,
          query: boundedText(input.query, 1_000),
          backendExecuted,
          status,
          newClaimIds: projection.newClaimIds,
          newEvidenceIds: projection.newEvidenceIds,
        });
      }
      return {
        status,
        roundEpoch: callEpoch,
        remainingKnowledgeQueriesThisRound: options.runResources
          ? options.runResources.knowledge.reviewedKnowledgeQueryBudget().remainingNewQueries
          : Math.max(0, maxKnowledgeQueries - session.knowledgeQueries),
        result: projection.modelResult,
      };
      } finally {
        session.searchInFlightByEpoch.delete(callEpoch);
      }
    },
  });

  const submitCandidateForValidation = tool({
    description: "提交一份完整、可独立验证的SysML v2候选模型。只填写完整候选文本；不要填写ID、hash、状态、Patch、diff或发布字段。",
    strict: true,
    inputSchema: z.object({
      content: z.string().min(1).max(candidateCharLimit),
    }).strict(),
    execute: async (input, execution) => {
      options.runResources?.assertAdmitted("repair_submit");
      const callEpoch = session.activeStepEpoch;
      if (session.timeToFirstCandidateSubmissionMs === undefined) {
        session.timeToFirstCandidateSubmissionMs = Date.now() - startedAt;
        session.knowledgeQueriesBeforeFirstCandidateSubmission = session.knowledgeQueries;
      }
      session.candidateSubmissionCalls += 1;
      if (!input.content.trim()) {
        session.attempts.push({
          round: callEpoch,
          status: "rejected",
          rejectionReason: "candidate_empty",
          toolCallId: execution.toolCallId,
          ...targetAudit(options.targetBinding),
        });
        return candidateActionResult("candidate_invalid", "候选内容为空。", session, callEpoch);
      }
      if (Buffer.byteLength(input.content, "utf8") > maxCandidateArtifactBytes) {
        session.attempts.push({
          round: callEpoch,
          status: "rejected",
          rejectionReason: "candidate_artifact_too_large",
          toolCallId: execution.toolCallId,
          ...targetAudit(options.targetBinding),
        });
        return candidateActionResult(
          "candidate_invalid",
          "候选内容超过 UTF-8 Artifact 字节上限。",
          session,
          callEpoch,
        );
      }
      if (session.validationInFlight) {
        return candidateActionResult("validation_in_flight", "已有候选正在验证。", session, callEpoch);
      }
      if (session.candidateAttempts >= options.maxCandidateAttempts) {
        session.terminalStopReason = "candidate_budget_exhausted";
        return candidateActionResult("candidate_budget_exhausted", "候选预算已耗尽。", session, callEpoch);
      }
      if (session.validatorCalls >= options.maxValidatorCalls) {
        session.terminalStopReason = "validator_budget_exhausted";
        return candidateActionResult("validator_budget_exhausted", "Validator预算已耗尽。", session, callEpoch);
      }
      if (stopForTime()) {
        return candidateActionResult("time_budget_exhausted", "Repair时间预算已耗尽。", session, callEpoch);
      }

      const contentHash = hashContent(input.content);
      if (session.candidateHashes.has(contentHash)) {
        session.candidateRepeatedCount += 1;
        session.attempts.push({
          round: callEpoch,
          status: "rejected",
          candidateHash: contentHash,
          rejectionReason: "candidate_hash_repeated",
          toolCallId: execution.toolCallId,
          inputContentHash: contentHash,
          ...targetAudit(options.targetBinding),
        });
        return candidateActionResult("candidate_repeated", "该候选与已验证或初始候选完全相同。", session, callEpoch);
      }

      session.validationInFlight = true;
      session.candidateHashes.add(contentHash);
      session.candidateAttempts += 1;
      session.validatorCalls += 1;
      try {
        const observation = await options.validateCandidate({
          content: input.content,
          contentHash,
          toolCallId: execution.toolCallId,
          roundEpoch: callEpoch,
          abortSignal: execution.abortSignal,
        });
        const nextStructureEvidence = structureEvidenceForModel(observation.validation);
        const candidateChangeSummary = summarizeCandidateChanges({
          previousContent: session.latestCandidateContent,
          nextContent: input.content,
          previousStructure: session.latestStructureEvidence,
          nextStructure: nextStructureEvidence,
          activeCluster: session.latestIssueSet?.activeCluster,
        });
        const nextIssueSet = createRepairIssueSet(observation.validation, contentHash);
        const diagnosticDelta = session.latestIssueSet
          ? computeDiagnosticDelta(
            session.latestIssueSet,
            nextIssueSet,
            session.resolvedIssueIds,
          )
          : createInitialDiagnosticDelta(nextIssueSet);
        for (const issue of diagnosticDelta.resolved) session.resolvedIssueIds.add(issue.issueId);
        session.latestCandidateContent = input.content;
        session.latestCandidateHash = contentHash;
        session.latestIssueSet = nextIssueSet;
        session.latestDiagnosticDelta = diagnosticDelta;
        session.latestCandidateChangeSummary = candidateChangeSummary;
        session.latestStructureEvidence = nextStructureEvidence;
        session.convergenceRounds.push(toRepairRoundTrace({
          round: callEpoch,
          issueSet: nextIssueSet,
          diagnosticDelta,
          changeSummary: candidateChangeSummary,
        }));
        if (options.validationPassed(observation.validation)) {
          session.accepted = {
            ...observation,
            content: input.content,
            contentHash,
            toolCallId: execution.toolCallId,
          };
          session.terminalStopReason = "validator_passed";
          session.attempts.push({
            round: callEpoch,
            status: "validated_passed",
            candidateHash: contentHash,
            toolCallId: execution.toolCallId,
            inputContentHash: contentHash,
            ...targetAudit(options.targetBinding),
            ...validationAudit(observation.validation),
          });
          await emitCheckpointProgress("validator_completed");
          return {
            status: "passed",
            structure: nextStructureEvidence,
            repairIssueSet: repairIssueSetForModel(nextIssueSet),
            diagnosticDelta: diagnosticDeltaForModel(diagnosticDelta),
            candidateChangeSummary: candidateChangeSummaryForModel(candidateChangeSummary),
            remainingValidatorCalls: Math.max(0, options.maxValidatorCalls - session.validatorCalls),
          };
        }
        if (!options.validationRetryable(observation.validation)) {
          const stopReason = validatorFailureStopReason(observation.validation);
          session.terminalStopReason = stopReason;
          session.attempts.push({
            round: callEpoch,
            status: "validated_failed",
            candidateHash: contentHash,
            toolCallId: execution.toolCallId,
            inputContentHash: contentHash,
            ...targetAudit(options.targetBinding),
            ...validationAudit(observation.validation),
          });
          await emitCheckpointProgress("validator_completed");
          return candidateActionResult(
            stopReason,
            "官方Validator未返回可继续修复的可信结论。",
            session,
            callEpoch,
          );
        }
        session.attempts.push({
          round: callEpoch,
          status: "validated_failed",
          candidateHash: contentHash,
          toolCallId: execution.toolCallId,
          inputContentHash: contentHash,
          ...targetAudit(options.targetBinding),
          ...validationAudit(observation.validation),
        });
        const failedValidationSignature = validationFailureSignature(observation.validation);
        session.consecutiveNoProgress = session.lastFailedValidationSignature === failedValidationSignature
          ? session.consecutiveNoProgress + 1
          : 0;
        session.lastFailedValidationSignature = failedValidationSignature;
        if (session.consecutiveNoProgress >= 2) {
          session.terminalStopReason = "repair_no_progress";
        }
        if (options.evaluationMode === "local_benchmark") {
          const diagnostics = diagnosticsForModel(observation.validation);
          session.evaluationFailedCandidates.push({
            round: callEpoch,
            content: input.content,
            contentHash,
            toolCallId: execution.toolCallId,
            validatorEvidenceHash: observation.validation.validator.evidenceHash,
            diagnostics: diagnostics.items.map((item) => ({
              ...(item.code ? { code: item.code } : {}),
              message: item.message,
              severity: item.severity,
            })),
          });
        }
        session.roundEpoch += 1;
        session.queriesByEpoch.set(session.roundEpoch, 0);
        session.queryHashesByEpoch.set(session.roundEpoch, new Set<string>());
        if (hasActionableValidationDiagnostics(observation.validation)
          && shouldCloseRepairSearch(nextIssueSet, initialKnowledge, session.consecutiveNoProgress)) {
          session.searchClosedByEpoch.add(session.roundEpoch);
        }
        if (session.terminalStopReason === "repair_no_progress") {
          // 相同可信诊断连续两轮没有变化时停止，避免为了用满上限继续消耗Validator。
        } else if (session.roundEpoch > maxRepairRounds) {
          session.terminalStopReason = "candidate_budget_exhausted";
        } else if (session.candidateAttempts >= options.maxCandidateAttempts) {
          session.terminalStopReason = "candidate_budget_exhausted";
        } else if (session.validatorCalls >= options.maxValidatorCalls) {
          session.terminalStopReason = "validator_budget_exhausted";
        }
        const diagnostics = diagnosticsForModel(observation.validation);
        await emitCheckpointProgress("validator_completed");
        return {
          status: "failed",
          diagnostics: nextIssueSet.activeCluster?.issues ?? diagnostics.items,
          diagnosticTotal: diagnostics.total,
          diagnosticIncluded: nextIssueSet.activeCluster?.issues.length ?? diagnostics.items.length,
          diagnosticTruncated: diagnostics.truncated
            || (nextIssueSet.activeCluster?.issues.length ?? diagnostics.items.length) < diagnostics.total,
          structure: nextStructureEvidence,
          repairIssueSet: repairIssueSetForModel(nextIssueSet),
          diagnosticDelta: diagnosticDeltaForModel(diagnosticDelta),
          candidateChangeSummary: candidateChangeSummaryForModel(candidateChangeSummary),
          remainingValidatorCalls: Math.max(0, options.maxValidatorCalls - session.validatorCalls),
          remainingKnowledgeQueriesThisRound: options.runResources
            ? options.runResources.knowledge.reviewedKnowledgeQueryBudget().remainingNewQueries
            : Math.max(0, maxKnowledgeQueries - session.knowledgeQueries),
        };
      } catch (error) {
        const stopReason = validatorFailureStopReason(error);
        session.terminalStopReason = stopReason;
        session.attempts.push({
          round: callEpoch,
          status: "validated_failed",
          candidateHash: contentHash,
          toolCallId: execution.toolCallId,
          inputContentHash: contentHash,
          rejectionReason: stopReason,
          ...targetAudit(options.targetBinding),
        });
        if (options.evaluationMode === "local_benchmark") {
          session.evaluationFailedCandidates.push({
            round: callEpoch,
            content: input.content,
            contentHash,
            toolCallId: execution.toolCallId,
            diagnostics: [{
              message: error instanceof Error ? error.message.slice(0, 1_000) : "Validator调用失败。",
              severity: "error",
            }],
          });
        }
        await emitCheckpointProgress("terminal");
        return candidateActionResult(
          stopReason,
          error instanceof Error ? error.message.slice(0, 500) : "Validator调用失败。",
          session,
          callEpoch,
        );
      } finally {
        session.validationInFlight = false;
      }
    },
  });

  const tools = {
    search_reviewed_knowledge: searchReviewedKnowledge,
    submit_candidate_for_validation: submitCandidateForValidation,
  };

  const explicitToolChoice = options.explicitToolChoice !== false;

  let observedUsage = zeroUsage();
  const observedSteps: unknown[] = [];
  const providerCalls: Array<{
    callId: string;
    request: LanguageModelCallStartEvent;
    startedAt: string;
    completedAt?: string;
  }> = [];
  const agent = new ToolLoopAgent({
    id: "validator-repair-worker-v1",
    model: options.model,
    instructions: options.instructions,
    tools,
    ...(explicitToolChoice ? { toolChoice: "required" as const } : {}),
    stopWhen: [
      stepCountIs(maxToolLoopSteps),
      () => Boolean(session.accepted || session.terminalStopReason),
    ],
    prepareStep: ({ messages, stepNumber }) => {
      session.activeStepEpoch = session.roundEpoch;
      const estimatedInputTokensBeforePrune = estimateTokens(JSON.stringify(messages))
        + estimateTokens(options.instructions)
        + CONTEXT_SAFETY_TOKENS;
      // AI SDK保留ToolLoop历史是默认行为。Repair每一步改为从服务端可信状态重建单一
      // WorkerResumeView，再显式清除旧reasoning/tool消息，避免候选和诊断逐轮累积。
      const sdkPrunedHistory = pruneMessages({
        messages,
        reasoning: "all",
        toolCalls: "all",
        emptyMessages: "remove",
      });
      const resumeMessages = pruneMessages({
        messages: createWorkerResumeMessages({
          taskMessages,
          taskContext: options.taskContext,
          targetBinding: options.targetBinding,
          roundEpoch: session.roundEpoch,
          latestCandidateContent: session.latestCandidateContent,
          latestCandidateHash: session.latestCandidateHash,
          issueSet: session.latestIssueSet,
          diagnosticDelta: session.latestDiagnosticDelta,
          changeSummary: session.latestCandidateChangeSummary,
          initialKnowledge,
          resumeKnowledgeEvidence: session.resumeKnowledgeEvidence,
          remainingCandidateAttempts: Math.max(0, options.maxCandidateAttempts - session.candidateAttempts),
          remainingValidatorCalls: Math.max(0, options.maxValidatorCalls - session.validatorCalls),
        }),
        reasoning: "all",
        toolCalls: "all",
        emptyMessages: "remove",
      });
      const estimatedInputTokens = estimateTokens(JSON.stringify(resumeMessages))
        + estimateTokens(options.instructions)
        + CONTEXT_SAFETY_TOKENS;
      const visibleOutputReserveTokens = requiredVisibleOutputReserveTokens(
        session.latestCandidateContent,
      );
      const projectedTokens = estimatedInputTokens + visibleOutputReserveTokens;
      const queriesThisRound = session.queriesByEpoch.get(session.roundEpoch) ?? 0;
      const searchAvailable = options.knowledgeSearchEnabled
        && (options.runResources
          ? options.runResources.isNewReviewedKnowledgeQueryAllowed()
          : session.knowledgeQueries < maxKnowledgeQueries)
        && !session.searchClosedByEpoch.has(session.roundEpoch);
      const activeTools: Array<keyof typeof tools> = searchAvailable
        ? ["search_reviewed_knowledge", "submit_candidate_for_validation"]
        : ["submit_candidate_for_validation"];
      const admission: ValidatorRepairWorkerResult<CANDIDATE>["contextAdmissions"][number] = {
        stepNumber,
        roundEpoch: session.roundEpoch,
        estimatedInputTokensBeforePrune,
        estimatedInputTokens,
        prunedInputTokens: Math.max(0, estimatedInputTokensBeforePrune - estimatedInputTokens),
        messageCountBeforePrune: messages.length,
        messageCountAfterSdkPrune: sdkPrunedHistory.length,
        messageCountAfterPrune: resumeMessages.length,
        latestCandidateOccurrences: countTextOccurrences(
          resumeMessages.map((message) => (
            typeof message.content === "string" ? message.content : JSON.stringify(message.content)
          )).join("\n"),
          JSON.stringify(session.latestCandidateContent).slice(1, -1),
        ),
        visibleOutputReserveTokens,
        projectedTokens,
        remainingTokens: options.contextWindowTokens - projectedTokens,
        knowledgeQueriesThisRound: queriesThisRound,
        candidateAttempts: session.candidateAttempts,
        activeTools,
      };
      if (projectedTokens > options.contextWindowTokens) {
        session.terminalStopReason = "repair_context_budget_exhausted";
        session.contextAdmissions.push({
          ...admission,
          stopReason: "repair_context_budget_exhausted",
        });
        throw new RepairWorkerControlledStop("repair_context_budget_exhausted");
      }
      session.contextAdmissions.push(admission);
      if (stepNumber >= maxToolLoopSteps - 1) {
        session.terminalStopReason = "step_budget_exhausted";
      }
      if (session.terminalStopReason || session.accepted) {
        return explicitToolChoice
          ? { messages: resumeMessages, activeTools: [], toolChoice: "none" as const }
          : { messages: resumeMessages, activeTools: [] };
      }
      if (!searchAvailable) {
        return explicitToolChoice ? {
          messages: resumeMessages,
          activeTools: ["submit_candidate_for_validation"] as Array<keyof typeof tools>,
          toolChoice: { type: "tool", toolName: "submit_candidate_for_validation" as keyof typeof tools },
        } : {
          messages: resumeMessages,
          activeTools: ["submit_candidate_for_validation"] as Array<keyof typeof tools>,
        };
      }
      return explicitToolChoice ? {
        messages: resumeMessages,
        activeTools: ["search_reviewed_knowledge", "submit_candidate_for_validation"] as Array<keyof typeof tools>,
        toolChoice: "required" as const,
      } : {
        messages: resumeMessages,
        activeTools: ["search_reviewed_knowledge", "submit_candidate_for_validation"] as Array<keyof typeof tools>,
      };
    },
    maxRetries: 0,
    temperature: options.temperature ?? 0,
    reasoning: options.reasoning,
    providerOptions: options.providerOptions,
    telemetry: {
      integrations: [{
        onLanguageModelCallStart: (event) => {
          providerCalls.push({
            callId: event.callId,
            request: event,
            startedAt: new Date().toISOString(),
          });
        },
        onLanguageModelCallEnd: (event) => {
          const pending = [...providerCalls].reverse().find((call) => (
            call.callId === event.callId && call.completedAt === undefined
          ));
          if (pending) pending.completedAt = new Date().toISOString();
        },
      }],
    },
    onStepEnd: async (step) => {
      observedSteps.push(step);
      const { usage } = step;
      observedUsage = addUsage(observedUsage, usage);
      await emitCheckpointProgress("context_admission");
    },
  });

  let generated: Awaited<ReturnType<typeof agent.generate>> | undefined;
  const generationStartedAt = new Date().toISOString();
  try {
    generated = await agent.generate({
      messages: createWorkerResumeMessages({
        taskMessages,
        taskContext: options.taskContext,
        targetBinding: options.targetBinding,
        roundEpoch: session.roundEpoch,
        latestCandidateContent: session.latestCandidateContent,
        latestCandidateHash: session.latestCandidateHash,
        issueSet: session.latestIssueSet,
        diagnosticDelta: session.latestDiagnosticDelta,
        changeSummary: session.latestCandidateChangeSummary,
        initialKnowledge,
        resumeKnowledgeEvidence: session.resumeKnowledgeEvidence,
        remainingCandidateAttempts: Math.max(0, options.maxCandidateAttempts - session.candidateAttempts),
        remainingValidatorCalls: Math.max(0, options.maxValidatorCalls - session.validatorCalls),
      }),
      abortSignal: options.abortSignal,
      ...(runtimeContext ? { runtimeContext } : {}),
      timeout: {
        totalMs: Math.min(options.timeoutMs, options.runResources?.budget.view().workRemainingMs ?? options.timeoutMs),
        toolMs: options.toolTimeoutMs,
      },
      ...(options.runResources && options.taskView ? {
        onToolExecutionStart: (event) => options.runResources?.recordToolLifecycle({
          toolCallId: event.toolCall.toolCallId,
          toolName: event.toolCall.toolName,
          participant: "repair",
          taskId: options.taskView?.taskId,
          taskRevision: options.taskView?.taskRevision,
          roundEpoch: session.activeStepEpoch,
          status: "started",
        }),
        onToolExecutionEnd: (event) => options.runResources?.recordToolLifecycle({
          toolCallId: event.toolCall.toolCallId,
          toolName: event.toolCall.toolName,
          participant: "repair",
          taskId: options.taskView?.taskId,
          taskRevision: options.taskView?.taskRevision,
          roundEpoch: session.activeStepEpoch,
          status: event.toolOutput.type === "tool-result" ? "succeeded" : "failed",
        }),
      } : {}),
    });
    await recordModelGeneration({
      phase: "validator_repair_worker",
      request: {
        instructions: options.instructions,
        messages: taskMessages,
        maxRetries: 0,
        temperature: options.temperature ?? 0,
        reasoning: options.reasoning,
        toolChoice: explicitToolChoice ? "required" : "provider_managed",
        toolNames: Object.keys(tools),
      },
      steps: generated.steps,
      providerCalls,
      parserStatus: "ai_sdk_parsed",
      startedAt: generationStartedAt,
    });
  } catch (error) {
    // 先落安全进度投影，再写模型审计；即使deadline导致后续审计失败，
    // 管理端仍能看到最后一次上下文压缩指标和收敛事实。
    await emitCheckpointProgress("terminal");
    if (observedSteps.length > 0) {
      await recordModelGeneration({
        phase: "validator_repair_worker",
        request: {
          instructions: options.instructions,
          messages: taskMessages,
          maxRetries: 0,
          temperature: options.temperature ?? 0,
          reasoning: options.reasoning,
          toolChoice: explicitToolChoice ? "required" : "provider_managed",
          toolNames: Object.keys(tools),
        },
        steps: observedSteps,
        providerCalls,
        parserStatus: "ai_sdk_parsed",
        startedAt: generationStartedAt,
      });
    }
    if (!(error instanceof RepairWorkerControlledStop)) {
      const pendingProviderCall = providerCalls.find((call) => call.completedAt === undefined);
      await recordModelGeneration({
        phase: "validator_repair_worker",
        request: {
          instructions: options.instructions,
          messages: taskMessages,
          maxRetries: 0,
          temperature: options.temperature ?? 0,
          reasoning: options.reasoning,
          toolChoice: explicitToolChoice ? "required" : "provider_managed",
          toolNames: Object.keys(tools),
        },
        ...(pendingProviderCall ? {
          steps: [{
            callId: pendingProviderCall.callId,
            stepNumber: observedSteps.length,
            model: {
              provider: pendingProviderCall.request.provider,
              modelId: pendingProviderCall.request.modelId,
            },
          }],
          providerCalls: [pendingProviderCall],
        } : {}),
        error,
        startedAt: pendingProviderCall
          ? pendingProviderCall.startedAt
          : generationStartedAt,
      });
    }
    if (!(error instanceof RepairWorkerControlledStop)) {
      if (isStepTimeoutError(error)) {
        const repairTimeout = new Error("repair_step_timeout");
        repairTimeout.name = "RepairStepTimeoutError";
        throw repairTimeout;
      }
      throw error;
    }
  }

  const steps = generated?.steps ?? [];
  session.toolInputInvalidCount = steps.reduce((count, step) => (
    count + ((step as { toolCalls?: Array<{ invalid?: boolean }> }).toolCalls ?? [])
      .filter((call) => call.invalid === true).length
  ), 0);
  if (!session.terminalStopReason) {
    session.terminalStopReason = steps.length >= maxToolLoopSteps
      ? "step_budget_exhausted"
      : "model_terminated_without_candidate";
  }
  const totalUsage = generated?.totalUsage ?? observedUsage;
  if (options.runResources && options.taskView) {
    options.runResources.budget.settleModelCall({
      callId: `${options.runResources.runId}:${options.taskView.taskId}:repair-tool-loop`,
      usage: totalUsage,
    });
  }
  await emitCheckpointProgress("terminal");
  return {
    ...(session.accepted ? { accepted: session.accepted } : {}),
    usage: totalUsage,
    finishReason: generated?.finishReason ?? session.terminalStopReason,
    steps,
    candidateCharLimit,
    terminalStopReason: session.terminalStopReason,
    validatorCalls: session.validatorCalls,
    candidateAttempts: session.candidateAttempts,
    candidateSubmissionCalls: session.candidateSubmissionCalls,
    ...(session.timeToFirstCandidateSubmissionMs === undefined
      ? {}
      : { timeToFirstCandidateSubmissionMs: session.timeToFirstCandidateSubmissionMs }),
    knowledgeQueriesBeforeFirstCandidateSubmission: session.knowledgeQueriesBeforeFirstCandidateSubmission,
    candidateRepeatedCount: session.candidateRepeatedCount,
    consecutiveNoProgress: session.consecutiveNoProgress,
    toolInputInvalidCount: session.toolInputInvalidCount,
    knowledgeQueries: session.knowledgeQueries,
    knowledgeBackendCalls: session.knowledgeBackendCalls,
    knowledgeNoNewEvidenceCount: session.knowledgeNoNewEvidenceCount,
    knowledgeQueriesByRound: [...session.queriesByEpoch.entries()].map(([round, queries]) => ({ round, queries })),
    contextAdmissions: session.contextAdmissions,
    convergenceTrace: {
      ...(initialIssueSet ? { initialIssueSet } : {}),
      ...(session.latestIssueSet ? { latestIssueSet: session.latestIssueSet } : {}),
      ...(session.latestDiagnosticDelta
        ? { latestDiagnosticDelta: session.latestDiagnosticDelta }
        : {}),
      ...(session.latestCandidateChangeSummary
        ? { latestCandidateChangeSummary: session.latestCandidateChangeSummary }
        : {}),
      rounds: session.convergenceRounds,
    },
    ...(options.evaluationMode === "local_benchmark" ? {
      evaluationTrace: {
        knowledgeQueries: session.evaluationKnowledgeQueries,
        failedCandidates: session.evaluationFailedCandidates,
      },
    } : {}),
    attempts: session.attempts,
  };
}

function createWorkerResumeMessages(input: {
  taskMessages: readonly ModelMessage[];
  taskContext?: unknown;
  targetBinding: ValidatorRepairWorkerOptions<unknown>["targetBinding"];
  roundEpoch: number;
  latestCandidateContent: string;
  latestCandidateHash: string;
  issueSet?: RepairIssueSet;
  diagnosticDelta?: DiagnosticDelta;
  changeSummary?: CandidateChangeSummary;
  initialKnowledge?: KnowledgeView;
  resumeKnowledgeEvidence: readonly unknown[];
  remainingCandidateAttempts: number;
  remainingValidatorCalls: number;
}): ModelMessage[] {
  const evidenceAdmission = repairEvidenceAdmission(input.issueSet);
  const resultPriority = visibleResultReserveAdvisory(input.latestCandidateContent);
  const resumeView = {
    protocolVersion: "repair-worker-resume-view-v1",
    ...(input.taskContext === undefined ? {} : { taskContext: input.taskContext }),
    targetBinding: input.targetBinding,
    roundEpoch: input.roundEpoch,
    control: {
      repairScope: "active_issue_cluster_first",
      preserveUnrelatedModelContent: true,
      submitCompleteCandidate: true,
      patchSchemaAllowed: false,
      latestCandidateIsOnlyCandidateCopy: true,
    },
    latestCandidate: {
      contentHash: input.latestCandidateHash,
      content: input.latestCandidateContent,
    },
    repairIssueSet: input.issueSet ? repairIssueSetForModel(input.issueSet) : undefined,
    previousDiagnosticDelta: input.diagnosticDelta
      ? diagnosticDeltaForModel(input.diagnosticDelta)
      : undefined,
    previousCandidateChangeSummary: input.changeSummary
      ? candidateChangeSummaryForModel(input.changeSummary)
      : undefined,
    necessaryEvidence: {
      admission: evidenceAdmission,
      shared: input.initialKnowledge
        ? knowledgeForResume(input.initialKnowledge, evidenceAdmission.sharedContent === "bounded_body")
        : undefined,
      latestRepairQuery: input.resumeKnowledgeEvidence,
    },
    remainingBudget: {
      candidateAttempts: input.remainingCandidateAttempts,
      validatorCalls: input.remainingValidatorCalls,
    },
    resultPriority,
    requiredNextAction: "修复active cluster并通过submit_candidate_for_validation提交一份完整候选；不要提交Patch、diff或业务状态。",
  };
  return [
    ...input.taskMessages,
    {
      role: "user",
      content: `Repair Worker续跑状态（服务端可信投影）：\n${JSON.stringify(resumeView)}`,
    },
  ];
}

function requiredVisibleOutputReserveTokens(latestCandidateContent: string): number {
  return estimateTokens(JSON.stringify({
    type: "tool-call",
    toolName: "submit_candidate_for_validation",
    input: { content: latestCandidateContent },
  }));
}

function visibleResultReserveAdvisory(latestCandidateContent: string): Record<string, unknown> {
  const estimatedCompleteToolJsonTokens = estimateTokens(JSON.stringify({
    type: "tool-call",
    toolName: "submit_candidate_for_validation",
    input: { content: latestCandidateContent },
  }));
  return {
    mode: "complete_tool_result_context_reserve",
    advisoryOnly: true,
    providerHardGuarantee: false,
    latestCandidateChars: latestCandidateContent.length,
    estimatedCompleteToolJsonTokens,
    requiredVisibleOutputReserveTokens: estimatedCompleteToolJsonTokens,
    instruction: `高效、简洁地完成当前最小修复，并优先调用submit_candidate_for_validation提交完整候选。完整Tool JSON按当前候选正文估算需要约${estimatedCompleteToolJsonTokens}个可见输出Token；该值只用于上下文准入和结果优先提示，不会作为Provider输出硬帽。`,
  };
}

function repairEvidenceAdmission(issueSet: RepairIssueSet | undefined) {
  const activeCategory = issueSet?.activeCluster?.category;
  if (!activeCategory) {
    return {
      activeCategory: "none" as const,
      sharedContent: "bounded_body" as const,
      domainContent: "bounded_body" as const,
      latestRepairQueryContent: "issue_directed_bounded_body" as const,
    };
  }
  return {
    activeCategory,
    // Candidate阶段遗留知识不等于当前Validator问题所需证据；只保留服务端引用。
    sharedContent: "references_only" as const,
    // Domain Search用于领域建模，不用于修复局部语言/Validator诊断。
    domainContent: "references_only" as const,
    // 历史共享证据仍只保留引用；Repair针对当前问题簇主动查询后，
    // 必须投影最新的有界正文，否则模型只看到Claim/覆盖标记而拿不到可执行语法证据。
    latestRepairQueryContent: "issue_directed_bounded_body" as const,
  };
}

function knowledgeForResume(
  knowledge: KnowledgeView,
  includeBodies: boolean,
): Record<string, unknown> {
  const references = {
    bundleRef: boundedText(knowledge.bundleRef, 160),
    sourceRegistryHash: boundedText(knowledge.sourceRegistryHash, 160),
    knowledgeContentHash: hashContent(JSON.stringify({
      claims: knowledge.claims,
      evidenceBlocks: knowledge.evidenceBlocks,
      domainEvidence: knowledge.domainEvidence,
    })),
    claimIds: boundedReferenceList([
      ...(knowledge.claimIds ?? []),
      ...knowledge.claims.map((claim) => claim.claimId),
    ]),
    evidenceIds: boundedReferenceList([
      ...(knowledge.evidenceIds ?? []),
      ...knowledge.evidenceBlocks.map((evidence) => evidence.evidenceId),
    ]),
    evidenceSpanIds: boundedReferenceList(knowledge.evidenceSpanIds ?? []),
    domainSourceIds: boundedReferenceList([
      ...(knowledge.domainSourceIds ?? []),
      ...(knowledge.domainEvidence?.disclosedSourceIds ?? []),
    ]),
    sourceToolCallIds: boundedReferenceList(knowledge.sourceToolCallIds ?? []),
    truncated: knowledge.truncated,
  };
  if (!includeBodies) {
    return {
      ...references,
      admission: "references_only",
      domainEvidence: knowledge.domainEvidence
        ? projectDomainEvidenceReferences(knowledge.domainEvidence)
        : undefined,
    };
  }
  return {
    ...references,
    admission: "bounded_body",
    claims: knowledge.claims,
    evidenceBlocks: knowledge.evidenceBlocks,
    domainEvidence: knowledge.domainEvidence,
  };
}

function projectDomainEvidenceReferences(
  domainEvidence: NonNullable<KnowledgeView["domainEvidence"]>,
): Record<string, unknown> {
  return {
    trust: domainEvidence.trust,
    evidenceHash: hashContent(JSON.stringify(domainEvidence)),
    disclosedSourceIds: boundedReferenceList(domainEvidence.disclosedSourceIds),
    researches: domainEvidence.researches.slice(-8).map((research) => ({
      sourceToolCallId: boundedText(research.sourceToolCallId, 160),
      sourceIds: boundedReferenceList(research.sources.map((source) => source.sourceId)),
    })),
    truncated: domainEvidence.truncated || domainEvidence.researches.length > 8,
  };
}

function boundedReferenceList(values: readonly unknown[]): string[] {
  return [...new Set(values.map((value) => boundedText(value, 160)).filter(Boolean))].slice(0, 128);
}

function repairIssueSetForModel(issueSet: RepairIssueSet): Record<string, unknown> {
  const activeCluster = issueSet.activeCluster ? {
    clusterId: issueSet.activeCluster.clusterId,
    category: issueSet.activeCluster.category,
    priority: issueSet.activeCluster.priority,
    fileId: issueSet.activeCluster.fileId,
    issueCount: issueSet.activeCluster.issueCount,
    issues: issueSet.activeCluster.issues.slice(0, 12).map(projectRepairIssueForModel),
    truncated: issueSet.activeCluster.issueCount > 12,
  } : undefined;
  return {
    protocolVersion: issueSet.protocolVersion,
    candidateHash: issueSet.candidateHash,
    validatorEvidenceHash: issueSet.validatorEvidenceHash,
    issueCount: issueSet.issueCount,
    categoryCounts: issueSet.categoryCounts,
    activeCluster,
    remainingClusters: issueSet.clusters.slice(1, 12).map((cluster) => ({
      clusterId: cluster.clusterId,
      category: cluster.category,
      priority: cluster.priority,
      fileId: cluster.fileId,
      issueCount: cluster.issueCount,
    })),
    clusterCount: issueSet.clusters.length,
    truncated: issueSet.clusters.length > 12,
  };
}

function diagnosticDeltaForModel(delta: DiagnosticDelta): Record<string, unknown> {
  const project = (issues: DiagnosticDelta["resolved"]) => (
    issues.slice(0, 6).map(projectRepairIssueForModel)
  );
  return {
    protocolVersion: delta.protocolVersion,
    counts: delta.counts,
    resolved: project(delta.resolved),
    unchanged: project(delta.unchanged),
    introduced: project(delta.introduced),
    regressed: project(delta.regressed),
    truncated: Object.values(delta.counts).some((count) => count > 6),
  };
}

function projectRepairIssueForModel(issue: RepairIssueSet["issues"][number]): Record<string, unknown> {
  return {
    issueId: issue.issueId,
    category: issue.category,
    severity: issue.severity,
    code: issue.code,
    message: boundedText(issue.message, 800),
    fileId: issue.fileId,
    line: issue.line,
    column: issue.column,
    from: issue.from,
    to: issue.to,
    targetConstruct: issue.targetConstruct,
  };
}

function candidateChangeSummaryForModel(summary: CandidateChangeSummary): Record<string, unknown> {
  return {
    protocolVersion: summary.protocolVersion,
    fromCandidateHash: summary.fromCandidateHash,
    toCandidateHash: summary.toCandidateHash,
    text: summary.text,
    declarations: {
      added: summary.declarations.added.slice(0, 24),
      removed: summary.declarations.removed.slice(0, 24),
      changedKinds: summary.declarations.changedKinds,
    },
    structure: {
      added: summary.structure.added.slice(0, 24),
      removed: summary.structure.removed.slice(0, 24),
      changedNodeCount: summary.structure.changedNodeCount,
    },
    outOfClusterChange: summary.outOfClusterChange,
    outOfClusterReasons: summary.outOfClusterReasons,
  };
}

function countTextOccurrences(value: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor <= value.length - search.length) {
    const next = value.indexOf(search, cursor);
    if (next < 0) break;
    count += 1;
    cursor = next + search.length;
  }
  return count;
}

function deriveRepairCandidateCharLimit<CANDIDATE>(
  options: ValidatorRepairWorkerOptions<CANDIDATE>,
  maxCandidateArtifactBytes: number,
): number {
  const fixedTokens = estimateTokens(options.instructions)
    + requiredVisibleOutputReserveTokens(options.initialCandidateContent)
    + CONTEXT_SAFETY_TOKENS
    + REPAIR_RESUME_VIEW_RESERVE_TOKENS;
  const remainingChars = Math.max(0, (options.contextWindowTokens - fixedTokens) * 4);
  // WorkerResumeView每步只携带一份最新Candidate，因此候选上限不再除以历史轮数。
  return Math.min(maxCandidateArtifactBytes, Math.floor(remainingChars));
}

function diagnosticsForModel(validation: ValidationOutput): {
  items: ValidationOutput["official"]["diagnostics"];
  total: number;
  truncated: boolean;
} {
  const items = [
    ...validation.official.diagnostics,
    ...(validation.courseRules?.diagnostics ?? []),
  ].slice(0, 200);
  const declared = validation.diagnosticSummary;
  const total = (declared?.total
    ?? validation.official.diagnostics.length + (validation.courseRules?.diagnostics.length ?? 0))
  return {
    items,
    total: Math.max(total, items.length),
    truncated: declared?.truncated === true || total > items.length,
  };
}

function structureEvidenceForModel(validation: ValidationOutput): CandidateStructureEvidence {
  return validation.structureEvidence ?? {
    source: "none",
    authority: "none",
    status: "unavailable",
    nodes: [],
    diagnostics: [],
    truncated: false,
  };
}

function candidateActionResult(
  status: string,
  message: string,
  session: {
    validatorCalls: number;
    maxValidatorCalls: number;
    maxKnowledgeQueries: number;
    queriesByEpoch: Map<number, number>;
    knowledgeQueries: number;
  },
  roundEpoch: number,
) {
  return {
    status,
    message,
    remainingValidatorCalls: Math.max(0, session.maxValidatorCalls - session.validatorCalls),
    remainingKnowledgeQueriesThisRound: Math.max(
      0,
      session.maxKnowledgeQueries - session.knowledgeQueries,
    ),
  };
}

function validatorFailureStopReason(value: unknown): RepairWorkerTerminalStopReason {
  const code = value && typeof value === "object" && "code" in value
    ? String((value as { code?: unknown }).code ?? "")
    : "";
  const diagnostics = value && typeof value === "object" && "official" in value
    ? (value as ValidationOutput).official.diagnostics
      .map((item) => `${item.code ?? ""} ${item.message}`)
      .join(" ")
    : "";
  const text = `${code} ${value instanceof Error ? value.message : ""} ${diagnostics}`;
  if (/VALIDATOR_QUEUE_FULL/iu.test(text)) return "validator_queue_full";
  if (/VALIDATOR_QUEUE_TIMEOUT/iu.test(text)) return "validator_queue_timeout";
  if (/OFFICIAL_VALIDATOR_TIMEOUT|VALIDATOR_TOOL_CALL_TIMEOUT/iu.test(text)) {
    return "validator_execution_timeout";
  }
  return "validator_unavailable";
}

function hashContent(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function targetAudit(binding: ValidatorRepairWorkerOptions<unknown>["targetBinding"]) {
  return {
    targetMode: binding.mode,
    ...(binding.fileId ? { targetFileId: binding.fileId } : {}),
    ...(binding.baseHash ? { baseHash: binding.baseHash } : {}),
  };
}

function validationAudit(validation: ValidationOutput) {
  const structure = structureEvidenceForModel(validation);
  const diagnostics = diagnosticsForModel(validation);
  return {
    ...(validation.candidateWorkspaceHash
      ? { candidateWorkspaceHash: validation.candidateWorkspaceHash }
      : {}),
    validatorEvidenceHash: validation.validator.evidenceHash,
    structureEvidenceSource: structure.source,
    structureEvidenceStatus: structure.status,
    structureEvidenceTruncated: structure.truncated,
    diagnosticTotal: diagnostics.total,
    diagnosticIncluded: diagnostics.items.length,
    diagnosticTruncated: diagnostics.truncated,
    ...(structure.contentHash ? { structureEvidenceContentHash: structure.contentHash } : {}),
  };
}

interface CachedEvidence {
  evidenceId: string;
  sectionPath: string;
  authorityLevel: string;
  spans: string[];
}

function validationFailureSignature(validation: ValidationOutput): string {
  const diagnosticKey = (diagnostic: ValidationOutput["official"]["diagnostics"][number]) => ({
    severity: diagnostic.severity,
    code: diagnostic.code ?? "",
    message: diagnostic.message,
    fileId: diagnostic.fileId ?? "",
    line: diagnostic.line ?? 0,
    column: diagnostic.column ?? 0,
    from: diagnostic.from ?? 0,
    to: diagnostic.to ?? 0,
  });
  const officialDiagnostics = validation.official.diagnostics
    .map(diagnosticKey)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const courseDiagnostics = (validation.courseRules?.diagnostics ?? [])
    .map(diagnosticKey)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify({
    syntax: validation.official.syntax,
    semantic: validation.official.semantic,
    officialDiagnostics,
    courseDiagnostics,
  });
}

function resolveSharedRepairTask<CANDIDATE>(
  options: ValidatorRepairWorkerOptions<CANDIDATE>,
): TaskWorkingState | undefined {
  if (Boolean(options.runResources) !== Boolean(options.taskView)) {
    throw new Error("runResources and taskView must be provided together");
  }
  if (!options.runResources || !options.taskView) return undefined;
  const current = options.runResources.tasks.get(options.taskView.taskId);
  if (!current
    || current.runId !== options.runResources.runId
    || current.runId !== options.taskView.runId
    || current.questionHash !== options.taskView.questionHash
    || current.workerType !== options.taskView.workerType
    || (current.workerType === "candidate" && options.taskView.workerType === "candidate"
      && current.mode !== options.taskView.mode)
    || (current.workerType === "repair" && options.taskView.workerType === "repair"
      && current.scope !== options.taskView.scope)
    || current.revision < options.taskView.taskRevision
    || (current.status !== "worker_running" && current.status !== "validating")) {
    throw new Error("Repair task is stale or does not belong to the bound Run");
  }
  return current;
}

function knowledgeResultForModel(
  value: unknown,
  query: string,
  providedClaimIds: ReadonlySet<string>,
  providedEvidenceIds: ReadonlySet<string>,
  evidenceCache: Map<string, CachedEvidence>,
  providedEvidenceSpanIds: ReadonlySet<string>,
): {
  modelResult: {
    protocolVersion: "repair-knowledge-progressive-v1";
    coverage: string;
    closureStatus: string;
    resultHash: string;
    newClaims: Array<Record<string, unknown>>;
    newEvidenceBlocks: Array<Record<string, unknown>>;
    alreadyProvidedClaimIds: string[];
    alreadyProvidedEvidenceIds: string[];
    no_new_evidence: boolean;
    totalClaims: number;
    includedClaims: number;
    totalEvidenceBlocks: number;
    includedEvidenceBlocks: number;
    modelViewTokenBudget: number;
    estimatedModelViewTokens: number;
    expansionAvailable: boolean;
    oversizedEvidenceSpanCount: number;
    truncated: boolean;
  };
  newClaimIds: string[];
  newEvidenceIds: string[];
  newEvidenceSpanIds: string[];
} {
  if (!value || typeof value !== "object") {
    return emptyKnowledgeProjection();
  }
  const source = value as Record<string, unknown>;
  const rawClaims = Array.isArray(source.newClaims)
    ? source.newClaims
    : Array.isArray(source.claims) ? source.claims : [];
  const rawEvidence = Array.isArray(source.newEvidenceBlocks)
    ? source.newEvidenceBlocks
    : Array.isArray(source.evidenceBlocks) ? source.evidenceBlocks : [];
  const declaredAlreadyProvidedClaimIds = new Set(textList(source.alreadyProvidedClaimIds, 128, 128));
  const declaredAlreadyProvidedEvidenceIds = new Set(textList(source.alreadyProvidedEvidenceIds, 128, 128));
  for (const item of rawEvidence) {
    if (!item || typeof item !== "object") continue;
    const evidence = item as Record<string, unknown>;
    const evidenceId = boundedText(evidence.evidenceId, 128);
    const excerpt = String(evidence.excerpt ?? evidence.textContent ?? "").trim();
    if (!evidenceId || !excerpt) continue;
    evidenceCache.set(evidenceId, {
      evidenceId,
      sectionPath: boundedText(evidence.sectionPath, 500),
      authorityLevel: boundedText(evidence.authorityLevel, 16),
      spans: semanticEvidenceSpans(excerpt),
    });
  }

  let remainingTokens = KNOWLEDGE_MODEL_VIEW_TOKEN_BUDGET;
  let estimatedModelViewTokens = 0;
  const duplicateClaimIds: string[] = [];
  const claimCandidates = rawClaims.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const claim = item as Record<string, unknown>;
    const claimId = boundedText(claim.claimId, 128);
    const claimText = String(claim.claimText ?? "").trim();
    if (!claimId || !claimText) return [];
    if (providedClaimIds.has(claimId) || declaredAlreadyProvidedClaimIds.has(claimId)) {
      duplicateClaimIds.push(claimId);
      return [];
    }
    return [{
      claimId,
      claimText,
      authorityLevel: boundedText(claim.authorityLevel, 16),
      evidenceIds: (Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [])
        .slice(0, 8)
        .map((item) => boundedText(item, 128))
        .filter(Boolean),
    }];
  });
  const claims: Array<Record<string, unknown>> = [];
  for (const claim of claimCandidates) {
    const tokens = estimatedJsonTokens(claim);
    if (tokens > remainingTokens) continue;
    claims.push(claim);
    remainingTokens -= tokens;
    estimatedModelViewTokens += tokens;
  }

  const requestedEvidenceIds = evidenceIdsMentionedInQuery(query, evidenceCache.keys());
  const rawEvidenceIds = rawEvidence.flatMap((item) => {
    const evidenceId = item && typeof item === "object"
      ? boundedText((item as Record<string, unknown>).evidenceId, 128)
      : "";
    return evidenceId ? [evidenceId] : [];
  });
  const evidenceIdsToConsider = [...new Set([
    ...requestedEvidenceIds,
    ...rawEvidenceIds,
    ...providedEvidenceIds,
  ])];
  const evidenceBlocks: Array<Record<string, unknown>> = [];
  const newEvidenceSpanIds: string[] = [];
  for (const evidenceId of evidenceIdsToConsider) {
    const cached = evidenceCache.get(evidenceId);
    if (!cached) continue;
    if (providedEvidenceSpanIds.has(`${evidenceId}:all`)) continue;
    const spanIndex = selectEvidenceSpanIndex(cached, query, providedEvidenceSpanIds, remainingTokens);
    if (spanIndex < 0) continue;
    const spanId = `${evidenceId}:${spanIndex}`;
    const block = {
      evidenceId,
      spanId,
      spanIndex,
      spanCount: cached.spans.length,
      sectionPath: cached.sectionPath,
      excerpt: cached.spans[spanIndex],
      authorityLevel: cached.authorityLevel,
      expansionAvailable: cached.spans.some((_, index) => !providedEvidenceSpanIds.has(`${evidenceId}:${index}`)
        && index !== spanIndex),
    };
    const tokens = estimatedJsonTokens(block);
    if (tokens > remainingTokens) continue;
    evidenceBlocks.push(block);
    newEvidenceSpanIds.push(spanId);
    remainingTokens -= tokens;
    estimatedModelViewTokens += tokens;
  }
  const newClaimIds = claims.map((item) => String(item.claimId));
  const newEvidenceIds = [...new Set(evidenceBlocks.map((item) => String(item.evidenceId)))];
  const oversizedEvidenceSpanCount = [...evidenceCache.values()].reduce((count, evidence) => (
    count + evidence.spans.filter((span) => estimatedTextTokens(span) + 100 > KNOWLEDGE_MODEL_VIEW_TOKEN_BUDGET).length
  ), 0);
  const expansionAvailable = [...evidenceCache.values()].some((evidence) => evidence.spans.some(
    (_, index) => !providedEvidenceSpanIds.has(`${evidence.evidenceId}:all`)
      && !providedEvidenceSpanIds.has(`${evidence.evidenceId}:${index}`)
      && !newEvidenceSpanIds.includes(`${evidence.evidenceId}:${index}`)
      && estimatedTextTokens(evidence.spans[index]!) + 100 <= KNOWLEDGE_MODEL_VIEW_TOKEN_BUDGET,
  ));
  const noNewEvidence = newClaimIds.length === 0
    && newEvidenceIds.length === 0
    && !expansionAvailable;
  return {
    modelResult: {
      protocolVersion: "repair-knowledge-progressive-v1",
      coverage: ["COMPLETE", "PARTIAL", "NONE"].includes(String(source.coverage))
        ? String(source.coverage)
        : "NONE",
      closureStatus: boundedText(source.closureStatus, 32),
      resultHash: boundedText(source.resultHash, 80),
      newClaims: claims,
      newEvidenceBlocks: evidenceBlocks,
      alreadyProvidedClaimIds: [...new Set([
        ...providedClaimIds,
        ...declaredAlreadyProvidedClaimIds,
        ...duplicateClaimIds,
      ])].slice(0, 128),
      alreadyProvidedEvidenceIds: [...new Set([
        ...providedEvidenceIds,
        ...declaredAlreadyProvidedEvidenceIds,
      ])].slice(0, 128),
      no_new_evidence: noNewEvidence,
      totalClaims: numericCount(source.totalClaims, rawClaims.length),
      includedClaims: claims.length,
      totalEvidenceBlocks: numericCount(source.totalEvidenceBlocks, rawEvidence.length),
      includedEvidenceBlocks: evidenceBlocks.length,
      modelViewTokenBudget: KNOWLEDGE_MODEL_VIEW_TOKEN_BUDGET,
      estimatedModelViewTokens,
      expansionAvailable,
      oversizedEvidenceSpanCount,
      truncated: claimCandidates.length > claims.length || expansionAvailable || oversizedEvidenceSpanCount > 0,
    },
    newClaimIds,
    newEvidenceIds,
    newEvidenceSpanIds,
  };
}

function emptyKnowledgeProjection(): ReturnType<typeof knowledgeResultForModel> {
  return {
    modelResult: {
      protocolVersion: "repair-knowledge-progressive-v1",
      coverage: "NONE",
      closureStatus: "",
      resultHash: "",
      newClaims: [],
      newEvidenceBlocks: [],
      alreadyProvidedClaimIds: [],
      alreadyProvidedEvidenceIds: [],
      no_new_evidence: true,
      totalClaims: 0,
      includedClaims: 0,
      totalEvidenceBlocks: 0,
      includedEvidenceBlocks: 0,
      modelViewTokenBudget: KNOWLEDGE_MODEL_VIEW_TOKEN_BUDGET,
      estimatedModelViewTokens: 0,
      expansionAvailable: false,
      oversizedEvidenceSpanCount: 0,
      truncated: false,
    },
    newClaimIds: [],
    newEvidenceIds: [],
    newEvidenceSpanIds: [],
  };
}

function hasActionableValidationDiagnostics(validation: ValidationOutput | undefined): boolean {
  if (!validation) return false;
  return validation.official.diagnostics.some((diagnostic) => diagnostic.severity === "error")
    || (validation.courseRules?.diagnostics.some((diagnostic) => diagnostic.severity === "error") ?? false);
}

function hasSharedReviewedEvidence(knowledge: KnowledgeView | undefined): boolean {
  if (!knowledge) return false;
  return knowledge.claims.length > 0 || knowledge.evidenceBlocks.length > 0;
}

function shouldCloseRepairSearch(
  issueSet: RepairIssueSet | undefined,
  knowledge: KnowledgeView | undefined,
  _consecutiveNoProgress: number,
): boolean {
  // Active Cluster只限制当前修复范围，不代表Validator诊断已经提供可执行的SysML v2语法证据。
  // 保持Search Tool可选，由Repair根据Prompt对明显词法/定界符错误直接修复，其他问题簇优先检索。
  // 共享Run预算、COMPLETE/no_new_evidence和当轮Search Guard仍由服务端硬性关闭。
  if (issueSet?.activeCluster) return false;
  // 没有服务端问题分类时保留旧兼容行为；已有共享审核证据则不重复查询。
  return !issueSet?.activeCluster && hasSharedReviewedEvidence(knowledge);
}

function isStepTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /step timeout(?: of)?(?: \d+ms)? exceeded/iu.test(error.message)
    || error.name === "StepTimeoutError";
}

function boundedRepairOutputTokens(value: number | undefined, fallback: number): number {
  return Math.min(64_000, Math.max(256, Number.isInteger(value) ? Number(value) : fallback));
}

function semanticEvidenceSpans(value: string): string[] {
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  const fencePattern = /```[\s\S]*?```/gu;
  let cursor = 0;
  for (const match of normalized.matchAll(fencePattern)) {
    const index = match.index ?? cursor;
    chunks.push(...proseEvidenceSpans(normalized.slice(cursor, index)));
    chunks.push(String(match[0]).trim());
    cursor = index + String(match[0]).length;
  }
  chunks.push(...proseEvidenceSpans(normalized.slice(cursor)));
  return chunks.filter(Boolean);
}

function proseEvidenceSpans(value: string): string[] {
  return value.split(/\n\s*\n/gu).flatMap((paragraph) => {
    const text = paragraph.trim();
    if (!text) return [];
    if (estimatedTextTokens(text) <= KNOWLEDGE_MODEL_VIEW_TOKEN_BUDGET) return [text];
    const sentences = text.match(/[^。！？.!?\n]+[。！？.!?]+|[^。！？.!?\n]+$/gu)
      ?.map((item) => item.trim()).filter(Boolean) ?? [];
    if (sentences.length > 1) return sentences;
    const lines = text.split(/\n+/gu).map((line) => line.trim()).filter(Boolean);
    return lines.length > 1 ? lines : [text];
  });
}

function evidenceIdsMentionedInQuery(query: string, evidenceIds: Iterable<string>): string[] {
  const normalized = query.toLowerCase();
  return [...evidenceIds].filter((evidenceId) => normalized.includes(evidenceId.toLowerCase()));
}

function selectEvidenceSpanIndex(
  evidence: CachedEvidence,
  query: string,
  providedEvidenceSpanIds: ReadonlySet<string>,
  remainingTokens: number,
): number {
  const disclosed = evidence.spans.flatMap((_, index) => (
    providedEvidenceSpanIds.has(`${evidence.evidenceId}:${index}`) ? [index] : []
  ));
  const undisclosed = evidence.spans.flatMap((_, index) => (
    providedEvidenceSpanIds.has(`${evidence.evidenceId}:${index}`)
      || estimatedTextTokens(evidence.spans[index]!) + 100 > remainingTokens ? [] : [index]
  ));
  if (!undisclosed.length) return -1;
  if (disclosed.length > 0) {
    const adjacent = undisclosed
      .filter((index) => disclosed.some((prior) => Math.abs(prior - index) === 1))
      .sort((left, right) => left - right);
    if (adjacent.length > 0) return adjacent[0]!;
  }
  const terms = relevanceTerms(query);
  return undisclosed.sort((left, right) => (
    evidenceSpanScore(evidence.spans[right]!, terms) - evidenceSpanScore(evidence.spans[left]!, terms)
      || left - right
  ))[0] ?? -1;
}

function relevanceTerms(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^\p{L}\p{N}:._-]+/gu)
    .map((term) => term.trim()).filter((term) => term.length >= 2))];
}

function evidenceSpanScore(value: string, terms: readonly string[]): number {
  const normalized = value.toLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}

function estimatedTextTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function estimatedJsonTokens(value: unknown): number {
  return estimatedTextTokens(JSON.stringify(value));
}

function textList(value: unknown, maxItems: number, maxLength: number): string[] {
  return (Array.isArray(value) ? value : [])
    .slice(0, maxItems)
    .map((item) => boundedText(item, maxLength))
    .filter(Boolean);
}

function numericCount(value: unknown, fallback: number): number {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : fallback;
}

function normalizeKnowledgeQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function boundedText(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function zeroUsage(): LanguageModelUsage {
  return {
    inputTokens: 0,
    inputTokenDetails: {
      noCacheTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokens: 0,
    outputTokenDetails: {
      textTokens: 0,
      reasoningTokens: 0,
    },
    totalTokens: 0,
  };
}

function addUsage(left: LanguageModelUsage, right: LanguageModelUsage): LanguageModelUsage {
  const sum = (a: number | undefined, b: number | undefined) => (a ?? 0) + (b ?? 0);
  return {
    inputTokens: sum(left.inputTokens, right.inputTokens),
    inputTokenDetails: {
      noCacheTokens: sum(left.inputTokenDetails.noCacheTokens, right.inputTokenDetails.noCacheTokens),
      cacheReadTokens: sum(left.inputTokenDetails.cacheReadTokens, right.inputTokenDetails.cacheReadTokens),
      cacheWriteTokens: sum(left.inputTokenDetails.cacheWriteTokens, right.inputTokenDetails.cacheWriteTokens),
    },
    outputTokens: sum(left.outputTokens, right.outputTokens),
    outputTokenDetails: {
      textTokens: sum(left.outputTokenDetails.textTokens, right.outputTokenDetails.textTokens),
      reasoningTokens: sum(left.outputTokenDetails.reasoningTokens, right.outputTokenDetails.reasoningTokens),
    },
    totalTokens: sum(left.totalTokens, right.totalTokens),
  };
}

/**
 * Checkpoint投影的唯一构造入口。只保留有界、可审计的数值和收敛对象；
 * Candidate正文、Prompt、AI SDK消息与reasoning从类型边界上就不可传入。
 */
export function projectRepairTelemetryCheckpointState(input: {
  contextAdmissions: ReadonlyArray<{
    readonly stepNumber: number;
    readonly roundEpoch: number;
    readonly estimatedInputTokensBeforePrune: number;
    readonly estimatedInputTokens: number;
    readonly prunedInputTokens: number;
    readonly messageCountBeforePrune: number;
    readonly messageCountAfterSdkPrune: number;
    readonly messageCountAfterPrune: number;
    readonly latestCandidateOccurrences: number;
    readonly visibleOutputReserveTokens: number;
    readonly projectedTokens: number;
    readonly remainingTokens: number;
    readonly knowledgeQueriesThisRound: number;
    readonly candidateAttempts: number;
    readonly stopReason?: string;
  }>;
  convergenceTrace: {
    readonly initialIssueSet?: RepairIssueSet;
    readonly latestIssueSet?: RepairIssueSet;
    readonly latestDiagnosticDelta?: DiagnosticDelta;
    readonly latestCandidateChangeSummary?: CandidateChangeSummary;
    readonly rounds: readonly RepairRoundTrace[];
  };
  noProgress?: boolean;
}) {
  const contextAdmissions = input.contextAdmissions.slice(-24).map((item) => ({
    stepNumber: item.stepNumber,
    roundEpoch: item.roundEpoch,
    estimatedInputTokensBeforePrune: item.estimatedInputTokensBeforePrune,
    estimatedInputTokens: item.estimatedInputTokens,
    prunedInputTokens: item.prunedInputTokens,
    messageCountBeforePrune: item.messageCountBeforePrune,
    messageCountAfterSdkPrune: item.messageCountAfterSdkPrune,
    messageCountAfterPrune: item.messageCountAfterPrune,
    latestCandidateOccurrences: item.latestCandidateOccurrences,
    visibleOutputReserveTokens: item.visibleOutputReserveTokens,
    projectedTokens: item.projectedTokens,
    remainingTokens: item.remainingTokens,
    knowledgeQueriesThisRound: item.knowledgeQueriesThisRound,
    candidateAttempts: item.candidateAttempts,
    ...(item.stopReason ? { stopReason: item.stopReason } : {}),
  }));
  const maxInputBeforePrune = contextAdmissions.reduce(
    (maximum, item) => Math.max(maximum, item.estimatedInputTokensBeforePrune),
    0,
  );
  const maxInputAfterPrune = contextAdmissions.reduce(
    (maximum, item) => Math.max(maximum, item.estimatedInputTokens),
    0,
  );
  return {
    version: "repair-checkpoint-state-v1" as const,
    contextAdmissions,
    convergenceTrace: {
      ...(input.convergenceTrace.initialIssueSet
        ? { initialIssueSet: projectCheckpointIssueSet(input.convergenceTrace.initialIssueSet) }
        : {}),
      ...(input.convergenceTrace.latestIssueSet
        ? { latestIssueSet: projectCheckpointIssueSet(input.convergenceTrace.latestIssueSet) }
        : {}),
      ...(input.convergenceTrace.latestDiagnosticDelta
        ? { latestDiagnosticDelta: projectCheckpointDiagnosticDelta(input.convergenceTrace.latestDiagnosticDelta) }
        : {}),
      ...(input.convergenceTrace.latestCandidateChangeSummary
        ? {
            latestCandidateChangeSummary: projectCheckpointCandidateChangeSummary(
              input.convergenceTrace.latestCandidateChangeSummary,
            ),
          }
        : {}),
      rounds: input.convergenceTrace.rounds.slice(-CHECKPOINT_ROUND_LIMIT).map(projectCheckpointRound),
    },
    metrics: {
      maxInputBeforePrune,
      maxInputAfterPrune,
      prunedInputTokens: Math.max(0, maxInputBeforePrune - maxInputAfterPrune),
      contextInflationDetected: maxInputBeforePrune > Math.max(12_000, maxInputAfterPrune * 2),
      noProgress: input.noProgress === true,
    },
  };
}

function projectCheckpointIssueSet(issueSet: RepairIssueSet) {
  const clusters = issueSet.clusters.slice(0, CHECKPOINT_CLUSTER_SUMMARY_LIMIT).map((cluster) => ({
    clusterId: boundedText(cluster.clusterId, 160),
    category: cluster.category,
    priority: cluster.priority,
    ...(cluster.fileId ? { fileId: boundedText(cluster.fileId, 200) } : {}),
    issueCount: cluster.issueCount,
  }));
  return {
    protocolVersion: issueSet.protocolVersion,
    candidateHash: boundedText(issueSet.candidateHash, 160),
    validatorEvidenceHash: boundedText(issueSet.validatorEvidenceHash, 160),
    issueCount: issueSet.issueCount,
    categoryCounts: issueSet.categoryCounts,
    clusters,
    clustersTruncated: issueSet.clusters.length > clusters.length,
    ...(issueSet.activeCluster ? {
      activeCluster: {
        clusterId: boundedText(issueSet.activeCluster.clusterId, 160),
        category: issueSet.activeCluster.category,
        priority: issueSet.activeCluster.priority,
        ...(issueSet.activeCluster.fileId
          ? { fileId: boundedText(issueSet.activeCluster.fileId, 200) }
          : {}),
        issueCount: issueSet.activeCluster.issueCount,
        issues: issueSet.activeCluster.issues
          .slice(0, CHECKPOINT_ISSUE_SAMPLE_LIMIT)
          .map(projectCheckpointIssue),
        issuesTruncated: issueSet.activeCluster.issues.length > CHECKPOINT_ISSUE_SAMPLE_LIMIT,
      },
    } : {}),
  };
}

function projectCheckpointDiagnosticDelta(delta: DiagnosticDelta) {
  const projectBucket = (issues: readonly DiagnosticDelta["resolved"][number][]) => (
    issues.slice(0, CHECKPOINT_ISSUE_SAMPLE_LIMIT).map(projectCheckpointIssue)
  );
  return {
    protocolVersion: delta.protocolVersion,
    counts: delta.counts,
    resolved: projectBucket(delta.resolved),
    unchanged: projectBucket(delta.unchanged),
    introduced: projectBucket(delta.introduced),
    regressed: projectBucket(delta.regressed),
    truncated: {
      resolved: delta.resolved.length > CHECKPOINT_ISSUE_SAMPLE_LIMIT,
      unchanged: delta.unchanged.length > CHECKPOINT_ISSUE_SAMPLE_LIMIT,
      introduced: delta.introduced.length > CHECKPOINT_ISSUE_SAMPLE_LIMIT,
      regressed: delta.regressed.length > CHECKPOINT_ISSUE_SAMPLE_LIMIT,
    },
  };
}

function projectCheckpointIssue(issue: DiagnosticDelta["resolved"][number]) {
  return {
    issueId: boundedText(issue.issueId, 160),
    category: issue.category,
    priority: issue.priority,
    severity: issue.severity,
    ...(issue.code ? { code: boundedText(issue.code, 160) } : {}),
    messageHash: hashContent(issue.message),
    ...(issue.fileId ? { fileId: boundedText(issue.fileId, 200) } : {}),
    ...(issue.line !== undefined ? { line: issue.line } : {}),
    ...(issue.column !== undefined ? { column: issue.column } : {}),
    ...(issue.from !== undefined ? { from: issue.from } : {}),
    ...(issue.to !== undefined ? { to: issue.to } : {}),
    ...(issue.targetConstruct ? { targetConstruct: issue.targetConstruct } : {}),
  };
}

function projectCheckpointCandidateChangeSummary(summary: CandidateChangeSummary) {
  const projectDeclaration = (change: CandidateChangeSummary["declarations"]["added"][number]) => ({
    kind: boundedText(change.kind, 80),
    name: boundedText(change.name, 200),
    line: change.line,
  });
  const projectStructure = (change: CandidateChangeSummary["structure"]["added"][number]) => ({
    kind: boundedText(change.kind, 80),
    ...(change.name ? { name: boundedText(change.name, 200) } : {}),
    ...(change.qualifiedName ? { qualifiedName: boundedText(change.qualifiedName, 300) } : {}),
    ...(change.fileId ? { fileId: boundedText(change.fileId, 200) } : {}),
    ...(change.line !== undefined ? { line: change.line } : {}),
  });
  return {
    protocolVersion: summary.protocolVersion,
    fromCandidateHash: boundedText(summary.fromCandidateHash, 160),
    toCandidateHash: boundedText(summary.toCandidateHash, 160),
    text: {
      changed: summary.text.changed,
      addedLineCount: summary.text.addedLineCount,
      removedLineCount: summary.text.removedLineCount,
      changedLineCount: summary.text.changedLineCount,
      changedRanges: summary.text.changedRanges.slice(0, CHECKPOINT_CHANGE_SAMPLE_LIMIT),
      changedRangesTruncated: summary.text.changedRanges.length > CHECKPOINT_CHANGE_SAMPLE_LIMIT,
    },
    declarations: {
      addedCount: summary.declarations.added.length,
      removedCount: summary.declarations.removed.length,
      added: summary.declarations.added.slice(0, CHECKPOINT_CHANGE_SAMPLE_LIMIT).map(projectDeclaration),
      removed: summary.declarations.removed.slice(0, CHECKPOINT_CHANGE_SAMPLE_LIMIT).map(projectDeclaration),
      changedKinds: summary.declarations.changedKinds
        .slice(0, CHECKPOINT_CHANGE_SAMPLE_LIMIT)
        .map((kind) => boundedText(kind, 80)),
    },
    structure: {
      addedCount: summary.structure.added.length,
      removedCount: summary.structure.removed.length,
      added: summary.structure.added.slice(0, CHECKPOINT_CHANGE_SAMPLE_LIMIT).map(projectStructure),
      removed: summary.structure.removed.slice(0, CHECKPOINT_CHANGE_SAMPLE_LIMIT).map(projectStructure),
      changedNodeCount: summary.structure.changedNodeCount,
    },
    outOfClusterChange: summary.outOfClusterChange,
    outOfClusterReasons: summary.outOfClusterReasons
      .slice(0, CHECKPOINT_CHANGE_SAMPLE_LIMIT)
      .map((reason) => boundedText(reason, 300)),
  };
}

function projectCheckpointRound(round: RepairRoundTrace) {
  return {
    round: round.round,
    candidateHash: boundedText(round.candidateHash, 160),
    validatorEvidenceHash: boundedText(round.validatorEvidenceHash, 160),
    issueCount: round.issueCount,
    ...(round.activeClusterId ? { activeClusterId: boundedText(round.activeClusterId, 160) } : {}),
    ...(round.activeCategory ? { activeCategory: round.activeCategory } : {}),
    diagnosticDelta: round.diagnosticDelta,
    changedLineCount: round.changedLineCount,
    changedDeclarationKinds: round.changedDeclarationKinds
      .slice(0, CHECKPOINT_CHANGE_SAMPLE_LIMIT)
      .map((kind) => boundedText(kind, 80)),
    changedStructureNodeCount: round.changedStructureNodeCount,
    outOfClusterChange: round.outOfClusterChange,
  };
}

function emptyResult<CANDIDATE>(
  options: ValidatorRepairWorkerOptions<CANDIDATE>,
  candidateCharLimit: number,
  terminalStopReason: RepairWorkerTerminalStopReason,
): ValidatorRepairWorkerResult<CANDIDATE> {
  return {
    usage: zeroUsage(),
    finishReason: terminalStopReason,
    steps: [],
    candidateCharLimit,
    terminalStopReason,
    validatorCalls: options.initialValidatorCalls,
    candidateAttempts: 0,
    candidateSubmissionCalls: 0,
    knowledgeQueriesBeforeFirstCandidateSubmission: 0,
    candidateRepeatedCount: 0,
    consecutiveNoProgress: 0,
    toolInputInvalidCount: 0,
    knowledgeQueries: 0,
    knowledgeBackendCalls: 0,
    knowledgeNoNewEvidenceCount: 0,
    knowledgeQueriesByRound: [],
    contextAdmissions: [],
    convergenceTrace: {
      ...(options.initialValidation ? {
        initialIssueSet: createRepairIssueSet(
          options.initialValidation,
          hashContent(options.initialCandidateContent),
        ),
      } : {}),
      rounds: [],
    },
    ...(options.evaluationMode === "local_benchmark" ? {
      evaluationTrace: { knowledgeQueries: [], failedCandidates: [] },
    } : {}),
    attempts: [],
  };
}
