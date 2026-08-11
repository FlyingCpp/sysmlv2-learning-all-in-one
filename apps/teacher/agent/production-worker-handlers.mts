import type { LanguageModel, ModelMessage } from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";

import { normalizeCapabilityGrant } from "./agent-policy.mjs";
import { runCandidateWorker } from "./candidate-worker.mjs";
import { runRepairWorker } from "./repair-worker.mjs";
import { createReadOnlyTools, type ReadOnlyTeacherTools } from "./tools/create-readonly-tools.mjs";
import type {
  AgentPolicy,
  AgentRunRequest,
  CandidateArtifact,
  RunTeacherAgentOptions,
  ValidationOutput,
} from "./types.mjs";
import {
  executionResumeSchema,
  validateCandidateInputSchema,
  validationOutputSchema,
} from "./types.mjs";
import {
  candidateAttemptDeadlineAt,
  projectWorkerEvidenceView,
  type RunResources,
} from "./run-resources.mjs";
import type {
  CandidateTaskView,
  CandidateValidationOutcome,
  RepairTaskView,
  WorkerTaskView,
} from "./worker-contracts.mjs";
import type { WorkerExecutionContext, WorkerHandlers } from "./worker-dispatcher.mjs";
import {
  createValidatedPassedResult,
  createWorkerFailureResult,
  computeCandidateWorkspaceHash,
  validationPassed,
  validationRetryable,
} from "./worker-result.mjs";

export type ResumeExecutionAction =
  | "validator"
  | "resolve_validation"
  | "repair"
  | "finalizer"
  | "return_persisted"
  | "engineering_resume";

export interface ProductionWorkerHandlerOptions {
  readonly resources: RunResources;
  readonly request: AgentRunRequest;
  readonly policy: AgentPolicy;
  readonly model: LanguageModel;
  readonly repairModel?: LanguageModel;
  readonly dependencies: RunTeacherAgentOptions["dependencies"];
  readonly candidateProviderOptions?: SharedV4ProviderOptions;
  readonly candidateReasoning?: "none" | "medium" | "high" | "xhigh";
  readonly repairProviderOptions?: SharedV4ProviderOptions;
  readonly repairReasoning?: "none" | "medium" | "high" | "xhigh";
  readonly repairExplicitToolChoice?: boolean;
  /** 仅由服务端 Advisory Controller 注入；初始 Main 不能选择该模式。 */
  readonly engineeringRevision?: Readonly<{
    baselineCandidateContent: string;
    issues: readonly Readonly<{
      issueId: string;
      goalRefId: string;
      sourceId: string;
      goalQuote: string;
      sourceHash: string;
      taskAuthorizationRevisionHash: string;
      start: number;
      end: number;
      issue: string;
      suggestion: string;
    }>[];
  }>;
}

const STRUCTURAL_REFINEMENT_VIEW_GUIDANCE = `结构细化与组成变化的可视化约束：
- 当学生要求新增模型细节、细化某个组成或改变part组成关系时，最终完整候选必须同步生成或更新显式view usage，使本轮新增或变化的结构能被PlantUML投影看见；view/expose只控制展示范围，不能替代结构建模本身。
- 优先更新已有且适用的显式view；没有时创建最小的StandardViewDefinitions::GeneralView。
- 显式expose根part definition、根part usage，以及本轮被细化且需要展示其内部成员的part definition。需要展示多层结构时，逐层expose每个拥有下一层成员的definition；不要假设自动视图会沿part的typing关系递归展开。
- ::**表示命名空间成员的递归暴露，不等于沿类型化组成树递归展开。除非学生明确要求整个命名空间的完整总图，不要用根类型或整个package的::**代替按需expose，以免图形失控。
- 所有expose目标必须存在于最终候选中；view位于package外时使用正确限定名。根类型、根usage和被细化definition的名称必须来自当前学生任务和授权模型，不得从其他领域示例推断或复制。
- 学生明确要求的语言构造必须以真实SysML v2语义实现；具体要求只来自当前任务和服务端绑定的GoalRef，不使用预置构造词表，也不得用文档注释或视图外观冒充模型语义。`;

const MINIMAL_SUFFICIENT_REASONING_GUIDANCE = `最小充分推理与结果优先约束：
- 只进行完成当前任务所必需的推理，不展开未被要求的备选方案、假设分支或防御性论证。
- 已有上下文和证据足够时立即产出结果，不继续检索、重复核对或在内部模拟Validator。
- 达到学生要求后立即停止，不为追求更完整而增加学生未要求的内容。`;

const CANDIDATE_BASE_INSTRUCTIONS = `只输出一份完整、可独立验证的SysML v2文本，不输出解释、JSON、diff、Patch、fileId、hash或Validator状态。候选必须满足学生问题，并尽量保留授权基线中与目标无关的内容。优先直接输出完整候选。`;
const CREATE_MINIMAL_EXAMPLE_GUIDANCE = `create模式最小样例约束：
- 当学生只指定一个日常对象并要求“示例模型”，但没有进一步要求需求、行为、接口、参数或分析时，生成最小结构教学样例，不自行扩张成完整产品规格。
- 默认只保留一个package、必要的part definitions、一个根part usage和一份最小GeneralView；结构元素应少而清楚，优先一次通过Validator。
- 除非学生明确要求，不要新增requirement、constraint、calc、action、state、port、connection、数值赋值、单位、多重性或外部库依赖。
- 不要为了显得完整而虚构性能指标、材料、寿命、容量、工况或其他领域事实。`;
const CANDIDATE_REVIEWED_KNOWLEDGE_GUIDANCE = `Candidate本地受审核知识检索规则：
- 首次生成可以自主选择零次或一次search_reviewed_knowledge；查询是上限，不是配额，已有证据足够时直接生成。
- 首次结果会返回coverage、Claims、closureGaps、missingClosureClaimIds和候选Pattern维度。你必须自己判断直接生成，还是提出一次目的不同、用于补足明确缺失维度的互补查询。
- 同一Run最多两次新的本地知识查询。完全相同的调用由服务端Ledger回放；只改大小写、空白、标点、limit或其他格式的重复查询会被拒绝；出现no_new_evidence后不得提出新查询。
- 内容恢复与首次生成共享同一查询额度和既有证据。恢复时若只执行过一次新查询，仍可提出一次互补查询；已执行两次时只能使用或精确回放已有结果。
- 查询因时间、上下文或调用预算关闭时，立即使用已有证据生成完整候选，不得把检索不可用当成拒绝生成的理由。`;
const REPAIR_INSTRUCTIONS = [
  `阅读学生意图、当前完整候选和Validator诊断。每轮可以查询受审核知识，然后必须通过submit_candidate_for_validation提交一份完整SysML v2模型。不得输出Patch Schema、业务对象、ID、hash或伪造Validator状态；只有Validator Tool返回passed才算成功。`,
  MINIMAL_SUFFICIENT_REASONING_GUIDANCE,
  `每轮只处理当前Validator诊断指向的最小问题簇，保留与该问题簇无关的正确内容；修复后立即提交完整候选供Validator复核，不做全局重写或全模型重新设计。`,
  `如果Repair涉及结构细化或组成变化，修订后的完整候选仍必须满足以下可视化约束。`,
  STRUCTURAL_REFINEMENT_VIEW_GUIDANCE,
].join("\n\n");

/** 生产V2链唯一固定Handler装配；Dispatcher不接受LLM生成的路由或Handler名称。 */
export function createProductionWorkerHandlers(
  options: ProductionWorkerHandlerOptions,
): WorkerHandlers {
  const registeredTools = createReadOnlyTools({
    context: options.request.context,
    dependencies: options.dependencies,
    capabilityGrant: normalizeCapabilityGrant(options.request.capabilityGrant),
    ledger: options.resources.ledger,
    runResources: options.resources,
  });

  return Object.freeze({
    candidate: async (task: CandidateTaskView, context: WorkerExecutionContext) => {
      const candidateStartedAtMs = Date.now();
      const engineeringRevision = options.engineeringRevision;
      const candidateDeadlineAtMs = engineeringRevision
        ? engineeringRevisionDeadlineAt(options, candidateStartedAtMs)
        : candidateAttemptDeadlineAt(options.resources, candidateStartedAtMs);
      return await runCandidateWorker({
        resources: options.resources,
        task,
        model: options.model,
        abortSignal: context.abortSignal,
        instructions: candidateInstructions(task),
        ...(engineeringRevision
          ? { prompt: engineeringRevisionPrompt(task.question, engineeringRevision) }
          : {}),
        // 单次Candidate只使用阶段窗口；Validator、Repair和最终回答预留不能被生成阶段占用。
        timeoutMs: Math.max(1, candidateDeadlineAtMs - candidateStartedAtMs),
        toolTimeoutMs: options.policy.toolTimeoutMs,
        temperature: options.policy.temperature,
        reasoning: options.candidateReasoning,
        providerOptions: options.candidateProviderOptions,
        tools: options.request.capabilityGrant.includes("search_reviewed_knowledge")
          ? { search_reviewed_knowledge: registeredTools.search_reviewed_knowledge }
          : undefined,
        maxSteps: options.policy.maxSteps,
        allowContentRecovery: options.policy.candidateRecoveryMaxAttempts > 0,
        validateCandidate: async ({ content, attempt, abortSignal }) => await validateCandidate({
          resources: options.resources,
          task,
          registeredTools,
          content,
        toolCallId: `${task.taskId}:candidate-validator:${attempt}`,
          abortSignal,
          dependencies: options.dependencies,
          checkpointMetadata: engineeringCheckpointMetadata(options),
      }),
        recoverValidationFailure: options.policy.candidateRepairEnabled
          ? async ({ content, validation, abortSignal }) => await recoverCandidate({
            options,
            task,
            registeredTools,
            content,
            initialValidation: validation.validation,
            abortSignal,
          })
          : undefined,
      });
    },
    repair: async (task: RepairTaskView, context: WorkerExecutionContext) => await runProductionRepair({
      options,
      task,
      registeredTools,
      abortSignal: context.abortSignal,
    }),
  });
}

async function runProductionRepair(input: {
  options: ProductionWorkerHandlerOptions;
  task: RepairTaskView;
  registeredTools: ReadOnlyTeacherTools;
  abortSignal: AbortSignal;
}) {
  const initialContent = repairInitialContent(input.task);
  if (!initialContent.trim()) {
    return createWorkerFailureResult({
      task: input.task,
      status: "worker_error",
      reason: "repair_target_has_no_model_content",
      attemptCount: 0,
    });
  }
  const initial = await validateCandidate({
    resources: input.options.resources,
    task: input.task,
    registeredTools: input.registeredTools,
    content: initialContent,
    toolCallId: `${input.task.taskId}:repair-validator:initial`,
    abortSignal: input.abortSignal,
    dependencies: input.options.dependencies,
    checkpointMetadata: engineeringCheckpointMetadata(input.options),
  });
  if (initial.passed) {
    return createValidatedPassedResult({
      task: input.task,
      candidate: initial.candidate,
      validation: initial.validation,
      attemptCount: 0,
    });
  }
  if (!initial.retryable || !input.options.policy.candidateRepairEnabled) {
    return createWorkerFailureResult({
      task: input.task,
      status: initial.retryable ? "validated_failed" : "worker_error",
      validation: initial.validation,
      reason: initial.reason,
      attemptCount: 0,
    });
  }
  return await executeRepairLoop({
    options: input.options,
    task: input.task,
    registeredTools: input.registeredTools,
    content: initialContent,
    initialValidation: initial.validation,
    abortSignal: input.abortSignal,
  });
}

async function recoverCandidate(input: {
  options: ProductionWorkerHandlerOptions;
  task: CandidateTaskView;
  registeredTools: ReadOnlyTeacherTools;
  content: string;
  initialValidation: ValidationOutput;
  abortSignal: AbortSignal;
}): Promise<CandidateValidationOutcome | undefined> {
  const result = await executeRepairLoop({
    options: input.options,
    task: input.task,
    registeredTools: input.registeredTools,
    content: input.content,
    initialValidation: input.initialValidation,
    abortSignal: input.abortSignal,
  });
  if (result.status !== "validated_passed") {
    if (result.status === "exhausted" || result.status === "worker_error") {
      throw new Error(result.reason);
    }
    return undefined;
  }
  return Object.freeze({
    passed: true,
    retryable: false,
    candidate: result.candidate,
    validation: result.validation,
    reason: "validator_passed_after_recovery",
  });
}

async function executeRepairLoop<TASK extends WorkerTaskView>(input: {
  options: ProductionWorkerHandlerOptions;
  task: TASK;
  registeredTools: ReadOnlyTeacherTools;
  content: string;
  initialValidation: ValidationOutput;
  abortSignal: AbortSignal;
  initialRepairRound?: number;
}) {
  const currentTask = input.options.resources.tasks.get(input.task.taskId);
  const task: TASK = currentTask
    ? Object.freeze({
      ...input.task,
      knowledge: projectWorkerEvidenceView(input.options.resources, currentTask),
    }) as TASK
    : input.task;
  let repairRound = input.initialRepairRound ?? 0;
  let checkpointCandidate = createCandidateArtifact(task, input.content);
  let checkpointValidation = input.initialValidation;
  let latestValidationPassed = false;
  await persistExecutionCheckpointFailSoft(input.options.resources, input.options.dependencies, {
    phase: "repair_in_progress",
    candidate: checkpointCandidate,
    validation: input.initialValidation,
    repairRound,
    metadata: engineeringCheckpointMetadata(input.options),
  });
  return await runRepairWorker({
    resources: input.options.resources,
    task,
    model: input.options.repairModel ?? input.options.model,
    instructions: REPAIR_INSTRUCTIONS,
    prompt: JSON.stringify({
      studentQuestion: task.question,
      initialCandidate: input.content.slice(0, 40_000),
      validator: boundedValidation(input.initialValidation),
      target: task.target.kind,
      knowledgeEvidence: task.knowledge,
      ...(input.options.engineeringRevision
        ? { engineeringRevision: engineeringRevisionRepairContext(input.options.engineeringRevision, input.content) }
        : {}),
    }),
    abortSignal: input.abortSignal,
    timeoutMs: Math.min(
      input.options.policy.maxDurationMs,
      Math.max(1, input.options.resources.budget.view().workRemainingMs
        - (input.options.engineeringRevision
          ? input.options.policy.semanticReviewVerificationTimeoutMs
          : 0)),
    ),
    toolTimeoutMs: input.options.policy.toolTimeoutMs,
    maxOutputTokens: input.options.policy.repairMaxOutputTokens,
    contextWindowTokens: input.options.policy.contextWindowTokens,
    maxCandidateAttempts: Math.max(
      1,
      input.options.resources.resourcePolicy.maxUniqueCandidateValidationsPerWorker - 1,
    ),
    maxValidatorCalls: input.options.resources.resourcePolicy.maxUniqueCandidateValidationsPerWorker,
    initialValidatorCalls: 1,
    initialValidation: input.initialValidation,
    initialCandidateContent: input.content,
    targetBinding: task.target.kind === "active_file"
      ? {
        mode: "replace_entry",
        fileId: task.target.fileId,
        baseHash: task.target.baseHash,
      }
      : { mode: "standalone_model" },
    knowledgeSearchEnabled: input.options.request.capabilityGrant.includes("search_reviewed_knowledge"),
    evaluationMode: input.options.request.evaluationMode ?? "production",
    temperature: input.options.policy.temperature,
    reasoning: input.options.repairReasoning,
    providerOptions: input.options.repairProviderOptions,
    explicitToolChoice: input.options.repairExplicitToolChoice,
    onCheckpointProgress: async (progress) => {
      await persistExecutionCheckpointFailSoft(input.options.resources, input.options.dependencies, {
        phase: latestValidationPassed
          ? "validated_passed"
          : progress.boundary === "validator_completed"
            ? "validation_failed"
            : "repair_in_progress",
        candidate: checkpointCandidate,
        validation: checkpointValidation,
        repairRound,
        repairState: progress.repairState,
        metadata: engineeringCheckpointMetadata(input.options),
      });
    },
    searchReviewedKnowledge: async ({ query, toolCallId, abortSignal }) => await executeRegisteredTool(
      input.registeredTools,
      "search_reviewed_knowledge",
      { query, limit: 5 },
      toolCallId,
      abortSignal ?? input.abortSignal,
    ),
    validateCandidate: async ({ content, toolCallId, abortSignal }) => {
      repairRound += 1;
      const outcome = await validateCandidate({
        resources: input.options.resources,
        task,
        registeredTools: input.registeredTools,
        content,
        toolCallId,
        abortSignal: abortSignal ?? input.abortSignal,
        repairRound,
        dependencies: input.options.dependencies,
        checkpointMetadata: engineeringCheckpointMetadata(input.options),
      });
      checkpointCandidate = outcome.candidate;
      checkpointValidation = outcome.validation;
      latestValidationPassed = outcome.passed;
      return { candidate: outcome.candidate, validation: outcome.validation };
    },
    validationPassed,
    validationRetryable,
  });
}

async function validateCandidate(input: {
  resources: RunResources;
  task: CandidateTaskView | RepairTaskView;
  registeredTools: ReadOnlyTeacherTools;
  content: string;
  toolCallId: string;
  abortSignal: AbortSignal;
  repairRound?: number;
  dependencies?: RunTeacherAgentOptions["dependencies"];
  checkpointMetadata?: Record<string, unknown>;
}): Promise<CandidateValidationOutcome> {
  const candidate = createCandidateArtifact(input.task, input.content);
  return await validatePersistedCandidate({
    ...input,
    candidate,
    dependencies: input.dependencies,
  });
}

async function validatePersistedCandidate(input: {
  resources: RunResources;
  task: CandidateTaskView | RepairTaskView;
  registeredTools: ReadOnlyTeacherTools;
  candidate: CandidateArtifact;
  toolCallId: string;
  abortSignal: AbortSignal;
  dependencies?: RunTeacherAgentOptions["dependencies"];
  repairRound?: number;
  checkpointMetadata?: Record<string, unknown>;
}): Promise<CandidateValidationOutcome> {
  input.resources.assertAdmitted("candidate_validate");
  markValidationStarted(input.resources, input.task.taskId);
  const candidate = Object.freeze(validateCandidateInputSchema.parse(input.candidate));
  const candidateWorkspaceHash = computeCandidateWorkspaceHash(input.task, candidate);
  const dependencies = input.dependencies;
  if (dependencies) {
    await persistExecutionCheckpointFailSoft(input.resources, dependencies, {
      phase: "candidate_ready",
      candidate,
      repairRound: input.repairRound ?? 0,
      metadata: input.checkpointMetadata,
    });
    await persistExecutionCheckpointFailSoft(input.resources, dependencies, {
      phase: "validation_pending",
      candidate,
      repairRound: input.repairRound ?? 0,
      metadata: mergeCheckpointMetadata(input.checkpointMetadata, { candidateWorkspaceHash }),
    });
  }
  const validation = await executeRegisteredTool(
    input.registeredTools,
    "validate_candidate_workspace",
    candidate,
    input.toolCallId,
    input.abortSignal,
  ) as ValidationOutput;
  const passed = validationPassed(validation);
  if (dependencies) {
    await persistExecutionCheckpointFailSoft(input.resources, dependencies, {
      phase: passed ? "validated_passed" : "validation_failed",
      candidate,
      validation,
      repairRound: input.repairRound ?? 0,
      metadata: input.checkpointMetadata,
    });
  }
  return Object.freeze({
    passed,
    retryable: validationRetryable(validation),
    candidate: Object.freeze(candidate),
    validation: Object.freeze(validation),
    reason: passed ? "validator_passed" : validatorReason(validation),
  });
}

function createCandidateArtifact(
  task: CandidateTaskView | RepairTaskView,
  content: string,
): CandidateArtifact {
  if (task.target.kind === "active_file") {
    return {
      mode: "replace_entry",
      fileId: task.target.fileId,
      baseHash: task.target.baseHash,
      content,
    };
  }
  return { mode: "standalone_model", fileName: "generated_architecture.sysml", content };
}

function markValidationStarted(resources: RunResources, taskId: string): void {
  const current = resources.tasks.get(taskId);
  if (!current || ["worker_completed", "worker_failed", "cancelled"].includes(current.status)) return;
  resources.tasks.transition(taskId, current.revision, { type: "validation_started" });
}

async function executeRegisteredTool(
  tools: ReadOnlyTeacherTools,
  name: keyof ReadOnlyTeacherTools,
  input: unknown,
  toolCallId: string,
  abortSignal: AbortSignal,
): Promise<unknown> {
  const executable = tools[name] as unknown as {
    execute?: (input: unknown, options: {
      toolCallId: string;
      messages: ModelMessage[];
      abortSignal: AbortSignal;
    }) => Promise<unknown>;
  };
  if (!executable.execute) throw new Error(`Registered tool ${name} has no execute handler`);
  return await executable.execute(input, { toolCallId, messages: [], abortSignal });
}

function repairInitialContent(task: RepairTaskView): string {
  const targetId = task.target.kind === "active_file"
    ? task.target.fileId
    : task.model.activeFileId ?? task.model.entryFileId;
  return task.model.files.find((file) => file.fileId === targetId)?.content
    ?? task.model.files[0]?.content
    ?? "";
}

function candidateContent(
  task: CandidateTaskView | RepairTaskView,
  candidate: CandidateArtifact,
): string {
  if (candidate.mode === "standalone_model" || candidate.mode === "replace_entry") {
    return candidate.content;
  }
  if (candidate.mode === "workspace_files") {
    const targetId = task.target.kind === "active_file"
      ? task.target.fileId
      : task.model.activeFileId ?? task.model.entryFileId;
    return candidate.files.find((file) => file.fileId === targetId)?.content
      ?? candidate.files[0]?.content
      ?? "";
  }
  const targetId = task.target.kind === "active_file"
    ? task.target.fileId
    : task.model.activeFileId ?? task.model.entryFileId;
  const base = task.model.files.find((file) => file.fileId === targetId)?.content
    ?? task.model.files[0]?.content
    ?? "";
  let lines = base.split(/\r\n|\r|\n/u);
  for (const edit of [...candidate.edits].sort((left, right) => (
    right.startLine - left.startLine || right.endLine - left.endLine
  ))) {
    lines.splice(
      edit.startLine - 1,
      edit.endLine - edit.startLine + 1,
      ...edit.replacement.split(/\r\n|\r|\n/u),
    );
  }
  return lines.join("\n");
}

async function persistExecutionCheckpointFailSoft(
  resources: RunResources,
  dependencies: RunTeacherAgentOptions["dependencies"],
  boundary: Parameters<NonNullable<RunTeacherAgentOptions["dependencies"]["persistExecutionCheckpoint"]>>[0],
): Promise<unknown> {
  if (!dependencies.persistExecutionCheckpoint) return undefined;
  try {
    return await dependencies.persistExecutionCheckpoint(boundary);
  } catch {
    resources.recordOperationalWarning("execution_checkpoint_persistence_failed");
    return undefined;
  }
}

async function recordReusedValidation(
  resources: RunResources,
  candidate: CandidateArtifact,
  validation: ValidationOutput,
): Promise<void> {
  await resources.ledger.recordObservation({
    toolCallId: `${resources.runId}:checkpoint-validator-reuse`,
    toolName: "validate_candidate_workspace",
    input: candidate,
    output: validation,
    replayedFromRunId: resources.resumeExecution?.lineageRootRunId,
  });
}

function validatorReason(validation: ValidationOutput): string {
  if (validation.official.syntax === "unavailable" || validation.official.semantic === "unavailable") {
    const diagnosticCode = validation.official.diagnostics
      .map((diagnostic) => String(diagnostic.code || "").trim())
      .find(Boolean) ?? "VALIDATOR_UNAVAILABLE";
    return `validator_unavailable:${diagnosticCode}`;
  }
  return "validator_failed";
}

function candidateInstructions(task: CandidateTaskView): string {
  return [
    CANDIDATE_BASE_INSTRUCTIONS,
    MINIMAL_SUFFICIENT_REASONING_GUIDANCE,
    CANDIDATE_REVIEWED_KNOWLEDGE_GUIDANCE,
    ...(task.mode === "create" ? [CREATE_MINIMAL_EXAMPLE_GUIDANCE] : []),
    STRUCTURAL_REFINEMENT_VIEW_GUIDANCE,
  ].join("\n\n");
}

function engineeringRevisionPrompt(
  question: string,
  revision: NonNullable<ProductionWorkerHandlerOptions["engineeringRevision"]>,
): string {
  return [
    "执行一次有界工程完善。以下基线已经通过Official Validator；只围绕服务端绑定到用户原文的Issue完善，不做无关全局重写。",
    "每条goalQuote和本轮用户任务都是用户原文中的授权目标，不是语法关键词表。对每个Issue内部逐项核对goalQuote、issue和suggestion中的对象、功能、关系与场景；用户原文包含列举、并列、条件或强调场景时，即使Issue或Suggestion摘要不完整，也必须从授权原文恢复并闭合其中每个显式要求。每个显式命名的工程概念都必须有可追溯的模型元素或关系；强调场景必须用适合其语义的行为、控制、工况或其它真实模型元素表达，并关联受影响对象，不能只靠相关部件、静态拓扑或注释暗示。Suggestion是最小闭合范围，不得只补名字、注释、孤立对象、相关部件或部分子项。",
    "在满足上述语义的前提下，优先沿用已通过Validator的基线建模风格和已有构造，以最少新增元素及关系完成闭合。用户没有明确要求复杂行为细节时，不要为了表达场景而扩张成大规模行为模型；可以用最小的控制、模式或工况对象及其与受控对象的关系建立可追溯闭环。",
    "保留基线中与Issue无关的正确内容，使用与目标语义匹配的SysML v2元素和关系完成闭合，并输出一份完整Candidate供Official Validator重新验证。提交前做一次简洁的目标覆盖自检，但不要输出分析过程。",
    `用户任务：\n${question.slice(0, 12_000)}`,
    `已验证基线：\n${revision.baselineCandidateContent.slice(0, 100_000)}`,
    `本轮有效Issue：\n${JSON.stringify(revision.issues.slice(0, 8))}`,
  ].join("\n\n");
}

export function engineeringRevisionRepairContext(
  revision: NonNullable<ProductionWorkerHandlerOptions["engineeringRevision"]>,
  currentCandidateContent: string,
): Readonly<{
  goalRefs: readonly Record<string, unknown>[];
  issues: readonly Record<string, unknown>[];
  baselinePreservation: Readonly<Record<string, unknown>>;
}> {
  const baselineLines = nonBlankLines(revision.baselineCandidateContent);
  const currentLines = nonBlankLines(currentCandidateContent);
  const retainedLineCount = retainedMultisetCount(baselineLines, currentLines);
  return Object.freeze({
    goalRefs: Object.freeze(revision.issues.slice(0, 8).map((item) => Object.freeze({
      goalRefId: item.goalRefId,
      sourceId: item.sourceId,
      quote: item.goalQuote,
      sourceHash: item.sourceHash,
      taskAuthorizationRevisionHash: item.taskAuthorizationRevisionHash,
      start: item.start,
      end: item.end,
    }))),
    issues: Object.freeze(revision.issues.slice(0, 8).map((item) => Object.freeze({
      issueId: item.issueId,
      goalRefId: item.goalRefId,
      issue: item.issue.slice(0, 500),
      suggestion: item.suggestion.slice(0, 500),
    }))),
    baselinePreservation: Object.freeze({
      baselineNonBlankLineCount: baselineLines.length,
      currentNonBlankLineCount: currentLines.length,
      retainedNonBlankLineCount: retainedLineCount,
      retainedNonBlankLineRatio: baselineLines.length === 0 ? 1 : retainedLineCount / baselineLines.length,
      removedBaselineLineCount: Math.max(0, baselineLines.length - retainedLineCount),
      addedCurrentLineCount: Math.max(0, currentLines.length - retainedLineCount),
      instruction: "保留与当前Validator诊断无关的基线内容，只修复诊断指向的最小问题簇。",
    }),
  });
}

function nonBlankLines(content: string): string[] {
  return content.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function retainedMultisetCount(baseline: readonly string[], current: readonly string[]): number {
  const available = new Map<string, number>();
  for (const line of current) available.set(line, (available.get(line) ?? 0) + 1);
  let retained = 0;
  for (const line of baseline) {
    const count = available.get(line) ?? 0;
    if (count < 1) continue;
    retained += 1;
    available.set(line, count - 1);
  }
  return retained;
}

function engineeringRevisionDeadlineAt(
  options: ProductionWorkerHandlerOptions,
  nowMs: number,
): number {
  const reservedAfterCandidateMs = options.policy.validatorToolTimeoutMs
    + options.policy.repairPhaseReserveMs
    + options.policy.semanticReviewVerificationTimeoutMs;
  return Math.max(nowMs, Math.min(
    options.resources.workDeadlineAtMs - reservedAfterCandidateMs,
    nowMs + options.resources.candidateMaxAttemptMs,
  ));
}

function engineeringCheckpointMetadata(
  options: ProductionWorkerHandlerOptions,
): Record<string, unknown> | undefined {
  const revision = options.engineeringRevision;
  if (!revision) return undefined;
  return {
    engineering: {
      status: "engineering_revision_in_progress",
      continuationKind: "engineering_improvement",
      assessmentCount: 1,
      mainReentryCount: 1,
      revisionCycleCount: 1,
      verificationCount: 0,
      issues: revision.issues.slice(0, 8).map((item) => ({
        issueId: item.issueId,
        goalRef: {
          goalRefId: item.goalRefId,
          sourceId: item.sourceId,
          quote: item.goalQuote,
          sourceHash: item.sourceHash,
          taskAuthorizationRevisionHash: item.taskAuthorizationRevisionHash,
          start: item.start,
          end: item.end,
        },
        issue: item.issue.slice(0, 500),
        suggestion: item.suggestion.slice(0, 500),
      })),
    },
  };
}

function mergeCheckpointMetadata(
  base: Record<string, unknown> | undefined,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(base ?? {}), ...extra };
}

function boundedValidation(validation: ValidationOutput): unknown {
  return {
    official: validation.official,
    courseRules: validation.courseRules,
    completeness: validation.completeness,
    diagnostics: [
      ...validation.official.diagnostics,
      ...(validation.courseRules?.diagnostics ?? []),
    ].slice(0, 20),
  };
}

interface ResumedProductionExecutionInput {
  options: ProductionWorkerHandlerOptions;
  task: CandidateTaskView | RepairTaskView;
  action: ResumeExecutionAction;
  candidate: unknown;
  validation?: unknown;
  validatorVersion?: string;
  rulesetVersion?: string;
  validationOptionsHash?: string;
  repairRound?: number;
  abortSignal: AbortSignal;
}

/** 从服务端Checkpoint继续，禁止重新进入Candidate生成。 */
export async function runResumedProductionExecution(input: ResumedProductionExecutionInput) {
  const refreshed = await refreshResumeExecution(input);
  if (!refreshed.ok) {
    return createWorkerFailureResult({
      task: input.task,
      status: "worker_error",
      reason: refreshed.reason,
      attemptCount: 0,
    });
  }
  const candidate = validateCandidateInputSchema.parse(refreshed.candidate);
  const validation = refreshed.validation === undefined
    ? undefined
    : validationOutputSchema.parse(refreshed.validation);
  const validatorVersion = refreshed.validatorVersion ?? input.validatorVersion;
  const rulesetVersion = refreshed.rulesetVersion ?? input.rulesetVersion;
  const validationOptionsHash = refreshed.validationOptionsHash ?? input.validationOptionsHash;
  const repairRound = refreshed.repairRound ?? input.repairRound ?? 0;
  const registeredTools = createReadOnlyTools({
    context: input.options.request.context,
    dependencies: input.options.dependencies,
    capabilityGrant: normalizeCapabilityGrant(input.options.request.capabilityGrant),
    ledger: input.options.resources.ledger,
    runResources: input.options.resources,
  });

  if (input.action === "finalizer" || input.action === "return_persisted" || input.action === "engineering_resume") {
    if (!validation) {
      return createWorkerFailureResult({
        task: input.task,
        status: "worker_error",
        reason: "checkpoint_validation_missing",
        attemptCount: 0,
      });
    }
    await recordReusedValidation(input.options.resources, candidate, validation);
    return createValidatedPassedResult({
      task: input.task,
      candidate,
      validation,
      attemptCount: 0,
    });
  }

  if (input.action === "repair") {
    if (!validation) {
      return createWorkerFailureResult({
        task: input.task,
        status: "worker_error",
        reason: "checkpoint_validation_missing",
        attemptCount: 0,
      });
    }
    await persistExecutionCheckpointFailSoft(input.options.resources, input.options.dependencies, {
      phase: "repair_in_progress",
      candidate,
      validation,
      repairRound,
      metadata: engineeringCheckpointMetadata(input.options),
    });
    return await executeRepairLoop({
      options: input.options,
      task: input.task,
      registeredTools,
      content: candidateContent(input.task, candidate),
      initialValidation: validation,
      abortSignal: input.abortSignal,
      initialRepairRound: repairRound,
    });
  }

  let reusableValidation: ValidationOutput | undefined;
  if (input.action === "resolve_validation"
    && input.options.dependencies.findReusableValidationArtifact
    && validatorVersion
    && rulesetVersion
    && validationOptionsHash) {
    const candidateWorkspaceHash = computeCandidateWorkspaceHash(input.task, candidate);
    try {
      const artifact = await input.options.dependencies.findReusableValidationArtifact({
        candidateWorkspaceHash,
        validatorVersion,
        rulesetVersion,
        validationOptionsHash,
      });
      const payload = artifact && typeof artifact === "object" && "payload" in artifact
        ? (artifact as { payload?: unknown }).payload
        : artifact;
      const parsed = validationOutputSchema.safeParse(payload);
      if (parsed.success) reusableValidation = parsed.data;
    } catch {
      input.options.resources.recordOperationalWarning("validator_reuse_lookup_failed");
    }
  }
  if (reusableValidation) {
    await recordReusedValidation(input.options.resources, candidate, reusableValidation);
    if (validationPassed(reusableValidation)) {
      return createValidatedPassedResult({
        task: input.task,
        candidate,
        validation: reusableValidation,
        attemptCount: 0,
      });
    }
    if (validationRetryable(reusableValidation) && input.options.policy.candidateRepairEnabled) {
      return await executeRepairLoop({
        options: input.options,
        task: input.task,
        registeredTools,
        content: candidateContent(input.task, candidate),
        initialValidation: reusableValidation,
        abortSignal: input.abortSignal,
        initialRepairRound: repairRound,
      });
    }
  }

  const validationOutcome = await validatePersistedCandidate({
    resources: input.options.resources,
    task: input.task,
    registeredTools,
    candidate,
    toolCallId: `${input.task.taskId}:resumed-validator`,
    abortSignal: input.abortSignal,
    dependencies: input.options.dependencies,
    repairRound,
    checkpointMetadata: engineeringCheckpointMetadata(input.options),
  });
  if (validationOutcome.passed) {
    return createValidatedPassedResult({
      task: input.task,
      candidate: validationOutcome.candidate,
      validation: validationOutcome.validation,
      attemptCount: 0,
    });
  }
  if (validationOutcome.retryable && input.options.policy.candidateRepairEnabled) {
    return await executeRepairLoop({
      options: input.options,
      task: input.task,
      registeredTools,
      content: candidateContent(input.task, candidate),
      initialValidation: validationOutcome.validation,
      abortSignal: input.abortSignal,
      initialRepairRound: repairRound,
    });
  }
  return createWorkerFailureResult({
    task: input.task,
    status: validationOutcome.retryable ? "validated_failed" : "worker_error",
    validation: validationOutcome.validation,
    reason: validationOutcome.reason,
    attemptCount: 0,
  });
}

async function refreshResumeExecution(input: ResumedProductionExecutionInput): Promise<
  | {
    ok: true;
    candidate: unknown;
    validation?: unknown;
    validatorVersion?: string;
    rulesetVersion?: string;
    validationOptionsHash?: string;
    repairRound?: number;
  }
  | { ok: false; reason: string }
> {
  if (!input.options.dependencies.loadLatestExecutionCheckpoint) {
    return {
      ok: true,
      candidate: input.candidate,
      validation: input.validation,
      validatorVersion: input.validatorVersion,
      rulesetVersion: input.rulesetVersion,
      validationOptionsHash: input.validationOptionsHash,
      repairRound: input.repairRound,
    };
  }
  try {
    const loaded = await input.options.dependencies.loadLatestExecutionCheckpoint();
    const candidateExecution = loaded && typeof loaded === "object" && "execution" in loaded
      ? (loaded as { execution?: unknown }).execution
      : loaded;
    const parsed = executionResumeSchema.safeParse(candidateExecution);
    if (!parsed.success) return { ok: false, reason: "checkpoint_reload_invalid" };
    if (parsed.data.decision.stale) return { ok: false, reason: "checkpoint_became_stale" };
    if (!parsed.data.decision.allowedActions.includes(input.action)) {
      return { ok: false, reason: "checkpoint_resume_action_not_allowed" };
    }
    if (!parsed.data.worker.candidate) return { ok: false, reason: "checkpoint_candidate_missing" };
    return {
      ok: true,
      candidate: parsed.data.worker.candidate,
      validation: parsed.data.worker.validation,
      validatorVersion: parsed.data.decision.validatorVersion,
      rulesetVersion: parsed.data.decision.rulesetVersion,
      validationOptionsHash: parsed.data.decision.validationOptionsHash,
      repairRound: parsed.data.decision.repairRound,
    };
  } catch {
    input.options.resources.recordOperationalWarning("execution_checkpoint_reload_failed");
    return { ok: false, reason: "checkpoint_reload_failed" };
  }
}
