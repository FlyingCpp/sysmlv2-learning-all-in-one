import type { MainAgentOutcome } from "./types.mjs";
import type { TaskWorkingState } from "./task-working-state.mjs";

export type AnswerObligation = Readonly<
  | {
    version: "teacher-answer-obligation-v1";
    runId: string;
    outcomeType: "direct_answer";
    deliverableType: "natural_language_answer";
  }
  | {
    version: "teacher-answer-obligation-v1";
    runId: string;
    outcomeType: "candidate";
    deliverableType: "validated_candidate_with_explanation";
    taskId: string;
    taskRevision: number;
    candidateMode: "create" | "complete" | "refine" | "milestone";
    preservationPolicyRef: string;
  }
  | {
    version: "teacher-answer-obligation-v1";
    runId: string;
    outcomeType: "repair";
    deliverableType: "validated_repair_with_explanation";
    taskId: string;
    taskRevision: number;
    repairScope: "active_file" | "standalone_model";
    preservationPolicyRef: string;
  }
>;

/** 每Run至多冻结一次；无需内部hash向同进程模块证明自身未改写。 */
export class AnswerObligationStore {
  readonly #runId: string;
  #value: AnswerObligation | undefined;

  constructor(runId: string) {
    this.#runId = runId;
  }

  freeze(input: {
    outcome: Exclude<MainAgentOutcome, {
      type: "scope_rejected" | "clarification_requested" | "resume_execution";
    }>;
    task?: TaskWorkingState;
    taskRevision?: number;
  }): AnswerObligation {
    if (this.#value) throw new Error("Answer Obligation is already frozen for this Run");
    const base = {
      version: "teacher-answer-obligation-v1" as const,
      runId: this.#runId,
    };
    let value: AnswerObligation;
    if (input.outcome.type === "finalize_requested") {
      if (input.task) throw new Error("Direct answer cannot bind a delegated Task");
      value = Object.freeze({
        ...base,
        outcomeType: "direct_answer",
        deliverableType: "natural_language_answer",
      });
    } else {
      const task = input.task;
      if (!task || task.runId !== this.#runId) {
        throw new Error("Delegated Answer Obligation requires the bound Run Task");
      }
      if (!Number.isInteger(input.taskRevision) || (input.taskRevision ?? -1) < task.revision) {
        throw new Error("Delegated Answer Obligation requires the dispatched Task revision");
      }
      if (input.outcome.type === "delegate_candidate") {
        if (task.workerType !== "candidate" || task.mode !== input.outcome.mode) {
          throw new Error("Candidate Answer Obligation does not match the materialized Task");
        }
        value = Object.freeze({
          ...base,
          outcomeType: "candidate",
          deliverableType: "validated_candidate_with_explanation",
          taskId: task.taskId,
          taskRevision: input.taskRevision!,
          candidateMode: task.mode,
          preservationPolicyRef: task.preservationPolicyRef,
        });
      } else {
        if (task.workerType !== "repair" || task.scope !== input.outcome.scope) {
          throw new Error("Repair Answer Obligation does not match the materialized Task");
        }
        value = Object.freeze({
          ...base,
          outcomeType: "repair",
          deliverableType: "validated_repair_with_explanation",
          taskId: task.taskId,
          taskRevision: input.taskRevision!,
          repairScope: task.scope,
          preservationPolicyRef: task.preservationPolicyRef,
        });
      }
    }
    this.#value = value;
    return value;
  }

  get(): AnswerObligation | undefined {
    return this.#value;
  }
}
