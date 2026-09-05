import { renderSysmlCode, canonicalCodeForBinding } from "./candidate-content.mjs";
import {
  validateCandidateInputSchema,
  validationOutputSchema,
  type CandidateArtifact,
  type ValidationOutput,
} from "./types.mjs";
import type { WorkerResult, WorkerTaskView } from "./worker-contracts.mjs";
import { computeCandidateWorkspaceHash, validationPassed } from "./worker-result.mjs";

export {
  getDeliveryTelemetry,
  recordAdapterLedgerRebuild,
  recordAdapterWorkspaceHashRecompute,
  recordWorkspaceHashCompute,
  resetDeliveryTelemetry,
  type DeliveryTelemetrySnapshot,
} from "./delivery-metrics.mjs";

export const VALIDATED_CANDIDATE_DELIVERY_VERSION = "validated-candidate-delivery-v1";

export type DeliveryTargetKind = "changed_file" | "no_change" | "standalone_model";

export type DeliveryRejectReason =
  | "worker_result_not_validated_passed"
  | "official_not_passed"
  | "workspace_binding_mismatch"
  | "task_revision_conflict"
  | "unauthorized_file_id"
  | "multi_file_delivery_unsupported"
  | "candidate_not_renderable";

export interface DeliveryTarget {
  readonly kind: DeliveryTargetKind;
  readonly fileId: string;
  readonly displayName: string;
}

export interface ValidatedCandidateDelivery {
  readonly version: typeof VALIDATED_CANDIDATE_DELIVERY_VERSION;
  readonly runId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly candidate: CandidateArtifact;
  readonly validation: ValidationOutput;
  readonly deliveryTarget: DeliveryTarget;
}

export type DeliveryFactoryResult =
  | { readonly ok: true; readonly delivery: ValidatedCandidateDelivery }
  | { readonly ok: false; readonly reason: DeliveryRejectReason };

/**
 * 同Run唯一交付工厂。只接受已经由 createValidatedPassedResult 冻结的真实对象，
 * 不再解析 Ledger ref，也不重算 Workspace Hash。
 */
export function createValidatedCandidateDelivery(input: {
  workerResult: WorkerResult;
  task: WorkerTaskView;
}): DeliveryFactoryResult {
  if (input.workerResult.status !== "validated_passed") {
    return { ok: false, reason: "worker_result_not_validated_passed" };
  }
  if (input.workerResult.runId !== input.task.runId
    || input.workerResult.taskId !== input.task.taskId) {
    return { ok: false, reason: "unauthorized_file_id" };
  }
  if (input.workerResult.taskRevision !== input.task.taskRevision) {
    return { ok: false, reason: "task_revision_conflict" };
  }
  const candidate = input.workerResult.candidate;
  const validation = input.workerResult.validation;
  if (!validationPassed(validation)) {
    return { ok: false, reason: "official_not_passed" };
  }
  if (!validation.candidateWorkspaceHash) {
    return { ok: false, reason: "workspace_binding_mismatch" };
  }
  const target = deriveDeliveryTarget(input.task, candidate);
  if (!target.ok) return target;
  const content = candidateBody(candidate);
  if (!content) {
    return { ok: false, reason: "candidate_not_renderable" };
  }
  return {
    ok: true,
    delivery: Object.freeze({
      version: VALIDATED_CANDIDATE_DELIVERY_VERSION,
      runId: input.workerResult.runId,
      taskId: input.workerResult.taskId,
      taskRevision: input.workerResult.taskRevision,
      candidate,
      validation,
      deliveryTarget: Object.freeze(target.deliveryTarget),
    }),
  };
}

/**
 * 跨时间恢复边界：从 Artifact 解引用并核一次 Hash。同Run初次交付不得走这条路径。
 */
export function restoreValidatedCandidateDelivery(input: {
  runId: string;
  taskId: string;
  taskRevision: number;
  candidate: unknown;
  validation: unknown;
  files: readonly Readonly<{
    fileId: string;
    displayName: string;
    content: string;
    contentHash: string;
    editable: boolean;
  }>[];
  expectedWorkspaceHash?: string;
}): DeliveryFactoryResult {
  const candidateParsed = validateCandidateInputSchema.safeParse(input.candidate);
  const validationParsed = validationOutputSchema.safeParse(input.validation);
  if (!candidateParsed.success || !validationParsed.success) {
    return { ok: false, reason: "workspace_binding_mismatch" };
  }
  if (!validationPassed(validationParsed.data)) {
    return { ok: false, reason: "official_not_passed" };
  }
  if (input.expectedWorkspaceHash
    && validationParsed.data.candidateWorkspaceHash !== input.expectedWorkspaceHash) {
    return { ok: false, reason: "workspace_binding_mismatch" };
  }
  const fakeTask = {
    runId: input.runId,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    model: { files: input.files },
    target: candidateParsed.data.mode === "standalone_model"
      ? { kind: "standalone_model" as const }
      : {
        kind: "active_file" as const,
        fileId: candidateParsed.data.mode === "replace_entry"
          ? candidateParsed.data.fileId
          : input.files[0]?.fileId ?? "",
        baseHash: candidateParsed.data.mode === "replace_entry"
          ? candidateParsed.data.baseHash
          : input.files[0]?.contentHash ?? "",
      },
  };
  if (computeCandidateWorkspaceHash(fakeTask as WorkerTaskView, candidateParsed.data) !== validationParsed.data.candidateWorkspaceHash) {
    return { ok: false, reason: "workspace_binding_mismatch" };
  }
  const target = deriveDeliveryTarget(fakeTask, candidateParsed.data);
  if (!target.ok) return target;
  const content = candidateBody(candidateParsed.data);
  if (!content) {
    return { ok: false, reason: "candidate_not_renderable" };
  }
  return {
    ok: true,
    delivery: Object.freeze({
      version: VALIDATED_CANDIDATE_DELIVERY_VERSION,
      runId: input.runId,
      taskId: input.taskId,
      taskRevision: input.taskRevision,
      candidate: Object.freeze(candidateParsed.data),
      validation: Object.freeze(validationParsed.data),
      deliveryTarget: Object.freeze(target.deliveryTarget),
    }),
  };
}

export function candidateBody(candidate: CandidateArtifact): string {
  if (candidate.mode === "standalone_model" || candidate.mode === "replace_entry") {
    return candidate.content;
  }
  if (candidate.mode === "workspace_files") {
    return candidate.files.length === 1 ? candidate.files[0]?.content ?? "" : "";
  }
  return candidate.edits.length === 1 ? candidate.edits[0]?.replacement ?? "" : "";
}

export function renderDeliverySysmlBlock(delivery: ValidatedCandidateDelivery): string {
  const content = canonicalCodeForBinding(candidateBody(delivery.candidate));
  const displayName = delivery.deliveryTarget.displayName
    .replace(/[\r\n`]/gu, "")
    .slice(0, 160);
  return `文件：${displayName}\n\n${renderSysmlCode(content)}`;
}

export { canonicalCodeForBinding } from "./candidate-content.mjs";

function deriveDeliveryTarget(
  task: Pick<WorkerTaskView, "target"> & {
    readonly model: Pick<WorkerTaskView["model"], "files">;
  },
  candidate: CandidateArtifact,
): { ok: false; reason: DeliveryRejectReason } | { ok: true; deliveryTarget: DeliveryTarget } {
  if (candidate.mode === "standalone_model") {
    if (task.target.kind !== "standalone_model") {
      return { ok: false, reason: "unauthorized_file_id" };
    }
    return {
      ok: true,
      deliveryTarget: {
        kind: "standalone_model",
        fileId: "standalone_model",
        displayName: candidate.fileName,
      },
    };
  }
  if (candidate.mode === "replace_entry") {
    const file = task.model.files.find((item) => item.fileId === candidate.fileId);
    if (!file || (task.target.kind === "active_file" && task.target.fileId !== candidate.fileId)) {
      return { ok: false, reason: "unauthorized_file_id" };
    }
    if (file.editable === false && file.content !== candidate.content) {
      return { ok: false, reason: "unauthorized_file_id" };
    }
    return {
      ok: true,
      deliveryTarget: {
        kind: file.content === candidate.content ? "no_change" : "changed_file",
        fileId: candidate.fileId,
        displayName: file.displayName,
      },
    };
  }
  if (candidate.mode === "workspace_files") {
    const changed = candidate.files.filter((item) => {
      const file = task.model.files.find((current) => current.fileId === item.fileId);
      return file && file.content !== item.content;
    });
    if (changed.length > 1 || candidate.files.length > 1) {
      return { ok: false, reason: "multi_file_delivery_unsupported" };
    }
    const only = candidate.files[0];
    const file = only && task.model.files.find((item) => item.fileId === only.fileId);
    if (!only || !file) return { ok: false, reason: "unauthorized_file_id" };
    return {
      ok: true,
      deliveryTarget: {
        kind: file.content === only.content ? "no_change" : "changed_file",
        fileId: only.fileId,
        displayName: file.displayName,
      },
    };
  }
  const fileIds = [...new Set(candidate.edits.map((edit) => edit.fileId))];
  if (fileIds.length !== 1) {
    return { ok: false, reason: "multi_file_delivery_unsupported" };
  }
  const fileId = fileIds[0] ?? "";
  const file = task.model.files.find((item) => item.fileId === fileId);
  if (!file) return { ok: false, reason: "unauthorized_file_id" };
  return {
    ok: true,
    deliveryTarget: {
      kind: "changed_file",
      fileId,
      displayName: file.displayName,
    },
  };
}
