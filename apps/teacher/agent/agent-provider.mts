import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import { z } from "zod";

const providerConfigSchema = z
  .object({
    name: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/),
    baseURL: z
      .url()
      .refine((value) => value.startsWith("https://") || value.startsWith("http://"), {
        message: "baseURL must use HTTP or HTTPS",
      }),
    modelId: z.string().min(1).max(200),
    apiKey: z.string().min(1).max(2_000).optional(),
    headers: z.record(z.string(), z.string().max(4_000)).optional(),
    includeUsage: z.boolean().default(true),
    compatibilityMode: z.enum(["generic-openai", "deepseek-v4-thinking-tools"])
      .default("generic-openai"),
  })
  .strict();

export type OpenAICompatibleAgentProviderConfig = z.infer<typeof providerConfigSchema>;

export interface OpenAICompatibleAgentRuntimeOptions {
  fetch?: FetchFunction;
}

export function createOpenAICompatibleAgentModel(
  config: unknown,
  runtime: OpenAICompatibleAgentRuntimeOptions = {},
): LanguageModel {
  const parsed = providerConfigSchema.parse(config);
  const provider = createOpenAICompatible({
    name: parsed.name,
    baseURL: parsed.baseURL,
    apiKey: parsed.apiKey,
    headers: parsed.headers,
    includeUsage: parsed.includeUsage,
    fetch: runtime.fetch,
    transformRequestBody: parsed.compatibilityMode === "deepseek-v4-thinking-tools"
      ? normalizeDeepSeekV4ThinkingToolRequest
      : undefined,
  });
  return provider.chatModel(parsed.modelId);
}

/**
 * DeepSeek V4思考模式的Tool续轮协议与通用OpenAI兼容格式有两个差异：
 * 不接受tool_choice，并要求带tool_calls的assistant消息保留非null content。
 * 变换只对显式启用思考的专用模型生效，避免污染其他OpenAI兼容Provider。
 */
function normalizeDeepSeekV4ThinkingToolRequest(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const thinking = args.thinking;
  if (!isRecord(thinking) || thinking.type !== "enabled") return args;

  const normalized = { ...args };
  delete normalized.tool_choice;
  if (Array.isArray(args.messages)) {
    normalized.messages = args.messages.map((message) => {
      if (!isRecord(message)
        || message.role !== "assistant"
        || !Array.isArray(message.tool_calls)
        || message.tool_calls.length === 0
        || message.content !== null) {
        return message;
      }
      return { ...message, content: "" };
    });
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const agentProviderTesting = {
  normalizeDeepSeekV4ThinkingToolRequest,
};
