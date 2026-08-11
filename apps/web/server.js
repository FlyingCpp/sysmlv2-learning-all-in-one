'use strict';

const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const net = require('net');
const path = require('path');
const tls = require('tls');
const { enhanceSysONLayout } = require('./syson-layout-enhancer');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || '';
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || '';
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8080';
const API_INTERNAL_URL = process.env.API_INTERNAL_URL || 'http://localhost:8080';
const AI_TEACHER_ENABLED = envFlag(process.env.AI_TEACHER_ENABLED, true);
const SYSON_VIEW_SERVICE_URL = envWithDefault('SYSON_VIEW_SERVICE_URL', 'http://localhost:3100');
const SYSON_GRAPHQL_URL = envWithDefault('SYSON_GRAPHQL_URL', `${process.env.SYSON_INTERNAL_URL || 'http://localhost:18080'}/api/graphql`);
const SYSON_WRITE_PROXY_ENABLED = envFlag(process.env.SYSON_WRITE_PROXY_ENABLED, false);
const SYSON_VIEW_PROXY_BASE = '/syson/view';
const SYSON_APP_URL = envWithDefault('SYSON_APP_URL', originFromUrl(SYSON_GRAPHQL_URL));
const DIST_DIR = path.join(__dirname, 'dist');
const REACT_ASSETS_PREFIX = '/react-assets/';
const REACT_PREVIEW_PREFIX = '/react/';
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const RESOURCES_ROOT = process.env.RESOURCES_ROOT || path.join(PROJECT_ROOT, 'resources');
const PLATFORM_APPS_ROOT = process.env.PLATFORM_APPS_ROOT || path.join(RESOURCES_ROOT, 'apps');
const APP_ASSETS_PREFIX = '/app-assets/';
const NODE_MODULES_DIR = path.join(PROJECT_ROOT, 'node_modules');
const NPM_PUBLIC_MODULES = new Set([
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/commands',
  '@codemirror/autocomplete',
  '@codemirror/search',
  '@codemirror/language',
  '@lezer/common',
  '@lezer/highlight',
  'style-mod',
  'crelt',
  'w3c-keyname',
  '@marijn/find-cluster-break'
]);
const SYSON_BROWSER_POLYFILL_SOURCE = `
(function () {
  var cryptoRef = window.crypto;
  if (!cryptoRef) {
    cryptoRef = {};
    try {
      Object.defineProperty(window, 'crypto', { value: cryptoRef, configurable: true });
    } catch (_) {
      window.crypto = cryptoRef;
      cryptoRef = window.crypto || cryptoRef;
    }
  }
  if (!cryptoRef.randomUUID) {
    var createUuid = function () {
      var bytes = new Uint8Array(16);
      if (cryptoRef.getRandomValues) {
        cryptoRef.getRandomValues(bytes);
      } else {
        for (var index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
      }
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      var hex = Array.prototype.map.call(bytes, function (byte) {
        return byte.toString(16).padStart(2, '0');
      }).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    };
    try {
      Object.defineProperty(cryptoRef, 'randomUUID', { value: createUuid, configurable: true });
    } catch (_) {
      cryptoRef.randomUUID = createUuid;
    }
  }
}());
`;
const SYSON_BROWSER_POLYFILLS = `<script data-syson-proxy-polyfills>${SYSON_BROWSER_POLYFILL_SOURCE}</script>`;
const SYSON_BROWSER_POLYFILL_HASH = `sha256-${crypto.createHash('sha256').update(SYSON_BROWSER_POLYFILL_SOURCE, 'utf8').digest('base64')}`;
const API_CONNECT_SOURCE = originFromUrl(API_BASE_URL);
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  `script-src 'self' '${SYSON_BROWSER_POLYFILL_HASH}'`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self'${API_CONNECT_SOURCE ? ` ${API_CONNECT_SOURCE}` : ''} ws: wss:`,
  "media-src 'self' blob: https:",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "manifest-src 'self'"
].join('; ');
const SECURITY_RESPONSE_HEADERS = Object.freeze({
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'x-frame-options': 'SAMEORIGIN'
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const requestHandler = (req, res) => {
  const pathname = (req.url || '').split('?')[0];
  if (pathname === '/api/graphql') {
    return handleSysONGraphQL(req, res);
  }
  if (isSysONAppProxyPath(req.url || '')) {
    return withSysONAccess(req, res, 'read', () => proxySysONApp(req, res));
  }
  if ((req.url || '').startsWith('/api/')) {
    return proxyApi(req, res);
  }
  if (isSysONViewProxyPath(req.url || '')) {
    const access = isSysONComputeRequest(req) ? 'compute' : 'read';
    return withSysONAccess(req, res, access, () => proxySysONView(req, res));
  }
  if (req.method === 'POST' && req.url === '/syson/enhance-layout') {
    return withSysONWriteAccess(req, res, () => enhanceSysONLayoutRoute(req, res));
  }
  if (req.method === 'POST' && req.url === '/syson/arrange-all') {
    return withSysONWriteAccess(req, res, () => arrangeAllSysON(req, res));
  }
  if (req.url === '/config.json') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
      apiBaseUrl: API_BASE_URL,
      aiTeacherEnabled: AI_TEACHER_ENABLED,
      sysonViewServiceUrl: SYSON_VIEW_SERVICE_URL ? SYSON_VIEW_PROXY_BASE : ''
    }));
  }
  if ((req.url || '').startsWith('/npm/')) {
    return serveNpmModule(req, res);
  }
  if ((req.url || '').startsWith(APP_ASSETS_PREFIX)) {
    return serveAppAsset(req, res);
  }
  return serveWebStatic(req, res);
};

const server = createHttpServer(requestHandler);

server.on('upgrade', (req, socket, head) => {
  if (isSysONWebSocketProxyPath(req.url || '')) {
    void authorizeSysONUpgrade(req).then(() => {
      proxySysONWebSocket(req, socket, head);
    }).catch((error) => {
      rejectSysONUpgrade(socket, error);
    });
    return;
  }
  socket.destroy();
});

async function handleSysONGraphQL(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, 'application/json; charset=utf-8', JSON.stringify({
      error: 'SysON GraphQL 仅接受受保护的 POST 请求。',
      code: 'SYSON_GRAPHQL_METHOD_NOT_ALLOWED'
    }));
  }
  try {
    assertSameOrigin(req);
    const payload = await readJson(req);
    const operationType = graphqlOperationType(payload);
    if (operationType === 'unknown') {
      return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({
        error: '无法识别 SysON GraphQL 操作。',
        code: 'SYSON_GRAPHQL_OPERATION_INVALID'
      }));
    }
    const access = operationType === 'write' ? 'write' : 'read';
    await authorizeSysONRequest(req, access);
    if (operationType === 'write' && !SYSON_WRITE_PROXY_ENABLED) {
      return send(res, 403, 'application/json; charset=utf-8', JSON.stringify({
        error: 'SysON 直接写代理未启用。',
        code: 'SYSON_WRITE_PROXY_DISABLED'
      }));
    }
    return proxySysONApp(req, res, Buffer.from(JSON.stringify(payload), 'utf8'));
  } catch (error) {
    return sendSysONAccessError(res, error);
  }
}

async function withSysONAccess(req, res, access, handler) {
  try {
    if (!isSafeMethod(req.method)) assertSameOrigin(req);
    await authorizeSysONRequest(req, access);
    return handler();
  } catch (error) {
    return sendSysONAccessError(res, error);
  }
}

function withSysONWriteAccess(req, res, handler) {
  return withSysONAccess(req, res, 'write', () => {
    if (!SYSON_WRITE_PROXY_ENABLED) {
      return send(res, 403, 'application/json; charset=utf-8', JSON.stringify({
        error: 'SysON 直接写代理未启用。',
        code: 'SYSON_WRITE_PROXY_DISABLED'
      }));
    }
    return handler();
  });
}

async function authorizeSysONRequest(req, access) {
  const upstream = new URL('/api/auth/syson-access', API_INTERNAL_URL);
  const response = await fetch(upstream, {
    method: 'POST',
    headers: forwardedSysONAuthHeaders(req),
    body: JSON.stringify({
      access,
      method: req.method || 'GET',
      route: String(req.url || '').slice(0, 256)
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (response.ok && payload.authorized) return payload;
  const error = new Error(String(payload.error || 'SysON 访问授权失败。'));
  error.statusCode = response.status || 503;
  error.code = String(payload.code || 'SYSON_ACCESS_DENIED');
  error.details = payload.details;
  throw error;
}

function forwardedSysONAuthHeaders(req) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': String(req.headers['user-agent'] || 'sysmlv2-web-syson-gateway')
  };
  for (const name of ['cookie', 'authorization', 'x-forwarded-for', 'x-real-ip', 'x-request-id']) {
    const value = req.headers[name];
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return headers;
}

function assertSameOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  const expectedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  let originHost = '';
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported origin protocol');
    originHost = parsed.host.toLowerCase();
  } catch {
    originHost = '';
  }
  if (originHost && expectedHost && originHost === expectedHost) return;
  const error = new Error('SysON 写请求未通过同源校验。');
  error.statusCode = 403;
  error.code = 'SYSON_CSRF_REJECTED';
  throw error;
}

function isSafeMethod(method) {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function graphqlOperationType(payload) {
  const entries = Array.isArray(payload) ? payload : [payload];
  if (!entries.length) return 'unknown';
  let hasWrite = false;
  for (const entry of entries) {
    const query = String(entry?.query || '').replace(/^\uFEFF/, '').replace(/#[^\r\n]*/g, '').trim();
    if (!query) return 'unknown';
    if (/^mutation\b/i.test(query)) {
      hasWrite = true;
      continue;
    }
    if (/^(query|subscription)\b/i.test(query) || query.startsWith('{')) continue;
    return 'unknown';
  }
  return hasWrite ? 'write' : 'read';
}

function isSysONComputeRequest(req) {
  if (req.method !== 'POST') return false;
  const pathname = (req.url || '').split('?')[0];
  return pathname === `${SYSON_VIEW_PROXY_BASE}/api/analyze`
    || pathname === `${SYSON_VIEW_PROXY_BASE}/api/render`;
}

async function authorizeSysONUpgrade(req) {
  assertSameOrigin(req);
  await authorizeSysONRequest(req, 'write');
  if (SYSON_WRITE_PROXY_ENABLED) return;
  const error = new Error('SysON WebSocket 写通道未启用。');
  error.statusCode = 403;
  error.code = 'SYSON_WRITE_PROXY_DISABLED';
  throw error;
}

function rejectSysONUpgrade(socket, error) {
  const status = Number(error?.statusCode || 403);
  const safeStatus = status === 401 ? 401 : status === 429 ? 429 : 403;
  const label = safeStatus === 401 ? 'Unauthorized' : safeStatus === 429 ? 'Too Many Requests' : 'Forbidden';
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${safeStatus} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
}

function sendSysONAccessError(res, error) {
  const rawStatus = Number(error?.statusCode || error?.status || 503);
  const status = [400, 401, 403, 429, 503].includes(rawStatus) ? rawStatus : 503;
  return send(res, status, 'application/json; charset=utf-8', JSON.stringify({
    error: String(error?.message || 'SysON 访问授权失败。'),
    code: String(error?.code || 'SYSON_ACCESS_DENIED'),
    details: error?.details
  }));
}

function proxyApi(req, res) {
  const upstream = new URL(req.url, API_INTERNAL_URL);
  const proxyReq = http.request(upstream, {
    method: req.method,
    headers: proxyRequestHeaders(req.headers, upstream.host)
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyHeaders(proxyRes.headers));
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (error) => {
    send(res, 502, 'application/json; charset=utf-8', JSON.stringify({ error: 'API proxy failed', message: error.message }));
  });
  req.pipe(proxyReq);
}

function createHttpServer(handler) {
  if (TLS_CERT_PATH || TLS_KEY_PATH) {
    if (!TLS_CERT_PATH || !TLS_KEY_PATH) throw new Error('TLS_CERT_PATH and TLS_KEY_PATH must be configured together.');
    const keyMode = fs.statSync(TLS_KEY_PATH).mode & 0o777;
    if ((keyMode & 0o077) !== 0) throw new Error(`TLS key file is too permissive: ${TLS_KEY_PATH}`);
    return https.createServer({
      cert: fs.readFileSync(TLS_CERT_PATH),
      key: fs.readFileSync(TLS_KEY_PATH)
    }, handler);
  }
  return http.createServer(handler);
}

function envFlag(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  return !/^(0|false|no|off|disabled)$/i.test(String(value).trim());
}

function serveNpmModule(req, res) {
  const urlPath = decodeURIComponent((req.url || '').split('?')[0]);
  const relative = urlPath.slice('/npm/'.length);
  const parts = relative.split('/').filter(Boolean);
  const packageName = parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1] || ''}` : parts[0];
  const packagePathParts = parts[0]?.startsWith('@') ? parts.slice(2) : parts.slice(1);
  if (!packageName || !NPM_PUBLIC_MODULES.has(packageName) || packagePathParts.length === 0) {
    return send(res, 404, 'text/plain', 'Not found');
  }
  const target = path.resolve(NODE_MODULES_DIR, packageName, ...packagePathParts);
  const packageRoot = path.resolve(NODE_MODULES_DIR, packageName);
  if (!target.startsWith(packageRoot)) return send(res, 403, 'text/plain', 'Forbidden');
  fs.readFile(target, (error, content) => {
    if (error) return send(res, 404, 'text/plain', 'Not found');
    send(res, 200, MIME[path.extname(target)] || 'application/javascript; charset=utf-8', content);
  });
}

function serveWebStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath.startsWith(REACT_ASSETS_PREFIX)) {
    return serveStaticFile(res, DIST_DIR, urlPath, { fallbackIndex: false });
  }
  if (urlPath.startsWith('/assets/')) {
    return send(res, 404, 'text/plain', 'Not found');
  }
  if (urlPath === '/react' || urlPath.startsWith(REACT_PREVIEW_PREFIX)) {
    return serveStaticFile(res, DIST_DIR, '/index.html', { fallbackIndex: false });
  }
  return serveStaticFile(res, DIST_DIR, urlPath, { fallbackIndex: true });
}

function serveAppAsset(req, res) {
  const urlPath = decodeURIComponent((req.url || '').split('?')[0]);
  const relative = urlPath.slice(APP_ASSETS_PREFIX.length);
  const parts = relative.split('/').filter(Boolean);
  const appId = parts.shift() || '';
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/i.test(appId) || parts.length === 0) {
    return send(res, 404, 'text/plain', 'Not found');
  }
  const appWebRoot = path.resolve(PLATFORM_APPS_ROOT, appId, 'web');
  const target = path.resolve(appWebRoot, ...parts);
  if (!target.startsWith(appWebRoot)) return send(res, 403, 'text/plain', 'Forbidden');
  fs.readFile(target, (error, content) => {
    if (error) return send(res, 404, 'text/plain', 'Not found');
    return send(res, 200, MIME[path.extname(target)] || 'application/octet-stream', content);
  });
}

function serveStaticFile(res, rootDir, urlPath, options = {}) {
  const safePath = urlPath === '/' ? '/index.html' : urlPath;
  const target = path.resolve(rootDir, '.' + safePath);
  if (!target.startsWith(rootDir)) return send(res, 403, 'text/plain', 'Forbidden');
  fs.readFile(target, (error, content) => {
    if (!error) {
      return send(res, 200, MIME[path.extname(target)] || 'application/octet-stream', content);
    }
    if (options.fallbackRoot) {
      const fallbackTarget = path.resolve(options.fallbackRoot, '.' + safePath);
      if (fallbackTarget.startsWith(options.fallbackRoot)) {
        return fs.readFile(fallbackTarget, (fallbackFileError, fallbackContent) => {
          if (!fallbackFileError) {
            return send(res, 200, MIME[path.extname(fallbackTarget)] || 'application/octet-stream', fallbackContent);
          }
          return serveIndexFallback(res, rootDir, options);
        });
      }
    }
    return serveIndexFallback(res, rootDir, options);
  });
}

function serveIndexFallback(res, rootDir, options = {}) {
  if (!options.fallbackIndex) return send(res, 404, 'text/plain', 'Not found');
  fs.readFile(path.join(rootDir, 'index.html'), (fallbackError, fallback) => {
    if (fallbackError && options.fallbackRoot) {
      return fs.readFile(path.join(options.fallbackRoot, 'index.html'), (secondaryError, secondaryFallback) => {
        if (secondaryError) return send(res, 404, 'text/plain', 'Not found');
        return send(res, 200, MIME['.html'], secondaryFallback);
      });
    }
    if (fallbackError) return send(res, 404, 'text/plain', 'Not found');
    return send(res, 200, MIME['.html'], fallback);
  });
}

function proxySysONView(req, res) {
  if (!SYSON_VIEW_SERVICE_URL) {
    return send(res, 404, 'application/json; charset=utf-8', JSON.stringify({
      error: 'SysON view service is not configured'
    }));
  }
  const rawUrl = req.url || '/';
  const suffix = rawUrl.startsWith(SYSON_VIEW_PROXY_BASE) ? rawUrl.slice(SYSON_VIEW_PROXY_BASE.length) || '/' : rawUrl;
  const upstream = new URL(suffix, SYSON_VIEW_SERVICE_URL);
  const proxyReq = http.request(upstream, {
    method: req.method,
    headers: proxyRequestHeaders(req.headers, upstream.host)
  }, (proxyRes) => {
    proxyMaybeRewriteSysONJson(proxyRes, res);
  });
  proxyReq.on('error', (error) => {
    send(res, 502, 'application/json; charset=utf-8', JSON.stringify({
      error: 'SysON view proxy failed',
      message: error.message,
      upstream: SYSON_VIEW_SERVICE_URL
    }));
  });
  req.pipe(proxyReq);
}

function proxySysONApp(req, res, bufferedBody) {
  if (!SYSON_APP_URL) {
    return send(res, 404, 'application/json; charset=utf-8', JSON.stringify({
      error: 'SysON app service is not configured'
    }));
  }
  const upstream = new URL(req.url || '/', SYSON_APP_URL);
  const headers = proxyRequestHeaders(req.headers, upstream.host);
  if (bufferedBody) headers['content-length'] = String(bufferedBody.length);
  const proxyReq = http.request(upstream, {
    method: req.method,
    headers
  }, (proxyRes) => {
    if (isHtmlResponse(proxyRes)) {
      return proxyTransformText(proxyRes, res, injectSysONBrowserPolyfills);
    }
    res.writeHead(proxyRes.statusCode || 502, proxyHeaders(proxyRes.headers));
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (error) => {
    send(res, 502, 'application/json; charset=utf-8', JSON.stringify({
      error: 'SysON app proxy failed',
      message: error.message,
      upstream: SYSON_APP_URL
    }));
  });
  if (bufferedBody) proxyReq.end(bufferedBody);
  else req.pipe(proxyReq);
}

function proxySysONWebSocket(req, socket, head) {
  if (!SYSON_APP_URL) {
    socket.destroy();
    return;
  }
  const upstream = new URL(req.url || '/', SYSON_APP_URL);
  const port = Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80));
  const connect = upstream.protocol === 'https:' ? tls.connect : net.connect;
  const upstreamSocket = connect({ host: upstream.hostname, port }, () => {
    const headers = proxyRequestHeaders(req.headers, upstream.host);
    const requestTarget = `${upstream.pathname}${upstream.search}`;
    const lines = [`${req.method} ${requestTarget} HTTP/${req.httpVersion}`];
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`);
      } else if (value !== undefined) {
        lines.push(`${name}: ${value}`);
      }
    }
    upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head && head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstreamSocket.on('error', () => socket.destroy());
  socket.on('error', () => upstreamSocket.destroy());
  socket.on('close', () => upstreamSocket.destroy());
}

function proxyHeaders(headers) {
  const sanitized = { ...headers };
  delete sanitized['content-length'];
  delete sanitized.connection;
  delete sanitized['keep-alive'];
  delete sanitized['transfer-encoding'];
  delete sanitized['accept-ranges'];
  delete sanitized['content-range'];
  sanitized['cache-control'] = 'no-store, max-age=0, must-revalidate';
  return withSecurityHeaders(sanitized);
}

function withSecurityHeaders(headers = {}) {
  return { ...headers, ...SECURITY_RESPONSE_HEADERS };
}

function proxyRequestHeaders(headers, host) {
  const sanitized = { ...headers, host };
  delete sanitized.range;
  delete sanitized['if-range'];
  delete sanitized['if-none-match'];
  delete sanitized['if-modified-since'];
  return sanitized;
}

function proxyMaybeRewriteSysONJson(proxyRes, res) {
  const headers = proxyHeaders(proxyRes.headers);
  const contentType = String(headers['content-type'] || '');
  if (!contentType.includes('application/json')) {
    res.writeHead(proxyRes.statusCode || 502, headers);
    proxyRes.pipe(res);
    return;
  }

  const chunks = [];
  proxyRes.on('data', (chunk) => chunks.push(chunk));
  proxyRes.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      const rewritten = JSON.stringify(rewriteSysONUrls(JSON.parse(raw)), null, 2);
      delete headers['content-length'];
      res.writeHead(proxyRes.statusCode || 502, headers);
      res.end(rewritten);
    } catch {
      res.writeHead(proxyRes.statusCode || 502, headers);
      res.end(raw);
    }
  });
}

function proxyTransformText(proxyRes, res, transform) {
  const headers = proxyHeaders(proxyRes.headers);
  const chunks = [];
  proxyRes.on('data', (chunk) => chunks.push(chunk));
  proxyRes.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    res.writeHead(proxyRes.statusCode || 502, headers);
    res.end(transform(raw));
  });
}

function isHtmlResponse(proxyRes) {
  return String(proxyRes.headers['content-type'] || '').includes('text/html');
}

function injectSysONBrowserPolyfills(html) {
  if (html.includes('data-syson-proxy-polyfills')) return html;
  if (html.includes('</head>')) return html.replace('</head>', `${SYSON_BROWSER_POLYFILLS}\n</head>`);
  return `${SYSON_BROWSER_POLYFILLS}\n${html}`;
}

function rewriteSysONUrls(payload) {
  const maps = [
    { origins: [originFromUrl(SYSON_VIEW_SERVICE_URL), originFromUrl(payload?.servicePublicUrl)], replacement: SYSON_VIEW_PROXY_BASE },
    { origins: [originFromUrl(SYSON_APP_URL), originFromUrl(payload?.sysonPublicUrl)], replacement: '' }
  ];
  return rewriteValue(payload, maps);
}

function rewriteValue(value, maps) {
  if (typeof value === 'string') return rewriteString(value, maps);
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, maps));
  if (value && typeof value === 'object') {
    const rewritten = {};
    for (const [key, child] of Object.entries(value)) rewritten[key] = rewriteValue(child, maps);
    return rewritten;
  }
  return value;
}

function rewriteString(value, maps) {
  let output = value;
  for (const map of maps) {
    const origins = [...new Set(map.origins.filter(Boolean))];
    for (const origin of origins) {
      output = output.split(origin).join(map.replacement);
      output = output.split(encodeURIComponent(origin)).join(encodeURIComponent(map.replacement));
    }
  }
  output = rewriteUrlOriginsByPort(output, '3100', SYSON_VIEW_PROXY_BASE);
  output = rewriteUrlOriginsByPort(output, '18080', '');
  return output;
}

function rewriteUrlOriginsByPort(value, port, replacement) {
  const absolute = new RegExp(`https?://[^/?#]+:${port}`, 'g');
  const encoded = new RegExp(`https?%3A%2F%2F[^/?#&]+%3A${port}`, 'gi');
  return value
    .replace(absolute, replacement)
    .replace(encoded, encodeURIComponent(replacement));
}

function isSysONAppProxyPath(url) {
  const pathname = (url || '').split('?')[0];
  return Boolean(
    SYSON_APP_URL
    && (
      pathname.startsWith('/projects/')
      || pathname.startsWith('/assets/')
      || pathname.startsWith('/api/locales/')
      || pathname.startsWith('/api/images/')
      || pathname === '/favicon.png'
      || pathname === '/api/graphql'
    )
  );
}

function isSysONWebSocketProxyPath(url) {
  const pathname = (url || '').split('?')[0];
  return Boolean(SYSON_APP_URL && pathname === '/subscriptions');
}

function isSysONViewProxyPath(url) {
  const pathname = (url || '').split('?')[0];
  return Boolean(
    SYSON_VIEW_SERVICE_URL
    && (
      pathname.startsWith(`${SYSON_VIEW_PROXY_BASE}/`)
      || pathname === SYSON_VIEW_PROXY_BASE
      || pathname === '/embed.js'
      || pathname === '/embed.css'
    )
  );
}

async function enhanceSysONLayoutRoute(req, res) {
  try {
    const result = await enhanceSysONLayout(await readJson(req));
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(result));
  } catch (error) {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
      ok: false,
      attempted: true,
      applied: false,
      error: 'SysON teaching layout enhancement failed',
      message: error.message,
      details: error.details || undefined
    }));
  }
}

async function arrangeAllSysON(req, res) {
  try {
    const body = await readJson(req);
    const editingContextId = String(body.editingContextId || '').trim();
    const representationId = String(body.representationId || '').trim();
    if (!editingContextId || !representationId) {
      return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({
        ok: false,
        error: 'editingContextId and representationId are required'
      }));
    }
    const payload = {
      query: `
        mutation arrangeAll($input: ArrangeAllInput!) {
          arrangeAll(input: $input) {
            __typename
            ... on SuccessPayload { id messages { level body } }
            ... on ErrorPayload { id messages { level body } }
          }
        }
      `,
      variables: {
        input: {
          id: randomId(),
          editingContextId,
          representationId
        }
      }
    };
    const response = await fetch(SYSON_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    const mutation = result.data?.arrangeAll;
    if (!response.ok || result.errors || !mutation || mutation.__typename === 'ErrorPayload') {
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
        ok: false,
        error: 'SysON arrangeAll failed',
        details: result.errors || mutation?.messages || result
      }));
    }
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
      ok: true,
      graphqlUrl: SYSON_GRAPHQL_URL,
      result: mutation
    }));
  } catch (error) {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
      ok: false,
      error: 'SysON arrangeAll proxy failed',
      message: error.message
    }));
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function randomId() {
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function envWithDefault(name, defaultValue) {
  return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : defaultValue;
}

function originFromUrl(value) {
  try {
    return value ? new URL(value).origin : '';
  } catch {
    return '';
  }
}

function send(res, status, type, body) {
  res.writeHead(status, withSecurityHeaders({
    'content-type': type,
    'cache-control': 'no-store, max-age=0, must-revalidate',
    pragma: 'no-cache',
    expires: '0'
  }));
  res.end(body);
}

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`web listening on ${HOST}:${PORT}`));
}

module.exports = { server };
