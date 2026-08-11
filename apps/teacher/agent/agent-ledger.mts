import type { ToolLedgerEntry, ToolName, ValidatorObservation } from "./types.mjs";

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function toCanonicalJson(value: unknown): CanonicalJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Tool arguments must contain finite numbers");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toCanonicalJson);
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const canonical: { [key: string]: CanonicalJson } = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item !== undefined) {
        canonical[key] = toCanonicalJson(item);
      }
    }
    return canonical;
  }
  throw new TypeError("Tool arguments must be JSON-compatible");
}

export function canonicalizeToolArguments(value: unknown): string {
  return JSON.stringify(toCanonicalJson(value));
}

export async function hashCanonicalValue(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeToolArguments(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

function errorDetails(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "UnknownError", message: String(error) };
}

function abortStatus(signal: AbortSignal | undefined): "cancelled" | "timed_out" | undefined {
  if (!signal?.aborted) {
    return undefined;
  }
  const reason = signal.reason;
  return reason instanceof DOMException && reason.name === "TimeoutError"
    ? "timed_out"
    : "cancelled";
}

interface InternalEntry {
  record: ToolLedgerEntry;
  promise: Promise<unknown>;
}

export class ToolCallConflictError extends Error {
  constructor(toolCallId: string) {
    super(`toolCallId ${toolCallId} was reused with different canonical arguments`);
    this.name = "ToolCallConflictError";
  }
}

export class ToolBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolBudgetExceededError";
  }
}

export interface ToolExecutionLedgerOptions {
  scopeKey?: string;
  maxExecutions?: number;
  maxExecutionsPerTool?: Partial<Record<ToolName, number>>;
}

export class ToolExecutionLedger {
  readonly #entries = new Map<string, InternalEntry>();
  readonly #semanticEntries = new Map<string, InternalEntry>();
  readonly #maxExecutions: number;
  readonly #maxExecutionsPerTool: Partial<Record<ToolName, number>>;
  readonly #toolCounts = new Map<ToolName, number>();
  readonly #executionContexts = new Map<string, NonNullable<ToolLedgerEntry["executionContext"]>>();
  readonly scopeKey: string;
  #sequence = 0;

  bindExecutionContext(
    toolCallId: string,
    context: NonNullable<ToolLedgerEntry["executionContext"]>,
  ): void {
    const frozen = Object.freeze({ ...context });
    this.#executionContexts.set(toolCallId, frozen);
    const existing = this.#entries.get(toolCallId);
    if (existing) existing.record.executionContext = frozen;
  }

  appendValidatorObservations(
    toolCallId: string,
    observations: readonly Readonly<ValidatorObservation>[],
  ): void {
    const existing = this.#entries.get(toolCallId);
    if (!existing || existing.record.toolName !== "validate_candidate_workspace") return;
    const combined = [
      ...(existing.record.validatorObservations ?? []),
      ...observations,
    ].slice(0, 2).map((item) => Object.freeze({ ...item }));
    existing.record.validatorObservations = Object.freeze(combined);
  }

  constructor(options: ToolExecutionLedgerOptions = {}) {
    this.scopeKey = options.scopeKey ?? "unscoped";
    this.#maxExecutions = options.maxExecutions ?? Number.POSITIVE_INFINITY;
    this.#maxExecutionsPerTool = options.maxExecutionsPerTool ?? {};
  }

  async execute<OUTPUT>(args: {
    toolCallId: string;
    toolName: ToolName;
    input: unknown;
    abortSignal?: AbortSignal;
    replayedFromRunId?: string;
    operation: () => Promise<OUTPUT>;
  }): Promise<OUTPUT> {
    const canonicalArgs = canonicalizeToolArguments(args.input);
    const argsHash = await hashCanonicalValue(args.input);
    const existing = this.#entries.get(args.toolCallId);
    if (existing) {
      if (
        existing.record.toolName !== args.toolName ||
        existing.record.canonicalArgs !== canonicalArgs
      ) {
        throw new ToolCallConflictError(args.toolCallId);
      }
      existing.record.replayCount += 1;
      return (await existing.promise) as OUTPUT;
    }

    const semanticKey = `${this.scopeKey}:${args.toolName}:${argsHash}`;
    const semanticExisting = this.#semanticEntries.get(semanticKey);
    if (semanticExisting && !["failed", "cancelled", "timed_out"].includes(semanticExisting.record.status)) {
      if (this.#entries.size >= this.#maxExecutions) {
        throw new ToolBudgetExceededError(`Agent tool call budget exceeded (${this.#maxExecutions})`);
      }
      const toolCount = this.#toolCounts.get(args.toolName) ?? 0;
      const toolLimit = this.#maxExecutionsPerTool[args.toolName] ?? Number.POSITIVE_INFINITY;
      if (toolCount >= toolLimit) {
        throw new ToolBudgetExceededError(`Agent tool budget exceeded for ${args.toolName} (${toolLimit})`);
      }
      semanticExisting.record.replayCount += 1;
      const record: ToolLedgerEntry = {
        sequence: this.#sequence,
        toolCallId: args.toolCallId,
        toolName: args.toolName,
        canonicalArgs,
        argsHash,
        status: "running",
        replayCount: 1,
        executionContext: this.#executionContexts.get(args.toolCallId),
        startedAt: new Date().toISOString(),
      };
      this.#sequence += 1;
      const promise = (async (): Promise<OUTPUT> => {
        try {
          const output = (await semanticExisting.promise) as OUTPUT;
          record.status = "succeeded";
          record.output = output;
          return output;
        } catch (error) {
          record.status = abortStatus(args.abortSignal) ?? "failed";
          record.error = errorDetails(error);
          throw error;
        } finally {
          record.finishedAt = new Date().toISOString();
        }
      })();
      this.#entries.set(args.toolCallId, { record, promise });
      this.#toolCounts.set(args.toolName, toolCount + 1);
      return await promise;
    }

    if (this.#entries.size >= this.#maxExecutions) {
      throw new ToolBudgetExceededError(`Agent tool call budget exceeded (${this.#maxExecutions})`);
    }
    const toolCount = this.#toolCounts.get(args.toolName) ?? 0;
    const toolLimit = this.#maxExecutionsPerTool[args.toolName] ?? Number.POSITIVE_INFINITY;
    if (toolCount >= toolLimit) {
      throw new ToolBudgetExceededError(`Agent tool budget exceeded for ${args.toolName} (${toolLimit})`);
    }

    const record: ToolLedgerEntry = {
      sequence: this.#sequence,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      canonicalArgs,
      argsHash,
      status: "running",
      replayCount: 0,
      ...(args.replayedFromRunId ? { replayedFromRunId: args.replayedFromRunId } : {}),
      executionContext: this.#executionContexts.get(args.toolCallId),
      startedAt: new Date().toISOString(),
    };
    this.#sequence += 1;

    const promise = (async (): Promise<OUTPUT> => {
      try {
        args.abortSignal?.throwIfAborted();
        const output = await raceWithAbort(args.operation(), args.abortSignal);
        args.abortSignal?.throwIfAborted();
        record.status = "succeeded";
        record.output = output;
        return output;
      } catch (error) {
        record.status = abortStatus(args.abortSignal) ?? "failed";
        record.error = errorDetails(error);
        throw error;
      } finally {
        record.finishedAt = new Date().toISOString();
      }
    })();

    this.#entries.set(args.toolCallId, { record, promise });
    this.#semanticEntries.set(semanticKey, { record, promise });
    this.#toolCounts.set(args.toolName, toolCount + 1);
    return await promise;
  }

  async recordObservation(args: {
    toolCallId: string;
    toolName: ToolName;
    input: unknown;
    output: unknown;
    replayedFromRunId?: string;
  }): Promise<void> {
    const canonicalArgs = canonicalizeToolArguments(args.input);
    const argsHash = await hashCanonicalValue(args.input);
    const existing = this.#entries.get(args.toolCallId);
    if (existing) {
      if (existing.record.toolName !== args.toolName || existing.record.canonicalArgs !== canonicalArgs) {
        throw new ToolCallConflictError(args.toolCallId);
      }
      existing.record.replayCount += 1;
      return;
    }
    if (this.#entries.size >= this.#maxExecutions) {
      throw new ToolBudgetExceededError(`Agent tool call budget exceeded (${this.#maxExecutions})`);
    }
    const toolCount = this.#toolCounts.get(args.toolName) ?? 0;
    const toolLimit = this.#maxExecutionsPerTool[args.toolName] ?? Number.POSITIVE_INFINITY;
    if (toolCount >= toolLimit) {
      throw new ToolBudgetExceededError(`Agent tool budget exceeded for ${args.toolName} (${toolLimit})`);
    }
    const timestamp = new Date().toISOString();
    const record: ToolLedgerEntry = {
      sequence: this.#sequence,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      canonicalArgs,
      argsHash,
      status: "succeeded",
      replayCount: 0,
      ...(args.replayedFromRunId ? { replayedFromRunId: args.replayedFromRunId } : {}),
      executionContext: this.#executionContexts.get(args.toolCallId),
      startedAt: timestamp,
      finishedAt: timestamp,
      output: args.output,
    };
    this.#sequence += 1;
    this.#entries.set(args.toolCallId, { record, promise: Promise.resolve(args.output) });
    this.#toolCounts.set(args.toolName, toolCount + 1);
  }

  snapshot(): ToolLedgerEntry[] {
    return [...this.#entries.values()]
      .map(({ record }) => ({
        ...record,
        ...(record.validatorObservations
          ? { validatorObservations: Object.freeze(record.validatorObservations.map((item) => Object.freeze({ ...item }))) }
          : {}),
      }))
      .sort((left, right) => left.sequence - right.sequence);
  }
}

async function raceWithAbort<OUTPUT>(
  operation: Promise<OUTPUT>,
  signal: AbortSignal | undefined,
): Promise<OUTPUT> {
  if (!signal) {
    return await operation;
  }
  signal.throwIfAborted();
  return await new Promise<OUTPUT>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
