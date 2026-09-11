import { createHash } from "node:crypto";

import type {
  CandidateArtifact,
  MainAgentOutcome,
  TeacherAgentContext,
  ValidationOutput,
} from "./types.mjs";

export type TaskWorkerType = "candidate" | "repair";

export type AuthorizedTargetBinding =
  | {
    readonly kind: "active_file";
    readonly fileId: string;
    readonly baseHash: string;
  }
  | { readonly kind: "standalone_model"; readonly fileName?: string };

export interface BaselineSnapshotBinding {
  readonly snapshotHash: string;
  readonly files: readonly {
    readonly fileId: string;
    readonly contentHash: string;
    readonly editable: boolean;
  }[];
}

export interface ValidatedCandidateModelBinding {
  readonly provenance: "previous_delivered_candidate" | "current_run_validated_candidate";
  readonly sourceRunId: string;
  readonly candidateWorkspaceHash: string;
  readonly target: AuthorizedTargetBinding;
  readonly model: Readonly<
    Omit<TeacherAgentContext["model"], "files" | "diagnostics"> & {
      readonly files: readonly Readonly<TeacherAgentContext["model"]["files"][number]>[];
      readonly diagnostics: readonly Readonly<TeacherAgentContext["model"]["diagnostics"][number]>[];
    }
  >;
  readonly candidate?: CandidateArtifact;
  readonly validation?: ValidationOutput;
}

export interface TaskIterationDirectiveBinding {
  readonly directiveId: string;
  readonly contractId: string;
  readonly contractRevision: number;
  readonly mode: "create" | "complete" | "refine" | "milestone";
  readonly subject:
    | "current_workspace"
    | "previous_validated_candidate"
    | "current_validated_candidate"
    | "last_validated_candidate"
    | "standalone_model";
  readonly taskSummary: string;
  readonly instruction: string;
}

interface TaskWorkingStateBase {
  readonly version: "task-working-state-v1";
  readonly taskId: string;
  readonly runId: string;
  readonly questionHash: string;
  readonly acceptedToolCallId: string;
  readonly target: AuthorizedTargetBinding;
  readonly baseline: BaselineSnapshotBinding;
  readonly preservationPolicyRef: string;
  readonly revision: number;
  readonly status:
    | "delegated"
    | "worker_running"
    | "validating"
    | "worker_completed"
    | "worker_failed"
    | "cancelled";
  readonly terminalReason?: string;
}

export type TaskWorkingState = TaskWorkingStateBase & (
  | {
    readonly workerType: "candidate";
    readonly mode: "create" | "complete" | "refine" | "milestone";
    readonly subject:
      | "current_workspace"
      | "previous_validated_candidate"
      | "current_validated_candidate"
      | "last_validated_candidate"
      | "standalone_model";
    readonly validatedCandidateBinding?: ValidatedCandidateModelBinding;
    readonly iterationDirective?: TaskIterationDirectiveBinding;
  }
  | {
    readonly workerType: "repair";
    readonly scope: "active_file" | "standalone_model";
  }
);

export type TaskTransitionEvent =
  | { readonly type: "worker_started" }
  | { readonly type: "validation_started" }
  | { readonly type: "worker_completed" }
  | { readonly type: "worker_failed"; readonly reason: string }
  | { readonly type: "cancelled"; readonly reason: string };

export class TaskStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskStateConflictError";
  }
}

export class TaskWorkingStateStore {
  readonly #runId: string;
  readonly #statesByDelegation = new Map<string, TaskWorkingState>();

  constructor(runId: string) {
    this.#runId = runId;
  }

  materialize(input: {
    questionHash: string;
    outcome: Extract<MainAgentOutcome, { type: "delegate_candidate" | "delegate_repair" }>;
    context: TeacherAgentContext;
    currentValidatedCandidateBinding?: ValidatedCandidateModelBinding;
    iterationDirective?: TaskIterationDirectiveBinding;
  }): TaskWorkingState {
    const key = `${this.#runId}:${input.outcome.acceptedToolCallId}`;
    const validatedCandidateBinding = deriveValidatedCandidateBinding(
      input.outcome,
      input.context,
      input.currentValidatedCandidateBinding,
    );
    const target = Object.freeze(deriveTarget(input.outcome, input.context, validatedCandidateBinding));
    const baseline = deriveBaseline(input.outcome, input.context, validatedCandidateBinding);
    const existing = this.#statesByDelegation.get(key);
    if (existing) {
      const sameWorker = input.outcome.type === "delegate_candidate"
        ? existing.workerType === "candidate"
          && existing.mode === input.outcome.mode
          && existing.subject === input.outcome.subject
        : existing.workerType === "repair" && existing.scope === input.outcome.scope;
      if (existing.questionHash !== input.questionHash
        || !sameWorker
        || JSON.stringify(existing.target) !== JSON.stringify(target)
        || existing.baseline.snapshotHash !== baseline.snapshotHash
        || (existing.workerType === "candidate"
          && existing.validatedCandidateBinding?.candidateWorkspaceHash
            !== validatedCandidateBinding?.candidateWorkspaceHash)
        || (existing.workerType === "candidate"
          && JSON.stringify(existing.iterationDirective) !== JSON.stringify(input.iterationDirective))) {
        throw new TaskStateConflictError(
          `acceptedToolCallId ${input.outcome.acceptedToolCallId} was rebound to different task facts`,
        );
      }
      return existing;
    }

    const base = {
      version: "task-working-state-v1" as const,
      taskId: stableId("task", key),
      runId: this.#runId,
      questionHash: input.questionHash,
      acceptedToolCallId: input.outcome.acceptedToolCallId,
      target,
      baseline,
      preservationPolicyRef: "preserve-authorized-baseline-v1",
      revision: 0,
      status: "delegated" as const,
    };
    const created: TaskWorkingState = input.outcome.type === "delegate_candidate"
      ? {
        ...base,
        workerType: "candidate",
        mode: input.outcome.mode,
        subject: input.outcome.subject,
        ...(validatedCandidateBinding ? { validatedCandidateBinding } : {}),
        ...(input.iterationDirective ? { iterationDirective: Object.freeze({ ...input.iterationDirective }) } : {}),
      }
      : { ...base, workerType: "repair", scope: input.outcome.scope };
    const frozen = freezeTask(created);
    this.#statesByDelegation.set(key, frozen);
    return frozen;
  }

  transition(
    taskId: string,
    expectedRevision: number,
    event: TaskTransitionEvent,
  ): TaskWorkingState {
    const entry = [...this.#statesByDelegation.entries()]
      .find(([, state]) => state.taskId === taskId);
    if (!entry) throw new TaskStateConflictError(`Unknown task: ${taskId}`);
    const [key, current] = entry;
    if (current.runId !== this.#runId) {
      throw new TaskStateConflictError("Task belongs to a different run");
    }
    if (current.revision !== expectedRevision) {
      throw new TaskStateConflictError(
        `Task revision mismatch: expected ${expectedRevision}, actual ${current.revision}`,
      );
    }
    const next = transitionTask(current, event);
    this.#statesByDelegation.set(key, next);
    return next;
  }

  get(taskId: string): TaskWorkingState | undefined {
    return [...this.#statesByDelegation.values()].find((state) => state.taskId === taskId);
  }

  snapshot(): readonly TaskWorkingState[] {
    return [...this.#statesByDelegation.values()];
  }
}

export function transitionTask(
  current: TaskWorkingState,
  event: TaskTransitionEvent,
): TaskWorkingState {
  if (["worker_completed", "worker_failed", "cancelled"].includes(current.status)) {
    throw new TaskStateConflictError(`Task is terminal: ${current.status}`);
  }
  let patch: Partial<TaskWorkingStateBase>;
  switch (event.type) {
    case "worker_started":
      if (current.status !== "delegated") throw invalidTransition(current.status, event.type);
      patch = { status: "worker_running" };
      break;
    case "validation_started":
      if (current.status !== "worker_running" && current.status !== "validating") {
        throw invalidTransition(current.status, event.type);
      }
      patch = { status: "validating" };
      break;
    case "worker_completed":
      if (current.status !== "worker_running" && current.status !== "validating") {
        throw invalidTransition(current.status, event.type);
      }
      patch = { status: "worker_completed" };
      break;
    case "worker_failed":
      patch = { status: "worker_failed", terminalReason: event.reason };
      break;
    case "cancelled":
      patch = { status: "cancelled", terminalReason: event.reason };
      break;
  }
  return freezeTask({ ...current, ...patch, revision: current.revision + 1 });
}

function deriveTarget(
  outcome: Extract<MainAgentOutcome, { type: "delegate_candidate" | "delegate_repair" }>,
  context: TeacherAgentContext,
  validatedCandidateBinding?: ValidatedCandidateModelBinding,
): AuthorizedTargetBinding {
  const standalone = outcome.type === "delegate_candidate"
    ? outcome.subject !== "current_workspace"
    : outcome.scope === "standalone_model";
  if (outcome.type === "delegate_candidate" && isValidatedCandidateSubject(outcome.subject)) {
    if (!validatedCandidateBinding) {
      throw new TaskStateConflictError("Validated Candidate binding is unavailable");
    }
    return validatedCandidateBinding.target;
  }
  if (standalone || !context.model.activeFileId) return { kind: "standalone_model" };
  const file = context.model.files.find((item) => item.fileId === context.model.activeFileId);
  if (!file) throw new TaskStateConflictError("Active file is not in the authorized baseline");
  if (outcome.type === "delegate_candidate"
    && (!file.editable || !isSysmlSourceFile(file.displayName))) {
    return { kind: "standalone_model" };
  }
  return { kind: "active_file", fileId: file.fileId, baseHash: file.contentHash };
}

function isSysmlSourceFile(displayName: string): boolean {
  return /\.(?:sysml|kerml)$/iu.test(displayName.trim());
}

function deriveBaseline(
  outcome: Extract<MainAgentOutcome, { type: "delegate_candidate" | "delegate_repair" }>,
  context: TeacherAgentContext,
  validatedCandidateBinding?: ValidatedCandidateModelBinding,
): BaselineSnapshotBinding {
  const files = selectedBaselineFiles(outcome, context, validatedCandidateBinding).map((file) => ({
    fileId: file.fileId,
    contentHash: file.contentHash,
    editable: file.editable,
  }));
  return Object.freeze({
    snapshotHash: stableHash(files),
    files: Object.freeze(files.map((file) => Object.freeze(file))),
  });
}

function selectedBaselineFiles(
  outcome: Extract<MainAgentOutcome, { type: "delegate_candidate" | "delegate_repair" }>,
  context: TeacherAgentContext,
  validatedCandidateBinding?: ValidatedCandidateModelBinding,
): readonly TeacherAgentContext["model"]["files"][number][] {
  if (outcome.type !== "delegate_candidate" || outcome.subject === "current_workspace") {
    return context.model.files;
  }
  if (outcome.subject === "standalone_model") return [];
  if (!validatedCandidateBinding) {
    throw new TaskStateConflictError("Validated Candidate binding is unavailable");
  }
  return validatedCandidateBinding.model.files;
}

function deriveValidatedCandidateBinding(
  outcome: Extract<MainAgentOutcome, { type: "delegate_candidate" | "delegate_repair" }>,
  context: TeacherAgentContext,
  current?: ValidatedCandidateModelBinding,
): ValidatedCandidateModelBinding | undefined {
  if (outcome.type !== "delegate_candidate" || !isValidatedCandidateSubject(outcome.subject)) {
    return undefined;
  }
  if (outcome.subject === "current_validated_candidate") {
    if (!current || current.provenance !== "current_run_validated_candidate") {
      throw new TaskStateConflictError("Current validated Candidate binding is unavailable");
    }
    return current;
  }
  const candidate = context.conversationSubjects?.lastValidatedCandidate;
  if (!candidate) throw new TaskStateConflictError("Previous validated Candidate is unavailable");
  const file = Object.freeze({
    fileId: candidate.fileId,
    displayName: candidate.displayName,
    content: candidate.content,
    contentHash: candidate.contentHash,
    editable: true,
  });
  return Object.freeze({
    provenance: "previous_delivered_candidate",
    sourceRunId: candidate.sourceRunId,
    candidateWorkspaceHash: candidate.candidateWorkspaceHash,
    target: Object.freeze({ kind: "standalone_model", fileName: candidate.displayName }),
    model: Object.freeze({
      entryFileId: file.fileId,
      activeFileId: file.fileId,
      files: Object.freeze([file]),
      diagnostics: Object.freeze([]),
    }),
  });
}

export function createCurrentValidatedCandidateBinding(input: {
  runId: string;
  candidate: CandidateArtifact;
  validation: ValidationOutput;
  baselineModel: TeacherAgentContext["model"] | ValidatedCandidateModelBinding["model"];
}): ValidatedCandidateModelBinding {
  if (!input.validation.candidateWorkspaceHash
    || input.validation.completeness !== "complete"
    || input.validation.official.syntax !== "passed"
    || input.validation.official.semantic !== "passed") {
    throw new TaskStateConflictError("Current Candidate is not bound to a complete Validator PASS");
  }
  const model = projectCandidateModel(input.candidate, input.baselineModel, input.runId);
  const active = model.files.find((file) => file.fileId === model.activeFileId);
  const target: AuthorizedTargetBinding = input.candidate.mode === "standalone_model"
    || !active
    || !active.editable
    || !isSysmlSourceFile(active.displayName)
      ? Object.freeze({ kind: "standalone_model", fileName: active?.displayName })
      : Object.freeze({ kind: "active_file", fileId: active.fileId, baseHash: active.contentHash });
  return Object.freeze({
    provenance: "current_run_validated_candidate",
    sourceRunId: input.runId,
    candidateWorkspaceHash: input.validation.candidateWorkspaceHash,
    target,
    model,
    candidate: Object.freeze(input.candidate),
    validation: Object.freeze(input.validation),
  });
}

function projectCandidateModel(
  candidate: CandidateArtifact,
  baseline: TeacherAgentContext["model"] | ValidatedCandidateModelBinding["model"],
  runId: string,
): ValidatedCandidateModelBinding["model"] {
  if (candidate.mode === "standalone_model") {
    const fileId = stableId("candidate_file", `${runId}\n${candidate.fileName}\n${contentHash(candidate.content)}`);
    const file = Object.freeze({
      fileId,
      displayName: candidate.fileName,
      content: candidate.content,
      contentHash: contentHash(candidate.content),
      editable: true,
    });
    return Object.freeze({
      entryFileId: fileId,
      activeFileId: fileId,
      files: Object.freeze([file]),
      diagnostics: Object.freeze([]),
    });
  }
  const files = baseline.files.map((file) => ({ ...file }));
  if (candidate.mode === "replace_entry") {
    const target = files.find((file) => file.fileId === candidate.fileId);
    if (!target || target.contentHash !== candidate.baseHash) {
      throw new TaskStateConflictError("Current Candidate target is outside its validated baseline");
    }
    target.content = candidate.content;
    target.contentHash = contentHash(candidate.content);
  } else if (candidate.mode === "workspace_files") {
    for (const replacement of candidate.files) {
      const target = files.find((file) => file.fileId === replacement.fileId);
      if (!target || target.contentHash !== replacement.baseHash) {
        throw new TaskStateConflictError("Current Candidate file is outside its validated baseline");
      }
      target.content = replacement.content;
      target.contentHash = contentHash(replacement.content);
    }
  } else {
    const editsByFile = new Map<string, typeof candidate.edits>();
    for (const edit of candidate.edits) {
      editsByFile.set(edit.fileId, [...(editsByFile.get(edit.fileId) ?? []), edit]);
    }
    for (const [fileId, edits] of editsByFile) {
      const target = files.find((file) => file.fileId === fileId);
      if (!target || edits.some((edit) => edit.baseHash !== target.contentHash)) {
        throw new TaskStateConflictError("Current Candidate edit is outside its validated baseline");
      }
      const lines = target.content.split(/\r\n|\r|\n/u);
      for (const edit of [...edits].sort((left, right) => (
        right.startLine - left.startLine || right.endLine - left.endLine
      ))) {
        lines.splice(
          edit.startLine - 1,
          edit.endLine - edit.startLine + 1,
          ...edit.replacement.split(/\r\n|\r|\n/u),
        );
      }
      target.content = lines.join("\n");
      target.contentHash = contentHash(target.content);
    }
  }
  return Object.freeze({
    ...baseline,
    files: Object.freeze(files.map((file) => Object.freeze(file))),
    diagnostics: Object.freeze([]),
  });
}

function isValidatedCandidateSubject(
  subject: Extract<MainAgentOutcome, { type: "delegate_candidate" }>["subject"],
): boolean {
  return subject === "previous_validated_candidate"
    || subject === "current_validated_candidate"
    || subject === "last_validated_candidate";
}

function freezeTask<T extends TaskWorkingState>(task: T): T {
  return Object.freeze(task);
}

function invalidTransition(status: TaskWorkingState["status"], event: string): TaskStateConflictError {
  return new TaskStateConflictError(`Invalid task transition: ${status} -> ${event}`);
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24)}`;
}

function stableHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

function contentHash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
