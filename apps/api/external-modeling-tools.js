'use strict';

const SYSON_TOOL_ID = 'syson';

function defaultExternalModelingToolSettings(env = process.env) {
  const serviceConfigured = Boolean(String(env.SYSON_VIEW_SERVICE_URL || '').trim());
  return {
    toolId: SYSON_TOOL_ID,
    enabled: envFlag(env.SYSON_ENABLED, serviceConfigured),
    frontendVisible: envFlag(env.SYSON_FRONTEND_VISIBLE, true),
    modelGenerationEnabled: envFlag(env.SYSON_MODEL_GENERATION_ENABLED, true),
    directWriteEnabled: envFlag(env.SYSON_DIRECT_WRITE_ENABLED, false),
    updatedBy: '',
    updatedAt: null
  };
}

function normalizeExternalModelingToolSettings(settings = {}, defaults = defaultExternalModelingToolSettings()) {
  return {
    toolId: SYSON_TOOL_ID,
    enabled: booleanSetting(settings.enabled, defaults.enabled),
    frontendVisible: booleanSetting(settings.frontendVisible ?? settings.frontend_visible, defaults.frontendVisible),
    modelGenerationEnabled: booleanSetting(
      settings.modelGenerationEnabled ?? settings.model_generation_enabled,
      defaults.modelGenerationEnabled
    ),
    directWriteEnabled: booleanSetting(settings.directWriteEnabled ?? settings.direct_write_enabled, defaults.directWriteEnabled),
    updatedBy: String(settings.updatedBy ?? settings.updated_by ?? defaults.updatedBy ?? ''),
    updatedAt: settings.updatedAt ?? settings.updated_at ?? defaults.updatedAt ?? null
  };
}

function externalModelingToolAdminView(settings = {}, env = process.env, health = null) {
  const desired = normalizeExternalModelingToolSettings(settings, defaultExternalModelingToolSettings(env));
  const effective = effectiveExternalModelingToolSettings(desired, env);
  return {
    toolId: SYSON_TOOL_ID,
    displayName: 'SysON',
    description: 'Eclipse SysON 原生 SysML v2 建模与视图服务。',
    desired: desiredSettingsView(desired),
    effective,
    deployment: {
      serviceConfigured: Boolean(String(env.SYSON_VIEW_SERVICE_URL || '').trim()),
      viewServiceUrl: safeDeploymentUrl(env.SYSON_VIEW_SERVICE_URL),
      graphqlConfigured: Boolean(String(env.SYSON_GRAPHQL_URL || '').trim()),
      graphqlUrl: safeDeploymentUrl(env.SYSON_GRAPHQL_URL),
      frontendProxyPath: '/syson/view',
      directWriteCeilingEnabled: envFlag(env.SYSON_WRITE_PROXY_ENABLED, false)
    },
    health: health || defaultHealth(effective)
  };
}

function publicExternalModelingTools(settings = {}, env = process.env) {
  const effective = effectiveExternalModelingToolSettings(settings, env);
  return {
    tools: [{
      toolId: SYSON_TOOL_ID,
      displayName: 'SysON',
      enabled: effective.enabled,
      frontendVisible: effective.frontendVisible,
      viewServiceUrl: effective.frontendVisible ? '/syson/view' : '',
      capabilities: {
        read: effective.enabled,
        modelGeneration: effective.modelGenerationEnabled,
        directWrite: effective.directWriteEnabled
      }
    }]
  };
}

function effectiveExternalModelingToolSettings(settings = {}, env = process.env) {
  const desired = normalizeExternalModelingToolSettings(settings, defaultExternalModelingToolSettings(env));
  const serviceConfigured = Boolean(String(env.SYSON_VIEW_SERVICE_URL || '').trim());
  const enabled = desired.enabled && serviceConfigured;
  return {
    enabled,
    frontendVisible: enabled && desired.frontendVisible,
    modelGenerationEnabled: enabled && desired.modelGenerationEnabled,
    directWriteEnabled: enabled
      && desired.directWriteEnabled
      && envFlag(env.SYSON_WRITE_PROXY_ENABLED, false)
  };
}

function externalModelingToolAccessAllowed(settings = {}, access = 'read', env = process.env) {
  const effective = effectiveExternalModelingToolSettings(settings, env);
  if (access === 'read') return effective.enabled;
  if (access === 'compute') return effective.modelGenerationEnabled;
  if (access === 'write') return effective.directWriteEnabled;
  return false;
}

function validateExternalModelingToolPatch(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw invalidSettingsError('settings must be an object.');
  }
  const allowed = new Set(['enabled', 'frontendVisible', 'modelGenerationEnabled', 'directWriteEnabled']);
  for (const [key, value] of Object.entries(settings)) {
    if (!allowed.has(key)) throw invalidSettingsError(`Unsupported setting: ${key}`);
    if (typeof value !== 'boolean') throw invalidSettingsError(`${key} must be a boolean.`);
  }
  return settings;
}

function desiredSettingsView(settings = {}) {
  return {
    enabled: settings.enabled === true,
    frontendVisible: settings.frontendVisible === true,
    modelGenerationEnabled: settings.modelGenerationEnabled === true,
    directWriteEnabled: settings.directWriteEnabled === true,
    updatedBy: settings.updatedBy || '',
    updatedAt: settings.updatedAt || null
  };
}

function defaultHealth(effective) {
  return {
    status: effective.enabled ? 'not_checked' : 'disabled',
    checkedAt: null,
    latencyMs: null,
    errorCode: ''
  };
}

function safeDeploymentUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/u, '');
  } catch {
    return '配置无效';
  }
}

function booleanSetting(value, fallback) {
  return value === undefined || value === null ? Boolean(fallback) : Boolean(value);
}

function envFlag(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return !/^(0|false|no|off|disabled)$/iu.test(String(value).trim());
}

function invalidSettingsError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'EXTERNAL_MODELING_TOOL_SETTINGS_INVALID';
  return error;
}

module.exports = {
  SYSON_TOOL_ID,
  defaultExternalModelingToolSettings,
  normalizeExternalModelingToolSettings,
  externalModelingToolAdminView,
  publicExternalModelingTools,
  effectiveExternalModelingToolSettings,
  externalModelingToolAccessAllowed,
  validateExternalModelingToolPatch,
  safeDeploymentUrl
};
