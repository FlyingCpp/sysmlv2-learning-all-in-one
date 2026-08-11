import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

export interface ModelCallAuditEntry {
  runId: string;
  callId: string;
  phase: string;
  stepNumber: number;
  provider: string;
  modelId: string;
  promptVersion: string;
  status: "succeeded" | "failed";
  parserStatus: "ai_sdk_parsed" | "schema_valid" | "not_applicable" | "failed";
  inputPayload: unknown;
  outputPayload: unknown;
  inputHash: string;
  outputHash: string;
  finishReason: string;
  errorCategory: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
  startedAt: string;
  completedAt: string;
}

interface ModelCallAuditContext {
  runId: string;
  promptVersion: string;
  record(entry: ModelCallAuditEntry): Promise<void> | void;
  failures: string[];
}

const storage = new AsyncLocalStorage<ModelCallAuditContext>();

const SECRET_KEYS = new Set([
  "authorization",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "password",
  "secret",
  "clientsecret",
  "cookie",
  "setcookie",
]);

const REASONING_KEYS = new Set([
  "reasoning",
  "reasoningcontent",
  "reasoningtext",
  "chainofthought",
]);

export async function withModelCallAuditContext<T>(
  context: Omit<ModelCallAuditContext, "failures">,
  operation: () => Promise<T>,
): Promise<{ value: T; failures: string[] }> {
  const active: ModelCallAuditContext = { ...context, failures: [] };
  const value = await storage.run(active, operation);
  return { value, failures: [...active.failures] };
}

export async function recordModelGeneration(input: {
  phase: string;
  promptVersion?: string;
  request: unknown;
  steps?: readonly unknown[];
  providerCalls?: readonly Readonly<{
    callId: string;
    request?: unknown;
    startedAt: string;
    completedAt?: string;
  }>[];
  providerRequests?: ReadonlyMap<string, unknown>;
  providerTimings?: ReadonlyMap<string, Readonly<{
    startedAt: string;
    completedAt?: string;
  }>>;
  parserStatus?: ModelCallAuditEntry["parserStatus"];
  error?: unknown;
  startedAt: string;
  completedAt?: string;
}): Promise<void> {
  const context = storage.getStore();
  if (!context) return;
  try {
    const completedAt = input.completedAt ?? new Date().toISOString();
    const baseRequest = sanitizeAuditValue(input.request);
    const steps = Array.isArray(input.steps) && input.steps.length > 0
      ? input.steps
      : [undefined];
    // AI SDK同一次generateText ToolLoop会在多个Provider Step中复用同一个callId，
    // StepResult也不提供逐Step唯一ID。因此以SDK回调发生顺序映射，并为审计行派生
    // 唯一Step后缀；这是观测ID，不是业务对象或外部Registry。
    const orderedCallIds = [...new Set([
      ...(input.providerRequests?.keys() ?? []),
      ...(input.providerTimings?.keys() ?? []),
    ])];
    for (const [index, rawStep] of steps.entries()) {
      const step = isRecord(rawStep) ? rawStep : {};
      const providerCall = input.providerCalls?.[index];
      const providerCallId = providerCall?.callId
        ?? (typeof step.callId === "string" ? step.callId : orderedCallIds[index]);
      const providerRequest = providerCall?.request ?? (providerCallId
        ? input.providerRequests?.get(providerCallId)
        : undefined);
      const providerTiming = providerCall ?? (providerCallId
        ? input.providerTimings?.get(providerCallId)
        : undefined);
      const auditCallId = providerCallId && (input.providerCalls?.length ?? 0) > 1
        ? `${providerCallId}/step-${index}`
        : providerCallId;
      const requestPayload = sanitizeAuditValue({
        configured: baseRequest,
        messages: isRecord(providerRequest)
          ? providerRequest.messages
          : isRecord(step.request) ? step.request.messages : undefined,
        body: isRecord(step.request) ? step.request.body : undefined,
      });
      const outputPayload = sanitizeAuditValue({
        visibleText: typeof step.text === "string" ? step.text : "",
        toolCalls: Array.isArray(step.toolCalls) ? step.toolCalls : [],
        responseMessages: isRecord(step.response) ? step.response.messages : undefined,
        responseBody: isRecord(step.response) ? step.response.body : undefined,
      });
      const usage = normalizedUsage(step.usage);
      const entry: ModelCallAuditEntry = {
        runId: context.runId,
        callId: safeIdentifier(auditCallId ?? `call_${randomUUID()}`, 160),
        phase: safeIdentifier(input.phase || "unclassified_model_call", 80),
        stepNumber: nonNegativeInteger(step.stepNumber, index),
        provider: safeIdentifier(
          isRecord(step.model) ? step.model.provider : isRecord(providerRequest) ? providerRequest.provider : "",
          80,
        ),
        modelId: safeIdentifier(
          isRecord(step.model) ? step.model.modelId : isRecord(providerRequest) ? providerRequest.modelId : "",
          200,
        ),
        promptVersion: safeIdentifier(input.promptVersion || context.promptVersion, 160),
        status: input.error ? "failed" : "succeeded",
        parserStatus: input.error ? "failed" : (input.parserStatus ?? "not_applicable"),
        inputPayload: requestPayload,
        outputPayload,
        inputHash: hashAuditValue(requestPayload),
        outputHash: hashAuditValue(outputPayload),
        finishReason: safeIdentifier(typeof step.finishReason === "string" ? step.finishReason : input.error ? "error" : "", 80),
        errorCategory: input.error ? safeIdentifier(errorCategory(input.error), 120) : "",
        usage,
        startedAt: providerTiming?.startedAt ?? input.startedAt,
        completedAt: providerTiming?.completedAt ?? completedAt,
      };
      try {
        await context.record(entry);
      } catch (error) {
        context.failures.push(errorCategory(error));
      }
    }
  } catch (error) {
    context.failures.push(errorCategory(error));
  }
}

export function sanitizeAuditValue(value: unknown): unknown {
  return sanitizeValue(value, new WeakSet<object>());
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return { byteLength: value.byteLength, omitted: "binary" };
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (isRecord(item) && isReasoningPart(item)) return [];
      const sanitized = sanitizeValue(item, seen);
      return sanitized === undefined ? [] : [sanitized];
    });
  }
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
    if (SECRET_KEYS.has(normalized) || REASONING_KEYS.has(normalized)) continue;
    if (isRecord(item) && isReasoningPart(item)) continue;
    const sanitized = sanitizeValue(item, seen);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  seen.delete(value);
  return output;
}

function isReasoningPart(value: Record<string, unknown>): boolean {
  return typeof value.type === "string" && /^reasoning(?:-|$)/iu.test(value.type);
}

function normalizedUsage(value: unknown): ModelCallAuditEntry["usage"] {
  const usage = isRecord(value) ? value : {};
  const details = isRecord(usage.outputTokenDetails) ? usage.outputTokenDetails : {};
  const inputTokens = nonNegativeInteger(usage.inputTokens ?? usage.promptTokens, 0);
  const outputTokens = nonNegativeInteger(usage.outputTokens ?? usage.completionTokens, 0);
  const reasoningTokens = nonNegativeInteger(usage.reasoningTokens ?? details.reasoningTokens, 0);
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: nonNegativeInteger(usage.totalTokens, inputTokens + outputTokens),
  };
}

function hashAuditValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex")}`;
}

function safeIdentifier(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/[^\p{L}\p{N}:._/-]/gu, "_").slice(0, maxLength);
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function errorCategory(error: unknown): string {
  if (error instanceof Error) return `${error.name}:${error.message}`.slice(0, 240);
  return String(error ?? "unknown_error").slice(0, 240);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
