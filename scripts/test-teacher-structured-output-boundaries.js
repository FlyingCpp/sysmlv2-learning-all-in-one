'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const files = {
  rules: read('AI_TEACHER_ARCHITECTURE.md'),
  runtime: read('apps/teacher/agent/agent-runtime.mts'),
  main: read('apps/teacher/agent/intent-orchestrator-v2.mts'),
  candidate: read('apps/teacher/agent/candidate-worker.mts'),
  repair: read('apps/teacher/agent/validator-repair-worker.mts'),
  generation: read('apps/teacher/agent/observed-generation.mts'),
  web: read('apps/teacher/deepseek-web-search.js')
};
const combined = Object.values(files).join('\n');

for (const forbidden of ['parseJsonObject', 'parseFeedbackJsonObject', 'parseStructuredObject']) {
  assert(!combined.includes(forbidden), `${forbidden} must not return to an LLM output boundary`);
}
assert(!/只输出(?:一个|单个|修复后的)?\s*(?:JSON|json)/u.test(combined),
  'Prompts must not ask models to hand-write JSON');

assert(files.rules.includes('AI Teacher LLM Schema Governance'));
assert(files.rules.includes('当前唯一已确认硬Schema例外是无法由服务端确定性派生、且具有副作用的类型化Tool参数'));
assert(files.generation.includes('Output.object({'));
assert(files.generation.includes('Output.choice({'));
assert(files.generation.includes('tool({'));
assert(!files.generation.includes('extractJsonMiddleware()'));

assert(files.runtime.includes('return await runIntentV2Execution({ options, request, policy })'));
assert(!files.runtime.includes('generateWorkflowObject'));
assert(files.main.includes('generateObservedToolLoopText({'));
for (const toolName of ['request_clarification', 'delegate_candidate', 'delegate_repair']) {
  assert(files.main.includes(toolName), `${toolName} must remain an explicit AI SDK Tool boundary`);
}
assert(files.repair.includes('new ToolLoopAgent({'));
assert(files.repair.includes('submit_candidate_for_validation'));
assert(/inputSchema:\s*z\.object\(\{\s*content:\s*z\.string\(\)\.min\(1\)\.max\(candidateCharLimit\),?\s*\}\)\.strict\(\)/u.test(files.repair),
  'Repair candidate Tool schema must contain only the complete candidate content field');
assert(!files.repair.includes('Output.object'));
assert(!files.repair.includes('generateWorkflowObject'));
assert(!files.web.includes('generateWorkflowObject'));
assert(files.web.includes('JSON.parse(text)'),
  'External HTTP protocol JSON parsing must remain in the deterministic adapter');

for (const retiredPhase of ['teacher_request_plan_proposal', 'repair_alignment_review', 'answer_contract_revision']) {
  assert(!combined.includes(retiredPhase), `${retiredPhase} must remain retired`);
}

console.log('teacher LLM schema governance tests passed');
