'use strict';

const fs = require('fs');
const path = require('path');

function createAppRegistry(options = {}) {
  const root = options.resourcesRoot || process.env.RESOURCES_ROOT || path.resolve(process.cwd(), 'resources');
  const appsRoot = options.appsRoot || process.env.PLATFORM_APPS_ROOT || path.join(root, 'apps');

  function listApps(options = {}) {
    if (!fs.existsSync(appsRoot)) return [];
    return fs.readdirSync(appsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => loadApp(entry.name))
      .filter(Boolean)
      .filter((app) => options.includeDisabled || app.enabled !== false)
      .sort((left, right) => (left.order || 9999) - (right.order || 9999) || left.name.localeCompare(right.name));
  }

  function loadApp(appId) {
    if (!isSafeId(appId)) return null;
    const manifestPath = path.join(appsRoot, appId, 'app.manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    const manifest = JSON.parse(stripUtf8Bom(fs.readFileSync(manifestPath, 'utf8')));
    return publicManifest(appId, manifest);
  }

  function registry() {
    const apps = listApps();
    return {
      apps,
      activeAppId: apps.find((app) => app.enabled !== false)?.id || ''
    };
  }

  return { appsRoot, registry, listApps, loadApp };
}

function publicManifest(appId, manifest) {
  const id = String(manifest.id || appId);
  if (!isSafeId(id)) throw new Error(`Invalid app id: ${id}`);
  const runtime = normalizeRuntime(id, manifest.runtime || {});
  return {
    id,
    name: String(manifest.name || id),
    shortName: manifest.shortName ? String(manifest.shortName) : undefined,
    version: manifest.version ? String(manifest.version) : '0.0.0',
    description: manifest.description ? String(manifest.description) : '',
    category: manifest.category ? String(manifest.category) : 'MBSE App',
    logo: normalizeAssetUrl(id, manifest.logo || manifest.logoUrl || manifest.iconUrl || 'logo.svg'),
    enabled: manifest.enabled !== false,
    order: Number.isFinite(Number(manifest.order)) ? Number(manifest.order) : 9999,
    permissions: Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [],
    capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String) : [],
    runtime,
    healthCheck: manifest.healthCheck ? String(manifest.healthCheck) : ''
  };
}

function normalizeRuntime(appId, runtime) {
  const requestedType = String(runtime.type || 'static-bundle');
  const type = ['iframe-service', 'native-react'].includes(requestedType) ? requestedType : 'static-bundle';
  if (type === 'iframe-service') {
    return {
      type,
      entryUrl: String(runtime.url || runtime.entryUrl || ''),
      sandbox: String(runtime.sandbox || 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads')
    };
  }
  if (type === 'native-react') {
    return {
      type,
      entryUrl: String(runtime.entryUrl || ''),
      component: String(runtime.component || '')
    };
  }
  const entry = String(runtime.entry || runtime.entryPath || 'index.html').replace(/^web\//, '');
  return {
    type,
    entryUrl: `/app-assets/${encodeURIComponent(appId)}/${entry.replace(/^\/+/, '')}`,
    sandbox: String(runtime.sandbox || 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads')
  };
}

function normalizeAssetUrl(appId, value) {
  const text = String(value || '');
  if (/^(https?:|data:|\/)/i.test(text)) return text;
  return `/app-assets/${encodeURIComponent(appId)}/${text.replace(/^web\//, '').replace(/^\/+/, '')}`;
}

function isSafeId(value) {
  return /^[a-z0-9][a-z0-9-]{1,63}$/i.test(String(value || ''));
}

function stripUtf8Bom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

module.exports = { createAppRegistry };
