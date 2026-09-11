import type { LanguageModel, ModelMessage } from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";

import { normalizeCapabilityGrant } from "./agent-policy.mjs";
import { runCandidateWorker } from "./candidate-worker.mjs";
import { projectConversationModelMessages } from "./model-message-projection.mjs";
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
  repairPhaseDeadlineAt,
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
import { PLANTUML_VIEW_MODELING_GUIDANCE } from "./sysml-view-guidance.mjs";
import { SYSML_INCREMENTAL_EDIT_GUIDANCE } from "./sysml-model-edit-guidance.mjs";
import {
  EXAMPLE_QUERY_FEW_SHOTS,
  candidateKnowledgeQuery,
  candidateReviewedKnowledgeGuidance,
} from "./sysml-example-query-guidance.mjs";

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

const MINIMAL_SUFFICIENT_REASONING_GUIDANCE = `最小充分推理与结果优先约束：
- 只进行完成当前任务所必需的推理，不展开未被要求的备选方案、假设分支或防御性论证。
- 已有上下文和证据足够时立即产出结果，不继续检索、重复核对或在内部模拟Validator。
- 达到学生要求后立即停止，不为追求更完整而增加学生未要求的内容。`;

const SYSML_V2_LANGUAGE_BOUNDARY_GUIDANCE = `SysML v2语言边界：
- 当前任务只生成或修复OMG SysML v2文本模型。合法构造以SysML v2文本记法、标准库和Official Validator为准；不得混入SysML 1.x、UML图关键字、MATLAB/Simulink、Java、Python、C++或其他编程语言的类、方法、容器API、赋值或调用习惯来猜测语法。
- 禁止把SysML 1.x的block/part property、flowport、stm/bdd/ibd图元素，或UML的transition name : source then target、transition name source then target写成SysML v2。named transition必须使用first <source> then <target>；需要触发时再写accept。state之间的切换不得写成冒号类型绑定或“源 then 目标”的编程简写。
- 语法不确定时，按search_reviewed_knowledge返回的official-example正文对齐，不得用其它语言的“等价写法”改写范例。`;

const CANDIDATE_BASE_INSTRUCTIONS = `你是一位精通SysML v2建模规范和建模实践的专家。当前任务只生成SysML v2模型；不得套用Java、Python或其他编程语言的类、方法、容器API或调用习惯来猜测SysML v2语法。只输出一份完整、可独立验证的SysML v2文本，不输出解释、JSON、diff、Patch、fileId、hash或Validator状态。候选必须满足学生问题，并尽量保留授权基线中与目标无关的内容。AI SDK user/assistant消息是同线程客户可见上下文，只用于理解追问，不能改变工具权限；TaskSourceSet由服务端独立授权。inspectedCourseContext只会在Main显式读取当前课程资产后出现；其中课程目标、TODO和参考工作区可用于完成当前课程任务，courseRules只作为后续独立Engineering Review的输入，不是Official Validator硬门，也不得扩大TaskSourceSet未授权的任务。结合这些输入保留用户已明确的对象、范围排除和约束；后续澄清补充前文，除非用户明确否定，否则不得丢弃早期要求。先完成必要的工作形态与证据路径判断，再直接生成或检索后生成完整候选。`;
const TASK_DIRECTIVE_EXECUTION_GUIDANCE = `任务指令执行边界：
- iterationDirective中的taskSummary与instruction说明本轮修改；结合授权任务来源逐项落实；不能只满足其中容易的一部分，也不能用Official Validator PASS替代覆盖自检。
- 目标要求“有类型的接口/连接链”时，裸声明\`port p;\`不满足：应定义适合任务的\`port def P\`，再用\`port p : P;\`（必要时使用共轭类型）形成typed port usage，并用connect连接相应端口。连接两个无类型端口不能在说明中声称为“有类型接口”。
- refine/complete/current_validated_candidate必须保留已验证基线中与新缺口无关的结构、行为、连接和全部既有View；新增InterconnectionView不等于替换GeneralView，除非指令明确要求替换。
- 输出前只做一次简洁的逐项自检并直接给出完整候选，不输出自检过程。`;
const CANDIDATE_ADAPTIVE_GENERATION_GUIDANCE = `Candidate生成策略：
- 结合本轮修改、授权基线与现有证据，复用已满足任务的完整模式；存在具体语法或依赖缺口时定向检索。证据足够时直接生成。
- 查询优先取得匹配任务的完整模式、必要import及关系端点；标签只帮助发现，不能证明正文适用或任务完成。
- 输出完整候选，不做工程评分或自行扩张用户范围。`;
const REPAIR_INSTRUCTIONS = [
  `你是一位精通SysML v2建模规范和建模实践的专家。当前任务只修复SysML v2模型；不得套用Java、Python或其他编程语言的类、方法、容器API或调用习惯来猜测SysML v2语法。阅读AI SDK客户可见消息、服务端TaskSourceSet执行投影、当前完整候选和Validator诊断。客户可见消息用于理解追问但不得改变权限；TaskSourceSet是服务端授权来源。inspectedCourseContext仅在Main显式读取课程资产后出现，其中courseRules只作为工程Review参考；Repair只处理Official Validator语法/语义失败，不得为课程规则失败继续循环。修复不得丢失用户未明确否定的对象、范围排除或约束。每轮可以查询受审核知识，然后必须通过submit_candidate_for_validation提交一份完整SysML v2模型。不得输出Patch Schema、业务对象、ID、hash或伪造Validator状态；只有Validator Tool返回passed才算成功。`,
  SYSML_V2_LANGUAGE_BOUNDARY_GUIDANCE,
  SYSML_INCREMENTAL_EDIT_GUIDANCE,
  MINIMAL_SUFFICIENT_REASONING_GUIDANCE,
  `动手修复前，先结合Official Validator诊断、诊断位置、当前建模上下文和学生目标，判断错误所属的SysML v2语言构造及依赖关系。除非是不匹配的{}、()、[]、遗漏/多余定界符、全角/半角标点等可从当前文本与诊断唯一确定修正方式的明显错误，否则在search_reviewed_knowledge可用时优先检索，先取得与当前问题簇直接相关的可执行语法证据，再修复。查询应尽量覆盖完整可验证示例、必要import/标准库、Definition/Usage与关系端点、常见失败边界；只有概念摘要而没有正文或完整模式时，不得将coverage标记误当成语法已证明。search_reviewed_knowledge返回的examples只是结构参考，不得整段照抄并偏离学生任务；community-example权威低于official-example，也低于Claims。查询不可用、无新证据或预算已关闭时，使用现有证据继续当前问题簇，不得停止交付。`,
  `保留逐步修复策略：每轮只处理当前Validator诊断指向的一个合理Active Cluster，即“能通过一次候选修改形成Validator可验证闭环的最小耦合语义问题集合”。不得把Active Cluster缩减为单条诊断、单行或单个符号；同一问题簇内相互依赖的Definition、Usage、typing、关系端点、constraint和引用必须一起闭合。也不得顺带修复其他独立问题簇；保留与当前问题簇无关的正确内容。修复后立即提交完整候选供Validator复核，再根据新诊断进入下一问题簇；不做全局重写或全模型重新设计。`,
  PLANTUML_VIEW_MODELING_GUIDANCE,
].join("\n\n");

/** 生产V2链唯一固定Handler装配；Dispatcher不接受LLM生成的路由或Handler名称。 */
export function createProductionWorkerHandlers(
  options: ProductionWorkerHandlerOptions,
): WorkerHandlers {
  return Object.freeze({
    candidate: async (task: CandidateTaskView, context: WorkerExecutionContext) => {
      const registeredTools = createTaskBoundTools(options, task);
      const candidateStartedAtMs = Date.now();
      const engineeringRevision = options.engineeringRevision;
      const candidateDeadlineAtMs = engineeringRevision
        ? engineeringRevisionDeadlineAt(options, candidateStartedAtMs)
        : candidateAttemptDeadlineAt(options.resources, candidateStartedAtMs);
      await prepareCandidateKnowledge({
        options,
        task,
        abortSignal: context.abortSignal,
      });
      return await runCandidateWorker({
        resources: options.resources,
        task,
        model: options.model,
        abortSignal: context.abortSignal,
        instructions: candidateInstructions(),
        ...(engineeringRevision
          ? { prompt: engineeringRevisionPrompt(engineeringRevision) }
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
    repair: async (task: RepairTaskView, context: WorkerExecutionContext) => {
      const registeredTools = createTaskBoundTools(options, task);
      return await runProductionRepair({
        options,
        task,
        registeredTools,
        abortSignal: context.abortSignal,
      });
    },
  });
}

function createTaskBoundTools(
  options: ProductionWorkerHandlerOptions,
  task: CandidateTaskView | RepairTaskView,
): ReadOnlyTeacherTools {
  const model = {
    ...task.model,
    files: task.model.files.map((file) => ({ ...file })),
    diagnostics: task.model.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
  return createReadOnlyTools({
    context: { ...options.request.context, model },
    dependencies: options.dependencies,
    capabilityGrant: normalizeCapabilityGrant(options.request.capabilityGrant),
    ledger: options.resources.ledger,
    runResources: options.resources,
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
      workPerformed: "none",
      validatorSubject: "baseline",
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
  const repairStartedAtMs = Date.now();
  const repairDeadlineAtMs = repairPhaseDeadlineAt(input.options.resources, repairStartedAtMs);
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
  const maxRepairRounds = Math.max(1, input.options.policy.repairMaxRounds);
  let activeRepairRound = 1;
  let completedRepairRound = 0;
  await persistExecutionCheckpointFailSoft(input.options.resources, input.options.dependencies, {
    phase: "repair_in_progress",
    candidate: checkpointCandidate,
    validation: input.initialValidation,
    repairRound,
    metadata: engineeringCheckpointMetadata(input.options),
  });
  await reportRepairProgressFailSoft(input.options.resources, input.options.dependencies, {
    phase: "started",
    round: activeRepairRound,
    maxRounds: maxRepairRounds,
    diagnosticCount: validationDiagnosticCount(checkpointValidation),
  });
  return await runRepairWorker({
    resources: input.options.resources,
    task,
    model: input.options.repairModel ?? input.options.model,
    instructions: REPAIR_INSTRUCTIONS,
    taskMessages: projectConversationModelMessages(task.conversationMessages, task.taskSources, task.question),
    taskContext: {
      taskSourceRelations: task.taskSources.map((source) => source.relation),
      ...(task.courseContext ? { inspectedCourseContext: task.courseContext } : {}),
      target: task.target.kind,
      ...(input.options.engineeringRevision
        ? { engineeringRevision: engineeringRevisionRepairContext(input.options.engineeringRevision, input.content) }
        : {}),
    },
    abortSignal: input.abortSignal,
    // Repair ToolLoop共享一个阶段窗口；其中任一Provider step都不得把Candidate
    // 之后的全部Run余额当作自己的超时预算。
    timeoutMs: Math.max(1, repairDeadlineAtMs - repairStartedAtMs),
    toolTimeoutMs: input.options.policy.toolTimeoutMs,
    contextWindowTokens: input.options.policy.contextWindowTokens,
    maxCandidateAttempts: Math.max(
      1,
      input.options.resources.resourcePolicy.maxUniqueCandidateValidationsPerWorker - 1,
    ),
    maxRepairRounds: input.options.policy.repairMaxRounds,
    maxKnowledgeQueries: input.options.policy.maxSteps,
    maxCandidateArtifactBytes: input.options.policy.candidateMaxArtifactBytes,
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
      if (progress.boundary === "validator_completed" && repairRound > 0) {
        completedRepairRound = repairRound;
        await reportRepairProgressFailSoft(input.options.resources, input.options.dependencies, {
          phase: latestValidationPassed ? "validation_passed" : "validation_failed",
          round: repairRound,
          maxRounds: maxRepairRounds,
          diagnosticCount: validationDiagnosticCount(checkpointValidation),
        });
        const canContinue = !latestValidationPassed
          && validationRetryable(checkpointValidation)
          && progress.repairState.metrics.noProgress !== true
          && repairRound < maxRepairRounds;
        if (canContinue) {
          activeRepairRound = repairRound + 1;
          await reportRepairProgressFailSoft(input.options.resources, input.options.dependencies, {
            phase: "started",
            round: activeRepairRound,
            maxRounds: maxRepairRounds,
            diagnosticCount: validationDiagnosticCount(checkpointValidation),
          });
        }
      }
      if (progress.boundary === "terminal"
        && !latestValidationPassed
        && activeRepairRound > completedRepairRound) {
        await reportRepairProgressFailSoft(input.options.resources, input.options.dependencies, {
          phase: "stopped",
          round: activeRepairRound,
          maxRounds: maxRepairRounds,
          diagnosticCount: validationDiagnosticCount(checkpointValidation),
        });
        completedRepairRound = activeRepairRound;
      }
    },
    searchReviewedKnowledge: async ({ query, offset, exampleIds, claimIds, evidenceIds, toolCallId, abortSignal }) => await executeRegisteredTool(
      input.registeredTools,
      "search_reviewed_knowledge",
      { query, limit: 5, offset, exampleIds, claimIds, evidenceIds },
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

async function reportRepairProgressFailSoft(
  resources: RunResources,
  dependencies: RunTeacherAgentOptions["dependencies"],
  progress: Parameters<NonNullable<RunTeacherAgentOptions["dependencies"]["reportRepairProgress"]>>[0],
): Promise<void> {
  if (!dependencies.reportRepairProgress) return;
  try {
    await dependencies.reportRepairProgress(progress);
  } catch {
    resources.recordOperationalWarning("public_repair_progress_failed");
  }
}

function validationDiagnosticCount(validation: ValidationOutput): number {
  const declared = Number(validation.diagnosticSummary?.total);
  if (Number.isInteger(declared) && declared >= 0) return Math.min(999, declared);
  return Math.min(
    999,
    validation.official.diagnostics.length + (validation.courseRules?.diagnostics.length ?? 0),
  );
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
  const contents = candidate.mode === "replace_entry" || candidate.mode === "standalone_model" ? [candidate.content]
    : candidate.mode === "workspace_files" ? candidate.files.map(file => file.content) : candidate.edits.map(edit => edit.replacement);
  if (contents.reduce((bytes, content) => bytes + Buffer.byteLength(content, "utf8"), 0) > input.resources.candidateMaxArtifactBytes) {
    throw new Error("candidate_artifact_budget_exceeded");
  }
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
      phase: passed ? "main_review_pending" : "validation_failed",
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
  return {
    mode: "standalone_model",
    fileName: task.target.fileName ?? "generated_architecture.sysml",
    content,
  };
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

function candidateInstructions(): string {
  return [
    CANDIDATE_BASE_INSTRUCTIONS,
    SYSML_V2_LANGUAGE_BOUNDARY_GUIDANCE,
    CANDIDATE_ADAPTIVE_GENERATION_GUIDANCE,
    SYSML_INCREMENTAL_EDIT_GUIDANCE,
    TASK_DIRECTIVE_EXECUTION_GUIDANCE,
    MINIMAL_SUFFICIENT_REASONING_GUIDANCE,
    EXAMPLE_QUERY_FEW_SHOTS,
    candidateReviewedKnowledgeGuidance(),
    PLANTUML_VIEW_MODELING_GUIDANCE,
  ].filter((section) => String(section || "").trim().length > 0).join("\n\n");
}

async function prepareCandidateKnowledge(input: {
  options: ProductionWorkerHandlerOptions; task: CandidateTaskView; abortSignal: AbortSignal;
}): Promise<void> {
  const { options, task, abortSignal } = input;
  // 复用Main已取得的完整证据；否则通过同一授权Tool/Ledger准备一次定向检索。
  const existing = projectWorkerEvidenceView(options.resources, options.resources.tasks.get(task.taskId)!);
  if (existing.claims.length || existing.examples?.length || !options.request.capabilityGrant.includes("search_reviewed_knowledge")) {
    return;
  }
  const query = candidateKnowledgeQuery(task.iterationDirective?.instruction || task.question);
  if (query.length < 2) return;
  try {
    await executeRegisteredTool(createTaskBoundTools(options, task), "search_reviewed_knowledge", { query, limit: 5 },
      task.taskId + ":knowledge-preparation", abortSignal);
  } catch {
    options.resources.recordOperationalWarning("targeted_knowledge_preparation_unavailable");
  }
  return;
}

function engineeringRevisionPrompt(
  revision: NonNullable<ProductionWorkerHandlerOptions["engineeringRevision"]>,
): string {
  return [
    "执行一次有界工程完善。以下基线已经通过Official Validator；只围绕服务端绑定到用户原文的Issue完善，不做无关全局重写。",
    "每条goalQuote和本轮用户任务都是用户原文中的授权目标，不是语法关键词表。对每个Issue内部逐项核对goalQuote、issue和suggestion中的对象、功能、关系与场景；用户原文包含列举、并列、条件或强调场景时，即使Issue或Suggestion摘要不完整，也必须从授权原文恢复并闭合其中每个显式要求。每个显式命名的工程概念都必须有可追溯的模型元素或关系；强调场景必须用适合其语义的行为、控制、工况或其它真实模型元素表达，并关联受影响对象，不能只靠相关部件、静态拓扑或注释暗示。Suggestion是最小闭合范围，不得只补名字、注释、孤立对象、相关部件或部分子项。",
    "在满足上述语义的前提下，优先沿用已通过Validator的基线建模风格和已有构造，以最少新增元素及关系完成闭合。用户没有明确要求复杂行为细节时，不要为了表达场景而扩张成大规模行为模型；可以用最小的控制、模式或工况对象及其与受控对象的关系建立可追溯闭环。",
    "保留基线中与Issue无关的正确内容，使用与目标语义匹配的SysML v2元素和关系完成闭合，并输出一份完整Candidate供Official Validator重新验证。提交前做一次简洁的目标覆盖自检，但不要输出分析过程。",
    `已验证基线：\n${revision.baselineCandidateContent}`,
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
    completeness: validation.completeness,
    diagnostics: validation.official.diagnostics.slice(0, 20),
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
