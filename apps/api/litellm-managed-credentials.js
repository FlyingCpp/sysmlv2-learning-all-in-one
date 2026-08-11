'use strict';

const crypto = require('crypto');

const CREDENTIAL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,119}$/;

function managedCredentialRuntime(options = {}) {
  const env = options.env || process.env;
  const baseUrl = String(options.baseUrl || env.LITELLM_ADMIN_BASE_URL || '').trim().replace(/\/$/, '');
  const masterKey = String(options.masterKey || env.LITELLM_MASTER_KEY || '');
  const fetchImpl = options.fetchImpl || global.fetch;
  if (!baseUrl || !masterKey || typeof fetchImpl !== 'function') {
    throw managedCredentialError('LITELLM_CREDENTIAL_STORE_NOT_CONFIGURED', 'LiteLLM managed credential storage is not configured.', 503);
  }
  return { baseUrl, masterKey, fetchImpl };
}

function normalizeCredentialName(value) {
  const credentialName = String(value || '').trim();
  if (!CREDENTIAL_NAME_PATTERN.test(credentialName)) {
    throw managedCredentialError('LITELLM_CREDENTIAL_NAME_INVALID', 'Credential name is invalid.', 400);
  }
  return credentialName;
}

async function listManagedCredentials(options = {}) {
  const payload = await adminJsonRequest('/credentials', { ...options, method: 'GET' });
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.credentials) ? payload.credentials : [];
  return rows.map(publicCredential).filter(Boolean).sort((left, right) => left.credentialName.localeCompare(right.credentialName));
}

async function writeManagedCredential(input = {}, options = {}) {
  const credentialName = normalizeCredentialName(input.credentialName);
  const apiKey = String(input.apiKey || '');
  if (!apiKey || apiKey.length > 8192) {
    throw managedCredentialError('LITELLM_CREDENTIAL_VALUE_INVALID', 'A non-empty provider API key is required.', 400);
  }
  const provider = String(input.provider || '').trim().slice(0, 80);
  const existing = await listManagedCredentials(options);
  const exists = existing.some((item) => item.credentialName === credentialName);
  const path = exists ? `/credentials/${encodeURIComponent(credentialName)}` : '/credentials';
  await adminJsonRequest(path, {
    ...options,
    method: exists ? 'PATCH' : 'POST',
    body: {
      credential_name: credentialName,
      credential_values: { api_key: apiKey },
      credential_info: {
        provider,
        managed_by: 'sysmlv2-admin',
        rotated_at: new Date().toISOString()
      }
    }
  });
  return { credentialName, provider, configured: true };
}

async function deleteManagedCredential(credentialName, options = {}) {
  const normalized = normalizeCredentialName(credentialName);
  await adminJsonRequest(`/credentials/${encodeURIComponent(normalized)}`, { ...options, method: 'DELETE' });
  return { credentialName: normalized, deleted: true };
}

async function testManagedCredentialConnection(input = {}, options = {}) {
  const credentialName = normalizeCredentialName(input.credentialName);
  const model = String(input.model || '').trim();
  const apiBase = String(input.apiBase || '').trim();
  if (!model || !apiBase) throw managedCredentialError('LITELLM_CREDENTIAL_TEST_INPUT_INVALID', 'Model and API base URL are required.', 400);
  const payload = await adminJsonRequest('/health/test_connection', {
    ...options,
    method: 'POST',
    body: {
      mode: 'chat',
      litellm_params: {
        model,
        api_base: apiBase,
        litellm_credential_name: credentialName,
        max_tokens: 8
      },
      model_info: { id: `credential-test-${crypto.randomUUID()}` }
    }
  });
  return { status: payload?.success === false ? 'blocked' : 'passed' };
}

async function createManagedProbeModel(input = {}, options = {}) {
  const credentialName = normalizeCredentialName(input.credentialName);
  const providerModel = String(input.providerModel || '').trim();
  const apiBase = String(input.apiBase || '').trim();
  if (!providerModel || !apiBase) throw managedCredentialError('LITELLM_PROBE_MODEL_INPUT_INVALID', 'Provider model and API base URL are required.', 400);
  const alias = `sysml-probe-${crypto.randomUUID()}`;
  const modelId = crypto.randomUUID();
  await adminJsonRequest('/model/new', {
    ...options,
    method: 'POST',
    body: {
      model_name: alias,
      litellm_params: {
        model: providerModel,
        api_base: apiBase,
        litellm_credential_name: credentialName
      },
      model_info: {
        id: modelId,
        mode: 'chat',
        access_group: 'sysmlv2-capability-probe'
      }
    }
  });
  return { alias, modelId };
}

async function deleteManagedProbeModel(modelId, options = {}) {
  const id = String(modelId || '').trim();
  if (!id) return;
  await adminJsonRequest('/model/delete', { ...options, method: 'POST', body: { id } });
}

async function managedChatCompletion(input = {}, options = {}) {
  const alias = String(input.alias || '').trim();
  if (!alias) throw managedCredentialError('LITELLM_PROBE_ALIAS_REQUIRED', 'Managed probe alias is required.', 500);
  return adminJsonRequest('/v1/chat/completions', {
    ...options,
    method: 'POST',
    signal: input.signal,
    body: { ...(input.body || {}), model: alias }
  });
}

async function managedProxyRequest(input = {}, options = {}) {
  const alias = String(input.alias || '').trim();
  if (!alias) throw managedCredentialError('LITELLM_PROBE_ALIAS_REQUIRED', 'Managed probe alias is required.', 500);
  const runtime = managedCredentialRuntime(options);
  return runtime.fetchImpl(`${runtime.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${runtime.masterKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ ...(input.body || {}), model: alias }),
    signal: input.signal,
    redirect: 'error'
  });
}

async function adminJsonRequest(path, options = {}) {
  const runtime = managedCredentialRuntime(options);
  const response = await runtime.fetchImpl(`${runtime.baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${runtime.masterKey}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw managedCredentialError('LITELLM_ADMIN_REQUEST_FAILED', `LiteLLM admin request failed with HTTP ${response.status}.`, response.status >= 500 ? 502 : 400);
  }
  return payload;
}

function publicCredential(row) {
  const credentialName = String(row?.credential_name || row?.credentialName || '').trim();
  if (!credentialName) return null;
  const info = row?.credential_info && typeof row.credential_info === 'object' ? row.credential_info : {};
  return {
    credentialName,
    provider: String(info.provider || '').slice(0, 80),
    configured: true,
    rotatedAt: safeIsoString(info.rotated_at)
  };
}

function safeIsoString(value) {
  const date = new Date(String(value || ''));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function managedCredentialError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.statusCode = status;
  return error;
}

module.exports = {
  normalizeCredentialName,
  listManagedCredentials,
  writeManagedCredential,
  deleteManagedCredential,
  testManagedCredentialConnection,
  createManagedProbeModel,
  deleteManagedProbeModel,
  managedChatCompletion,
  managedProxyRequest
};
