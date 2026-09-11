import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const registry = require("../../../../packages/agent-resource-policy/index.js");
const { BOOTSTRAP_MODEL_CONTEXT_WINDOW_TOKENS } = require("../../../../packages/teacher-contract/index.js");

/** 缺省值也消费统一 Catalog 投影，避免直接 Worker 调用和生产入口使用两套策略。 */
export function bootstrapAgentPolicy(keys: readonly string[]): Record<string, unknown> {
  const projection = registry.runtimeProjection(registry.BOOTSTRAP_VALUES).teacher;
  return Object.fromEntries(keys.map((key) => [key,
    key === "contextWindowTokens" ? BOOTSTRAP_MODEL_CONTEXT_WINDOW_TOKENS
      : key === "semanticReviewMaxIssues" ? 8
        : projection[`agent${key[0]!.toUpperCase()}${key.slice(1)}`],
  ]));
}
