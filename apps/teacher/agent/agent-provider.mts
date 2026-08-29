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
    compatibilityMode: z.enum(["generic-openai", "gateway-thinking-tools-non-null-content"])
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
    transformRequestBody: parsed.compatibilityMode === "gateway-thinking-tools-non-null-content"
      ? normalizeThinkingToolRequest
      : undefined,
  });
  return provider.chatModel(parsed.modelId);
}

/**
 * 该变换由冻结的执行Profile声明，不依赖Provider名称。仅当Profile同时要求
 * Thinking Tool省略tool_choice且assistant content非null时启用。
 */
function normalizeThinkingToolRequest(
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
  normalizeThinkingToolRequest,
};
