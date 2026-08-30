import {
  APICallError,
  generateText,
  NoObjectGeneratedError,
  Output,
  streamText,
  tool,
  type LanguageModel,
  type LanguageModelCallStartEvent,
  type LanguageModelUsage,
  type Instructions,
  type ModelMessage,
  type OnToolExecutionEndCallback,
  type OnToolExecutionStartCallback,
  type PrepareStepFunction,
  type StepResult,
  type StopCondition,
  type TimeoutConfiguration,
  type ToolChoice,
  type ToolSet,
  type TypedToolCall,
  type TypedToolResult,
} from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { FlexibleSchema } from "@ai-sdk/provider-utils";
import { z } from "zod";
import { recordModelGeneration } from "./model-call-audit.mjs";
import type { RunExecutionView, RunToolContext } from "./run-resources.mjs";

export interface ObservedTextResult {
  text: string;
  usage: LanguageModelUsage;
  finishReason: string;
  toolCalls: readonly unknown[];
  steps: readonly unknown[];
  timeToFirstOutputMs?: number;
}

interface ObservedTextOptionsBase {
  model: LanguageModel;
  phase?: string;
  promptVersion?: string;
  instructions?: Instructions;
  maxRetries?: number;
  maxOutputTokens?: number;
  temperature?: number;
  reasoning?: "none" | "medium" | "high" | "xhigh";
  providerOptions?: SharedV4ProviderOptions;
  abortSignal?: AbortSignal;
  /** 直接透传AI SDK timeout；调用方不得再并行维护第二套Step计时器。 */
  timeout?: TimeoutConfiguration<{}>;
  /** AI SDK运行上下文；只允许不可变、有界的服务端投影。 */
  runtimeContext?: RunExecutionView;
}

type ObservedPromptInput =
  | { prompt: string; messages?: never }
  | { messages: ModelMessage[]; prompt?: never };

export type ObservedTextOptions = ObservedTextOptionsBase & ObservedPromptInput;

export type ObservedToolLoopTextOptions<TOOLS extends ToolSet> = Omit<ObservedTextOptionsBase, "timeout"> & ObservedPromptInput & {
  tools: TOOLS;
  toolChoice?: ToolChoice<TOOLS>;
  stopWhen: StopCondition<TOOLS> | Array<StopCondition<TOOLS>>;
  prepareStep?: PrepareStepFunction<TOOLS>;
  timeout?: TimeoutConfiguration<TOOLS>;
  toolsContext?: Readonly<Record<string, RunToolContext>>;
  onToolExecutionStart?: OnToolExecutionStartCallback<TOOLS>;
  onToolExecutionEnd?: OnToolExecutionEndCallback<TOOLS>;
};

export interface ObservedToolLoopTextResult<TOOLS extends ToolSet> {
  text: string;
  usage: LanguageModelUsage;
  finishReason: string;
  toolCalls: readonly TypedToolCall<TOOLS>[];
  toolResults: readonly TypedToolResult<TOOLS>[];
  steps: readonly StepResult<TOOLS>[];
  timeToFirstOutputMs?: number;
}

export interface ObservedObjectResult<T> {
  value: T;
  usage: LanguageModelUsage;
  finishReason: string;
  toolCalls: readonly [];
  steps: readonly [unknown];
  timeToFirstOutputMs?: number;
}

export type ObservedObjectOptions<T> = ObservedTextOptionsBase & ObservedPromptInput & {
  schema: FlexibleSchema<T>;
  schemaName?: string;
  schemaDescription?: string;
};

export type WorkflowObjectOptions<T> = ObservedObjectOptions<T> & {
  phase: string;
  toolChoiceMode?: "required" | "auto";
};

export type WorkflowChoiceOptions<CHOICE extends string> = ObservedTextOptions & {
  phase: string;
  choices: readonly CHOICE[];
  choiceName?: string;
  choiceDescription?: string;
};

export type WorkflowObjectErrorCategory =
  | "aborted"
  | "structured_output_invalid"
  | "provider_contract_error"
  | "provider_failure";

export const WORKFLOW_JSON_RESPONSE_INSTRUCTION =
  "本调用通过AI SDK受类型约束的提交通道传递最小建议；不要在聊天正文中手写JSON。最终业务状态由服务端派生。";

const WORKFLOW_ADVICE_TOOL_NAME = "submit_workflow_advice";

function workflowToolName(name?: string): string {
  const normalized = String(name ?? "workflow_advice")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
  return `submit_${normalized || "workflow_advice"}`;
}

/**
 * 生产模型走流式接口以取得真实首输出时间；AI SDK mock 仍走 doGenerate，
 * 避免现有确定性测试被迫同时维护一套无业务价值的 doStream fixture。
 */
export async function generateObservedText(
  options: ObservedTextOptions,
): Promise<ObservedTextResult> {
  const {
    phase = "text_generation",
    promptVersion,
    ...generationOptions
  } = options;
  const startedAt = Date.now();
  const auditStartedAt = new Date(startedAt).toISOString();
  try {
    if (typeof generationOptions.model !== "string"
      && "provider" in generationOptions.model
      && generationOptions.model.provider === "mock-provider") {
      const result = await generateText(generationOptions);
      await recordModelGeneration({
        phase,
        promptVersion,
        request: auditConfiguredRequest(generationOptions),
        steps: result.steps,
        parserStatus: "ai_sdk_parsed",
        startedAt: auditStartedAt,
      });
      return {
        text: result.text,
        usage: result.usage,
        finishReason: result.finishReason,
        toolCalls: result.toolCalls,
        steps: result.steps,
      };
    }

    let timeToFirstOutputMs: number | undefined;
    const result = streamText({
      ...generationOptions,
      onChunk: ({ chunk }) => {
        if (timeToFirstOutputMs !== undefined) return;
        if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
          timeToFirstOutputMs = Date.now() - startedAt;
        }
      },
    });
    const [text, usage, finishReason, steps] = await Promise.all([
      result.text,
      result.usage,
      result.finishReason,
      result.steps,
    ]);
    await recordModelGeneration({
      phase,
      promptVersion,
      request: auditConfiguredRequest(generationOptions),
      steps,
      parserStatus: "ai_sdk_parsed",
      startedAt: auditStartedAt,
    });
    return {
      text,
      usage,
      finishReason,
      toolCalls: steps.flatMap((step) => step.toolCalls),
      steps,
      ...(timeToFirstOutputMs === undefined ? {} : { timeToFirstOutputMs }),
    };
  } catch (error) {
    await recordModelGeneration({
      phase,
      promptVersion,
      request: auditConfiguredRequest(generationOptions),
      error,
      startedAt: auditStartedAt,
    });
    throw error;
  }
}

/** 使用AI SDK原生多步Tool Loop生成最终文本，业务对象仍由服务端构造。 */
export async function generateObservedToolLoopText<TOOLS extends ToolSet>(
  options: ObservedToolLoopTextOptions<TOOLS>,
): Promise<ObservedToolLoopTextResult<TOOLS>> {
  const {
    phase = "tool_loop_generation",
    promptVersion,
    ...generationOptions
  } = options;
  const startedAt = new Date().toISOString();
  const providerCalls: Array<{
    callId: string;
    request: LanguageModelCallStartEvent;
    startedAt: string;
    completedAt?: string;
  }> = [];
  try {
    // AI SDK用Tool定义推导toolsContext是否必填；本薄适配器允许同时服务
    // 有Context与无Context的ToolSet，因此在这一处把调用收窄到SDK原生参数类型。
    const result = await generateText<TOOLS, RunExecutionView>({
      ...generationOptions,
      onLanguageModelCallStart: (event) => {
        providerCalls.push({
          callId: event.callId,
          request: event,
          startedAt: new Date().toISOString(),
        });
      },
      onLanguageModelCallEnd: (event) => {
        const pending = [...providerCalls].reverse().find((call) => (
          call.callId === event.callId && call.completedAt === undefined
        ));
        if (pending) pending.completedAt = new Date().toISOString();
      },
    } as Parameters<typeof generateText<TOOLS, RunExecutionView>>[0]);
    await recordModelGeneration({
      phase,
      promptVersion,
      request: auditConfiguredRequest(generationOptions),
      steps: result.steps,
      providerCalls,
      parserStatus: "ai_sdk_parsed",
      startedAt,
    });
    return {
      text: result.text,
      usage: result.usage,
      finishReason: result.finishReason,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
      steps: result.steps,
    };
  } catch (error) {
    await recordModelGeneration({
      phase,
      promptVersion,
      request: auditConfiguredRequest(generationOptions),
      error,
      startedAt,
    });
    throw error;
  }
}

/**
 * 所有工作流最小建议的薄适配器。生产Provider使用AI SDK类型化Tool参数，
 * 避免让模型在正文手写JSON；跨字段和跨阶段语义仍由业务代码校验。
 */
export async function generateWorkflowObject<T>(
  options: WorkflowObjectOptions<T>,
): Promise<ObservedObjectResult<T>> {
  const {
    phase,
    promptVersion,
    schema,
    schemaName,
    schemaDescription,
    toolChoiceMode = "required",
    ...generationOptions
  } = options;
  const output = Output.object({
    schema,
    name: schemaName,
    description: schemaDescription,
  });
  const structuredGenerationOptions = {
    ...generationOptions,
    instructions: appendSystemInstruction(
      generationOptions.instructions,
      WORKFLOW_JSON_RESPONSE_INSTRUCTION,
    ),
  };
  const startedAt = new Date().toISOString();
  let observedSteps: readonly unknown[] | undefined;
  try {
    if (typeof structuredGenerationOptions.model !== "string"
      && "provider" in structuredGenerationOptions.model
      && structuredGenerationOptions.model.provider === "mock-provider") {
      const result = await generateText({ ...structuredGenerationOptions, output });
      observedSteps = result.steps;
      await recordModelGeneration({
        phase,
        promptVersion,
        request: auditConfiguredRequest(structuredGenerationOptions),
        steps: observedSteps,
        parserStatus: "schema_valid",
        startedAt,
      });
      return {
        value: result.output,
        usage: result.usage,
        finishReason: result.finishReason,
        toolCalls: [],
        steps: [result.steps[0] ?? {}],
      };
    }
    const adviceTool = tool({
      description: schemaDescription ?? "提交本阶段最小、非绑定的语义建议。最终业务状态由服务端派生。",
      inputSchema: schema,
    });
    const toolName = workflowToolName(schemaName);
    const result = await generateText({
      ...structuredGenerationOptions,
      tools: { [toolName]: adviceTool },
      toolChoice: toolChoiceMode === "auto" ? "auto" : { type: "tool", toolName },
    });
    observedSteps = result.steps;
    const adviceCall = result.toolCalls.find((call) => call.toolName === toolName);
    if (!adviceCall) throw new Error("workflow_advice_tool_call_missing");
    await recordModelGeneration({
      phase,
      promptVersion,
      request: auditConfiguredRequest(structuredGenerationOptions),
      steps: observedSteps,
      parserStatus: "schema_valid",
      startedAt,
    });
    return {
      value: adviceCall.input as T,
      usage: result.usage,
      finishReason: result.finishReason,
      toolCalls: [],
      steps: [result.steps[0] ?? {}],
    };
  } catch (error) {
    await recordModelGeneration({
      phase,
      promptVersion,
      request: auditConfiguredRequest(structuredGenerationOptions),
      steps: observedSteps,
      error,
      startedAt,
    });
    throw error;
  }
}

/**
 * 最小机器判断通过AI SDK类型化Tool参数提交，不让模型填写完整业务对象。
 * choice只能作为建议；最终业务状态必须由调用方的服务端逻辑派生。
 */
export async function generateWorkflowChoice<CHOICE extends string>(
  options: WorkflowChoiceOptions<CHOICE>,
): Promise<ObservedObjectResult<CHOICE>> {
  const {
    phase,
    promptVersion,
    choices,
    choiceName,
    choiceDescription,
    ...generationOptions
  } = options;
  const output = Output.choice({
    options: [...choices],
    name: choiceName,
    description: choiceDescription,
  });
  const structuredGenerationOptions = {
    ...generationOptions,
    instructions: appendSystemInstruction(
      generationOptions.instructions,
      "本调用使用AI SDK的最小类型化选择通道。只选择一个给定值；业务状态由服务端派生。",
    ),
  };
  const startedAt = new Date().toISOString();
  let observedSteps: readonly unknown[] | undefined;
  try {
    if (typeof structuredGenerationOptions.model !== "string"
      && "provider" in structuredGenerationOptions.model
      && structuredGenerationOptions.model.provider === "mock-provider") {
      const result = await generateText({ ...structuredGenerationOptions, output });
      observedSteps = result.steps;
      await recordModelGeneration({
        phase,
        promptVersion,
        request: auditConfiguredRequest(structuredGenerationOptions),
        steps: observedSteps,
        parserStatus: "schema_valid",
        startedAt,
      });
      return {
        value: result.output,
        usage: result.usage,
        finishReason: result.finishReason,
        toolCalls: [],
        steps: [result.steps[0] ?? {}],
      };
    }
    const choiceTool = tool({
      description: choiceDescription ?? "提交一个最小、非绑定的语义选择。最终业务状态由服务端派生。",
      inputSchema: z.object({
        choice: z.enum([...choices] as [CHOICE, ...CHOICE[]]),
      }).strict(),
    });
    const toolName = workflowToolName(choiceName ?? WORKFLOW_ADVICE_TOOL_NAME);
    const result = await generateText({
      ...structuredGenerationOptions,
      tools: { [toolName]: choiceTool },
      toolChoice: { type: "tool", toolName },
    });
    observedSteps = result.steps;
    const adviceCall = result.toolCalls.find((call) => call.toolName === toolName);
    if (!adviceCall) throw new Error("workflow_advice_tool_call_missing");
    const selected = (adviceCall.input as { choice?: unknown }).choice;
    if (typeof selected !== "string" || !choices.includes(selected as CHOICE)) {
      throw new Error("workflow_advice_choice_invalid");
    }
    await recordModelGeneration({
      phase,
      promptVersion,
      request: auditConfiguredRequest(structuredGenerationOptions),
      steps: observedSteps,
      parserStatus: "schema_valid",
      startedAt,
    });
    return {
      value: selected as CHOICE,
      usage: result.usage,
      finishReason: result.finishReason,
      toolCalls: [],
      steps: [result.steps[0] ?? {}],
    };
  } catch (error) {
    await recordModelGeneration({
      phase,
      promptVersion,
      request: auditConfiguredRequest(structuredGenerationOptions),
      steps: observedSteps,
      error,
      startedAt,
    });
    throw error;
  }
}

/** 兼容已有Repair调用；新工作流阶段应显式使用generateWorkflowObject。 */
export async function generateObservedObject<T>(
  options: ObservedObjectOptions<T>,
): Promise<ObservedObjectResult<T>> {
  return await generateWorkflowObject({ ...options, phase: options.schemaName ?? "structured_output" });
}

export function workflowObjectErrorCategory(error: unknown): WorkflowObjectErrorCategory {
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  const apiError = findApiCallError(error);
  if (apiError) {
    return apiError.statusCode !== undefined && apiError.statusCode >= 400 && apiError.statusCode < 500
      ? "provider_contract_error"
      : "provider_failure";
  }
  if (NoObjectGeneratedError.isInstance(error)) return "structured_output_invalid";
  if (error instanceof Error
    && (error.name === "ZodError" || /JSON|schema|parse|invalid input/iu.test(error.message))) {
    return "structured_output_invalid";
  }
  return "provider_failure";
}

function findApiCallError(error: unknown, depth = 0): APICallError | undefined {
  if (APICallError.isInstance(error)) return error;
  if (depth >= 4 || !error || typeof error !== "object" || !("cause" in error)) return undefined;
  return findApiCallError((error as { cause?: unknown }).cause, depth + 1);
}

function auditConfiguredRequest(options: Record<string, unknown>): Record<string, unknown> {
  const tools = options.tools && typeof options.tools === "object"
    ? Object.entries(options.tools as Record<string, unknown>).map(([name, definition]) => ({
      name,
      description: definition && typeof definition === "object" && "description" in definition
        ? (definition as { description?: unknown }).description
        : undefined,
    }))
    : [];
  return {
    instructions: options.instructions,
    prompt: options.prompt,
    messages: options.messages,
    maxRetries: options.maxRetries,
    maxOutputTokens: options.maxOutputTokens,
    temperature: options.temperature,
    reasoning: options.reasoning,
    toolChoice: options.toolChoice,
    toolNames: tools.map((entry) => entry.name),
    tools,
  };
}

function appendSystemInstruction(
  instructions: Instructions | undefined,
  content: string,
): Instructions {
  if (!instructions) return content;
  if (typeof instructions === "string") return `${instructions}\n\n${content}`;
  const appended = { role: "system" as const, content };
  return Array.isArray(instructions)
    ? [...instructions, appended]
    : [instructions, appended];
}
