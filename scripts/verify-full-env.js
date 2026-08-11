'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const envPath = path.resolve(root, process.env.SYNFELD_ENV_FILE || '.env');
const values = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {};
const required = [
  'AUTH_DB_PASSWORD',
  'TEACHER_DB_PASSWORD',
  'LITELLM_DB_PASSWORD',
  'BETTER_AUTH_SECRET',
  'AI_TEACHER_INTERNAL_TOKEN',
  'AI_TEACHER_TOOL_TOKEN',
  'LITELLM_MASTER_KEY',
  'LITELLM_SALT_KEY',
  'PROVIDER_API_BASE',
  'PROVIDER_API_KEY',
  'PROVIDER_MODEL'
];
const errors = [];

for (const name of required) {
  const value = String(process.env[name] || values[name] || '').trim();
  if (!value) errors.push(`${name} is required`);
  if (/replace-with|change-me|example/i.test(value)) errors.push(`${name} still contains a placeholder`);
}

for (const name of ['BETTER_AUTH_SECRET', 'AI_TEACHER_INTERNAL_TOKEN', 'AI_TEACHER_TOOL_TOKEN', 'LITELLM_MASTER_KEY', 'LITELLM_SALT_KEY']) {
  const value = String(process.env[name] || values[name] || '');
  if (value && value.length < 32) errors.push(`${name} must contain at least 32 characters`);
}

const distinctNames = [
  'AUTH_DB_PASSWORD', 'TEACHER_DB_PASSWORD', 'LITELLM_DB_PASSWORD',
  'BETTER_AUTH_SECRET', 'AI_TEACHER_INTERNAL_TOKEN', 'AI_TEACHER_TOOL_TOKEN',
  'LITELLM_MASTER_KEY', 'LITELLM_SALT_KEY', 'PROVIDER_API_KEY'
];
const distinctValues = distinctNames.map((name) => String(process.env[name] || values[name] || '')).filter(Boolean);
if (new Set(distinctValues).size !== distinctValues.length) {
  errors.push('database passwords, service tokens, master keys, salt, and provider key must be distinct');
}

const providerBase = String(process.env.PROVIDER_API_BASE || values.PROVIDER_API_BASE || '');
if (!/^https:\/\//i.test(providerBase)) errors.push('PROVIDER_API_BASE must use HTTPS');

const activeBundlePolicy = String(
  process.env.AI_TEACHER_REQUIRE_ACTIVE_BUNDLE || values.AI_TEACHER_REQUIRE_ACTIVE_BUNDLE || 'false'
).trim();
if (!/^(true|false)$/i.test(activeBundlePolicy)) {
  errors.push('AI_TEACHER_REQUIRE_ACTIVE_BUNDLE must be true or false');
}

if (errors.length) {
  console.error(JSON.stringify({ status: 'BLOCK', envFilePresent: fs.existsSync(envPath), errors }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: 'PASS',
  envFilePresent: fs.existsSync(envPath),
  configurationSource: fs.existsSync(envPath) ? 'env-file' : 'process-environment',
  requiredValuesPresent: true,
  sensitiveValuesDistinct: true,
  providerTls: true,
  reviewedKnowledgePolicyValid: true
}, null, 2));

function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    result[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/u, '$2');
  }
  return result;
}
