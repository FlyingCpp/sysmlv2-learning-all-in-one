'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'apps', 'web', 'dist');
const distIndex = path.join(distDir, 'index.html');
const reactAssetsDir = path.join(distDir, 'react-assets');

assert(fs.existsSync(distIndex), 'React dist/index.html must exist; run npm run build:web first');
assert(fs.existsSync(reactAssetsDir), 'React dist/react-assets must exist');

const distHtml = fs.readFileSync(distIndex, 'utf8');
assert(distHtml.includes('/react-assets/'), 'React dist index must reference /react-assets/ instead of /assets/');
assert(!distHtml.includes('/assets/'), 'React dist index must not reference Vite default /assets/');

(async () => {
  await withServer({}, async (baseUrl) => {
    const reactHome = await request(`${baseUrl}/`);
    assert.strictEqual(reactHome.status, 200, '/ should return 200');
    assert(reactHome.body.includes('react-root'), '/ must serve React shell after Phase5');
    assert(reactHome.body.includes('/react-assets/'), '/ must reference /react-assets/');

    const reactPreview = await request(`${baseUrl}/react/`);
    assert.strictEqual(reactPreview.status, 200, '/react/ should remain a compatibility entry');
    assert(reactPreview.body.includes('react-root'), '/react/ must serve React shell');
    assert(reactPreview.body.includes('/react-assets/'), '/react/ must reference /react-assets/');

    const reactDeepLink = await request(`${baseUrl}/react/courses/placeholder`);
    assert.strictEqual(reactDeepLink.status, 200, '/react/* deep links should return React dist index');
    assert(reactDeepLink.body.includes('react-root'), 'React deep link fallback must serve React shell');

    const rootDeepLink = await request(`${baseUrl}/courses/placeholder`);
    assert.strictEqual(rootDeepLink.status, 200, 'root deep links should return React dist index');
    assert(rootDeepLink.body.includes('react-root'), 'root deep link fallback must serve React shell');

    const jsAsset = firstAsset('js');
    const assetResponse = await request(`${baseUrl}/react-assets/${jsAsset}`);
    assert.strictEqual(assetResponse.status, 200, '/react-assets JS should return 200');
    assert(!assetResponse.body.includes('<!doctype html'), '/react-assets JS must not fall back to HTML');

    const cssAsset = entryStylesheetAsset();
    const cssResponse = await request(`${baseUrl}/react-assets/${cssAsset}`);
    assert.strictEqual(cssResponse.status, 200, '/react-assets CSS should return 200');
    assert(!cssResponse.body.includes('<!doctype html'), '/react-assets CSS must not fall back to HTML');
    assert(cssResponse.body.includes('phase2Shell'), '/react-assets CSS must contain the React Phase 2 stylesheet');

    const missingAppBundle = await request(`${baseUrl}/app-assets/opencar/missing.js`);
    assert.strictEqual(missingAppBundle.status, 404, 'missing /app-assets files must return 404 instead of React index');
    assert(!missingAppBundle.body.includes('react-root'), 'missing /app-assets files must not fall back to React index');

    const config = await request(`${baseUrl}/config.json`);
    assert.strictEqual(config.status, 200, '/config.json should remain available');
    const parsedConfig = JSON.parse(config.body);
    assert(!Object.hasOwn(parsedConfig, 'authEnabled'), '/config.json must not expose auth bypass flags');

    const apiProxy = await request(`${baseUrl}/api/phase0-static-routing`);
    assert.notStrictEqual(apiProxy.status, 200, '/api/* must not be served by static fallback');
    assert(!apiProxy.body.includes('react-root'), '/api/* must not return React index');

    const sysonViewProxy = await request(`${baseUrl}/syson/view/phase0-static-routing`);
    assert.notStrictEqual(sysonViewProxy.status, 200, '/syson/view/* must not be served by static fallback');
    assert(!sysonViewProxy.body.includes('react-root'), '/syson/view/* must not return React index');

    const sysonAppAssetProxy = await request(`${baseUrl}/assets/phase0-static-routing.js`);
    assert.notStrictEqual(sysonAppAssetProxy.status, 200, 'SysON app /assets/* must not be served by local static fallback');
    assert(!sysonAppAssetProxy.body.includes('react-root'), 'SysON app /assets/* must not return React index');

    const legacyApp = await request(`${baseUrl}/app.js`);
    assert.strictEqual(legacyApp.status, 200, 'unknown root files fall back to React index for SPA routing');
    assert(legacyApp.body.includes('react-root'), 'legacy app.js path should no longer serve handwritten app.js');
    const legacyCss = await request(`${baseUrl}/styles.css`);
    assert.strictEqual(legacyCss.status, 200, 'unknown root css path falls back to React index for SPA routing');
    assert(legacyCss.body.includes('react-root'), 'legacy styles.css path should no longer serve handwritten styles');
  });

  console.log('web static routing tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function firstAsset(extension) {
  const asset = fs.readdirSync(reactAssetsDir).find((name) => name.endsWith(`.${extension}`));
  assert(asset, `React ${extension} asset must exist in dist/react-assets`);
  return asset;
}

function entryStylesheetAsset() {
  const match = distHtml.match(/href="\/react-assets\/([^"]+\.css)"/);
  assert(match, 'React dist index must reference an entry stylesheet in /react-assets/');
  return match[1];
}

async function withServer(extraEnv, callback) {
  const port = await freePort();
  const child = spawn(process.execPath, ['apps/web/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      ...extraEnv,
      HOST: '127.0.0.1',
      PORT: String(port),
      API_INTERNAL_URL: 'http://127.0.0.1:1',
      SYSON_VIEW_SERVICE_URL: 'http://127.0.0.1:1',
      SYSON_GRAPHQL_URL: 'http://127.0.0.1:1/api/graphql'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  try {
    await waitForServer(port);
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    if (stderr.length) process.stderr.write(stderr.join(''));
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForServer(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await request(`http://127.0.0.1:${port}/config.json`);
      if (response.status === 200) return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`web server did not start on ${port}`);
}

function request(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error(`request timed out: ${url}`));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
