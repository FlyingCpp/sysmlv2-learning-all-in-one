import type { KnowledgeView, RunInputSnapshot } from "./run-resources.mjs";
import type {
  AuthorizedTargetBinding,
  BaselineSnapshotBinding,
} from "./task-working-state.mjs";
import type { CandidateArtifact, ValidationOutput } from "./types.mjs";
import type {
  CandidateChangeSummary,
  DiagnosticDelta,
  RepairIssueSet,
  RepairRoundTrace,
} from "./repair-convergence.mjs";

export type CandidateMode = "create" | "complete" | "refine" | "milestone";
export type RepairScope = "active_file" | "standalone_model";

interface WorkerTaskViewBase {
  readonly version: "worker-task-view-v1";
  readonly runId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly question: string;
  readonly questionHash: string;
  readonly conversationMessages: RunInputSnapshot["conversationMessages"];
  readonly taskSources: RunInputSnapshot["taskSources"];
  readonly authorizationScopeRef: string;
  readonly target: AuthorizedTargetBinding;
  readonly baseline: BaselineSnapshotBinding;
  readonly preservationPolicyRef: string;
  readonly model: RunInputSnapshot["model"];
  readonly knowledge: KnowledgeView;
}

export type CandidateTaskView = Readonly<WorkerTaskViewBase & {
  readonly workerType: "candidate";
  readonly mode: CandidateMode;
}>;

export type RepairTaskView = Readonly<WorkerTaskViewBase & {
  readonly workerType: "repair";
  readonly scope: RepairScope;
}>;

export type WorkerTaskView = CandidateTaskView | RepairTaskView;

export type WorkerTerminalStatus =
  | "validated_passed"
  | "validated_failed"
  | "exhausted"
  | "cancelled"
  | "worker_error";

export interface RepairContextAdmission {
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
  readonly activeTools: readonly ("search_reviewed_knowledge" | "submit_candidate_for_validation")[];
  readonly stopReason?: string;
}

export interface RepairTelemetry {
  readonly contextAdmissions: readonly RepairContextAdmission[];
  readonly convergenceTrace: Readonly<{
    initialIssueSet?: RepairIssueSet;
    latestIssueSet?: RepairIssueSet;
    latestDiagnosticDelta?: DiagnosticDelta;
    latestCandidateChangeSummary?: CandidateChangeSummary;
    rounds: readonly RepairRoundTrace[];
  }>;
}

interface WorkerResultBase {
  readonly version: "worker-result-v2";
  readonly runId: string;
  readonly taskId: string;
  /** Worker启动后所读取的Task revision；Dispatcher用它做CAS。 */
  readonly taskRevision: number;
  readonly attemptCount: number;
  readonly repairTelemetry?: RepairTelemetry;
}

type ValidatedPassedPayload = {
  readonly status: "validated_passed";
  readonly candidate: CandidateArtifact;
  readonly validation: ValidationOutput;
};

type WorkerFailurePayload = {
  readonly status: Exclude<WorkerTerminalStatus, "validated_passed">;
  readonly validation?: ValidationOutput;
  readonly reason: string;
};

export type CandidateWorkerResult = Readonly<WorkerResultBase & {
  readonly workerType: "candidate";
  readonly mode: CandidateMode;
} & (ValidatedPassedPayload | WorkerFailurePayload)>;

export type RepairWorkerResult = Readonly<WorkerResultBase & {
  readonly workerType: "repair";
  readonly scope: RepairScope;
} & (ValidatedPassedPayload | WorkerFailurePayload)>;

export type WorkerResult = CandidateWorkerResult | RepairWorkerResult;

export type DispatchRejectReason =
  | "unknown_task"
  | "task_revision_conflict"
  | "task_not_delegated"
  | "question_hash_conflict"
  | "baseline_conflict"
  | "budget_exhausted"
  | "cancelled"
  | "deadline_exceeded";

export type DispatchOutcome =
  | Readonly<{
    type: "rejected";
    reason: DispatchRejectReason;
  }>
  | Readonly<{
    type: "completed";
    result: WorkerResult;
  }>;

/** Validator Adapter返回真实Candidate与Validation，二者在同一次服务端调用中完成绑定。 */
export interface CandidateValidationOutcome {
  readonly passed: boolean;
  readonly retryable: boolean;
  readonly candidate: CandidateArtifact;
  readonly validation: ValidationOutput;
  readonly reason: string;
}
