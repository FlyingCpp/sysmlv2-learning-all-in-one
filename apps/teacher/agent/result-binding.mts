import type { AnswerObligation } from "./answer-obligation.mjs";
import type { WorkerResult } from "./worker-contracts.mjs";

export type WorkerTerminalBinding = Readonly<{
  version: "teacher-result-binding-v1";
  stage: "worker_terminal";
  obligation: Exclude<AnswerObligation, { outcomeType: "direct_answer" }>;
  workerResult: WorkerResult;
}>;

export type FinalResultBinding = Readonly<{
  version: "teacher-result-binding-v1";
  stage: "finalized";
  obligation: AnswerObligation;
  workerResult?: WorkerResult;
  finalAnswer: string;
  finalization: "main_model" | "deterministic_fallback" | "direct_main_answer";
}>;

export function bindWorkerResult(
  obligation: AnswerObligation,
  workerResult: WorkerResult,
): WorkerTerminalBinding {
  if (obligation.outcomeType === "direct_answer") {
    throw new Error("Direct Answer Obligation cannot bind a WorkerResult");
  }
  if (workerResult.runId !== obligation.runId || workerResult.taskId !== obligation.taskId) {
    throw new Error("WorkerResult does not belong to the Answer Obligation");
  }
  if ((obligation.outcomeType === "candidate" && workerResult.workerType !== "candidate")
    || (obligation.outcomeType === "repair" && workerResult.workerType !== "repair")) {
    throw new Error("WorkerResult type does not match the Answer Obligation");
  }
  return Object.freeze({
    version: "teacher-result-binding-v1",
    stage: "worker_terminal",
    obligation,
    workerResult,
  });
}

export function bindFinalAnswer(input: {
  obligation: AnswerObligation;
  workerResult?: WorkerResult;
  finalAnswer: string;
  finalization: FinalResultBinding["finalization"];
}): FinalResultBinding {
  const answer = input.finalAnswer.trim();
  if (!answer || answer.length > 200_000) throw new Error("Final answer must be non-empty and bounded");
  if (input.obligation.outcomeType === "direct_answer") {
    if (input.workerResult || input.finalization !== "direct_main_answer") {
      throw new Error("Direct final answer cannot bind WorkerResult or Finalizer output");
    }
  } else {
    if (!input.workerResult) throw new Error("Delegated final answer requires WorkerResult");
    bindWorkerResult(input.obligation, input.workerResult);
    if (input.finalization === "direct_main_answer") {
      throw new Error("Delegated final answer must come from Finalizer or deterministic fallback");
    }
  }
  return Object.freeze({
    version: "teacher-result-binding-v1",
    stage: "finalized",
    obligation: input.obligation,
    ...(input.workerResult ? { workerResult: input.workerResult } : {}),
    finalAnswer: answer,
    finalization: input.finalization,
  });
}
