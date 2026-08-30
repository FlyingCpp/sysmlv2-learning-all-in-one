import { createHash } from "node:crypto";

import { projectWorkerEvidenceView, type RunResources } from "./run-resources.mjs";
import {
  TaskStateConflictError,
  type TaskWorkingState,
} from "./task-working-state.mjs";
import type {
  CandidateTaskView,
  CandidateWorkerResult,
  DispatchOutcome,
  DispatchRejectReason,
  RepairTaskView,
  RepairWorkerResult,
  WorkerResult,
  WorkerTaskView,
} from "./worker-contracts.mjs";
import { createWorkerFailureResult } from "./worker-result.mjs";

export interface WorkerExecutionContext {
  readonly resources: RunResources;
  readonly abortSignal: AbortSignal;
}

export interface WorkerHandlers {
  readonly candidate: (
    task: CandidateTaskView,
    context: WorkerExecutionContext,
  ) => Promise<CandidateWorkerResult>;
  readonly repair: (
    task: RepairTaskView,
    context: WorkerExecutionContext,
  ) => Promise<RepairWorkerResult>;
}

export interface WorkerDispatcherInput {
  readonly resources: RunResources;
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly abortSignal: AbortSignal;
  readonly workers: WorkerHandlers;
}

export interface ResumedWorkerDispatcherInput {
  readonly resources: RunResources;
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly abortSignal: AbortSignal;
  readonly execute: (
    task: WorkerTaskView,
    context: WorkerExecutionContext,
  ) => Promise<WorkerResult>;
}

/** Dispatcher是确定性业务路由：不调用LLM，不接收重复action，也不生成最终学生回答。 */
export async function dispatchWorker(input: WorkerDispatcherInput): Promise<DispatchOutcome> {
  const rejected = preflight(input);
  if (rejected) return Object.freeze({ type: "rejected", reason: rejected });

  const delegated = input.resources.tasks.get(input.taskId);
  if (!delegated) return Object.freeze({ type: "rejected", reason: "unknown_task" });
  const running = input.resources.tasks.transition(
    delegated.taskId,
    delegated.revision,
    { type: "worker_started" },
  );
  const taskView = projectWorkerTaskView(input.resources, running);

  let result: WorkerResult;
  try {
    result = taskView.workerType === "candidate"
      ? await input.workers.candidate(taskView, {
        resources: input.resources,
        abortSignal: input.abortSignal,
      })
      : await input.workers.repair(taskView, {
        resources: input.resources,
        abortSignal: input.abortSignal,
      });
    input.abortSignal.throwIfAborted();
    assertWorkerResult(result, taskView);
  } catch (error) {
    result = workerErrorResult(taskView, input.abortSignal.aborted
      ? workerAbortReason(input.abortSignal)
      : boundedReason(error));
  }

  settleWorkerTask(input.resources, running.taskId, result);
  return Object.freeze({ type: "completed", result });
}

/** 恢复执行仍经Dispatcher推进Task状态机，但不会重新进入Candidate生成。 */
export async function dispatchResumedWorker(
  input: ResumedWorkerDispatcherInput,
): Promise<DispatchOutcome> {
  const rejected = preflightResumed(input);
  if (rejected) return Object.freeze({ type: "rejected", reason: rejected });

  const delegated = input.resources.tasks.get(input.taskId);
  if (!delegated) return Object.freeze({ type: "rejected", reason: "unknown_task" });
  const running = input.resources.tasks.transition(
    delegated.taskId,
    delegated.revision,
    { type: "worker_started" },
  );
  const taskView = projectWorkerTaskView(input.resources, running);

  let result: WorkerResult;
  try {
    result = await input.execute(taskView, {
      resources: input.resources,
      abortSignal: input.abortSignal,
    });
    input.abortSignal.throwIfAborted();
    assertWorkerResult(result, taskView);
  } catch (error) {
    result = workerErrorResult(taskView, input.abortSignal.aborted
      ? workerAbortReason(input.abortSignal)
      : boundedReason(error));
  }

  settleWorkerTask(input.resources, running.taskId, result);
  return Object.freeze({ type: "completed", result });
}

export function projectWorkerTaskView(
  resources: RunResources,
  task: TaskWorkingState,
): WorkerTaskView {
  if (task.runId !== resources.runId || task.questionHash !== resources.input.questionHash) {
    throw new TaskStateConflictError("Task does not belong to the bound Run input");
  }
  const base = {
    version: "worker-task-view-v1" as const,
    runId: task.runId,
    taskId: task.taskId,
    taskRevision: task.revision,
    question: resources.input.question,
    questionHash: task.questionHash,
    conversationMessages: resources.input.conversationMessages,
    taskSources: resources.input.taskSources,
    authorizationScopeRef: resources.input.authorizationScopeRef,
    target: task.target,
    baseline: task.baseline,
    preservationPolicyRef: task.preservationPolicyRef,
    model: resources.input.model,
    knowledge: projectWorkerEvidenceView(resources, task),
  };
  return task.workerType === "candidate"
    ? Object.freeze({ ...base, workerType: "candidate", mode: task.mode })
    : Object.freeze({ ...base, workerType: "repair", scope: task.scope });
}

function preflight(input: WorkerDispatcherInput): DispatchRejectReason | undefined {
  const task = input.resources.tasks.get(input.taskId);
  if (!task) return "unknown_task";
  if (task.revision !== input.expectedRevision) return "task_revision_conflict";
  if (task.status !== "delegated") return "task_not_delegated";
  if (task.questionHash !== input.resources.input.questionHash) return "question_hash_conflict";
  if (task.baseline.snapshotHash !== currentBaselineHash(input.resources)) return "baseline_conflict";
  if (input.abortSignal.aborted) {
    return workerAbortReason(input.abortSignal) !== "caller_cancelled"
      ? "deadline_exceeded"
      : "cancelled";
  }
  if (!input.resources.isAllowed("main_delegate")) return "deadline_exceeded";
  const budget = input.resources.budget.view();
  if (budget.remainingOperations.validator <= 0) return "budget_exhausted";
  if (task.workerType === "candidate"
    && budget.remainingOperations.candidate_generation <= 0) return "budget_exhausted";
  return undefined;
}

function preflightResumed(input: ResumedWorkerDispatcherInput): DispatchRejectReason | undefined {
  const task = input.resources.tasks.get(input.taskId);
  if (!task) return "unknown_task";
  if (task.revision !== input.expectedRevision) return "task_revision_conflict";
  if (task.status !== "delegated") return "task_not_delegated";
  if (task.questionHash !== input.resources.input.questionHash) return "question_hash_conflict";
  if (task.baseline.snapshotHash !== currentBaselineHash(input.resources)) return "baseline_conflict";
  if (input.abortSignal.aborted) {
    return workerAbortReason(input.abortSignal) !== "caller_cancelled"
      ? "deadline_exceeded"
      : "cancelled";
  }
  if (!input.resources.isAllowed("main_delegate")) return "deadline_exceeded";
  if (input.resources.budget.view().remainingOperations.validator <= 0) return "budget_exhausted";
  return undefined;
}

function currentBaselineHash(resources: RunResources): string {
  const files = resources.input.model.files.map((file) => ({
    fileId: file.fileId,
    contentHash: file.contentHash,
    editable: file.editable,
  }));
  return `sha256:${createHash("sha256").update(JSON.stringify(files), "utf8").digest("hex")}`;
}

function assertWorkerResult(result: WorkerResult, task: WorkerTaskView): void {
  if (result.version !== "worker-result-v2"
    || result.runId !== task.runId
    || result.taskId !== task.taskId
    || result.taskRevision !== task.taskRevision
    || result.workerType !== task.workerType) {
    throw new TaskStateConflictError("WorkerResult is not bound to the dispatched Task revision");
  }
  if (result.workerType === "candidate" && task.workerType === "candidate" && result.mode !== task.mode) {
    throw new TaskStateConflictError("Candidate WorkerResult mode does not match Task");
  }
  if (result.workerType === "repair" && task.workerType === "repair" && result.scope !== task.scope) {
    throw new TaskStateConflictError("Repair WorkerResult scope does not match Task");
  }
  if (!Number.isInteger(result.attemptCount) || result.attemptCount < 0) {
    throw new TaskStateConflictError("WorkerResult attemptCount is invalid");
  }
  if (result.status !== "validated_passed") assertReason(result.reason);
}

export function settleWorkerTask(resources: RunResources, taskId: string, result: WorkerResult): void {
  const current = resources.tasks.get(taskId);
  if (!current || ["worker_completed", "worker_failed", "cancelled"].includes(current.status)) return;
  try {
    if (result.status === "validated_passed") {
      resources.tasks.transition(current.taskId, current.revision, { type: "worker_completed" });
      return;
    }
    if (result.status === "cancelled") {
      resources.tasks.transition(current.taskId, current.revision, {
        type: "cancelled",
        reason: result.reason,
      });
      return;
    }
    resources.tasks.transition(current.taskId, current.revision, {
      type: "worker_failed",
      reason: result.reason,
    });
  } catch (error) {
    if (!(error instanceof TaskStateConflictError)) throw error;
    const latest = resources.tasks.get(taskId);
    if (!latest || !["worker_completed", "worker_failed", "cancelled"].includes(latest.status)) {
      throw error;
    }
  }
}

function workerErrorResult(task: WorkerTaskView, reason: string): WorkerResult {
  const cancelled = [
    "caller_cancelled",
    "work_deadline_reached",
    "hard_deadline_reached",
  ].includes(reason);
  return task.workerType === "candidate"
    ? createWorkerFailureResult({
      task,
      status: cancelled ? "cancelled" : "worker_error",
      reason,
      attemptCount: 0,
    })
    : createWorkerFailureResult({
      task,
      status: cancelled ? "cancelled" : "worker_error",
      reason,
      attemptCount: 0,
    });
}

function workerAbortReason(signal: AbortSignal): string {
  const causeCode = signal.reason && typeof signal.reason === "object"
    ? (signal.reason as { causeCode?: unknown }).causeCode
    : undefined;
  return causeCode === "work_deadline_reached" || causeCode === "hard_deadline_reached"
    ? causeCode
    : "caller_cancelled";
}

function assertReason(value: string): void {
  if (!value.trim() || value.length > 500) {
    throw new TaskStateConflictError("WorkerResult reason must be non-empty and bounded");
  }
}

function boundedReason(value: unknown): string {
  const reason = value instanceof Error ? value.message : String(value || "worker_error");
  return reason.trim().slice(0, 500) || "worker_error";
}
