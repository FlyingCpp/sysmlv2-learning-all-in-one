'use strict';

const assert = require('assert');
const { server } = require('../apps/validator/server');

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (!server.listening) return;
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const preflight = await fetch(`${base}/validate`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://attacker.example',
      'access-control-request-method': 'POST'
    }
  });
  assert.strictEqual(preflight.status, 204);
  assert.strictEqual(preflight.headers.get('access-control-allow-origin'), null, 'Validator must not opt into cross-origin browser access');
  assert.strictEqual(preflight.headers.get('access-control-allow-methods'), null, 'Validator must not advertise browser-callable methods');

  const health = await fetch(`${base}/health`, { headers: { origin: 'https://attacker.example' } });
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.headers.get('access-control-allow-origin'), null, 'Validator health must remain same-origin/server-to-server only');

  console.log('validator HTTP boundary tests passed');
}
