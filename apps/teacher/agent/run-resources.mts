import { selectKnowledgeContent, knowledgeTokens } from "./knowledge-content.mjs";
import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalizeToolArguments, ToolExecutionLedger } from "./agent-ledger.mjs";
import { AnswerObligationStore } from "./answer-obligation.mjs";
import { domainEvidenceOutputSchema } from "./types.mjs";
import {
  TaskWorkingStateStore,
  type TaskWorkingState,
  type TaskWorkerType,
} from "./task-working-state.mjs";
import type {
  AgentPolicy,
  AgentRunRequest,
  DomainEvidenceOutput,
  ReviewedKnowledgeOutput,
  ToolName,
} from "./types.mjs";

export type RunParticipant = "main" | TaskWorkerType;
export type RunExecutionParticipant = RunParticipant | "final_answer";

export interface RunInputSnapshot {
  readonly question: string;
  readonly questionHash: string;
  readonly conversationMessages: readonly Readonly<AgentRunRequest["conversationMessages"][number]>[];
  readonly taskSources: readonly Readonly<AgentRunRequest["taskSources"][number]>[];
  readonly threadId: string;
  readonly authorizationScopeRef: string;
  readonly lesson: Readonly<{
    courseId: string;
    lessonId: string;
    title: string;
    objectives: readonly string[];
    taskHints: readonly string[];
    courseRules: readonly Readonly<AgentRunRequest["context"]["lesson"]["courseRules"][number]>[];
    referenceModel?: Readonly<{
      entryFile: string;
      files: readonly Readonly<NonNullable<AgentRunRequest["context"]["lesson"]["referenceModel"]>["files"][number]>[];
    }>;
  }>;
  readonly model: Readonly<{
    entryFileId?: string;
    activeFileId?: string;
    files: readonly Readonly<{
      fileId: string;
      displayName: string;
      workspacePath?: string;
      content: string;
      contentHash: string;
      editable: boolean;
    }>[];
    selection?: Readonly<NonNullable<AgentRunRequest["context"]["model"]["selection"]>>;
    diagnostics: readonly Readonly<AgentRunRequest["context"]["model"]["diagnostics"][number]>[];
    activeDiagnosticId?: string;
  }>;
  readonly conversationSubjects: Readonly<{
    lastValidatedCandidate?: Readonly<NonNullable<AgentRunRequest["context"]["conversationSubjects"]>["lastValidatedCandidate"]>;
  }>;
}

export const runToolContextSchema = z.object({
  runId: z.string().min(1).max(128),
  scopeKey: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  participant: z.enum(["main", "candidate", "repair"]),
  threadId: z.string().min(1).max(128),
  toolName: z.string().min(1).max(128).optional(),
  checkpointId: z.string().min(1).max(128).optional(),
  checkpointRevision: z.number().int().positive().optional(),
  candidateArtifactId: z.string().min(1).max(128).optional(),
  validationArtifactId: z.string().min(1).max(128).optional(),
  allowedActions: z.array(z.string().min(1).max(80)).max(8).default([]),
  idempotencyKey: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
}).strict();

export type RunToolContext = z.infer<typeof runToolContextSchema> & Record<string, unknown>;

export type RunExecutionView = Readonly<Record<string, unknown> & {
  readonly runId: string;
  readonly scopeKey: string;

  readonly hardDeadlineAtMs: number;
  readonly workDeadlineAtMs: number;
  readonly convergeAtMs: number;
  readonly candidatePhaseDeadlineAtMs: number;
  readonly repairDeadlineAtMs: number;
  readonly participant: RunExecutionParticipant;
  readonly remaining: Readonly<RunBudgetView>;
  readonly stageBudget: Readonly<{
    terminalReserveMs: number;
    candidateMaxAttemptMs: number;
    candidateRemainingMs: number;
    repairPhaseReserveMs: number;
    repairRemainingMs: number;
    validatorToolTimeoutMs: number;
  }>;
  readonly checkpoint?: Readonly<{
    checkpointId: string;
    revision: number;
    phase: string;
    candidateAvailable: boolean;
    validationStatus: "not_started" | "pending" | "failed" | "passed";
    repairRound: number;
    allowedActions: readonly string[];
  }>;
}>;

export interface RunKnowledgeSnapshot {
  readonly bundleRef?: string;
  readonly sourceRegistryHash?: string;
  readonly seenClaimIds: readonly string[];
  readonly seenEvidenceIds: readonly string[];
  readonly seenEvidenceSpanIds: readonly string[];
  readonly seenDomainSourceIds: readonly string[];
  readonly seenExampleIds: readonly string[];
  readonly lexicalQueryHashes: readonly string[];
  readonly noNewEvidenceObservations: readonly {
    toolName: ToolName;
    queryHash: string;
    bundleRef: string;
  }[];
}

export interface KnowledgeView {
  readonly bundleRef?: string;
  readonly sourceRegistryHash?: string;
  readonly claimIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly evidenceSpanIds: readonly string[];
  readonly domainSourceIds: readonly string[];
  readonly exampleIds: readonly string[];
  /** 真正进入本次Worker Prompt的受审核知识；Seen ID本身不代表模型已经读过内容。 */
  readonly claims: readonly KnowledgeClaimView[];
  readonly evidenceBlocks: readonly KnowledgeEvidenceView[];
  readonly examples?: readonly KnowledgeExampleView[];
  readonly disclosedClaimIds: readonly string[];
  readonly disclosedEvidenceIds: readonly string[];
  readonly disclosedEvidenceSpanIds: readonly string[];
  readonly disclosedExampleIds?: readonly string[];
  readonly sourceToolCallIds: readonly string[];
  /** 外部领域资料必须与受审核SysML知识分层，不能伪装成同权威Claim/Evidence。 */
  readonly domainEvidence?: WorkerDomainEvidenceView;
  readonly deferredContent?: readonly {kind: string; id: string}[];
  readonly truncated: boolean;
}

export type KnowledgeClaimView = Readonly<Omit<Pick<
  ReviewedKnowledgeOutput["claims"][number],
  "claimId" | "claimText" | "authorityLevel" | "evidenceIds"
>, "evidenceIds"> & { readonly evidenceIds: readonly string[] }>;

export type KnowledgeEvidenceView = Readonly<Pick<
  ReviewedKnowledgeOutput["evidenceBlocks"][number],
  "evidenceId" | "sectionPath" | "excerpt" | "authorityLevel"
>>;

export type KnowledgeExampleView = Readonly<{
  exampleId: string;
  title: string;
  intentText: string;
  modelText: string;
  constructTags: readonly string[];
  exampleAuthority: "official-example" | "community-example";
  languageVersionTrack: string;
  validatorPassed: true;
  truncated?: boolean;
}>;

export type WorkerDomainSourceView = Readonly<DomainEvidenceOutput["sources"][number]>;

export interface WorkerDomainResearchView {
  readonly sourceToolCallId: string;
  readonly questions: readonly string[];
  readonly summary: string;
  readonly sources: readonly WorkerDomainSourceView[];
}

export interface WorkerDomainEvidenceView {
  readonly trust: "untrusted_external_domain_evidence";
  readonly researches: readonly WorkerDomainResearchView[];
  readonly disclosedSourceIds: readonly string[];
  readonly truncated: boolean;
}

const WORKER_DOMAIN_EVIDENCE_VIEW_TOKEN_BUDGET = 2_000;

export type ReviewedKnowledgeQueryRejectionReason = "reviewed_knowledge_duplicate_normalized_query";

export class ReviewedKnowledgeQueryRejectedError extends Error {
  readonly code: ReviewedKnowledgeQueryRejectionReason;

  constructor(code: ReviewedKnowledgeQueryRejectionReason) {
    super(code);
    this.name = "ReviewedKnowledgeQueryRejectedError";
    this.code = code;
  }
}

export interface ReviewedKnowledgeQueryBudgetView {
  readonly maxNewQueries: number;
  readonly admittedNewQueries: number;
  readonly remainingNewQueries: number;
  readonly noNewEvidenceObserved: boolean;
}

export class RunKnowledgeSession {
  #bundleRef: string | undefined;
  #sourceRegistryHash: string | undefined;
  readonly #claimIds = new Set<string>();
  readonly #evidenceIds = new Set<string>();
  readonly #evidenceSpanIds = new Set<string>();
  readonly #domainSourceIds = new Set<string>();
  readonly #exampleIds = new Set<string>();
  readonly #queryHashes = new Set<string>();
  readonly #noNewEvidence = new Map<string, RunKnowledgeSnapshot["noNewEvidenceObservations"][number]>();
  readonly #reviewedKnowledgeNoveltyKeys = new Set<string>();
  constructor(private readonly readBudget: () => { max: number; remaining: number }) {}

  admitNewReviewedKnowledgeQuery(input: unknown): void {

    const noveltyKey = reviewedKnowledgeNoveltyKey(input);
    if (this.#reviewedKnowledgeNoveltyKeys.has(noveltyKey)) {
      throw new ReviewedKnowledgeQueryRejectedError("reviewed_knowledge_duplicate_normalized_query");
    }
    this.#reviewedKnowledgeNoveltyKeys.add(noveltyKey);
  }

  reviewedKnowledgeQueryBudget(): ReviewedKnowledgeQueryBudgetView {
    const budget = this.readBudget();
    return Object.freeze({
      maxNewQueries: budget.max, admittedNewQueries: budget.max - budget.remaining,
      remainingNewQueries: budget.remaining, noNewEvidenceObserved: this.#noNewEvidence.size > 0,
    });
  }

  releaseFailedQuery(input: unknown): void {
    // 失败仍消耗共享动作预算，但不能把暂时不可用记作永久无新证据。
    this.#reviewedKnowledgeNoveltyKeys.delete(reviewedKnowledgeNoveltyKey(input));
  }

  observeToolResult(toolName: ToolName, input: unknown, output: unknown): void {
    if (!output || typeof output !== "object" || Array.isArray(output)) return;
    const record = output as Record<string, unknown>;
    const query = readQuery(input);
    const queryHash = query ? lexicalQueryHash(query) : undefined;
    if (queryHash) this.#queryHashes.add(queryHash);

    if (toolName === "search_reviewed_knowledge") {
      const nextBundleRef = readString(record.bundleId) ?? readString(record.baselineId);
      const nextRegistryHash = readString(record.sourceRegistryHash);
      this.#bindBaseline(nextBundleRef, nextRegistryHash);
      collectIds(record.claims, "claimId", this.#claimIds);
      collectIds(record.evidenceBlocks, "evidenceId", this.#evidenceIds);
      collectIds(record.evidenceBlocks, "evidenceSpanId", this.#evidenceSpanIds);
      collectIds(record.examples, "exampleId", this.#exampleIds);
      if (queryHash && isNoNewEvidence(record)) {
        const bundleRef = this.#bundleRef ?? "unbound";
        this.#noNewEvidence.set(`${toolName}:${queryHash}:${bundleRef}`, {
          toolName,
          queryHash,
          bundleRef,
        });
      }
      return;
    }
    if (toolName === "search_skill_guidance") {
      collectIds(record.items, "sourceId", this.#evidenceIds);
      return;
    }
    if (toolName === "search_engineering_domain_evidence") {
      collectIds(record.sources, "sourceId", this.#domainSourceIds);
    }
  }

  projectForTask(_task: TaskWorkingState): KnowledgeView {
    return Object.freeze({
      ...(this.#bundleRef ? { bundleRef: this.#bundleRef } : {}),
      ...(this.#sourceRegistryHash ? { sourceRegistryHash: this.#sourceRegistryHash } : {}),
      claimIds: Object.freeze([...this.#claimIds].sort()),
      evidenceIds: Object.freeze([...this.#evidenceIds].sort()),
      evidenceSpanIds: Object.freeze([...this.#evidenceSpanIds].sort()),
      domainSourceIds: Object.freeze([...this.#domainSourceIds].sort()),
      exampleIds: Object.freeze([...this.#exampleIds].sort()),
      claims: Object.freeze([]),
      evidenceBlocks: Object.freeze([]),
      disclosedClaimIds: Object.freeze([]),
      disclosedEvidenceIds: Object.freeze([]),
      disclosedEvidenceSpanIds: Object.freeze([]),
      sourceToolCallIds: Object.freeze([]),
      truncated: false,
    });
  }

  snapshot(): RunKnowledgeSnapshot {
    return Object.freeze({
      ...(this.#bundleRef ? { bundleRef: this.#bundleRef } : {}),
      ...(this.#sourceRegistryHash ? { sourceRegistryHash: this.#sourceRegistryHash } : {}),
      seenClaimIds: Object.freeze([...this.#claimIds].sort()),
      seenEvidenceIds: Object.freeze([...this.#evidenceIds].sort()),
      seenEvidenceSpanIds: Object.freeze([...this.#evidenceSpanIds].sort()),
      seenDomainSourceIds: Object.freeze([...this.#domainSourceIds].sort()),
      seenExampleIds: Object.freeze([...this.#exampleIds].sort()),
      lexicalQueryHashes: Object.freeze([...this.#queryHashes].sort()),
      noNewEvidenceObservations: Object.freeze([...this.#noNewEvidence.values()]),
    });
  }

  #bindBaseline(bundleRef: string | undefined, sourceRegistryHash: string | undefined): void {
    if (this.#bundleRef && bundleRef && this.#bundleRef !== bundleRef) {
      throw new Error("Knowledge Bundle changed within one Run");
    }
    if (this.#sourceRegistryHash && sourceRegistryHash && this.#sourceRegistryHash !== sourceRegistryHash) {
      throw new Error("Knowledge source registry changed within one Run");
    }
    this.#bundleRef ??= bundleRef;
    this.#sourceRegistryHash ??= sourceRegistryHash;
  }
}

export const DEFAULT_MAX_UNIQUE_CANDIDATE_VALIDATIONS_PER_WORKER = 12;

export type BudgetOperation = "knowledge_backend" | "validator" | "candidate_generation";

export type RunPhase = RunBudgetView["phase"];

export type RunBusinessAction =
  | "knowledge_search"
  | "main_delegate"
  | "candidate_generate"
  | "candidate_validate"
  | "repair_submit"
  | "request_clarification"
  | "finalize_answer";

export type RunPhaseAdmissionReason =
  | "not_allowed_in_converge"
  | "work_deadline_reached"
  | "hard_deadline_reached";

export interface RunPhaseAdmission {
  readonly action: RunBusinessAction;
  readonly phase: RunPhase;
  readonly allowed: boolean;
  readonly reason?: RunPhaseAdmissionReason;
}

export class RunPhaseAdmissionError extends Error {
  readonly code = "RUN_PHASE_ACTION_NOT_ALLOWED";
  readonly action: RunBusinessAction;
  readonly phase: RunPhase;
  readonly reason: RunPhaseAdmissionReason;

  constructor(admission: RunPhaseAdmission) {
    super(`Run action ${admission.action} is not allowed in ${admission.phase} phase`);
    this.name = "RunPhaseAdmissionError";
    this.action = admission.action;
    this.phase = admission.phase;
    this.reason = admission.reason ?? "work_deadline_reached";
  }
}

const PHASE_ACTIONS: Readonly<Record<RunPhase, ReadonlySet<RunBusinessAction>>> = Object.freeze({
  normal: new Set<RunBusinessAction>([
    "knowledge_search", "main_delegate", "candidate_generate", "candidate_validate",
    "repair_submit", "request_clarification", "finalize_answer",
  ]),
  converge: new Set<RunBusinessAction>([
    "main_delegate", "candidate_generate", "candidate_validate", "repair_submit",
    "request_clarification", "finalize_answer",
  ]),
  finalize: new Set<RunBusinessAction>(["finalize_answer"]),
  expired: new Set<RunBusinessAction>(),
});

const BUDGET_ACTION: Readonly<Record<BudgetOperation, RunBusinessAction>> = Object.freeze({
  knowledge_backend: "knowledge_search",
  validator: "candidate_validate",
  candidate_generation: "candidate_generate",
});

export function evaluateRunPhaseAdmission(
  action: RunBusinessAction,
  phase: RunPhase,
): Readonly<RunPhaseAdmission> {
  const allowed = PHASE_ACTIONS[phase].has(action);
  const reason = allowed
    ? undefined
    : phase === "converge"
      ? "not_allowed_in_converge" as const
      : phase === "expired"
        ? "hard_deadline_reached" as const
        : "work_deadline_reached" as const;
  return Object.freeze({ action, phase, allowed, ...(reason ? { reason } : {}) });
}

export interface RunResourcePolicy {
  readonly maxToolExecutions: number;
  readonly maxExecutionsPerTool: Readonly<Partial<Record<ToolName, number>>>;
  readonly operationLimits: Readonly<Record<BudgetOperation, number>>;
  readonly maxUniqueCandidateValidationsPerWorker: number;
}

export interface BudgetPermit {
  readonly permitId: string;
  readonly operation: BudgetOperation;
}

export interface RunBudgetView {
  readonly hardDeadlineAtMs: number;
  readonly workDeadlineAtMs: number;
  readonly convergeAtMs: number;
  readonly hardRemainingMs: number;
  readonly workRemainingMs: number;
  readonly phase: "normal" | "converge" | "finalize" | "expired";
  readonly state: "NORMAL" | "COMMIT" | "FINALIZE" | "EXPIRED";
  readonly modelInputTokens: number;
  readonly modelOutputTokens: number;
  readonly modelReasoningTokens: number;
  readonly modelTotalTokens: number;
  readonly remainingOperations: Readonly<Record<BudgetOperation, number>>;
}

export class RunBudgetAccount {
  readonly #hardDeadlineAtMs: number;
  readonly #workDeadlineAtMs: number;
  readonly #convergeAtMs: number;
  readonly #limits: Record<BudgetOperation, number>;
  readonly #settledCalls = new Set<string>();
  readonly #settledPermits = new Set<string>();
  readonly #reservedCounts: Record<BudgetOperation, number> = {
    knowledge_backend: 0,
    validator: 0,
    candidate_generation: 0,
  };
  #permitSequence = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  #reasoningTokens = 0;
  #totalTokens = 0;

  constructor(
    timing: {
      hardDeadlineAtMs: number;
      workDeadlineAtMs: number;
      convergeAtMs: number;
    },
    limits?: Partial<Record<BudgetOperation, number>>,
  ) {
    if (!(timing.convergeAtMs <= timing.workDeadlineAtMs
      && timing.workDeadlineAtMs < timing.hardDeadlineAtMs)) {
      throw new Error("Run budget deadlines are invalid");
    }
    this.#hardDeadlineAtMs = timing.hardDeadlineAtMs;
    this.#workDeadlineAtMs = timing.workDeadlineAtMs;
    this.#convergeAtMs = timing.convergeAtMs;
    this.#limits = {
      knowledge_backend: limits?.knowledge_backend ?? 24,
      validator: limits?.validator ?? DEFAULT_MAX_UNIQUE_CANDIDATE_VALIDATIONS_PER_WORKER,
      candidate_generation: limits?.candidate_generation ?? 2,
    };
  }

  view(nowMs = Date.now()): Readonly<RunBudgetView> {
    const phase = nowMs >= this.#hardDeadlineAtMs
      ? "expired" as const
      : nowMs >= this.#workDeadlineAtMs
        ? "finalize" as const
        : nowMs >= this.#convergeAtMs
          ? "converge" as const
          : "normal" as const;
    return Object.freeze({
      hardDeadlineAtMs: this.#hardDeadlineAtMs,
      workDeadlineAtMs: this.#workDeadlineAtMs,
      convergeAtMs: this.#convergeAtMs,
      hardRemainingMs: Math.max(0, this.#hardDeadlineAtMs - nowMs),
      workRemainingMs: Math.max(0, this.#workDeadlineAtMs - nowMs),
      phase,
      state: phase === "normal"
        ? "NORMAL"
        : phase === "converge"
          ? "COMMIT"
          : phase === "finalize"
            ? "FINALIZE"
            : "EXPIRED",
      modelInputTokens: this.#inputTokens,
      modelOutputTokens: this.#outputTokens,
      modelReasoningTokens: this.#reasoningTokens,
      modelTotalTokens: this.#totalTokens,
      remainingOperations: Object.freeze({
        knowledge_backend: Math.max(0, this.#limits.knowledge_backend - this.#reservedCounts.knowledge_backend),
        validator: Math.max(0, this.#limits.validator - this.#reservedCounts.validator),
        candidate_generation: Math.max(0, this.#limits.candidate_generation - this.#reservedCounts.candidate_generation),
      }),
    });
  }

  settleModelCall(input: {
    callId: string;
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      totalTokens?: number;
      outputTokenDetails?: { reasoningTokens?: number };
    };
  }): void {
    if (this.#settledCalls.has(input.callId)) return;
    this.#settledCalls.add(input.callId);
    this.#inputTokens += input.usage.inputTokens ?? 0;
    this.#outputTokens += input.usage.outputTokens ?? 0;
    this.#reasoningTokens += input.usage.reasoningTokens
      ?? input.usage.outputTokenDetails?.reasoningTokens
      ?? 0;
    this.#totalTokens += input.usage.totalTokens ?? 0;
  }

  admit(action: RunBusinessAction, nowMs = Date.now()): Readonly<RunPhaseAdmission> {
    return evaluateRunPhaseAdmission(action, this.view(nowMs).phase);
  }

  assertAdmitted(action: RunBusinessAction, nowMs = Date.now()): void {
    const admission = this.admit(action, nowMs);
    if (!admission.allowed) throw new RunPhaseAdmissionError(admission);
  }

  isAllowed(action: RunBusinessAction, nowMs = Date.now()): boolean {
    return this.admit(action, nowMs).allowed;
  }

  reserve(operation: BudgetOperation): BudgetPermit {
    this.assertAdmitted(BUDGET_ACTION[operation]);
    if (this.#reservedCounts[operation] >= this.#limits[operation]) {
      throw new Error(`Run budget exceeded for ${operation}`);
    }
    const permit = Object.freeze({
      permitId: `permit_${this.#permitSequence++}`,
      operation,
    });
    this.#reservedCounts[operation] += 1;
    return permit;
  }

  settle(permit: BudgetPermit, _outcome: "succeeded" | "failed" | "cancelled"): void {
    if (this.#settledPermits.has(permit.permitId)) return;
    this.#settledPermits.add(permit.permitId);
  }
}

export interface ToolLifecycleProjection {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly participant: RunParticipant;
  readonly taskId?: string;
  readonly taskRevision?: number;
  readonly roundEpoch?: number;
  readonly status: "started" | "succeeded" | "failed";
}

export interface RunResources {
  readonly knowledgeWindowTokens: number;
  readonly runId: string;
  readonly scopeKey: string;
  readonly candidateMaxArtifactBytes: number;
  readonly hardDeadlineAtMs: number;
  readonly workDeadlineAtMs: number;
  readonly convergeAtMs: number;
  readonly candidatePhaseDeadlineAtMs: number;
  readonly repairDeadlineAtMs: number;
  readonly terminalReserveMs: number;
  readonly candidateMaxAttemptMs: number;
  readonly repairPhaseReserveMs: number;
  readonly validatorToolTimeoutMs: number;
  readonly resumeExecution?: NonNullable<AgentRunRequest["resumeContext"]>["execution"];
  /** 同一Run内冻结的服务端输入；Worker只能读取由它投影出的有界Task View。 */
  readonly input: RunInputSnapshot;
  /** 服务端一次构造的唯一资源策略；Budget、Ledger与Worker只能读取该对象。 */
  readonly resourcePolicy: RunResourcePolicy;
  readonly ledger: ToolExecutionLedger;
  readonly knowledge: RunKnowledgeSession;
  readonly budget: RunBudgetAccount;
  readonly admit: (action: RunBusinessAction) => Readonly<RunPhaseAdmission>;
  readonly assertAdmitted: (action: RunBusinessAction) => void;
  readonly isAllowed: (action: RunBusinessAction) => boolean;
  /** 下一次模型Step是否仍应看到Reviewed Knowledge Search。 */
  readonly isNewReviewedKnowledgeQueryAllowed: () => boolean;
  readonly assertNewReviewedKnowledgeQueryAllowed: (input: unknown) => void;
  readonly tasks: TaskWorkingStateStore;
  readonly obligations: AnswerObligationStore;
  readonly priorKnowledgeEntries: Readonly<NonNullable<AgentRunRequest["resumeContext"]>["priorToolLedger"]>;
  readonly serverInjectedKnowledgeEntries: () => readonly {
    toolCallId: string;
    toolName: "search_reviewed_knowledge";
    input: unknown;
    output: unknown;
  }[];
  readonly injectServerKnowledge: (entry: {
    toolCallId: string;
    toolName: "search_reviewed_knowledge";
    input: unknown;
    output: unknown;
  }) => void;
  readonly findPriorKnowledgeResult: (toolName: ToolName, input: unknown) => {
    sourceRunId: string;
    output: unknown;
  } | undefined;
  readonly recordToolLifecycle: (event: ToolLifecycleProjection) => void;
  readonly toolLifecycleSnapshot: () => readonly ToolLifecycleProjection[];
  readonly recordOperationalWarning: (warning: string) => void;
  readonly operationalWarnings: () => readonly string[];
}

export function createRunResources(input: {
  request: AgentRunRequest;
  policy: AgentPolicy;
  deadlineAtMs: number;
  startedAtMs?: number;
}): RunResources {
  const scopeKey = scopeHash(input.request);
  const resourcePolicy = createRunResourcePolicy(input.policy);
  const timing = createRunTiming(
    input.startedAtMs ?? Date.now(),
    input.deadlineAtMs,
    input.policy.convergeLeadMs,
    {
      terminalReserveMs: input.policy.terminalReserveMs,
      candidateMaxAttemptMs: input.policy.candidateMaxAttemptMs,
      repairPhaseReserveMs: input.policy.repairPhaseReserveMs,
      validatorToolTimeoutMs: input.policy.validatorToolTimeoutMs,
    },
  );
  const lifecycle: ToolLifecycleProjection[] = [];
  const operationalWarnings = new Set<string>();
  const injectedKnowledgeEntries: Array<{
    toolCallId: string;
    toolName: "search_reviewed_knowledge";
    input: unknown;
    output: unknown;
  }> = [];
  const priorKnowledgeEntries = Object.freeze((input.request.resumeContext?.priorToolLedger ?? [])
    .map((entry) => Object.freeze({ ...entry })));
  const ledger = new ToolExecutionLedger({
    scopeKey,
    maxExecutions: resourcePolicy.maxToolExecutions,
    maxExecutionsPerTool: resourcePolicy.maxExecutionsPerTool,
  });
  const budget = new RunBudgetAccount(timing, resourcePolicy.operationLimits);
  const knowledge = new RunKnowledgeSession(() => ({
    max: resourcePolicy.operationLimits.knowledge_backend, remaining: budget.view().remainingOperations.knowledge_backend,
  }));
  for (const entry of priorKnowledgeEntries) {
    knowledge.observeToolResult(entry.toolName, entry.input, entry.output);
  }
  const resource: RunResources = {
    runId: input.request.runId,
    candidateMaxArtifactBytes: input.policy.candidateMaxArtifactBytes,
    knowledgeWindowTokens: Math.max(0, input.policy.contextWindowTokens - input.policy.mainContextExecutionReserveTokens - knowledgeTokens({model: input.request.context.model, messages: input.request.conversationMessages})),
    scopeKey,
    hardDeadlineAtMs: timing.hardDeadlineAtMs,
    workDeadlineAtMs: timing.workDeadlineAtMs,
    convergeAtMs: timing.convergeAtMs,
    candidatePhaseDeadlineAtMs: timing.candidatePhaseDeadlineAtMs,
    repairDeadlineAtMs: timing.repairDeadlineAtMs,
    terminalReserveMs: timing.terminalReserveMs,
    candidateMaxAttemptMs: timing.candidateMaxAttemptMs,
    repairPhaseReserveMs: timing.repairPhaseReserveMs,
    validatorToolTimeoutMs: timing.validatorToolTimeoutMs,
    resumeExecution: input.request.resumeContext?.execution,
    input: createRunInputSnapshot(input.request),
    resourcePolicy,
    ledger,
    knowledge,
    budget,
    admit: (action) => budget.admit(action),
    assertAdmitted: (action) => budget.assertAdmitted(action),
    isAllowed: (action) => budget.isAllowed(action),
    isNewReviewedKnowledgeQueryAllowed: () => {
      const queryBudget = knowledge.reviewedKnowledgeQueryBudget();
      return budget.isAllowed("knowledge_search")
        && queryBudget.remainingNewQueries > 0;
    },
    assertNewReviewedKnowledgeQueryAllowed: (toolInput) => {
      budget.assertAdmitted("knowledge_search");

      knowledge.admitNewReviewedKnowledgeQuery(toolInput);
    },
    tasks: new TaskWorkingStateStore(input.request.runId),
    obligations: new AnswerObligationStore(input.request.runId),
    priorKnowledgeEntries,
    serverInjectedKnowledgeEntries: () => Object.freeze(injectedKnowledgeEntries.map((entry) => Object.freeze({ ...entry }))),
    injectServerKnowledge: (entry) => {
      if (entry.toolName !== "search_reviewed_knowledge") return;
      if (injectedKnowledgeEntries.some((item) => item.toolCallId === entry.toolCallId)) return;
      injectedKnowledgeEntries.push(Object.freeze({
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        input: entry.input,
        output: entry.output,
      }));
    },
    findPriorKnowledgeResult: (toolName, toolInput) => {
      if (!["search_reviewed_knowledge", "search_engineering_domain_evidence"].includes(toolName)
        || !input.request.resumeContext) return undefined;
      const canonicalInput = canonicalKnowledgeReplayInput(toolName, toolInput);
      const matched = priorKnowledgeEntries.find((entry) => (
        entry.toolName === toolName && canonicalKnowledgeReplayInput(entry.toolName, entry.input) === canonicalInput
      ));
      return matched
        ? { sourceRunId: input.request.resumeContext.sourceRunId, output: matched.output }
        : undefined;
    },
    recordToolLifecycle: (event) => {
      lifecycle.push(Object.freeze({ ...event }));
      if (event.status === "started") {
        ledger.bindExecutionContext(event.toolCallId, {
          participant: event.participant,
          ...(event.taskId ? { taskId: event.taskId } : {}),
          ...(event.taskRevision !== undefined ? { taskRevision: event.taskRevision } : {}),
          ...(event.roundEpoch !== undefined ? { roundEpoch: event.roundEpoch } : {}),
        });
      }
    },
    toolLifecycleSnapshot: () => Object.freeze(lifecycle.map((event) => Object.freeze({ ...event }))),
    recordOperationalWarning: (warning) => {
      const normalized = String(warning || "").trim().slice(0, 160);
      if (normalized) operationalWarnings.add(normalized);
    },
    operationalWarnings: () => Object.freeze([...operationalWarnings]),
  };
  return Object.freeze(resource);
}

export function createRunResourcePolicy(policy: AgentPolicy): RunResourcePolicy {
  const maxUniqueCandidateValidationsPerWorker = 1 + policy.repairMaxRounds;
  const maxExecutionsPerTool = Object.freeze({
    validate_candidate_workspace: maxUniqueCandidateValidationsPerWorker,
  } satisfies Partial<Record<ToolName, number>>);
  const maxToolExecutions = policy.maxSteps + maxUniqueCandidateValidationsPerWorker;
  return Object.freeze({
    maxToolExecutions,
    maxExecutionsPerTool,
    operationLimits: Object.freeze({
      knowledge_backend: policy.maxSteps,
      validator: maxUniqueCandidateValidationsPerWorker,
      candidate_generation: 1 + policy.candidateRecoveryMaxAttempts,
    }),
    maxUniqueCandidateValidationsPerWorker,
  });
}

function canonicalKnowledgeReplayInput(toolName: ToolName, value: unknown): string {
  if (toolName !== "search_reviewed_knowledge"
    || !value || typeof value !== "object" || Array.isArray(value)) {
    return canonicalizeToolArguments(value);
  }
  const input = value as Record<string, unknown>;
  return canonicalizeToolArguments({
    ...input,
    selectedPatternIds: Array.isArray(input.selectedPatternIds) ? input.selectedPatternIds : [],
  });
}

export interface RunStageBudgetPolicy {
  readonly terminalReserveMs?: number;
  readonly candidateMaxAttemptMs?: number;
  readonly repairPhaseReserveMs?: number;
  readonly validatorToolTimeoutMs?: number;
}

export function createRunTiming(
  startedAtMs: number,
  hardDeadlineAtMs: number,
  requestedConvergeLeadMs = 30_000,
  stageBudget: RunStageBudgetPolicy = {},
): Readonly<{
  hardDeadlineAtMs: number;
  workDeadlineAtMs: number;
  convergeAtMs: number;
  candidatePhaseDeadlineAtMs: number;
  repairDeadlineAtMs: number;
  terminalReserveMs: number;
  candidateMaxAttemptMs: number;
  repairPhaseReserveMs: number;
  validatorToolTimeoutMs: number;
}> {
  const durationMs = Math.max(4, hardDeadlineAtMs - startedAtMs);
  const terminalReserveMs = Math.min(
    Math.max(1, stageBudget.terminalReserveMs ?? Math.floor(durationMs / 8)),
    Math.max(1, durationMs - 3),
  );
  const workDeadlineAtMs = hardDeadlineAtMs - terminalReserveMs;
  const validatorToolTimeoutMs = Math.max(0, Math.min(
    stageBudget.validatorToolTimeoutMs ?? 0,
    Math.max(0, workDeadlineAtMs - startedAtMs - 2),
  ));
  const repairPhaseReserveMs = Math.max(0, Math.min(
    stageBudget.repairPhaseReserveMs ?? 0,
    Math.max(0, workDeadlineAtMs - startedAtMs - validatorToolTimeoutMs - 1),
  ));
  const candidatePhaseDeadlineAtMs = Math.max(
    startedAtMs,
    workDeadlineAtMs - validatorToolTimeoutMs - repairPhaseReserveMs,
  );
  const candidateMaxAttemptMs = Math.max(
    1,
    stageBudget.candidateMaxAttemptMs ?? Math.max(1, candidatePhaseDeadlineAtMs - startedAtMs),
  );
  const repairDeadlineAtMs = workDeadlineAtMs;
  const convergeLeadMs = Math.min(
    Math.max(1, requestedConvergeLeadMs),
    Math.max(1, Math.floor(durationMs / 3)),
  );
  const convergeAtMs = Math.max(startedAtMs, workDeadlineAtMs - convergeLeadMs);
  return Object.freeze({
    hardDeadlineAtMs,
    workDeadlineAtMs,
    convergeAtMs,
    candidatePhaseDeadlineAtMs,
    repairDeadlineAtMs,
    terminalReserveMs,
    candidateMaxAttemptMs,
    repairPhaseReserveMs,
    validatorToolTimeoutMs,
  });
}

export function candidateAttemptDeadlineAt(
  resources: Pick<RunResources, "candidatePhaseDeadlineAtMs" | "candidateMaxAttemptMs">,
  nowMs = Date.now(),
): number {
  return Math.max(nowMs, Math.min(
    resources.candidatePhaseDeadlineAtMs,
    nowMs + resources.candidateMaxAttemptMs,
  ));
}

export function repairPhaseDeadlineAt(
  resources: Pick<RunResources, "repairDeadlineAtMs" | "repairPhaseReserveMs">,
  nowMs = Date.now(),
): number {
  return Math.max(nowMs, Math.min(
    resources.repairDeadlineAtMs,
    nowMs + resources.repairPhaseReserveMs,
  ));
}

export function createRunExecutionView(
  resources: RunResources,
  participant: RunExecutionParticipant,
): RunExecutionView {
  const nowMs = Date.now();
  const execution = resources.resumeExecution;
  const phase = execution?.decision.phase;
  const validationStatus = phase === "validation_pending"
    ? "pending" as const
    : phase === "validation_failed" || phase === "repair_in_progress"
      ? "failed" as const
      : phase === "validated_passed" || phase === "main_review_pending"
        || phase === "finalization_pending" || phase === "completed"
        ? "passed" as const
        : "not_started" as const;
  return Object.freeze({
    runId: resources.runId,
    scopeKey: resources.scopeKey,
    hardDeadlineAtMs: resources.hardDeadlineAtMs,
    workDeadlineAtMs: resources.workDeadlineAtMs,
    convergeAtMs: resources.convergeAtMs,
    candidatePhaseDeadlineAtMs: resources.candidatePhaseDeadlineAtMs,
    repairDeadlineAtMs: resources.repairDeadlineAtMs,
    participant,
    remaining: resources.budget.view(),
    stageBudget: Object.freeze({
      terminalReserveMs: resources.terminalReserveMs,
      candidateMaxAttemptMs: resources.candidateMaxAttemptMs,
      candidateRemainingMs: Math.max(0, candidateAttemptDeadlineAt(resources, nowMs) - nowMs),
      repairPhaseReserveMs: resources.repairPhaseReserveMs,
      repairRemainingMs: Math.max(0, resources.repairDeadlineAtMs - nowMs),
      validatorToolTimeoutMs: resources.validatorToolTimeoutMs,
    }),
    ...(execution ? {
      checkpoint: Object.freeze({
        checkpointId: execution.checkpointId,
        revision: execution.revision,
        phase: execution.decision.phase,
        candidateAvailable: Boolean(execution.decision.candidateArtifactId),
        validationStatus,
        repairRound: execution.decision.repairRound,
        allowedActions: Object.freeze([...execution.decision.allowedActions]),
      }),
    } : {}),
  });
}

export function createRunToolContext(
  resources: RunResources,
  participant: RunParticipant,
  toolName?: string,
): RunToolContext {
  const execution = resources.resumeExecution;
  const idempotencyKey = toolName ? contentHash(canonicalizeToolArguments({
    runId: resources.runId,
    checkpointId: execution?.checkpointId ?? "",
    checkpointRevision: execution?.revision ?? 0,
    participant,
    toolName,
  })) : undefined;
  return Object.freeze(runToolContextSchema.parse({
    runId: resources.runId,
    scopeKey: resources.scopeKey,
    participant,
    threadId: resources.input.threadId,
    ...(toolName ? { toolName } : {}),
    ...(execution ? {
      checkpointId: execution.checkpointId,
      checkpointRevision: execution.revision,
      candidateArtifactId: execution.decision.candidateArtifactId,
      validationArtifactId: execution.decision.validationArtifactId,
      allowedActions: execution.decision.allowedActions,
    } : { allowedActions: [] }),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  })) as RunToolContext;
}

export function createRunToolsContext(
  resources: RunResources,
  participant: RunParticipant,
  toolNames: readonly string[],
): Readonly<Record<string, RunToolContext>> {
  return Object.freeze(Object.fromEntries(toolNames.map((toolName) => [
    toolName,
    createRunToolContext(resources, participant, toolName),
  ])));
}

export function assertRunToolContext(resources: RunResources, context: unknown): RunToolContext {
  const parsed = runToolContextSchema.parse(context);
  if (parsed.runId !== resources.runId || parsed.scopeKey !== resources.scopeKey) {
    throw new Error("Tool context does not belong to the bound Run resources");
  }
  return parsed;
}

/**
 * 从单一Tool Ledger派生有界Worker证据视图。Ledger仍是完整Tool Result唯一事实源，
 * 本函数不建立第二套Evidence存储，也不改变RunKnowledgeSession的Seen索引职责。
 */
export function projectWorkerEvidenceView(
  resources: RunResources,
  task: TaskWorkingState,
): KnowledgeView {
  const seen = resources.knowledge.projectForTask(task);
  const claimIds = new Set<string>();
  const evidenceIds = new Set<string>();
  const exampleIds = new Set<string>();
  const sourceToolCallIds = new Set<string>();
  const claims: KnowledgeClaimView[] = [];
  const evidenceBlocks: KnowledgeEvidenceView[] = [];
  const examples: KnowledgeExampleView[] = [];
  const domainResearches: WorkerDomainResearchView[] = [];
  const disclosedDomainSourceIds = new Set<string>();
  let remainingDomainTokens = WORKER_DOMAIN_EVIDENCE_VIEW_TOKEN_BUDGET;
  let truncated = false;
  let domainTruncated = false;

  const evidenceEntries = [
    ...resources.serverInjectedKnowledgeEntries().map((entry) => ({
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      status: "succeeded" as const,
      output: entry.output,
    })),
    ...resources.priorKnowledgeEntries.map((entry) => ({
      toolCallId: `${resources.runId}:prior:${entry.toolCallId}`,
      toolName: entry.toolName,
      status: "succeeded" as const,
      output: entry.output,
    })),
    ...resources.ledger.snapshot(),
  ];
  const reviewedEntries = evidenceEntries.filter(entry => entry.toolName === "search_reviewed_knowledge" && entry.status === "succeeded");
  const selected = selectKnowledgeContent(reviewedEntries.map(entry => entry.output), resources.knowledgeWindowTokens);
  claims.push(...selected.claims as unknown as KnowledgeClaimView[]);
  evidenceBlocks.push(...selected.evidenceBlocks as unknown as KnowledgeEvidenceView[]);
  examples.push(...selected.examples.filter(row => row.validatorPassed === true) as unknown as KnowledgeExampleView[]);
  claims.forEach(row => claimIds.add(row.claimId));
  evidenceBlocks.forEach(row => evidenceIds.add(row.evidenceId));
  examples.forEach(row => exampleIds.add(row.exampleId));
  for (const entry of [...reviewedEntries].reverse()) {
    const data = entry.output as Record<string, unknown>;
    if ([...(Array.isArray(data.claims) ? data.claims : []), ...(Array.isArray(data.examples) ? data.examples : [])]
      .some(row => claims.includes(row) || examples.includes(row))) { sourceToolCallIds.add(entry.toolCallId); }
  }
  truncated = selected.deferredContent.length > 0;
  for (const entry of evidenceEntries) {
    if (entry.toolName !== "search_engineering_domain_evidence" || entry.status !== "succeeded") continue;
    const parsed = domainEvidenceOutputSchema.safeParse(entry.output);
    if (!parsed.success || parsed.data.status === "unavailable" || !parsed.data.summary.trim()) continue;
    const research = fitDomainResearchView({
      sourceToolCallId: entry.toolCallId,
      questions: parsed.data.questions,
      summary: parsed.data.summary,
      sources: parsed.data.sources,
    }, remainingDomainTokens);
    if (!research) {
      domainTruncated = true;
      continue;
    }
    const cost = estimatedJsonTokens(research);
    remainingDomainTokens -= cost;
    domainResearches.push(research);
    for (const source of research.sources) disclosedDomainSourceIds.add(source.sourceId);
    if (research.summary.length < parsed.data.summary.length
      || research.sources.length < parsed.data.sources.length) {
      domainTruncated = true;
    }
  }

  return Object.freeze({
    ...seen,
    claims: Object.freeze(claims),
    evidenceBlocks: Object.freeze(evidenceBlocks),
    ...(examples.length > 0 ? {
      examples: Object.freeze(examples),
      disclosedExampleIds: Object.freeze([...exampleIds]),
    } : {}),
    disclosedClaimIds: Object.freeze([...claimIds]),
    disclosedEvidenceIds: Object.freeze([...evidenceIds]),
    // Evidence View披露的是完整excerpt；`:all`阻止Repair把同一excerpt切片后再次披露。
    disclosedEvidenceSpanIds: Object.freeze([...evidenceIds].map((id) => `${id}:all`)),
    sourceToolCallIds: Object.freeze([...sourceToolCallIds]),
    ...(domainResearches.length > 0 ? {
      domainEvidence: Object.freeze({
        trust: "untrusted_external_domain_evidence" as const,
        researches: Object.freeze(domainResearches),
        disclosedSourceIds: Object.freeze([...disclosedDomainSourceIds]),
        truncated: domainTruncated,
      }),
    } : {}),
    deferredContent: Object.freeze(selected.deferredContent),
    truncated: truncated || domainTruncated,
  });
}

function fitDomainResearchView(
  input: {
    sourceToolCallId: string;
    questions: readonly string[];
    summary: string;
    sources: readonly WorkerDomainSourceView[];
  },
  tokenBudget: number,
): WorkerDomainResearchView | undefined {
  const profiles = [
    { summaryChars: 1_800, maxSources: 8 },
    { summaryChars: 1_200, maxSources: 5 },
    { summaryChars: 800, maxSources: 3 },
    { summaryChars: 400, maxSources: 2 },
  ];
  for (const profile of profiles) {
    const view = Object.freeze({
      sourceToolCallId: input.sourceToolCallId,
      questions: Object.freeze([...input.questions]),
      summary: input.summary.slice(0, profile.summaryChars),
      sources: Object.freeze(input.sources.slice(0, profile.maxSources).map((source) => Object.freeze({ ...source }))),
    });
    if (estimatedJsonTokens(view) <= tokenBudget) return view;
  }
  return undefined;
}

function estimatedJsonTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

function scopeHash(request: AgentRunRequest): string {
  const scope = {
    runId: request.runId,
    lesson: {
      courseId: request.context.lesson.courseId,
      lessonId: request.context.lesson.lessonId,
    },
    files: request.context.model.files.map((file) => ({
      fileId: file.fileId,
      contentHash: file.contentHash,
      editable: file.editable,
    })),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(scope), "utf8").digest("hex")}`;
}

function createRunInputSnapshot(request: AgentRunRequest): RunInputSnapshot {
  const question = request.currentStudentQuestion ?? request.question;
  const model = request.context.model;
  return Object.freeze({
    question,
    // 与hashCanonicalValue(string)一致：字符串先按JSON规范序列化再哈希。
    questionHash: stableHash(question),
    // 客户可见角色消息只作为非规范理解上下文；TaskSourceSet继续独立承担授权语义。
    conversationMessages: Object.freeze(request.conversationMessages.map((message) => Object.freeze({ ...message }))),
    // TaskSourceSet已由Agent Adapter按服务端授权范围和Hash绑定规则形成；
    // Run内只冻结并投影，不再让Main或Worker重新抽取一套“事实对象”。
    taskSources: Object.freeze(request.taskSources.map((source) => Object.freeze({ ...source }))),
    threadId: request.context.threadId,
    authorizationScopeRef: stableHash({
      tenantId: request.context.tenantId,
      userId: request.context.userId,
      threadId: request.context.threadId,
    }),
    lesson: Object.freeze({
      courseId: request.context.lesson.courseId,
      lessonId: request.context.lesson.lessonId,
      title: request.context.lesson.title,
      objectives: Object.freeze([...request.context.lesson.objectives]),
      taskHints: Object.freeze([...request.context.lesson.taskHints]),
      courseRules: Object.freeze(request.context.lesson.courseRules.map((rule) => Object.freeze({ ...rule }))),
      ...(request.context.lesson.referenceModel
        ? {
          referenceModel: Object.freeze({
            ...request.context.lesson.referenceModel,
            files: Object.freeze(request.context.lesson.referenceModel.files.map((file) => Object.freeze({ ...file }))),
          }),
        }
        : {}),
    }),
    model: Object.freeze({
      ...(model.entryFileId ? { entryFileId: model.entryFileId } : {}),
      ...(model.activeFileId ? { activeFileId: model.activeFileId } : {}),
      files: Object.freeze(model.files.map((file) => Object.freeze({ ...file }))),
      ...(model.selection ? { selection: Object.freeze({ ...model.selection }) } : {}),
      diagnostics: Object.freeze(model.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))),
      ...(model.activeDiagnosticId ? { activeDiagnosticId: model.activeDiagnosticId } : {}),
    }),
    conversationSubjects: Object.freeze({
      ...(request.context.conversationSubjects?.lastValidatedCandidate
        ? {
          lastValidatedCandidate: Object.freeze({
            ...request.context.conversationSubjects.lastValidatedCandidate,
          }),
        }
        : {}),
    }),
  });
}

function contentHash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function stableHash(value: unknown): string {
  return contentHash(JSON.stringify(value));
}

function lexicalQueryHash(query: string): string {
  const normalized = query.trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

function reviewedKnowledgeNoveltyKey(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return stableHash(value);
  }
  const input = value as Record<string, unknown>;
  return stableHash({
    query: normalizeKnowledgeQueryForNovelty(input.query),
    topic: normalizeKnowledgeQueryForNovelty(input.topic),
    offset: input.offset ?? 0,
    exampleIds: input.exampleIds ?? [],
    claimIds: input.claimIds ?? [],
    evidenceIds: input.evidenceIds ?? [],
    selectedPatternIds: Array.isArray(input.selectedPatternIds)
      ? input.selectedPatternIds.filter((item): item is string => typeof item === "string").sort()
      : [],
  });
}

function normalizeKnowledgeQueryForNovelty(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\s，。；、,.!?！？'"“”‘’（）()]+/gu, "")
    .trim();
}

function readQuery(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (typeof record.query === "string") return record.query;
  if (Array.isArray(record.questions)) return record.questions.filter((item) => typeof item === "string").join("\n");
  return undefined;
}

function collectIds(value: unknown, key: string, target: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = readString((item as Record<string, unknown>)[key]);
    if (id) target.add(id);
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isNoNewEvidence(output: Record<string, unknown>): boolean {
  if (Array.isArray(output.examples) && output.examples.some((example: any) => example?.validatorPassed && example?.modelText)) return false;
  if (output.no_new_evidence === true) return true;
  return output.coverage === "NONE"
    && Array.isArray(output.claims)
    && output.claims.length === 0
    && Array.isArray(output.evidenceBlocks)
    && output.evidenceBlocks.length === 0;
}
