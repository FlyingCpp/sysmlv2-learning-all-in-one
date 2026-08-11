'use strict';

const ADAPTER_PROFILE_CATALOG = Object.freeze([
  {
    profileId: 'deepseek-v4.v1',
    revision: 1,
    displayName: 'DeepSeek V4',
    gatewayProtocol: 'openai-compatible',
    litellmProviderPrefix: 'deepseek',
    endpointPolicy: { schemes: ['https'], defaultPort: 443, recommendedHosts: ['api.deepseek.com'] },
    supportedCapabilities: ['streaming', 'tool_calling', 'thinking', 'thinking_with_tools', 'structured_output', 'usage']
  },
  {
    profileId: 'zai-glm.v1',
    revision: 1,
    displayName: 'Z.AI / 智谱 GLM',
    gatewayProtocol: 'openai-compatible',
    litellmProviderPrefix: 'zai',
    endpointPolicy: { schemes: ['https'], defaultPort: 443, recommendedHosts: ['open.bigmodel.cn', 'api.z.ai'] },
    supportedCapabilities: ['streaming', 'tool_calling', 'thinking', 'thinking_with_tools', 'structured_output', 'usage']
  },
  {
    profileId: 'openai.v1',
    revision: 1,
    displayName: 'OpenAI',
    gatewayProtocol: 'openai-compatible',
    litellmProviderPrefix: 'openai',
    endpointPolicy: { schemes: ['https'], defaultPort: 443, recommendedHosts: ['api.openai.com'] },
    supportedCapabilities: ['streaming', 'tool_calling', 'structured_output', 'vision', 'usage']
  },
  {
    profileId: 'openai-compatible-public.v1',
    revision: 1,
    displayName: 'OpenAI-compatible',
    gatewayProtocol: 'openai-compatible',
    litellmProviderPrefix: 'openai',
    endpointPolicy: { schemes: ['https'], defaultPort: 443, recommendedHosts: [] },
    supportedCapabilities: ['streaming', 'tool_calling', 'structured_output', 'usage']
  },
  {
    profileId: 'anthropic.v1',
    revision: 1,
    displayName: 'Anthropic Messages',
    gatewayProtocol: 'anthropic-messages',
    litellmProviderPrefix: 'anthropic',
    endpointPolicy: { schemes: ['https'], defaultPort: 443, recommendedHosts: ['api.anthropic.com'] },
    supportedCapabilities: ['streaming', 'tool_calling', 'thinking', 'vision', 'usage']
  },
  {
    profileId: 'azure-openai.v1',
    revision: 1,
    displayName: 'Azure OpenAI',
    gatewayProtocol: 'azure-openai',
    litellmProviderPrefix: 'azure',
    endpointPolicy: { schemes: ['https'], defaultPort: 443, recommendedHosts: [] },
    supportedCapabilities: ['streaming', 'tool_calling', 'structured_output', 'vision', 'usage']
  }
]);

const MODEL_PROTOCOL_PROFILE_CATALOG = Object.freeze([
  {
    profileId: 'deepseek-v4-chat.v1',
    revision: 1,
    adapterProfileId: 'deepseek-v4.v1',
    modelIdPattern: /^deepseek-v4-(?:pro|flash)$/i,
    thinking: {
      enabledBody: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
      disabledBody: { thinking: { type: 'disabled' } }
    },
    toolChoice: { nonThinking: 'named', thinking: 'omit' },
    continuation: { reasoningContent: 'required', assistantContent: 'non_null' }
  },
  {
    profileId: 'glm-5.2-chat.v1',
    revision: 2,
    adapterProfileId: 'zai-glm.v1',
    modelIdPattern: /^glm-5\.2$/i,
    litellm: {
      extraBodyParams: ['thinking'],
      allowedOpenAiParams: ['reasoning_effort', 'response_format']
    },
    thinking: {
      enabledBody: { thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: 'high' },
      disabledBody: { thinking: { type: 'disabled' } }
    },
    toolChoice: { nonThinking: 'auto', thinking: 'auto' },
    continuation: { reasoningContent: 'required', assistantContent: 'non_null' }
  }
]);

function findAdapterProfile(profileId) {
  return ADAPTER_PROFILE_CATALOG.find((profile) => profile.profileId === String(profileId || '')) || null;
}

function publicAdapterProfileCatalog() {
  return {
    schemaVersion: 2,
    profiles: ADAPTER_PROFILE_CATALOG,
    modelProtocolProfiles: MODEL_PROTOCOL_PROFILE_CATALOG.map((profile) => ({
      profileId: profile.profileId,
      revision: profile.revision,
      adapterProfileId: profile.adapterProfileId
    }))
  };
}

function findModelProtocolProfile(adapterProfileId, providerModelId) {
  return MODEL_PROTOCOL_PROFILE_CATALOG.find((profile) => profile.adapterProfileId === String(adapterProfileId || '')
    && profile.modelIdPattern.test(String(providerModelId || ''))) || null;
}

module.exports = {
  ADAPTER_PROFILE_CATALOG,
  MODEL_PROTOCOL_PROFILE_CATALOG,
  findAdapterProfile,
  findModelProtocolProfile,
  publicAdapterProfileCatalog
};
