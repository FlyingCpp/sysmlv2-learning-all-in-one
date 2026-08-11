import { runIntentV2Execution } from "./intent-v2-execution.mjs";
import {
  DEFAULT_AGENT_POLICY,
  agentPolicyOverrideSchema,
  agentPolicySchema,
  agentRunRequestSchema,
  type AgentRunOutcome,
  type RunTeacherAgentOptions,
} from "./types.mjs";

/** AI Teacher唯一生产执行入口。工作流版本由构建本身确定，不接受运行时切换。 */
export async function runTeacherAgent(options: RunTeacherAgentOptions): Promise<AgentRunOutcome> {
  const request = agentRunRequestSchema.parse(options.request);
  const override = agentPolicyOverrideSchema.parse(options.policy ?? {});
  const policy = agentPolicySchema.parse({ ...DEFAULT_AGENT_POLICY, ...override });
  return await runIntentV2Execution({ options, request, policy });
}
