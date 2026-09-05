import { createHash } from "node:crypto";

import type { TaskIterationDirectiveBinding } from "./task-working-state.mjs";
import type {
  AgentDependencies,
  AgentRunRequest,
  MainAgentOutcome,
} from "./types.mjs";

type CandidateOutcome = Extract<MainAgentOutcome, { type: "delegate_candidate" }>;

interface TaskContractGoalSnapshot {
  goalId: string;
  statement: string;
  status: string;
  required: boolean;
  origin: string;
  evidenceRefs: string[];
  note: string;
}

interface TaskContractSnapshot {
  contractId: string;
  revision: number;
  status: string;
  predecessorContractId: string;
  taskRelation: string;
  objectiveSummary: string;
  goals: TaskContractGoalSnapshot[];
  assumptions: string[];
  exclusions: string[];
  openQuestions: string[];
  preservationConstraints: string[];
  currentDirective?: Record<string, unknown> | null;
  lastValidatedCandidate?: Record<string, unknown> | null;
  sealedRevision?: number | null;
  selectedDelivery?: Record<string, unknown> | null;
}

export interface FinalizerTaskContractView {
  readonly contractId: string;
  readonly revision: number;
  readonly sealedRevision: number;
  readonly status: "sealed_for_finalization" | "finalizing" | "delivery_pending";
  readonly taskSummary: string;
  readonly selectedDelivery: Readonly<Record<string, unknown>>;
}

export interface PreparedTaskContractDirective {
  readonly directive: TaskIterationDirectiveBinding;
  readonly contract?: TaskContractSnapshot;
  readonly warnings: readonly string[];
}

export async function prepareCandidateTaskContract(input: {
  readonly dependencies: AgentDependencies;
  readonly runId: string;
  readonly outcome: CandidateOutcome;
  readonly taskContractContext?: AgentRunRequest["taskContractContext"];
}): Promise<PreparedTaskContractDirective> {
  const fallback = fallbackDirective(input.runId, input.outcome);
  if (!input.dependencies.ensureTaskLifecycleContract
    || !input.dependencies.appendTaskLifecycleContractEvent) {
    return { directive: fallback, warnings: ["task_contract_store_unavailable"] };
  }
  try {
    let contract = parseContract(await input.dependencies.ensureTaskLifecycleContract({
      taskProfile: input.outcome.mode === "create" ? "model_authoring" : "model_refinement",
      objectiveSummary: input.outcome.taskSummary,
      preservationConstraints: ["保留已授权基线和已验证内容，除非本轮目标明确要求修改。"],
    }));
    if (!contract) return { directive: fallback, warnings: ["task_contract_snapshot_invalid"] };
    contract = await linkPredecessor(
      input.dependencies,
      contract,
      input.taskContractContext,
      candidateTaskRelation(input.outcome),
      input.outcome.acceptedToolCallId,
    );
    if (contract.status === "provisional") {
      contract = resultContract(await input.dependencies.appendTaskLifecycleContractEvent({
        expectedRevision: contract.revision,
        eventType: "activate",
        actor: { type: "main", id: input.outcome.acceptedToolCallId },
      })) ?? contract;
    }
    if (contract.status === "waiting_user" || contract.status === "delivery_pending") {
      contract = resultContract(await input.dependencies.appendTaskLifecycleContractEvent({
        expectedRevision: contract.revision,
        eventType: "resume_execution",
        actor: { type: "server" },
      })) ?? contract;
    }
    // 当前意图保持不变；返工只替换指令，不继承历史覆盖清单。
    contract = resultContract(await input.dependencies.appendTaskLifecycleContractEvent({
      expectedRevision: contract.revision,
      eventType: "set_iteration_directive",
      actor: { type: "main", id: input.outcome.acceptedToolCallId },
      payload: {
        mode: input.outcome.mode,
        subject: input.outcome.subject,
        taskSummary: input.outcome.taskSummary,
        instruction: input.outcome.instruction,
      },
    })) ?? contract;
    if (contract.status === "active") {
      contract = resultContract(await input.dependencies.appendTaskLifecycleContractEvent({
        expectedRevision: contract.revision,
        eventType: "begin_execution",
        actor: { type: "server" },
      })) ?? contract;
    }
    const directive = parseDirective(contract, input.outcome) ?? fallback;
    return { directive, contract, warnings: [] };
  } catch (error) {
    return {
      directive: fallback,
      warnings: [`task_contract_update_failed:${safeCode(error)}`],
    };
  }
}

export async function prepareClarificationTaskContract(input: {
  readonly dependencies: AgentDependencies;
  readonly clarificationQuestion: string;
  readonly acceptedToolCallId: string;
  readonly taskContractContext?: AgentRunRequest["taskContractContext"];
}): Promise<readonly string[]> {
  if (!input.dependencies.ensureTaskLifecycleContract
    || !input.dependencies.appendTaskLifecycleContractEvent) return ["task_contract_store_unavailable"];
  try {
    let contract = parseContract(await input.dependencies.ensureTaskLifecycleContract({
      taskProfile: "analysis",
      objectiveSummary: "等待用户补充完成任务所需的关键信息。",
    }));
    if (!contract) return ["task_contract_snapshot_invalid"];
    contract = await linkPredecessor(
      input.dependencies,
      contract,
      input.taskContractContext,
      "contextual_reference",
      input.acceptedToolCallId,
    );
    if (contract.status === "provisional") {
      contract = resultContract(await input.dependencies.appendTaskLifecycleContractEvent({
        expectedRevision: contract.revision,
        eventType: "activate",
        actor: { type: "main", id: input.acceptedToolCallId },
      })) ?? contract;
    }
    if (!contract.openQuestions.includes(input.clarificationQuestion)) {
      contract = resultContract(await input.dependencies.appendTaskLifecycleContractEvent({
        expectedRevision: contract.revision,
        eventType: "update_goals",
        actor: { type: "main", id: input.acceptedToolCallId },
        payload: {
          addGoals: [],
          statusUpdates: [],
          objectiveSummary: contract.objectiveSummary,
          assumptions: contract.assumptions,
          exclusions: contract.exclusions,
          openQuestions: [...contract.openQuestions, input.clarificationQuestion],
          preservationConstraints: contract.preservationConstraints,
        },
      })) ?? contract;
    }
    if (contract.status === "active" || contract.status === "executing") {
      await input.dependencies.appendTaskLifecycleContractEvent({
        expectedRevision: contract.revision,
        eventType: "wait_for_user",
        actor: { type: "server" },
      });
    }
    return [];
  } catch (error) {
    return [`task_contract_clarification_failed:${safeCode(error)}`];
  }
}

export async function bindValidatedCandidateTaskContract(input: {
  readonly dependencies: AgentDependencies;
  readonly checkpoint: unknown;
  readonly candidateWorkspaceHash: string;
  readonly candidateContent: string;
}): Promise<Readonly<{
  warnings: readonly string[];
  contractId?: string;
  contractRevision?: number;
}>> {
  if (!input.dependencies.loadTaskLifecycleContract
    || !input.dependencies.appendTaskLifecycleContractEvent) {
    return { warnings: ["task_contract_store_unavailable"] };
  }
  try {
    let contract = parseContract(await input.dependencies.loadTaskLifecycleContract());
    const checkpoint = parseCheckpoint(input.checkpoint);
    if (!contract || !checkpoint) {
      return { warnings: ["task_contract_validation_binding_deferred"] };
    }
    if (contract.lastValidatedCandidate?.candidateWorkspaceHash !== input.candidateWorkspaceHash
      || contract.lastValidatedCandidate.candidateArtifactId !== checkpoint.candidateArtifactId
      || contract.lastValidatedCandidate.validationArtifactId !== checkpoint.validationArtifactId) {
      contract = resultContract(await input.dependencies.appendTaskLifecycleContractEvent({
        expectedRevision: contract.revision,
        eventType: "bind_validated_candidate",
        actor: { type: "server" },
        payload: {
          candidateArtifactId: checkpoint.candidateArtifactId,
          candidateWorkspaceHash: input.candidateWorkspaceHash,
          validationArtifactId: checkpoint.validationArtifactId,
          validatorStatus: "validated_passed",
        },
      })) ?? contract;
    }
    return {
      warnings: [],
      contractId: contract.contractId,
      contractRevision: contract.revision,
    };
  } catch (error) {
    return {
      warnings: [`task_contract_validation_binding_failed:${safeCode(error)}`],
    };
  }
}

export async function sealDirectTaskContract(input: {
  readonly dependencies: AgentDependencies;
  readonly finalizationRequestId: string;
  readonly answerSource: "main_draft" | "finalizer";
  readonly taskContractContext?: AgentRunRequest["taskContractContext"];
}): Promise<{ view?: FinalizerTaskContractView; warnings: readonly string[] }> {
  if (!input.dependencies.ensureTaskLifecycleContract
    || !input.dependencies.appendTaskLifecycleContractEvent) {
    return { warnings: ["task_contract_store_unavailable"] };
  }
  try {
    let contract = parseContract(await input.dependencies.ensureTaskLifecycleContract({
      taskProfile: "direct_answer",
    }));
    if (!contract) return { warnings: ["task_contract_snapshot_invalid"] };
    contract = await linkPredecessor(
      input.dependencies,
      contract,
      input.taskContractContext,
      "contextual_reference",
      input.finalizationRequestId,
    );
    if (contract.status === "provisional") {
      contract = resultContract(await input.dependencies.appendTaskLifecycleContractEvent({
        expectedRevision: contract.revision,
        eventType: "activate",
        actor: { type: "main", id: input.finalizationRequestId },
      })) ?? contract;
    }
    if (contract.status === "waiting_user" || contract.status === "delivery_pending") {
      contract = resultContract(await input.dependencies.appendTaskLifecycleContractEvent({
        expectedRevision: contract.revision,
        eventType: "resume_execution",
        actor: { type: "server" },
      })) ?? contract;
    }
    contract = resultContract(await input.dependencies.appendTaskLifecycleContractEvent({
      expectedRevision: contract.revision,
      eventType: "seal_for_finalization",
      actor: { type: "server" },
      payload: { deliveryKind: "direct_answer", answerSource: input.answerSource },
    })) ?? contract;
    contract = await beginFinalization(input.dependencies, contract);
    return { view: projectFinalizerContract(contract), warnings: [] };
  } catch (error) {
    return { warnings: [`task_contract_seal_failed:${safeCode(error)}`] };
  }
}

export async function sealCandidateTaskContract(input: {
  readonly dependencies: AgentDependencies;
  readonly checkpoint: unknown;
  readonly candidateWorkspaceHash: string;
  readonly candidateContent: string;
  readonly finalizationRequestId: string;
  readonly resultCheckCompleted?: boolean;
  readonly limitations?: string;
}): Promise<{ view?: FinalizerTaskContractView; warnings: readonly string[] }> {
  if (!input.dependencies.loadTaskLifecycleContract
    || !input.dependencies.appendTaskLifecycleContractEvent) {
    return { warnings: ["task_contract_store_unavailable"] };
  }
  try {
    let contract = parseContract(await input.dependencies.loadTaskLifecycleContract());
    const checkpoint = parseCheckpoint(input.checkpoint);
    if (!contract || !checkpoint) return { warnings: ["task_contract_seal_deferred"] };
    if (["sealed_for_finalization", "finalizing", "delivery_pending"].includes(contract.status)
      && contract.selectedDelivery?.candidateWorkspaceHash === input.candidateWorkspaceHash) {
      return { view: projectFinalizerContract(contract), warnings: [] };
    }
    if (contract.lastValidatedCandidate?.candidateWorkspaceHash !== input.candidateWorkspaceHash
      || contract.lastValidatedCandidate.candidateArtifactId !== checkpoint.candidateArtifactId
      || contract.lastValidatedCandidate.validationArtifactId !== checkpoint.validationArtifactId) {
      contract = resultContract(await input.dependencies.appendTaskLifecycleContractEvent({
        expectedRevision: contract.revision,
        eventType: "bind_validated_candidate",
        actor: { type: "server" },
        payload: {
          candidateArtifactId: checkpoint.candidateArtifactId,
          candidateWorkspaceHash: input.candidateWorkspaceHash,
          validationArtifactId: checkpoint.validationArtifactId,
          validatorStatus: "validated_passed",
        },
      })) ?? contract;
    }
    contract = resultContract(await input.dependencies.appendTaskLifecycleContractEvent({
      expectedRevision: contract.revision,
      eventType: "seal_for_finalization",
      actor: { type: "server" },
      payload: {
        deliveryKind: "validated_candidate",
        resultCheckCompleted: input.resultCheckCompleted === true,
        limitations: input.limitations ?? "",
        candidateArtifactId: checkpoint.candidateArtifactId,
        candidateWorkspaceHash: input.candidateWorkspaceHash,
        validationArtifactId: checkpoint.validationArtifactId,
        validatorStatus: "validated_passed",
      },
    })) ?? contract;
    contract = await beginFinalization(input.dependencies, contract);
    return { view: projectFinalizerContract(contract), warnings: [] };
  } catch (error) {
    return { warnings: [`task_contract_seal_failed:${safeCode(error)}`] };
  }
}

export async function loadTaskFinalizationDecision(dependencies: AgentDependencies, candidateWorkspaceHash: string): Promise<{
  completed: boolean; limitations: string;
}> {
  try {
    const contract = parseContract(await dependencies.loadTaskLifecycleContract?.());
    const selection = contract?.selectedDelivery;
    if (selection?.candidateWorkspaceHash === candidateWorkspaceHash
      && typeof selection.resultCheckCompleted === "boolean") {
      return { completed: selection.resultCheckCompleted,
        limitations: typeof selection.limitations === "string" ? selection.limitations : "" };
    }
  } catch { /* 历史或不可读记录不补造完成判断。 */ }
  return { completed: false, limitations: "已恢复通过验证的模型，但尚未确认它满足原任务全部要求。" };
}

export async function markTaskContractDeliveryPending(input: {
  readonly dependencies: AgentDependencies;
}): Promise<readonly string[]> {
  if (!input.dependencies.loadTaskLifecycleContract
    || !input.dependencies.appendTaskLifecycleContractEvent) return ["task_contract_store_unavailable"];
  try {
    const contract = parseContract(await input.dependencies.loadTaskLifecycleContract());
    if (!contract || contract.status === "delivery_pending") return [];
    if (contract.status !== "finalizing" && contract.status !== "sealed_for_finalization") return [];
    const payload = deliveryPayload(contract.selectedDelivery);
    if (!payload) return ["task_contract_delivery_binding_missing"];
    await input.dependencies.appendTaskLifecycleContractEvent({
      expectedRevision: contract.revision,
      eventType: "mark_delivery_pending",
      actor: { type: "server" },
      payload,
    });
    return [];
  } catch (error) {
    return [`task_contract_delivery_pending_failed:${safeCode(error)}`];
  }
}

function parseContract(value: unknown): TaskContractSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  // 旧版本保持只读，禁止新版执行器把历史覆盖状态改写成新语义。
  if (record.version !== "teacher-task-lifecycle-contract-v2") {
    throw Object.assign(new Error("Legacy task contract is read-only."), { code: "TASK_CONTRACT_LEGACY_READ_ONLY" });
  }
  if (typeof record.contractId !== "string"
    || !Number.isInteger(record.revision)
    || typeof record.status !== "string"
    || !Array.isArray(record.goals)) return undefined;
  const goals = record.goals.flatMap((goal) => {
    if (!goal || typeof goal !== "object" || Array.isArray(goal)) return [];
    const item = goal as Record<string, unknown>;
    return typeof item.goalId === "string" && typeof item.statement === "string" && typeof item.status === "string"
      ? [{
        goalId: item.goalId,
        statement: item.statement,
        status: item.status,
        required: item.required !== false,
        origin: typeof item.origin === "string" ? item.origin : "main_derived",
        evidenceRefs: stringList(item.evidenceRefs),
        note: typeof item.note === "string" ? item.note : "",
      }]
      : [];
  });
  if (goals.length !== record.goals.length) return undefined;
  return {
    contractId: record.contractId,
    revision: Number(record.revision),
    status: record.status,
    predecessorContractId: typeof record.predecessorContractId === "string" ? record.predecessorContractId : "",
    taskRelation: typeof record.taskRelation === "string" ? record.taskRelation : "new_task",
    objectiveSummary: typeof record.objectiveSummary === "string" ? record.objectiveSummary : "",
    goals,
    assumptions: stringList(record.assumptions),
    exclusions: stringList(record.exclusions),
    openQuestions: stringList(record.openQuestions),
    preservationConstraints: stringList(record.preservationConstraints),
    currentDirective: record.currentDirective && typeof record.currentDirective === "object"
      ? record.currentDirective as Record<string, unknown>
      : null,
    lastValidatedCandidate: record.lastValidatedCandidate && typeof record.lastValidatedCandidate === "object"
      ? record.lastValidatedCandidate as Record<string, unknown>
      : null,
    sealedRevision: Number.isInteger(record.sealedRevision) ? Number(record.sealedRevision) : null,
    selectedDelivery: record.selectedDelivery && typeof record.selectedDelivery === "object"
      ? record.selectedDelivery as Record<string, unknown>
      : null,
  };
}

async function linkPredecessor(
  dependencies: AgentDependencies,
  contract: TaskContractSnapshot,
  context: AgentRunRequest["taskContractContext"] | undefined,
  requestedRelation: "contextual_reference" | "continue" | "amend" | "supersede",
  actorId: string,
): Promise<TaskContractSnapshot> {
  if (context?.relation !== "prior_dialogue" || contract.predecessorContractId) return contract;
  return resultContract(await dependencies.appendTaskLifecycleContractEvent?.({
    expectedRevision: contract.revision,
    eventType: "link_predecessor",
    actor: { type: "server", id: actorId },
    payload: {
      predecessorContractId: context.contract.contractId,
      taskRelation: requestedRelation,
    },
  })) ?? contract;
}

function candidateTaskRelation(outcome: CandidateOutcome): "contextual_reference" | "continue" | "amend" {
  if (!["previous_validated_candidate", "last_validated_candidate"].includes(outcome.subject)) {
    return "contextual_reference";
  }
  return outcome.mode === "milestone" ? "continue" : "amend";
}

async function beginFinalization(
  dependencies: AgentDependencies,
  contract: TaskContractSnapshot,
): Promise<TaskContractSnapshot> {
  if (contract.status !== "sealed_for_finalization") return contract;
  return resultContract(await dependencies.appendTaskLifecycleContractEvent?.({
    expectedRevision: contract.revision,
    eventType: "begin_finalization",
    actor: { type: "server" },
  })) ?? contract;
}

function projectFinalizerContract(contract: TaskContractSnapshot): FinalizerTaskContractView | undefined {
  if (!["sealed_for_finalization", "finalizing", "delivery_pending"].includes(contract.status)
    || !Number.isInteger(contract.sealedRevision)
    || !contract.selectedDelivery) return undefined;
  return Object.freeze({
    contractId: contract.contractId,
    revision: contract.revision,
    sealedRevision: Number(contract.sealedRevision),
    status: contract.status as FinalizerTaskContractView["status"],
    taskSummary: contract.objectiveSummary,
    selectedDelivery: Object.freeze({ ...contract.selectedDelivery }),
  });
}

function deliveryPayload(selection: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  if (!selection) return undefined;
  if (selection.deliveryKind === "direct_answer") {
    return {
      deliveryKind: "direct_answer",
      answerSource: selection.answerSource,
    };
  }
  return typeof selection.candidateArtifactId === "string"
    && typeof selection.candidateWorkspaceHash === "string"
    && typeof selection.validationArtifactId === "string"
    ? {
      deliveryKind: "validated_candidate",
      candidateArtifactId: selection.candidateArtifactId,
      candidateWorkspaceHash: selection.candidateWorkspaceHash,
      validationArtifactId: selection.validationArtifactId,
      validatorStatus: "validated_passed",
    }
    : undefined;
}

function resultContract(value: unknown): TaskContractSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return parseContract((value as Record<string, unknown>).contract);
}

function parseDirective(
  contract: TaskContractSnapshot,
  outcome: CandidateOutcome,
): TaskIterationDirectiveBinding | undefined {
  const value = contract.currentDirective;
  if (!value
    || typeof value.directiveId !== "string"
    || !Number.isInteger(value.contractRevision)) return undefined;
  return Object.freeze({
    directiveId: value.directiveId,
    contractId: contract.contractId,
    contractRevision: Number(value.contractRevision),
    mode: outcome.mode,
    subject: outcome.subject,
    taskSummary: typeof value.taskSummary === "string" ? value.taskSummary : outcome.taskSummary,
    instruction: typeof value.instruction === "string" ? value.instruction : outcome.instruction,
  });
}

function fallbackDirective(runId: string, outcome: CandidateOutcome): TaskIterationDirectiveBinding {
  const material = `${runId}\n${outcome.acceptedToolCallId}\n${outcome.instruction}`;
  return Object.freeze({
    directiveId: stableId("directive_fallback", material),
    contractId: stableId("task_contract_unpersisted", runId),
    contractRevision: 0,
    mode: outcome.mode,
    subject: outcome.subject,
    taskSummary: outcome.taskSummary,
    instruction: outcome.instruction,
  });
}

function parseCheckpoint(value: unknown): { candidateArtifactId: string; validationArtifactId: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const outer = value as Record<string, unknown>;
  const record = outer.checkpoint && typeof outer.checkpoint === "object" && !Array.isArray(outer.checkpoint)
    ? outer.checkpoint as Record<string, unknown>
    : outer;
  return typeof record.candidateArtifactId === "string" && record.candidateArtifactId
    && typeof record.validationArtifactId === "string" && record.validationArtifactId
    ? {
      candidateArtifactId: record.candidateArtifactId,
      validationArtifactId: record.validationArtifactId,
    }
    : undefined;
}

function stringList(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string");
}

function stableId(prefix: string, material: string): string {
  return `${prefix}_${createHash("sha256").update(material).digest("hex").slice(0, 24)}`;
}

function safeCode(error: unknown): string {
  const value = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : error instanceof Error ? error.name : "unknown";
  return value.replace(/[^a-zA-Z0-9:_-]/gu, "_").slice(0, 120) || "unknown";
}
