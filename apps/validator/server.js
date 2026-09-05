'use strict';

const http = require('http');
const crypto = require('crypto');
const {
  applyValidatorResourcePolicy,
  validatorResourcePolicyState,
  validateWorkspace,
  generatePlantUml,
  validatorHealth,
  SOURCE
} = require('./validator');

const PORT = Number(process.env.PORT || 9090);
const HOST = process.env.HOST || '0.0.0.0';
const guardedHttpSockets = new WeakSet();

// Node在高并发取消时可能把底层Socket的断连错误直接提升到进程边界，
// 即使具体stdin/HTTP流都已注册error监听。只接管已断开管道；其他未捕获
// 异常继续按原行为终止进程，避免掩盖Validator内部错误。
process.on('uncaughtException', (error) => {
  if (error?.code === 'EPIPE' || error?.code === 'ECONNRESET') return;
  throw error;
});

function send(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) resolve({});
      else {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // 压力测试或上游截止会在Validator完成前关闭HTTP连接。响应流随后写回
  // EPIPE/ECONNRESET属于该请求不可交付，不得成为未处理事件并退出整个服务。
  if (!guardedHttpSockets.has(req.socket)) {
    guardedHttpSockets.add(req.socket);
    req.socket.on('error', () => {});
  }
  res.on('error', () => {});
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, validatorHealth());
  }
  if (req.url === '/internal/resource-policy' && ['GET', 'PUT'].includes(req.method)) {
    const authorization = authorizeResourcePolicyRequest(req);
    if (!authorization.ok) return send(res, authorization.status, { code: authorization.code });
    try {
      if (req.method === 'GET') return send(res, 200, validatorResourcePolicyState());
      const payload = await readJson(req);
      return send(res, 200, applyValidatorResourcePolicy(payload));
    } catch (error) {
      return send(res, Number(error?.status || 400), {
        code: String(error?.code || 'VALIDATOR_RESOURCE_POLICY_APPLY_FAILED'),
        message: String(error?.message || 'Validator resource policy apply failed.')
      });
    }
  }
  if (req.method === 'GET' && req.url === '/validate/self-test') {
    return send(res, 200, await validateWorkspace({ content: 'package SelfTest { part def Vehicle; part car : Vehicle; }' }));
  }
  if (req.method === 'POST' && req.url === '/validate') {
    const requestLifetime = createRequestLifetime(req, res);
    try {
      const payload = await readJson(req);
      const validation = await validateWorkspace(payload, { signal: requestLifetime.signal });
      return send(res, 200, validation);
    } catch (error) {
      const status = Number(error?.status || 400);
      return send(res, status, {
        source: SOURCE,
        code: String(error?.code || 'VALIDATOR_REQUEST_FAILED'),
        retryableBeforeStart: ['VALIDATOR_QUEUE_FULL', 'VALIDATOR_QUEUE_TIMEOUT'].includes(error?.code),
        ...(error?.validatorObservation ? { validatorObservation: error.validatorObservation } : {}),
        details: error?.details || {},
        valid: false,
        syntaxValid: false,
        semanticValid: false,
        diagnostics: [{ severity: 'error', category: 'syntax', message: error.message, source: SOURCE }]
      });
    } finally {
      requestLifetime.dispose();
    }
  }
  if (req.method === 'POST' && req.url === '/plantuml') {
    try {
      const payload = await readJson(req);
      return send(res, 200, await generatePlantUml(payload));
    } catch (error) {
      return send(res, 400, { source: SOURCE, ok: false, kind: 'ERROR', diagnostics: [{ severity: 'error', category: 'plantuml', message: error.message, source: SOURCE }] });
    }
  }
  return send(res, 404, { error: 'Not found', source: SOURCE });
});

function authorizeResourcePolicyRequest(req) {
  const expected = String(process.env.AI_TEACHER_INTERNAL_TOKEN || '');
  if (!expected) {
    return { ok: false, status: 503, code: 'VALIDATOR_RESOURCE_POLICY_AUTH_NOT_CONFIGURED' };
  }
  const actual = String(req.headers['x-ai-teacher-token'] || '');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(actual, 'utf8');
  const matches = expectedBuffer.length === actualBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  return matches
    ? { ok: true }
    : { ok: false, status: 401, code: 'VALIDATOR_RESOURCE_POLICY_TOKEN_INVALID' };
}

function createRequestLifetime(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('Validator HTTP caller disconnected'));
    }
  };
  req.once('aborted', abort);
  res.once('close', abort);
  return {
    signal: controller.signal,
    dispose() {
      req.off('aborted', abort);
      res.off('close', abort);
    }
  };
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`validator listening on ${HOST}:${PORT}`);
  });
}

module.exports = { createRequestLifetime, server };
