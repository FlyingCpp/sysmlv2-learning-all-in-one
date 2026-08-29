'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { generateText, stepCountIs, tool } = require('ai');
const { z } = require('zod');
const { findModelProtocolProfile } = require('../apps/api/llm-adapter-catalog');

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function completion(message, finishReason, usage = {}) {
  return {
    id: `chatcmpl_${Math.random().toString(16).slice(2)}`,
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-v4-flash',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: usage.promptTokens || 10,
      completion_tokens: usage.completionTokens || 6,
      total_tokens: (usage.promptTokens || 10) + (usage.completionTokens || 6),
      completion_tokens_details: { reasoning_tokens: usage.reasoningTokens || 2 }
    }
  };
}

async function main() {
  const providerModulePath = path.resolve(
    __dirname,
    '../apps/teacher/dist/agent/agent-provider.mjs'
  );
  const {
    agentProviderTesting,
    createOpenAICompatibleAgentModel
  } = await import(pathToFileURL(providerModulePath).href);
  const { v2GenerationSettings, v2RepairGenerationSettings } = await import(pathToFileURL(path.resolve(
    __dirname,
    '../apps/teacher/dist/agent/intent-orchestrator-v2.mjs'
  )).href);

  const thinkingBodies = [];
  let thinkingCall = 0;
  const thinkingModel = createOpenAICompatibleAgentModel({
    name: 'wiredeepseek',
    baseURL: 'https://provider.invalid/v1',
    modelId: 'deepseek-v4-flash',
    apiKey: 'test-key',
    compatibilityMode: 'gateway-thinking-tools-non-null-content'
  }, {
    fetch: async (_url, init) => {
      thinkingBodies.push(JSON.parse(String(init.body)));
      thinkingCall += 1;
      if (thinkingCall === 1) {
        return jsonResponse(completion({
          role: 'assistant',
          content: null,
          reasoning_content: 'I need the reviewed fact.',
          tool_calls: [{
            id: 'call_wire_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":"constraint"}' }
          }]
        }, 'tool_calls'));
      }
      return jsonResponse(completion({
        role: 'assistant',
        content: '基于工具结果作答。',
        reasoning_content: 'The tool result is sufficient.'
      }, 'stop'));
    }
  });

  const thinkingResult = await generateText({
    model: thinkingModel,
    prompt: 'Explain the constraint.',
    tools: {
      lookup: tool({
        description: 'Read a reviewed fact.',
        inputSchema: z.object({ query: z.string() }).strict(),
        execute: async () => ({ statement: 'asserted constraints must hold' })
      })
    },
    toolChoice: 'auto',
    stopWhen: stepCountIs(2),
    maxRetries: 0,
    reasoning: 'high',
    providerOptions: {
      wiredeepseek: {
        thinking: { type: 'enabled' },
        reasoningEffort: 'high',
        parallel_tool_calls: false
      }
    }
  });

  assert.equal(thinkingResult.text, '基于工具结果作答。');
  assert.equal(thinkingBodies.length, 2);
  for (const body of thinkingBodies) {
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.parallel_tool_calls, false);
    assert.equal(Object.hasOwn(body, 'tool_choice'), false,
      'DeepSeek V4 thinking+tools wire request must omit tool_choice');
  }
  const continuedAssistant = thinkingBodies[1].messages.find((message) => (
    message.role === 'assistant' && Array.isArray(message.tool_calls)
  ));
  assert(continuedAssistant, 'continuation request must preserve the assistant tool-call turn');
  assert.equal(continuedAssistant.content, '',
    'DeepSeek V4 assistant tool-call turn must carry non-null content');
  assert.equal(continuedAssistant.reasoning_content, 'I need the reviewed fact.',
    'DeepSeek V4 continuation must replay reasoning_content');

  const disabledBodies = [];
  const disabledModel = createOpenAICompatibleAgentModel({
    name: 'wiredisabled',
    baseURL: 'https://provider.invalid/v1',
    modelId: 'deepseek-v4-flash',
    apiKey: 'test-key',
    compatibilityMode: 'generic-openai'
  }, {
    fetch: async (_url, init) => {
      disabledBodies.push(JSON.parse(String(init.body)));
      return jsonResponse(completion({ role: 'assistant', content: '直接回答。' }, 'stop'));
    }
  });
  await generateText({
    model: disabledModel,
    prompt: 'Answer directly.',
    maxRetries: 0,
    reasoning: 'none',
    providerOptions: {
      wiredisabled: {
        thinking: { type: 'disabled' }
      }
    },
    tools: {
      lookup: tool({
        description: 'Unused read tool.',
        inputSchema: z.object({ query: z.string() }).strict()
      })
    },
    toolChoice: 'auto'
  });
  assert.deepEqual(disabledBodies[0].thinking, { type: 'disabled' });
  assert.equal(Object.hasOwn(disabledBodies[0], 'extra_body'), false,
    'direct OpenAI-compatible wire request must not send the Python SDK extra_body wrapper');
  assert.equal(disabledBodies[0].tool_choice, 'auto',
    'disabled/generic control must preserve the standard tool_choice field');

  const disabledControl = {
    thinking: { type: 'disabled' },
    tool_choice: 'auto',
    messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_control' }] }]
  };
  assert.strictEqual(
    agentProviderTesting.normalizeThinkingToolRequest(disabledControl),
    disabledControl,
    'the DeepSeek compatibility transform must not mutate disabled-thinking requests'
  );

  const liteLlmBodies = [];
  const liteLlmModel = createOpenAICompatibleAgentModel({
    name: 'wirelitellm',
    baseURL: 'https://gateway.invalid/v1',
    modelId: 'ai-teacher-reasoning-passthrough',
    apiKey: 'test-key',
    compatibilityMode: 'generic-openai'
  }, {
    fetch: async (_url, init) => {
      liteLlmBodies.push(JSON.parse(String(init.body)));
      return jsonResponse(completion({ role: 'assistant', content: 'OK' }, 'stop'));
    }
  });
  await generateText({
    model: liteLlmModel,
    prompt: 'Answer directly.',
    maxRetries: 0,
    reasoning: 'none',
    providerOptions: {
      wirelitellm: {
        extra_body: { thinking: { type: 'disabled' } },
        parallel_tool_calls: false
      }
    }
  });
  assert.deepEqual(liteLlmBodies[0].extra_body, { thinking: { type: 'disabled' } },
    'LiteLLM passthrough wire must preserve the Python client extra_body envelope');
  assert.equal(Object.hasOwn(liteLlmBodies[0], 'thinking'), false,
    'LiteLLM passthrough wire must not send direct DeepSeek thinking at the proxy boundary');

  const glmBodies = [];
  const glmModel = createOpenAICompatibleAgentModel({
    name: 'wireglm',
    baseURL: 'https://gateway.invalid/v1',
    modelId: 'ai-teacher-glm-model',
    apiKey: 'test-key',
    compatibilityMode: 'generic-openai'
  }, {
    fetch: async (_url, init) => {
      glmBodies.push(JSON.parse(String(init.body)));
      return jsonResponse(completion({ role: 'assistant', content: 'GLM OK' }, 'stop'));
    }
  });
  const glmSettings = v2GenerationSettings({
    model: glmModel,
    request: {},
    dependencies: {},
    reasoningMode: 'adaptive',
    providerOptionsName: 'wireglm',
    providerCompatibility: 'deepseek-v4-litellm',
    stageProtocolProfiles: {
      main: {
        protocolMode: 'gateway-chat-v1',
        executionPolicy: findModelProtocolProfile('zai-glm.v1', 'glm-5.2').executionPolicy
      }
    }
  }, false, 'main');
  await generateText({
    model: glmModel,
    prompt: 'Use the published stage protocol.',
    maxRetries: 0,
    reasoning: glmSettings.reasoning,
    providerOptions: glmSettings.providerOptions,
    tools: {
      lookup: tool({
        description: 'Unused read tool.',
        inputSchema: z.object({ query: z.string() }).strict()
      })
    },
    toolChoice: glmSettings.explicitToolChoice ? 'auto' : undefined
  });
  assert.deepEqual(glmBodies[0].extra_body, {
    thinking: { type: 'enabled', clear_thinking: false }
  });
  assert.equal(glmBodies[0].reasoning_effort, 'high');
  assert.deepEqual(glmBodies[0].allowed_openai_params, ['reasoning_effort']);
  assert.equal(glmBodies[0].tool_choice, 'auto');
  assert.equal(Object.hasOwn(glmBodies[0], 'parallel_tool_calls'), false,
    'GLM 5.2 wire request must omit the ZAI-unsupported parallel_tool_calls field');

  const glm53Policy = findModelProtocolProfile('zai-glm.v1', 'glm-5.3-flash').executionPolicy;
  assert.throws(() => v2GenerationSettings({
    model: glmModel,
    request: {},
    dependencies: {},
    reasoningMode: 'disabled',
    providerOptionsName: 'wireglm',
    stageProtocolProfiles: { main: { protocolMode: 'gateway-chat-v1', executionPolicy: glm53Policy } }
  }, true, 'main'), (error) => error?.code === 'AI_TEACHER_REASONING_MODE_UNSUPPORTED',
  'GLM 5.3 standard API must reject a disabled-thinking run before a Provider call');
  const glm53FinalizerSettings = v2GenerationSettings({
    model: glmModel,
    request: {},
    dependencies: {},
    reasoningMode: 'disabled',
    stageReasoningModes: { finalizer: 'provider-managed' },
    providerOptionsName: 'wireglm',
    stageProtocolProfiles: {
      finalizer: { protocolMode: 'gateway-chat-v1', executionPolicy: glm53Policy }
    }
  }, true, 'finalizer');
  assert.equal(glm53FinalizerSettings.reasoning, 'high',
    'an always-thinking GLM finalizer must follow the published stage policy instead of an internal disabled hint');
  assert.deepEqual(glm53FinalizerSettings.providerOptions.wireglm.extra_body, {
    thinking: { type: 'enabled', clear_thinking: false }
  });

  const openAiChatPolicy = findModelProtocolProfile(
    'openai.v1',
    'any-explicit-chat-model',
    'openai-chat.v1'
  ).executionPolicy;
  const openAiChatSettings = v2GenerationSettings({
    model: glmModel,
    request: {},
    dependencies: {},
    reasoningMode: 'adaptive',
    providerOptionsName: 'wireopenai',
    stageProtocolProfiles: { main: { protocolMode: 'gateway-chat-v1', executionPolicy: openAiChatPolicy } }
  }, false, 'main');
  assert.equal(openAiChatSettings.reasoning, 'none',
    'non-reasoning chat profiles must not inherit a synthetic reasoning_effort from the Run mode');
  assert.deepEqual(openAiChatSettings.providerOptions, {});
  assert.throws(() => v2RepairGenerationSettings({
    model: glmModel,
    request: {},
    dependencies: {},
    reasoningMode: 'adaptive',
    providerOptionsName: 'wireopenai',
    stageProtocolProfiles: { repair: { protocolMode: 'gateway-chat-v1', executionPolicy: openAiChatPolicy } }
  }), (error) => error?.code === 'AI_TEACHER_REPAIR_REASONING_UNSUPPORTED');

  console.log('teacher provider wire contract tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
