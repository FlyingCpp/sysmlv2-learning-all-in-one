import { createHash } from "node:crypto";

import type {
  MainAgentOutcome,
  TeacherAgentContext,
} from "./types.mjs";

export type TaskWorkerType = "candidate" | "repair";

export type AuthorizedTargetBinding =
  | {
    readonly kind: "active_file";
    readonly fileId: string;
    readonly baseHash: string;
  }
  | { readonly kind: "standalone_model" };

export interface BaselineSnapshotBinding {
  readonly snapshotHash: string;
  readonly files: readonly {
    readonly fileId: string;
    readonly contentHash: string;
    readonly editable: boolean;
  }[];
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
  }): TaskWorkingState {
    const key = `${this.#runId}:${input.outcome.acceptedToolCallId}`;
    const target = Object.freeze(deriveTarget(input.outcome, input.context));
    const baseline = deriveBaseline(input.context);
    const existing = this.#statesByDelegation.get(key);
    if (existing) {
      const sameWorker = input.outcome.type === "delegate_candidate"
        ? existing.workerType === "candidate" && existing.mode === input.outcome.mode
        : existing.workerType === "repair" && existing.scope === input.outcome.scope;
      if (existing.questionHash !== input.questionHash
        || !sameWorker
        || JSON.stringify(existing.target) !== JSON.stringify(target)
        || existing.baseline.snapshotHash !== baseline.snapshotHash) {
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
      ? { ...base, workerType: "candidate", mode: input.outcome.mode }
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
): AuthorizedTargetBinding {
  const standalone = outcome.type === "delegate_candidate"
    ? outcome.mode === "milestone"
    : outcome.scope === "standalone_model";
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

function deriveBaseline(context: TeacherAgentContext): BaselineSnapshotBinding {
  const files = context.model.files.map((file) => ({
    fileId: file.fileId,
    contentHash: file.contentHash,
    editable: file.editable,
  }));
  return Object.freeze({
    snapshotHash: stableHash(files),
    files: Object.freeze(files.map((file) => Object.freeze(file))),
  });
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
