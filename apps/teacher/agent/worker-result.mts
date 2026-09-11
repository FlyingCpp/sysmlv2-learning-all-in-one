import { canonicalWorkspaceText } from "./candidate-content.mjs";
import { createHash } from "node:crypto";

import {
  validateCandidateInputSchema,
  validationOutputSchema,
  type CandidateArtifact,
  type ValidationOutput,
} from "./types.mjs";
import type {
  CandidateTaskView,
  CandidateWorkerResult,
  RepairTaskView,
  RepairWorkerResult,
  RepairTelemetry,
  WorkerTerminalStatus,
  WorkerTaskView,
} from "./worker-contracts.mjs";
import { recordWorkspaceHashCompute } from "./delivery-metrics.mjs";

export function validationPassed(validation: ValidationOutput): boolean {
  return validation.completeness === "complete"
    && Boolean(validation.candidateWorkspaceHash)
    && validation.official.syntax === "passed"
    && validation.official.semantic === "passed";
}

export function validationRetryable(validation: ValidationOutput): boolean {
  if (validation.official.syntax === "unavailable"
    || validation.official.semantic === "unavailable") return false;
  return !validationPassed(validation);
}

/** validated_passed唯一服务端工厂；真实对象在同一进程内直接传递。 */
export function createValidatedPassedResult<TASK extends WorkerTaskView>(input: {
  task: TASK;
  candidate: CandidateArtifact;
  validation: ValidationOutput;
  attemptCount: number;
  workPerformed?: "candidate_produced" | "candidate_repaired" | "none";
  validatorSubject?: "baseline" | "candidate";
  repairTelemetry?: RepairTelemetry;
}): TASK extends CandidateTaskView ? CandidateWorkerResult : RepairWorkerResult {
  const candidate = Object.freeze(validateCandidateInputSchema.parse(input.candidate));
  const validation = Object.freeze(validationOutputSchema.parse(input.validation));
  if (!validationPassed(validation)) {
    throw new Error("validated_passed requires an official complete PASS result");
  }
  const expectedWorkspaceHash = computeCandidateWorkspaceHash(input.task, candidate);
  if (validation.candidateWorkspaceHash !== expectedWorkspaceHash) {
    throw new Error("CandidateArtifact does not match the Validator candidateWorkspaceHash");
  }
  const base = {
    version: "worker-result-v2" as const,
    runId: input.task.runId,
    taskId: input.task.taskId,
    taskRevision: input.task.taskRevision,
    status: "validated_passed" as const,
    candidate,
    validation,
    attemptCount: boundedAttempts(input.attemptCount),
    workPerformed: input.workPerformed ?? (input.task.workerType === "candidate"
      ? "candidate_produced"
      : "candidate_repaired"),
    validatorSubject: input.validatorSubject ?? "candidate",
    ...(input.repairTelemetry ? { repairTelemetry: Object.freeze(input.repairTelemetry) } : {}),
  };
  return (input.task.workerType === "candidate"
    ? Object.freeze({ ...base, workerType: "candidate" as const, mode: input.task.mode })
    : Object.freeze({ ...base, workerType: "repair" as const, scope: input.task.scope })) as
      TASK extends CandidateTaskView ? CandidateWorkerResult : RepairWorkerResult;
}

export function createWorkerFailureResult<TASK extends WorkerTaskView>(input: {
  task: TASK;
  status: Exclude<WorkerTerminalStatus, "validated_passed">;
  reason: unknown;
  attemptCount: number;
  validation?: ValidationOutput;
  repairTelemetry?: RepairTelemetry;
}): TASK extends CandidateTaskView ? CandidateWorkerResult : RepairWorkerResult {
  const base = {
    version: "worker-result-v2" as const,
    runId: input.task.runId,
    taskId: input.task.taskId,
    taskRevision: input.task.taskRevision,
    status: input.status,
    ...(input.validation ? {
      validation: Object.freeze(validationOutputSchema.parse(input.validation)),
    } : {}),
    attemptCount: boundedAttempts(input.attemptCount),
    workPerformed: "none" as const,
    validatorSubject: input.task.workerType === "repair" ? "baseline" as const : "candidate" as const,
    ...(input.repairTelemetry ? { repairTelemetry: Object.freeze(input.repairTelemetry) } : {}),
    reason: boundedReason(input.reason),
  };
  return (input.task.workerType === "candidate"
    ? Object.freeze({ ...base, workerType: "candidate" as const, mode: input.task.mode })
    : Object.freeze({ ...base, workerType: "repair" as const, scope: input.task.scope })) as
      TASK extends CandidateTaskView ? CandidateWorkerResult : RepairWorkerResult;
}

function boundedAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error("attemptCount is invalid");
  return value;
}

function boundedReason(value: unknown): string {
  const reason = value instanceof Error ? value.message : String(value || "worker_error");
  return reason.trim().slice(0, 500) || "worker_error";
}

/** 只在Candidate提交Validator的真实边界核对一次；后续层不再重复计算。 */
export function computeCandidateWorkspaceHash(
  task: WorkerTaskView,
  candidate: CandidateArtifact,
): string {
  recordWorkspaceHashCompute();
  if (candidate.mode === "standalone_model") {
    return hashContent(`standalone/${candidate.fileName}\n${hashContent(candidate.content)}`);
  }
  const files = task.model.files.map((file) => ({
    fileId: file.fileId,
    path: file.workspacePath ?? file.displayName,
    content: file.content,
  }));
  if (candidate.mode === "replace_entry") {
    const file = files.find((item) => item.fileId === candidate.fileId);
    if (!file) throw new Error("CandidateArtifact targets a file outside the bound Task");
    file.content = candidate.content;
  } else if (candidate.mode === "workspace_files") {
    for (const replacement of candidate.files) {
      const file = files.find((item) => item.fileId === replacement.fileId);
      if (!file) throw new Error("CandidateArtifact targets a file outside the bound Task");
      file.content = replacement.content;
    }
  } else {
    const grouped = new Map<string, typeof candidate.edits>();
    for (const edit of candidate.edits) {
      grouped.set(edit.fileId, [...(grouped.get(edit.fileId) ?? []), edit]);
    }
    for (const [fileId, edits] of grouped) {
      const file = files.find((item) => item.fileId === fileId);
      if (!file) throw new Error("CandidateArtifact targets a file outside the bound Task");
      let lines = file.content.split(/\r\n|\r|\n/u);
      for (const edit of [...edits].sort((left, right) => (
        right.startLine - left.startLine || right.endLine - left.endLine
      ))) {
        lines.splice(
          edit.startLine - 1,
          edit.endLine - edit.startLine + 1,
          ...edit.replacement.split(/\r\n|\r|\n/u),
        );
      }
      file.content = lines.join("\n");
    }
  }
  const canonical = canonicalWorkspaceText(files);
  return hashContent(canonical);
}

function hashContent(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
