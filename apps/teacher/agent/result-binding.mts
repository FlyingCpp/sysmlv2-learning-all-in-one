import type { AnswerObligation } from "./answer-obligation.mjs";
import type { FinalAnswerWorkerResult } from "./final-answer-worker.mjs";
import type { ValidatedCandidateDelivery } from "./validated-candidate-delivery.mjs";
import type { WorkerResult } from "./worker-contracts.mjs";

export type WorkerTerminalBinding = Readonly<{
  version: "teacher-result-binding-v1";
  stage: "worker_terminal";
  obligation: Exclude<AnswerObligation, { outcomeType: "direct_answer" }>;
  workerResult: WorkerResult;
  validatedCandidateDelivery?: ValidatedCandidateDelivery;
}>;

export type FinalResultBinding = Readonly<{
  version: "teacher-result-binding-v1";
  stage: "finalized";
  obligation: AnswerObligation;
  workerResult?: WorkerResult;
  validatedCandidateDelivery?: ValidatedCandidateDelivery;
  finalAnswerWorkerResult: FinalAnswerWorkerResult;
  finalAnswer: string;
  finalization: "final_answer_worker" | "server_bound_main_draft" | "deterministic_fallback";
}>;

export function bindWorkerResult(
  obligation: AnswerObligation,
  workerResult: WorkerResult,
  validatedCandidateDelivery?: ValidatedCandidateDelivery,
): WorkerTerminalBinding {
  if (obligation.outcomeType === "direct_answer") {
    throw new Error("Direct Answer Obligation cannot bind a WorkerResult");
  }
  if (workerResult.runId !== obligation.runId
    || workerResult.taskId !== obligation.taskId
    || workerResult.taskRevision !== obligation.taskRevision) {
    throw new Error("WorkerResult does not belong to the Answer Obligation");
  }
  if ((obligation.outcomeType === "candidate" && workerResult.workerType !== "candidate")
    || (obligation.outcomeType === "repair" && workerResult.workerType !== "repair")) {
    throw new Error("WorkerResult type does not match the Answer Obligation");
  }
  if (validatedCandidateDelivery) {
    if (validatedCandidateDelivery.runId !== obligation.runId
      || validatedCandidateDelivery.taskId !== obligation.taskId
      || validatedCandidateDelivery.taskRevision !== obligation.taskRevision) {
      throw new Error("ValidatedCandidateDelivery does not belong to the Answer Obligation");
    }
    if (workerResult.status !== "validated_passed"
      || validatedCandidateDelivery.candidate !== workerResult.candidate
      || validatedCandidateDelivery.validation !== workerResult.validation) {
      throw new Error("ValidatedCandidateDelivery must reuse the WorkerResult objects");
    }
  }
  return Object.freeze({
    version: "teacher-result-binding-v1",
    stage: "worker_terminal",
    obligation,
    workerResult,
    ...(validatedCandidateDelivery ? { validatedCandidateDelivery } : {}),
  });
}

export function bindFinalAnswer(input: {
  obligation: AnswerObligation;
  workerResult?: WorkerResult;
  validatedCandidateDelivery?: ValidatedCandidateDelivery;
  finalAnswerWorkerResult: FinalAnswerWorkerResult;
  finalAnswer: string;
  finalization: FinalResultBinding["finalization"];
}): FinalResultBinding {
  const answer = input.finalAnswer.trim();
  if (!answer) throw new Error("Final answer must be non-empty");
  const finalResult = input.finalAnswerWorkerResult;
  if (finalResult.runId !== input.obligation.runId
    || finalResult.workerType !== "final_answer"
    || finalResult.version !== "final-answer-worker-result-v1"
    || finalResult.taskId !== `${input.obligation.runId}:final-answer`
    || finalResult.taskRevision !== 1
    || !Number.isInteger(finalResult.attemptCount)) {
    throw new Error("FinalAnswerWorkerResult does not belong to the Answer Obligation");
  }
  if (input.finalization === "final_answer_worker" && finalResult.status !== "completed") {
    throw new Error("Final Answer Worker completion requires a completed WorkerResult");
  }
  if (input.finalization === "deterministic_fallback" && finalResult.status === "completed") {
    throw new Error("Deterministic fallback cannot bind a completed FinalAnswerWorkerResult");
  }
  if (input.finalization === "server_bound_main_draft" && finalResult.status === "completed") {
    throw new Error("Server-bound Main draft fallback requires a failed FinalAnswerWorkerResult");
  }
  if (input.obligation.outcomeType === "direct_answer") {
    if (input.workerResult) {
      throw new Error("Direct final answer cannot bind a Candidate/Repair WorkerResult");
    }
    if (input.validatedCandidateDelivery) {
      throw new Error("Direct final answer cannot bind a ValidatedCandidateDelivery");
    }
  } else {
    if (!input.workerResult) throw new Error("Delegated final answer requires WorkerResult");
    bindWorkerResult(input.obligation, input.workerResult, input.validatedCandidateDelivery);
  }
  return Object.freeze({
    version: "teacher-result-binding-v1",
    stage: "finalized",
    obligation: input.obligation,
    ...(input.workerResult ? { workerResult: input.workerResult } : {}),
    ...(input.validatedCandidateDelivery
      ? { validatedCandidateDelivery: input.validatedCandidateDelivery }
      : {}),
    finalAnswerWorkerResult: input.finalAnswerWorkerResult,
    finalAnswer: answer,
    finalization: input.finalization,
  });
}
