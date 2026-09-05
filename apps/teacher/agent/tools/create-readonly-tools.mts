import { createHash } from "node:crypto";
import { selectKnowledgeContent } from "../knowledge-content.mjs";

import { tool } from "ai";
import type { z } from "zod";

import { ToolExecutionLedger } from "../agent-ledger.mjs";
import { assertToolCapability, deriveEditorGrounding } from "../agent-policy.mjs";
import type { BudgetOperation, RunBusinessAction, RunResources } from "../run-resources.mjs";
import {
  currentModelOutputSchema,
  domainEvidenceOutputSchema,
  inspectCurrentModelInputSchema,
  inspectLessonContextInputSchema,
  lessonContextOutputSchema,
  reviewedKnowledgeOutputSchema,
  searchReviewedKnowledgeInputSchema,
  searchDomainEvidenceInputSchema,
  searchGuidanceInputSchema,
  skillGuidanceOutputSchema,
  validateCandidateInputSchema,
  validateCandidateToolInputSchema,
  validationOutputSchema,
  type AgentDependencies,
  type TeacherAgentContext,
  type ToolName,
  type ValidateCandidateInput,
  type ValidatorObservation,
} from "../types.mjs";

interface ToolRegistryOptions {
  context: TeacherAgentContext;
  dependencies: AgentDependencies;
  capabilityGrant: ReadonlySet<ToolName>;
  ledger: ToolExecutionLedger;
  runResources?: RunResources;
}

function hashText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function validatorDependencyEnvelope(value: unknown): {
  validation: unknown;
  observations: readonly Readonly<ValidatorObservation>[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { validation: value, observations: [] };
  }
  const record = value as Record<string, unknown>;
  if (!("validation" in record) || !Array.isArray(record.validatorObservations)) {
    return { validation: value, observations: [] };
  }
  return {
    validation: record.validation,
    observations: record.validatorObservations as readonly Readonly<ValidatorObservation>[],
  };
}

function validatorErrorObservations(error: unknown): readonly Readonly<ValidatorObservation>[] {
  if (!error || typeof error !== "object") return [];
  const observations = (error as { validatorObservations?: unknown }).validatorObservations;
  return Array.isArray(observations)
    ? observations as readonly Readonly<ValidatorObservation>[]
    : [];
}

function extractKnowledgeOperators(value: string): string[] {
  const found: string[] = [];
  const multi = ["default :=", "default =", "::>", ":>>", ":=", ":>"];
  for (let index = 0; index < value.length;) {
    const operator = multi.find((candidate) => value.startsWith(candidate, index));
    if (operator) {
      found.push(operator);
      index += operator.length;
      continue;
    }
    const current = value[index];
    const previous = value[index - 1] ?? "";
    const next = value[index + 1] ?? "";
    if (current === ":" && previous !== ":" && next !== ":" && next !== "/" && next !== "\\") {
      found.push(":");
    }
    if (current === "=" && !["<", ">", "!", "=", ":"].includes(previous) && !["=", ">"].includes(next)) {
      found.push("=");
    }
    index += 1;
  }
  return [...new Set(found)];
}

async function executeBoundTool<OUTPUT>(args: {
  toolCallId: string;
  toolName: ToolName;
  input: unknown;
  abortSignal?: AbortSignal;
  capabilityGrant: ReadonlySet<ToolName>;
  ledger: ToolExecutionLedger;
  outputSchema: z.ZodType<OUTPUT>;
  outputGuard?: (output: OUTPUT) => void;
  operation: () => Promise<unknown>;
  budgetOperation?: BudgetOperation;
  phaseAction?: RunBusinessAction;
  runResources?: RunResources;
}): Promise<OUTPUT> {
  const priorResult = args.runResources?.findPriorKnowledgeResult(args.toolName, args.input);
  return await args.ledger.execute({
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    input: args.input,
    abortSignal: args.abortSignal,
    ...(priorResult ? { replayedFromRunId: priorResult.sourceRunId } : {}),
    operation: async ({ markBackendExecutionStarted }) => {
      assertToolCapability(args.capabilityGrant, args.toolName);
      if (priorResult) {
        const output = args.outputSchema.parse(priorResult.output);
        args.outputGuard?.(output);
        args.runResources?.knowledge.observeToolResult(args.toolName, args.input, output);
        return output;
      }
      if (args.phaseAction && args.runResources) {
        args.runResources.assertAdmitted(args.phaseAction);
      }
      if (args.toolName === "search_reviewed_knowledge" && args.runResources) {
        args.runResources.assertNewReviewedKnowledgeQueryAllowed(args.input);
      }
      const permit = args.budgetOperation && args.runResources
        ? args.runResources.budget.reserve(args.budgetOperation)
        : undefined;
      try {
        markBackendExecutionStarted();
        const rawOutput = await args.operation();
        const output = args.outputSchema.parse(rawOutput);
        args.outputGuard?.(output);
        args.runResources?.knowledge.observeToolResult(args.toolName, args.input, output);
        if (permit) args.runResources?.budget.settle(permit, "succeeded");
        return output;
      } catch (error) {
        if (args.toolName === "search_reviewed_knowledge") args.runResources?.knowledge.releaseFailedQuery(args.input);
        if (permit) {
          args.runResources?.budget.settle(
            permit,
            args.abortSignal?.aborted ? "cancelled" : "failed",
          );
        }
        throw error;
      }
    },
  });
}

function authorizedFiles(context: TeacherAgentContext): Map<string, TeacherAgentContext["model"]["files"][number]> {
  return new Map(context.model.files.map((file) => [file.fileId, file]));
}

function authorizedInspectedFiles(
  context: TeacherAgentContext,
  source: "current_workspace" | "last_validated_candidate",
): Map<string, TeacherAgentContext["model"]["files"][number]> {
  if (source === "current_workspace") return authorizedFiles(context);
  const candidate = context.conversationSubjects?.lastValidatedCandidate;
  if (!candidate) throw new Error("Last validated Candidate is unavailable");
  return new Map([[candidate.fileId, {
    fileId: candidate.fileId,
    displayName: candidate.displayName,
    content: candidate.content,
    contentHash: candidate.contentHash,
    editable: true,
  }]]);
}

function candidateTargetReadOnlyError(fileId: string): Error & { readonly code: string } {
  return Object.assign(
    new Error(`Read-only candidate must match the trusted snapshot: ${fileId}`),
    { code: "CANDIDATE_TARGET_READ_ONLY" as const },
  );
}

function assertCandidateAuthorized(
  context: TeacherAgentContext,
  input: ValidateCandidateInput,
): void {
  if (input.mode === "standalone_model") {
    if (!/^[\p{L}\p{N}_-][\p{L}\p{N}._-]*\.sysml$/iu.test(input.fileName)) {
      throw new Error("Standalone candidate fileName must be a safe .sysml basename");
    }
    return;
  }
  const files = authorizedFiles(context);
  if (input.mode === "workspace_files") {
    const seen = new Set<string>();
    for (const candidate of input.files) {
      if (seen.has(candidate.fileId)) {
        throw new Error(`Duplicate candidate fileId: ${candidate.fileId}`);
      }
      seen.add(candidate.fileId);
      const authorized = files.get(candidate.fileId);
      if (!authorized || authorized.contentHash !== candidate.baseHash) {
        throw new Error(`Candidate file is not authorized at its base hash: ${candidate.fileId}`);
      }
      if (!authorized.editable && candidate.content !== authorized.content) {
        throw candidateTargetReadOnlyError(candidate.fileId);
      }
    }
    return;
  }

  if (input.mode === "apply_edits") {
    const grouped = new Map<string, typeof input.edits>();
    for (const edit of input.edits) {
      const authorized = files.get(edit.fileId);
      if (!authorized || !authorized.editable || authorized.contentHash !== edit.baseHash) {
        throw new Error(`Candidate edit is not authorized at its base hash: ${edit.fileId}`);
      }
      const existing = grouped.get(edit.fileId) ?? [];
      grouped.set(edit.fileId, [...existing, edit]);
    }
    for (const edits of grouped.values()) {
      const ordered = [...edits].sort((left, right) => left.startLine - right.startLine);
      const firstEdit = ordered[0];
      if (!firstEdit) {
        throw new Error("Candidate edit group must not be empty");
      }
      const authorized = files.get(firstEdit.fileId);
      if (!authorized) {
        throw new Error(`Candidate file is not authorized: ${firstEdit.fileId}`);
      }
      const lineCount = authorized.content.split(/\r?\n/u).length;
      let previousEnd = 0;
      for (const edit of ordered) {
        if (edit.startLine <= previousEnd) {
          throw new Error("Candidate line edits must not overlap");
        }
        if (edit.endLine > lineCount + 1) {
          throw new Error(`Candidate line edit exceeds the authorized file: ${edit.fileId}`);
        }
        previousEnd = edit.endLine;
      }
    }
    return;
  }

  const authorized = files.get(input.fileId);
  if (!authorized || authorized.contentHash !== input.baseHash) {
    throw new Error(`Candidate file is not authorized at its base hash: ${input.fileId}`);
  }
  if (!authorized.editable && input.content !== authorized.content) {
    throw candidateTargetReadOnlyError(input.fileId);
  }
  if (
    input.mode === "replace_entry" &&
    context.model.entryFileId &&
    input.fileId !== context.model.entryFileId
  ) {
    throw new Error("replace_entry may only target the trusted entry file");
  }
}

function assertValidationOutputAuthorized(
  context: TeacherAgentContext,
  output: z.infer<typeof validationOutputSchema>,
): void {
  const files = authorizedFiles(context);
  for (const patch of output.patches) {
    const authorized = files.get(patch.fileId);
    if (!authorized || authorized.contentHash !== patch.baseHash) {
      throw new Error(`Validator returned a patch outside the authorized manifest: ${patch.fileId}`);
    }
  }
}

export function createReadOnlyTools(options: ToolRegistryOptions) {
  const grounding = deriveEditorGrounding(options.context);

  const inspectLessonContext = tool({
    description:
      "按需读取当前课程与课时目标、课程规则和课程参考工作区。参数不包含路径；仅返回服务端绑定到本次运行的可信课程资产。课程规则是工程Review参考，不是Official Validator硬门。",
    strict: true,
    inputSchema: inspectLessonContextInputSchema,
    execute: async (input, execution) => {
      const output = await executeBoundTool({
        toolCallId: execution.toolCallId,
        toolName: "inspect_lesson_context",
        input,
        abortSignal: execution.abortSignal,
        capabilityGrant: options.capabilityGrant,
        ledger: options.ledger,
        outputSchema: lessonContextOutputSchema,
        phaseAction: "knowledge_search",
        runResources: options.runResources,
        outputGuard: (output) => {
          if (
            output.courseId !== options.context.lesson.courseId ||
            output.lessonId !== options.context.lesson.lessonId
          ) {
            throw new Error("Lesson dependency returned context for a different lesson");
          }
        },
        operation: async () =>
          await options.dependencies.inspectLessonContext({
            context: options.context,
            input,
            abortSignal: execution.abortSignal,
          }),
      });
      return output;
    },
  });

  const inspectCurrentModel = tool({
    description:
      "读取本次运行已授权的模型、诊断、选区和光标语义。不接受文件路径；非空选区优先于光标。",
    strict: true,
    inputSchema: inspectCurrentModelInputSchema,
    execute: async (input, execution) => {
      const output = await executeBoundTool({
        toolCallId: execution.toolCallId,
        toolName: "inspect_current_model",
        input,
        abortSignal: execution.abortSignal,
        capabilityGrant: options.capabilityGrant,
        ledger: options.ledger,
        outputSchema: currentModelOutputSchema,
        phaseAction: "knowledge_search",
        runResources: options.runResources,
        outputGuard: (output) => {
          if (output.source !== input.source) {
            throw new Error("Model dependency returned a different source");
          }
          const authorized = authorizedInspectedFiles(options.context, input.source);
          for (const file of output.files) {
            const expected = authorized.get(file.fileId);
            if (
              !expected ||
              file.contentHash !== expected.contentHash ||
              file.editable !== expected.editable ||
              (file.content !== undefined && file.content !== expected.content)
            ) {
              throw new Error("Model dependency returned data outside the authorized snapshot");
            }
          }
          const expectedActiveFileId = input.source === "current_workspace"
            ? options.context.model.activeFileId
            : options.context.conversationSubjects?.lastValidatedCandidate?.fileId;
          if (output.activeFileId !== expectedActiveFileId) {
            throw new Error("Model dependency returned a different active file");
          }
          const expectedActiveDiagnosticId = input.source === "current_workspace"
            ? options.context.model.activeDiagnosticId
            : undefined;
          if (output.activeDiagnosticId !== expectedActiveDiagnosticId) {
            throw new Error("Model dependency returned a different active diagnostic");
          }
          if (input.source === "last_validated_candidate" && output.diagnostics.length > 0) {
            throw new Error("Previous Candidate inspection must not inherit current diagnostics");
          }
        },
        operation: async () => {
          const rawOutput = await options.dependencies.inspectCurrentModel({
            context: options.context,
            input,
            grounding,
            abortSignal: execution.abortSignal,
          });
          const parsed = currentModelOutputSchema.parse(rawOutput);
          return parsed;
        },
      });
      return output;
    },
  });

  const searchSkillGuidance = tool({
    description:
      "在服务端 allowlist 内检索 SysML v2 Skill 指导。只接受查询、主题和有限条数，不接受路径或 URL。",
    strict: true,
    inputSchema: searchGuidanceInputSchema,
    execute: async (input, execution) => {
      const output = await executeBoundTool({
        toolCallId: execution.toolCallId,
        toolName: "search_skill_guidance",
        input,
        abortSignal: execution.abortSignal,
        capabilityGrant: options.capabilityGrant,
        ledger: options.ledger,
        outputSchema: skillGuidanceOutputSchema,
        phaseAction: "knowledge_search",
        budgetOperation: "knowledge_backend",
        runResources: options.runResources,
        outputGuard: (output) => {
          if (output.query !== input.query) {
            throw new Error("Skill dependency query mismatch");
          }
        },
        operation: async () =>
          await options.dependencies.searchSkillGuidance({
            context: options.context,
            input,
            abortSignal: execution.abortSignal,
          }),
      });
      return output;
    },
  });

  const searchReviewedKnowledge = tool({
    toModelOutput: ({ output }) => {
      const selected = selectKnowledgeContent([output], options.runResources?.knowledgeWindowTokens ?? Number.POSITIVE_INFINITY);
      return { type: "json" as const, value: JSON.parse(JSON.stringify({
        ...(output as Record<string, unknown>), ...selected, disclosedContentComplete: selected.deferredContent.length === 0,
      })) };
    },
    description:
      "从当前Active SysML v2权威知识Bundle检索已审核Claim与Evidence。首次调用返回可选Knowledge Pattern；只有你确认Pattern适合学生原问题时，才在后续调用提交其selectedPatternIds以加载完整闭包。Pattern候选本身不是回答义务。",
    strict: true,
    inputSchema: searchReviewedKnowledgeInputSchema,
    execute: async (input, execution) => {
      const output = await executeBoundTool({
        toolCallId: execution.toolCallId,
        toolName: "search_reviewed_knowledge",
        input,
        abortSignal: execution.abortSignal,
        capabilityGrant: options.capabilityGrant,
        ledger: options.ledger,
        outputSchema: reviewedKnowledgeOutputSchema,
        budgetOperation: "knowledge_backend",
        phaseAction: "knowledge_search",
        runResources: options.runResources,
        outputGuard: (output) => {
          if (output.requestedQuery !== input.query) {
            throw new Error("Knowledge dependency requestedQuery mismatch");
          }
          if (output.requestedQueryHash !== hashText(input.query)
            || output.effectiveQueryHash !== hashText(output.effectiveQuery)) {
            throw new Error("Knowledge dependency query hash mismatch");
          }
          const effectiveOperators = new Set(extractKnowledgeOperators(output.effectiveQuery));
          const missingRequestedOperators = extractKnowledgeOperators(input.query)
            .filter((operator) => !effectiveOperators.has(operator));
          if (missingRequestedOperators.length > 0) {
            throw new Error(`Knowledge dependency removed requested operators: ${missingRequestedOperators.join(",")}`);
          }
          const requestedPatternIds = new Set(input.selectedPatternIds || []);
          if (output.selectedKnowledgePatternIds.some((patternId) => !requestedPatternIds.has(patternId))) {
            throw new Error("Knowledge dependency activated an unrequested Pattern");
          }
        },
        operation: async () =>
          await options.dependencies.searchReviewedKnowledge({
            context: options.context,
            input,
            abortSignal: execution.abortSignal,
          }),
      });
      return output;
    },
  });

  const searchDomainEvidence = tool({
    description:
      "使用服务端配置的 DeepSeek 原生 Web Search 检索工程领域事实。只接受最多三个自然语言研究问题，不接受 URL、域名、请求头或认证信息；结果不得覆盖 SysML v2 内部语言证据。",
    strict: true,
    inputSchema: searchDomainEvidenceInputSchema,
    execute: async (input, execution) => {
      const output = await executeBoundTool({
        toolCallId: execution.toolCallId,
        toolName: "search_engineering_domain_evidence",
        input,
        abortSignal: execution.abortSignal,
        capabilityGrant: options.capabilityGrant,
        ledger: options.ledger,
        outputSchema: domainEvidenceOutputSchema,
        phaseAction: "knowledge_search",
        budgetOperation: "knowledge_backend",
        runResources: options.runResources,
        outputGuard: (result) => {
          if (result.questions.length !== input.questions.length
            || result.questions.some((question, index) => question !== input.questions[index])) {
            throw new Error("Domain evidence dependency question mismatch");
          }
        },
        operation: async () =>
          await options.dependencies.searchDomainEvidence({
            context: options.context,
            input,
            abortSignal: execution.abortSignal,
          }),
      });
      return output;
    },
  });

  const validateCandidateWorkspace = tool({
    description:
      "在隔离副本中验证候选 SysML v2 工作区或独立模型。工作区修改只接受授权 fileId/baseHash；standalone_model 只验证和展示，不生成当前工作区补丁。先运行官方验证，再按适用性运行课程规则。",
    strict: true,
    inputSchema: validateCandidateToolInputSchema,
    execute: async (input, execution) => {
      const validatedInput = validateCandidateInputSchema.parse(input);
      let validatorObservations: readonly Readonly<ValidatorObservation>[] = [];
      try {
        const output = await executeBoundTool({
          toolCallId: execution.toolCallId,
          toolName: "validate_candidate_workspace",
          input: validatedInput,
          abortSignal: execution.abortSignal,
          capabilityGrant: options.capabilityGrant,
          ledger: options.ledger,
          outputSchema: validationOutputSchema,
          phaseAction: "candidate_validate",
          budgetOperation: "validator",
          runResources: options.runResources,
          operation: async () => {
            assertCandidateAuthorized(options.context, validatedInput);
            let rawOutput: unknown;
            try {
              rawOutput = await options.dependencies.validateCandidateWorkspace({
                context: options.context,
                input: validatedInput,
                abortSignal: execution.abortSignal,
              });
            } catch (error) {
              validatorObservations = validatorErrorObservations(error);
              throw error;
            }
            const envelope = validatorDependencyEnvelope(rawOutput);
            validatorObservations = envelope.observations;
            const parsed = validationOutputSchema.parse(envelope.validation);
            if (validatedInput.mode === "standalone_model" && parsed.patches.length > 0) {
              throw new Error("Standalone candidate validation must not create workspace patches");
            }
            assertValidationOutputAuthorized(options.context, parsed);
            return parsed;
          },
        });
        // executeBoundTool返回时Ledger记录必已注册；此时附加摘要，避免启动竞态丢失观测。
        options.ledger.appendValidatorObservations(execution.toolCallId, validatorObservations);
        return output;
      } catch (error) {
        options.ledger.appendValidatorObservations(
          execution.toolCallId,
          validatorObservations.length ? validatorObservations : validatorErrorObservations(error),
        );
        throw error;
      }
    },
  });

  return {
    inspect_lesson_context: inspectLessonContext,
    inspect_current_model: inspectCurrentModel,
    search_skill_guidance: searchSkillGuidance,
    search_reviewed_knowledge: searchReviewedKnowledge,
    search_engineering_domain_evidence: searchDomainEvidence,
    validate_candidate_workspace: validateCandidateWorkspace,
  };
}

export type ReadOnlyTeacherTools = ReturnType<typeof createReadOnlyTools>;
