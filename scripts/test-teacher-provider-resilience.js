'use strict';

const assert = require('node:assert/strict');
const { createProviderResilienceGateway } = require('../apps/teacher/provider-resilience');

async function main() {
  const gateway = createProviderResilienceGateway({
    maxConcurrency: 1,
    queueLimit: 2
  });

  let releaseFirst;
  let active = 0;
  let maxActive = 0;
  const first = gateway.run({
    signal: AbortSignal.timeout(500),
    invoke: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      // 同一Run内的多个模型阶段已经准入，不应再次进入Gateway队列。
      await Promise.resolve('main-step');
      await Promise.resolve('candidate-step');
      await new Promise((resolve) => { releaseFirst = resolve; });
      active -= 1;
      return 'first';
    }
  });
  await waitUntil(() => gateway.state.inFlight === 1);

  const secondStartedAt = Date.now();
  const second = gateway.run({
    signal: AbortSignal.timeout(500),
    invoke: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      return 'second';
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(gateway.state.queue.length, 1,
    '等待准入的完整Run必须留在Run Admission队列中');
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert(Date.now() - secondStartedAt >= 30);
  assert.equal(maxActive, 1, '整轮Run准入不得突破并发上限');

  let releaseQueueOwner;
  const queueGateway = createProviderResilienceGateway({
    maxConcurrency: 1,
    queueLimit: 1
  });
  const queueOwner = queueGateway.run({
    invoke: async () => await new Promise((resolve) => { releaseQueueOwner = resolve; })
  });
  await waitUntil(() => queueGateway.state.inFlight === 1);
  const queuedRun = queueGateway.run({ invoke: async () => 'queued' });
  await assert.rejects(
    queueGateway.run({ invoke: async () => 'must-not-enter' }),
    (error) => error?.code === 'AI_TEACHER_BUSY',
    'queueLimit只统计等待准入的Run，并在等待队列满时拒绝新的Run'
  );
  releaseQueueOwner('owner');
  assert.deepEqual(await Promise.all([queueOwner, queuedRun]), ['owner', 'queued']);

  const businessError = Object.assign(new Error('validator binding failed'), {
    code: 'VALIDATION_ARTIFACT_NOT_BOUND',
    statusCode: 422
  });
  await assert.rejects(
    queueGateway.run({ invoke: async () => { throw businessError; } }),
    (error) => error === businessError,
    'Run Admission只能控制容量，不能把Agent业务错误改写成Provider错误'
  );

  let transientAttempts = 0;
  const oneShotGateway = createProviderResilienceGateway({
    maxConcurrency: 1,
    queueLimit: 1
  });
  await assert.rejects(oneShotGateway.run({
    signal: AbortSignal.timeout(500),
    invoke: async () => {
      transientAttempts += 1;
      throw Object.assign(new Error('temporary upstream failure'), { code: 'PROVIDER_ERROR', statusCode: 503 });
    }
  }), (error) => error?.code === 'PROVIDER_ERROR');
  assert.equal(transientAttempts, 1, 'Teacher不得在LiteLLM Provider Owner之外重复重试');

  let invalidAttempts = 0;
  await assert.rejects(
    oneShotGateway.run({
      signal: AbortSignal.timeout(500),
      invoke: async () => {
        invalidAttempts += 1;
        throw Object.assign(new Error('invalid model response'), {
          code: 'PROVIDER_INVALID_RESPONSE',
          statusCode: 502
        });
      }
    }),
    (error) => error?.code === 'PROVIDER_INVALID_RESPONSE'
  );
  assert.equal(invalidAttempts, 1, '无效模型输出不是基础设施瞬时错误，不得自动重试');

  for (const retired of ['queueTimeoutMs', 'requestTimeoutMs', 'maxRetries', 'circuitOpenMs']) {
    assert.throws(
      () => createProviderResilienceGateway({ maxConcurrency: 1, queueLimit: 1, [retired]: 1 }),
      /Teacher Provider controls were removed/,
      `${retired}不得成为静默生效或静默忽略的隐藏配置`
    );
  }

  let releaseThird;
  const third = oneShotGateway.run({
    invoke: async () => await new Promise((resolve) => { releaseThird = resolve; })
  });
  await waitUntil(() => oneShotGateway.state.inFlight === 1);
  const queuedAbort = new AbortController();
  const cancelled = oneShotGateway.run({ signal: queuedAbort.signal, invoke: async () => 'must-not-run' });
  queuedAbort.abort();
  await assert.rejects(cancelled, (error) => error?.code === 'TEACHER_RUN_CANCELLED');
  releaseThird('third');
  assert.equal(await third, 'third');

  console.log('teacher provider resilience tests passed');
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for provider resilience state.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
