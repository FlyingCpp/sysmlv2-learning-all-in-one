import type { CandidateArtifact } from "./types.mjs";
import type { RunResources } from "./run-resources.mjs";
import {
  runValidatorRepairWorker,
  type ValidatorRepairWorkerOptions,
} from "./validator-repair-worker.mjs";
import type {
  CandidateTaskView,
  CandidateWorkerResult,
  RepairTaskView,
  RepairWorkerResult,
  WorkerResult,
  WorkerTaskView,
  WorkerTerminalStatus,
} from "./worker-contracts.mjs";
import {
  createValidatedPassedResult,
  createWorkerFailureResult,
} from "./worker-result.mjs";

export type RepairWorkerOptions<TASK extends WorkerTaskView = WorkerTaskView> = Omit<
  ValidatorRepairWorkerOptions<CandidateArtifact>,
  "runResources" | "taskView" | "runtimeContext" | "initialKnowledge"
> & {
  readonly resources: RunResources;
  readonly task: TASK;
};

/** 将既有AI SDK ToolLoop结果收敛为携带真实业务对象的WorkerResult。 */
export async function runRepairWorker<TASK extends WorkerTaskView>(
  options: RepairWorkerOptions<TASK>,
): Promise<TASK extends CandidateTaskView ? CandidateWorkerResult : RepairWorkerResult> {
  const { resources, task, ...workerOptions } = options;
  const result = await runValidatorRepairWorker({
    ...workerOptions,
    runResources: resources,
    taskView: task,
  });
  const accepted = result.accepted;
  const status = repairStatus(result.terminalStopReason, options.abortSignal.aborted, Boolean(accepted));
  if (status === "validated_passed") {
    if (!accepted) {
      throw new Error("Repair Worker reported validator_passed without real business objects");
    }
    return createValidatedPassedResult({
      task,
      candidate: accepted.candidate,
      validation: accepted.validation,
      attemptCount: result.candidateAttempts,
      repairTelemetry: {
        contextAdmissions: result.contextAdmissions,
        convergenceTrace: result.convergenceTrace,
      },
    });
  }
  return createWorkerFailureResult({
    task,
    status,
    reason: result.terminalStopReason,
    attemptCount: result.candidateAttempts,
    repairTelemetry: {
      contextAdmissions: result.contextAdmissions,
      convergenceTrace: result.convergenceTrace,
    },
  });
}

function repairStatus(
  reason: string,
  aborted: boolean,
  accepted: boolean,
): Exclude<WorkerTerminalStatus, "validated_passed"> | "validated_passed" {
  if (accepted && reason === "validator_passed") return "validated_passed";
  if (aborted) return "cancelled";
  if ([
    "candidate_budget_exhausted",
    "validator_budget_exhausted",
    "repair_context_budget_exhausted",
    "repair_time_budget_exhausted",
    "repair_no_progress",
    "step_budget_exhausted",
    "validator_queue_full",
    "validator_queue_timeout",
    "validator_execution_timeout",
  ].includes(reason)) return "exhausted";
  if (reason === "validator_unavailable" || reason === "repair_context_not_admitted") {
    return "worker_error";
  }
  return "validated_failed";
}
